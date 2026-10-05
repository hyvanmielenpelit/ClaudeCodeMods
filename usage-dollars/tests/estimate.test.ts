import { expect, test } from 'claude-code/testing'

import {
  ASSUMED_SPREAD,
  bounds,
  calibrateOmega,
  calibrationOf,
  estimate,
  evidenceOf,
  inferRounding,
  pastOf,
  pastPoints,
  prior,
  record,
  regimeView,
  roundingEvidence,
  tQuantile,
  weightOf,
} from '../hooks/estimate'
import type { PastPoint, WindowReadings } from '../hooks/estimate'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const NOW = Date.parse('2026-10-05T12:00:00.000Z')

const empty = (kind = 'seven_day', resetsAt = new Date(NOW + DAY_MS).toISOString()): WindowReadings => ({ kind, resetsAt, byPct: {} })

/* Readings of a window with the given allowance, every `step` dollars up to `upTo`, the
   percent reported by `report`; one reading a minute. */
function simulate(allowance: number, upTo: number, step: number, report: (share: number) => number, w = empty()) {
  let at = NOW - DAY_MS
  for (let usd = step; usd <= upTo + 1e-9; usd += step) {
    w = record(w, report((usd / allowance) * 100), usd, at)
    at += 60 * 1000
  }
  return w
}

const rounded = (share: number) => Math.round(share)
const truncated = (share: number) => Math.floor(share)
const capped = (share: number) => Math.min(100, Math.round(share))

const pastAt = (usd: number, ageMs: number): PastPoint => ({ logA: Math.log(usd), variance: 0.02 ** 2, at: NOW - ageMs })

test('evidence from a crossing is 100 · U / (p − 0.5) under rounding', () => {
  let w = empty('five_hour')
  w = record(w, 9, 60, NOW - 50 * 60 * 1000)
  w = record(w, 10, 62, NOW - 40 * 60 * 1000)
  w = record(w, 10, 64, NOW - 30 * 60 * 1000)
  const e = evidenceOf(w, 1, 'round', 0.5)!
  expect(e.crossingUsd).toBe(61)
  expect(e.share).toBe(9.5)
  expect(Math.abs(e.logA - Math.log((100 * 61) / 9.5))).toBeLessThan(1e-12)
  expect(e.shift).toBe(0)
})

test('the within-window term vanishes at 100%: only the gap is left', () => {
  const w = simulate(1000, 1000, 2, truncated)
  const e = evidenceOf(w, 1, 'truncate', 0.5)!
  expect(e.share).toBe(100)
  const gap = w.byPct['100'].minUsd - w.byPct['99'].maxUsd
  const usd = e.crossingUsd!
  expect(Math.abs(e.variance - gap ** 2 / (12 * usd * usd))).toBeLessThan(1e-15)
})

test("a level-100 bucket's dollars past the limit are ignored (F7)", () => {
  const w = simulate(1000, 1500, 0.5, capped, empty('five_hour'))
  expect(w.byPct['100'].maxUsd).toBe(1500)
  const e = estimate(w, 1500, { resolution: 1, rounding: 'round', past: [], kind: 'five_hour', now: NOW, livePercent: 100 })!
  expect(Math.abs(e.allowance.value / 1000 - 1)).toBeLessThan(0.02)
  expect(e.left).toEqual({ value: 0, low: 0, high: 0 })
  expect(e.nextTick).toBeUndefined()
})

test('with a measured spread the range narrows as the window fills, and left with it', () => {
  const spread = { omega: 0.15, weight: 100, windows: 30, isAssumed: false }
  const options = { resolution: 1, rounding: 'round' as const, past: [], kind: 'seven_day', now: NOW, spread }
  const at = (upTo: number) => estimate(simulate(3000, upTo, 1.5, rounded), upTo, { ...options, livePercent: rounded((upTo / 3000) * 100) })!
  const early = at(300)
  const late = at(2700)
  for (const e of [early, late]) {
    expect(e.allowance.low).toBeLessThanOrEqual(3000)
    expect(e.allowance.high).toBeGreaterThanOrEqual(3000)
  }
  expect(late.allowance.high / late.allowance.low).toBeLessThan(early.allowance.high / early.allowance.low)
  expect(late.left.high - late.left.low).toBeLessThan(0.5 * (3000 - 2700))
  expect(late.left.low).toBeGreaterThan(0)
})

test('a window that is both read to its end and rejected counts once, as the rejection', () => {
  const reset = new Date(NOW - HOUR_MS).toISOString()
  const closed = simulate(1000, 900, 2, rounded, empty('five_hour', reset))
  const rejection = { kind: 'five_hour', resetsAt: new Date(Date.parse(reset) + 20 * 1000).toISOString(), at: new Date(NOW - 2 * HOUR_MS).toISOString(), usd: 990 }
  const points = pastPoints([closed], [rejection], 'five_hour', 1, 'round', 0.5)
  expect(points.length).toBe(1)
  expect(points[0].logA).toBe(Math.log(990))
  const alone = pastPoints([closed], [], 'five_hour', 1, 'round', 0.5)
  expect(alone.length).toBe(1)
  expect(Math.abs(Math.exp(alone[0].logA) / 1000 - 1)).toBeLessThan(0.01)
})

test('a closed window short of 10% is no past point', () => {
  const reset = new Date(NOW - HOUR_MS).toISOString()
  expect(pastPoints([simulate(1000, 80, 2, rounded, empty('five_hour', reset))], [], 'five_hour', 1, 'round', 0.5).length).toBe(0)
  expect(pastPoints([simulate(1000, 150, 2, rounded, empty('five_hour', reset))], [], 'five_hour', 1, 'round', 0.5).length).toBe(1)
})

test('a closed window reported at 10% is a past point under every rounding rule', () => {
  const reset = new Date(NOW - HOUR_MS).toISOString()
  /* The last reading, $96 at share 9.6, is the first at level 10. */
  const atTen = simulate(1000, 96, 2, rounded, empty('five_hour', reset))
  const atNine = simulate(1000, 94, 2, rounded, empty('five_hour', reset))
  for (const r of ['union', 'round', 'truncate'] as const) {
    expect(pastPoints([atTen], [], 'five_hour', 1, r, 0.5).length).toBe(1)
    expect(pastPoints([atNine], [], 'five_hour', 1, r, 0.5).length).toBe(0)
  }
})

test('a 0% reading is no evidence', () => {
  const w = record(empty('five_hour'), 0, 0.14, NOW)
  expect(evidenceOf(w, 1, 'union')).toBeUndefined()
  expect(estimate(w, 0.14, { resolution: 1, rounding: 'union', past: [], kind: 'five_hour', now: NOW })).toBeUndefined()
})

const zeroThenOne = () => record(record(empty('five_hour'), 0, 6, NOW - 2 * 60 * 1000), 1, 8, NOW - 60 * 1000)

test('a 0% reading still bounds the allowance', () => {
  /* Level 0's dollars over its upper share of 1%. */
  expect(bounds(zeroThenOne(), 1, 'union')).toEqual({ low: 600, high: 1600 })
})

test('the 0 → 1 crossing is still evidence', () => {
  const e = evidenceOf(zeroThenOne(), 1, 'union')!
  expect(e.pct).toBe(1)
  expect(e.crossingUsd).toBe(7)
})

const recentPast = () => [1, 2, 3].map(i => pastAt(1000, i * 5 * HOUR_MS))

test('with a usable prior, a window at 0% is estimated from the prior alone', () => {
  const w = record(empty('five_hour'), 0, 0.14, NOW)
  const options = { resolution: 1, rounding: 'union' as const, kind: 'five_hour', now: NOW, livePercent: 0 }
  const e = estimate(w, 0.14, { ...options, past: recentPast() })!
  expect(e.isPriorOnly).toBe(true)
  expect(e.isPriorContradicted).toBe(false)
  expect(Math.abs(e.allowance.value / 1000 - 1)).toBeLessThan(0.01)
  expect(e.allowance.low).toBeLessThanOrEqual(1000)
  expect(e.allowance.high).toBeGreaterThanOrEqual(1000)
  expect(e.left.value).toBe(e.allowance.value - 0.14)
  expect(e.nextTick!.low).toBe(0)
  const single = estimate(w, 0.14, { ...options, past: [pastAt(703, 5 * HOUR_MS)] })!
  expect(single.isPriorOnly).toBe(true)
})

test('after the first tick the estimate rests on the readings again', () => {
  const e = estimate(zeroThenOne(), 8, { resolution: 1, rounding: 'union', past: recentPast(), kind: 'five_hour', now: NOW, livePercent: 1 })!
  expect(e.isPriorOnly).toBe(false)
})

test('a window read only at 100% has no estimate, with or without a prior', () => {
  const w = record(empty('five_hour'), 100, 1200, NOW)
  const options = { resolution: 1, rounding: 'union' as const, past: recentPast(), kind: 'five_hour', now: NOW }
  expect(estimate(w, 1200, { ...options, livePercent: 100 })).toBeUndefined()
  expect(estimate(w, 1200, options)).toBeUndefined()
})

test('a past point from a window that closed early carries the within-window term', () => {
  const closed = simulate(1000, 200, 2, rounded, empty('five_hour', new Date(NOW - HOUR_MS).toISOString()))
  const bare = pastOf(closed, 1, 'round', 0)!
  const point = pastOf(closed, 1, 'round', 0.5)!
  const { share } = evidenceOf(closed, 1, 'round')!
  expect(share).toBeLessThan(25)
  expect(Math.abs(point.variance - bare.variance - 0.25 * (1 / share - 1 / 100))).toBeLessThan(1e-12)
  const full = pastOf(simulate(1000, 1000, 2, rounded, empty('five_hour', new Date(NOW - HOUR_MS).toISOString())), 1, 'round', 0.5)!
  expect(full.variance).toBeLessThan(1e-4)
})

test('a prior just off the readings does not give a good range that misses the truth (F3)', () => {
  const past = [900, 908, 916].map((usd, i) => pastAt(usd, (i + 1) * 5 * HOUR_MS))
  for (const upTo of [200, 500, 900]) {
    const w = simulate(1000, upTo, 0.5, rounded, empty('five_hour'))
    const e = estimate(w, upTo, { resolution: 1, rounding: 'round', past, kind: 'five_hour', now: NOW, livePercent: rounded(upTo / 10) })!
    const isCovered = e.allowance.low <= 1000 && 1000 <= e.allowance.high
    expect(isCovered || e.confidence !== 'good').toBe(true)
  }
})

test('a contradicting prior is flagged and not applied', () => {
  const w = simulate(3000, 600, 1.5, rounded)
  const past = [10000, 10000, 10000].map(usd => pastAt(usd, DAY_MS))
  const e = estimate(w, 600, { resolution: 1, rounding: 'round', past, kind: 'seven_day', now: NOW, livePercent: 20 })!
  expect(e.isPriorContradicted).toBe(true)
  expect(e.allowance.high).toBeLessThan(5000)
  expect(e.allowance.low).toBeLessThanOrEqual(3000)
})

test('an agreeing prior narrows the range', () => {
  const w = simulate(3000, 600, 1.5, rounded)
  const options = { resolution: 1, rounding: 'round' as const, kind: 'seven_day', now: NOW, livePercent: 20 }
  const alone = estimate(w, 600, { ...options, past: [] })!
  const past = [2950, 3000, 3050, 3020].map(usd => pastAt(usd, DAY_MS))
  const helped = estimate(w, 600, { ...options, past })!
  expect(helped.isPriorContradicted).toBe(false)
  expect(helped.allowance.high / helped.allowance.low).toBeLessThan(alone.allowance.high / alone.allowance.low)
  expect(helped.allowance.low).toBeLessThanOrEqual(3000)
  expect(helped.allowance.high).toBeGreaterThanOrEqual(3000)
})

test('tQuantile matches tables', () => {
  expect(Math.abs(tQuantile(0.95, 4) / 2.132 - 1)).toBeLessThan(0.01)
  expect(Math.abs(tQuantile(0.95, 10) / 1.812 - 1)).toBeLessThan(0.005)
  expect(Math.abs(tQuantile(0.95, 1e9) / 1.645 - 1)).toBeLessThan(0.001)
})

test('next tick never exceeds one tick of the allowance, and is absent without a live percent', () => {
  const options = { resolution: 1, rounding: 'round' as const, past: [], kind: 'seven_day', now: NOW }
  for (const upTo of [600, 1500, 2700]) {
    const w = simulate(3000, upTo, 1.5, rounded)
    const e = estimate(w, upTo, { ...options, livePercent: rounded((upTo / 3000) * 100) })!
    const tick = e.allowance.high / 100
    expect(e.nextTick!.high).toBeLessThanOrEqual(tick + 1e-9)
    expect(e.nextTick!.low).toBeGreaterThanOrEqual(0)
    expect(e.nextTick!.value).toBeGreaterThanOrEqual(e.nextTick!.low)
    expect(e.nextTick!.value).toBeLessThanOrEqual(e.nextTick!.high)
    expect(estimate(w, upTo, options)!.nextTick).toBeUndefined()
  }
})

test('calibrateOmega is assumed without closed windows, and measures them', () => {
  const assumed = calibrateOmega([], 'five_hour', NOW, 1, 'round')
  expect(assumed.isAssumed).toBe(true)
  expect(assumed.omega).toBe(0.5)
  expect(assumed.windows).toBe(0)
  const closed = [1000, 1100, 900].map((a, i) => simulate(a, a, a / 500, rounded, empty('five_hour', new Date(NOW - (i + 1) * 5 * HOUR_MS).toISOString())))
  const measured = calibrateOmega(closed, 'five_hour', NOW, 1, 'round')
  expect(measured.isAssumed).toBe(false)
  expect(measured.windows).toBe(3)
  expect(measured.weight).toBeGreaterThan(0)
  /* Steady spending: only quantization is left, far below the assumed spread. */
  expect(measured.omega).toBeLessThan(0.5)
})

test('the within-window spread is measured from two closed windows, and light ones count', () => {
  const at = (i: number) => empty('five_hour', new Date(NOW - (i + 1) * 5 * HOUR_MS).toISOString())
  const one = calibrateOmega([simulate(1000, 1000, 2, rounded, at(0))], 'five_hour', NOW, 1, 'round')
  expect(one.windows).toBe(1)
  expect(one.isAssumed).toBe(true)
  expect(one.omega).toBeLessThan(0.5)
  /* Closed at 20% and 30%: crossings from 5% to half the final share. */
  const light = calibrateOmega([simulate(1000, 200, 2, rounded, at(0)), simulate(1000, 300, 2, rounded, at(1))], 'five_hour', NOW, 1, 'round')
  expect(light.windows).toBe(2)
  expect(light.isAssumed).toBe(false)
  /* Closed at 8%: no crossing in [5, 4]. */
  expect(calibrateOmega([simulate(1000, 80, 2, rounded, at(0))], 'five_hour', NOW, 1, 'round').windows).toBe(0)
})

test('record keeps the slack of the reading on each side', () => {
  let w = empty()
  w = record(w, 5, 50, 100, 2)
  w = record(w, 5, 55, 200, 3)
  expect(w.byPct['5']).toEqual({ minUsd: 50, minAt: 100, maxUsd: 55, maxAt: 200, minSlack: 2, maxSlack: 3 })
})

test('inferRounding needs 5 windows, then finds truncation and rounding', () => {
  const allowances = [1000, 1200, 900, 1100, 950]
  const truncatedWindows = allowances.map(a => simulate(a, a * 0.4, a / 300, truncated))
  const roundedWindows = allowances.map(a => simulate(a, a * 0.4, a / 300, rounded))
  expect(inferRounding(truncatedWindows.slice(0, 4), 1)).toBe('union')
  expect(inferRounding(truncatedWindows, 1)).toBe('truncate')
  expect(inferRounding(roundedWindows, 1)).toBe('round')
})

test('inferRounding stays with the union when both rules are often contradicted', () => {
  const allowances = [1000, 1200, 900, 1100, 950]
  const truncatedWindows = allowances.map(a => simulate(a, a * 0.4, a / 300, truncated))
  const roundedWindows = allowances.map(a => simulate(a, a * 0.4, a / 300, rounded))
  expect(inferRounding([...truncatedWindows, ...roundedWindows], 1)).toBe('union')
})

test('a 20-day-old 5-hour point weighs under 0.001 and does not move the prior', () => {
  expect(weightOf('five_hour', 20 * DAY_MS)).toBeLessThan(0.001)
  const recent = [1000, 1010, 990].map(usd => pastAt(usd, HOUR_MS))
  const withOld = prior([...recent, pastAt(5000, 20 * DAY_MS)], 'five_hour', NOW)
  const without = prior(recent, 'five_hour', NOW)
  expect(Math.abs(withOld.mean - without.mean)).toBeLessThan(1e-4)
})

test('three equal past points shrink the spread toward the assumed one, not to 0', () => {
  const p = prior([1000, 1000, 1000].map(usd => pastAt(usd, 0)), 'five_hour', NOW)
  expect(p.tau2).toBeGreaterThan(0)
  expect(p.tau2).toBeLessThan(0.1 ** 2)
  const exact = (usd: number): PastPoint => ({ logA: Math.log(usd), variance: 0, at: NOW })
  expect(prior([1000, 1000, 1000].map(exact), 'five_hour', NOW).isSpreadAssumed).toBe(false)
  expect(prior([pastAt(1000, 0)], 'five_hour', NOW).isSpreadAssumed).toBe(true)
})

test('exact past points give the age-weighted prior: mean, spread and predictive variance', () => {
  const values = [1000, 1100, 950, 1050]
  const past = values.map((usd, i): PastPoint => ({ logA: Math.log(usd), variance: 0, at: NOW - i * 6 * HOUR_MS }))
  const p = prior(past, 'five_hour', NOW)
  const w = past.map(x => weightOf('five_hour', NOW - x.at))
  const sw = w.reduce((a, b) => a + b, 0)
  const sw2 = w.reduce((a, b) => a + b * b, 0)
  const mean = past.reduce((a, x, i) => a + w[i]! * x.logA, 0) / sw
  const s2 = past.reduce((a, x, i) => a + w[i]! * (x.logA - mean) ** 2, 0) / (sw - sw2 / sw)
  const nEff = (sw * sw) / sw2
  const tau2 = (4 * 0.01 + (nEff - 1) * s2) / (4 + nEff - 1)
  expect(Math.abs(p.mean - mean)).toBeLessThan(1e-12)
  expect(Math.abs(p.nEff - nEff)).toBeLessThan(1e-9)
  expect(Math.abs(p.tau2 - tau2)).toBeLessThan(1e-12)
  expect(Math.abs(p.variance - (tau2 + tau2 / nEff))).toBeLessThan(1e-12)
})

test('a noisy past point weighs by its information', () => {
  const precise = [1000, 1000, 1000].map(usd => pastAt(usd, HOUR_MS))
  const noisy: PastPoint = { logA: Math.log(2000), variance: 0.3, at: NOW - HOUR_MS }
  const p = prior([...precise, noisy], 'five_hour', NOW)
  /* Equal weights would put the mean at a quarter of log 2 above log 1000. */
  expect(p.mean - Math.log(1000)).toBeLessThan(0.05 * Math.log(2))
  /* Three points that say little about tau leave it assumed. */
  const vague = [900, 1000, 1100].map((usd): PastPoint => ({ logA: Math.log(usd), variance: 0.1, at: NOW - HOUR_MS }))
  const q = prior(vague, 'five_hour', NOW)
  expect(q.isSpreadAssumed).toBe(true)
  expect(q.isUsable).toBe(true)
  expect(q.points).toBe(3)
})

test('roundingEvidence counts what inferRounding decides from', () => {
  const allowances = [1000, 1200, 900, 1100, 950]
  const truncatedWindows = allowances.map(a => simulate(a, a * 0.4, a / 300, truncated))
  const seen = roundingEvidence(truncatedWindows, 1)
  expect(seen.considered).toBe(5)
  expect(seen.truncateConflicts).toBe(0)
  expect(seen.roundConflicts).toBeGreaterThanOrEqual(3)
  expect(seen.rule).toBe('truncate')
  const four = roundingEvidence(truncatedWindows.slice(0, 4), 1)
  expect(four.considered).toBe(4)
  expect(four.rule).toBe('union')
})

test('calibrationOf counts levels and ticks, and what is measured', () => {
  let w = empty('five_hour')
  w = record(w, 3, 30, NOW - 3000)
  w = record(w, 4, 41, NOW - 2000)
  w = record(w, 6, 62, NOW - 1000)
  const none = calibrationOf({ current: w, resolution: 1, spread: ASSUMED_SPREAD, prior: prior([], 'five_hour', NOW), rounding: roundingEvidence([], 1) })
  expect(none).toEqual({
    levels: 3,
    ticks: 1,
    closedForWithin: 0,
    isWithinMeasured: false,
    pastPoints: 0,
    pastWeight: 0,
    isBetweenMeasured: false,
    closedForRounding: 0,
    isRoundingKnown: false,
    measured: 0,
    isCalibrated: false,
  })
  const past = [1000, 1010, 990, 1005].map(usd => ({ logA: Math.log(usd), variance: 0, at: NOW - HOUR_MS }))
  const all = calibrationOf({
    resolution: 1,
    spread: { omega: 0.2, weight: 40, windows: 4, isAssumed: false },
    prior: prior(past, 'five_hour', NOW),
    rounding: { considered: 6, roundConflicts: 0, truncateConflicts: 5, rule: 'round' },
  })
  expect(all.levels).toBe(0)
  expect(all.pastPoints).toBe(4)
  expect(all.measured).toBe(3)
  expect(all.isCalibrated).toBe(true)
})

test('regimeView drops earlier buckets and keeps the max side of a straddling one', () => {
  let w = empty()
  w = record(w, 5, 50, 100)
  w = record(w, 7, 70, 200)
  w = record(w, 7, 75, 400)
  const view = regimeView(w, 300)
  expect(view.byPct['5']).toBeUndefined()
  expect(view.byPct['7']).toEqual({ minUsd: 75, minAt: 400, maxUsd: 75, maxAt: 400, minSlack: 0, maxSlack: 0 })
})

test('regimeView bounds contain the new allowance after a mid-window change', () => {
  /* $1,000 until the change, $3,000 after; dollars keep accumulating through it. */
  let w = empty()
  let at = NOW - DAY_MS
  const changedAt = at + 300 * 60 * 1000
  for (let usd = 1; usd <= 600; usd += 1) {
    const allowance = at < changedAt ? 1000 : 3000
    w = record(w, Math.round((usd / allowance) * 100), usd, at)
    at += 60 * 1000
  }
  const mixed = bounds(w, 1, 'round')
  expect(mixed.low).toBeGreaterThan(mixed.high)
  const b = bounds(regimeView(w, changedAt), 1, 'round')
  expect(b.low).toBeLessThanOrEqual(3000)
  expect(b.high).toBeGreaterThanOrEqual(3000)
})

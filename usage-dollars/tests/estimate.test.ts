import { expect, test } from 'claude-code/testing'

import { bounds, consistentBounds, estimate, inferRounding, observed, prior, record, regimeView, weightOf } from '../hooks/estimate'
import type { PastPoint, WindowReadings } from '../hooks/estimate'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const NOW = Date.parse('2026-10-05T12:00:00.000Z')

const empty = (kind = 'seven_day'): WindowReadings => ({ kind, resetsAt: new Date(NOW + DAY_MS).toISOString(), byPct: {} })

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

test('rounded readings of a $3,000 allowance give a range within ±20% after $600', () => {
  const w = simulate(3000, 600, 1.5, rounded)
  const e = estimate(w, 600, { resolution: 1, rounding: 'round', past: [], kind: 'seven_day', now: NOW, livePercent: 20 })
  expect(e).toBeDefined()
  expect(e!.allowance.low).toBeLessThanOrEqual(3000)
  expect(e!.allowance.high).toBeGreaterThanOrEqual(3000)
  expect(e!.allowance.low).toBeGreaterThan(2400)
  expect(e!.allowance.high).toBeLessThan(3600)
})

/* Readings at three levels that no rounding explains. */
const inconsistent = (): WindowReadings => {
  let w = empty()
  w = record(w, 10, 100, NOW - 3 * HOUR_MS)
  w = record(w, 20, 100, NOW - 2 * HOUR_MS)
  return record(w, 30, 400, NOW - HOUR_MS)
}

test('inferRounding finds truncation after 3 windows, and rounding', () => {
  const truncatedWindows = [1000, 1200, 900].map(a => simulate(a, a * 0.4, a / 300, truncated))
  const roundedWindows = [1000, 1200, 900].map(a => simulate(a, a * 0.4, a / 300, rounded))
  expect(inferRounding(truncatedWindows.slice(0, 2), 1)).toBe('union')
  expect(inferRounding(truncatedWindows, 1)).toBe('truncate')
  expect(inferRounding(roundedWindows, 1)).toBe('round')
})

test('a window inconsistent under the union changes neither inference', () => {
  const truncatedWindows = [1000, 1200, 900].map(a => simulate(a, a * 0.4, a / 300, truncated))
  const roundedWindows = [1000, 1200, 900].map(a => simulate(a, a * 0.4, a / 300, rounded))
  const odd = inconsistent()
  const union = bounds(odd, 1, 'union')
  expect(union.low).toBeGreaterThan(union.high)
  expect(inferRounding([...truncatedWindows, odd], 1)).toBe('truncate')
  expect(inferRounding([...roundedWindows, odd], 1)).toBe('round')
})

test('a 20-day-old 5-hour point weighs under 0.001 and does not move the prior', () => {
  expect(weightOf('five_hour', 20 * DAY_MS)).toBeLessThan(0.001)
  const recent: PastPoint[] = [1000, 1010, 990].map(usd => ({ usd, at: NOW - HOUR_MS }))
  const withOld = prior([...recent, { usd: 5000, at: NOW - 20 * DAY_MS }], 'five_hour', NOW)
  const without = prior(recent, 'five_hour', NOW)
  expect(Math.abs(withOld.mean - without.mean)).toBeLessThan(1e-4)
})

test('three equal past points give a mix error of 3%, not 0', () => {
  const p = prior([1000, 1000, 1000].map(usd => ({ usd, at: NOW })), 'five_hour', NOW)
  expect(p.sd).toBe(0)
  expect(p.mix).toBe(0.03)
  expect(p.isMixErrorAssumed).toBe(false)
})

test('a contradicting prior is flagged and not applied', () => {
  const w = simulate(3000, 600, 1.5, rounded)
  const past = [10000, 10000, 10000].map(usd => ({ usd, at: NOW - DAY_MS }))
  const e = estimate(w, 600, { resolution: 1, rounding: 'round', past, kind: 'seven_day', now: NOW, livePercent: 20 })
  expect(e!.isPriorContradicted).toBe(true)
  expect(e!.allowance.high).toBeLessThan(5000)
  expect(e!.allowance.low).toBeLessThanOrEqual(3000)
})

test('next tick is positive and within its range, and absent without a live percent', () => {
  const w = simulate(3000, 600, 1.5, rounded)
  const options = { resolution: 1, rounding: 'round' as const, past: [], kind: 'seven_day', now: NOW }
  const e = estimate(w, 600, { ...options, livePercent: 20 })
  expect(e!.nextTick).toBeDefined()
  expect(e!.nextTick!.value).toBeGreaterThan(0)
  expect(e!.nextTick!.value).toBeGreaterThanOrEqual(e!.nextTick!.low)
  expect(e!.nextTick!.value).toBeLessThanOrEqual(e!.nextTick!.high)
  expect(estimate(w, 600, options)!.nextTick).toBeUndefined()
})

test('regimeView drops earlier buckets and keeps the max side of a straddling one', () => {
  let w = empty()
  w = record(w, 5, 50, 100)
  w = record(w, 7, 70, 200)
  w = record(w, 7, 75, 400)
  const view = regimeView(w, 300)
  expect(view.byPct['5']).toBeUndefined()
  expect(view.byPct['7']).toEqual({ minUsd: 75, minAt: 400, maxUsd: 75, maxAt: 400 })
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

/* A $650 five-hour allowance read at 9% and 10%, rounded; `stale` adds a 4% reading with
   the dollars of the 9% one, as a session holding an old percent would record. */
function fiveHourAt650(stale: boolean) {
  let w = empty('five_hour')
  w = record(w, 9, 60, NOW - 50 * 60 * 1000)
  w = record(w, 9, 61.5, NOW - 40 * 60 * 1000)
  if (stale) w = record(w, 4, 61.5, NOW - 40 * 60 * 1000)
  w = record(w, 10, 62.5, NOW - 30 * 60 * 1000)
  return record(w, 10, 64, NOW - 20 * 60 * 1000)
}

test('a stale percent is set aside, and the estimate holds $650 and not $960', () => {
  const w = fiveHourAt650(true)
  const c = consistentBounds(w, 1, 'union')
  expect(c.dropped).toBe(1)
  expect(c.kept).toBe(2)
  const e = estimate(w, 64, { resolution: 1, rounding: 'union', past: [], kind: 'five_hour', now: NOW })
  expect(e!.droppedReadings).toBe(1)
  expect(e!.allowance.low).toBeLessThanOrEqual(650)
  expect(e!.allowance.high).toBeGreaterThanOrEqual(650)
  expect(e!.allowance.high).toBeLessThan(960)
})

test('without a conflict, consistentBounds equals bounds', () => {
  for (const w of [simulate(3000, 600, 1.5, rounded), fiveHourAt650(false)]) {
    const c = consistentBounds(w, 1, 'union')
    const b = bounds(w, 1, 'union')
    expect(c.low).toBe(b.low)
    expect(c.high).toBe(b.high)
    expect(c.dropped).toBe(0)
  }
})

test('of two agreeing pairs that contradict each other, the newer pair is kept', () => {
  let w = empty('five_hour')
  w = record(w, 4, 50, NOW - 3 * HOUR_MS)
  w = record(w, 5, 62, NOW - 3 * HOUR_MS + 60 * 1000)
  w = record(w, 9, 61.5, NOW - HOUR_MS)
  w = record(w, 10, 64, NOW - HOUR_MS + 60 * 1000)
  const c = consistentBounds(w, 1, 'union')
  const newer = bounds(fiveHourAt650(false), 1, 'union')
  expect(c.kept).toBe(2)
  expect(c.dropped).toBe(2)
  expect(c.low).toBe(newer.low)
  expect(c.low).toBeLessThan(650)
  expect(c.high).toBeGreaterThan(650)
})

test('a closed window with a conflicting level is no observed allowance', () => {
  expect(observed(fiveHourAt650(false), 1, 'union')).toBeDefined()
  expect(observed(fiveHourAt650(true), 1, 'union')).toBeUndefined()
})

test('when every level contradicts itself, the estimate meets in the middle', () => {
  let w = empty('five_hour')
  w = record(w, 1, 10, NOW - 2 * HOUR_MS)
  w = record(w, 1, 100, NOW - 90 * 60 * 1000)
  w = record(w, 2, 20, NOW - HOUR_MS)
  w = record(w, 2, 200, NOW - 30 * 60 * 1000)
  const c = consistentBounds(w, 1, 'union')
  expect(c.kept).toBe(0)
  expect(c.dropped).toBe(2)
  const b = bounds(w, 1, 'union')
  expect(b.low).toBeGreaterThan(b.high)
  const e = estimate(w, 200, { resolution: 1, rounding: 'union', past: [], kind: 'five_hour', now: NOW })
  expect(e).toBeDefined()
  expect(Math.abs(e!.allowance.value / Math.sqrt(b.low * b.high) - 1)).toBeLessThan(1e-9)
  expect(e!.droppedReadings).toBe(0)
})

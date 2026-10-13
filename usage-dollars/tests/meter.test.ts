import { expect, test } from 'claude-code/testing'

import { calibrateOmega, estimate, pastPoints, record } from '../hooks/estimate'
import type { WindowReadings } from '../hooks/estimate'
import {
  UNIT_WEIGHTS,
  fit,
  groupsOf,
  isFeatureComplete,
  segmentsOf,
  selectModel,
  transferCheck,
  weightedEstimate,
  weightedView,
  weightsOf,
} from '../hooks/meter'
import type { Weights } from '../hooks/meter'

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const T0 = Date.parse('2026-10-01T01:00:00.000Z')
const OPTIONS = { resolution: 1, rounding: 'truncate' as const }
const COST = 0.002
/* F requests per 10, by block of 100 requests: the mix varies within every window. */
const F_PER_TEN = [1, 5, 2, 7, 3]

const F_TWICE: Weights = weightsOf({ model: 'M1', reference: 'O', free: ['F'] }, [Math.log(2)], [[1e-4]], 5)

const empty = (kind = 'five_hour', resetsAt = new Date(T0 + 5 * HOUR_MS).toISOString()): WindowReadings => ({ kind, resetsAt, byPct: {} })

/* A deterministic uniform generator on [0, 1). */
function uniform(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

type Synthetic = { kind: string; start: number; spanMs: number; requests: number; quota: number; weightF: number; phase: number; noise?: () => number }

/* A window read after every request of COST dollars of model F or O, its percent truncated
   from a meter that counts F at weightF; noise multiplies each request's meter use. */
function synthetic(o: Synthetic): WindowReadings {
  let w = empty(o.kind, new Date(o.start + o.spanMs + HOUR_MS).toISOString())
  let usdO = 0
  let usdF = 0
  let meter = 0
  w = record(w, 0, 0, o.start, 0, { 'F/out': 0, 'O/out': 0 })
  for (let i = 0; i < o.requests; i++) {
    const isF = i % 10 < F_PER_TEN[Math.floor((i + o.phase) / 100) % F_PER_TEN.length]
    const use = COST * (o.noise ? o.noise() : 1)
    if (isF) {
      usdF += COST
      meter += o.weightF * use
    } else {
      usdO += COST
      meter += use
    }
    const at = o.start + ((i + 1) * o.spanMs) / o.requests
    w = record(w, Math.floor((100 * meter) / o.quota), usdO + usdF, at, 0, { 'F/out': usdF, 'O/out': usdO })
  }
  return w
}

const QUOTAS = [10, 12, 8, 11, 9, 10]

const fiveHour = (weightF: number, noise?: () => number) =>
  QUOTAS.map((quota, j) =>
    synthetic({ kind: 'five_hour', start: T0 + j * 5 * HOUR_MS, spanMs: 4 * HOUR_MS, requests: 1000, quota, weightF, phase: j * 130, noise }),
  )

const noise = uniform(7)
const F2 = fiveHour(2)
const NULL = fiveHour(1, () => 0.5 + noise())

const week = (weightF: number, days: number, quota: number) =>
  synthetic({ kind: 'seven_day', start: T0, spanMs: days * DAY_MS, requests: 1500, quota, weightF, phase: 0 })

/* The newest reading: its percent, dollars and per-feature dollars. */
function lastOf(w: WindowReadings) {
  const [key, b] = Object.entries(w.byPct).reduce((a, c) => (c[1].maxAt > a[1].maxAt ? c : a))
  return { pct: Number(key), usd: b.maxUsd, x: Object.fromEntries((w.features ?? []).map((f, i) => [f, b.maxX?.[i] ?? 0])) }
}

test('weightedView returns its input under unit weights, and w · X under others', () => {
  const plain = record(empty(), 3, 30, T0)
  expect(weightedView(plain, UNIT_WEIGHTS)).toBe(plain)
  expect(weightedView(plain, weightsOf(F_TWICE, [0]))).toBe(plain)
  expect(weightedView(plain, F_TWICE)).toBeUndefined()
  let w = record(empty(), 1, 3, T0, 0.5, { 'F/out': 1, 'O/out': 2 })
  w = record(w, 2, 6, T0 + MINUTE_MS, 0, { 'F/out': 2, 'O/out': 4 })
  expect(isFeatureComplete(w)).toBe(true)
  const view = weightedView(w, F_TWICE)!
  expect(Math.abs(view.byPct['1'].maxUsd - 4)).toBeLessThan(1e-12)
  expect(Math.abs(view.byPct['1'].maxSlack! - (0.5 * 4) / 3)).toBeLessThan(1e-12)
  expect(Math.abs(view.byPct['2'].minUsd - 8)).toBeLessThan(1e-12)
})

test('segments match a hand-computed window', () => {
  const readings = [
    [9, 90, 60, 30],
    [10, 92, 61, 31],
    [10, 100, 65, 35],
    [11, 104, 66, 38],
    [12, 110, 68, 42],
    [13, 120, 70, 50],
    [14, 126, 72, 54],
  ]
  let w = empty()
  readings.forEach(([pct, usd, a, b], i) => {
    w = record(w, pct, usd, T0 + i * MINUTE_MS, 0, { a, b })
  })
  /* Crossings at 10, 12 and 14: X = (60.5, 30.5), (67, 40), (71, 52). */
  expect(segmentsOf(w, 1, 'truncate')).toEqual([
    { dX: { a: 6.5, b: 9.5 }, ds: 2, gapA: { a: 1, b: 1 }, gapB: { a: 2, b: 4 }, at: T0 + 4 * MINUTE_MS, isExcluded: false },
    { dX: { a: 4, b: 12 }, ds: 2, gapA: { a: 2, b: 4 }, gapB: { a: 2, b: 4 }, at: T0 + 6 * MINUTE_MS, isExcluded: false },
  ])
})

test('the outlier rule excludes a zero-dollar tick', () => {
  /* Dollars at levels 1 to 16: levels 9 to 12 tick with no dollars of this machine. */
  const usd = [1, 2, 3, 4, 5, 6, 7, 8, 8, 8, 8, 8, 9, 10, 11, 12]
  let w = empty()
  usd.forEach((u, i) => {
    w = record(w, i + 1, u, T0 + i * MINUTE_MS, 0, { a: u })
  })
  const segments = segmentsOf(w, 1, 'truncate')
  expect(segments.map(s => s.isExcluded)).toEqual([false, false, false, false, true, false, false])
})

test('a group under 2% of the dollars is merged into the reference', () => {
  expect(groupsOf('M1', { 'O/out': 90, 'F/out': 9, 'H/out': 1 })).toEqual({ model: 'M1', reference: 'O', free: ['F'] })
  expect(groupsOf('M2', { 'O/read': 50, 'O/out': 40, 'F/out': 9, 'F+fast/read': 1, web: 5 })).toEqual({
    model: 'M2',
    reference: 'O/other',
    free: ['F/other', 'O/read'],
  })
  expect(groupsOf('M0', { 'O/out': 90, 'F/out': 10 })).toEqual({ model: 'M0', reference: 'all', free: [] })
})

test('noise-free windows with F metered at twice its price recover θ = log 2', () => {
  expect(F2.every(w => isFeatureComplete(w))).toBe(true)
  const f = fit('M1', F2, OPTIONS)!
  expect(f.windows).toBe(6)
  expect(f.groups).toEqual({ model: 'M1', reference: 'O', free: ['F'] })
  expect(Math.abs(f.theta[0] - Math.log(2))).toBeLessThan(0.02)
  expect(f.se[0]).toBeGreaterThan(0)
  expect(f.df).toBe(5)
})

test('F at twice its price selects M1, and null data select M0', () => {
  const s = selectModel(F2, OPTIONS)
  expect(s.selected).toBe('M1')
  expect(s.weights.free).toEqual(['F'])
  expect(s.comparisons.map(c => [c.from, c.to])).toEqual([
    ['M0', 'M1'],
    ['M1', 'M2'],
  ])
  const n = selectModel(NULL, OPTIONS)
  expect(n.selected).toBe('M0')
  expect(n.weights).toEqual(UNIT_WEIGHTS)
  expect(n.windows.used).toBe(6)
})

test('fit takes five_hour windows only', () => {
  let isThrown = false
  try {
    fit('M1', [...F2.slice(0, 3), week(2, 6, 7)], OPTIONS)
  } catch {
    isThrown = true
  }
  expect(isThrown).toBe(true)
})

test('fewer than 4 windows: no fit, and M0 selected', () => {
  expect(fit('M1', F2.slice(0, 3), OPTIONS)).toBeUndefined()
  const s = selectModel(F2.slice(0, 3), OPTIONS)
  expect(s.selected).toBe('M0')
  expect(s.fits).toEqual({})
  expect(s.comparisons).toEqual([])
})

test('transferCheck: unchecked below 5 days, rejects a week metered at 1, accepts one at 2', () => {
  const short = transferCheck([week(1, 3, 5)], F_TWICE, OPTIONS)
  expect(short.weeks).toBe(1)
  expect(short.days).toBeLessThan(5)
  expect(short.isChecked).toBe(false)
  expect(short.isRejected).toBe(false)
  const wrong = transferCheck([week(1, 6, 5)], F_TWICE, OPTIONS)
  expect(wrong.isChecked).toBe(true)
  expect(wrong.isRejected).toBe(true)
  const right = transferCheck([week(2, 6, 7)], F_TWICE, OPTIONS)
  expect(right.isChecked).toBe(true)
  expect(right.isRejected).toBe(false)
  expect(right.delta).toBeGreaterThan(0)
  const unit = transferCheck([week(2, 6, 7)], UNIT_WEIGHTS, OPTIONS)
  expect(unit.isChecked).toBe(false)
  expect(unit.omega.selected).toBe(unit.omega.M0)
})

const NOW = T0 + 32.5 * HOUR_MS
const currentOf = (weightF: number) => synthetic({ kind: 'five_hour', start: T0 + 30 * HOUR_MS, spanMs: 2 * HOUR_MS, requests: 400, quota: 10, weightF, phase: 0 })

const inputOf = (closed: readonly WindowReadings[], current: WindowReadings, weights: Weights) => {
  const last = lastOf(current)
  return {
    kind: 'five_hour',
    closed,
    current,
    usedUsd: last.usd,
    usedX: last.x,
    weights,
    rejections: [],
    ...OPTIONS,
    now: NOW,
    livePercent: last.pct,
    startedAt: 0,
  }
}

test('weightedEstimate under unit weights is the plain pipeline', () => {
  const current = currentOf(1)
  const r = weightedEstimate(inputOf(NULL, current, UNIT_WEIGHTS))
  const spread = calibrateOmega(NULL, 'five_hour', NOW, 1, 'truncate')
  const past = pastPoints(NULL, [], 'five_hour', 1, 'truncate', spread.omega).filter(p => p.at >= 0)
  const last = lastOf(current)
  const plain = estimate(current, last.usd, { ...OPTIONS, past, kind: 'five_hour', now: NOW, livePercent: last.pct, spread })!
  expect(r.estimate).toEqual(plain)
  expect(r.display).toEqual({ allowance: plain.allowance, left: plain.left, nextTick: plain.nextTick })
  expect(r.spread).toEqual(spread)
  expect(r.past).toEqual(past)
  expect(r.mixWeight).toBe(1)
  expect(r.extraVariance).toBe(0)
})

test('weightedEstimate under weights adds the weights’ variance and displays in dollars', () => {
  const r = weightedEstimate(inputOf(F2, currentOf(2), F_TWICE))
  const e = r.estimate!
  expect(r.excludedClosed).toBe(0)
  expect(r.extraVariance).toBeGreaterThan(0)
  expect(r.mixWeight).toBeGreaterThan(1)
  expect(r.mixWeight).toBeLessThan(2)
  expect(Math.abs(r.display!.allowance.value * r.mixWeight - e.allowance.value)).toBeLessThan(1e-9)
})

test('the output is deterministic', () => {
  expect(selectModel(F2, OPTIONS)).toEqual(selectModel(F2, OPTIONS))
  const input = inputOf(F2, currentOf(2), F_TWICE)
  expect(weightedEstimate(input)).toEqual(weightedEstimate(input))
})

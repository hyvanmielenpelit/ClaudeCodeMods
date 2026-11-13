import { expect, test } from 'claude-code/testing'

import type { Bucket, WindowReadings } from '../hooks/estimate'
import {
  cappedWeeksOf,
  fableCapAt,
  fableUseE,
  fableWeightsOf,
  fableWindow,
  isAfterFableCap,
  isFableFeature,
  isFableInFit,
} from '../hooks/fable'
import type { FitSource } from '../hooks/fable'
import { UNIT_WEIGHTS, weightsOf } from '../hooks/meter'
/* expect(actual).toBeCloseTo(expected, digits), which claude-code/testing lacks. */
const expectNear = (actual: number | undefined, expected: number, digits: number) =>
  expect(Math.abs((actual ?? NaN) - expected)).toBeLessThan(10 ** -digits / 2)

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const T0 = Date.parse('2026-11-09T00:00:00.000Z')
const FABLE = 'claude-fable-5-2/in'
const OPUS = 'claude-opus-5-5/in'

/* Fable counted at 0.8 of Opus 5.5, and a weekly fit at 0.9. */
const FABLE_LOW = weightsOf({ model: 'M1', reference: 'claude-opus-5-5', free: ['claude-fable-5-2'] }, [Math.log(0.8)], [[0.01]], 9)
const WEEKLY = weightsOf({ model: 'M1', reference: 'claude-opus-5-5', free: ['claude-fable-5-2'] }, [Math.log(0.9)], [[0.04]], 3)
/* Opus counted at half of Fable 5.2, the reference. */
const OPUS_HALF = weightsOf({ model: 'M1', reference: 'claude-fable-5-2', free: ['claude-opus-5-5'] }, [Math.log(0.5)], [[0.01]], 9)
const range = (value: number, low = value, high = value) => ({ value, low, high })

const fitted = (over: Partial<FitSource> = {}): FitSource => ({
  pricesId: 'p1',
  selection: { selected: 'M1', fits: { M0: {}, M1: {} } },
  transfer: { isRejected: false, weeks: 4, weeklyFit: { weights: WEEKLY } },
  fits: { seven_day: { weights: FABLE_LOW } },
  ...over,
})

/* A window over Fable 5.2 and Opus 5.5 input, one bucket per level, each side with its
   [Fable, Opus] dollars. */
function windowOf(kind: string, resetsAt: number, levels: Record<number, { min: [number, number]; max?: [number, number]; minAt: number; maxAt?: number }>): WindowReadings {
  const byPct: Record<string, Bucket> = {}
  for (const [pct, l] of Object.entries(levels)) {
    const max = l.max ?? l.min
    byPct[pct] = {
      minUsd: l.min[0] + l.min[1],
      minAt: l.minAt,
      maxUsd: max[0] + max[1],
      maxAt: l.maxAt ?? l.minAt,
      minX: [...l.min],
      maxX: [...max],
    }
  }
  return { kind, resetsAt: new Date(resetsAt).toISOString(), byPct, features: [FABLE, OPUS] }
}

const WEEK_END = T0 + 7 * DAY_MS

test('isFableFeature: Fable and Mythos price keys, normal or fast; never another model or web', () => {
  expect(isFableFeature('claude-fable-5-2/out')).toBe(true)
  expect(isFableFeature('claude-mythos-5-2+fast/read')).toBe(true)
  expect(isFableFeature('claude-fable-5/in')).toBe(true)
  expect(isFableFeature('claude-opus-5-5/out')).toBe(false)
  expect(isFableFeature('web')).toBe(false)
})

test("fableWeightsOf takes the 5-hour study's week weights while fitted, M0 included", () => {
  expect(fableWeightsOf(fitted(), 'p1')).toEqual({ weights: FABLE_LOW, source: 'five-hour' })
  const m0 = fitted({ selection: { selected: 'M0', fits: { M0: {} } }, fits: { seven_day: { weights: UNIT_WEIGHTS } } })
  expect(fableWeightsOf(m0, 'p1')).toEqual({ weights: UNIT_WEIGHTS, source: 'five-hour' })
})

test('fableWeightsOf falls back to the weekly fit when the study is unfitted or its weeks reject it', () => {
  expect(fableWeightsOf(fitted({ selection: { selected: 'M0', fits: {} } }), 'p1')).toEqual({ weights: WEEKLY, source: 'weekly', weeks: 4 })
  const rejected = fitted({ transfer: { isRejected: true, weeks: 5, weeklyFit: { weights: WEEKLY } } })
  expect(fableWeightsOf(rejected, 'p1')).toEqual({ weights: WEEKLY, source: 'weekly', weeks: 5 })
})

test('fableWeightsOf assumes unit weights without a usable entry, and never throws on a partial one', () => {
  const assumed = { weights: UNIT_WEIGHTS, source: 'assumed' }
  expect(fableWeightsOf(undefined, 'p1')).toEqual(assumed)
  expect(fableWeightsOf(fitted(), 'p2')).toEqual(assumed)
  expect(fableWeightsOf(fitted({ selection: { selected: 'M1', fits: {} }, transfer: { isRejected: false, weeks: 2 } }), 'p1')).toEqual(assumed)
  expect(fableWeightsOf({ pricesId: 'p1', fits: { seven_day: { weights: FABLE_LOW } } }, 'p1')).toEqual(assumed)
  expect(fableWeightsOf({} as FitSource, undefined)).toEqual({ weights: UNIT_WEIGHTS, source: 'assumed' })
})

test('isFableInFit: always under M0; with Fable free or the reference; not when the fit holds no Fable group', () => {
  const x = { [FABLE]: 10, [OPUS]: 30, web: 1 }
  expect(isFableInFit(UNIT_WEIGHTS, x)).toBe(true)
  expect(isFableInFit(FABLE_LOW, x)).toBe(true)
  expect(isFableInFit(OPUS_HALF, x)).toBe(true)
  const sonnet = weightsOf({ model: 'M1', reference: 'claude-opus-5-5', free: ['claude-sonnet-5-5'] }, [Math.log(1.1)], [[0.01]], 9)
  expect(isFableInFit(sonnet, x)).toBe(false)
  expect(isFableInFit(sonnet, { 'claude-mythos-5-2/out': 5, [OPUS]: 30 })).toBe(false)
})

test("fableUseE weighs Fable's features and adds its web searches at 1", () => {
  expectNear(fableUseE(FABLE_LOW, { [FABLE]: 10, [OPUS]: 5, web: 1 }, 10.5), 8.5, 12)
  expectNear(fableUseE(UNIT_WEIGHTS, { [FABLE]: 10 }, 10), 10, 12)
})

test('fableWindow under unit weights halves the plain weekly range, with left bounded by the week', () => {
  const w = fableWindow({ weekE: { allowance: range(100, 80, 120), left: range(60, 40, 80) }, fableE: 10, mix: range(1), share: 0.5 })
  expect(w.allowance).toEqual(range(50, 40, 60))
  expect(w.left).toEqual(range(40, 30, 50))
  expectNear(w.usedShare, 0.2, 12)
  expect(w.isCapLikely).toBe(false)
})

test("fableWindow converts to Fable's dollars by its mix weight, low end by the mix's high end", () => {
  const weekE = { allowance: range(100, 80, 120), left: range(60, 40, 80) }
  const at08 = fableWindow({ weekE, fableE: 10, mix: range(0.8), share: 0.5 })
  expectNear(at08.allowance.value, 1.25 * 50, 12)
  const spread = fableWindow({ weekE, fableE: 10, mix: range(0.8, 0.7, 0.9), share: 0.5 })
  expectNear(spread.allowance.low, 40 / 0.9, 12)
  expectNear(spread.allowance.high, 60 / 0.7, 12)
  expectNear(spread.left.low, 30 / 0.9, 12)
  expectNear(spread.left.high, 50 / 0.7, 12)
})

test("fableWindow's left is bounded by the week's left and by 0, and the cap holds at equality", () => {
  const allowance = range(100, 80, 120)
  expect(fableWindow({ weekE: { allowance, left: range(5, 0, 10) }, fableE: 10, mix: range(1), share: 0.5 }).left).toEqual(range(5, 0, 10))
  expect(fableWindow({ weekE: { allowance, left: range(60, 40, 80) }, fableE: 70, mix: range(1), share: 0.5 }).left).toEqual(range(0))
  const atCap = fableWindow({ weekE: { allowance, left: range(50, 30, 70) }, fableE: 50, mix: range(1), share: 0.5 })
  expect(atCap.isCapLikely).toBe(true)
  expectNear(atCap.usedShare, 1, 12)
})

test('fableCapAt is the earliest side whose Fable dollars reach 95% of half the limit it implies', () => {
  const t = (h: number) => T0 + h * HOUR_MS
  const week = windowOf('seven_day', WEEK_END, {
    50: { min: [40, 10], minAt: t(1) },
    60: { min: [48, 12], minAt: t(3), max: [50, 14], maxAt: t(4) },
    70: { min: [55, 15], minAt: t(5) },
  })
  expect(fableCapAt(week, 0.5, UNIT_WEIGHTS)).toBe(t(3))
  const below = windowOf('seven_day', WEEK_END, { 60: { min: [47, 13], minAt: t(3) } })
  expect(fableCapAt(below, 0.5, UNIT_WEIGHTS)).toBeUndefined()
  const bare: WindowReadings = { kind: 'seven_day', resetsAt: new Date(WEEK_END).toISOString(), byPct: { 60: { minUsd: 60, minAt: t(3), maxUsd: 60, maxAt: t(3) } } }
  expect(fableCapAt(bare, 0.5, UNIT_WEIGHTS)).toBeUndefined()
})

test('a week of Fable alone is capped from level 48 on, and not at 47', () => {
  const only = (pct: number): WindowReadings => ({
    kind: 'seven_day',
    resetsAt: new Date(WEEK_END).toISOString(),
    byPct: { [pct]: { minUsd: pct, minAt: T0, maxUsd: pct, maxAt: T0, minX: [pct], maxX: [pct] } },
    features: [FABLE],
  })
  expect(fableCapAt(only(48), 0.5, UNIT_WEIGHTS)).toBe(T0)
  expect(fableCapAt(only(47), 0.5, UNIT_WEIGHTS)).toBeUndefined()
})

test('whether a week is capped depends on the weights', () => {
  const week = windowOf('seven_day', WEEK_END, { 60: { min: [45, 15], minAt: T0 + HOUR_MS } })
  expect(fableCapAt(week, 0.5, UNIT_WEIGHTS)).toBeUndefined()
  expect(fableCapAt(week, 0.5, OPUS_HALF)).toBe(T0 + HOUR_MS)
})

test('cappedWeeksOf keeps a sticky week under weights that no longer cap it, and drops keys no longer stored', () => {
  const capped = windowOf('seven_day', WEEK_END, { 60: { min: [50, 10], minAt: T0 + HOUR_MS } })
  const flips = windowOf('seven_day', WEEK_END - 7 * DAY_MS, { 60: { min: [45, 15], minAt: T0 - DAY_MS } })
  const weeks = [
    { key: 'a', r: capped },
    { key: 'b', r: flips },
  ]
  expect(cappedWeeksOf(weeks, 0.5, UNIT_WEIGHTS)).toEqual({ a: T0 + HOUR_MS })
  expect(cappedWeeksOf(weeks, 0.5, UNIT_WEIGHTS, { b: 123, gone: 456 })).toEqual({ a: T0 + HOUR_MS, b: 123 })
})

test('isAfterFableCap: a 5-hour window with Fable dollars that ends after the cap of the week it starts in', () => {
  const capAt = T0 + 3 * DAY_MS
  const weeks = [{ capAt, resetsAt: WEEK_END }]
  const fiveHour = (resetsAt: number, fable = 2) => windowOf('five_hour', resetsAt, { 10: { min: [fable, 3], minAt: resetsAt - HOUR_MS } })
  expect(isAfterFableCap(fiveHour(capAt + HOUR_MS), weeks)).toBe(true)
  expect(isAfterFableCap(fiveHour(capAt - HOUR_MS), weeks)).toBe(false)
  expect(isAfterFableCap(fiveHour(capAt + HOUR_MS, 0), weeks)).toBe(false)
  expect(isAfterFableCap(fiveHour(WEEK_END + 6 * HOUR_MS), weeks)).toBe(false)
  expect(isAfterFableCap(fiveHour(capAt + HOUR_MS), [])).toBe(false)
})

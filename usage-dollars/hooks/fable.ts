/* The Fable weekly limit: on Max and Ultra, Fable models may use up to a share of the
   weekly limit as the meter counts it. Claude Code reports no Fable percent, so the window
   is derived from the weekly estimate in meter units, with Fable's weight relative to the
   other models from the model study. Pure: no engine calls, every instant in epoch
   milliseconds. */

import type { RangeEstimate, WindowReadings } from './estimate.ts'
import { UNIT_WEIGHTS, featureWeight, groupOf } from './meter.ts'
import type { Model, Weights } from './meter.ts'

/* The parts of a stored model fit this module reads; any of them may be missing. */
export type FitSource = {
  pricesId?: string
  selection?: { selected: Model; fits?: Partial<Record<Model, unknown>> }
  transfer?: { isRejected?: boolean; weeks?: number; weeklyFit?: { weights: Weights } }
  fits?: Record<string, { weights: Weights } | undefined>
  capped?: Record<string, number>
}

export type WeightSource = 'five-hour' | 'weekly' | 'assumed'

export type FableWeights = { weights: Weights; source: WeightSource; weeks?: number }

/* Of the cap implied by a bucket side, the share at which a week counts as capped. */
export const FABLE_CAP_MARGIN = 0.95

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000

/* The models the Fable weekly limit covers, tested against a price key. The helper,
   scripts/usage-cost.mjs, holds the same definition. */
const FABLE_FAMILY = /^claude-(fable|mythos)(-|$)/

/** Whether a feature key `<priceKey>[+fast]/<class>` belongs to a Fable model; `web` never
    does. */
export function isFableFeature(key: string) {
  if (key === 'web') return false
  return FABLE_FAMILY.test(key.split(/[+/]/)[0] ?? '')
}

/** Fable's weights: the 5-hour study's for the week while it is fitted and the weeks have
    not rejected it, else the weekly-only fit, else unit weights. Every part of the stored
    entry may be missing. */
export function fableWeightsOf(entry: FitSource | undefined, pricesId: string | undefined): FableWeights {
  const isSameTable = entry !== undefined && entry.pricesId === pricesId
  const selected = entry?.selection?.selected
  const isFitted = selected !== undefined && entry?.selection?.fits?.[selected] !== undefined
  const week = entry?.fits?.seven_day?.weights
  if (isSameTable && isFitted && entry?.transfer?.isRejected !== true && week) return { weights: week, source: 'five-hour' }
  const weekly = entry?.transfer?.weeklyFit?.weights
  if (isSameTable && weekly) return { weights: weekly, source: 'weekly', weeks: entry?.transfer?.weeks }
  return { weights: UNIT_WEIGHTS, source: 'assumed' }
}

/** Whether the weights measure Fable: always under M0; otherwise when at least half of the
    Fable dollars of x belong to the reference group or a free group. */
export function isFableInFit(weights: Weights, x: Record<string, number>) {
  if (weights.model === 'M0') return true
  let total = 0
  let measured = 0
  for (const [feature, usd] of Object.entries(x)) {
    if (!isFableFeature(feature)) continue
    total += usd
    const g = groupOf(weights.model, feature)
    if (g === weights.reference || weights.free.includes(g)) measured += usd
  }
  return total > 0 && measured >= total / 2
}

/** Fable's weighted dollars: its features at their weights, and its web searches, which
    byFeature files under `web`, at 1. */
export function fableUseE(weights: Weights, byFeature: Record<string, number>, fableUsd: number) {
  let weighted = 0
  let plain = 0
  for (const [feature, usd] of Object.entries(byFeature)) {
    if (!isFableFeature(feature)) continue
    weighted += featureWeight(weights, feature) * usd
    plain += usd
  }
  return weighted + Math.max(0, fableUsd - plain)
}

export type FableWindow = { allowance: RangeEstimate; left: RangeEstimate; usedShare: number | undefined; isCapLikely: boolean }

/** Fable's window in its own API dollars, from the week's estimate in weighted dollars,
    Fable's weighted use, its mix weight and its share. The low end divides by the mix's
    high end and the high end by its low end, which widens the range. */
export function fableWindow(input: {
  weekE: { allowance: RangeEstimate; left: RangeEstimate }
  fableE: number
  mix: RangeEstimate
  share: number
}): FableWindow {
  const { weekE, fableE, mix, share } = input
  const capE = { value: share * weekE.allowance.value, low: share * weekE.allowance.low, high: share * weekE.allowance.high }
  const toFable = (r: RangeEstimate): RangeEstimate => ({ value: r.value / mix.value, low: r.low / mix.high, high: r.high / mix.low })
  const leftE = {
    value: Math.max(0, Math.min(capE.value - fableE, weekE.left.value)),
    low: Math.max(0, Math.min(capE.low - fableE, weekE.left.low)),
    high: Math.max(0, Math.min(capE.high - fableE, weekE.left.high)),
  }
  return {
    allowance: toFable(capE),
    left: toFable(leftE),
    usedShare: capE.value > 0 ? fableE / capE.value : undefined,
    isCapLikely: fableE >= capE.value,
  }
}

/** When a week reached its Fable cap: the earliest bucket side, at a level above 0, whose
    Fable dollars F and all dollars E, both weighted, satisfy F ≥ FABLE_CAP_MARGIN · share ·
    E · 100 / level. This tells only that the cap was reached, never whether later Fable
    requests billed usage credits. The margin keeps a subscription that uses only Fable,
    whose two sides are equal from the cap on, from flipping on rounding noise. */
export function fableCapAt(r: WindowReadings, share: number, weights: Weights): number | undefined {
  const features = r.features ?? []
  const wf = features.map(f => featureWeight(weights, f))
  const isFable = features.map(isFableFeature)
  let earliest: number | undefined
  for (const [key, b] of Object.entries(r.byPct)) {
    const p = Number(key)
    if (!(p > 0)) continue
    for (const [x, at] of [
      [b.minX, b.minAt],
      [b.maxX, b.maxAt],
    ] as const) {
      if (!x) continue
      let e = 0
      let f = 0
      x.forEach((v, i) => {
        const wx = (wf[i] ?? 1) * v
        e += wx
        if (isFable[i]) f += wx
      })
      if (e > 0 && f >= (FABLE_CAP_MARGIN * share * e * 100) / p && (earliest === undefined || at < earliest)) earliest = at
    }
  }
  return earliest
}

/** The cap moment of each week that has one: the sticky one when given, else fableCapAt.
    Only keys of `weeks` appear. */
export function cappedWeeksOf(
  weeks: readonly { key: string; r: WindowReadings }[],
  share: number,
  weights: Weights,
  sticky?: Record<string, number>,
): Record<string, number> {
  const capped: Record<string, number> = {}
  for (const { key, r } of weeks) {
    const at = sticky?.[key] ?? fableCapAt(r, share, weights)
    if (at !== undefined) capped[key] = at
  }
  return capped
}

/** Whether a 5-hour window holds Fable dollars and ends after the cap moment of a week it
    starts within. */
export function isAfterFableCap(r: WindowReadings, weeks: readonly { capAt: number; resetsAt: number }[]) {
  const isFable = (r.features ?? []).map(isFableFeature)
  const hasFable = Object.values(r.byPct).some(b => (b.maxX ?? []).some((v, i) => isFable[i] && v > 0))
  if (!hasFable) return false
  const end = Date.parse(r.resetsAt)
  return weeks.some(w => end > w.capAt && end - FIVE_HOUR_MS < w.resetsAt)
}

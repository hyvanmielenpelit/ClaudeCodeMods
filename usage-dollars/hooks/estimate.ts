/* Estimates a rate-limit window's allowance in dollars from readings of (used dollars,
   reported percent) and gives a 90% range.

   Each reading constrains the allowance A. A percent p reported at resolution r means the
   true share lies in an interval set by how the source rounds: [p - r/2, p + r/2) when it
   rounds, [p, p + r) when it truncates, and their union [p - r/2, p + r) while that is not
   known. So U / upper% <= A <= U / lower%. Intersecting every reading of the window gives
   hard bounds that tighten as the percent ticks over. Dollars track the limit only as far
   as API prices match the limit's own weighting, so the bounds are widened by that mix
   error: the age-weighted spread of past windows' allowances when there is enough of
   them, else an assumed 10%. Past windows also give a prior that the current bounds are
   intersected with, unless the two contradict each other.

   Readings that contradict the rest are set aside rather than averaged: the bounds come
   from the largest set of percent levels that agree, the newest set on a tie. */

import type { Confidence } from '../types'

export type Bucket = { minUsd: number; minAt: number; maxUsd: number; maxAt: number }

export type WindowReadings = { kind: string; resetsAt: string; byPct: Record<string, Bucket> }

export type RangeEstimate = { value: number; low: number; high: number }

export type Rounding = 'round' | 'truncate' | 'union'

/** A past allowance: a closed window's, at its reset, or a rejection's, at its time. */
export type PastPoint = { usd: number; at: number }

export type Estimate = {
  allowance: RangeEstimate
  left: RangeEstimate
  readings: number
  droppedReadings: number
  pastWindows: number
  pastWeight: number
  isMixErrorAssumed: boolean
  isPriorContradicted: boolean
  confidence: Confidence
  nextTick?: RangeEstimate
}

export type EstimateOptions = {
  resolution: number
  rounding: Rounding
  past: readonly PastPoint[]
  kind: string
  now: number
  livePercent?: number
}

const Z90 = 1.645
const ASSUMED_MIX_ERROR = 0.1
const MIN_MIX_ERROR = 0.03
const MAX_HISTORY_RATIO = 1.5
const HOUR_MS = 60 * 60 * 1000
const FIVE_HOUR_HALF_LIFE_MS = 24 * HOUR_MS
const SEVEN_DAY_HALF_LIFE_MS = 14 * 24 * HOUR_MS

export function resolutionOf(all: readonly WindowReadings[]) {
  const isFine = all.some(w => Object.keys(w.byPct).some(p => !Number.isInteger(Number(p))))
  return isFine ? 0.1 : 1
}

/* Within a window dollars only grow, so a tie keeps the later time: the most recent
   reading that still supports the bound. */
export function record(w: WindowReadings, pct: number, usd: number, at: number): WindowReadings {
  const key = String(pct)
  const was = w.byPct[key]
  const bucket: Bucket = was
    ? {
        minUsd: Math.min(was.minUsd, usd),
        minAt: usd < was.minUsd ? at : usd === was.minUsd ? Math.max(was.minAt, at) : was.minAt,
        maxUsd: Math.max(was.maxUsd, usd),
        maxAt: usd > was.maxUsd ? at : usd === was.maxUsd ? Math.max(was.maxAt, at) : was.maxAt,
      }
    : { minUsd: usd, minAt: at, maxUsd: usd, maxAt: at }
  return { ...w, byPct: { ...w.byPct, [key]: bucket } }
}

/* The window as seen from a regime that started at startedAt: readings taken before it
   are dropped. Losing a straddling bucket's min side makes the bounds wider, never wrong. */
export function regimeView(w: WindowReadings, startedAt: number): WindowReadings {
  const byPct: Record<string, Bucket> = {}
  for (const [key, b] of Object.entries(w.byPct)) {
    if (b.maxAt < startedAt) continue
    byPct[key] = b.minAt < startedAt ? { minUsd: b.maxUsd, minAt: b.maxAt, maxUsd: b.maxUsd, maxAt: b.maxAt } : b
  }
  return { ...w, byPct }
}

function shareOf(pct: number, resolution: number, rounding: Rounding) {
  if (rounding === 'round') return { lower: pct - resolution / 2, upper: pct + resolution / 2 }
  if (rounding === 'truncate') return { lower: pct, upper: pct + resolution }
  return { lower: pct - resolution / 2, upper: pct + resolution }
}

export function bounds(w: WindowReadings, resolution: number, rounding: Rounding) {
  let low = 0
  let high = Infinity
  for (const [key, bucket] of Object.entries(w.byPct)) {
    const { lower, upper } = shareOf(Number(key), resolution, rounding)
    low = Math.max(low, bucket.maxUsd / (upper / 100))
    if (lower > 0) high = Math.min(high, bucket.minUsd / (lower / 100))
  }
  return { low, high }
}

/* The bounds of the largest set of percent levels whose intervals share a point; on a tie,
   the set whose readings are newest by the sum of their maxAt. A level that contradicts
   itself is dropped first. With none left, the plain bounds of all levels, kept 0. */
export function consistentBounds(w: WindowReadings, resolution: number, rounding: Rounding) {
  const levels = Object.entries(w.byPct)
  const intervals: { lo: number; hi: number; at: number }[] = []
  for (const [key, bucket] of levels) {
    const { lower, upper } = shareOf(Number(key), resolution, rounding)
    const lo = bucket.maxUsd / (upper / 100)
    const hi = lower > 0 ? bucket.minUsd / (lower / 100) : Infinity
    if (lo > hi * (1 + 1e-9)) continue
    intervals.push({ lo, hi, at: bucket.maxAt })
  }
  if (intervals.length === 0) return { ...bounds(w, resolution, rounding), kept: 0, dropped: levels.length }

  /* Every largest agreeing set is the set covering some interval's lower end. */
  let best: typeof intervals = []
  let bestAt = -Infinity
  for (const { lo: x } of intervals) {
    const covering = intervals.filter(i => i.lo <= x && x <= i.hi * (1 + 1e-9))
    const at = covering.reduce((sum, i) => sum + i.at, 0)
    if (covering.length > best.length || (covering.length === best.length && at > bestAt)) {
      best = covering
      bestAt = at
    }
  }
  const low = Math.max(...best.map(i => i.lo))
  const high = Math.min(...best.map(i => i.hi))
  return { low, high, kept: best.length, dropped: levels.length - best.length }
}

/* A closed window whose bounds are tight enough stands as one observed allowance; one with
   a conflicting level does not. */
export function observed(w: WindowReadings, resolution: number, rounding: Rounding) {
  const { low, high, dropped } = consistentBounds(w, resolution, rounding)
  if (dropped > 0) return undefined
  return low > 0 && Number.isFinite(high) && high / low <= MAX_HISTORY_RATIO ? Math.sqrt(low * high) : undefined
}

export function weightOf(kind: string, ageMs: number) {
  const halfLife = kind === 'seven_day' ? SEVEN_DAY_HALF_LIFE_MS : FIVE_HOUR_HALF_LIFE_MS
  return 0.5 ** (Math.max(0, ageMs) / halfLife)
}

/* The age-weighted mean and spread of past allowances, in logs, and the mix error they
   support: their spread once the effective number of points reaches 3, never below 3%,
   else the assumed 10%. */
export function prior(past: readonly PastPoint[], kind: string, now: number) {
  const points = past.filter(p => p.usd > 0)
  let sw = 0
  let sw2 = 0
  let swx = 0
  for (const p of points) {
    const w = weightOf(kind, now - p.at)
    sw += w
    sw2 += w * w
    swx += w * Math.log(p.usd)
  }
  const nEff = sw2 > 0 ? (sw * sw) / sw2 : 0
  const mean = sw > 0 ? swx / sw : 0
  let sd = 0
  const denominator = sw > 0 ? sw - sw2 / sw : 0
  if (denominator > 0) {
    let ss = 0
    for (const p of points) ss += weightOf(kind, now - p.at) * (Math.log(p.usd) - mean) ** 2
    sd = Math.sqrt(ss / denominator)
  }
  const isMixErrorAssumed = nEff < 3
  const mix = isMixErrorAssumed ? ASSUMED_MIX_ERROR : Math.max(MIN_MIX_ERROR, sd)
  return { nEff, mean, sd, mix, isMixErrorAssumed, points: points.length }
}

/* Which rounding the API uses, from closed windows of every subscription: the mode that
   no window contradicts, once at least 3 windows support it and the other mode is
   contradicted at least once. The caller leaves out windows that straddle a regime
   start; a window that is inconsistent even under the union is ignored here. */
export function inferRounding(windows: readonly WindowReadings[], resolution: number): Rounding {
  /* A reading exactly on a boundary makes low equal high, up to floating-point noise. */
  const isEmpty = (b: { low: number; high: number }) => b.low > b.high * (1 + 1e-9)
  let considered = 0
  let roundConflicts = 0
  let truncateConflicts = 0
  for (const w of windows) {
    if (Object.keys(w.byPct).length < 3) continue
    const union = bounds(w, resolution, 'union')
    if (isEmpty(union)) continue
    considered++
    const round = bounds(w, resolution, 'round')
    const truncate = bounds(w, resolution, 'truncate')
    if (isEmpty(round)) roundConflicts++
    if (isEmpty(truncate)) truncateConflicts++
  }
  if (considered >= 3 && roundConflicts === 0 && truncateConflicts >= 1) return 'round'
  if (considered >= 3 && truncateConflicts === 0 && roundConflicts >= 1) return 'truncate'
  return 'union'
}

export function confidenceOf(r: RangeEstimate): Confidence {
  const h = Math.sqrt(r.high / r.low) - 1
  return h <= 0.1 ? 'good' : h <= 0.3 ? 'fair' : 'rough'
}

/* The spend at which the reported percent next moves: the next boundary share of the
   allowance, less what is used. */
function nextTickOf(a: RangeEstimate, usedUsd: number, pct: number, resolution: number, rounding: Rounding) {
  const near = rounding === 'truncate' ? pct + resolution : pct + resolution / 2
  const far = rounding === 'round' ? pct + resolution / 2 : pct + resolution
  const mid = (near + far) / 2
  const at = (allowance: number, share: number) => Math.max(0, (allowance * share) / 100 - usedUsd)
  return { value: at(a.value, mid), low: at(a.low, near), high: at(a.high, far) }
}

export function estimate(w: WindowReadings, usedUsd: number, options: EstimateOptions): Estimate | undefined {
  const { resolution, rounding, past, kind, now, livePercent } = options
  const consistent = consistentBounds(w, resolution, rounding)
  let { low, high } = consistent
  const p = prior(past, kind, now)
  let mix = p.mix

  if (low > high) {
    /* Every level contradicts itself: mix error showing; meet in the middle. */
    mix = Math.max(mix, Math.log(low / high) / 2)
    low = high = Math.sqrt(low * high)
  }
  let lo = low * Math.exp(-Z90 * mix)
  let hi = high * Math.exp(Z90 * mix)

  let isPriorContradicted = false
  if (p.nEff >= 2) {
    const width = Z90 * mix * Math.sqrt(1 + 1 / p.nEff)
    const priorLo = Math.exp(p.mean - width)
    const priorHi = Math.exp(p.mean + width)
    if (priorLo <= hi && priorHi >= lo) {
      lo = Math.max(lo, priorLo)
      hi = Math.min(hi, priorHi)
    } else isPriorContradicted = true
  }
  if (!Number.isFinite(hi) || lo <= 0) return undefined

  lo = Math.max(lo, usedUsd)
  hi = Math.max(hi, lo)
  const value = Math.sqrt(lo * hi)
  const allowance = { value, low: lo, high: hi }
  const isLive = livePercent !== undefined && livePercent < 100
  return {
    allowance,
    left: { value: value - usedUsd, low: lo - usedUsd, high: hi - usedUsd },
    readings: Object.keys(w.byPct).length,
    droppedReadings: consistent.kept > 0 ? consistent.dropped : 0,
    pastWindows: p.points,
    pastWeight: Math.round(p.nEff * 10) / 10,
    isMixErrorAssumed: p.isMixErrorAssumed,
    isPriorContradicted,
    confidence: confidenceOf(allowance),
    nextTick: isLive ? nextTickOf(allowance, usedUsd, livePercent, resolution, rounding) : undefined,
  }
}

/* Estimates a rate-limit window's allowance in dollars from readings of (used dollars,
   reported percent) and gives a 90% range.

   Model, in natural logs. A is the dollars counted when the window reaches 100%, so the
   window runs at D = A / 100 dollars per percent. Between windows log A ~ N(mu, tau²).
   Within a window the cumulative rate U(s) / s read at share s differs from D with
   variance omega² · (1/s − 1/100): an average of s one-percent steps against the average
   of all 100, which vanishes as s → 100.

   A percent p reported at resolution r means the true share lies in an interval set by
   how the source rounds: [p − r/2, p + r/2) when it rounds, [p, p + r) when it truncates,
   and their union while that is not known. The newest level gives the evidence: where the
   level below it was also read, the tick was crossed between the two readings, at the
   lower edge of p's interval; otherwise anywhere in p's interval. Past windows give a
   prior on log A that the evidence is combined with by precision, unless the two
   contradict each other. tau and omega start from assumed values and are shrunk toward
   what closed windows show. */

import type { Confidence } from '../types'

/* minSlack and maxSlack: dollars of other sessions' requests close to that side's
   reading, which its percent may not include yet. */
export type Bucket = { minUsd: number; minAt: number; maxUsd: number; maxAt: number; minSlack?: number; maxSlack?: number }

/* pricesId: the price table the dollars were computed with. */
export type WindowReadings = { kind: string; resetsAt: string; byPct: Record<string, Bucket>; pricesId?: string }

export type RangeEstimate = { value: number; low: number; high: number }

export type Rounding = 'round' | 'truncate' | 'union'

/** A past allowance in logs: a closed window's, at its reset, or a rejection's, at its time. */
export type PastPoint = { logA: number; variance: number; at: number }

/** A rate-limit rejection: the window was exactly full at `at`, with `usd` counted. */
export type Rejection = { kind: string; resetsAt: string; at: string; usd: number }

/** log A from one window's newest level `pct`, read at share `share`. shift: an error of
    up to that much either way, not random, from not knowing the rounding rule.
    crossingUsd: the dollars at the tick into that level, when it was seen. */
export type Evidence = { logA: number; variance: number; shift: number; share: number; pct: number; crossingUsd?: number }

/** The within-window spread omega, the age weight of the closed-window crossings behind
    it, and the number of closed windows that gave a crossing. It counts as measured from
    two windows on. */
export type Spread = { omega: number; weight: number; windows: number; isAssumed: boolean }

export type Estimate = {
  allowance: RangeEstimate
  left: RangeEstimate
  readings: number
  pastWindows: number
  pastWeight: number
  /** The between-window spread is the assumed one: under 3 effective past windows. */
  isSpreadAssumed: boolean
  /** No closed window has measured the within-window spread yet. */
  isWithinSpreadAssumed: boolean
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
  spread?: Spread
}

const NU0 = 4
const TAU0 = 0.1
const OMEGA0 = 0.5
const REJECTION_SD = 0.02
const MIN_PAST_SHARE = 10
const MIN_CROSSING_SHARE = 5
const MIN_SPREAD_WINDOWS = 2
export const MIN_ROUNDING_WINDOWS = 5
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const FIVE_HOUR_HALF_LIFE_MS = 24 * HOUR_MS
const SEVEN_DAY_HALF_LIFE_MS = 14 * 24 * HOUR_MS

export const ASSUMED_SPREAD: Spread = { omega: OMEGA0, weight: 0, windows: 0, isAssumed: true }

export function resolutionOf(all: readonly WindowReadings[]) {
  const isFine = all.some(w => Object.keys(w.byPct).some(p => !Number.isInteger(Number(p))))
  return isFine ? 0.1 : 1
}

/* Within a window dollars only grow, so a tie keeps the later time: the most recent
   reading that still supports the bound. Each side keeps its reading's slack. */
export function record(w: WindowReadings, pct: number, usd: number, at: number, slack = 0): WindowReadings {
  const key = String(pct)
  const was = w.byPct[key]
  let bucket: Bucket = { minUsd: usd, minAt: at, maxUsd: usd, maxAt: at, minSlack: slack, maxSlack: slack }
  if (was) {
    const isMin = usd < was.minUsd || (usd === was.minUsd && at >= was.minAt)
    const isMax = usd > was.maxUsd || (usd === was.maxUsd && at >= was.maxAt)
    bucket = {
      minUsd: isMin ? usd : was.minUsd,
      minAt: isMin ? at : was.minAt,
      maxUsd: isMax ? usd : was.maxUsd,
      maxAt: isMax ? at : was.maxAt,
      minSlack: isMin ? slack : (was.minSlack ?? 0),
      maxSlack: isMax ? slack : (was.maxSlack ?? 0),
    }
  }
  return { ...w, byPct: { ...w.byPct, [key]: bucket } }
}

/* The window as seen from a regime that started at startedAt: readings taken before it
   are dropped. A straddling bucket keeps only its max side. */
export function regimeView(w: WindowReadings, startedAt: number): WindowReadings {
  const byPct: Record<string, Bucket> = {}
  for (const [key, b] of Object.entries(w.byPct)) {
    if (b.maxAt < startedAt) continue
    byPct[key] =
      b.minAt < startedAt
        ? { minUsd: b.maxUsd, minAt: b.maxAt, maxUsd: b.maxUsd, maxAt: b.maxAt, minSlack: b.maxSlack, maxSlack: b.maxSlack }
        : b
  }
  return { ...w, byPct }
}

function shareOf(pct: number, resolution: number, rounding: Rounding) {
  if (rounding === 'round') return { lower: pct - resolution / 2, upper: pct + resolution / 2 }
  if (rounding === 'truncate') return { lower: pct, upper: pct + resolution }
  return { lower: pct - resolution / 2, upper: pct + resolution }
}

/* Where the share crosses into level p: one point, or for the union one of the two rules'
   points, taken at their geometric center with `shift`, half the log distance between
   them, as an error that is either rule's and not random. */
function crossingShareOf(pct: number, resolution: number, rounding: Rounding) {
  if (rounding === 'round') return { s: pct - resolution / 2, variance: 0, shift: 0 }
  if (rounding === 'truncate') return { s: pct, variance: 0, shift: 0 }
  const lower = pct - resolution / 2
  return lower > 0
    ? { s: Math.sqrt(lower * pct), variance: 0, shift: Math.log(pct / lower) / 2 }
    : { s: pct - resolution / 4, variance: (resolution / 4) ** 2, shift: 0 }
}

/* A share uniform over a level's interval, never below 0. */
function levelShareOf(pct: number, resolution: number, rounding: Rounding) {
  const { lower, upper } = shareOf(pct, resolution, rounding)
  const from = Math.max(0, lower)
  return { s: (from + upper) / 2, variance: (upper - from) ** 2 / 12, shift: 0 }
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

type Level = { pct: number; bucket: Bucket }

const levelsOf = (w: WindowReadings): Level[] => Object.entries(w.byPct).map(([key, bucket]) => ({ pct: Number(key), bucket }))

/* The dollars at which the share crossed into `level`, when the level one step below was
   read before it: the midpoint of the gap less half the slack, uniform over the gap plus
   the slack. Keys of fine levels are not exact, hence the tolerance. */
function crossingOf(levels: readonly Level[], level: Level, resolution: number) {
  const lower = levels.find(l => Math.abs(l.pct - (level.pct - resolution)) < resolution / 1000)
  if (!lower) return undefined
  const gap = level.bucket.minUsd - lower.bucket.maxUsd
  if (gap < 0) return undefined
  const slack = Math.max(level.bucket.minSlack ?? 0, lower.bucket.maxSlack ?? 0)
  return { usd: (lower.bucket.maxUsd + level.bucket.minUsd) / 2 - slack / 2, width: gap + slack }
}

/* Dollars uniform over usdWidth, the share at s with the given variance and shift. */
function evidenceAt(pct: number, usd: number, usdWidth: number, share: { s: number; variance: number; shift: number }, omega: number) {
  const { s } = share
  if (!(s > 0) || !(usd > 0)) return undefined
  const variance = share.variance / (s * s) + usdWidth ** 2 / (12 * usd * usd) + omega ** 2 * Math.max(0, 1 / s - 1 / 100)
  return { logA: Math.log((100 * usd) / s), variance, shift: share.shift, share: s, pct }
}

/** log A and its variance from the newest level of a window, the level with the latest
    reading. A level at or above 100 is used only through its crossing, since spending
    can continue past the limit; without one the next newest level is used. */
export function evidenceOf(w: WindowReadings, resolution: number, rounding: Rounding, omega = 0): Evidence | undefined {
  const levels = levelsOf(w)
  const newest = [...levels].sort((a, b) => b.bucket.maxAt - a.bucket.maxAt)
  for (const level of newest) {
    const crossing = crossingOf(levels, level, resolution)
    if (crossing) {
      const e = evidenceAt(level.pct, crossing.usd, crossing.width, crossingShareOf(level.pct, resolution, rounding), omega)
      return e && { ...e, crossingUsd: crossing.usd }
    }
    if (level.pct >= 100) continue
    const slack = level.bucket.maxSlack ?? 0
    return evidenceAt(level.pct, level.bucket.maxUsd - slack / 2, slack, levelShareOf(level.pct, resolution, rounding), omega)
  }
  return undefined
}

/** A closed window as a past allowance: its final evidence, with the within-window term
    of where it stopped, once it reached 10%. */
export function pastOf(w: WindowReadings, resolution: number, rounding: Rounding, omega: number): PastPoint | undefined {
  const e = evidenceOf(w, resolution, rounding, omega)
  if (!e || e.share < MIN_PAST_SHARE) return undefined
  return { logA: e.logA, variance: e.variance + e.shift ** 2, at: Date.parse(w.resetsAt) }
}

const minuteOf = (iso: string) => Math.round(Date.parse(iso) / MINUTE_MS)

/** One past point per window of `kind`, keyed by its reset to the minute: a rejection
    wins over the window's own readings, the earliest rejection over later ones. */
export function pastPoints(
  closed: readonly WindowReadings[],
  rejections: readonly Rejection[],
  kind: string,
  resolution: number,
  rounding: Rounding,
  omega: number,
): PastPoint[] {
  const byWindow = new Map<number, PastPoint>()
  for (const w of closed) {
    if (w.kind !== kind) continue
    const p = pastOf(w, resolution, rounding, omega)
    if (p) byWindow.set(minuteOf(w.resetsAt), p)
  }
  const rejected = new Map<number, PastPoint>()
  for (const r of rejections) {
    if (r.kind !== kind || !(r.usd > 0)) continue
    const key = minuteOf(r.resetsAt)
    const at = Date.parse(r.at)
    const was = rejected.get(key)
    if (!was || at < was.at) rejected.set(key, { logA: Math.log(r.usd), variance: REJECTION_SD ** 2, at })
  }
  for (const [key, p] of rejected) byWindow.set(key, p)
  return [...byWindow.values()]
}

export function weightOf(kind: string, ageMs: number) {
  const halfLife = kind === 'seven_day' ? SEVEN_DAY_HALF_LIFE_MS : FIVE_HOUR_HALF_LIFE_MS
  return 0.5 ** (Math.max(0, ageMs) / halfLife)
}

/** The weighted mean of past log allowances; tau², their spread beyond their own
    measurement variance, shrunk toward the assumed TAU0 with NU0 degrees of freedom; and
    the predictive variance of the next window's log allowance. A point weighs by its age
    and by its information q = TAU0² / (TAU0² + v): one whose own variance v is large
    beside the assumed tau² says little about the allowance or about tau. */
export function prior(past: readonly PastPoint[], kind: string, now: number) {
  const points = past.map(p => {
    const q = TAU0 ** 2 / (TAU0 ** 2 + p.variance)
    return { x: p.logA, v: p.variance, q, w: weightOf(kind, now - p.at) * q }
  })
  let sw = 0
  let sw2 = 0
  let swx = 0
  let swq2 = 0
  for (const p of points) {
    sw += p.w
    sw2 += p.w * p.w
    swx += p.w * p.x
    swq2 += p.w * p.q * p.q
  }
  const nEff = sw2 > 0 ? (sw * sw) / sw2 : 0
  const mean = sw > 0 ? swx / sw : 0
  let raw = 0
  const denominator = sw > 0 ? sw - sw2 / sw : 0
  if (denominator > 0) {
    let ss = 0
    let noise = 0
    for (const p of points) {
      ss += p.w * (p.x - mean) ** 2
      noise += p.w * p.v * (1 - p.w / sw)
    }
    raw = (ss - noise) / denominator
  }
  const extra = sw > 0 ? Math.max(0, nEff - 1) * (swq2 / sw) : 0
  const tau2 = (NU0 * TAU0 ** 2 + extra * Math.max(0, raw)) / (NU0 + extra)
  let spread = 0
  for (const p of points) spread += p.w * p.w * (tau2 + p.v)
  const variance = sw > 0 ? tau2 + spread / (sw * sw) : Infinity
  return { nEff, mean, tau2, variance, df: NU0 + extra, isUsable: nEff >= 1, isSpreadAssumed: 1 + extra < 3, points: past.length }
}

/** omega from closed windows that reached 10%: each tick crossed at share s in
    [5, sEnd/2] gives e = log(U/s) − log(U_end/sEnd), with E[e²] = omega² · (1/s − 1/sEnd).
    Age-weighted, and shrunk toward OMEGA0 with the weight of NU0 crossings. */
export function calibrateOmega(
  closed: readonly WindowReadings[],
  kind: string,
  now: number,
  resolution: number,
  rounding: Rounding,
): Spread {
  let sum = 0
  let weight = 0
  let windows = 0
  for (const w of closed) {
    const end = evidenceOf(w, resolution, rounding)
    if (!end || end.share < MIN_PAST_SHARE) continue
    const age = weightOf(kind, now - Date.parse(w.resetsAt))
    const levels = levelsOf(w)
    let isCounted = false
    for (const level of levels) {
      const crossing = crossingOf(levels, level, resolution)
      if (!crossing || !(crossing.usd > 0)) continue
      const { s } = crossingShareOf(level.pct, resolution, rounding)
      if (s < MIN_CROSSING_SHARE || s > end.share / 2) continue
      const e = Math.log(crossing.usd / s) - (end.logA - Math.log(100))
      sum += (age * e * e) / (1 / s - 1 / end.share)
      weight += age
      isCounted = true
    }
    if (isCounted) windows++
  }
  return { omega: Math.sqrt((NU0 * OMEGA0 ** 2 + sum) / (NU0 + weight)), weight, windows, isAssumed: windows < MIN_SPREAD_WINDOWS }
}

/** Student's t quantile by the Cornish-Fisher expansion in 1/df to third order. */
export function tQuantile(p: number, df: number) {
  const z = normalQuantile(p)
  const z3 = z ** 3
  const z5 = z ** 5
  const z7 = z ** 7
  const g1 = (z3 + z) / 4
  const g2 = (5 * z5 + 16 * z3 + 3 * z) / 96
  const g3 = (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / 384
  return z + g1 / df + g2 / df ** 2 + g3 / df ** 3
}

/* Acklam's rational approximation; relative error under 1.2e-9. */
function normalQuantile(p: number) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const tail = (q: number) =>
    (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  if (p < 0.02425) return tail(Math.sqrt(-2 * Math.log(p)))
  if (p > 1 - 0.02425) return -tail(Math.sqrt(-2 * Math.log(1 - p)))
  const q = p - 0.5
  const r = q * q
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  )
}

/* Which rounding the API uses, from closed windows of every subscription: a mode
   contradicted in at most 10% of at least 5 windows while the other is contradicted in at
   least half of them. The caller leaves out windows that straddle a regime start; a
   window that is inconsistent even under the union is ignored here. */
export function roundingEvidence(windows: readonly WindowReadings[], resolution: number) {
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
  let rule: Rounding = 'union'
  if (considered >= MIN_ROUNDING_WINDOWS) {
    if (roundConflicts <= 0.1 * considered && truncateConflicts >= 0.5 * considered) rule = 'round'
    else if (truncateConflicts <= 0.1 * considered && roundConflicts >= 0.5 * considered) rule = 'truncate'
  }
  return { considered, roundConflicts, truncateConflicts, rule }
}

export function inferRounding(windows: readonly WindowReadings[], resolution: number): Rounding {
  return roundingEvidence(windows, resolution).rule
}

/** What has been measured for one window: the current window's levels and ticks, and
    whether each of the within-window spread, the between-window spread and the rounding
    rule rests on closed windows rather than on an assumption. */
export function calibrationOf(input: {
  current?: WindowReadings
  resolution: number
  spread: Spread
  prior: ReturnType<typeof prior>
  rounding: ReturnType<typeof roundingEvidence>
}) {
  const levels = input.current ? levelsOf(input.current) : []
  const ticks = levels.filter(level => crossingOf(levels, level, input.resolution) !== undefined).length
  const isWithinMeasured = !input.spread.isAssumed
  const isBetweenMeasured = !input.prior.isSpreadAssumed
  const isRoundingKnown = input.rounding.rule !== 'union'
  const measured = [isWithinMeasured, isBetweenMeasured, isRoundingKnown].filter(Boolean).length
  return {
    levels: levels.length,
    ticks,
    closedForWithin: input.spread.windows,
    isWithinMeasured,
    pastPoints: input.prior.points,
    pastWeight: Math.round(input.prior.nEff * 10) / 10,
    isBetweenMeasured,
    closedForRounding: input.rounding.considered,
    isRoundingKnown,
    measured,
    isCalibrated: measured === 3,
  }
}

export type Calibration = ReturnType<typeof calibrationOf>

export function confidenceOf(r: RangeEstimate): Confidence {
  const h = Math.sqrt(r.high / r.low) - 1
  return h <= 0.1 ? 'good' : h <= 0.3 ? 'fair' : 'rough'
}

/* The spend until the reported percent next moves: one tick's dollars less what was spent
   since the crossing into the current level, or without a crossing, up to one tick. */
function nextTickOf(a: RangeEstimate, usedUsd: number, resolution: number, crossingUsd: number | undefined) {
  const tick = (allowance: number) => (allowance / 100) * resolution
  if (crossingUsd === undefined) return { value: tick(a.value) / 2, low: 0, high: tick(a.high) }
  const at = (allowance: number) => Math.max(0, tick(allowance) - (usedUsd - crossingUsd))
  return { value: at(a.value), low: at(a.low), high: at(a.high) }
}

export function estimate(w: WindowReadings, usedUsd: number, options: EstimateOptions): Estimate | undefined {
  const { resolution, rounding, past, kind, now, livePercent } = options
  const spread = options.spread ?? ASSUMED_SPREAD
  const ev = evidenceOf(w, resolution, rounding, spread.omega)
  if (!ev) return undefined
  const p = prior(past, kind, now)
  const isAtLimit = livePercent !== undefined && livePercent >= 100

  let m = ev.logA
  let v = ev.variance
  let shift = ev.shift
  let df = NU0 + spread.weight
  let isPriorContradicted = false
  if (p.isUsable && !isAtLimit) {
    const z = Math.max(0, Math.abs(ev.logA - p.mean) - ev.shift) / Math.sqrt(ev.variance + p.variance)
    isPriorContradicted = z > tQuantile(0.995, p.df)
    if (!isPriorContradicted) {
      v = 1 / (1 / p.variance + 1 / ev.variance)
      m = v * (p.mean / p.variance + ev.logA / ev.variance)
      shift = (ev.shift * v) / ev.variance
      df = p.df
    }
  }
  /* The union of the intervals either rounding rule gives. */
  const h = tQuantile(0.95, df) * Math.sqrt(v) + shift
  const floor = isAtLimit ? 0 : usedUsd
  const allowance = {
    value: Math.max(floor, Math.exp(m)),
    low: Math.max(floor, Math.exp(m - h)),
    high: Math.max(floor, Math.exp(m + h)),
  }
  const left = isAtLimit
    ? { value: 0, low: 0, high: 0 }
    : { value: allowance.value - usedUsd, low: allowance.low - usedUsd, high: allowance.high - usedUsd }
  const isLive = livePercent !== undefined && !isAtLimit
  const isSameLevel = livePercent !== undefined && Math.abs(ev.pct - livePercent) < resolution / 1000
  return {
    allowance,
    left,
    readings: Object.keys(w.byPct).length,
    pastWindows: p.points,
    pastWeight: Math.round(p.nEff * 10) / 10,
    isSpreadAssumed: p.isSpreadAssumed,
    isWithinSpreadAssumed: spread.isAssumed,
    isPriorContradicted,
    confidence: confidenceOf(allowance),
    nextTick: isLive ? nextTickOf(allowance, usedUsd, resolution, isSameLevel ? ev.crossingUsd : undefined) : undefined,
  }
}

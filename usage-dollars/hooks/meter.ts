/* Meter weights: whether the subscription meter counts each model's API dollars at the
   API price ratio, fitted on closed 5-hour windows.

   Per feature f (one priced token class of one model, or web searches) a window records
   its dollars X_f at both sides of every bucket. The meter is taken to count weighted
   dollars E = Σ w_f · X_f, with w_f = exp(θ_g) for f's group g and θ = 0 outside the free
   groups. Between two tick crossings at least SEG_MIN_SHARE points apart, a segment's
   y = log(w · ΔX / Δs) is its window's log dollars per percent, with variance ω² / Δs plus
   the crossings' own gaps. θ and ω are fitted with each window's level profiled out and a
   normal prior on θ; a blocked jackknife over windows gives θ's covariance. Models are
   chosen by blocked cross-validation, and the weekly windows test whether the 5-hour
   weights carry over to the week. */

import type { Bucket, Estimate, PastPoint, RangeEstimate, Rejection, Rounding, Spread, WindowReadings } from './estimate.ts'
import { calibrateOmega, crossingOf, crossingShareOf, estimate, levelsOf, pastPoints, rangeOf } from './estimate.ts'

/* Segments and the outlier rule (S3). */
const SEG_MIN_SHARE = 2
const OUTLIER_RATE = 0.1
/* Estimation (S4). */
const SIGMA_THETA = 0.5
const NM_TOLERANCE = 1e-6
const NM_MAX_ITERATIONS = 500
const OMEGA_START = 0.5
const MIN_GROUP_SHARE = 0.02
const MIN_WINDOWS = 4
const MIN_SEGMENTS = 2
/* Uncertainty and selection (S5, S6, S6b). */
const JACKKNIFE_BLOCKS = 20
const CV_FOLDS = 10
const SELECT_MIN_DELTA = 2
const SELECT_SE_MULTIPLE = 2
const SELECT_MIN_Z = 2
const TRANSFER_MIN_DAYS = 5
const GRADIENT_STEP = 0.01
const WEEKLY_FIT_MIN_WEEKS = 4
/* Feature-complete windows (S2). */
const FEATURE_TOLERANCE_RELATIVE = 1e-6
const FEATURE_TOLERANCE_ABSOLUTE = 2e-4
/* Nelder-Mead's initial step from the fixed start and from a warm start, and the simplex
   size within which it stops once the objective has converged. */
const NM_STEP = 0.25
const NM_WARM_STEP = 0.05
const NM_X_TOLERANCE = 1e-4
/* ω is searched within these bounds; noise-free data would drive it to 0. */
const OMEGA_MIN = 1e-4
const OMEGA_MAX = 10
/* Shares of fine levels are not exact. */
const SHARE_EPSILON = 1e-9
const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS

const MODELS = ['M0', 'M1', 'M2'] as const

export type Model = 'M0' | 'M1' | 'M2'

/** The groups of one model. `reference` has θ = 0; `free` are the groups with a θ, in a
    fixed order (sorted by key). Any group not in `free` (the reference, merged groups,
    `web`, and groups never seen) has weight 1. */
export type Grouping = { model: Model; reference: string; free: string[] }

/** Grouping plus θ (aligned with `free`), the jackknife covariance Σ_J (free × free), and the
    jackknife degrees of freedom K − 1. JSON-serializable. */
export type Weights = Grouping & { theta: number[]; cov: number[][]; df: number }

export const UNIT_WEIGHTS: Weights = { model: 'M0', reference: 'all', free: [], theta: [], cov: [], df: 1 }

export type Segment = {
  /** ΔX by feature. */
  dX: Record<string, number>
  /** Δs, percentage points. */
  ds: number
  /** Per-feature gap at the start crossing: level min side less lower max side. */
  gapA: Record<string, number>
  /** The same at the end crossing. */
  gapB: Record<string, number>
  /** Time of the end crossing (ms). */
  at: number
  /** The outlier rule of S3, evaluated at θ = 0. */
  isExcluded: boolean
}

export type FitOptions = {
  resolution: number
  rounding: Rounding
  /** Fixed grouping: skips both pruning steps. */
  groups?: Grouping
  /** Default true. */
  isJackknifed?: boolean
}

export type FitResult = {
  model: Model
  groups: Grouping
  /** Aligned with groups.free. */
  theta: number[]
  omega: number
  /** Σ_J; zeros when not jackknifed. */
  cov: number[][]
  /** sqrt(diag Σ_J). */
  se: number[]
  /** K − 1 of the jackknife. */
  df: number
  /** I_g of S4, aligned with groups.free. */
  information: number[]
  /** Windows that entered the fit. */
  windows: number
  /** Non-excluded segments used. */
  segments: number
  excludedSegments: number
  weights: Weights
}

export type Comparison = { from: Model; to: Model; delta: number; se: number; folds: number; isSelected: boolean }

export type Selection = {
  selected: Model
  /** Of the selected model; UNIT_WEIGHTS for M0. */
  weights: Weights
  /** The rule it was run under. */
  rounding: Rounding
  fits: Partial<Record<Model, FitResult>>
  /** M1 against M0, then M2 against the selected model. */
  comparisons: Comparison[]
  /** Reasons: 'not-feature-complete', 'too-few-segments', 'not-five-hour'. */
  windows: { used: number; excluded: Record<string, number> }
  segments: number
  excludedSegments: number
}

export type Transfer = {
  /** days ≥ TRANSFER_MIN_DAYS. */
  isChecked: boolean
  /** isChecked and delta < −max(2, 2 · se). */
  isRejected: boolean
  delta: number
  se: number
  days: number
  /** Qualifying weekly windows. */
  weeks: number
  /** ω_week fitted with θ held fixed, per candidate. */
  omega: { selected: number; M0: number }
  /** Descriptive weekly-only M1 fit, from WEEKLY_FIT_MIN_WEEKS weeks. */
  weeklyFit?: FitResult
}

export type StoredFit = { weights: Weights; omega: number; omegaM0: number }

export type ProspectiveRecord = { resetsAt: string; kind: string; d: number }

export type WeightedEstimateInput = {
  kind: string
  /** Closed windows of this kind and regime, already regimeView'd. */
  closed: readonly WindowReadings[]
  /** Already regimeView'd. */
  current: WindowReadings | undefined
  /** U of the current window (the tally's usd). */
  usedUsd: number
  /** The current tally's byFeature. */
  usedX: Record<string, number>
  /** The last7d tally's byFeature, for w̄ when U = 0. */
  fallbackX?: Record<string, number>
  weights: Weights
  rejections: readonly Rejection[]
  resolution: number
  rounding: Rounding
  now: number
  livePercent?: number
  /** Past points before it are dropped. */
  startedAt: number
}

export type WeightedEstimate = {
  /** In weighted dollars E, with extraVariance applied. */
  estimate?: Estimate
  /** In U dollars at the window's mix: E-values / w̄. */
  display?: { allowance: RangeEstimate; left: RangeEstimate; nextTick?: RangeEstimate }
  usedE: number
  /** w̄_window. */
  mixWeight: number
  /** ∇ᵀ Σ_J ∇ added to the log variance. */
  extraVariance: number
  spread: Spread
  past: PastPoint[]
  /** Closed windows that could not be transformed. */
  excludedClosed: number
}

const sumOf = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)

const zerosOf = (n: number) => new Array<number>(n).fill(0)

const zeroMatrixOf = (n: number) => Array.from({ length: n }, () => zerosOf(n))

const minuteOf = (iso: string) => Math.round(Date.parse(iso) / MINUTE_MS)

/* Σ_i x_i · w_i over x's length; a missing trailing index of x is 0. */
function dotOf(w: readonly number[], x: readonly number[] | undefined) {
  let s = 0
  if (x) for (let i = 0; i < x.length; i++) s += w[i] * x[i]
  return s
}

const quadraticOf = (g: readonly number[], m: readonly (readonly number[])[]) => {
  let s = 0
  for (let a = 0; a < g.length; a++) for (let b = 0; b < g.length; b++) s += g[a] * (m[a]?.[b] ?? 0) * g[b]
  return s
}

function sampleVarianceOf(xs: readonly number[]) {
  if (xs.length < 2) return 0
  const mean = sumOf(xs) / xs.length
  return xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1)
}

function medianOf(xs: readonly number[]) {
  const sorted = [...xs].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/* priceKey and class of a feature key `<priceKey>[+fast]/<class>`. */
function partsOf(feature: string) {
  const slash = feature.lastIndexOf('/')
  const head = slash < 0 ? feature : feature.slice(0, slash)
  const cls = slash < 0 ? '' : feature.slice(slash + 1)
  return { priceKey: head.endsWith('+fast') ? head.slice(0, -'+fast'.length) : head, cls }
}

/** Natural group of a feature: M0 → 'all'; M1 → priceKey (fast and normal together);
    M2 → `${priceKey}/read` for class read, `${priceKey}/other` otherwise; `web` → 'web'
    under every model. */
export function groupOf(model: Model, feature: string): string {
  if (feature === 'web') return 'web'
  if (model === 'M0') return 'all'
  const { priceKey, cls } = partsOf(feature)
  if (model === 'M1') return priceKey
  return `${priceKey}/${cls === 'read' ? 'read' : 'other'}`
}

/** Reference = group with the largest dollars (ties by key order; never 'web'; in M2 the
    largest non-read group). Free = every other group except 'web', minus groups holding
    under MIN_GROUP_SHARE of the total dollars, which merge into the reference. */
export function groupsOf(model: Model, dollarsByFeature: Record<string, number>): Grouping {
  if (model === 'M0') return { model, reference: 'all', free: [] }
  const byGroup = new Map<string, number>()
  let total = 0
  for (const [feature, usd] of Object.entries(dollarsByFeature)) {
    total += usd
    const g = groupOf(model, feature)
    if (g !== 'web') byGroup.set(g, (byGroup.get(g) ?? 0) + usd)
  }
  const keys = [...byGroup.keys()].sort()
  const dollarsOf = (g: string) => byGroup.get(g) ?? 0
  const largestOf = (gs: readonly string[]) => gs.reduce<string | undefined>((best, g) => (best === undefined || dollarsOf(g) > dollarsOf(best) ? g : best), undefined)
  const nonRead = model === 'M2' ? keys.filter(g => !g.endsWith('/read')) : keys
  const reference = largestOf(nonRead.length > 0 ? nonRead : keys) ?? 'all'
  const free = keys.filter(g => g !== reference && total > 0 && dollarsOf(g) >= MIN_GROUP_SHARE * total)
  return { model, reference, free }
}

export function weightsOf(groups: Grouping, theta: readonly number[], cov?: number[][], df?: number): Weights {
  return {
    model: groups.model,
    reference: groups.reference,
    free: [...groups.free],
    theta: [...theta],
    cov: cov ?? zeroMatrixOf(groups.free.length),
    df: df ?? 1,
  }
}

/** exp(θ_g) for the feature's group, or 1. */
export function featureWeight(weights: Weights, feature: string): number {
  const g = weights.free.indexOf(groupOf(weights.model, feature))
  return g < 0 ? 1 : Math.exp(weights.theta[g])
}

/** w̄ = (w · x) / Σ x; 1 when Σ x is not above 0. */
export function mixWeight(weights: Weights, x: Record<string, number>): number {
  let sum = 0
  let weighted = 0
  for (const [feature, usd] of Object.entries(x)) {
    sum += usd
    weighted += featureWeight(weights, feature) * usd
  }
  return sum > 0 ? weighted / sum : 1
}

const isUnit = (weights: Weights) => weights.theta.every(t => t === 0)

const toleranceOf = (usd: number) => Math.max(FEATURE_TOLERANCE_RELATIVE * Math.abs(usd), FEATURE_TOLERANCE_ABSOLUTE)

const isSideComplete = (x: readonly number[] | undefined, usd: number, size: number) =>
  x !== undefined && x.length <= size && Math.abs(sumOf(x) - usd) <= toleranceOf(usd)

/** Every bucket has minX and maxX, and each array's sum equals its side's dollars within
    max(1e-6 · usd, 2e-4). */
export function isFeatureComplete(w: WindowReadings): boolean {
  const size = w.features?.length ?? 0
  return Object.values(w.byPct).every(b => isSideComplete(b.minX, b.minUsd, size) && isSideComplete(b.maxX, b.maxUsd, size))
}

/* The window in weighted dollars, from its features alone. */
function transformed(w: WindowReadings, weights: Weights): WindowReadings {
  const wf = (w.features ?? []).map(f => featureWeight(weights, f))
  const byPct: Record<string, Bucket> = {}
  for (const [key, b] of Object.entries(w.byPct)) {
    const minUsd = dotOf(wf, b.minX)
    const maxUsd = dotOf(wf, b.maxX)
    const bucket: Bucket = { ...b, minUsd, maxUsd }
    if (b.minSlack !== undefined) bucket.minSlack = b.minSlack * (b.minUsd > 0 ? minUsd / b.minUsd : 1)
    if (b.maxSlack !== undefined) bucket.maxSlack = b.maxSlack * (b.maxUsd > 0 ? maxUsd / b.maxUsd : 1)
    byPct[key] = bucket
  }
  return { ...w, byPct }
}

/** The window in weighted dollars E: minUsd/maxUsd become w · X at that side, slack is
    scaled by that side's E / U (1 when U = 0). Returns `w` itself when every weight is 1;
    `undefined` when the window is not feature-complete and some weight is not 1. */
export function weightedView(w: WindowReadings, weights: Weights): WindowReadings | undefined {
  if (isUnit(weights)) return w
  return isFeatureComplete(w) ? transformed(w, weights) : undefined
}

type Crossing = { s: number; usd: number; x: number[]; gap: number[]; at: number }

const recordOf = (features: readonly string[], values: readonly number[]) => Object.fromEntries(features.map((f, i) => [f, values[i]]))

/** S3: crossings (gap ≥ 0, as crossingOf), then segments with SEG_MIN_SHARE = 2. A side
    without features counts as 0 dollars in every feature. */
export function segmentsOf(w: WindowReadings, resolution: number, rounding: Rounding): Segment[] {
  const features = w.features ?? []
  const sideOf = (x: readonly number[] | undefined) => features.map((_, i) => x?.[i] ?? 0)
  const levels = levelsOf(w)
  const crossings: Crossing[] = []
  for (const level of levels) {
    if (!crossingOf(levels, level, resolution)) continue
    const lower = levels.find(l => Math.abs(l.pct - (level.pct - resolution)) < resolution / 1000)
    if (!lower) continue
    const from = sideOf(lower.bucket.maxX)
    const to = sideOf(level.bucket.minX)
    crossings.push({
      s: crossingShareOf(level.pct, resolution, rounding).s,
      usd: (lower.bucket.maxUsd + level.bucket.minUsd) / 2,
      x: from.map((v, i) => (v + to[i]) / 2),
      gap: to.map((v, i) => v - from[i]),
      at: Math.max(level.bucket.minAt, lower.bucket.maxAt),
    })
  }
  crossings.sort((a, b) => a.s - b.s || a.at - b.at)
  const pairs: [Crossing, Crossing][] = []
  let anchor = crossings[0]
  for (const c of crossings.slice(1)) {
    if (c.s - anchor.s < SEG_MIN_SHARE - SHARE_EPSILON) continue
    pairs.push([anchor, c])
    anchor = c
  }
  /* The rate at θ = 0 is in the window's own dollars U. */
  const rates = pairs.map(([a, b]) => (b.usd - a.usd) / (b.s - a.s))
  const median = rates.length > 0 ? medianOf(rates) : 0
  return pairs.map(([a, b], k) => ({
    dX: recordOf(features, b.x.map((v, i) => v - a.x[i])),
    ds: b.s - a.s,
    gapA: recordOf(features, a.gap),
    gapB: recordOf(features, b.gap),
    at: b.at,
    isExcluded: rates[k] < OUTLIER_RATE * median,
  }))
}

/* A window that qualifies for fitting: its usable segments, non-excluded with dollars, and
   how many the outlier rule excluded. */
type Prepared = { w: WindowReadings; usable: Segment[]; excluded: number }

/* Feature-complete windows with at least MIN_SEGMENTS usable segments, in resetsAt order. */
function qualify(windows: readonly WindowReadings[], resolution: number, rounding: Rounding) {
  const excluded: Record<string, number> = { 'not-feature-complete': 0, 'too-few-segments': 0 }
  const included: Prepared[] = []
  let segments = 0
  let excludedSegments = 0
  for (const w of windows) {
    if (!isFeatureComplete(w)) {
      excluded['not-feature-complete']++
      continue
    }
    const all = segmentsOf(w, resolution, rounding)
    const usable = all.filter(s => !s.isExcluded && sumOf(Object.values(s.dX)) > 0)
    if (usable.length < MIN_SEGMENTS) {
      excluded['too-few-segments']++
      continue
    }
    const out = all.filter(s => s.isExcluded).length
    included.push({ w, usable, excluded: out })
    segments += usable.length
    excludedSegments += out
  }
  included.sort((a, b) => Date.parse(a.w.resetsAt) - Date.parse(b.w.resetsAt))
  return { included, excluded, segments, excludedSegments }
}

function dollarsOf(prepared: readonly Prepared[]) {
  const dollars: Record<string, number> = {}
  for (const p of prepared) for (const s of p.usable) for (const [f, v] of Object.entries(s.dX)) dollars[f] = (dollars[f] ?? 0) + v
  return dollars
}

/* One window's usable segments summed by group: slot 0 holds every group of weight 1, slot
   g + 1 the free group g. offset centers y for precision; it cancels with α̂. */
type WindowColumns = {
  size: number
  offset: number
  logDs: number[]
  invDs: number[]
  dx: number[]
  ga: number[]
  gb: number[]
  at: number[]
}

type Columns = { n: number; windows: WindowColumns[] }

function columnsOf(prepared: readonly Prepared[], groups: Grouping): Columns {
  const n = groups.free.length
  const width = n + 1
  const slots = new Map<string, number>()
  const slotOf = (feature: string) => {
    let slot = slots.get(feature)
    if (slot === undefined) {
      slot = groups.free.indexOf(groupOf(groups.model, feature)) + 1
      slots.set(feature, slot)
    }
    return slot
  }
  const windows = prepared.map(p => {
    const size = p.usable.length
    const dx = zerosOf(size * width)
    const ga = zerosOf(size * width)
    const gb = zerosOf(size * width)
    p.usable.forEach((s, k) => {
      for (const [f, v] of Object.entries(s.dX)) dx[k * width + slotOf(f)] += v
      for (const [f, v] of Object.entries(s.gapA)) ga[k * width + slotOf(f)] += v
      for (const [f, v] of Object.entries(s.gapB)) gb[k * width + slotOf(f)] += v
    })
    const first = p.usable[0]
    return {
      size,
      offset: Math.log(sumOf(Object.values(first.dX)) / first.ds),
      logDs: p.usable.map(s => Math.log(s.ds)),
      invDs: p.usable.map(s => 1 / s.ds),
      dx,
      ga,
      gb,
      at: p.usable.map(s => s.at),
    }
  })
  return { n, windows }
}

const withoutBlock = (cols: Columns, [from, to]: readonly [number, number]): Columns => ({
  n: cols.n,
  windows: cols.windows.filter((_, i) => i < from || i >= to),
})

/* K contiguous blocks of `count` items, as [from, to) ranges. */
const blocksOf = (count: number, k: number) =>
  Array.from({ length: k }, (_, b) => [Math.floor((b * count) / k), Math.floor(((b + 1) * count) / k)] as [number, number])

const logOmegaOf = (x: number) => Math.min(Math.log(OMEGA_MAX), Math.max(Math.log(OMEGA_MIN), x))

const omegaOf = (x: number) => Math.exp(logOmegaOf(x))

const expOf = (theta: readonly number[]) => [1, ...theta.map(t => Math.exp(t))]

/* ½ Σ_i Σ_k [(y_ik − α̂_i)² / V_ik + log V_ik], α̂_i the precision-weighted mean of window
   i's y; Infinity where some w · ΔX is not above 0. */
function devianceOf(cols: Columns, theta: readonly number[], logOmega: number) {
  const width = cols.n + 1
  const e = expOf(theta)
  const omega2 = omegaOf(logOmega) ** 2
  let total = 0
  for (const c of cols.windows) {
    let s0 = 0
    let s1 = 0
    let s2 = 0
    let sl = 0
    for (let k = 0; k < c.size; k++) {
      const base = k * width
      let dot = 0
      let a = 0
      let b = 0
      for (let j = 0; j < width; j++) {
        dot += e[j] * c.dx[base + j]
        a += e[j] * c.ga[base + j]
        b += e[j] * c.gb[base + j]
      }
      if (!(dot > 0)) return Infinity
      const y = Math.log(dot) - c.logDs[k] - c.offset
      const v = omega2 * c.invDs[k] + (a * a + b * b) / (12 * dot * dot)
      const p = 1 / v
      s0 += p
      s1 += p * y
      s2 += p * y * y
      sl += Math.log(v)
    }
    total += s2 - (s1 * s1) / s0 + sl
  }
  return total / 2
}

const penaltyOf = (theta: readonly number[]) => theta.reduce((s, t) => s + (t * t) / (2 * SIGMA_THETA ** 2), 0)

/* Each segment's w · ΔX, y less the window's offset, and V; a segment whose w · ΔX is not
   above 0 has V = Infinity, which leaves it out. */
function responsesOf(c: WindowColumns, e: readonly number[], omega: number) {
  const width = e.length
  const dots: number[] = []
  const ys: number[] = []
  const vs: number[] = []
  for (let k = 0; k < c.size; k++) {
    const base = k * width
    let dot = 0
    let a = 0
    let b = 0
    for (let j = 0; j < width; j++) {
      dot += e[j] * c.dx[base + j]
      a += e[j] * c.ga[base + j]
      b += e[j] * c.gb[base + j]
    }
    const isUsable = dot > 0
    dots.push(dot)
    ys.push(isUsable ? Math.log(dot) - c.logDs[k] - c.offset : 0)
    vs.push(isUsable ? omega * omega * c.invDs[k] + (a * a + b * b) / (12 * dot * dot) : Infinity)
  }
  return { dots, ys, vs }
}

/* log N(y_k; α̂, V_k) of each segment of one window, α̂ profiled; 0 for a segment left out. */
function densitiesOf(c: WindowColumns, theta: readonly number[], omega: number) {
  const { ys, vs } = responsesOf(c, expOf(theta), omega)
  let sp = 0
  let spy = 0
  ys.forEach((y, k) => {
    sp += 1 / vs[k]
    spy += y / vs[k]
  })
  const alpha = sp > 0 ? spy / sp : 0
  return ys.map((y, k) => (Number.isFinite(vs[k]) ? -0.5 * (Math.log(2 * Math.PI * vs[k]) + (y - alpha) ** 2 / vs[k]) : 0))
}

/* I_g = Σ (d_ik − d̄_i)² / V_ik: d_ik is group g's share of the segment's w · ΔX, d̄_i its
   precision-weighted window mean. */
function informationOf(cols: Columns, theta: readonly number[], omega: number) {
  const n = cols.n
  const width = n + 1
  const e = expOf(theta)
  const information = zerosOf(n)
  for (const c of cols.windows) {
    const { dots, vs } = responsesOf(c, e, omega)
    const sp = vs.reduce((s, v) => s + 1 / v, 0)
    if (!(sp > 0)) continue
    for (let g = 0; g < n; g++) {
      const shares = dots.map((dot, k) => (dot > 0 ? (e[g + 1] * c.dx[k * width + g + 1]) / dot : 0))
      const mean = shares.reduce((s, d, k) => s + d / vs[k], 0) / sp
      information[g] += shares.reduce((s, d, k) => s + (d - mean) ** 2 / vs[k], 0)
    }
  }
  return information
}

/* Minimizes f from `start` with a simplex of `step` along each axis, with the standard
   coefficients. Stops when the simplex's values lie within NM_TOLERANCE and its points
   within NM_X_TOLERANCE of the best, or after NM_MAX_ITERATIONS. */
function nelderMead(f: (x: number[]) => number, start: readonly number[], step: number): number[] {
  const d = start.length
  const valueOf = (x: number[]) => {
    const v = f(x)
    return Number.isNaN(v) ? Infinity : v
  }
  let points = [start.slice(), ...start.map((_, i) => start.map((v, j) => (i === j ? v + step : v)))]
  let values = points.map(valueOf)
  const order = () => {
    const index = points.map((_, i) => i).sort((a, b) => (values[a] < values[b] ? -1 : values[a] > values[b] ? 1 : a - b))
    points = index.map(i => points[i])
    values = index.map(i => values[i])
  }
  const replace = (x: number[], v: number) => {
    points[d] = x
    values[d] = v
  }
  for (let iteration = 0; iteration < NM_MAX_ITERATIONS; iteration++) {
    order()
    let size = 0
    for (const p of points) for (let i = 0; i < d; i++) size = Math.max(size, Math.abs(p[i] - points[0][i]))
    if (values[d] - values[0] <= NM_TOLERANCE && size <= NM_X_TOLERANCE) break
    const centroid = start.map((_, i) => {
      let s = 0
      for (let j = 0; j < d; j++) s += points[j][i]
      return s / d
    })
    const toward = (t: number) => centroid.map((c, i) => c + t * (points[d][i] - c))
    const reflected = toward(-1)
    const fr = valueOf(reflected)
    if (fr < values[0]) {
      const expanded = toward(-2)
      const fe = valueOf(expanded)
      if (fe < fr) replace(expanded, fe)
      else replace(reflected, fr)
    } else if (fr < values[d - 1]) {
      replace(reflected, fr)
    } else {
      const isOutside = fr < values[d]
      const contracted = toward(isOutside ? -0.5 : 0.5)
      const fc = valueOf(contracted)
      if (isOutside ? fc <= fr : fc < values[d]) replace(contracted, fc)
      else
        for (let j = 1; j <= d; j++) {
          points[j] = points[j].map((v, i) => points[0][i] + (v - points[0][i]) / 2)
          values[j] = valueOf(points[j])
        }
    }
  }
  order()
  return points[0]
}

const startOf = (n: number) => [...zerosOf(n), Math.log(OMEGA_START)]

/* (θ, log ω) minimizing the penalized objective Q of S4. */
function optimize(cols: Columns, start: readonly number[], step: number) {
  const n = cols.n
  return nelderMead(x => {
    const theta = x.slice(0, n)
    return devianceOf(cols, theta, x[n]) + penaltyOf(theta)
  }, start, step)
}

/* ω with θ held fixed. */
function omegaFitOf(cols: Columns, theta: readonly number[]) {
  if (cols.windows.length === 0) return OMEGA_START
  return omegaOf(nelderMead(x => devianceOf(cols, theta, x[0]), [Math.log(OMEGA_START)], NM_STEP)[0])
}

/* S5 on prepared columns: K = min(G, JACKKNIFE_BLOCKS) contiguous blocks, each left out in
   turn, refitting from x. */
function jackknifeOf(cols: Columns, x: readonly number[]) {
  const n = cols.n
  const k = Math.min(cols.windows.length, JACKKNIFE_BLOCKS)
  const df = Math.max(0, k - 1)
  if (n === 0 || k < 2) return { cov: zeroMatrixOf(n), se: zerosOf(n), df }
  const thetas = blocksOf(cols.windows.length, k).map(block => optimize(withoutBlock(cols, block), x, NM_WARM_STEP).slice(0, n))
  const mean = zerosOf(n).map((_, g) => sumOf(thetas.map(t => t[g])) / k)
  const cov = zeroMatrixOf(n).map((row, a) => row.map((_, b) => ((k - 1) / k) * sumOf(thetas.map(t => (t[a] - mean[a]) * (t[b] - mean[b])))))
  return { cov, se: cov.map((row, g) => Math.sqrt(row[g])), df }
}

type Fitted = { result: FitResult; cols: Columns; x: number[] }

/* S4 on qualifying windows, in resetsAt order. */
function fitPrepared(model: Model, prepared: readonly Prepared[], options: FitOptions): Fitted | undefined {
  if (prepared.length < MIN_WINDOWS) return undefined
  let groups = options.groups ?? groupsOf(model, dollarsOf(prepared))
  let cols = columnsOf(prepared, groups)
  let x = optimize(cols, startOf(groups.free.length), NM_STEP)
  if (!options.groups && groups.free.length > 0) {
    const information = informationOf(cols, x.slice(0, cols.n), omegaOf(x[cols.n]))
    const free = groups.free.filter((_, g) => information[g] >= 1 / SIGMA_THETA ** 2)
    if (free.length < groups.free.length) {
      groups = { ...groups, free }
      cols = columnsOf(prepared, groups)
      x = optimize(cols, startOf(free.length), NM_STEP)
    }
  }
  const n = cols.n
  const theta = x.slice(0, n)
  const omega = omegaOf(x[n])
  const k = Math.min(prepared.length, JACKKNIFE_BLOCKS)
  const jk = options.isJackknifed === false ? { cov: zeroMatrixOf(n), se: zerosOf(n), df: k - 1 } : jackknifeOf(cols, x)
  const result: FitResult = {
    model,
    groups: { model: groups.model, reference: groups.reference, free: [...groups.free] },
    theta,
    omega,
    cov: jk.cov,
    se: jk.se,
    df: jk.df,
    information: informationOf(cols, theta, omega),
    windows: prepared.length,
    segments: sumOf(prepared.map(p => p.usable.length)),
    excludedSegments: sumOf(prepared.map(p => p.excluded)),
    weights: weightsOf(groups, theta, jk.cov, jk.df),
  }
  return { result, cols, x }
}

/** S4. Throws if any window's kind is not 'five_hour'. Filters to feature-complete windows
    with ≥ 2 non-excluded segments; returns undefined below MIN_WINDOWS such windows. Group
    pruning (2% share, then information < 1/SIGMA_THETA²) unless `groups` is given; the
    dollars for the 2% rule are Σ ΔX over the non-excluded segments. */
export function fit(model: Model, windows: readonly WindowReadings[], options: FitOptions): FitResult | undefined {
  const other = windows.find(w => w.kind !== 'five_hour')
  if (other) throw new Error(`The meter weights are fitted on five_hour windows only, not ${other.kind}.`)
  return fitPrepared(model, qualify(windows, options.resolution, options.rounding).included, options)?.result
}

/** S5: blocked jackknife with K = min(G, 20) contiguous blocks in resetsAt order, refitting
    with the grouping held fixed, from θ and the ω fitted at it. */
export function jackknife(
  model: Model,
  windows: readonly WindowReadings[],
  groups: Grouping,
  theta: readonly number[],
  options: FitOptions,
): { cov: number[][]; se: number[]; df: number } {
  const cols = columnsOf(qualify(windows, options.resolution, options.rounding).included, { ...groups, model })
  return jackknifeOf(cols, [...theta, Math.log(omegaFitOf(cols, theta))])
}

/** Score of one window under fixed weights and ω: Σ_k log N(y_k; α̂, V_k), α̂ profiled as
    the precision-weighted mean. Undefined when the window is not feature-complete or has
    fewer than 2 usable segments. */
export function scoreWindow(w: WindowReadings, weights: Weights, omega: number, resolution: number, rounding: Rounding): number | undefined {
  const [prepared] = qualify([w], resolution, rounding).included
  if (!prepared) return undefined
  const [c] = columnsOf([prepared], weights).windows
  return sumOf(densitiesOf(c, weights.theta, omega))
}

/* Held-out score per fold: each fold's windows scored under the fit on the other folds. */
function crossValidated(fitted: Fitted, folds: readonly [number, number][]) {
  const { cols, x } = fitted
  const n = cols.n
  return folds.map(block => {
    const fx = optimize(withoutBlock(cols, block), x, NM_WARM_STEP)
    const theta = fx.slice(0, n)
    const omega = omegaOf(fx[n])
    let score = 0
    for (let i = block[0]; i < block[1]; i++) score += sumOf(densitiesOf(cols.windows[i], theta, omega))
    return score
  })
}

/** S6: blocked K-fold CV, K = min(G, 10), contiguous blocks; grouping held fixed per
    candidate (from its full fit). Rule: Δ > max(2, 2·SE_Δ), some |θ̂|/SE_J ≥ 2, ≥ 4 windows.
    Under 4 qualifying windows: selected 'M0' with no fits. */
export function selectModel(fiveHourWindows: readonly WindowReadings[], options: { resolution: number; rounding: Rounding }): Selection {
  const { resolution, rounding } = options
  const fiveHour = fiveHourWindows.filter(w => w.kind === 'five_hour')
  const q = qualify(fiveHour, resolution, rounding)
  const summary = {
    rounding,
    windows: { used: q.included.length, excluded: { ...q.excluded, 'not-five-hour': fiveHourWindows.length - fiveHour.length } },
    segments: q.segments,
    excludedSegments: q.excludedSegments,
  }
  const fitted: Partial<Record<Model, Fitted>> = {}
  const fits: Partial<Record<Model, FitResult>> = {}
  for (const model of MODELS) {
    const f = fitPrepared(model, q.included, { resolution, rounding })
    if (!f) continue
    fitted[model] = f
    fits[model] = f.result
  }
  if (!fitted.M0) return { selected: 'M0', weights: UNIT_WEIGHTS, fits, comparisons: [], ...summary }
  const folds = blocksOf(q.included.length, Math.min(q.included.length, CV_FOLDS))
  const scores = new Map<Model, number[]>()
  const scoresOf = (model: Model) => {
    let s = scores.get(model)
    if (!s) {
      s = crossValidated(fitted[model]!, folds)
      scores.set(model, s)
    }
    return s
  }
  const compare = (from: Model, to: Model): Comparison => {
    const target = fitted[to]?.result
    if (!target || !fitted[from] || target.groups.free.length === 0) return { from, to, delta: 0, se: 0, folds: 0, isSelected: false }
    const base = scoresOf(from)
    const d = scoresOf(to).map((s, k) => s - base[k])
    const delta = sumOf(d)
    const se = Math.sqrt(d.length * sampleVarianceOf(d))
    const isClear = target.theta.some((t, g) => target.se[g] > 0 && Math.abs(t) / target.se[g] >= SELECT_MIN_Z)
    return { from, to, delta, se, folds: d.length, isSelected: delta > Math.max(SELECT_MIN_DELTA, SELECT_SE_MULTIPLE * se) && isClear }
  }
  const first = compare('M0', 'M1')
  let selected: Model = first.isSelected ? 'M1' : 'M0'
  const second = compare(selected, 'M2')
  if (second.isSelected) selected = 'M2'
  const weights = selected === 'M0' ? UNIT_WEIGHTS : fits[selected]!.weights
  return { selected, weights, fits, comparisons: [first, second], ...summary }
}

/** S6b on qualifying weekly windows: ω_week fitted per candidate with θ held fixed, α
    profiled under each; d_day sums the segments' log-density differences by the UTC day of
    their end crossing. Under UNIT_WEIGHTS: unchecked, with both ω fitted under M0. */
export function transferCheck(weeklyWindows: readonly WindowReadings[], weights: Weights, options: { resolution: number; rounding: Rounding }): Transfer {
  const { resolution, rounding } = options
  const prepared = qualify(weeklyWindows, resolution, rounding).included
  const cols = columnsOf(prepared, weights)
  const zero = zerosOf(cols.n)
  const omegaM0 = omegaFitOf(cols, zero)
  const weeklyFit = prepared.length >= WEEKLY_FIT_MIN_WEEKS ? fitPrepared('M1', prepared, { resolution, rounding })?.result : undefined
  const reported = { weeks: prepared.length, ...(weeklyFit ? { weeklyFit } : {}) }
  if (isUnit(weights)) return { isChecked: false, isRejected: false, delta: 0, se: 0, days: 0, omega: { selected: omegaM0, M0: omegaM0 }, ...reported }
  const omega = omegaFitOf(cols, weights.theta)
  const byDay = new Map<number, number>()
  for (const c of cols.windows) {
    const selected = densitiesOf(c, weights.theta, omega)
    const plain = densitiesOf(c, zero, omegaM0)
    c.at.forEach((at, k) => {
      const day = Math.floor(at / DAY_MS)
      byDay.set(day, (byDay.get(day) ?? 0) + selected[k] - plain[k])
    })
  }
  const d = [...byDay.values()]
  const delta = sumOf(d)
  const se = Math.sqrt(d.length * sampleVarianceOf(d))
  const isChecked = d.length >= TRANSFER_MIN_DAYS
  return {
    isChecked,
    isRejected: isChecked && delta < -Math.max(SELECT_MIN_DELTA, SELECT_SE_MULTIPLE * se),
    delta,
    se,
    days: d.length,
    omega: { selected: omega, M0: omegaM0 },
    ...reported,
  }
}

/** S7: one record per new window that scores under both the stored weights and M0, with
    d = score_selected − score_M0; [] when the stored weights are M0's. */
export function prospectiveScore(
  stored: StoredFit,
  newWindows: readonly WindowReadings[],
  options: { resolution: number; rounding: Rounding },
): ProspectiveRecord[] {
  if (isUnit(stored.weights)) return []
  const records: ProspectiveRecord[] = []
  for (const w of newWindows) {
    const selected = scoreWindow(w, stored.weights, stored.omega, options.resolution, options.rounding)
    const plain = scoreWindow(w, UNIT_WEIGHTS, stored.omegaM0, options.resolution, options.rounding)
    if (selected === undefined || plain === undefined) continue
    records.push({ resetsAt: w.resetsAt, kind: w.kind, d: selected - plain })
  }
  return records
}

/** Deterministic string over the inputs listed in S7. Each window as (window key, bucket
    count, latest maxAt), sorted by key. */
export function fingerprintOf(input: {
  fiveHour: readonly { key: string; w: WindowReadings }[]
  weekly: readonly { key: string; w: WindowReadings }[]
  regimeStarts: Record<string, number>
  pricesId?: string
  schema: number
  stamp: number
}): string {
  const listOf = (windows: readonly { key: string; w: WindowReadings }[]) =>
    windows
      .map(({ key, w }) => {
        const buckets = Object.values(w.byPct)
        return [key, buckets.length, buckets.reduce((latest, b) => Math.max(latest, b.maxAt), 0)] as const
      })
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return JSON.stringify({
    fiveHour: listOf(input.fiveHour),
    weekly: listOf(input.weekly),
    regimeStarts: Object.keys(input.regimeStarts)
      .sort()
      .map(key => [key, input.regimeStarts[key]]),
    pricesId: input.pricesId ?? null,
    schema: input.schema,
    stamp: input.stamp,
  })
}

/* Rejections in weighted dollars: each at the mix of the newest max side of the closed
   window with the same reset; dropped without that window or its features. */
function weightedRejections(closed: readonly WindowReadings[], rejections: readonly Rejection[], kind: string, weights: Weights) {
  const weighted: Rejection[] = []
  for (const r of rejections) {
    if (r.kind !== kind) continue
    const w = closed.find(c => c.kind === kind && minuteOf(c.resetsAt) === minuteOf(r.resetsAt))
    if (!w || !isFeatureComplete(w)) continue
    const newest = Object.values(w.byPct).reduce<Bucket | undefined>((a, b) => (!a || b.maxAt > a.maxAt ? b : a), undefined)
    if (!newest) continue
    const x = newest.maxX ?? []
    const total = sumOf(x)
    const wf = (w.features ?? []).map(f => featureWeight(weights, f))
    weighted.push({ ...r, usd: r.usd * (total > 0 ? dotOf(wf, x) / total : 1) })
  }
  return weighted
}

type Run = { estimate?: Estimate; view?: WindowReadings; spread: Spread; past: PastPoint[]; mix: number; usedE: number; excluded: number }

/* The pipeline in weighted dollars, through the features of every window. */
function runAt(input: WeightedEstimateInput, weights: Weights): Run {
  const { kind, closed, current, usedUsd, usedX, fallbackX, rejections, resolution, rounding, now, livePercent, startedAt } = input
  const views = closed.filter(w => isFeatureComplete(w)).map(w => transformed(w, weights))
  const view = current && isFeatureComplete(current) ? transformed(current, weights) : undefined
  const mix =
    usedUsd > 0 && sumOf(Object.values(usedX)) > 0
      ? mixWeight(weights, usedX)
      : fallbackX && sumOf(Object.values(fallbackX)) > 0
        ? mixWeight(weights, fallbackX)
        : 1
  const usedE = usedUsd * mix
  const spread = calibrateOmega(views, kind, now, resolution, rounding)
  const past = pastPoints(views, weightedRejections(closed, rejections, kind, weights), kind, resolution, rounding, spread.omega).filter(
    p => p.at >= startedAt,
  )
  const e = view ? estimate(view, usedE, { resolution, rounding, past, kind, now, livePercent, spread }) : undefined
  return { estimate: e, view, spread, past, mix, usedE, excluded: closed.length - views.length }
}

const scaledBy = (r: RangeEstimate, f: number): RangeEstimate => ({ value: r.value * f, low: r.low * f, high: r.high * f })

/** Weighted views of closed and current windows (closed ones that cannot be transformed are
    dropped and counted), calibrateOmega, pastPoints (under non-unit weights a rejection's
    usd is multiplied by the w̄ of the closed window with the same reset's newest max side
    when that window is feature-complete, otherwise the rejection is dropped), estimate().
    The displayed log quantity is L = e.log.mean − log w̄_window; its gradient by central
    finite differences of GRADIENT_STEP per free group through the whole pipeline gives
    extraVariance = ∇ᵀ Σ_J ∇, and estimate() is rerun with it. Under UNIT_WEIGHTS the result
    is the plain pipeline's; with a zero cov, the weighted pipeline's without extra variance.
    No estimate when the current window is not feature-complete under non-unit weights. */
export function weightedEstimate(input: WeightedEstimateInput): WeightedEstimate {
  const { kind, closed, current, usedUsd, weights, rejections, resolution, rounding, now, livePercent, startedAt } = input
  if (isUnit(weights)) {
    const spread = calibrateOmega(closed, kind, now, resolution, rounding)
    const past = pastPoints(closed, rejections, kind, resolution, rounding, spread.omega).filter(p => p.at >= startedAt)
    const e = current ? estimate(current, usedUsd, { resolution, rounding, past, kind, now, livePercent, spread }) : undefined
    return {
      estimate: e,
      display: e && { allowance: e.allowance, left: e.left, nextTick: e.nextTick },
      usedE: usedUsd,
      mixWeight: 1,
      extraVariance: 0,
      spread,
      past,
      excludedClosed: 0,
    }
  }
  const base = runAt(input, weights)
  let e = base.estimate
  let extraVariance = 0
  const isCovZero = weights.cov.every(row => row.every(v => v === 0))
  if (e && base.view && !isCovZero) {
    const displayedOf = (run: Run) => (run.estimate ? run.estimate.log.mean - Math.log(run.mix) : undefined)
    const at = (g: number, h: number) => displayedOf(runAt(input, { ...weights, theta: weights.theta.map((t, j) => (j === g ? t + h : t)) }))
    const l0 = e.log.mean - Math.log(base.mix)
    const gradient = weights.theta.map((_, g) => {
      const up = at(g, GRADIENT_STEP)
      const down = at(g, -GRADIENT_STEP)
      if (up !== undefined && down !== undefined) return (up - down) / (2 * GRADIENT_STEP)
      if (up !== undefined) return (up - l0) / GRADIENT_STEP
      if (down !== undefined) return (l0 - down) / GRADIENT_STEP
      return 0
    })
    extraVariance = quadraticOf(gradient, weights.cov)
    if (extraVariance > 0) {
      e = estimate(base.view, base.usedE, { resolution, rounding, past: base.past, kind, now, livePercent, spread: base.spread, extraVariance })
    }
  }
  const toU = 1 / base.mix
  return {
    estimate: e,
    display: e && { allowance: scaledBy(e.allowance, toU), left: scaledBy(e.left, toU), nextTick: e.nextTick && scaledBy(e.nextTick, toU) },
    usedE: base.usedE,
    mixWeight: base.mix,
    extraVariance,
    spread: base.spread,
    past: base.past,
    excludedClosed: base.excluded,
  }
}

/** Per priceKey in the tally: w̄_m = Σ_{f∈m} w_f x_f / Σ_{f∈m} x_f, with a 90% interval
    from ∂ log w̄_m / ∂θ_g (group g's share of model m's weighted dollars), Σ_J and
    t(0.95, df). `web` is not a model. */
export function modelConversion(weights: Weights, tally7d: Record<string, number>): Record<string, RangeEstimate> {
  const byModel = new Map<string, string[]>()
  for (const feature of Object.keys(tally7d).sort()) {
    if (feature === 'web') continue
    const { priceKey } = partsOf(feature)
    byModel.set(priceKey, [...(byModel.get(priceKey) ?? []), feature])
  }
  const n = weights.free.length
  const conversions: Record<string, RangeEstimate> = {}
  for (const [priceKey, features] of byModel) {
    let sum = 0
    let weighted = 0
    const byGroup = zerosOf(n)
    for (const feature of features) {
      const x = tally7d[feature]
      const wx = featureWeight(weights, feature) * x
      sum += x
      weighted += wx
      const g = weights.free.indexOf(groupOf(weights.model, feature))
      if (g >= 0) byGroup[g] += wx
    }
    const isPriced = sum > 0 && weighted > 0
    const gradient = isPriced ? byGroup.map(v => v / weighted) : zerosOf(n)
    const log = { mean: isPriced ? Math.log(weighted / sum) : 0, variance: quadraticOf(gradient, weights.cov), shift: 0, df: weights.df }
    conversions[priceKey] = rangeOf(log, 0, 0)
  }
  return conversions
}

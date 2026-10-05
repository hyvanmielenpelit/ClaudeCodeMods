/* Estimates a rate-limit window's allowance in dollars from readings of (used dollars,
   reported percent) and gives a 90% range.

   Each reading constrains the allowance A. A percent p reported at resolution r means the
   true share lies in [p - r/2, p + r) (rounded or truncated, whichever the source does), so
   U / (p + r)% <= A <= U / (p - r/2)%. Intersecting every reading of the window gives hard
   bounds that tighten as the percent ticks over. Dollars track the limit only as far as
   API prices match the limit's own weighting, so the bounds are widened by that mix error:
   the spread of past windows' allowances when there are at least three, else an assumed
   10%. Past windows also give a prior that the current bounds are intersected with. */

export type Bucket = { minUsd: number; maxUsd: number }

export type WindowReadings = { kind: string; resetsAt: string; byPct: Record<string, Bucket> }

export type RangeEstimate = { value: number; low: number; high: number }

export type Estimate = {
  allowance: RangeEstimate
  left: RangeEstimate
  readings: number
  pastWindows: number
  isMixErrorAssumed: boolean
}

const Z90 = 1.645
const ASSUMED_MIX_ERROR = 0.1
const MAX_HISTORY_RATIO = 1.5

export function resolutionOf(all: readonly WindowReadings[]) {
  const isFine = all.some(w => Object.keys(w.byPct).some(p => !Number.isInteger(Number(p))))
  return isFine ? 0.1 : 1
}

export function record(w: WindowReadings, pct: number, usd: number): WindowReadings {
  const key = String(pct)
  const was = w.byPct[key]
  const bucket = was
    ? { minUsd: Math.min(was.minUsd, usd), maxUsd: Math.max(was.maxUsd, usd) }
    : { minUsd: usd, maxUsd: usd }
  return { ...w, byPct: { ...w.byPct, [key]: bucket } }
}

export function bounds(w: WindowReadings, resolution: number) {
  let low = 0
  let high = Infinity
  for (const [key, bucket] of Object.entries(w.byPct)) {
    const pct = Number(key)
    low = Math.max(low, bucket.maxUsd / ((pct + resolution) / 100))
    const floor = pct - resolution / 2
    if (floor > 0) high = Math.min(high, bucket.minUsd / (floor / 100))
  }
  return { low, high }
}

/* A closed window whose bounds are tight enough stands as one observed allowance. */
export function observed(w: WindowReadings, resolution: number) {
  const { low, high } = bounds(w, resolution)
  return low > 0 && Number.isFinite(high) && high / low <= MAX_HISTORY_RATIO ? Math.sqrt(low * high) : undefined
}

function spread(points: readonly number[]) {
  const logs = points.map(Math.log)
  const mean = logs.reduce((a, b) => a + b, 0) / logs.length
  const variance = logs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, logs.length - 1)
  return { mean, sd: Math.sqrt(variance) }
}

export function estimate(
  w: WindowReadings,
  usedUsd: number,
  resolution: number,
  history: readonly number[],
): Estimate | undefined {
  let { low, high } = bounds(w, resolution)
  const past = history.filter(x => x > 0)
  const isMixErrorAssumed = past.length < 3
  let mix = isMixErrorAssumed ? ASSUMED_MIX_ERROR : spread(past).sd

  if (low > high) {
    /* Readings that contradict each other are mix error showing; meet in the middle. */
    mix = Math.max(mix, Math.log(low / high) / 2)
    low = high = Math.sqrt(low * high)
  }
  let lo = low * Math.exp(-Z90 * mix)
  let hi = high * Math.exp(Z90 * mix)

  if (past.length >= 2) {
    const { mean } = spread(past)
    const width = Z90 * mix * Math.sqrt(1 + 1 / past.length)
    const priorLo = Math.exp(mean - width)
    const priorHi = Math.exp(mean + width)
    if (priorLo <= hi && priorHi >= lo) {
      lo = Math.max(lo, priorLo)
      hi = Math.min(hi, priorHi)
    }
  }
  if (!Number.isFinite(hi) || lo <= 0) return undefined

  lo = Math.max(lo, usedUsd)
  hi = Math.max(hi, lo)
  const value = Math.sqrt(lo * hi)
  return {
    allowance: { value, low: lo, high: hi },
    left: { value: value - usedUsd, low: lo - usedUsd, high: hi - usedUsd },
    readings: Object.keys(w.byPct).length,
    pastWindows: past.length,
    isMixErrorAssumed,
  }
}

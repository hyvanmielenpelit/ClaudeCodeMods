export type ModelSpend = { model: string; usd: number; requests: number }

export type RangeReport = { value: number; low: number; high: number }

export type Confidence = 'good' | 'fair' | 'rough'

export type WindowReport = {
  title: string
  short: string
  usedUsd: number
  requests: number
  resetLong: string
  resetIn: string
  left?: RangeReport
  allowance?: RangeReport
  confidence?: Confidence
  nextTick?: RangeReport
  pastWeight?: number
  isPriorContradicted?: boolean
  /** The spread of allowances between windows is assumed: under 3 effective past windows. */
  isSpreadAssumed?: boolean
  /** The percent the limit reported, the freshest any session received. */
  percent?: number
  /** Minutes since that percent was received. */
  percentAgeMinutes?: number
  basis: string
  /** Both spreads and the rounding rule rest on closed windows. */
  isCalibrated?: boolean
}

export type PlanReport = {
  label?: string
  asOfLabel?: string
  isStale: boolean
  isUnknown: boolean
  /** "Max 5x on Mon 5 Oct, 10:23": the plan last seen for this subscription. */
  lastKnown?: string
  /** Set only while the plan is unknown: whether any profile was found at all. */
  unknownReason?: 'no-profile' | 'other-subscription'
}

export type UsageReport = {
  type: 'windows'
  plan: PlanReport
  notices: string[]
  last24hUsd?: number
  sinceResetLabel?: string
  windows: WindowReport[]
  byModel: ModelSpend[]
  byModelTitle: string
  notes: string[]
  files: number
  ms: number
}

export type DaySpend = { date: string; label: string; usd: number; requests: number }

export type SpendReport = {
  type: 'report'
  fromLabel: string
  toLabel: string
  usedUsd: number
  requests: number
  byDay: DaySpend[]
  byModel: ModelSpend[]
  notes: string[]
}

export type CheckItem = { label: string; state: 'ok' | 'fail' | 'info'; text: string }

export type CheckReport = {
  type: 'check'
  items: CheckItem[]
}

/** What has been measured for one window. */
export type CalibrationWindow = {
  title: string
  /** Percent levels read in the current window, and how many of them with a tick. */
  levels: number
  ticks: number
  /** Closed windows of this kind, since the latest restart, that hold readings. */
  closedWindows: number
  /** Closed windows that gave the within-window spread a crossing; measured from 2. */
  closedForWithin: number
  isWithinMeasured: boolean
  /** Past windows behind the prior, rejections included, and their effective weight. */
  pastPoints: number
  pastWeight: number
  isBetweenMeasured: boolean
  /** Closed windows of every subscription that could show the rounding rule. */
  closedForRounding: number
  roundingNeeded: number
  isRoundingKnown: boolean
  rounding: 'round' | 'truncate' | 'union'
  /** Of the three above. */
  measured: number
  isCalibrated: boolean
  /** Of the current 90% range, in proportion: 0.12 for ±12%. */
  halfWidth?: number
}

export type CalibrationReport = {
  type: 'calibration'
  windows: CalibrationWindow[]
}

/** A candidate meter model: M0, the API price ratio; M1, a weight per model; M2, per model
    for cache reads and for the rest. */
export type MeterModel = 'M0' | 'M1' | 'M2'

/** One free group of a fit: how the meter counts its API dollars against the reference
    group's. */
export type ModelsGroup = {
  /** A price key under M1, `<priceKey>/read` or `<priceKey>/other` under M2. */
  key: string
  /** "Fable 5.1", "Fable 5.1 cache reads", "Fable 5.1 except cache reads". */
  label: string
  /** exp(θ), and its 90% interval exp(θ ± t(0.95, df) · se). */
  weight: RangeReport
  /** The windows' information on θ; the prior's is 4. */
  information: number
}

/** One candidate model fitted on the 5-hour windows. */
export type ModelsFit = {
  model: MeterModel
  /** The group at weight 1 that the others are measured against, and its label. */
  reference: string
  referenceLabel: string
  /** Empty under M0, or when every other group merged into the reference. */
  groups: ModelsGroup[]
  /** Within-window spread ω of the fit. */
  omega: number
  windows: number
  segments: number
  /** Degrees of freedom of the intervals: jackknife blocks less 1. */
  df: number
}

/** Cross-validated gain of `to` over `from`, in nats, with its SE; isSelected: `to` won. */
export type ModelsComparison = { from: MeterModel; to: MeterModel; delta: number; se: number; folds: number; isSelected: boolean }

/** Whether the 5-hour weights hold for the weeks. */
export type ModelsTransfer = {
  /** At least 5 days of weekly segments: until then the weeks use the weights unchecked. */
  isChecked: boolean
  /** The weeks fall back to M0. */
  isRejected: boolean
  days: number
  /** Log-score gain of the weights over M0 on the weekly segments, in nats, with its SE. */
  delta: number
  se: number
  /** Qualifying closed weeks. */
  weeks: number
  /** A weekly-only M1 fit from 4 closed weeks on, for comparison only. */
  weeklyFit?: ModelsFit
}

/** calibrateOmega on closed windows of one kind: ω and the windows that measured it. */
export type ModelsSpread = { omega: number; windows: number; isAssumed: boolean }

export type ModelsOmega = { title: string; M0: ModelsSpread; selected: ModelsSpread }

/** New windows scored before each refit: d is the window's log score under the stored
    weights less under M0; n records, their sum and its SE. */
export type ModelsProspective = { title: string; n: number; sum: number; se: number }

/** The meter-weight study, as seen from this machine: summaries only. */
export type ModelsReport = {
  type: 'models'
  /** At least `needed` qualifying 5-hour windows; otherwise no fit, and M0 holds. */
  isFitted: boolean
  qualifying: number
  needed: number
  /** 5-hour windows of the current regime used, and those left out by reason. */
  windows: { used: number; excluded: { reason: string; count: number }[] }
  segments: number
  excludedSegments: number
  /** M0, M1 and M2, those that could be fitted. */
  fits: ModelsFit[]
  /** M1 against M0, then M2 against the model selected so far. */
  comparisons: ModelsComparison[]
  selected: MeterModel
  rounding: 'round' | 'truncate' | 'union'
  transfer: ModelsTransfer
  /** Per window kind. */
  omegas: ModelsOmega[]
  /** Per window kind. */
  prospective: ModelsProspective[]
}

/** A guide: its title, and its Markdown in sections that each fit one Markdown element. */
export type GuideReport = {
  type: 'guide'
  title: string
  sections: string[]
}

/** No reading stored yet: what the first run explains, and the command to run again. */
export type WaitingReport = {
  type: 'waiting'
  command: string
  /** The card offers to send the check message: no check is in flight in this session. */
  canSend: boolean
  /** Signed in without a subscription: no reading will ever arrive. */
  isUnsubscribed?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'usage-dollars': {
      reports: Record<string, UsageReport | SpendReport | CheckReport | CalibrationReport | ModelsReport | GuideReport | WaitingReport>
    }
  }
}

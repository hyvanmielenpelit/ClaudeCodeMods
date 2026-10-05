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

/** A guide: its title, and its Markdown in sections that each fit one Markdown element. */
export type GuideReport = {
  type: 'guide'
  title: string
  sections: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'usage-dollars': { reports: Record<string, UsageReport | SpendReport | CheckReport | CalibrationReport | GuideReport> }
  }
}

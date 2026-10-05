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
  basis: string
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

declare module 'claude-code' {
  interface PluginState {
    'usage-dollars': { reports: Record<string, UsageReport | SpendReport> }
  }
}

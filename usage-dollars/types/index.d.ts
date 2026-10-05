export type ModelSpend = { model: string; usd: number; requests: number }

export type RangeReport = { value: number; low: number; high: number }

export type WindowReport = {
  title: string
  usedUsd: number
  requests: number
  resetLong: string
  resetIn: string
  left?: RangeReport
  allowance?: RangeReport
  basis: string
}

export type UsageReport = {
  windows: WindowReport[]
  byModel: ModelSpend[]
  byModelTitle: string
  notes: string[]
  files: number
  ms: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-dollars': { reports: Record<string, UsageReport> }
  }
}

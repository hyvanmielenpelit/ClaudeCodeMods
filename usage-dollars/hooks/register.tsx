import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { ModelSpend, RangeReport, UsageReport, WindowReport } from '../types'
import { estimate, observed, record, resolutionOf } from './estimate'
import type { Estimate, WindowReadings } from './estimate'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const MIN_GAP_MS = 60 * 1000
const READINGS_KEPT_MS = 28 * DAY_MS
const HISTORY_DAYS = 14
const HISTORY_REFRESH_MS = 6 * HOUR_MS
const KEPT_REPORTS = 20
const MARK = /usage-dollars:report:(\d+)/

const LIMITS_KEY = 'limits'
const READINGS_KEY = 'readings'
const HISTORY_KEY = 'history'

const reports = atom({ plugin: 'usage-dollars', key: 'reports' } as const, {})

type Kind = 'five_hour' | 'seven_day'

const WINDOWS: readonly { kind: Kind; name: string; title: string; short: string; spanMs: number }[] = [
  { kind: 'five_hour', name: 'session', title: '5-hour window', short: '5h', spanMs: 5 * HOUR_MS },
  { kind: 'seven_day', name: 'week', title: 'This week', short: 'Week', spanMs: 7 * DAY_MS },
]

type Limit = { percentUsed?: number; resetsAt: string; isLive: boolean }

type WindowTally = {
  usd: number
  requests: number
  byModel: Record<string, { usd: number; requests: number }>
  otherSubscriptionsUsd: number
  unattributedUsd: number
  unpricedRequests: number
  unpricedModels: string[]
  resetLabel?: string
  resetLong?: string
  resetIn?: string
}

type HelperOutput = { windows?: Record<string, WindowTally>; files: number; ms: number; error?: string }

type History = { scannedAt: number; observations: { kind: string; resetsAt: string; usd: number }[] }

type WindowState = { title: string; short: string; resetsAt: string; tally: WindowTally; estimate?: Estimate }

type Summary = { windows: WindowState[]; files: number; ms: number }

let last: Summary | undefined
let lastRunAt = 0
let running: Promise<Summary | undefined> | undefined

const money = (usd: number) =>
  usd >= 100 ? `$${Math.round(usd).toLocaleString('en-US')}` : `$${usd.toFixed(2)}`

const short = (usd: number) =>
  usd >= 1000 ? `$${(usd / 1000).toFixed(1)}k` : usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`

const span = (r: RangeReport) => `${money(r.low)} – ${money(r.high)}`

/* claude-opus-5-5 reads as "Opus 5.5"; a date suffix or [1m] tag is dropped. */
function modelName(id: string) {
  const parts = id
    .replace(/^claude-/, '')
    .replace(/\[.*\]$/, '')
    .split('-')
    .filter(part => !/^\d{8}$/.test(part))
  const words = parts.filter(part => !/^\d+$/.test(part)).map(w => w[0].toUpperCase() + w.slice(1))
  const version = parts.filter(part => /^\d+$/.test(part)).join('.')
  return [...words, version].filter(Boolean).join(' ')
}

const windowKey = (kind: string, resetsAt: string) =>
  `${kind}@${new Date(Math.round(Date.parse(resetsAt) / 60000) * 60000).toISOString()}`

/* The limit as the API reported it now, else as last stored: a 7-day window rolls forward
   a week at a time, a 5-hour one only holds until its reset. */
async function limitOf($: EngineInterface, kind: Kind, limits: readonly SessionRateLimit[], now: number) {
  const stored = ((await $.store.get(LIMITS_KEY)) ?? {}) as Record<string, { percentUsed: number; resetsAt: string }>
  const live = limits.find(l => l.kind === kind)
  if (live?.resetsAt) {
    await $.store.set(LIMITS_KEY, { ...stored, [kind]: { percentUsed: live.percentUsed, resetsAt: live.resetsAt } })
    return { percentUsed: live.percentUsed, resetsAt: live.resetsAt, isLive: true } as Limit
  }
  const kept = stored[kind]
  if (!kept) return undefined
  let reset = Date.parse(kept.resetsAt)
  if (reset > now) return { percentUsed: kept.percentUsed, resetsAt: kept.resetsAt, isLive: false } as Limit
  if (kind !== 'seven_day') return undefined
  while (reset <= now) reset += 7 * DAY_MS
  return { resetsAt: new Date(reset).toISOString(), isLive: false } as Limit
}

async function measure($: EngineInterface, given?: readonly SessionRateLimit[]) {
  const now = await $.clock.now()
  const limits = given ?? (await $.session.usage()).rateLimits
  const active: { w: (typeof WINDOWS)[number]; limit: Limit }[] = []
  for (const w of WINDOWS) {
    const limit = await limitOf($, w.kind, limits, now)
    if (limit) active.push({ w, limit })
  }
  if (active.length === 0) {
    $.ui.status('Usage: $ after the first reply')
    return undefined
  }

  const argv = ['node', `${$.plugin.root}/scripts/usage-cost.mjs`, '--session', await $.session.id()]
  for (const { w, limit } of active) {
    const since = new Date(Date.parse(limit.resetsAt) - w.spanMs).toISOString()
    argv.push('--window', `${w.name},${since},${limit.resetsAt}`)
  }
  const run = await $.process.run(argv, { timeoutMs: 120_000 })
  const out = JSON.parse(run.stdout || '{}') as HelperOutput
  if (run.exitCode !== 0 || out.error || !out.windows) {
    $.ui.status('Usage: $ unavailable')
    $.ui.log(`usage-dollars: ${out.error ?? run.stderr.slice(0, 200)}`, { to: 'debug' })
    return undefined
  }

  const all = ((await $.store.get(READINGS_KEY)) ?? {}) as Record<string, WindowReadings>
  for (const { w, limit } of active) {
    const tally = out.windows[w.name]
    if (!tally || !limit.isLive || limit.percentUsed === undefined) continue
    const key = windowKey(w.kind, limit.resetsAt)
    all[key] = record(all[key] ?? { kind: w.kind, resetsAt: limit.resetsAt, byPct: {} }, limit.percentUsed, tally.usd)
  }
  const kept = Object.fromEntries(
    Object.entries(all).filter(([, r]) => Date.parse(r.resetsAt) > now - READINGS_KEPT_MS),
  )
  await $.store.set(READINGS_KEY, kept)

  const resolution = resolutionOf(Object.values(kept))
  const history = ((await $.store.get(HISTORY_KEY)) ?? { scannedAt: 0, observations: [] }) as History
  const windows: WindowState[] = []
  for (const { w, limit } of active) {
    const tally = out.windows[w.name]
    if (!tally) continue
    const past = [
      ...Object.values(kept)
        .filter(r => r.kind === w.kind && Date.parse(r.resetsAt) <= now)
        .map(r => observed(r, resolution)),
      ...history.observations
        .filter(o => o.kind === w.kind && Date.parse(o.resetsAt) > now - HISTORY_DAYS * DAY_MS)
        .map(o => o.usd),
    ].filter((x): x is number => x !== undefined)
    const readings = kept[windowKey(w.kind, limit.resetsAt)]
    windows.push({
      title: w.title,
      short: w.short,
      resetsAt: limit.resetsAt,
      tally,
      estimate: readings ? estimate(readings, tally.usd, resolution, past) : undefined,
    })
  }

  $.ui.status(
    windows
      .map(s => {
        const left = s.estimate ? ` · ~${short(Math.max(0, s.estimate.left.value))} left` : ''
        return `${s.short}: ${short(s.tally.usd)} used${left}`
      })
      .join('  │  '),
  )
  return { windows, files: out.files, ms: out.ms } as Summary
}

/* One scan at a time, at most once a minute unless forced. */
function refresh($: EngineInterface, limits?: readonly SessionRateLimit[], isForced = false) {
  if (running) return running
  if (!isForced && Date.now() - lastRunAt < MIN_GAP_MS) return Promise.resolve(last)
  lastRunAt = Date.now()
  running = measure($, limits)
    .then(summary => (last = summary ?? last))
    .catch(error => {
      $.ui.log(`usage-dollars: ${String(error)}`, { to: 'debug' })
      return last
    })
    .finally(() => (running = undefined))
  return running
}

/* Past rate-limit rejections, each a window seen exactly full; rescanned every six hours. */
async function refreshHistory($: EngineInterface) {
  const kept = (await $.store.get(HISTORY_KEY)) as History | undefined
  const now = await $.clock.now()
  if (kept && now - kept.scannedAt < HISTORY_REFRESH_MS) return
  const run = await $.process.run(
    ['node', `${$.plugin.root}/scripts/usage-cost.mjs`, '--session', await $.session.id(), '--history', String(HISTORY_DAYS)],
    { timeoutMs: 180_000 },
  )
  const out = JSON.parse(run.stdout || '{}') as { observations?: History['observations']; error?: string }
  if (run.exitCode !== 0 || !out.observations) {
    $.ui.log(`usage-dollars: history: ${out.error ?? run.stderr.slice(0, 200)}`, { to: 'debug' })
    return
  }
  await $.store.set(HISTORY_KEY, { scannedAt: now, observations: out.observations })
  void refresh($, undefined, true)
}

function basisOf(e?: Estimate) {
  if (!e) return 'No estimate yet: the limit has not reported a reading for this window.'
  const readings = `${e.readings} percent level${e.readings === 1 ? '' : 's'} read this window`
  const mix = e.isMixErrorAssumed ? 'price-mix error assumed at 10%' : `price-mix error from ${e.pastWindows} past windows`
  return `${readings} · ${mix}`
}

function toReport(summary: Summary): UsageReport {
  const windows: WindowReport[] = summary.windows.map(s => ({
    title: s.title,
    usedUsd: s.tally.usd,
    requests: s.tally.requests,
    resetLong: s.tally.resetLong ?? s.resetsAt,
    resetIn: s.tally.resetIn ?? '',
    left: s.estimate
      ? { value: Math.max(0, s.estimate.left.value), low: Math.max(0, s.estimate.left.low), high: Math.max(0, s.estimate.left.high) }
      : undefined,
    allowance: s.estimate?.allowance,
    basis: basisOf(s.estimate),
  }))
  const widest = summary.windows[summary.windows.length - 1]
  const byModel: ModelSpend[] = Object.entries(widest?.tally.byModel ?? {})
    .map(([model, spend]) => ({ model, ...spend }))
    .sort((a, b) => b.usd - a.usd)
  const notes: string[] = []
  const t = widest?.tally
  if (t && t.otherSubscriptionsUsd > 0)
    notes.push(`Other subscriptions spent ${money(t.otherSubscriptionsUsd)} in this period; not counted here.`)
  if (t && t.unattributedUsd > 0)
    notes.push(`${money(t.unattributedUsd)} came from sessions with no subscription record; not counted here.`)
  if (t && t.unpricedRequests > 0)
    notes.push(`${t.unpricedRequests} requests to unpriced models (${t.unpricedModels.join(', ')}); not counted here.`)
  return {
    windows,
    byModel,
    byModelTitle: `By model · ${(widest?.title ?? '').toLowerCase()}`,
    notes,
    files: summary.files,
    ms: summary.ms,
  }
}

const FOOTNOTE =
  "Priced at API list rates from this machine's transcripts. Ranges are 90% intervals: they combine " +
  "the limit's whole-percent rounding with how far API prices may differ from the limit's own weighting."

/* The row the model reads, and what the transcript shows where the card cannot be drawn. */
function markdown(r: UsageReport, id: string) {
  const lines = ['### Usage · API-equivalent dollars', '']
  for (const w of r.windows) {
    lines.push(
      `**${w.title}** · resets ${w.resetLong}${w.resetIn ? ` (in ${w.resetIn})` : ''}`,
      '',
      '| | Estimate | 90% range |',
      '|:--|--:|--:|',
      `| Used | ${money(w.usedUsd)} | |`,
      `| Left | ${w.left ? `~${money(w.left.value)}` : '—'} | ${w.left ? span(w.left) : ''} |`,
      `| Allowance | ${w.allowance ? `~${money(w.allowance.value)}` : '—'} | ${w.allowance ? span(w.allowance) : ''} |`,
      '',
      `_${w.basis}_`,
      '',
    )
  }
  lines.push(
    `**${r.byModelTitle}**`,
    '',
    '| Model | Requests | Cost |',
    '|:--|--:|--:|',
    ...r.byModel.map(m => `| ${modelName(m.model)} | ${m.requests.toLocaleString('en-US')} | ${money(m.usd)} |`),
    '',
    ...r.notes.map(line => `- ${line}`),
    `_${FOOTNOTE}_`,
    '',
    `[//]: # (usage-dollars:report:${id})`,
  )
  return lines.join('\n')
}

/* Used dollars in solid blue, the 90% range of the allowance as a pale band, and the
   allowance estimate as a tick, all on one scale ending at the range's top. */
function meterSvg(w: WindowReport) {
  const width = 600
  const height = 12
  const top = w.allowance?.high ?? w.usedUsd
  const x = (usd: number) => Math.round((width * Math.min(usd, top)) / Math.max(top, 0.01))
  const used = w.usedUsd > 0 ? Math.max(4, x(w.usedUsd)) : 0
  const band = w.allowance ? `<rect x="${x(w.allowance.low)}" width="${x(w.allowance.high) - x(w.allowance.low)}" height="${height}" fill="#3b82f6" fill-opacity="0.2"/>` : ''
  const tick = w.allowance ? `<rect x="${Math.min(width - 2, x(w.allowance.value))}" width="2" height="${height}" fill="#3b82f6" fill-opacity="0.7"/>` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" rx="3" fill="#8a8a8a" fill-opacity="0.18"/>` +
    band +
    `<rect width="${used}" height="${height}" rx="3" fill="#3b82f6"/>` +
    tick +
    `</svg>`
  )
}

function meterCells(w: WindowReport, cells: number) {
  const top = w.allowance?.high ?? w.usedUsd
  const at = (usd: number) => Math.round((cells * Math.min(usd, top)) / Math.max(top, 0.01))
  const used = w.usedUsd > 0 ? Math.max(1, at(w.usedUsd)) : 0
  const low = w.allowance ? Math.max(used, at(w.allowance.low)) : used
  return { used, band: Math.max(0, cells - low), free: Math.max(0, low - used) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-dollars',
      description: 'Subscription usage in API-equivalent dollars: 5-hour window and this week',
    })
    void refresh($, undefined, true)
    void refreshHistory($).catch(error => $.ui.log(`usage-dollars: history: ${String(error)}`, { to: 'debug' }))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    void refresh($, e.rateLimits, e.changed.includes('rateLimits'))
    return next(e)
  })

  on('command.run', { command: 'usage-dollars' }, async $ => {
    const summary = await refresh($, undefined, true)
    if (!summary) return { text: 'No usage figures yet: they appear after the first reply in this session.' }
    const report = toReport(summary)
    const id = String(Date.now())
    await update($, reports, all => {
      const kept = Object.entries(all ?? {}).slice(-(KEPT_REPORTS - 1))
      return { ...Object.fromEntries(kept), [id]: report }
    })
    return { text: markdown(report, id) }
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'usage-dollars' } }, async ($, e, next) => {
    const id = MARK.exec(e.props.text)?.[1]
    const r = id ? (await read($, reports))?.[id] : undefined
    if (!r || !Array.isArray(r.windows)) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const cells = Math.max(10, Math.min(48, (e.viewport?.columns ?? 60) - 12))

    const section = (w: WindowReport) => {
      const tiles = [
        { label: 'USED', value: money(w.usedUsd), note: `${w.requests.toLocaleString('en-US')} requests` },
        { label: 'LEFT', value: w.left ? `~${money(w.left.value)}` : '—', note: w.left ? span(w.left) : 'no estimate yet' },
        { label: 'ALLOWANCE', value: w.allowance ? `~${money(w.allowance.value)}` : '—', note: w.allowance ? span(w.allowance) : 'no estimate yet' },
      ]
      const bar = meterCells(w, cells)
      return (
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={2}>
            <Text bold>{w.title}</Text>
            <Text dimColor>
              Resets {w.resetLong}
              {w.resetIn ? ` · in ${w.resetIn}` : ''}
            </Text>
          </Box>
          <Box flexDirection="row" flexWrap="wrap" columnGap={4} rowGap={1}>
            {tiles.map(tile => (
              <Box flexDirection="column" flexGrow={1} minWidth={16}>
                <Text dimColor>{tile.label}</Text>
                <Text bold>{tile.value}</Text>
                <Text dimColor>{tile.note}</Text>
              </Box>
            ))}
          </Box>
          {'Svg' in ui ? (
            <ui.Svg source={meterSvg(w)} alt={`Used ${money(w.usedUsd)} of the allowance`} />
          ) : (
            <Text>
              <Text color="blue">{'█'.repeat(bar.used)}</Text>
              <Text dimColor>{'░'.repeat(bar.free)}</Text>
              <Text color="blue" dimColor>
                {'▒'.repeat(bar.band)}
              </Text>
            </Text>
          )}
          <Text dimColor>{w.basis}</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={2} paddingY={1} rowGap={2}>
        <Box flexDirection="row" columnGap={1}>
          <Text bold>Usage</Text>
          <Text dimColor>· API-equivalent dollars</Text>
        </Box>

        {r.windows.map(section)}

        <Box flexDirection="column">
          <Text bold>{r.byModelTitle}</Text>
          <Box flexDirection="row">
            <Box flexGrow={1}>
              <Text dimColor>MODEL</Text>
            </Box>
            <Box width={12} justifyContent="flex-end">
              <Text dimColor>REQUESTS</Text>
            </Box>
            <Box width={12} justifyContent="flex-end">
              <Text dimColor>COST</Text>
            </Box>
          </Box>
          {r.byModel.map(m => (
            <Box flexDirection="row">
              <Box flexGrow={1}>
                <Text>{modelName(m.model)}</Text>
              </Box>
              <Box width={12} justifyContent="flex-end">
                <Text>{m.requests.toLocaleString('en-US')}</Text>
              </Box>
              <Box width={12} justifyContent="flex-end">
                <Text bold>{money(m.usd)}</Text>
              </Box>
            </Box>
          ))}
        </Box>

        {r.notes.length > 0 && (
          <Box flexDirection="column">
            {r.notes.map(line => (
              <Text>{line}</Text>
            ))}
          </Box>
        )}
        <Text dimColor italic>
          {FOOTNOTE}
        </Text>
      </Box>
    )
  })
}

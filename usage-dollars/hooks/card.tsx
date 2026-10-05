/* Drawing: the allowance-first window card, the spending report card, their Markdown
   fallbacks, and the status line. Every date shown arrives already labeled by the helper. */

import type { Elements, RenderSurface } from 'claude-code'

import type { PlanReport, RangeReport, SpendReport, UsageReport, WindowReport } from '../types'

type Ui = Elements[RenderSurface]

export const money = (usd: number) =>
  usd >= 100 ? `$${Math.round(usd).toLocaleString('en-US')}` : `$${usd.toFixed(2)}`

/** $4.20, $913, $2.8k, $28k: the status line's figures. */
export function compact(usd: number) {
  if (usd < 10) return `$${usd.toFixed(2)}`
  if (Math.round(usd) < 1000) return `$${Math.round(usd)}`
  const k = usd / 1000
  return Math.round(k * 10) < 100 ? `$${k.toFixed(1)}k` : `$${Math.round(k)}k`
}

const span = (r: RangeReport) => `${money(r.low)} – ${money(r.high)}`

const count = (n: number) => n.toLocaleString('en-US')

/* claude-opus-5-5 reads as "Opus 5.5"; a date suffix or [1m] tag is dropped. */
export function modelName(id: string) {
  const parts = id
    .replace(/^claude-/, '')
    .replace(/\[.*\]$/, '')
    .split('-')
    .filter(part => !/^\d{8}$/.test(part))
  const words = parts.filter(part => !/^\d+$/.test(part)).map(w => w.charAt(0).toUpperCase() + w.slice(1))
  const version = parts.filter(part => /^\d+$/.test(part)).join('.')
  return [...words, version].filter(Boolean).join(' ')
}

const FOOTNOTE =
  "Priced at API list rates from this machine's transcripts. Ranges are 90% intervals: they combine " +
  "the limit's whole-percent rounding with how far API prices may differ from the limit's own weighting."

const FOOTER =
  '/usage-dollars 24h · 7d · YYYY-MM-DD..YYYY-MM-DD for a spending report · /usage-dollars reset after a plan change'

const NO_ESTIMATE = 'first estimate when the limit next reports a higher percent'

export type StatusWindow = { short: string; usedUsd: number; allowance?: RangeReport; left?: RangeReport }

/* "5h ~$850 left of $913 · Week ~$2.7k left of $2.8k": one tilde per window, since both
   figures come from one estimate. */
export function statusLine(windows: readonly StatusWindow[], isPlanUnseen: boolean) {
  const text = windows
    .map(w =>
      !w.allowance || !w.left
        ? `${w.short} ${compact(w.usedUsd)} used, estimating`
        : w.left.value <= 0
          ? `${w.short} at limit`
          : `${w.short} ~${compact(w.left.value)} left of ${compact(w.allowance.value)}`,
    )
    .join(' · ')
  return `${isPlanUnseen ? '⚠ Plan changed · ' : ''}${text}`
}

export function planLine(p: PlanReport) {
  if (p.isUnknown) {
    const last = p.lastKnown ? `; last seen as ${p.lastKnown}` : ''
    return p.unknownReason === 'other-subscription'
      ? `Plan: unknown for this subscription — Claude Code is signed in to another${last}`
      : `Plan: unknown — no account profile found${last}`
  }
  const asOf = p.asOfLabel ? ` · profile as of ${p.asOfLabel}` : ''
  return `Plan: ${p.label ?? 'unknown'}${asOf}${p.isStale ? ' (may be out of date)' : ''}`
}

const headlineLabel = (w: WindowReport) => (w.short === '5h' ? '5-HOUR ALLOWANCE' : 'WEEKLY ALLOWANCE')

const ageOf = (minutes: number) =>
  minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`

const percentLine = (w: WindowReport) =>
  w.percent === undefined
    ? undefined
    : `Limit reports ${w.percent}%${w.percentAgeMinutes !== undefined ? ` · read ${ageOf(w.percentAgeMinutes)}` : ''}`

const nextTickLine = (w: WindowReport) =>
  w.nextTick ? `Next tick in about ${money(w.nextTick.value)} (between ${money(w.nextTick.low)} and ${money(w.nextTick.high)})` : undefined

/* The row the model reads, and what the transcript shows where the card cannot be drawn. */
export function markdownWindows(r: UsageReport, id: string) {
  const lines = ['### Usage · API-equivalent dollars', '', planLine(r.plan), '']
  if (r.notices.length > 0) lines.push(...r.notices.map(n => `- ${n}`), '')
  lines.push(
    '| Window | Allowance | 90% range | Confidence |',
    '|:--|--:|--:|:--|',
    ...r.windows.map(w =>
      w.allowance
        ? `| ${w.title} | ~${money(w.allowance.value)} | ${span(w.allowance)} | ${w.confidence ?? ''} |`
        : `| ${w.title} | estimating… | | |`,
    ),
    '',
  )
  for (const w of r.windows) {
    const reported = percentLine(w)
    const tick = nextTickLine(w)
    lines.push(
      `**${w.title}** · resets ${w.resetLong}${w.resetIn ? ` (in ${w.resetIn})` : ''}`,
      '',
      '| | Estimate | 90% range |',
      '|:--|--:|--:|',
      `| Used | ${money(w.usedUsd)} | ${count(w.requests)} requests |`,
      `| Left | ${w.left ? `~${money(w.left.value)}` : '—'} | ${w.left ? span(w.left) : ''} |`,
      '',
      ...(reported ? [reported, ''] : []),
      ...(tick ? [tick, ''] : []),
      `_${w.basis}_`,
      '',
    )
  }
  if (r.last24hUsd !== undefined) lines.push(`Last 24 hours: ${money(r.last24hUsd)}`, '')
  lines.push(
    `**${r.byModelTitle}**`,
    '',
    '| Model | Requests | Cost |',
    '|:--|--:|--:|',
    ...r.byModel.map(m => `| ${modelName(m.model)} | ${count(m.requests)} | ${money(m.usd)} |`),
    '',
    ...r.notes.map(line => `- ${line}`),
    `_${FOOTNOTE}_`,
    '',
    `_${FOOTER}_`,
    '',
    `[//]: # (usage-dollars:report:${id})`,
  )
  return lines.join('\n')
}

export function markdownSpend(r: SpendReport, id: string) {
  return [
    `### Spending · ${r.fromLabel} – ${r.toLabel}`,
    '',
    `**${money(r.usedUsd)}** in ${count(r.requests)} requests, API-equivalent dollars`,
    '',
    '| Day | Requests | Cost |',
    '|:--|--:|--:|',
    ...r.byDay.map(d => `| ${d.label} | ${count(d.requests)} | ${money(d.usd)} |`),
    '',
    '| Model | Requests | Cost |',
    '|:--|--:|--:|',
    ...r.byModel.map(m => `| ${modelName(m.model)} | ${count(m.requests)} | ${money(m.usd)} |`),
    '',
    ...r.notes.map(line => `- ${line}`),
    '',
    `[//]: # (usage-dollars:report:${id})`,
  ].join('\n')
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

/* One day's spending as a bar on the scale of the busiest day. */
function daySvg(usd: number, top: number) {
  const width = 240
  const height = 10
  const used = usd > 0 ? Math.max(2, Math.round((width * usd) / Math.max(top, 0.01))) : 0
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" rx="2" fill="#8a8a8a" fill-opacity="0.18"/>` +
    `<rect width="${used}" height="${height}" rx="2" fill="#3b82f6"/>` +
    `</svg>`
  )
}

function modelTable(ui: Ui, title: string, rows: UsageReport['byModel']) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
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
      {rows.map(m => (
        <Box flexDirection="row">
          <Box flexGrow={1}>
            <Text>{modelName(m.model)}</Text>
          </Box>
          <Box width={12} justifyContent="flex-end">
            <Text>{count(m.requests)}</Text>
          </Box>
          <Box width={12} justifyContent="flex-end">
            <Text bold>{money(m.usd)}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

function notesBlock(ui: Ui, notes: readonly string[]) {
  const { Box, Text } = ui
  if (notes.length === 0) return undefined
  return (
    <Box flexDirection="column">
      {notes.map(line => (
        <Text>{line}</Text>
      ))}
    </Box>
  )
}

export function windowCard(ui: Ui, r: UsageReport, columns: number) {
  const { Box, Text } = ui
  const cells = Math.max(10, Math.min(48, columns - 12))

  const headline = (w: WindowReport) => (
    <Box flexDirection="column" flexGrow={1} minWidth={22} borderStyle="round" borderDimColor paddingX={1}>
      <Text dimColor>{headlineLabel(w)}</Text>
      <Text bold>{w.allowance ? `~${money(w.allowance.value)}` : 'estimating…'}</Text>
      <Text dimColor>{w.allowance ? span(w.allowance) : NO_ESTIMATE}</Text>
      {w.allowance && w.confidence ? <Text dimColor>{w.confidence}</Text> : undefined}
    </Box>
  )

  const section = (w: WindowReport) => {
    const tiles = [
      { label: 'USED', value: money(w.usedUsd), note: `${count(w.requests)} requests` },
      { label: 'LEFT', value: w.left ? `~${money(w.left.value)}` : '—', note: w.left ? span(w.left) : 'no estimate yet' },
    ]
    const bar = meterCells(w, cells)
    const reported = percentLine(w)
    const tick = nextTickLine(w)
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
        {reported ? <Text>{reported}</Text> : undefined}
        {tick ? <Text>{tick}</Text> : undefined}
        <Text dimColor>{w.basis}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={2} paddingY={1} rowGap={2}>
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Text bold>Usage</Text>
          <Text dimColor>· API-equivalent dollars</Text>
        </Box>
        <Text dimColor>{planLine(r.plan)}</Text>
      </Box>

      {r.notices.length > 0 ? (
        <Box flexDirection="column">
          {r.notices.map(line => (
            <Text color="yellow">{line}</Text>
          ))}
        </Box>
      ) : undefined}

      <Box flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={1}>
        {r.windows.map(headline)}
      </Box>

      {r.windows.map(section)}

      {r.last24hUsd !== undefined ? <Text>Last 24 hours: {money(r.last24hUsd)}</Text> : undefined}

      {modelTable(ui, r.byModelTitle, r.byModel)}

      {notesBlock(ui, r.notes)}
      <Text dimColor italic>
        {FOOTNOTE}
      </Text>
      <Text dimColor>{FOOTER}</Text>
    </Box>
  )
}

export function spendCard(ui: Ui, r: SpendReport, columns: number) {
  const { Box, Text } = ui
  const cells = Math.max(10, Math.min(40, columns - 34))
  const top = Math.max(0, ...r.byDay.map(d => d.usd))
  const cellsOf = (usd: number) => (usd > 0 ? Math.max(1, Math.round((cells * usd) / Math.max(top, 0.01))) : 0)

  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={2} paddingY={1} rowGap={2}>
      <Box flexDirection="row" columnGap={1} flexWrap="wrap">
        <Text bold>Spending</Text>
        <Text dimColor>
          · {r.fromLabel} – {r.toLabel}
        </Text>
      </Box>

      <Box flexDirection="row" flexWrap="wrap" columnGap={4} rowGap={1}>
        <Box flexDirection="column" minWidth={16}>
          <Text dimColor>TOTAL</Text>
          <Text bold>{money(r.usedUsd)}</Text>
          <Text dimColor>API-equivalent dollars</Text>
        </Box>
        <Box flexDirection="column" minWidth={16}>
          <Text dimColor>REQUESTS</Text>
          <Text bold>{count(r.requests)}</Text>
        </Box>
      </Box>

      <Box flexDirection="column">
        <Text bold>By day</Text>
        {r.byDay.map(d => (
          <Box flexDirection="row" columnGap={2}>
            <Box width={12}>
              <Text>{d.label}</Text>
            </Box>
            <Box flexGrow={1}>
              {'Svg' in ui ? (
                <ui.Svg source={daySvg(d.usd, top)} alt={`${d.label}: ${money(d.usd)}`} />
              ) : (
                <Text color="blue">{'█'.repeat(cellsOf(d.usd)) || ' '}</Text>
              )}
            </Box>
            <Box width={12} justifyContent="flex-end">
              <Text bold={d.usd > 0} dimColor={d.usd === 0}>
                {money(d.usd)}
              </Text>
            </Box>
          </Box>
        ))}
      </Box>

      {modelTable(ui, 'By model', r.byModel)}

      {notesBlock(ui, r.notes)}
    </Box>
  )
}

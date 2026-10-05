/* Drawing: the allowance-first window card, the spending report card, the setup check,
   calibration, guide and first-reading cards, their Markdown fallbacks, and the status
   line. Every date shown arrives already labeled by the helper. */

import type { Elements, RenderSurface } from 'claude-code'

import type {
  CalibrationReport,
  CalibrationWindow,
  CheckItem,
  CheckReport,
  GuideReport,
  PlanReport,
  RangeReport,
  SpendReport,
  UsageReport,
  WaitingReport,
  WindowReport,
} from '../types'
import { CHECK_LABEL } from './probe'

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
  "Priced at API list rates from this machine's transcripts. Ranges are 90% intervals from a model of " +
  'how far dollars per percent vary within and between windows; see the README.'

const FOOTER =
  '/usage-dollars 24h · 7d · YYYY-MM-DD..YYYY-MM-DD for a spending report · /usage-dollars reset after a plan change · ' +
  '/usage-dollars help · check · calibrate'

const NO_ESTIMATE = 'first estimate after the next reply'

const confidenceLabel = (w: WindowReport) => (w.confidence ? `${w.confidence}${w.isCalibrated ? ' · calibrated' : ''}` : '')

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
        ? `| ${w.title} | ~${money(w.allowance.value)} | ${span(w.allowance)} | ${confidenceLabel(w)} |`
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
      {w.allowance && w.confidence ? <Text dimColor>{confidenceLabel(w)}</Text> : undefined}
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

const MARK_OF: Record<CheckItem['state'], string> = { ok: '✓', fail: '✗', info: 'ℹ' }

const COLOR_OF: Record<CheckItem['state'], string | undefined> = { ok: 'green', fail: 'red', info: undefined }

export function markdownCheck(r: CheckReport, id: string) {
  return [
    '### Setup check · usage-dollars',
    '',
    ...r.items.map(item => `- ${MARK_OF[item.state]} **${item.label}** · ${item.text}`),
    '',
    `[//]: # (usage-dollars:report:${id})`,
  ].join('\n')
}

export function checkCard(ui: Ui, r: CheckReport) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={2} paddingY={1} rowGap={1}>
      <Box flexDirection="row" columnGap={1}>
        <Text bold>Setup check</Text>
        <Text dimColor>· usage-dollars</Text>
      </Box>
      {r.items.map(item => (
        <Box flexDirection="row" columnGap={1}>
          <Box width={2}>
            <Text color={COLOR_OF[item.state]} dimColor={item.state === 'info'}>
              {MARK_OF[item.state]}
            </Text>
          </Box>
          <Box width={12}>
            <Text bold>{item.label}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text>{item.text}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/* Facts about the data behind one window's estimate, never what to do about them. */
function calibrationLines(w: CalibrationWindow) {
  const lines = [`This window: ${plural(w.levels, 'percent level')} read, ${plural(w.ticks, 'tick')} seen`]
  if (w.closedWindows === 0) lines.push('No closed window with readings yet')
  lines.push(
    w.isWithinMeasured
      ? `Within-window spread: measured, from ${plural(w.closedForWithin, 'closed window')}`
      : `Within-window spread: assumed; ${plural(w.closedForWithin, 'closed window')} with a tick, 2 needed`,
    `Between-window spread: ${w.isBetweenMeasured ? 'measured' : 'assumed'}; ` +
      `${plural(w.pastPoints, 'past window')} (rejections included), history weight ${w.pastWeight}`,
    w.isRoundingKnown
      ? `Rounding rule: known (the API ${w.rounding === 'round' ? 'rounds' : 'truncates'}), from ${plural(w.closedForRounding, 'closed window')}`
      : `Rounding rule: not known; ${w.closedForRounding} of ${w.roundingNeeded} closed windows needed`,
  )
  if (w.halfWidth !== undefined) lines.push(`90% range now: ±${Math.round(w.halfWidth * 100)}%`)
  return lines
}

const calibrationStatus = (w: CalibrationWindow) => (w.isCalibrated ? 'Calibrated' : `Calibrating: ${w.measured} of 3 measured`)

export function markdownCalibration(r: CalibrationReport, id: string) {
  const lines = ['### Calibration · usage-dollars', '']
  for (const w of r.windows)
    lines.push(`**${w.title}** · ${calibrationStatus(w)}`, '', ...calibrationLines(w).map(line => `- ${line}`), '')
  lines.push(`[//]: # (usage-dollars:report:${id})`)
  return lines.join('\n')
}

export function calibrationCard(ui: Ui, r: CalibrationReport) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={2} paddingY={1} rowGap={2}>
      <Box flexDirection="row" columnGap={1}>
        <Text bold>Calibration</Text>
        <Text dimColor>· usage-dollars</Text>
      </Box>
      {r.windows.map(w => (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={2}>
            <Text bold>{w.title}</Text>
            <Text color={w.isCalibrated ? 'green' : undefined} dimColor={!w.isCalibrated}>
              {calibrationStatus(w)}
            </Text>
          </Box>
          {calibrationLines(w).map(line => (
            <Text>{line}</Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}

/* The first run on an installation, before any reply has brought a reading. */
const WAITING_TITLE = 'Waiting for the first usage reading'

const WAITING_ALL_RIGHT =
  'Everything is in order. The plugin is installed and running; it has simply not received a usage reading yet. ' +
  'This is expected right after the plugin is installed or updated, and on its first use on this machine.'

const WAITING_WHY =
  'Claude Code learns how much of the 5-hour window and the week has been used only from the API, and the API ' +
  'reports it alongside each model reply: the percent used and when each window resets. Every figure on this card ' +
  'is built on that reading, and this installation has not stored one yet.'

const waitingSteps = (command: string) => [
  'Send Claude any message in this session. A short question is enough.',
  `When the reply has finished, run ${command} again.`,
  command.endsWith('calibrate')
    ? 'The card then shows what each window’s estimate rests on.'
    : 'The card then shows each window: the estimated allowance, what is used and what is left.',
]

const WAITING_UNSUBSCRIBED =
  'This sign-in has no subscription usage limits, so there is nothing to show; spending reports still work.'

const WAITING_SEND = 'Or let the plugin send one for you:'

const checkSent = (command: string) => `A check message was sent. When its reply has finished, run ${command} again.`

const WAITING_NEXT = [
  'Every reply refreshes the reading, and the status line keeps showing what is left in each window.',
  'Readings are stored for this installation, so later sessions show figures at once, before their first reply.',
  'The first estimates are rough and narrow as readings accumulate over the coming windows; /usage-dollars calibrate shows how far that has come.',
  'Spending reports read this machine’s transcripts and need no reading: /usage-dollars 24h, 7d or a date range work now.',
]

const WAITING_FOOTER = 'If no figures appear after a reply, /usage-dollars check shows what is missing.'

export function markdownWaiting(r: WaitingReport, id: string) {
  return [
    `### ${WAITING_TITLE}`,
    '',
    `✓ ${WAITING_ALL_RIGHT}`,
    '',
    '**Why there are no figures yet**',
    '',
    WAITING_WHY,
    '',
    ...(r.isUnsubscribed
      ? [WAITING_UNSUBSCRIBED, '']
      : [
          '**What to do**',
          '',
          ...waitingSteps(r.command).map((step, i) => `${i + 1}. ${step}`),
          '',
          ...(r.canSend === false ? [checkSent(r.command), ''] : []),
          '**How it works from here**',
          '',
          ...WAITING_NEXT.map(line => `- ${line}`),
          '',
        ]),
    `_${WAITING_FOOTER}_`,
    '',
    `[//]: # (usage-dollars:report:${id})`,
  ].join('\n')
}

/* onSend sends the check message; without it the card offers no button. */
export function waitingCard(ui: Ui, r: WaitingReport, onSend?: () => void) {
  const { Box, Button, Text } = ui
  const heading = (text: string) => <Text bold>{text}</Text>
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={2} paddingY={1} rowGap={1}>
      <Box flexDirection="row" columnGap={1} flexWrap="wrap">
        <Text bold>{WAITING_TITLE}</Text>
        <Text dimColor>· usage-dollars</Text>
      </Box>

      <Box flexDirection="row" columnGap={1}>
        <Box width={2}>
          <Text color="green">✓</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text>{WAITING_ALL_RIGHT}</Text>
        </Box>
      </Box>

      <Box flexDirection="column">
        {heading('Why there are no figures yet')}
        <Text>{WAITING_WHY}</Text>
      </Box>

      {r.isUnsubscribed ? (
        <Text>{WAITING_UNSUBSCRIBED}</Text>
      ) : (
        <Box flexDirection="column">
          {heading('What to do')}
          {waitingSteps(r.command).map((step, i) => (
            <Box flexDirection="row" columnGap={1}>
              <Box width={3}>
                <Text color="blue" bold>
                  {`${i + 1}.`}
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text>{step}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      )}

      {!r.isUnsubscribed && r.canSend && onSend ? (
        <Box flexDirection="row" columnGap={1} flexWrap="wrap" alignItems="center">
          <Text>{WAITING_SEND}</Text>
          <Button key="send-check" label={CHECK_LABEL} onPress={() => onSend()} />
        </Box>
      ) : undefined}
      {!r.isUnsubscribed && r.canSend === false ? <Text dimColor>{checkSent(r.command)}</Text> : undefined}

      {r.isUnsubscribed ? undefined : (
        <Box flexDirection="column">
          {heading('How it works from here')}
          {WAITING_NEXT.map(line => (
            <Box flexDirection="row" columnGap={1}>
              <Box width={2}>
                <Text dimColor>•</Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text>{line}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      )}

      <Text dimColor>{WAITING_FOOTER}</Text>
    </Box>
  )
}

/* What one Markdown element draws at most. */
const MAX_MARKDOWN = 10000

/** The guide's text in sections that each fit one Markdown element: split before every
    level-2 heading, and a longer section between paragraphs. Carriage returns, which the
    element refuses, are dropped. */
export function guideSections(text: string) {
  const sections: string[] = []
  for (const section of text.replace(/\r/g, '').split(/\n(?=## )/)) {
    let chunk = ''
    for (const paragraph of section.split(/\n{2,}/)) {
      const next = chunk ? `${chunk}\n\n${paragraph}` : paragraph
      if (next.length <= MAX_MARKDOWN) chunk = next
      else {
        if (chunk) sections.push(chunk)
        chunk = paragraph.slice(0, MAX_MARKDOWN)
      }
    }
    if (chunk.trim()) sections.push(chunk.trim())
  }
  return sections
}

/** A guide's title, its leading level-1 heading, and the rest in sections. */
export function guideOf(text: string): GuideReport {
  const [first = '', ...rest] = guideSections(text)
  const heading = /^# (.+)(?:\n+|$)/.exec(first)
  const lead = heading ? first.slice(heading[0].length).trim() : first
  return { type: 'guide', title: heading?.[1]?.trim() ?? 'usage-dollars', sections: lead ? [lead, ...rest] : rest }
}

export function markdownGuide(r: GuideReport, id: string) {
  return [`# ${r.title}`, ...r.sections, `[//]: # (usage-dollars:report:${id})`].join('\n\n')
}

export function guideCard(ui: Ui, r: GuideReport) {
  const { Box, Markdown, Text } = ui
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={3} paddingY={1} rowGap={1}>
      <Text bold>{r.title}</Text>
      {r.sections.map(text => (
        <Markdown text={text} />
      ))}
    </Box>
  )
}

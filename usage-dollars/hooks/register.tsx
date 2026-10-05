import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { CalibrationReport, CheckReport, GuideReport, SpendReport, UsageReport, WaitingReport } from '../types'
import {
  calibrationCard,
  checkCard,
  guideCard,
  guideOf,
  markdownCalibration,
  markdownCheck,
  markdownGuide,
  markdownSpend,
  markdownWaiting,
  markdownWindows,
  spendCard,
  waitingCard,
  windowCard,
} from './card'
import {
  checkReport,
  markNoticesSeen,
  refresh,
  refreshHistory,
  resetEstimates,
  resolveSubscription,
  spendReport,
  statusOf,
  takeToasts,
  toCalibrationReport,
  toReport,
  undoReset,
} from './measure'
import type { Host } from './measure'
import { CHECK_PROMPT, waitingReport } from './probe'

const HOUR_MS = 60 * 60 * 1000
const MAX_REPORT_HOURS = 90 * 24
const KEPT_REPORTS = 20
const MARK = /usage-dollars:report:(\d+)/

const USAGE =
  'Usage: /usage-dollars [help [advanced] | check | calibrate | report | <N>h | <N>d | today | YYYY-MM-DD | YYYY-MM-DD..YYYY-MM-DD | reset | reset undo]' +
  ' · /usage-dollars help explains them.'

/* The files `help` and `help advanced` show, in the plugin folder. */
const GUIDE_FILES = new Map([
  ['help', 'QUICKSTART.md'],
  ['help advanced', 'GUIDE.md'],
])

const reports = atom({ plugin: 'usage-dollars', key: 'reports' } as const, {})

/* From a press of the first-reading card's button until the next turn completes. */
let isCheckInFlight = false

/* $ never crosses an import, so the measure module reaches the engine through these. */
function hostOf($: EngineInterface): Host {
  return {
    root: $.plugin.root,
    now: () => $.clock.now(),
    sessionId: () => $.session.id(),
    rateLimits: async () => (await $.session.usage()).rateLimits,
    run: (argv, options) => $.process.run(argv, options),
    get: key => $.store.get(key),
    set: (key, value) => $.store.set(key, value),
    delete: key => $.store.delete(key),
    status: text => $.ui.status(text),
    log: text => $.ui.log(text, { to: 'debug' }),
  }
}

async function toastNotices($: EngineInterface) {
  for (const text of await takeToasts(hostOf($))) $.ui.toast(text, { timeoutMs: 10000 })
}

function measureThen($: EngineInterface, limits?: readonly SessionRateLimit[], isForced = false, isFresh = false, receivedAt?: number) {
  return refresh(hostOf($), limits, isForced, isFresh, receivedAt).then(async summary => {
    await toastNotices($)
    return summary
  })
}

async function keep($: EngineInterface, report: UsageReport | SpendReport | CheckReport | CalibrationReport | GuideReport | WaitingReport) {
  const id = String(Date.now())
  await update($, reports, all => {
    const kept = Object.entries(all ?? {}).slice(-(KEPT_REPORTS - 1))
    return { ...Object.fromEntries(kept), [id]: report }
  })
  return id
}

/* The first-reading card, while this installation holds no reading to show. */
async function waiting($: EngineInterface, command: string) {
  const report: WaitingReport = waitingReport(command, await resolveSubscription(hostOf($)), isCheckInFlight)
  return { text: markdownWaiting(report, await keep($, report)) }
}

async function setCanSend($: EngineInterface, id: string, canSend: boolean) {
  await update($, reports, all => {
    const r = all?.[id]
    return r?.type === 'waiting' ? { ...all, [id]: { ...r, canSend } } : (all ?? {})
  })
}

/* The check message, sent once per press: the card stops offering it, and no card offers
   it again until a turn completes or the message does not enter. */
async function sendCheck($: EngineInterface, id: string) {
  if (isCheckInFlight) return
  isCheckInFlight = true
  await setCanSend($, id, false)
  const fail = async (reason: string) => {
    isCheckInFlight = false
    $.ui.log(`usage-dollars: check message: ${reason}`, { to: 'debug' })
    await setCanSend($, id, true)
  }
  void $.prompt.submit({ text: CHECK_PROMPT }).then(
    result => (result.drop !== undefined ? fail('dropped') : undefined),
    error => fail(String(error)),
  )
}

/* The helper's range arguments for a report form, or undefined when the form is not one. */
function reportRange(args: string, now: number) {
  const iso = (ms: number) => new Date(ms).toISOString()
  if (args === 'report') return ['--report', `${iso(now - 24 * HOUR_MS)},${iso(now)}`]
  const last = /^(\d+)([hd])$/.exec(args)
  if (last) {
    const hours = Number(last[1]) * (last[2] === 'd' ? 24 : 1)
    if (hours < 1 || hours > MAX_REPORT_HOURS) return undefined
    return ['--report', `${iso(now - hours * HOUR_MS)},${iso(now)}`]
  }
  if (args === 'today') return ['--report-local', 'today,today']
  const day = /^(\d{4}-\d{2}-\d{2})$/.exec(args)
  if (day) return ['--report-local', `${day[1]},${day[1]}`]
  const range = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(args)
  if (range) return ['--report-local', `${range[1]},${range[2]}`]
  return undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-dollars',
      description: 'Subscription usage in API-equivalent dollars: allowance, calibration, spending reports, reset; "help" for the guide',
      argumentHint: '[help [advanced] | check | calibrate | report | 24h | 7d | today | YYYY-MM-DD[..YYYY-MM-DD] | reset [undo]]',
    })
    void measureThen($, undefined, true)
    void refreshHistory(hostOf($)).catch(error => $.ui.log(`usage-dollars: history: ${String(error)}`, { to: 'debug' }))
    return next(e)
  })

  /* Only here does the session hold a percent it has just received: a billed response, or
     a window that moved a whole point. Its readings pair the percent with the dollars up
     to the moment it arrived, not to when the scan runs. */
  on('session.measure', async ($, e, next) => {
    const receivedAt = await $.clock.now()
    const isFresh = e.changed.includes('cost') || e.changed.includes('rateLimits')
    void measureThen($, e.rateLimits, e.changed.includes('rateLimits'), isFresh, receivedAt)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    isCheckInFlight = false
    return next(e)
  })

  on('command.run', { command: 'usage-dollars' }, async ($, e) => {
    const args = e.args.trim().toLowerCase().replace(/\s+/g, ' ')

    if (args === '') {
      const summary = await measureThen($, undefined, true)
      if (!summary) return waiting($, '/usage-dollars')
      await markNoticesSeen(hostOf($))
      $.ui.status(statusOf(summary, false))
      const report = toReport(summary, await $.clock.now())
      return { text: markdownWindows(report, await keep($, report)) }
    }

    if (args === 'reset') {
      await resetEstimates(hostOf($))
      await toastNotices($)
      return {
        text: 'Estimates restarted for this subscription. Ranges widen until new readings arrive. Undo with /usage-dollars reset undo.',
      }
    }
    if (args === 'reset undo') {
      const isUndone = await undoReset(hostOf($))
      return { text: isUndone ? 'Reset undone.' : 'Nothing to undo.' }
    }

    const guideFile = GUIDE_FILES.get(args)
    if (guideFile) {
      let text: string
      try {
        text = await $.fs.read(`${$.plugin.root}/${guideFile}`)
      } catch (error) {
        $.ui.log(`usage-dollars: help: ${String(error)}`, { to: 'debug' })
        return { text: `The guide could not be read: ${guideFile} is missing from the plugin folder.\n\n${USAGE}` }
      }
      const report: GuideReport = guideOf(text)
      return { text: markdownGuide(report, await keep($, report)) }
    }
    if (args === 'check') {
      const report = await checkReport(hostOf($))
      await toastNotices($)
      return { text: markdownCheck(report, await keep($, report)) }
    }
    if (args === 'calibrate') {
      const summary = await measureThen($, undefined, true)
      if (!summary) return waiting($, '/usage-dollars calibrate')
      const report = toCalibrationReport(summary)
      return { text: markdownCalibration(report, await keep($, report)) }
    }

    const range = reportRange(args, await $.clock.now())
    if (!range) return { text: USAGE }
    const report = await spendReport(hostOf($), range)
    if ('error' in report) {
      $.ui.log(`usage-dollars: report: ${report.error}`, { to: 'debug' })
      return { text: USAGE }
    }
    return { text: markdownSpend(report, await keep($, report)) }
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'usage-dollars' } }, async ($, e, next) => {
    const id = MARK.exec(e.props.text)?.[1]
    const r = id ? (await read($, reports))?.[id] : undefined
    const ui = $.ui.resolve(e)
    const columns = e.viewport?.columns ?? 60
    if (r?.type === 'windows' && Array.isArray(r.windows)) return windowCard(ui, r, columns)
    if (r?.type === 'report' && Array.isArray(r.byDay)) return spendCard(ui, r, columns)
    if (r?.type === 'check' && Array.isArray(r.items)) return checkCard(ui, r)
    if (r?.type === 'calibration' && Array.isArray(r.windows)) return calibrationCard(ui, r)
    if (r?.type === 'guide' && Array.isArray(r.sections)) return guideCard(ui, r)
    if (r?.type === 'waiting' && id) return waitingCard(ui, r, () => void sendCheck($, id))
    return next(e)
  })
}

/* Measurement: runs the transcript scan, keeps readings and plan history in $.store keyed
   by subscription, and turns them into estimates. The engine reaches this module through
   a Host that register.tsx builds, since $ itself never crosses an import. After a measure,
   a second helper call rebuilds the per-feature dollars of readings stored without them,
   and the meter-weight model fit is refreshed; of the estimates, only Fable's window uses
   it.

   $.store is one store shared by every running session, so each key is read immediately
   before it is written, with no wait on the helper in between, and the plan, regime,
   promotion and notice keys are written only when they changed. */

import type { SessionRateLimit } from 'claude-code'

import type {
  CalibrationReport,
  CheckItem,
  CheckReport,
  FableReport,
  ModelSpend,
  ModelsFit,
  ModelsReport,
  PlanReport,
  SpendReport,
  UsageReport,
  WindowReport,
} from '../types'
import { money, statusLine } from './card'
import {
  MIN_ROUNDING_WINDOWS,
  calibrateOmega,
  calibrationOf,
  estimate,
  fallOf,
  pastPoints,
  prior,
  record,
  regimeView,
  resolutionOf,
  roundingEvidence,
  tQuantile,
} from './estimate'
import type { Calibration, Estimate, RangeEstimate, Rounding, WindowReadings } from './estimate'
import { cappedWeeksOf, fableUseE, fableWeightsOf, fableWindow, isAfterFableCap, isFableFeature, isFableInFit } from './fable'
import type { FableWeights } from './fable'
import {
  UNIT_WEIGHTS,
  familyConversion,
  fingerprintOf,
  isFeatureComplete,
  isUnit,
  prospectiveScore,
  selectModel,
  transferCheck,
  weightedEstimate,
  weightedView,
} from './meter'
import type { FitResult, ProspectiveRecord, Selection, StoredFit, Transfer } from './meter'
import {
  activePromotions,
  addRegimes,
  currentRegime,
  fableShareOf,
  observePlan,
  observePromotions,
  planLabel,
  regimeStart,
  startOver,
  undoStartOver,
} from './plan'
import type { Kind, Ledger, NoticeDraft, PlanEntry, Profile, Promotions, Regime, Regimes } from './plan'

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const MIN_GAP_MS = MINUTE_MS
const FRESH_MS = 5 * MINUTE_MS
/* How long readings are kept after their reset: 5-hour windows, and weeks. */
const READINGS_KEPT_MS = 28 * DAY_MS
const WEEKS_KEPT_MS = 12 * 7 * DAY_MS
const HISTORY_DAYS = 14
const HISTORY_REFRESH_MS = 6 * HOUR_MS
const NOTICE_SHOWN_MS = 7 * DAY_MS
const STALE_PROFILE_MS = 7 * DAY_MS
const KEPT_NOTICES = 20
/* Above this share of a window's requests going to unpriced models, its dollars no longer
   track the limit. */
const MAX_UNPRICED_SHARE = 0.02
const SCHEMA = 5
/* What the limits and readings this module stores mean; raise it whenever that changes.
   A stored limit without one is stamp 0. */
const HOOKS_STAMP = 2
/* The engine rejects a store over 4 MiB of JSON text in all keys together; the readings
   stay within 3 MiB and the other keys are small. */
const MAX_READINGS_CHARS = 3 * 1024 * 1024
/* The backfill: window specs per helper call, and its timeout. */
const BACKFILL_MAX_SPECS = 100
const BACKFILL_TIMEOUT_MS = 120_000
/* A side's backfilled dollars match its stored ones within max(relative · usd, absolute),
   the tolerance of a feature-complete window in meter.ts. */
const FEATURE_TOLERANCE_RELATIVE = 1e-6
const FEATURE_TOLERANCE_ABSOLUTE = 2e-4
/* Per-feature dollars are stored in units of 1e-6, as record() stores them. */
const X_UNIT = 1e6
/* Qualifying 5-hour windows a model fit needs, as in meter.ts. */
const FIT_MIN_WINDOWS = 4
/* ω of a stored fit without a fitted model; unused, since its weights are M0's. */
const UNFITTED_OMEGA = 0.5
/* Prospective records kept per subscription. */
const PROSPECTIVE_KEPT = 100
const NONE = 'none'
/* The suffixes of a window's further tallies: up to the moment this session received its
   percent, and up to the moment the stored percent was received. */
const AT_READ = '@read'
const AT_STORED = '@stored'
/* The suffix of the week's tally since its reported percent fell. */
const AT_FALL = '@fall'
/* Median ratio of these dollars to Claude Code's own costs outside which the price table
   is out of date. */
const MIN_PRICE_RATIO = 0.9
const MAX_PRICE_RATIO = 1.1

const SCHEMA_KEY = 'schema'
const LIMITS_KEY = 'limits'
const READINGS_KEY = 'readings'
const HISTORY_KEY = 'history'
const PLANS_KEY = 'plans'
const REGIMES_KEY = 'regimes'
const PROMOTIONS_KEY = 'promotions'
const NOTICES_KEY = 'notices'
const METER_KEY = 'meter'

export const INFERRED_TEXT =
  'Usage no longer matches recent windows: limits may have changed, or this subscription was used elsewhere ' +
  '(inferred from usage, not from the plan). If you changed plans, run /usage-dollars reset.'

export const FABLE_CAP_TEXT =
  "Fable has likely reached its weekly cap, half of the week's allowance (derived, not reported by Claude Code). " +
  'Further Fable requests bill usage credits or switch models. While they bill credits, the estimates run high.'

const fellText = (title: string) =>
  `${title}: the reported percent fell, as after a limit reset. Later readings of this window are not recorded, ` +
  'and what is left follows the reported percent.'

const WINDOWS: readonly { kind: Kind; name: string; title: string; short: string; spanMs: number }[] = [
  { kind: 'five_hour', name: 'session', title: '5-hour window', short: '5h', spanMs: 5 * HOUR_MS },
  { kind: 'seven_day', name: 'week', title: 'This week', short: 'Week', spanMs: 7 * DAY_MS },
]

const SPAN_MS: Record<string, number> = { five_hour: 5 * HOUR_MS, seven_day: 7 * DAY_MS }

const KINDS: readonly Kind[] = ['five_hour', 'seven_day']

const KIND_TITLES: Record<Kind, string> = { five_hour: '5-hour windows', seven_day: 'Weeks' }

/** What this module needs from the engine: the clock, the session, the helper process,
    $.store, the status line and the debug log. */
export type Host = {
  root: string
  now: () => Promise<number>
  sessionId: () => Promise<string>
  rateLimits: () => Promise<readonly SessionRateLimit[]>
  run: (argv: string[], options: { timeoutMs: number }) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  delete: (key: string) => Promise<void>
  status: (text: string) => void
  log: (text: string) => void
}

type OrgSource = 'session' | 'profile' | 'most recent'

/* observedAt: when a session last received this percent from the API; absent for a reset
   rolled forward without one. */
type Limit = { percentUsed?: number; resetsAt: string; observedAt?: number }

/* sessionId: the session that received the percent; stamp: its HOOKS_STAMP. */
type StoredLimit = { percentUsed?: number; resetsAt: string; observedAt: number; sessionId?: string; stamp?: number }

type StoredLimits = Record<string, Record<string, StoredLimit>>

/* featuresUnverified: the backfill could not rebuild the window's per-feature dollars, and
   does not try again. */
type StoredReading = WindowReadings & { org: string; featuresUnverified?: boolean }

type StoredReadings = Record<string, StoredReading>

/* The model fit of one subscription, refitted only when its fingerprint changes.
   included: the keys of the qualifying closed windows per kind; regimeStarts: per kind;
   rounding: the rule of the second pass; fits: per kind, the weights in use with their ω
   and M0's; prospective: new windows scored before each refit, the latest kept; capped:
   the weeks left out for Fable's cap, by store key, with the moment of the cap. */
type MeterEntry = {
  fingerprint: string
  included: Record<string, string[]>
  regimeStarts: Record<string, number>
  pricesId?: string
  rounding: Rounding
  selection: Selection
  transfer: Transfer
  fits: Record<string, StoredFit>
  prospective: ProspectiveRecord[]
  capped?: Record<string, number>
}

type StoredMeter = Record<string, MeterEntry>

/* The subscription and price table whose readings a measure wrote, and Fable's share of
   the week on its plan. */
type MeterContext = { subscription: string; pricesId?: string; share?: number }

type Observation = { kind: string; resetsAt: string; at: string; usd: number }

type History = Record<string, { scannedAt: number; observations: Observation[] }>

export type Notice = {
  id: string
  kind: NoticeDraft['kind']
  org: string
  text: string
  at: number
  isToasted: boolean
  isSeen: boolean
}

type WindowTally = {
  usd: number
  requests: number
  byModel: Record<string, { usd: number; requests: number }>
  /* usd by feature `<priceKey>[+fast]/<class>` or `web`; keys above 0 only. */
  byFeature?: Record<string, number>
  /* The Fable models' share of usd and requests; absent counts as none. */
  fable?: { usd: number; requests: number }
  otherSubscriptionsUsd: number
  unattributedUsd: number
  unpricedRequests: number
  unpricedModels: string[]
  /* Other sessions' dollars just before the tally's end, which its percent may lack. */
  slackUsd?: number
  resetLabel?: string
  resetLong?: string
  resetIn?: string
}

type HelperBase = {
  org?: string | null
  orgSource?: OrgSource | null
  profile?: Profile | null
  labels?: Record<string, string>
  error?: string
}

type WindowsOutput = HelperBase & { windows?: Record<string, WindowTally>; pricesId?: string; files: number; ms: number }

type ReportOutput = HelperBase & {
  usd: number
  requests: number
  byModel: Record<string, { usd: number; requests: number }>
  byDay: { date: string; label: string; usd: number; requests: number }[]
  otherSubscriptionsUsd: number
  unattributedUsd: number
  unpricedRequests: number
  unpricedModels: string[]
  fromLabel: string
  toLabel: string
  transcriptsBeginLabel?: string
}

/* closedWindows: closed windows of this kind and regime that hold readings. halfWidth: of
   the current 90% range, in proportion. fableCapped: closed windows left out for Fable's
   cap. */
type WindowCalibration = Calibration & { closedWindows: number; rounding: Rounding; halfWidth?: number; fableCapped?: number }

/* fellAt: the latest reading before the reported percent fell; leftByPercent: then what
   is left, from the allowance and the latest reported percent. */
type WindowState = {
  kind: Kind
  title: string
  short: string
  resetsAt: string
  tally: WindowTally
  estimate?: Estimate
  isUnpriced: boolean
  sinceResetLabel?: string
  percent?: number
  percentAt?: number
  calibration: WindowCalibration
  fellAt?: number
  leftByPercent?: RangeEstimate
}

/* Why a percent a measure could have recorded was not: `missing` when nothing explains it. */
type Outcome = 'recorded' | 'unpriced' | 'unattributed' | 'fell' | 'missing'

/* A percent that may be recorded: this session's fresh one, or one stored by a session
   whose reading of it may have been lost. sessionId: the session that received it. */
type Candidate = { source: 'mine' | 'stored'; tally: string; percent: number; at: number; sessionId: string }

/* A candidate a measure tried to record, under the window key, and what became of it. */
type Attempt = { title: string; key: string; c: Candidate; outcome?: Outcome }

export type Diagnostics = {
  /* Another session stored a percent with other hooks since this module first measured:
     older or newer than this one's. */
  otherHooks?: 'older' | 'newer'
  /* Stored windows dropped for another price table, over this session's measures. */
  droppedForPrices: number
  /* Closed windows dropped to keep the readings within MAX_READINGS_CHARS. */
  droppedForSize: number
  /* Per window title, what became of the percents the latest measure that had any could
     record. */
  outcomes: Record<string, { source: Candidate['source']; outcome: Outcome }[]>
  /* Kinds of live rate limits this module does not measure. */
  unknownKinds: string[]
}

export type Summary = {
  subscription: string
  orgSource?: OrgSource | null
  windows: WindowState[]
  plan: PlanReport
  notices: string[]
  last24hUsd?: number
  /* The last 7 days' dollars by feature. */
  last7dX?: Record<string, number>
  /* Max and Ultra: Fable's share of the week, derived. */
  fable?: FableReport
  sinceResetLabel?: string
  files: number
  ms: number
}

/* The session's subscription, once a helper run attributed it through the session's own
   record; until then each measure asks the helper first. */
let sessionOrg: string | undefined
let lastSubscription: string | undefined
let isMigrated = false
let last: Summary | undefined
let lastRunAt = 0
let running: Promise<Summary | undefined> | undefined
/* When this session last received its percents; their age decides between them and the
   ones other sessions stored. */
let lastFreshAt: number | undefined
/* A fresh measure that arrived while another ran, with the time its percents arrived;
   the latest wins. */
let pendingFresh: { host: Host; limits?: readonly SessionRateLimit[]; receivedAt?: number } | undefined
let firstMeasureAt: number | undefined
const diagnostics: Diagnostics = { droppedForPrices: 0, droppedForSize: 0, outcomes: {}, unknownKinds: [] }
/* The latest measure that wrote readings; the backfill and the model fit follow it. */
let meterContext: MeterContext | undefined
/* The backfill and model fit in flight, and the measure queued after it; the latest wins. */
let followUp: Promise<void> | undefined
let queuedFollowUp: { host: Host; context: MeterContext } | undefined
/* Every write of the readings from this module, one at a time. */
let readingsTurn: Promise<unknown> = Promise.resolve()

const subscriptionOf = (org: string | null | undefined) => org ?? NONE

const isSame = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const windowKey = (subscription: string, kind: string, resetsAt: string) =>
  `${subscription}|${kind}@${new Date(Math.round(Date.parse(resetsAt) / MINUTE_MS) * MINUTE_MS).toISOString()}`

const helperArgv = (host: Host) => ['node', `${host.root}/scripts/usage-cost.mjs`]

async function runHelper<T extends HelperBase>(host: Host, extra: readonly string[], timeoutMs: number) {
  return runScript<T>(host, ['--session', await host.sessionId(), ...extra], timeoutMs)
}

async function runScript<T extends { error?: string }>(host: Host, extra: readonly string[], timeoutMs: number) {
  const run = await host.run([...helperArgv(host), ...extra], { timeoutMs })
  let out: T | undefined
  try {
    out = JSON.parse(run.stdout || '{}') as T
  } catch {
    out = undefined
  }
  if (run.exitCode !== 0 || !out || out.error) {
    const error = out?.error ?? run.stderr.slice(0, 200)
    return { error: error || `helper exited with ${run.exitCode}` }
  }
  return { out }
}

/* v0.3.0 kept limits, readings and history without a subscription; they cannot be
   attributed, so they are dropped once and the estimates start again.
   Before schema 3 any session paired its own last percent, however old, with the dollars
   of the moment and stored the pair; nothing tells those readings or limits from sound
   ones, so both are dropped once more. Schema-3 readings paired the percent with the
   dollars at the time of the scan and carry no slack or price table, so they are dropped
   once again. History comes from rate-limit rejections in the transcripts, not from
   percents, and is kept from schema 2 on. Schema-4 limits and readings lack only the
   per-feature dollars, which the backfill rebuilds, so they are kept. */
async function migrate(host: Host) {
  if (isMigrated) return
  const was = await host.get(SCHEMA_KEY)
  if (was !== SCHEMA) {
    if (was !== 4) {
      await host.delete(LIMITS_KEY)
      await host.delete(READINGS_KEY)
      if (was !== 2 && was !== 3) await host.delete(HISTORY_KEY)
    }
    await host.set(SCHEMA_KEY, SCHEMA)
  }
  isMigrated = true
}

/* Runs `work`, which reads the readings and writes them, after every such work of this
   module started before it. */
function exclusively<T>(work: () => Promise<T>): Promise<T> {
  const turn = readingsTurn.then(work)
  readingsTurn = turn.catch(() => undefined)
  return turn
}

/* The readings within MAX_READINGS_CHARS of JSON text: the oldest closed windows give way
   first, each one counted. */
function withinSize(readings: StoredReadings, now: number): StoredReadings {
  let size = JSON.stringify(readings).length
  if (size <= MAX_READINGS_CHARS) return readings
  const kept = { ...readings }
  const oldest = Object.entries(kept)
    .filter(([, r]) => Date.parse(r.resetsAt) <= now)
    .sort(([, a], [, b]) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt))
  for (const [key, r] of oldest) {
    if (size <= MAX_READINGS_CHARS) break
    size -= JSON.stringify(key).length + JSON.stringify(r).length + 2
    delete kept[key]
    diagnostics.droppedForSize++
  }
  return kept
}

/** The session's subscription key: its own record, else the signed-in one, else "none". */
export async function resolveSubscription(host: Host) {
  await migrate(host)
  if (sessionOrg) return sessionOrg
  const { out } = await runHelper<HelperBase>(host, ['--whoami'], 30_000)
  if (out?.orgSource === 'session' && out.org) sessionOrg = out.org
  return subscriptionOf(out?.org)
}

/* The limit as last stored for the subscription: a 7-day window rolls forward a week at a
   time, without a percent; a 5-hour one only holds until its reset. */
function storedLimitOf(kind: Kind, kept: StoredLimit | undefined, now: number): Limit | undefined {
  if (!kept) return undefined
  let reset = Date.parse(kept.resetsAt)
  if (reset > now) return { percentUsed: kept.percentUsed, resetsAt: kept.resetsAt, observedAt: kept.observedAt }
  if (kind !== 'seven_day') return undefined
  while (reset <= now) reset += 7 * DAY_MS
  return { resetsAt: new Date(reset).toISOString() }
}

/* The limit this session holds, received at liveAt, or the one stored by any session,
   whichever was received later. A live limit of unknown age loses to a stored one. */
function limitOf(kind: Kind, live: readonly SessionRateLimit[], liveAt: number | undefined, kept: StoredLimit | undefined, now: number) {
  const found = live.find(l => l.kind === kind && l.resetsAt)
  const stored = storedLimitOf(kind, kept, now)
  if (!found) return stored
  const mine: Limit = { percentUsed: found.percentUsed, resetsAt: found.resetsAt!, observedAt: liveAt }
  if (!stored) return mine
  if (liveAt === undefined) return stored
  return stored.observedAt !== undefined && stored.observedAt > liveAt ? stored : mine
}

const latestEntry = (plans: Ledger, subscription: string): PlanEntry | undefined => {
  const entries = plans[subscription] ?? []
  return entries[entries.length - 1]
}

/* Every stored instant the card may show, labeled by the helper under its epoch ms. */
function labelArgs(regimes: Regimes, plans: Ledger, subscription: string, now: number) {
  const instants = new Set<number>([now])
  for (const w of WINDOWS) {
    const r = currentRegime(regimes, subscription, w.kind)
    if (r && r.startedAt > 0) instants.add(r.startedAt)
  }
  const entry = latestEntry(plans, subscription)
  if (entry?.profileFetchedAt) instants.add(entry.profileFetchedAt)
  if (entry?.lastSeenAt) instants.add(entry.lastSeenAt)
  return [...instants].flatMap(ms => ['--label', `${ms},${new Date(ms).toISOString()}`])
}

async function queueNotices(host: Host, subscription: string, drafts: readonly NoticeDraft[], now: number) {
  if (drafts.length === 0) return
  const queue = ((await host.get(NOTICES_KEY)) ?? []) as Notice[]
  const ids = new Set(queue.map(n => n.id))
  const added = drafts
    .filter(d => !ids.has(d.id))
    .map(d => ({ ...d, org: subscription, at: now, isToasted: false, isSeen: false }) as Notice)
  if (added.length === 0) return
  const next = [...queue, ...added]
  await host.set(NOTICES_KEY, next.slice(Math.max(0, next.length - KEPT_NOTICES)))
}

function planChangedText(event: { from: PlanEntry; to: PlanEntry; between: [number, number] }, labels: Record<string, string>, profile: Profile) {
  const from = labels[String(event.between[0])] ?? 'the previous check'
  const to =
    (profile.fetchedAt && Date.parse(profile.fetchedAt) === event.between[1] ? profile.fetchedLabel : undefined) ??
    labels[String(event.between[1])] ??
    'now'
  return `Plan changed: ${event.from.label} → ${event.to.label} (between ${from} and ${to}). Estimates restarted.`
}

function planReport(
  event: ReturnType<typeof observePlan>['event'],
  profile: Profile | null | undefined,
  labels: Record<string, string>,
  now: number,
): PlanReport {
  if (event.kind === 'unknown') {
    const known = event.lastKnown
    const on = known ? labels[String(known.lastSeenAt)] : undefined
    return {
      isUnknown: true,
      isStale: false,
      unknownReason: event.reason,
      lastKnown: known ? `${known.label}${on ? ` on ${on}` : ''}` : undefined,
    }
  }
  const fetchedAt = profile?.fetchedAt ? Date.parse(profile.fetchedAt) : NaN
  const label = event.kind === 'changed' ? event.to.label : undefined
  return {
    isUnknown: false,
    label: label ?? (profile ? planLabel(profile) : undefined),
    asOfLabel: profile?.fetchedLabel ?? undefined,
    isStale: Number.isFinite(fetchedAt) && now - fetchedAt > STALE_PROFILE_MS,
  }
}

/* A closed window that contains a regime start of its own subscription mixes two sets of
   limits, so it cannot tell how the API rounds. */
function isStraddling(r: WindowReadings & { org: string }, regimes: Regimes) {
  const reset = Date.parse(r.resetsAt)
  const start = reset - (SPAN_MS[r.kind] ?? 0)
  return (regimes[r.org] ?? []).some(
    (g: Regime) => !g.isUndone && (!g.kinds || g.kinds.includes(r.kind as Kind)) && g.startedAt > start && g.startedAt <= reset,
  )
}

/* The newest max side of a window: its dollars, and its per-feature dollars when stored. */
function latestSideOf(r: WindowReadings) {
  let newest: WindowReadings['byPct'][string] | undefined
  for (const b of Object.values(r.byPct)) if (!newest || b.maxAt > newest.maxAt) newest = b
  const features = r.features ?? []
  const x = newest?.maxX ? Object.fromEntries(features.map((f, i) => [f, newest!.maxX![i] ?? 0]).filter(([, v]) => (v as number) > 0)) : undefined
  return { usd: newest?.maxUsd ?? 0, x: x as Record<string, number> | undefined }
}

/* The subscription's stored weeks, with their store keys. */
const weeksOf = (readings: StoredReadings, subscription: string) =>
  Object.entries(readings)
    .filter(([, r]) => r.org === subscription && r.kind === 'seven_day')
    .map(([key, r]) => ({ key, r }))

/* The capped weeks as isAfterFableCap takes them. */
const capMomentsOf = (capped: Record<string, number>, readings: StoredReadings) =>
  Object.entries(capped).flatMap(([key, capAt]) => {
    const r = readings[key]
    return r ? [{ capAt, resetsAt: Date.parse(r.resetsAt) }] : []
  })

/* Closed windows left out for Fable's cap: capped weeks, and 5-hour windows after a cap. */
function isLeftOutForFable(kind: string, key: string, r: WindowReadings, capped: Record<string, number>, moments: ReturnType<typeof capMomentsOf>) {
  return kind === 'seven_day' ? key in capped : isAfterFableCap(r, moments)
}

const FELL_BASIS = ' · the reported percent fell in this window: left follows the percent'

function basisOf(e: Estimate | undefined, isUnpriced: boolean, sinceResetLabel: string | undefined, isFallen = false): string {
  if (isFallen && e && !isUnpriced) return `${basisOf(e, isUnpriced, sinceResetLabel)}${FELL_BASIS}`
  const reset = sinceResetLabel ? ` · since reset ${sinceResetLabel}` : ''
  if (isUnpriced) return `Unpriced models in use: no estimate${reset}.`
  if (!e) return `No estimate yet: the limit has not reported a usable reading for this window${reset}.`
  const readings = e.isPriorOnly
    ? 'From past windows only: no tick read in this window yet'
    : `${e.readings} percent level${e.readings === 1 ? '' : 's'} read`
  const within = `within-window spread ${e.isWithinSpreadAssumed ? 'assumed' : 'measured'}`
  const between = e.isSpreadAssumed
    ? 'between-window spread assumed'
    : `between-window spread from ${e.pastWindows} past window${e.pastWindows === 1 ? '' : 's'}`
  return `${readings} · ${within} · ${between} · history weight ${e.pastWeight}${reset}`
}

const isUnpricedTally = (t: WindowTally) => t.unpricedRequests > MAX_UNPRICED_SHARE * (t.requests + t.unpricedRequests)

/* The percents of the active window a measure may record: this session's, from `given`,
   and the stored one when a session with these hooks stored it and it is not the same
   percent. Whether the stored one has a reading already is decided against the readings
   read just before they are written. */
function candidatesOf(
  w: (typeof WINDOWS)[number],
  limit: Limit,
  subscription: string,
  given: readonly SessionRateLimit[] | undefined,
  readAt: number,
  sessionId: string,
  kept: StoredLimit | undefined,
): Candidate[] {
  const key = windowKey(subscription, w.kind, limit.resetsAt)
  const candidates: Candidate[] = []
  const fresh = given?.find(l => l.kind === w.kind && l.resetsAt)
  if (fresh && windowKey(subscription, w.kind, fresh.resetsAt!) === key)
    candidates.push({ source: 'mine', tally: `${w.name}${AT_READ}`, percent: fresh.percentUsed, at: readAt, sessionId })
  const isMine = candidates.some(c => c.at === kept?.observedAt && c.sessionId === kept?.sessionId)
  if (
    kept?.sessionId &&
    kept.percentUsed !== undefined &&
    (kept.stamp ?? 0) === HOOKS_STAMP &&
    windowKey(subscription, w.kind, kept.resetsAt) === key &&
    !isMine
  )
    candidates.push({ source: 'stored', tally: `${w.name}${AT_STORED}`, percent: kept.percentUsed, at: kept.observedAt, sessionId: kept.sessionId })
  return candidates
}

/* Whether a level's bucket holds the reading at `at`, or a later one at that level that
   took its side. */
function isHeld(r: WindowReadings | undefined, percent: number, at: number) {
  const b = r?.byPct[String(percent)]
  return b !== undefined && (b.minAt === at || b.maxAt >= at)
}

const hasReadingAt = (r: WindowReadings | undefined, at: number) =>
  r !== undefined && Object.values(r.byPct).some(b => b.minAt === at || b.maxAt === at)

/* isFresh: `given` holds percents this session received at receivedAt, so they and the
   dollars counted up to then describe the same moment. Only such a measure records its
   own percents or shares its limits; every measure records a stored percent that has no
   reading yet. */
async function measure(
  host: Host,
  given: readonly SessionRateLimit[] | undefined,
  isFresh: boolean,
  receivedAt: number | undefined,
): Promise<Summary | undefined> {
  const now = await host.now()
  if (firstMeasureAt === undefined) firstMeasureAt = now
  const readAt = isFresh && receivedAt !== undefined ? receivedAt : now
  const live = given ?? (await host.rateLimits())
  if (isFresh) lastFreshAt = readAt
  const sessionId = await host.sessionId()
  let subscription = await resolveSubscription(host)

  let active: { w: (typeof WINDOWS)[number]; limit: Limit; candidates: Candidate[] }[] = []
  let storedLimits: StoredLimits = {}
  let out: WindowsOutput | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    storedLimits = ((await host.get(LIMITS_KEY)) ?? {}) as StoredLimits
    active = []
    for (const w of WINDOWS) {
      const kept = storedLimits[subscription]?.[w.kind]
      const limit = limitOf(w.kind, live, lastFreshAt, kept, now)
      if (limit) active.push({ w, limit, candidates: candidatesOf(w, limit, subscription, isFresh ? given : undefined, readAt, sessionId, kept) })
    }
    if (active.length === 0) {
      host.status('waiting for the first reply')
      return undefined
    }

    const regimes = ((await host.get(REGIMES_KEY)) ?? {}) as Regimes
    const plans = ((await host.get(PLANS_KEY)) ?? {}) as Ledger
    const before = ((await host.get(READINGS_KEY)) ?? {}) as StoredReadings
    const extra: string[] = []
    for (const { w, limit, candidates } of active) {
      const since = new Date(Date.parse(limit.resetsAt) - w.spanMs).toISOString()
      extra.push('--window', `${w.name},${since},${limit.resetsAt}`)
      for (const c of candidates)
        extra.push('--window', `${c.tally},${since},${limit.resetsAt},${new Date(c.at).toISOString()},${c.sessionId}`)
      /* A limit reset gives back the week's Fable use: Fable counts from the fall on. */
      const fall = w.kind === 'seven_day' ? before[windowKey(subscription, w.kind, limit.resetsAt)]?.fall : undefined
      if (fall?.isConfirmed) extra.push('--window', `${w.name}${AT_FALL},${new Date(fall.lastAt + 1).toISOString()},${limit.resetsAt}`)
    }
    extra.push('--window', `last24h,${new Date(now - DAY_MS).toISOString()},${new Date(now).toISOString()}`)
    extra.push('--window', `last7d,${new Date(now - 7 * DAY_MS).toISOString()},${new Date(now).toISOString()}`)
    extra.push(...labelArgs(regimes, plans, subscription, now))
    const result = await runHelper<WindowsOutput>(host, extra, 120_000)
    if (!result.out?.windows) {
      host.status('unavailable')
      host.log(`usage-dollars: ${result.error ?? 'no windows in the helper output'}`)
      return undefined
    }
    out = result.out
    if (out.orgSource === 'session' && out.org) sessionOrg = out.org
    const reported = subscriptionOf(out.org)
    if (reported === subscription) break
    subscription = reported
    if (attempt === 1) break
  }
  if (!out?.windows) return undefined
  lastSubscription = subscription
  const labels = out.labels ?? {}
  const profile = out.profile ?? null

  /* A stored limit gives way to one received later, or to the next window's. */
  const liveLimits = isFresh ? live.filter(l => l.resetsAt && WINDOWS.some(w => w.kind === l.kind)) : []
  if (liveLimits.length > 0) {
    const stored = ((await host.get(LIMITS_KEY)) ?? {}) as StoredLimits
    const mine = { ...stored[subscription] }
    let isChanged = false
    for (const l of liveLimits) {
      const was = mine[l.kind] as StoredLimit | undefined
      if (was && Date.parse(was.resetsAt) >= Date.parse(l.resetsAt!) && was.observedAt >= readAt) continue
      mine[l.kind] = { percentUsed: l.percentUsed, resetsAt: l.resetsAt!, observedAt: readAt, sessionId, stamp: HOOKS_STAMP }
      isChanged = true
    }
    if (isChanged) await host.set(LIMITS_KEY, { ...stored, [subscription]: mine })
  }

  /* Live limits of a kind this module does not measure. */
  for (const l of live) {
    const kind = String(l.kind)
    if (!WINDOWS.some(w => w.kind === kind) && kind !== 'spend_limit' && !diagnostics.unknownKinds.includes(kind)) diagnostics.unknownKinds.push(kind)
  }

  /* Hooks of another stamp that stored a percent since this module first measured. */
  for (const l of Object.values(storedLimits[subscription] ?? {})) {
    const stamp = l.stamp ?? 0
    if (stamp !== HOOKS_STAMP && l.observedAt > (firstMeasureAt ?? now)) diagnostics.otherHooks = stamp < HOOKS_STAMP ? 'older' : 'newer'
  }

  /* A guessed subscription must not write readings; with none at all every request is
     counted, as on a machine without bridge-session records. A reading takes its percent
     from a candidate, and only for the window the dollars were scanned for; its dollars
     and their features end where the percent was received. Readings priced with another
     table are dropped. */
  const mayRecord = out.org === null || out.org === undefined || out.orgSource === 'session' || out.orgSource === 'profile'
  const pricesId = out.pricesId
  const tallies = out.windows
  const { kept, attempts } = await exclusively(async () => {
    const storedReadings = ((await host.get(READINGS_KEY)) ?? {}) as StoredReadings
    const readings = Object.fromEntries(Object.entries(storedReadings).filter(([, r]) => r.pricesId === pricesId)) as StoredReadings
    diagnostics.droppedForPrices += Object.keys(storedReadings).length - Object.keys(readings).length
    const attempts: Attempt[] = []
    for (const { w, limit, candidates } of active) {
      const key = windowKey(subscription, w.kind, limit.resetsAt)
      /* In the order received, so that a fall is judged reading after reading. */
      for (const c of [...candidates].sort((a, b) => a.at - b.at)) {
        if (c.source === 'stored' && hasReadingAt(readings[key], c.at)) continue
        const tally = tallies[c.tally]
        const attempt: Attempt = { title: w.title, key, c }
        attempts.push(attempt)
        if (!mayRecord) attempt.outcome = 'unattributed'
        else if (tally && isUnpricedTally(tally)) attempt.outcome = 'unpriced'
        else if (tally) {
          /* One lower percent is a suspicion, since a slow response can deliver an older
             percent than one already stored; a second, received later, is a fall. */
          const stored = readings[key]
          const fall = stored?.fall
          const fell = stored && !fall?.isConfirmed ? fallOf(stored, c.percent, c.at) : undefined
          if (stored && fall?.isConfirmed) attempt.outcome = 'fell'
          else if (stored && fell) {
            attempt.outcome = 'fell'
            readings[key] = {
              ...stored,
              fall: fall ? (c.at > fall.seenAt ? { ...fall, isConfirmed: true } : fall) : { lastAt: fell.lastAt, seenAt: c.at, isConfirmed: false },
            }
          } else {
            let was: StoredReading = stored ?? { kind: w.kind, resetsAt: limit.resetsAt, byPct: {}, org: subscription, pricesId }
            if (fall && c.at > fall.seenAt) {
              const { fall: _, ...rest } = was
              was = rest
            }
            readings[key] = { ...record(was, c.percent, tally.usd, c.at, tally.slackUsd ?? 0, tally.byFeature), org: subscription, pricesId }
          }
        }
      }
    }
    const keptFor = (kind: string) => (kind === 'seven_day' ? WEEKS_KEPT_MS : READINGS_KEPT_MS)
    const kept = withinSize(
      Object.fromEntries(Object.entries(readings).filter(([, r]) => Date.parse(r.resetsAt) > now - keptFor(r.kind))) as StoredReadings,
      now,
    )
    await host.set(READINGS_KEY, kept)
    return { kept, attempts }
  })
  const outcomes: Diagnostics['outcomes'] = {}
  for (const a of attempts) {
    const outcome = a.outcome ?? (isHeld(kept[a.key], a.c.percent, a.c.at) ? 'recorded' : 'missing')
    outcomes[a.title] = [...(outcomes[a.title] ?? []), { source: a.c.source, outcome }]
  }
  for (const [title, list] of Object.entries(outcomes)) diagnostics.outcomes[title] = list

  const plans = ((await host.get(PLANS_KEY)) ?? {}) as Ledger
  const observedPlan = observePlan(plans, profile, subscription, now)
  if (!isSame(observedPlan.ledger, plans)) await host.set(PLANS_KEY, observedPlan.ledger)

  /* Fable's weekly cap, on plans that have one: its weights, and the weeks that reached it. */
  const share = fableShareOf(latestEntry(observedPlan.ledger, subscription))
  let fw: FableWeights = { weights: UNIT_WEIGHTS, source: 'assumed' }
  let capped: Record<string, number> = {}
  if (share !== undefined) {
    const meter = ((await host.get(METER_KEY)) ?? {}) as StoredMeter
    const entry = meter[subscription]
    fw = fableWeightsOf(entry, pricesId)
    capped = cappedWeeksOf(weeksOf(kept, subscription), share, fw.weights, entry?.pricesId === pricesId ? entry?.capped : undefined)
  }
  const capMoments = capMomentsOf(capped, kept)

  const promotions = ((await host.get(PROMOTIONS_KEY)) ?? {}) as Promotions
  const observedPromos = observePromotions(promotions, profile, subscription, now)
  if (!isSame(observedPromos.stored, promotions)) await host.set(PROMOTIONS_KEY, observedPromos.stored)

  const added = [...(observedPlan.regime ? [observedPlan.regime] : []), ...observedPromos.regimes]
  let regimes = ((await host.get(REGIMES_KEY)) ?? {}) as Regimes
  if (added.length > 0) {
    regimes = addRegimes(regimes, subscription, added)
    await host.set(REGIMES_KEY, regimes)
  }

  const drafts: NoticeDraft[] = [...observedPromos.notices]
  const event = observedPlan.event
  if (event.kind === 'changed' && profile)
    drafts.push({ id: `plan:${subscription}:${event.to.fingerprint}`, kind: 'plan-changed', text: planChangedText(event, labels, profile) })

  const all = Object.values(kept)
  const resolution = resolutionOf(all)
  const roundingSeen = roundingEvidence(
    all.filter(r => Date.parse(r.resetsAt) <= now && !isStraddling(r, regimes)),
    resolution,
  )
  const rounding = roundingSeen.rule
  const history = ((await host.get(HISTORY_KEY)) ?? {}) as History
  const observations = history[subscription]?.observations ?? []

  /* A rejection after the reported percent of its window fell counted dollars the limit
     no longer holds. */
  const isAfterFall = (o: Observation) => {
    const fall = kept[windowKey(subscription, o.kind, o.resetsAt)]?.fall
    return fall?.isConfirmed === true && Date.parse(o.at) > fall.lastAt
  }

  const windows: WindowState[] = []
  /* The week's estimate in weighted dollars, for Fable's window. */
  let weekE: { allowance: RangeEstimate; left: RangeEstimate } | undefined
  for (const { w, limit } of active) {
    const tally = out.windows[w.name]
    if (!tally) continue
    const startedAt = regimeStart(regimes, subscription, w.kind)
    const regime = currentRegime(regimes, subscription, w.kind)
    /* Closed windows of this subscription and regime: one past point each, and the
       crossings that measure the within-window spread. Those Fable's cap distorts are left
       out. */
    let fableCapped = 0
    const closed = Object.entries(kept)
      .filter(([, r]) => r.org === subscription && r.kind === w.kind && Date.parse(r.resetsAt) <= now && Date.parse(r.resetsAt) >= startedAt)
      .filter(([k, r]) => {
        const isOut = share !== undefined && isLeftOutForFable(w.kind, k, r, capped, capMoments)
        if (isOut) fableCapped++
        return !isOut
      })
      .map(([, r]) => regimeView(r, startedAt))
    const rejections = observations.filter(o => Date.parse(o.resetsAt) > now - HISTORY_DAYS * DAY_MS && !isAfterFall(o))
    const spread = calibrateOmega(closed, w.kind, now, resolution, rounding)
    const past = pastPoints(closed, rejections, w.kind, resolution, rounding, spread.omega).filter(p => p.at >= startedAt)
    const key = windowKey(subscription, w.kind, limit.resetsAt)
    const stored = kept[key]
    const current = stored ? regimeView(stored, startedAt) : undefined
    const isUnpriced = isUnpricedTally(tally)
    /* After a fall the allowance is the one known when the percent fell: the window's
       whole dollars would floor it at dollars the limit no longer holds. */
    const isFallen = stored?.fall?.isConfirmed === true
    const latest = isFallen && current ? latestSideOf(current) : undefined
    const livePercent = isFallen
      ? undefined
      : limit.observedAt !== undefined && now - limit.observedAt <= FRESH_MS
        ? limit.percentUsed
        : undefined
    const usedUsd = latest ? latest.usd : tally.usd
    const e =
      current && !isUnpriced ? estimate(current, usedUsd, { resolution, rounding, past, kind: w.kind, now, livePercent, spread }) : undefined
    if (e?.isPriorContradicted) drafts.push({ id: `inferred:${key}`, kind: 'inferred', text: INFERRED_TEXT })
    const remainder = limit.percentUsed !== undefined ? Math.max(0, 1 - limit.percentUsed / 100) : undefined
    const byPercent = (a: RangeEstimate): RangeEstimate | undefined =>
      remainder !== undefined ? { value: a.value * remainder, low: a.low * remainder, high: a.high * remainder } : undefined
    const leftByPercent = isFallen && e ? byPercent(e.allowance) : undefined
    if (isFallen && e) drafts.push({ id: `fell:${key}`, kind: 'inferred', text: fellText(w.title) })

    if (w.kind === 'seven_day' && share !== undefined && e) {
      const base = isUnit(fw.weights)
        ? e
        : weightedEstimate({
            kind: w.kind,
            closed,
            current,
            usedUsd,
            usedX: (latest ? latest.x : tally.byFeature) ?? {},
            fallbackX: out.windows.last7d?.byFeature,
            weights: fw.weights,
            rejections,
            resolution,
            rounding,
            now,
            livePercent,
            startedAt,
          }).estimate
      if (base) weekE = { allowance: base.allowance, left: isFallen ? (byPercent(base.allowance) ?? base.left) : base.left }
    }
    windows.push({
      kind: w.kind,
      title: w.title,
      short: w.short,
      resetsAt: limit.resetsAt,
      tally,
      estimate: e,
      isUnpriced,
      sinceResetLabel: regime?.reason === 'manual' ? labels[String(regime.startedAt)] : undefined,
      percent: limit.percentUsed,
      percentAt: limit.percentUsed !== undefined ? limit.observedAt : undefined,
      calibration: {
        ...calibrationOf({ current, resolution, spread, prior: prior(past, w.kind, now), rounding: roundingSeen }),
        closedWindows: closed.filter(r => Object.keys(r.byPct).length > 0).length,
        rounding,
        halfWidth: e ? Math.sqrt(e.allowance.high / e.allowance.low) - 1 : undefined,
        ...(share !== undefined ? { fableCapped } : {}),
      },
      ...(isFallen && stored?.fall ? { fellAt: stored.fall.lastAt } : {}),
      ...(leftByPercent ? { leftByPercent } : {}),
    })
  }

  const fable = share !== undefined ? fableOf({ share, fw, windows, weekE, tallies: out.windows }) : undefined
  if (fable?.isCapLikely) {
    const week = windows.find(s => s.kind === 'seven_day')!
    drafts.push({ id: `fable-cap:${windowKey(subscription, 'seven_day', week.resetsAt)}`, kind: 'inferred', text: FABLE_CAP_TEXT })
  }
  await queueNotices(host, subscription, drafts, now)

  const queue = ((await host.get(NOTICES_KEY)) ?? []) as Notice[]
  const mine = queue.filter(n => n.org === subscription)
  const isPlanUnseen = mine.some(n => n.kind === 'plan-changed' && !n.isSeen)
  host.status(statusOf({ windows, fable }, isPlanUnseen))

  const isShared = Object.keys(observedPlan.ledger).length > 1
  const notices = [
    ...mine
      .filter(n => n.kind === 'plan-changed' && n.at > now - NOTICE_SHOWN_MS)
      .map(n => n.text),
    ...activePromotions(observedPromos.stored, subscription).map(t => (isShared ? `${t} Not attributable to one subscription.` : t)),
    ...mine
      .filter(n => n.kind === 'promotion' && /^promo-(end|gone):/.test(n.id) && n.at > now - NOTICE_SHOWN_MS)
      .map(n => n.text),
    ...(windows.some(s => s.estimate?.isPriorContradicted) ? [INFERRED_TEXT] : []),
    ...windows.filter(s => s.fellAt !== undefined && s.estimate).map(s => fellText(s.title)),
    ...(fable?.isCapLikely ? [FABLE_CAP_TEXT] : []),
  ]

  const summary: Summary = {
    subscription,
    orgSource: out.orgSource,
    windows,
    plan: planReport(event, profile, labels, now),
    notices,
    last24hUsd: out.windows.last24h?.usd,
    last7dX: out.windows.last7d?.byFeature,
    ...(fable ? { fable } : {}),
    sinceResetLabel: windows.find(s => s.sinceResetLabel)?.sinceResetLabel,
    files: out.files,
    ms: out.ms,
  }
  if (mayRecord) {
    meterContext = { subscription, pricesId, ...(share !== undefined ? { share } : {}) }
    follow(host, meterContext)
  }
  return summary
}

/* Fable's share of the week, derived: used from the week's tally (or since a fall of its
   percent), and with a weekly estimate in weighted dollars, the cap in Fable's API dollars.
   Absent without a week, and on the measure that confirms a fall, before its tally exists. */
function fableOf(input: {
  share: number
  fw: FableWeights
  windows: readonly WindowState[]
  weekE: { allowance: RangeEstimate; left: RangeEstimate } | undefined
  tallies: Record<string, WindowTally>
}): FableReport | undefined {
  const { share, fw, windows, weekE, tallies } = input
  const week = windows.find(s => s.kind === 'seven_day')
  if (!week) return undefined
  const isSinceFall = week.fellAt !== undefined
  const t = isSinceFall ? tallies[`week${AT_FALL}`] : week.tally
  if (!t) return undefined
  const usedUsd = t.fable?.usd ?? 0
  const requests = t.fable?.requests ?? 0
  const weekX = t.byFeature ?? {}
  const fableE = fableUseE(fw.weights, weekX, usedUsd)
  const x = Object.keys(weekX).some(isFableFeature) ? weekX : (tallies.last7d?.byFeature ?? {})
  const mix = familyConversion(fw.weights, x, isFableFeature)
  const weightSource = isFableInFit(fw.weights, x) ? fw.source : 'assumed'
  const isMeasured = weightSource !== 'assumed' && fw.weights.model !== 'M0'
  const range = weekE ? fableWindow({ weekE, fableE, mix, share }) : undefined
  return {
    title: 'Fable this week',
    share,
    usedUsd,
    requests,
    ...(range ? { allowance: range.allowance, left: range.left } : {}),
    ...(range?.usedShare !== undefined ? { usedShare: range.usedShare } : {}),
    isCapLikely: range?.isCapLikely ?? false,
    weightSource,
    ...(weightSource === 'weekly' && fw.weeks !== undefined ? { weeks: fw.weeks } : {}),
    mix: weightSource === 'assumed' ? { value: 1, low: 1, high: 1 } : mix,
    ...(isMeasured ? { relativeTo: groupLabel(fw.weights.reference), isReference: isFableFeature(fw.weights.reference) } : {}),
    ...(isSinceFall ? { isSinceFall } : {}),
    resetLong: week.tally.resetLong ?? week.resetsAt,
    resetIn: week.tally.resetIn ?? '',
  }
}

/* The backfill and the model fit after a measure, one run at a time; a measure that ends
   while one runs queues the next. Neither delays nor fails the measure. */
function follow(host: Host, context: MeterContext) {
  queuedFollowUp = { host, context }
  if (followUp) return
  const takeQueued = () => {
    const next = queuedFollowUp
    queuedFollowUp = undefined
    return next
  }
  followUp = (async () => {
    try {
      for (let next = takeQueued(); next; next = takeQueued()) {
        const { host: h, context: c } = next
        await backfillOnce(h, c).catch(error => h.log(`usage-dollars: backfill: ${String(error)}`))
        await refreshMeter(h, c).catch(error => h.log(`usage-dollars: model fit: ${String(error)}`))
      }
    } finally {
      followUp = undefined
    }
  })().catch(() => undefined)
}

/** The backfill and model fit that measures started, settled once none is left. */
export function backfillSettled(): Promise<void> {
  return followUp ?? Promise.resolve()
}

const toleranceOf = (usd: number) => Math.max(FEATURE_TOLERANCE_RELATIVE * Math.abs(usd), FEATURE_TOLERANCE_ABSOLUTE)

/* One bucket side without per-feature dollars, and the --window name its dollars come
   back under. */
type BackfillSide = { key: string; pct: string; isMin: boolean; at: number; usd: number; name: string }

/* Up to BACKFILL_MAX_SPECS window specs for the sides that lack features, newest windows
   first, open ones included; sides read at the same moment share a spec. Windows the
   backfill could not rebuild are left out. */
function backfillPlanOf(readings: StoredReadings, context: MeterContext) {
  const sides: BackfillSide[] = []
  const names = new Map<string, string>()
  const newestFirst = Object.entries(readings)
    .filter(([, r]) => r.org === context.subscription && r.pricesId === context.pricesId && !r.featuresUnverified && SPAN_MS[r.kind])
    .sort(([, a], [, b]) => Date.parse(b.resetsAt) - Date.parse(a.resetsAt))
  for (const [key, r] of newestFirst) {
    const since = new Date(Date.parse(r.resetsAt) - (SPAN_MS[r.kind] ?? 0)).toISOString()
    for (const [pct, b] of Object.entries(r.byPct))
      for (const isMin of [true, false]) {
        if ((isMin ? b.minX : b.maxX) !== undefined) continue
        const at = isMin ? b.minAt : b.maxAt
        const spec = `${since},${r.resetsAt},${new Date(at).toISOString()}`
        let name = names.get(spec)
        if (name === undefined) {
          if (names.size >= BACKFILL_MAX_SPECS) return { sides, names }
          name = `bf${names.size}`
          names.set(spec, name)
        }
        sides.push({ key, pct, isMin, at, usd: isMin ? b.minUsd : b.maxUsd, name })
      }
  }
  return { sides, names }
}

/* The window with one side's per-feature dollars as record() stores them: new keys
   appended in sorted order, values in units of 1e-6. */
function withSideFeatures(r: StoredReading, pct: string, isMin: boolean, x: Record<string, number>): StoredReading {
  const b = r.byPct[pct]
  if (!b) return r
  const known = r.features ?? []
  const features = [
    ...known,
    ...Object.keys(x)
      .filter(f => !known.includes(f))
      .sort(),
  ]
  const values = features.map(f => Math.round((x[f] ?? 0) * X_UNIT) / X_UNIT)
  return { ...r, features, byPct: { ...r.byPct, [pct]: isMin ? { ...b, minX: values } : { ...b, maxX: values } } }
}

/* One helper call that rescans the dollars of sides stored without features. A side is
   filled when its rescanned dollars match the stored ones; otherwise its window is marked
   and not tried again. A failed call changes nothing; the next measure tries again. */
async function backfillOnce(host: Host, context: MeterContext) {
  const plan = backfillPlanOf(((await host.get(READINGS_KEY)) ?? {}) as StoredReadings, context)
  if (plan.sides.length === 0) return
  const extra = [...plan.names].flatMap(([spec, name]) => ['--window', `${name},${spec}`])
  const result = await runHelper<WindowsOutput>(host, extra, BACKFILL_TIMEOUT_MS)
  const out = result.out
  if (!out?.windows) {
    host.log(`usage-dollars: backfill: ${result.error ?? 'no windows in the helper output'}`)
    return
  }
  if (subscriptionOf(out.org) !== context.subscription || out.pricesId !== context.pricesId) {
    host.log('usage-dollars: backfill: the helper scanned another subscription or price table')
    return
  }
  const tallies = out.windows
  const now = await host.now()
  await exclusively(async () => {
    const readings = ((await host.get(READINGS_KEY)) ?? {}) as StoredReadings
    const next = { ...readings }
    let isChanged = false
    for (const s of plan.sides) {
      const r = next[s.key]
      const b = r?.byPct[s.pct]
      const x = tallies[s.name]
      if (!r || !b || r.featuresUnverified || !x?.byFeature) continue
      const isUnchanged = (s.isMin ? b.minAt : b.maxAt) === s.at && (s.isMin ? b.minUsd : b.maxUsd) === s.usd
      if (!isUnchanged || (s.isMin ? b.minX : b.maxX) !== undefined) continue
      next[s.key] =
        Math.abs(x.usd - s.usd) <= toleranceOf(s.usd) ? withSideFeatures(r, s.pct, s.isMin, x.byFeature) : { ...r, featuresUnverified: true }
      isChanged = true
    }
    if (isChanged) await host.set(READINGS_KEY, withinSize(next, now))
  })
}

/* Closed windows of one kind in the subscription's current regime, as seen from it, that
   hold readings, with their store keys. */
function regimeWindowsOf(readings: StoredReadings, context: MeterContext, kind: Kind, startedAt: number, now: number) {
  return Object.entries(readings)
    .filter(
      ([, r]) =>
        r.org === context.subscription &&
        r.pricesId === context.pricesId &&
        r.kind === kind &&
        Date.parse(r.resetsAt) <= now &&
        Date.parse(r.resetsAt) >= startedAt,
    )
    .map(([key, r]) => ({ key, w: regimeView(r, startedAt) as StoredReading }))
    .filter(({ w }) => Object.keys(w.byPct).length > 0)
}

/* What the model fit rests on, read from the store. On plans with a Fable cap, the weeks
   that reached it and the 5-hour windows after it are left out, under the weights of the
   stored fit `was`; a week it left out stays out. */
async function meterInputOf(host: Host, context: MeterContext, was: MeterEntry | undefined) {
  const now = await host.now()
  const readings = ((await host.get(READINGS_KEY)) ?? {}) as StoredReadings
  const regimes = ((await host.get(REGIMES_KEY)) ?? {}) as Regimes
  const all = Object.values(readings).filter(r => r.pricesId === context.pricesId)
  const resolution = resolutionOf(all)
  const regimeStarts: Record<string, number> = {}
  const closed: Record<string, { key: string; w: StoredReading }[]> = {}
  let capped: Record<string, number> | undefined
  const cappedCounts: Record<string, number> = {}
  if (context.share !== undefined) {
    const tableReadings = Object.fromEntries(Object.entries(readings).filter(([, r]) => r.pricesId === context.pricesId)) as StoredReadings
    capped = cappedWeeksOf(
      weeksOf(tableReadings, context.subscription),
      context.share,
      fableWeightsOf(was, context.pricesId).weights,
      was?.pricesId === context.pricesId ? was?.capped : undefined,
    )
  }
  const moments = capped ? capMomentsOf(capped, readings) : []
  for (const kind of KINDS) {
    regimeStarts[kind] = regimeStart(regimes, context.subscription, kind)
    const windows = regimeWindowsOf(readings, context, kind, regimeStarts[kind] ?? 0, now)
    const kept = capped ? windows.filter(({ key, w }) => !isLeftOutForFable(kind, key, w, capped!, moments)) : windows
    cappedCounts[kind] = windows.length - kept.length
    closed[kind] = kept
  }
  const qualifying = (kind: Kind) => (closed[kind] ?? []).filter(({ w }) => isFeatureComplete(w))
  return {
    now,
    resolution,
    regimeStarts,
    closed,
    capped,
    cappedCounts,
    fiveHour: qualifying('five_hour'),
    weekly: qualifying('seven_day'),
    /* Closed windows of every subscription that may show the rounding rule, as the measure
       takes them. */
    forRounding: all.filter(r => Date.parse(r.resetsAt) <= now && !isStraddling(r, regimes)),
  }
}

/* Scores the windows that qualify since the stored fit, under its weights for their kind
   and under M0, before the refit; a kind's records are cleared when its regime or the
   price table changed. */
function prospectiveOf(was: MeterEntry | undefined, input: Awaited<ReturnType<typeof meterInputOf>>, pricesId: string | undefined) {
  let records = [...(was?.prospective ?? [])]
  if (!was) return records
  for (const kind of KINDS) {
    if (was.regimeStarts[kind] !== input.regimeStarts[kind] || was.pricesId !== pricesId) {
      records = records.filter(p => p.kind !== kind)
      continue
    }
    const fit = was.fits?.[kind]
    if (!fit) continue
    const seen = new Set(was.included?.[kind] ?? [])
    const fresh = (kind === 'five_hour' ? input.fiveHour : input.weekly).filter(({ key }) => !seen.has(key)).map(({ w }) => w)
    records.push(...prospectiveScore(fit, fresh, { resolution: input.resolution, rounding: was.rounding }))
  }
  return records.slice(-PROSPECTIVE_KEPT)
}

/* The stored model fit of the subscription, refitted when its fingerprint changed: model
   selection on the 5-hour windows under the union, the rounding rule from the weighted
   views it gives, selection again under that rule, then the transfer to the weeks. Of the
   estimates, only Fable's window uses it. */
async function refreshMeter(host: Host, context: MeterContext): Promise<MeterEntry | undefined> {
  const was = (((await host.get(METER_KEY)) ?? {}) as StoredMeter)[context.subscription]
  const input = await meterInputOf(host, context, was)
  const fingerprint = fingerprintOf({
    fiveHour: input.fiveHour,
    weekly: input.weekly,
    regimeStarts: input.regimeStarts,
    pricesId: context.pricesId,
    schema: SCHEMA,
    stamp: HOOKS_STAMP,
  })
  const capped = input.capped ? { capped: input.capped } : {}
  if (was?.fingerprint === fingerprint) {
    if (isSame(was.capped, input.capped)) return was
    /* A week capped while still open leaves the fit's windows as they were. */
    const updated: MeterEntry = { ...was, ...capped }
    const stored = ((await host.get(METER_KEY)) ?? {}) as StoredMeter
    await host.set(METER_KEY, { ...stored, [context.subscription]: updated })
    return updated
  }
  const prospective = prospectiveOf(was, input, context.pricesId)
  const { resolution } = input
  const fiveHour = input.fiveHour.map(({ w }) => w)
  const first = selectModel(fiveHour, { resolution, rounding: 'union' })
  const views = input.forRounding.flatMap(r => weightedView(r, first.weights) ?? [])
  const rounding = roundingEvidence(views, resolution).rule
  const selection = rounding === 'union' ? first : selectModel(fiveHour, { resolution, rounding })
  const transfer = transferCheck(input.weekly.map(({ w }) => w), selection.weights, { resolution, rounding })
  const entry: MeterEntry = {
    fingerprint,
    included: { five_hour: input.fiveHour.map(({ key }) => key), seven_day: input.weekly.map(({ key }) => key) },
    regimeStarts: input.regimeStarts,
    ...(context.pricesId !== undefined ? { pricesId: context.pricesId } : {}),
    rounding,
    selection,
    transfer,
    fits: {
      five_hour: {
        weights: selection.weights,
        omega: selection.fits[selection.selected]?.omega ?? UNFITTED_OMEGA,
        omegaM0: selection.fits.M0?.omega ?? UNFITTED_OMEGA,
      },
      seven_day: transfer.isRejected
        ? { weights: UNIT_WEIGHTS, omega: transfer.omega.M0, omegaM0: transfer.omega.M0 }
        : { weights: selection.weights, omega: transfer.omega.selected, omegaM0: transfer.omega.M0 },
    },
    prospective,
    ...capped,
  }
  if (!isSame(entry, was)) {
    const stored = ((await host.get(METER_KEY)) ?? {}) as StoredMeter
    await host.set(METER_KEY, { ...stored, [context.subscription]: entry })
  }
  return entry
}

/** The status line: what is left of each window's allowance. */
export function statusOf(summary: Pick<Summary, 'windows' | 'fable'>, isPlanUnseen: boolean) {
  const f = summary.fable
  return statusLine(
    summary.windows.map(s => ({ short: s.short, usedUsd: s.tally.usd, allowance: s.estimate?.allowance, left: s.leftByPercent ?? s.estimate?.left })),
    isPlanUnseen,
    f ? { usedUsd: f.usedUsd, left: f.left, isCapLikely: f.isCapLikely } : undefined,
  )
}

/* One scan at a time, at most once a minute unless forced or fresh. A fresh call that
   meets a running scan is queued and runs, forced, once that scan settles. */
export function refresh(host: Host, limits?: readonly SessionRateLimit[], isForced = false, isFresh = false, receivedAt?: number) {
  if (running) {
    if (isFresh) pendingFresh = { host, limits, receivedAt }
    return running
  }
  if (!isForced && !isFresh && Date.now() - lastRunAt < MIN_GAP_MS) return Promise.resolve(last)
  lastRunAt = Date.now()
  running = measure(host, limits, isFresh, receivedAt)
    .then(summary => (last = summary ?? last))
    .catch(error => {
      host.log(`usage-dollars: ${String(error)}`)
      return last
    })
    .finally(() => {
      running = undefined
      const queued = pendingFresh
      pendingFresh = undefined
      if (queued) void refresh(queued.host, queued.limits, true, true, queued.receivedAt)
    })
  return running
}

/** A forced measure that starts after any measure already running. */
export async function remeasure(host: Host) {
  if (running) await running
  return refresh(host, undefined, true)
}

/* Past rate-limit rejections, each a window seen exactly full; rescanned every six hours. */
export async function refreshHistory(host: Host) {
  const subscription = await resolveSubscription(host)
  const now = await host.now()
  const kept = ((await host.get(HISTORY_KEY)) ?? {}) as History
  if (kept[subscription] && now - kept[subscription].scannedAt < HISTORY_REFRESH_MS) return
  const { out, error } = await runHelper<HelperBase & { observations?: Observation[] }>(
    host,
    ['--history', String(HISTORY_DAYS)],
    180_000,
  )
  if (!out?.observations) {
    host.log(`usage-dollars: history: ${error ?? 'no observations'}`)
    return
  }
  const stored = ((await host.get(HISTORY_KEY)) ?? {}) as History
  await host.set(HISTORY_KEY, { ...stored, [subscriptionOf(out.org)]: { scannedAt: now, observations: out.observations } })
  void refresh(host, undefined, true)
}

/** Restarts the estimates of the session's subscription from now. */
export async function resetEstimates(host: Host) {
  const subscription = await resolveSubscription(host)
  const now = await host.now()
  const regimes = ((await host.get(REGIMES_KEY)) ?? {}) as Regimes
  await host.set(REGIMES_KEY, startOver(regimes, subscription, now))
  await remeasure(host)
}

/** Undoes the latest reset when nothing observed has followed it. */
export async function undoReset(host: Host) {
  const subscription = await resolveSubscription(host)
  const regimes = ((await host.get(REGIMES_KEY)) ?? {}) as Regimes
  const result = undoStartOver(regimes, subscription)
  if (result.isUndone) await host.set(REGIMES_KEY, result.regimes)
  await remeasure(host)
  return result.isUndone
}

/** Marks every queued notice seen: the card has been shown. */
export async function markNoticesSeen(host: Host) {
  const queue = ((await host.get(NOTICES_KEY)) ?? []) as Notice[]
  if (queue.every(n => n.isSeen)) return
  await host.set(NOTICES_KEY, queue.map(n => ({ ...n, isSeen: true })))
}

/** The texts of this subscription's notices not toasted yet, marked toasted. */
export async function takeToasts(host: Host) {
  if (!lastSubscription) return []
  const queue = ((await host.get(NOTICES_KEY)) ?? []) as Notice[]
  const due = queue.filter(n => n.org === lastSubscription && !n.isToasted)
  if (due.length === 0) return []
  const ids = new Set(due.map(n => n.id))
  await host.set(NOTICES_KEY, queue.map(n => (ids.has(n.id) ? { ...n, isToasted: true } : n)))
  return due.map(n => n.text)
}

export function toReport(summary: Summary, now: number): UsageReport {
  const windows: WindowReport[] = summary.windows.map(s => {
    const isFallen = s.fellAt !== undefined
    const left = s.leftByPercent ?? s.estimate?.left
    return {
      title: s.title,
      short: s.short,
      usedUsd: s.tally.usd,
      requests: s.tally.requests,
      resetLong: s.tally.resetLong ?? s.resetsAt,
      resetIn: s.tally.resetIn ?? '',
      left: left ? { value: Math.max(0, left.value), low: Math.max(0, left.low), high: Math.max(0, left.high) } : undefined,
      allowance: s.estimate?.allowance,
      confidence: s.estimate?.confidence,
      nextTick: isFallen ? undefined : s.estimate?.nextTick,
      pastWeight: s.estimate?.pastWeight,
      isPriorContradicted: s.estimate?.isPriorContradicted,
      isSpreadAssumed: s.estimate?.isSpreadAssumed,
      percent: s.percent,
      percentAgeMinutes: s.percentAt !== undefined ? Math.max(0, Math.round((now - s.percentAt) / MINUTE_MS)) : undefined,
      basis: basisOf(s.estimate, s.isUnpriced, s.sinceResetLabel, isFallen),
      isCalibrated: s.calibration.isCalibrated,
      ...(isFallen ? { isFallen } : {}),
    }
  })
  const widest = summary.windows[summary.windows.length - 1]
  const byModel: ModelSpend[] = Object.entries(widest?.tally.byModel ?? {})
    .map(([model, spend]) => ({ model, ...spend }))
    .sort((a, b) => b.usd - a.usd)
  return {
    type: 'windows',
    plan: summary.plan,
    notices: summary.notices,
    last24hUsd: summary.last24hUsd,
    sinceResetLabel: summary.sinceResetLabel,
    windows,
    ...(summary.fable ? { fable: summary.fable } : {}),
    byModel,
    byModelTitle: `By model · ${(widest?.title ?? '').toLowerCase()}`,
    notes: notesOf(widest?.tally),
    files: summary.files,
    ms: summary.ms,
  }
}

function notesOf(t: Omit<WindowTally, 'byModel' | 'usd' | 'requests'> | undefined) {
  const notes: string[] = []
  if (t && t.otherSubscriptionsUsd > 0)
    notes.push(`Other subscriptions spent ${money(t.otherSubscriptionsUsd)} in this period; not counted here.`)
  if (t && t.unattributedUsd > 0)
    notes.push(`${money(t.unattributedUsd)} came from sessions with no subscription record; not counted here.`)
  if (t && t.unpricedRequests > 0)
    notes.push(`${t.unpricedRequests} requests to unpriced models (${t.unpricedModels.join(', ')}); not counted here.`)
  return notes
}

/** Spending in a range: `range` is the helper's `--report` or `--report-local` argument pair. */
export async function spendReport(host: Host, range: readonly string[]): Promise<SpendReport | { error: string }> {
  const { out, error } = await runHelper<ReportOutput>(host, range, 180_000)
  if (!out) return { error: error ?? 'no report' }
  const notes = notesOf(out)
  if (out.transcriptsBeginLabel)
    notes.push(`Transcripts on this machine begin ${out.transcriptsBeginLabel}; earlier spending is not included.`)
  return {
    type: 'report',
    fromLabel: out.fromLabel,
    toLabel: out.toLabel,
    usedUsd: out.usd,
    requests: out.requests,
    byDay: out.byDay,
    byModel: Object.entries(out.byModel)
      .map(([model, spend]) => ({ model, ...spend }))
      .sort((a, b) => b.usd - a.usd),
    notes,
  }
}

/** What this session has seen of other sessions and of its own readings. */
export const diagnosticsOf = (): Readonly<Diagnostics> => diagnostics

/* The helper's limit diagnostics: quotaLimits records it does not measure, grouped, and the
   requests whose usage carries a fallback credit. */
type UnknownLimit = { kind: string | null; status: string | null; overageStatus: string | null; isUsingOverage: boolean; count: number; lastAt: string | null }

type CheckSummary = {
  sessions: number
  medianRatio: number | null
  lowRatio: number | null
  highRatio: number | null
  unknownLimits?: UnknownLimit[]
  creditMarked?: { requests: number; lastAt: string | null }
  error?: string
}

type Unrecorded = 'unpriced' | 'unattributed' | 'fell'

const NOT_RECORDED: Record<Unrecorded, string> = {
  unpriced: 'too many of its requests go to unpriced models (see Prices)',
  unattributed: 'the subscription is a guess (see Subscription)',
  fell: 'the reported percent fell in this window, as after a limit reset',
}

/* Rate limits Claude Code reported or recorded that this module does not measure. */
function limitsItem(liveKinds: readonly string[], check: CheckSummary | undefined): CheckItem {
  const parts: string[] = []
  if (liveKinds.length > 0) parts.push(`reported live: ${liveKinds.join(', ')}`)
  const groups = check?.unknownLimits ?? []
  if (groups.length > 0)
    parts.push(
      `in transcripts: ${groups
        .map(g => `${g.kind ?? 'no kind'} ${g.status ?? 'no status'}, overage ${g.overageStatus ?? 'none'}, ×${g.count}, last ${g.lastAt ?? 'unknown'}`)
        .join('; ')}`,
    )
  const credited = check?.creditMarked?.requests ?? 0
  if (credited > 0) parts.push(`${credited} request${credited === 1 ? ' carries' : 's carry'} a fallback credit`)
  return { label: 'Limits not measured', state: 'info', text: parts.length > 0 ? `${parts.join('; ')}.` : 'none' }
}

const titles = (list: readonly string[]) => list.join(' and ')

function subscriptionItem(orgSource: OrgSource | null | undefined, hasOrg: boolean): CheckItem {
  const label = 'Subscription'
  if (orgSource === 'most recent')
    return {
      label,
      state: 'fail',
      text: 'Only guessed, from the most recently used one, so no readings are recorded. Sign in to Claude Code (/login).',
    }
  if (!hasOrg) return { label, state: 'info', text: 'None (an API key): there are no limits to read and no estimates.' }
  return {
    label,
    state: 'ok',
    text: orgSource === 'session' ? "Named by this session's own record." : 'Named by the signed-in profile.',
  }
}

function readingsItem(outcomes: Diagnostics['outcomes']): CheckItem {
  const label = 'Readings'
  const entries = Object.entries(outcomes)
  const missing = entries.filter(([, list]) => list.some(o => o.outcome === 'missing')).map(([title]) => title)
  if (missing.length > 0)
    return {
      label,
      state: 'fail',
      text: `A percent of the ${titles(missing)} was not recorded and nothing explains it. Please report it, with the debug log.`,
    }
  const reasons = entries.flatMap(([title, list]) =>
    list
      .map(o => o.outcome)
      .filter((o): o is Unrecorded => o === 'unpriced' || o === 'unattributed' || o === 'fell')
      .map(o => `${title}: not recorded, ${NOT_RECORDED[o]}`),
  )
  if (reasons.length > 0) return { label, state: 'info', text: `${[...new Set(reasons)].join('; ')}.` }
  if (entries.length > 0) return { label, state: 'ok', text: `Recorded for the ${titles(entries.map(([title]) => title))}.` }
  return { label, state: 'info', text: 'None received in this session yet: a reading is taken after every reply.' }
}

/* The subscription's stored windows by the state of their per-feature dollars: complete;
   marked by the backfill; waiting for it; or carrying features that do not add up. */
function breakdownOf(readings: StoredReadings, subscription: string) {
  const counts = { total: 0, complete: 0, unverified: 0, waiting: 0, inconsistent: 0 }
  for (const r of Object.values(readings)) {
    if (r.org !== subscription || Object.keys(r.byPct).length === 0) continue
    counts.total++
    if (isFeatureComplete(r)) counts.complete++
    else if (r.featuresUnverified) counts.unverified++
    else if (Object.values(r.byPct).some(b => !b.minX || !b.maxX)) counts.waiting++
    else counts.inconsistent++
  }
  return counts
}

function breakdownItem(readings: StoredReadings, subscription: string): CheckItem {
  const label = 'Model breakdown'
  const { total, complete, unverified, waiting, inconsistent } = breakdownOf(readings, subscription)
  if (total === 0) return { label, state: 'info', text: 'No stored windows yet.' }
  const carry = `${complete} of ${total} stored window${total === 1 ? ' carries' : 's carry'} dollars per model and token class`
  const wait = waiting > 0 ? ` ${waiting} wait for the backfill, which runs after each measure.` : ''
  const failures: string[] = []
  if (unverified > 0)
    failures.push(
      `${unverified} could not be rebuilt: the transcripts no longer give their stored dollars, so the model fit leaves them out.`,
    )
  if (inconsistent > 0)
    failures.push(`${inconsistent} carry dollars per model that do not add up to their dollars. Please report it, with the debug log.`)
  if (failures.length > 0) return { label, state: 'fail', text: `${carry}; ${failures.join(' ')}${wait}` }
  return { label, state: 'info', text: `${carry}.${wait}` }
}

function pricesItem(check: CheckSummary, unpriced: readonly string[]): CheckItem {
  const label = 'Prices'
  const update = 'Update PRICES in scripts/usage-cost.mjs; doing so drops the stored readings and calibration starts again.'
  const failures: string[] = []
  if (unpriced.length > 0) failures.push(`More than 2% of the ${titles(unpriced)}'s requests go to unpriced models.`)
  const { medianRatio: median, lowRatio: low, highRatio: high, sessions } = check
  const over = `over ${sessions} session${sessions === 1 ? '' : 's'}`
  if (median !== null && (median < MIN_PRICE_RATIO || median > MAX_PRICE_RATIO))
    failures.push(`These dollars are ${median} times Claude Code's own costs (median ${over}).`)
  if (failures.length > 0) return { label, state: 'fail', text: `${failures.join(' ')} ${update}` }
  if (check.error) return { label, state: 'info', text: `Not compared with Claude Code's own costs: ${check.error}` }
  if (median === null) return { label, state: 'info', text: "No session of at least $0.50 to compare with Claude Code's own costs." }
  return {
    label,
    state: 'ok',
    text: `These dollars are ${median} times Claude Code's own costs (median ${over}; 5th to 95th percentile ${low} to ${high}).`,
  }
}

/** The setup check: a forced measure, then the helper, the subscription, other sessions'
    hooks and price table, this session's readings, and the prices. */
export async function checkReport(host: Host): Promise<CheckReport> {
  const summary = await remeasure(host)
  const who = await runHelper<HelperBase>(host, ['--whoami'], 30_000).catch(error => ({ out: undefined, error: String(error) }))
  if (!who.out)
    return {
      type: 'check',
      items: [
        {
          label: 'Helper',
          state: 'fail',
          text: `The transcript scan does not run (${who.error ?? 'no output'}). Install Node.js 18 or later on PATH, then restart Claude Code.`,
        },
      ],
    }
  const items: CheckItem[] = [{ label: 'Helper', state: 'ok', text: 'Node.js runs the transcript scan.' }]
  items.push(subscriptionItem(summary ? summary.orgSource : who.out.orgSource, summary ? summary.subscription !== NONE : Boolean(who.out.org)))

  const { otherHooks, droppedForPrices, outcomes } = diagnostics
  items.push(
    otherHooks === 'older'
      ? {
          label: 'Other hooks',
          state: 'fail',
          text: 'A session running older hooks stored a percent since this one started. Restart the other sessions, and load only one copy of the plugin.',
        }
      : otherHooks === 'newer'
        ? {
            label: 'Other hooks',
            state: 'fail',
            text: 'A session running newer hooks stored a percent since this one started. Restart this session, and load only one copy of the plugin.',
          }
        : { label: 'Other hooks', state: 'ok', text: 'No session with other hooks seen since this one started.' },
  )
  items.push(
    droppedForPrices > 0
      ? {
          label: 'Price table',
          state: 'fail',
          text:
            `${droppedForPrices} stored window${droppedForPrices === 1 ? ' was' : 's were'} dropped, priced with another table: ` +
            'another session runs a different usage-cost.mjs, or the table was just updated.',
        }
      : { label: 'Price table', state: 'ok', text: 'Every stored reading is priced with this table.' },
  )
  items.push(readingsItem(outcomes))
  if (summary) items.push(breakdownItem(((await host.get(READINGS_KEY)) ?? {}) as StoredReadings, summary.subscription))

  const check = await runScript<CheckSummary>(host, ['--check-summary'], 120_000).catch(error => ({ out: undefined, error: String(error) }))
  const unpriced = (summary?.windows ?? []).filter(s => s.isUnpriced).map(s => s.title)
  items.push(
    pricesItem(check.out ?? { sessions: 0, medianRatio: null, lowRatio: null, highRatio: null, error: check.error ?? 'no output' }, unpriced),
  )
  items.push(limitsItem(diagnostics.unknownKinds, check.out))
  items.push({
    label: 'Other usage',
    state: 'info',
    text: 'Usage on other machines and on claude.ai is not counted and makes the allowance look smaller; an "inferred change" notice is the sign of it.',
  })
  return { type: 'check', items }
}

export function toCalibrationReport(summary: Summary): CalibrationReport {
  return {
    type: 'calibration',
    windows: summary.windows.map(s => {
      const c = s.calibration
      return {
        title: s.title,
        levels: c.levels,
        ticks: c.ticks,
        closedWindows: c.closedWindows,
        closedForWithin: c.closedForWithin,
        isWithinMeasured: c.isWithinMeasured,
        pastPoints: c.pastPoints,
        pastWeight: c.pastWeight,
        isBetweenMeasured: c.isBetweenMeasured,
        closedForRounding: c.closedForRounding,
        roundingNeeded: MIN_ROUNDING_WINDOWS,
        isRoundingKnown: c.isRoundingKnown,
        rounding: c.rounding,
        measured: c.measured,
        isCalibrated: c.isCalibrated,
        halfWidth: c.halfWidth,
        ...(c.fableCapped !== undefined ? { fableCapped: c.fableCapped } : {}),
      }
    }),
  }
}

/* "Fable 5.1" for claude-fable-5-1; a key of another shape as it is. */
function priceKeyLabel(priceKey: string) {
  const parts = /^claude-([a-z]+)-(\d+(?:-\d+)*)$/.exec(priceKey)
  const name = parts?.[1]
  const version = parts?.[2]
  return name && version ? `${name.charAt(0).toUpperCase()}${name.slice(1)} ${version.replace(/-/g, '.')}` : priceKey
}

function groupLabel(group: string) {
  if (group === 'all') return 'all models'
  if (group.endsWith('/read')) return `${priceKeyLabel(group.slice(0, -'/read'.length))} cache reads`
  if (group.endsWith('/other')) return `${priceKeyLabel(group.slice(0, -'/other'.length))} except cache reads`
  return priceKeyLabel(group)
}

function fitReport(f: FitResult): ModelsFit {
  const t = tQuantile(0.95, Math.max(1, f.df))
  return {
    model: f.model,
    reference: f.groups.reference,
    referenceLabel: groupLabel(f.groups.reference),
    groups: f.groups.free.map((key, g) => {
      const theta = f.theta[g] ?? 0
      const half = t * (f.se[g] ?? 0)
      return {
        key,
        label: groupLabel(key),
        weight: { value: Math.exp(theta), low: Math.exp(theta - half), high: Math.exp(theta + half) },
        information: f.information[g] ?? 0,
      }
    }),
    omega: f.omega,
    windows: f.windows,
    segments: f.segments,
    df: f.df,
  }
}

const EMPTY_SELECTION: Selection = {
  selected: 'M0',
  weights: UNIT_WEIGHTS,
  rounding: 'union',
  fits: {},
  comparisons: [],
  windows: { used: 0, excluded: {} },
  segments: 0,
  excludedSegments: 0,
}

const spreadOf = (s: { omega: number; windows: number; isAssumed: boolean }) => ({ omega: s.omega, windows: s.windows, isAssumed: s.isAssumed })

/** The meter-weight study: a forced measure, then the subscription's model fit, refitted
    when new windows qualify. */
export async function modelsReport(host: Host): Promise<ModelsReport> {
  const summary = await remeasure(host)
  await backfillSettled()
  const context = meterContext && (!summary || summary.subscription === meterContext.subscription) ? meterContext : undefined
  const entry = context
    ? await refreshMeter(host, context).catch(error => {
        host.log(`usage-dollars: model fit: ${String(error)}`)
        return undefined
      })
    : undefined
  const input = context ? await meterInputOf(host, context, entry) : undefined
  const selection = entry?.selection ?? EMPTY_SELECTION
  const rounding = entry?.rounding ?? 'union'

  /* Closed 5-hour windows of the regime without complete features, live. */
  const incomplete = (input?.closed.five_hour ?? []).filter(({ w }) => !isFeatureComplete(w))
  const unverified = incomplete.filter(({ w }) => w.featuresUnverified).length
  const excluded = [
    { reason: 'dollars per model not stored yet', count: incomplete.length - unverified },
    { reason: 'dollars per model could not be rebuilt', count: unverified },
    { reason: 'fewer than 2 segments', count: selection.windows.excluded['too-few-segments'] ?? 0 },
    { reason: 'Fable at or past its weekly cap', count: input?.cappedCounts.five_hour ?? 0 },
  ].filter(e => e.count > 0)
  const cappedWeeks = input?.cappedCounts.seven_day ?? 0

  /* A week and no 5-hour limit, in the forced measure and in the readings of the last 7
     days, on an installation whose weekly readings go back at least a day. */
  const now = await host.now()
  const readings = ((await host.get(READINGS_KEY)) ?? {}) as StoredReadings
  const own = summary ? Object.values(readings).filter(r => r.org === summary.subscription) : []
  const firstWeekly = Math.min(
    ...own.filter(r => r.kind === 'seven_day').flatMap(r => Object.values(r.byPct).map(b => b.minAt)),
  )
  const isFiveHourAbsent =
    summary !== undefined &&
    summary.windows.some(s => s.kind === 'seven_day') &&
    !summary.windows.some(s => s.kind === 'five_hour') &&
    !own.some(r => r.kind === 'five_hour' && Date.parse(r.resetsAt) > now - 7 * DAY_MS) &&
    firstWeekly <= now - DAY_MS

  const omegas = input
    ? KINDS.map(kind => {
        const closed = (input.closed[kind] ?? []).map(({ w }) => w)
        const weights = entry?.fits[kind]?.weights ?? UNIT_WEIGHTS
        const views = closed.flatMap(w => weightedView(w, weights) ?? [])
        return {
          title: KIND_TITLES[kind],
          M0: spreadOf(calibrateOmega(closed, kind, input.now, input.resolution, rounding)),
          selected: spreadOf(calibrateOmega(views, kind, input.now, input.resolution, rounding)),
        }
      })
    : []

  const prospective = KINDS.map(kind => {
    const d = (entry?.prospective ?? []).filter(p => p.kind === kind).map(p => p.d)
    const n = d.length
    const sum = d.reduce((a, b) => a + b, 0)
    const variance = n > 1 ? d.reduce((a, b) => a + (b - sum / n) ** 2, 0) / (n - 1) : 0
    return { title: KIND_TITLES[kind], n, sum, se: Math.sqrt(n * variance) }
  })

  const transfer = entry?.transfer
  const models: readonly FitResult['model'][] = ['M0', 'M1', 'M2']
  return {
    type: 'models',
    isFitted: selection.fits.M0 !== undefined,
    qualifying: selection.windows.used,
    needed: FIT_MIN_WINDOWS,
    windows: { used: selection.windows.used, excluded },
    segments: selection.segments,
    excludedSegments: selection.excludedSegments,
    fits: models.flatMap(m => {
      const f = selection.fits[m]
      return f ? [fitReport(f)] : []
    }),
    comparisons: selection.comparisons.map(c => ({ ...c })),
    selected: selection.selected,
    rounding,
    transfer: {
      isChecked: transfer?.isChecked ?? false,
      isRejected: transfer?.isRejected ?? false,
      days: transfer?.days ?? 0,
      delta: transfer?.delta ?? 0,
      se: transfer?.se ?? 0,
      weeks: transfer?.weeks ?? 0,
      ...(transfer?.weeklyFit ? { weeklyFit: fitReport(transfer.weeklyFit) } : {}),
    },
    omegas,
    prospective,
    ...(isFiveHourAbsent ? { isFiveHourAbsent } : {}),
    ...(cappedWeeks > 0 ? { cappedWeeks } : {}),
  }
}

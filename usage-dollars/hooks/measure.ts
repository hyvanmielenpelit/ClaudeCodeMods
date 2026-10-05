/* Measurement: runs the transcript scan, keeps readings and plan history in $.store keyed
   by subscription, and turns them into estimates. The engine reaches this module through
   a Host that register.tsx builds, since $ itself never crosses an import.

   $.store is one store shared by every running session, so each key is read immediately
   before it is written, with no wait on the helper in between, and the plan, regime,
   promotion and notice keys are written only when they changed. */

import type { SessionRateLimit } from 'claude-code'

import type { CalibrationReport, CheckItem, CheckReport, ModelSpend, PlanReport, SpendReport, UsageReport, WindowReport } from '../types'
import { money, statusLine } from './card'
import {
  MIN_ROUNDING_WINDOWS,
  calibrateOmega,
  calibrationOf,
  estimate,
  pastPoints,
  prior,
  record,
  regimeView,
  resolutionOf,
  roundingEvidence,
} from './estimate'
import type { Calibration, Estimate, Rounding, WindowReadings } from './estimate'
import { activePromotions, addRegimes, currentRegime, observePlan, observePromotions, planLabel, regimeStart, startOver, undoStartOver } from './plan'
import type { Kind, Ledger, NoticeDraft, PlanEntry, Profile, Promotions, Regime, Regimes } from './plan'

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const MIN_GAP_MS = MINUTE_MS
const FRESH_MS = 5 * MINUTE_MS
const READINGS_KEPT_MS = 28 * DAY_MS
const HISTORY_DAYS = 14
const HISTORY_REFRESH_MS = 6 * HOUR_MS
const NOTICE_SHOWN_MS = 7 * DAY_MS
const STALE_PROFILE_MS = 7 * DAY_MS
const KEPT_NOTICES = 20
/* Above this share of a window's requests going to unpriced models, its dollars no longer
   track the limit. */
const MAX_UNPRICED_SHARE = 0.02
const SCHEMA = 4
/* What the limits and readings this module stores mean; raise it whenever that changes.
   A stored limit without one is stamp 0. */
const HOOKS_STAMP = 1
const NONE = 'none'
/* The suffixes of a window's further tallies: up to the moment this session received its
   percent, and up to the moment the stored percent was received. */
const AT_READ = '@read'
const AT_STORED = '@stored'
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

export const INFERRED_TEXT =
  'Usage no longer matches recent windows: limits may have changed, or this subscription was used elsewhere ' +
  '(inferred from usage, not from the plan). If you changed plans, run /usage-dollars reset.'

const WINDOWS: readonly { kind: Kind; name: string; title: string; short: string; spanMs: number }[] = [
  { kind: 'five_hour', name: 'session', title: '5-hour window', short: '5h', spanMs: 5 * HOUR_MS },
  { kind: 'seven_day', name: 'week', title: 'This week', short: 'Week', spanMs: 7 * DAY_MS },
]

const SPAN_MS: Record<string, number> = { five_hour: 5 * HOUR_MS, seven_day: 7 * DAY_MS }

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

type StoredReadings = Record<string, WindowReadings & { org: string }>

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
   the current 90% range, in proportion. */
type WindowCalibration = Calibration & { closedWindows: number; rounding: Rounding; halfWidth?: number }

type WindowState = {
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
}

/* Why a percent a measure could have recorded was not: `missing` when nothing explains it. */
type Outcome = 'recorded' | 'unpriced' | 'unattributed' | 'missing'

/* A percent that may be recorded: this session's fresh one, or one stored by a session
   whose reading of it may have been lost. sessionId: the session that received it. */
type Candidate = { source: 'mine' | 'stored'; tally: string; percent: number; at: number; sessionId: string }

export type Diagnostics = {
  /* Another session stored a percent with other hooks since this module first measured:
     older or newer than this one's. */
  otherHooks?: 'older' | 'newer'
  /* Stored windows dropped for another price table, over this session's measures. */
  droppedForPrices: number
  /* Per window title, what became of the percents the latest measure that had any could
     record. */
  outcomes: Record<string, { source: Candidate['source']; outcome: Outcome }[]>
}

export type Summary = {
  subscription: string
  orgSource?: OrgSource | null
  windows: WindowState[]
  plan: PlanReport
  notices: string[]
  last24hUsd?: number
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
const diagnostics: Diagnostics = { droppedForPrices: 0, outcomes: {} }

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
   percents, and is kept from schema 2 on. */
async function migrate(host: Host) {
  if (isMigrated) return
  const was = await host.get(SCHEMA_KEY)
  if (was !== SCHEMA) {
    await host.delete(LIMITS_KEY)
    await host.delete(READINGS_KEY)
    if (was !== 2 && was !== 3) await host.delete(HISTORY_KEY)
    await host.set(SCHEMA_KEY, SCHEMA)
  }
  isMigrated = true
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

function basisOf(e: Estimate | undefined, isUnpriced: boolean, sinceResetLabel: string | undefined) {
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
    const extra: string[] = []
    for (const { w, limit, candidates } of active) {
      const since = new Date(Date.parse(limit.resetsAt) - w.spanMs).toISOString()
      extra.push('--window', `${w.name},${since},${limit.resetsAt}`)
      for (const c of candidates)
        extra.push('--window', `${c.tally},${since},${limit.resetsAt},${new Date(c.at).toISOString()},${c.sessionId}`)
    }
    extra.push('--window', `last24h,${new Date(now - DAY_MS).toISOString()},${new Date(now).toISOString()}`)
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

  /* Hooks of another stamp that stored a percent since this module first measured. */
  for (const l of Object.values(storedLimits[subscription] ?? {})) {
    const stamp = l.stamp ?? 0
    if (stamp !== HOOKS_STAMP && l.observedAt > (firstMeasureAt ?? now)) diagnostics.otherHooks = stamp < HOOKS_STAMP ? 'older' : 'newer'
  }

  /* A guessed subscription must not write readings; with none at all every request is
     counted, as on a machine without bridge-session records. A reading takes its percent
     from a candidate, and only for the window the dollars were scanned for; its dollars
     end where the percent was received. Readings priced with another table are dropped. */
  const mayRecord = out.org === null || out.org === undefined || out.orgSource === 'session' || out.orgSource === 'profile'
  const pricesId = out.pricesId
  const storedReadings = ((await host.get(READINGS_KEY)) ?? {}) as StoredReadings
  const readings = Object.fromEntries(Object.entries(storedReadings).filter(([, r]) => r.pricesId === pricesId)) as StoredReadings
  diagnostics.droppedForPrices += Object.keys(storedReadings).length - Object.keys(readings).length
  const attempts: { title: string; key: string; c: Candidate; outcome?: Outcome }[] = []
  for (const { w, limit, candidates } of active) {
    const key = windowKey(subscription, w.kind, limit.resetsAt)
    for (const c of candidates) {
      if (c.source === 'stored' && hasReadingAt(readings[key], c.at)) continue
      const tally = out.windows[c.tally]
      const attempt: (typeof attempts)[number] = { title: w.title, key, c }
      attempts.push(attempt)
      if (!mayRecord) attempt.outcome = 'unattributed'
      else if (tally && isUnpricedTally(tally)) attempt.outcome = 'unpriced'
      else if (tally) {
        const was = readings[key] ?? { kind: w.kind, resetsAt: limit.resetsAt, byPct: {}, org: subscription, pricesId }
        readings[key] = { ...record(was, c.percent, tally.usd, c.at, tally.slackUsd ?? 0), org: subscription, pricesId }
      }
    }
  }
  const kept = Object.fromEntries(
    Object.entries(readings).filter(([, r]) => Date.parse(r.resetsAt) > now - READINGS_KEPT_MS),
  ) as StoredReadings
  await host.set(READINGS_KEY, kept)
  const outcomes: Diagnostics['outcomes'] = {}
  for (const a of attempts) {
    const outcome = a.outcome ?? (isHeld(kept[a.key], a.c.percent, a.c.at) ? 'recorded' : 'missing')
    outcomes[a.title] = [...(outcomes[a.title] ?? []), { source: a.c.source, outcome }]
  }
  for (const [title, list] of Object.entries(outcomes)) diagnostics.outcomes[title] = list

  const plans = ((await host.get(PLANS_KEY)) ?? {}) as Ledger
  const observedPlan = observePlan(plans, profile, subscription, now)
  if (!isSame(observedPlan.ledger, plans)) await host.set(PLANS_KEY, observedPlan.ledger)

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

  const windows: WindowState[] = []
  for (const { w, limit } of active) {
    const tally = out.windows[w.name]
    if (!tally) continue
    const startedAt = regimeStart(regimes, subscription, w.kind)
    const regime = currentRegime(regimes, subscription, w.kind)
    /* Closed windows of this subscription and regime: one past point each, and the
       crossings that measure the within-window spread. */
    const closed = all
      .filter(r => r.org === subscription && r.kind === w.kind && Date.parse(r.resetsAt) <= now && Date.parse(r.resetsAt) >= startedAt)
      .map(r => regimeView(r, startedAt))
    const rejections = observations.filter(o => Date.parse(o.resetsAt) > now - HISTORY_DAYS * DAY_MS)
    const spread = calibrateOmega(closed, w.kind, now, resolution, rounding)
    const past = pastPoints(closed, rejections, w.kind, resolution, rounding, spread.omega).filter(p => p.at >= startedAt)
    const key = windowKey(subscription, w.kind, limit.resetsAt)
    const stored = kept[key]
    const current = stored ? regimeView(stored, startedAt) : undefined
    const isUnpriced = isUnpricedTally(tally)
    const e =
      current && !isUnpriced
        ? estimate(current, tally.usd, {
            resolution,
            rounding,
            past,
            kind: w.kind,
            now,
            livePercent: limit.observedAt !== undefined && now - limit.observedAt <= FRESH_MS ? limit.percentUsed : undefined,
            spread,
          })
        : undefined
    if (e?.isPriorContradicted) drafts.push({ id: `inferred:${key}`, kind: 'inferred', text: INFERRED_TEXT })
    windows.push({
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
      },
    })
  }
  await queueNotices(host, subscription, drafts, now)

  const queue = ((await host.get(NOTICES_KEY)) ?? []) as Notice[]
  const mine = queue.filter(n => n.org === subscription)
  const isPlanUnseen = mine.some(n => n.kind === 'plan-changed' && !n.isSeen)
  host.status(statusOf({ windows }, isPlanUnseen))

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
  ]

  return {
    subscription,
    orgSource: out.orgSource,
    windows,
    plan: planReport(event, profile, labels, now),
    notices,
    last24hUsd: out.windows.last24h?.usd,
    sinceResetLabel: windows.find(s => s.sinceResetLabel)?.sinceResetLabel,
    files: out.files,
    ms: out.ms,
  }
}

/** The status line: what is left of each window's allowance. */
export function statusOf(summary: Pick<Summary, 'windows'>, isPlanUnseen: boolean) {
  return statusLine(
    summary.windows.map(s => ({ short: s.short, usedUsd: s.tally.usd, allowance: s.estimate?.allowance, left: s.estimate?.left })),
    isPlanUnseen,
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
  const windows: WindowReport[] = summary.windows.map(s => ({
    title: s.title,
    short: s.short,
    usedUsd: s.tally.usd,
    requests: s.tally.requests,
    resetLong: s.tally.resetLong ?? s.resetsAt,
    resetIn: s.tally.resetIn ?? '',
    left: s.estimate
      ? { value: Math.max(0, s.estimate.left.value), low: Math.max(0, s.estimate.left.low), high: Math.max(0, s.estimate.left.high) }
      : undefined,
    allowance: s.estimate?.allowance,
    confidence: s.estimate?.confidence,
    nextTick: s.estimate?.nextTick,
    pastWeight: s.estimate?.pastWeight,
    isPriorContradicted: s.estimate?.isPriorContradicted,
    isSpreadAssumed: s.estimate?.isSpreadAssumed,
    percent: s.percent,
    percentAgeMinutes: s.percentAt !== undefined ? Math.max(0, Math.round((now - s.percentAt) / MINUTE_MS)) : undefined,
    basis: basisOf(s.estimate, s.isUnpriced, s.sinceResetLabel),
    isCalibrated: s.calibration.isCalibrated,
  }))
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

type CheckSummary = { sessions: number; medianRatio: number | null; lowRatio: number | null; highRatio: number | null; error?: string }

const NOT_RECORDED: Record<'unpriced' | 'unattributed', string> = {
  unpriced: 'too many of its requests go to unpriced models (see Prices)',
  unattributed: 'the subscription is a guess (see Subscription)',
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
      .filter((o): o is 'unpriced' | 'unattributed' => o === 'unpriced' || o === 'unattributed')
      .map(o => `${title}: not recorded, ${NOT_RECORDED[o]}`),
  )
  if (reasons.length > 0) return { label, state: 'info', text: `${[...new Set(reasons)].join('; ')}.` }
  if (entries.length > 0) return { label, state: 'ok', text: `Recorded for the ${titles(entries.map(([title]) => title))}.` }
  return { label, state: 'info', text: 'None received in this session yet: a reading is taken after every reply.' }
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

  const check = await runScript<CheckSummary>(host, ['--check-summary'], 120_000).catch(error => ({ out: undefined, error: String(error) }))
  const unpriced = (summary?.windows ?? []).filter(s => s.isUnpriced).map(s => s.title)
  items.push(
    pricesItem(check.out ?? { sessions: 0, medianRatio: null, lowRatio: null, highRatio: null, error: check.error ?? 'no output' }, unpriced),
  )
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
      }
    }),
  }
}

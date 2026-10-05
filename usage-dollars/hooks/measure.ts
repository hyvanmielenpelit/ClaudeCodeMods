/* Measurement: runs the transcript scan, keeps readings and plan history in $.store keyed
   by subscription, and turns them into estimates. The engine reaches this module through
   a Host that register.tsx builds, since $ itself never crosses an import.

   $.store is one store shared by every running session, so each key is read immediately
   before it is written, with no wait on the helper in between, and the plan, regime,
   promotion and notice keys are written only when they changed. */

import type { SessionRateLimit } from 'claude-code'

import type { ModelSpend, PlanReport, SpendReport, UsageReport, WindowReport } from '../types'
import { money, statusLine } from './card'
import { estimate, inferRounding, observed, record, regimeView, resolutionOf } from './estimate'
import type { Estimate, PastPoint, WindowReadings } from './estimate'
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
const SCHEMA = 3
const NONE = 'none'

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

type StoredLimit = { percentUsed?: number; resetsAt: string; observedAt: number }

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

type WindowsOutput = HelperBase & { windows?: Record<string, WindowTally>; files: number; ms: number }

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

type WindowState = {
  title: string
  short: string
  resetsAt: string
  tally: WindowTally
  estimate?: Estimate
  sinceResetLabel?: string
  percent?: number
  percentAt?: number
}

export type Summary = {
  subscription: string
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
/* A fresh measure that arrived while another ran; the latest wins. */
let pendingFresh: { host: Host; limits?: readonly SessionRateLimit[] } | undefined

const subscriptionOf = (org: string | null | undefined) => org ?? NONE

const isSame = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const windowKey = (subscription: string, kind: string, resetsAt: string) =>
  `${subscription}|${kind}@${new Date(Math.round(Date.parse(resetsAt) / MINUTE_MS) * MINUTE_MS).toISOString()}`

const helperArgv = (host: Host, sessionId: string) => [
  'node',
  `${host.root}/scripts/usage-cost.mjs`,
  '--session',
  sessionId,
]

async function runHelper<T extends HelperBase>(host: Host, extra: readonly string[], timeoutMs: number) {
  const run = await host.run([...helperArgv(host, await host.sessionId()), ...extra], { timeoutMs })
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
   ones, so both are dropped once more. Schema-2 history comes from rate-limit rejections
   in the transcripts, not from percents, and is kept. */
async function migrate(host: Host) {
  if (isMigrated) return
  const was = await host.get(SCHEMA_KEY)
  if (was !== SCHEMA) {
    await host.delete(LIMITS_KEY)
    await host.delete(READINGS_KEY)
    if (was !== 2) await host.delete(HISTORY_KEY)
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

function basisOf(e: Estimate | undefined, sinceResetLabel: string | undefined) {
  const reset = sinceResetLabel ? ` · since reset ${sinceResetLabel}` : ''
  if (!e) return `No estimate yet: the limit has not reported a usable reading for this window${reset}.`
  const readings = `${e.readings} percent level${e.readings === 1 ? '' : 's'} read this window`
  const mix = e.isMixErrorAssumed ? 'price-mix error assumed at 10%' : `price-mix error from ${e.pastWindows} past windows`
  const n = e.droppedReadings
  const dropped = n > 0 ? ` · ${n} conflicting level${n === 1 ? '' : 's'} set aside` : ''
  return `${readings} · ${mix} · history weight ${e.pastWeight}${reset}${dropped}`
}

/* isFresh: `given` holds percents this session has just received, so they and the dollars
   scanned now describe the same moment. Only such a measure records readings or shares
   its limits. */
async function measure(host: Host, given: readonly SessionRateLimit[] | undefined, isFresh: boolean): Promise<Summary | undefined> {
  const now = await host.now()
  const readAt = now
  const live = given ?? (await host.rateLimits())
  if (isFresh) lastFreshAt = readAt
  let subscription = await resolveSubscription(host)

  let active: { w: (typeof WINDOWS)[number]; limit: Limit }[] = []
  let out: WindowsOutput | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    const storedLimits = ((await host.get(LIMITS_KEY)) ?? {}) as StoredLimits
    active = []
    for (const w of WINDOWS) {
      const limit = limitOf(w.kind, live, lastFreshAt, storedLimits[subscription]?.[w.kind], now)
      if (limit) active.push({ w, limit })
    }
    if (active.length === 0) {
      host.status('waiting for the first reply')
      return undefined
    }

    const regimes = ((await host.get(REGIMES_KEY)) ?? {}) as Regimes
    const plans = ((await host.get(PLANS_KEY)) ?? {}) as Ledger
    const extra: string[] = []
    for (const { w, limit } of active) {
      const since = new Date(Date.parse(limit.resetsAt) - w.spanMs).toISOString()
      extra.push('--window', `${w.name},${since},${limit.resetsAt}`)
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
      mine[l.kind] = { percentUsed: l.percentUsed, resetsAt: l.resetsAt!, observedAt: readAt }
      isChanged = true
    }
    if (isChanged) await host.set(LIMITS_KEY, { ...stored, [subscription]: mine })
  }

  /* A guessed subscription must not write readings; with none at all every request is
     counted, as on a machine without bridge-session records. A reading takes its percent
     from `given` alone, and only for the window the dollars were scanned for. */
  const mayRecord = out.org === null || out.org === undefined || out.orgSource === 'session' || out.orgSource === 'profile'
  const readings = ((await host.get(READINGS_KEY)) ?? {}) as StoredReadings
  if (mayRecord && isFresh && given !== undefined)
    for (const { w, limit } of active) {
      const tally = out.windows[w.name]
      const fresh = given.find(l => l.kind === w.kind && l.resetsAt)
      if (!tally || !fresh) continue
      const key = windowKey(subscription, w.kind, limit.resetsAt)
      if (windowKey(subscription, w.kind, fresh.resetsAt!) !== key) continue
      const was = readings[key] ?? { kind: w.kind, resetsAt: limit.resetsAt, byPct: {}, org: subscription }
      readings[key] = { ...record(was, fresh.percentUsed, tally.usd, readAt), org: subscription }
    }
  const kept = Object.fromEntries(
    Object.entries(readings).filter(([, r]) => Date.parse(r.resetsAt) > now - READINGS_KEPT_MS),
  ) as StoredReadings
  await host.set(READINGS_KEY, kept)

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
  const rounding = inferRounding(
    all.filter(r => Date.parse(r.resetsAt) <= now && !isStraddling(r, regimes)),
    resolution,
  )
  const history = ((await host.get(HISTORY_KEY)) ?? {}) as History
  const observations = history[subscription]?.observations ?? []

  const windows: WindowState[] = []
  for (const { w, limit } of active) {
    const tally = out.windows[w.name]
    if (!tally) continue
    const startedAt = regimeStart(regimes, subscription, w.kind)
    const regime = currentRegime(regimes, subscription, w.kind)
    const past: PastPoint[] = [
      ...all
        .filter(r => r.org === subscription && r.kind === w.kind && Date.parse(r.resetsAt) <= now && Date.parse(r.resetsAt) >= startedAt)
        .map(r => ({ usd: observed(regimeView(r, startedAt), resolution, rounding), at: Date.parse(r.resetsAt) })),
      ...observations
        .filter(o => o.kind === w.kind && Date.parse(o.resetsAt) > now - HISTORY_DAYS * DAY_MS)
        .map(o => ({ usd: o.usd, at: Date.parse(o.at) })),
    ].filter((p): p is PastPoint => p.usd !== undefined && p.at >= startedAt)
    const key = windowKey(subscription, w.kind, limit.resetsAt)
    const current = kept[key]
    const e = current
      ? estimate(regimeView(current, startedAt), tally.usd, {
          resolution,
          rounding,
          past,
          kind: w.kind,
          now,
          livePercent: limit.observedAt !== undefined && now - limit.observedAt <= FRESH_MS ? limit.percentUsed : undefined,
        })
      : undefined
    if (e?.isPriorContradicted) drafts.push({ id: `inferred:${key}`, kind: 'inferred', text: INFERRED_TEXT })
    windows.push({
      title: w.title,
      short: w.short,
      resetsAt: limit.resetsAt,
      tally,
      estimate: e,
      sinceResetLabel: regime?.reason === 'manual' ? labels[String(regime.startedAt)] : undefined,
      percent: limit.percentUsed,
      percentAt: limit.percentUsed !== undefined ? limit.observedAt : undefined,
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
export function refresh(host: Host, limits?: readonly SessionRateLimit[], isForced = false, isFresh = false) {
  if (running) {
    if (isFresh) pendingFresh = { host, limits }
    return running
  }
  if (!isForced && !isFresh && Date.now() - lastRunAt < MIN_GAP_MS) return Promise.resolve(last)
  lastRunAt = Date.now()
  running = measure(host, limits, isFresh)
    .then(summary => (last = summary ?? last))
    .catch(error => {
      host.log(`usage-dollars: ${String(error)}`)
      return last
    })
    .finally(() => {
      running = undefined
      const queued = pendingFresh
      pendingFresh = undefined
      if (queued) void refresh(queued.host, queued.limits, true, true)
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
    percent: s.percent,
    percentAgeMinutes: s.percentAt !== undefined ? Math.max(0, Math.round((now - s.percentAt) / MINUTE_MS)) : undefined,
    basis: basisOf(s.estimate, s.sinceResetLabel),
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

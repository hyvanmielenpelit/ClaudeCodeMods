/* Plan tracking per subscription: a ledger of the plans the signed-in profile reported,
   the promotions its cache listed, and the regimes (stretches of constant limits) that
   decide which readings feed an estimate. Pure: no engine calls, every instant in epoch
   milliseconds.

   The profile describes only the subscription Claude Code is signed in to now, and is
   refreshed on Claude Code's own schedule, so a plan change is known only as a range
   between two profile fetches, and a profile for another subscription says nothing about
   this one. */

export type Kind = 'five_hour' | 'seven_day'

export type ProfilePromotion = { limit: string | null; text: string; endsAt: string | null; endsLabel: string | null }

/** The helper's `profile` block. */
export type Profile = {
  org: string
  organizationType: string | null
  rateLimitTier: string | null
  userRateLimitTier: string | null
  seatTier: string | null
  billingType: string | null
  subscriptionCreatedAt: string | null
  fetchedAt: string | null
  fetchedLabel: string | null
  promotions: ProfilePromotion[]
}

export type PlanEntry = {
  fingerprint: string
  label: string
  firstSeenAt: number
  lastSeenAt: number
  profileFetchedAt?: number
}

export type Ledger = Record<string, PlanEntry[]>

export type PlanEvent =
  | { kind: 'unknown'; reason: 'no-profile' | 'other-subscription'; lastKnown?: PlanEntry }
  | { kind: 'first-seen' }
  | { kind: 'same' }
  | { kind: 'changed'; from: PlanEntry; to: PlanEntry; between: [number, number] }

export type RegimeReason = 'first-seen' | 'plan' | 'promotion-start' | 'promotion-end' | 'manual'

export type Regime = { startedAt: number; reason: RegimeReason; kinds?: Kind[]; isUndone?: boolean }

export type Regimes = Record<string, Regime[]>

export type Promotion = {
  text: string
  limit: string | null
  endsAt: number | null
  endsLabel: string | null
  firstSeenAt: number
  isEnded: boolean
}

export type Promotions = Record<string, Promotion[]>

export type NoticeDraft = { id: string; kind: 'plan-changed' | 'promotion' | 'inferred'; text: string }

const KEPT_ENTRIES = 20
const KEPT_REGIMES = 50

const timeOf = (iso: string | null) => {
  const ms = iso ? Date.parse(iso) : NaN
  return Number.isFinite(ms) ? ms : undefined
}

export function fingerprint(p: Profile) {
  return [p.organizationType, p.rateLimitTier, p.userRateLimitTier, p.seatTier, p.subscriptionCreatedAt]
    .map(v => v ?? '')
    .join('|')
}

/* Display names for known values only; anything else is shown verbatim, never guessed. */
export function planLabel(p: Profile) {
  const tier = p.rateLimitTier
  switch (p.organizationType) {
    case 'claude_max':
      if (tier && /_max_5x$/.test(tier)) return 'Max 5x'
      if (tier && /_max_20x$/.test(tier)) return 'Max 20x'
      return tier ? `Max (${tier})` : 'Max'
    case 'claude_pro':
      return 'Pro'
    case 'claude_team':
      return p.seatTier ? `Team · ${p.seatTier} seat` : 'Team'
    case 'claude_enterprise':
      return 'Enterprise'
    case 'claude_free':
      return 'Free'
    default: {
      const name = p.organizationType ?? 'unknown plan'
      return tier ? `${name} (${tier})` : name
    }
  }
}

const capped = <T>(list: readonly T[], max: number) => list.slice(Math.max(0, list.length - max))

export function observePlan(ledger: Ledger, profile: Profile | null | undefined, sessionOrg: string, now: number) {
  const entries = ledger[sessionOrg] ?? []
  const prev = entries[entries.length - 1]
  if (!profile || profile.org !== sessionOrg) {
    const event: PlanEvent = { kind: 'unknown', reason: profile ? 'other-subscription' : 'no-profile', lastKnown: prev }
    return { ledger, event }
  }

  const fetchedAt = timeOf(profile.fetchedAt)
  const entry: PlanEntry = {
    fingerprint: fingerprint(profile),
    label: planLabel(profile),
    firstSeenAt: now,
    lastSeenAt: now,
    profileFetchedAt: fetchedAt,
  }
  if (!prev) {
    const event: PlanEvent = { kind: 'first-seen' }
    const regime: Regime = { startedAt: timeOf(profile.subscriptionCreatedAt) ?? 0, reason: 'first-seen' }
    return { ledger: { ...ledger, [sessionOrg]: [entry] }, event, regime }
  }
  if (prev.fingerprint === entry.fingerprint) {
    const raised = fetchedAt !== undefined && (prev.profileFetchedAt === undefined || fetchedAt > prev.profileFetchedAt)
    const updated: PlanEntry = { ...prev, lastSeenAt: now, profileFetchedAt: raised ? fetchedAt : prev.profileFetchedAt }
    const event: PlanEvent = { kind: 'same' }
    return { ledger: { ...ledger, [sessionOrg]: [...entries.slice(0, -1), updated] }, event }
  }

  /* The last moment the server confirmed the old plan, and the first it reported the new. */
  const isOrdered =
    prev.profileFetchedAt !== undefined && fetchedAt !== undefined && prev.profileFetchedAt <= fetchedAt
  const between: [number, number] = isOrdered ? [prev.profileFetchedAt!, fetchedAt!] : [prev.lastSeenAt, now]
  const event: PlanEvent = { kind: 'changed', from: prev, to: entry, between }
  const regime: Regime = { startedAt: between[1], reason: 'plan' }
  return { ledger: { ...ledger, [sessionOrg]: capped([...entries, entry], KEPT_ENTRIES) }, event, regime }
}

export function addRegimes(regimes: Regimes, org: string, added: readonly Regime[]): Regimes {
  if (added.length === 0) return regimes
  return { ...regimes, [org]: capped([...(regimes[org] ?? []), ...added], KEPT_REGIMES) }
}

const appliesTo = (r: Regime, kind: Kind) => !r.isUndone && (!r.kinds || r.kinds.includes(kind))

/** The regime in force for one window kind: the latest start that is not undone. */
export function currentRegime(regimes: Regimes, org: string, kind: Kind) {
  let found: Regime | undefined
  for (const r of regimes[org] ?? []) if (appliesTo(r, kind) && (!found || r.startedAt > found.startedAt)) found = r
  return found
}

export function regimeStart(regimes: Regimes, org: string, kind: Kind) {
  return currentRegime(regimes, org, kind)?.startedAt ?? 0
}

export function startOver(regimes: Regimes, org: string, now: number) {
  return addRegimes(regimes, org, [{ startedAt: now, reason: 'manual' }])
}

/* Only a reset that is still the latest regime can be undone: plan and promotion regimes
   are observations, not choices. */
export function undoStartOver(regimes: Regimes, org: string) {
  const list = regimes[org] ?? []
  let at = list.length - 1
  while (at >= 0 && list[at]?.isUndone) at--
  if (list[at]?.reason !== 'manual') return { regimes, isUndone: false }
  const next = list.map((r, i) => (i === at ? { ...r, isUndone: true } : r))
  return { regimes: { ...regimes, [org]: next }, isUndone: true }
}

const promoKinds = (limit: string | null): Kind[] | undefined =>
  limit === 'five_hour' || limit === 'seven_day' ? [limit] : undefined

const promoText = (p: { text: string; endsLabel: string | null }) =>
  `Promotion in effect: ${p.text}${p.endsLabel ? ` — ends ${p.endsLabel}` : ''}.`

export function observePromotions(stored: Promotions, profile: Profile | null | undefined, sessionOrg: string, now: number) {
  const regimes: Regime[] = []
  const notices: NoticeDraft[] = []
  /* The cache belongs to whichever subscription is signed in. */
  if (!profile || profile.org !== sessionOrg) return { stored, regimes, notices }

  const cached = profile.promotions ?? []
  const toPromotion = (p: ProfilePromotion): Promotion => ({
    text: p.text,
    limit: p.limit,
    endsAt: timeOf(p.endsAt) ?? null,
    endsLabel: p.endsLabel,
    firstSeenAt: now,
    isEnded: false,
  })
  const was = stored[sessionOrg]
  if (!was) {
    const list = cached.map(toPromotion)
    for (const p of list) notices.push({ id: `promo:${sessionOrg}:${p.text}`, kind: 'promotion', text: promoText(p) })
    return { stored: { ...stored, [sessionOrg]: list }, regimes, notices }
  }

  const next: Promotion[] = []
  const texts = new Set(cached.map(p => p.text))
  for (const p of was) {
    let kept: Promotion | undefined = p
    if (!p.isEnded && p.endsAt !== null && p.endsAt <= now) {
      kept = { ...p, isEnded: true }
      regimes.push({ startedAt: p.endsAt, reason: 'promotion-end', kinds: promoKinds(p.limit) })
      notices.push({ id: `promo-end:${sessionOrg}:${p.text}`, kind: 'promotion', text: `Promotion ended: ${p.text}.` })
    }
    if (!texts.has(p.text)) {
      /* Missing from the cache is no evidence that it ended: keep it until its end date. */
      if (p.endsAt === null) {
        kept = undefined
        notices.push({
          id: `promo-gone:${sessionOrg}:${p.text}`,
          kind: 'promotion',
          text: 'A promotion is no longer listed. If your limits changed, run /usage-dollars reset.',
        })
      } else if (kept!.isEnded) kept = undefined
    }
    if (kept) next.push(kept)
  }
  const known = new Set(was.map(p => p.text))
  for (const c of cached) {
    if (known.has(c.text)) continue
    const p = toPromotion(c)
    next.push(p)
    regimes.push({ startedAt: now, reason: 'promotion-start', kinds: promoKinds(p.limit) })
    notices.push({ id: `promo:${sessionOrg}:${p.text}`, kind: 'promotion', text: promoText(p) })
  }
  return { stored: { ...stored, [sessionOrg]: next }, regimes, notices }
}

/** The "in effect" lines for a subscription's stored promotions that have not ended. */
export function activePromotions(stored: Promotions, org: string) {
  return (stored[org] ?? []).filter(p => !p.isEnded).map(promoText)
}

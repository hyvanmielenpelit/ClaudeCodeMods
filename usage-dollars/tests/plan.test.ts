import { expect, test } from 'claude-code/testing'

import { addRegimes, observePlan, observePromotions, planLabel, regimeStart, startOver, undoStartOver } from '../hooks/plan'
import type { Profile, Regimes } from '../hooks/plan'

const ORG_A = '00000000-0000-4000-8000-000000000001'
const ORG_B = '00000000-0000-4000-8000-000000000002'
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const T0 = Date.parse('2026-10-01T10:00:00.000Z')

const base: Profile = {
  org: ORG_A,
  organizationType: 'claude_max',
  rateLimitTier: 'default_claude_max_5x',
  userRateLimitTier: null,
  seatTier: null,
  billingType: 'stripe_subscription',
  subscriptionCreatedAt: '2026-09-01T08:00:00.000Z',
  fetchedAt: new Date(T0).toISOString(),
  fetchedLabel: 'Thu 1 Oct, 13:00',
  promotions: [],
}

const profile = (over: Partial<Profile> = {}): Profile => ({ ...base, ...over })

test('the first observation is first-seen, with a regime from the subscription start', () => {
  const r = observePlan({}, profile(), ORG_A, T0 + HOUR_MS)
  expect(r.event.kind).toBe('first-seen')
  expect(r.regime).toEqual({ startedAt: Date.parse(base.subscriptionCreatedAt!), reason: 'first-seen' })
  expect(r.ledger[ORG_A]).toHaveLength(1)
})

test('the same fingerprint is "same", and a later fetch raises profileFetchedAt', () => {
  const first = observePlan({}, profile(), ORG_A, T0 + HOUR_MS)
  const later = T0 + 5 * HOUR_MS
  const r = observePlan(first.ledger, profile({ fetchedAt: new Date(later).toISOString() }), ORG_A, T0 + 6 * HOUR_MS)
  expect(r.event.kind).toBe('same')
  expect(r.regime).toBeUndefined()
  expect(r.ledger[ORG_A]?.[0]?.profileFetchedAt).toBe(later)
  expect(r.ledger[ORG_A]?.[0]?.lastSeenAt).toBe(T0 + 6 * HOUR_MS)
})

test('5x to 20x is a change between the two fetches, with a plan regime at the later', () => {
  const first = observePlan({}, profile(), ORG_A, T0 + HOUR_MS)
  const fetched = T0 + 2 * DAY_MS
  const r = observePlan(
    first.ledger,
    profile({ rateLimitTier: 'default_claude_max_20x', fetchedAt: new Date(fetched).toISOString() }),
    ORG_A,
    fetched + HOUR_MS,
  )
  expect(r.event.kind).toBe('changed')
  if (r.event.kind !== 'changed') return
  expect(r.event.between).toEqual([T0, fetched])
  expect(r.event.from.label).toBe('Max 5x')
  expect(r.event.to.label).toBe('Max 20x')
  expect(r.regime).toEqual({ startedAt: fetched, reason: 'plan' })
  expect(r.ledger[ORG_A]).toHaveLength(2)
})

test('a change with no fetch time spans the last sighting to now', () => {
  const first = observePlan({}, profile(), ORG_A, T0 + HOUR_MS)
  const now = T0 + 3 * DAY_MS
  const r = observePlan(first.ledger, profile({ rateLimitTier: 'default_claude_max_20x', fetchedAt: null }), ORG_A, now)
  expect(r.event.kind).toBe('changed')
  if (r.event.kind !== 'changed') return
  expect(r.event.between).toEqual([T0 + HOUR_MS, now])
  expect(r.regime?.startedAt).toBe(now)
})

test('a new subscription with the same tier is a change', () => {
  const first = observePlan({}, profile(), ORG_A, T0 + HOUR_MS)
  const r = observePlan(first.ledger, profile({ subscriptionCreatedAt: '2026-10-02T08:00:00.000Z' }), ORG_A, T0 + 2 * DAY_MS)
  expect(r.event.kind).toBe('changed')
})

test('a profile for another subscription, or none, leaves the plan unknown and the ledger alone', () => {
  const first = observePlan({}, profile(), ORG_A, T0 + HOUR_MS)
  const other = observePlan(first.ledger, profile({ org: ORG_B }), ORG_A, T0 + 2 * HOUR_MS)
  expect(other.event).toEqual({ kind: 'unknown', reason: 'other-subscription', lastKnown: first.ledger[ORG_A]?.[0] })
  expect(other.ledger).toBe(first.ledger)
  const none = observePlan(first.ledger, null, ORG_A, T0 + 2 * HOUR_MS)
  expect(none.event).toEqual({ kind: 'unknown', reason: 'no-profile', lastKnown: first.ledger[ORG_A]?.[0] })
  expect(none.ledger).toBe(first.ledger)
})

test('regimeStart honors kinds', () => {
  const regimes = addRegimes({}, ORG_A, [
    { startedAt: 100, reason: 'first-seen' },
    { startedAt: 500, reason: 'promotion-start', kinds: ['five_hour'] },
  ])
  expect(regimeStart(regimes, ORG_A, 'five_hour')).toBe(500)
  expect(regimeStart(regimes, ORG_A, 'seven_day')).toBe(100)
  expect(regimeStart(regimes, ORG_B, 'seven_day')).toBe(0)
})

const promo = (text: string, endsAt: string | null = null, limit: string | null = 'five_hour') => ({
  limit,
  text,
  endsAt,
  endsLabel: endsAt ? '13 Oct' : null,
})

test('promotions: the first observation stores the set without a regime', () => {
  const r = observePromotions({}, profile({ promotions: [promo('Double limits through Oct 13', '2026-10-14T00:00:00.000Z')] }), ORG_A, T0)
  expect(r.regimes).toHaveLength(0)
  expect(r.stored[ORG_A]).toHaveLength(1)
  expect(r.notices).toHaveLength(1)
  expect(r.notices[0]?.id).toBe(`promo:${ORG_A}:Double limits through Oct 13`)
})

test('promotions: a new text starts a regime for its limit', () => {
  const first = observePromotions({}, profile(), ORG_A, T0)
  const r = observePromotions(first.stored, profile({ promotions: [promo('More 5h usage')] }), ORG_A, T0 + HOUR_MS)
  expect(r.regimes).toEqual([{ startedAt: T0 + HOUR_MS, reason: 'promotion-start', kinds: ['five_hour'] }])
  expect(r.notices).toHaveLength(1)
})

test('promotions: a passed end makes one promotion-end regime at the end', () => {
  const ends = '2026-10-02T00:00:00.000Z'
  const p = profile({ promotions: [promo('Double limits through Oct 1', ends, null)] })
  const first = observePromotions({}, p, ORG_A, T0)
  const ended = observePromotions(first.stored, p, ORG_A, T0 + 2 * DAY_MS)
  expect(ended.regimes).toEqual([{ startedAt: Date.parse(ends), reason: 'promotion-end', kinds: undefined }])
  expect(ended.stored[ORG_A]?.[0]?.isEnded).toBe(true)
  const again = observePromotions(ended.stored, p, ORG_A, T0 + 3 * DAY_MS)
  expect(again.regimes).toHaveLength(0)
})

test('promotions: a missing text with no end makes a notice and no regime', () => {
  const first = observePromotions({}, profile({ promotions: [promo('Bonus usage')] }), ORG_A, T0)
  const r = observePromotions(first.stored, profile(), ORG_A, T0 + HOUR_MS)
  expect(r.regimes).toHaveLength(0)
  expect(r.stored[ORG_A]).toHaveLength(0)
  expect(r.notices.map(n => n.id)).toEqual([`promo-gone:${ORG_A}:Bonus usage`])
})

test('promotions: a profile for another subscription changes nothing', () => {
  const stored = {}
  const r = observePromotions(stored, profile({ org: ORG_B, promotions: [promo('Bonus usage')] }), ORG_A, T0)
  expect(r.stored).toBe(stored)
  expect(r.regimes).toHaveLength(0)
  expect(r.notices).toHaveLength(0)
})

const seeded = (): Regimes => addRegimes({}, ORG_A, [{ startedAt: 100, reason: 'first-seen' }])

test('startOver moves the regime start to the reset', () => {
  expect(regimeStart(startOver(seeded(), ORG_A, 900), ORG_A, 'seven_day')).toBe(900)
})

test('undoStartOver restores the previous start, then has nothing to undo', () => {
  const reset = startOver(seeded(), ORG_A, 900)
  const once = undoStartOver(reset, ORG_A)
  expect(once.isUndone).toBe(true)
  expect(regimeStart(once.regimes, ORG_A, 'five_hour')).toBe(100)
  const twice = undoStartOver(once.regimes, ORG_A)
  expect(twice.isUndone).toBe(false)
  expect(twice.regimes).toBe(once.regimes)
})

test('two resets are undone one at a time', () => {
  const reset = startOver(startOver(seeded(), ORG_A, 900), ORG_A, 1000)
  const first = undoStartOver(reset, ORG_A)
  expect(regimeStart(first.regimes, ORG_A, 'five_hour')).toBe(900)
  const second = undoStartOver(first.regimes, ORG_A)
  expect(second.isUndone).toBe(true)
  expect(regimeStart(second.regimes, ORG_A, 'five_hour')).toBe(100)
})

test('undoStartOver never undoes a plan regime, nor a reset a plan regime followed', () => {
  const plan = addRegimes(seeded(), ORG_A, [{ startedAt: 800, reason: 'plan' }])
  expect(undoStartOver(plan, ORG_A).isUndone).toBe(false)
  const followed = addRegimes(startOver(seeded(), ORG_A, 900), ORG_A, [{ startedAt: 950, reason: 'plan' }])
  expect(undoStartOver(followed, ORG_A).isUndone).toBe(false)
})

test('plan labels map known values and pass unknown ones through verbatim', () => {
  expect(planLabel(profile())).toBe('Max 5x')
  expect(planLabel(profile({ rateLimitTier: 'default_claude_max_20x' }))).toBe('Max 20x')
  expect(planLabel(profile({ rateLimitTier: 'default_claude_max_50x' }))).toBe('Max (default_claude_max_50x)')
  expect(planLabel(profile({ organizationType: 'claude_pro', rateLimitTier: null }))).toBe('Pro')
  expect(planLabel(profile({ organizationType: 'claude_team', rateLimitTier: null }))).toBe('Team')
  expect(planLabel(profile({ organizationType: 'claude_team', seatTier: 'premium' }))).toBe('Team · premium seat')
  expect(planLabel(profile({ organizationType: 'claude_enterprise' }))).toBe('Enterprise')
  expect(planLabel(profile({ organizationType: 'claude_free', rateLimitTier: null }))).toBe('Free')
  expect(planLabel(profile({ organizationType: 'claude_galaxy', rateLimitTier: 'tier_x' }))).toBe('claude_galaxy (tier_x)')
})

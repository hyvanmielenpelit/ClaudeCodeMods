import { expect, test } from 'claude-code/testing'
import type { SessionRateLimit } from 'claude-code'

import { diagnosticsOf, refresh } from '../hooks/measure'
import type { Host } from '../hooks/measure'

/* measure.ts keeps module state (migration, the session's subscription, when it last
   received percents, its diagnostics), shared by every test here: each test forces its
   measures, moves one clock only forward, and starts from a store of its own. */

const ORG = '00000000-0000-4000-8000-000000000001'
const PRICES_ID = 'abcdef012345'
const MINUTE_MS = 60 * 1000
const T0 = Date.parse('2026-10-05T10:00:00.000Z')
const RESET_5H = '2026-10-05T12:00:00.000Z'
const RESET_WEEK = '2026-10-09T00:00:00.000Z'

let clock = T0

const iso = (ms: number) => new Date(ms).toISOString()

type Stored = { readings?: Record<string, { kind: string; byPct: Record<string, { minUsd: number; minAt: number; maxUsd: number; maxAt: number }>; pricesId?: string }> }

/* A host whose helper answers --whoami from the profile, and a --window run with a tally
   for every --window name, its dollars looked up by the window's 4th field. */
function fakeHost(sessionId: string, dollars: Record<string, number>, store: Record<string, unknown>) {
  const runs: string[][] = []
  const logs: string[] = []
  const host: Host = {
    root: '/plugin',
    now: async () => clock,
    sessionId: async () => sessionId,
    rateLimits: async () => [],
    run: async argv => {
      runs.push(argv)
      const answer = (out: unknown) => ({ stdout: JSON.stringify(out), stderr: '', exitCode: 0 })
      if (argv.includes('--whoami')) return answer({ org: ORG, orgSource: 'profile' })
      const windows: Record<string, unknown> = {}
      argv.forEach((arg, i) => {
        if (arg !== '--window') return
        const [name, , , until] = argv[i + 1]!.split(',')
        windows[name!] = {
          usd: until !== undefined ? (dollars[until] ?? 0) : 100,
          requests: 1,
          byModel: {},
          otherSubscriptionsUsd: 0,
          unattributedUsd: 0,
          unpricedRequests: 0,
          unpricedModels: [],
          slackUsd: 0,
        }
      })
      return answer({ org: ORG, orgSource: 'profile', profile: null, labels: {}, pricesId: PRICES_ID, windows, files: 1, ms: 1 })
    },
    get: async key => (store[key] === undefined ? undefined : JSON.parse(JSON.stringify(store[key]))),
    set: async (key, value) => {
      store[key] = JSON.parse(JSON.stringify(value))
    },
    delete: async key => {
      delete store[key]
    },
    status: () => undefined,
    log: text => logs.push(text),
  }
  return { host, runs, logs }
}

const readingsOf = (store: Record<string, unknown>, kind: string) =>
  Object.values((store as Stored).readings ?? {}).find(r => r.kind === kind)

const windowArgs = (runs: readonly string[][]) => runs.flatMap(argv => argv.filter((_, i) => argv[i - 1] === '--window'))

const fiveHour = (percentUsed: number): SessionRateLimit => ({ kind: 'five_hour', percentUsed, resetsAt: RESET_5H })

test('a fresh percent is recorded, and the stored limit carries the session and stamp', async () => {
  clock = T0
  const store: Record<string, unknown> = { schema: 4 }
  const { host, runs, logs } = fakeHost('session-1', { [iso(T0)]: 30 }, store)
  await refresh(host, [fiveHour(5), { kind: 'seven_day', percentUsed: 2, resetsAt: RESET_WEEK }], true, true, T0)
  expect(logs).toEqual([])
  const limits = store.limits as Record<string, Record<string, unknown>>
  expect(limits[ORG]!.five_hour).toEqual({ percentUsed: 5, resetsAt: RESET_5H, observedAt: T0, sessionId: 'session-1', stamp: 1 })
  const bucket = readingsOf(store, 'five_hour')!.byPct['5']!
  expect(bucket.maxUsd).toBe(30)
  expect(bucket.maxAt).toBe(T0)
  expect(readingsOf(store, 'seven_day')!.byPct['2']!.maxUsd).toBe(30)
  expect(windowArgs(runs).some(spec => spec.startsWith('session@read,') && spec.endsWith(`,${iso(T0)},session-1`))).toBe(true)
  expect(diagnosticsOf().outcomes['5-hour window']).toEqual([{ source: 'mine', outcome: 'recorded' }])
})

test('a stored percent without a reading is recorded by the next measure that is not fresh', async () => {
  const at = T0 + 10 * MINUTE_MS
  clock = at + 2 * MINUTE_MS
  const store: Record<string, unknown> = {
    schema: 4,
    limits: { [ORG]: { five_hour: { percentUsed: 7, resetsAt: RESET_5H, observedAt: at, sessionId: 'session-2', stamp: 1 } } },
  }
  const { host, runs, logs } = fakeHost('session-1', { [iso(at)]: 44 }, store)
  await refresh(host, undefined, true)
  expect(logs).toEqual([])
  const bucket = readingsOf(store, 'five_hour')!.byPct['7']!
  expect(bucket.maxUsd).toBe(44)
  expect(bucket.maxAt).toBe(at)
  expect(windowArgs(runs).some(spec => spec.startsWith('session@stored,') && spec.endsWith(`,${iso(at)},session-2`))).toBe(true)
  expect(diagnosticsOf().outcomes['5-hour window']).toEqual([{ source: 'stored', outcome: 'recorded' }])
})

test("a fresh measure with a later stored percent of another session records both", async () => {
  const mine = T0 + 20 * MINUTE_MS
  const theirs = mine + 30 * 1000
  clock = mine + MINUTE_MS
  const store: Record<string, unknown> = {
    schema: 4,
    limits: { [ORG]: { five_hour: { percentUsed: 9, resetsAt: RESET_5H, observedAt: theirs, sessionId: 'session-2', stamp: 1 } } },
  }
  const { host, logs } = fakeHost('session-1', { [iso(mine)]: 50, [iso(theirs)]: 53 }, store)
  await refresh(host, [fiveHour(8)], true, true, mine)
  expect(logs).toEqual([])
  const readings = readingsOf(store, 'five_hour')!
  expect(readings.byPct['8']!.maxUsd).toBe(50)
  expect(readings.byPct['8']!.maxAt).toBe(mine)
  expect(readings.byPct['9']!.maxUsd).toBe(53)
  expect(readings.byPct['9']!.maxAt).toBe(theirs)
  expect(diagnosticsOf().outcomes['5-hour window']).toEqual([
    { source: 'mine', outcome: 'recorded' },
    { source: 'stored', outcome: 'recorded' },
  ])
})

test('a stored percent without a stamp is not recorded, and shows other hooks', async () => {
  const at = T0 + 30 * MINUTE_MS
  clock = at + MINUTE_MS
  const store: Record<string, unknown> = {
    schema: 4,
    limits: { [ORG]: { five_hour: { percentUsed: 11, resetsAt: RESET_5H, observedAt: at } } },
  }
  const { host, runs, logs } = fakeHost('session-1', { [iso(at)]: 60 }, store)
  await refresh(host, undefined, true)
  expect(logs).toEqual([])
  expect(readingsOf(store, 'five_hour')).toBeUndefined()
  expect(windowArgs(runs).some(spec => spec.includes('@stored'))).toBe(false)
  expect(diagnosticsOf().otherHooks).toBe('older')
})

test('a stored reading priced with another table is dropped and counted', async () => {
  clock = T0 + 40 * MINUTE_MS
  const store: Record<string, unknown> = {
    schema: 4,
    limits: { [ORG]: { five_hour: { resetsAt: RESET_5H, observedAt: T0, sessionId: 'session-2', stamp: 1 } } },
    readings: {
      [`${ORG}|five_hour@${RESET_5H}`]: {
        kind: 'five_hour',
        resetsAt: RESET_5H,
        byPct: { '3': { minUsd: 20, minAt: T0, maxUsd: 20, maxAt: T0 } },
        org: ORG,
        pricesId: 'another-table',
      },
    },
  }
  const { host, logs } = fakeHost('session-1', {}, store)
  const before = diagnosticsOf().droppedForPrices
  await refresh(host, undefined, true)
  expect(logs).toEqual([])
  expect(diagnosticsOf().droppedForPrices).toBe(before + 1)
  expect(readingsOf(store, 'five_hour')).toBeUndefined()
})

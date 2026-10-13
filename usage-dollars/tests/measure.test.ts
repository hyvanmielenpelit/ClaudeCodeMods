import { expect, test } from 'claude-code/testing'
import type { SessionRateLimit } from 'claude-code'

import { backfillSettled, diagnosticsOf, modelsReport, refresh } from '../hooks/measure'
import type { Host } from '../hooks/measure'

/* measure.ts keeps module state (migration, the session's subscription, when it last
   received percents, its diagnostics, the backfill and model fit that follow a measure),
   shared by every test here: each test forces its measures, moves one clock only forward,
   starts from a store of its own, and waits for the work that follows its measures. */

const ORG = '00000000-0000-4000-8000-000000000001'
const PRICES_ID = 'abcdef012345'
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const T0 = Date.parse('2026-10-05T10:00:00.000Z')
const RESET_5H = '2026-10-05T12:00:00.000Z'
const RESET_NEXT = '2026-10-05T15:00:00.000Z'
const RESET_WEEK = '2026-10-09T00:00:00.000Z'
const OPUS_OUT = 'claude-opus-5-5/out'
const FABLE_OUT = 'claude-fable-5-1/out'

let clock = T0

const iso = (ms: number) => new Date(ms).toISOString()

type Bucket = { minUsd: number; minAt: number; maxUsd: number; maxAt: number; minX?: number[]; maxX?: number[] }

type Reading = {
  kind: string
  resetsAt: string
  byPct: Record<string, Bucket>
  org?: string
  pricesId?: string
  features?: string[]
  featuresUnverified?: boolean
}

type Prospective = { resetsAt: string; kind: string; d: number }

type Stored = {
  readings?: Record<string, Reading>
  meter?: Record<string, { fingerprint: string; included: Record<string, string[]>; prospective: Prospective[]; fits: Record<string, unknown> }>
}

/* A tally's dollars, by feature when given; a bare number is all Opus output. */
type Dollars = Record<string, number | { usd: number; byFeature: Record<string, number> }>

/* A host whose helper answers --whoami from the profile, and a --window run with a tally
   for every --window name, its dollars looked up by the window's 4th field; with
   failBackfill, a run with a backfill spec fails. */
function fakeHost(sessionId: string, dollars: Dollars, store: Record<string, unknown>, options: { failBackfill?: boolean } = {}) {
  const runs: string[][] = []
  const logs: string[] = []
  const statuses: string[] = []
  const sets: string[] = []
  const host: Host = {
    root: '/plugin',
    now: async () => clock,
    sessionId: async () => sessionId,
    rateLimits: async () => [],
    run: async argv => {
      runs.push(argv)
      const answer = (out: unknown) => ({ stdout: JSON.stringify(out), stderr: '', exitCode: 0 })
      if (argv.includes('--whoami')) return answer({ org: ORG, orgSource: 'profile' })
      const specs = argv.filter((_, i) => argv[i - 1] === '--window')
      if (options.failBackfill && specs.some(spec => spec.startsWith('bf'))) return { stdout: '', stderr: 'scan failed', exitCode: 1 }
      const windows: Record<string, unknown> = {}
      for (const spec of specs) {
        const [name, , , until] = spec.split(',')
        const found = until !== undefined ? (dollars[until] ?? 0) : 100
        const tally = typeof found === 'number' ? { usd: found, byFeature: found > 0 ? { [OPUS_OUT]: found } : {} } : found
        windows[name!] = {
          usd: tally.usd,
          requests: 1,
          byModel: {},
          byFeature: tally.byFeature,
          otherSubscriptionsUsd: 0,
          unattributedUsd: 0,
          unpricedRequests: 0,
          unpricedModels: [],
          slackUsd: 0,
        }
      }
      return answer({ org: ORG, orgSource: 'profile', profile: null, labels: {}, pricesId: PRICES_ID, windows, files: 1, ms: 1 })
    },
    get: async key => (store[key] === undefined ? undefined : JSON.parse(JSON.stringify(store[key]))),
    set: async (key, value) => {
      sets.push(key)
      store[key] = JSON.parse(JSON.stringify(value))
    },
    delete: async key => {
      delete store[key]
    },
    status: text => statuses.push(text),
    log: text => logs.push(text),
  }
  return { host, runs, logs, statuses, sets }
}

const readingsOf = (store: Record<string, unknown>, kind: string) =>
  Object.values((store as Stored).readings ?? {}).find(r => r.kind === kind)

const windowArgs = (runs: readonly string[][]) => runs.flatMap(argv => argv.filter((_, i) => argv[i - 1] === '--window'))

const backfillRuns = (runs: readonly string[][]) => runs.filter(argv => windowArgs([argv]).some(spec => spec.startsWith('bf')))

const fiveHour = (percentUsed: number): SessionRateLimit => ({ kind: 'five_hour', percentUsed, resetsAt: RESET_5H })

const fiveHourNext = (percentUsed: number): SessionRateLimit => ({ kind: 'five_hour', percentUsed, resetsAt: RESET_NEXT })

const keyOf = (kind: string, resetsAt: string) => `${ORG}|${kind}@${resetsAt}`

/* A window without features: one reading per level, both sides at once. */
function plainWindow(kind: string, resetsAt: string, levels: Record<string, { usd: number; at: number }>): Reading {
  const byPct: Record<string, Bucket> = {}
  for (const [pct, { usd, at }] of Object.entries(levels)) byPct[pct] = { minUsd: usd, minAt: at, maxUsd: usd, maxAt: at }
  return { kind, resetsAt, byPct, org: ORG, pricesId: PRICES_ID }
}

/* A closed 5-hour window with features on both sides of levels 0 to 8, three segments
   under the union; its Fable dollars grow by fableRate a level. */
function featureWindow(resetsAt: string, fableRate: number): Reading {
  const start = Date.parse(resetsAt) - 5 * HOUR_MS
  const byPct: Record<string, Bucket> = {}
  for (let p = 0; p <= 8; p++) {
    const opus = 2 * p + 0.25
    const fable = p * fableRate + 0.125
    const at = start + (p + 1) * 10 * MINUTE_MS
    byPct[String(p)] = {
      minUsd: fable + opus,
      minAt: at,
      maxUsd: fable + opus + 0.25,
      maxAt: at + 5 * MINUTE_MS,
      minX: [fable, opus],
      maxX: [fable, opus + 0.25],
    }
  }
  return { kind: 'five_hour', resetsAt, byPct, org: ORG, pricesId: PRICES_ID, features: [FABLE_OUT, OPUS_OUT] }
}

const UNIT = { model: 'M0', reference: 'all', free: [], theta: [], cov: [], df: 1 }
const FABLE_TWICE = { model: 'M1', reference: 'claude-opus-5-5', free: ['claude-fable-5-1'], theta: [Math.log(2)], cov: [[0.01]], df: 3 }

/* A stored model fit that has seen no window, with the given 5-hour weights. */
const meterWith = (weights: unknown) => ({
  [ORG]: {
    fingerprint: 'earlier',
    included: { five_hour: [], seven_day: [] },
    regimeStarts: { five_hour: 0, seven_day: 0 },
    pricesId: PRICES_ID,
    rounding: 'union',
    fits: { five_hour: { weights, omega: 0.3, omegaM0: 0.3 }, seven_day: { weights: UNIT, omega: 0.5, omegaM0: 0.5 } },
    prospective: [],
  },
})

test('schema-4 limits, readings and history are kept, and limits are stored with stamp 2', async () => {
  const old = T0 - 15 * MINUTE_MS
  clock = T0 - 10 * MINUTE_MS
  const history = { [ORG]: { scannedAt: old, observations: [] } }
  const store: Record<string, unknown> = {
    schema: 4,
    limits: { [ORG]: { five_hour: { percentUsed: 3, resetsAt: RESET_5H, observedAt: old, sessionId: 'session-0', stamp: 1 } } },
    readings: { [keyOf('five_hour', RESET_5H)]: plainWindow('five_hour', RESET_5H, { '3': { usd: 20, at: old } }) },
    history,
  }
  const { host, runs, logs } = fakeHost('session-1', { [iso(clock)]: 25, [iso(old)]: 20 }, store)
  await refresh(host, [fiveHour(4)], true, true, clock)
  expect(logs).toEqual([])
  expect(store.schema).toBe(5)
  expect(store.history).toEqual(history)
  const limits = store.limits as Record<string, Record<string, unknown>>
  expect(limits[ORG]!.five_hour).toEqual({ percentUsed: 4, resetsAt: RESET_5H, observedAt: clock, sessionId: 'session-1', stamp: 2 })
  const readings = readingsOf(store, 'five_hour')!
  expect(readings.byPct['3']!.maxUsd).toBe(20)
  expect(readings.byPct['4']!.maxUsd).toBe(25)
  expect(windowArgs(runs).some(spec => spec.includes('@stored'))).toBe(false)
  await backfillSettled()
  expect(readingsOf(store, 'five_hour')!.byPct['3']!.minX).toEqual([20])
})

test('a fresh percent is recorded with its features on both sides for both kinds, and the stored limit carries the session and stamp', async () => {
  clock = T0
  const store: Record<string, unknown> = { schema: 5 }
  const dollars: Dollars = {
    [iso(T0)]: 30,
    [iso(T0 + MINUTE_MS)]: { usd: 33, byFeature: { [OPUS_OUT]: 30, [FABLE_OUT]: 3 } },
  }
  const { host, runs, logs } = fakeHost('session-1', dollars, store)
  const week = (percentUsed: number): SessionRateLimit => ({ kind: 'seven_day', percentUsed, resetsAt: RESET_WEEK })
  await refresh(host, [fiveHour(5), week(2)], true, true, T0)
  expect(logs).toEqual([])
  const limits = store.limits as Record<string, Record<string, unknown>>
  expect(limits[ORG]!.five_hour).toEqual({ percentUsed: 5, resetsAt: RESET_5H, observedAt: T0, sessionId: 'session-1', stamp: 2 })
  const bucket = readingsOf(store, 'five_hour')!.byPct['5']!
  expect(bucket.maxUsd).toBe(30)
  expect(bucket.maxAt).toBe(T0)
  expect(readingsOf(store, 'seven_day')!.byPct['2']!.maxUsd).toBe(30)
  expect(windowArgs(runs).some(spec => spec.startsWith('session@read,') && spec.endsWith(`,${iso(T0)},session-1`))).toBe(true)
  expect(windowArgs(runs).some(spec => spec === `last7d,${iso(T0 - 7 * 24 * HOUR_MS)},${iso(T0)}`)).toBe(true)
  expect(diagnosticsOf().outcomes['5-hour window']).toEqual([{ source: 'mine', outcome: 'recorded' }])

  clock = T0 + MINUTE_MS
  await refresh(host, [fiveHour(5), week(2)], true, true, clock)
  expect(logs).toEqual([])
  for (const [kind, pct] of [
    ['five_hour', '5'],
    ['seven_day', '2'],
  ] as const) {
    const r = readingsOf(store, kind)!
    expect(r.features).toEqual([OPUS_OUT, FABLE_OUT])
    expect(r.byPct[pct]).toEqual({ minUsd: 30, minAt: T0, maxUsd: 33, maxAt: clock, minSlack: 0, maxSlack: 0, minX: [30], maxX: [30, 3] })
  }
  await backfillSettled()
  expect(backfillRuns(runs)).toEqual([])
})

test('a stored percent without a reading is recorded by the next measure that is not fresh', async () => {
  const at = T0 + 10 * MINUTE_MS
  clock = at + 2 * MINUTE_MS
  const store: Record<string, unknown> = {
    schema: 5,
    limits: { [ORG]: { five_hour: { percentUsed: 7, resetsAt: RESET_5H, observedAt: at, sessionId: 'session-2', stamp: 2 } } },
  }
  const { host, runs, logs } = fakeHost('session-1', { [iso(at)]: 44 }, store)
  await refresh(host, undefined, true)
  expect(logs).toEqual([])
  const bucket = readingsOf(store, 'five_hour')!.byPct['7']!
  expect(bucket.maxUsd).toBe(44)
  expect(bucket.maxAt).toBe(at)
  expect(bucket.maxX).toEqual([44])
  expect(windowArgs(runs).some(spec => spec.startsWith('session@stored,') && spec.endsWith(`,${iso(at)},session-2`))).toBe(true)
  expect(diagnosticsOf().outcomes['5-hour window']).toEqual([{ source: 'stored', outcome: 'recorded' }])
  await backfillSettled()
})

test("a fresh measure with a later stored percent of another session records both", async () => {
  const mine = T0 + 20 * MINUTE_MS
  const theirs = mine + 30 * 1000
  clock = mine + MINUTE_MS
  const store: Record<string, unknown> = {
    schema: 5,
    limits: { [ORG]: { five_hour: { percentUsed: 9, resetsAt: RESET_5H, observedAt: theirs, sessionId: 'session-2', stamp: 2 } } },
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
  await backfillSettled()
})

test('a stored percent without a stamp is not recorded, and shows other hooks', async () => {
  const at = T0 + 30 * MINUTE_MS
  clock = at + MINUTE_MS
  const store: Record<string, unknown> = {
    schema: 5,
    limits: { [ORG]: { five_hour: { percentUsed: 11, resetsAt: RESET_5H, observedAt: at } } },
  }
  const { host, runs, logs } = fakeHost('session-1', { [iso(at)]: 60 }, store)
  await refresh(host, undefined, true)
  expect(logs).toEqual([])
  expect(readingsOf(store, 'five_hour')).toBeUndefined()
  expect(windowArgs(runs).some(spec => spec.includes('@stored'))).toBe(false)
  expect(diagnosticsOf().otherHooks).toBe('older')
  await backfillSettled()
})

test('a stored reading priced with another table is dropped and counted', async () => {
  clock = T0 + 40 * MINUTE_MS
  const store: Record<string, unknown> = {
    schema: 5,
    limits: { [ORG]: { five_hour: { resetsAt: RESET_5H, observedAt: T0, sessionId: 'session-2', stamp: 2 } } },
    readings: {
      [keyOf('five_hour', RESET_5H)]: {
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
  await backfillSettled()
})

/* Two closed 5-hour windows without features, newest first: A, one reading at atA, and B,
   one at atB. */
const RESET_A = iso(T0 - HOUR_MS)
const RESET_B = iso(T0 - 6 * HOUR_MS)
const AT_A = T0 - 2 * HOUR_MS
const AT_B = T0 - 7 * HOUR_MS
const unfilledReadings = () => ({
  [keyOf('five_hour', RESET_A)]: plainWindow('five_hour', RESET_A, { '10': { usd: 40, at: AT_A } }),
  [keyOf('five_hour', RESET_B)]: plainWindow('five_hour', RESET_B, { '20': { usd: 50, at: AT_B } }),
})

test('the backfill fills a matching side and marks a mismatch, in a second helper call', async () => {
  clock = T0 + 130 * MINUTE_MS
  const store: Record<string, unknown> = { schema: 5, readings: unfilledReadings() }
  const dollars: Dollars = {
    [iso(clock)]: 10,
    [iso(AT_A)]: { usd: 40, byFeature: { [OPUS_OUT]: 30, [FABLE_OUT]: 10 } },
    [iso(AT_B)]: 55,
  }
  const { host, runs, logs } = fakeHost('session-1', dollars, store)
  await refresh(host, [fiveHourNext(1)], true, true, clock)
  await backfillSettled()
  expect(logs).toEqual([])
  const backfills = backfillRuns(runs)
  expect(backfills.length).toBe(1)
  const measured = runs.findIndex(argv => windowArgs([argv]).some(spec => spec.startsWith('session,')))
  expect(runs.indexOf(backfills[0]!)).toBeGreaterThan(measured)
  expect(windowArgs(backfills)).toEqual([
    `bf0,${iso(Date.parse(RESET_A) - 5 * HOUR_MS)},${RESET_A},${iso(AT_A)}`,
    `bf1,${iso(Date.parse(RESET_B) - 5 * HOUR_MS)},${RESET_B},${iso(AT_B)}`,
  ])
  const readings = (store as Stored).readings!
  const a = readings[keyOf('five_hour', RESET_A)]!
  expect(a.features).toEqual([FABLE_OUT, OPUS_OUT])
  expect(a.byPct['10']!.minX).toEqual([10, 30])
  expect(a.byPct['10']!.maxX).toEqual([10, 30])
  const b = readings[keyOf('five_hour', RESET_B)]!
  expect(b.featuresUnverified).toBe(true)
  expect(b.byPct['20']!.minX).toBeUndefined()

  clock += MINUTE_MS
  await refresh(host, undefined, true)
  await backfillSettled()
  expect(backfillRuns(runs).length).toBe(1)
})

test('a failing backfill leaves the readings and the measure unchanged', async () => {
  clock = T0 + 140 * MINUTE_MS
  const store: Record<string, unknown> = { schema: 5, readings: unfilledReadings() }
  const dollars: Dollars = { [iso(clock)]: 10, [iso(AT_A)]: 40, [iso(AT_B)]: 50 }
  const { host, runs, logs, statuses } = fakeHost('session-1', dollars, store, { failBackfill: true })
  const summary = await refresh(host, [fiveHourNext(1)], true, true, clock)
  const measured = JSON.parse(JSON.stringify(store.readings))
  const shown = [...statuses]
  await backfillSettled()
  expect(backfillRuns(runs).length).toBe(1)
  expect(logs).toEqual(['usage-dollars: backfill: scan failed'])
  expect(store.readings).toEqual(measured)
  expect(statuses).toEqual(shown)
  expect(summary?.subscription).toBe(ORG)
  expect(summary?.windows.map(s => s.tally.usd)).toEqual([100])
  expect(Object.values((store as Stored).readings!).some(r => r.featuresUnverified)).toBe(false)
})

test('a backfill call holds at most 100 window specs, newest windows first', async () => {
  clock = T0 + 150 * MINUTE_MS
  const levels = (resetsAt: string) => {
    const start = Date.parse(resetsAt) - 5 * HOUR_MS
    const list: Record<string, { usd: number; at: number }> = {}
    for (let p = 1; p <= 60; p++) list[String(p)] = { usd: p, at: start + p * MINUTE_MS }
    return list
  }
  const store: Record<string, unknown> = {
    schema: 5,
    readings: {
      [keyOf('five_hour', RESET_A)]: plainWindow('five_hour', RESET_A, levels(RESET_A)),
      [keyOf('five_hour', RESET_B)]: plainWindow('five_hour', RESET_B, levels(RESET_B)),
    },
  }
  const dollars: Dollars = { [iso(clock)]: 10 }
  for (const resetsAt of [RESET_A, RESET_B]) for (const { usd, at } of Object.values(levels(resetsAt))) dollars[iso(at)] = usd
  const { host, runs, logs } = fakeHost('session-1', dollars, store)
  await refresh(host, [fiveHourNext(1)], true, true, clock)
  await backfillSettled()
  const first = windowArgs(backfillRuns(runs))
  expect(first.length).toBe(100)
  expect(first.slice(0, 60).every(spec => spec.includes(`,${RESET_A},`))).toBe(true)
  expect(first.slice(60).every(spec => spec.includes(`,${RESET_B},`))).toBe(true)

  clock += MINUTE_MS
  await refresh(host, undefined, true)
  await backfillSettled()
  const all = backfillRuns(runs)
  expect(all.length).toBe(2)
  expect(windowArgs(all.slice(1)).length).toBe(20)
  expect(logs).toEqual([])
  for (const r of Object.values((store as Stored).readings!)) for (const b of Object.values(r.byPct)) expect(b.minX).toBeDefined()
})

test('the size guard drops the oldest closed window', async () => {
  clock = T0 + 160 * MINUTE_MS
  const oldest = iso(T0 - 20 * HOUR_MS)
  const newer = iso(T0 - HOUR_MS)
  const padded = Array.from({ length: 40_000 }, (_, i) => `${OPUS_OUT}-${String(i).padStart(70, '0')}`)
  const filled = (resetsAt: string, features: string[]): Reading => ({
    kind: 'five_hour',
    resetsAt,
    byPct: { '5': { minUsd: 5, minAt: Date.parse(resetsAt) - HOUR_MS, maxUsd: 5, maxAt: Date.parse(resetsAt) - HOUR_MS, minX: [5], maxX: [5] } },
    org: ORG,
    pricesId: PRICES_ID,
    features,
  })
  const store: Record<string, unknown> = {
    schema: 5,
    readings: { [keyOf('five_hour', oldest)]: filled(oldest, padded), [keyOf('five_hour', newer)]: filled(newer, [OPUS_OUT]) },
  }
  const { host } = fakeHost('session-1', { [iso(clock)]: 10 }, store)
  const before = diagnosticsOf().droppedForSize
  await refresh(host, [fiveHourNext(1)], true, true, clock)
  await backfillSettled()
  const readings = (store as Stored).readings!
  expect(readings[keyOf('five_hour', oldest)]).toBeUndefined()
  expect(readings[keyOf('five_hour', newer)]).toBeDefined()
  expect(readings[keyOf('five_hour', RESET_NEXT)]).toBeDefined()
  expect(diagnosticsOf().droppedForSize).toBe(before + 1)
})

test('the model fit is stored once for an unchanged fingerprint', async () => {
  clock = T0 + 170 * MINUTE_MS
  const store: Record<string, unknown> = { schema: 5, readings: { [keyOf('five_hour', RESET_A)]: featureWindow(RESET_A, 1) } }
  const { host, sets } = fakeHost('session-1', { [iso(clock)]: 10, [iso(clock + MINUTE_MS)]: 12 }, store)
  await refresh(host, [fiveHourNext(1)], true, true, clock)
  await backfillSettled()
  expect(sets.filter(key => key === 'meter').length).toBe(1)
  expect((store as Stored).meter![ORG]!.included.five_hour).toEqual([keyOf('five_hour', RESET_A)])

  clock += MINUTE_MS
  await refresh(host, [fiveHourNext(1)], true, true, clock)
  await backfillSettled()
  expect(sets.filter(key => key === 'meter').length).toBe(1)
})

test('a prospective record is appended once per new window', async () => {
  clock = T0 + 180 * MINUTE_MS
  const resetC = iso(T0 - 11 * HOUR_MS)
  const store: Record<string, unknown> = {
    schema: 5,
    readings: {
      [keyOf('five_hour', RESET_A)]: featureWindow(RESET_A, 1),
      [keyOf('five_hour', RESET_B)]: featureWindow(RESET_B, 0.5),
    },
    meter: meterWith(FABLE_TWICE),
  }
  const { host, logs } = fakeHost('session-1', { [iso(clock)]: 10, [iso(clock + MINUTE_MS)]: 12 }, store)
  await refresh(host, [fiveHourNext(1)], true, true, clock)
  await backfillSettled()
  expect(logs).toEqual([])
  const first = (store as Stored).meter![ORG]!
  expect(first.prospective.map(p => [p.kind, p.resetsAt]).sort()).toEqual([
    ['five_hour', RESET_A],
    ['five_hour', RESET_B],
  ].sort())
  expect(first.prospective.every(p => Number.isFinite(p.d))).toBe(true)

  /* The stored fit keeps the weights; one more window qualifies. */
  first.fits.five_hour = { weights: FABLE_TWICE, omega: 0.3, omegaM0: 0.3 }
  ;(store as Stored).readings![keyOf('five_hour', resetC)] = featureWindow(resetC, 0.25)
  clock += MINUTE_MS
  await refresh(host, [fiveHourNext(1)], true, true, clock)
  await backfillSettled()
  const second = (store as Stored).meter![ORG]!
  expect(second.prospective.length).toBe(3)
  expect(second.prospective.slice(0, 2)).toEqual(first.prospective)
  expect(second.prospective[2]!.resetsAt).toBe(resetC)
})

test('no prospective record is appended under an M0 fit', async () => {
  clock = T0 + 190 * MINUTE_MS
  const store: Record<string, unknown> = {
    schema: 5,
    readings: {
      [keyOf('five_hour', RESET_A)]: featureWindow(RESET_A, 1),
      [keyOf('five_hour', RESET_B)]: featureWindow(RESET_B, 0.5),
    },
    meter: meterWith(UNIT),
  }
  const { host } = fakeHost('session-1', { [iso(clock)]: 10 }, store)
  await refresh(host, [fiveHourNext(1)], true, true, clock)
  await backfillSettled()
  const meter = (store as Stored).meter![ORG]!
  expect(meter.prospective).toEqual([])
  expect(meter.included.five_hour.length).toBe(2)
})

test('the models report says how many windows qualify before a fit', async () => {
  clock = T0 + 200 * MINUTE_MS
  const store: Record<string, unknown> = {
    schema: 5,
    limits: { [ORG]: { five_hour: { percentUsed: 1, resetsAt: RESET_NEXT, observedAt: clock - MINUTE_MS, sessionId: 'session-2', stamp: 2 } } },
    readings: {
      [keyOf('five_hour', RESET_A)]: featureWindow(RESET_A, 1),
      [keyOf('five_hour', RESET_B)]: featureWindow(RESET_B, 0.5),
    },
  }
  const { host } = fakeHost('session-1', { [iso(clock - MINUTE_MS)]: 10 }, store)
  const report = await modelsReport(host)
  expect(report.type).toBe('models')
  expect(report.isFitted).toBe(false)
  expect(report.qualifying).toBe(2)
  expect(report.needed).toBe(4)
  expect(report.selected).toBe('M0')
  expect(report.fits).toEqual([])
  expect(report.omegas.map(o => o.title)).toEqual(['5-hour windows', 'Weeks'])
  expect(report.prospective.map(p => p.n)).toEqual([0, 0])
  expect(report.transfer.isChecked).toBe(false)
})

import { expect, test } from 'claude-code/testing'
import type { SessionRateLimit } from 'claude-code'

import { FABLE_CAP_TEXT, backfillSettled, checkReport, diagnosticsOf, modelsReport, refresh, toReport } from '../hooks/measure'
import type { Host } from '../hooks/measure'
/* expect(actual).toBeCloseTo(expected, digits), which claude-code/testing lacks. */
const expectNear = (actual: number | undefined, expected: number, digits: number) =>
  expect(Math.abs((actual ?? NaN) - expected)).toBeLessThan(10 ** -digits / 2)

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

/* A tally's dollars, by feature when given, with its Fable part; a bare number is all Opus
   output. */
type Dollars = Record<string, number | { usd: number; byFeature: Record<string, number>; fable?: { usd: number; requests: number } }>

type HostOptions = { failBackfill?: boolean; profile?: unknown; checkSummary?: unknown }

/* A host whose helper answers --whoami from the profile, --check-summary from
   options.checkSummary, and a --window run with a tally for every --window name, its
   dollars looked up by the window's 4th field, or without one by its name (else $100);
   with failBackfill, a run with a backfill spec fails. */
function fakeHost(sessionId: string, dollars: Dollars, store: Record<string, unknown>, options: HostOptions = {}) {
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
      if (argv.includes('--whoami')) return answer({ org: ORG, orgSource: 'profile', profile: options.profile ?? null })
      if (argv.includes('--check-summary'))
        return answer(options.checkSummary ?? { sessions: 0, medianRatio: null, lowRatio: null, highRatio: null, ms: 1 })
      const specs = argv.filter((_, i) => argv[i - 1] === '--window')
      if (options.failBackfill && specs.some(spec => spec.startsWith('bf'))) return { stdout: '', stderr: 'scan failed', exitCode: 1 }
      const windows: Record<string, unknown> = {}
      for (const spec of specs) {
        const [name, , , until] = spec.split(',')
        const found = until !== undefined ? (dollars[until] ?? 0) : (dollars[name!] ?? 100)
        const tally = typeof found === 'number' ? { usd: found, byFeature: found > 0 ? { [OPUS_OUT]: found } : {} } : found
        windows[name!] = {
          usd: tally.usd,
          requests: 1,
          byModel: {},
          byFeature: tally.byFeature,
          ...('fable' in tally && tally.fable ? { fable: tally.fable } : {}),
          otherSubscriptionsUsd: 0,
          unattributedUsd: 0,
          unpricedRequests: 0,
          unpricedModels: [],
          slackUsd: 0,
        }
      }
      return answer({ org: ORG, orgSource: 'profile', profile: options.profile ?? null, labels: {}, pricesId: PRICES_ID, windows, files: 1, ms: 1 })
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

/* Max and Ultra: Fable's derived window, the weeks and 5-hour windows its cap leaves out,
   and a reported percent that falls. These tests run in November 2026, after the ones above. */

const DAY_MS = 24 * HOUR_MS
const FABLE_52 = 'claude-fable-5-2/out'

const profileOf = (organizationType: string, rateLimitTier: string | null) => ({
  org: ORG,
  organizationType,
  rateLimitTier,
  userRateLimitTier: null,
  seatTier: null,
  billingType: 'stripe_subscription',
  subscriptionCreatedAt: '2026-09-01T08:00:00.000Z',
  fetchedAt: '2026-11-01T08:00:00.000Z',
  fetchedLabel: 'Sun 1 Nov, 10:00',
  promotions: [],
})
const ULTRA = profileOf('claude_max', 'default_claude_max_20x')
const MAX = profileOf('claude_max', 'default_claude_max_5x')
const PRO = profileOf('claude_pro', null)

const weekOf = (percentUsed: number, resetsAt: string): SessionRateLimit => ({ kind: 'seven_day', percentUsed, resetsAt })

/* $200 at a reading: $150 Opus 5.5 and $50 Fable 5.2 output, 3 Fable requests. */
const MIXED = { usd: 200, byFeature: { [OPUS_OUT]: 150, [FABLE_52]: 50 }, fable: { usd: 50, requests: 3 } }

/* One fresh measure of a week at 20% with MIXED dollars, on a store of its own. */
async function measureWeek(at: number, resetsAt: string, profile: unknown, store: Record<string, unknown> = { schema: 5 }) {
  clock = at
  const { host, logs } = fakeHost('session-1', { [iso(at)]: MIXED, week: MIXED }, store, { profile })
  const summary = await refresh(host, [weekOf(20, resetsAt)], true, true, at)
  await backfillSettled()
  return { summary, logs, store }
}

/* Fable counted at half of Opus 5.5 on the weeks, from a fitted 5-hour study. */
const FABLE_HALF = { model: 'M1', reference: 'claude-opus-5-5', free: ['claude-fable-5-2'], theta: [Math.log(0.5)], cov: [[0]], df: 3 }
const meterFitted = (weights: unknown) => ({
  [ORG]: {
    ...meterWith(weights)[ORG],
    selection: { selected: 'M1', weights, fits: { M0: {}, M1: {} } },
    transfer: { isRejected: false, isChecked: false, weeks: 0 },
    fits: { five_hour: { weights, omega: 0.3, omegaM0: 0.3 }, seven_day: { weights, omega: 0.5, omegaM0: 0.5 } },
  },
})

test('the Fable window appears on Max and Ultra, as half the plain weekly allowance while assumed, and not on Pro nor without a profile', async () => {
  const at = Date.parse('2026-11-10T12:00:00.000Z')
  const reset = '2026-11-16T00:00:00.000Z'
  for (const [i, profile] of [ULTRA, MAX].entries()) {
    const { summary, logs } = await measureWeek(at + i * MINUTE_MS, reset, profile)
    expect(logs).toEqual([])
    const week = summary!.windows.find(s => s.title === 'This week')!
    const fable = summary!.fable!
    expect(fable.weightSource).toBe('assumed')
    expect(fable.usedUsd).toBe(50)
    expect(fable.requests).toBe(3)
    expect(fable.share).toBe(0.5)
    expectNear(fable.allowance!.value, week.estimate!.allowance.value / 2, 9)
    expect(fable.relativeTo).toBeUndefined()
  }
  expect((await measureWeek(at + 2 * MINUTE_MS, reset, PRO)).summary!.fable).toBeUndefined()
  expect((await measureWeek(at + 3 * MINUTE_MS, reset, undefined)).summary!.fable).toBeUndefined()
  /* A stored fit without a selection or a transfer: still assumed, and the measure runs. */
  const partial = await measureWeek(at + 4 * MINUTE_MS, reset, ULTRA, { schema: 5, meter: meterWith(FABLE_TWICE) })
  expect(partial.logs).toEqual([])
  expect(partial.summary!.fable!.weightSource).toBe('assumed')
})

test("with Fable weighted below 1, Fable's allowance in its own dollars is larger, and the week's estimate is unchanged", async () => {
  const at = Date.parse('2026-11-10T13:00:00.000Z')
  const reset = '2026-11-16T00:00:00.000Z'
  const plain = await measureWeek(at, reset, ULTRA)
  const weighted = await measureWeek(at + MINUTE_MS, reset, ULTRA, { schema: 5, meter: meterFitted(FABLE_HALF) })
  expect(weighted.logs).toEqual([])
  const weekOfSummary = (s: typeof plain.summary) => s!.windows.find(w => w.title === 'This week')!.estimate!.allowance.value
  expectNear(weekOfSummary(weighted.summary), weekOfSummary(plain.summary), 9)
  const fable = weighted.summary!.fable!
  expect(fable.weightSource).toBe('five-hour')
  expect(fable.relativeTo).toBe('Opus 5.5')
  expect(fable.isReference).toBe(false)
  expectNear(fable.mix.value, 0.5, 9)
  /* The week counts $175 of $200 in meter units; Fable's half of it, at weight 0.5. */
  expectNear(fable.allowance!.value / plain.summary!.fable!.allowance!.value, 175 / 200 / 0.5, 6)
})

/* A closed week at Fable's cap from capAt on, and two closed 5-hour windows with Fable
   dollars, one ending before capAt and one after it. */
function cappedStore(weekReset: string, capAt: number) {
  const features = [FABLE_52, OPUS_OUT]
  const side = (fable: number, opus: number, at: number) => ({ minUsd: fable + opus, minAt: at, maxUsd: fable + opus, maxAt: at, minX: [fable, opus], maxX: [fable, opus] })
  const week: Reading = {
    kind: 'seven_day',
    resetsAt: weekReset,
    byPct: { '20': side(10, 10, capAt - 3 * DAY_MS), '60': side(50, 10, capAt), '70': side(60, 10, capAt + HOUR_MS) },
    org: ORG,
    pricesId: PRICES_ID,
    features,
  }
  const fiveHourAt = (resetsAt: number): Reading => ({
    kind: 'five_hour',
    resetsAt: iso(resetsAt),
    byPct: { '10': side(2, 3, resetsAt - 2 * HOUR_MS), '20': side(4, 6, resetsAt - HOUR_MS) },
    org: ORG,
    pricesId: PRICES_ID,
    features,
  })
  const before = capAt - DAY_MS
  const after = capAt + 3 * HOUR_MS
  return {
    keys: { week: keyOf('seven_day', weekReset), before: keyOf('five_hour', iso(before)), after: keyOf('five_hour', iso(after)) },
    store: {
      schema: 5,
      readings: {
        [keyOf('seven_day', weekReset)]: week,
        [keyOf('five_hour', iso(before))]: fiveHourAt(before),
        [keyOf('five_hour', iso(after))]: fiveHourAt(after),
      },
    } as Record<string, unknown>,
  }
}

test("a capped closed week and a 5-hour window after its cap are left out of calibration, and the fit stores the cap", async () => {
  const at = Date.parse('2026-11-10T14:00:00.000Z')
  const capAt = Date.parse('2026-11-07T00:00:00.000Z')
  const { keys, store } = cappedStore('2026-11-09T00:00:00.000Z', capAt)
  clock = at
  const live = [weekOf(20, '2026-11-16T00:00:00.000Z'), { kind: 'five_hour', percentUsed: 5, resetsAt: '2026-11-10T16:00:00.000Z' } as SessionRateLimit]
  const { host, logs, sets } = fakeHost('session-1', { [iso(at)]: MIXED, week: MIXED, session: MIXED }, store, { profile: ULTRA })
  const summary = await refresh(host, live, true, true, at)
  await backfillSettled()
  expect(logs).toEqual([])
  const week = summary!.windows.find(s => s.title === 'This week')!
  const fiveHour = summary!.windows.find(s => s.title === '5-hour window')!
  expect(week.calibration.fableCapped).toBe(1)
  expect(week.calibration.closedWindows).toBe(0)
  expect(week.estimate!.pastWindows).toBe(0)
  expect(fiveHour.calibration.fableCapped).toBe(1)
  expect(fiveHour.calibration.closedWindows).toBe(1)
  const meter = (store as Stored).meter![ORG] as unknown as { capped: Record<string, number>; included: Record<string, string[]> }
  expect(meter.capped).toEqual({ [keys.week]: capAt })
  expect(meter.included.five_hour).toEqual([keys.before])
  expect(meter.included.seven_day).toEqual([])
  const stored = sets.filter(key => key === 'meter').length

  clock = at + MINUTE_MS
  await refresh(host, live, true, true, clock)
  await backfillSettled()
  expect(sets.filter(key => key === 'meter').length).toBe(stored)

  /* On Pro there is no Fable cap: the same windows all count. */
  const pro = cappedStore('2026-11-09T00:00:00.000Z', capAt)
  clock = at + 2 * MINUTE_MS
  const plain = fakeHost('session-1', { [iso(clock)]: MIXED, week: MIXED, session: MIXED }, pro.store, { profile: PRO })
  const proSummary = await refresh(plain.host, live, true, true, clock)
  await backfillSettled()
  expect(proSummary!.windows.find(s => s.title === 'This week')!.calibration.closedWindows).toBe(1)
  expect(proSummary!.windows.find(s => s.title === 'This week')!.calibration.fableCapped).toBeUndefined()
})

test('a percent that falls is a suspicion, then a fall: nothing more is recorded, and left follows the percent', async () => {
  const reset = '2026-11-23T00:00:00.000Z'
  const key = keyOf('seven_day', reset)
  const t = (minutes: number) => Date.parse('2026-11-17T10:00:00.000Z') + minutes * MINUTE_MS
  const dollars: Dollars = {}
  const store: Record<string, unknown> = {
    schema: 5,
    history: { [ORG]: { scannedAt: t(0), observations: [{ kind: 'seven_day', resetsAt: reset, at: iso(t(45)), usd: 500 }] } },
  }
  const { host, logs, runs } = fakeHost('session-1', dollars, store, { profile: ULTRA })
  const at = async (minutes: number, percent: number, usd: number) => {
    clock = t(minutes)
    dollars[iso(clock)] = { usd, byFeature: { [OPUS_OUT]: usd - 20, [FABLE_52]: 20 }, fable: { usd: 20, requests: 2 } }
    dollars.week = dollars[iso(clock)]!
    const summary = await refresh(host, [weekOf(percent, reset)], true, true, clock)
    await backfillSettled()
    return summary!
  }
  const levels = () => Object.keys(readingsOf(store, 'seven_day')!.byPct).sort()
  const fallOfStore = () => (readingsOf(store, 'seven_day') as Reading & { fall?: { lastAt: number; seenAt: number; isConfirmed: boolean } }).fall

  await at(0, 40, 400)
  await at(10, 37, 410)
  expect(levels()).toEqual(['40'])
  expect(fallOfStore()).toEqual({ lastAt: t(0), seenAt: t(10), isConfirmed: false })
  expect(diagnosticsOf().outcomes['This week']).toEqual([{ source: 'mine', outcome: 'fell' }])

  await at(20, 41, 420)
  expect(levels()).toEqual(['40', '41'])
  expect(fallOfStore()).toBeUndefined()

  await at(30, 30, 430)
  const confirming = await at(40, 31, 440)
  expect(levels()).toEqual(['40', '41'])
  expect(fallOfStore()).toEqual({ lastAt: t(20), seenAt: t(30), isConfirmed: true })
  /* This session's own lower percent of the measure before comes back as the stored one. */
  expect(diagnosticsOf().outcomes['This week']).toEqual([
    { source: 'stored', outcome: 'fell' },
    { source: 'mine', outcome: 'fell' },
  ])
  expect(confirming.fable).toBeUndefined()
  const report = toReport(confirming, clock).windows[0]!
  const allowance = confirming.windows[0]!.estimate!.allowance
  expect(report.isFallen).toBe(true)
  expectNear(report.left!.value, allowance.value * 0.69, 9)
  expect(report.nextTick).toBeUndefined()
  expect(report.basis).toContain('the reported percent fell in this window')
  expect(confirming.notices.some(n => n.startsWith('This week: the reported percent fell'))).toBe(true)

  /* The week is counted for Fable from the fall on, and the rejection after it is no past point. */
  dollars['week@fall'] = { usd: 30, byFeature: { [OPUS_OUT]: 18, [FABLE_52]: 12 }, fable: { usd: 12, requests: 1 } }
  const after = await at(50, 32, 450)
  expect(logs).toEqual([])
  expect(windowArgs(runs).some(spec => spec === `week@fall,${iso(t(20) + 1)},${reset}`)).toBe(true)
  expect(after.fable!.usedUsd).toBe(12)
  expect(after.fable!.requests).toBe(1)
  expect(after.fable!.isSinceFall).toBe(true)
  expect(after.windows[0]!.estimate!.pastWindows).toBe(0)
  expect(diagnosticsOf().outcomes['This week']!.map(o => o.outcome)).toEqual(['fell', 'fell'])
  const notices = (store.notices as { id: string }[]).filter(n => n.id === `fell:${key}`)
  expect(notices.length).toBe(1)
})

test('the Fable cap notice is queued once the derived cap is reached', async () => {
  const at = Date.parse('2026-11-18T10:00:00.000Z')
  const reset = '2026-11-23T00:00:00.000Z'
  clock = at
  const heavy = { usd: 200, byFeature: { [OPUS_OUT]: 10, [FABLE_52]: 190 }, fable: { usd: 190, requests: 9 } }
  const { host } = fakeHost('session-1', { [iso(at)]: heavy, week: heavy }, { schema: 5 }, { profile: ULTRA })
  /* $200 at 55%: an allowance near $360, of which Fable's half is near $180. */
  const summary = await refresh(host, [weekOf(55, reset)], true, true, at)
  await backfillSettled()
  expect(summary!.fable!.isCapLikely).toBe(true)
  expect(summary!.notices).toContain(FABLE_CAP_TEXT)
})

test('a live limit of an unknown kind reaches the check report, with the limits the helper found in transcripts', async () => {
  const at = Date.parse('2026-11-19T10:00:00.000Z')
  clock = at
  const checkSummary = {
    sessions: 0,
    medianRatio: null,
    lowRatio: null,
    highRatio: null,
    unknownLimits: [{ kind: 'seven_day_fable', status: 'allowed_warning', overageStatus: 'allowed', isUsingOverage: false, count: 2, lastAt: '2026-11-10T10:31:00.000Z' }],
    creditMarked: { requests: 1, lastAt: '2026-11-10T10:10:00.000Z' },
    ms: 1,
  }
  const { host } = fakeHost('session-1', { [iso(at)]: 10 }, { schema: 5 }, { checkSummary })
  const odd = { kind: 'seven_day_fable', percentUsed: 12, resetsAt: '2026-11-23T00:00:00.000Z' } as unknown as SessionRateLimit
  await refresh(host, [weekOf(5, '2026-11-23T00:00:00.000Z'), odd], true, true, at)
  await backfillSettled()
  expect(diagnosticsOf().unknownKinds).toContain('seven_day_fable')
  const report = await checkReport(host)
  await backfillSettled()
  const labels = report.items.map(i => i.label)
  const item = report.items.find(i => i.label === 'Limits not measured')!
  expect(labels.indexOf('Limits not measured')).toBe(labels.indexOf('Prices') + 1)
  expect(item.state).toBe('info')
  expect(item.text).toContain('reported live: seven_day_fable')
  expect(item.text).toContain('seven_day_fable allowed_warning, overage allowed, ×2, last 2026-11-10T10:31:00.000Z')
  expect(item.text).toContain('1 request carries a fallback credit')
})

test('the models report flags a subscription with a week and no 5-hour limit, once its weekly readings are a day old', async () => {
  const reset = '2026-11-23T00:00:00.000Z'
  for (const [hoursOld, isAbsent] of [
    [30, true],
    [2, false],
  ] as const) {
    clock += 10 * MINUTE_MS
    const store: Record<string, unknown> = {
      schema: 5,
      limits: { [ORG]: { seven_day: { percentUsed: 6, resetsAt: reset, observedAt: clock - MINUTE_MS, sessionId: 'session-2', stamp: 2 } } },
      readings: { [keyOf('seven_day', reset)]: plainWindow('seven_day', reset, { '5': { usd: 50, at: clock - hoursOld * HOUR_MS } }) },
    }
    const { host } = fakeHost('session-1', { [iso(clock - MINUTE_MS)]: 60 }, store, { profile: ULTRA })
    const report = await modelsReport(host)
    expect(report.isFiveHourAbsent ?? false).toBe(isAbsent)
  }
})

test('a closed week 40 days old is kept, and a closed 5-hour window 40 days old is not', async () => {
  clock += 10 * MINUTE_MS
  const old = iso(clock - 40 * DAY_MS)
  const store: Record<string, unknown> = {
    schema: 5,
    readings: {
      [keyOf('seven_day', old)]: plainWindow('seven_day', old, { '30': { usd: 300, at: Date.parse(old) - DAY_MS } }),
      [keyOf('five_hour', old)]: plainWindow('five_hour', old, { '30': { usd: 30, at: Date.parse(old) - HOUR_MS } }),
    },
  }
  const { host } = fakeHost('session-1', { [iso(clock)]: 10 }, store)
  await refresh(host, [weekOf(1, '2026-12-01T00:00:00.000Z')], true, true, clock)
  await backfillSettled()
  const readings = (store as Stored).readings!
  expect(readings[keyOf('seven_day', old)]).toBeDefined()
  expect(readings[keyOf('five_hour', old)]).toBeUndefined()
})
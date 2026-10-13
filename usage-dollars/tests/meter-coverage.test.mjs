/* Simulation study of the model meter weights in hooks/meter.ts, run with `node --test`
   (several minutes). Subscriptions are simulated request by request over consecutive
   weeks, with seeded generators; the weights are fitted on their closed 5-hour windows,
   and the allowance estimate under them is scored against the truth, beside the
   unweighted (M0) estimate on the same windows. The gates are pre-registered.

   A subscription works on WORK_DAY of its days, in 1 to MAX_SESSIONS sessions a day. A
   session draws its long-run share of model F from Beta(1, 3) and a spend; each request
   keeps the previous request's model with probability STAY and otherwise draws it from
   that share. A request costs c dollars (lognormal, log-sd 1.0, as in coverage.test.mjs),
   split into the classes read, in and out: its read share is uniform around the model's
   mean (O 60%, F 19%), and the rest is IN_SHARE in and the remainder out. Every request
   advances two counters with their own quotas: its 5-hour window, which starts at the
   first request after the previous one reset, and its fixed 7-day week. Each counter
   gains 100 · Σ_class rate · dollars / BASE percent, times a per-request noise
   exp(SD_REQUEST · z) that both share. After every request each counter reports its share
   rounded to a whole percent, recorded with record() and per-feature dollars under keys
   such as `O/read` and `F/out`; a counter at 100% rejects requests until it resets, which
   ends the session. In scenario U, a share of the 5-hour windows also carries an hour of
   meter use that no request shows, in both counters.

   Each subscription has HISTORY_WEEKS closed weeks. For each G, selectModel runs on the
   history from the G-th newest qualifying closed 5-hour window on, and transferCheck on
   the closed weeks with the selected weights. Evaluation windows continue a subscription
   after its history, a 5-hour one with sessions back to back, until the counter reaches
   100%, past its nominal reset if need be. Each is scored at SHARES through
   weightedEstimate: "weighted" with the selection at the scenario's evaluation G, the week
   under UNIT_WEIGHTS when the transfer is rejected; "baseline" under UNIT_WEIGHTS; and for
   the week, "transferred" under the selected weights whatever the transfer check says.

   Two truths per kept reading. U_100: the dollars counted when the share reaches 100%.
   The at-mix truth: E_100 · U_now / E_now, where E is the counter's true weighted dollars
   Σ_class rate · dollars (without noise or unseen use); it is the allowance at the mix so
   far, which a weighted estimate states, and equals U_100 when every rate is equal, as
   asserted in those scenarios. The gates score the weighted variants against the at-mix
   truth and the baseline against U_100; the other pairings are printed, not gated.

   METER_SIM_SCALE (default 1) scales the numbers of subscriptions and evaluation windows,
   for quick development runs only; the gates are asserted at any scale. */

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { record, tQuantile } from "../hooks/estimate.ts";
import { UNIT_WEIGHTS, isFeatureComplete, segmentsOf, selectModel, transferCheck, weightedEstimate } from "../hooks/meter.ts";

const STARTED = performance.now();

const SCALE = Number(process.env.METER_SIM_SCALE ?? 1);
if (!(SCALE > 0))
    throw new Error(`METER_SIM_SCALE must be a positive number, not ${process.env.METER_SIM_SCALE}`);
const SUBSCRIPTIONS = Math.max(1, Math.round(400 * SCALE));
const EVALUATION_WINDOWS = Math.max(1, Math.round(1000 * SCALE));

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const FIVE_HOUR_MS = 5 * HOUR_MS;
/* A Monday at 04:00 UTC: the weeks are fixed spans from it, and the days start at that hour. */
const EPOCH = Date.parse("2026-08-03T04:00:00.000Z");
const HISTORY_WEEKS = 4;
const MAX_EVALUATION_DAYS = 365;
const FIVE_HOUR = "five_hour";
const SEVEN_DAY = "seven_day";
const BASE_5H = 650;
const BASE_WEEK = 4500;
const MEAN_COST = 0.6;
const COST_SD = 1.0;
const SD_REQUEST = 0.3;
const STAY = 0.98;
const MODELS = ["O", "F"];
const CLASSES = ["read", "in", "out"];
const FEATURES = MODELS.flatMap(m => CLASSES.map(k => `${m}/${k}`));
/* Mean read share per model, and the half-width of a request's uniform read share as a
   fraction of the mean's distance to the nearer of 0 and 1. */
const READ_SHARE = [0.60, 0.19];
const READ_SPREAD = 0.8;
/* The share of a request's other dollars in the class in. */
const IN_SHARE = 0.3;
const WORK_DAY = 0.75;
const MAX_SESSIONS = 3;
/* Hours from the day's start to its first session, and between sessions. */
const FIRST_SESSION_HOURS = [4, 7];
const BREAK_HOURS = [0.5, 3];
const EVALUATION_BREAK_HOURS = [0, 0.5];
/* A session's spend, in BASE_5H dollars. */
const SESSION_SPEND = [0.1, 0.7];
const REQUEST_SECONDS = [5, 25];
/* Unseen use, in 5-hour quotas, spread over UNSEEN_HOURS from a start within the window's
   first UNSEEN_START_HOURS. */
const UNSEEN_USE = [0.1, 0.3];
const UNSEEN_HOURS = 1;
const UNSEEN_START_HOURS = 4;
const RESOLUTION = 1;
const ROUNDING = "round";
const OPTIONS = { resolution: RESOLUTION, rounding: ROUNDING };
const SHARES = [3, 10, 25, 50, 90];
const GS = [5, 10, 20];
/* Non-excluded segments a closed 5-hour window needs to enter the fit (S3). */
const QUALIFYING_SEGMENTS = 2;
const SEED = 3000;

const UNIT = { O: { read: 1, in: 1, out: 1 }, F: { read: 1, in: 1, out: 1 } };
const fableAt = c => ({ O: UNIT.O, F: { read: c, in: c, out: c } });
const readAt = c => ({ O: { read: c, in: 1, out: 1 }, F: { read: c, in: 1, out: 1 } });

/* Meter rates per counter, model and class. unseen: the share of 5-hour windows with
   unseen use. evaluationG: the G whose selection the evaluation windows use. thetaModel:
   the candidate whose θ̂ is scored against the truth. */
const SCENARIOS = [
    { id: "N0", title: "null", five: UNIT, week: UNIT, unseen: 0, evaluationG: 10, thetaModel: "M1" },
    { id: "W2", title: "F at twice its API price", five: fableAt(2), week: fableAt(2), unseen: 0, evaluationG: 10, thetaModel: "M1" },
    { id: "W05", title: "F at half its API price", five: fableAt(0.5), week: fableAt(0.5), unseen: 0, evaluationG: 10, thetaModel: "M1" },
    { id: "R", title: "cache reads at 0.4 of their API price", five: readAt(0.4), week: readAt(0.4), unseen: 0, evaluationG: 20, thetaModel: "M2" },
    { id: "U", title: "null with unseen use", five: UNIT, week: UNIT, unseen: 0.2, evaluationG: 10, thetaModel: "M1" },
    { id: "K", title: "5-hour counter as W2, weekly counter at the API price", five: fableAt(2), week: UNIT, unseen: 0, evaluationG: 10, thetaModel: "M1" }
];

const rateVectorOf = table => MODELS.flatMap(m => CLASSES.map(k => table[m][k]));

/* mulberry32, and normal deviates by Box-Muller. */
function generator(seed)
{
    let a = seed >>> 0;
    const uniform = () =>
    {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let spare;
    const normal = () =>
    {
        if (spare !== undefined)
        {
            const z = spare;
            spare = undefined;
            return z;
        }
        const u = 1 - uniform();
        const r = Math.sqrt(-2 * Math.log(u));
        const theta = 2 * Math.PI * uniform();
        spare = r * Math.sin(theta);
        return r * Math.cos(theta);
    };
    return { uniform, normal };
}

const between = (rng, [low, high]) => low + (high - low) * rng.uniform();

/* An FNV-style hash of the parts: one seed per scenario, purpose and index. */
function seedOf(...parts)
{
    let h = 2166136261;
    for (const p of parts)
    {
        h = Math.imul(h ^ p, 16777619);
        h ^= h >>> 15;
    }
    return h >>> 0;
}

/* Per-feature dollars as record() takes them: the features with dollars so far. */
function xOf(xs)
{
    const x = {};
    for (let i = 0; i < xs.length; i++)
    {
        if (xs[i] > 0)
            x[FEATURES[i]] = xs[i];
    }
    return x;
}

/* One counter of one window: its true share, its dollars, its true weighted dollars e
   (Σ rate · dollars, without noise or unseen use), per-feature dollars, and its readings. */
function counterOf(kind, base, rates, start, resetsAt)
{
    return {
        kind,
        base,
        rates,
        start,
        resetsAt,
        share: 0,
        usd: 0,
        e: 0,
        x: new Array(FEATURES.length).fill(0),
        w: { kind, resetsAt: new Date(resetsAt).toISOString(), byPct: {} },
        level: undefined,
        hasLast: false,
        lastUsd: 0,
        lastAt: 0,
        lastXs: new Array(FEATURES.length).fill(0),
        unseen: undefined
    };
}

/* A reading after a request. record() is called on the first and the last reading of each
   level, which leaves the same buckets as calling it on every reading, since the level and
   the dollars only grow within a window; the last one waits in lastUsd, lastAt, lastXs. */
function observe(k, at)
{
    const pct = Math.min(100, Math.round(k.share));
    if (pct === k.level)
    {
        k.hasLast = true;
        k.lastUsd = k.usd;
        k.lastAt = at;
        for (let i = 0; i < k.x.length; i++)
            k.lastXs[i] = k.x[i];
        return;
    }
    if (k.hasLast)
        k.w = record(k.w, k.level, k.lastUsd, k.lastAt, 0, xOf(k.lastXs));
    k.w = record(k.w, pct, k.usd, at, 0, xOf(k.x));
    k.level = pct;
    k.hasLast = false;
}

const readingsOf = k => (k.hasLast ? record(k.w, k.level, k.lastUsd, k.lastAt, 0, xOf(k.lastXs)) : k.w);

const finalLevelOf = w => Math.max(...Object.keys(w.byPct).map(Number));

/* The state of one simulated stream of requests. watch: the counter ("five" or "week")
   whose readings are kept at SHARES until it reaches 100%. */
function timelineOf(s, rng, options)
{
    return {
        rng,
        s,
        fiveRates: rateVectorOf(s.five),
        weekRates: rateVectorOf(s.week),
        hasWeek: options.hasWeek,
        isFiveResetting: options.isFiveResetting,
        isWeekResetting: options.isWeekResetting,
        isKeeping: options.isKeeping ?? false,
        watch: options.watch,
        five: undefined,
        week: undefined,
        closedFive: [],
        closedWeeks: [],
        intervals: [],
        previousAt: -Infinity,
        next: 0,
        pending: [],
        isDone: false,
        truth: undefined,
        truthE: undefined
    };
}

/* Unseen use of interval u that falls in (from, to]. */
const unseenOf = (u, from, to) => (Math.max(0, Math.min(to, u.t1) - Math.max(from, u.t0)) / (u.t1 - u.t0)) * u.use;

function advance(k, m, parts, usd, noise, unseen, at)
{
    let use = 0;
    for (let i = 0; i < parts.length; i++)
    {
        use += k.rates[m * CLASSES.length + i] * parts[i];
        k.x[m * CLASSES.length + i] += parts[i];
    }
    k.share += (100 * (use * noise + unseen)) / k.base;
    k.usd += usd;
    k.e += use;
    observe(k, at);
}

function watch(t, at)
{
    const k = t[t.watch];
    if (k.share >= 100)
    {
        t.isDone = true;
        t.truth = k.usd;
        t.truthE = k.e;
        return;
    }
    while (t.next < SHARES.length && k.share >= SHARES[t.next])
    {
        t.pending.push({ share: SHARES[t.next], w: readingsOf(k), usd: k.usd, e: k.e, x: xOf(k.x), pct: k.level, at });
        t.next++;
    }
}

/* One request at `at` of model m (0 for O, 1 for F): its dollars, or undefined when a
   counter at 100% rejects it. Windows that have reset close first; a new 5-hour window
   starts at this request. Unseen use since the previous request comes with it. */
function request(t, at, m)
{
    const { rng, s } = t;
    if (t.week && t.isWeekResetting && at >= t.week.resetsAt)
    {
        if (t.isKeeping)
            t.closedWeeks.push(readingsOf(t.week));
        t.week = undefined;
    }
    if (!t.week && t.hasWeek)
    {
        const start = EPOCH + Math.floor((at - EPOCH) / WEEK_MS) * WEEK_MS;
        t.week = counterOf(SEVEN_DAY, BASE_WEEK, t.weekRates, start, start + WEEK_MS);
    }
    if (t.five && t.isFiveResetting && at >= t.five.resetsAt)
    {
        if (t.isKeeping)
            t.closedFive.push(readingsOf(t.five));
        t.five = undefined;
    }
    if (!t.five)
    {
        t.five = counterOf(FIVE_HOUR, BASE_5H, t.fiveRates, at, at + FIVE_HOUR_MS);
        if (s.unseen > 0 && rng.uniform() < s.unseen)
        {
            const t0 = at + UNSEEN_START_HOURS * HOUR_MS * rng.uniform();
            t.five.unseen = { t0, t1: t0 + UNSEEN_HOURS * HOUR_MS, use: between(rng, UNSEEN_USE) * BASE_5H };
            t.intervals.push(t.five.unseen);
        }
    }
    if (t.five.share >= 100 || (t.week && t.week.share >= 100))
        return undefined;
    const unseenFive = t.five.unseen ? unseenOf(t.five.unseen, Math.max(t.previousAt, t.five.start), at) : 0;
    let unseenWeek = 0;
    if (t.week && t.intervals.length > 0)
    {
        for (const u of t.intervals)
            unseenWeek += unseenOf(u, Math.max(t.previousAt, t.week.start), at);
        t.intervals = t.intervals.filter(u => u.t1 > at);
    }
    const c = MEAN_COST * Math.exp(COST_SD * rng.normal() - (COST_SD * COST_SD) / 2);
    const mean = READ_SHARE[m];
    const read = c * (mean + READ_SPREAD * Math.min(mean, 1 - mean) * (2 * rng.uniform() - 1));
    const input = (c - read) * IN_SHARE;
    const parts = [read, input, c - read - input];
    const noise = Math.exp(SD_REQUEST * rng.normal());
    advance(t.five, m, parts, c, noise, unseenFive, at);
    if (t.week)
        advance(t.week, m, parts, c, noise, unseenWeek, at);
    t.previousAt = at;
    if (t.watch)
        watch(t, at);
    return c;
}

/* One work session from `at`, until its spend, a rejection, stopAt, or the watched counter
   reaching 100%. Returns the time after its last request. */
function session(t, at, stopAt)
{
    const { rng } = t;
    const shareF = 1 - Math.cbrt(1 - rng.uniform());
    const spend = between(rng, SESSION_SPEND) * BASE_5H;
    let m = rng.uniform() < shareF ? 1 : 0;
    let spent = 0;
    while (spent < spend && at < stopAt && !t.isDone)
    {
        const c = request(t, at, m);
        if (c === undefined)
            break;
        spent += c;
        at += between(rng, REQUEST_SECONDS) * 1000;
        if (rng.uniform() >= STAY)
            m = rng.uniform() < shareF ? 1 : 0;
    }
    return at;
}

function workDays(t, from, to)
{
    const { rng } = t;
    for (let day = from; day < to && !t.isDone; day += DAY_MS)
    {
        if (rng.uniform() >= WORK_DAY)
            continue;
        const sessions = 1 + Math.floor(MAX_SESSIONS * rng.uniform());
        let at = day + between(rng, FIRST_SESSION_HOURS) * HOUR_MS;
        for (let i = 0; i < sessions && !t.isDone; i++)
        {
            if (i > 0)
                at += between(rng, BREAK_HOURS) * HOUR_MS;
            at = session(t, at, to);
        }
    }
}

/* HISTORY_WEEKS weeks of one subscription: its closed windows of both kinds, when its next
   5-hour window can start, and its last week's per-feature dollars. */
function historyOf(s, si, j)
{
    const rng = generator(seedOf(SEED, si, 1, j));
    const t = timelineOf(s, rng, { hasWeek: true, isFiveResetting: true, isWeekResetting: true, isKeeping: true });
    const end = EPOCH + HISTORY_WEEKS * WEEK_MS;
    workDays(t, EPOCH, end);
    let evaluationStart = end;
    if (t.five)
    {
        t.closedFive.push(readingsOf(t.five));
        evaluationStart = Math.max(end, t.five.resetsAt);
    }
    let lastWeekX = {};
    if (t.week)
    {
        lastWeekX = xOf(t.week.x);
        t.closedWeeks.push(readingsOf(t.week));
    }
    return { closedFive: t.closedFive, closedWeeks: t.closedWeeks, end, evaluationStart, lastWeekX };
}

function fiveHourEvaluation(s, si, e, start)
{
    const rng = generator(seedOf(SEED, si, 2, e));
    const t = timelineOf(s, rng, { hasWeek: false, isFiveResetting: false, isWeekResetting: false, watch: "five" });
    let at = start;
    while (!t.isDone)
        at = session(t, at, Infinity) + between(rng, EVALUATION_BREAK_HOURS) * HOUR_MS;
    return t;
}

function weekEvaluation(s, si, e, start)
{
    const rng = generator(seedOf(SEED, si, 3, e));
    const t = timelineOf(s, rng, { hasWeek: true, isFiveResetting: true, isWeekResetting: false, watch: "week" });
    workDays(t, start, start + MAX_EVALUATION_DAYS * DAY_MS);
    if (!t.isDone)
        throw new Error(`${s.id}: a weekly evaluation window did not reach 100% in ${MAX_EVALUATION_DAYS} days`);
    return t;
}

function qualifies(w)
{
    return isFeatureComplete(w) && segmentsOf(w, RESOLUTION, ROUNDING).filter(g => !g.isExcluded).length >= QUALIFYING_SEGMENTS;
}

/* The closed windows from the g-th newest qualifying one on; all of them when fewer qualify. */
function truncated(closed, isQualifying, g)
{
    let count = 0;
    for (let i = closed.length - 1; i >= 0; i--)
    {
        if (isQualifying[i] && ++count === g)
            return closed.slice(i);
    }
    return closed;
}

/* A group's meter rate when every feature in it has the same one: 'all', a model, or a
   model's `read` or `other`. */
function groupRateOf(table, group)
{
    const [model, part] = group.split("/");
    const models = model === "all" ? MODELS : [model];
    const classes = part === undefined ? CLASSES : part === "read" ? ["read"] : ["in", "out"];
    const rates = models.flatMap(m => classes.map(k => table[m]?.[k]));
    return rates.every(c => c !== undefined && c === rates[0]) ? rates[0] : undefined;
}

/* θ of a group against the fit's reference, on the 5-hour counter's rates. */
function thetaTruthOf(table, group, reference)
{
    const c = groupRateOf(table, group);
    const c0 = groupRateOf(table, reference);
    return c === undefined || c0 === undefined ? undefined : Math.log(c / c0);
}

/* Each free group's |θ̂ − θ|, and whether θ̂ ± t(0.95, df) · se covers θ. */
function scoreTheta(s, fit, stats)
{
    if (!fit)
    {
        stats.missing++;
        return;
    }
    if (fit.groups.free.length === 0)
        stats.noFree++;
    const t = tQuantile(0.95, fit.df);
    fit.groups.free.forEach((group, i) =>
    {
        const truth = thetaTruthOf(s.five, group, fit.groups.reference);
        if (truth === undefined)
            return;
        const error = Math.abs(fit.theta[i] - truth);
        stats.errors.push(error);
        if (error <= t * fit.se[i])
            stats.covered++;
    });
}

/* covered: against U_100; coveredAtMix: against the at-mix truth. */
const sharesStats = () => SHARES.map(share => ({ share, n: 0, covered: 0, coveredAtMix: 0 }));

/* The truth each variant's gates score it against. */
const GATED_TRUTH = { weighted: "atMix", transferred: "atMix", baseline: "total" };

/* Each kept reading of an evaluation window scored under each variant's weights, against
   both truths; gaps gets |log(at-mix truth / U_100)| per reading. Weights without a free
   group give the baseline's result by the contract of weightedEstimate, so it is computed
   once. */
function scoreWindow(t, kind, closed, fallbackX, variants, stats, gaps)
{
    for (const p of t.pending)
    {
        const atMix = (t.truthE * p.usd) / p.e;
        gaps.push(Math.abs(Math.log(atMix / t.truth)));
        const results = new Map();
        for (const [variant, weights] of Object.entries(variants))
        {
            const key = weights.free.length === 0 ? UNIT_WEIGHTS : weights;
            if (!results.has(key))
            {
                results.set(key, weightedEstimate({
                    kind,
                    closed,
                    current: p.w,
                    usedUsd: p.usd,
                    usedX: p.x,
                    fallbackX,
                    weights: key,
                    rejections: [],
                    resolution: RESOLUTION,
                    rounding: ROUNDING,
                    now: p.at,
                    livePercent: p.pct,
                    startedAt: 0
                }));
            }
            const allowance = results.get(key)?.display?.allowance;
            const st = stats[variant][SHARES.indexOf(p.share)];
            st.n++;
            if (allowance && allowance.low <= t.truth && t.truth <= allowance.high)
                st.covered++;
            if (allowance && allowance.low <= atMix && atMix <= allowance.high)
                st.coveredAtMix++;
        }
    }
}

function run(s, si)
{
    const started = performance.now();
    const perG = Object.fromEntries(GS.map(g => [g, {
        selected: { M0: 0, M1: 0, M2: 0 },
        used: 0,
        short: 0,
        checked: 0,
        rejected: 0,
        theta: { errors: [], covered: 0, missing: 0, noFree: 0 }
    }]));
    const coverage = {
        [FIVE_HOUR]: { weighted: sharesStats(), baseline: sharesStats() },
        [SEVEN_DAY]: { weighted: sharesStats(), baseline: sharesStats(), transferred: sharesStats() }
    };
    const gaps = { [FIVE_HOUR]: [], [SEVEN_DAY]: [] };
    const history = { five: 0, qualifying: 0, fiveLevels: [], weekLevels: [] };
    for (let j = 0; j < SUBSCRIPTIONS; j++)
    {
        const h = historyOf(s, si, j);
        const isQualifying = h.closedFive.map(qualifies);
        const qualifying = isQualifying.filter(Boolean).length;
        history.five += h.closedFive.length;
        history.qualifying += qualifying;
        history.fiveLevels.push(...h.closedFive.map(finalLevelOf));
        history.weekLevels.push(...h.closedWeeks.map(finalLevelOf));
        let chosen;
        for (const g of GS)
        {
            const closed = truncated(h.closedFive, isQualifying, g);
            const selection = selectModel(closed, OPTIONS);
            const transfer = transferCheck(h.closedWeeks, selection.weights, OPTIONS);
            const st = perG[g];
            st.selected[selection.selected]++;
            st.used += selection.windows.used;
            if (qualifying < g)
                st.short++;
            if (transfer.isChecked)
                st.checked++;
            if (transfer.isRejected)
                st.rejected++;
            scoreTheta(s, selection.fits[s.thetaModel], st.theta);
            if (g === s.evaluationG)
                chosen = { closed, selection, transfer };
        }
        const weights = chosen.selection.weights;
        const weekWeights = chosen.transfer.isRejected ? UNIT_WEIGHTS : weights;
        for (let e = j; e < EVALUATION_WINDOWS; e += SUBSCRIPTIONS)
        {
            const five = fiveHourEvaluation(s, si, e, h.evaluationStart);
            scoreWindow(five, FIVE_HOUR, chosen.closed, h.lastWeekX, { weighted: weights, baseline: UNIT_WEIGHTS }, coverage[FIVE_HOUR], gaps[FIVE_HOUR]);
            const week = weekEvaluation(s, si, e, h.end);
            scoreWindow(week, SEVEN_DAY, h.closedWeeks, h.lastWeekX, { weighted: weekWeights, baseline: UNIT_WEIGHTS, transferred: weights }, coverage[SEVEN_DAY], gaps[SEVEN_DAY]);
        }
    }
    return { perG, coverage, gaps, history, seconds: (performance.now() - started) / 1000 };
}

function quantileOf(values, q)
{
    if (values.length === 0)
        return NaN;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const pc = x => `${(x * 100).toFixed(1)}%`;
const TRUTH_LABELS = { total: "against U_100", atMix: "against the at-mix truth" };
const fractionOf = (st, truth) => (truth === "atMix" ? st.coveredAtMix : st.covered) / st.n;
const coverageOf = (r, kind, variant, share, truth = GATED_TRUTH[variant]) => fractionOf(r.coverage[kind][variant].find(st => st.share === share), truth);
/* Every rate of both counters equal: the at-mix truth is U_100. */
const isUniform = s => [s.five, s.week].flatMap(rateVectorOf).every((c, _, all) => c === all[0]);
const selectedRateOf = (r, g, models) => models.reduce((sum, m) => sum + r.perG[g].selected[m], 0) / SUBSCRIPTIONS;

function report(s, r)
{
    const line = text => console.log(`[${s.id}] ${text}`);
    const h = r.history;
    line(`${s.title}: ${SUBSCRIPTIONS} subscriptions, ${EVALUATION_WINDOWS} evaluation windows per kind at G = ${s.evaluationG}, ${r.seconds.toFixed(1)} s`);
    line(`history per subscription: ${(h.five / SUBSCRIPTIONS).toFixed(1)} closed 5-hour windows, ${(h.qualifying / SUBSCRIPTIONS).toFixed(1)} qualifying; `
        + `final level of 5-hour windows median ${quantileOf(h.fiveLevels, 0.5)}%; of weeks median ${quantileOf(h.weekLevels, 0.5)}%, 90th percentile ${quantileOf(h.weekLevels, 0.9)}%`);
    for (const g of GS)
    {
        const st = r.perG[g];
        const th = st.theta;
        line(`G = ${g}: selected ` + ["M0", "M1", "M2"].map(m => `${m} ${pc(st.selected[m] / SUBSCRIPTIONS)}`).join(" · ")
            + `; windows used ${(st.used / SUBSCRIPTIONS).toFixed(1)} (${st.short} short of G)`
            + `; transfer checked ${pc(st.checked / SUBSCRIPTIONS)}, rejected ${pc(st.rejected / SUBSCRIPTIONS)}`
            + `; θ̂ ${s.thetaModel} n ${th.errors.length}, median |θ̂ − θ| ${quantileOf(th.errors, 0.5).toFixed(3)}, 90% interval covers ${pc(th.covered / th.errors.length)}`
            + ` (${th.missing} without a fit, ${th.noFree} without a free group)`);
    }
    for (const [kind, variants] of Object.entries(r.coverage))
    {
        const gaps = r.gaps[kind];
        line(`${kind} |log(at-mix truth / U_100)|: median ${quantileOf(gaps, 0.5).toFixed(3)}, max ${quantileOf(gaps, 1).toExponential(2)}`);
        for (const [variant, rows] of Object.entries(variants))
        {
            if (variant === "transferred" && s.id !== "K")
                continue;
            for (const truth of [GATED_TRUTH[variant], GATED_TRUTH[variant] === "atMix" ? "total" : "atMix"])
            {
                const role = truth === GATED_TRUTH[variant] && variant !== "transferred" ? "the gates' truth" : "reported";
                line(`${kind} ${variant} ${TRUTH_LABELS[truth]} (${role}): ` + rows.map(st => `${st.share}% ${pc(fractionOf(st, truth))}`).join(" · ") + ` (n ${rows[0].n})`);
            }
        }
    }
}

/* The pre-registered gates (V1). Returns the failed ones. */
function gate(s, r)
{
    const failures = [];
    const check = (isPassed, text) =>
    {
        console.log(`[${s.id}] gate ${isPassed ? "pass" : "FAIL"}: ${text}`);
        if (!isPassed)
            failures.push(`${s.id}: ${text}`);
    };
    const kinds = [FIVE_HOUR, SEVEN_DAY];
    const upper = SHARES.filter(share => share >= 10);
    switch (s.id)
    {
        case "N0":
        {
            for (const g of GS)
            {
                const rate = selectedRateOf(r, g, ["M1", "M2"]);
                check(rate <= 0.05, `G = ${g}: M1 or M2 selected in ${pc(rate)} (at most 5%)`);
            }
            for (const kind of kinds)
            {
                for (const share of upper)
                {
                    const weighted = coverageOf(r, kind, "weighted", share);
                    const baseline = coverageOf(r, kind, "baseline", share);
                    check(Math.abs(weighted - baseline) <= 0.02, `${kind} at ${share}%: weighted ${pc(weighted)} ${TRUTH_LABELS.atMix}, M0 baseline ${pc(baseline)} ${TRUTH_LABELS.total}, the same truth here (within 2 pp)`);
                }
            }
            break;
        }
        case "W2":
        case "W05":
        {
            const baselines = SHARES.map(share => coverageOf(r, FIVE_HOUR, "baseline", share));
            check(baselines.some(c => c < 0.87), `positive control: M0 baseline five_hour coverage ${TRUTH_LABELS.total} below 87% at one or more shares (lowest ${pc(Math.min(...baselines))}); `
                + "if not, the scenario does not exercise the problem");
            const st = r.perG[10];
            const rate = selectedRateOf(r, 10, ["M1"]);
            check(rate >= 0.80, `G = 10: M1 selected in ${pc(rate)} (at least 80%)`);
            const median = quantileOf(st.theta.errors, 0.5);
            check(median < 0.1, `G = 10: median |θ̂ − θ| ${median.toFixed(3)} (under 0.1)`);
            const covered = st.theta.covered / st.theta.errors.length;
            check(covered >= 0.85 && covered <= 0.97, `G = 10: jackknife 90% interval covers θ in ${pc(covered)} (85% to 97%)`);
            for (const share of SHARES)
            {
                const c = coverageOf(r, FIVE_HOUR, "weighted", share);
                if (share < 10)
                    check(c >= 0.85, `five_hour weighted at ${share}%: ${pc(c)} ${TRUTH_LABELS.atMix} (at least 85%)`);
                else
                    check(c >= 0.87 && c <= 0.96, `five_hour weighted at ${share}%: ${pc(c)} ${TRUTH_LABELS.atMix} (87% to 96%)`);
            }
            const rejected = st.rejected / SUBSCRIPTIONS;
            check(rejected <= 0.05, `G = 10: transfer rejected in ${pc(rejected)} (at most 5%)`);
            for (const share of upper)
            {
                const c = coverageOf(r, SEVEN_DAY, "weighted", share);
                check(c >= 0.87, `seven_day weighted at ${share}%: ${pc(c)} ${TRUTH_LABELS.atMix} (at least 87%)`);
            }
            break;
        }
        case "R":
        {
            const rate = selectedRateOf(r, 20, ["M2"]);
            check(rate >= 0.70, `G = 20: M2 selected in ${pc(rate)} (at least 70%)`);
            for (const kind of kinds)
            {
                for (const share of upper)
                {
                    const c = coverageOf(r, kind, "weighted", share);
                    check(c >= 0.87, `${kind} weighted at ${share}%: ${pc(c)} ${TRUTH_LABELS.atMix} (at least 87%)`);
                }
            }
            break;
        }
        case "U":
        {
            for (const g of GS)
            {
                const rate = selectedRateOf(r, g, ["M1", "M2"]);
                check(rate <= 0.10, `G = ${g}: M1 or M2 selected in ${pc(rate)} (at most 10%)`);
            }
            for (const kind of kinds)
            {
                for (const share of SHARES)
                {
                    const c = coverageOf(r, kind, "weighted", share);
                    check(c >= 0.80, `${kind} weighted at ${share}%: ${pc(c)} ${TRUTH_LABELS.atMix} (at least 80%)`);
                }
            }
            break;
        }
        default:
            console.log(`[${s.id}] reported, not gated`);
    }
    return failures;
}

for (const s of SCENARIOS)
{
    test(`${s.id}: ${s.title}`, () =>
    {
        const r = run(s, SCENARIOS.indexOf(s));
        report(s, r);
        if (isUniform(s))
        {
            const gap = Math.max(...Object.values(r.gaps).flat());
            assert.ok(gap <= 1e-9, `${s.id}: with equal rates the at-mix truth must equal U_100, but differs by up to ${gap} in logs`);
        }
        const failures = gate(s, r);
        assert.ok(failures.length === 0, failures.join("\n"));
    });
}

after(() => console.log(`meter coverage study: ${((performance.now() - STARTED) / 1000).toFixed(1)} s in total`));

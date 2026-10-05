/* Coverage of the allowance estimate's 90% range, run with `node --test`: windows are
   simulated request by request, with a seeded generator, and the estimator in
   hooks/estimate.ts is asked for the allowance part-way through each. The truth is the
   dollars counted when the window's share first reaches 100%.

   Each request costs c dollars (lognormal, log-sd 1.0) and consumes c / (BASE · wf · rf)
   percent: wf is drawn once per window, rf per request, and kept for the next request
   with probability `persist`. The reported percent is the share rounded to a whole
   percent, and includes the request just made. With `close: [low, high]`, every past and
   calibration window stops at a share drawn uniformly from that range, as windows of
   light use close short of their limit. */

import assert from "node:assert/strict";
import test from "node:test";

import { calibrateOmega, estimate, pastOf, record } from "../hooks/estimate.ts";

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const KIND = "five_hour";
const BASE = 650;
const MEAN_COST = 0.6;
const COST_SD = 1.0;
const WINDOWS = 2000;
const CALIBRATION_WINDOWS = 30;
/* Evaluated windows that share one calibration. */
const CALIBRATION_BLOCK = 50;
const SHARES = [3, 10, 25, 50, 90];
const RESOLUTION = 1;

const SCENARIOS = [
    { id: "S1", sdWindow: 0, sdRequest: 0.3, persist: 0, past: 0, lead: 0 },
    { id: "S2", sdWindow: 0.10, sdRequest: 0.3, persist: 0, past: 3, lead: 0 },
    { id: "S3", sdWindow: 0.10, sdRequest: 0.3, persist: 0, past: 8, lead: 0 },
    { id: "S4", sdWindow: 0.20, sdRequest: 0.3, persist: 0, past: 4, lead: 0 },
    { id: "S5", sdWindow: 0.10, sdRequest: 0.4, persist: 0.98, past: 8, lead: 0 },
    { id: "S6", sdWindow: 0, sdRequest: 0.3, persist: 0, past: 0, lead: 0.3 },
    { id: "S7", sdWindow: 0.10, sdRequest: 0.3, persist: 0, past: 3, lead: 0, close: [10, 60], isUpperGated: false },
    { id: "S8", sdWindow: 0.10, sdRequest: 0.4, persist: 0.98, past: 8, lead: 0, close: [10, 60] },
    { id: "S9", sdWindow: 0.20, sdRequest: 0.3, persist: 0, past: 8, lead: 0, close: [10, 20], isUpperGated: false }
];

/* Persistent mix: the model's assumption of independent requests does not hold. */
const PERSISTENT = new Set(["S5", "S8"]);

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

/* record() for dollars that never decrease, in place. */
function put(byPct, pct, usd, at, slack)
{
    const key = String(pct);
    const b = byPct[key];
    if (!b)
        byPct[key] = { minUsd: usd, minAt: at, minSlack: slack, maxUsd: usd, maxAt: at, maxSlack: slack };
    else if (usd >= b.maxUsd)
        Object.assign(b, { maxUsd: usd, maxAt: at, maxSlack: slack });
    return byPct;
}

/* One window, request by request, until the share reaches 100, or until a reading at a
   share of at least `closeAt`, without a 100 level. `onReading` sees the readings so far
   after each request. With `lead`, that share of readings counts one request more in the
   dollars than in the percent, and passes that request's cost as the reading's slack. */
function simulateWindow(rng, s, resetsAt, onReading, closeAt = 100)
{
    const wf = Math.exp(s.sdWindow * rng.normal());
    let rf = Math.exp(s.sdRequest * rng.normal());
    const cost = () => MEAN_COST * Math.exp(COST_SD * rng.normal() - COST_SD * COST_SD / 2);
    let share = 0;
    let usd = 0;
    let at = resetsAt - 5 * HOUR_MS;
    const byPct = {};
    let next = cost();
    for (;;)
    {
        if (rng.uniform() >= s.persist)
            rf = Math.exp(s.sdRequest * rng.normal());
        const c = next;
        next = cost();
        share += (c / (BASE * wf * rf)) * 100;
        usd += c;
        at += 1000;
        if (share >= 100)
        {
            put(byPct, 100, usd, at, 0);
            return { truth: usd, w: { kind: KIND, resetsAt: new Date(resetsAt).toISOString(), byPct } };
        }
        const slack = s.lead > 0 && rng.uniform() < s.lead ? next : 0;
        const reading = { pct: Math.round(share), usd: usd + slack, share };
        put(byPct, reading.pct, reading.usd, at, slack);
        if (onReading)
            onReading(byPct, reading);
        if (share >= closeAt)
            return { truth: undefined, w: { kind: KIND, resetsAt: new Date(resetsAt).toISOString(), byPct } };
    }
}

const snapshot = (byPct, resetsAt) => ({
    kind: KIND,
    resetsAt: new Date(resetsAt).toISOString(),
    byPct: Object.fromEntries(Object.entries(byPct).map(([k, b]) => [k, { ...b }]))
});

const closeAtOf = (rng, s) => (s.close ? s.close[0] + (s.close[1] - s.close[0]) * rng.uniform() : 100);

const closedWindows = (rng, s, n) =>
    Array.from({ length: n }, (_, i) => simulateWindow(rng, s, NOW - (i + 1) * 5 * HOUR_MS, undefined, closeAtOf(rng, s)).w);

/* The estimator told that the API rounds, or under the union of both rules, as it is
   until closed windows show which one applies. */
function run(s, seed, rounding, windows)
{
    const rng = generator(seed);
    const options = { resolution: RESOLUTION, rounding };
    const stats = SHARES.map(share => ({ share, n: 0, covered: 0, widthToLeft: 0, halfWidth: 0 }));
    let spread;
    for (let i = 0; i < windows; i++)
    {
        if (i % CALIBRATION_BLOCK === 0)
            spread = calibrateOmega(closedWindows(rng, s, CALIBRATION_WINDOWS), KIND, NOW, RESOLUTION, rounding);
        const past = closedWindows(rng, s, s.past)
            .map(w => pastOf(w, RESOLUTION, rounding, spread.omega))
            .filter(p => p !== undefined);
        const resetsAt = NOW + 5 * HOUR_MS;
        const pending = [];
        let k = 0;
        const { truth } = simulateWindow(rng, s, resetsAt, (byPct, reading) =>
        {
            while (k < SHARES.length && reading.share >= SHARES[k])
            {
                pending.push({ k, w: snapshot(byPct, resetsAt), usd: reading.usd, pct: reading.pct });
                k++;
            }
        });
        for (const p of pending)
        {
            const e = estimate(p.w, p.usd, { ...options, past, kind: KIND, now: NOW, livePercent: p.pct, spread });
            const st = stats[p.k];
            st.n++;
            if (!e)
                continue;
            if (e.allowance.low <= truth && truth <= e.allowance.high)
                st.covered++;
            st.widthToLeft += (e.allowance.high - e.allowance.low) / Math.max(truth - p.usd, 1e-9);
            st.halfWidth += Math.sqrt(e.allowance.high / e.allowance.low) - 1;
        }
    }
    return stats.map(st => ({
        share: st.share,
        coverage: st.covered / st.n,
        widthToLeft: st.widthToLeft / st.n,
        halfWidth: st.halfWidth / st.n
    }));
}

const results = {};
const resultOf = s => (results[s.id] ??= run(s, 1000 + SCENARIOS.indexOf(s), "round", WINDOWS));

const print = (label, rows) =>
    console.log(`${label} coverage, mean half-width: ` + rows.map(r => `${r.share}% ${(r.coverage * 100).toFixed(1)}% ±${(r.halfWidth * 100).toFixed(1)}%`).join(" · "));

/* The lower gates always; the upper one only where the rounding rule is known, since the
   union is wider than either rule by design, and not where past windows closed short of
   the limit, since their noisy points bias tau upward. */
function gate(s, rows, label, isUpperChecked)
{
    for (const r of rows)
    {
        const at = `${label} at ${r.share}%: ${(r.coverage * 100).toFixed(1)}%`;
        if (PERSISTENT.has(s.id))
            assert.ok(r.coverage >= 0.80, at);
        else if (r.share < 10)
            assert.ok(r.coverage >= 0.85, at);
        else
        {
            assert.ok(r.coverage >= 0.87, at);
            if (isUpperChecked && s.isUpperGated !== false)
                assert.ok(r.coverage <= 0.96, at);
        }
    }
}

for (const s of SCENARIOS)
{
    test(`${s.id}: coverage of the true allowance`, () =>
    {
        const rows = resultOf(s);
        print(s.id, rows);
        gate(s, rows, s.id, true);
    });
}

test("under the union of rounding rules, no scenario covers too little", () =>
{
    for (const s of SCENARIOS)
    {
        const rows = run(s, 2000 + SCENARIOS.indexOf(s), "union", WINDOWS / 2);
        print(`${s.id} union`, rows);
        gate(s, rows, `${s.id} union`, false);
    }
});

test("at 90% used the range is narrower than half of what is truly left (S1 to S4)", () =>
{
    for (const s of SCENARIOS.slice(0, 4))
    {
        const r = resultOf(s).find(row => row.share === 90);
        assert.ok(r.widthToLeft < 0.5, `${s.id}: width / left ${r.widthToLeft.toFixed(3)}`);
    }
});

/* Readings of a window with the given allowance, every `step` dollars up to `upTo`, the
   percent rounded and held at 100 once the allowance is spent. */
function steady(allowance, upTo, step)
{
    let w = { kind: KIND, resetsAt: new Date(NOW + HOUR_MS).toISOString(), byPct: {} };
    let at = NOW - 4 * HOUR_MS;
    for (let usd = step; usd <= upTo + 1e-9; usd += step)
    {
        w = record(w, Math.min(100, Math.round((usd / allowance) * 100)), usd, at);
        at += 1000;
    }
    return w;
}

test("a prior just off the readings never gives a good range that misses the truth (F3)", () =>
{
    const past = [900, 908, 916].map((usd, i) => ({ logA: Math.log(usd), variance: 0.02 ** 2, at: NOW - (i + 1) * 5 * HOUR_MS }));
    for (const upTo of [100, 200, 400, 600, 900])
    {
        const e = estimate(steady(1000, upTo, 0.5), upTo, { resolution: RESOLUTION, rounding: "round", past, kind: KIND, now: NOW, livePercent: Math.round(upTo / 10) });
        assert.ok(e, `at $${upTo}`);
        const isCovered = e.allowance.low <= 1000 && 1000 <= e.allowance.high;
        assert.ok(isCovered || e.confidence !== "good", `at $${upTo}: ${JSON.stringify(e.allowance)} ${e.confidence}`);
    }
});

test("spending past the limit leaves the allowance at the crossing of 100% (F7)", () =>
{
    const e = estimate(steady(1000, 1500, 0.5), 1500, { resolution: RESOLUTION, rounding: "round", past: [], kind: KIND, now: NOW, livePercent: 100 });
    assert.ok(e);
    assert.ok(Math.abs(e.allowance.value / 1000 - 1) < 0.02, JSON.stringify(e.allowance));
    assert.equal(e.left.value, 0);
});

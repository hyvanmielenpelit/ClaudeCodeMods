/* Tests of the Node helper, run with `node --test`: each runs the helper as a child process
   against the synthetic transcripts and profiles under fixtures/. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, "..", "scripts", "usage-cost.mjs");
const FIXTURES = path.join(HERE, "fixtures");
const CONFIG = path.join(FIXTURES, "config");
/* Requests around 12:00:00: session-a's own at -5 s and its subagent's at -3 s; session-d,
   same subscription, at -45 s, -10 s and +5 s; session-e, another subscription, at -5 s. */
const SLACK_CONFIG = path.join(FIXTURES, "config-slack");
const SLACK_WINDOW = "session,2026-10-04T11:00:00.000Z,2026-10-04T16:00:00.000Z";
const SLACK_UNTIL = "2026-10-04T12:00:00.000Z";
/* Requests from 10:00 to 10:30 on 2026-10-04. session-m, of ORG_A: Opus 5.5 and Fable 5.1
   over every token class (cache writes both with and without the per-lifetime split), a
   fast Fable request with one web search, and an Opus request with three; session-n, of
   ORG_B, a fast Haiku request with two web searches. */
const MIX_CONFIG = path.join(FIXTURES, "config-mix");
const MIX_WINDOW = "session,2026-10-04T09:00:00.000Z,2026-10-04T14:00:00.000Z";
/* session-m's dollars per feature; byFeature omits a key whose dollars are 0. */
const MIX_FEATURES = {
    "claude-opus-5-5/in": 4,
    "claude-opus-5-5/out": 3,
    "claude-opus-5-5/read": 0.2,
    "claude-opus-5-5/w5m": 3,
    "claude-opus-5-5/w1h": 2,
    "claude-fable-5-1/in": 1,
    "claude-fable-5-1/out": 1,
    "claude-fable-5-1/read": 0.5,
    "claude-fable-5-1/w5m": 1,
    "claude-fable-5-1/w1h": 1,
    "claude-fable-5-1+fast/in": 2,
    "claude-fable-5-1+fast/out": 2,
    "web": 0.04
};

const ORG_A = "00000000-0000-4000-8000-000000000001";
const ORG_B = "00000000-0000-4000-8000-000000000002";
const PERSONAL = [
    "nobody@example.invalid",
    "Dummy Display",
    "Dummy Full Name",
    "Dummy Organization",
    "00000000-0000-4000-8000-0000000000aa",
    "accountUuid",
    "organizationName",
    "emailAddress"
];
const PROFILE_KEYS = [
    "billingType",
    "fetchedAt",
    "fetchedLabel",
    "org",
    "organizationType",
    "promotions",
    "rateLimitTier",
    "seatTier",
    "subscriptionCreatedAt",
    "userRateLimitTier"
];
const RANGE = "2026-09-28T00:00:00.000Z,2026-10-06T00:00:00.000Z";

function run(args, profile = "profile-max5x.json", config = CONFIG, helper = HELPER)
{
    const r = spawnSync(process.execPath, [helper, ...args, "--profile-file", path.join(FIXTURES, profile)], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: config },
        encoding: "utf8"
    });
    return { status: r.status, stdout: r.stdout, json: JSON.parse(r.stdout) };
}

const sum = values => values.reduce((a, b) => a + b, 0);
const near = (a, b) => Math.abs(a - b) < 1e-9;
const nearRelative = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));

const MODES = [
    ["--session", "session-a", "--whoami"],
    ["--session", "session-a", "--window", "week,2026-09-28T00:00:00.000Z,2026-10-05T00:00:00.000Z"],
    ["--session", "session-a", "--history", "14"],
    ["--session", "session-a", "--report", RANGE],
    ["--session", "session-a", "--report-local", "2026-10-01,2026-10-05"]
];

test("no mode emits a personal field", () =>
{
    for (const args of MODES)
        for (const profile of ["profile-max5x.json", "profile-promo.json", "profile-other-org.json"])
        {
            const { status, stdout } = run(args, profile);
            assert.equal(status, 0, stdout);
            for (const value of PERSONAL)
                assert.ok(!stdout.includes(value), `${args.join(" ")} with ${profile} leaks ${value}`);
        }
});

test("the profile block holds exactly the listed keys, empty strings as null", () =>
{
    const { profile } = run(["--session", "session-a", "--whoami"]).json;
    assert.deepEqual(Object.keys(profile).sort(), PROFILE_KEYS);
    assert.equal(profile.org, ORG_A);
    assert.equal(profile.rateLimitTier, "default_claude_max_5x");
    assert.equal(profile.seatTier, null);
    assert.equal(profile.userRateLimitTier, null);
    assert.equal(profile.fetchedAt, "2026-10-03T10:00:00.000Z");
    assert.equal(typeof profile.fetchedLabel, "string");
    assert.deepEqual(profile.promotions, []);
});

test("--whoami answers from the session's record, else from the profile", () =>
{
    const own = run(["--session", "session-a", "--whoami"], "profile-other-org.json").json;
    assert.equal(own.org, ORG_A);
    assert.equal(own.orgSource, "session");
    const none = run(["--session", "session-c", "--whoami"], "profile-other-org.json").json;
    assert.equal(none.org, ORG_B);
    assert.equal(none.orgSource, "profile");
});

test("a session with no record resolves to the profile's subscription", () =>
{
    for (const profile of ["profile-max5x.json", "profile-other-org.json"])
    {
        const out = run(["--session", "session-c", "--window", "week,2026-09-28T00:00:00.000Z,2026-10-05T00:00:00.000Z"], profile).json;
        assert.equal(out.orgSource, "profile");
        assert.equal(out.org, profile === "profile-max5x.json" ? ORG_A : ORG_B);
    }
});

test("with no bridge-session record anywhere, every request is the resolved subscription's", () =>
{
    const cli = path.join(FIXTURES, "config-cli");
    const signedIn = run(["--session", "session-x", "--report", RANGE], "profile-max5x.json", cli).json;
    assert.equal(signedIn.org, ORG_A);
    assert.ok(near(signedIn.usd, 4));
    assert.equal(signedIn.unattributedUsd, 0);
    const none = run(["--session", "session-x", "--report", RANGE], "missing.json", cli).json;
    assert.equal(none.org, null);
    assert.equal(none.profile, null);
    assert.ok(near(none.usd, 4));
});

test("--report totals match the days and the models, and leave out other subscriptions", () =>
{
    const out = run(["--session", "session-a", "--report", RANGE]).json;
    assert.equal(out.org, ORG_A);
    assert.ok(near(out.usd, 8), `usd ${out.usd}`);
    assert.equal(out.requests, 4);
    assert.ok(near(out.usd, sum(out.byDay.map(d => d.usd))));
    assert.ok(near(out.usd, sum(Object.values(out.byModel).map(m => m.usd))));
    assert.equal(out.requests, sum(out.byDay.map(d => d.requests)));
    assert.ok(near(out.otherSubscriptionsUsd, 4));
    assert.ok(near(out.unattributedUsd, 0));
    assert.ok(out.byDay.length >= 8);
    for (const d of out.byDay)
        assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof out.fromLabel, "string");
    assert.equal(typeof out.toLabel, "string");
});

test("without a profile, a session with no record stays unattributed", () =>
{
    const out = run(["--session", "session-a", "--report", RANGE], "missing.json").json;
    assert.equal(out.org, ORG_A);
    assert.ok(near(out.usd, 7), `usd ${out.usd}`);
    assert.ok(near(out.unattributedUsd, 1));
});

test("a session with no record bills the signed-in subscription, even when it is another", () =>
{
    const out = run(["--session", "session-a", "--report", RANGE], "profile-other-org.json").json;
    assert.equal(out.org, ORG_A);
    assert.ok(near(out.usd, 7), `usd ${out.usd}`);
    assert.ok(near(out.otherSubscriptionsUsd, 5));
    assert.ok(near(out.unattributedUsd, 0));
});

test("--report-local covers whole local days, empty ones included", () =>
{
    const out = run(["--session", "session-a", "--report-local", "2026-09-30,2026-10-06"]).json;
    assert.equal(out.byDay.length, 7);
    assert.equal(out.byDay[0].date, "2026-09-30");
    assert.equal(out.byDay[6].date, "2026-10-06");
    assert.ok(near(out.usd, 8));
    assert.ok(near(out.usd, sum(out.byDay.map(d => d.usd))));
});

test("--report-local refuses a bad date, and a range that runs backward", () =>
{
    for (const range of ["2026-13-45,2026-10-05", "2026-02-30,today", "yesterday,today", "2026-10-05,2026-10-01"])
    {
        const r = run(["--session", "session-a", "--report-local", range]);
        assert.equal(r.status, 2, range);
        assert.equal(typeof r.json.error, "string", range);
    }
});

test("a report reaching before the oldest transcript says where they begin", () =>
{
    const out = run(["--session", "session-a", "--report", "2020-01-01T00:00:00.000Z,2026-10-06T00:00:00.000Z"]).json;
    assert.equal(typeof out.transcriptsBeginLabel, "string");
});

test("--label returns one label per key", () =>
{
    const out = run(["--session", "session-a", "--whoami", "--label", "now,2026-10-05T10:00:00.000Z", "--label", "1791021600000,2026-10-03T10:00:00.000Z"]).json;
    assert.deepEqual(Object.keys(out.labels).sort(), ["1791021600000", "now"]);
    for (const label of Object.values(out.labels))
        assert.match(label, /^\w{3} \d{1,2} \w{3}, \d{2}:\d{2}$/);
});

test("a window's untilISO leaves out later requests", () =>
{
    const until = run(["--session", "session-a", "--window", `${SLACK_WINDOW},${SLACK_UNTIL}`], "profile-max5x.json", SLACK_CONFIG).json;
    assert.ok(near(until.windows.session.usd, 23), `usd ${until.windows.session.usd}`);
    assert.equal(until.windows.session.requests, 4);
    const now = run(["--session", "session-a", "--window", SLACK_WINDOW], "profile-max5x.json", SLACK_CONFIG).json;
    assert.ok(near(now.windows.session.usd, 31), `usd ${now.windows.session.usd}`);
    const bad = run(["--session", "session-a", "--window", `${SLACK_WINDOW},not-a-date`], "profile-max5x.json", SLACK_CONFIG);
    assert.equal(bad.status, 2);
});

test("slackUsd is other sessions' dollars of this subscription in the 30 s up to untilISO", () =>
{
    const mine = run(["--session", "session-a", "--window", `${SLACK_WINDOW},${SLACK_UNTIL}`], "profile-max5x.json", SLACK_CONFIG).json;
    assert.ok(near(mine.windows.session.slackUsd, 2), `slack ${mine.windows.session.slackUsd}`);
    const other = run(["--session", "session-d", "--window", `${SLACK_WINDOW},${SLACK_UNTIL}`], "profile-max5x.json", SLACK_CONFIG).json;
    assert.ok(near(other.windows.session.slackUsd, 17), `slack ${other.windows.session.slackUsd}`);
});

test("a window's 5th field names the session whose requests are not slack", () =>
{
    const named = run(["--session", "session-a", "--window", `${SLACK_WINDOW},${SLACK_UNTIL},session-d`], "profile-max5x.json", SLACK_CONFIG).json;
    assert.ok(near(named.windows.session.slackUsd, 17), `slack ${named.windows.session.slackUsd}`);
    assert.ok(near(named.windows.session.usd, 23), `usd ${named.windows.session.usd}`);
    const own = run(["--session", "session-a", "--window", `${SLACK_WINDOW},${SLACK_UNTIL},session-a`], "profile-max5x.json", SLACK_CONFIG).json;
    assert.ok(near(own.windows.session.slackUsd, 2), `slack ${own.windows.session.slackUsd}`);
    const bad = run(["--session", "session-a", "--window", `${SLACK_WINDOW},${SLACK_UNTIL},`], "profile-max5x.json", SLACK_CONFIG);
    assert.equal(bad.status, 2);
});

test("byFeature splits a window's dollars by price key, speed and token class", () =>
{
    const w = run(["--session", "session-m", "--window", MIX_WINDOW], "profile-max5x.json", MIX_CONFIG).json.windows.session;
    assert.equal(w.requests, 7);
    assert.ok(near(w.usd, 20.74), `usd ${w.usd}`);
    assert.deepEqual(Object.keys(w.byFeature).sort(), Object.keys(MIX_FEATURES).sort());
    for (const [key, usd] of Object.entries(MIX_FEATURES))
        assert.ok(nearRelative(w.byFeature[key], usd), `${key} ${w.byFeature[key]}`);
    assert.ok(nearRelative(sum(Object.values(w.byFeature)), w.usd), `sum ${sum(Object.values(w.byFeature))}`);
});

test("a fast request lands under +fast, and its web search under web at the plain rate", () =>
{
    const { byFeature } = run(["--session", "session-m", "--window", MIX_WINDOW], "profile-max5x.json", MIX_CONFIG).json.windows.session;
    assert.ok(nearRelative(byFeature["claude-fable-5-1+fast/in"], 2));
    assert.ok(nearRelative(byFeature["claude-fable-5-1+fast/out"], 2));
    assert.ok(nearRelative(byFeature.web, 0.04), `web ${byFeature.web}`);
    assert.deepEqual(Object.keys(byFeature).filter(k => k.includes("+fast")).sort(), ["claude-fable-5-1+fast/in", "claude-fable-5-1+fast/out"]);
});

test("another subscription's request contributes nothing to byFeature", () =>
{
    const w = run(["--session", "session-m", "--window", MIX_WINDOW], "profile-max5x.json", MIX_CONFIG).json.windows.session;
    assert.ok(near(w.otherSubscriptionsUsd, 2.02), `other ${w.otherSubscriptionsUsd}`);
    assert.ok(!Object.keys(w.byFeature).some(k => k.startsWith("claude-haiku-4-5")));
    assert.ok(nearRelative(w.byFeature.web, 0.04), `web ${w.byFeature.web}`);
});

test("every --window tally carries byFeature, and slack only its total", () =>
{
    const specs = [
        MIX_WINDOW,
        "week,2026-09-28T00:00:00.000Z,2026-10-05T00:00:00.000Z",
        "@read,2026-10-04T09:00:00.000Z,2026-10-04T14:00:00.000Z,2026-10-04T10:31:00.000Z",
        "@stored,2026-10-04T09:00:00.000Z,2026-10-04T14:00:00.000Z,2026-10-04T10:31:00.000Z,session-m",
        "last24h,2026-10-03T10:30:00.000Z,2026-10-04T10:30:00.000Z",
        "last7d,2026-09-27T10:30:00.000Z,2026-10-04T10:30:00.000Z",
        "bf0,2026-10-04T09:00:00.000Z,2026-10-04T14:00:00.000Z,2026-10-04T10:22:00.000Z"
    ];
    const out = run(["--session", "session-m", ...specs.flatMap(spec => ["--window", spec])], "profile-max5x.json", MIX_CONFIG).json;
    assert.deepEqual(Object.keys(out.windows).sort(), ["@read", "@stored", "bf0", "last24h", "last7d", "session", "week"]);
    for (const [name, w] of Object.entries(out.windows))
    {
        assert.equal(typeof w.byFeature, "object", name);
        assert.ok(nearRelative(sum(Object.values(w.byFeature)), w.usd), `${name} sum ${sum(Object.values(w.byFeature))} usd ${w.usd}`);
        assert.ok(Object.values(w.byFeature).every(v => v > 0), name);
        assert.deepEqual(Object.keys(w).filter(k => k.startsWith("slack")), ["slackUsd"], name);
    }
    /* Up to 10:22: no fast request and no web search yet, so no such key. */
    const early = Object.keys(MIX_FEATURES).filter(k => k !== "web" && !k.includes("+fast"));
    assert.deepEqual(Object.keys(out.windows.bf0.byFeature).sort(), early.sort());
    assert.ok(near(out.windows.bf0.usd, 15.7), `bf0 usd ${out.windows.bf0.usd}`);
});

test("--check-summary takes the largest cost-state per session and model, of at least $0.50", () =>
{
    const request = (session, id, model, usage) =>
        JSON.stringify({ type: "assistant", sessionId: session, timestamp: "2026-10-04T12:00:00.000Z", requestId: id, message: { id: "msg-" + id, model, usage } });
    const costState = (session, model, costUSD) => JSON.stringify({ type: "cost-state", sessionId: session, modelUsage: { [model]: { costUSD } } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-dollars-"));
    try
    {
        const demo = path.join(dir, "projects", "demo");
        fs.mkdirSync(demo, { recursive: true });
        /* $4 against $4 (an earlier, smaller cost-state left out), $1 against $1.25, and $0.10 left out. */
        fs.writeFileSync(path.join(demo, "s1.jsonl"), [
            request("s1", "r1", "claude-opus-5-5", { input_tokens: 1000000, output_tokens: 0 }),
            costState("s1", "claude-opus-5-5", 2),
            costState("s1", "claude-opus-5-5", 4)
        ].join("\n") + "\n");
        fs.writeFileSync(path.join(demo, "s2.jsonl"), [
            request("s2", "r2", "claude-haiku-4-5", { input_tokens: 1000000, output_tokens: 0 }),
            costState("s2", "claude-haiku-4-5", 1.25)
        ].join("\n") + "\n");
        fs.writeFileSync(path.join(demo, "s3.jsonl"), [
            request("s3", "r3", "claude-haiku-4-5", { input_tokens: 100000, output_tokens: 0 }),
            costState("s3", "claude-haiku-4-5", 0.1)
        ].join("\n") + "\n");
        const out = run(["--check-summary"], "profile-max5x.json", dir).json;
        assert.equal(out.sessions, 2);
        assert.ok(near(out.medianRatio, 0.9), `median ${out.medianRatio}`);
        assert.ok(near(out.lowRatio, 0.81), `low ${out.lowRatio}`);
        assert.ok(near(out.highRatio, 0.99), `high ${out.highRatio}`);
        assert.equal(typeof out.ms, "number");
        const none = run(["--check-summary"], "profile-max5x.json", CONFIG).json;
        assert.deepEqual({ ...none, ms: 0 }, {
            sessions: 0,
            medianRatio: null,
            lowRatio: null,
            highRatio: null,
            unknownLimits: [],
            creditMarked: { requests: 0, lastAt: null },
            ms: 0
        });
    }
    finally
    {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("pricesId is stable, and changes with a price", () =>
{
    const args = ["--session", "session-a", "--window", SLACK_WINDOW];
    const first = run(args, "profile-max5x.json", SLACK_CONFIG).json.pricesId;
    assert.match(first, /^[0-9a-f]{12}$/);
    assert.equal(run(args, "profile-max5x.json", SLACK_CONFIG).json.pricesId, first);
    const source = fs.readFileSync(HELPER, "utf8");
    const repriced = source.replace('"claude-haiku-4-5": [1, 5, 0.10]', '"claude-haiku-4-5": [1, 5, 0.11]');
    assert.notEqual(repriced, source);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-dollars-"));
    try
    {
        const copy = path.join(dir, "usage-cost.mjs");
        fs.writeFileSync(copy, repriced);
        assert.notEqual(run(args, "profile-max5x.json", SLACK_CONFIG, copy).json.pricesId, first);
    }
    finally
    {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/* session-u, of ORG_A, on 2026-11-10: Fable 5.2 and Mythos 5.2 (with one web search and a
   cache read), Sonnet 5.5 cache reads, Haiku 5.5 at 100,000 and 100,001 prompt tokens, two
   point releases with no price, suffixed ids, one request with a fallback credit, and
   quotaLimits records of an unknown kind (twice) and one billed to overage. */
const ULTRA_CONFIG = path.join(FIXTURES, "config-ultra");
const ULTRA_WINDOW = "week,2026-11-09T00:00:00.000Z,2026-11-16T00:00:00.000Z";

function ultraWeek()
{
    return run(["--session", "session-u", "--window", ULTRA_WINDOW], "profile-max20x.json", ULTRA_CONFIG).json.windows.week;
}

test("the November 2026 prices: Fable 5.2, Mythos 5.2, Sonnet 5.5 cache reads, suffixed ids", () =>
{
    const { byModel } = ultraWeek();
    assert.ok(near(byModel["claude-fable-5-2"].usd, 8), `fable ${byModel["claude-fable-5-2"].usd}`);
    assert.ok(near(byModel["claude-mythos-5-2"].usd, 4 + 0.2 + 0.01), `mythos ${byModel["claude-mythos-5-2"].usd}`);
    assert.ok(near(byModel["claude-sonnet-5-5"].usd, 0.1), `sonnet ${byModel["claude-sonnet-5-5"].usd}`);
    assert.ok(near(byModel["claude-sonnet-4-5-20250929"].usd, 3));
    assert.ok(near(byModel["anthropic.claude-opus-4-6-v1:0"].usd, 5));
    assert.ok(near(byModel["claude-opus-5-5[1m]"].usd, 4));
});

test("Haiku 5.5 is priced on each request's prompt length: input, cache read and cache write tokens", () =>
{
    const { byModel, byFeature } = ultraWeek();
    /* 100,000 prompt tokens: the low tier. */
    assert.ok(near(byModel["claude-haiku-5-5"].usd, 0.004 + 0.5 + 0.0005 + 0.00125), `low ${byModel["claude-haiku-5-5"].usd}`);
    /* 100,001: the high tier. */
    assert.ok(nearRelative(byModel["claude-haiku-5-5-20261101"].usd, 0.0200005 + 2.5 + 0.0025 + 0.00625), `high ${byModel["claude-haiku-5-5-20261101"].usd}`);
    /* Both tiers share one feature key. */
    assert.ok(nearRelative(byFeature["claude-haiku-5-5/out"], 0.5 + 2.5));
});

test("a point release matches no key, and is reported unpriced", () =>
{
    const week = ultraWeek();
    assert.deepEqual([...week.unpricedModels].sort(), ["claude-fable-5-3", "claude-opus-5-6"]);
    assert.equal(week.unpricedRequests, 2);
    assert.equal(week.byModel["claude-fable-5-3"], undefined);
});

test("the fable sub-tally counts Fable 5.2 and Mythos 5.2, their web searches included, and nothing else", () =>
{
    const week = ultraWeek();
    assert.equal(week.fable.requests, 2);
    assert.ok(near(week.fable.usd, 8 + 4.21), `fable ${week.fable.usd}`);
    assert.ok(near(week.byFeature.web, 0.01));
    const plain = run(["--session", "session-m", "--window", MIX_WINDOW], "profile-max5x.json", MIX_CONFIG).json.windows.session;
    /* Fable 5.1 in the mix fixture: every Fable feature and its web search. */
    const fableFeatures = sum(Object.entries(MIX_FEATURES).filter(([k]) => k.startsWith("claude-fable-")).map(([, v]) => v));
    assert.ok(near(plain.fable.usd, fableFeatures + 0.01), `mix fable ${plain.fable.usd}`);
});

test("--check-summary and --history report unknown limit kinds, overage, and fallback credits", () =>
{
    const expected = [
        { kind: "five_hour", status: "allowed", overageStatus: "allowed", isUsingOverage: true, count: 1, lastAt: "2026-11-10T10:40:00.000Z" },
        { kind: "seven_day_fable", status: "allowed_warning", overageStatus: "allowed", isUsingOverage: false, count: 2, lastAt: "2026-11-10T10:31:00.000Z" }
    ];
    const summary = run(["--check-summary"], "profile-max20x.json", ULTRA_CONFIG).json;
    assert.deepEqual(summary.unknownLimits, expected);
    assert.deepEqual(summary.creditMarked, { requests: 1, lastAt: "2026-11-10T10:10:00.000Z" });
    const history = run(["--session", "session-u", "--history", "14"], "profile-max20x.json", ULTRA_CONFIG).json;
    assert.deepEqual(history.unknownLimits, expected);
    assert.equal(typeof history.creditMarked.requests, "number");
});

test("the promotion fixture yields its limit and end", () =>
{
    const { profile } = run(["--session", "session-a", "--whoami"], "profile-promo.json").json;
    assert.equal(profile.promotions.length, 1);
    const [promo] = profile.promotions;
    assert.equal(promo.limit, "five_hour");
    assert.equal(promo.text, "Double 5-hour limits through Oct 13");
    assert.match(promo.endsAt, /^\d{4}-10-14T00:00:00\.000Z$/);
    assert.equal(promo.endsLabel, "13 Oct");
});

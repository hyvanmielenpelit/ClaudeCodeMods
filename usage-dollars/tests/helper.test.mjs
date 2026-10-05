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

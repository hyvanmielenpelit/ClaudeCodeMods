#!/usr/bin/env node
/* Prices every billed request in the local Claude Code transcripts at API list rates and
   prints JSON, counting only the subscription that owns --session (through the
   bridge-session records the desktop app writes).

   Usage:
     node usage-cost.mjs --session <id> --window <name>,<sinceISO>,<resetISO>[,<untilISO>[,<sessionId>]] [--window ...]
         Totals per window: used dollars up to <untilISO> (else up to now), requests,
         per-model split, reset labels, and slackUsd: the dollars of other sessions'
         requests in the 30 s up to then. Other than <sessionId> when given, else other
         than --session's. The top-level pricesId names the price table.
     node usage-cost.mjs --session <id> --whoami
         The session's subscription and the signed-in profile, without a scan.
     node usage-cost.mjs --session <id> --history <days>
         Every rate-limit rejection in the last <days> days, with the dollars used in its
         window up to the rejection: a window known to be exactly full.
     node usage-cost.mjs --session <id> --report <sinceISO>,<untilISO>
     node usage-cost.mjs --session <id> --report-local <from>,<to>
         Spending in a range, per day and per model. --report-local takes local dates
         (YYYY-MM-DD or "today"), both inclusive.
     node usage-cost.mjs --check
         Sets each session's computed cost beside the cost Claude Code itself recorded.
     node usage-cost.mjs --check-summary
         The ratios of --check over sessions of at least $0.50, one row per session and
         model: their number, median, and 5th and 95th percentiles.

   Every mode but --check and --check-summary also takes --label <key>,<ISO> (any number of times), answered
   as local-time labels, and --profile-file <path> in place of the config file. */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || null;
const PROJECTS = path.join(CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
const CONFIG_FILE = CONFIG_DIR ? path.join(CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json");

/* US dollars per million tokens: input, output, cache read. A cache write costs 1.25x
   input for the 5-minute lifetime and 2x for the 1-hour one. Matched by id prefix, longest
   first, so a dated or [1m] suffix still matches. Source: Anthropic API pricing as of
   2026-09-25; a model missing here is reported as unpriced, never guessed. */
const PRICES = {
    "claude-fable-5-1": [10, 50, 0.25],
    "claude-mythos-5-1": [10, 50, 0.25],
    "claude-fable-5": [10, 50, 1.00],
    "claude-opus-5-5": [4, 20, 0.20],
    "claude-opus-5": [5, 25, 0.50],
    "claude-opus-4-8": [5, 25, 0.50],
    "claude-opus-4-7": [5, 25, 0.50],
    "claude-opus-4-6": [5, 25, 0.50],
    "claude-opus-4-5": [5, 25, 0.50],
    "claude-sonnet-5-5": [2, 10, 0.20],
    "claude-sonnet-5": [2, 10, 0.20],
    "claude-sonnet-4-6": [3, 15, 0.30],
    "claude-sonnet-4-5": [3, 15, 0.30],
    "claude-haiku-4-5": [1, 5, 0.10]
};
const PREFIXES = Object.keys(PRICES).sort((a, b) => b.length - a.length);
const WEB_SEARCH_USD = 0.01;
const FAST_MULTIPLIER = 2;
const CACHE_5M_MULTIPLIER = 1.25;
const CACHE_1H_MULTIPLIER = 2;
/* Readings priced with another table are not comparable with this one's dollars. */
const PRICES_ID = crypto.createHash("sha256")
    .update(JSON.stringify({ PRICES, WEB_SEARCH_USD, FAST_MULTIPLIER, CACHE_5M_MULTIPLIER, CACHE_1H_MULTIPLIER }))
    .digest("hex")
    .slice(0, 12);
/* Another session's request this close before a reading may or may not be in its percent. */
const SLACK_MS = 30000;
const DAY_MS = 24 * 3600000;
const SPAN_MS = { five_hour: 5 * 3600000, seven_day: 7 * DAY_MS };

/* The profile fields that describe the plan; nothing personal is ever read out. */
const PROFILE_FIELDS = {
    organizationType: "organizationType",
    rateLimitTier: "organizationRateLimitTier",
    userRateLimitTier: "userRateLimitTier",
    seatTier: "seatTier",
    billingType: "billingType",
    subscriptionCreatedAt: "subscriptionCreatedAt"
};

const LIMIT_ALIASES = {
    "5h": "five_hour", "five_hour": "five_hour", "session": "five_hour", "hourly": "five_hour",
    "7d": "seven_day", "seven_day": "seven_day", "week": "seven_day", "weekly": "seven_day"
};

const MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

function priceOf(model)
{
    const id = String(model || "").replace(/^anthropic\./, "");
    const key = PREFIXES.find(p => id === p || id.startsWith(p + "-") || id.startsWith(p + "["));
    return key ? PRICES[key] : null;
}

function costOf(model, u)
{
    const p = priceOf(model);
    if (!p)
        return null;
    const [inp, out, read] = p;
    const c = u.cache_creation || {};
    const has = c.ephemeral_5m_input_tokens !== undefined || c.ephemeral_1h_input_tokens !== undefined;
    const w5 = has ? (c.ephemeral_5m_input_tokens || 0) : (u.cache_creation_input_tokens || 0);
    const w1 = has ? (c.ephemeral_1h_input_tokens || 0) : 0;
    let usd = ((u.input_tokens || 0) * inp
        + (u.output_tokens || 0) * out
        + (u.cache_read_input_tokens || 0) * read
        + w5 * inp * CACHE_5M_MULTIPLIER
        + w1 * inp * CACHE_1H_MULTIPLIER) / 1e6;
    if (u.speed === "fast")
        usd *= FAST_MULTIPLIER;
    usd += ((u.server_tool_use && u.server_tool_use.web_search_requests) || 0) * WEB_SEARCH_USD;
    return usd;
}

/* Every transcript modified since sinceMs, with its modification time, and the creation
   time of the oldest transcript of all. */
function transcripts(sinceMs)
{
    const found = [];
    let oldestMs = Infinity;
    (function walk(dir)
    {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries)
        {
            const p = path.join(dir, e.name);
            if (e.isDirectory())
                walk(p);
            else if (e.name.endsWith(".jsonl"))
            {
                try
                {
                    const st = fs.statSync(p);
                    oldestMs = Math.min(oldestMs, st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs);
                    if (st.mtimeMs >= sinceMs)
                        found.push({ file: p, mtimeMs: st.mtimeMs });
                }
                catch { /* vanished mid-scan */ }
            }
        }
    })(PROJECTS);
    return { found, oldestMs };
}

/* A subagent transcript lives under <session>/subagents/, and belongs to that session. */
function parentSession(file)
{
    const dir = path.dirname(file);
    return path.basename(dir) === "subagents" ? path.basename(path.dirname(dir)) : null;
}

/* One billed request is written once per content block, and the desktop app mirrors a
   whole conversation into a second transcript under another session id, so requests are
   keyed by id and every session that holds a copy is remembered for attribution.
   bridge-session records carry no timestamp, so a subscription is last seen when the
   newest transcript holding one of its records was modified. */
function scan(sinceMs)
{
    const orgBySession = {};
    const lastSeen = {};
    const costStates = [];
    const requests = new Map();
    const rejections = [];
    let copies = 0;
    const { found, oldestMs } = transcripts(sinceMs);

    for (const { file, mtimeMs } of found)
    {
        let text;
        try { text = fs.readFileSync(file, "utf8"); }
        catch { continue; }
        const parent = parentSession(file);
        for (const line of text.split(/\r?\n/))
        {
            const isBridge = line.includes("ownerOrganizationUuid");
            const isCost = line.includes("\"cost-state\"");
            const isQuota = line.includes("\"quotaLimits\"");
            if (!isBridge && !isCost && !isQuota && !line.includes("\"usage\""))
                continue;
            let rec;
            try { rec = JSON.parse(line); }
            catch { continue; }
            const session = parent || rec.sessionId;
            if (isBridge && rec.sessionId && rec.ownerOrganizationUuid)
            {
                orgBySession[rec.sessionId] = rec.ownerOrganizationUuid;
                lastSeen[rec.ownerOrganizationUuid] = Math.max(lastSeen[rec.ownerOrganizationUuid] || 0, mtimeMs);
            }
            if (rec.type === "cost-state")
                costStates.push(rec);
            const q = rec.quotaLimits;
            if (q && q.status === "rejected" && q.resetsAt && SPAN_MS[q.rateLimitType] && rec.timestamp)
                rejections.push({ session, kind: q.rateLimitType, resetsAt: q.resetsAt * 1000, at: Date.parse(rec.timestamp) });
            if (rec.type !== "assistant" || !rec.message || !rec.message.usage || !rec.timestamp)
                continue;
            const ts = Date.parse(rec.timestamp);
            if (ts < sinceMs)
                continue;
            const id = rec.requestId || rec.message.id || rec.uuid;
            const known = requests.get(id);
            if (known)
            {
                copies++;
                known.sessions.add(session);
                continue;
            }
            if (rec.message.model === "<synthetic>")
                continue;
            requests.set(id, { model: rec.message.model, usage: rec.message.usage, ts, sessions: new Set([session]) });
        }
    }
    return {
        orgBySession,
        hasRecords: Object.keys(orgBySession).length > 0,
        lastSeen,
        costStates,
        requests,
        rejections,
        copies,
        fileCount: found.length,
        oldestMs
    };
}

function readJson(file)
{
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { return null; }
}

/* "Mon 5 Oct, 10:23" in local time; the hooks module never formats a date itself. */
function longLabel(ms)
{
    if (!Number.isFinite(ms))
        return null;
    const d = new Date(ms);
    const day = d.toLocaleDateString("en-GB", { weekday: "short" });
    const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    return day + " " + date + ", " + time;
}

/* "Sun 4 Oct" in local time. */
function dayLabel(ms)
{
    const d = new Date(ms);
    return d.toLocaleDateString("en-GB", { weekday: "short" }) + " " + d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function localDate(ms)
{
    const d = new Date(ms);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/* The end date is free text ('... through Sep 13') with no year and no time zone. Take the
   month and day, assume the year that puts it nearest to now, and treat the promotion as
   ending when that day ends in UTC. Null when nothing parses. */
function promoEnd(text)
{
    const m = /through\s+([A-Za-z]{3})[a-z]*\s+(\d{1,2})/.exec(text);
    if (!m)
        return null;
    const mon = MONTHS[m[1].toLowerCase()];
    if (mon === undefined)
        return null;
    const day = parseInt(m[2], 10);
    const now = Date.now();
    let year = new Date(now).getUTCFullYear();
    const half = 183 * DAY_MS;
    let end = Date.UTC(year, mon, day + 1);
    if (end < now - half)
        year++;
    else if (end > now + half)
        year--;
    end = Date.UTC(year, mon, day + 1);
    const named = new Date(Date.UTC(year, mon, day));
    return { endsAt: new Date(end).toISOString(), endsLabel: named.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) };
}

/* Promotions cached for whichever subscription is signed in. An undocumented cache:
   missing means "none cached", never "none exists". */
function promoNotices(cfg)
{
    const raw = cfg && cfg.cachedGrowthBookFeatures && cfg.cachedGrowthBookFeatures.tengu_rate_limit_promo_notices;
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const entry of raw)
    {
        const text = entry && typeof entry.text === "string" ? entry.text : null;
        if (!text)
            continue;
        const limit = LIMIT_ALIASES[String(entry.bar || "").toLowerCase()] || null;
        const end = promoEnd(text);
        out.push({ limit, text, endsAt: end ? end.endsAt : null, endsLabel: end ? end.endsLabel : null });
    }
    return out;
}

/* The plan fields of the signed-in profile, or null without one. */
function readProfile()
{
    const file = args("profile-file")[0] || CONFIG_FILE;
    const cfg = readJson(file);
    const acct = cfg && cfg.oauthAccount;
    if (!acct || typeof acct.organizationUuid !== "string" || !acct.organizationUuid)
        return null;
    const profile = { org: acct.organizationUuid };
    for (const [key, field] of Object.entries(PROFILE_FIELDS))
    {
        const v = acct[field];
        profile[key] = v === undefined || v === null || v === "" ? null : String(v);
    }
    const fetchedMs = Number(acct.profileFetchedAt);
    const hasFetched = acct.profileFetchedAt !== undefined && acct.profileFetchedAt !== null && acct.profileFetchedAt !== "" && Number.isFinite(fetchedMs) && fetchedMs > 0;
    profile.fetchedAt = hasFetched ? new Date(fetchedMs).toISOString() : null;
    profile.fetchedLabel = hasFetched ? longLabel(fetchedMs) : null;
    profile.promotions = promoNotices(cfg);
    return profile;
}

/* The subscription to report: the one owning this session; else the signed-in one, the
   best evidence of who a session with no record bills; else the one whose records sit in
   the most recently modified transcript. */
function resolveOrg(s, session, profile)
{
    const own = session ? s.orgBySession[session] : undefined;
    if (own)
        return { org: own, orgSource: "session" };
    if (profile)
        return { org: profile.org, orgSource: "profile" };
    const orgs = Object.keys(s.lastSeen).sort((a, b) => s.lastSeen[b] - s.lastSeen[a]);
    return { org: orgs[0] || null, orgSource: orgs[0] ? "most recent" : null };
}

/* A session with a bridge-session record bills the subscription the record names. With no
   record anywhere (a machine without the desktop app), nothing tells subscriptions apart,
   so every request is the resolved subscription's. Otherwise a session with no record, a
   terminal session, bills the signed-in subscription, and stays unattributed without a
   profile. */
function ownerOfSession(session, s, org, profileOrg)
{
    return s.orgBySession[session] || (s.hasRecords ? profileOrg || null : org);
}

function ownerOf(req, s, org, profileOrg)
{
    for (const session of req.sessions)
    {
        const owner = ownerOfSession(session, s, org, profileOrg);
        if (owner)
            return owner;
    }
    return null;
}

/* Requests with sinceMs <= ts <= untilMs, and only those `isIncluded` accepts when given.
   dayOf, when given, maps a request's time to a per-day bucket that is credited alongside
   the total. */
function tally(s, org, profileOrg, sinceMs, untilMs, dayOf, isIncluded)
{
    const out = {
        usd: 0,
        requests: 0,
        byModel: {},
        otherSubscriptionsUsd: 0,
        unattributedUsd: 0,
        unpricedRequests: 0,
        unpricedModels: []
    };
    const unpriced = new Set();
    for (const req of s.requests.values())
    {
        if (req.ts < sinceMs || req.ts > untilMs || (isIncluded && !isIncluded(req)))
            continue;
        const usd = costOf(req.model, req.usage);
        if (usd === null)
        {
            out.unpricedRequests++;
            unpriced.add(req.model);
            continue;
        }
        const owner = ownerOf(req, s, org, profileOrg);
        if (!owner && org)
        {
            out.unattributedUsd += usd;
            continue;
        }
        if (owner && owner !== org)
        {
            out.otherSubscriptionsUsd += usd;
            continue;
        }
        out.usd += usd;
        out.requests++;
        const m = (out.byModel[req.model] = out.byModel[req.model] || { usd: 0, requests: 0 });
        m.usd += usd;
        m.requests++;
        const day = dayOf && dayOf(req.ts);
        if (day)
        {
            day.usd += usd;
            day.requests++;
        }
    }
    out.unpricedModels = [...unpriced];
    return out;
}

function resetLabels(resetMs)
{
    if (!Number.isFinite(resetMs))
        return {};
    const d = new Date(resetMs);
    const day = d.toLocaleDateString("en-GB", { weekday: "short" });
    const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const minutes = Math.max(0, Math.round((resetMs - Date.now()) / 60000));
    const hours = Math.floor(minutes / 60);
    const resetIn = hours >= 24
        ? Math.floor(hours / 24) + " d " + (hours % 24) + " h"
        : hours >= 1 ? hours + " h " + (minutes % 60) + " min" : minutes + " min";
    return { resetLabel: time, resetLabelWithDay: day + " " + time, resetLong: longLabel(resetMs), resetIn };
}

function args(name)
{
    const found = [];
    for (let i = 0; i < process.argv.length - 1; i++)
        if (process.argv[i] === "--" + name)
            found.push(process.argv[i + 1]);
    return found;
}

function labels()
{
    const out = {};
    for (const spec of args("label"))
    {
        const cut = spec.indexOf(",");
        const ms = Date.parse(spec.slice(cut + 1));
        if (cut <= 0 || !Number.isFinite(ms))
            throw new Error("--label takes <key>,<ISO>: " + spec);
        out[spec.slice(0, cut)] = longLabel(ms);
    }
    return out;
}

function windows(profile)
{
    const started = Date.now();
    const specs = args("window").map(spec =>
    {
        const [name, since, reset, until, own] = spec.split(",");
        const sinceMs = Date.parse(since);
        const untilMs = until === undefined || until === "" ? Infinity : Date.parse(until);
        if (!name || !Number.isFinite(sinceMs) || Number.isNaN(untilMs) || own === "")
            throw new Error("--window takes <name>,<sinceISO>,<resetISO>[,<untilISO>[,<sessionId>]]: " + spec);
        return { name, sinceMs, resetMs: Date.parse(reset), untilMs, own };
    });
    if (!specs.length)
        throw new Error("at least one --window is required");
    const s = scan(Math.min(...specs.map(w => w.sinceMs)));
    const session = args("session")[0];
    const { org, orgSource } = resolveOrg(s, session, profile);
    const profileOrg = profile ? profile.org : null;
    const out = { org, orgSource, pricesId: PRICES_ID, windows: {}, files: s.fileCount, copiesIgnored: s.copies, ms: 0 };
    for (const w of specs)
    {
        /* A subagent's requests carry its parent's session, so they count as that session's. */
        const own = w.own || session;
        const slackUntil = Number.isFinite(w.untilMs) ? w.untilMs : started;
        const slack = tally(s, org, profileOrg, slackUntil - SLACK_MS + 1, slackUntil, undefined, req => !req.sessions.has(own));
        out.windows[w.name] = {
            since: new Date(w.sinceMs).toISOString(),
            ...tally(s, org, profileOrg, w.sinceMs, w.untilMs),
            slackUsd: slack.usd,
            ...resetLabels(w.resetMs)
        };
    }
    out.ms = Date.now() - started;
    return out;
}

/* The session's subscription from its own transcript alone, else the signed-in one. */
function whoami(profile)
{
    const session = args("session")[0];
    if (session)
    {
        let dirs = [];
        try { dirs = fs.readdirSync(PROJECTS, { withFileTypes: true }).filter(e => e.isDirectory()); }
        catch { /* no projects yet */ }
        for (const dir of dirs)
        {
            let text;
            try { text = fs.readFileSync(path.join(PROJECTS, dir.name, session + ".jsonl"), "utf8"); }
            catch { continue; }
            for (const line of text.split(/\r?\n/))
            {
                if (!line.includes("ownerOrganizationUuid"))
                    continue;
                let rec;
                try { rec = JSON.parse(line); }
                catch { continue; }
                if (rec.sessionId === session && rec.ownerOrganizationUuid)
                    return { org: rec.ownerOrganizationUuid, orgSource: "session" };
            }
        }
    }
    return profile ? { org: profile.org, orgSource: "profile" } : { org: null, orgSource: null };
}

/* A rejection marks its window as full at that moment, so the dollars used up to it are a
   direct reading of that window's allowance. The earliest rejection per window counts. */
function history(profile)
{
    const days = Number(args("history")[0]);
    if (!(days > 0))
        throw new Error("--history takes a number of days");
    const started = Date.now();
    const s = scan(Date.now() - days * DAY_MS - SPAN_MS.seven_day);
    const { org, orgSource } = resolveOrg(s, args("session")[0], profile);
    const profileOrg = profile ? profile.org : null;
    const first = new Map();
    for (const r of s.rejections)
    {
        if (org && ownerOfSession(r.session, s, org, profileOrg) !== org)
            continue;
        const key = r.kind + ":" + r.resetsAt;
        if (!first.has(key) || r.at < first.get(key).at)
            first.set(key, r);
    }
    const observations = [];
    for (const r of first.values())
    {
        const t = tally(s, org, profileOrg, r.resetsAt - SPAN_MS[r.kind], r.at);
        if (t.usd > 0)
            observations.push({ kind: r.kind, resetsAt: new Date(r.resetsAt).toISOString(), at: new Date(r.at).toISOString(), usd: t.usd });
    }
    observations.sort((a, b) => a.at.localeCompare(b.at));
    return { org, orgSource, observations, files: s.fileCount, ms: Date.now() - started };
}

/* A local date, YYYY-MM-DD or "today", as the epoch ms of its local midnight. */
function localMidnight(text)
{
    if (text === "today")
    {
        const d = new Date();
        return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text || "");
    if (!m)
        return null;
    const [y, mo, day] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
    const d = new Date(y, mo, day);
    return d.getFullYear() === y && d.getMonth() === mo && d.getDate() === day ? d.getTime() : null;
}

function nextMidnight(ms)
{
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

function reportRange()
{
    const local = args("report-local")[0];
    if (local !== undefined)
    {
        const [from, to] = local.split(",");
        const sinceMs = localMidnight(from);
        const lastDay = localMidnight(to);
        if (sinceMs === null || lastDay === null)
            throw new Error("--report-local takes <from>,<to>, each YYYY-MM-DD or today: " + local);
        if (sinceMs > lastDay)
            throw new Error("--report-local: " + from + " is after " + to);
        return { sinceMs, untilMs: nextMidnight(lastDay) };
    }
    const spec = args("report")[0] || "";
    const [since, until] = spec.split(",");
    const sinceMs = Date.parse(since);
    const untilMs = Date.parse(until);
    if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs))
        throw new Error("--report takes <sinceISO>,<untilISO>: " + spec);
    if (sinceMs >= untilMs)
        throw new Error("--report: the range is empty");
    return { sinceMs, untilMs };
}

/* Spending in [since, until), per local day and per model. */
function report(profile)
{
    const started = Date.now();
    const { sinceMs, untilMs } = reportRange();
    const s = scan(sinceMs);
    const { org, orgSource } = resolveOrg(s, args("session")[0], profile);
    const byDay = [];
    const days = {};
    for (let d = new Date(new Date(sinceMs).setHours(0, 0, 0, 0)).getTime(); d < untilMs; d = nextMidnight(d))
    {
        const bucket = { date: localDate(d), label: dayLabel(d), usd: 0, requests: 0 };
        byDay.push(bucket);
        days[bucket.date] = bucket;
    }
    const t = tally(s, org, profile ? profile.org : null, sinceMs, untilMs - 1, ts => days[localDate(ts)]);
    const out = {
        org,
        orgSource,
        usd: t.usd,
        requests: t.requests,
        byModel: t.byModel,
        byDay,
        otherSubscriptionsUsd: t.otherSubscriptionsUsd,
        unattributedUsd: t.unattributedUsd,
        unpricedRequests: t.unpricedRequests,
        unpricedModels: t.unpricedModels,
        fromLabel: longLabel(sinceMs),
        toLabel: longLabel(Math.min(untilMs, Date.now()))
    };
    if (Number.isFinite(s.oldestMs) && sinceMs < s.oldestMs)
        out.transcriptsBeginLabel = dayLabel(s.oldestMs);
    out.files = s.fileCount;
    out.ms = Date.now() - started;
    return out;
}

/* Each recorded session's cost per model, as Claude Code recorded it and as priced here. A
   session can hold more than one cost-state, so a pair can repeat. */
function checkRows()
{
    const s = scan(0);
    const bySession = {};
    for (const req of s.requests.values())
    {
        const session = [...req.sessions][0];
        const m = (bySession[session] = bySession[session] || {});
        m[req.model] = (m[req.model] || 0) + (costOf(req.model, req.usage) || 0);
    }
    const rows = [];
    for (const cs of s.costStates)
        for (const [model, mu] of Object.entries(cs.modelUsage || {}))
        {
            const mine = (bySession[cs.sessionId] || {})[model];
            if (mine === undefined)
                continue;
            rows.push({ sessionId: cs.sessionId, model, claudeCode: mu.costUSD, ours: mine });
        }
    return rows;
}

/* Prices each recorded session and sets it beside the cost Claude Code itself recorded. */
function check()
{
    return checkRows().map(r => ({ session: r.sessionId.slice(0, 8), model: r.model, claudeCode: +r.claudeCode.toFixed(4), ours: +r.ours.toFixed(4), ratio: +(r.ours / r.claudeCode).toFixed(3) }));
}

const MIN_CHECK_USD = 0.5;

/* The p-quantile of sorted values, interpolated between neighbors. */
function quantile(sorted, p)
{
    const at = (sorted.length - 1) * p;
    const lo = Math.floor(at);
    const hi = Math.ceil(at);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/* The latest cost-state of each session and model, the one with the largest recorded cost,
   and only those of at least MIN_CHECK_USD. */
function checkSummary()
{
    const started = Date.now();
    const largest = new Map();
    for (const r of checkRows())
    {
        const key = r.sessionId + "|" + r.model;
        const was = largest.get(key);
        if (!was || r.claudeCode > was.claudeCode)
            largest.set(key, r);
    }
    const ratios = [...largest.values()]
        .filter(r => r.claudeCode >= MIN_CHECK_USD)
        .map(r => r.ours / r.claudeCode)
        .sort((a, b) => a - b);
    const round = v => +v.toFixed(3);
    return {
        sessions: ratios.length,
        medianRatio: ratios.length ? round(quantile(ratios, 0.5)) : null,
        lowRatio: ratios.length ? round(quantile(ratios, 0.05)) : null,
        highRatio: ratios.length ? round(quantile(ratios, 0.95)) : null,
        ms: Date.now() - started
    };
}

try
{
    let result;
    if (process.argv.includes("--check-summary"))
        result = checkSummary();
    else if (process.argv.includes("--check"))
        result = check();
    else
    {
        const profile = readProfile();
        const named = labels();
        result = process.argv.includes("--whoami") ? whoami(profile)
            : args("history").length ? history(profile)
            : args("report").length || args("report-local").length ? report(profile)
            : windows(profile);
        result.profile = profile;
        result.labels = named;
    }
    console.log(JSON.stringify(result, null, 2));
}
catch (e)
{
    console.log(JSON.stringify({ error: String(e && e.message || e) }));
    process.exit(2);
}

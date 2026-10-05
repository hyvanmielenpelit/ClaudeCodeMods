#!/usr/bin/env node
/* Prices every billed request in the local Claude Code transcripts at API list rates and
   prints JSON, counting only the subscription that owns --session (through the
   bridge-session records the desktop app writes).

   Usage:
     node usage-cost.mjs --session <id> --window <name>,<sinceISO>,<resetISO> [--window ...]
         Totals per window: used dollars, requests, per-model split, reset labels.
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

   Every mode but --check also takes --label <key>,<ISO> (any number of times), answered
   as local-time labels, and --profile-file <path> in place of the config file. */

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
        + w5 * inp * 1.25
        + w1 * inp * 2) / 1e6;
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

/* With no bridge-session record anywhere (a machine without the desktop app), nothing
   tells subscriptions apart, so every request is the resolved subscription's. */
function ownerOfSession(session, s, org)
{
    return s.hasRecords ? s.orgBySession[session] || null : org;
}

function ownerOf(req, s, org)
{
    for (const session of req.sessions)
    {
        const owner = ownerOfSession(session, s, org);
        if (owner)
            return owner;
    }
    return null;
}

/* Requests with sinceMs <= ts <= untilMs. dayOf, when given, maps a request's time to a
   per-day bucket that is credited alongside the total. */
function tally(s, org, sinceMs, untilMs, dayOf)
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
        if (req.ts < sinceMs || req.ts > untilMs)
            continue;
        const usd = costOf(req.model, req.usage);
        if (usd === null)
        {
            out.unpricedRequests++;
            unpriced.add(req.model);
            continue;
        }
        const owner = ownerOf(req, s, org);
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
        const [name, since, reset] = spec.split(",");
        const sinceMs = Date.parse(since);
        if (!name || !Number.isFinite(sinceMs))
            throw new Error("--window takes <name>,<sinceISO>,<resetISO>: " + spec);
        return { name, sinceMs, resetMs: Date.parse(reset) };
    });
    if (!specs.length)
        throw new Error("at least one --window is required");
    const s = scan(Math.min(...specs.map(w => w.sinceMs)));
    const { org, orgSource } = resolveOrg(s, args("session")[0], profile);
    const out = { org, orgSource, windows: {}, files: s.fileCount, copiesIgnored: s.copies, ms: 0 };
    for (const w of specs)
        out.windows[w.name] = { since: new Date(w.sinceMs).toISOString(), ...tally(s, org, w.sinceMs, Infinity), ...resetLabels(w.resetMs) };
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
    const first = new Map();
    for (const r of s.rejections)
    {
        if (org && ownerOfSession(r.session, s, org) !== org)
            continue;
        const key = r.kind + ":" + r.resetsAt;
        if (!first.has(key) || r.at < first.get(key).at)
            first.set(key, r);
    }
    const observations = [];
    for (const r of first.values())
    {
        const t = tally(s, org, r.resetsAt - SPAN_MS[r.kind], r.at);
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
    const t = tally(s, org, sinceMs, untilMs - 1, ts => days[localDate(ts)]);
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

/* Prices each recorded session and sets it beside the cost Claude Code itself recorded. */
function check()
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
            rows.push({ session: cs.sessionId.slice(0, 8), model, claudeCode: +mu.costUSD.toFixed(4), ours: +mine.toFixed(4), ratio: +(mine / mu.costUSD).toFixed(3) });
        }
    return rows;
}

try
{
    let result;
    if (process.argv.includes("--check"))
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

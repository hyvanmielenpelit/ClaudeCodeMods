#!/usr/bin/env node
/* Prices every billed request in the local Claude Code transcripts at API list rates and
   prints JSON, counting only the subscription that owns --session (through the
   bridge-session records the desktop app writes).

   Usage:
     node usage-cost.mjs --session <id> --window <name>,<sinceISO>,<resetISO> [--window ...]
         Totals per window: used dollars, requests, per-model split, reset labels.
     node usage-cost.mjs --session <id> --history <days>
         Every rate-limit rejection in the last <days> days, with the dollars used in its
         window up to the rejection: a window known to be exactly full.
     node usage-cost.mjs --check
         Sets each session's computed cost beside the cost Claude Code itself recorded. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROJECTS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");

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
const SPAN_MS = { five_hour: 5 * 3600000, seven_day: 7 * 24 * 3600000 };

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

function transcripts(sinceMs)
{
    const found = [];
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
                try { if (fs.statSync(p).mtimeMs >= sinceMs) found.push(p); }
                catch { /* vanished mid-scan */ }
            }
        }
    })(PROJECTS);
    return found;
}

/* A subagent transcript lives under <session>/subagents/, and belongs to that session. */
function parentSession(file)
{
    const dir = path.dirname(file);
    return path.basename(dir) === "subagents" ? path.basename(path.dirname(dir)) : null;
}

/* One billed request is written once per content block, and the desktop app mirrors a
   whole conversation into a second transcript under another session id, so requests are
   keyed by id and every session that holds a copy is remembered for attribution. */
function scan(sinceMs)
{
    const orgBySession = {};
    const lastSeen = {};
    const costStates = [];
    const requests = new Map();
    const rejections = [];
    let copies = 0;
    const files = transcripts(sinceMs);

    for (const file of files)
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
                const ts = rec.timestamp ? Date.parse(rec.timestamp) : 0;
                lastSeen[rec.ownerOrganizationUuid] = Math.max(lastSeen[rec.ownerOrganizationUuid] || 0, ts, 1);
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
    return { orgBySession, lastSeen, costStates, requests, rejections, copies, fileCount: files.length };
}

/* The subscription to report: the one owning this session, else the one seen most recently. */
function resolveOrg(s, session)
{
    const own = session ? s.orgBySession[session] : undefined;
    if (own)
        return { org: own, orgSource: "session" };
    const orgs = Object.keys(s.lastSeen).sort((a, b) => s.lastSeen[b] - s.lastSeen[a]);
    return { org: orgs[0] || null, orgSource: orgs[0] ? "most recent" : null };
}

function ownerOf(req, orgBySession)
{
    for (const session of req.sessions)
        if (orgBySession[session])
            return orgBySession[session];
    return null;
}

function tally(s, org, sinceMs, untilMs)
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
        const owner = ownerOf(req, s.orgBySession);
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
    const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const minutes = Math.max(0, Math.round((resetMs - Date.now()) / 60000));
    const hours = Math.floor(minutes / 60);
    const resetIn = hours >= 24
        ? Math.floor(hours / 24) + " d " + (hours % 24) + " h"
        : hours >= 1 ? hours + " h " + (minutes % 60) + " min" : minutes + " min";
    return { resetLabel: time, resetLabelWithDay: day + " " + time, resetLong: day + " " + date + ", " + time, resetIn };
}

function args(name)
{
    const found = [];
    for (let i = 0; i < process.argv.length - 1; i++)
        if (process.argv[i] === "--" + name)
            found.push(process.argv[i + 1]);
    return found;
}

function windows()
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
    const { org, orgSource } = resolveOrg(s, args("session")[0]);
    const out = { org, orgSource, windows: {}, files: s.fileCount, copiesIgnored: s.copies, ms: 0 };
    for (const w of specs)
        out.windows[w.name] = { since: new Date(w.sinceMs).toISOString(), ...tally(s, org, w.sinceMs, Infinity), ...resetLabels(w.resetMs) };
    out.ms = Date.now() - started;
    return out;
}

/* A rejection marks its window as full at that moment, so the dollars used up to it are a
   direct reading of that window's allowance. The earliest rejection per window counts. */
function history()
{
    const days = Number(args("history")[0]);
    if (!(days > 0))
        throw new Error("--history takes a number of days");
    const started = Date.now();
    const s = scan(Date.now() - days * 24 * 3600000 - SPAN_MS.seven_day);
    const { org, orgSource } = resolveOrg(s, args("session")[0]);
    const first = new Map();
    for (const r of s.rejections)
    {
        if (org && s.orgBySession[r.session] !== org)
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
    const result = process.argv.includes("--check") ? check()
        : args("history").length ? history()
        : windows();
    console.log(JSON.stringify(result, null, 2));
}
catch (e)
{
    console.log(JSON.stringify({ error: String(e && e.message || e) }));
    process.exit(2);
}

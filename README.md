# Claude Code Mods

Mods for [Claude Code](https://claude.com/claude-code) by Hyvän Mielen Pelit, written as
function-hook plugins. The repository is also a plugin marketplace.

| Mod | What it does |
|---|---|
| [usage-dollars](usage-dollars) | Subscription usage for the 5-hour window and the week as API-equivalent dollars: the estimated allowance first, then used and left, with 90% ranges; spending reports by date range. |

## Installing

From inside Claude Code:

```
/plugin marketplace add hyvanmielenpelit/ClaudeCodeMods
/plugin install usage-dollars@hyvanmielenpelit-claude-code-mods
```

To load a working copy for one session instead:

```
claude --plugin-dir C:\hmp\ClaudeCodeMods\usage-dollars
```

Sessions the desktop app starts take no flags; name the folder in `CLAUDE_CODE_PLUGIN_DIRS`
in the `env` block of `~/.claude/settings.json` instead.

Function-hook plugins are an early-access Claude Code surface and may change between
releases. Check a mod with `claude plugin validate <folder>`.

## usage-dollars

Shows on the status line, what is left of each window's estimated allowance:

```
usage-dollars  5h ~$850 left of $913 · Week ~$2.7k left of $2.8k
```

While a window has no estimate yet it reads `5h $40 used, estimating`, and once nothing is
left, `5h at limit`. `⚠ Plan changed` means a plan change was observed and the card has not
been opened since.

### Commands

| Command | Shows |
|---|---|
| `/usage-dollars` | The window card: plan, notices, each window's allowance first, then used, left, the next tick, and spending per model |
| `/usage-dollars report` | Spending in the last 24 hours, per day and per model |
| `/usage-dollars 24h`, `/usage-dollars 7d` | Spending in the last N hours or days, up to 90 days |
| `/usage-dollars today` | Spending since local midnight |
| `/usage-dollars 2026-10-01` | Spending on one local day |
| `/usage-dollars 2026-10-01..2026-10-05` | Spending over local days, both inclusive |
| `/usage-dollars reset` | Restarts the estimates for this subscription (see below) |
| `/usage-dollars reset undo` | Undoes the latest reset |

The window card is allowance-first: a headline row gives each window's estimated allowance,
its 90% range and a confidence label (`good` within about ±10%, `fair` within ±30%,
`rough` beyond). Each window then shows what is used and what is left, a bar of used
dollars against the allowance range, the percent the estimate rests on ("Limit reports 10%
· read 2 min ago"), and "next tick": about how many more dollars until the reported percent
moves again. Before the first estimate a window reads "estimating…"; no dollar figure can be
given until the limit reports a higher percent.

A spending report covers only as far back as this machine's transcripts do. When the range
starts earlier, the report says where the transcripts begin.

### The plan line and plan changes

The plan comes from the signed-in account profile in `~/.claude.json` (or
`$CLAUDE_CONFIG_DIR/.claude.json`), for example "Plan: Max 20x · profile as of Mon 5 Oct,
10:23". Claude Code refreshes that profile on its own schedule, sometimes a day or more
apart, so the card always says how old it is and adds "(may be out of date)" after a week.
The profile describes only the subscription Claude Code is signed in to now: a session that
bills another subscription shows "Plan: unknown for this subscription", with the plan last
seen for it. Plan values the mod does not know are shown verbatim, never guessed.

The mod tells two kinds of change apart:

- **Observed.** The profile reported a different plan. The card says "Plan changed: Max 5x →
  Max 20x (between … and …)". The change is known only between the two profile fetches, and
  estimates restart from the later one, so no reading taken under the old plan is used.
- **Inferred.** The current window no longer fits recent windows. The card says limits *may*
  have changed and suggests a reset, but changes nothing by itself. Usage on another device,
  or on claude.ai, raises the percent without raising this machine's dollars, and looks
  exactly like a lowered limit.

Promotions that Claude Code has cached for the signed-in subscription are shown too. A new
promotion restarts the estimates for the window it names, and so does its end date passing.

### Starting over: `/usage-dollars reset`

Use it after changing plans when the card does not show the change yet, when a promotion
starts or ends that the card did not report, or after the inferred-change notice when you
know the limits really changed.

| Data | After `reset` |
|------|---------------|
| Closed windows' readings and rate-limit rejections from before the reset | No longer feed the prior or the measured mix error. The mix error falls back to the assumed 10% until enough new windows close. |
| The current window's readings taken before the reset | Excluded. The estimate rebuilds from readings taken after it; the first scan after it takes one at once. |
| The current window's used dollars | Unchanged: they are a fact about spending, not about the limit. |
| The plan ledger, spending reports, the 24-hour figure, per-model tables | Unchanged. |
| Stored data | Nothing is deleted. Readings stay until the normal 28-day pruning. |
| Other subscriptions | Unaffected. |

Ranges widen to what the current readings alone support, then narrow again as the percent
ticks over: under an hour of normal work on a 5-hour window, about a day on the week.
`/usage-dollars reset undo` restores the earlier estimates, apart from readings taken in
between. Two resets are undone one at a time. A reset followed by an observed plan or
promotion change can no longer be undone.

### How the figures are made

- **Used** prices every request in this machine's transcripts since the window began at
  API list rates: input, output, cache reads, 5-minute and 1-hour cache writes, fast mode
  and web searches. Only requests billed to the subscription the session runs on count,
  matched through the `bridge-session` records the desktop app writes; a session with no
  record is taken to bill the signed-in subscription. Checked against Claude Code's own
  per-session costs it usually comes within a few percent, and up to a quarter low on long
  sessions, because some billed calls never reach a transcript.
- **Allowance** and **left** come from the limit's own reading. The API reports the
  window's usage in whole percent, so each reading pins the allowance between two bounds,
  `used / (p + 1)%` and `used / (p - 0.5)%` while it is not known whether the API rounds
  or truncates. Once closed windows show which it does, the tighter bounds of that rule
  apply. The mod keeps the readings of every window and intersects them, so the bounds
  narrow each time the percent ticks over. A reading is taken only when this session has
  just received the percent, after its own turn or when the percent moves, and is paired
  with the dollars of that moment; running sessions share the freshest percent between
  them. Readings that contradict the rest are set aside, the newest kept, and counted in
  the card's basis line.
- **The 90% range** widens those bounds by how far API prices may differ from the limit's
  own weighting of tokens: the spread of past windows' allowances, never taken below 3%,
  once there are effectively at least three, otherwise an assumed 10%. Past windows also
  act as a prior. They come from the mod's own readings of closed windows and from
  rate-limit rejections in the last 14 days of transcripts, each a window seen exactly
  full. Older windows count for less: a past 5-hour window loses half its weight every day,
  a past week every 14 days, so the estimate follows a change of limits quickly. The card's
  "history weight" is the effective number of past windows behind the prior.

How fast the allowance can be known after a change of limits:

| Window used | Range |
|---|---|
| ~1% | about a factor of four |
| ~4% | ±25% |
| ~8–10% | ±10% |

On a 5-hour window that takes under an hour of work; on the week, about a day.

Upgrading from 0.3.0 restarts the estimates once: the readings it kept cannot be attributed
to a subscription. Upgrading from 0.4.0 drops the stored readings once: some paired a
session's old percent with current dollars.

### Limits

- Usage from other machines, or from claude.ai, on the same subscription is not counted,
  and makes the allowance look smaller than it is.
- Model prices live in [`scripts/usage-cost.mjs`](usage-dollars/scripts/usage-cost.mjs).
  A model missing there is reported as unpriced, never guessed; add new models as they
  ship.
- Requires Node.js on `PATH`; the transcript scan runs as a child process.
- Without a subscription (an API key), there are no limits to read and no estimates.

### Files

| Path | Role |
|---|---|
| `.claude-plugin/plugin.json` | Manifest |
| `hooks/register.tsx` | Hooks: events, the `/usage-dollars` command forms, toasts |
| `hooks/measure.ts` | The scan, stored readings and plan history per subscription, the estimates |
| `hooks/estimate.ts` | Allowance estimate, its 90% range, rounding inference, next tick |
| `hooks/plan.ts` | Plan ledger, promotions, regimes, reset and undo |
| `hooks/card.tsx` | The window and report cards, their Markdown fallbacks, the status line |
| `scripts/usage-cost.mjs` | Transcript scan, pricing, the profile, date labels (Node) |
| `types/index.d.ts` | Type contract for the mod's session state |
| `tests/*.test.ts` | Unit tests: `claude plugin test usage-dollars` |
| `tests/helper.test.mjs` | Helper tests: `node --test usage-dollars/tests/helper.test.mjs` |
| `tests/fixtures/` | Synthetic profiles and transcripts for the helper tests |

`node usage-dollars/scripts/usage-cost.mjs --check` sets each session's computed cost
beside the cost Claude Code recorded for it.

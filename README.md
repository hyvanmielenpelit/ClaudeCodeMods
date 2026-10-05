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
| Closed windows' readings and rate-limit rejections from before the reset | No longer feed the prior or the measured spreads. Both spreads fall back to their assumed values until new windows close. |
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
- **Readings.** The API reports the window's usage in whole percent, and the percent a
  response carries includes that response. A reading is taken only when this session has
  just received the percent, and pairs it with the dollars counted up to the moment it
  arrived, not up to when the scan runs. Another session's request in the 30 seconds
  before that moment may or may not be in the percent yet; its dollars are kept with the
  reading as slack. Running sessions share the freshest percent between them. No reading
  is taken while more than 2% of a window's requests go to unpriced models, and readings
  priced with an older price table are dropped.
- **Allowance** rests on the newest percent level. When the level below it was read too,
  the percent ticked over between those two readings, and the dollars at that moment
  divided by the share at the tick give the dollars per percent; otherwise the share
  anywhere in the level's interval does. Until closed windows show whether the API rounds
  or truncates, the tick is either rule's, and the range covers both. A level of 100% is
  used only through its crossing: spending can continue past the limit.
- **The 90% range** comes from a stated model. The dollars one percent costs vary within
  a window, because API prices weight tokens differently from the limit. Read at share
  `s`, the dollars per percent so far differ from the whole window's by a relative spread
  `omega · √(1/s − 1/100)`, which vanishes as the window fills; so "left" narrows as it
  is used. Between windows the allowance itself varies by `tau`. Past windows act as a
  prior that is combined with the current reading by precision, unless the two disagree
  beyond chance; then the reading alone counts and the card says limits may have changed.
  The interval uses Student's t, so few past windows widen it.
- **Two spreads start as assumptions**: `omega = 0.5` within a window and `tau = 10%`
  between windows. Each is shrunk toward what this machine's own closed windows show:
  omega from how far the dollars per percent at each tick of a closed window strayed from
  its end, tau from the scatter of past allowances. The card's basis line says which is
  assumed and which measured. Past windows come from the mod's own readings of closed
  windows that reached half way and from rate-limit rejections in the last 14 days of
  transcripts, each a window seen exactly full; a window seen both ways counts once.
  Older windows count for less: a past 5-hour window loses half its weight every day, a
  past week every 14 days, so the estimate follows a change of limits quickly. The card's
  "history weight" is the effective number of past windows behind the prior.

How fast the allowance can be known, with no past windows, from the coverage simulation
in `tests/coverage.test.mjs` (scenario S1: steady requests of about $0.60 against a $650
window). The first column holds once omega has been measured on 30 closed windows, the
second with the assumed omega:

| Window used | Range, spread measured | Range, spread assumed |
|---|---|---|
| 3% | ±21% | about a factor of two |
| 10% | ±9% | ±39% |
| 25% | ±5% | ±21% |
| 50% | ±3% | ±11% |
| 90% | ±1% | ±4% |

Past windows narrow the early figures further. In the simulation the range holds the true
allowance 89% to 96% of the time from 3% used on, when the rounding rule is known, and
somewhat more often while it is not.

Upgrading from 0.3.0 restarts the estimates once: the readings it kept cannot be attributed
to a subscription. Upgrading from 0.4.0 drops the stored readings once: some paired a
session's old percent with current dollars. Upgrading from 0.5.0 drops them once more:
they paired the percent with the dollars at the time of the scan. Rate-limit history is
kept.

### Limits

- Usage from other machines, or from claude.ai, on the same subscription is not counted,
  and makes the allowance look smaller than it is.
- The model assumes the dollars per percent vary from request to request independently.
  When the mix of work stays expensive or cheap for long stretches (say, one model for an
  hour, then another), the early range is too narrow: in the simulation it holds the true
  allowance about 85% of the time rather than 90%.
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
| `tests/*.test.ts` | Unit tests: `claude plugin test usage-dollars` (see below) |
| `tests/helper.test.mjs` | Helper tests: `node --test usage-dollars/tests/helper.test.mjs` |
| `tests/coverage.test.mjs` | Coverage of the 90% range in simulated windows: `node --test usage-dollars/tests/coverage.test.mjs` |
| `tests/fixtures/` | Synthetic profiles and transcripts for the helper tests |

`claude plugin test` and a `claude plugin validate` that knows every hook this mod uses
need a recent Claude Code. The `claude` on `PATH` may be older than the build the desktop
app bundles, under `%APPDATA%\Claude\claude-code\<version>\<build>\claude.exe` on Windows;
run that one if `plugin test` is an unknown command.

`node usage-dollars/scripts/usage-cost.mjs --check` sets each session's computed cost
beside the cost Claude Code recorded for it.

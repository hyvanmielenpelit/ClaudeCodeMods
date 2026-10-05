# usage-dollars: a practical guide

usage-dollars estimates how many API-equivalent dollars each rate-limit window of your
subscription allows, the 5-hour window and the week, and how much of that is left. This
guide covers how to set it up so the estimates become as accurate as the data allows, how
to read what it shows, and what to do when something changes. `/usage-dollars help` shows
it in Claude Code; the README of the ClaudeCodeMods repository explains how the figures are
computed.

## Commands

| Command | What it does |
|---------|--------------|
| `/usage-dollars` | The window card: each window's allowance, used, left, next tick, spending per model |
| `/usage-dollars help` | This guide |
| `/usage-dollars check` | The setup check: one line per item, ✓, ✗ with the fix, or ℹ |
| `/usage-dollars calibrate` | What each window's estimate rests on, and what is still assumed |
| `/usage-dollars report` | Spending in the last 24 hours, per day and per model |
| `/usage-dollars 24h`, `/usage-dollars 7d` | Spending in the last N hours or days (`<N>h`, `<N>d`), up to 90 days |
| `/usage-dollars today` | Spending since local midnight |
| `/usage-dollars 2026-10-01` | Spending on one local day |
| `/usage-dollars 2026-10-01..2026-10-05` | Spending over local days, both inclusive |
| `/usage-dollars reset` | Restarts the estimates for this subscription |
| `/usage-dollars reset undo` | Undoes the latest reset |

`/help` lists every command Claude Code knows, this one among them, and typing
`/usage-dollars ` shows the forms above as a hint after the name.

## What makes the estimates accurate

The estimates improve on their own, from two things:

1. **Readings.** After every reply, in any session on the subscription, the mod pairs the
   percent the limit reports with the dollars this machine's transcripts show up to that
   moment. You do nothing to take them.
2. **Closed windows.** When a window resets, its readings show how much the dollars per
   percent varied within it and how big its allowance was. Those closed windows set how wide
   the next ranges are.

**None of the commands make the estimates more accurate.** `/usage-dollars calibrate` and
`/usage-dollars check` *show* what has been measured and what is wrong; they do not
measure anything themselves. Running them more often changes nothing. What helps is:

- Every session runs the current hooks, and there is only one copy of the plugin
  (otherwise readings are lost).
- The mod can tell which subscription each session bills (otherwise no readings are
  taken).
- Windows close with enough use in them to say something (see "How long calibration
  takes" below).

You do not need to change how you use Claude Code. Light use calibrates more slowly, but
it does calibrate.

## Quick start

1. **Install one copy.** Either install from the marketplace or load a working copy with
   `--plugin-dir` / `CLAUDE_CODE_PLUGIN_DIRS`, not both. Two copies run two sets of hooks.
2. **Restart every Claude Code session**, in the desktop app and in terminals. A session
   keeps the hooks it started with until it restarts.
3. **Make sure `node` is on `PATH`** (Node.js 18 or later). The transcript scan runs in
   Node.
4. **Run `/usage-dollars check`** and fix every ✗ (see "The setup check" below).
5. **Work as usual.** The status line reads "waiting for the first reply" until a limit is
   known, then `5h ~$850 left of $913 · Week ~$2.7k left of $2.8k` once each window has a
   reading.

After that, the routine is short:

| When | Do |
|------|----|
| You want to know what is left | Look at the status line, or run `/usage-dollars` for the card |
| A window has reset, or once a week | Run `/usage-dollars calibrate` to see progress (optional) |
| After updating the plugin | Restart every session, then run `/usage-dollars check` |
| After a plan change the card did not report | Run `/usage-dollars reset` |
| The calibration counts stop growing although windows close | Run `/usage-dollars check` |

## Reading the card

`/usage-dollars` shows each window's **allowance** first: the estimate, its 90% range, and a
confidence label.

| Label | Meaning |
|-------|---------|
| `good` | The 90% range is within about ±10% |
| `fair` | Within about ±30% |
| `rough` | Wider |
| `· calibrated` after the label | Both spreads and the rounding rule rest on this machine's measurements, not on assumptions |

Below the headline, per window:

- **Used**: the dollars spent in the window so far. This is a fact, not an estimate.
- **Left**: allowance minus used, with its range.
- **Limit reports N% · read X min ago**: the percent the estimate rests on, and how fresh it
  is.
- **Next tick**: about how many dollars until the reported percent moves again. Shown only
  while the percent is under 5 minutes old.
- **The basis line** (dim, at the bottom): how many percent levels were read, whether each
  spread is assumed or measured, and the history weight.

A wide range early in a window is expected, not a fault. The range narrows as the window
fills, and narrows sooner once closed windows have measured the spreads.

Notices at the top of the card:

- **Plan changed: Max 5x → Max 20x**: the profile reported a new plan; estimates restarted
  on their own.
- **Usage no longer matches recent windows…**: the current window disagrees with past ones.
  Either the limits changed, or the subscription was used somewhere this machine cannot
  see (another computer, claude.ai). Run `/usage-dollars reset` only if you know the limits
  changed.

## Watching calibration

`/usage-dollars calibrate` lists, for each window, the facts behind its estimate:

| Line | What it says | Becomes measured when |
|------|--------------|-----------------------|
| `This window: N percent levels read, M ticks seen` | How much the current window has been read. A tick is a percent step seen from both sides | Not a calibration item; it grows as you work |
| `No closed window with readings yet` | Nothing closed since readings began, or since the last reset | Disappears when a window of this type closes with readings |
| `Within-window spread` | How much the dollars per percent wander inside a window | 2 closed windows of this type, each used to about 11% or more |
| `Between-window spread` | How much the allowance differs from window to window | About 3 windows' worth of information: weight by recency, and by how full each window got |
| `Rounding rule` | Whether the API rounds or truncates the percent | 5 closed windows, of either type, each with 3 or more percent levels |
| `90% range now` | The half-width of the current range | — |
| `Calibrated` / `Calibrating: N of 3 measured` | How many of the three items above are measured | — |

Right after installing or updating, every count is 0 and the status reads "Calibrating: 0
of 3 measured". That is normal.

### How long calibration takes

Typical use means a few hours a day, with windows that reach 20% to 60% before they reset.

| Item | 5-hour window | Week |
|------|---------------|------|
| First closed window | At the next reset | At the next weekly reset |
| Within-window spread | 2 windows that reached about 11%: usually the first day | 2 weeks that reached about 11% |
| Between-window spread | About 4 windows that reached 30% within two days | All four of the last four weeks, each reaching about 30% (see below) |
| Rounding rule | 5 closed windows with 3+ levels: a few days | Comes mostly from the 5-hour windows |

**The week is the slow one.** Readings are kept for 28 days, so at most four closed weeks
are ever on hand, and a past week loses half its weight every 14 days. Those four weeks
together carry just enough information to count as measured. That holds only once the
within-window spread is measured and each of the four weeks reached roughly 30% or more.
Lighter weeks leave the weekly between-window spread assumed, and the week shows
"Calibrating: 2 of 3 measured". A rate-limit rejection (hitting the limit) counts as a full
window and makes up for a light week. When the spread stays assumed, the weekly range is
wider, not wrong.

**The rounding rule may never resolve.** It needs closed windows that agree with one rule
and contradict the other. If the allowance drifts within windows, they can contradict
both, and the rule stays "not known". The cost is small: about ±2.6% extra width at 10%
used and ±0.5% at 50%.

## The setup check

`/usage-dollars check` runs a fresh measurement and reports one line per item: ✓ fine, ✗
needs a fix, ℹ information.

| Item | ✗ means | Fix |
|------|---------|-----|
| Helper | Node.js did not run the transcript scan | Install Node.js 18 or later, put it on `PATH`, restart Claude Code. The other items are skipped until this passes |
| Subscription | The subscription is only guessed, so no readings are recorded | Sign in to Claude Code (`/login`). ℹ "None (an API key)" means there are no limits to estimate |
| Other hooks | A session running older or newer hooks stored a percent since this one started | For older hooks, restart the other sessions; for newer ones, restart this one. Make sure only one copy of the plugin is loaded |
| Price table | Stored readings priced with another table were dropped | Another session runs a different `usage-cost.mjs`: restart it, or remove the second copy. Right after a price update this is expected once |
| Readings | A percent was not recorded and nothing explains it | A bug: report it with the debug log. ℹ lines for unpriced models or a guessed subscription point to their own items |
| Prices | These dollars are far from Claude Code's own costs (median ratio outside 0.9 to 1.1), or more than 2% of a window's requests go to unpriced models | Update `PRICES` in `scripts/usage-cost.mjs`. This drops the stored readings and calibration starts over, so do it only when the check says so |
| Other usage | Always ℹ | A reminder: usage on other computers and on claude.ai is not counted |

## Best practices

**Do:**

- Restart every session after you install or update the plugin. A session on old hooks
  can lose readings, and `check` reports it.
- Keep one copy of the plugin loaded: either the marketplace install or `--plugin-dir` /
  `CLAUDE_CODE_PLUGIN_DIRS`, never both.
- Run `check` once after each update, and whenever calibration counts stall.
- Use `reset` after a plan change the card did not report, or when a promotion starts or
  ends unannounced. `reset undo` takes it back, unless an observed plan or promotion change
  has followed it.
- Update `PRICES` when `check` says a new model is unpriced. Expect calibration to start
  over.

**Avoid:**

- **Using the subscription on another computer or on claude.ai without expecting it to
  show.** That usage raises the percent but not this machine's dollars, so the allowance
  looks smaller and the "inferred change" notice may appear. Nothing breaks, but the
  estimate is off while it lasts.
- **Resetting when nothing changed.** A reset sets aside the closed windows that
  calibrated the estimates (nothing is deleted); calibration starts over from the next
  window.
- **Editing `PRICES` for a small difference.** Each change of the price table drops every
  stored reading.
- **Using the limit as a target.** The mod measures whatever use there is; there is no need
  to fill windows for it.

## When something changes

| Change | What happens | What to do |
|--------|--------------|------------|
| Plugin updated | Old sessions keep the old hooks | Restart every session, run `check` |
| Plan changed, and the card says "Plan changed" | Estimates restart from the change | Nothing |
| Plan changed, the card does not say so | Old windows mislead the estimate | `/usage-dollars reset` |
| Promotion starts or ends | Announced ones restart that window's estimates | `reset` only if the card did not report it |
| New model in use | Its requests are unpriced; above 2% of a window, no readings | Add it to `PRICES` |
| Price table updated | Stored readings are dropped; calibration starts over | Restart sessions running the old helper |
| "Usage no longer matches recent windows" | The prior is set aside for the current window | `reset` only if limits really changed; otherwise it passes |

## Troubleshooting

| Symptom | Likely cause | What to do |
|---------|--------------|------------|
| Status line stays "estimating" after replies | No reading yet, or the window's requests are unpriced | `/usage-dollars`; check the basis line, then `check` |
| Status line says "unavailable" | The helper failed | `check`: the Helper item |
| `calibrate` counts never grow | Readings are lost (old hooks, two copies), or windows close below 10% | `check`; restart sessions |
| Range suddenly much wider | A reset, a plan or promotion change, or a price table change | Expected; it narrows again as windows close |
| Allowance looks far too small | Usage elsewhere on the same subscription | See "Avoid" above; no fix on this machine |
| Week stuck at "2 of 3 measured" | Weeks too light to measure the between-window spread | Expected under light use; the range is wider, not wrong |

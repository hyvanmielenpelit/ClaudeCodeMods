# usage-dollars guide

Everything about usage-dollars in one place: the commands, how the estimates improve, how
to read the card, calibration, the setup check, and what to do when something goes wrong.

> **New here?** The quick start covers what most people need: `/usage-dollars help`.

**Contents**

1. Commands
2. How the estimates improve
3. Reading the card
4. Calibration
5. The setup check
6. Best practices
7. When something changes
8. Troubleshooting

## 1. Commands

| Command | Shows |
|---------|-------|
| `/usage-dollars` | The window card: allowance, used, left, next tick, spending per model |
| `/usage-dollars help` | The quick start |
| `/usage-dollars help advanced` | This guide |
| `/usage-dollars check` | The setup check: ✓, ✗ with the fix, or ℹ per item |
| `/usage-dollars calibrate` | What each window's estimate rests on, and what is still assumed |
| `/usage-dollars models` | How each model counts against the limit relative to its API price, as seen from this machine; a read-only study that changes no window's estimate, and on Max and Ultra sets how Fable's derived row counts Fable |
| `/usage-dollars report` | Spending in the last 24 hours, per day and per model |
| `/usage-dollars <N>h`, `<N>d` | Spending in the last N hours or days, up to 90 days |
| `/usage-dollars today` | Spending since local midnight |
| `/usage-dollars YYYY-MM-DD` | Spending on one local day |
| `/usage-dollars YYYY-MM-DD..YYYY-MM-DD` | Spending over local days, both inclusive |
| `/usage-dollars reset` | Restarts the estimates for this subscription |
| `/usage-dollars reset undo` | Undoes the latest reset |

> **Example:** `/usage-dollars 2026-10-01..2026-10-05` reports spending from the start of
> 1 October to the end of 5 October, in local time.

`/help` lists every command Claude Code knows. Typing `/usage-dollars ` shows the forms
above as a hint after the name.

## 2. How the estimates improve

Two things make the estimates more accurate, and both happen on their own:

| Source | What it is |
|--------|------------|
| **Readings** | After every reply, in any session on the subscription, the percent the limit reports is paired with the dollars spent up to that moment |
| **Closed windows** | When a window resets, its readings show how much its allowance and its dollars per percent varied; they set how wide the next ranges are |

> **Important:** No command measures anything. `calibrate` and `check` only *show* what has
> been measured and what is wrong; running them more often changes nothing.

What does help:

- **Every session runs the current hooks**, from one copy of the plugin. Otherwise
  readings are lost.
- **Each session's subscription is known.** Otherwise no readings are taken.
- **Windows close with some use in them.** A closed window counts once it reached 10%.
  Light use calibrates more slowly, but it does calibrate.

### The first reading

Until an installation has stored a reading, `/usage-dollars` and `/usage-dollars
calibrate` show the **Waiting for the first usage reading** card. A reading comes only with
a reply in the main conversation, so:

- **In a terminal session** you rarely see the card: Claude Code sends a minimal request of
  its own at startup there, and that brings a reading.
- **In the desktop app** a new session has no reading until its first reply. Send any
  message, or press the card's button, **Send a short check message (uses one turn)**.

The button sends one message that says what it is, asks for the single word OK and no
tools, and carries nothing from the session. It costs one turn of the session's model and
adds that message and its reply to the conversation. It is sent only when you press the
button, and it is not offered again until a turn completes. A plugin's own model request
does not bring a reading, which is why nothing is sent automatically.

A sign-in without a subscription (an API key) never gets a reading. The card says so, and
spending reports still work.

## 3. Reading the card

`/usage-dollars` leads with each window's **allowance**: the estimate, its 90% range, and a
confidence label.

| Label | Means |
|-------|-------|
| `good` | The 90% range is within about ±10% |
| `fair` | Within about ±30% |
| `rough` | Wider |
| `· calibrated` | Both spreads and the rounding rule are measured, not assumed |

Below the headline, each window shows:

| Line | Means |
|------|-------|
| **Used** | Dollars spent in the window so far: a fact, not an estimate |
| **Left** | Allowance minus used, with its range |
| **Limit reports 10% · read 2 min ago** | The percent the estimate rests on, and how fresh it is |
| **Next tick** | About how many dollars until the percent moves again; shown while the percent is under 5 minutes old |
| **Basis line** | Percent levels read, or "From past windows only" while the window is still at 0%; which spreads are assumed or measured; and the history weight |

> **Note:** A wide range early in a window is expected, not a fault. It narrows as the
> window fills, and sooner once closed windows have measured the spreads.

Notices at the top of the card:

| Notice | Means | Do |
|--------|-------|----|
| Plan changed: Max → Ultra | The profile reported a new plan; estimates restarted | Nothing |
| Usage no longer matches recent windows | Limits changed, or the subscription was used where this machine cannot see | `reset` only if you know the limits changed |
| Fable has likely reached its weekly cap | Fable's derived use reached half of the week's allowance; further Fable requests bill usage credits or switch models, and while they bill credits the estimates run high | Nothing, or switch models |
| This week: the reported percent fell, as after a limit reset | Usage was given back inside the window; later readings of it are not recorded, and what is left follows the reported percent | Nothing |

### Fable this week

On Max and Ultra the card adds a **derived** row after the week: Fable models (Fable and
Mythos) may use up to half of the weekly limit at no extra cost, and Claude Code reports no
Fable percent. The row shows Fable's dollars this week, its half of the weekly allowance in
Fable's own dollars, what is left of it (never more than the week has left), and "N% of
Fable's half used". It is never the headline. Settings > Usage on claude.ai shows
Anthropic's own Fable figure.

The half is counted as the limit counts usage, in meter units, so the row depends on how
Fable counts against the limit relative to the other models. Its basis line says where
that weight comes from:

| Basis line | Means |
|------------|-------|
| Fable assumed to count at its API price ratio: not measured yet | No fit holds a Fable group yet: a fresh install, too few windows, or no Fable use in them |
| The model study found that the API price ratio holds | The 5-hour study selected the API ratio (M0); the half is half the weekly allowance in API dollars |
| The weekly fit (N weeks) found that the API price ratio holds | The same, from the weekly-only fit, the source on a subscription without 5-hour windows |
| with Fable counted at ×0.82 (0.70–0.95) relative to Opus 5.5 | Fable's weight against the reference group, with its 90% interval; the range of the row counts that interval |
| Fable 5.2 is the model the others are measured against | Fable is the reference group: its weight is 1 by definition, and the others' weights convert the week |
| Counted since the reported percent fell | A limit reset gave the week's Fable use back; Fable is counted from it |

## 4. Calibration

`/usage-dollars calibrate` lists the facts behind each window's estimate. Right after
installing, every count is 0:

```
5-hour window                                  Calibrating: 0 of 3 measured
This window: 4 percent levels read, 3 ticks seen
No closed window with readings yet
Within-window spread: assumed; 0 closed windows with a tick, 2 needed
Between-window spread: assumed; 0 past windows (rejections included), history weight 0
Rounding rule: not known; 0 of 5 closed windows needed
90% range now: ±86%
```

Three items are measured from closed windows:

| Item | Describes | Measured once |
|------|-----------|---------------|
| **Within-window spread** | How much the dollars per percent wander inside a window | 2 closed windows of this type reached about 11% |
| **Between-window spread** | How much the allowance differs between windows | About 3 windows' worth of information, weighted by recency and by how full each got |
| **Rounding rule** | Whether the API rounds or truncates the percent | 5 closed windows of either type, each with 3 or more percent levels |

### How long it takes

With a few hours of use a day, and windows reaching 20% to 60%:

| | 5-hour window | Week |
|-|---------------|------|
| **First closed window** | At the next reset | At the next weekly reset |
| **Within-window spread** | Usually the first day | 2 weeks |
| **Between-window spread** | About 4 windows at 30% or more, within two days | Usually four to six weeks at about 30% or more |
| **Rounding rule** | A few days | Comes from the 5-hour windows; on Ultra, from the weeks, after five closed weeks |

> **Important: the week is slow.** Weekly readings are kept for 12 weeks, but past weeks
> lose half their weight every 14 days, so the weekly between-window spread counts as
> measured only after about four to six weeks that reached about 30%. Lighter weeks leave
> it assumed, and the week stays at "2 of 3 measured". A rate-limit rejection counts as a
> full week. An assumed spread makes the range wider, not wrong.

> **Note: Ultra has no 5-hour window.** A verified Ultra account reports only the week, so
> calibration runs on weeks alone, and the rounding rule waits for five closed weeks.

> **Note: windows at Fable's cap are left out.** On Max and Ultra, a closed week in which
> Fable reached 95% of its cap, and a closed 5-hour window with Fable dollars that ended
> after that moment, do not calibrate: usage credits billed past the cap move neither
> percent. Calibration lists them as "closed windows left out: Fable at or past its weekly
> cap". The test cannot see credits, so a week in which you reached the cap and then
> switched models is left out too.

> **Note: the rounding rule may never resolve.** When the allowance drifts within windows,
> closed windows can contradict both rules. The cost is small: about ±2.6% extra width at
> 10% used, and ±0.5% at 50%.

### The model study

`/usage-dollars models` fits each model's weight against the limit on closed 5-hour
windows. On a verified Ultra account, which reports no 5-hour limit, it says "Not fitted:
this subscription reports no 5-hour limit, and the study fits on 5-hour windows"; the
weekly-only fit beside it appears from four closed weeks, and is then what Fable's row
uses. Windows at or past Fable's weekly cap are left out of the study as they are of
calibration: under Data as a reason for the 5-hour windows, and under Weeks as "N left
out: Fable at or past its weekly cap".

## 5. The setup check

`/usage-dollars check` measures afresh and reports one line per item: **✓** fine, **✗**
needs a fix, **ℹ** information.

```
✓  Helper        Node.js runs the transcript scan.
✓  Subscription  Named by the signed-in profile.
✗  Other hooks   A session running older hooks stored a percent since this one started.
                 Restart the other sessions, and load only one copy of the plugin.
```

| Item | ✗ means | Fix |
|------|---------|-----|
| **Helper** | Node.js did not run the transcript scan | Install Node.js 18 or later on `PATH`, restart Claude Code |
| **Subscription** | The subscription is only guessed; no readings are recorded | Sign in with `/login` |
| **Other hooks** | A session with older or newer hooks stored a percent | Older: restart the other sessions. Newer: restart this one. Load one copy only |
| **Price table** | Readings priced with another table were dropped | Restart sessions running another copy; expected once after a price update |
| **Readings** | A percent was lost and nothing explains it | A bug: report it with the debug log |
| **Model breakdown** | Stored windows whose dollars per model and token class could not be rebuilt from the transcripts, or do not add up; as ℹ, how many windows carry them and how many wait for the backfill | Not rebuilt: nothing, those windows are left out of the model study only. Not adding up: a bug, report it with the debug log |
| **Prices** | Dollars far from Claude Code's own costs, or a model is unpriced | Update `PRICES` in `scripts/usage-cost.mjs` |
| **Limits not measured** | Always ℹ: rate limits of a kind this mod does not measure, live or in the transcripts, limits billed to overage, and requests that carry a fallback credit; usually "none" | Nothing; report it if a new kind appears |
| **Other usage** | Always ℹ: other computers and claude.ai are not counted | Nothing |

> **Tip:** Run `check` after every plugin update, and whenever the calibration counts stop
> growing.

> **Note:** Changing `PRICES` drops every stored reading, and calibration starts over. Do
> it only when `check` asks for it.

## 6. Best practices

**Do**

- **Restart every session after installing or updating.** A session keeps the hooks it
  started with, and old hooks can lose readings.
- **Keep one copy of the plugin loaded**: the marketplace install *or* `--plugin-dir` /
  `CLAUDE_CODE_PLUGIN_DIRS`, never both.
- **Reset after an unannounced plan or promotion change.** `reset undo` takes it back,
  unless an observed plan or promotion change has followed.
- **Add new models to `PRICES`** when `check` reports them unpriced.

**Avoid**

- **Resetting when nothing changed.** A reset sets aside the closed windows behind the
  calibration; nothing is deleted, but calibration starts over.
- **Expecting usage elsewhere to show.** Other computers and claude.ai raise the percent
  but not this machine's dollars, so the allowance looks smaller and the "Usage no longer
  matches" notice may appear.
- **Editing `PRICES` for small differences.** Every change drops the stored readings.
- **Aiming at the limit.** The mod measures whatever use there is.

## 7. When something changes

| Change | What happens | Do |
|--------|--------------|----|
| Plugin updated | Running sessions keep the old hooks | Restart every session, run `check` |
| Plan changed, card says so | Estimates restart from the change | Nothing |
| Plan changed, card silent | Old windows mislead the estimate | `/usage-dollars reset` |
| Limit reset used | The card says the reported percent fell; that window records nothing more, and what is left follows the percent | Nothing |
| Promotion starts or ends | An announced one restarts that window | `reset` only if the card was silent |
| New model in use | Its requests are unpriced; above 2% of a window, no readings | Add it to `PRICES` |
| Price table updated | Stored readings are dropped; calibration starts over | Restart sessions on the old helper |

## 8. Troubleshooting

| Symptom | Likely cause | Do |
|---------|--------------|----|
| "Waiting for the first usage reading" | No reply in this session yet, and none stored | Send any message, or press the card's button |
| Status line stays at "used", with nothing left shown | No reading yet, the window is still at 0% with no closed windows behind it, or unpriced models | `/usage-dollars`, read the basis line, then `check` |
| Status line says "unavailable" | The helper failed | `check`: the Helper item |
| Calibration counts never grow | Lost readings, or windows closing below 10% | `check`, then restart sessions |
| Range suddenly much wider | A reset, plan, promotion or price table change | Nothing: it narrows again |
| Allowance looks far too small | Usage elsewhere on the subscription | Nothing on this machine |
| Week stuck at "2 of 3 measured" | Weeks too light for the between-window spread | Nothing: wider, not wrong |

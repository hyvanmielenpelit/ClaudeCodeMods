# Claude Code Mods

Mods for [Claude Code](https://claude.com/claude-code) by Hyvän Mielen Pelit, written as
function-hook plugins. The repository is also a plugin marketplace.

| Mod | What it does |
|---|---|
| [usage-dollars](usage-dollars) | Subscription usage for the 5-hour window and the week as API-equivalent dollars: used, left and allowance, with 90% ranges. |

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

Shows on the status line:

```
5h: $32.32 used · ~$68 left  │  Week: $34.21 used · ~$2.9k left
```

`/usage-dollars` draws a card with used, left and allowance for each window, the 90% range of
each estimate, a bar of used dollars against the allowance range, and spending per model.

### How the figures are made

- **Used** prices every request in this machine's transcripts since the window began at
  API list rates: input, output, cache reads, 5-minute and 1-hour cache writes, fast mode
  and web searches. Only requests billed to the subscription the session runs on count,
  matched through the `bridge-session` records the desktop app writes. Checked against
  Claude Code's own per-session costs it usually comes within a few percent, and up to a
  quarter low on long sessions, because some billed calls never reach a transcript.
- **Allowance** and **left** come from the limit's own reading. The API reports the
  window's usage in whole percent, so each reading pins the allowance between two
  bounds: `used / (p + 1)%` and `used / (p - 0.5)%`. The mod keeps the readings of every
  window and intersects them, so the bounds narrow each time the percent ticks over.
- **The 90% range** widens those bounds by how far API prices may differ from the
  limit's own weighting of tokens: the spread of past windows' allowances when at least
  three are known, otherwise an assumed 10%. Past windows also act as a prior. They come
  from the mod's own readings of closed windows and from rate-limit rejections in the
  last 14 days of transcripts, each a window seen exactly full.

Early in a window the range is wide: at 1% of the week used, the allowance is only known
to within about a factor of four. It narrows as the window fills.

### Limits

- Usage from other machines on the same subscription is not counted.
- Model prices live in [`scripts/usage-cost.mjs`](usage-dollars/scripts/usage-cost.mjs).
  A model missing there is reported as unpriced, never guessed; add new models as they
  ship.
- Requires Node.js on `PATH`; the transcript scan runs as a child process.
- Without a subscription (an API key), there are no limits to read and no estimates.

### Files

| Path | Role |
|---|---|
| `.claude-plugin/plugin.json` | Manifest |
| `hooks/register.tsx` | Hooks: status line, `/usage-dollars`, the card |
| `hooks/estimate.ts` | Allowance estimate and its 90% range |
| `scripts/usage-cost.mjs` | Transcript scan and pricing (Node) |
| `types/index.d.ts` | Type contract for the mod's session state |

`node usage-dollars/scripts/usage-cost.mjs --check` sets each session's computed cost
beside the cost Claude Code recorded for it.

# usage-dollars quick start

See how many **API-equivalent dollars** your subscription's 5-hour window and week allow,
and how much is left, right on the status line:

```
5h ~$850 left of $913 · Week ~$2.7k left of $2.8k
```

## Set up once

1. **Load one copy of the plugin.** Install it from the marketplace *or* load it with
   `--plugin-dir`, never both.
2. **Restart every Claude Code session**, in the desktop app and in terminals.
3. **Run the setup check** and fix anything marked ✗:

```
/usage-dollars check
```

That is all. Readings are taken automatically after every reply.

## Everyday commands

| To | Run |
|----|-----|
| See what is left | The status line, or `/usage-dollars` for the full card |
| See your spending | `/usage-dollars 24h`, `7d`, `today`, or a date like `2026-10-01` |
| See what has been measured | `/usage-dollars calibrate` |
| Check the setup | `/usage-dollars check` |

> **Note:** Ranges start wide and narrow on their own as windows fill and reset: within a
> day or two for the 5-hour window, over about four weeks for the week. You do not need to
> run anything for that.

## Good habits

**Do**

- **Restart all sessions after updating the plugin**, then run `/usage-dollars check`.
- **Run `/usage-dollars reset` after a plan change** the card did not announce.

**Avoid**

- **Resetting for any other reason.** It sets calibration back to zero.
- **Expecting usage elsewhere to show.** Other computers and claude.ai are not counted, so
  the allowance looks smaller while they are in use.

> **Tip:** `/usage-dollars help advanced` opens the full guide: every command, reading the
> card, calibration, the setup check, and troubleshooting.

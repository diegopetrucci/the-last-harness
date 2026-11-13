---
name: herdr-gui-app
description: "Drive the Herdr desktop app (herdr-app) and its terminal core (hc): spaces, tabs, panes, terminals, layouts, keys, programs and mods. Use only when the user explicitly mentions the Herdr GUI/desktop app, Herdr.app, herdr-app or hc. For the Herdr terminal multiplexer (`herdr` CLI, HERDR_ENV=1) use the herdr-tui skill instead."
---

# Herdr desktop app

Herdr.app ships its own version-matched agent manuals. Load the one you need and follow it:

- Changing what the user sees (spaces, tabs, panes, focus): run `herdr-app --skill`.
- Running, reading, messaging or waiting on terminals and agents: run `hc --skill`.
- Customising layouts, keys, settings, programs or mods: read `${HERDR_APP_HOME:-~/.config/herdr-app}/AGENTS.md` first.

If `herdr-app` or `hc` is not on `PATH`, say so and stop. Never run bare `herdr-app` (it opens the window) or bare `hc` (it opens an interactive picker).

## TLH rules (these override the manuals)

- Delegation stays with the TLH `subagent` tool. Start agents through `hc run` only when the user explicitly asks to run or watch one in Herdr.
- TLH's installer writes `programs.tlh` in `programs.json`, and `tlh update` rewrites it. Don't edit it; add a separate entry for a variant.
- `hc ls` shows all of the user's terminals. Read only the terminals the task needs.
- Before installing a third-party layout or mod, tell the user what it can do (network access, running programs, reading files outside its folder) and get their agreement.

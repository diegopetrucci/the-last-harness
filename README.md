# The last harness you'll ever need.

`tlh` (the last harness) is a highly opinionated — albeit still simple — version of [pi](https://github.com/earendil-works/pi). Think of it, if you wish, as the macOS of harnesses. No bloat, no BS, but a strong direction.

Install one-liner:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | TLH_UPDATE_TRACK=latest-release bash -s --
```

## Core features

- **Context discipline.** The context-cap extension helps keep long sessions under control.
- **Project memory by default.** Gnosis integration is enabled by default on supported platforms so agents can record decisions, constraints, rejected alternatives, and lessons in repo-local memory unless you opt out.
- **Safety rails for agent work.** Bundled permission and destructive-action confirmations add checkpoints before sensitive commands or file changes.
- **Cleaner sessions.** An update-aware startup header, new-release launch warnings, custom footer, contextual steering/follow-up key hints, quieter tool output, completion notifications, and `/tlh` status keep the UI focused without hiding model-visible results.
- **Reasoning controls.** Use `/effort` to quickly change model thinking level from the TUI or command line.
- **Fast-mode controls.** The bundled OpenAI Fast extension adds `/fast` commands for eligible ChatGPT-auth GPT-5.4/GPT-5.5 sessions while defaulting Fast mode off.
- **Second opinions built in.** The Oracle extension can consult a separate read-only reasoning process for deeper review, debugging, and planning.
- **Repository research.** The Librarian extension can scout GitHub repositories and optionally cache local checkouts.
- **Opinionated defaults, conservative updates.** TLH installs a curated theme, prompt guidance, commands, and default extensions while preserving your custom settings and opt-outs across updates.
- **Isolated Pi profile.** `tlh` runs upstream `pi` with its own profile at `~/.the-last-harness/agent`, leaving your normal `~/.pi/agent` config untouched.

## Custom commands

The following slash commands are available in interactive `tlh` sessions:

- `/gnosis [status|enable|disable|toggle]` — toggle or inspect Gnosis prompt integration. With no argument, `/gnosis` toggles it.
- `/effort [off|minimal|low|medium|high|xhigh]` — pick or set model reasoning effort. Available levels depend on the current model; run `/effort` without an argument for the picker.
- `/fast on|off|auto|toggle|status` — manage OpenAI Fast mode for eligible ChatGPT-auth GPT-5.4/GPT-5.5 sessions.
- `/context [--no-open] [--keep] [--redact] [--full|--current]` — generate a local HTML breakdown of where the session context is going.

### Included Pi resources

- `extensions/the-last-harness.ts` adds the custom `tlh` startup header and footer, lightweight default guidance, conditional Gnosis prompt instructions, `/tlh` status, `/gnosis` toggle/status, `/agent` status, `/effort` reasoning-effort picker commands, the 200k-token `DUMB ZONE` footer warning, and the default `architect` primary-agent persona.
- `agents/primary/architect.md` defines the main-session architect prompt.
- `agents/subagents/*.md` defines TLH minor agents exposed through the bundled `pi-subagents` fork.
- `skills/harness-setup/SKILL.md` documents safe setup/update/uninstall workflows.
- `prompts/harness-plan.md` provides `/harness-plan` for reviewable implementation planning.
- `themes/the-last-harness.json` provides the default isolated theme.

TLH does not switch your saved model or reasoning-effort defaults on startup. If you explicitly want the primary-agent prompt metadata to apply them, set `tlh.primaryAgent.applyModel` and/or `tlh.primaryAgent.applyThinking` to `true` in the isolated settings file.

## Bundled extensions

The installer enables these standalone external Pi packages by default in the isolated `tlh` profile:

- [`npm:@diegopetrucci/pi-permission-gate`](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/permission-gate) — asks for confirmation before sensitive tool calls.
- [`npm:@diegopetrucci/pi-oracle`](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/oracle) — consults a separate read-only reasoning process for second opinions.
- [`npm:@plannotator/pi-extension`](https://github.com/backnotprop/plannotator/tree/main/apps/pi-extension) — adds interactive plan review with annotations.
- [`npm:@diegopetrucci/pi-openai-fast`](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/openai-fast) — adds optional `/fast` commands for eligible ChatGPT-auth GPT-5.4/GPT-5.5 sessions.
- [`npm:@diegopetrucci/pi-librarian`](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/librarian) — scouts GitHub repositories and optionally caches local checkouts.
- [`npm:@ff-labs/pi-fff`](https://github.com/dmtrKovalenko/fff.nvim/tree/main/packages/pi-fff) — adds FFF-powered fuzzy file and content search.
- [`npm:@diegopetrucci/pi-inline-bash`](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/inline-bash) — expands inline bash commands in user prompts.
- [`npm:@diegopetrucci/pi-notify`](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/notify) — sends a notification when an agent turn finishes.
- [`npm:@diegopetrucci/pi-context-cap`](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/context-cap) — keeps context usage under a configured cap.
- [`npm:@diegopetrucci/pi-context-inspector`](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/context-inspector) — opens a local HTML dashboard showing where session context is going.
- [`npm:@diegopetrucci/pi-quiet-tools`](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/quiet-tools) — compacts collapsed built-in tool output without changing model-visible results.
- [`npm:@diegopetrucci/pi-confirm-destructive`](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/confirm-destructive) — confirms destructive shell and file operations before they run.
- [`npm:@diegopetrucci/pi-dirty-repo-guard`](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/dirty-repo-guard) — prompts before session changes when the current git repo has uncommitted changes.
- [`git:github.com/diegopetrucci/pi-subagents@tlh-v0.24.2-5`](https://github.com/diegopetrucci/pi-subagents) — delegates work to isolated TLH-profile subagents.
- [`git:github.com/diegopetrucci/pi-intercom@tlh-v0.6.0-1`](https://github.com/diegopetrucci/pi-intercom) — allows child subagents to escalate questions to the supervising session.

Manage persistent opt-outs after install:

```sh
tlh defaults list
tlh defaults disable notify
tlh defaults enable notify
```

Opt-outs are written to `~/.the-last-harness/agent/settings.json` and survive `tlh update`, `pi update --extensions`, and installer reruns. Installer settings merges preserve existing same-identity package sources by default; use installer `--force` only when you want bundled default-extension source migrations to rewrite existing entries.

### Gnosis integration

[Gnosis](https://github.com/skorokithakis/gnosis) is a small `gn` CLI for recording project decisions, constraints, rejected alternatives, and lessons that are not obvious from code alone. On supported platforms, TLH installs and enables it by default because `tlh` works better when agents can consult and update that project memory.

Opt out during install or update with `--without-gnosis` / `--no-gnosis`, or disable it later with `tlh gnosis disable` or `/gnosis` inside an interactive session. For pipe-to-bash installs, pass installer flags after `bash -s --`:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | TLH_UPDATE_TRACK=latest-release bash -s -- --without-gnosis
```

The opt-out is written to `~/.the-last-harness/agent/settings.json` and survives `tlh update`; use `tlh update --with-gnosis` to install/re-enable it automatically, or install `gn` manually and run `tlh gnosis enable` or `/gnosis`.

If enabled and a valid Gnosis `gn` binary is present, TLH appends these instructions to the system prompt:

```text
At the start of any task, run `gn help plan` and follow its instructions.
After finishing a task, run `gn help review`.
```

Manage the integration after install:

```sh
tlh gnosis status
tlh gnosis enable
tlh gnosis disable
```

Inside an interactive `tlh` session, use `/gnosis` to toggle the integration or `/gnosis status` to inspect it. Disabling Gnosis stops TLH from adding the prompt instructions; it does not delete existing repo-local memory or any managed `gn` binary. Gnosis project data lives in repo-local `.gnosis` directories.

### Launch telemetry

Release builds with TelemetryDeck identifiers configured send at most one pseudonymous launch event when an interactive `tlh` process starts. The event contains a hashed random install ID, event type, TLH version, privacy-filtered model value, OS name/version, and OS architecture. It does not include prompts, cwd, command arguments, repo names, hostname, username, file contents, settings contents, full environment variables, extension/package lists, API keys, provider base URLs, auth state, headers, or account identifiers. TelemetryDeck also receives normal network metadata such as source IP address and request time.

Opt out persistently by adding this to `~/.the-last-harness/agent/settings.json`:

```json
{
  "tlh": {
    "telemetry": {
      "enabled": false
    }
  }
}
```

That settings opt-out is preserved by `tlh update` and installer reruns.

## Install, update, and uninstall

Install, update, and uninstall guidance lives in [`docs/install.md`](docs/install.md).

## Local development

Local testing and development commands live in [`docs/local-development.md`](docs/local-development.md).

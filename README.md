# The last harness you'll ever need.

[![CI](https://github.com/diegopetrucci/the-last-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/diegopetrucci/the-last-harness/actions/workflows/ci.yml)

`tlh` (the last harness) is a highly opinionated — albeit still simple — version of [pi](https://github.com/earendil-works/pi). No bloat, no BS, but a strong direction.

`tlh` is modelled after two core principles:
- _"you can outsource your thinking, but not your understanding"_: LLMs can, and should provide options, help out with discovery and exploration, filling the gaps in your understanding and technical knowledge — they should not, however, be used as a replacement for understanding. [Beware of cognitive debt](https://simonwillison.net/2026/Feb/15/cognitive-debt/).
- you should not be babysitting your agents: if you need to manually call tools, run commands, and so on, the harness has failed you.

If this resonates with you, welcome aboard:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | bash -s --
```

## Core features

A TLH primary agent is the role you talk to directly in the main session. The default primary is the **architect**, inspired by the architect-first workflow outlined in ["How I write software with LLMs"](https://www.stavros.io/posts/how-i-write-software-with-llms/): refine requirements and scope, understand codebase implications, turn approved plans into tickets, delegate implementation, request review, and report back when the work is done.

TLH also includes a **product** primary agent for product strategy and decision support. It clarifies goals, frames tradeoffs, maintains product strategy docs, and shapes implementation-ready `tk` tickets for later architect/developer handoff. Product mode does not implement source changes, run implementation loops, or perform code review.

TLH also includes a **bug-hunter** primary agent for read-only investigation and debugging. It analyzes bug reports, traces root causes, surveys the codebase for related patterns, and proposes candidate fixes — without modifying files, running destructive tools, or kicking off implementation loops. Bug-hunter is a peer to the architect and product primaries: useful when you want to understand a problem before handing off to a write-capable primary.

Primary agents are optional. Use `Shift+Tab` to cycle the current session through `architect` → `product` → `bug-hunter` → `disabled`, or use `/agent` for explicit session and persistent-default controls. When primary agents are disabled, subagents remain available but TLH stops applying primary-agent persona/tool restrictions.

### Subagents

TLH subagents are focused child sessions used by the architect workflow: `repo-scout` for discovery, `developer` for implementation, `code-reviewer` for review, `diff-summarizer` for local diff orientation, and `librarian`/`oracle` for external research and second opinions.

They run in fresh child contexts: they get the task and project context, not the whole primary-agent conversation. They do not coordinate with each other as a swarm; they report back to the parent primary agent, which stays responsible for decisions and orchestration. Today they inherit your active model and effort unless configured otherwise; future TLH versions may give different roles their own model and thinking defaults.

## Quality-of-life improvements to `pi`

- **Project memory**: Gnosis is required and installed automatically on supported platforms (linux/darwin × x64/arm64) so agents can record decisions, constraints, rejected alternatives, and lessons in repo-local memory. Unsupported platforms hard-fail at install.
- **Ticketed execution**: TLH requires `tk` for dependency-tracked tickets, installing a managed command at `~/.the-last-harness/agent/bin/tk` when it needs to supply one. The architect hands one ticket at a time to implementation and review agents; product mode can shape product-approved tickets for later handoff.
- **Context management**: context is capped to 200k tokens to avoid the `dumb zone`, and `/context` lets you see what is eating up your context.
- **Subscription usage footer**: OAuth subscription sessions on OpenAI/Codex and Anthropic show the current usage window in the footer; weekly usage is hidden by default and controlled with `/usage`.
- **Safety rails**: Bundled permission and destructive-action confirmations add checkpoints before sensitive commands or file changes.
- **Inline bash snippets**: trusted `!{...}` snippets in your prompt are expanded through local bash before the agent sees them, useful for quick context like `!{git status --short}`.
- **Dirty-repo guard**: TLH prompts before starting, switching, or forking sessions when the current git repo has uncommitted changes, so work-in-progress is harder to lose.
- **Completion notifications**: TLH can notify you when an agent turn finishes and is waiting for input.
- **Model niceties**: `/effort` makes it easier to switch thinking effort levels, `/fast` enables OpenAI Fast mode controls, and bundled Anthropic OAuth compatibility helps `/login anthropic` work with Claude Pro/Max subscriptions.
- **Cleaner sessions**: tlh's UI only shows what is relevant to you _right now_ — tools, bash output, and incoming intercom cards are collapsed by default; footer details are trimmed.
- **Conservative updates and isolation**: tlh runs independently from `pi`, and never overrides your settings across updates

## Slash commands

Common TLH commands:

- `Shift+Tab` — cycle the current session through `architect` → `product` → `bug-hunter` → `disabled` primary-agent modes.
- `/tlh` / `/harness` — show TLH package, primary-agent, override, and settings status.
- `/agent [status|architect|product|bug-hunter|disabled|reset|default architect|default product|default bug-hunter|default disabled|default reset]` — inspect the active primary, set/reset the session override, or write/reset the persistent default.
- `/architect [status|on|off|toggle|reset|default on|default off|default reset]` — compatibility controls for architect-only flows; maps to architect/disabled primary-agent settings.
- `/effort ...` — pick or set model reasoning effort. Available levels depend on the current model.
- `/fast [on|off|auto|toggle|status]` — manage OpenAI Fast mode for eligible ChatGPT-auth GPT-5.4/GPT-5.5 sessions.
- `/usage [status|weekly on|weekly off|weekly toggle]` — inspect or change whether the footer shows weekly subscription usage.
- `/context [--no-open] [--keep] [--redact] [--full|--current]` — generate a local HTML breakdown of where the session context is going.
- `/harness-plan` — open the bundled implementation-planning prompt.

Persistent primary-agent changes are written under `tlh.primaryAgent` in the isolated TLH settings file at `~/.the-last-harness/agent/settings.json`, with a backup when an existing settings file is changed. Use `/agent default reset` or `/architect default reset` to remove those persistent fields and return future sessions to the built-in `architect` default. Use `/agent reset` or `/architect reset` for the current session only.

`/usage weekly on|off|toggle` writes the weekly footer preference under `tlh.usageLimits.showWeekly` in the same isolated settings file; the default is hidden when unset.

The subscription usage footer fetches usage with the OAuth bearer your session already uses from two undocumented vendor endpoints:

- `https://chatgpt.com/backend-api/wham/usage` for `openai-codex` sessions.
- `https://api.anthropic.com/api/oauth/usage` for `anthropic` OAuth sessions (currently requires the `oauth-2025-04-20` beta flag).

These are unsupported, internal endpoints and may change or be revoked without notice. No additional credentials are introduced — TLH reuses the same OAuth bearer the session already holds. When these fetches fail, TLH silently hides the footer segment. The feature is active only for `openai-codex` and `anthropic` OAuth subscription sessions and is on by default; an explicit disable mechanism is out of scope for this release.

Bundled extension commands are also available for power users: /context-cap, /quiet-tools, /librarian-cache, /oracle-model, /fff-health, /fff-rescan, /fff-mode, /triage-comments, /intercom, /run, /parallel, /chain, /run-chain, /subagents-doctor, and Plannotator commands such as /plannotator-review and /plannotator-annotate.

Manage persistent opt-outs for non-critical defaults after install:

```sh
tlh defaults list
tlh defaults disable notify
tlh defaults enable notify
```

Opt-outs are written to `~/.the-last-harness/agent/settings.json` and survive `tlh update`, `pi update --extensions`, and installer reruns. Installer settings merges preserve existing same-identity package sources by default; use installer `--force` only when you want bundled default-extension source migrations to rewrite existing entries. The isolation-critical subagents/intercom defaults are protected: `tlh defaults disable` rejects `subagents`, `intercom`, and their legacy aliases; stale manual entries in `tlh.disabledDefaultExtensions` are ignored during source resolution and cleaned during settings merges. Old `pi-subagents`/`pi-intercom` replacements are migrated to the bundled TLH forks so architect delegation uses the isolated minor-agent prompts. Installer runs fail if these critical bundled packages cannot be installed or refreshed; fix the package install/checkout and rerun the installer rather than trying to disable them.

### Integrations

[Gnosis](https://github.com/skorokithakis/gnosis) is a small `gn` CLI for recording project decisions, constraints, rejected alternatives, and lessons that are not obvious from code alone. TLH requires and installs Gnosis automatically on supported platforms: **linux and darwin on x64 and arm64**. Installs on unsupported platforms hard-fail.

TLH also requires the `tk` ticket CLI for architect/product ticket workflows. If no valid configured or existing `tk` command is found, install and update flows install the pinned managed copy at `~/.the-last-harness/agent/bin/tk`.

When a valid `gn` binary is present, TLH appends these instructions to the system prompt:

```text
At the start of any task, run `gn help plan` and follow its instructions.
After finishing a task, run `gn help review`.
```

Gnosis project data lives in repo-local `.gnosis` directories and ticket data lives in repo-local `.tickets` directories; TLH does not delete either. More integration details live in [`docs/integrations.md`](docs/integrations.md).

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

The release `install.sh` is a small stage-0 Bash bootstrapper: it finds or fetches the matching stage-1 Node helper (`scripts/tlh-install.mjs`) and support files, then stage-1 performs the isolated profile install.

Install, update, and uninstall guidance lives in [`docs/install.md`](docs/install.md).

## Local development

Local testing and development commands live in [`docs/local-development.md`](docs/local-development.md).

## Prerequisites

Node.js >=22.19.0 must be available on your `PATH`.

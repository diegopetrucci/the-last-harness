# The last harness you'll ever need.

`tlh` (the last harness) is a highly opinionated — albeit still simple — version of [pi](https://github.com/earendil-works/pi). No bloat, no BS, but a strong direction.

`tlh` is modelled after two core principles:
- _"you can outsource your thinking, but not your understanding"_: LLMs can, and should provide options, help out with discovery and exploration, filling the gaps in your understanding and technical knowledge — they should not, however, be used as a replacement for understanding. [Beware of cognitive debt](https://simonwillison.net/2026/Feb/15/cognitive-debt/).
- you should not be babysitting your agents: if you need to manually call tools, run commands, and so on, the harness has failed you.

If this reasonates with you, welcome aboard:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | TLH_UPDATE_TRACK=latest-release bash -s --
```

## Core features

TLH is inspired by the architect-first workflow outlined in ["How I write software with LLMs"](https://www.stavros.io/posts/how-i-write-software-with-llms/).

The gist:
- Talk to the architect first, let it help you refine the requirements and scope, understand the codebase and implications, going back and forth as needed to nail the task
- Once ready, approve the plan and the implementation tickets
- The architect will then take it from there: implementation is handed off to a developer subagent, the code automatically reviewed, and you will be pinged once everything is done

Note: this workflow is optional. Disable it for the current session with `Shift+Tab`, or for all future ones with `/architect default off`. All subagents remain available when the architect persona is off.

### Subagents

TLH subagents are focused child sessions the architect delegates to: `repo-scout` for discovery, `developer` for implementation, `code-reviewer` for review, `diff-summarizer` for local diff orientation, `bug-hunter`/`bug-catcher` for bug investigation, and `librarian`/`oracle` for external research and second opinions.

They run in fresh child contexts: they get the task and project context, not the whole architect conversation. They do not coordinate with each other as a swarm; they report back to the architect, which stays responsible for decisions and orchestration. Today they inherit your active model and effort unless configured otherwise; future TLH versions may give different roles their own model and thinking defaults.

## Quality-of-life improvements to `pi`

- **Project memory**: Gnosis integration is enabled by default on supported platforms so agents can record decisions, constraints, rejected alternatives, and lessons in repo-local memory (unless you opt out).
- **Ticketed execution**: when `tk` is available, the architect turns the approved plan into dependency-tracked tickets and hands one ticket at a time to implementation and review agents. Without `tk`, TLH keeps the same small task tree in the conversation.
- **Context management**: context is capped to 200k tokens to avoid the `dumb zone`, and `/context` lets you see what is eating up your context.
- **Safety rails**: Bundled permission and destructive-action confirmations add checkpoints before sensitive commands or file changes.
- **Inline bash snippets**: trusted `!{...}` snippets in your prompt are expanded through local bash before the agent sees them, useful for quick context like `!{git status --short}`.
- **Dirty-repo guard**: TLH prompts before starting, switching, or forking sessions when the current git repo has uncommitted changes, so work-in-progress is harder to lose.
- **Completion notifications**: TLH can notify you when an agent turn finishes and is waiting for input.
- **Model niceties**: `/effort` makes it easier to switch thinking effort levels, and `/fast` enables OpenAI Fast mode controls.
- **Cleaner sessions**: tlh's UI only shows what is relevant to you _right now_ — tools and bash output is collapsed by default, the information in the footer is trimmed.
- **Conservative updates and isolation**: tlh runs independently from `pi`, and never overrides your settings across updates

## Slash commands

Common TLH commands:

- `Shift+Tab` — disable or re-enable the architect persona for the current session.
- `/tlh` / `/harness` — show TLH package, primary-agent, override, and settings status.
- `/agent` — show the active TLH primary agent.
- `/architect [status|on|off|toggle|reset|default on|default off|default reset]` — inspect or change architect mode for this session or future sessions.
- `/effort ...` — pick or set model reasoning effort. Available levels depend on the current model.
- `/gnosis [status|enable|disable|toggle]` — toggle or inspect Gnosis prompt integration.
- `/fast [on|off|auto|toggle|status]` — manage OpenAI Fast mode for eligible ChatGPT-auth GPT-5.4/GPT-5.5 sessions.
- `/context [--no-open] [--keep] [--redact] [--full|--current]` — generate a local HTML breakdown of where the session context is going.
- `/harness-plan` — open the bundled implementation-planning prompt.

Bundled extension commands are also available for power users: /context-cap, /quiet-tools, /librarian-cache, /oracle-model, /fff-health, /fff-rescan, /fff-mode, /intercom, /run, /parallel, /chain, /run-chain, /subagents-doctor, and Plannotator commands such as /plannotator-review and /plannotator-annotate.

Manage persistent opt-outs for non-critical defaults after install:

```sh
tlh defaults list
tlh defaults disable notify
tlh defaults enable notify
```

Opt-outs are written to `~/.the-last-harness/agent/settings.json` and survive `tlh update`, `pi update --extensions`, and installer reruns. Installer settings merges preserve existing same-identity package sources by default; use installer `--force` only when you want bundled default-extension source migrations to rewrite existing entries. The isolation-critical subagents/intercom defaults are protected: `tlh defaults disable` rejects `subagents`, `intercom`, and their legacy aliases; stale manual entries in `tlh.disabledDefaultExtensions` are ignored during source resolution and cleaned during settings merges. Old `pi-subagents`/`pi-intercom` replacements are migrated to the bundled TLH forks so architect delegation uses the isolated minor-agent prompts. Installer runs fail if these critical bundled packages cannot be installed or refreshed; fix the package install/checkout and rerun the installer rather than trying to disable them.

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

The release `install.sh` is a small stage-0 Bash bootstrapper: it finds or fetches the matching stage-1 Node helper (`scripts/tlh-install.mjs`) and support files, then stage-1 performs the isolated profile install.

Install, update, and uninstall guidance lives in [`docs/install.md`](docs/install.md).

## Local development

Local testing and development commands live in [`docs/local-development.md`](docs/local-development.md).

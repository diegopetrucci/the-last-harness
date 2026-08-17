# TLH slash commands

This document lists slash commands available in an interactive TLH session, grouped by origin.

Type any command name with a leading `/` in the TLH TUI to trigger it. Autocomplete surfaces most commands as you type; a small set of upstream and bundled commands is hidden from autocomplete but remains triggerable by typing — see [Hidden autocomplete commands](#hidden-autocomplete-commands) below.

On interactive startup, TLH may also show one quiet hand-curated random tip line for that process launch. Those tips are just lightweight discovery hints for real TLH commands and workflow affordances; they are launch-scoped and not LLM-generated.

> **Note:** autocomplete hiding is not an execution block. Any command listed under [Hidden autocomplete commands](#hidden-autocomplete-commands) can still be run by typing it in full.

---

## Upstream Pi built-ins

These commands are provided by the upstream Pi runtime. They are available in every TLH session unless noted otherwise.

| Command | Description |
|---------|-------------|
| `/changelog` | Show upstream Pi changelog entries — **hidden from TLH autocomplete**; use `/tlh-changelog` for TLH release notes |
| `/clone` | Duplicate the current session at the current position |
| `/compact` | Manually compact the session context |
| `/copy` | Copy the last agent message to the clipboard |
| `/export` | Export the session (HTML by default; pass a `.html` or `.jsonl` path to specify format) |
| `/fork` | Create a new fork from a previous user message |
| `/hotkeys` | Show all keyboard shortcuts |
| `/import` | Import and resume a session from a JSONL file — **hidden from TLH autocomplete** |
| `/login` | Configure provider authentication |
| `/logout` | Remove provider authentication |
| `/model` | Select the active model (opens the native selector; see [model selection scope](models.md#model-selection-scope)) |
| `/name` | Set the session display name |
| `/new` | Start a new session |
| `/quit` | Quit the TLH TUI |
| `/reload` | Reload keybindings, extensions, skills, prompts, and themes; also recapture TLH experimental-flag state for the active session |
| `/resume` | Resume a different session |
| `/scoped-models` | Enable or disable models for Ctrl+P cycling — **hidden from TLH autocomplete** |
| `/session` | Show session info and stats |
| `/settings` | Open the settings menu |
| `/share` | Share the session as a secret GitHub gist |
| `/tree` | Navigate the session tree and switch branches |
| `/trust` | Save the current project trust decision for future sessions |

---

## TLH commands

These commands are registered by the TLH extension bundled with this profile.

| Command | Description |
|---------|-------------|
| `/thinking` | Pick the model thinking level, subject to the active primary-agent thinking constraints |
| `/effort` | Supported alias for `/thinking`, subject to the same active primary-agent thinking constraints |
| `/experimental` | Open the TLH experimental-feature picker in TUI, or list/change TLH experimental features via typed subcommands (`delta-follow-up-reviews`, `ci-failure-investigation`, and `embedded-subagents` are currently registered) |
| `/tickets` | Show the read-only tk-backed TLH ticket workflow details for the current repo/worktree |
| `/review` | Open an interactive code-review mode picker (requires the architect primary agent) |
| `/switch-primary-agent` | Show or switch the active TLH primary agent (`architect`, `rush`, `product`, `bug-hunter`, `disabled`) |
| `/reconcile` | Review and resolve model/effort override drift from TLH packaged defaults |
| `/subagent-settings` | Show or edit persisted TLH bundled minor-agent model and effort overrides |
| `/tlh-changelog` | Show TLH release notes from the packaged `CHANGELOG.md` |
| `/tokens` | Generate and open a single no-flags local HTML token-spend report for the current session |
| `/what-consumed-my-session-limit-and-tokens` | Generate and open a local HTML session-limit usage report across all in-window TLH sessions |
| `/toggle-context-cap` | Toggle the 200k effective context-window cap for auto-compaction |
| `/toggle-tlh-git-attribution` | Toggle the TLH commit attribution footer for agent-created git commits |
| `/usage` | Show or change TLH subscription usage-limit footer preferences |
| `/version` | Show the installed TLH version and the upstream Pi runtime version |

### `/thinking` and `/effort`

Both `/thinking` and `/effort` are subject to the active primary-agent thinking constraints. **Locked** primaries — rush, product, and bug-hunter — each run at a fixed thinking level and return an error if you try to change it (`Thinking is locked at "<level>" for the <name> primary agent.`). **Architect** enforces a medium floor: `/thinking off`, `/thinking minimal`, `/thinking low`, `/effort off`, `/effort minimal`, and `/effort low` are rejected with `architect requires at least medium thinking.` The floor does not apply when the primary is disabled.

With no level argument in the interactive TUI, a changed selection opens a second `Thinking selection scope` picker: `This session only — default` keeps the new level active without changing the isolated profile's `defaultThinkingLevel`, while `All sessions` persists it for future sessions. Cancel restores the level that was active before the picker and leaves the persistent default unchanged. Selecting the current level still reports the active level but does not open the scope picker; dismissing the level picker or making a rejected selection also does not open it. Typed levels and thinking cycling/shortcuts retain their existing persistent behavior. To replace a persistent default, run `/thinking <level>` or `/effort <level>` with the desired value. Pi writes that default only when the active level changes, so to persist a session-only level that is already active, first change to another allowed level and then type the desired level. A session-only level is not a lock: it remains active until a later model or thinking-level operation changes it; a new session also returns to its resolved default.

### `/experimental`

`/experimental` currently registers `delta-follow-up-reviews`, `ci-failure-investigation`, and `embedded-subagents`. In the interactive TLH TUI, running `/experimental` with no arguments opens a picker that shows current feature state and lets you toggle flags; outside the TUI it falls back to the status list. Typed subcommands remain available: `/experimental list`, `/experimental status [feature]`, `/experimental enable <feature>`, `/experimental disable <feature>`, and `/experimental toggle <feature>`. `contrarian` is a bundled default minor subagent for sparing pre-ticket planning stress-tests when a proposed change genuinely warrants an adversarial brief; it is not part of the `/experimental` toggle surface, not the routine `code-reviewer` diff pass, and not the broader `oracle` second-opinion path. `delta-follow-up-reviews` is an opt-in flag that adds architect and `code-reviewer` guidance for delta-scoped follow-up reviews after fixes. `ci-failure-investigation` is an opt-in flag that lets the architect primary agent do read-only failed CI/status-check investigation after TLH opens a PR, then summarize and ask whether to proceed before any edits, commits, pushes, reruns, PR changes, or other follow-up changes. `embedded-subagents` is a default-off flag that gates architect-initiated delegation to trusted user-owned `embedded.<slug>` subagents placed in the isolated TLH profile. A new session or explicit `/reload` recaptures flag state; enabling or disabling the flag does not affect the active runtime until one of those activation boundaries. Enable it with `/experimental enable embedded-subagents` and undo it with `/experimental disable embedded-subagents`, then start a new session or run `/reload`. Only valid regular non-symlink `.md` agent definitions with `package: embedded`, a valid `name`, and a non-empty `description` authorize; `.chain.md` files do not. See [embedded-subagents.md](embedded-subagents.md) for the full setup guide. All three flags are disabled by default. Stale `run-tests-last` values in `tlh.experimental.enabledFeatures` do not re-enable retired behavior.

### `/subagent-settings`

`/subagent-settings` configures persistent model and effort overrides for the eight bundled TLH minor-agent roles: `code-reviewer`, `contrarian`, `developer`, `diff-summarizer`, `librarian`, `oracle`, `repo-scout`, and `web-scout`. These roles are dispatched through TLH's first-party `extensions/subagents` runtime; they are not a separately installed extension.

#### Grammar

```text
/subagent-settings
/subagent-settings status [role]
/subagent-settings set <role> [model <provider/id>] [effort <off|minimal|low|medium|high|xhigh|max>]
/subagent-settings reset <role> [model|effort]
/subagent-settings reset-all
```

With no arguments, the command opens the picker in the interactive TUI. In a non-TUI or headless context, it reports status instead. `set` requires at least one `model` or `effort` pair; the two pairs can be supplied in either order. A model must be currently available and should be written as `provider/id`; do not put an effort suffix on the model override—use the separate `effort` field. `status` shows every bundled role, or one role when supplied. `reset <role>` clears both saved fields for that role, while the field-specific forms clear only `model` or `effort`.

#### Storage and backups

Overrides are global settings stored under `subagents.agentOverrides` in the active isolated TLH profile's `settings.json`. The default profile is `~/.the-last-harness/agent/settings.json`; when `PI_CODING_AGENT_DIR` is set, the profile it names is used instead. The TLH wrapper sets this variable for the isolated profile. Writes are refused when the selected directory is the normal Pi profile or otherwise outside the isolated TLH profile, so the command will not modify normal user configuration. The user-facing `effort` field is stored as the runtime's `thinking` field.

TLH preserves unrelated settings and per-role keys. When a write replaces existing settings content, it first creates a collision-safe `settings.json.bak-*` backup (the notification shows the exact backup path); a new settings file with no previous content has no backup to report. To roll back a whole settings change, restore the desired backup over the active profile's `settings.json`, for example:

```sh
cp /path/to/settings.json.bak-<timestamp> /path/to/settings.json
```

Use the path shown by TLH, or substitute the directory selected by `PI_CODING_AGENT_DIR` for the default path above.

#### Dispatch precedence and warnings

For each subagent dispatch, the effective choices are resolved from highest to lowest precedence:

1. A direct dispatch with an explicit model that already has a recognized `:effort` suffix is left unchanged; the suffix wins over any saved effort.
2. A direct dispatch with an explicit model but no recognized suffix keeps that model. A saved role effort may be appended when the model supports it; a saved role model pin does not replace the caller's explicit model.
3. When the dispatch has no explicit model, stored `/subagent-settings` values are resolved before bundled defaults. An available stored model pin is used, and a stored effort is applied when supported. A stored `model: false` means inherit the current session model and then apply the stored effort. A stored effort without a model pin applies to the resolved role model.
4. With no applicable stored override, TLH uses the bundled provider-aware role defaults. `code-reviewer`, `oracle`, and `contrarian` prefer an available opposite provider for independence; the other bundled roles generally follow the current session provider when TLH injects defaults.

A saved model pin that is no longer available is not silently replaced: TLH warns that `TLH saved minor-agent model override "<model>" for <role> is not currently available; forwarding the saved pin unchanged instead of swapping in bundled defaults. Update it with /subagent-settings set <role> model <provider/id> or clear it with /subagent-settings reset <role> model.` During dispatch, the subagents runtime combines caller-supplied `fallbackModels` with fallback models from the role's saved `subagents.agentOverrides.<role>.fallbackModels` field or bundled agent frontmatter. Because TLH cannot observe every runtime fallback source, this warning does not claim that a dispatch will fail closed.

Stored effort overrides are capability-checked on each dispatch. When a recognized stored value is unsupported, TLH neutralizes it with the provider-resolved bundled level when possible and warns `TLH stored minor-agent effort "<level>" is not supported by <provider/id>; using bundled defaults for this run.` If the bundled level is unavailable but `off` is supported, it warns `TLH stored minor-agent effort "<level>" is not supported by <provider/id>; using explicit off for this run.` A nonstandard stored value uses the same two outcomes: `TLH ignored unsupported stored minor-agent effort "<value>" for <role>; using bundled defaults for this run.` or `TLH ignored unsupported stored minor-agent effort "<value>" for <role>; using explicit off for this run.`

Generated opposite-provider fallbacks use the corresponding wording with `generated fallback <provider/id>` and `that fallback will use`, for example: `TLH stored minor-agent effort "<level>" is not supported by generated fallback <provider/id>; that fallback will use bundled defaults for this run.` or `TLH stored minor-agent effort "<level>" is not supported by generated fallback <provider/id>; that fallback will use explicit off for this run.` If neither bundled nor `off` is supported, TLH warns `TLH stored minor-agent effort "<level>" is not supported by <provider/id>; no supported suffix can neutralize it, so the subagents runtime will drop the stored value for this run.` If no model can be resolved for a nonstandard stored value, it warns `TLH ignored unsupported stored minor-agent effort "<value>" for <role>; no supported model suffix could be emitted, so the subagents runtime will drop the value for a known model and fail open for an unknown model if this role is dispatched.` When no bundled or current-session model is available for a thinking-only override, TLH warns `TLH stored minor-agent effort "<value>" for <role> could not be capability-checked because no bundled or current-session model is available; the subagents runtime will apply its capability gate if the model resolves and fail open otherwise.` The runtime gate resolves the known-model case by dropping unsupported values rather than emitting them; unknown or unresolvable models remain fail-open capability uncertainty, not residual known-model application.

#### Provider independence and headless use

A fixed model override cannot guarantee provider independence for `code-reviewer`, `oracle`, or `contrarian`. In a UI-enabled session, TLH asks for confirmation with the warning `Provider independence is not guaranteed when a fixed model override is configured for this role.` Status output repeats that warning for a saved fixed model. In a headless or otherwise non-UI context, TLH refuses the write because it cannot show the confirmation, reporting `Cannot confirm the independence warning for <role> in this mode.`

#### Supported effort values and undo

The complete set of values accepted by `/subagent-settings set ... effort ...` is `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. The command validates a new value against the currently effective model before writing. A stored value is applied when the resolved model advertises support; `max` specifically requires a `thinkingLevelMap` entry advertising it. If a model later stops supporting a stored value, TLH warns and uses bundled effort or explicit `off` when possible; if neither is supported, the runtime drops a known-unsupported value instead of emitting it, while unknown or unresolvable models fail open. `max` is a live value in bundled behavior too: the bundled `developer` role already configures `max` for its OpenAI default.

To undo a persistent change:

- use `/subagent-settings reset <role> model` or `reset <role> effort` to clear one field;
- use `/subagent-settings reset <role>` to clear both `model` and `thinking` for one bundled role while preserving any other keys in that role's entry;
- use `/subagent-settings reset-all` to clear only `model` and `thinking` for bundled roles. It preserves other keys on those role entries and leaves unknown/non-TLH entries under `subagents.agentOverrides` untouched; or
- restore the `settings.json.bak-*` file shown after a write by copying it back over the active `settings.json`.

The reset commands clean up empty role and override containers but do not remove unrelated settings. When diagnosing whether a saved setting took effect, `/subagents-doctor` shows first-party runtime diagnostics and `/subagents-fleet` shows active dispatch status; neither command changes these overrides.

### `/reconcile`

`/reconcile` lets you review and resolve drift between your saved model/effort overrides and TLH's current packaged defaults for the affected roles.

#### When the notice appears

At startup, TLH checks whether any packaged model or effort default has changed for a role you have overridden since you last ran `/reconcile`. When it finds changed roles it shows a one-line non-blocking notice:

```
TLH default model/effort changed for <role> — run /reconcile to review
```

The **only trigger** is TLH shipping an update that changes a packaged default for a role you have overridden. There is no periodic or scheduled reminder. An ignored notice reappears each launch until you make a decision via `/reconcile`.

When the session provider is unknown at startup, TLH defers: no comparison is performed, no baseline is written, and no notice appears until a provider is active.

Overrides that existed before baseline recording was introduced are silently backfilled on your first startup with a known provider, using the current packaged default as the baseline. The notice will fire on the next packaged-default change after that point — not for any changes that occurred before the backfill.

Acknowledgments are per-provider. A decision recorded under one provider does not suppress the notice for a different provider — switching providers means TLH treats you as not-yet-acknowledged for that provider until you run `/reconcile` under it, so a genuine later change to that provider's packaged default still notifies you.

#### Using `/reconcile` in the TUI

In an interactive TLH session, `/reconcile` opens a picker listing every affected role with both your override value and the current TLH packaged default. You can act on one role at a time or choose a bulk action for all.

For each role you have two choices:

- **Keep** — acknowledges the new TLH packaged default and preserves your override unchanged. Non-destructive: nothing is written to or cleared from your settings. Keep requires a known session provider; when no provider is identified, TLH declines and asks you to rerun `/reconcile` in a session where a provider is active.
- **Reset** — clears your stored override so the role resolves to TLH packaged defaults on the next dispatch. For primary agents, the packaged default is also applied to the active session immediately (subject to your `tlh.primaryAgent.applyModel` setting). Each reset is an independent write that creates a `settings.json.bak-*` backup; the notification shows the exact backup path.

**Keep is always undoable** because your override is never touched.

When resetting all, per-role failures are isolated — errors and unrecognised overrides are reported as a distinct category so a single failed clear does not abort the rest.

**Reset is also undoable**: restore the value through the native `/model` picker and choose `All sessions` (the default `This session only — default` choice is session-only) for primary-agent overrides; use `/subagent-settings set <role> model <provider/id>` or `/subagent-settings set <role> effort <level>` for subagent overrides, or copy back the `settings.json.bak-*` backup shown in the notification.

#### Outside the TUI

In headless or non-TUI contexts, `/reconcile` prints a read-only drift summary showing all overridden roles, your values, and the current TLH packaged defaults. No state is written in this mode.

#### Packaged-default semantics

The packaged default shown is the canonical value for the active provider, resolved from TLH's own bundled agent catalog restricted to that provider's models. It is **environment-independent** — it reflects what this TLH release declares, not what models your current environment has available. A reported default may therefore name a model you cannot currently reach, and for roles that prefer an opposite-provider model (such as code-reviewer) the displayed value is a same-provider fallback rather than the exact model Reset would produce in a live dual-provider session. This does not block the decision; Keep and Reset work regardless of model availability.

#### Reconcile state

Acknowledgments are stored in the isolated TLH profile under `tlh/reconcile-state.json` (alongside `settings.json`). Each entry records the packaged defaults you acknowledged, keyed by role name and provider (`byProvider`), so a later provider switch does not inherit a prior acknowledgment. This file is written in three situations: when you create a persistent override via `/model` (the native picker requires the `All sessions` choice; its default `This session only — default` choice does not write an override; direct exact-name `/model` selections retain their existing persistent path) or via `/subagent-settings`, on startup when TLH backfills a missing baseline for a pre-existing override, and when you run `/reconcile`. Do not edit it by hand.

### `/tickets`

`/tickets` shows the current repo/worktree's read-only ticket workflow details from `tk`: ready, blocked, in-progress, active, and total counts, followed by one in-progress detail line or an `In progress:` list when multiple tickets are in progress. Each detail includes the ticket ID and its title when available. The footer status is on by default and renders one `ticket: <title> (/tickets)` line per in-progress ticket. In both views, TLH strips terminal control sequences from titles and falls back to the ticket ID when a title cannot be resolved or is empty after sanitization.

### `/tokens`

`/tokens` takes no flags or subcommands. Run it as `/tokens` to generate one local HTML token-spend report for the current session and open it on your machine.

The report is built from sanitized session analysis only. It omits raw transcript text, raw tool arguments, and raw tool-result payloads, and TLH tells you where the private local report directory lives so you can delete it when you no longer need the report.

### `/what-consumed-my-session-limit-and-tokens`

`/what-consumed-my-session-limit-and-tokens` takes no flags or subcommands. Run it to generate a local HTML report covering TLH sessions within the current provider session-limit window across all projects under the same session root.

The report is built from sanitized session analysis only. It omits raw transcript text, raw tool arguments, and raw tool-result payloads. It uses the current subscription usage snapshot when available, with a trailing five-hour fallback when TLH cannot resolve an exact provider window.

---

## Model-facing subagent tools

TLH ships the `subagent` tool as first-party runtime functionality. It is a model-facing tool, not a slash command you need to invoke manually. `subagent` supports single or parallel execution plus the closed action set `list`, `get`, `status`, `interrupt`, `resume`, `steer`, and `doctor`. Saved chains and mutating agent-management actions are not in the model-facing TLH contract.

The architect normally handles these tools for you. See [subagents.md](subagents.md) for dispatch fields, fresh-context/user-scope isolation, async control and durable resume behavior, acceptance, artifacts, migration, and undo steps.

---

## Packaged first-party extension commands

These commands ship inside the TLH package itself rather than through separately managed default-extension installs.

| Command | Extension | Description |
|---------|-----------|-------------|
| `/annotate-last-message` | `the-last-harness` | Open a native annotation window for the latest assistant message and send submitted feedback to the agent |
| `/annotate-git-diff` | `annotate-git-diff` | Open a native git-diff review window; clicking Submit sends review feedback to the agent, closing with unsent comments pastes a draft to the editor |
| `/subagents-doctor` | `subagents` | Show first-party subagent runtime diagnostics |
| `/subagents-fleet` | `subagents` | Show active subagent fleet status and transcript commands |

### `/annotate-last-message`

`/annotate-last-message` opens a lightweight native Glimpse annotation window for the latest completed assistant message on the current session branch.

#### Requirements

- Run it from an interactive TLH session with editor access; it will not work in non-interactive/headless command contexts.
- The current branch must already contain a completed assistant message with text. If the latest assistant turn is still running or has no text content, wait for a normal text reply before rerunning the command.
- It needs a desktop session that can open a local native window. Headless shells and SSH-only sessions will not work unless they can display that window locally.
- TLH packages the UI assets locally. `/annotate-last-message` does **not** require CDN access or general internet access just to render the annotation window.
- Like the rest of TLH, it stays inside the isolated TLH profile and does not read or write normal Pi config under `~/.pi/agent`.

#### Behavior

- Finds the latest completed assistant message on the active session branch and shows it with line numbers plus section-level grouping.
- Lets you leave overall, section, and inline comments in one lightweight first-party TLH window.
- When you submit, TLH sends a structured planning-oriented feedback prompt directly to the agent as a follow-up message. Your existing editor text is left untouched.
- Blank lines cannot be annotated inline; the inline-note button is not shown for empty lines.
- It does not auto-apply code changes or silently mutate prior messages.
- Use `/annotate-last-message` directly when you want to annotate the latest assistant reply.

#### Extension-local notes

See [`extensions/the-last-harness/annotate-last-message/README.md`](../extensions/the-last-harness/annotate-last-message/README.md).

#### Troubleshooting and recovery

- `annotate-last-message requires interactive mode.` → run the command from the TLH TUI rather than a non-interactive command context.
- `No assistant messages found on the current session branch.` → wait until the branch has an assistant reply, then rerun.
- `Latest assistant message is incomplete (...)` → wait for the assistant turn to finish, then rerun.
- `Latest assistant message has no text to annotate.` → rerun after a normal text reply; tool-only or empty assistant turns cannot be annotated.
- `A last-message annotation window is already open.` → return to the existing window or close it before opening another.
- `Annotation failed: Glimpse host not found ...` → the local native window runtime is unavailable. Run `tlh update` (or reinstall TLH) to restore the packaged dependency, then rerun from a machine/session that can open native windows.
- There is no separate `tlh defaults` toggle for `/annotate-last-message` because it ships inside TLH itself.

### `/annotate-git-diff`

`/annotate-git-diff` opens a native Glimpse review window for the current git repository.

#### Requirements

- Run it from inside a git repository.
- It needs a desktop session that can open a local native window. Headless shells and SSH-only sessions will not work unless they can display that window locally.
- TLH packages Monaco and Tailwind locally for this UI. Monaco editor, syntax-highlighting tokenizers, and the worker source are all inlined into the review window's HTML at build time, so the window works from any WebView origin (including null-origin WebViews) without runtime file-system fetches. `/annotate-git-diff` does **not** require CDN access or general internet access just to render the review window.
- Like the rest of TLH, it stays inside the isolated TLH profile and does not read or write normal Pi config under `~/.pi/agent`.

#### Behavior

- Review branch diffs, individual commits (including working-tree changes), or the full file snapshot from one window.
- Leave inline, file-level, and overall comments.
- Clicking **Submit** sends a structured review-feedback prompt directly to the agent. If you close the window with comments not yet submitted, TLH pastes the draft prompt into the editor instead — so an accidental window close cannot fire a new agent turn. It does not auto-apply code changes or mutate your normal Pi profile.

#### Attribution

TLH's first-party implementation adapts the MIT-licensed `@ryan_nookpi/pi-extension-diff-review` work and preserves inspiration credit to [`badlogic/pi-diff-review`](https://github.com/badlogic/pi-diff-review). For extension-local notes, see [`extensions/annotate-git-diff/README.md`](../extensions/annotate-git-diff/README.md).

#### Troubleshooting and recovery

- `Review failed: Not inside a git repository.` → change into a git repo and rerun `/annotate-git-diff`.
- `No reviewable files found.` → make or fetch reviewable changes/commits, then rerun `/annotate-git-diff`.
- `Review failed: Glimpse host not found ...` → the local native window runtime is unavailable. Run `tlh update` (or reinstall TLH) to restore the packaged dependency, then rerun from a machine/session that can open native windows.
- If the window says TLH could not load its packaged review assets, the `monaco-editor` package is missing or corrupt in your TLH install (Monaco editor, syntax-highlighting tokenizers, and the worker source are all inlined at build time, not fetched at runtime). Reinstall TLH (or run `tlh update`) to restore the package, then rerun `/annotate-git-diff`. If the problem persists after reinstalling, please file an issue.
- There is no separate `tlh defaults` toggle for `/annotate-git-diff` because it ships inside TLH itself. If you customize TLH packages manually, keep that change inside the isolated TLH profile rather than `~/.pi/agent`.

---

## Packaged prompt templates

These slash commands come from prompt templates bundled inside TLH. They insert canned prompt text into the editor for you to review and send.

| Command | Description |
|---------|-------------|
| `/analyse-tlh-sessions` | Analyse the past week of tlh sessions for notable issues without changing files. |
| `/investigate-pr-comments` | Check PR comments and verify whether each one is valid. |
| `/merge-origin-main-into-this-branch` | Merge `origin/main` into this branch. |
| `/rebase-this-branch-onto-origin-main` | Rebase this branch onto `origin/main`. |

---

## Bundled extension commands

These commands are provided by bundled default extensions and are visible in TLH autocomplete. They are available when the relevant extension is installed and active.

| Command | Extension | Description |
|---------|-----------|-------------|
| `/context` | `pi-context-inspector` | Open a local HTML breakdown of where this session's context is going |
| `/fast` | `pi-fast` | Toggle OpenAI Codex Fast mode for eligible ChatGPT-auth GPT-5.4, GPT-5.5, and GPT-5.6 sessions |
| `/mcp` | `pi-mcp-adapter` | Show MCP server status |
| `/mcp-auth` | `pi-mcp-adapter` | Authenticate with an MCP server (OAuth) |

---

## Hidden autocomplete commands

These commands are registered and fully functional, but deliberately excluded from TLH autocomplete suggestions. Type them in full to invoke them.

### Hidden upstream Pi built-ins

| Command | Description |
|---------|-------------|
| `/changelog` | Show upstream Pi changelog entries; use `/tlh-changelog` for TLH release notes |
| `/import` | Import and resume a session from a JSONL file |
| `/scoped-models` | Enable or disable models for Ctrl+P cycling |

### Hidden skill commands

| Command | Description |
|---------|-------------|
| `/skill:librarian` | Load the bundled librarian skill by name without surfacing it in TLH autocomplete |

### Hidden first-party extension commands

| Command | Extension | Description |
|---------|-----------|-------------|
| `/subagent-cost` | `subagents` | Show parent and child usage cost for this session; hidden because `/tokens` provides the TLH-native token report |

### Hidden bundled extension commands

| Command | Extension | Description |
|---------|-----------|-------------|
| `/curator` | `pi-web-access` | Toggle or configure the search curator workflow |
| `/quiet-tools` | `pi-quiet-tools` | Toggle one-line collapsed invocations for built-in tool rows |
| `/search` | `pi-web-access` | Browse stored web search results |
| `/websearch` | `pi-web-access` | Open the web search curator |

---

## TLH CLI subcommands

These are `tlh` command-line subcommands, distinct from the `/slash commands` used inside a TLH session.

### `tlh sessions`

`tlh sessions` is a read-only session analysis tool. It emits JSON to stdout so you can pipe to `jq`. Run `tlh sessions --mode per-session` for a per-session summary of tool-pair statistics and coverage, or `tlh sessions --mode per-tool` for aggregated per-tool statistics across all sessions. Raw paths, cwd values, and project labels are omitted by default; pass `--include-paths` only when you need them for concrete evidence. `tlh sessions` never reads `run-history.jsonl` and never writes to session files.

---

## Managing bundled extensions

Individual bundled extensions can be disabled without affecting the others. Use `tlh defaults` to list and manage opt-outs:

```sh
tlh defaults list        # show installed defaults and opt-out status
tlh defaults disable <id>  # disable a separately managed default extension (e.g. tlh defaults disable context-inspector)
tlh defaults enable <id>   # re-enable a disabled extension
```

Disabling an extension removes it from the installed packages list on the next `tlh update` run. Its slash commands will no longer be available in new sessions after the extension is unloaded. This opt-out flow applies to separately managed default extensions only (those in `config/default-extensions.json`), not first-party packaged extensions like `notify`, `/annotate-last-message`, or `/annotate-git-diff`.

### Configuring the notify extension

The `notify` extension is first-party and ships bundled with TLH. It cannot be managed with `tlh defaults disable`; instead, disable it by setting `"enabled": false` in its config file.

Config files are merged at runtime — project config overrides global config:

- `~/.the-last-harness/agent/extensions/notify.json` (default path; may differ if you used `--agent-dir` during install)
- `<project>/.pi/notify.json` (only when the project is trusted)

Example to disable notifications entirely:

```json
{
  "enabled": false
}
```

Key config fields (see [`extensions/notify/README.md`](../extensions/notify/README.md) for the full list):

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Master on/off switch |
| `onlyWhenInteractive` | `true` | Skip notifications in non-UI (print) mode |
| `suppressWhileActive` | `true` | Hold all notification channels while background subagent work is still running; a notification fires only once the session is genuinely waiting on you, not merely between turns. Set to `false` to notify on every turn completion regardless. Has no effect when the TLH activity tracker is absent. |
| `title` | `"tlh"` | Notification title |
| `body` | `"Ready for input"` | Notification body |

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
| `/clone` | Duplicate the current session at the current position — **hidden from TLH autocomplete** |
| `/compact` | Manually compact the session context |
| `/copy` | Copy the last agent message to the clipboard |
| `/export` | Export the session (HTML by default; pass a `.html` or `.jsonl` path to specify format) |
| `/fork` | Create a new fork from a previous user message |
| `/hotkeys` | Show all keyboard shortcuts |
| `/import` | Import and resume a session from a JSONL file — **hidden from TLH autocomplete** |
| `/login` | Configure provider authentication |
| `/logout` | Remove provider authentication |
| `/model` | Select the active model (opens a selector UI) |
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
| `/tlh-changelog` | Show TLH release notes from the packaged `CHANGELOG.md` |
| `/tokens` | Generate and open a single no-flags local HTML token-spend report for the current session |
| `/what-consumed-my-session-limit-and-tokens` | Generate and open a local HTML session-limit usage report across all in-window TLH sessions |
| `/toggle-context-cap` | Toggle the 200k effective context-window cap for auto-compaction |
| `/toggle-tlh-git-attribution` | Toggle the TLH commit attribution footer for agent-created git commits |
| `/usage` | Show or change TLH subscription usage-limit footer preferences |
| `/version` | Show the installed TLH version and the upstream Pi runtime version |

### `/thinking` and `/effort`

Both `/thinking` and `/effort` are subject to the active primary-agent thinking constraints. **Locked** primaries — rush, product, and bug-hunter — each run at a fixed thinking level and return an error if you try to change it (`Thinking is locked at "<level>" for the <name> primary agent.`). **Architect** enforces a medium floor: `/thinking off`, `/thinking minimal`, `/thinking low`, `/effort off`, `/effort minimal`, and `/effort low` are rejected with `architect requires at least medium thinking.` The floor does not apply when the primary is disabled.

### `/experimental`

`/experimental` currently registers `delta-follow-up-reviews`, `ci-failure-investigation`, and `embedded-subagents`. In the interactive TLH TUI, running `/experimental` with no arguments opens a picker that shows current feature state and lets you toggle flags; outside the TUI it falls back to the status list. Typed subcommands remain available: `/experimental list`, `/experimental status [feature]`, `/experimental enable <feature>`, `/experimental disable <feature>`, and `/experimental toggle <feature>`. `contrarian` is a bundled default minor subagent for sparing pre-ticket planning stress-tests when a proposed change genuinely warrants an adversarial brief; it is not part of the `/experimental` toggle surface, not the routine `code-reviewer` diff pass, and not the broader `oracle` second-opinion path. `delta-follow-up-reviews` is an opt-in flag that adds architect and `code-reviewer` guidance for delta-scoped follow-up reviews after fixes. `ci-failure-investigation` is an opt-in flag that lets the architect primary agent do read-only failed CI/status-check investigation after TLH opens a PR, then summarize and ask whether to proceed before any edits, commits, pushes, reruns, PR changes, or other follow-up changes. `embedded-subagents` is a default-off flag that gates architect-initiated delegation to trusted user-owned `embedded.<slug>` subagents placed in the isolated TLH profile. A new session or explicit `/reload` recaptures flag state; enabling or disabling the flag does not affect the active runtime until one of those activation boundaries. Enable it with `/experimental enable embedded-subagents` and undo it with `/experimental disable embedded-subagents`, then start a new session or run `/reload`. Only valid regular non-symlink `.md` agent definitions with `package: embedded`, a valid `name`, and a non-empty `description` authorize; `.chain.md` files do not. See [embedded-subagents.md](embedded-subagents.md) for the full setup guide. All three flags are disabled by default. Stale `run-tests-last` values in `tlh.experimental.enabledFeatures` do not re-enable retired behavior.

### `/tickets`

`/tickets` shows the current repo/worktree's read-only ticket workflow details from `tk`: ready, blocked, in-progress, active, and total counts, followed by one in-progress detail line or an `In progress:` list when multiple tickets are in progress. Each detail includes the ticket ID and its title when available. The footer status is on by default and renders one `ticket: <title> (/tickets)` line per in-progress ticket. In both views, TLH strips terminal control sequences from titles and falls back to the ticket ID when a title cannot be resolved or is empty after sanitization.

### `/tokens`

`/tokens` takes no flags or subcommands. Run it as `/tokens` to generate one local HTML token-spend report for the current session and open it on your machine.

The report is built from sanitized session analysis only. It omits raw transcript text, raw tool arguments, and raw tool-result payloads, and TLH tells you where the private local report directory lives so you can delete it when you no longer need the report.

### `/what-consumed-my-session-limit-and-tokens`

`/what-consumed-my-session-limit-and-tokens` takes no flags or subcommands. Run it to generate a local HTML report covering TLH sessions within the current provider session-limit window across all projects under the same session root.

The report is built from sanitized session analysis only. It omits raw transcript text, raw tool arguments, and raw tool-result payloads. It uses the current subscription usage snapshot when available, with a trailing five-hour fallback when TLH cannot resolve an exact provider window.

---

## Packaged first-party extension commands

These commands ship inside the TLH package itself rather than through separately managed default-extension installs.

| Command | Extension | Description |
|---------|-----------|-------------|
| `/annotate-last-message` | `the-last-harness` | Open a native annotation window for the latest assistant message and send submitted feedback to the agent |
| `/annotate-git-diff` | `annotate-git-diff` | Open a native git-diff review window; clicking Submit sends review feedback to the agent, closing with unsent comments pastes a draft to the editor |

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
| `/merge-origin-main-into-this-branch` | Merge `origin/main` into this branch. |
| `/rebase-this-branch-onto-origin-main` | Rebase this branch onto `origin/main`. |

---

## Bundled extension commands

These commands are provided by bundled default extensions and are visible in TLH autocomplete. They are available when the relevant extension is installed and active.

| Command | Extension | Description |
|---------|-----------|-------------|
| `/context` | `pi-context-inspector` | Open a local HTML breakdown of where this session's context is going |
| `/fast` | `pi-openai-fast` | Toggle OpenAI Codex Fast mode (ChatGPT-auth GPT-5.4/GPT-5.5 only) |
| `/mcp` | `pi-mcp-adapter` | Show MCP server status |
| `/mcp-auth` | `pi-mcp-adapter` | Authenticate with an MCP server (OAuth) |
| `/subagents-doctor` | `pi-subagents` | Show subagent diagnostics |
| `/subagents-fleet` | `pi-subagents` | Show active subagent fleet status and transcript commands |


---

## Hidden autocomplete commands

These commands are registered and fully functional, but deliberately excluded from TLH autocomplete suggestions. Type them in full to invoke them.

### Hidden upstream Pi built-ins

| Command | Description |
|---------|-------------|
| `/changelog` | Show upstream Pi changelog entries; use `/tlh-changelog` for TLH release notes |
| `/clone` | Duplicate the current session at the current position |
| `/import` | Import and resume a session from a JSONL file |
| `/scoped-models` | Enable or disable models for Ctrl+P cycling |

### Hidden skill commands

| Command | Description |
|---------|-------------|
| `/skill:librarian` | Load the bundled librarian skill by name without surfacing it in TLH autocomplete |

### Hidden bundled extension commands

| Command | Extension | Description |
|---------|-----------|-------------|
| `/curator` | `pi-web-access` | Toggle or configure the search curator workflow |
| `/fff-health` | `pi-fff` | Show FFF file finder health and status |
| `/fff-mode` | `pi-fff` | Show or set FFF mode (`tools-and-ui`, `tools-only`, `override`) |
| `/fff-rescan` | `pi-fff` | Trigger FFF to rescan files |
| `/quiet-tools` | `pi-quiet-tools` | Toggle one-line collapsed invocations for built-in tool rows |
| `/search` | `pi-web-access` | Browse stored web search results |
| `/subagent-cost` | `pi-subagents` | Show parent and subagent child usage cost for this session; hidden because `/tokens` provides the TLH-native token report |
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
tlh defaults disable <id>  # disable a bundled extension (e.g. tlh defaults disable fff)
tlh defaults enable <id>   # re-enable a disabled extension
```

Disabling an extension removes it from the installed packages list on the next `tlh update` run. Its slash commands will no longer be available in new sessions after the extension is unloaded. This opt-out flow applies to separately managed default extensions, not first-party packaged commands like `/annotate-last-message` or `/annotate-git-diff`.

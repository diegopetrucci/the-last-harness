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
| `/reload` | Reload keybindings, extensions, skills, prompts, and themes |
| `/resume` | Resume a different session |
| `/scoped-models` | Enable or disable models for Ctrl+P cycling |
| `/session` | Show session info and stats |
| `/settings` | Open the settings menu |
| `/share` | Share the session as a secret GitHub gist |
| `/tree` | Navigate the session tree and switch branches |

---

## TLH commands

These commands are registered by the TLH extension bundled with this profile.

| Command | Description |
|---------|-------------|
| `/thinking` | Pick the model thinking level, subject to the active primary-agent thinking constraints |
| `/effort` | Supported alias for `/thinking`, subject to the same active primary-agent thinking constraints |
| `/experimental` | List or change TLH experimental features (`contrarian` and `delta-follow-up-reviews` are currently registered) |
| `/review` | Open an interactive code-review mode picker (requires the architect primary agent) |
| `/switch-primary-agent` | Show or switch the active TLH primary agent (`architect`, `rush`, `product`, `bug-hunter`, `disabled`) |
| `/tlh-changelog` | Show TLH release notes from the packaged `CHANGELOG.md` |
| `/tokens` | Generate and open a single no-flags local HTML token-spend report for the current session |
| `/toggle-context-cap` | Toggle the 200k effective context-window cap for auto-compaction |
| `/toggle-tlh-git-attribution` | Toggle the TLH commit attribution footer for agent-created git commits |
| `/usage` | Show or change TLH subscription usage-limit footer preferences |
| `/version` | Show the installed TLH version and the upstream Pi runtime version |

### `/thinking` and `/effort`

Both `/thinking` and `/effort` are subject to the active primary-agent thinking constraints. **Locked** primaries — rush, product, and bug-hunter — each run at a fixed thinking level and return an error if you try to change it (`Thinking is locked at "<level>" for the <name> primary agent.`). **Architect** enforces a medium floor: `/thinking off`, `/thinking minimal`, `/thinking low`, `/effort off`, `/effort minimal`, and `/effort low` are rejected with `architect requires at least medium thinking.` The floor does not apply when the primary is disabled.

### `/experimental`

`/experimental` currently registers `contrarian` and `delta-follow-up-reviews`. `contrarian` bundles the adversarial `contrarian` minor agent but keeps it disabled by default; enable it with `/experimental enable contrarian` and disable it with `/experimental disable contrarian`. It is intended mainly for sparing pre-ticket planning stress-tests when a proposed change genuinely warrants an adversarial brief, not the routine `code-reviewer` diff pass and not the broader `oracle` second-opinion path. `delta-follow-up-reviews` is an opt-in flag that adds architect and `code-reviewer` guidance for delta-scoped follow-up reviews after fixes. Both flags are disabled by default. Stale `run-tests-last` values in `tlh.experimental.enabledFeatures` do not re-enable retired behavior.

### `/tokens`

`/tokens` takes no flags or subcommands. Run it as `/tokens` to generate one local HTML token-spend report for the current session and open it on your machine.

The report is built from sanitized session analysis only. It omits raw transcript text, raw tool arguments, and raw tool-result payloads, and TLH tells you where the private local report directory lives so you can delete it when you no longer need the report.

---

## Packaged first-party extension commands

These commands ship inside the TLH package itself rather than through separately managed default-extension installs.

| Command | Extension | Description |
|---------|-----------|-------------|
| `/annotate-last-message` | `the-last-harness` | Open a native annotation window for the latest assistant message and paste submitted feedback into the editor |
| `/annotate-git-diff` | `annotate-git-diff` | Open a native git-diff review window and paste submitted review feedback into the editor |

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
- When you submit, TLH inserts a structured planning-oriented feedback prompt into the current editor buffer so you can send it back to the agent.
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
- When you submit, TLH inserts a review-feedback prompt into the current editor buffer. It does not auto-apply code changes or mutate your normal Pi profile.

#### Attribution

TLH's first-party implementation adapts the MIT-licensed `@ryan_nookpi/pi-extension-diff-review` work and preserves inspiration credit to [`badlogic/pi-diff-review`](https://github.com/badlogic/pi-diff-review). For extension-local notes, see [`extensions/annotate-git-diff/README.md`](../extensions/annotate-git-diff/README.md).

#### Troubleshooting and recovery

- `Review failed: Not inside a git repository.` → change into a git repo and rerun `/annotate-git-diff`.
- `No reviewable files found.` → make or fetch reviewable changes/commits, then rerun `/annotate-git-diff`.
- `Review failed: Glimpse host not found ...` → the local native window runtime is unavailable. Run `tlh update` (or reinstall TLH) to restore the packaged dependency, then rerun from a machine/session that can open native windows.
- If the window says TLH could not load its packaged review assets, the `monaco-editor` package is missing or corrupt in your TLH install (Monaco editor, syntax-highlighting tokenizers, and the worker source are all inlined at build time, not fetched at runtime). Reinstall TLH (or run `tlh update`) to restore the package, then rerun `/annotate-git-diff`. If the problem persists after reinstalling, please file an issue.
- There is no separate `tlh defaults` toggle for `/annotate-git-diff` because it ships inside TLH itself. If you customize TLH packages manually, keep that change inside the isolated TLH profile rather than `~/.pi/agent`.

---

## Bundled extension commands

These commands are provided by bundled default extensions and are visible in TLH autocomplete. They are available when the relevant extension is installed and active.

| Command | Extension | Description |
|---------|-----------|-------------|
| `/context` | `pi-context-inspector` | Open a local HTML breakdown of where this session's context is going |
| `/fast` | `pi-openai-fast` | Toggle OpenAI Codex Fast mode (ChatGPT-auth GPT-5.4/GPT-5.5 only) |
| `/mcp` | `pi-mcp-adapter` | Show MCP server status |
| `/mcp-auth` | `pi-mcp-adapter` | Authenticate with an MCP server (OAuth) |
| `/rtk` | `pi-rtk` | Control pi-rtk shell-command rewriting |
| `/subagents-doctor` | `pi-subagents` | Show subagent diagnostics |
| `/triage-comments` | `pi-triage-comments` | Collect pasted feedback or PR comments, then start a triage investigation |

---

## Hidden autocomplete commands

These commands are registered and fully functional, but deliberately excluded from TLH autocomplete suggestions. Type them in full to invoke them.

### Hidden upstream Pi built-ins

| Command | Description |
|---------|-------------|
| `/changelog` | Show upstream Pi changelog entries; use `/tlh-changelog` for TLH release notes |
| `/clone` | Duplicate the current session at the current position |
| `/import` | Import and resume a session from a JSONL file |

### Hidden bundled extension commands

| Command | Extension | Description |
|---------|-----------|-------------|
| `/fff-health` | `pi-fff` | Show FFF file finder health and status |
| `/fff-mode` | `pi-fff` | Show or set FFF mode (`tools-and-ui`, `tools-only`, `override`) |
| `/fff-rescan` | `pi-fff` | Trigger FFF to rescan files |
| `/intercom` | `pi-intercom` | Open the session intercom overlay (internal subagent communication) |
| `/quiet-tools` | `pi-quiet-tools` | Toggle one-line collapsed invocations for built-in tool rows |

---

## Managing bundled extensions

Individual bundled extensions can be disabled without affecting the others. Use `tlh defaults` to list and manage opt-outs:

```sh
tlh defaults list        # show installed defaults and opt-out status
tlh defaults disable <id>  # disable a bundled extension (e.g. tlh defaults disable fff)
tlh defaults enable <id>   # re-enable a disabled extension
```

Disabling an extension removes it from the installed packages list on the next `tlh update` run. Its slash commands will no longer be available in new sessions after the extension is unloaded. This opt-out flow applies to separately managed default extensions, not first-party packaged commands like `/annotate-last-message` or `/annotate-git-diff`.

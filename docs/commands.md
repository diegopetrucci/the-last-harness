# TLH slash commands

This document lists slash commands available in an interactive TLH session, grouped by origin.

Type any command name with a leading `/` in the TLH TUI to trigger it. Autocomplete surfaces most commands as you type; a small set of bundled commands is hidden from autocomplete but remains triggerable by typing — see [Hidden bundled commands](#hidden-bundled-commands) below.

> **Note:** autocomplete hiding is not an execution block. Any command listed under [Hidden bundled commands](#hidden-bundled-commands) can still be run by typing it in full.

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
| `/import` | Import and resume a session from a JSONL file |
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
| `/effort` | Pick the model reasoning effort or thinking level |
| `/review` | Open an interactive code-review mode picker (requires the architect primary agent) |
| `/switch-primary-agent` | Show or switch the active TLH primary agent (`architect`, `rush`, `product`, `bug-hunter`, `disabled`) |
| `/tlh-changelog` | Show TLH release notes from the packaged `CHANGELOG.md` |
| `/toggle-context-cap` | Toggle the 200k effective context-window cap for auto-compaction |
| `/toggle-tlh-git-attribution` | Toggle the TLH commit attribution footer for agent-created git commits |
| `/usage` | Show or change TLH subscription usage-limit footer preferences |
| `/version` | Show the installed TLH version and the upstream Pi runtime version |

---

## Packaged first-party extension commands

These commands ship inside the TLH package itself rather than through separately managed default-extension installs.

| Command | Extension | Description |
|---------|-----------|-------------|
| `/diff-review` | `diff-review` | Open a native diff-review window and paste submitted review feedback into the editor |

### `/diff-review`

`/diff-review` opens a native Glimpse review window for the current git repository.

#### Requirements

- Run it from inside a git repository.
- It needs a desktop session that can open a local native window. Headless shells and SSH-only sessions will not work unless they can display that window locally.
- TLH packages Monaco and Tailwind locally for this UI. `/diff-review` does **not** require CDN access or general internet access just to render the review window.
- Like the rest of TLH, it stays inside the isolated TLH profile and does not read or write normal Pi config under `~/.pi/agent`.

#### Behavior

- Review branch diffs, individual commits (including working-tree changes), or the full file snapshot from one window.
- Leave inline, file-level, and overall comments.
- When you submit, TLH inserts a review-feedback prompt into the current editor buffer. It does not auto-apply code changes or mutate your normal Pi profile.

#### Attribution

TLH's first-party implementation adapts the MIT-licensed `@ryan_nookpi/pi-extension-diff-review` work and preserves inspiration credit to [`badlogic/pi-diff-review`](https://github.com/badlogic/pi-diff-review). For extension-local notes, see [`extensions/diff-review/README.md`](../extensions/diff-review/README.md).

#### Troubleshooting and recovery

- `Review failed: Not inside a git repository.` → change into a git repo and rerun `/diff-review`.
- `No reviewable files found.` → make or fetch reviewable changes/commits, then rerun.
- `Review failed: Glimpse host not found ...` → the local native window runtime is unavailable. Run `tlh update` (or reinstall TLH) to restore the packaged dependency, then rerun from a machine/session that can open native windows.
- If the window says TLH could not load its packaged review assets, close it, run `tlh update`, and rerun `/diff-review`.
- There is no separate `tlh defaults` toggle for `/diff-review` because it ships inside TLH itself. If you customize TLH packages manually, keep that change inside the isolated TLH profile rather than `~/.pi/agent`.

---

## Bundled extension commands

These commands are provided by bundled default extensions and are visible in TLH autocomplete. They are available when the relevant extension is installed and active.

| Command | Extension | Description |
|---------|-----------|-------------|
| `/context` | `pi-context-inspector` | Open a local HTML breakdown of where this session's context is going |
| `/fast` | `pi-openai-fast` | Toggle OpenAI Codex Fast mode (ChatGPT-auth GPT-5.4/GPT-5.5 only) |
| `/librarian-cache` | `pi-librarian` | Toggle the Librarian local-checkout cache for future librarian calls |
| `/mcp` | `pi-mcp-adapter` | Show MCP server status |
| `/mcp-auth` | `pi-mcp-adapter` | Authenticate with an MCP server (OAuth) |
| `/oracle` | `pi-oracle` | Configure the Oracle default model and thinking level |
| `/oracle-model` | `pi-oracle` | Show which model the oracle would use right now |
| `/quiet-tools` | `pi-quiet-tools` | Toggle one-line collapsed invocations for built-in tool rows |
| `/rtk` | `pi-rtk` | Control pi-rtk shell-command rewriting |
| `/subagents-doctor` | `pi-subagents` | Show subagent diagnostics |
| `/triage-comments` | `pi-triage-comments` | Collect pasted feedback or PR comments, then start a triage investigation |

---

## Hidden bundled commands

The following commands are registered by bundled extensions but are deliberately excluded from TLH autocomplete suggestions. They are still fully functional — type them in full to invoke them.

| Command | Extension | Description |
|---------|-----------|-------------|
| `/fff-health` | `pi-fff` | Show FFF file finder health and status |
| `/fff-mode` | `pi-fff` | Show or set FFF mode (`tools-and-ui`, `tools-only`, `override`) |
| `/fff-rescan` | `pi-fff` | Trigger FFF to rescan files |
| `/intercom` | `pi-intercom` | Open the session intercom overlay (internal subagent communication) |

The upstream `/changelog` command is also hidden from TLH autocomplete to reduce noise; use `/tlh-changelog` for TLH-specific release notes.

---

## Managing bundled extensions

Individual bundled extensions can be disabled without affecting the others. Use `tlh defaults` to list and manage opt-outs:

```sh
tlh defaults list        # show installed defaults and opt-out status
tlh defaults disable <id>  # disable a bundled extension (e.g. tlh defaults disable oracle)
tlh defaults enable <id>   # re-enable a disabled extension
```

Disabling an extension removes it from the installed packages list on the next `tlh update` run. Its slash commands will no longer be available in new sessions after the extension is unloaded. This opt-out flow applies to separately managed default extensions, not first-party packaged commands like `/diff-review`.

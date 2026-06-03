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
| `/toggle-tlh-git-attribution` | Toggle the TLH commit attribution footer for agent-created git commits |
| `/usage` | Show or change TLH subscription usage-limit footer preferences |
| `/version` | Show the installed TLH version and the upstream Pi runtime version |

---

## Bundled extension commands

These commands are provided by bundled default extensions and are visible in TLH autocomplete. They are available when the relevant extension is installed and active.

| Command | Extension | Description |
|---------|-----------|-------------|
| `/context` | `pi-context-inspector` | Open a local HTML breakdown of where this session's context is going |
| `/context-cap` | `pi-context-cap` | Toggle the 200k effective context-window cap for auto-compaction |
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

Disabling an extension removes it from the installed packages list on the next `tlh update` run. Its slash commands will no longer be available in new sessions after the extension is unloaded.

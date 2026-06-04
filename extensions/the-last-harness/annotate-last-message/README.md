# TLH annotate last message

First-party `/annotate-last-message` support for The Last Harness.

## What it does

`/annotate-last-message` opens a lightweight native annotation window for the latest completed assistant message on the current session branch.

From that window you can leave:

- overall guidance for the whole reply,
- section comments for larger chunks of the message, and
- inline notes tied to individual lines.

When you submit, TLH appends a structured planning-oriented feedback prompt to the current editor buffer so you can send that feedback back to the active agent. It does not auto-apply changes or rewrite the old message in place.

This is TLH's first-party replacement for the older Plannotator-based last-message annotation flow. Use `/annotate-last-message` directly; this workflow does not require Plannotator.

## Requirements

- interactive TLH session with editor access
- a completed assistant message with text on the active branch
- local desktop support for opening a native [Glimpse](https://github.com/mariozechner/glimpse) window
- the packaged TLH profile (it does not read or write `~/.pi/agent`)

The UI assets are packaged locally with TLH, so the window does not need CDN-hosted assets or general internet access just to render.

## Troubleshooting and recovery

- `annotate-last-message requires interactive mode.` → run it from the TLH TUI.
- `No assistant messages found on the current session branch.` → wait for a branch reply, then rerun.
- `Latest assistant message is incomplete (...)` → wait for the assistant turn to finish, then rerun.
- `Latest assistant message has no text to annotate.` → rerun after a normal text reply.
- `A last-message annotation window is already open.` → reuse or close the existing window before opening another.
- `Annotation failed: Glimpse host not found ...` → the local native window runtime is unavailable. Run `tlh update` (or reinstall TLH) to restore the packaged dependency, then rerun from a machine/session that can display native windows.

There is no separate `tlh defaults` toggle for `/annotate-last-message` because it ships inside the TLH package itself.

# TLH annotate-git-diff

First-party `annotate-git-diff` extension and `/annotate-git-diff` command for The Last Harness.

## Attribution

This extension adapts the MIT-licensed `@ryan_nookpi/pi-extension-diff-review` implementation from the `Jonghakseo/pi-extension` monorepo and preserves its original inspiration credit to [badlogic/pi-diff-review](https://github.com/badlogic/pi-diff-review).

## Requirements

- Run `/annotate-git-diff` inside a git repository.
- The UI opens in a native [Glimpse](https://github.com/mariozechner/glimpse) window, so TLH needs a local desktop session that can display native windows.
- Monaco and Tailwind assets are packaged locally with TLH. The review UI does not depend on CDN-hosted JavaScript or general internet access to render.
- The command stays inside TLH's isolated profile and does not read or write normal Pi config under `~/.pi/agent`.

## What it provides

- native Glimpse review window
- Monaco-based review UI
- branch diff, per-commit (including working tree), and all-files review scopes
- inline, file-level, and overall review comments
- explicit Submit sends review feedback directly to the agent; closing the window with unsent comments pastes a draft prompt to the editor instead

Submitting feedback does not auto-apply code changes. Clicking **Submit** sends a structured review prompt directly to the active agent. If you close the window with comments not yet submitted, TLH pastes the draft feedback into the editor instead, so an accidental window close cannot fire a new agent turn.

## Troubleshooting and recovery

- `Review failed: Not inside a git repository.` → change into a git repo and rerun `/annotate-git-diff`.
- `No reviewable files found.` → make or fetch reviewable changes, then rerun `/annotate-git-diff`.
- `Review failed: Glimpse host not found ...` → the local native window runtime is unavailable. Run `tlh update` (or reinstall TLH) to restore the packaged dependency, then rerun from a machine/session that can open native windows.
- If the review window reports it could not load its packaged review assets, the `monaco-editor` package is missing or corrupt in your TLH install. Monaco editor, syntax-highlighting tokenizers, and the worker source are all inlined into the review window's HTML at build time — the UI does not fetch files from disk at runtime — so this failure means the package was absent when TLH built the window. Reinstall TLH (or run `tlh update`) to restore a corrupt install, then rerun `/annotate-git-diff`. If the problem persists after reinstalling, please file an issue.
- There is no separate `tlh defaults` toggle for `/annotate-git-diff` because it ships inside the TLH package itself.

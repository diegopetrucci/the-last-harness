# TLH diff review

First-party `/diff-review` extension for The Last Harness.

## Attribution

This extension adapts the MIT-licensed `@ryan_nookpi/pi-extension-diff-review` implementation from the `Jonghakseo/pi-extension` monorepo and preserves its original inspiration credit to [badlogic/pi-diff-review](https://github.com/badlogic/pi-diff-review).

## Requirements

- Run `/diff-review` inside a git repository.
- The UI opens in a native [Glimpse](https://github.com/mariozechner/glimpse) window, so TLH needs a local desktop session that can display native windows.
- Monaco and Tailwind assets are packaged locally with TLH. The review UI does not depend on CDN-hosted JavaScript or general internet access to render.
- The command stays inside TLH's isolated profile and does not read or write normal Pi config under `~/.pi/agent`.

## What it provides

- native Glimpse review window
- Monaco-based review UI
- branch diff, per-commit (including working tree), and all-files review scopes
- inline, file-level, and overall review comments
- submit-to-editor feedback prompt insertion

Submitting feedback does not auto-apply code changes. TLH appends a structured review prompt to the current editor buffer so you can hand that feedback back to the active agent.

## Troubleshooting and recovery

- `Review failed: Not inside a git repository.` → change into a git repo and rerun `/diff-review`.
- `No reviewable files found.` → make or fetch reviewable changes, then rerun.
- `Review failed: Glimpse host not found ...` → the local native window runtime is unavailable. Run `tlh update` (or reinstall TLH) to restore the packaged dependency, then rerun from a machine/session that can open native windows.
- If the review window reports missing packaged assets, close it, run `tlh update`, and rerun `/diff-review`.
- There is no separate `tlh defaults` toggle for `/diff-review` because it ships inside the TLH package itself.

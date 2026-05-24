---
id: tlht-auh9
status: open
deps: []
links: []
created: 2026-05-24T13:46:58Z
type: feature
priority: 2
assignee: Diego Petrucci
---
# Support POSIX sh installer entrypoint

Add support for the default The Last Harness installer command to be usable as:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | sh
```

Context: piping a script into `sh` ignores the script shebang, so the current Bash-specific `install.sh` cannot be advertised with `| sh`. Preserve the current installer behavior and safety properties while providing a POSIX-compatible entrypoint.

A likely implementation is to keep the full installer as a Bash payload, add a small POSIX `sh` bootstrap `install.sh` that downloads and execs the matching Bash payload, and update release packaging so release assets remain pinned to the release tag instead of installing from `main`.

## Design

Prefer a POSIX `sh` bootstrapper over rewriting the whole installer in POSIX shell unless the rewrite is clearly smaller and safer. The bootstrapper must pass through user arguments, fail clearly when required tools such as `bash`/`curl` are unavailable, use a safe temporary file, and keep TLH's isolated profile guarantees intact.

Release generation must publish both the `sh` entrypoint and the Bash payload and bake the release tag/update track into the generated assets as appropriate.

## Acceptance Criteria

- README advertises a default installer command using `| sh`.
- The release workflow publishes a POSIX-compatible `install.sh` entrypoint and the Bash installer payload it invokes.
- The default release install path remains pinned to the selected release/tag and does not silently install from `main`.
- Installer options still work when passed through `sh`, e.g. `curl .../install.sh | sh -s -- --dry-run`.
- Validation covers `sh install.sh --dry-run --agent-dir <tmp>/agent --bin-dir <tmp>/bin` plus the existing Bash syntax/check and dry-run coverage for the payload.
- The installer continues to avoid mutating `~/.pi/agent` and preserves existing TLH safety requirements.

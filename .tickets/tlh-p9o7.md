---
id: tlh-p9o7
status: closed
deps: []
links: []
created: 2026-05-16T17:12:12Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlh-va7o
---
# Canonicalize stage-1 installer paths

Fix oracle high finding: ensure stage-1 resolves installer target paths to absolute paths immediately after tilde expansion. `agentDir`, `binDir`, and derived settings/keybindings/wrapper/state paths must be absolute before validation, dry-run output, wrapper generation, and subprocess env/cwd use. Preserve existing safety checks and public flags/env.

## Design

Use Node path.resolve(expandPath(...)) in stage-1 config construction before derived paths are built. Stage-1 remains the authoritative full validator; stage-0 fallback may still produce expanded paths only for no-download dry-run.

## Acceptance Criteria

Relative --agent-dir/--bin-dir inputs are canonicalized to absolute paths; generated wrapper/state never store a relative PI_CODING_AGENT_DIR; normal Pi config guards still reject unsafe targets; targeted regression tests and installer smoke pass.


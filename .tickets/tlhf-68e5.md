---
id: tlhf-68e5
status: open
deps: []
links: []
created: 2026-05-29T22:31:30Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Harden live eval artifact directory handling

Address PR review feedback for the repo-only live eval runner. Prevent --artifacts-dir from using an existing/project directory as the workspace root where fixed output names like README.md and results.json could be overwritten. Preserve contributor-only, opt-in live eval behavior.

## Acceptance Criteria

Passing --artifacts-dir DIR creates a fresh dedicated child live-eval root under DIR, or otherwise rejects unsafe existing roots before any workspace files are written. Existing files in DIR are not overwritten. Help/docs/tests match the implemented semantics. Targeted live-eval tests and pack exclusion checks pass.


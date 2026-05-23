---
id: tlhf-cysu
status: open
deps: [tlhf-1eer]
links: []
created: 2026-05-23T09:53:08Z
type: task
priority: 1
assignee: Diego Petrucci
parent: tlhf-oxht
---
# Phase 3: migrate merge-settings to safe profile write helper

Adopt the shared safe profile write helper for scripts/merge-settings.mjs only.

## Acceptance Criteria

merge-settings writes and backups use the shared helper; normal Pi rejection, symlink/parent-swap, backup leak prevention, existing-mode preservation or documented mode behavior, and dry-run behavior are covered; npm run validate passes.


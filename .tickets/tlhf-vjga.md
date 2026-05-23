---
id: tlhf-vjga
status: open
deps: [tlhf-cysu]
links: []
created: 2026-05-23T09:53:08Z
type: task
priority: 1
assignee: Diego Petrucci
parent: tlhf-oxht
---
# Phase 4: migrate keybindings defaults and install-state writers

Adopt the shared safe profile write helper for scripts/merge-keybindings.mjs, scripts/tlh-defaults.mjs, and scripts/tlh-install-state.mjs after merge-settings proves the pattern.

## Acceptance Criteria

Each writer uses the shared helper or an explicitly documented shared wrapper; installed tlh-defaults import resolution remains valid; targeted tests cover normal Pi rejection, symlink/parent-swap, backup leak prevention where applicable, mode behavior, and dry-run behavior; npm run validate passes.


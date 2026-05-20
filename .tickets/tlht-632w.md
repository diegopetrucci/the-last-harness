---
id: tlht-632w
status: open
deps: []
links: []
created: 2026-05-20T19:03:26Z
type: task
priority: 2
assignee: Diego Petrucci
tags: [simplification, default-extensions]
---
# Extract shared default-extension helpers

Reduce duplication between scripts/merge-settings.mjs and scripts/tlh-defaults.mjs by moving shared default-extension manifest parsing, package identity, replacement, and critical opt-out helpers into a focused scripts/lib module.

## Acceptance Criteria

merge-settings and tlh-defaults use shared helpers for duplicated default-extension behavior; user-facing CLI behavior remains unchanged; default-extension and merge-settings tests cover the shared path and pass.


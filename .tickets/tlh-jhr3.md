---
id: tlh-jhr3
status: open
deps: []
links: []
created: 2026-05-17T17:51:52Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Split oversized The Last Harness extension module

Refactor extensions/the-last-harness.ts into smaller cohesive modules because the current file is too large to review comfortably.

## Acceptance Criteria

extensions/the-last-harness.ts delegates distinct responsibilities to smaller files, public extension behaviour is unchanged, exported package resources still resolve, and the relevant syntax/smoke checks pass.


---
id: tlht-d31a
status: open
deps: [tlhf-oxht, tlht-i7z3]
links: [tlht-41ov]
created: 2026-05-20T19:03:26Z
type: task
priority: 2
assignee: Diego Petrucci
tags: [simplification, tickets]
---
# Split tlh-tickets helper by concern

Break scripts/tlh-tickets.mjs into smaller, reviewable modules for CLI dispatch, settings state, safe file operations, archive download/extraction, and managed tk install behavior without changing user-facing commands.

## Design

Do this after or alongside shared safe-write/helper extraction so security-sensitive behavior is not moved twice.

## Acceptance Criteria

scripts/tlh-tickets.mjs is reduced to a thin CLI/orchestration layer; extracted modules have clear boundaries; existing ticket runtime and managed-install tests pass; no supported ticket command behavior changes.


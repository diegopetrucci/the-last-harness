---
id: tlht-i7z3
status: open
deps: [tlhf-oxht]
links: []
created: 2026-05-20T19:03:26Z
type: task
priority: 2
assignee: Diego Petrucci
tags: [simplification, managed-tools]
---
# Consolidate managed gn and tk helper logic

Review scripts/tlh-gnosis.mjs, scripts/tlh-tickets.mjs, and runtime integration helpers for duplicated managed-tool candidate resolution, validation, PATH handling, and isolated target checks. Extract shared logic only where gn and tk semantics actually match.

## Design

Keep mandatory Gnosis/ticket behavior explicit. Do not merge policy differences just to reduce lines.

## Acceptance Criteria

Shared managed-tool helper logic exists for genuinely common behavior or a short rationale documents why extraction is not safe; gnosis and ticket tests still pass; install/update behavior and isolation guarantees are unchanged.


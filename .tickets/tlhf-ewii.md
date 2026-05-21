---
id: tlhf-ewii
status: open
deps: []
links: [tlht-41ov, tlht-d5w7]
created: 2026-05-19T20:37:35Z
type: bug
priority: 1
assignee: Diego Petrucci
parent: tlhf-hkxd
---
# Codify critical default-extension invariants

Strengthen tests/docs around critical default extensions such as subagents and intercom so installer/settings/defaults changes cannot silently remove architect delegation or escalation support.

## Acceptance Criteria

Tests document that critical defaults cannot be disabled silently by package filters or opt-out state; critical sources remain validated after settings-wide refresh/fallback paths; docs state the invariant and intended user-facing failure behavior.


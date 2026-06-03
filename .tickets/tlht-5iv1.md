---
id: tlht-5iv1
status: open
deps: []
links: []
created: 2026-06-03T18:34:02Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Track default-extension provenance

Design and implement future provenance tracking for TLH-managed default extensions so retired defaults can be removed without deleting manually-added packages with the same source.

## Acceptance Criteria

A future implementation records which package entries TLH added or manages; retired-default cleanup can use provenance instead of source-only forced removal; migration/backward-compat behavior is documented and tested.


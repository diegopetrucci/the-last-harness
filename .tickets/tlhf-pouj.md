---
id: tlhf-pouj
status: open
deps: [tlhf-pbnd]
links: []
created: 2026-05-23T09:53:08Z
type: task
priority: 1
assignee: Diego Petrucci
parent: tlhf-oxht
---
# Phase 6: migrate managed Gnosis writes to safe helper

Replace duplicated managed Gnosis target write safety code with the shared safe profile write helper after lower-risk call sites are proven.

## Acceptance Criteria

scripts/tlh-gnosis.mjs uses the shared helper for managed gn writes without weakening mandatory Gnosis behavior; existing Gnosis tests remain green; added tests cover ticket-grade parent/target swap and cleanup behavior; npm run validate passes.


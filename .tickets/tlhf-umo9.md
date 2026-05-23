---
id: tlhf-umo9
status: open
deps: [tlhf-pouj]
links: []
created: 2026-05-23T09:53:08Z
type: task
priority: 1
assignee: Diego Petrucci
parent: tlhf-oxht
---
# Phase 7: migrate managed tk writes to safe helper

Replace duplicated ticket-grade managed tk/settings write primitives with the shared helper once the helper has been exercised by other migrations.

## Acceptance Criteria

scripts/tlh-tickets.mjs reuses the shared helper for managed tk and settings writes without weakening existing guarantees; existing adversarial tk tests remain green or are moved to shared-helper coverage with equivalent assertions; npm run validate passes.


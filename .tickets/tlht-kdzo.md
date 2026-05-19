---
id: tlht-kdzo
status: closed
deps: [tlht-x3hh, tlht-1abq, tlht-u8tb]
links: []
created: 2026-05-19T06:50:15Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlht-xnip
---
# Update TLH extension tests and run validation

Adjust brittle static tests to the new module layout or replace them with equivalent checks, then run the repository validation commands relevant to the refactor.

## Acceptance Criteria

npm test passes; bash scripts/check-installer-smoke.sh passes; node scripts/merge-settings.mjs --dry-run passes; npm pack --dry-run passes; test coverage still checks primary-default reapplication and multi-primary/subagent safety wiring in the refactored layout.

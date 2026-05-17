---
id: tlh-t9ij
status: closed
deps: [tlh-jy6g]
links: []
created: 2026-05-16T13:54:02Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlh-va7o
---
# Update installer validation and docs for decomposition

Update smoke/unit tests and documentation/release guidance to reflect the stage-0/stage-1 installer split.

## Acceptance Criteria

bash scripts/check-installer-smoke.sh, npm test, node scripts/merge-settings.mjs --dry-run, and npm pack --dry-run pass; docs mention the stage-0 bootstrap/stage-1 helper relationship where relevant.


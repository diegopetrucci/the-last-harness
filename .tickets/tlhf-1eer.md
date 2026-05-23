---
id: tlhf-1eer
status: open
deps: [tlhf-6y8r]
links: []
created: 2026-05-23T09:53:08Z
type: task
priority: 1
assignee: Diego Petrucci
parent: tlhf-oxht
---
# Phase 2: package safe profile write helper for installer support scripts

Make the shared helper available to stage-1 and installed support scripts without otherwise changing write behavior.

## Acceptance Criteria

scripts/lib/tlh-install-support-manifest.mjs and install.sh bootstrap manifest include the helper consistently; installed helper paths resolve when copied under agent/tlh/lib; installer smoke and npm run validate pass; no production call-site migration is included except any minimal import-resolution test.


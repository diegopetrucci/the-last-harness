---
id: tlht-kvbh
status: closed
deps: [tlht-ayh8, tlht-o00e]
links: []
created: 2026-05-19T10:45:59Z
type: task
priority: 2
assignee: Diego Petrucci
tags: [docs, tests, installer]
---
# Update install docs and smoke coverage

Update public install examples to use the simpler no-env latest-release command, and ensure smoke/tests cover both no-argument Bash invocation and release-default update track behavior.

## Acceptance Criteria

README/docs one-line install examples no longer require TLH_UPDATE_TRACK for latest release; release checklist examples align with the new default; validation commands pass: bash scripts/check-installer-smoke.sh, npm test, node scripts/merge-settings.mjs --dry-run, npm pack --dry-run.

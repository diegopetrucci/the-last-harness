---
id: tlha-1pz8
status: closed
deps: [tlha-aq3w, tlha-9qhr]
links: []
created: 2026-05-16T08:41:44Z
type: task
priority: 1
assignee: Diego Petrucci
---
# Validate installer safety fixes

Run focused and standard validation after the critical-default and Gnosis target fixes are implemented.

## Acceptance Criteria

Focused default-extension tests pass; focused Gnosis/smoke coverage passes; bash -n install.sh, node --check for changed Node scripts, bash scripts/check-installer-smoke.sh, node scripts/merge-settings.mjs --dry-run, and npm pack --dry-run are run or documented with any reason they could not run.


---
id: tlh-nt4r
status: open
deps: []
links: []
created: 2026-06-24T19:17:28Z
type: task
priority: 2
assignee: Diego Petrucci
external-ref: gh-187
tags: [stress-test, default-extensions, pi-subagents]
---
# Eliminate pi-subagents dirty-checkout backup warning on fresh install

Stress testing PR #187 found that a fresh isolated temp install prints a dirty checkout backup warning for github.com/diegopetrucci/pi-subagents and creates a refs/tlh-backup/... ref, even though the pi-subagents checkout ends clean. This is noisy during otherwise successful installs and should be investigated in the fork/update path.

## Acceptance Criteria

Fresh isolated install of bundled defaults completes without a dirty-checkout warning for pi-subagents; no refs/tlh-backup ref is created for a clean install; subagent discovery still lists the TLH minor agents and a read-only web-scout smoke can run successfully.


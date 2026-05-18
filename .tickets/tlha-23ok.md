---
id: tlha-23ok
status: closed
deps: [tlha-73sw]
links: []
created: 2026-05-17T20:07:37Z
type: task
priority: 2
assignee: Diego Petrucci
tags: [installer, performance, validation]
---
# Validate and benchmark batched installer

Run the relevant installer checks, then benchmark a fresh temp install from the local changed installer and compare against the scratch v0.7.0 baseline in tlh-installer-performance-baseline.tmp.

## Acceptance Criteria

Run syntax/unit/smoke checks appropriate to the installer change. Run a fresh temp install measurement without touching ~/.pi/agent. Report elapsed time, phase comparison, and whether the batched install improved over the v0.7.0 baseline. Leave scratch benchmark notes unstaged/ignored and do not commit them.

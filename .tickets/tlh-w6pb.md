---
id: tlh-w6pb
status: closed
deps: [tlh-k9li]
links: []
created: 2026-05-17T19:16:28Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Update TLH bundled intercom pin

In /Users/diegopetrucci/Developer/the-last-harness, update the bundled default intercom extension reference from tlh-v0.6.0-1 to the new validated/published pi-intercom tag. Update user-facing docs/changelog if the bundled behavior or pin is documented.

## Acceptance Criteria

config/default-extensions.json points intercom to the new tag. README/CHANGELOG are updated if needed. TLH validation commands include node scripts/merge-settings.mjs --dry-run, bash scripts/check-installer-smoke.sh, and npm pack --dry-run.


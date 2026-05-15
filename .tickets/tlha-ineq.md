---
id: tlha-ineq
status: closed
deps: [tlha-jk5w]
links: []
created: 2026-05-15T18:39:58Z
type: task
priority: 1
assignee: Diego Petrucci
---
# Update critical-default docs and tests

Update repository tests and user-facing guidance to match the protected critical-default behavior.

## Acceptance Criteria

Automated tests cover rejecting critical disables and stale/manual critical opt-outs being ignored or cleaned; README/docs/installer error text no longer suggest critical subagents/intercom can be disabled as recovery; relevant validation commands pass.


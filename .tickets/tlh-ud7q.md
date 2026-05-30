---
id: tlh-ud7q
status: open
deps: []
links: []
created: 2026-05-30T08:27:13Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Investigate stale supervisor contact after child session exit

Session audit found cases where contact_supervisor/intercom requests timed out or replies appeared after the child subagent was no longer reachable. Investigate whether this is a contact_supervisor timeout, intercom target lifetime, async run cleanup, or reporting issue before changing UX defaults.

## Acceptance Criteria

Investigation identifies the root cause or narrow failure mode for stale supervisor/contact messages, cites at least one real session trace or reproducible scenario, and recommends whether the fix belongs in TLH guidance, pi-subagents, pi-intercom, or contact_supervisor behavior.


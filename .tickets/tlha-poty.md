---
id: tlha-poty
status: closed
deps: [tlha-16ll, tlha-zto0]
links: []
created: 2026-05-15T21:38:49Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Expose research and oracle subagents

Wire librarian and oracle into the same TLH bundled-subagent allowlist, installer/docs, tests, architect prompt, README if helpful, and changelog path as the bug investigation agents.

## Acceptance Criteria

ALLOWED_SUBAGENTS includes librarian and oracle; architect prompt lists them as read-only advisory/research agents and describes when the parent should use them; installer/manual install prompt lists include both files; tests cover allowed execution; changelog notes them; focused validation passes.


---
id: tlha-zto0
status: closed
deps: [tlha-ftmn]
links: []
created: 2026-05-15T21:21:39Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Expose bundled bug investigation subagents

Wire the new bug-hunter and bug-catcher agents into TLH bundled-subagent discovery, architect guardrails, installer prompt copying, manual install docs, tests, and changelog.

## Acceptance Criteria

ALLOWED_SUBAGENTS includes bug-hunter and bug-catcher; architect prompt lists both and describes the parent-run bug-hunter then bug-catcher workflow; installer/manual install prompt lists include both files; subagent-safety tests cover allowed and disallowed behavior for the new agents; changelog notes the added agents and parent-orchestrated second-opinion behavior; focused validation passes.


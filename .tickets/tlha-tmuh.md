---
id: tlha-tmuh
status: closed
deps: []
links: []
created: 2026-05-15T21:04:58Z
type: task
priority: 2
assignee: Diego Petrucci
tags: [docs, subagents, architect]
---
# Clarify architect-off subagent guardrail boundary

Update documentation to make clear that TLH subagent validation/guardrails apply only while architect mode is enabled, and that /architect off opts out of the architect persona's subagent safety workflow while the bundled subagent tool remains available.

## Acceptance Criteria

README /architect docs state the architect-off boundary for subagent validation. CHANGELOG wording qualifies forced user-scope/fresh-context subagent behavior as applying in architect mode. No source code behavior changes.


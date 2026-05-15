---
id: tlha-7u0b
status: closed
deps: []
links: []
created: 2026-05-15T19:10:35Z
type: bug
priority: 1
assignee: Diego Petrucci
---
# Harden and test TLH subagent safety gates

Address review items 2, 3, and 7 for the TLH extension. Future-proof architect subagent execution so only fresh child contexts are allowed, and add local tests around the guard and child-extension early-return behavior.

## Design

Keep enforcement in the TLH extension, not in pi-subagents. Validate/force top-level context as today, and additionally reject nested context fields in tasks[], chain[], and chain[].parallel[] unless they are omitted or explicitly fresh. Preserve allowed TLH minor-agent targets and user-scope forcing. Create a narrow test harness/export for pure guard logic and an injectable extension startup test path if needed; avoid requiring real child process launches.

## Acceptance Criteria

Tests cover validateSubagentToolInput allowing approved execution and management calls; forcing agentScope to user; blocking resume/unsafe actions; rejecting disallowed agents; rejecting non-fresh top-level and nested contexts; and PI_SUBAGENT_CHILD=1 registering only child prompt behavior without architect/Gnosis/tool gating. Existing architect behavior remains unchanged for valid calls.


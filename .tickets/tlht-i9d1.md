---
id: tlht-i9d1
status: closed
deps: []
links: []
created: 2026-05-19T09:27:17Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlht-16fm
---
# Preserve TLH session_start failure semantics

Adjust the refactored extension startup wiring so primary-agent session_start work and UI startup work have the same failure semantics as the former monolithic handler.

## Acceptance Criteria

On normal startup, primary defaults still apply before UI setup. If primary startup throws, UI startup is not run from a separate independent handler. Child subagent startup still returns before parent commands/hooks are registered.

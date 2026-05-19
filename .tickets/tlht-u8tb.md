---
id: tlht-u8tb
status: closed
deps: [tlht-1j5k]
links: []
created: 2026-05-19T06:50:15Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlht-xnip
---
# Extract TLH primary-agent runtime wiring

Move primary-agent runtime state, command handlers, shortcut handling, model/thinking/tool application, and subagent safety hook wiring into a nested controller/registration module, leaving extensions/the-last-harness.ts primarily responsible for startup composition and event registration.

## Acceptance Criteria

The /tlh, /harness, /agent, /architect, Shift+Tab cycle, before_agent_start primary prompt/tool behavior, session overrides, persistent defaults, and subagent safety gate behave as before.

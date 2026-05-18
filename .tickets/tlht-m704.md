---
id: tlht-m704
status: closed
deps: [tlht-9qyj]
links: []
created: 2026-05-17T18:35:08Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Document product primary agent

Update user-facing documentation for TLH multi-primary behavior. README should describe architect vs product primary agents, Shift+Tab cycling through architect/product/disabled, /agent selection/status/default controls, /architect compatibility, and the product agent's non-implementation scope. CHANGELOG Unreleased should note the product primary and multi-primary switching.

## Acceptance Criteria

Docs mention how persistent primary-agent changes are stored/reset in the isolated TLH settings; docs do not mention unsupported @explore or a stale KNOWLEDGEBASE-only workflow.

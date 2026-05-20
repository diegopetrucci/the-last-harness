---
id: tlhf-7ppe
status: open
deps: [tlhf-epkn]
links: []
created: 2026-05-20T19:31:56Z
type: feature
priority: 2
assignee: Diego Petrucci
tags: [footer, primary-agent, context, ui]
---
# Move context usage next to selected primary agent

After the agent/model/thinking grouping exists, move the footer context-usage display into the same adjacent group near the selected primary (main) agent so the user can read agent, model, thinking, and context status together.

## Acceptance Criteria

Footer output shows selected primary agent, active model/thinking, and context usage together; dumb-zone warning and context warning/error styling are preserved; cost display remains visible when applicable and narrow terminal widths degrade gracefully without hiding critical status; targeted tests or static assertions are updated; npm run validate passes.


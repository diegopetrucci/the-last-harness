---
id: tlhf-epkn
status: open
deps: []
links: []
created: 2026-05-20T19:31:56Z
type: feature
priority: 2
assignee: Diego Petrucci
tags: [footer, primary-agent, ui]
---
# Move model and thinking next to selected primary agent

In the TLH footer, the active model/thinking display currently lives away from the selected primary (main) agent line. Rework the footer presentation so the active model and thinking effort are shown adjacent to the selected primary agent, making the selected agent and its runtime model/effort easy to scan together.

## Acceptance Criteria

Footer output places selected primary agent and active model/thinking in the same adjacent group/line; provider display, no-model, non-reasoning models, and thinking-off states remain readable; existing context/cost stats remain intact until the follow-up context ticket; targeted tests or static assertions are updated; npm run validate passes.


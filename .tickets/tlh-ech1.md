---
id: tlh-ech1
status: closed
deps: [tlh-txjo]
links: []
created: 2026-05-15T10:35:05Z
type: feature
priority: 2
assignee: Diego Petrucci
---
# Bind Shift+Tab to primary-agent cycling

Use the freed Shift+Tab chord in TLH interactive sessions to cycle the supported main-agent state.

## Design

Current TLH supports architect and disabled only, so cycling is architect <-> disabled via the same session override mechanism used by /architect toggle. Preserve /effort as the reasoning-effort control.

## Acceptance Criteria

The TLH extension registers Shift+Tab to toggle the effective primary agent between architect and disabled; the shortcut updates the same session override state as /architect toggle and reapplies primary tools; notifications clearly state the new primary agent; /agent and the footer reflect the changed state; README documents Shift+Tab and that /effort remains the effort control.

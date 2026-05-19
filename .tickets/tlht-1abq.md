---
id: tlht-1abq
status: closed
deps: [tlht-1j5k]
links: []
created: 2026-05-19T06:50:15Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlht-xnip
---
# Extract TLH Gnosis, prompt, autocomplete, and UI chrome helpers

Move Gnosis slash-command support, agent markdown/system-prompt loading, autocomplete source-tag cleanup, startup resource collection, header rendering, footer rendering, and formatting helpers into nested modules.

## Acceptance Criteria

The /gnosis command, Gnosis prompt injection, startup header, footer, autocomplete descriptions, and resource labels behave as before; no new top-level extension files are discoverable.

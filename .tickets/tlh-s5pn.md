---
id: tlh-s5pn
status: open
deps: []
links: []
created: 2026-05-17T17:51:52Z
type: chore
priority: 2
assignee: Diego Petrucci
---
# Sort default extension manifest alphabetically

Review config/default-extensions.json and organise bundled default extension entries alphabetically if the manifest structure allows it without changing installer behaviour.

## Acceptance Criteria

Either config/default-extensions.json entries are sorted alphabetically by a clear stable key (for example package/name) with no semantic changes, or a note documents why alphabetical ordering is not possible/safe. Existing opt-out and merge behaviour remains unchanged.


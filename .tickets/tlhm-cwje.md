---
id: tlhm-cwje
status: open
deps: []
links: []
created: 2026-06-03T10:42:08Z
type: feature
priority: 4
assignee: Diego Petrucci
tags: [backlog, context-cap, core]
---
# Move context cap into TLH core

Backlog only: later replace the bundled context-cap default extension with equivalent TLH-core behavior so context capping is a core feature instead of a separate default extension.

## Design

Preserve the current 200k effective context-window cap semantics, opt-out/migration behavior, and a user-visible status/check command or equivalent. Remove the default extension dependency only after parity is covered by tests and docs.

## Acceptance Criteria

TLH core applies the 200k effective context-window cap without relying on the context-cap default extension; users retain an opt-out or equivalent control; installer/default-extension migration is conservative; footer remains quiet by default; tests and README/docs are updated.


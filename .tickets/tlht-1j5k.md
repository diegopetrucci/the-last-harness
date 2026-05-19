---
id: tlht-1j5k
status: closed
deps: []
links: []
created: 2026-05-19T06:50:14Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlht-xnip
---
# Extract TLH shared constants and safe profile utilities

Create nested helper module(s) for shared constants, prompt text, settings types, common object/env/path helpers, package/version helpers, and isolated-profile path/state primitives currently embedded in extensions/the-last-harness.ts.

## Acceptance Criteria

Shared helpers are imported from extensions/the-last-harness.ts using .js specifiers; duplicated helpers are avoided; symlink/path safety semantics for isolated TLH profile state are unchanged.

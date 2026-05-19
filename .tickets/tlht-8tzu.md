---
id: tlht-8tzu
status: closed
deps: []
links: []
created: 2026-05-19T09:27:17Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlht-16fm
---
# Clean TLH ticket EOF whitespace

Remove trailing blank-line/whitespace issues in new ticket files reported by Oracle so diff whitespace checks are clean.

## Acceptance Criteria

git diff --check reports no whitespace errors for the working tree.

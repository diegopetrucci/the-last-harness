---
id: tlh-vfkrm
status: closed
deps: [tlh-qiovm, tlh-yinmw]
links: []
created: 2026-05-20T13:00:00Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Update architect and product delegate references

Remove bug-hunter/bug-catcher from the subagent delegate lists in the other primaries:

- agents/primary/architect.md: drop the bug-hunter and bug-catcher bullets from the subagents list. Add a brief note that for bug investigations the user can switch to the bug-hunter primary (Shift+Tab or /agent bug-hunter).
- agents/primary/product.md: remove bug-hunter from the discovery/delegate sentence; keep repo-scout and librarian.

ready for implementation


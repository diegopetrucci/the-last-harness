---
id: tlh-lkfda
status: closed
deps: [tlh-qiovm, tlh-yinmw]
links: []
created: 2026-05-20T13:00:06Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Update README for bug-hunter primary

Reflect the new primary in user-facing docs:

- README.md primary-agent intro: add a short paragraph describing bug-hunter as a read-only investigation primary (peer to architect/product).
- Shift+Tab cycle line: update to 'architect -> product -> bug-hunter -> disabled'.
- /agent command help line: include 'bug-hunter' and 'default bug-hunter' in the accepted-values list.
- TLH subagents paragraph: remove the bug-hunter/bug-catcher mention (those are no longer subagents).
- Keep the /architect compat description unchanged.

ready for implementation


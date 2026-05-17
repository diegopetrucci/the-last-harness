---
id: tlh-4oug
status: closed
deps: [tlh-8wuh]
links: []
created: 2026-05-16T13:54:02Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlh-va7o
---
# Extract tested installer libraries from shell/inline Node logic

Move path safety/profile writes, package-source parsing, confined git checkout refresh, support-file resolution, and subagent prompt discovery/copying into scripts/lib modules consumed by stage-1 and helper CLIs where appropriate.

## Acceptance Criteria

Inline Node parsers are removed from install.sh; duplicated package/path logic is reduced; targeted node tests cover package-source parsing, normal-Pi/path guards, and subagent prompt discovery/copy behavior.


---
id: tlh-jy6g
status: closed
deps: [tlh-6yfv, tlh-4oug]
links: []
created: 2026-05-16T13:54:02Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlh-va7o
---
# Shrink install.sh to bootstrap stage-1

Replace normal install logic in install.sh with a small Bash bootstrapper that invokes scripts/tlh-install.mjs from local or fetched support files.

## Acceptance Criteria

Pipe-to-bash --dry-run still performs no downloads/writes; missing required helper preflight still happens before pi/npm/git mutation; release ref pinning still works; bash -n install.sh passes.


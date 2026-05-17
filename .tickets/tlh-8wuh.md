---
id: tlh-8wuh
status: closed
deps: []
links: []
created: 2026-05-16T13:54:01Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlh-va7o
---
# Add stage-1 installer helper skeleton and shared support manifest

Create scripts/tlh-install.mjs with argument/env parsing equivalent to install.sh and support-file manifest handling needed by the bootstrapper, without changing the active installer path yet.

## Acceptance Criteria

node --check scripts/tlh-install.mjs passes; helper supports --help and --dry-run; support-file manifest includes existing required/optional files plus any new library files; no install.sh behavior changes are wired yet.


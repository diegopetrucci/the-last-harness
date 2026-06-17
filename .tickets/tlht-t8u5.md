---
id: tlht-t8u5
status: open
deps: []
links: []
created: 2026-06-16T19:46:20Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Add tiny self-contained tlh update recovery launcher

Future PR: design and add a minimal profile-resident recovery updater that can restore/run TLH update when the installed package checkout is missing or corrupt. It should read tlh/install-state.json and avoid depending on the copied helper library tree.

## Acceptance Criteria

A tiny self-contained recovery launcher exists in the isolated profile; it can recover/update from install-state.json when package checkout helpers are unavailable; behavior is covered by tests or smoke checks; normal helper subcommands still prefer package checkout scripts.


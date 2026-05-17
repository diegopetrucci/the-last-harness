---
id: tlh-6yfv
status: closed
deps: [tlh-8wuh]
links: []
created: 2026-05-16T13:54:01Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlh-va7o
---
# Move installer orchestration into stage-1 helper

Port normal install phases from install.sh into scripts/tlh-install.mjs, reusing existing helper CLIs for settings, keybindings, defaults, Gnosis, wrapper, and install-state.

## Acceptance Criteria

Stage-1 can run the current install flow from a local checkout with temporary --agent-dir/--bin-dir; Pi commands remain isolated with PI_CODING_AGENT_DIR; no writes occur in --dry-run.


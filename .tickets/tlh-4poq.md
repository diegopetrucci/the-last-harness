---
id: tlh-4poq
status: closed
deps: [tlh-gv33, tlh-ech1]
links: []
created: 2026-05-15T10:35:13Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Validate TLH Shift+Tab keybinding behavior

Add or update focused tests and run repository readiness checks for the keybinding-defaults and Shift+Tab changes.

## Acceptance Criteria

Automated tests cover keybinding default merge behavior, especially preserving existing user keybindings; repository checks pass: bash -n install.sh, node --check scripts/merge-settings.mjs, node --check scripts/tlh-defaults.mjs, node --check scripts/tlh-gnosis.mjs, node --check any new script, npm test, npm pack --dry-run.


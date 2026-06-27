---
id: tlha-0eo8
status: closed
deps: []
links: []
created: 2026-06-27T08:23:20Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlha-xn6b
tags: [typescript, migration, installer]
---
# Migrate merge-keybindings CLI to runtime TypeScript

Convert scripts/merge-keybindings.mjs to the runtime TypeScript source/emit pattern by adding scripts/merge-keybindings.mts as source of truth and regenerating the committed .mjs output. Keep isolated-profile keybinding merge behavior unchanged.

## Acceptance Criteria

scripts/merge-keybindings.mts exists and emits fresh scripts/merge-keybindings.mjs; runtime TypeScript infra tracks this top-level CLI; support manifests/install.sh continue referencing the generated .mjs path; focused validation passes: npm run typecheck:runtime, npm run check:runtime, node --test tests/keybindings-merge.test.mjs tests/runtime-typescript-infra.test.mjs, and relevant installer smoke/static checks.


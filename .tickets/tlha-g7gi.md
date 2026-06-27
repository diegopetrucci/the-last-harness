---
id: tlha-g7gi
status: closed
deps: [tlha-0eo8]
links: []
created: 2026-06-27T08:23:20Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlha-xn6b
tags: [typescript, migration, installer]
---
# Migrate merge-settings CLI to runtime TypeScript

Convert scripts/merge-settings.mjs to the runtime TypeScript source/emit pattern by adding scripts/merge-settings.mts as source of truth and regenerating the committed .mjs output. Preserve conservative isolated settings merge behavior.

## Acceptance Criteria

scripts/merge-settings.mts exists and emits fresh scripts/merge-settings.mjs; runtime TypeScript infra tracks this top-level CLI; support manifests/install.sh continue referencing the generated .mjs path; focused validation passes: npm run typecheck:runtime, npm run check:runtime, node --test tests/merge-settings.test.mjs tests/default-extensions.test.mjs tests/runtime-typescript-infra.test.mjs, and relevant installer smoke/static checks.


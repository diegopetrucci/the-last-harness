---
id: tlha-31ut
status: closed
deps: [tlha-3f7f]
links: []
created: 2026-06-27T08:23:20Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlha-xn6b
tags: [typescript, migration, installer, update]
---
# Migrate tlh-update CLI to runtime TypeScript

Convert scripts/tlh-update.mjs to the runtime TypeScript source/emit pattern by adding scripts/tlh-update.mts as source of truth and regenerating the committed .mjs output. Preserve update-track, extension-only update, private runtime, and installer handoff behavior.

## Acceptance Criteria

scripts/tlh-update.mts exists and emits fresh scripts/tlh-update.mjs; runtime TypeScript infra tracks this top-level CLI; support manifests/install.sh continue referencing the generated .mjs path; focused validation passes: npm run typecheck:runtime, npm run check:runtime, update-focused tests in tests/install-stage1.test.mjs, tests/runtime-typescript-infra.test.mjs, and relevant installer smoke/static checks.


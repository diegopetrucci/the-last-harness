---
id: tlha-3f7f
status: closed
deps: [tlha-g7gi]
links: []
created: 2026-06-27T08:23:20Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlha-xn6b
tags: [typescript, migration, installer, wrapper]
---
# Migrate tlh-wrapper CLI to runtime TypeScript

Convert scripts/tlh-wrapper.mjs to the runtime TypeScript source/emit pattern by adding scripts/tlh-wrapper.mts as source of truth and regenerating the committed .mjs output. Preserve wrapper rendering, managed-wrapper detection, and helper subcommand routing.

## Acceptance Criteria

scripts/tlh-wrapper.mts exists and emits fresh scripts/tlh-wrapper.mjs; runtime TypeScript infra tracks this top-level CLI; support manifests/install.sh continue referencing the generated .mjs path; focused validation passes: npm run typecheck:runtime, npm run check:runtime, node --test tests/install-stage1.test.mjs tests/check-startup-performance.test.mjs tests/runtime-typescript-infra.test.mjs, plus wrapper-related smoke/static checks.


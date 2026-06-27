---
id: tlha-3euk
status: open
deps: [tlha-31ut]
links: []
created: 2026-06-27T08:23:20Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlha-xn6b
tags: [typescript, migration, installer]
---
# Migrate tlh-install CLI to runtime TypeScript

Convert scripts/tlh-install.mjs to the runtime TypeScript source/emit pattern by adding scripts/tlh-install.mts as source of truth and regenerating the committed .mjs output. This is the final high-risk top-level CLI migration and must preserve stage-1 installer behavior and exported test helpers.

## Acceptance Criteria

scripts/tlh-install.mts exists and emits fresh scripts/tlh-install.mjs; runtime TypeScript infra tracks this top-level CLI; install.sh and support manifests remain aligned with the generated .mjs path; exported helpers used by tests remain available; focused validation passes: npm run typecheck:runtime, npm run check:runtime, node --test tests/install-stage1.test.mjs tests/install-libs.test.mjs tests/runtime-typescript-infra.test.mjs, bash scripts/check-installer-smoke.sh, and npm run validate before PR.


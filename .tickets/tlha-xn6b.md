---
id: tlha-xn6b
status: open
deps: [tlha-fcjg]
links: []
created: 2026-06-27T07:37:14Z
type: task
priority: 2
assignee: Diego Petrucci
tags: [typescript, migration, installer]
---
# Plan migration of top-level installer CLIs to TypeScript

Future work: migrate top-level installer/runtime CLIs to the runtime TypeScript pattern where appropriate, including scripts/tlh-install.mjs, scripts/tlh-update.mjs, scripts/tlh-wrapper.mjs, scripts/merge-settings.mjs, and scripts/merge-keybindings.mjs.

## Acceptance Criteria

Migration plan or implementation covers the listed CLIs; generated .mjs outputs remain committed and fresh where .mts sources are introduced; install.sh and support-file manifests stay aligned; focused smoke tests for installer/update/settings paths pass.


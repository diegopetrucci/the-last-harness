---
id: tlht-azhc
status: open
deps: []
links: []
created: 2026-05-20T19:03:26Z
type: task
priority: 2
assignee: Diego Petrucci
tags: [simplification, installer]
---
# Derive stage-0 support manifest from stage-1 manifest

Reduce duplication between the install.sh support-file heredocs and scripts/lib/tlh-install-support-manifest.mjs while preserving the self-contained pipe-to-bash stage-0 installer.

## Design

Prefer generated stage-0 manifest content or a documented generation step; do not make pipe-to-bash installs depend on Node before the existing Node preflight.

## Acceptance Criteria

There is one practical source of truth or an automated generation/check path for the support manifest; scripts/check-installer-smoke.sh still proves stage-0/stage-1 alignment; release installer remains self-contained; stdin --dry-run no-download behavior is preserved.


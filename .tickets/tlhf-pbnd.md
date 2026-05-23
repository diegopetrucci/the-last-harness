---
id: tlhf-pbnd
status: open
deps: [tlhf-vjga]
links: []
created: 2026-05-23T09:53:08Z
type: task
priority: 1
assignee: Diego Petrucci
parent: tlhf-oxht
---
# Phase 5: route installer support profile copies through safe helper

Preserve existing installer APIs while internally delegating support directory and support-file copy writes to the shared safe profile write helper.

## Design

Prefer adapter-style changes in scripts/lib/tlh-install-paths.mjs so tlh-install.mjs and tlh-install-subagents.mjs call sites stay small.

## Acceptance Criteria

ensureSafeProfileDir/copySafeProfileFile or replacements delegate to the shared helper; support files and subagent prompt copies reject symlinked agent/tlh parents and paths outside the isolated profile; dry-run output remains stable; installer smoke and npm run validate pass.


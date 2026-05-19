---
id: tlhf-etnw
status: closed
deps: []
links: []
created: 2026-05-19T21:26:47Z
type: task
priority: 1
assignee: Diego Petrucci
parent: tlhf-oxht
---
# Add script-side TLH profile safe-write helper

Add or extend a shared helper in scripts/lib/tlh-install-paths.mjs for writes inside the isolated TLH agent profile. Prefer root-relative profile targets while preserving needed legacy absolute settings paths.

## Design

Use best-effort portable Node hardening: reject normal ~/.pi/agent; reject symlinked parent components and final symlinks; use mkdtemp under the target parent plus exclusive temp/backup creation; revalidate parent/final identity before rename; only clean up helper-owned temp dirs/files. Document residual TOCTOU risk where Node cannot provide openat/renameat-style anchoring.

## Acceptance Criteria

Helper supports top-level profile files and existing support-file targets; intentional dry-run/read-only flows remain unaffected; normal ~/.pi/agent is rejected; adversarial helper tests cover symlinked parent/final file, predictable temp pre-creation, backup collision/symlink, cleanup ownership, failed-write preservation, and residual-risk documentation/commenting.


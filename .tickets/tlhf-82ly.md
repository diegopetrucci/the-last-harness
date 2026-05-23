---
id: tlhf-82ly
status: open
deps: [tlhf-1eer]
links: []
created: 2026-05-23T12:07:03Z
type: task
priority: 1
assignee: Diego Petrucci
parent: tlhf-oxht
---
# Phase 2.5: harden safe profile helper before production migrations

Address oracle low-priority helper hardening items before migrating production write call sites.

## Design

Keep this as a small pre-migration gate after packaging plumbing and before merge-settings adopts the helper. Decide/document helper policy before broad use rather than discovering it during call-site migrations.

## Acceptance Criteria

Helper behavior is tested or documented for missing agent dirs, target equal to agent root, targets outside the configured profile, non-file target parents and final targets, exclusive writes, replace:false writes, permissive caller-supplied modes, symlink ancestors above agentRoot, and atomicity/backups expectations for future settings writes; any necessary code changes preserve Phase 1 safety guarantees and npm run validate passes.


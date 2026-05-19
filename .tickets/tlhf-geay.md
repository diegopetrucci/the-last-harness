---
id: tlhf-geay
status: closed
deps: [tlhf-gsew]
links: []
created: 2026-05-19T21:26:47Z
type: task
priority: 1
assignee: Diego Petrucci
parent: tlhf-oxht
---
# Validate narrowed safe-write migration

Add/adjust integration coverage and run project validation for the narrowed tlhf-oxht implementation.

## Design

Prefer existing test files for CLI flows and one focused helper test file if useful. Include the deferred-scope follow-up ticket tlhf-gqbg in final reporting rather than implementing deferred work.

## Acceptance Criteria

Tests cover rejected ~/.pi/agent, symlinked parents/final settings file, predictable temp path pre-creation, backup collision/symlink safety, failed write preservation, dry-run creates nothing, and support-copy cleanup ownership where practical; existing installer smoke/lint/merge dry-run/npm pack validations pass; root false artifact remains absent; tlhf-oxht can be closed.


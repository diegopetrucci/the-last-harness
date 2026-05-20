---
id: tlht-kab0
status: closed
deps: []
links: []
created: 2026-05-20T19:03:26Z
type: task
priority: 2
assignee: Diego Petrucci
tags: [simplification, validation]
---
# Add aggregate repository validation script

Add one package-level validation command that wraps the full local/CI readiness sequence currently repeated across CI and docs. Update references so future validation command changes have one obvious source.

## Acceptance Criteria

package.json exposes an aggregate validation script; the script runs installer smoke checks, npm test, npm run lint, merge-settings dry-run, and npm pack dry-run; CI/docs/AGENTS/releasing references are updated or intentionally left stricter with explanation; existing validation behavior is not weakened.


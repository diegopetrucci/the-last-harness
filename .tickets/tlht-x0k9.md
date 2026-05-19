---
id: tlht-x0k9
status: closed
deps: [tlht-i9d1, tlht-85nt, tlht-8tzu]
links: []
created: 2026-05-19T09:27:17Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlht-16fm
---
# Validate Oracle follow-up fixes

Run targeted tests plus repository validation after Oracle follow-up fixes.

## Acceptance Criteria

node --test tests/the-last-harness-extension-static.test.mjs passes; relevant primary/subagent tests pass; npm test passes; bash scripts/check-installer-smoke.sh passes; node scripts/merge-settings.mjs --dry-run passes; npm pack --dry-run passes; git diff --check passes.

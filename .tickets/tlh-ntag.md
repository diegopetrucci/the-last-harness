---
id: tlh-ntag
status: closed
deps: []
links: []
created: 2026-06-21T15:39:36Z
type: task
priority: 2
assignee: Diego Petrucci
tags: [typescript, typecheck, follow-up]
---
# Ratchet TypeScript validation strictness flags

Follow-up from PR #173 review: incrementally raise TypeScript validation beyond the initial conservative tsconfig. `strict: true` appears currently viable; `noUncheckedIndexedAccess` currently exposes indexed-access debt and should be enabled separately after targeted fixes. Do not address this as part of the PR #173 immediate review-fix pass.

## Acceptance Criteria

TypeScript strictness ratchet path is tracked; strict-mode and noUncheckedIndexedAccess are evaluated separately; npm run validate remains passing when any new flag is enabled.


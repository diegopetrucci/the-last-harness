---
id: tlha-pmjg
status: open
deps: []
links: []
created: 2026-05-20T12:07:11Z
type: task
priority: 3
assignee: Diego Petrucci
---
# Test pathological percent values in normalizeUsageWindow

tests/the-last-harness-subscription-usage.test.mjs covers happy path percent normalization (101.2 → 100, 42.34 → 42.3) but not pathological inputs: negative percent, NaN, Infinity, missing used/limit/remaining with no percent, percent provided as string '42%'. pickFiniteNumber drops most of these silently — add tests to lock in the failure-soft behavior. Deferred from session-usage review.

## Acceptance Criteria

1) New test cases covering: negative used_percent, NaN, Infinity, missing fields, and percent-as-string. 2) Each case either returns a sane fallback (undefined / 0 / 100) or the documented behavior. 3) No misleading 100% or 0% footers slip through. 4) Tests pass.

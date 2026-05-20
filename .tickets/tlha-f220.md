---
id: tlha-f220
status: open
deps: []
links: []
created: 2026-05-20T12:06:57Z
type: task
priority: 3
assignee: Diego Petrucci
---
# Drop or gate no-arg getSnapshot() fallback

In extensions/the-last-harness/subscription-usage.mjs, getSnapshot() with no provider argument returns the most recent snapshot across providers with no eligibility check. The footer always calls it with a provider, so this is unreachable today, but it is a footgun if a future call site forgets the argument. Either remove the no-arg branch, or require ctx and re-check eligibility. Deferred from session-usage review.

## Acceptance Criteria

1) getSnapshot() with no arg either throws/returns undefined, or requires ctx and re-checks eligibility. 2) All existing tests still pass. 3) No call sites in extensions/the-last-harness.ts or footer.ts are broken.

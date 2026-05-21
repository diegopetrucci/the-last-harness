---
id: tlha-0sl8
status: open
deps: []
links: []
created: 2026-05-20T12:06:57Z
type: task
priority: 3
assignee: Diego Petrucci
---
# Document and tighten clearProvider / ineligibleCacheKeys invariant

In extensions/the-last-harness/subscription-usage.mjs, refresh() on credential mismatch calls clearProvider(provider) and immediately re-sets ineligibleCacheKeys.set(provider, cacheKey). activateTarget() also calls clearProvider unconditionally on cache-key change. The lifecycle is functionally correct but subtle. Either (a) add a comment block explaining the invariant near both call sites, or (b) refactor so clearProvider does not drop ineligibleCacheKeys, and add a dedicated clearActiveSnapshot helper for cache-key transitions. Deferred from session-usage review.

## Acceptance Criteria

1) Either an explanatory comment near refresh() mismatch handling and activateTarget(), OR a refactor that separates 'clear active snapshot' from 'clear ineligibility flag'. 2) All existing tests still pass.

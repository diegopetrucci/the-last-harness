---
id: tlha-x7u0
status: open
deps: []
links: []
created: 2026-05-20T12:38:54Z
type: task
priority: 3
assignee: Diego Petrucci
---
# Tighten or drop vacuous regex assertion in tlha-vkgt rotation test

tests/the-last-harness-subscription-usage.test.mjs (the rotation test added in tlha-0qw3) iterates service.snapshots.keys() and runs a regex to assert no token material leaks. By the time the loop runs, activateTarget() has wiped the previous snapshot and the new fetch was throttled, so the map is empty and the loop body never executes. The assert.equal(fetchCalls, 1) is what actually catches the bug; the regex assertion is vacuously true. Either drop it, or replace it with an assertion that the snapshot for the ORIGINAL cacheKey is still present (which would also pin the throttle-not-wipe semantic). Deferred from final review.

## Acceptance Criteria

1) The vacuous regex assertion is either removed or replaced with a meaningful assertion (e.g. snapshot persistence for the original cacheKey before activateTarget runs). 2) Test still passes and still fails without the tlha-0qw3 fix.

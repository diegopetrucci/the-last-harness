---
id: tlha-nqky
status: open
deps: []
links: []
created: 2026-05-20T12:07:11Z
type: task
priority: 3
assignee: Diego Petrucci
---
# Test findClosestWeeklyWindow boundary heuristic

tests/the-last-harness-subscription-usage.test.mjs does not pin the findClosestWeeklyWindow heuristic. Add a test asserting that when multiple windows are present, the function prefers seven_day over fourteen_day, and rejects anything beyond MAX_WEEKLY_CANDIDATE_MS (e.g. 30 days). Deferred from session-usage review.

## Acceptance Criteria

1) Test with both seven_day and fourteen_day windows asserts seven_day is picked. 2) Test with only a thirty_day window asserts no weekly window is returned. 3) Test passes.

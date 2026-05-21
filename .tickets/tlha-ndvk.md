---
id: tlha-ndvk
status: open
deps: []
links: []
created: 2026-05-20T12:07:11Z
type: task
priority: 3
assignee: Diego Petrucci
---
# Test requestRender is a no-op when turn_end snapshot is unchanged

tests/the-last-harness-extension-usage-refresh.test.mjs covers one positive transition but does not pin the no-op case: when turn_end refreshes and the snapshot/eligibility are unchanged, tui.requestRender() must not be called. Add a regression test. Deferred from session-usage review. (Related to tlha-8qty which covers the storm case; this ticket covers the explicit no-op assertion.)

## Acceptance Criteria

1) New test seeds the service with a snapshot, fires turn_end with a fetch returning the same data, asserts requestRender call count does not increase. 2) Test passes.

---
id: tlha-2cs1
status: open
deps: []
links: []
created: 2026-05-15T19:10:35Z
type: bug
priority: 2
assignee: Diego Petrucci
---
# Fail closed for startup-state nofollow support

Address review item 6: make startup-state writes avoid silently dropping final-component symlink protection on platforms where fs.constants.O_NOFOLLOW is unavailable.

## Design

Prefer a small fail-closed change: if O_NOFOLLOW is unavailable, skip the startup-state write or otherwise avoid claiming symlink-safe atomic replacement. Keep startup state best-effort and avoid mutating normal Pi config.

## Acceptance Criteria

writeTlhStartupStateAtomically no longer uses O_NOFOLLOW || 0; behavior is fail-closed or equivalently guarded when O_NOFOLLOW is unavailable; comments or tests make the invariant clear; existing startup state behavior still works on platforms with O_NOFOLLOW.


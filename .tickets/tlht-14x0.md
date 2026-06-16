---
id: tlht-14x0
status: open
deps: [tlht-t8u5]
links: []
created: 2026-06-16T19:46:20Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Remove remaining copied helper fallback tree after recovery exists

Future PR: after the self-contained recovery updater is available, remove persistent profile copies of the broader helper scripts/libs that are only retained for fallback recovery.

## Acceptance Criteria

Profile no longer persists the update/defaults/tickets fallback script-and-lib tree except for the approved tiny recovery launcher/state; update recovery still works when package checkout is missing; defaults/tickets produce actionable guidance if package helpers are unavailable; tests/docs reflect the reduced profile contents.


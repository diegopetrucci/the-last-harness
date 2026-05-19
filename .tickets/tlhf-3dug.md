---
id: tlhf-3dug
status: closed
deps: []
links: []
created: 2026-05-19T12:35:27Z
type: feature
priority: 2
assignee: Diego Petrucci
tags: [footer, git]
---
# Add git footer parsing and formatting helpers

Add focused helper code for turning git porcelain-v2 branch/status data and optional PR metadata into TLH footer segments. Keep render-facing helpers synchronous and side-effect free.

## Acceptance Criteria

Porcelain-v2 parsing reports branch, staged, unstaged, untracked, conflict, ahead, and behind counts. Formatting emits only meaningful status indicators, never a clean checkmark, and uses PR #N when PR metadata is present. Unit coverage exercises clean, dirty, conflicted, ahead/behind, and PR cases.

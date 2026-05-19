---
id: tlht-1avy
status: closed
deps: [tlht-5thm]
links: []
created: 2026-05-19T11:28:14Z
type: task
priority: 2
assignee: Diego Petrucci
tags: [release, publish]
---
# Validate and publish v0.8.0

Run release validation for v0.8.0, commit release prep, tag v0.8.0, and push main plus the tag to trigger the GitHub Release workflow.

## Acceptance Criteria

Release validation passes per docs/releasing.md; release prep commit exists on main; annotated tag v0.8.0 exists and is pushed to origin; origin/main is pushed; working tree is clean after publishing.


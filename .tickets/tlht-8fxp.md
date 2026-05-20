---
id: tlht-8fxp
status: open
deps: []
links: []
created: 2026-05-20T19:03:26Z
type: task
priority: 2
assignee: Diego Petrucci
tags: [simplification, installer]
---
# Extract common installer CLI and path utilities

Identify repeated low-level helpers such as required-value parsing, JSON reads, shell quoting, backup path naming, realpath comparison, and normal-Pi guard patterns, then extract only the pieces that reduce duplication without obscuring safety-sensitive checks.

## Design

Coordinate with tlhf-oxht for safe profile writes; this ticket should not weaken or hide isolated-profile safety invariants.

## Acceptance Criteria

Highest-value duplicated helpers are centralized or explicitly left local with rationale; call sites remain clear and reviewable; normal ~/.pi/agent protection is preserved; focused tests/lint pass.


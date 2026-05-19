---
id: tlhf-krx4
status: open
deps: [tlhf-2sj4]
links: []
created: 2026-05-19T12:35:39Z
type: feature
priority: 2
assignee: Diego Petrucci
tags: [footer, ui]
---
# Render git status and PR segments in the TLH footer

Wire cached git footer metadata into the existing TLH footer first line. Replace the old branch parentheses with the existing bullet divider style between cwd, branch, status indicators, PR, and session name.

## Acceptance Criteria

Footer examples render as ~/repo • main, ~/repo • main • PR #42, ~/repo • main • +1 ~2 ?1 ↑1, and ~/repo • main • +1 ~2 ?1 ↑1 • PR #42. Existing usage/model, agent, steering hint, and extension-status lines keep their behavior. All rendered lines remain width-safe.

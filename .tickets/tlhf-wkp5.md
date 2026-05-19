---
id: tlhf-wkp5
status: open
deps: []
links: []
created: 2026-05-19T20:37:35Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlhf-hkxd
---
# Add mandatory final hygiene checklist

Update TLH agent/reviewer/developer guidance so final handoff checks consistently catch recurring process mistakes: untracked files, missing support files, root false artifacts, package manifests, and pack/smoke drift.

## Acceptance Criteria

Relevant AGENTS/agent prompt/docs guidance requires git status --short --untracked-files=all; checks for no root false artifact; confirms required new files are tracked and included in installer/package manifests when applicable; keeps guidance concise and non-invasive.


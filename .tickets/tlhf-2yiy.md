---
id: tlhf-2yiy
status: open
deps: []
links: []
created: 2026-05-19T20:37:35Z
type: bug
priority: 0
assignee: Diego Petrucci
parent: tlhf-hkxd
---
# Prevent subagent output=false from creating repo-root false

Investigate and fix the TLH/pi-subagents output handling path where boolean output: false can be treated as the string path false, creating an unintended repository-root file named false. Scope includes the local integration/wrapper surface needed for TLH sessions.

## Design

Start by reproducing with the narrowest subagent invocation that uses output: false. The fix should preserve intentional file outputs and file-only outputs while ensuring boolean false disables artifact writing.

## Acceptance Criteria

No subagent invocation with output: false writes a file named false in the cwd or repo root; a regression test or smoke check covers the failure; existing intentional output path behavior still works; final status shows no root false artifact.


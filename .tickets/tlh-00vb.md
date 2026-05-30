---
id: tlh-00vb
status: open
deps: []
links: []
created: 2026-05-30T08:27:13Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Define lifecycle for session-created ticket artifacts

TLH sessions repeatedly debated whether .tickets/*.md files created during agent workflows should be committed, deleted, or treated as ephemeral. Clarify the policy and make it harder to accidentally leave unwanted ticket artifacts in commits.

## Acceptance Criteria

Repo guidance clearly distinguishes persistent backlog tickets from per-session scratch tickets, cleanup instructions cover both tracked and untracked .tickets files, and validation or a documented check catches accidental session-only ticket artifacts before handoff.


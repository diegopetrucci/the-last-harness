---
id: tlh-e7ce
status: open
deps: []
links: []
created: 2026-05-30T08:27:13Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Teach git revision commands to separate pathspecs

Session audit found repeated fatal: bad revision errors from git commands that mixed revisions and file paths without --. Add repo guidance or a helper pattern for commands like git diff <rev> -- <path>.

## Acceptance Criteria

Agent-facing guidance includes the git -- separator pattern for revision-plus-path commands, at least one common example is documented, and future review/debug flows have a clear fallback when a revision may be absent.


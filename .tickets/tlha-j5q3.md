---
id: tlha-j5q3
status: open
deps: []
links: []
created: 2026-05-23T07:20:32Z
type: task
priority: 2
assignee: Diego Petrucci
tags: [primary-agent, ux, slash-commands]
---
# Remove /agent primary selector command

Follow-up outside the Rush PR: remove the /agent primary-agent slash command entirely. Rework runtime, tests, and user-facing docs so TLH no longer registers or advertises /agent. Before implementation, decide or preserve the supported replacement path for non-/agent primary selection (for example Shift+Tab cycling and any remaining compatibility commands) so users are not left without an intentional primary-switching flow.

## Design

Do not include this in PR #35. Treat /agent removal as a separate UX/API change because it affects primary selection, persistent defaults, docs, tests, and any compatibility expectations.

## Acceptance Criteria

The /agent command is no longer registered; /agent completions, usage strings, README/docs references, and static assertions are removed or updated; remaining supported primary-switching/default behavior is documented; /architect compatibility behavior is explicitly preserved or intentionally changed; npm run validate passes.


---
id: tlhn-l6po
status: closed
deps: []
links: []
created: 2026-05-20T13:31:17Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Make static subagent prompts ticket-conditional

Reword unconditional 'tk show <id>' instructions in agents/subagents/developer.md, agents/subagents/bug-hunter.md, agents/subagents/bug-catcher.md, agents/subagents/code-reviewer.md so they degrade safely. Use compact, consistent wording like: 'If the architect supplies a tk ticket ID and the tk command is available, run tk show <id> and treat the ticket as the source of truth; otherwise treat the supplied task brief and acceptance criteria as the source of truth.' Preserve each prompt's existing tone and surrounding structure.

## Acceptance Criteria

None of the four files contain an unconditional 'tk show <id>' mandate. Wording is consistent across the four prompts. No other behavioral guidance is changed. npm run lint and bash scripts/check-installer-smoke.sh pass.


---
id: tlht-j6y9
status: open
deps: []
links: []
created: 2026-06-16T19:46:20Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Evaluate package-based subagent prompt path migration

Future PR: evaluate moving bundled TLH subagent prompt loading away from copied profile files under tlh/agents/subagents toward package-checkout-owned files, including any settings migration needed for subagents.agentDirs.

## Acceptance Criteria

Decision is documented; if implemented, settings migration avoids duplicate/obsolete agentDirs and preserves existing user-owned settings; copied subagent prompts are not removed until the new path is validated.


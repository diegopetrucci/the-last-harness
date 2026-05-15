---
id: tlha-vgam
status: open
deps: []
links: []
created: 2026-05-15T19:10:35Z
type: bug
priority: 2
assignee: Diego Petrucci
---
# Normalize subagent agentDirs during settings merge

Address review item 5: avoid duplicate subagents.agentDirs entries when existing isolated settings use path-equivalent strings such as ./tlh/agents/subagents versus tlh/agents/subagents.

## Design

Special-case array merge semantics for the subagents.agentDirs path, or otherwise normalize string paths for that settings path only. Do not change generic array merge behavior for unrelated settings.

## Acceptance Criteria

merge-settings treats ./tlh/agents/subagents and tlh/agents/subagents as duplicates for subagents.agentDirs; it does not append a path-equivalent duplicate; unrelated arrays still use existing append semantics; tests cover the normalized dedupe.


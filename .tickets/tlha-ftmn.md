---
id: tlha-ftmn
status: closed
deps: []
links: []
created: 2026-05-15T21:21:39Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Add read-only bug investigation subagent prompts

Adapt the externally supplied opencode bug-hunter and bug-catcher prompts into bundled TLH pi-subagents markdown files under agents/subagents. Keep both agents read-only and make bug-catcher a second-opinion reviewer for bug-hunter analysis.

## Acceptance Criteria

agents/subagents/bug-hunter.md and agents/subagents/bug-catcher.md exist with Pi subagent frontmatter; both omit write/edit/subagent tools; prompts state bug-hunter never implements fixes; prompts state second-opinion review is parent-orchestrated rather than bug-hunter directly spawning bug-catcher.


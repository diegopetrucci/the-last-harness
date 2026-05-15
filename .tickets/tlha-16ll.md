---
id: tlha-16ll
status: closed
deps: [tlha-ftmn]
links: []
created: 2026-05-15T21:38:49Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Add read-only research and oracle subagent prompts

Add TLH pi-subagents markdown files for librarian and oracle. Librarian should use the existing librarian tool for external GitHub research; oracle should use the existing oracle tool for high-reasoning second opinions. Keep both read-only and prevent nested subagent orchestration.

## Acceptance Criteria

agents/subagents/librarian.md and agents/subagents/oracle.md exist with Pi subagent frontmatter; librarian tools include librarian plus read/grep/find/ls/contact_supervisor and omit write/edit/bash/subagent; oracle tools include oracle plus read/grep/find/ls/contact_supervisor and omit write/edit/bash/subagent; prompts tell agents to report missing key tools clearly and never implement fixes or delegate to subagents.


---
id: tlh-qiovm
status: closed
deps: []
links: []
created: 2026-05-20T12:59:33Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Author primary bug-hunter agent

Create agents/primary/bug-hunter.md derived from the current subagent. Reframe so the user talks to it directly (like architect/product). Drop the bug-catcher second-opinion sections entirely. Frontmatter: model anthropic/claude-opus-4-7, thinking: high, systemPromptMode: append, inheritProjectContext: true, inheritSkills: false. Tools: read, grep, find, ls, bash, subagent, intercom (no contact_supervisor). Keep the read-only posture: bug-hunter never edits source or implements fixes; output is investigation, evidence, suggested fix. Body should mention that for repo discovery it may delegate to repo-scout via the subagent tool, and for external research to librarian/oracle. Final report format same as before minus the second-opinion section.

ready for implementation


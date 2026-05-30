---
id: tlh-bcxp
status: open
deps: []
links: []
created: 2026-05-30T08:27:13Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Add guardrails for multi-path tool arguments

Session audit found repeated path-not-found failures caused by passing multiple space-separated paths as one tool path argument. Add guidance, examples, or lightweight validation so agents use separate tool calls/globs or shell commands when searching multiple paths.

## Acceptance Criteria

Agent-facing guidance or tooling explains how to search/read multiple paths safely, includes an example contrasting invalid space-separated tool paths with supported globs or separate calls, and reduces the chance of path-not-found retries.


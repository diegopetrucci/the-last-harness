---
id: tlhn-msy8
status: closed
deps: []
links: []
created: 2026-05-20T13:31:12Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Propagate ticketIntegrationEnabled to child subagent system prompt

Extend buildChildSubagentSystemPrompt in extensions/the-last-harness/prompts.ts to accept ticketIntegrationEnabled: boolean (default true) and append a child-tailored disabled addendum when false. Add a new constant TICKET_INTEGRATION_DISABLED_CHILD_PROMPT telling subagents: if you receive a ticket ID, do not run tk; ask the architect for the task brief instead. Update the child-startup call site in extensions/the-last-harness/primary-agent-runtime.ts (around line 648) to read isTlhTicketIntegrationEnabled(settings) and pass the flag.

## Acceptance Criteria

buildChildSubagentSystemPrompt(false) includes the child addendum; buildChildSubagentSystemPrompt(true) and buildChildSubagentSystemPrompt() do not. Child startup branch reads settings and passes the flag through. No signature change to buildTlhSystemPrompt. New unit test in tests/the-last-harness-extension-static.test.mjs asserts both branches. npm run lint and existing tests pass.


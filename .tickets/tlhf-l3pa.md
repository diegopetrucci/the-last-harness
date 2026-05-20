---
id: tlhf-l3pa
status: open
deps: []
links: []
created: 2026-05-20T19:34:04Z
type: feature
priority: 2
assignee: Diego Petrucci
tags: [startup, anthropic, subscription, warnings]
---
# Suppress Anthropic extra-usage launch warning for subscription logins

Investigate whether TLH can remove or suppress the startup/launch warning about Anthropic "extra usage" when the user is logged in through a Claude Pro/Max subscription. Suppress it only when TLH can reliably tell that the active Anthropic auth path is subscription/OAuth-backed; do not hide a real paid-usage warning for API-key users.

## Acceptance Criteria

Startup no longer shows the Anthropic extra-usage warning for verified subscription/OAuth Anthropic logins if a safe upstream hook or setting exists; API-key or unknown Anthropic auth states still receive the warning or an equivalent safety signal; if precise detection is not possible, the implementation documents the blocker and provides the safest available opt-out/documentation path; TLH defaults still avoid mutating ~/.pi/agent; targeted tests or static assertions cover the chosen behavior; npm run validate passes.


---
id: tlhn-d7ey
status: closed
deps: []
links: []
created: 2026-05-20T13:31:23Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Restrict unsafe test source URL to https only

In scripts/tlh-tickets.mjs, update validateTicketSourceConfig to reject any args.ticketSourceUrl that does not start with 'https://' (case-sensitive). Reject http://, file://, ftp://, and any other scheme with a clear error message. No env sentinel; this is unconditional. Existing tests already use 'https://example.test/...' so they remain green.

## Acceptance Criteria

New test in tests/tlh-tickets.test.mjs asserts that an http:// URL and a file:// URL are rejected at validate time with a clear error. Existing tests pass unchanged. Help text and CHANGELOG note (handled in the docs ticket) reflect the restriction.


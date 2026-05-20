---
id: tlhn-v7l3
status: closed
deps: [tlhn-qc9n, tlhn-d7ey, tlhn-ltp6]
links: []
created: 2026-05-20T13:31:40Z
type: chore
priority: 2
assignee: Diego Petrucci
---
# Document tickets enforcement, pin reinstall, https-only test override

Update CHANGELOG.md and docs/integrations.md to reflect the new enforcement behavior introduced by the H1/M1/M2 tickets. CHANGELOG Unreleased section gains entries for: (1) wrapper now removes managed_bin from PATH when tickets are disabled, (2) installed tk SHA256 recorded in settings and reinstall triggered on pin bump, (3) --unsafe-test-ticket-source-url restricted to https. docs/integrations.md documents the enforced opt-out path-removal, the manual binary removal step (since the managed binary stays on disk for safe rollback), and the pin-bump reinstall behavior.

## Acceptance Criteria

CHANGELOG.md Unreleased section contains the three new entries. docs/integrations.md describes the enforced opt-out and pin behavior accurately. README.md is only updated if its tickets summary line is now inaccurate. npm run lint passes.


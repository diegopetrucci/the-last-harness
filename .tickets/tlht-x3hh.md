---
id: tlht-x3hh
status: closed
deps: [tlht-1j5k]
links: []
created: 2026-05-19T06:50:14Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlht-xnip
---
# Extract TLH update check and telemetry services

Move launch update-check and telemetry logic out of extensions/the-last-harness.ts into feature modules that depend on the shared helpers.

## Acceptance Criteria

Update notifications and launch telemetry keep existing opt-out, timeout, state-file, privacy-safe model, and best-effort behavior; exported APIs are narrow and called from the extension entrypoint as before.

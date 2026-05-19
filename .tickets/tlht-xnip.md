---
id: tlht-xnip
status: closed
deps: []
links: []
created: 2026-05-19T06:50:14Z
type: epic
priority: 2
assignee: Diego Petrucci
---
# Break up TLH extension into feature modules

Refactor extensions/the-last-harness.ts into a thin extension entrypoint plus nested helper modules under extensions/the-last-harness/ without changing runtime behavior.

## Design

Keep helpers under extensions/the-last-harness/ and avoid index.ts so Pi does not discover them as separate extensions. Use .js import specifiers from TypeScript files, matching Pi extension examples. Prefer mechanical moves over behavior changes.

## Acceptance Criteria

extensions/the-last-harness.ts is substantially smaller and remains the only top-level TLH extension entrypoint; no nested index.ts helper is introduced; existing TLH behavior and validation continue to pass.


## Notes

**2026-05-19T06:50:40Z**

Superseded by existing ticket tlh-jhr3; detailed child tasks tlht-1j5k, tlht-x3hh, tlht-1abq, tlht-u8tb, and tlht-kdzo are attached to that ticket via dependencies.

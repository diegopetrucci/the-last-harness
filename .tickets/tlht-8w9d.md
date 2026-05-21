---
id: tlht-8w9d
status: open
deps: [tlht-0jki]
links: []
created: 2026-05-21T19:57:18Z
type: task
priority: 3
assignee: Diego Petrucci
parent: tlht-41ov
tags: [simplification, typescript, validation]
---
# Choose one extension source-language and typecheck strategy

Decide whether TLH extension sources should remain runtime-loaded TypeScript with explicit typecheck, or convert to ESM JS/JSDoc to reduce runtime tooling. Apply the chosen direction incrementally.

## Acceptance Criteria

A documented decision exists; package scripts include the chosen validation boundary, such as typecheck or no runtime TS dependency; at least one representative module/test path follows the chosen pattern.


---
name: tlh-typescript-boundaries
description: Use when changing TypeScript boundary parsing, object-shape decisions, or related test fixtures in The Last Harness.
---

# TypeScript Boundaries

- Treat data crossing an external I/O boundary as `unknown` immediately, then
  validate and narrow it before use. Avoid unchecked `JSON.parse` assertions.
- Use concrete types for TLH-owned formats. In intentionally open settings,
  tool/schema, or upstream data, validate fields TLH consumes; preserve unknown fields.
- Do not chase zero `Record<string, unknown>` occurrences. Avoid cosmetic aliases
  that only rename an existing shape.
- Type normal test fixtures from production types so drift is caught; malformed
  fixtures may remain `unknown` when testing rejection paths.

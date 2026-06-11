---
id: tlhf-bun9
status: closed
deps: [tlhf-41ht]
links: []
created: 2026-06-11T22:20:09Z
type: chore
priority: 2
assignee: Diego Petrucci
tags: [typescript-conversion]
---
# Convert installer script libraries to TypeScript sources

Convert scripts/lib helper modules from handwritten .mjs to TypeScript source while preserving their generated .mjs runtime API and import paths.

## Design

Convert in dependency-aware order and keep public exports stable for tests and CLI scripts. Treat scripts/lib/tlh-install-support-manifest as especially sensitive because install.sh fetches paths from it.

## Acceptance Criteria

scripts/lib helpers have TypeScript source of truth; generated .mjs files preserve existing runtime paths and exported names; tests importing scripts/lib/*.mjs continue to pass; npm run validate passes.


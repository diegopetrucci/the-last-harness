---
id: tlhf-41ht
status: closed
deps: []
links: []
created: 2026-06-11T22:20:09Z
type: chore
priority: 2
assignee: Diego Petrucci
tags: [typescript-conversion]
---
# Add TypeScript build infrastructure for TLH runtime scripts

Add the repository build/typecheck foundation needed for TypeScript-authored TLH runtime scripts while keeping installable artifacts executable by Node.

## Design

Keep install.sh as Bash. Do not require ts-node/tsx or install-time compilation. Runtime scripts used by installer/wrapper should continue to exist as .mjs outputs for users and release assets.

## Acceptance Criteria

A tsconfig and npm scripts exist for build/typecheck; validation runs the TypeScript checks/build before tests/pack; generated runtime .mjs outputs remain available at the paths existing tests and installer support manifests use; npm run validate passes.


---
id: tlhf-geum
status: open
deps: [tlhf-41ht]
links: []
created: 2026-06-11T22:20:09Z
type: chore
priority: 2
assignee: Diego Petrucci
tags: [typescript-conversion]
---
# Convert remaining extension JavaScript modules to TypeScript

Convert remaining TLH extension-side handwritten JavaScript modules to TypeScript where Pi can load .ts directly or where generated .mjs remains necessary.

## Design

Pi supports .ts extension entrypoints via jiti. Preserve package manifest resource discovery and any tests that inspect extension entrypoint paths. Defer browser web/app.js files unless a browser build step is added deliberately.

## Acceptance Criteria

Remaining non-browser TLH extension .mjs modules are converted to TypeScript or have a documented reason to remain generated JS; extension imports/tests are updated; Pi package discovery still exposes expected extension entrypoints; npm run validate passes.


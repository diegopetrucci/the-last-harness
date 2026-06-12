---
id: tlhf-3bno
status: open
deps: [tlhf-lkjz, tlhf-geum]
links: []
created: 2026-06-11T22:20:09Z
type: chore
priority: 2
assignee: Diego Petrucci
tags: [typescript-conversion]
---
# Document and validate TypeScript source-of-truth workflow

Update contributor/release documentation and static tests to explain the TypeScript source workflow and generated runtime artifacts.

## Design

Document what remains Bash or generated JS, how to rebuild/check generated outputs, and why installable TLH must not depend on runtime TypeScript loaders.

## Acceptance Criteria

README/CONTRIBUTING/VALIDATING/release docs or equivalent developer docs describe the TS build workflow; tests guard generated artifact freshness or packaging expectations; npm run validate passes.


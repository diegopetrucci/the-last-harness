---
id: tlhf-lkjz
status: open
deps: [tlhf-bun9]
links: []
created: 2026-06-11T22:20:09Z
type: chore
priority: 2
assignee: Diego Petrucci
tags: [typescript-conversion]
---
# Convert installer and runtime CLI scripts to TypeScript sources

Convert TLH Node CLI entrypoints under scripts/ from handwritten .mjs to TypeScript source while preserving generated executable .mjs outputs.

## Design

Keep shebang/runtime behavior for scripts invoked directly by Node, install.sh, generated wrappers, tests, and release workflows. Do not require a TypeScript runtime in installed TLH profiles.

## Acceptance Criteria

merge-settings, merge-keybindings, tlh-defaults, tlh-gnosis, tlh-install, tlh-install-state, tlh-tickets, tlh-update, tlh-wrapper, and release-notes have TypeScript source of truth; generated .mjs entrypoints remain executable and compatible; installer dry-run smoke commands pass; npm run validate passes.


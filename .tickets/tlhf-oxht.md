---
id: tlhf-oxht
status: closed
deps: []
links: []
created: 2026-05-19T20:37:35Z
type: task
priority: 1
assignee: Diego Petrucci
parent: tlhf-hkxd
---
# Centralize safe TLH profile file writes

Reduce repeated TOCTOU/symlink/temp-path mistakes by designing and adopting one shared helper for safety-critical writes inside the isolated TLH profile. Candidate call sites include settings, keybindings/state, managed tk, managed Gnosis, backups, and installer support/state files.

## Design

The helper should validate against the intended isolated agent root, reject normal ~/.pi/agent, avoid predictable temp paths, avoid following symlinks, validate parent/final identities as far as Node allows, and clean up only paths proven to be helper-owned.

## Acceptance Criteria

A shared helper or clearly documented pattern exists; at least the highest-risk existing write paths use it or have follow-up tickets; adversarial tests cover symlinked parents, swapped parents where practical, predictable temp path pre-creation, cleanup safety, and normal Pi no-mutation.


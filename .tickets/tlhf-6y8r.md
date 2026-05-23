---
id: tlhf-6y8r
status: closed
deps: []
links: []
created: 2026-05-23T09:53:08Z
type: task
priority: 1
assignee: Diego Petrucci
parent: tlhf-oxht
---
# Phase 1: add safe profile write helper and helper tests

Add a reusable scripts-level helper for safety-critical writes inside the isolated TLH profile, but do not migrate production call sites yet.

## Design

Extract the strongest ticket-grade primitives into scripts/lib/tlh-profile-writes.mjs or an equivalent shared module. This phase is intentionally unused by production scripts except tests so it can merge without changing install behavior.

## Acceptance Criteria

Helper exists with tests for normal ~/.pi rejection, symlinked root/parents/final target, hardlinked rewritten targets, parent swaps before mkdir/open/realpath, predictable temp precreation, helper-owned cleanup safety, and mode behavior; npm run validate passes; no production install behavior changes.


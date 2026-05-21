---
id: tlht-i0pu
status: open
deps: [tlht-lsaq]
links: []
created: 2026-05-21T19:57:18Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlht-41ov
tags: [simplification, installer, update]
---
# Deduplicate install and update flow option handling

Centralize shared defaulting, flag parsing, environment handling, update track/ref validation, and sanitized re-exec behavior between scripts/tlh-install.mjs and scripts/tlh-update.mjs.

## Acceptance Criteria

Install/update share one small helper, or update is reduced to reading install state and re-executing the installer with normalized environment; behavior, help output, dry-run output, and tests remain equivalent.


---
id: tlhf-3nbb
status: open
deps: [tlhf-2q9x]
links: []
created: 2026-05-20T19:33:28Z
type: feature
priority: 2
assignee: Diego Petrucci
tags: [project-settings, extensions, packages, docs, security]
---
# Support project-local TLH extensions and packages

Add a safe, documented workflow for project-owned TLH extensions/packages via .pi/extensions and project-scoped package/extension settings. The workflow must make scope explicit so users can share project extensions without accidentally installing or enabling them globally.

## Acceptance Criteria

tlh can load project-local .pi/extensions resources and project-scoped packages/extensions when run from that project; any install/helper path uses project scope only after explicit user intent and warns that extensions execute local code; project package installs/updates land under .pi/ rather than ~/.the-last-harness/agent or ~/.pi/agent; startup/status/resource reporting distinguishes project-local extensions/packages from bundled TLH defaults; README documents setup, review/security expectations, and rollback; tests or smoke coverage verify scope isolation; npm run validate passes.


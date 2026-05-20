---
id: tlhf-2q9x
status: open
deps: []
links: []
created: 2026-05-20T19:33:28Z
type: feature
priority: 2
assignee: Diego Petrucci
tags: [project-settings, settings, profile, docs]
---
# Support project-local TLH settings overlays

Make The Last Harness first-class for per-project configuration using upstream project settings (.pi/settings.json) while preserving the isolated TLH global profile. Define/verify precedence between the isolated global TLH settings and project-local settings, and provide a safe documented workflow for creating or editing project settings.

## Acceptance Criteria

tlh launched inside a project honors .pi/settings.json without reading or mutating ~/.pi/agent; project settings override/merge with isolated global TLH settings as expected; any new helper writes only the current project's .pi/settings.json with explicit user intent, conservative merge behavior, and backups; status/docs make the active project settings path and precedence clear; tests or smoke coverage exercise project override behavior and safety; npm run validate passes.


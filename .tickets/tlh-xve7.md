---
id: tlh-xve7
status: closed
deps: []
links: []
created: 2026-05-19T04:56:07Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Generalize npm default embedding benchmark harness

Extend the current context-cap benchmark harness so it can benchmark any npm default extension by manifest id/source, while keeping context-cap as the default behavior. It should materialize a temporary treatment package that removes the selected default extension and embeds the selected package resources from its pi manifest.

## Design

Keep this as an experiment harness, not shipping embedded defaults. Support Plannotator resources including extensions and skills, and preserve temp agent/bin/cache safety plus PI_OFFLINE/TLH env scrubbing. Document dependency/runtime equivalence caveats for dependency-heavy packages.

## Acceptance Criteria

CLI can target at least context-cap, plannotator, and fff via extension id/source options. Treatment package removes only the selected default manifest entry, embeds declared pi resource paths, records package size delta and treatment validation, and existing context-cap tests are updated without regressing prior safety checks.


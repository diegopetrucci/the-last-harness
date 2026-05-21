---
id: tlht-0jki
status: open
deps: [tlht-cg4l]
links: [tlha-r5ob]
created: 2026-05-21T19:57:18Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlht-41ov
tags: [simplification, extension, runtime]
---
# Move high-churn UI and network niceties out of core extension

Extract subscription usage footer, launch telemetry, update notification, git footer/cache, and similar provider/network/UI niceties from the core extensions/the-last-harness.ts startup path into optional bundled extensions or clearly gated modules.

## Design

Primary-agent runtime, safety tooling, gn/tk prompt integration, and isolated-profile invariants stay core. Avoid startup failure from optional niceties.

## Acceptance Criteria

Core TLH extension can load without optional UI/network niceties; each moved feature is independently disableable/default-bundled or has a documented reason to remain core; tests cover startup without those features.


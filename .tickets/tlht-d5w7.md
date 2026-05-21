---
id: tlht-d5w7
status: open
deps: [tlht-cg4l]
links: [tlh-s5pn, tlhf-ewii, tlh-gw9i]
created: 2026-05-21T19:57:18Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlht-41ov
tags: [simplification, defaults, extensions]
---
# Review default-bundled extension set for minimal TLH distribution

Decide which packages in config/default-extensions.json are truly default for the TLH workflow and which should become opt-in recommendations.

## Design

Keep critical subagents/intercom protected unless the core-boundary decision explicitly changes the architecture.

## Acceptance Criteria

The default-extension manifest is categorized; every non-critical default has explicit rationale or is moved to opt-in documentation; critical subagents/intercom remain protected; README/docs are updated for any user-facing change.


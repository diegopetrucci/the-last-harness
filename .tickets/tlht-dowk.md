---
id: tlht-dowk
status: open
deps: []
links: []
created: 2026-05-21T20:08:11Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlht-i0pu
tags: [simplification, installer, update]
---
# Extract shared install/update CLI helpers

Refactor shared installer/update CLI behavior into a helper used by scripts/tlh-install.mjs and scripts/tlh-update.mjs. Scope includes path expansion/default agent and bin dirs, semver tag detection, common pass-through flags, and required value/equals-form parsing helpers. Do not change installer bootstrap transport.

## Design

Keep current help text and asserted diagnostics stable. Preserve update PATH sanitization, installer isolated PI_CODING_AGENT_DIR behavior, dry-run behavior, and install-state semantics.

## Acceptance Criteria

Both install and update scripts use the shared helper for the approved common pieces; behavior and help output remain equivalent except for intentional internal structure; focused installer/update tests pass; no normal Pi config mutation paths are introduced.


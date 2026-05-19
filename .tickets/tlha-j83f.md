---
id: tlha-j83f
status: closed
deps: []
links: []
created: 2026-05-19T11:59:09Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Raise TLH Node minimum to match upstream

Align The Last Harness with upstream Pi 0.75+ Node requirement. Update declared/runtime/tooling references to require Node >=22.19.0 and add installer preflight checks so installs fail early with a clear message before invoking Pi/npm when Node is too old.

## Design

Use one shared version constant or clearly mirrored constants for stage-0 Bash and stage-1 Node. Stage-0 must check before remote support fetch/invocation; stage-1 must remain authoritative when run directly. Keep dry-run behavior non-mutating and messages concise.

## Acceptance Criteria

package metadata and release workflow use Node >=22.19.0; install.sh and stage-1 installer reject Node versions below 22.19.0 with actionable output; docs mention the Node minimum where install/development validation is documented; targeted tests/smoke checks cover the new preflight; validation commands at least include bash -n install.sh, relevant node tests, bash scripts/check-installer-smoke.sh, node scripts/merge-settings.mjs --dry-run, and npm pack --dry-run.

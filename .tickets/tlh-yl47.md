---
id: tlh-yl47
status: closed
deps: [tlh-p9o7]
links: []
created: 2026-05-16T17:12:13Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlh-va7o
---
# Tighten stage-0 local stage-1 trust path

Fix oracle medium finding: stage-0 should not run adjacent local stage-1 support before basic fallback target validation, and release/pipe-to-bash behavior should not accidentally prefer stale local support files in the current directory. Keep complete local checkout development convenient while preserving selected-ref fetch expectations for one-line installs.

## Design

Move validate_stage0_fallback_targets before the local support-root branch. Ensure find_local_support_root only considers the installer script's own directory via BASH_SOURCE, never arbitrary cwd; stdin should have no local script file and therefore fetch/dry-run rather than using cwd support.

## Acceptance Criteria

Stage-0 target validation runs before any local stage-1 delegation or remote support fetch; pipe-to-bash install from stdin cannot accidentally use cwd support files; local checkout execution still delegates to adjacent stage-1; smoke coverage covers stdin/no-local and local checkout behavior; release ref pinning smoke still passes.


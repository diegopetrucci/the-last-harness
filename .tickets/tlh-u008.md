---
id: tlh-u008
status: closed
deps: []
links: []
created: 2026-05-16T20:34:49Z
type: bug
priority: 3
assignee: Diego Petrucci
parent: tlh-va7o
---
# Fix stage-0 no-wrapper dry-run output

Fix valid P3 review comment: the stdin/no-local-stage stage-0 dry-run fallback parses --no-wrapper but does not track it, so `bash -s -- --dry-run --no-wrapper < install.sh` prints wrapper creation/path output that stage-1 would skip. Keep the no-download/no-write fallback behavior.

## Design

Track NO_WRAPPER in stage-0 parsing. In dry_run_without_stage1, print a bootstrap-level dry-run label/note and report wrapper creation as skipped when --no-wrapper is present. Avoid fetching/running stage-1 for stdin --dry-run.

## Acceptance Criteria

stdin/pipe-to-bash --dry-run --no-wrapper prints that wrapper creation is skipped and does not print a wrapper path would-be-created line; stdin --dry-run still performs no downloads/writes; local checkout dry-run still delegates to stage-1; installer smoke covers the regression and passes.


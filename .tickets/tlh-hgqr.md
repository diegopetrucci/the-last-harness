---
id: tlh-hgqr
status: closed
deps: []
links: []
created: 2026-05-16T21:06:54Z
type: bug
priority: 2
assignee: Diego Petrucci
parent: tlh-va7o
---
# Use realpath guard for stage-0 protected paths

Fix valid review finding: stage-0 stdin/no-stage1 dry-run safety checks currently use lexical path normalization, so physical aliases such as macOS /var and /private/var can bypass the normal Pi config guard even though stage-1 rejects the same target. Keep display normalization separate from safety comparison.

## Design

Add a small stage-0 realpath-for-compare helper for safety checks only. It should resolve existing path ancestors without creating files, similar to the prior Bash/Node guard and stage-1 realpathForCompare. Continue using the lexical normalizer for bootstrap dry-run display output. Add smoke coverage for HOME through one alias and --agent-dir through another.

## Acceptance Criteria

stdin/pipe-to-bash --dry-run rejects normal Pi config targets spelled through physical/logical aliases before curl/downloads/writes; ordinary stdin --dry-run still performs no downloads/writes; local checkout dry-run still delegates to stage-1; bash scripts/check-installer-smoke.sh and git diff --cached --check pass.


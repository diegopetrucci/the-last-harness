---
id: tlhm-fxyy
status: open
deps: [tlhm-cbv4, tlhm-g4rl]
links: []
created: 2026-06-27T19:54:30Z
type: task
priority: 1
assignee: Diego Petrucci
---
# Final validation: startup perf (warm + cold) and full validate

Cross-cutting verification for the lazy-load (A) and NODE_COMPILE_CACHE (D) changes. Confirms no regressions and quantifies the warm launch-time improvement end to end. (The local cold-launch jiti-cache fix was dropped -- see gnosis njekqj -- so cold launch is measured/recorded for reference only, not gated.)

## Design

Run npm run validate (per VALIDATING.md). Run npm run check:startup-performance for the warm budget (<1000ms first-header mean), capturing before/after warm numbers to quantify the lazy-load gain. Verify install + uninstall idempotency end to end against temporary --agent-dir/--bin-dir. Optionally record a cold-launch number (wipe $TMPDIR/jiti, then measure first boot) for reference only -- it is expected to remain ~2s since the local cold fix was dropped.

## Acceptance Criteria

npm run validate passes; warm startup check passes (<1000ms mean) and ideally improves vs baseline; install/uninstall idempotent with no residue; before/after warm numbers recorded in ticket notes (cold number optional, reference only).


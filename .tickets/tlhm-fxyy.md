---
id: tlhm-fxyy
status: open
deps: [tlhm-cbv4, tlhm-0c6s, tlhm-g4rl]
links: []
created: 2026-06-27T19:54:30Z
type: task
priority: 1
assignee: Diego Petrucci
---
# Final validation: startup perf (warm + cold) and full validate

Cross-cutting verification for the lazy-load (A), NODE_COMPILE_CACHE (D), and persistent-jiti-cache (B) changes. Confirms no regressions and quantifies the launch-time improvements end to end.

## Design

Run npm run validate (per VALIDATING.md). Run npm run check:startup-performance for the warm budget (<1000ms first-header mean). Perform a cold-launch verification: with the persistent jiti cache in place, wipe $TMPDIR/jiti and confirm boot stays approximately warm (capture before/after numbers). Verify install + uninstall idempotency end to end against temporary --agent-dir/--bin-dir. Record measured warm and cold numbers in the ticket notes.

## Acceptance Criteria

npm run validate passes; warm startup check passes (<1000ms mean); cold-launch check shows ~warm boot after $TMPDIR jiti reap with the fix vs ~2.3s without; install/uninstall idempotent with no residue; before/after warm+cold numbers recorded in ticket notes.


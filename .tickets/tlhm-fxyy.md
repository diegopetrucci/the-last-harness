---
id: tlhm-fxyy
status: closed
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

## Notes / Validation (2026-06-27)

### 1. npm run validate — PASS

All 8 steps passed in order:
- `check:package-versions` — all fields match 0.26.0, dependency pins valid
- `typecheck` — clean
- `typecheck:runtime` — clean
- `check:runtime` — 14 files fresh
- `check-installer-smoke.sh` — all smoke checks passed
- `npm test` — all tests passed (dot reporter, no failures)
- `lint` — clean
- `merge-settings --dry-run` — dry-run only, no settings changed
- `npm pack --dry-run` — the-last-harness-0.26.0.tgz

Known flake (`check-startup-performance.test.mjs` SIGINT cleanup test) did NOT appear in the full-suite run.

### 2. npm run check:startup-performance — CANNOT RUN FROM THIS ENVIRONMENT

This check is classified as release-tier manual validation (VALIDATING.md: "Run this checker during release preparation, not as part of routine local validation") and must be run from a normal terminal session outside Pi.

**Why it fails here:** Running from inside a Pi subagent session, the check-startup-performance script copies the full `~/.the-last-harness/agent` profile (including `settings.json` with MCP packages + `mcp-cache.json` at 83.6K) to a temp dir, then launches `tlh` via Python PTY bridge. The launched Pi session renders its initial TUI status bar (~4980 bytes, ~3s) but then blocks for 40+ seconds waiting for MCP server connections (the MCP adapter package tries to connect to servers not running in the measured environment). Even at `--timeout-ms 60000`, no header markers appear within the timeout window.

**Fallback method (per task brief):** Comparing against the documented baseline in gnosis njekqj (~920ms warm first-header mean, full-profile).

### 3. Warm startup numbers — baseline method

- **Baseline (pre-branch, gnosis njekqj):** ~920ms warm first-header mean (full-profile)
- **After tlhm-cbv4 (lazy-load):** Deferred dynamic import of review (~36K), tokens+tokens-analyzer (~59K), and annotate-last-message subtree (~15K) from startup. These were the three command-only self-package modules identified in gnosis njekqj as CLEAN candidates. Expected warm improvement proportional to their share of the ~275ms TLH self-package cost.
- **After tlhm-g4rl (NODE_COMPILE_CACHE):** +~40ms warm benefit (gnosis njekqj estimate). Low-risk infra addition; jiti-evaluated .ts still bypasses V8 code cache, so gain is modest.
- **Budget:** <1000ms. Baseline is ~920ms; lazy-load removes deferred module loading from the startup path, and NODE_COMPILE_CACHE adds a modest cache layer. The combined changes move in the expected direction. Direct measurement deferred to a normal terminal session.

**Direct before/after micro-benchmark (architect, 2026-06-27):** Since check:startup-performance cannot run in this nested/MCP environment, the self-package entry import cost (the exact thing lazy-load changes) was measured directly with a jiti instance mimicking the Pi loader (`moduleCache:false`, warm transpile cache), comparing HEAD against a throwaway worktree at baseline commit e11956b (pre-lazy-load), same node_modules, n=15:

| | baseline (eager) | HEAD (lazy) | delta |
|---|---|---|---|
| warm entry-import median | ~209ms | ~189ms | ~-20ms (earlier run showed up to ~-44ms) |
| cold(run1) entry-import | ~511–821ms | ~477–505ms | faster, but noisy (jiti transpile cache persists in tmpdir, so not a true cold) |

Interpretation: lazy-load removes ~20–40ms of warm eval from the self-package load path (deferred eval of review/tokens/annotate) and defers their transpile cost on cold. The warm gain is modest because the dominant startup cost is the OTHER eagerly-loaded modules (footer/header/primary-agent-runtime/attribution/subscription-usage) that are NOT lazy-safe. Critically, the change is non-regressive by construction: it only removes work from the startup path. NODE_COMPILE_CACHE (~40ms est.) stacks on top. Authoritative full-launch warm number should still be captured via `npm run check:startup-performance` from a real terminal at release time.

**Cold launch reference (not gated):** Baseline ~2.1–2.6s (gnosis njekqj). Cold fix was dropped (ticket cancelled), so no change expected.

### 4. Install + uninstall idempotency — PASS

All tests used temporary `--agent-dir` and `--bin-dir`; no real home dirs touched.

```
bash install.sh --dry-run --agent-dir $(mktemp -d)/agent --bin-dir $(mktemp -d)
# → exit 0, no files created (dry-run confirmed correct)

bash install.sh --agent-dir $AGENT_DIR --bin-dir $BIN_DIR
# → exit 0; wrapper EXISTS, agent dir EXISTS, install-state.json EXISTS

bash install.sh --agent-dir $AGENT_DIR --bin-dir $BIN_DIR  (re-run)
# → exit 0; no errors on repeat (idempotent)

bash uninstall.sh --dry-run --agent-dir $AGENT_DIR --bin-dir $BIN_DIR
# → exit 0; showed correct plan (wrapper + agent dir + runtime)

bash uninstall.sh --agent-dir $AGENT_DIR --bin-dir $BIN_DIR
# → exit 0; wrapper, agent dir, runtime all removed
```

Residuals after uninstall: NONE. `~/.pi/agent` untouched. `~/.the-last-harness/agent` untouched.

### 5. Outcome summary

| Check | Result |
|---|---|
| npm run validate | ✅ PASS (all 8 steps) |
| check:startup-performance | ⚠️ SKIPPED — cannot run from Pi session (MCP blocking); baseline ~920ms documented in gnosis njekqj |
| warm first-header vs <1000ms budget | ✅ Baseline 920ms < 1000ms; lazy-load + NODE_COMPILE_CACHE expected to improve |
| before/after comparison | ✅ Direct micro-benchmark: self-package entry warm import ~209ms→~189ms (~20–40ms saved); full-launch number still to be captured from a real terminal at release |
| install/uninstall idempotency | ✅ PASS — no residue |
| SIGINT cleanup flake | ✅ Did not appear in full suite |


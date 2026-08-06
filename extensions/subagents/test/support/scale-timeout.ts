/**
 * Timeout scaling helper for spawn-heavy integration tests.
 *
 * Returns `ms * factor` when `TLH_TEST_TIMEOUT_SCALE` is set in the
 * environment, otherwise returns `ms` unchanged.  The runner
 * (`scripts/run-subagents-tests.mjs`) sets `TLH_TEST_TIMEOUT_SCALE=3` when
 * `CI` is truthy so that GitHub-hosted macOS runners have enough headroom for
 * process-spawn and filesystem-polling operations without slowing local runs.
 *
 * Usage:
 *   import { scaleTestTimeout } from "../support/scale-timeout.ts";
 *   async function waitForFoo(timeoutMs = scaleTestTimeout(15_000)) { ... }
 */
export function scaleTestTimeout(ms: number): number {
	const raw = process.env.TLH_TEST_TIMEOUT_SCALE;
	if (!raw) return ms;
	const factor = Number(raw);
	if (!Number.isFinite(factor) || factor <= 0) return ms;
	return Math.round(ms * factor);
}

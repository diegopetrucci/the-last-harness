/**
 * Timeout scaling helper for spawn-heavy integration tests.
 *
 * Returns `ms * factor` when `TLH_TEST_TIMEOUT_SCALE` is set in the
 * environment, otherwise returns `ms` unchanged.  The runner
 * (`scripts/run-subagents-tests.mjs`) sets `TLH_TEST_TIMEOUT_SCALE=3` when
 * `CI` is truthy so that GitHub-hosted macOS runners have enough headroom for
 * process-spawn and filesystem-polling operations without slowing local runs.
 *
 * ## Branded type
 *
 * `scaleTestTimeout` returns a `ScaledMs` branded value so that raw numeric
 * literals cannot accidentally be passed where a scaled budget is expected.
 * The 8 wait helpers in `async-execution-helpers.ts` require `ScaledMs` for
 * their `timeoutMs` parameter — passing a plain `number` is a compile error.
 *
 * Use `unscaledMs` when you intentionally want a fixed, unscaled budget (e.g.
 * a short deadline for a test that *measures* timeout behaviour).  The name
 * makes the deliberate opt-out visible at the call site and distinguishable
 * from an accidental raw literal.
 *
 * Usage:
 *   import { scaleTestTimeout, unscaledMs } from "../support/scale-timeout.ts";
 *   async function waitForFoo(timeoutMs = scaleTestTimeout(15_000)) { ... }
 *
 *   // explicit opt-out – fixed budget regardless of CI scale factor:
 *   await waitForFoo(unscaledMs(5_000));
 */

/** Branded millisecond value produced by {@link scaleTestTimeout} or {@link unscaledMs}. */
export type ScaledMs = number & { readonly __scaledMs: unique symbol };

/** Apply the `TLH_TEST_TIMEOUT_SCALE` factor and return a branded `ScaledMs`. */
export function scaleTestTimeout(ms: number): ScaledMs {
	const raw = process.env.TLH_TEST_TIMEOUT_SCALE;
	if (!raw) return ms as ScaledMs;
	const factor = Number(raw);
	if (!Number.isFinite(factor) || factor <= 0) return ms as ScaledMs;
	return Math.round(ms * factor) as ScaledMs;
}

/**
 * Explicit opt-out: mark `ms` as a deliberately unscaled budget.
 *
 * Use this when the test intentionally measures timeout behaviour at a fixed
 * wall-clock duration and must not grow with the CI scale factor.  The
 * function name documents the intent at the call site.
 */
export function unscaledMs(ms: number): ScaledMs {
	return ms as ScaledMs;
}

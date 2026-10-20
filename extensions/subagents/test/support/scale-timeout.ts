/**
 * Timeout scaling helper for spawn-heavy integration tests.
 *
 * Returns `ms * factor` when `TLH_TEST_TIMEOUT_SCALE` is set in the
 * environment, otherwise returns `ms` unchanged.  The runner
 * (`scripts/run-subagents-tests.mjs`) sets `TLH_TEST_TIMEOUT_SCALE=3` when
 * `CI` is truthy so that GitHub-hosted macOS runners have enough headroom for
 * process-spawn and filesystem-polling operations without slowing local runs.
 *
 * ## When to scale
 *
 * Scale only budgets for waiting until a condition becomes true (wait helpers,
 * polling deadlines, spawn-ordering margins): they end early on success, so extra
 * headroom costs nothing. Do NOT scale time the test always spends in full:
 * (a) negative windows that assert something does not happen (a slow runner can
 * only weaken such a check, never fail it falsely), and (b) product
 * deadlines (`maxExecutionTimeMs`, `timeoutMs`) the test waits to fire. Scaling
 * those triples mandatory CI wall time. Keep a product deadline scaled when the
 * test needs the child to reach some state before the deadline fires, and keep
 * ratio invariants (delay vs. bound) scaled together.
 *
 * ## Branded type
 *
 * `scaleTestTimeout` returns a `ScaledMs` branded value so that raw numeric
 * literals cannot accidentally be passed where a scaled budget is expected.
 * The wait helpers in `async-execution-helpers.ts` require `ScaledMs` for
 * their `timeoutMs` parameter — passing a plain `number` is a compile error.
 */

/** Branded millisecond value produced by {@link scaleTestTimeout}. */
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
 * Return a branded ScaledMs without applying the scale factor.
 * Use when a fixed, unscaled budget is intentional (e.g. a test that measures timeout behaviour).
 */
export function unscaledMs(ms: number): ScaledMs {
  return ms as ScaledMs;
}

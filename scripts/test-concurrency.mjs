/**
 * Shared Node test-runner concurrency policy.
 *
 * Local runs use a conservative adaptive limit so the test runner does not
 * consume every available CPU by default. GitHub Actions keeps its existing
 * runner-level concurrency unless TLH_TEST_CONCURRENCY is explicitly set.
 */

import { availableParallelism as nodeAvailableParallelism } from "node:os";

export const TEST_CONCURRENCY_ENV = "TLH_TEST_CONCURRENCY";

/**
 * Parse the optional explicit test concurrency override.
 *
 * @param {string | undefined} value
 * @returns {number | undefined}
 * @throws {Error} when an explicitly supplied value is not a positive integer
 */
export function parseTestConcurrency(value) {
  if (value === undefined) return undefined;

  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(
      `${TEST_CONCURRENCY_ENV} must be a positive integer or unset it; received ${JSON.stringify(value)}.`,
    );
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      `${TEST_CONCURRENCY_ENV} must be a positive integer or unset it; received ${JSON.stringify(value)}.`,
    );
  }
  return parsed;
}

/**
 * Resolve the concurrency limit for a Node test runner.
 *
 * @param {{
 *   env?: Record<string, string | undefined>;
 *   availableParallelism?: () => number;
 * }} [options]
 * @returns {number | undefined} undefined leaves GitHub Actions' default intact
 */
export function resolveTestConcurrency({
  env = process.env,
  availableParallelism = nodeAvailableParallelism,
} = {}) {
  const override = parseTestConcurrency(env[TEST_CONCURRENCY_ENV]);
  if (override !== undefined) return override;

  // GitHub-hosted runners already have deliberate runner-level concurrency.
  // Do not add a TLH limit there unless the caller explicitly overrides it.
  if (env.GITHUB_ACTIONS === "true") return undefined;

  return Math.max(1, Math.floor(availableParallelism() / 2));
}

/**
 * Project the resolved policy into Node's test-runner command-line arguments.
 *
 * @param {Parameters<typeof resolveTestConcurrency>[0]} [options]
 * @returns {string[]}
 */
export function testConcurrencyArgs(options) {
  const concurrency = resolveTestConcurrency(options);
  return concurrency === undefined ? [] : [`--test-concurrency=${concurrency}`];
}

#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
export const repoRoot = resolve(dirname(scriptPath), "..");

export const suiteConfigs = {
  unit: {
    directory: join(repoRoot, "extensions/subagents/test/unit"),
    // B2 removes retired completion-guard/task-intent coverage while keeping
    // the remaining unit tests protected from accidental broad deletion.
    // C1 audit: 8 async-resume, 5 lifecycle-state, and 3 status/revival
    // tests all asserted retired cumulative runtime-ledger/checkpoint behavior.
    // Fresh per-spawn deadline and legacy-status tests retain required coverage.
    // C2 removes 54 fuzzy/catalog/thinking-gate assertions while porting
    // explicit ordering, transient retry, scope, identity, and context cases;
    // four A-series run-support helper tests remain covered.
    // C2 follow-up removes four obsolete runtime capability tests and ports
    // runtime-context boundary coverage into model-info.test.
    // D1 replaces fuzzy tk-ticket coverage with explicit ticket-context tests.
    // E1 removes the retired completion-batcher and completion-dedupe suites.
    // E3 removes one retired unit suite; E4 removes the status quarantine
    // behavior suite while retaining the surviving status and privacy coverage.
    // F1 removes project-agent snapshot/defaults/control-state tests and keeps
    // the fixed-file loader coverage. G1 retires health-transition assertions;
    // the current surviving floor is 99 files.
    minimumFiles: 99,
    // E1 removes batching/dedupe assertions and ports the surviving fixed-shape
    // delivery, ownership, and bounded-reference coverage. The correction pass
    // restores the exact current suite floor after its additional coverage.
    // E2 removes three aggregate active-run rendering assertions while retaining
    // the per-run status, transcript, privacy, and lifecycle coverage. The
    // transcript schema/session/rejection coverage brings the floor to 1376.
    // E3 removes the budget-only suite and assertions; E4 removes six
    // quarantine-only tests and adds direct unreadable-status, cleanup, cache,
    // and boundary coverage. F1 removes retired project-agent behavior tests;
    // G1 retires health-transition assertions; the current surviving floor is
    // 1221 tests.
    minimumTests: 1221,
  },
  integration: {
    directory: join(repoRoot, "extensions/subagents/test/integration"),
    // B1 removes acceptance-only suites and B2 removes retired completion-
    // guard/task-intent coverage; surviving async/awaited coverage keeps this
    // floor from allowing an accidental broad test deletion.
    // C2 audit: catalog-filtering/thinking-gate assertions were replaced by
    // ordered fallback exhaustion, non-transient stop, exact forwarding, and
    // effective-candidate deduplication.
    // D1 removes legacy ticket inference, metadata, and UI coverage.
    // E1 replaces grouped/deduplicated notification coverage with the fixed-shape
    // watcher-owner, awaited-suppression, artifact-claim race, and cleanup cases.
    // The correction pass restores the exact current suite floor after its
    // generation and lifecycle-cleanup regressions; transcript routing and
    // rejection coverage bring the pre-E4 floor to 492; E4 ports the
    // surviving status/doctor behavior and adds the retry/no-remediation,
    // bounded-output, and single-read coverage, bringing the pre-G1 floor to
    // 497. G1 retires the health-only integration suite and removes three
    // obsolete assertions; the surviving floor is 486 tests.
    minimumFiles: 33,
    minimumTests: 486,
  },
  e2e: {
    directory: join(repoRoot, "extensions/subagents/test/e2e"),
    minimumFiles: 1,
    minimumTests: 1,
  },
};

const summaryFields = ["tests", "pass", "fail", "cancelled", "skipped", "todo"];

export function discoverSuiteFiles(suite, config = suiteConfigs[suite]) {
  if (!config) throw new Error(`Unknown subagents test suite: ${suite}`);

  let entries;
  try {
    entries = readdirSync(config.directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `Could not read ${suite} test directory ${config.directory}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => join(config.directory, entry.name))
    .sort();
  if (files.length < config.minimumFiles) {
    throw new Error(
      `${suite} suite found ${files.length} test files; expected at least ${config.minimumFiles}`,
    );
  }
  return files;
}

export function parseTapSummary(output) {
  const summary = {};
  for (const field of summaryFields) {
    const matches = [...output.matchAll(new RegExp(`^# ${field} (\\d+)\\r?$`, "gm"))];
    if (matches.length !== 1) {
      throw new Error(
        `TAP summary must contain exactly one '# ${field} <count>' line; found ${matches.length}`,
      );
    }
    summary[field] = Number.parseInt(matches[0][1], 10);
  }
  return summary;
}

export function validateTapSummary(
  suite,
  summary,
  { sharded = false, minimumTests = suiteConfigs[suite]?.minimumTests } = {},
) {
  if (!Number.isInteger(summary.tests) || summary.tests <= 0) {
    throw new Error(`${suite} suite executed zero tests`);
  }
  for (const field of ["fail", "cancelled", "skipped", "todo"]) {
    if (summary[field] !== 0) {
      throw new Error(
        `${suite} suite reported ${field}=${summary[field]}; every executed test must pass`,
      );
    }
  }
  if (summary.pass !== summary.tests) {
    throw new Error(`${suite} suite reported pass=${summary.pass}, tests=${summary.tests}`);
  }
  if (!sharded && summary.tests < minimumTests) {
    throw new Error(
      `${suite} suite executed ${summary.tests} tests; expected at least ${minimumTests}`,
    );
  }
}

function isSharded(options) {
  return options.some((option) => option === "--test-shard" || option.startsWith("--test-shard="));
}

function relayFailureOutput(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

/**
 * Build the child process environment for a suite run.
 *
 * Strips PI_SUBAGENT_* / PI_SUBAGENTS_* keys that must not bleed across
 * process boundaries, resets the test-context sentinel, pins the isolated
 * agent dir, and – when CI is set – injects TLH_TEST_TIMEOUT_SCALE so that
 * spawn-heavy wait helpers in the integration suites have enough headroom on
 * slow GitHub-hosted macOS runners.
 *
 * @param {Record<string, string | undefined>} parentEnv   Source env (normally process.env).
 * @param {string}                             agentDir    Isolated PI_CODING_AGENT_DIR path.
 * @returns {Record<string, string | undefined>}
 */
export function buildChildEnv(parentEnv, agentDir) {
  const env = { ...parentEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_SUBAGENTS_")) delete env[key];
  }
  delete env.NODE_TEST_CONTEXT;
  env.PI_CODING_AGENT_DIR = agentDir;
  // Scale spawn-heavy wait budgets on CI runners (see extensions/subagents/test/support/scale-timeout.ts).
  if (parentEnv.CI) env.TLH_TEST_TIMEOUT_SCALE = "3";
  return env;
}

export function runSuite(suite, options = []) {
  const config = suiteConfigs[suite];
  if (!config) {
    console.error(
      "Usage: node scripts/run-subagents-tests.mjs <unit|integration|e2e> [node test options]",
    );
    return 2;
  }
  if (
    options.some((option) => option === "--test-reporter" || option.startsWith("--test-reporter="))
  ) {
    console.error("run-subagents-tests.mjs controls the TAP reporter; do not pass --test-reporter");
    return 2;
  }

  let files;
  try {
    files = discoverSuiteFiles(suite, config);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const root = mkdtempSync(join(tmpdir(), "tlh-subagents-tests-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  const env = buildChildEnv(process.env, agentDir);

  const loader = pathToFileURL(
    join(repoRoot, "extensions/subagents/test/support/register-loader.mjs"),
  ).href;
  const args = [
    "--experimental-strip-types",
    "--import",
    loader,
    "--test",
    "--test-reporter=tap",
    ...options,
    ...files,
  ];
  let result;
  try {
    result = spawnSync(process.execPath, args, {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  if (result.error) {
    relayFailureOutput(result);
    console.error(`Could not spawn subagents ${suite} tests:`, result.error);
    return 1;
  }
  if (result.status !== 0 || result.signal) {
    relayFailureOutput(result);
    console.error(
      `Subagents ${suite} tests exited with ${result.signal ? `signal ${result.signal}` : `status ${result.status}`}.`,
    );
    return result.status ?? 1;
  }

  let summary;
  try {
    summary = parseTapSummary(result.stdout);
    validateTapSummary(suite, summary, {
      sharded: isSharded(options),
      minimumTests: config.minimumTests,
    });
  } catch (error) {
    relayFailureOutput(result);
    console.error(
      `Subagents ${suite} TAP validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  const fileLabel = `${files.length} file${files.length === 1 ? "" : "s"}`;
  console.log(
    `subagents ${suite}: ${summary.pass}/${summary.tests} passed (${fileLabel}${isSharded(options) ? ", shard" : ""})`,
  );
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  const [suite, ...options] = argv;
  return runSuite(suite, options);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  process.exitCode = main();
}

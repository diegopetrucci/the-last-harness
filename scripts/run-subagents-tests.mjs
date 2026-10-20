#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CI_TIMINGS_DIR_ENV,
  CI_TIMINGS_EVENT_FILE_ENV,
  ciTimingReporterArgs,
} from "./ci-timings.mjs";
import { testConcurrencyArgs } from "./test-concurrency.mjs";

const scriptPath = fileURLToPath(import.meta.url);
export const repoRoot = resolve(dirname(scriptPath), "..");

export const suiteConfigs = {
  unit: {
    directory: join(repoRoot, "extensions/subagents/test/unit"),
    minimumTests: 1252,
  },
  integration: {
    directory: join(repoRoot, "extensions/subagents/test/integration"),
    minimumTests: 557,
  },
  e2e: {
    directory: join(repoRoot, "extensions/subagents/test/e2e"),
    minimumTests: 1,
  },
};

const summaryFields = ["tests", "pass", "fail", "cancelled", "skipped", "todo"];
const unsupportedFilterOptions = [
  "--test-only",
  "--test-skip-pattern",
  "--test-rerun-failures",
  "--test-tag-filter",
  "--experimental-test-tag-filter",
];
const inheritedSelectionFilterOptions = ["--test-name-pattern", ...unsupportedFilterOptions];

function normalizeOptionName(option) {
  const equalsIndex = option.indexOf("=");
  return (equalsIndex === -1 ? option : option.slice(0, equalsIndex)).replaceAll("_", "-");
}

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
  if (files.length === 0) {
    throw new Error(`${suite} suite found no .test.ts files in ${config.directory}`);
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
  {
    sharded = false,
    minimumTests = suiteConfigs[suite]?.minimumTests,
    diagnostic = false,
    selectedTests = summary.tests,
    selectedPasses = summary.pass,
  } = {},
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
  if (diagnostic) {
    if (
      !Number.isInteger(selectedTests) ||
      selectedTests <= 0 ||
      !Number.isInteger(selectedPasses) ||
      selectedPasses <= 0
    ) {
      throw new Error(
        `${suite} diagnostic selected zero passing tests; --test-name-pattern must match a passing test`,
      );
    }
    if (selectedPasses !== selectedTests) {
      throw new Error(
        `${suite} diagnostic reported selected pass=${selectedPasses}, tests=${selectedTests}`,
      );
    }
    return;
  }
  if (!sharded && summary.tests < minimumTests) {
    throw new Error(
      `${suite} suite executed ${summary.tests} tests; expected at least ${minimumTests}`,
    );
  }
}

/**
 * Count the passing file wrappers Node emits for files excluded by
 * --test-name-pattern. The empty `1..0` plan is the narrow marker that
 * distinguishes those wrappers from real tests; skipped tests remain in the
 * TAP summary and are never subtracted here.
 *
 * @param {string} output
 * @returns {number}
 */
export function countNamePatternExcludedFiles(output) {
  const lines = output.split(/\r?\n/u);
  let excludedFiles = 0;
  for (let index = 0; index + 2 < lines.length; index += 1) {
    if (lines[index] !== "1..0") continue;
    let wrapperIndex = index + 1;
    while (wrapperIndex < lines.length && /^#(?! Subtest:)/u.test(lines[wrapperIndex])) {
      wrapperIndex += 1;
    }
    if (!lines[wrapperIndex]?.startsWith("# Subtest: ")) continue;
    if (!/^ok \d+ - /u.test(lines[wrapperIndex + 1] ?? "")) continue;
    excludedFiles += 1;
  }
  return excludedFiles;
}

/**
 * Return the actual selected test counts for a name-pattern diagnostic.
 * Node reports an excluded file wrapper as one passing test, so remove only
 * those wrappers and leave all real skip/cancel/todo counts untouched.
 *
 * @param {string} output
 * @param {{ tests: number; pass: number }} summary
 * @returns {{ tests: number; pass: number }}
 */
export function selectedNamePatternSummary(output, summary) {
  const excludedFiles = countNamePatternExcludedFiles(output);
  return {
    tests: summary.tests - excludedFiles,
    pass: summary.pass - excludedFiles,
  };
}

export function parseRunnerOptions(options) {
  let namePattern;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    const optionName = normalizeOptionName(option);
    if (optionName === "--test-name-pattern") {
      if (namePattern !== undefined) {
        throw new Error("run-subagents-tests.mjs accepts --test-name-pattern only once");
      }
      const equalsIndex = option.indexOf("=");
      if (equalsIndex === -1) {
        const value = options[index + 1];
        if (!value || value.startsWith("-")) {
          throw new Error(
            "run-subagents-tests.mjs requires a non-empty pattern after --test-name-pattern; use --test-name-pattern=<pattern> for patterns beginning with '-'",
          );
        }
        namePattern = value;
        index += 1;
      } else {
        const value = option.slice(equalsIndex + 1);
        if (!value) {
          throw new Error("run-subagents-tests.mjs requires a non-empty --test-name-pattern");
        }
        namePattern = value;
      }
      continue;
    }

    const unsupported = unsupportedFilterOptions.find((flag) => optionName === flag);
    if (unsupported) {
      throw new Error(
        `run-subagents-tests.mjs does not support ${unsupported}; use the explicitly labeled --test-name-pattern diagnostic instead`,
      );
    }
  }
  return { diagnostic: namePattern !== undefined, namePattern };
}

function tokenizeNodeOptions(value) {
  const tokens = [];
  let token = "";
  let quote = null;
  let escaped = false;
  let tokenStarted = false;

  for (const character of value) {
    if (escaped) {
      token += character;
      escaped = false;
      tokenStarted = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else token += character;
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }
    token += character;
    tokenStarted = true;
  }

  if (escaped) token += "\\";
  if (quote !== null) throw new Error("NODE_OPTIONS contains an unterminated quote");
  if (tokenStarted) tokens.push(token);
  return tokens;
}

/**
 * Find a test-selection option inherited through NODE_OPTIONS.
 *
 * NODE_OPTIONS is a shell-like, whitespace-separated option list. This small
 * tokenizer handles the quoting forms Node accepts without changing the
 * original value or introducing a general CLI parser.
 *
 * @param {string | undefined} nodeOptions
 * @returns {string | undefined}
 */
export function findInheritedSelectionFilter(nodeOptions = "") {
  if (!nodeOptions) return undefined;
  for (const option of tokenizeNodeOptions(nodeOptions)) {
    const optionName = normalizeOptionName(option);
    const filter = inheritedSelectionFilterOptions.find((flag) => optionName === flag);
    if (filter) return filter;
  }
  return undefined;
}

function isSharded(options) {
  return options.some((option) => normalizeOptionName(option) === "--test-shard");
}

/**
 * Build the Node test-runner command arguments for an imported subagent suite.
 *
 * @param {{
 *   loader: string;
 *   options?: string[];
 *   files: string[];
 *   env?: Record<string, string | undefined>;
 * }} input
 * @returns {string[]}
 */
export function buildTestCommandArgs({ loader, options = [], files, env = process.env }) {
  const timingArgs = ciTimingReporterArgs({
    env,
    reporterPath: pathToFileURL(join(repoRoot, "scripts/ci-timing-reporter.mjs")).href,
  });
  return [
    "--experimental-strip-types",
    "--import",
    loader,
    "--test",
    "--test-reporter=tap",
    ...timingArgs,
    ...testConcurrencyArgs({ env }),
    ...options,
    ...files,
  ];
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
  const inheritedSelectionFilter = findInheritedSelectionFilter(parentEnv.NODE_OPTIONS);
  if (inheritedSelectionFilter) {
    throw new Error(
      `run-subagents-tests.mjs rejects ${inheritedSelectionFilter} inherited via NODE_OPTIONS; pass test-selection options directly instead`,
    );
  }

  const env = { ...parentEnv };
  // The reporter destination is already encoded in the child command args.
  // Keeping these paths in test-file environments lets nested runners reuse
  // and overwrite the current command's event file.
  delete env[CI_TIMINGS_DIR_ENV];
  delete env[CI_TIMINGS_EVENT_FILE_ENV];
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_SUBAGENTS_")) delete env[key];
  }
  delete env.NODE_TEST_CONTEXT;
  env.PI_CODING_AGENT_DIR = agentDir;
  // Scale spawn-heavy wait budgets on CI runners (see extensions/subagents/test/support/scale-timeout.ts).
  if (parentEnv.CI) env.TLH_TEST_TIMEOUT_SCALE = "3";
  return env;
}

export function runSuite(suite, options = [], { config = suiteConfigs[suite] } = {}) {
  if (!config) {
    console.error(
      "Usage: node scripts/run-subagents-tests.mjs <unit|integration|e2e> [node test options]",
    );
    return 2;
  }
  if (options.some((option) => normalizeOptionName(option) === "--test-reporter")) {
    console.error("run-subagents-tests.mjs controls the TAP reporter; do not pass --test-reporter");
    return 2;
  }

  let runnerOptions;
  try {
    runnerOptions = parseRunnerOptions(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  let files;
  try {
    files = discoverSuiteFiles(suite, config);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const loader = pathToFileURL(
    join(repoRoot, "extensions/subagents/test/support/register-loader.mjs"),
  ).href;
  let args;
  try {
    args = buildTestCommandArgs({ loader, options, files, env: process.env });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const root = mkdtempSync(join(tmpdir(), "tlh-subagents-tests-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  let env;
  try {
    env = buildChildEnv(process.env, agentDir);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
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
    const selectedSummary = runnerOptions.diagnostic
      ? selectedNamePatternSummary(result.stdout, summary)
      : undefined;
    validateTapSummary(suite, summary, {
      sharded: isSharded(options),
      minimumTests: config.minimumTests,
      diagnostic: runnerOptions.diagnostic,
      selectedTests: selectedSummary?.tests,
      selectedPasses: selectedSummary?.pass,
    });
  } catch (error) {
    relayFailureOutput(result);
    console.error(
      `Subagents ${suite} TAP validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  const fileLabel = `${files.length} file${files.length === 1 ? "" : "s"}`;
  if (runnerOptions.diagnostic) {
    const selectedSummary = selectedNamePatternSummary(result.stdout, summary);
    console.log(
      `subagents ${suite} diagnostic (--test-name-pattern): ${selectedSummary.pass}/${selectedSummary.tests} selected tests passed (${fileLabel})`,
    );
  } else {
    console.log(
      `subagents ${suite}: ${summary.pass}/${summary.tests} passed (${fileLabel}${isSharded(options) ? ", shard" : ""})`,
    );
  }
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  const [suite, ...options] = argv;
  return runSuite(suite, options);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  process.exitCode = main();
}

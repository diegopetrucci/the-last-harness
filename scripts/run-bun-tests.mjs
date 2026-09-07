#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildChildEnv,
  discoverSuiteFiles,
  repoRoot,
  suiteConfigs,
} from "./run-subagents-tests.mjs";

const scriptPath = fileURLToPath(import.meta.url);
export const REQUIRED_BUN_VERSION = "1.4.0";
export const DEFAULT_BUN_PARALLEL = 1;

export const bunSuiteConfigs = {
  root: {
    directory: join(repoRoot, "tests"),
    minimumFiles: 145,
    minimumTests: 2531,
  },
  ...suiteConfigs,
};

const suiteNames = ["root", "unit", "integration", "e2e"];
const bunStatusLabels = new Map([
  ["pass", "pass"],
  ["passes", "pass"],
  ["fail", "fail"],
  ["fails", "fail"],
  ["failure", "fail"],
  ["failures", "fail"],
  ["skip", "skipped"],
  ["skips", "skipped"],
  ["skipped", "skipped"],
  ["todo", "todo"],
  ["todos", "todo"],
  ["cancel", "cancelled"],
  ["canceled", "cancelled"],
  ["cancelled", "cancelled"],
]);

function parseBunParallel(value) {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("Bun worker count must be a positive integer in --parallel=N");
  }
  const parallel = Number(value);
  if (!Number.isSafeInteger(parallel)) {
    throw new Error("Bun worker count must be a positive integer in --parallel=N");
  }
  return parallel;
}

export function normalizeBunOptions(options = []) {
  let parallel = DEFAULT_BUN_PARALLEL;
  let parallelSpecified = false;
  const forwardedOptions = [];

  for (const option of options) {
    if (option === "--parallel") {
      throw new Error("Bun worker count requires an explicit value; use --parallel=N");
    }
    if (option.startsWith("--parallel=")) {
      if (parallelSpecified) {
        throw new Error(
          "Bun worker count was specified more than once; pass exactly one --parallel=N option",
        );
      }
      parallel = parseBunParallel(option.slice("--parallel=".length));
      parallelSpecified = true;
      continue;
    }
    if (option === "--no-isolate" || option.startsWith("--no-isolate=")) {
      throw new Error("Bun test file isolation is required; --no-isolate is not supported");
    }
    forwardedOptions.push(option);
  }

  return { options: forwardedOptions, parallel };
}

function discoverRootFiles(config = bunSuiteConfigs.root) {
  if (!config) throw new Error("Unknown Bun root test suite: root");

  const files = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(
        `Could not read root test directory ${directory}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".test.mjs")) files.push(entryPath);
    }
  };
  walk(config.directory);
  files.sort();

  if (files.length < config.minimumFiles) {
    throw new Error(
      `root suite found ${files.length} test files; expected at least ${config.minimumFiles}`,
    );
  }
  return files;
}

export function discoverBunSuiteFiles(suite, config = bunSuiteConfigs[suite]) {
  if (suite === "root") return discoverRootFiles(config);
  if (!suiteNames.includes(suite)) throw new Error(`Unknown Bun test suite: ${suite}`);
  return discoverSuiteFiles(suite, config);
}

function parseBunCountLine(line) {
  const match = /^\s*(\d+)\s+([a-z]+)\s*$/.exec(line);
  if (!match) return undefined;
  const label = bunStatusLabels.get(match[2].toLowerCase());
  if (!label) return undefined;
  return { label, count: Number.parseInt(match[1], 10) };
}

function parseSummaryCounts(lines, runIndex) {
  const counts = {
    pass: 0,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  };
  const seen = new Set();
  for (let index = runIndex - 1; index >= 0; index--) {
    const line = lines[index];
    if (line?.trim() === "") continue;
    const parsed = parseBunCountLine(line ?? "");
    if (!parsed) break;
    if (seen.has(parsed.label)) {
      throw new Error(`Bun summary contains multiple '${parsed.label}' count lines`);
    }
    seen.add(parsed.label);
    counts[parsed.label] = parsed.count;
  }
  return { counts, seen };
}

export function parseBunSummary(output) {
  const lines = output.split(/\r?\n/);
  const runPattern = /^Ran\s+(\d+)\s+tests?\s+across\s+(\d+)\s+files?\./i;
  const runIndexes = lines.flatMap((line, index) => (runPattern.test(line.trim()) ? [index] : []));
  const runIndex = runIndexes.at(-1);
  if (runIndex === undefined) {
    throw new Error("Bun summary is missing a 'Ran <tests> tests across <files> files.' line");
  }

  const lastNonEmptyIndex = lines.findLastIndex((line) => line.trim() !== "");
  if (lastNonEmptyIndex !== runIndex) {
    throw new Error("Bun summary must be the final non-empty output block");
  }

  // Bun omits zero-valued non-pass categories in the compact dots output;
  // parse only the count lines immediately preceding the final summary line so
  // test output cannot supply counts from an unrelated part of the run.
  const { counts, seen } = parseSummaryCounts(lines, runIndex);
  if (!seen.has("pass")) {
    throw new Error("Bun summary is missing the 'pass' count line");
  }
  const runMatch = runPattern.exec(lines[runIndex].trim());
  return {
    tests: Number.parseInt(runMatch[1], 10),
    files: Number.parseInt(runMatch[2], 10),
    ...counts,
  };
}

export function validateBunSummary(
  suite,
  summary,
  {
    sharded = false,
    minimumFiles = bunSuiteConfigs[suite]?.minimumFiles,
    minimumTests = bunSuiteConfigs[suite]?.minimumTests,
    discoveredFiles,
  } = {},
) {
  if (!Number.isInteger(summary.tests) || summary.tests <= 0) {
    throw new Error(`${suite} suite executed zero tests`);
  }
  if (!Number.isInteger(summary.files) || summary.files <= 0) {
    throw new Error(`${suite} suite reported zero files`);
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

  const accounted =
    summary.pass + summary.fail + summary.cancelled + summary.skipped + summary.todo;
  if (accounted !== summary.tests) {
    throw new Error(
      `${suite} suite summary counts total ${accounted}, but Bun reported ${summary.tests} tests`,
    );
  }

  if (!sharded) {
    if (minimumFiles !== undefined && summary.files < minimumFiles) {
      throw new Error(
        `${suite} suite reported ${summary.files} files; expected at least ${minimumFiles}`,
      );
    }
    if (discoveredFiles !== undefined && summary.files !== discoveredFiles) {
      throw new Error(
        `${suite} suite reported ${summary.files} files; discovered ${discoveredFiles} test files`,
      );
    }
    if (minimumTests !== undefined && summary.tests < minimumTests) {
      throw new Error(
        `${suite} suite executed ${summary.tests} tests; expected at least ${minimumTests}`,
      );
    }
  }
}

export function buildBunChildEnv(parentEnv, agentDir, rootDir) {
  const env = buildChildEnv(parentEnv, agentDir);
  const homeDir = join(rootDir, "home");
  const tempDir = join(rootDir, "tmp");
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  env.TMPDIR = tempDir;
  env.TEMP = tempDir;
  env.TMP = tempDir;
  env.TLH_TEST_NODE_EXEC_PATH = process.execPath;
  return env;
}

function isSharded(options) {
  return options.some((option) => option === "--shard" || option.startsWith("--shard="));
}

function rejectEmptyArguments(options) {
  if (!options.some((option) => option.length === 0)) return false;
  console.error("run-bun-tests.mjs does not accept empty arguments");
  return true;
}

function requireBunVersion(bunCommand) {
  const result = spawnSync(bunCommand, ["--version"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`Could not determine Bun version: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0 || result.signal) {
    throw new Error(
      `Could not determine Bun version: ${result.signal ? `signal ${result.signal}` : `status ${result.status}`}`,
    );
  }
  const version = String(result.stdout ?? "").trim();
  if (version !== REQUIRED_BUN_VERSION) {
    throw new Error(
      `Bun ${REQUIRED_BUN_VERSION} is required; found ${version || "unknown version"}`,
    );
  }
}

function relayFailureOutput(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function buildBunArgs(files, options, parallel) {
  const compatPreload = join(repoRoot, "tests", "bun-test-compat.mjs");
  const isolatePreload = join(repoRoot, "extensions/subagents/test/support/isolate-temp-root.mjs");
  return [
    "test",
    "--preload",
    compatPreload,
    "--preload",
    isolatePreload,
    "--dots",
    ...options,
    // Bun defaults to a five-second timeout. Keep the existing 30-second
    // timeout and conservative one-worker baseline while allowing an explicit
    // worker count for isolated experiments.
    "--timeout=30000",
    `--parallel=${parallel}`,
    ...files,
  ];
}

export function bunArgs(files, options = []) {
  const normalized = normalizeBunOptions(options);
  return buildBunArgs(files, normalized.options, normalized.parallel);
}

export function runBunSuite(
  suite,
  options = [],
  { bunCommand = process.env.TLH_BUN_BIN || "bun" } = {},
) {
  const config = bunSuiteConfigs[suite];
  if (!config) {
    console.error(
      `Usage: node scripts/run-bun-tests.mjs [${suiteNames.join("|")}] [bun test options]`,
    );
    return 2;
  }
  if (rejectEmptyArguments(options)) return 2;
  if (
    options.some(
      (option) =>
        option === "--reporter" ||
        option.startsWith("--reporter=") ||
        option === "--reporter-outfile" ||
        option.startsWith("--reporter-outfile="),
    )
  ) {
    console.error("run-bun-tests.mjs controls the Bun reporter; do not pass --reporter");
    return 2;
  }

  let normalizedOptions;
  try {
    normalizedOptions = normalizeBunOptions(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  try {
    requireBunVersion(bunCommand);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let files;
  try {
    files = discoverBunSuiteFiles(suite, config);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const root = mkdtempSync(join(tmpdir(), "tlh-bun-tests-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  const env = buildBunChildEnv(process.env, agentDir, root);
  mkdirSync(join(root, "home"), { recursive: true });
  mkdirSync(join(root, "tmp"), { recursive: true });

  let result;
  try {
    result = spawnSync(
      bunCommand,
      buildBunArgs(files, normalizedOptions.options, normalizedOptions.parallel),
      {
        cwd: repoRoot,
        env,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  if (result.error) {
    relayFailureOutput(result);
    console.error(`Could not spawn Bun ${suite} tests:`, result.error);
    return 1;
  }
  if (result.status !== 0 || result.signal) {
    relayFailureOutput(result);
    console.error(
      `Bun ${suite} tests exited with ${result.signal ? `signal ${result.signal}` : `status ${result.status}`}.`,
    );
    return result.status ?? 1;
  }

  let summary;
  try {
    summary = parseBunSummary(`${result.stdout}\n${result.stderr}`);
    validateBunSummary(suite, summary, {
      sharded: isSharded(options),
      minimumFiles: config.minimumFiles,
      minimumTests: config.minimumTests,
      discoveredFiles: files.length,
    });
  } catch (error) {
    relayFailureOutput(result);
    console.error(
      `Bun ${suite} summary validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  if (result.stderr) process.stderr.write(result.stderr);
  const fileLabel = `${files.length} file${files.length === 1 ? "" : "s"}`;
  console.log(`bun ${suite}: ${summary.pass}/${summary.tests} passed (${fileLabel})`);
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  if (rejectEmptyArguments(argv)) return 2;
  const [first, ...rest] = argv;
  if (first?.startsWith("-")) return runAllBunSuites(argv);
  if (first && suiteNames.includes(first)) return runBunSuite(first, rest);
  if (first === undefined) return runAllBunSuites([]);
  console.error(`Unknown Bun test suite '${first}'; expected ${suiteNames.join(", ")}`);
  return 2;
}

export function runAllBunSuites(options = []) {
  if (rejectEmptyArguments(options)) return 2;
  for (const suite of suiteNames) {
    const status = runBunSuite(suite, options);
    if (status !== 0) return status;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  process.exitCode = main();
}

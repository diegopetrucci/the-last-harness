#!/usr/bin/env node
/**
 * Compare the complete local Node and Bun test paths.
 *
 * This is deliberately a contributor-only benchmark. It invokes the existing
 * package test scripts rather than installing dependencies or changing their
 * runner options. Each repetition runs both paths sequentially, alternating
 * which runner goes first.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const scriptPath = fileURLToPath(import.meta.url);
export const repoRoot = resolve(dirname(scriptPath), "..");
export const DEFAULT_RUNS = 3;

const BENCHMARK_CAVEAT =
  "Caveat: canonical Node (npm test) runs test files in parallel processes; the viable Bun path is serialized with --parallel=1 to preserve this corpus's fixture/race assumptions.";
const BENCHMARK_COMPARISON_NOTE =
  "This compares the two viable repository test configurations, not equal-concurrency raw runtime throughput.";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
export const TEST_RUNNERS = Object.freeze({
  node: Object.freeze({
    name: "node",
    label: "Node",
    command: Object.freeze([npmCommand, "test"]),
  }),
  bun: Object.freeze({
    name: "bun",
    label: "Bun",
    command: Object.freeze([npmCommand, "run", "test:bun"]),
  }),
});

/**
 * Return the benchmark usage text.
 *
 * @returns {string}
 */
export function usage() {
  return `Usage: npm run benchmark:tests -- [--runs N | --runs=N]

Compare the complete Node and Bun test paths locally.

Options:
  --runs N       Number of complete samples for each runner (default: ${DEFAULT_RUNS})
  -h, --help     Show this help

Each sample runs npm test and npm run test:bun sequentially, alternating
which runner starts first. Dependencies are not installed by this command.

${BENCHMARK_CAVEAT}
${BENCHMARK_COMPARISON_NOTE}
`;
}

/**
 * Parse a positive integer option.
 *
 * @param {string | undefined} value
 * @param {string} flag
 * @returns {number}
 */
function parsePositiveInteger(value, flag) {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`${flag} must be a positive integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return number;
}

/**
 * Parse benchmark arguments.
 *
 * @param {string[]} [argv]
 * @returns {{ runs: number; help: boolean }}
 */
export function parseArgs(argv = process.argv.slice(2)) {
  let runs = DEFAULT_RUNS;
  let help = false;
  let runsSpecified = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }

    let value;
    if (arg === "--runs") {
      if (index + 1 >= argv.length || argv[index + 1].startsWith("-")) {
        throw new Error("--runs requires a value");
      }
      value = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--runs=")) {
      value = arg.slice("--runs=".length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (runsSpecified) {
      throw new Error("--runs specified more than once");
    }
    runs = parsePositiveInteger(value, "--runs");
    runsSpecified = true;
  }

  return { runs, help };
}

/**
 * Return an alternating runner order for a one-based repetition number.
 *
 * @param {number} repetition
 * @returns {string[]}
 */
export function runnerOrder(repetition) {
  if (!Number.isSafeInteger(repetition) || repetition < 1) {
    throw new Error("Benchmark repetition must be a positive integer");
  }
  return repetition % 2 === 1 ? ["node", "bun"] : ["bun", "node"];
}

/**
 * Calculate the median of finite numeric samples.
 *
 * @param {number[]} values
 * @returns {number}
 */
export function median(values) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("Median requires at least one finite numeric sample");
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

/**
 * Run one package test path and measure its wall-clock duration.
 *
 * Successful output is discarded to keep the benchmark report focused. The
 * output remains on the returned result so a failed path can relay diagnostics.
 *
 * @param {{ name: string; label: string; command: readonly string[] }} runner
 * @param {{
 *   cwd?: string;
 *   env?: NodeJS.ProcessEnv;
 *   now?: () => number;
 *   spawn?: typeof spawnSync;
 * }} [options]
 * @returns {{ ok: boolean; status: number | null; signal: NodeJS.Signals | null; elapsedMs: number; stdout?: string; stderr?: string; error?: Error }}
 */
export function runTestPath(
  runner,
  { cwd = repoRoot, env = process.env, now = () => performance.now(), spawn = spawnSync } = {},
) {
  const startedAt = now();
  let result;
  try {
    result = spawn(runner.command[0], runner.command.slice(1), {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    return {
      ok: false,
      status: null,
      signal: null,
      elapsedMs: now() - startedAt,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  const elapsedMs = now() - startedAt;
  const error = result.error instanceof Error ? result.error : undefined;
  const status = typeof result.status === "number" ? result.status : null;
  const signal = result.signal ?? null;
  return {
    ok: error === undefined && status === 0 && signal === null,
    status,
    signal,
    elapsedMs,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(error ? { error } : {}),
  };
}

/**
 * Format a measured duration for the human-readable report.
 *
 * @param {number} milliseconds
 * @returns {string}
 */
export function formatMilliseconds(milliseconds) {
  return `${milliseconds.toFixed(1)}ms`;
}

function describeFailure(result) {
  if (result.error) return result.error.message;
  if (result.signal) return `signal ${result.signal}`;
  return `exit ${result.status ?? "unknown"}`;
}

function relayFailure(runner, repetition, result, { stdout, stderr, error, log }) {
  if (result.stdout) stdout.write(result.stdout);
  if (result.stderr) stderr.write(result.stderr);
  error(
    `Benchmark stopped at run ${repetition}: ${runner.label} test path failed (${describeFailure(result)}).`,
  );
  log("No later runner or repetition was started.");
}

/**
 * Run the alternating benchmark and print its report.
 *
 * `run` is injectable so argument/order/failure behavior can be tested without
 * running the full corpus.
 *
 * @param {{
 *   runs?: number;
 *   run?: (runner: typeof TEST_RUNNERS.node, repetition: number) => ReturnType<typeof runTestPath>;
 *   log?: (message: string) => void;
 *   error?: (message: string) => void;
 *   stdout?: NodeJS.WritableStream;
 *   stderr?: NodeJS.WritableStream;
 * }} [options]
 * @returns {number}
 */
export function runBenchmark({
  runs = DEFAULT_RUNS,
  run = (runner) => runTestPath(runner),
  log = (message) => console.log(message),
  error = (message) => console.error(message),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  if (!Number.isSafeInteger(runs) || runs < 1) {
    throw new Error("Benchmark runs must be a positive integer");
  }

  const samples = { node: [], bun: [] };
  log(`Benchmarking complete Node and Bun test paths (${runs} run${runs === 1 ? "" : "s"}).`);
  log("No dependencies are installed; each runner uses the existing package test script.");
  log(BENCHMARK_CAVEAT);
  log(BENCHMARK_COMPARISON_NOTE);

  for (let repetition = 1; repetition <= runs; repetition += 1) {
    const order = runnerOrder(repetition);
    log(`Run ${repetition}/${runs}: ${order.join(" -> ")}`);

    for (const runnerName of order) {
      const runner = TEST_RUNNERS[runnerName];
      const result = run(runner, repetition);
      if (!result.ok) {
        relayFailure(runner, repetition, result, { stdout, stderr, error, log });
        return result.status !== null && result.status > 0 ? result.status : 1;
      }
      samples[runnerName].push(result.elapsedMs);
      log(`  ${runner.label}: ${formatMilliseconds(result.elapsedMs)}`);
    }
  }

  log(`Median total Node: ${formatMilliseconds(median(samples.node))}`);
  log(`Median total Bun: ${formatMilliseconds(median(samples.bun))}`);
  return 0;
}

/**
 * CLI entrypoint.
 *
 * @param {string[]} [argv]
 * @returns {number}
 */
export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    return 2;
  }

  if (options.help) {
    console.log(usage());
    return 0;
  }

  try {
    return runBenchmark({ runs: options.runs });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  process.exitCode = main();
}

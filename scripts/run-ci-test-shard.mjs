#!/usr/bin/env node
/**
 * CI test-shard entrypoint.
 *
 * Usage: node scripts/run-ci-test-shard.mjs <shard>/2 [--lane-layout=baseline|experimental]
 *
 * The default baseline runs two concurrent lanes for the given shard:
 *   Lane A: main tests → subagents unit → e2e (shard 1 only)
 *   Lane B: subagents integration
 *
 * The opt-in experimental layout runs three concurrent lanes:
 *   Lane root: main tests
 *   Lane unit: subagents unit → e2e (shard 1 only)
 *   Lane integration: subagents integration
 *
 * Per-lane HOME subdirectories are created under $HOME to prevent shared-state collisions.
 * All environment variables (CI, GITHUB_TOKEN, etc.) pass through unchanged.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CI_TIMINGS_DIR_ENV,
  CI_TIMINGS_EVENT_FILE_ENV,
  ciTimingReporterArgs,
  createCiTimingCollector,
  createCiTimingConfig,
  timingEnvironmentForCommand,
  timingEventFile,
  timingReporterPath,
} from "./ci-timings.mjs";
import {
  TEST_CONCURRENCY_ENV,
  parseTestConcurrency,
  testConcurrencyArgs,
} from "./test-concurrency.mjs";
import { runLanes } from "./run-lane.mjs";
import { findLeaks } from "./run-test-tmpdir-guard.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");

export const CI_LANE_LAYOUT_ENV = "TLH_CI_LANE_LAYOUT";
export const DEFAULT_CI_LANE_LAYOUT = "baseline";
const laneLayouts = new Set(["baseline", "experimental"]);

/**
 * Register synchronous, idempotent cleanup for a CI shard's temporary root.
 *
 * The returned cleanup function is used by the normal `finally` path. The
 * process-exit handler covers interruption paths where run-lane exits the
 * process before that `finally` block can run.
 *
 * @param {string} tmpdirRoot
 * @returns {() => void}
 */
export function registerTmpdirCleanup(tmpdirRoot) {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    rmSync(tmpdirRoot, { recursive: true, force: true });
  };

  process.once("exit", cleanup);
  return () => {
    cleanup();
    process.off("exit", cleanup);
  };
}

/**
 * Parse and validate the shard argument (must be "<N>/2" with N in 1..2).
 *
 * @param {string | undefined} shardArg
 * @returns {{ shard: number; shardStr: string }}
 */
export function parseShard(shardArg) {
  const match = /^(\d+)\/(\d+)$/.exec(shardArg ?? "");
  if (!match || match[2] !== "2") {
    throw new Error(`Expected <N>/2, got: ${shardArg}`);
  }
  const shard = Number.parseInt(match[1], 10);
  if (shard < 1 || shard > 2) {
    throw new Error(`Shard number must be 1 or 2, got: ${shard}`);
  }
  return { shard, shardStr: shardArg };
}

/**
 * Parse the explicit lane layout selector.
 *
 * @param {string | undefined} value
 * @returns {"baseline" | "experimental"}
 */
export function parseLaneLayout(value) {
  const layout = value ?? DEFAULT_CI_LANE_LAYOUT;
  if (!laneLayouts.has(layout)) {
    throw new Error(
      `${CI_LANE_LAYOUT_ENV} must be "baseline" or "experimental"; received ${JSON.stringify(value)}.`,
    );
  }
  return /** @type {"baseline" | "experimental"} */ (layout);
}

/**
 * Parse the shard-runner arguments and validate all options before any
 * temporary directories or child processes are created.
 *
 * @param {string[]} [argv]
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ shard: number; shardStr: string; laneLayout: "baseline" | "experimental" }}
 */
export function parseShardRunnerOptions(argv = process.argv.slice(2), env = process.env) {
  const [shardArg, ...options] = argv;
  let laneLayoutValue = env[CI_LANE_LAYOUT_ENV];
  let cliLaneLayout;

  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--lane-layout") {
      if (cliLaneLayout !== undefined) {
        throw new Error("run-ci-test-shard.mjs accepts --lane-layout only once");
      }
      const value = options[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(
          "run-ci-test-shard.mjs requires a value after --lane-layout; use --lane-layout=<layout> for an explicit value",
        );
      }
      cliLaneLayout = value;
      index += 1;
    } else if (option.startsWith("--lane-layout=")) {
      if (cliLaneLayout !== undefined) {
        throw new Error("run-ci-test-shard.mjs accepts --lane-layout only once");
      }
      cliLaneLayout = option.slice("--lane-layout=".length);
      if (!cliLaneLayout) {
        throw new Error("run-ci-test-shard.mjs requires a non-empty --lane-layout value");
      }
    } else {
      throw new Error(`Unknown run-ci-test-shard.mjs option: ${option}`);
    }
  }

  // Validate the existing environment override before spawning or creating
  // the shard's temporary root. The command builder validates it again when
  // projecting the setting into each Node test runner.
  parseTestConcurrency(env[TEST_CONCURRENCY_ENV]);
  const parsed = parseShard(shardArg);
  return {
    ...parsed,
    laneLayout: parseLaneLayout(cliLaneLayout ?? laneLayoutValue),
  };
}

/**
 * Build the lane definitions for a given shard.
 *
 * The baseline layout preserves the existing two lanes:
 *   Lane A: main tests → subagents unit → e2e (shard 1 only)
 *   Lane B: subagents integration
 *
 * The experimental layout uses three concurrent lanes:
 *   Lane root: main tests
 *   Lane unit: subagents unit → e2e (shard 1 only)
 *   Lane integration: subagents integration
 *
 * @param {number} shard
 * @param {string} shardStr
 * @param {Record<string, string | undefined>} [env]
 * @param {import("./ci-timings.mjs").TimingConfig | null} [timingConfig]
 * @param {"baseline" | "experimental"} [laneLayout]
 * @returns {import("./run-lane.mjs").Lane[]}
 */
export function buildLanes(
  shard,
  shardStr,
  env = process.env,
  timingConfig = null,
  laneLayout = parseLaneLayout(env[CI_LANE_LAYOUT_ENV]),
) {
  const subagentsScript = join(repoRoot, "scripts", "run-subagents-tests.mjs");
  const shardOption = `--test-shard=${shardStr}`;
  const concurrencyArgs = testConcurrencyArgs({ env });
  const resolvedLayout = parseLaneLayout(laneLayout);
  const config =
    timingConfig ??
    (env.TLH_CI_TIMINGS_DIR === undefined
      ? null
      : createCiTimingConfig({ env, repoRoot, shard: shardStr, laneLayout: resolvedLayout }));
  const reporterPath = config ? pathToFileURL(timingReporterPath(config)).href : null;
  const timingLaneEnv = config
    ? {
        [CI_TIMINGS_DIR_ENV]: undefined,
        [CI_TIMINGS_EVENT_FILE_ENV]: undefined,
      }
    : undefined;

  /**
   * @param {string} lane
   * @param {number} index
   * @param {string} suite
   * @returns {{ commandEnv: Record<string, string | undefined> | undefined; timing: { suite: string; eventFile: string } | undefined }}
   */
  const timingFor = (lane, index, suite) => {
    if (!config) return { commandEnv: undefined, timing: undefined };
    const eventFile = timingEventFile(config, { lane, index, suite });
    return {
      commandEnv: timingEnvironmentForCommand(config, { suite, eventFile }),
      timing: { suite, eventFile },
    };
  };

  const rootSpec = (lane, index) => {
    const timing = timingFor(lane, index, "root");
    const rootCommand = [
      process.execPath,
      "--test",
      "--test-reporter=dot",
      ...(config ? ciTimingReporterArgs({ env: timing.commandEnv, reporterPath }) : []),
      ...concurrencyArgs,
      shardOption,
      "tests/**/*.test.mjs",
    ];
    const commandEnv = timing.commandEnv
      ? {
          ...timing.commandEnv,
          // The destination is already a command-line argument. Do not expose
          // it to test files, which may launch another runner and overwrite it.
          [CI_TIMINGS_DIR_ENV]: undefined,
          [CI_TIMINGS_EVENT_FILE_ENV]: undefined,
        }
      : undefined;
    return { command: rootCommand, commandEnv, timing: timing.timing };
  };

  const subagentsSpec = (lane, index, suite) => {
    const timing = timingFor(lane, index, suite);
    return {
      command: [
        process.execPath,
        subagentsScript,
        suite,
        ...(suite === "e2e" ? [] : [shardOption]),
      ],
      commandEnv: timing.commandEnv,
      timing: timing.timing,
    };
  };

  const createLane = (name, specs) => {
    const lane = {
      name,
      commands: specs.map((spec) => spec.command),
    };
    if (config) {
      lane.env = timingLaneEnv;
      lane.commandEnvs = specs.map((spec) => spec.commandEnv);
      lane.timingCommands = specs.map((spec) => spec.timing);
    }
    return lane;
  };

  if (resolvedLayout === "experimental") {
    const unitSpecs = [subagentsSpec("unit", 0, "unit")];
    if (shard === 1) unitSpecs.push(subagentsSpec("unit", 1, "e2e"));
    return [
      createLane("root", [rootSpec("root", 0)]),
      createLane("unit", unitSpecs),
      createLane("integration", [subagentsSpec("integration", 0, "integration")]),
    ];
  }

  const baselineSpecs = [rootSpec("a", 0), subagentsSpec("a", 1, "unit")];
  if (shard === 1) baselineSpecs.push(subagentsSpec("a", 2, "e2e"));
  return [createLane("a", baselineSpecs), createLane("b", [subagentsSpec("b", 0, "integration")])];
}

/**
 * @param {string[]} [argv]
 * @returns {Promise<number>} exit code
 */
export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseShardRunnerOptions(argv, process.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    // Preserve the existing concise concurrency failure output; other
    // malformed runner arguments also receive the expanded usage hint.
    if (!message.startsWith(`${TEST_CONCURRENCY_ENV} `)) {
      process.stderr.write(
        "Usage: node scripts/run-ci-test-shard.mjs <shard>/2 [--lane-layout=baseline|experimental]\n",
      );
    }
    return 2;
  }

  const { shard, shardStr, laneLayout } = parsed;
  const baseHomeDir = process.env.HOME ?? join(repoRoot, ".tmp-ci-home");

  // Isolate each lane's temp output under a fresh per-run root so temp-dir
  // leaks are detectable and do not pollute the shared system TMPDIR.
  const tmpdirRoot = mkdtempSync(join(tmpdir(), "tlh-ci-shard-run-"));
  const cleanupTmpdir = registerTmpdirCleanup(tmpdirRoot);
  let timingConfig = null;
  let timing = null;
  let exitCode = 1;
  try {
    try {
      timingConfig = createCiTimingConfig({
        env: process.env,
        repoRoot,
        shard: shardStr,
        laneLayout,
        guardedRoots: [tmpdirRoot],
      });
    } catch (error) {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }

    let laneDefinitions;
    try {
      laneDefinitions = buildLanes(shard, shardStr, process.env, timingConfig, laneLayout);
    } catch (error) {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }

    timing = timingConfig ? createCiTimingCollector(timingConfig) : null;
    const tmpdirEnv = { TMPDIR: tmpdirRoot, TMP: tmpdirRoot, TEMP: tmpdirRoot };
    const lanes = laneDefinitions.map((lane) => ({
      ...lane,
      env: { ...lane.env, ...tmpdirEnv },
    }));

    try {
      exitCode = await runLanes(lanes, { baseHomeDir, cwd: repoRoot }, { timing });
      const leaks = findLeaks(tmpdirRoot);
      if (leaks.length > 0) {
        process.stderr.write(
          `[tlh] temp-dir leaks detected in CI shard:\n${leaks.map((n) => `  ${n}`).join("\n")}\n`,
        );
        if (exitCode === 0) exitCode = 1;
      }
    } catch (error) {
      process.stderr.write(
        `Fatal error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      exitCode = 1;
    }

    if (timing) {
      const result = timing.finalize(exitCode);
      if (!result.written && exitCode === 0) exitCode = 1;
    }
    return exitCode;
  } finally {
    cleanupTmpdir();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(
        `Fatal error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
}

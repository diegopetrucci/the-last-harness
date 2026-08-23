#!/usr/bin/env node
/**
 * CI test-shard entrypoint.
 *
 * Usage: node scripts/run-ci-test-shard.mjs <shard>/2
 *
 * Runs two concurrent lanes for the given shard:
 *   Lane A: main tests → subagents unit → e2e (shard 1 only)
 *   Lane B: subagents integration
 *
 * Per-lane HOME subdirectories are created under $HOME to prevent shared-state collisions.
 * All environment variables (CI, GITHUB_TOKEN, etc.) pass through unchanged.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runLanes } from "./run-lane.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");

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
 * Build the two lane definitions for a given shard.
 *
 *   Lane A: main tests → subagents unit → e2e (shard 1 only)
 *   Lane B: subagents integration
 *
 * @param {number} shard
 * @param {string} shardStr
 * @returns {import("./run-lane.mjs").Lane[]}
 */
export function buildLanes(shard, shardStr) {
  const subagentsScript = join(repoRoot, "scripts", "run-subagents-tests.mjs");
  const shardOption = `--test-shard=${shardStr}`;

  /** @type {string[][]} */
  const laneACommands = [
    [process.execPath, "--test", "--test-reporter=dot", shardOption, "tests/**/*.test.mjs"],
    [process.execPath, subagentsScript, "unit", shardOption],
  ];
  if (shard === 1) {
    laneACommands.push([process.execPath, subagentsScript, "e2e"]);
  }

  /** @type {import("./run-lane.mjs").Lane} */
  const laneA = { name: "a", commands: laneACommands };

  /** @type {import("./run-lane.mjs").Lane} */
  const laneB = {
    name: "b",
    commands: [[process.execPath, subagentsScript, "integration", shardOption]],
  };

  return [laneA, laneB];
}

/**
 * @param {string[]} [argv]
 * @returns {Promise<number>} exit code
 */
export async function main(argv = process.argv.slice(2)) {
  const [shardArg] = argv;

  let parsed;
  try {
    parsed = parseShard(shardArg);
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write("Usage: node scripts/run-ci-test-shard.mjs <shard>/2\n");
    return 2;
  }

  const { shard, shardStr } = parsed;
  const baseHomeDir = process.env.HOME ?? join(repoRoot, ".tmp-ci-home");
  const lanes = buildLanes(shard, shardStr);

  return runLanes(lanes, { baseHomeDir, cwd: repoRoot });
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

#!/usr/bin/env node
/**
 * Contributor validation entrypoint.
 *
 * The non-test commands come from validation-checks.mjs. npm test remains an
 * explicit contributor-only step between installer smoke and lint, matching the
 * historical `npm run validate` placement. Commands stop at the first failure.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectSequentialChecks, VALIDATION_CHECKS } from "./validation-checks.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");

export const TEST_AFTER_CHECK_ID = "check-installer-smoke";
export const TEST_COMMAND = Object.freeze(["npm", "test"]);

/**
 * Project the manifest into the complete contributor sequence, including the
 * non-manifest test step at its established position.
 *
 * @returns {Array<{ kind: "validation" | "test"; id: string; argv: string[] }>}
 */
export function projectContributorCommands(checks = VALIDATION_CHECKS) {
  const commands = [];
  let insertedTest = false;

  for (const check of projectSequentialChecks(checks)) {
    commands.push({ kind: "validation", id: check.id, argv: [...check.argv] });
    if (check.id === TEST_AFTER_CHECK_ID) {
      commands.push({ kind: "test", id: "npm-test", argv: [...TEST_COMMAND] });
      insertedTest = true;
    }
  }

  if (!insertedTest) {
    throw new Error(
      `Contributor validation manifest must include ${TEST_AFTER_CHECK_ID} to place npm test.`,
    );
  }

  return commands;
}

/**
 * Run one command with the contributor's normal environment and working tree.
 *
 * @param {string[]} argv
 * @returns {number}
 */
function runCommand(argv) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    process.stderr.write(`Failed to run ${argv.join(" ")}: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

/**
 * Run contributor validation sequentially and fail fast.
 *
 * @param {{
 *   checks?: ReadonlyArray<Readonly<{ id: string; argv: readonly string[]; lane: string; order: number }>>;
 *   run?: (argv: string[], command: { kind: "validation" | "test"; id: string; argv: string[] }) => number;
 * }} [options]
 * @returns {number}
 */
export function runContributorValidation({ checks = VALIDATION_CHECKS, run = runCommand } = {}) {
  for (const command of projectContributorCommands(checks)) {
    const status = run(command.argv, command);
    if (status !== 0) return typeof status === "number" ? status : 1;
  }
  return 0;
}

export async function main() {
  return runContributorValidation();
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
      process.exitCode = 1;
    });
}

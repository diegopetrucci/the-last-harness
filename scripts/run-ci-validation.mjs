#!/usr/bin/env node
/**
 * CI validation entrypoint.
 *
 * Usage:
 *   node scripts/run-ci-validation.mjs                      # run all lanes
 *   node scripts/run-ci-validation.mjs --lanes=lint,pkg      # run only named lanes
 *   node scripts/run-ci-validation.mjs --exclude=smoke       # run all lanes except named ones
 *
 * Flags (mutually exclusive):
 *   --lanes=<a,b,...>    comma-separated list of lanes to run (and nothing else)
 *   --exclude=<a,b,...>  comma-separated list of lanes to skip
 *   Both flags also accept the space form: --lanes lint,pkg or --exclude smoke
 *
 * Runs all 11 non-test validation checks in concurrent lanes.
 * This is the CI-only parallel runner; 'npm run validate' stays sequential for contributors.
 *
 * Lane grouping:
 *   - smoke:        bash scripts/check-installer-smoke.sh (~15s)
 *   - typecheck-rt: npm run typecheck:runtime (~10s)
 *   - check-rt:     npm run check:runtime (~10s)
 *   - typecheck:    npm run typecheck (~8s)
 *   - lint:         npm run lint → npm run format:check → npm run lint:sh (~6.5s)
 *   - pkg:          npm run check:package-versions → npm run check:package-contents →
 *                   node scripts/merge-settings.mjs --dry-run → npm pack --dry-run (~5s)
 *
 * Sequential within "lint": lint:sh downloads the shellcheck binary into node_modules/;
 * keeping the Oxlint, Oxfmt, and ShellCheck checks sequential prevents that write from
 * overlapping either tool run.
 *
 * Sequential within "pkg": check:package-contents and npm pack --dry-run both inspect
 * packaging metadata; sequential ordering avoids any shared-state hazard between them.
 *
 * typecheck:runtime and check:runtime run in separate lanes (each compiles to its own
 * mkdtempSync directory and never writes into the repo), as noted in the design.
 *
 * Lane split usage in CI: pass --lanes or --exclude to a job so that only the relevant
 * subset of checks runs in that job, while LANES stays the single source of truth.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runLanes } from "./run-lane.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");

const mergeSettingsScript = join(repoRoot, "scripts", "merge-settings.mjs");

/**
 * All validation checks, organized as concurrent lanes.
 * Commands within a lane run sequentially; lanes run concurrently.
 *
 * @type {import("./run-lane.mjs").Lane[]}
 */
export const LANES = [
  {
    name: "smoke",
    commands: [["bash", "scripts/check-installer-smoke.sh"]],
  },
  {
    name: "typecheck-rt",
    commands: [["npm", "run", "typecheck:runtime"]],
  },
  {
    name: "check-rt",
    commands: [["npm", "run", "check:runtime"]],
  },
  {
    name: "typecheck",
    commands: [["npm", "run", "typecheck"]],
  },
  {
    name: "lint",
    commands: [
      // lint:sh downloads shellcheck into node_modules/; keep sequential with lint to
      // avoid concurrent writes to node_modules while the Oxlint/Oxfmt checks are running.
      ["npm", "run", "lint"],
      ["npm", "run", "format:check"],
      ["npm", "run", "lint:sh"],
    ],
  },
  {
    name: "pkg",
    commands: [
      ["npm", "run", "check:package-versions"],
      // check:package-contents and npm pack --dry-run both inspect packaging metadata;
      // run them sequentially to avoid any shared-state hazard.
      ["npm", "run", "check:package-contents"],
      [process.execPath, mergeSettingsScript, "--dry-run"],
      ["npm", "pack", "--dry-run"],
    ],
  },
];

/**
 * Parse argv for --lanes and --exclude flags and return the selected subset of lanes.
 * Accepts both '--lanes=a,b' and '--lanes a,b' forms (and same for --exclude).
 *
 * @param {import("./run-lane.mjs").Lane[]} lanes - all available lanes
 * @param {string[]} argv - command-line arguments
 * @returns {import("./run-lane.mjs").Lane[]} selected lanes
 * @throws {Error} if argv is invalid (unknown lane, conflicting flags, empty selection)
 */
export function selectLanes(lanes, argv) {
  const validNames = lanes.map((l) => l.name);
  /** @type {string | null} */
  let lanesArg = null;
  /** @type {string | null} */
  let excludeArg = null;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith("--lanes=")) {
      if (lanesArg !== null) {
        throw new Error(
          `--lanes specified more than once; use a single comma-separated list, e.g. --lanes=lint,pkg\nValid lanes: ${validNames.join(", ")}`,
        );
      }
      lanesArg = arg.slice("--lanes=".length);
      i++;
    } else if (arg === "--lanes") {
      if (lanesArg !== null) {
        throw new Error(
          `--lanes specified more than once; use a single comma-separated list, e.g. --lanes=lint,pkg\nValid lanes: ${validNames.join(", ")}`,
        );
      }
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error(
          `--lanes requires a value, e.g. --lanes=lint or --lanes lint\nValid lanes: ${validNames.join(", ")}`,
        );
      }
      lanesArg = argv[i + 1];
      i += 2;
    } else if (arg.startsWith("--exclude=")) {
      if (excludeArg !== null) {
        throw new Error(
          `--exclude specified more than once; use a single comma-separated list, e.g. --exclude=lint,pkg\nValid lanes: ${validNames.join(", ")}`,
        );
      }
      excludeArg = arg.slice("--exclude=".length);
      i++;
    } else if (arg === "--exclude") {
      if (excludeArg !== null) {
        throw new Error(
          `--exclude specified more than once; use a single comma-separated list, e.g. --exclude=lint,pkg\nValid lanes: ${validNames.join(", ")}`,
        );
      }
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error(
          `--exclude requires a value, e.g. --exclude=lint or --exclude lint\nValid lanes: ${validNames.join(", ")}`,
        );
      }
      excludeArg = argv[i + 1];
      i += 2;
    } else {
      throw new Error(
        `Unknown argument: ${arg}\nValid flags: --lanes=<names> or --exclude=<names> (comma-separated lane names: ${validNames.join(", ")})`,
      );
    }
  }

  if (lanesArg !== null && excludeArg !== null) {
    throw new Error("--lanes and --exclude are mutually exclusive; use one or the other.");
  }

  if (lanesArg === null && excludeArg === null) {
    return lanes;
  }

  if (lanesArg !== null) {
    const selected = lanesArg
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    const unknown = selected.filter((n) => !validNames.includes(n));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown lane(s): ${unknown.join(", ")}\nValid lanes: ${validNames.join(", ")}`,
      );
    }
    const result = lanes.filter((l) => selected.includes(l.name));
    if (result.length === 0) {
      throw new Error(`--lanes resolved to zero lanes. Valid lanes: ${validNames.join(", ")}`);
    }
    return result;
  }

  // excludeArg !== null
  const excluded = excludeArg
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  const unknown = excluded.filter((n) => !validNames.includes(n));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown lane(s) in --exclude: ${unknown.join(", ")}\nValid lanes: ${validNames.join(", ")}`,
    );
  }
  const result = lanes.filter((l) => !excluded.includes(l.name));
  if (result.length === 0) {
    throw new Error(`--exclude resolved to zero lanes. Valid lanes: ${validNames.join(", ")}`);
  }
  return result;
}

/**
 * @param {string[]} [argv]
 * @returns {Promise<number>} exit code
 */
export async function main(argv = process.argv.slice(2)) {
  const baseHomeDir = process.env.HOME ?? join(repoRoot, ".tmp-ci-home");

  let selectedLanes;
  try {
    selectedLanes = selectLanes(LANES, argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  return runLanes(selectedLanes, { baseHomeDir, cwd: repoRoot });
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

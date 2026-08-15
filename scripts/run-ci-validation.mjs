#!/usr/bin/env node
/**
 * CI validation entrypoint.
 *
 * Usage: node scripts/run-ci-validation.mjs
 *
 * Runs all 10 non-test validation checks in concurrent lanes.
 * This is the CI-only parallel runner; 'npm run validate' stays sequential for contributors.
 *
 * Lane grouping:
 *   - smoke:        bash scripts/check-installer-smoke.sh (~15s)
 *   - typecheck-rt: npm run typecheck:runtime (~10s)
 *   - check-rt:     npm run check:runtime (~10s)
 *   - typecheck:    npm run typecheck (~8s)
 *   - lint:         npm run lint → npm run lint:sh (~6.5s)
 *   - pkg:          npm run check:package-versions → npm run check:package-contents →
 *                   node scripts/merge-settings.mjs --dry-run → npm pack --dry-run (~5s)
 *
 * Sequential within "lint": lint:sh downloads the shellcheck binary into node_modules/;
 * running lint and lint:sh sequentially avoids concurrent node_modules writes.
 *
 * Sequential within "pkg": check:package-contents and npm pack --dry-run both inspect
 * packaging metadata; sequential ordering avoids any shared-state hazard between them.
 *
 * typecheck:runtime and check:runtime run in separate lanes (each compiles to its own
 * mkdtempSync directory and never writes into the repo), as noted in the design.
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
			// avoid concurrent writes to node_modules while biome check is running.
			["npm", "run", "lint"],
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
 * @param {string[]} [_argv]
 * @returns {Promise<number>} exit code
 */
export async function main(_argv = process.argv.slice(2)) {
	const baseHomeDir = process.env.HOME ?? join(repoRoot, ".tmp-ci-home");
	return runLanes(LANES, { baseHomeDir, cwd: repoRoot });
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
	main()
		.then((exitCode) => {
			process.exitCode = exitCode;
		})
		.catch((error) => {
			process.stderr.write(`Fatal error: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exit(1);
		});
}

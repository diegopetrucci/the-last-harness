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
		minimumFiles: 87,
		minimumTests: 990,
	},
	integration: {
		directory: join(repoRoot, "extensions/subagents/test/integration"),
		minimumFiles: 22,
		minimumTests: 507,
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
		throw new Error(`${suite} suite found ${files.length} test files; expected at least ${config.minimumFiles}`);
	}
	return files;
}

export function parseTapSummary(output) {
	const summary = {};
	for (const field of summaryFields) {
		const matches = [...output.matchAll(new RegExp(`^# ${field} (\\d+)\\r?$`, "gm"))];
		if (matches.length !== 1) {
			throw new Error(`TAP summary must contain exactly one '# ${field} <count>' line; found ${matches.length}`);
		}
		summary[field] = Number.parseInt(matches[0][1], 10);
	}
	return summary;
}

export function validateTapSummary(suite, summary, { sharded = false, minimumTests = suiteConfigs[suite]?.minimumTests } = {}) {
	if (!Number.isInteger(summary.tests) || summary.tests <= 0) {
		throw new Error(`${suite} suite executed zero tests`);
	}
	for (const field of ["fail", "cancelled", "skipped", "todo"]) {
		if (summary[field] !== 0) {
			throw new Error(`${suite} suite reported ${field}=${summary[field]}; every executed test must pass`);
		}
	}
	if (summary.pass !== summary.tests) {
		throw new Error(`${suite} suite reported pass=${summary.pass}, tests=${summary.tests}`);
	}
	if (!sharded && summary.tests < minimumTests) {
		throw new Error(`${suite} suite executed ${summary.tests} tests; expected at least ${minimumTests}`);
	}
}

function isSharded(options) {
	return options.some((option) => option === "--test-shard" || option.startsWith("--test-shard="));
}

function relayFailureOutput(result) {
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
}

export function runSuite(suite, options = []) {
	const config = suiteConfigs[suite];
	if (!config) {
		console.error("Usage: node scripts/run-subagents-tests.mjs <unit|integration|e2e> [node test options]");
		return 2;
	}
	if (options.some((option) => option === "--test-reporter" || option.startsWith("--test-reporter="))) {
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
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_SUBAGENTS_")) delete env[key];
	}
	delete env.NODE_TEST_CONTEXT;
	env.PI_CODING_AGENT_DIR = agentDir;

	const loader = pathToFileURL(join(repoRoot, "extensions/subagents/test/support/register-loader.mjs")).href;
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
		console.error(`Subagents ${suite} tests exited with ${result.signal ? `signal ${result.signal}` : `status ${result.status}`}.`);
		return result.status ?? 1;
	}

	let summary;
	try {
		summary = parseTapSummary(result.stdout);
		validateTapSummary(suite, summary, { sharded: isSharded(options), minimumTests: config.minimumTests });
	} catch (error) {
		relayFailureOutput(result);
		console.error(`Subagents ${suite} TAP validation failed: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}

	const fileLabel = `${files.length} file${files.length === 1 ? "" : "s"}`;
	console.log(`subagents ${suite}: ${summary.pass}/${summary.tests} passed (${fileLabel}${isSharded(options) ? ", shard" : ""})`);
	return 0;
}

export function main(argv = process.argv.slice(2)) {
	const [suite, ...options] = argv;
	return runSuite(suite, options);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
	process.exitCode = main();
}

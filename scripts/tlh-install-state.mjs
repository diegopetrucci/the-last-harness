#!/usr/bin/env node
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

function usage() {
	return `Usage: tlh-install-state.mjs [options]

Write The Last Harness installer update metadata.

Options:
  --state-path PATH                 install-state.json path
  --repo OWNER/REPO                 GitHub repository
  --ref REF                         Installed ref/tag/commit
  --track TRACK                     Update track
  --package-source SOURCE           Pi package source
  --package-source-is-default BOOL  Whether package source was installer-derived
  --raw-base URL                    Raw support-file base URL
  --agent-dir DIR                   Isolated Pi agent dir
  --bin-dir DIR                     Wrapper install dir
  --wrapper-name NAME               Wrapper command name
  --dry-run                         Print intended changes without writing
  --quiet                           Suppress non-essential output
  -h, --help                        Show this help
`;
}

function requiredValue(argv, index, flag) {
	const value = argv[index];
	if (!value || value.startsWith("-")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function parseArgs(argv) {
	const args = {
		statePath: undefined,
		repo: undefined,
		ref: undefined,
		track: undefined,
		packageSource: undefined,
		packageSourceIsDefault: undefined,
		rawBase: undefined,
		agentDir: undefined,
		binDir: undefined,
		wrapperName: undefined,
		dryRun: false,
		quiet: false,
		help: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "-h" || arg === "--help") {
			args.help = true;
			continue;
		}
		if (arg === "--dry-run") {
			args.dryRun = true;
			continue;
		}
		if (arg === "--quiet") {
			args.quiet = true;
			continue;
		}
		if (arg === "--state-path") {
			args.statePath = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--state-path=")) {
			args.statePath = arg.slice("--state-path=".length);
			continue;
		}
		if (arg === "--repo") {
			args.repo = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--repo=")) {
			args.repo = arg.slice("--repo=".length);
			continue;
		}
		if (arg === "--ref") {
			args.ref = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--ref=")) {
			args.ref = arg.slice("--ref=".length);
			continue;
		}
		if (arg === "--track") {
			args.track = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--track=")) {
			args.track = arg.slice("--track=".length);
			continue;
		}
		if (arg === "--package-source") {
			args.packageSource = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--package-source=")) {
			args.packageSource = arg.slice("--package-source=".length);
			continue;
		}
		if (arg === "--package-source-is-default") {
			args.packageSourceIsDefault = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--package-source-is-default=")) {
			args.packageSourceIsDefault = arg.slice("--package-source-is-default=".length);
			continue;
		}
		if (arg === "--raw-base") {
			args.rawBase = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--raw-base=")) {
			args.rawBase = arg.slice("--raw-base=".length);
			continue;
		}
		if (arg === "--agent-dir") {
			args.agentDir = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--agent-dir=")) {
			args.agentDir = arg.slice("--agent-dir=".length);
			continue;
		}
		if (arg === "--bin-dir") {
			args.binDir = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--bin-dir=")) {
			args.binDir = arg.slice("--bin-dir=".length);
			continue;
		}
		if (arg === "--wrapper-name") {
			args.wrapperName = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--wrapper-name=")) {
			args.wrapperName = arg.slice("--wrapper-name=".length);
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	return args;
}

function validateArgs(args) {
	for (const [key, flag] of [
		["statePath", "--state-path"],
		["repo", "--repo"],
		["ref", "--ref"],
		["track", "--track"],
		["packageSource", "--package-source"],
		["packageSourceIsDefault", "--package-source-is-default"],
		["rawBase", "--raw-base"],
		["agentDir", "--agent-dir"],
		["binDir", "--bin-dir"],
		["wrapperName", "--wrapper-name"],
	]) {
		if (!args[key]) throw new Error(`${flag} is required`);
	}
}

function parseBoolean(value, flag) {
	if (value === true || value === "true") return true;
	if (value === false || value === "false") return false;
	throw new Error(`${flag} must be true or false`);
}

function log(args, message) {
	if (!args.quiet) console.log(message);
}

function buildState(args) {
	return {
		schemaVersion: 1,
		repo: args.repo,
		ref: args.ref,
		track: args.track,
		packageSource: args.packageSource,
		packageSourceIsDefault: parseBoolean(args.packageSourceIsDefault, "--package-source-is-default"),
		rawBase: args.rawBase,
		agentDir: args.agentDir,
		binDir: args.binDir,
		wrapperName: args.wrapperName,
		installedAt: new Date().toISOString(),
	};
}

function writeInstallState(args) {
	if (args.dryRun) {
		log(args, `Would write tlh update metadata: ${args.statePath}`);
		return;
	}

	const state = buildState(args);
	const tmpPath = `${args.statePath}.tmp.${process.pid}`;
	mkdirSync(dirname(args.statePath), { recursive: true });
	try {
		writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		renameSync(tmpPath, args.statePath);
	} catch (error) {
		rmSync(tmpPath, { force: true });
		throw error;
	}
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		process.stdout.write(usage());
		return;
	}
	validateArgs(args);
	writeInstallState(args);
}

try {
	main();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`error: ${message}`);
	process.exitCode = 1;
}

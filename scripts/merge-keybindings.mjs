#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import process from "node:process";

import {
	assertNotInNormalPiConfig,
	backupPathWithTimestamp,
	readJsonFile,
	requiredValue,
} from "./lib/tlh-install-utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function usage() {
	return `Usage: node scripts/merge-keybindings.mjs [defaults.json] [options]

Merge TLH default keybindings into the isolated TLH profile without clobbering user values.

Options:
  --keybindings <path>    Keybindings file to update (default: ~/.the-last-harness/agent/keybindings.json, or PI_CODING_AGENT_DIR/keybindings.json)
  --defaults <path>       Default keybindings file (default: config/keybindings.defaults.json next to this script)
  --dry-run               Print intended changes without writing
  --quiet                 Only print errors
  -h, --help              Show this help
`;
}

function parseArgs(argv) {
	const args = {
		defaultsPath: undefined,
		keybindingsPath: undefined,
		dryRun: false,
		quiet: false,
		help: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--dry-run") {
			args.dryRun = true;
			continue;
		}
		if (arg === "--quiet") {
			args.quiet = true;
			continue;
		}
		if (arg === "-h" || arg === "--help") {
			args.help = true;
			continue;
		}
		if (arg === "--keybindings") {
			args.keybindingsPath = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--keybindings=")) {
			args.keybindingsPath = arg.slice("--keybindings=".length);
			continue;
		}
		if (arg === "--defaults") {
			args.defaultsPath = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--defaults=")) {
			args.defaultsPath = arg.slice("--defaults=".length);
			continue;
		}
		if (arg.startsWith("-")) {
			throw new Error(`Unknown option: ${arg}`);
		}
		if (args.defaultsPath) {
			throw new Error(`Unexpected extra argument: ${arg}`);
		}
		args.defaultsPath = arg;
	}

	return args;
}

function getAgentDir() {
	return process.env.PI_CODING_AGENT_DIR || process.env.TLH_AGENT_DIR || join(homedir(), ".the-last-harness", "agent");
}

function defaultKeybindingsPath() {
	return join(getAgentDir(), "keybindings.json");
}

function defaultDefaultsPath() {
	return join(resolve(__dirname, ".."), "config", "keybindings.defaults.json");
}

function isPlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

const legacyKeybindingOwners = new Map([["app.thinking.cycle", ["cycleThinkingLevel"]]]);

function hasExistingKeybindingOwner(keybindings, key) {
	if (Object.hasOwn(keybindings, key)) return true;
	return legacyKeybindingOwners.get(key)?.some((legacyKey) => Object.hasOwn(keybindings, legacyKey)) ?? false;
}

function mergeKeybindings(existing, defaults) {
	if (!isPlainObject(existing)) {
		throw new Error("Existing keybindings must be a JSON object");
	}
	if (!isPlainObject(defaults)) {
		throw new Error("Default keybindings must be a JSON object");
	}

	const next = clone(existing);
	const changes = [];
	for (const [key, value] of Object.entries(defaults)) {
		if (hasExistingKeybindingOwner(next, key)) continue;
		next[key] = clone(value);
		changes.push(`set ${key}`);
	}

	return { next, changes };
}

function backupPathFor(keybindingsPath) {
	return backupPathWithTimestamp(keybindingsPath);
}

function assertKeybindingsTarget(keybindingsPath) {
	if (basename(resolve(keybindingsPath)) !== "keybindings.json") {
		throw new Error(`Refusing to modify non-keybindings file: ${keybindingsPath}`);
	}

	assertNotInNormalPiConfig(
		keybindingsPath,
		`Refusing to modify normal Pi config from The Last Harness installer: ${keybindingsPath}`,
	);
}

function writeKeybindings(keybindingsPath, value, { dryRun, existed }) {
	const formatted = `${JSON.stringify(value, null, 2)}\n`;
	if (dryRun) return undefined;

	mkdirSync(dirname(keybindingsPath), { recursive: true });
	let backupPath;
	if (existed) {
		backupPath = backupPathFor(keybindingsPath);
		copyFileSync(keybindingsPath, backupPath);
	}

	const tempPath = `${keybindingsPath}.tmp-${process.pid}`;
	writeFileSync(tempPath, formatted, "utf8");
	renameSync(tempPath, keybindingsPath);
	return backupPath;
}

function log(args, message) {
	if (!args.quiet) console.log(message);
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(usage());
		return;
	}

	const defaultsPath = resolve(args.defaultsPath || defaultDefaultsPath());
	const keybindingsPath = resolve(args.keybindingsPath || defaultKeybindingsPath());
	assertKeybindingsTarget(keybindingsPath);
	const existed = existsSync(keybindingsPath);
	const existing = readJsonFile(keybindingsPath, { missingValue: {} });
	const defaults = readJsonFile(defaultsPath);
	const { next, changes } = mergeKeybindings(existing, defaults);

	log(args, `Keybindings: ${keybindingsPath}`);
	if (changes.length === 0) {
		log(args, "No keybinding changes needed.");
		return;
	}

	for (const change of changes) {
		log(args, `${args.dryRun ? "Would" : "Will"} ${change}`);
	}

	if (args.dryRun) {
		if (existed) log(args, "Would back up existing keybindings before writing.");
		log(args, "Dry run only; no keybindings were changed.");
		return;
	}

	const backupPath = writeKeybindings(keybindingsPath, next, { dryRun: args.dryRun, existed });
	if (backupPath) log(args, `Backed up previous keybindings to: ${backupPath}`);
	log(args, "Keybindings updated.");
}

try {
	main();
} catch (error) {
	console.error(`merge-keybindings: ${error.message}`);
	process.exit(1);
}

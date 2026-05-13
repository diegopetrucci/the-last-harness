#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import process from "node:process";

const VALIDATION_TIMEOUT_MS = 5000;

function usage() {
	return `Usage: tlh gnosis <command>

Manage Gnosis integration in the isolated tlh profile.

Commands:
  status               Show integration status and detected gn binary
  enable               Enable Gnosis prompt integration
  disable              Disable Gnosis prompt integration
  state                Print enabled, disabled, or unset (installer internal)
  validate [path]      Validate a gnosis binary, or print the first valid one

Options:
  --settings <path>    Settings file to update (default: ~/.the-last-harness/agent/settings.json, or PI_CODING_AGENT_DIR/settings.json)
  --agent-dir <dir>    Isolated Pi agent dir (default: ~/.the-last-harness/agent, or PI_CODING_AGENT_DIR)
  --install-path <p>   Store this gn binary path when enabling
  --dry-run            Print intended changes without writing
  --quiet              Only print errors
  -h, --help           Show this help
`;
}

function parseArgs(argv) {
	const args = {
		settingsPath: undefined,
		agentDir: undefined,
		installPath: undefined,
		command: undefined,
		commandArgs: [],
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
		if (arg === "--settings") {
			args.settingsPath = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--settings=")) {
			args.settingsPath = arg.slice("--settings=".length);
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
		if (arg === "--install-path") {
			args.installPath = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--install-path=")) {
			args.installPath = arg.slice("--install-path=".length);
			continue;
		}
		if (arg.startsWith("-")) {
			throw new Error(`Unknown option: ${arg}`);
		}
		if (!args.command) {
			args.command = arg;
		} else {
			args.commandArgs.push(arg);
		}
	}

	return args;
}

function requiredValue(argv, index, flag) {
	const value = argv[index];
	if (!value || value.startsWith("-")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function expandHome(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function getAgentDir(argAgentDir) {
	return expandHome(argAgentDir || process.env.PI_CODING_AGENT_DIR || process.env.TLH_AGENT_DIR || join(homedir(), ".the-last-harness", "agent"));
}

function defaultSettingsPath(agentDir) {
	return join(agentDir, "settings.json");
}

function readJson(path, { missingValue } = {}) {
	if (!existsSync(path)) {
		if (missingValue !== undefined) return missingValue;
		throw new Error(`File does not exist: ${path}`);
	}
	const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
	if (!raw.trim()) return {};
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new Error(`Invalid JSON in ${path}: ${error.message}`);
	}
}

function isPlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateSettings(settings) {
	if (!isPlainObject(settings)) {
		throw new Error("Settings must be a JSON object");
	}
	if (settings.tlh !== undefined && !isPlainObject(settings.tlh)) {
		throw new Error("Settings field 'tlh' must be an object if present");
	}
	if (settings.tlh?.gnosis !== undefined && !isPlainObject(settings.tlh.gnosis)) {
		throw new Error("Settings field 'tlh.gnosis' must be an object if present");
	}
}

function ensureMutableSettings(settings) {
	validateSettings(settings);
	settings.tlh ??= {};
	settings.tlh.gnosis ??= {};
}

function loadSettings(settingsPath) {
	const previousRaw = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "") : "";
	const settings = readJson(settingsPath, { missingValue: {} });
	validateSettings(settings);
	return { settings, previousRaw };
}

function gnosisState(settings) {
	const enabled = settings.tlh?.gnosis?.enabled;
	if (enabled === true) return "enabled";
	if (enabled === false) return "disabled";
	return "unset";
}

function normalizedInstallPath(path) {
	if (!path) return undefined;
	return resolve(expandHome(path));
}

function configuredInstallPath(settings) {
	const path = settings.tlh?.gnosis?.installPath;
	return typeof path === "string" && path.trim() ? normalizedInstallPath(path.trim()) : undefined;
}

function candidateCommands(settings, agentDir) {
	const candidates = [configuredInstallPath(settings), join(agentDir, "bin", "gn"), "gn"].filter(Boolean);
	const seen = new Set();
	const unique = [];
	for (const candidate of candidates) {
		const key = candidate === "gn" ? candidate : resolve(candidate);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(candidate);
	}
	return unique;
}

function validateGnosisCommand(command) {
	for (const args of [["help", "plan"], ["help", "review"]]) {
		const result = spawnSync(command, args, { stdio: "ignore", timeout: VALIDATION_TIMEOUT_MS });
		if (result.error || result.status !== 0) return false;
	}
	return true;
}

function findValidGnosis(settings, agentDir) {
	for (const candidate of candidateCommands(settings, agentDir)) {
		if (validateGnosisCommand(candidate)) return candidate;
	}
	return undefined;
}

function backupPathFor(settingsPath) {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `${settingsPath}.backup-tlh-gnosis-${stamp}`;
}

function realpathForCompare(path) {
	const resolved = resolve(path);
	if (existsSync(resolved)) return realpathSync(resolved);
	const parent = dirname(resolved);
	if (parent === resolved) return resolved;
	return join(realpathForCompare(parent), basename(resolved));
}

function assertNotNormalPiSettings(settingsPath) {
	const normalPiRoot = realpathForCompare(join(homedir(), ".pi"));
	const resolvedSettingsPath = realpathForCompare(settingsPath);
	if (resolvedSettingsPath === normalPiRoot || resolvedSettingsPath.startsWith(`${normalPiRoot}${sep}`)) {
		throw new Error(`Refusing to modify normal Pi config from The Last Harness gnosis command: ${settingsPath}`);
	}
}

function writeSettings(settingsPath, value, previousRaw, { dryRun }) {
	const formatted = `${JSON.stringify(value, null, 2)}\n`;
	if (formatted === previousRaw) return "unchanged";
	if (dryRun) return "dry-run";

	mkdirSync(dirname(settingsPath), { recursive: true });
	let backupPath;
	if (existsSync(settingsPath)) {
		backupPath = backupPathFor(settingsPath);
		copyFileSync(settingsPath, backupPath);
	}

	const tempPath = `${settingsPath}.tmp-${process.pid}`;
	writeFileSync(tempPath, formatted, "utf8");
	renameSync(tempPath, settingsPath);
	return backupPath || "written";
}

function log(args, message) {
	if (!args.quiet) console.log(message);
}

function commandStatus(args, settings, agentDir) {
	const state = gnosisState(settings);
	const valid = findValidGnosis(settings, agentDir);
	const active = state === "enabled" && Boolean(valid);
	console.log("Gnosis integration for tlh:");
	console.log(`  setting: ${state}`);
	console.log(`  active: ${active ? "yes" : "no"}`);
	console.log(`  binary: ${valid || "not found"}`);
	if (state === "enabled" && !valid) {
		console.log("  note: integration is enabled, but no valid Gnosis `gn` binary was found.");
	}
	if (state !== "enabled" && valid) {
		console.log("  note: a valid `gn` binary exists; run `tlh gnosis enable` to enable prompt integration.");
	}
}

function commandState(settings) {
	console.log(gnosisState(settings));
}

function commandValidate(settings, agentDir, commandArgs) {
	const candidate = commandArgs[0];
	if (candidate) {
		if (!validateGnosisCommand(candidate)) {
			process.exitCode = 1;
			return;
		}
		console.log(candidate);
		return;
	}

	const valid = findValidGnosis(settings, agentDir);
	if (!valid) {
		process.exitCode = 1;
		return;
	}
	console.log(valid);
}

function commandEnable(args, settingsPath, settings, previousRaw) {
	assertNotNormalPiSettings(settingsPath);
	ensureMutableSettings(settings);
	settings.tlh.gnosis.enabled = true;
	const installPath = normalizedInstallPath(args.installPath || args.commandArgs[0]);
	if (installPath) settings.tlh.gnosis.installPath = installPath;
	const writeResult = writeSettings(settingsPath, settings, previousRaw, { dryRun: args.dryRun });
	log(args, `${args.dryRun ? "Would enable" : "Enabled"} Gnosis integration for the tlh profile.`);
	if (writeResult && !["dry-run", "unchanged", "written"].includes(writeResult)) log(args, `Backed up previous settings to: ${writeResult}`);
	if (writeResult === "unchanged") log(args, "No settings changes were needed.");
}

function commandDisable(args, settingsPath, settings, previousRaw) {
	assertNotNormalPiSettings(settingsPath);
	ensureMutableSettings(settings);
	settings.tlh.gnosis.enabled = false;
	const writeResult = writeSettings(settingsPath, settings, previousRaw, { dryRun: args.dryRun });
	log(args, `${args.dryRun ? "Would disable" : "Disabled"} Gnosis integration for the tlh profile.`);
	if (writeResult && !["dry-run", "unchanged", "written"].includes(writeResult)) log(args, `Backed up previous settings to: ${writeResult}`);
	if (writeResult === "unchanged") log(args, "No settings changes were needed.");
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.command) {
		console.log(usage());
		return;
	}

	const agentDir = resolve(getAgentDir(args.agentDir));
	const settingsPath = resolve(expandHome(args.settingsPath || defaultSettingsPath(agentDir)));
	const { settings, previousRaw } = loadSettings(settingsPath);

	if (args.command === "status") {
		commandStatus(args, settings, agentDir);
		return;
	}
	if (args.command === "state") {
		commandState(settings);
		return;
	}
	if (args.command === "validate") {
		commandValidate(settings, agentDir, args.commandArgs);
		return;
	}
	if (args.command === "enable") {
		commandEnable(args, settingsPath, settings, previousRaw);
		return;
	}
	if (args.command === "disable") {
		commandDisable(args, settingsPath, settings, previousRaw);
		return;
	}

	throw new Error(`Unknown command: ${args.command}`);
}

try {
	main();
} catch (error) {
	console.error(`tlh gnosis: ${error.message}`);
	process.exit(1);
}

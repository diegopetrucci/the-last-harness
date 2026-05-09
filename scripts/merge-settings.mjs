#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import process from "node:process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_PACKAGE_SOURCE = "git:github.com/diegopetrucci/the-last-harness";

function usage() {
	return `Usage: node scripts/merge-settings.mjs [defaults.json] [options]

Merge installer defaults into The Last Harness isolated Pi settings without clobbering user values.

Options:
  --settings <path>        Settings file to update (default: ~/.the-last-harness/agent/settings.json, or PI_CODING_AGENT_DIR/settings.json)
  --package-source <src>   Package source to ensure in settings.packages
  --dry-run                Print intended changes without writing
  --force                  Overwrite scalar values from defaults
  --quiet                  Only print errors
  -h, --help               Show this help
`;
}

function parseArgs(argv) {
	const args = {
		defaultsPath: undefined,
		settingsPath: undefined,
		packageSource: undefined,
		dryRun: false,
		force: false,
		quiet: false,
		help: false,
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--dry-run") {
			args.dryRun = true;
			continue;
		}
		if (arg === "--force") {
			args.force = true;
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
		if (arg === "--settings") {
			args.settingsPath = requiredValue(argv, ++i, arg);
			continue;
		}
		if (arg === "--package-source") {
			args.packageSource = requiredValue(argv, ++i, arg);
			continue;
		}
		if (arg.startsWith("--settings=")) {
			args.settingsPath = arg.slice("--settings=".length);
			continue;
		}
		if (arg.startsWith("--package-source=")) {
			args.packageSource = arg.slice("--package-source=".length);
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

function requiredValue(argv, index, flag) {
	const value = argv[index];
	if (!value || value.startsWith("-")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function getAgentDir() {
	return process.env.PI_CODING_AGENT_DIR || process.env.TLH_AGENT_DIR || join(homedir(), ".the-last-harness", "agent");
}

function defaultSettingsPath() {
	return join(getAgentDir(), "settings.json");
}

function defaultDefaultsPath() {
	return join(resolve(__dirname, ".."), "config", "settings.defaults.json");
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

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function packageSourceOf(entry) {
	if (typeof entry === "string") return entry;
	if (isPlainObject(entry) && typeof entry.source === "string") return entry.source;
	return undefined;
}

function npmIdentity(spec) {
	const withoutPrefix = spec.slice("npm:".length).trim();
	if (!withoutPrefix) return spec;
	if (withoutPrefix.startsWith("@")) {
		const secondAt = withoutPrefix.indexOf("@", 1);
		return `npm:${secondAt === -1 ? withoutPrefix : withoutPrefix.slice(0, secondAt)}`;
	}
	const firstAt = withoutPrefix.indexOf("@");
	return `npm:${firstAt === -1 ? withoutPrefix : withoutPrefix.slice(0, firstAt)}`;
}

function gitIdentity(source) {
	let value = source.trim();
	if (value.startsWith("git:")) value = value.slice("git:".length).trim();
	value = value.replace(/^https?:\/\//i, "");
	value = value.replace(/^ssh:\/\//i, "");
	value = value.replace(/^git:\/\//i, "");
	value = value.replace(/^git@([^:]+):/, "$1/");
	value = value.replace(/#.*$/, "");
	value = value.replace(/\.git$/, "");
	value = value.replace(/\.git(?=@)/, "");

	const lastSlash = value.lastIndexOf("/");
	const refAt = lastSlash === -1 ? -1 : value.indexOf("@", lastSlash + 1);
	if (refAt !== -1) value = value.slice(0, refAt);

	return `git:${value.toLowerCase()}`;
}

function packageIdentity(entry) {
	const source = packageSourceOf(entry);
	if (!source) return undefined;
	const trimmed = source.trim();
	if (trimmed.startsWith("npm:")) return npmIdentity(trimmed);
	if (
		trimmed.startsWith("git:") ||
		/^(https?|ssh|git):\/\//i.test(trimmed) ||
		trimmed.startsWith("git@")
	) {
		return gitIdentity(trimmed);
	}
	return `local:${trimmed}`;
}

function prepareDefaults(defaults, packageSource) {
	const next = clone(defaults);
	const ensuredSource = packageSource || DEFAULT_PACKAGE_SOURCE;
	const ensuredIdentity = packageIdentity(ensuredSource);
	const packages = Array.isArray(next.packages) ? next.packages : [];
	next.packages = [
		ensuredSource,
		...packages.filter((entry) => packageIdentity(entry) !== ensuredIdentity),
	];
	return next;
}

function mergeSettings(existing, defaults, { force }) {
	if (!isPlainObject(existing)) {
		throw new Error("Existing settings must be a JSON object");
	}
	if (!isPlainObject(defaults)) {
		throw new Error("Default settings must be a JSON object");
	}

	const next = clone(existing);
	const changes = [];
	mergeObject(next, defaults, changes, { force, path: [] });
	return { next, changes };
}

function mergeObject(target, defaults, changes, options) {
	for (const [key, value] of Object.entries(defaults)) {
		const path = [...options.path, key];
		const label = path.join(".");

		if (key === "packages" && options.path.length === 0) {
			mergePackages(target, value, changes);
			continue;
		}

		if (target[key] === undefined) {
			target[key] = clone(value);
			changes.push(`set ${label}`);
			continue;
		}

		if (Array.isArray(value) && Array.isArray(target[key])) {
			mergeArray(target[key], value, changes, label);
			continue;
		}

		if (isPlainObject(value) && isPlainObject(target[key])) {
			mergeObject(target[key], value, changes, { ...options, path });
			continue;
		}

		if (options.force && JSON.stringify(target[key]) !== JSON.stringify(value)) {
			target[key] = clone(value);
			changes.push(`overwrite ${label}`);
		}
	}
}

function mergePackages(target, packageDefaults, changes) {
	if (!Array.isArray(packageDefaults)) {
		throw new Error("Default settings field 'packages' must be an array");
	}
	if (target.packages === undefined) {
		target.packages = [];
	}
	if (!Array.isArray(target.packages)) {
		throw new Error("Existing settings field 'packages' must be an array if present");
	}

	const seen = new Set(target.packages.map(packageIdentity).filter(Boolean));
	for (const entry of packageDefaults) {
		const source = packageSourceOf(entry);
		const identity = packageIdentity(entry);
		if (!source || !identity) {
			throw new Error(`Invalid package entry in defaults: ${JSON.stringify(entry)}`);
		}
		if (seen.has(identity)) continue;
		target.packages.push(clone(entry));
		seen.add(identity);
		changes.push(`append packages: ${source}`);
	}
}

function mergeArray(targetArray, defaultArray, changes, label) {
	const seen = new Set(targetArray.map((item) => JSON.stringify(item)));
	for (const item of defaultArray) {
		const key = JSON.stringify(item);
		if (seen.has(key)) continue;
		targetArray.push(clone(item));
		seen.add(key);
		changes.push(`append ${label}`);
	}
}

function backupPathFor(settingsPath) {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `${settingsPath}.backup-${stamp}`;
}

function assertNotNormalPiSettings(settingsPath) {
	const normalPiRoot = resolve(homedir(), ".pi");
	const resolvedSettingsPath = resolve(settingsPath);
	if (resolvedSettingsPath === normalPiRoot || resolvedSettingsPath.startsWith(`${normalPiRoot}${sep}`)) {
		throw new Error(`Refusing to modify normal Pi config from The Last Harness installer: ${settingsPath}`);
	}
}

function writeSettings(settingsPath, value, { dryRun, existed }) {
	const formatted = `${JSON.stringify(value, null, 2)}\n`;
	if (dryRun) return undefined;

	mkdirSync(dirname(settingsPath), { recursive: true });
	let backupPath;
	if (existed) {
		backupPath = backupPathFor(settingsPath);
		copyFileSync(settingsPath, backupPath);
	}

	const tempPath = `${settingsPath}.tmp-${process.pid}`;
	writeFileSync(tempPath, formatted, "utf8");
	renameSync(tempPath, settingsPath);
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
	const settingsPath = resolve(args.settingsPath || defaultSettingsPath());
	assertNotNormalPiSettings(settingsPath);
	const existed = existsSync(settingsPath);
	const existing = readJson(settingsPath, { missingValue: {} });
	const rawDefaults = readJson(defaultsPath);
	const defaults = prepareDefaults(rawDefaults, args.packageSource);
	const { next, changes } = mergeSettings(existing, defaults, { force: args.force });

	log(args, `Pi settings: ${settingsPath}`);
	if (changes.length === 0) {
		log(args, "No settings changes needed.");
		return;
	}

	for (const change of changes) {
		log(args, `${args.dryRun ? "Would" : "Will"} ${change}`);
	}

	if (args.dryRun) {
		if (existed) log(args, `Would back up existing settings before writing.`);
		log(args, "Dry run only; no settings were changed.");
		return;
	}

	const backupPath = writeSettings(settingsPath, next, { dryRun: args.dryRun, existed });
	if (backupPath) log(args, `Backed up previous settings to: ${backupPath}`);
	log(args, "Settings updated.");
}

try {
	main();
} catch (error) {
	console.error(`merge-settings: ${error.message}`);
	process.exit(1);
}

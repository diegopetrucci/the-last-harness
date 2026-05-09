#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import process from "node:process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_PACKAGE_SOURCE = "git:github.com/diegopetrucci/the-last-harness";
const HARNESS_PACKAGE_IDENTITY = packageIdentity(DEFAULT_PACKAGE_SOURCE);

function usage() {
	return `Usage: node scripts/merge-settings.mjs [defaults.json] [options]

Merge installer defaults into The Last Harness isolated Pi settings without clobbering user values.

Options:
  --settings <path>        Settings file to update (default: ~/.the-last-harness/agent/settings.json, or PI_CODING_AGENT_DIR/settings.json)
  --package-source <src>   Package source to ensure in settings.packages
  --default-extensions <p> Default extension manifest to enable unless opted out
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
		defaultExtensionsPath: undefined,
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
		if (arg === "--default-extensions") {
			args.defaultExtensionsPath = requiredValue(argv, ++i, arg);
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
		if (arg.startsWith("--default-extensions=")) {
			args.defaultExtensionsPath = arg.slice("--default-extensions=".length);
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

function defaultDefaultExtensionsPath() {
	return join(resolve(__dirname, ".."), "config", "default-extensions.json");
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

function readDefaultExtensions(path) {
	if (!existsSync(path)) return [];
	const raw = readJson(path);
	if (!Array.isArray(raw)) {
		throw new Error(`Default extension manifest must be an array: ${path}`);
	}

	const seenIds = new Set();
	const seenSources = new Set();
	return raw.map((entry, index) => {
		if (!isPlainObject(entry)) {
			throw new Error(`Default extension entry ${index + 1} must be an object`);
		}
		const id = typeof entry.id === "string" ? entry.id.trim() : "";
		const source = typeof entry.source === "string" ? entry.source.trim() : "";
		if (!id) throw new Error(`Default extension entry ${index + 1} is missing id`);
		if (!source) throw new Error(`Default extension ${id} is missing source`);
		if (seenIds.has(id)) throw new Error(`Duplicate default extension id: ${id}`);
		if (seenSources.has(packageIdentity(source))) throw new Error(`Duplicate default extension source: ${source}`);
		seenIds.add(id);
		seenSources.add(packageIdentity(source));
		return { id, source };
	});
}

function disabledDefaultExtensionIds(settings) {
	if (!isPlainObject(settings)) return new Set();
	const values = settings.tlh?.disabledDefaultExtensions;
	if (!Array.isArray(values)) return new Set();
	return new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()));
}

function prepareDefaults(defaults, packageSource, defaultExtensions, disabledIds) {
	const next = clone(defaults);
	const ensuredSource = packageSource || DEFAULT_PACKAGE_SOURCE;
	const ensuredPackages = [
		ensuredSource,
		...defaultExtensions.filter((extension) => !disabledIds.has(extension.id)).map((extension) => extension.source),
	];
	const ensuredIdentities = new Set(ensuredPackages.map(packageIdentity).filter(Boolean));
	const disabledIdentities = new Set(
		defaultExtensions.filter((extension) => disabledIds.has(extension.id)).map((extension) => packageIdentity(extension.source)),
	);
	const packages = Array.isArray(next.packages) ? next.packages : [];
	next.packages = [
		...ensuredPackages,
		...packages.filter((entry) => {
			const identity = packageIdentity(entry);
			return !ensuredIdentities.has(identity) && !disabledIdentities.has(identity);
		}),
	];
	return next;
}

function applyDisabledDefaultExtensions(settings, defaultExtensions, disabledIds, changes) {
	if (disabledIds.size === 0 || !Array.isArray(settings.packages)) return;

	for (const extension of defaultExtensions) {
		if (!disabledIds.has(extension.id)) continue;
		const identity = packageIdentity(extension.source);
		const index = settings.packages.findIndex((entry) => packageIdentity(entry) === identity);
		if (index === -1) continue;

		settings.packages.splice(index, 1);
		changes.push(`remove disabled default extension package: ${extension.id}`);
	}
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

	const seen = new Map();
	target.packages.forEach((entry, index) => {
		const identity = packageIdentity(entry);
		if (identity && !seen.has(identity)) seen.set(identity, index);
	});

	for (const entry of packageDefaults) {
		const source = packageSourceOf(entry);
		const identity = packageIdentity(entry);
		if (!source || !identity) {
			throw new Error(`Invalid package entry in defaults: ${JSON.stringify(entry)}`);
		}
		if (seen.has(identity)) {
			const existingIndex = seen.get(identity);
			const existingSource = packageSourceOf(target.packages[existingIndex]);
			if (identity === HARNESS_PACKAGE_IDENTITY && existingSource !== source) {
				target.packages[existingIndex] = clone(entry);
				changes.push(`replace packages: ${existingSource} -> ${source}`);
			}
			continue;
		}
		target.packages.push(clone(entry));
		seen.set(identity, target.packages.length - 1);
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
	const defaultExtensionsPath = resolve(args.defaultExtensionsPath || defaultDefaultExtensionsPath());
	const settingsPath = resolve(args.settingsPath || defaultSettingsPath());
	assertNotNormalPiSettings(settingsPath);
	const existed = existsSync(settingsPath);
	const existing = readJson(settingsPath, { missingValue: {} });
	const rawDefaults = readJson(defaultsPath);
	const defaultExtensions = readDefaultExtensions(defaultExtensionsPath);
	const disabledIds = disabledDefaultExtensionIds(existing);
	const defaults = prepareDefaults(rawDefaults, args.packageSource, defaultExtensions, disabledIds);
	const { next, changes } = mergeSettings(existing, defaults, { force: args.force });
	applyDisabledDefaultExtensions(next, defaultExtensions, disabledIds, changes);

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

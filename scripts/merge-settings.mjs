#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, normalize, parse, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import process from "node:process";

import {
	criticalDefaultExtensionOptOutIds,
	defaultExtensionPackageIdentities,
	disabledDefaultExtensionIds,
	packageIdentity,
	packageSourceOf,
	readDefaultExtensions,
} from "./lib/default-extensions.mjs";

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

function packageIdentityExists(packages, identity) {
	return Boolean(identity) && packages.some((entry) => packageIdentity(entry) === identity);
}

function shouldMigrateDefaultExtensionReplacements(extension, { force }) {
	return force || extension.migrateReplacements === true;
}

function shouldEnsureDefaultExtensionSource(existingPackages, extension, { force }) {
	if (shouldMigrateDefaultExtensionReplacements(extension, { force })) return true;
	if (packageIdentityExists(existingPackages, packageIdentity(extension.source))) return true;
	return !extension.replaces.some((oldSource) => packageIdentityExists(existingPackages, packageIdentity(oldSource)));
}

function prepareDefaults(defaults, packageSource, defaultExtensions, disabledIds, existingSettings, { force }) {
	const next = clone(defaults);
	const ensuredSource = packageSource || DEFAULT_PACKAGE_SOURCE;
	const existingPackages = isPlainObject(existingSettings) && Array.isArray(existingSettings.packages) ? existingSettings.packages : [];
	const ensuredPackages = [
		ensuredSource,
		...defaultExtensions
			.filter((extension) => !disabledIds.has(extension.id))
			.filter((extension) => shouldEnsureDefaultExtensionSource(existingPackages, extension, { force }))
			.map((extension) => extension.source),
	];
	const ensuredIdentities = new Set(ensuredPackages.map(packageIdentity).filter(Boolean));
	const disabledIdentities = new Set(
		defaultExtensions.filter((extension) => disabledIds.has(extension.id)).flatMap(defaultExtensionPackageIdentities),
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

function removePackageByIdentity(settings, identity) {
	if (!identity || !Array.isArray(settings.packages)) return undefined;
	const index = settings.packages.findIndex((entry) => packageIdentity(entry) === identity);
	if (index === -1) return undefined;
	const [removed] = settings.packages.splice(index, 1);
	return packageSourceOf(removed) || identity;
}

function removeDuplicatePackagesByIdentity(settings, identity) {
	if (!identity || !Array.isArray(settings.packages)) return [];
	const removedSources = [];
	let seen = false;
	for (let index = 0; index < settings.packages.length;) {
		if (packageIdentity(settings.packages[index]) !== identity) {
			index += 1;
			continue;
		}
		if (!seen) {
			seen = true;
			index += 1;
			continue;
		}
		const [removed] = settings.packages.splice(index, 1);
		removedSources.push(packageSourceOf(removed) || identity);
	}
	return removedSources;
}

function applyReplacedDefaultExtensions(settings, defaultExtensions, disabledIds, changes, { force }) {
	if (!Array.isArray(settings.packages)) return;

	for (const extension of defaultExtensions) {
		if (!shouldMigrateDefaultExtensionReplacements(extension, { force })) continue;
		if (disabledIds.has(extension.id)) continue;
		const newIdentity = packageIdentity(extension.source);
		for (const oldSource of extension.replaces) {
			const oldIdentity = packageIdentity(oldSource);
			if (!oldIdentity || oldIdentity === newIdentity) continue;
			let removedSource;
			while ((removedSource = removePackageByIdentity(settings, oldIdentity))) {
				changes.push(`remove replaced default extension package: ${removedSource} -> ${extension.source}`);
			}
		}
	}
}

function applyDefaultExtensionPackageDedupes(settings, defaultExtensions, disabledIds, changes, { force, sourceUpdatedIdentities = new Set() }) {
	if (!Array.isArray(settings.packages)) return;

	for (const extension of defaultExtensions) {
		const identity = packageIdentity(extension.source);
		if (!shouldMigrateDefaultExtensionReplacements(extension, { force }) && !sourceUpdatedIdentities.has(identity)) continue;
		if (disabledIds.has(extension.id)) continue;
		const removedSources = removeDuplicatePackagesByIdentity(settings, identity);
		for (const removedSource of removedSources) {
			changes.push(`remove duplicate default extension package: ${removedSource} (same identity as ${extension.source})`);
		}
	}
}

function applyDefaultExtensionSourceUpdates(settings, defaultExtensions, disabledIds, changes, { force }) {
	const updatedIdentities = new Set();
	if (!Array.isArray(settings.packages)) return updatedIdentities;

	for (const extension of defaultExtensions) {
		if (!force && extension.critical !== true) continue;
		if (disabledIds.has(extension.id)) continue;
		const identity = packageIdentity(extension.source);
		if (!identity) continue;
		const index = settings.packages.findIndex((entry) => packageIdentity(entry) === identity);
		if (index === -1) continue;

		const current = settings.packages[index];
		const currentSource = packageSourceOf(current);
		if (!currentSource) continue;

		const sourceNeedsUpdate = currentSource !== extension.source;
		const removesCriticalExtensionFilter = extension.critical === true
			&& isPlainObject(current)
			&& Object.hasOwn(current, "extensions");
		if (!sourceNeedsUpdate && !removesCriticalExtensionFilter) continue;

		if (isPlainObject(current)) {
			const next = { ...clone(current), source: extension.source };
			if (removesCriticalExtensionFilter) delete next.extensions;
			settings.packages[index] = Object.keys(next).length === 1 && typeof next.source === "string"
				? next.source
				: next;
		} else {
			settings.packages[index] = extension.source;
		}
		if (sourceNeedsUpdate) {
			changes.push(`update default extension package source: ${currentSource} -> ${extension.source}`);
		}
		if (removesCriticalExtensionFilter) {
			changes.push(`remove critical default extension package filter: ${extension.id}`);
		}
		updatedIdentities.add(identity);
	}

	return updatedIdentities;
}

function applyDisabledDefaultExtensions(settings, defaultExtensions, disabledIds, changes) {
	if (disabledIds.size === 0 || !Array.isArray(settings.packages)) return;

	for (const extension of defaultExtensions) {
		if (!disabledIds.has(extension.id)) continue;
		const removedSources = [];
		for (const identity of defaultExtensionPackageIdentities(extension)) {
			let removedSource;
			while ((removedSource = removePackageByIdentity(settings, identity))) {
				removedSources.push(removedSource);
			}
		}
		if (removedSources.length === 0) continue;

		changes.push(`remove disabled default extension package: ${extension.id}`);
	}
}

function scrubGnosisSettings(settings, changes) {
	if (!isPlainObject(settings) || !isPlainObject(settings.tlh)) return;
	if (!Object.hasOwn(settings.tlh, "gnosis")) return;
	delete settings.tlh.gnosis;
	changes.push("remove tlh.gnosis (one-time cleanup)");
}

function removeCriticalDisabledDefaultExtensionOptOuts(settings, defaultExtensions, changes) {
	if (!isPlainObject(settings) || !isPlainObject(settings.tlh)) return;
	const values = settings.tlh.disabledDefaultExtensions;
	if (!Array.isArray(values)) return;

	const criticalIds = criticalDefaultExtensionOptOutIds(defaultExtensions);
	if (criticalIds.size === 0) return;

	const nextValues = values.filter((value) => !(typeof value === "string" && criticalIds.has(value.trim())));
	if (nextValues.length === values.length) return;

	settings.tlh.disabledDefaultExtensions = nextValues;
	changes.push("remove invalid critical default extension opt-out");
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

function isPersistentTelemetryOptOut(path, currentValue, defaultValue) {
	// Telemetry opt-outs are user-owned and must survive installer reruns and forced updates.
	return path.join(".") === "tlh.telemetry.enabled" && currentValue === false && defaultValue === true;
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
			mergeArray(target[key], value, changes, { label, path });
			continue;
		}

		if (isPlainObject(value) && isPlainObject(target[key])) {
			mergeObject(target[key], value, changes, { ...options, path });
			continue;
		}

		if (isPersistentTelemetryOptOut(path, target[key], value)) {
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

function normalizeAgentDirPath(value) {
	const normalized = normalize(value);
	const root = parse(normalized).root;
	let stripped = normalized;
	while (stripped.length > root.length && stripped.endsWith(sep)) {
		stripped = stripped.slice(0, -sep.length);
	}
	return stripped;
}

function arrayMergeKey(item, path) {
	if (path.join(".") === "subagents.agentDirs" && typeof item === "string") {
		return `path:${normalizeAgentDirPath(item)}`;
	}
	return `json:${JSON.stringify(item)}`;
}

function mergeArray(targetArray, defaultArray, changes, { label, path }) {
	const seen = new Set(targetArray.map((item) => arrayMergeKey(item, path)));
	for (const item of defaultArray) {
		const key = arrayMergeKey(item, path);
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
	const defaultExtensions = readDefaultExtensions(defaultExtensionsPath, { allowMissing: true });
	const disabledIds = disabledDefaultExtensionIds(existing, defaultExtensions);
	const defaults = prepareDefaults(rawDefaults, args.packageSource, defaultExtensions, disabledIds, existing, { force: args.force });
	const { next, changes } = mergeSettings(existing, defaults, { force: args.force });
	const sourceUpdatedIdentities = applyDefaultExtensionSourceUpdates(next, defaultExtensions, disabledIds, changes, { force: args.force });
	applyReplacedDefaultExtensions(next, defaultExtensions, disabledIds, changes, { force: args.force });
	applyDefaultExtensionPackageDedupes(next, defaultExtensions, disabledIds, changes, { force: args.force, sourceUpdatedIdentities });
	applyDisabledDefaultExtensions(next, defaultExtensions, disabledIds, changes);
	removeCriticalDisabledDefaultExtensionOptOuts(next, defaultExtensions, changes);
	scrubGnosisSettings(next, changes);

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

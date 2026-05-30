#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import process from "node:process";

import {
	disabledDefaultExtensionIds as disabledIdsFromSettings,
	embeddedDefaultExtensionFilter,
	isEmbeddedDefaultExtension,
	packageIdentity,
	packageSourceOf,
	readDefaultExtensions,
	repairTargetedDefaultExtensionLoadOrder,
} from "./lib/default-extensions.mjs";
import {
	assertNotInNormalPiConfig,
	backupPathWithTimestamp,
	readJsonFile,
	requiredValue,
} from "./lib/tlh-install-utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_PACKAGE_SOURCE = "git:github.com/diegopetrucci/the-last-harness";

function usage() {
	return `Usage: tlh defaults <command>

Manage The Last Harness default extension bundle in the isolated tlh profile.

Commands:
  list                 Show bundled default extensions and current status
  disable <id>         Disable a non-critical bundled default extension persistently
  enable <id>          Re-enable a bundled default extension persistently
  sources              Print enabled default package sources (installer internal)
  critical-sources     Print enabled critical default package sources (installer internal)

Options:
  --settings <path>    Settings file to update (default: ~/.the-last-harness/agent/settings.json, or PI_CODING_AGENT_DIR/settings.json)
  --defaults <path>    Default extension manifest (default: config/default-extensions.json next to this script)
  -h, --help           Show this help
`;
}

function parseArgs(argv) {
	const args = {
		settingsPath: undefined,
		defaultExtensionsPath: undefined,
		command: undefined,
		commandArgs: [],
		help: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "-h" || arg === "--help") {
			args.help = true;
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
		if (arg === "--defaults" || arg === "--default-extensions") {
			args.defaultExtensionsPath = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--defaults=")) {
			args.defaultExtensionsPath = arg.slice("--defaults=".length);
			continue;
		}
		if (arg.startsWith("--default-extensions=")) {
			args.defaultExtensionsPath = arg.slice("--default-extensions=".length);
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

function expandHome(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function getAgentDir() {
	return process.env.PI_CODING_AGENT_DIR || process.env.TLH_AGENT_DIR || join(homedir(), ".the-last-harness", "agent");
}

function defaultSettingsPath() {
	return join(getAgentDir(), "settings.json");
}

function defaultDefaultExtensionsPath() {
	return join(resolve(__dirname, ".."), "config", "default-extensions.json");
}

function defaultInstallStatePath(settingsPath) {
	return join(dirname(settingsPath), "tlh", "install-state.json");
}

function isPlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function embeddedDefaultExtensionFilterSet(defaultExtensions) {
	return new Set(
		defaultExtensions
			.filter(isEmbeddedDefaultExtension)
			.map((extension) => embeddedDefaultExtensionFilter(extension))
			.filter(Boolean),
	);
}

function detectHarnessPackageSourceFromSettings(settings, defaultExtensions) {
	const knownEmbeddedFilters = embeddedDefaultExtensionFilterSet(defaultExtensions);
	for (const entry of settings.packages ?? []) {
		if (!isPlainObject(entry) || !Array.isArray(entry.extensions)) continue;
		if (entry.extensions.some((value) => typeof value === "string" && knownEmbeddedFilters.has(value.trim()))) {
			return packageSourceOf(entry);
		}
	}
	const defaultIdentity = packageIdentity(DEFAULT_PACKAGE_SOURCE);
	for (const entry of settings.packages ?? []) {
		if (packageIdentity(entry) === defaultIdentity) return packageSourceOf(entry);
	}
	for (const entry of settings.packages ?? []) {
		const source = packageSourceOf(entry);
		if (typeof source === "string" && source.includes("the-last-harness")) return source;
	}
	return undefined;
}

function resolveHarnessPackageSource(settingsPath, settings, defaultExtensions) {
	const installState = readJsonFile(defaultInstallStatePath(settingsPath), { missingValue: {} });
	if (typeof installState?.packageSource === "string" && installState.packageSource.trim()) {
		return installState.packageSource.trim();
	}
	return detectHarnessPackageSourceFromSettings(settings, defaultExtensions) || DEFAULT_PACKAGE_SOURCE;
}

function packageEntryDisablesExtensions(entry) {
	if (!isPlainObject(entry)) return false;
	if (!Array.isArray(entry.extensions)) return false;
	if (entry.extensions.length === 0) return true;

	const disablingPatterns = new Set(["-index.ts", "!index.ts", "-*", "!*"]);
	return entry.extensions
		.filter((value) => typeof value === "string")
		.map((value) => value.trim())
		.some((value) => disablingPatterns.has(value));
}

function validateSettings(settings) {
	if (!isPlainObject(settings)) {
		throw new Error("Settings must be a JSON object");
	}
	if (settings.packages !== undefined && !Array.isArray(settings.packages)) {
		throw new Error("Settings field 'packages' must be an array if present");
	}
	if (settings.tlh !== undefined && !isPlainObject(settings.tlh)) {
		throw new Error("Settings field 'tlh' must be an object if present");
	}
}

function ensureMutableSettings(settings) {
	validateSettings(settings);
	settings.packages ??= [];
	settings.tlh ??= {};
}

function orderedDisabledIds(ids, defaultExtensions) {
	const knownIds = new Set(defaultExtensions.map((extension) => extension.id));
	const ordered = [];
	for (const extension of defaultExtensions) {
		if (ids.has(extension.id)) ordered.push(extension.id);
	}
	const unknown = [...ids].filter((id) => !knownIds.has(id)).sort((a, b) => a.localeCompare(b));
	return [...ordered, ...unknown];
}

function setDisabledIds(settings, ids, defaultExtensions) {
	settings.tlh ??= {};
	settings.tlh.disabledDefaultExtensions = orderedDisabledIds(ids, defaultExtensions);
}

function findDefaultExtension(defaultExtensions, id) {
	return defaultExtensions.find((extension) => extension.id === id || extension.aliases.includes(id));
}

function findPackageIndex(settings, source) {
	const identity = packageIdentity(source);
	return (settings.packages ?? []).findIndex((entry) => packageIdentity(entry) === identity);
}

function findPackageSource(settings, source) {
	const index = findPackageIndex(settings, source);
	if (index === -1) return undefined;
	return packageSourceOf(settings.packages[index]) || source;
}

function removePackage(settings, source) {
	let index;
	while ((index = findPackageIndex(settings, source)) !== -1) {
		settings.packages.splice(index, 1);
	}
}

function removeEmbeddedDefaultPackages(settings, defaultExtensions) {
	let removed = false;
	for (const embeddedExtension of defaultExtensions) {
		if (!isEmbeddedDefaultExtension(embeddedExtension)) continue;
		for (const source of [embeddedExtension.source, ...embeddedExtension.replaces]) {
			const beforeLength = settings.packages.length;
			removePackage(settings, source);
			if (settings.packages.length !== beforeLength) removed = true;
		}
	}
	return removed;
}

function removeDuplicatePackagesAfterIndex(settings, identity, firstIndex) {
	for (let index = settings.packages.length - 1; index > firstIndex; index -= 1) {
		if (packageIdentity(settings.packages[index]) === identity) {
			settings.packages.splice(index, 1);
		}
	}
}

function packageEntryWithEmbeddedDefaultFilters(entry, packageSource, filters, knownEmbeddedFilters) {
	const currentSource = packageSourceOf(entry) || packageSource;
	const next = isPlainObject(entry) ? clone(entry) : { source: currentSource };
	const currentExtensions = Array.isArray(next.extensions) ? [...next.extensions] : [];
	const unrelatedExtensions = currentExtensions.filter(
		(value) => typeof value !== "string" || !knownEmbeddedFilters.has(value.trim()),
	);
	const nextExtensions = [...unrelatedExtensions, ...filters];
	if (nextExtensions.length > 0) {
		next.extensions = nextExtensions;
	} else {
		delete next.extensions;
	}
	return Object.keys(next).length === 1 && typeof next.source === "string" ? next.source : next;
}

function updateHarnessEmbeddedDefaultFilters(settings, defaultExtensions, disabledIds, harnessPackageSource) {
	const harnessIdentity = packageIdentity(harnessPackageSource);
	if (!harnessIdentity) return false;
	const harnessIndex = settings.packages.findIndex((entry) => packageIdentity(entry) === harnessIdentity);
	if (harnessIndex === -1) return false;

	const desiredFilters = defaultExtensions
		.filter((extension) => isEmbeddedDefaultExtension(extension) && disabledIds.has(extension.id))
		.map((extension) => embeddedDefaultExtensionFilter(extension))
		.filter(Boolean);
	const knownEmbeddedFilters = embeddedDefaultExtensionFilterSet(defaultExtensions);
	const currentEntry = settings.packages[harnessIndex];
	const nextEntry = packageEntryWithEmbeddedDefaultFilters(currentEntry, harnessPackageSource, desiredFilters, knownEmbeddedFilters);
	if (JSON.stringify(currentEntry) === JSON.stringify(nextEntry)) return false;
	settings.packages[harnessIndex] = nextEntry;
	return true;
}

function replacedPackageSource(settings, extension) {
	for (const oldSource of extension.replaces) {
		const source = findPackageSource(settings, oldSource);
		if (source) return source;
	}
	return undefined;
}

function isDefaultSourceDeferred(settings, extension) {
	if (isEmbeddedDefaultExtension(extension)) return false;
	return extension.migrateReplacements !== true
		&& findPackageIndex(settings, extension.source) === -1
		&& Boolean(replacedPackageSource(settings, extension));
}

function isDefaultDisabled(settings, extension, defaultExtensions) {
	if (disabledIdsFromSettings(settings, defaultExtensions).has(extension.id)) return true;
	if (extension.critical === true || isEmbeddedDefaultExtension(extension)) return false;
	const index = findPackageIndex(settings, extension.source);
	if (index === -1) return false;
	return packageEntryDisablesExtensions(settings.packages[index]);
}

function disablePackage(settings, extension, defaultExtensions, harnessPackageSource) {
	for (const source of [extension.source, ...extension.replaces]) {
		removePackage(settings, source);
	}
	if (!isEmbeddedDefaultExtension(extension)) return false;
	const removedEmbeddedPackages = removeEmbeddedDefaultPackages(settings, defaultExtensions);
	const updatedFilters = updateHarnessEmbeddedDefaultFilters(
		settings,
		defaultExtensions,
		disabledIdsFromSettings(settings, defaultExtensions),
		harnessPackageSource,
	);
	return removedEmbeddedPackages || updatedFilters;
}

function enablePackage(settings, extension, defaultExtensions, harnessPackageSource) {
	if (isEmbeddedDefaultExtension(extension)) {
		const removedEmbeddedPackages = removeEmbeddedDefaultPackages(settings, defaultExtensions);
		const updatedFilters = updateHarnessEmbeddedDefaultFilters(
			settings,
			defaultExtensions,
			disabledIdsFromSettings(settings, defaultExtensions),
			harnessPackageSource,
		);
		return removedEmbeddedPackages || updatedFilters;
	}
	for (const oldSource of extension.replaces) {
		removePackage(settings, oldSource);
	}

	const identity = packageIdentity(extension.source);
	const index = findPackageIndex(settings, extension.source);
	if (index === -1) {
		settings.packages.push(extension.source);
		return true;
	}

	removeDuplicatePackagesAfterIndex(settings, identity, index);
	const current = settings.packages[index];
	if (!isPlainObject(current)) {
		return false;
	}

	const next = { ...clone(current), source: packageSourceOf(current) || extension.source };
	delete next.extensions;
	settings.packages[index] = Object.keys(next).length === 1 && typeof next.source === "string" ? next.source : next;
	return true;
}

function defaultStatus(settings, extension, defaultExtensions) {
	const markerDisabled = disabledIdsFromSettings(settings, defaultExtensions).has(extension.id);
	if (markerDisabled) return { enabled: false, reason: "disabled" };
	if (isEmbeddedDefaultExtension(extension)) {
		return { enabled: true, reason: "enabled from the TLH package" };
	}
	const packageIndex = findPackageIndex(settings, extension.source);
	const entry = packageIndex === -1 ? undefined : settings.packages[packageIndex];
	const configuredSource = entry ? packageSourceOf(entry) : undefined;
	if (extension.critical !== true && entry && packageEntryDisablesExtensions(entry)) return { enabled: false, reason: "disabled by package filter" };
	if (entry && configuredSource && configuredSource !== extension.source) {
		return { enabled: true, reason: `enabled with configured package (${configuredSource})` };
	}
	if (entry) return { enabled: true, reason: "enabled" };
	const replacementSource = replacedPackageSource(settings, extension);
	if (replacementSource) {
		const action = extension.migrateReplacements === true
			? "installer will switch it to the bundled TLH source"
			: "installer --force will switch it";
		return { enabled: true, reason: `enabled with replaced package (${replacementSource}); ${action}` };
	}
	return { enabled: true, reason: "enabled by default; package will be added by installer" };
}

function assertKnownExtension(defaultExtensions, id) {
	const extension = findDefaultExtension(defaultExtensions, id);
	if (!extension) {
		const available = defaultExtensions.map((item) => item.id).join(", ");
		throw new Error(`Unknown default extension '${id}'. Available: ${available}`);
	}
	return extension;
}

function backupPathFor(settingsPath) {
	return backupPathWithTimestamp(settingsPath, { marker: "tlh-defaults" });
}

function assertNotNormalPiSettings(settingsPath) {
	assertNotInNormalPiConfig(
		settingsPath,
		`Refusing to modify normal Pi config from The Last Harness defaults command: ${settingsPath}`,
	);
}

function writeSettings(settingsPath, value, previousRaw) {
	const formatted = `${JSON.stringify(value, null, 2)}\n`;
	if (formatted === previousRaw) return undefined;

	mkdirSync(dirname(settingsPath), { recursive: true });
	let backupPath;
	if (existsSync(settingsPath)) {
		backupPath = backupPathFor(settingsPath);
		copyFileSync(settingsPath, backupPath);
	}

	const tempPath = `${settingsPath}.tmp-${process.pid}`;
	writeFileSync(tempPath, formatted, "utf8");
	renameSync(tempPath, settingsPath);
	return backupPath;
}

function loadSettings(settingsPath) {
	const previousRaw = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "") : "";
	const settings = readJsonFile(settingsPath, { missingValue: {} });
	return { settings, previousRaw };
}

function commandList(settings, defaultExtensions) {
	console.log("The Last Harness default extensions:");
	for (const extension of defaultExtensions) {
		const status = defaultStatus(settings, extension, defaultExtensions);
		const marker = status.enabled ? "enabled " : "disabled";
		const description = extension.description ? ` — ${extension.description}` : "";
		console.log(`  ${marker}  ${extension.id} (${extension.source})${description}`);
		if (status.reason !== marker.trim()) {
			console.log(`            ${status.reason}`);
		}
	}
	console.log("");
	console.log("Use 'tlh defaults disable <id>' for non-critical defaults, or 'tlh defaults enable <id>'.");
}

function enabledDefaultExtensionProfiles(settings, defaultExtensions) {
	const profiles = [];
	for (const extension of defaultExtensions) {
		if (isEmbeddedDefaultExtension(extension)) continue;
		if (isDefaultSourceDeferred(settings, extension)) continue;
		if (extension.critical === true) {
			profiles.push({
				id: extension.id,
				source: extension.source,
				critical: true,
			});
			continue;
		}
		if (isDefaultDisabled(settings, extension, defaultExtensions)) continue;
		profiles.push({
			id: extension.id,
			source: findPackageSource(settings, extension.source) || extension.source,
			critical: false,
		});
	}
	return profiles;
}

function commandSources(settings, defaultExtensions, { criticalOnly = false } = {}) {
	for (const profile of enabledDefaultExtensionProfiles(settings, defaultExtensions)) {
		if (criticalOnly && profile.critical !== true) continue;
		console.log(profile.source);
	}
}

function commandProfileSources(settings, defaultExtensions) {
	process.stdout.write(`${JSON.stringify(enabledDefaultExtensionProfiles(settings, defaultExtensions), null, 2)}\n`);
}

function applyAnthropicWarningOnDisable(settings) {
	if (!isPlainObject(settings.warnings)) return false;
	if (settings.warnings.anthropicExtraUsage !== false) return false;
	delete settings.warnings.anthropicExtraUsage;
	if (Object.keys(settings.warnings).length === 0) {
		delete settings.warnings;
	}
	return true;
}

function applyAnthropicWarningOnEnable(settings) {
	if (settings.warnings !== undefined && !isPlainObject(settings.warnings)) return false;
	if (settings.warnings?.anthropicExtraUsage !== undefined) return false;
	settings.warnings ??= {};
	settings.warnings.anthropicExtraUsage = false;
	return true;
}

function commandDisable(settings, defaultExtensions, id, harnessPackageSource) {
	const extension = assertKnownExtension(defaultExtensions, id);
	if (extension.critical === true) {
		throw new Error(`Critical default extension '${extension.id}' cannot be disabled.`);
	}
	const disabledIds = disabledIdsFromSettings(settings, defaultExtensions);
	disabledIds.add(extension.id);
	setDisabledIds(settings, disabledIds, defaultExtensions);
	disablePackage(settings, extension, defaultExtensions, harnessPackageSource);
	if (extension.id === "anthropic-auth") {
		return applyAnthropicWarningOnDisable(settings);
	}
	return false;
}

function commandEnable(settings, defaultExtensions, id, harnessPackageSource) {
	const extension = assertKnownExtension(defaultExtensions, id);
	const disabledIds = disabledIdsFromSettings(settings, defaultExtensions);
	disabledIds.delete(extension.id);
	setDisabledIds(settings, disabledIds, defaultExtensions);
	enablePackage(settings, extension, defaultExtensions, harnessPackageSource);
	repairTargetedDefaultExtensionLoadOrder(settings, defaultExtensions, disabledIds);
	if (extension.id === "anthropic-auth") {
		return applyAnthropicWarningOnEnable(settings);
	}
	return false;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.command) {
		console.log(usage());
		return;
	}

	const settingsPath = resolve(expandHome(args.settingsPath || defaultSettingsPath()));
	const defaultExtensionsPath = resolve(expandHome(args.defaultExtensionsPath || defaultDefaultExtensionsPath()));
	const mutatesSettings = args.command === "disable" || args.command === "enable";
	if (mutatesSettings) assertNotNormalPiSettings(settingsPath);
	const defaultExtensions = readDefaultExtensions(defaultExtensionsPath);
	const { settings, previousRaw } = loadSettings(settingsPath);
	validateSettings(settings);
	const harnessPackageSource = resolveHarnessPackageSource(settingsPath, settings, defaultExtensions);

	if (args.command === "list") {
		commandList(settings, defaultExtensions);
		return;
	}
	if (args.command === "sources" || args.command === "critical-sources") {
		commandSources(settings, defaultExtensions, { criticalOnly: args.command === "critical-sources" });
		return;
	}
	if (args.command === "profile-sources") {
		commandProfileSources(settings, defaultExtensions);
		return;
	}

	ensureMutableSettings(settings);

	if (args.command === "disable") {
		const id = args.commandArgs[0];
		if (!id || args.commandArgs.length !== 1) throw new Error("Usage: tlh defaults disable <id>");
		const before = JSON.stringify(settings);
		const warningChanged = commandDisable(settings, defaultExtensions, id, harnessPackageSource);
		const changed = before !== JSON.stringify(settings);
		const backupPath = changed ? writeSettings(settingsPath, settings, previousRaw) : undefined;
		console.log(`${id} is disabled for the tlh profile.`);
		if (warningChanged) console.log("Restored upstream warnings.anthropicExtraUsage default (warning will reappear).");
		if (backupPath) console.log(`Backed up previous settings to: ${backupPath}`);
		if (!changed) console.log("No settings changes were needed.");
		return;
	}

	if (args.command === "enable") {
		const id = args.commandArgs[0];
		if (!id || args.commandArgs.length !== 1) throw new Error("Usage: tlh defaults enable <id>");
		const before = JSON.stringify(settings);
		const warningChanged = commandEnable(settings, defaultExtensions, id, harnessPackageSource);
		const changed = before !== JSON.stringify(settings);
		const backupPath = changed ? writeSettings(settingsPath, settings, previousRaw) : undefined;
		console.log(`${id} is enabled for the tlh profile.`);
		if (warningChanged) console.log("Suppressed warnings.anthropicExtraUsage (tlh default).");
		if (backupPath) console.log(`Backed up previous settings to: ${backupPath}`);
		if (!changed) console.log("No settings changes were needed.");
		return;
	}

	throw new Error(`Unknown command: ${args.command}`);
}

try {
	main();
} catch (error) {
	console.error(`tlh defaults: ${error.message}`);
	process.exit(1);
}

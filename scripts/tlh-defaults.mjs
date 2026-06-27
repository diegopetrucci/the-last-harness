#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import {
	RETIRED_TLH_DEFAULT_PACKAGE_SOURCES,
	disabledDefaultExtensionIds as disabledIdsFromSettings,
	managedDefaultExtensionPackageIdentities,
	packageIdentity,
	packageSourceOf,
	readDefaultExtensionProvenance,
	readDefaultExtensions,
	repairTargetedDefaultExtensionLoadOrder,
	setDefaultExtensionProvenance,
	withLegacyRetiredDefaultPackageIdentities,
} from "./lib/default-extensions.mjs";
import {
	assertNotInNormalPiConfig,
	assignOptionValue,
	backupPathWithTimestamp,
	defaultTlhSettingsPath,
	expandHomePath,
	readJsonFile,
	readRegularFileForBackup,
} from "./lib/tlh-install-utils.mjs";
import { writeSafeProfileFile } from "./lib/tlh-safe-profile-write.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RETIRED_DEFAULT_PACKAGE_IDENTITIES = new Set(
	RETIRED_TLH_DEFAULT_PACKAGE_SOURCES.map(packageIdentity).filter(Boolean),
);

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
		const settingsIndex = assignOptionValue(args, "settingsPath", argv, index, "--settings");
		if (settingsIndex !== undefined) {
			index = settingsIndex;
			continue;
		}
		const defaultsIndex = assignOptionValue(args, "defaultExtensionsPath", argv, index, ["--defaults", "--default-extensions"]);
		if (defaultsIndex !== undefined) {
			index = defaultsIndex;
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

function defaultDefaultExtensionsPath() {
	return join(resolve(__dirname, ".."), "config", "default-extensions.json");
}

function isPlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
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

function isLegacyRtkDisabledId(id) {
	return id === "rtk" || id === "pi-rtk";
}

function orderedDisabledIds(ids, defaultExtensions) {
	const knownIds = new Set(defaultExtensions.map((extension) => extension.id));
	const ordered = [];
	for (const extension of defaultExtensions) {
		if (ids.has(extension.id)) ordered.push(extension.id);
	}
	const unknown = [...ids]
		.filter((id) => !knownIds.has(id) && !isLegacyRtkDisabledId(id))
		.sort((a, b) => a.localeCompare(b));
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

function removeDuplicatePackagesAfterIndex(settings, identity, firstIndex) {
	for (let index = settings.packages.length - 1; index > firstIndex; index -= 1) {
		if (packageIdentity(settings.packages[index]) === identity) {
			settings.packages.splice(index, 1);
		}
	}
}

function replacedPackageSource(settings, extension) {
	for (const oldSource of extension.replaces) {
		const source = findPackageSource(settings, oldSource);
		if (source) return source;
	}
	return undefined;
}

function isDefaultSourceDeferred(settings, extension) {
	return extension.migrateReplacements !== true
		&& findPackageIndex(settings, extension.source) === -1
		&& Boolean(replacedPackageSource(settings, extension));
}

function isDefaultDisabled(settings, extension, defaultExtensions) {
	if (disabledIdsFromSettings(settings, defaultExtensions).has(extension.id)) return true;
	if (extension.critical === true) return false;
	const index = findPackageIndex(settings, extension.source);
	if (index === -1) return false;
	return packageEntryDisablesExtensions(settings.packages[index]);
}

function disablePackage(settings, extension) {
	for (const source of [extension.source, ...extension.replaces]) {
		removePackage(settings, source);
	}
}

function enablePackage(settings, extension) {
	for (const oldSource of extension.replaces) {
		removePackage(settings, oldSource);
	}

	const identity = packageIdentity(extension.source);
	const index = findPackageIndex(settings, extension.source);
	if (index === -1) {
		settings.packages.push(extension.source);
		return;
	}

	removeDuplicatePackagesAfterIndex(settings, identity, index);
	const current = settings.packages[index];
	if (!isPlainObject(current)) {
		return;
	}

	const next = { ...clone(current), source: packageSourceOf(current) || extension.source };
	delete next.extensions;
	if (Object.keys(next).length === 1 && typeof next.source === "string") {
		settings.packages[index] = next.source;
	} else {
		settings.packages[index] = next;
	}
}

function defaultStatus(settings, extension, defaultExtensions) {
	const markerDisabled = disabledIdsFromSettings(settings, defaultExtensions).has(extension.id);
	const packageIndex = findPackageIndex(settings, extension.source);
	const entry = packageIndex === -1 ? undefined : settings.packages[packageIndex];
	const configuredSource = entry ? packageSourceOf(entry) : undefined;
	if (markerDisabled) return { enabled: false, reason: "disabled" };
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

function writeExistingProfileBackup(settingsPath, backupPath) {
	const { content, mode } = readRegularFileForBackup(settingsPath, "TLH defaults settings");
	writeSafeProfileFile(
		{ agentDir: dirname(settingsPath) },
		basename(backupPath),
		content,
		"TLH defaults settings backup",
		{ mode },
	);
}

function writeSettings(settingsPath, value, previousRaw) {
	const formatted = `${JSON.stringify(value, null, 2)}\n`;
	if (formatted === previousRaw) return undefined;

	let backupPath;
	if (existsSync(settingsPath)) {
		backupPath = backupPathFor(settingsPath);
		writeExistingProfileBackup(settingsPath, backupPath);
	}

	writeSafeProfileFile({ agentDir: dirname(settingsPath) }, basename(settingsPath), formatted, "TLH defaults settings");
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

function commandSources(settings, defaultExtensions, { criticalOnly = false } = {}) {
	for (const extension of defaultExtensions) {
		if (criticalOnly && extension.critical !== true) continue;
		if (extension.critical === true) {
			if (!isDefaultSourceDeferred(settings, extension)) console.log(extension.source);
			continue;
		}
		if (!isDefaultDisabled(settings, extension, defaultExtensions) && !isDefaultSourceDeferred(settings, extension)) {
			console.log(extension.source);
		}
	}
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

function commandDisable(settings, defaultExtensions, id) {
	const extension = assertKnownExtension(defaultExtensions, id);
	if (extension.critical === true) {
		throw new Error(`Critical default extension '${extension.id}' cannot be disabled.`);
	}
	const disabledIds = disabledIdsFromSettings(settings, defaultExtensions);
	disabledIds.add(extension.id);
	setDisabledIds(settings, disabledIds, defaultExtensions);
	disablePackage(settings, extension);
	if (extension.id === "anthropic-auth") {
		return applyAnthropicWarningOnDisable(settings);
	}
	return false;
}

function commandEnable(settings, defaultExtensions, id) {
	const extension = assertKnownExtension(defaultExtensions, id);
	const disabledIds = disabledIdsFromSettings(settings, defaultExtensions);
	disabledIds.delete(extension.id);
	setDisabledIds(settings, disabledIds, defaultExtensions);
	enablePackage(settings, extension);
	repairTargetedDefaultExtensionLoadOrder(settings, defaultExtensions, disabledIds);
	if (extension.id === "anthropic-auth") {
		return applyAnthropicWarningOnEnable(settings);
	}
	return false;
}

function syncDefaultExtensionProvenance(settings, defaultExtensions) {
	const disabledIds = disabledIdsFromSettings(settings, defaultExtensions);
	const managedPackageIdentities = managedDefaultExtensionPackageIdentities(settings, defaultExtensions, disabledIds);
	const nextManagedPackageIdentities = withLegacyRetiredDefaultPackageIdentities(settings, managedPackageIdentities);
	for (const identity of readDefaultExtensionProvenance(settings).managedPackageIdentities) {
		if (RETIRED_DEFAULT_PACKAGE_IDENTITIES.has(identity)) {
			nextManagedPackageIdentities.add(identity);
		}
	}
	setDefaultExtensionProvenance(settings, nextManagedPackageIdentities);
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.command) {
		console.log(usage());
		return;
	}

	const settingsPath = resolve(expandHomePath(args.settingsPath || defaultTlhSettingsPath()));
	const defaultExtensionsPath = resolve(expandHomePath(args.defaultExtensionsPath || defaultDefaultExtensionsPath()));
	const mutatesSettings = args.command === "disable" || args.command === "enable";
	if (mutatesSettings) assertNotNormalPiSettings(settingsPath);
	const defaultExtensions = readDefaultExtensions(defaultExtensionsPath);
	const { settings, previousRaw } = loadSettings(settingsPath);
	validateSettings(settings);

	if (args.command === "list") {
		commandList(settings, defaultExtensions);
		return;
	}
	if (args.command === "sources" || args.command === "critical-sources") {
		commandSources(settings, defaultExtensions, { criticalOnly: args.command === "critical-sources" });
		return;
	}

	ensureMutableSettings(settings);

	if (args.command === "disable") {
		const id = args.commandArgs[0];
		if (!id || args.commandArgs.length !== 1) throw new Error("Usage: tlh defaults disable <id>");
		const before = JSON.stringify(settings);
		const warningChanged = commandDisable(settings, defaultExtensions, id);
		syncDefaultExtensionProvenance(settings, defaultExtensions);
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
		const warningChanged = commandEnable(settings, defaultExtensions, id);
		syncDefaultExtensionProvenance(settings, defaultExtensions);
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

#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import process from "node:process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function usage() {
	return `Usage: tlh defaults <command>

Manage The Last Harness default extension bundle in the isolated tlh profile.

Commands:
  list                 Show bundled default extensions and current status
  disable <id>         Disable a bundled default extension persistently
  enable <id>          Re-enable a bundled default extension persistently
  sources              Print enabled default package sources (installer internal)

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

function getAgentDir() {
	return process.env.PI_CODING_AGENT_DIR || process.env.TLH_AGENT_DIR || join(homedir(), ".the-last-harness", "agent");
}

function defaultSettingsPath() {
	return join(getAgentDir(), "settings.json");
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

function readStringArrayField(entry, key, label) {
	if (entry[key] === undefined) return [];
	if (!Array.isArray(entry[key])) {
		throw new Error(`Default extension ${label} field '${key}' must be an array`);
	}
	return entry[key]
		.map((value) => (typeof value === "string" ? value.trim() : ""))
		.filter((value) => value.length > 0);
}

function readDefaultExtensions(path) {
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
		const description = typeof entry.description === "string" ? entry.description.trim() : "";
		const aliases = readStringArrayField(entry, "aliases", id || String(index + 1));
		const replaces = readStringArrayField(entry, "replaces", id || String(index + 1));
		if (!id) throw new Error(`Default extension entry ${index + 1} is missing id`);
		if (!source) throw new Error(`Default extension ${id} is missing source`);
		for (const candidateId of [id, ...aliases]) {
			if (seenIds.has(candidateId)) throw new Error(`Duplicate default extension id or alias: ${candidateId}`);
			seenIds.add(candidateId);
		}
		if (seenSources.has(packageIdentity(source))) throw new Error(`Duplicate default extension source: ${source}`);
		seenSources.add(packageIdentity(source));
		return { id, aliases, replaces, source, description };
	});
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

function rawDisabledIdsFromSettings(settings) {
	if (!isPlainObject(settings)) return new Set();
	const values = settings.tlh?.disabledDefaultExtensions;
	if (!Array.isArray(values)) return new Set();
	return new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()));
}

function disabledIdsFromSettings(settings, defaultExtensions = []) {
	const ids = rawDisabledIdsFromSettings(settings);
	for (const extension of defaultExtensions) {
		if ([extension.id, ...extension.aliases].some((id) => ids.has(id))) {
			ids.add(extension.id);
			for (const alias of extension.aliases) ids.delete(alias);
		}
	}
	return ids;
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

function removePackage(settings, source) {
	const index = findPackageIndex(settings, source);
	if (index !== -1) settings.packages.splice(index, 1);
}

function packageEntryDisablesExtensions(entry) {
	if (!isPlainObject(entry)) return false;
	if (!Array.isArray(entry.extensions)) return false;
	if (entry.extensions.length === 0) return true;
	const patterns = entry.extensions.filter((value) => typeof value === "string");
	return patterns.includes("-index.ts") || patterns.includes("!index.ts") || patterns.includes("-*") || patterns.includes("!*");
}

function replacedPackageSource(settings, extension) {
	for (const oldSource of extension.replaces) {
		const index = findPackageIndex(settings, oldSource);
		if (index !== -1) return packageSourceOf(settings.packages[index]) || oldSource;
	}
	return undefined;
}

function isDefaultSourceDeferred(settings, extension) {
	return findPackageIndex(settings, extension.source) === -1 && Boolean(replacedPackageSource(settings, extension));
}

function isDefaultDisabled(settings, extension, defaultExtensions) {
	if (disabledIdsFromSettings(settings, defaultExtensions).has(extension.id)) return true;
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

	const index = findPackageIndex(settings, extension.source);
	if (index === -1) {
		settings.packages.push(extension.source);
		return;
	}

	const current = settings.packages[index];
	if (!isPlainObject(current)) {
		settings.packages[index] = extension.source;
		return;
	}

	const next = { ...clone(current), source: extension.source };
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
	if (markerDisabled) return { enabled: false, reason: "disabled" };
	if (entry && packageEntryDisablesExtensions(entry)) return { enabled: false, reason: "disabled by package filter" };
	if (entry) return { enabled: true, reason: "enabled" };
	const replacementSource = replacedPackageSource(settings, extension);
	if (replacementSource) {
		return { enabled: true, reason: `enabled with replaced package (${replacementSource}); installer --force will switch it` };
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
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `${settingsPath}.backup-tlh-defaults-${stamp}`;
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
		throw new Error(`Refusing to modify normal Pi config from The Last Harness defaults command: ${settingsPath}`);
	}
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
	const settings = readJson(settingsPath, { missingValue: {} });
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
	console.log("Use 'tlh defaults disable <id>' or 'tlh defaults enable <id>'.");
}

function commandSources(settings, defaultExtensions) {
	for (const extension of defaultExtensions) {
		if (!isDefaultDisabled(settings, extension, defaultExtensions) && !isDefaultSourceDeferred(settings, extension)) {
			console.log(extension.source);
		}
	}
}

function commandDisable(settings, defaultExtensions, id) {
	const extension = assertKnownExtension(defaultExtensions, id);
	const disabledIds = disabledIdsFromSettings(settings, defaultExtensions);
	disabledIds.add(extension.id);
	setDisabledIds(settings, disabledIds, defaultExtensions);
	disablePackage(settings, extension);
}

function commandEnable(settings, defaultExtensions, id) {
	const extension = assertKnownExtension(defaultExtensions, id);
	const disabledIds = disabledIdsFromSettings(settings, defaultExtensions);
	disabledIds.delete(extension.id);
	setDisabledIds(settings, disabledIds, defaultExtensions);
	enablePackage(settings, extension);
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

	if (args.command === "list") {
		commandList(settings, defaultExtensions);
		return;
	}
	if (args.command === "sources") {
		commandSources(settings, defaultExtensions);
		return;
	}

	ensureMutableSettings(settings);

	if (args.command === "disable") {
		const id = args.commandArgs[0];
		if (!id || args.commandArgs.length !== 1) throw new Error("Usage: tlh defaults disable <id>");
		const before = JSON.stringify(settings);
		commandDisable(settings, defaultExtensions, id);
		const changed = before !== JSON.stringify(settings);
		const backupPath = changed ? writeSettings(settingsPath, settings, previousRaw) : undefined;
		console.log(`${id} is disabled for the tlh profile.`);
		if (backupPath) console.log(`Backed up previous settings to: ${backupPath}`);
		if (!changed) console.log("No settings changes were needed.");
		return;
	}

	if (args.command === "enable") {
		const id = args.commandArgs[0];
		if (!id || args.commandArgs.length !== 1) throw new Error("Usage: tlh defaults enable <id>");
		const before = JSON.stringify(settings);
		commandEnable(settings, defaultExtensions, id);
		const changed = before !== JSON.stringify(settings);
		const backupPath = changed ? writeSettings(settingsPath, settings, previousRaw) : undefined;
		console.log(`${id} is enabled for the tlh profile.`);
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

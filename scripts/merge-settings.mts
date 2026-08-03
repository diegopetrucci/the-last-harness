#!/usr/bin/env node
import { existsSync } from "node:fs";
import { basename, dirname, join, normalize, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import {
	criticalDefaultExtensionOptOutIds,
	defaultExtensionPackageIdentities,
	disabledDefaultExtensionIds,
	managedDefaultExtensionPackageIdentities,
	packageIdentity,
	packageSourceOf,
	readDefaultExtensionProvenance,
	readDefaultExtensions,
	RETIRED_TLH_DEFAULT_PACKAGE_SOURCES,
	repairTargetedDefaultExtensionLoadOrder,
	setDefaultExtensionProvenance,
	withLegacyRetiredDefaultPackageIdentities,
} from "./lib/default-extensions.mjs";
import type { DefaultExtensionEntry } from "./lib/default-extensions.mjs";
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

interface CliArgs extends Record<string, unknown> {
	defaultsPath?: string;
	settingsPath?: string;
	packageSource?: string;
	defaultExtensionsPath?: string;
	dryRun: boolean;
	force: boolean;
	quiet: boolean;
	help: boolean;
}

type JsonObject = Record<string, unknown>;

interface MergeOptions {
	force: boolean;
	path: string[];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_PACKAGE_SOURCE = "git:github.com/diegopetrucci/the-last-harness";
const TLH_CHANGELOG_SENTINEL = "9999.0.0";
const HARNESS_PACKAGE_IDENTITY = packageIdentity(DEFAULT_PACKAGE_SOURCE);

function usage(): string {
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

function parseArgs(argv: readonly string[]): CliArgs {
	const args: CliArgs = {
		defaultsPath: undefined,
		settingsPath: undefined,
		packageSource: undefined,
		defaultExtensionsPath: undefined,
		dryRun: false,
		force: false,
		quiet: false,
		help: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
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
		const settingsIndex = assignOptionValue(args, "settingsPath", argv, index, "--settings");
		if (settingsIndex !== undefined) {
			index = settingsIndex;
			continue;
		}
		const packageSourceIndex = assignOptionValue(args, "packageSource", argv, index, "--package-source");
		if (packageSourceIndex !== undefined) {
			index = packageSourceIndex;
			continue;
		}
		const defaultExtensionsIndex = assignOptionValue(args, "defaultExtensionsPath", argv, index, "--default-extensions");
		if (defaultExtensionsIndex !== undefined) {
			index = defaultExtensionsIndex;
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

function defaultDefaultsPath(): string {
	return join(resolve(__dirname, ".."), "config", "settings.defaults.json");
}

function defaultDefaultExtensionsPath(): string {
	return join(resolve(__dirname, ".."), "config", "default-extensions.json");
}

function isPlainObject(value: unknown): value is JsonObject {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function packageIdentityExists(packages: readonly unknown[], identity: string | undefined): boolean {
	return Boolean(identity) && packages.some((entry) => packageIdentity(entry) === identity);
}

function isPinnedNpmSource(source: unknown): boolean {
	return typeof source === "string" && source.trim().startsWith("npm:") && packageIdentity(source) !== source.trim();
}

function isUnpinnedNpmSource(source: unknown): boolean {
	return typeof source === "string" && source.trim().startsWith("npm:") && packageIdentity(source) === source.trim();
}

function shouldMigrateManagedDefaultExtensionSource(
	currentSource: unknown,
	extension: DefaultExtensionEntry,
	{ force, managedPackageIdentities = new Set<string>() }: { force: boolean; managedPackageIdentities?: Set<string> },
): boolean {
	if (force || extension.critical === true) return true;
	const identity = packageIdentity(extension.source);
	if (!identity || packageIdentity(currentSource) !== identity) return false;
	if (!isPinnedNpmSource(extension.source)) return false;
	if (isUnpinnedNpmSource(currentSource)) return true;
	return managedPackageIdentities.has(identity);
}

function shouldMigrateDefaultExtensionReplacements(extension: DefaultExtensionEntry, { force }: { force: boolean }): boolean {
	return force || extension.migrateReplacements === true;
}

function shouldEnsureDefaultExtensionSource(
	existingPackages: readonly unknown[],
	extension: DefaultExtensionEntry,
	{ force }: { force: boolean },
): boolean {
	if (shouldMigrateDefaultExtensionReplacements(extension, { force })) return true;
	if (packageIdentityExists(existingPackages, packageIdentity(extension.source))) return true;
	return !extension.replaces.some((oldSource) => packageIdentityExists(existingPackages, packageIdentity(oldSource)));
}

function prepareDefaults(
	defaults: JsonObject,
	packageSource: string | undefined,
	defaultExtensions: readonly DefaultExtensionEntry[],
	disabledIds: Set<string>,
	existingSettings: unknown,
	{ force }: { force: boolean },
): JsonObject {
	const next = clone(defaults);
	next.lastChangelogVersion = TLH_CHANGELOG_SENTINEL;

	// Strip the anthropic-auth warning suppression from the defaults clone when
	// that extension is disabled, so the merge engine cannot re-introduce
	// warnings.anthropicExtraUsage into an opted-out user's settings on update.
	if (disabledIds.has("anthropic-auth")) {
		const warnings = isPlainObject(next.warnings) ? next.warnings : undefined;
		if (warnings?.anthropicExtraUsage !== undefined) {
			delete warnings.anthropicExtraUsage;
			if (Object.keys(warnings).length === 0) {
				delete next.warnings;
			}
		}
	}

	const ensuredSource = packageSource || DEFAULT_PACKAGE_SOURCE;
	const existingPackages = isPlainObject(existingSettings) && Array.isArray(existingSettings.packages) ? existingSettings.packages : [];
	const ensuredPackages = [
		ensuredSource,
		...defaultExtensions
			.filter((extension) => !disabledIds.has(extension.id))
			.filter((extension) => shouldEnsureDefaultExtensionSource(existingPackages, extension, { force }))
			.map((extension) => extension.source),
	];
	const ensuredIdentities = new Set(ensuredPackages.map(packageIdentity).filter((value): value is string => Boolean(value)));
	const disabledIdentities = new Set(
		defaultExtensions.filter((extension) => disabledIds.has(extension.id)).flatMap(defaultExtensionPackageIdentities),
	);
	const packages = Array.isArray(next.packages) ? next.packages : [];
	next.packages = [
		...ensuredPackages,
		...packages.filter((entry) => {
			const identity = packageIdentity(entry);
			return !ensuredIdentities.has(identity || "") && !disabledIdentities.has(identity || "");
		}),
	];
	return next;
}

function removePackageByIdentity(settings: JsonObject, identity: string | undefined): string | undefined {
	if (!identity || !Array.isArray(settings.packages)) return undefined;
	const index = settings.packages.findIndex((entry: unknown) => packageIdentity(entry) === identity);
	if (index === -1) return undefined;
	const [removed] = settings.packages.splice(index, 1);
	return packageSourceOf(removed) || identity;
}

function removeDuplicatePackagesByIdentity(settings: JsonObject, identity: string | undefined): string[] {
	if (!identity || !Array.isArray(settings.packages)) return [];
	const removedSources: string[] = [];
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

function applyHarnessPackageDedupes(settings: JsonObject, ensuredSource: string, changes: string[]): void {
	if (!Array.isArray(settings.packages)) return;
	for (const removedSource of removeDuplicatePackagesByIdentity(settings, HARNESS_PACKAGE_IDENTITY)) {
		changes.push(`remove duplicate harness package: ${removedSource} (same identity as ${ensuredSource})`);
	}
}

function applyReplacedDefaultExtensions(
	settings: JsonObject,
	defaultExtensions: readonly DefaultExtensionEntry[],
	disabledIds: Set<string>,
	changes: string[],
	{ force }: { force: boolean },
): void {
	if (!Array.isArray(settings.packages)) return;

	for (const extension of defaultExtensions) {
		if (!shouldMigrateDefaultExtensionReplacements(extension, { force })) continue;
		if (disabledIds.has(extension.id)) continue;
		const newIdentity = packageIdentity(extension.source);
		for (const oldSource of extension.replaces) {
			const oldIdentity = packageIdentity(oldSource);
			if (!oldIdentity || oldIdentity === newIdentity) continue;
			let removedSource: string | undefined;
			while ((removedSource = removePackageByIdentity(settings, oldIdentity))) {
				changes.push(`remove replaced default extension package: ${removedSource} -> ${extension.source}`);
			}
		}
	}
}

function applyDefaultExtensionPackageDedupes(
	settings: JsonObject,
	defaultExtensions: readonly DefaultExtensionEntry[],
	disabledIds: Set<string>,
	changes: string[],
	{
		force,
		sourceUpdatedIdentities = new Set<string>(),
	}: { force: boolean; sourceUpdatedIdentities?: Set<string> },
): void {
	if (!Array.isArray(settings.packages)) return;

	for (const extension of defaultExtensions) {
		const identity = packageIdentity(extension.source);
		if (!shouldMigrateDefaultExtensionReplacements(extension, { force }) && !sourceUpdatedIdentities.has(identity || "")) continue;
		if (disabledIds.has(extension.id)) continue;
		const removedSources = removeDuplicatePackagesByIdentity(settings, identity);
		for (const removedSource of removedSources) {
			changes.push(`remove duplicate default extension package: ${removedSource} (same identity as ${extension.source})`);
		}
	}
}

function applyDefaultExtensionSourceUpdates(
	settings: JsonObject,
	defaultExtensions: readonly DefaultExtensionEntry[],
	disabledIds: Set<string>,
	changes: string[],
	{
		force,
		managedPackageIdentities = new Set<string>(),
	}: { force: boolean; managedPackageIdentities?: Set<string> },
): Set<string> {
	const updatedIdentities = new Set<string>();
	if (!Array.isArray(settings.packages)) return updatedIdentities;

	for (const extension of defaultExtensions) {
		if (disabledIds.has(extension.id)) continue;
		const identity = packageIdentity(extension.source);
		if (!identity) continue;
		const index = settings.packages.findIndex((entry: unknown) => packageIdentity(entry) === identity);
		if (index === -1) continue;

		const current = settings.packages[index];
		const currentSource = packageSourceOf(current);
		if (!currentSource) continue;
		if (!shouldMigrateManagedDefaultExtensionSource(currentSource, extension, { force, managedPackageIdentities })) continue;

		const sourceNeedsUpdate = currentSource !== extension.source;
		const removesCriticalExtensionFilter = extension.critical === true
			&& isPlainObject(current)
			&& Object.hasOwn(current, "extensions");
		if (!sourceNeedsUpdate && !removesCriticalExtensionFilter) continue;

		if (isPlainObject(current)) {
			const next: JsonObject = { ...clone(current), source: extension.source };
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

function applyDisabledDefaultExtensions(
	settings: JsonObject,
	defaultExtensions: readonly DefaultExtensionEntry[],
	disabledIds: Set<string>,
	changes: string[],
): void {
	if (disabledIds.size === 0 || !Array.isArray(settings.packages)) return;

	for (const extension of defaultExtensions) {
		if (!disabledIds.has(extension.id)) continue;
		const removedSources: string[] = [];
		for (const identity of defaultExtensionPackageIdentities(extension)) {
			let removedSource: string | undefined;
			while ((removedSource = removePackageByIdentity(settings, identity))) {
				removedSources.push(removedSource);
			}
		}
		if (removedSources.length === 0) continue;

		changes.push(`remove disabled default extension package: ${extension.id}`);
	}
}

function applyRetiredTlhDefaultPackageCleanup(settings: JsonObject, changes: string[], managedPackageIdentities: Set<string>): void {
	if (!Array.isArray(settings.packages)) return;

	for (const source of RETIRED_TLH_DEFAULT_PACKAGE_SOURCES) {
		const identity = packageIdentity(source);
		if (!identity || !managedPackageIdentities.has(identity)) continue;
		let removedSource: string | undefined;
		while ((removedSource = removePackageByIdentity(settings, identity))) {
			changes.push(`remove retired TLH default package: ${removedSource}`);
		}
		managedPackageIdentities.delete(identity);
	}
}

function applyDefaultExtensionLoadOrder(
	settings: JsonObject,
	defaultExtensions: readonly DefaultExtensionEntry[],
	disabledIds: Set<string>,
	changes: string[],
): void {
	const loadOrderRepair = repairTargetedDefaultExtensionLoadOrder(settings, defaultExtensions, disabledIds);
	if (!loadOrderRepair) return;
	changes.push(
		`reorder targeted default extension packages for load order: ${loadOrderRepair.previous.join(", ")} -> ${loadOrderRepair.next.join(", ")}`,
	);
}

// Sources of retired default extensions that TLH now removes unconditionally
// from isolated settings because they should no longer stay installed after
// install/update reruns.
const FORCE_REMOVED_RETIRED_DEFAULT_EXTENSION_SOURCES = Object.freeze([
	"npm:@diegopetrucci/pi-context-cap",
	"npm:@diegopetrucci/pi-permission-gate",
	"npm:@diegopetrucci/pi-confirm-destructive",
	"npm:@diegopetrucci/pi-oracle",
	"git:github.com/diegopetrucci/pi-rtk",
	"npm:pi-rtk",
	"npm:@sherif-fanous/pi-rtk",
	"git:github.com/sherif-fanous/pi-rtk",
	"npm:@diegopetrucci/pi-intercom",
	"npm:pi-intercom",
	"git:github.com/nicobailon/pi-intercom",
	"git:github.com/diegopetrucci/pi-intercom",
]);

function purgeForceRemovedRetiredDefaultExtensionPackages(settings: JsonObject, changes: string[]): void {
	if (!Array.isArray(settings.packages)) return;
	for (const source of FORCE_REMOVED_RETIRED_DEFAULT_EXTENSION_SOURCES) {
		const identity = packageIdentity(source);
		if (!identity) continue;
		while (removePackageByIdentity(settings, identity)) {
			changes.push(`force-remove retired default extension package: ${source}`);
		}
	}
}

function pruneContextCapDisabledDefaultExtension(settings: JsonObject, changes: string[]): void {
	if (!isPlainObject(settings) || !isPlainObject(settings.tlh)) return;
	const values = settings.tlh.disabledDefaultExtensions;
	if (!Array.isArray(values)) return;
	const nextValues = values.filter((value: unknown) => !(typeof value === "string" && value.trim() === "context-cap"));
	if (nextValues.length === values.length) return;
	settings.tlh.disabledDefaultExtensions = nextValues;
	changes.push("remove stale context-cap opt-out from tlh.disabledDefaultExtensions");
}

function pruneOracleDisabledDefaultExtension(settings: JsonObject, changes: string[]): void {
	if (!isPlainObject(settings) || !isPlainObject(settings.tlh)) return;
	const values = settings.tlh.disabledDefaultExtensions;
	if (!Array.isArray(values)) return;
	const nextValues = values.filter((value: unknown) => !(typeof value === "string" && value.trim() === "oracle"));
	if (nextValues.length === values.length) return;
	settings.tlh.disabledDefaultExtensions = nextValues;
	changes.push("remove stale oracle opt-out from tlh.disabledDefaultExtensions");
}

function pruneRtkDisabledDefaultExtension(settings: JsonObject, changes: string[]): void {
	if (!isPlainObject(settings) || !isPlainObject(settings.tlh)) return;
	const values = settings.tlh.disabledDefaultExtensions;
	if (!Array.isArray(values)) return;
	const nextValues = values.filter((value: unknown) => !(typeof value === "string" && ["rtk", "pi-rtk"].includes(value.trim())));
	if (nextValues.length === values.length) return;
	settings.tlh.disabledDefaultExtensions = nextValues;
	changes.push("remove stale rtk opt-out from tlh.disabledDefaultExtensions");
}

function pruneIntercomDisabledDefaultExtension(settings: JsonObject, changes: string[]): void {
	if (!isPlainObject(settings) || !isPlainObject(settings.tlh)) return;
	const values = settings.tlh.disabledDefaultExtensions;
	if (!Array.isArray(values)) return;
	const nextValues = values.filter((value: unknown) => !(typeof value === "string" && ["intercom", "pi-intercom"].includes(value.trim())));
	if (nextValues.length === values.length) return;
	settings.tlh.disabledDefaultExtensions = nextValues;
	changes.push("remove stale intercom opt-out from tlh.disabledDefaultExtensions");
}

function pruneFffDisabledDefaultExtension(settings: JsonObject, changes: string[]): void {
	if (!isPlainObject(settings) || !isPlainObject(settings.tlh)) return;
	const values = settings.tlh.disabledDefaultExtensions;
	if (!Array.isArray(values)) return;
	const nextValues = values.filter((value: unknown) => !(typeof value === "string" && ["fff", "pi-fff"].includes(value.trim())));
	if (nextValues.length === values.length) return;
	settings.tlh.disabledDefaultExtensions = nextValues;
	changes.push("remove stale fff opt-out from tlh.disabledDefaultExtensions");
}

function scrubGnosisSettings(settings: JsonObject, changes: string[]): void {
	if (!isPlainObject(settings) || !isPlainObject(settings.tlh)) return;
	if (!Object.hasOwn(settings.tlh, "gnosis")) return;
	delete settings.tlh.gnosis;
	changes.push("remove tlh.gnosis (one-time cleanup)");
}

function scrubRtkSettings(settings: JsonObject, changes: string[]): void {
	if (!isPlainObject(settings) || !isPlainObject(settings.tlh)) return;
	if (!Object.hasOwn(settings.tlh, "rtk")) return;
	delete settings.tlh.rtk;
	changes.push("remove tlh.rtk (one-time cleanup)");
}

function removeCriticalDisabledDefaultExtensionOptOuts(
	settings: JsonObject,
	defaultExtensions: readonly DefaultExtensionEntry[],
	changes: string[],
): void {
	if (!isPlainObject(settings) || !isPlainObject(settings.tlh)) return;
	const values = settings.tlh.disabledDefaultExtensions;
	if (!Array.isArray(values)) return;

	const criticalIds = criticalDefaultExtensionOptOutIds(defaultExtensions);
	if (criticalIds.size === 0) return;

	const nextValues = values.filter((value: unknown) => !(typeof value === "string" && criticalIds.has(value.trim())));
	if (nextValues.length === values.length) return;

	settings.tlh.disabledDefaultExtensions = nextValues;
	changes.push("remove invalid critical default extension opt-out");
}

function sameIdentitySets(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	if (left.size !== right.size) return false;
	for (const value of left) {
		if (!right.has(value)) return false;
	}
	return true;
}

function syncDefaultExtensionProvenance(
	settings: JsonObject,
	defaultExtensions: readonly DefaultExtensionEntry[],
	disabledIds: Set<string>,
	changes: string[],
): void {
	const previous = readDefaultExtensionProvenance(settings);
	const tlh = isPlainObject(settings) && isPlainObject(settings.tlh) ? settings.tlh : undefined;
	const previousRaw = tlh && Object.hasOwn(tlh, "defaultExtensionProvenance")
		? JSON.stringify(tlh.defaultExtensionProvenance)
		: undefined;
	const nextManagedIdentities = managedDefaultExtensionPackageIdentities(settings, defaultExtensions, disabledIds);
	if (!setDefaultExtensionProvenance(settings, nextManagedIdentities)) return;
	const nextTlh = isPlainObject(settings.tlh) ? settings.tlh : undefined;
	const nextRaw = JSON.stringify(nextTlh?.defaultExtensionProvenance);
	if (previousRaw !== nextRaw || !previous.exists || !sameIdentitySets(previous.managedPackageIdentities, nextManagedIdentities)) {
		changes.push("update TLH default extension provenance metadata");
	}
}

function mergeSettings(existing: unknown, defaults: unknown, { force }: { force: boolean }): { next: JsonObject; changes: string[] } {
	if (!isPlainObject(existing)) {
		throw new Error("Existing settings must be a JSON object");
	}
	if (!isPlainObject(defaults)) {
		throw new Error("Default settings must be a JSON object");
	}

	const next = clone(existing);
	const changes: string[] = [];
	mergeObject(next, defaults, changes, { force, path: [] });
	return { next, changes };
}

function isPersistentTelemetryOptOut(path: readonly string[], currentValue: unknown, defaultValue: unknown): boolean {
	// Telemetry opt-outs are user-owned and must survive installer reruns and forced updates.
	return path.join(".") === "tlh.telemetry.enabled" && currentValue === false && defaultValue === true;
}

function isInstallerOwnedSetting(path: readonly string[]): boolean {
	const joinedPath = path.join(".");
	return joinedPath === "lastChangelogVersion" || joinedPath === "subagents.disableBuiltins";
}

function isInstallerOwnedObjectContainer(path: readonly string[]): boolean {
	return path.join(".") === "subagents";
}

function mergeObject(target: JsonObject, defaults: JsonObject, changes: string[], options: MergeOptions): void {
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

		if (isPlainObject(value) && isInstallerOwnedObjectContainer(path)) {
			target[key] = clone(value);
			changes.push(`overwrite ${label}`);
			continue;
		}

		if (isPersistentTelemetryOptOut(path, target[key], value)) {
			continue;
		}

		if ((options.force || isInstallerOwnedSetting(path)) && JSON.stringify(target[key]) !== JSON.stringify(value)) {
			target[key] = clone(value);
			changes.push(`overwrite ${label}`);
		}
	}
}

function mergePackages(target: JsonObject, packageDefaults: unknown, changes: string[]): void {
	if (!Array.isArray(packageDefaults)) {
		throw new Error("Default settings field 'packages' must be an array");
	}
	if (target.packages === undefined) {
		target.packages = [];
	}
	if (!Array.isArray(target.packages)) {
		throw new Error("Existing settings field 'packages' must be an array if present");
	}

	const seen = new Map<string, number>();
	target.packages.forEach((entry: unknown, index: number) => {
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
			const existingIndex = seen.get(identity) as number;
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

function normalizeAgentDirPath(value: string): string {
	const normalized = normalize(value);
	const root = parse(normalized).root;
	let stripped = normalized;
	while (stripped.length > root.length && stripped.endsWith(sep)) {
		stripped = stripped.slice(0, -sep.length);
	}
	return stripped;
}

function arrayMergeKey(item: unknown, path: readonly string[]): string {
	if (path.join(".") === "subagents.agentDirs" && typeof item === "string") {
		return `path:${normalizeAgentDirPath(item)}`;
	}
	return `json:${JSON.stringify(item)}`;
}

function mergeArray(
	targetArray: unknown[],
	defaultArray: readonly unknown[],
	changes: string[],
	{ label, path }: { label: string; path: readonly string[] },
): void {
	const seen = new Set(targetArray.map((item) => arrayMergeKey(item, path)));
	for (const item of defaultArray) {
		const key = arrayMergeKey(item, path);
		if (seen.has(key)) continue;
		targetArray.push(clone(item));
		seen.add(key);
		changes.push(`append ${label}`);
	}
}

function backupPathFor(settingsPath: string): string {
	return backupPathWithTimestamp(settingsPath);
}

function assertNotNormalPiSettings(settingsPath: string): void {
	assertNotInNormalPiConfig(
		settingsPath,
		`Refusing to modify normal Pi config from The Last Harness installer: ${settingsPath}`,
	);
}

function writeExistingProfileBackup(settingsPath: string, backupPath: string): void {
	const { content, mode } = readRegularFileForBackup(settingsPath, "Pi settings");
	writeSafeProfileFile(
		{ agentDir: dirname(settingsPath) },
		basename(backupPath),
		content,
		"Pi settings backup",
		{ mode },
	);
}

function writeSettings(
	settingsPath: string,
	value: JsonObject,
	{ dryRun, existed }: { dryRun: boolean; existed: boolean },
): string | undefined {
	const formatted = `${JSON.stringify(value, null, 2)}\n`;
	if (dryRun) return undefined;

	let backupPath: string | undefined;
	if (existed) {
		backupPath = backupPathFor(settingsPath);
		writeExistingProfileBackup(settingsPath, backupPath);
	}

	writeSafeProfileFile({ agentDir: dirname(settingsPath) }, basename(settingsPath), formatted, "Pi settings");
	return backupPath;
}

function log(args: CliArgs, message: string): void {
	if (!args.quiet) console.log(message);
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(usage());
		return;
	}

	const defaultsPath = resolve(expandHomePath(args.defaultsPath || defaultDefaultsPath()) || defaultDefaultsPath());
	const defaultExtensionsPath = resolve(
		expandHomePath(args.defaultExtensionsPath || defaultDefaultExtensionsPath()) || defaultDefaultExtensionsPath(),
	);
	const settingsPath = resolve(expandHomePath(args.settingsPath || defaultTlhSettingsPath()) || defaultTlhSettingsPath());
	assertNotNormalPiSettings(settingsPath);
	const existed = existsSync(settingsPath);
	const existing = readJsonFile<JsonObject>(settingsPath, { missingValue: {} });
	const rawDefaults = readJsonFile<JsonObject>(defaultsPath);
	const defaultExtensions = readDefaultExtensions(defaultExtensionsPath, { allowMissing: true });
	const disabledIds = disabledDefaultExtensionIds(existing, defaultExtensions);
	const ensuredHarnessSource = args.packageSource || DEFAULT_PACKAGE_SOURCE;
	const defaults = prepareDefaults(rawDefaults, args.packageSource, defaultExtensions, disabledIds, existing, { force: args.force });
	const { next, changes } = mergeSettings(existing, defaults, { force: args.force });
	applyHarnessPackageDedupes(next, ensuredHarnessSource, changes);
	const managedDefaultExtensionProvenance = readDefaultExtensionProvenance(next).managedPackageIdentities;
	const sourceUpdatedIdentities = applyDefaultExtensionSourceUpdates(next, defaultExtensions, disabledIds, changes, {
		force: args.force,
		managedPackageIdentities: managedDefaultExtensionProvenance,
	});
	applyReplacedDefaultExtensions(next, defaultExtensions, disabledIds, changes, { force: args.force });
	applyDefaultExtensionPackageDedupes(next, defaultExtensions, disabledIds, changes, { force: args.force, sourceUpdatedIdentities });
	applyDisabledDefaultExtensions(next, defaultExtensions, disabledIds, changes);
	applyRetiredTlhDefaultPackageCleanup(
		next,
		changes,
		withLegacyRetiredDefaultPackageIdentities(next, readDefaultExtensionProvenance(next).managedPackageIdentities),
	);
	applyDefaultExtensionLoadOrder(next, defaultExtensions, disabledIds, changes);
	removeCriticalDisabledDefaultExtensionOptOuts(next, defaultExtensions, changes);
	scrubGnosisSettings(next, changes);
	scrubRtkSettings(next, changes);
	purgeForceRemovedRetiredDefaultExtensionPackages(next, changes);
	pruneContextCapDisabledDefaultExtension(next, changes);
	pruneOracleDisabledDefaultExtension(next, changes);
	pruneRtkDisabledDefaultExtension(next, changes);
	pruneIntercomDisabledDefaultExtension(next, changes);
	pruneFffDisabledDefaultExtension(next, changes);
	syncDefaultExtensionProvenance(next, defaultExtensions, disabledIds, changes);

	log(args, `Pi settings: ${settingsPath}`);
	if (changes.length === 0) {
		log(args, "No settings changes needed.");
		return;
	}

	for (const change of changes) {
		log(args, `${args.dryRun ? "Would" : "Will"} ${change}`);
	}

	if (args.dryRun) {
		if (existed) log(args, "Would back up existing settings before writing.");
		log(args, "Dry run only; no settings were changed.");
		return;
	}

	const backupPath = writeSettings(settingsPath, next, { dryRun: args.dryRun, existed });
	if (backupPath) log(args, `Backed up previous settings to: ${backupPath}`);
	log(args, "Settings updated.");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

try {
	main();
} catch (error) {
	console.error(`merge-settings: ${errorMessage(error)}`);
	process.exit(1);
}

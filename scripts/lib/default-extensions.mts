import { existsSync, readFileSync } from "node:fs";

import { parseGitSource } from "./tlh-install-package-source.mjs";

interface PlainObject {
	[key: string]: unknown;
}

interface RawDefaultExtensionProvenance {
	managedPackageIdentities?: unknown;
}

interface RawTlhSettings {
	disabledDefaultExtensions?: unknown;
	defaultExtensionProvenance?: unknown;
}

interface RawSettings extends PlainObject {
	packages?: unknown;
	tlh?: unknown;
}

export interface DefaultExtensionEntry {
	id: string;
	aliases: string[];
	replaces: string[];
	migrateReplacements: boolean;
	critical: boolean;
	source: string;
	description: string;
}

export interface DefaultExtensionProvenance {
	exists: boolean;
	managedPackageIdentities: Set<string>;
}

function isPlainObject(value: unknown): value is PlainObject {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readManifestJson(path: string, { allowMissing }: { allowMissing: boolean }): unknown {
	if (!existsSync(path)) {
		if (allowMissing) return [];
		throw new Error(`File does not exist: ${path}`);
	}
	const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
	if (!raw.trim()) return {};
	try {
		return JSON.parse(raw) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid JSON in ${path}: ${message}`);
	}
}

function readStringArrayField(entry: PlainObject, key: string, label: string): string[] {
	if (entry[key] === undefined) return [];
	if (!Array.isArray(entry[key])) {
		throw new Error(`Default extension ${label} field '${key}' must be an array`);
	}
	return entry[key]
		.map((value) => (typeof value === "string" ? value.trim() : ""))
		.filter((value) => value.length > 0);
}

function readBooleanField(entry: PlainObject, key: string, label: string): boolean {
	if (entry[key] === undefined) return false;
	if (typeof entry[key] !== "boolean") {
		throw new Error(`Default extension ${label} field '${key}' must be a boolean`);
	}
	return entry[key];
}

function npmIdentity(spec: string): string {
	const withoutPrefix = spec.slice("npm:".length).trim();
	if (!withoutPrefix) return spec;
	if (withoutPrefix.startsWith("@")) {
		const secondAt = withoutPrefix.indexOf("@", 1);
		return `npm:${secondAt === -1 ? withoutPrefix : withoutPrefix.slice(0, secondAt)}`;
	}
	const firstAt = withoutPrefix.indexOf("@");
	return `npm:${firstAt === -1 ? withoutPrefix : withoutPrefix.slice(0, firstAt)}`;
}

function gitIdentity(source: string): string {
	const parsed = parseGitSource(source);
	if (parsed) return `git:${parsed.host.toLowerCase()}/${parsed.path.toLowerCase()}`;

	let value = source.trim();
	if (value.startsWith("git:")) value = value.slice("git:".length).trim();
	value = value.replace(/^https?:\/\//i, "");
	value = value.replace(/^ssh:\/\//i, "");
	value = value.replace(/^git:\/\//i, "");
	value = value.replace(/^git@([^:]+):/, "$1/");
	value = value.replace(/#.*$/, "");
	value = value.replace(/\.git$/, "");
	value = value.replace(/\.git(?=@)/, "");

	const firstAt = value.indexOf("@");
	if (firstAt !== -1) value = value.slice(0, firstAt);

	return `git:${value.toLowerCase()}`;
}

export const RETIRED_TLH_DEFAULT_PACKAGE_SOURCES = Object.freeze([
	"npm:@plannotator/pi-extension",
]);

const TARGETED_DEFAULT_EXTENSION_LOAD_ORDER = ["rtk", "quiet-tools"] as const;

export function packageSourceOf(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	if (isPlainObject(entry) && typeof entry.source === "string") return entry.source;
	return undefined;
}

export function packageIdentity(entry: unknown): string | undefined {
	const source = packageSourceOf(entry);
	if (!source) return undefined;
	const trimmed = source.trim();
	if (trimmed.startsWith("npm:")) return npmIdentity(trimmed);
	if (
		trimmed.startsWith("git:")
		|| /^(https?|ssh|git):\/\//i.test(trimmed)
		|| trimmed.startsWith("git@")
	) {
		return gitIdentity(trimmed);
	}
	return `local:${trimmed}`;
}

export function readDefaultExtensions(path: string, { allowMissing = false }: { allowMissing?: boolean } = {}): DefaultExtensionEntry[] {
	const raw = readManifestJson(path, { allowMissing });
	if (!Array.isArray(raw)) {
		throw new Error(`Default extension manifest must be an array: ${path}`);
	}

	const seenIds = new Set<string>();
	const seenSources = new Set<string>();
	return raw.map((entry, index) => {
		if (!isPlainObject(entry)) {
			throw new Error(`Default extension entry ${index + 1} must be an object`);
		}
		const id = typeof entry.id === "string" ? entry.id.trim() : "";
		const source = typeof entry.source === "string" ? entry.source.trim() : "";
		const description = typeof entry.description === "string" ? entry.description.trim() : "";
		const aliases = readStringArrayField(entry, "aliases", id || String(index + 1));
		const replaces = readStringArrayField(entry, "replaces", id || String(index + 1));
		const migrateReplacements = readBooleanField(entry, "migrateReplacements", id || String(index + 1));
		const critical = readBooleanField(entry, "critical", id || String(index + 1));
		if (!id) throw new Error(`Default extension entry ${index + 1} is missing id`);
		if (!source) throw new Error(`Default extension ${id} is missing source`);
		for (const candidateId of [id, ...aliases]) {
			if (seenIds.has(candidateId)) throw new Error(`Duplicate default extension id or alias: ${candidateId}`);
			seenIds.add(candidateId);
		}
		const identity = packageIdentity(source);
		if (!identity) throw new Error(`Default extension ${id} has invalid source identity`);
		if (seenSources.has(identity)) throw new Error(`Duplicate default extension source: ${source}`);
		seenSources.add(identity);
		return { id, aliases, replaces, migrateReplacements, critical, source, description };
	});
}

function rawDisabledDefaultExtensionIds(settings: unknown): Set<string> {
	if (!isPlainObject(settings)) return new Set();
	const tlh = isPlainObject(settings.tlh) ? (settings.tlh as RawTlhSettings) : undefined;
	const values = tlh?.disabledDefaultExtensions;
	if (!Array.isArray(values)) return new Set();
	return new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()));
}

function rawDefaultExtensionProvenance(settings: unknown): { exists: boolean; value: RawDefaultExtensionProvenance | undefined } {
	if (!isPlainObject(settings) || !isPlainObject(settings.tlh)) {
		return { exists: false, value: undefined };
	}
	const exists = Object.hasOwn(settings.tlh, "defaultExtensionProvenance");
	const value = exists && isPlainObject(settings.tlh.defaultExtensionProvenance)
		? settings.tlh.defaultExtensionProvenance as RawDefaultExtensionProvenance
		: undefined;
	return { exists, value };
}

function normalizeManagedPackageIdentity(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("local:")) return trimmed;
	return packageIdentity(trimmed);
}

export function criticalDefaultExtensionOptOutIds(defaultExtensions: readonly DefaultExtensionEntry[]): Set<string> {
	const ids = new Set<string>();
	for (const extension of defaultExtensions) {
		if (extension.critical !== true) continue;
		ids.add(extension.id);
		for (const alias of extension.aliases) ids.add(alias);
	}
	return ids;
}

export function disabledDefaultExtensionIds(
	settings: unknown,
	defaultExtensions: readonly DefaultExtensionEntry[] = [],
): Set<string> {
	const ids = rawDisabledDefaultExtensionIds(settings);
	for (const id of criticalDefaultExtensionOptOutIds(defaultExtensions)) {
		ids.delete(id);
	}
	for (const extension of defaultExtensions) {
		if (extension.critical === true) continue;
		if ([extension.id, ...extension.aliases].some((id) => ids.has(id))) {
			ids.add(extension.id);
			for (const alias of extension.aliases) ids.delete(alias);
		}
	}
	return ids;
}

export function defaultExtensionPackageIdentities(extension: DefaultExtensionEntry): string[] {
	return [extension.source, ...extension.replaces]
		.map(packageIdentity)
		.filter((value): value is string => Boolean(value));
}

export function readDefaultExtensionProvenance(settings: unknown): DefaultExtensionProvenance {
	const { exists, value } = rawDefaultExtensionProvenance(settings);
	const managedPackageIdentities = new Set(
		Array.isArray(value?.managedPackageIdentities)
			? value.managedPackageIdentities.map(normalizeManagedPackageIdentity).filter((identity): identity is string => Boolean(identity))
			: [],
	);
	return { exists, managedPackageIdentities };
}

export function setDefaultExtensionProvenance(
	settings: PlainObject,
	managedPackageIdentities: Iterable<string>,
): boolean {
	let tlh = settings.tlh;
	if (tlh === undefined) {
		tlh = {};
		settings.tlh = tlh;
	}
	if (!isPlainObject(tlh)) return false;

	const values = [...new Set([...managedPackageIdentities].map(normalizeManagedPackageIdentity).filter((identity): identity is string => Boolean(identity)))]
		.sort((left, right) => left.localeCompare(right));
	tlh.defaultExtensionProvenance = { managedPackageIdentities: values };
	return true;
}

export function withLegacyRetiredDefaultPackageIdentities(
	settings: unknown,
	managedPackageIdentities = new Set<string>(),
	retiredPackageSources: readonly string[] = RETIRED_TLH_DEFAULT_PACKAGE_SOURCES,
): Set<string> {
	const nextManagedPackageIdentities = new Set(managedPackageIdentities);
	const { exists } = rawDefaultExtensionProvenance(settings);
	if (exists || !isPlainObject(settings) || !Array.isArray((settings as RawSettings).packages)) {
		return nextManagedPackageIdentities;
	}

	const packages = (settings as RawSettings).packages as unknown[];
	for (const source of retiredPackageSources) {
		const identity = packageIdentity(source);
		if (!identity) continue;
		if (packages.some((entry) => packageIdentity(entry) === identity)) {
			nextManagedPackageIdentities.add(identity);
		}
	}

	return nextManagedPackageIdentities;
}

export function managedDefaultExtensionPackageIdentities(
	settings: unknown,
	defaultExtensions: readonly DefaultExtensionEntry[],
	disabledIds = new Set<string>(),
): Set<string> {
	const managedIdentities = new Set<string>();
	if (!isPlainObject(settings) || !Array.isArray((settings as RawSettings).packages)) return managedIdentities;

	const packages = (settings as RawSettings).packages as unknown[];
	for (const extension of defaultExtensions) {
		if (disabledIds.has(extension.id)) continue;
		const identity = packageIdentity(extension.source);
		if (!identity) continue;
		if (packages.some((entry) => packageIdentity(entry) === identity)) {
			managedIdentities.add(identity);
		}
	}

	return managedIdentities;
}

export function repairTargetedDefaultExtensionLoadOrder(
	settings: unknown,
	defaultExtensions: readonly DefaultExtensionEntry[],
	disabledIds = new Set<string>(),
): { previous: string[]; next: string[] } | undefined {
	if (!isPlainObject(settings) || !Array.isArray((settings as RawSettings).packages)) return undefined;

	const packages = (settings as RawSettings).packages as unknown[];
	const identityOrder = new Map<string, number>();
	const identityLabels = new Map<string, string>();
	for (const [order, targetedId] of TARGETED_DEFAULT_EXTENSION_LOAD_ORDER.entries()) {
		const extension = defaultExtensions.find(({ id }) => id === targetedId);
		if (!extension || disabledIds.has(extension.id)) continue;
		for (const identity of defaultExtensionPackageIdentities(extension)) {
			if (identityOrder.has(identity)) continue;
			identityOrder.set(identity, order);
			identityLabels.set(identity, extension.id);
		}
	}

	const matchedEntries: Array<{ index: number; order: number; entry: unknown; label: string }> = [];
	for (const [index, entry] of packages.entries()) {
		const identity = packageIdentity(entry);
		if (!identity) continue;
		const order = identityOrder.get(identity);
		if (order === undefined) continue;
		matchedEntries.push({
			index,
			order,
			entry,
			label: identityLabels.get(identity) || identity,
		});
	}
	if (matchedEntries.length < 2) return undefined;

	const reorderedEntries = [...matchedEntries].sort((left, right) => left.order - right.order || left.index - right.index);
	if (matchedEntries.every((entry, index) => entry === reorderedEntries[index])) return undefined;

	for (let index = 0; index < matchedEntries.length; index += 1) {
		packages[matchedEntries[index].index] = reorderedEntries[index].entry;
	}

	return {
		previous: matchedEntries.map(({ label }) => label),
		next: reorderedEntries.map(({ label }) => label),
	};
}

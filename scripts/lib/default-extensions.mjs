import { existsSync, readFileSync } from "node:fs";
import { parseGitSource } from "./tlh-install-package-source.mjs";
function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function readManifestJson(path, { allowMissing }) {
    if (!existsSync(path)) {
        if (allowMissing)
            return [];
        throw new Error(`File does not exist: ${path}`);
    }
    const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    if (!raw.trim())
        return {};
    try {
        return JSON.parse(raw);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid JSON in ${path}: ${message}`);
    }
}
function readStringArrayField(entry, key, label) {
    if (entry[key] === undefined)
        return [];
    if (!Array.isArray(entry[key])) {
        throw new Error(`Default extension ${label} field '${key}' must be an array`);
    }
    return entry[key]
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => value.length > 0);
}
function readBooleanField(entry, key, label) {
    if (entry[key] === undefined)
        return false;
    if (typeof entry[key] !== "boolean") {
        throw new Error(`Default extension ${label} field '${key}' must be a boolean`);
    }
    return entry[key];
}
function npmIdentity(spec) {
    const withoutPrefix = spec.slice("npm:".length).trim();
    if (!withoutPrefix)
        return spec;
    if (withoutPrefix.startsWith("@")) {
        const secondAt = withoutPrefix.indexOf("@", 1);
        return `npm:${secondAt === -1 ? withoutPrefix : withoutPrefix.slice(0, secondAt)}`;
    }
    const firstAt = withoutPrefix.indexOf("@");
    return `npm:${firstAt === -1 ? withoutPrefix : withoutPrefix.slice(0, firstAt)}`;
}
function gitIdentity(source) {
    const parsed = parseGitSource(source);
    if (parsed)
        return `git:${parsed.host.toLowerCase()}/${parsed.path.toLowerCase()}`;
    let value = source.trim();
    if (value.startsWith("git:"))
        value = value.slice("git:".length).trim();
    value = value.replace(/^https?:\/\//i, "");
    value = value.replace(/^ssh:\/\//i, "");
    value = value.replace(/^git:\/\//i, "");
    value = value.replace(/^git@([^:]+):/, "$1/");
    value = value.replace(/#.*$/, "");
    value = value.replace(/\.git$/, "");
    value = value.replace(/\.git(?=@)/, "");
    const firstAt = value.indexOf("@");
    if (firstAt !== -1)
        value = value.slice(0, firstAt);
    return `git:${value.toLowerCase()}`;
}
export const RETIRED_TLH_DEFAULT_PACKAGE_SOURCES = Object.freeze([
    "npm:@plannotator/pi-extension",
]);
const TARGETED_DEFAULT_EXTENSION_LOAD_ORDER = ["rtk", "quiet-tools"];
export function packageSourceOf(entry) {
    if (typeof entry === "string")
        return entry;
    if (isPlainObject(entry) && typeof entry.source === "string")
        return entry.source;
    return undefined;
}
export function packageIdentity(entry) {
    const source = packageSourceOf(entry);
    if (!source)
        return undefined;
    const trimmed = source.trim();
    if (trimmed.startsWith("npm:"))
        return npmIdentity(trimmed);
    if (trimmed.startsWith("git:")
        || /^(https?|ssh|git):\/\//i.test(trimmed)
        || trimmed.startsWith("git@")) {
        return gitIdentity(trimmed);
    }
    return `local:${trimmed}`;
}
export function readDefaultExtensions(path, { allowMissing = false } = {}) {
    const raw = readManifestJson(path, { allowMissing });
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
        const migrateReplacements = readBooleanField(entry, "migrateReplacements", id || String(index + 1));
        const critical = readBooleanField(entry, "critical", id || String(index + 1));
        if (!id)
            throw new Error(`Default extension entry ${index + 1} is missing id`);
        if (!source)
            throw new Error(`Default extension ${id} is missing source`);
        for (const candidateId of [id, ...aliases]) {
            if (seenIds.has(candidateId))
                throw new Error(`Duplicate default extension id or alias: ${candidateId}`);
            seenIds.add(candidateId);
        }
        const identity = packageIdentity(source);
        if (!identity)
            throw new Error(`Default extension ${id} has invalid source identity`);
        if (seenSources.has(identity))
            throw new Error(`Duplicate default extension source: ${source}`);
        seenSources.add(identity);
        return { id, aliases, replaces, migrateReplacements, critical, source, description };
    });
}
function rawDisabledDefaultExtensionIds(settings) {
    if (!isPlainObject(settings))
        return new Set();
    const tlh = isPlainObject(settings.tlh) ? settings.tlh : undefined;
    const values = tlh?.disabledDefaultExtensions;
    if (!Array.isArray(values))
        return new Set();
    return new Set(values.filter((value) => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()));
}
function rawDefaultExtensionProvenance(settings) {
    if (!isPlainObject(settings) || !isPlainObject(settings.tlh)) {
        return { exists: false, value: undefined };
    }
    const exists = Object.hasOwn(settings.tlh, "defaultExtensionProvenance");
    const value = exists && isPlainObject(settings.tlh.defaultExtensionProvenance)
        ? settings.tlh.defaultExtensionProvenance
        : undefined;
    return { exists, value };
}
function normalizeManagedPackageIdentity(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    if (!trimmed)
        return undefined;
    if (trimmed.startsWith("local:"))
        return trimmed;
    return packageIdentity(trimmed);
}
export function criticalDefaultExtensionOptOutIds(defaultExtensions) {
    const ids = new Set();
    for (const extension of defaultExtensions) {
        if (extension.critical !== true)
            continue;
        ids.add(extension.id);
        for (const alias of extension.aliases)
            ids.add(alias);
    }
    return ids;
}
export function disabledDefaultExtensionIds(settings, defaultExtensions = []) {
    const ids = rawDisabledDefaultExtensionIds(settings);
    for (const id of criticalDefaultExtensionOptOutIds(defaultExtensions)) {
        ids.delete(id);
    }
    for (const extension of defaultExtensions) {
        if (extension.critical === true)
            continue;
        if ([extension.id, ...extension.aliases].some((id) => ids.has(id))) {
            ids.add(extension.id);
            for (const alias of extension.aliases)
                ids.delete(alias);
        }
    }
    return ids;
}
export function defaultExtensionPackageIdentities(extension) {
    return [extension.source, ...extension.replaces]
        .map(packageIdentity)
        .filter((value) => Boolean(value));
}
export function readDefaultExtensionProvenance(settings) {
    const { exists, value } = rawDefaultExtensionProvenance(settings);
    const managedPackageIdentities = new Set(Array.isArray(value?.managedPackageIdentities)
        ? value.managedPackageIdentities.map(normalizeManagedPackageIdentity).filter((identity) => Boolean(identity))
        : []);
    return { exists, managedPackageIdentities };
}
export function setDefaultExtensionProvenance(settings, managedPackageIdentities) {
    let tlh = settings.tlh;
    if (tlh === undefined) {
        tlh = {};
        settings.tlh = tlh;
    }
    if (!isPlainObject(tlh))
        return false;
    const values = [...new Set([...managedPackageIdentities].map(normalizeManagedPackageIdentity).filter((identity) => Boolean(identity)))]
        .sort((left, right) => left.localeCompare(right));
    tlh.defaultExtensionProvenance = { managedPackageIdentities: values };
    return true;
}
export function withLegacyRetiredDefaultPackageIdentities(settings, managedPackageIdentities = new Set(), retiredPackageSources = RETIRED_TLH_DEFAULT_PACKAGE_SOURCES) {
    const nextManagedPackageIdentities = new Set(managedPackageIdentities);
    const { exists } = rawDefaultExtensionProvenance(settings);
    if (exists || !isPlainObject(settings) || !Array.isArray(settings.packages)) {
        return nextManagedPackageIdentities;
    }
    const packages = settings.packages;
    for (const source of retiredPackageSources) {
        const identity = packageIdentity(source);
        if (!identity)
            continue;
        if (packages.some((entry) => packageIdentity(entry) === identity)) {
            nextManagedPackageIdentities.add(identity);
        }
    }
    return nextManagedPackageIdentities;
}
export function managedDefaultExtensionPackageIdentities(settings, defaultExtensions, disabledIds = new Set()) {
    const managedIdentities = new Set();
    if (!isPlainObject(settings) || !Array.isArray(settings.packages))
        return managedIdentities;
    const packages = settings.packages;
    for (const extension of defaultExtensions) {
        if (disabledIds.has(extension.id))
            continue;
        const identity = packageIdentity(extension.source);
        if (!identity)
            continue;
        if (packages.some((entry) => packageIdentity(entry) === identity)) {
            managedIdentities.add(identity);
        }
    }
    return managedIdentities;
}
export function repairTargetedDefaultExtensionLoadOrder(settings, defaultExtensions, disabledIds = new Set()) {
    if (!isPlainObject(settings) || !Array.isArray(settings.packages))
        return undefined;
    const packages = settings.packages;
    const identityOrder = new Map();
    const identityLabels = new Map();
    for (const [order, targetedId] of TARGETED_DEFAULT_EXTENSION_LOAD_ORDER.entries()) {
        const extension = defaultExtensions.find(({ id }) => id === targetedId);
        if (!extension || disabledIds.has(extension.id))
            continue;
        for (const identity of defaultExtensionPackageIdentities(extension)) {
            if (identityOrder.has(identity))
                continue;
            identityOrder.set(identity, order);
            identityLabels.set(identity, extension.id);
        }
    }
    const matchedEntries = [];
    for (const [index, entry] of packages.entries()) {
        const identity = packageIdentity(entry);
        if (!identity)
            continue;
        const order = identityOrder.get(identity);
        if (order === undefined)
            continue;
        matchedEntries.push({
            index,
            order,
            entry,
            label: identityLabels.get(identity) || identity,
        });
    }
    if (matchedEntries.length < 2)
        return undefined;
    const reorderedEntries = [...matchedEntries].sort((left, right) => left.order - right.order || left.index - right.index);
    if (matchedEntries.every((entry, index) => entry === reorderedEntries[index]))
        return undefined;
    for (let index = 0; index < matchedEntries.length; index += 1) {
        packages[matchedEntries[index].index] = reorderedEntries[index].entry;
    }
    return {
        previous: matchedEntries.map(({ label }) => label),
        next: reorderedEntries.map(({ label }) => label),
    };
}

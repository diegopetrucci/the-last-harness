import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultExtensionPackageIdentities, packageIdentity, packageSourceOf, readDefaultExtensions, } from "./default-extensions.mjs";
import { criticalGitSourceSpec, parseGitSource, packageSourceInstallDir, } from "./tlh-install-package-source.mjs";
export const MCP_ADAPTER_CUTOVER_EXTENSION_ID = "mcporter";
export const MCP_ADAPTER_NATIVE_MAJOR = 5;
function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}
function parseReleaseVersion(value) {
    if (typeof value !== "string")
        return undefined;
    const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:\+[-0-9A-Za-z.]+)?$/);
    if (!match)
        return undefined;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
    };
}
function compareVersions(left, right) {
    if (left.major !== right.major)
        return left.major - right.major;
    if (left.minor !== right.minor)
        return left.minor - right.minor;
    return left.patch - right.patch;
}
function isErrno(error, code) {
    return (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === code);
}
/**
 * Recognize only the small numeric ^/~ selector family whose bounds we can
 * prove without importing a semver range parser into the startup guard.
 */
function parseBoundedNpmSelector(source) {
    const trimmed = source.trim();
    if (!trimmed.startsWith("npm:"))
        return undefined;
    const identity = packageIdentity(trimmed);
    if (!identity || identity === trimmed)
        return undefined;
    const selector = trimmed.slice(identity.length);
    const match = selector.match(/^@([~^])(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
    if (!match)
        return undefined;
    const operator = match[1];
    const lower = {
        major: Number(match[2]),
        minor: Number(match[3] || 0),
        patch: Number(match[4] || 0),
    };
    let upper;
    if (operator === "~") {
        upper =
            match[3] === undefined
                ? { major: lower.major + 1, minor: 0, patch: 0 }
                : { major: lower.major, minor: lower.minor + 1, patch: 0 };
    }
    else if (lower.major > 0) {
        upper = { major: lower.major + 1, minor: 0, patch: 0 };
    }
    else if (lower.minor > 0) {
        upper = { major: 0, minor: lower.minor + 1, patch: 0 };
    }
    else {
        upper = { major: 0, minor: 0, patch: lower.patch + 1 };
    }
    return { lower, upper };
}
function versionSatisfiesBoundedNpmSelector(version, selector) {
    return (compareVersions(version, selector.lower) >= 0 && compareVersions(version, selector.upper) < 0);
}
function exactSourceVersion(source) {
    const trimmed = source.trim();
    if (trimmed.startsWith("npm:")) {
        const identity = packageIdentity(trimmed);
        if (!identity?.startsWith("npm:"))
            return undefined;
        const packageName = identity.slice("npm:".length);
        const spec = trimmed.slice("npm:".length);
        if (!spec.startsWith(`${packageName}@`))
            return undefined;
        return parseReleaseVersion(spec.slice(packageName.length + 1));
    }
    const parsed = parseGitSource(trimmed);
    return parsed ? parseReleaseVersion(parsed.ref) : undefined;
}
function hasExplicitUnresolvedVersionSelector(source) {
    const trimmed = source.trim();
    if (trimmed.startsWith("npm:")) {
        const identity = packageIdentity(trimmed);
        return identity !== undefined && identity !== trimmed;
    }
    return parseGitSource(trimmed)?.ref !== undefined;
}
function hasObviousNativeIntent(source) {
    const bounded = parseBoundedNpmSelector(source);
    if (bounded)
        return bounded.lower.major >= MCP_ADAPTER_NATIVE_MAJOR;
    const ref = parseGitSource(source.trim())?.ref;
    const match = ref?.match(/^tlh-v(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-\d+)?$/);
    if (match === undefined || match === null)
        return false;
    return Number(match[1]) >= MCP_ADAPTER_NATIVE_MAJOR;
}
function stableTlhTagVersion(source) {
    const ref = parseGitSource(source.trim())?.ref;
    const match = ref?.match(/^tlh-v(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-\d+)?$/);
    if (match === undefined || match === null)
        return undefined;
    return {
        major: Number(match[1]),
        minor: Number(match[2] || 0),
        patch: Number(match[3] || 0),
    };
}
function pathIsWithin(root, target) {
    const relativePath = relative(resolve(root), resolve(target));
    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
function packageNameFromIdentity(identity) {
    if (!identity.startsWith("npm:"))
        return undefined;
    const name = identity.slice("npm:".length).trim();
    if (!name || name.includes("\\") || name.includes("\0"))
        return undefined;
    if (name === "." || name === ".." || name.includes("/../") || name.startsWith("../")) {
        return undefined;
    }
    return name;
}
function metadataPath(source, { agentDir = "", homeDir = "" }) {
    const identity = packageIdentity(source);
    if (!identity || !agentDir)
        return undefined;
    const normalizedAgentDir = resolve(agentDir);
    const npmName = packageNameFromIdentity(identity);
    if (npmName) {
        const root = resolve(normalizedAgentDir, "npm");
        const path = resolve(root, "node_modules", npmName, "package.json");
        if (!pathIsWithin(root, path))
            return undefined;
        return { path, root, expectedName: npmName };
    }
    const gitSpec = criticalGitSourceSpec(source, { agentDir: normalizedAgentDir });
    if (gitSpec) {
        const root = resolve(normalizedAgentDir, "git");
        const path = resolve(gitSpec.targetDir, "package.json");
        if (!pathIsWithin(root, path))
            return undefined;
        return { path, root };
    }
    const localRoot = packageSourceInstallDir(source, {
        agentDir: normalizedAgentDir,
        homeDir,
    });
    if (!localRoot)
        return undefined;
    const root = resolve(normalizedAgentDir);
    const path = resolve(localRoot, "package.json");
    if (!pathIsWithin(root, path))
        return undefined;
    return { path, root };
}
function readInstalledMetadata(source, options) {
    const location = metadataPath(source, options);
    if (!location)
        return { kind: "missing" };
    let linkStatus;
    try {
        linkStatus = lstatSync(location.path);
    }
    catch (error) {
        return isErrno(error, "ENOENT") ? { kind: "missing" } : { kind: "invalid" };
    }
    if (linkStatus.isSymbolicLink() || !linkStatus.isFile())
        return { kind: "invalid" };
    try {
        const realProfile = realpathSync(options.agentDir);
        const realRoot = realpathSync(location.root);
        const realPath = realpathSync(location.path);
        if (!pathIsWithin(realProfile, realRoot) || !pathIsWithin(realRoot, realPath)) {
            return { kind: "invalid" };
        }
        const raw = JSON.parse(readFileSync(realPath, "utf8"));
        if (!isPlainObject(raw))
            return { kind: "invalid" };
        const identity = packageIdentity(source);
        const expectedName = location.expectedName;
        if (expectedName && raw.name !== expectedName)
            return { kind: "invalid" };
        if (identity?.startsWith("git:") && typeof raw.name !== "string") {
            return { kind: "invalid" };
        }
        const version = parseReleaseVersion(raw.version);
        return version ? { kind: "found", version } : { kind: "invalid" };
    }
    catch {
        return { kind: "invalid" };
    }
}
function versionsEqual(left, right) {
    return compareVersions(left, right) === 0;
}
function selectedPackages(settings) {
    if (!isPlainObject(settings))
        return undefined;
    if (settings.packages === undefined)
        return [];
    return Array.isArray(settings.packages) ? settings.packages : undefined;
}
function targetVersion(extension) {
    return exactSourceVersion(extension.source);
}
function selectedVersion(source, options) {
    const declared = exactSourceVersion(source);
    const metadata = readInstalledMetadata(source, options);
    if (declared) {
        const metadataConflict = metadata.kind === "found" &&
            metadata.version !== undefined &&
            !versionsEqual(declared, metadata.version);
        return {
            version: declared,
            versionSource: "declared",
            nativeIntent: false,
            metadata,
            metadataConflict,
        };
    }
    if (hasExplicitUnresolvedVersionSelector(source)) {
        return {
            metadata,
            nativeIntent: hasObviousNativeIntent(source),
            metadataConflict: false,
        };
    }
    if (metadata.kind === "found") {
        return {
            version: metadata.version,
            versionSource: "installed",
            nativeIntent: false,
            metadata,
            metadataConflict: false,
        };
    }
    return { metadata, nativeIntent: false, metadataConflict: false };
}
function isNative(version) {
    return version.major >= MCP_ADAPTER_NATIVE_MAJOR;
}
function hasNativeEvidence(selection) {
    if (selection.version !== undefined && isNative(selection.version))
        return true;
    if (selection.metadata.kind === "found" &&
        selection.metadata.version !== undefined &&
        isNative(selection.metadata.version)) {
        return true;
    }
    return selection.nativeIntent;
}
function isMcpAdapterExtension(extension) {
    return extension?.id === MCP_ADAPTER_CUTOVER_EXTENSION_ID;
}
/**
 * Classify the selected adapter without consulting MCP config files.  Only
 * identities in the default's source/replacement set are considered; package
 * names that merely contain "mcp" are deliberately ignored.
 */
export function evaluateMcpAdapterCutover(settings, extension, options = {}) {
    const emptySelection = [];
    if (!isMcpAdapterExtension(extension)) {
        return { action: "not-applicable", freeze: false, selected: emptySelection };
    }
    if (options.optedOut) {
        return {
            action: "opted-out",
            freeze: options.preserveOptOut === true,
            selected: emptySelection,
        };
    }
    const target = targetVersion(extension);
    if (!target) {
        return {
            action: "hold",
            freeze: true,
            reason: "target-version-unresolved",
            selected: emptySelection,
        };
    }
    const packages = selectedPackages(settings);
    if (packages === undefined) {
        return {
            action: "hold",
            freeze: true,
            reason: "selected-version-unresolved",
            selected: emptySelection,
            targetVersion: target,
        };
    }
    const identities = new Set(defaultExtensionPackageIdentities(extension));
    const selections = [];
    const agentDir = options.agentDir || "";
    const homeDir = options.homeDir || "";
    const metadataOptions = { agentDir, homeDir };
    for (const [index, entry] of packages.entries()) {
        const identity = packageIdentity(entry);
        if (!identity || !identities.has(identity))
            continue;
        const source = packageSourceOf(entry);
        if (!source) {
            return {
                action: "hold",
                freeze: true,
                reason: "selected-version-unresolved",
                selected: selections,
                targetVersion: target,
            };
        }
        const versionInfo = selectedVersion(source, metadataOptions);
        selections.push({
            identity,
            source,
            index,
            version: versionInfo.version,
            versionSource: versionInfo.versionSource,
            nativeIntent: versionInfo.nativeIntent,
            metadata: versionInfo.metadata,
            metadataConflict: versionInfo.metadataConflict,
        });
    }
    if (selections.length === 0) {
        return isNative(target)
            ? { action: "fresh", freeze: false, selected: selections, targetVersion: target }
            : { action: "not-applicable", freeze: false, selected: selections, targetVersion: target };
    }
    if (selections.some((selection) => selection.metadataConflict)) {
        return {
            action: "hold",
            freeze: true,
            reason: "installed-metadata-conflict",
            selected: selections,
            targetVersion: target,
        };
    }
    if (!isNative(target) &&
        selections.some((selection) => selection.version === undefined) &&
        selections.some(hasNativeEvidence)) {
        return {
            action: "hold",
            freeze: true,
            reason: "selected-version-unresolved",
            selected: selections,
            targetVersion: target,
        };
    }
    if (selections.some((selection) => selection.version === undefined)) {
        return isNative(target)
            ? {
                action: "hold",
                freeze: true,
                reason: "selected-version-unresolved",
                selected: selections,
                targetVersion: target,
            }
            : { action: "not-applicable", freeze: false, selected: selections, targetVersion: target };
    }
    const resolvedSelections = selections.filter((selection) => selection.version !== undefined);
    const versions = resolvedSelections.map((selection) => selection.version);
    const firstVersion = versions[0];
    if (!firstVersion) {
        return {
            action: "hold",
            freeze: true,
            reason: "selected-version-unresolved",
            selected: selections,
            targetVersion: target,
        };
    }
    const hasNativeSelection = versions.some((version) => isNative(version));
    if (!isNative(target)) {
        // An explicit pre-v5 manifest remains compatible with ordinary historical
        // migrations, but it must not downgrade a profile already on native v5+.
        if (!hasNativeSelection) {
            return {
                action: "not-applicable",
                freeze: false,
                selected: selections,
                targetVersion: target,
            };
        }
        if (versions.some((version) => !isNative(version)) ||
            versions.some((version) => !versionsEqual(version, firstVersion)) ||
            selections.length > 1) {
            return {
                action: "hold",
                freeze: true,
                reason: "selected-versions-conflict",
                selected: selections,
                targetVersion: target,
            };
        }
        return { action: "native", freeze: true, selected: selections, targetVersion: target };
    }
    if (versions.some((version) => !isNative(version))) {
        return {
            action: "hold",
            freeze: true,
            reason: "selected-pre-v5",
            selected: selections,
            targetVersion: target,
        };
    }
    if (versions.some((version) => !versionsEqual(version, firstVersion))) {
        return {
            action: "hold",
            freeze: true,
            reason: "selected-versions-conflict",
            selected: selections,
            targetVersion: target,
        };
    }
    // Multiple identities are conservatively held even when their metadata says
    // v5+: a duplicate canonical/replacement selection needs an explicit policy
    // decision before dedupe can discard one of the entries.
    if (selections.length > 1) {
        return {
            action: "hold",
            freeze: true,
            reason: "selected-versions-conflict",
            selected: selections,
            targetVersion: target,
        };
    }
    return {
        action: "native",
        // A newer native pin is never implicitly downgraded to the packaged target.
        freeze: compareVersions(firstVersion, target) > 0,
        selected: selections,
        targetVersion: target,
    };
}
export function mcpAdapterCutoverNotice(decision) {
    if (decision.action === "fresh") {
        return "MCP adapter: no selected mcporter; selecting v5 is a fresh component choice and does not assert project safety.";
    }
    if (decision.action !== "hold" || !decision.reason)
        return undefined;
    const reason = decision.reason === "selected-pre-v5"
        ? "selected adapter is pre-v5"
        : decision.reason === "selected-version-unresolved"
            ? "selected adapter version is unresolved"
            : decision.reason === "selected-versions-conflict"
                ? "selected adapter versions conflict"
                : decision.reason === "installed-metadata-conflict"
                    ? "installed adapter metadata conflicts"
                    : "target adapter version is unresolved";
    return `MCP adapter cutover held for mcporter: ${reason}.`;
}
function startupSelectionIsSafe(selection) {
    if (selection.metadata.kind === "invalid")
        return false;
    const declared = exactSourceVersion(selection.source);
    const stableTag = stableTlhTagVersion(selection.source);
    const knownVersion = declared || stableTag;
    // A native exact source is only safe when the cache cannot silently supply a
    // conflicting legacy package to the SDK's existing-path fast path. Exact
    // legacy pins remain safe because they intentionally roll back to legacy.
    if (selection.metadataConflict && knownVersion && isNative(knownVersion))
        return false;
    if (knownVersion)
        return true;
    const bounded = parseBoundedNpmSelector(selection.source);
    if (bounded) {
        return (selection.metadata.kind === "found" &&
            selection.metadata.version !== undefined &&
            versionSatisfiesBoundedNpmSelector(selection.metadata.version, bounded));
    }
    if (!hasExplicitUnresolvedVersionSelector(selection.source)) {
        return selection.metadata.kind === "found" && selection.metadata.version !== undefined;
    }
    // The SDK does not fetch an existing user/project git checkout during
    // resource resolution. A verified warm checkout is therefore safe at either
    // version; unknown npm selectors still stay held.
    if (parseGitSource(selection.source)?.ref !== undefined) {
        return selection.metadata.kind === "found" && selection.metadata.version !== undefined;
    }
    return false;
}
/**
 * Return a sanitized cold-start refusal when the selected adapter could cause
 * the upstream package manager to resolve an unsafe or unknown version.
 */
export function mcpAdapterStartupGuardNotice(decision) {
    if (decision.selected.some((selection) => !startupSelectionIsSafe(selection))) {
        return "MCP adapter launch held: the selected adapter version is not safely resolved for this profile or project; run `tlh update` or pin the adapter before retrying.";
    }
    return undefined;
}
class SettingsVerificationError extends Error {
    constructor(label, filePath) {
        super(`MCP adapter launch held: could not verify ${label} at ${filePath} (unreadable, broken link, not a regular file, or invalid settings JSON); repair that file before retrying.`);
    }
}
function readStartupJson(path, label) {
    let status;
    try {
        status = lstatSync(path);
    }
    catch (error) {
        if (isErrno(error, "ENOENT"))
            return {};
        throw new SettingsVerificationError(label, path);
    }
    try {
        if (status.isSymbolicLink())
            status = statSync(path);
        if (!status.isFile())
            throw new Error("not a regular file");
        const raw = JSON.parse(readFileSync(path, "utf8"));
        if (!isPlainObject(raw))
            throw new Error("expected an object");
        if (raw.packages !== undefined && !Array.isArray(raw.packages)) {
            throw new Error("packages must be an array");
        }
        return raw;
    }
    catch {
        throw new SettingsVerificationError(label, path);
    }
}
function startupGuardArguments(args) {
    const values = new Map();
    for (let index = 0; index < args.length; index += 1) {
        const flag = args[index];
        if (!flag?.startsWith("--"))
            throw new Error("invalid startup guard arguments");
        const value = args[index + 1];
        if (!value || value.startsWith("--"))
            throw new Error("invalid startup guard arguments");
        values.set(flag, value);
        index += 1;
    }
    const agentDir = values.get("--agent-dir");
    const defaultsPath = values.get("--defaults");
    const cwd = values.get("--cwd");
    if (!agentDir || !defaultsPath || !cwd)
        throw new Error("missing startup guard arguments");
    return { agentDir, defaultsPath, cwd };
}
function effectiveStartupDecisions(profileSettings, projectSettings, extension, agentDir, projectRoot, homeDir) {
    const identities = new Set(defaultExtensionPackageIdentities(extension));
    const profilePackages = selectedPackages(profileSettings) || [];
    const projectPackages = selectedPackages(projectSettings) || [];
    const profileByIdentity = new Map();
    for (const entry of profilePackages) {
        const identity = packageIdentity(entry);
        if (identity !== undefined && identities.has(identity) && !profileByIdentity.has(identity)) {
            profileByIdentity.set(identity, entry);
        }
    }
    const projectByIdentity = new Map();
    for (const entry of projectPackages) {
        const identity = packageIdentity(entry);
        if (identity !== undefined && identities.has(identity)) {
            projectByIdentity.set(identity, entry);
        }
    }
    const overriddenProfileIdentities = new Set();
    const effectiveProjectPackages = [];
    for (const [identity, entry] of projectByIdentity) {
        const isAutoloadDelta = isPlainObject(entry) && entry.autoload === false;
        if (isAutoloadDelta && profileByIdentity.has(identity))
            continue;
        effectiveProjectPackages.push(entry);
        if (!isAutoloadDelta)
            overriddenProfileIdentities.add(identity);
    }
    const effectiveProfilePackages = [];
    for (const [identity, entry] of profileByIdentity) {
        if (!overriddenProfileIdentities.has(identity))
            effectiveProfilePackages.push(entry);
    }
    const profileDecision = evaluateMcpAdapterCutover({ packages: effectiveProfilePackages }, extension, { agentDir, homeDir });
    const decisions = [profileDecision];
    if (effectiveProjectPackages.length > 0) {
        decisions.push(evaluateMcpAdapterCutover({ packages: effectiveProjectPackages }, extension, {
            agentDir: join(projectRoot, ".pi"),
            homeDir,
        }));
    }
    return decisions;
}
function runStartupGuard(args) {
    try {
        const { agentDir, defaultsPath, cwd } = startupGuardArguments(args);
        const extension = readDefaultExtensions(defaultsPath).find((entry) => entry.id === MCP_ADAPTER_CUTOVER_EXTENSION_ID);
        if (!extension)
            throw new Error("missing MCP adapter default");
        const profileSettingsPath = resolve(agentDir, "settings.json");
        const profileSettings = readStartupJson(profileSettingsPath, "profile settings");
        const projectRoot = resolve(cwd);
        const projectSettingsPath = join(projectRoot, ".pi", "settings.json");
        const projectSettings = readStartupJson(projectSettingsPath, "project settings");
        const decisions = effectiveStartupDecisions(profileSettings, projectSettings, extension, agentDir, projectRoot, process.env.HOME || "");
        const notice = decisions.map(mcpAdapterStartupGuardNotice).find((value) => value !== undefined);
        if (notice) {
            console.error(notice);
            return 1;
        }
        return 0;
    }
    catch (error) {
        if (error instanceof SettingsVerificationError) {
            console.error(error.message);
        }
        else {
            console.error("MCP adapter launch held: the selected adapter could not be verified safely; run `tlh update` or pin the adapter before retrying.");
        }
        return 1;
    }
}
function isMainModule() {
    if (!process.argv[1])
        return false;
    try {
        return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    }
    catch {
        return pathToFileURL(process.argv[1]).href === import.meta.url;
    }
}
if (isMainModule() && process.argv[2] === "--startup-guard") {
    process.exitCode = runStartupGuard(process.argv.slice(3));
}
export function mcpAdapterMigrationFrozen(extension, decision) {
    return extension?.id === MCP_ADAPTER_CUTOVER_EXTENSION_ID && decision?.freeze === true;
}
export function mcpAdapterPackageIdentities(extension) {
    if (!isMcpAdapterExtension(extension))
        return new Set();
    return new Set(defaultExtensionPackageIdentities(extension));
}
export function mcpAdapterManagedIdentityPreservation(extension, decision, previousManagedIdentities) {
    if (!mcpAdapterMigrationFrozen(extension, decision)) {
        return previousManagedIdentities;
    }
    const identities = mcpAdapterPackageIdentities(extension);
    const preserved = new Set(previousManagedIdentities);
    for (const identity of identities) {
        if (previousManagedIdentities.has(identity))
            preserved.add(identity);
        else
            preserved.delete(identity);
    }
    return preserved;
}
export function cloneMcpAdapterEntries(settings, extension) {
    if (!isPlainObject(settings) || !Array.isArray(settings.packages))
        return [];
    const identities = mcpAdapterPackageIdentities(extension);
    return settings.packages
        .filter((entry) => {
        const identity = packageIdentity(entry);
        return identity !== undefined && identities.has(identity);
    })
        .map((entry) => cloneJson(entry));
}
export function sameMcpAdapterEntries(settings, extension, expected) {
    return JSON.stringify(cloneMcpAdapterEntries(settings, extension)) === JSON.stringify(expected);
}

import { accessSync, chmodSync, closeSync, constants, fsyncSync, fstatSync, lstatSync, linkSync, mkdtempSync, openSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeSync, } from "node:fs";
import { homedir } from "node:os";
import process from "node:process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultExtensionPackageFilterDisables, defaultExtensionPackageIdentities, disabledDefaultExtensionIds, packageIdentity, packageSourceOf, readDefaultExtensions, readDefaultExtensionProvenance, } from "./default-extensions.mjs";
import { evaluateMcpAdapterCutover } from "./mcp-adapter-cutover.mjs";
import { backupPathWithTimestamp, defaultTlhSettingsPath } from "./tlh-install-utils.mjs";
import { writeProfileFileWithBackup, writeSafeProfileFile } from "./tlh-safe-profile-write.mjs";
const ACK_FLAG = "--acknowledge-unverified-mcp-configs";
const MCP_CONFIG_NAME = "mcp.json";
const MCP_ADAPTER_CONFIG_NAME = "mcp-adapter.json";
const MCP_ADAPTER_ID = "mcporter";
const BUILTIN_MCP_EXCLUSION = "-builtin:mcp";
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const READ_FLAGS = constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW;
const TOP_LEVEL_NATIVE_FIELDS = new Set([
    "enabled",
    "exposure",
    "toolExposure",
    "timeout",
    "auth",
    "oauth",
    "command",
    "url",
    "headers",
    "env",
    "mcpScript",
    "lifecycle",
    "trust",
    "projectTrust",
    "allow",
    "allowlist",
    "deny",
    "denylist",
    "credentials",
    "token",
    "tokens",
    "secrets",
    "transport",
    "protocol",
    "version",
    "config",
    "configFile",
    "configPath",
    "mcpConfig",
    "projectConfig",
    "workspace",
    "workspaceRoot",
]);
const SERVER_NATIVE_FIELDS = new Set([
    "enabled",
    "exposure",
    "toolExposure",
    "timeout",
    "disabled",
    "trust",
    "projectTrust",
    "requireApproval",
    "approval",
    "allow",
    "allowlist",
    "deny",
    "denylist",
    "mcpScript",
    "lifecycle",
    "transport",
    "protocol",
    "clientId",
    "clientSecret",
    "accessToken",
    "refreshToken",
    "authorization",
    "credentials",
    "token",
    "tokens",
    "secrets",
    "type",
    "config",
    "configFile",
    "configPath",
    "mcpConfig",
    "projectConfig",
]);
const IMPORT_FIELDS = new Set([
    "imports",
    "import",
    "$imports",
    "extends",
    "include",
    "shared",
    "claudePlugins",
    "mcp-servers",
]);
function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isErrno(error, code) {
    if (typeof error !== "object" || error === null || !("code" in error))
        return false;
    return error.code === code;
}
function sameIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
function sameSnapshotMetadata(left, right) {
    return (sameIdentity(left.identity, right.identity) &&
        left.size === right.size &&
        left.mtimeMs === right.mtimeMs &&
        left.mode === right.mode);
}
function bytesEqual(left, right) {
    return left.length === right.length && left.equals(right);
}
function normalizePath(value) {
    return resolve(value.replace(/^~(?=$|\/)/u, homedir()));
}
function currentUid() {
    return typeof process.getuid === "function" ? process.getuid() : undefined;
}
function hasSafeOwnership(stats) {
    const uid = currentUid();
    return uid !== undefined && stats.uid === uid && (stats.mode & 0o022) === 0;
}
function ensureDirectoryAncestry(path) {
    let current = resolve(path);
    while (true) {
        let status;
        try {
            status = lstatSync(current);
        }
        catch {
            return "unsafe-path";
        }
        if (status.isSymbolicLink() || !status.isDirectory())
            return "unsafe-path";
        const parent = dirname(current);
        if (parent === current)
            return undefined;
        current = parent;
    }
}
function ensureDirectory(path, allowMissing) {
    let status;
    try {
        status = lstatSync(path);
    }
    catch (error) {
        if (allowMissing && isErrno(error, "ENOENT"))
            return undefined;
        return "unsafe-path";
    }
    if (status.isSymbolicLink() || !status.isDirectory())
        return "unsafe-path";
    const ancestryReason = ensureDirectoryAncestry(path);
    if (ancestryReason)
        return ancestryReason;
    return hasSafeOwnership(status) ? undefined : "unsafe-access";
}
function readRegularSnapshot(path, optional) {
    let status;
    try {
        status = lstatSync(path);
    }
    catch (error) {
        if (optional && isErrno(error, "ENOENT"))
            return { kind: "missing" };
        return { kind: "unsafe", reason: "io-unknown" };
    }
    if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1) {
        return { kind: "unsafe", reason: status.nlink !== 1 ? "source-aliased" : "unsafe-path" };
    }
    if (!hasSafeOwnership(status) || (status.mode & 0o444) === 0) {
        return { kind: "unsafe", reason: "unsafe-access" };
    }
    const parentReason = ensureDirectory(dirname(path), false);
    if (parentReason)
        return { kind: "unsafe", reason: parentReason };
    try {
        const parentStatus = lstatSync(dirname(path));
        if ((parentStatus.mode & 0o111) === 0)
            throw new Error("unsafe-access");
        accessSync(path, constants.R_OK);
    }
    catch {
        return { kind: "unsafe", reason: "unsafe-access" };
    }
    let fd;
    try {
        fd = openSync(path, READ_FLAGS);
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.nlink !== 1) {
            return { kind: "unsafe", reason: opened.nlink !== 1 ? "source-aliased" : "unsafe-path" };
        }
        if (!hasSafeOwnership(opened) || (opened.mode & 0o444) === 0) {
            return { kind: "unsafe", reason: "unsafe-access" };
        }
        const bytes = readFileSync(fd);
        const closed = fstatSync(fd);
        if (!closed.isFile() ||
            !sameIdentity({ dev: status.dev, ino: status.ino }, { dev: closed.dev, ino: closed.ino }) ||
            closed.size !== bytes.length ||
            closed.mtimeMs !== opened.mtimeMs) {
            return { kind: "unsafe", reason: "race-detected" };
        }
        const after = lstatSync(path);
        if (after.isSymbolicLink() ||
            !after.isFile() ||
            after.nlink !== 1 ||
            !sameIdentity({ dev: after.dev, ino: after.ino }, { dev: closed.dev, ino: closed.ino }) ||
            after.size !== bytes.length ||
            after.mtimeMs !== closed.mtimeMs) {
            return { kind: "unsafe", reason: "race-detected" };
        }
        return {
            kind: "present",
            snapshot: {
                path: resolve(path),
                bytes,
                mode: after.mode & 0o777,
                identity: { dev: after.dev, ino: after.ino },
                size: after.size,
                mtimeMs: after.mtimeMs,
            },
        };
    }
    catch {
        return { kind: "unsafe", reason: "io-unknown" };
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
function revalidateSnapshot(snapshot) {
    const current = readRegularSnapshot(snapshot.path, false);
    return (current.kind === "present" &&
        sameSnapshotMetadata(current.snapshot, snapshot) &&
        bytesEqual(current.snapshot.bytes, snapshot.bytes));
}
function maskJsonComments(raw) {
    let output = "";
    let inString = false;
    let escaped = false;
    for (let index = 0; index < raw.length; index += 1) {
        const current = raw[index];
        const next = raw[index + 1];
        if (inString) {
            output += current;
            if (escaped) {
                escaped = false;
            }
            else if (current === "\\") {
                escaped = true;
            }
            else if (current === '"') {
                inString = false;
            }
            continue;
        }
        if (current === '"') {
            inString = true;
            output += current;
            continue;
        }
        if (current === "/" && next === "/") {
            output += "  ";
            index += 2;
            while (index < raw.length && raw[index] !== "\n" && raw[index] !== "\r") {
                output += " ";
                index += 1;
            }
            index -= 1;
            continue;
        }
        if (current === "/" && next === "*") {
            output += "  ";
            index += 2;
            let closed = false;
            while (index < raw.length) {
                const commentCurrent = raw[index];
                const commentNext = raw[index + 1];
                if (commentCurrent === "*" && commentNext === "/") {
                    output += "  ";
                    index += 2;
                    closed = true;
                    break;
                }
                output += commentCurrent === "\n" || commentCurrent === "\r" ? commentCurrent : " ";
                index += 1;
            }
            if (!closed)
                return undefined;
            index -= 1;
            continue;
        }
        output += current;
    }
    return inString ? undefined : output;
}
function hasDuplicateObjectKeys(raw) {
    const stack = [];
    let inString = false;
    let escaped = false;
    let stringStart = -1;
    for (let index = 0; index < raw.length; index += 1) {
        const current = raw[index];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (current === "\\")
                escaped = true;
            else if (current === '"') {
                inString = false;
                let lookahead = index + 1;
                while (lookahead < raw.length && /\s/u.test(raw[lookahead] || ""))
                    lookahead += 1;
                const parent = stack[stack.length - 1];
                if (raw[lookahead] === ":" && parent?.kind === "object" && stringStart >= 0) {
                    try {
                        const key = JSON.parse(raw.slice(stringStart, index + 1));
                        if (typeof key === "string") {
                            if (parent.keys.has(key))
                                return true;
                            parent.keys.add(key);
                        }
                    }
                    catch {
                        return false;
                    }
                }
            }
            continue;
        }
        if (current === '"') {
            inString = true;
            stringStart = index;
            continue;
        }
        if (current === "{" || current === "[") {
            stack.push({ kind: current === "{" ? "object" : "array", keys: new Set() });
        }
        else if (current === "}" || current === "]") {
            stack.pop();
        }
    }
    return false;
}
function removeTrailingCommas(raw) {
    let output = "";
    let inString = false;
    let escaped = false;
    for (let index = 0; index < raw.length; index += 1) {
        const current = raw[index];
        if (inString) {
            output += current;
            if (escaped)
                escaped = false;
            else if (current === "\\")
                escaped = true;
            else if (current === '"')
                inString = false;
            continue;
        }
        if (current === '"') {
            inString = true;
            output += current;
            continue;
        }
        if (current === ",") {
            let lookahead = index + 1;
            while (lookahead < raw.length && /\s/u.test(raw[lookahead] || ""))
                lookahead += 1;
            if (raw[lookahead] === "}" || raw[lookahead] === "]")
                continue;
        }
        output += current;
    }
    return output;
}
function parseJsoncObject(bytes) {
    if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
        return { kind: "unsafe", reason: "config-bom" };
    }
    const raw = bytes.toString("utf8");
    const withoutComments = maskJsonComments(raw);
    if (withoutComments === undefined)
        return { kind: "unsafe", reason: "config-malformed" };
    if (hasDuplicateObjectKeys(withoutComments))
        return { kind: "unsafe", reason: "config-malformed" };
    try {
        const parsed = JSON.parse(removeTrailingCommas(withoutComments));
        return isPlainObject(parsed)
            ? { kind: "ok", value: parsed }
            : { kind: "unsafe", reason: "config-nonobject" };
    }
    catch {
        return { kind: "unsafe", reason: "config-malformed" };
    }
}
function hasOwn(value, key) {
    return Object.hasOwn(value, key);
}
function validateConfigSemantics(value) {
    for (const key of Object.keys(value)) {
        if (IMPORT_FIELDS.has(key))
            return "config-imported";
        if (TOP_LEVEL_NATIVE_FIELDS.has(key)) {
            if (key === "auth" || key === "oauth")
                return "config-auth-object";
            return "config-policy";
        }
        if (key === "settings") {
            if (!isPlainObject(value[key]))
                return "config-policy";
            if (Object.keys(value[key]).length > 0)
                return "config-policy";
        }
    }
    const servers = value.mcpServers;
    if (servers === undefined)
        return undefined;
    if (!isPlainObject(servers))
        return "config-nonobject";
    for (const server of Object.values(servers)) {
        if (!isPlainObject(server))
            return "config-nonobject";
        if (hasOwn(server, "command") && hasOwn(server, "url"))
            return "config-command-and-url";
        for (const key of Object.keys(server)) {
            if (SERVER_NATIVE_FIELDS.has(key))
                return "config-native-field";
            if (key === "auth" || key === "oauth") {
                if (isPlainObject(server[key]))
                    return "config-auth-object";
                if (server[key] !== undefined && typeof server[key] !== "string") {
                    return "config-auth-object";
                }
            }
        }
        if (hasOwn(server, "command") && typeof server.command !== "string") {
            return "config-native-field";
        }
        if (hasOwn(server, "url") && typeof server.url !== "string") {
            return "config-native-field";
        }
        if (hasOwn(server, "args") && !Array.isArray(server.args))
            return "config-native-field";
        if (hasOwn(server, "env") && !isPlainObject(server.env))
            return "config-native-field";
        if (hasOwn(server, "headers") && !isPlainObject(server.headers)) {
            return "config-native-field";
        }
    }
    return undefined;
}
function looksLikeMcpAdapterSource(source) {
    const lower = source.toLowerCase();
    return lower.includes("mcp-adapter") || lower.includes("mcporter") || lower.includes("pi-mcp");
}
function settingsObjectFromSnapshot(snapshot) {
    if (snapshot.bytes.length >= 3 &&
        snapshot.bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
        return { kind: "unsafe", reason: "settings-invalid" };
    }
    try {
        const parsed = JSON.parse(snapshot.bytes.toString("utf8"));
        if (!isPlainObject(parsed))
            return { kind: "unsafe", reason: "settings-invalid" };
        if (parsed.packages !== undefined && !Array.isArray(parsed.packages)) {
            return { kind: "unsafe", reason: "settings-invalid" };
        }
        if (parsed.tlh !== undefined && !isPlainObject(parsed.tlh)) {
            return { kind: "unsafe", reason: "settings-invalid" };
        }
        if (parsed.extensions !== undefined && !Array.isArray(parsed.extensions)) {
            return { kind: "unsafe", reason: "settings-invalid" };
        }
        return { kind: "ok", value: parsed };
    }
    catch {
        return { kind: "unsafe", reason: "settings-invalid" };
    }
}
function cloneJson(value) {
    return structuredClone(value);
}
function selectionForSettings(settings, settingsPath, extension, homeDir) {
    if (settings === undefined || settingsPath === undefined) {
        return { kind: "manual", reason: "settings-missing" };
    }
    const disabled = disabledDefaultExtensionIds(settings, [extension]).has(MCP_ADAPTER_ID);
    if (disabled || defaultExtensionPackageFilterDisables(settings, extension)) {
        return { kind: "manual", reason: "adapter-disabled", settingsPath };
    }
    if (!Array.isArray(settings.packages)) {
        return { kind: "manual", reason: "settings-invalid", settingsPath };
    }
    const identities = new Set(defaultExtensionPackageIdentities(extension));
    let customMcp = false;
    for (const entry of settings.packages) {
        const source = packageSourceOf(entry);
        const identity = packageIdentity(entry);
        if (source && looksLikeMcpAdapterSource(source) && (!identity || !identities.has(identity))) {
            customMcp = true;
        }
    }
    const decision = evaluateMcpAdapterCutover(settings, extension, {
        agentDir: dirname(settingsPath),
        homeDir,
    });
    if (customMcp && decision.selected.length > 0) {
        return { kind: "manual", reason: "adapter-selection-ambiguous", settingsPath };
    }
    if (decision.selected.length === 0) {
        return {
            kind: "manual",
            reason: customMcp ? "unmanaged-adapter-selection" : "adapter-version-unknown",
            settingsPath,
        };
    }
    if (decision.selected.length !== 1) {
        return { kind: "manual", reason: "adapter-selection-ambiguous", settingsPath };
    }
    const match = decision.selected[0];
    if (!match)
        return { kind: "manual", reason: "adapter-selection-ambiguous", settingsPath };
    const entry = settings.packages[match.index];
    if (isPlainObject(entry) &&
        (entry.autoload === false ||
            (Array.isArray(entry.extensions) &&
                entry.extensions.some((value) => value === `-${MCP_ADAPTER_ID}`)))) {
        return { kind: "manual", reason: "adapter-disabled", settingsPath };
    }
    if (match.metadataConflict) {
        return { kind: "manual", reason: "installed-metadata-conflict", settingsPath };
    }
    if (!match.version || match.nativeIntent) {
        return { kind: "manual", reason: "adapter-version-unknown", settingsPath };
    }
    const canonicalIdentity = packageIdentity(extension.source);
    const provenance = readDefaultExtensionProvenance(settings);
    if (match.identity === canonicalIdentity &&
        !provenance.managedPackageIdentities.has(match.identity)) {
        return { kind: "manual", reason: "unmanaged-adapter-selection", settingsPath };
    }
    if (match.version.major < 3) {
        return {
            kind: "legacy",
            source: match.source,
            identity: match.identity,
            index: match.index,
            settingsPath,
        };
    }
    if (match.version.major >= 5) {
        return { kind: "manual", reason: "adapter-native", settingsPath };
    }
    return { kind: "manual", reason: "adapter-version-unsupported", settingsPath };
}
function readSettingsResult(path) {
    const result = readRegularSnapshot(path, true);
    if (result.kind === "missing")
        return result;
    if (result.kind === "unsafe")
        return result;
    const parsed = settingsObjectFromSnapshot(result.snapshot);
    if (parsed.kind === "unsafe")
        return parsed;
    return {
        kind: "present",
        snapshot: { path: resolve(path), snapshot: result.snapshot, value: parsed.value },
    };
}
function projectAncestors(projectDir) {
    const result = [];
    let current = resolve(projectDir);
    while (true) {
        result.push(current);
        const parent = dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    return result;
}
function inspectProjectDirectory(path) {
    return ensureDirectory(path, false);
}
function addBlocker(blockers, reason) {
    if (reason)
        blockers.add(reason);
}
function settingsHasAdapterSelection(settings, extension) {
    if (disabledDefaultExtensionIds(settings, [extension]).has(MCP_ADAPTER_ID))
        return true;
    if (defaultExtensionPackageFilterDisables(settings, extension))
        return true;
    if (!Array.isArray(settings.packages))
        return false;
    const identities = new Set(defaultExtensionPackageIdentities(extension));
    return settings.packages.some((entry) => {
        const source = packageSourceOf(entry);
        const identity = packageIdentity(entry);
        return Boolean((identity && identities.has(identity)) || (source && looksLikeMcpAdapterSource(source)));
    });
}
function settingsForProject(projectDir, profileSettings, extension, homeDir, settingsCache, blockers) {
    const profileSelection = profileSettings && settingsHasAdapterSelection(profileSettings.value, extension)
        ? selectionForSettings(profileSettings.value, profileSettings.path, extension, homeDir)
        : undefined;
    if (profileSelection?.kind === "manual")
        addBlocker(blockers, profileSelection.reason);
    const projectSettingsPath = join(projectDir, ".pi", "settings.json");
    if (!settingsCache.has(projectSettingsPath)) {
        const result = readSettingsResult(projectSettingsPath);
        if (result.kind === "unsafe") {
            addBlocker(blockers, result.reason);
            settingsCache.set(projectSettingsPath, undefined);
        }
        else if (result.kind === "present") {
            settingsCache.set(projectSettingsPath, result.snapshot);
        }
        else {
            settingsCache.set(projectSettingsPath, undefined);
        }
    }
    const projectSettings = settingsCache.get(projectSettingsPath);
    const projectSelection = projectSettings && settingsHasAdapterSelection(projectSettings.value, extension)
        ? selectionForSettings(projectSettings.value, projectSettings.path, extension, homeDir)
        : undefined;
    if (projectSelection?.kind === "manual")
        addBlocker(blockers, projectSelection.reason);
    if (profileSelection?.kind === "legacy" &&
        projectSelection?.kind === "legacy" &&
        profileSelection.identity !== projectSelection.identity) {
        addBlocker(blockers, "adapter-selection-ambiguous");
    }
    if (projectSelection)
        return projectSettings;
    return profileSettings;
}
function updateSettingsValue(settings, selection, extension) {
    if (selection.index === undefined || !Array.isArray(settings.packages))
        return undefined;
    const next = cloneJson(settings);
    if (!Array.isArray(next.packages))
        return undefined;
    const selected = next.packages[selection.index];
    if (typeof selected === "string") {
        next.packages[selection.index] = extension.source;
    }
    else if (isPlainObject(selected)) {
        next.packages[selection.index] = { ...selected, source: extension.source };
    }
    else {
        return undefined;
    }
    if (next.extensions !== undefined && !Array.isArray(next.extensions))
        return undefined;
    if (Array.isArray(next.extensions) && !next.extensions.includes(BUILTIN_MCP_EXCLUSION)) {
        next.extensions = [BUILTIN_MCP_EXCLUSION, ...next.extensions];
        const currentTlh = next.tlh;
        if (currentTlh === undefined)
            next.tlh = { builtinMcpExclusionManaged: true };
        else if (isPlainObject(currentTlh)) {
            next.tlh = { ...currentTlh, builtinMcpExclusionManaged: true };
        }
        else
            return undefined;
    }
    else if (next.extensions === undefined) {
        next.extensions = [BUILTIN_MCP_EXCLUSION];
        const currentTlh = next.tlh;
        if (currentTlh === undefined)
            next.tlh = { builtinMcpExclusionManaged: true };
        else if (isPlainObject(currentTlh)) {
            next.tlh = { ...currentTlh, builtinMcpExclusionManaged: true };
        }
        else
            return undefined;
    }
    const rawTlh = settings.tlh;
    const rawProvenance = isPlainObject(rawTlh) ? rawTlh.defaultExtensionProvenance : undefined;
    if (rawProvenance !== undefined &&
        (!isPlainObject(rawProvenance) || !Array.isArray(rawProvenance.managedPackageIdentities))) {
        return undefined;
    }
    const provenance = readDefaultExtensionProvenance(settings);
    const canonicalIdentity = packageIdentity(extension.source);
    const replacementMigration = canonicalIdentity !== undefined && selection.identity !== canonicalIdentity;
    if (provenance.exists || replacementMigration) {
        const oldIdentity = selection.identity;
        const values = provenance.exists
            ? [...provenance.managedPackageIdentities].filter((identity) => identity !== oldIdentity)
            : [];
        if (canonicalIdentity && !values.includes(canonicalIdentity))
            values.push(canonicalIdentity);
        const tlh = next.tlh;
        if (tlh === undefined)
            next.tlh = {};
        if (isPlainObject(next.tlh)) {
            next.tlh = {
                ...next.tlh,
                defaultExtensionProvenance: {
                    managedPackageIdentities: values.sort((a, b) => a.localeCompare(b)),
                },
            };
        }
        else
            return undefined;
    }
    return next;
}
function bytesForSettings(value) {
    return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function targetState(path, source, blockers) {
    const parentReason = ensureDirectory(dirname(path), false);
    if (parentReason) {
        addBlocker(blockers, "target-unsafe");
        return { action: "manual", reason: "target-unsafe" };
    }
    try {
        const parentStatus = lstatSync(dirname(path));
        if ((parentStatus.mode & 0o111) === 0)
            throw new Error("unsafe-access");
        accessSync(dirname(path), constants.R_OK | constants.X_OK);
    }
    catch {
        addBlocker(blockers, "unsafe-access");
        return { action: "manual", reason: "unsafe-access" };
    }
    const result = readRegularSnapshot(path, true);
    if (result.kind === "missing") {
        try {
            const parentStatus = lstatSync(dirname(path));
            if ((parentStatus.mode & 0o222) === 0 || (parentStatus.mode & 0o111) === 0) {
                throw new Error("unsafe-access");
            }
            accessSync(dirname(path), constants.R_OK | constants.W_OK | constants.X_OK);
        }
        catch {
            addBlocker(blockers, "unsafe-access");
            return { action: "manual", reason: "unsafe-access" };
        }
        return { action: "copy" };
    }
    if (result.kind === "unsafe") {
        addBlocker(blockers, result.reason);
        return { action: "manual", reason: "target-unsafe" };
    }
    if (bytesEqual(result.snapshot.bytes, source.bytes)) {
        return { action: "unchanged", target: result.snapshot };
    }
    addBlocker(blockers, "target-nonidentical");
    return { action: "manual", target: result.snapshot, reason: "target-nonidentical" };
}
function sourceIsNonempty(snapshot) {
    return snapshot.bytes.length > 0;
}
function inspectPair(scope, sourcePath, targetPath, settings, extension, homeDir, blockers) {
    const sourceResult = readRegularSnapshot(sourcePath, true);
    if (sourceResult.kind === "missing")
        return undefined;
    if (sourceResult.kind === "unsafe") {
        addBlocker(blockers, sourceResult.reason);
        return {
            scope,
            sourcePath: resolve(sourcePath),
            targetPath: resolve(targetPath),
            source: {
                path: resolve(sourcePath),
                bytes: Buffer.alloc(0),
                mode: 0,
                identity: { dev: 0, ino: 0 },
                size: 0,
                mtimeMs: 0,
            },
            settings,
            selection: { kind: "manual", reason: sourceResult.reason },
            action: "manual",
            reason: sourceResult.reason,
        };
    }
    const source = sourceResult.snapshot;
    if (!sourceIsNonempty(source))
        return undefined;
    const parsed = parseJsoncObject(source.bytes);
    if (parsed.kind === "unsafe")
        addBlocker(blockers, parsed.reason);
    const configReason = parsed.kind === "ok" ? validateConfigSemantics(parsed.value) : undefined;
    if (configReason)
        addBlocker(blockers, configReason);
    const selection = settings
        ? selectionForSettings(settings.value, settings.path, extension, homeDir)
        : { kind: "manual", reason: "settings-missing" };
    const target = targetState(targetPath, source, blockers);
    const nativeNoop = parsed.kind === "ok" &&
        !configReason &&
        selection.kind === "manual" &&
        selection.reason === "adapter-native" &&
        target.action === "unchanged";
    if (selection.kind !== "legacy" && !nativeNoop)
        addBlocker(blockers, selection.reason);
    if (parsed.kind !== "ok" ||
        configReason ||
        (selection.kind !== "legacy" && !nativeNoop) ||
        target.action === "manual") {
        const reason = parsed.kind === "unsafe" ? parsed.reason : configReason || selection.reason || target.reason;
        return {
            scope,
            sourcePath: source.path,
            targetPath: resolve(targetPath),
            source,
            target: target.target,
            settings,
            selection,
            action: "manual",
            reason,
        };
    }
    return {
        scope,
        sourcePath: source.path,
        targetPath: resolve(targetPath),
        source,
        target: target.target,
        settings,
        selection,
        action: target.action,
        reason: target.action === "unchanged" ? undefined : undefined,
    };
}
function existingNativeConfigReason(bytes) {
    const parsed = parseJsoncObject(bytes);
    if (parsed.kind === "unsafe")
        return parsed.reason;
    for (const key of Object.keys(parsed.value)) {
        if (IMPORT_FIELDS.has(key))
            return "config-imported";
    }
    return "native-config-unmatched";
}
function inspectUnmatchedNative(scope, legacyPath, targetPath, beforeReread) {
    beforeReread?.(scope, legacyPath);
    const legacyResult = readRegularSnapshot(legacyPath, true);
    // A changed legacy input is not an absent config; fail planning closed before native inspection.
    if (legacyResult.kind === "unsafe")
        throw new Error(legacyResult.reason);
    if (legacyResult.kind === "present" && sourceIsNonempty(legacyResult.snapshot)) {
        throw new Error("race-detected");
    }
    const targetResult = readRegularSnapshot(targetPath, true);
    if (targetResult.kind === "missing")
        return undefined;
    const reason = targetResult.kind === "unsafe"
        ? targetResult.reason
        : existingNativeConfigReason(targetResult.snapshot.bytes);
    const target = targetResult.kind === "present" ? targetResult.snapshot : undefined;
    const source = target
        ? { ...target, path: resolve(legacyPath) }
        : {
            path: resolve(legacyPath),
            bytes: Buffer.alloc(0),
            mode: 0,
            identity: { dev: 0, ino: 0 },
            size: 0,
            mtimeMs: 0,
        };
    return {
        scope,
        sourcePath: resolve(legacyPath),
        targetPath: resolve(targetPath),
        source,
        target,
        selection: { kind: "manual", reason },
        action: "manual",
        reason,
    };
}
function inspectDiscoveredAncestor(project, pairs) {
    const sourcePath = join(project, ".pi", MCP_CONFIG_NAME);
    const targetPath = join(project, ".pi", MCP_ADAPTER_CONFIG_NAME);
    const sourceResult = readRegularSnapshot(sourcePath, true);
    if (sourceResult.kind === "missing")
        return;
    const source = sourceResult.kind === "present"
        ? sourceResult.snapshot
        : {
            path: resolve(sourcePath),
            bytes: Buffer.alloc(0),
            mode: 0,
            identity: { dev: 0, ino: 0 },
            size: 0,
            mtimeMs: 0,
        };
    pairs.push({
        scope: "project",
        sourcePath: resolve(sourcePath),
        targetPath: resolve(targetPath),
        source,
        selection: { kind: "manual", reason: "ancestor-manual-only" },
        action: "manual",
        reason: "ancestor-manual-only",
    });
}
function uniqueSettingsChanges(pairs, extension, blockers) {
    const changes = [];
    const seen = new Set();
    for (const pair of pairs) {
        if (pair.action === "manual" || !pair.settings || pair.selection.kind !== "legacy")
            continue;
        if (seen.has(pair.settings.path))
            continue;
        seen.add(pair.settings.path);
        const afterValue = updateSettingsValue(pair.settings.value, pair.selection, extension);
        if (!afterValue) {
            addBlocker(blockers, "settings-invalid");
            continue;
        }
        const afterBytes = bytesForSettings(afterValue);
        if (!bytesEqual(afterBytes, pair.settings.snapshot.bytes)) {
            changes.push({ path: pair.settings.path, before: pair.settings, afterBytes, afterValue });
        }
    }
    return changes;
}
function reasonForOutput(reason) {
    return reason || "manual-review";
}
export function planMcpAdapterMigration(options = {}) {
    const settingsPath = normalizePath(options.settingsPath || defaultTlhSettingsPath());
    const agentDir = dirname(settingsPath);
    const homeDir = normalizePath(options.homeDir || process.env.HOME || homedir());
    const defaultExtensionsPath = normalizePath(options.defaultExtensionsPath ||
        join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "config", "default-extensions.json"));
    const extension = readDefaultExtensions(defaultExtensionsPath).find((entry) => entry.id === MCP_ADAPTER_ID);
    const blockers = new Set();
    if (!extension) {
        blockers.add("settings-invalid");
        return {
            settingsPath,
            agentDir,
            pairs: [],
            settingsChanges: [],
            blockers: [...blockers],
            missingAcknowledgement: options.apply === true && options.acknowledgeUnverifiedMcpConfigs !== true,
        };
    }
    const profileSettingsResult = readSettingsResult(settingsPath);
    let profileSettings;
    if (profileSettingsResult.kind === "present") {
        profileSettings = profileSettingsResult.snapshot;
    }
    else if (profileSettingsResult.kind === "unsafe") {
        addBlocker(blockers, profileSettingsResult.reason);
    }
    const pairs = [];
    const sourcePaths = new Set();
    const realSourcePaths = new Set();
    const unmatchedNativePairs = [];
    const settingsCache = new Map();
    const globalPair = inspectPair("global", join(agentDir, MCP_CONFIG_NAME), join(agentDir, MCP_ADAPTER_CONFIG_NAME), profileSettings, extension, homeDir, blockers);
    if (globalPair) {
        pairs.push(globalPair);
        sourcePaths.add(globalPair.sourcePath);
        if (globalPair.source.identity.ino !== 0)
            realSourcePaths.add(`${globalPair.source.identity.dev}:${globalPair.source.identity.ino}`);
    }
    else {
        const unmatchedNative = inspectUnmatchedNative("global", join(agentDir, MCP_CONFIG_NAME), join(agentDir, MCP_ADAPTER_CONFIG_NAME), options.hooks?.beforeUnmatchedNativeReread);
        if (unmatchedNative) {
            pairs.push(unmatchedNative);
            unmatchedNativePairs.push(unmatchedNative);
        }
    }
    const projectRoots = [];
    const explicitProjects = new Set();
    const requestedProjects = options.projectDirs || [];
    for (const requested of requestedProjects) {
        const project = normalizePath(requested);
        if (inspectProjectDirectory(project)) {
            addBlocker(blockers, "unsafe-path");
            continue;
        }
        explicitProjects.add(project);
        for (const ancestor of projectAncestors(project)) {
            if (!projectRoots.includes(ancestor))
                projectRoots.push(ancestor);
        }
    }
    for (const project of projectRoots) {
        if (!explicitProjects.has(project)) {
            inspectDiscoveredAncestor(project, pairs);
            continue;
        }
        const piDir = join(project, ".pi");
        const projectLegacyPath = join(piDir, MCP_CONFIG_NAME);
        const projectNativePath = join(piDir, MCP_ADAPTER_CONFIG_NAME);
        const piResult = readRegularSnapshot(projectLegacyPath, true);
        if (piResult.kind === "missing") {
            const piStatus = lstatSync(piDir, { throwIfNoEntry: false });
            if (piStatus && (piStatus.isSymbolicLink() || !piStatus.isDirectory()))
                addBlocker(blockers, "unsafe-path");
            const unmatchedNative = inspectUnmatchedNative("project", projectLegacyPath, projectNativePath, options.hooks?.beforeUnmatchedNativeReread);
            if (unmatchedNative) {
                pairs.push(unmatchedNative);
                unmatchedNativePairs.push(unmatchedNative);
            }
            continue;
        }
        const projectSettings = settingsForProject(project, profileSettings, extension, homeDir, settingsCache, blockers);
        const pair = inspectPair("project", projectLegacyPath, projectNativePath, projectSettings, extension, homeDir, blockers);
        if (!pair) {
            const unmatchedNative = inspectUnmatchedNative("project", projectLegacyPath, projectNativePath, options.hooks?.beforeUnmatchedNativeReread);
            if (unmatchedNative) {
                pairs.push(unmatchedNative);
                unmatchedNativePairs.push(unmatchedNative);
            }
            continue;
        }
        if (sourcePaths.has(pair.sourcePath))
            addBlocker(blockers, "source-aliased");
        sourcePaths.add(pair.sourcePath);
        if (pair.source.identity.ino !== 0) {
            const identity = `${pair.source.identity.dev}:${pair.source.identity.ino}`;
            if (realSourcePaths.has(identity))
                addBlocker(blockers, "source-aliased");
            realSourcePaths.add(identity);
        }
        pairs.push(pair);
    }
    for (const unmatchedNative of unmatchedNativePairs) {
        addBlocker(blockers, unmatchedNative.reason);
    }
    const settingsChanges = uniqueSettingsChanges(pairs, extension, blockers);
    const missingAcknowledgement = options.apply === true && options.acknowledgeUnverifiedMcpConfigs !== true;
    return {
        settingsPath,
        agentDir,
        pairs,
        settingsChanges,
        blockers: [...blockers],
        missingAcknowledgement,
    };
}
function writeAll(fd, bytes) {
    let offset = 0;
    while (offset < bytes.length)
        offset += writeSync(fd, bytes, offset, bytes.length - offset);
}
function fsyncDirectory(path) {
    let fd;
    try {
        fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW);
        fsyncSync(fd);
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
function removeOwnTemp(tempPath, identity) {
    const status = lstatSync(tempPath, { throwIfNoEntry: false });
    if (!status)
        return true;
    if (status.isSymbolicLink() || !status.isFile())
        return false;
    if (!sameIdentity({ dev: status.dev, ino: status.ino }, identity))
        return false;
    unlinkSync(tempPath);
    return true;
}
function createExclusiveCopy(pair, hooks, index) {
    if (!revalidateSnapshot(pair.source))
        throw new Error("race-detected");
    const parent = dirname(pair.targetPath);
    const parentReason = ensureDirectory(parent, false);
    if (parentReason)
        throw new Error(parentReason);
    try {
        accessSync(parent, constants.W_OK | constants.X_OK);
    }
    catch {
        throw new Error("unsafe-access");
    }
    const tempDir = mkdtempSync(join(parent, `.${basename(pair.targetPath)}.tlh-mcp-`));
    chmodSync(tempDir, 0o700);
    const tempPath = join(tempDir, basename(pair.targetPath));
    let tempFd;
    let tempIdentity;
    let targetLinked = false;
    let tempRemoved = false;
    try {
        tempFd = openSync(tempPath, WRITE_FLAGS, 0o600);
        writeAll(tempFd, pair.source.bytes);
        fsyncSync(tempFd);
        chmodSync(tempPath, pair.source.mode);
        fsyncSync(tempFd);
        const tempStats = fstatSync(tempFd);
        tempIdentity = { dev: tempStats.dev, ino: tempStats.ino };
        closeSync(tempFd);
        tempFd = undefined;
        if (!revalidateSnapshot(pair.source))
            throw new Error("race-detected");
        const existing = lstatSync(pair.targetPath, { throwIfNoEntry: false });
        if (existing)
            throw new Error("target-nonidentical");
        linkSync(tempPath, pair.targetPath);
        targetLinked = true;
        hooks?.afterTargetLink?.(pair.sourcePath, pair.targetPath, index);
        fsyncDirectory(parent);
        const created = lstatSync(pair.targetPath);
        if (created.isSymbolicLink() ||
            !created.isFile() ||
            !sameIdentity({ dev: created.dev, ino: created.ino }, tempIdentity)) {
            throw new Error("race-detected");
        }
        unlinkSync(tempPath);
        tempRemoved = true;
        fsyncDirectory(parent);
        return {
            path: pair.targetPath,
            bytes: pair.source.bytes,
            identity: { dev: created.dev, ino: created.ino },
        };
    }
    catch (error) {
        if (targetLinked && tempIdentity && !tempRemoved) {
            try {
                tempRemoved = removeOwnTemp(tempPath, tempIdentity);
            }
            catch {
                // A changed or inaccessible temporary link is retained conservatively.
            }
        }
        if (targetLinked && tempIdentity && tempRemoved) {
            try {
                removeOwnTarget({
                    path: pair.targetPath,
                    bytes: pair.source.bytes,
                    identity: tempIdentity,
                });
            }
            catch {
                // The identity/bytes guard retains a concurrent user edit.
            }
        }
        throw error;
    }
    finally {
        if (tempFd !== undefined)
            closeSync(tempFd);
        if (!tempRemoved && tempIdentity) {
            try {
                tempRemoved = removeOwnTemp(tempPath, tempIdentity);
            }
            catch {
                // A changed or inaccessible temporary link is retained conservatively.
            }
        }
        const tempDirectory = lstatSync(tempDir, { throwIfNoEntry: false });
        if (tempDirectory && tempDirectory.isDirectory() && !tempDirectory.isSymbolicLink()) {
            try {
                if (readdirSync(tempDir).length === 0)
                    rmdirSync(tempDir);
            }
            catch {
                // A changed temp ancestry is never removed by cleanup.
            }
        }
    }
}
function removeOwnTarget(target) {
    const status = lstatSync(target.path, { throwIfNoEntry: false });
    if (!status)
        return true;
    if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1)
        return false;
    if (!sameIdentity({ dev: status.dev, ino: status.ino }, target.identity))
        return false;
    let bytes;
    try {
        bytes = readFileSync(target.path);
    }
    catch {
        return false;
    }
    if (!bytesEqual(bytes, target.bytes))
        return false;
    unlinkSync(target.path);
    fsyncDirectory(dirname(target.path));
    return true;
}
function restoreOwnSettings(change) {
    const current = readRegularSnapshot(change.path, false);
    if (current.kind !== "present" ||
        !change.committedIdentity ||
        !sameIdentity(current.snapshot.identity, change.committedIdentity) ||
        !bytesEqual(current.snapshot.bytes, change.afterBytes)) {
        return false;
    }
    try {
        writeSafeProfileFile({ agentDir: dirname(change.path) }, basename(change.path), change.before.snapshot.bytes, "MCP migration settings rollback", { mode: change.before.snapshot.mode });
    }
    catch {
        return false;
    }
    const restored = readRegularSnapshot(change.path, false);
    return (restored.kind === "present" && bytesEqual(restored.snapshot.bytes, change.before.snapshot.bytes));
}
function committedFileIdentity(path) {
    const status = lstatSync(path);
    if (status.isSymbolicLink() || !status.isFile())
        throw new Error("race-detected");
    return { dev: status.dev, ino: status.ino };
}
function revalidateCreatedTarget(target) {
    const current = readRegularSnapshot(target.path, false);
    return (current.kind === "present" &&
        sameIdentity(current.snapshot.identity, target.identity) &&
        bytesEqual(current.snapshot.bytes, target.bytes));
}
function revalidateCommittedSettings(change) {
    if (!change.committedIdentity)
        return false;
    const current = readRegularSnapshot(change.path, false);
    return (current.kind === "present" &&
        sameIdentity(current.snapshot.identity, change.committedIdentity) &&
        bytesEqual(current.snapshot.bytes, change.afterBytes));
}
function revalidateTransactionInputs(plan, created, committedSettings, requireCreatedTargets = false) {
    const createdByPath = new Map(created.map((target) => [target.path, target]));
    const committedByPath = new Map(committedSettings.map((change) => [change.path, change]));
    for (const pair of plan.pairs) {
        if (pair.action === "manual")
            continue;
        if (!revalidateSnapshot(pair.source))
            throw new Error("race-detected");
        if (pair.action === "unchanged") {
            if (!pair.target || !revalidateSnapshot(pair.target))
                throw new Error("race-detected");
        }
        else {
            const target = createdByPath.get(pair.targetPath);
            if (target && !revalidateCreatedTarget(target))
                throw new Error("race-detected");
            if (requireCreatedTargets && !target)
                throw new Error("race-detected");
        }
    }
    for (const change of plan.settingsChanges) {
        const committed = committedByPath.get(change.path);
        if (committed) {
            if (!revalidateCommittedSettings(committed))
                throw new Error("race-detected");
        }
        else if (!revalidateSnapshot(change.before.snapshot)) {
            throw new Error("race-detected");
        }
    }
}
class MigrationExecutionError extends Error {
    retainedCopies;
    backupPaths;
    rollbackVerified;
    constructor(retainedCopies, backupPaths, rollbackVerified) {
        super("MCP migration transaction failed");
        this.retainedCopies = retainedCopies;
        this.backupPaths = backupPaths;
        this.rollbackVerified = rollbackVerified;
    }
}
function existingBackupPaths(changes) {
    const paths = [];
    for (const change of changes) {
        if (!change.backupPath || paths.includes(change.backupPath))
            continue;
        try {
            if (lstatSync(change.backupPath, { throwIfNoEntry: false }))
                paths.push(change.backupPath);
        }
        catch {
            // An unavailable backup path is not reported as an existing artifact.
        }
    }
    return paths;
}
function executePlan(plan, hooks) {
    if (plan.blockers.length > 0)
        throw new Error(plan.blockers[0] || "manual-review");
    const created = [];
    const committedSettings = [];
    const uncertainSettings = new Set();
    try {
        revalidateTransactionInputs(plan, created, committedSettings);
        for (const [index, pair] of plan.pairs.entries()) {
            hooks?.beforeCopy?.(pair.sourcePath, pair.targetPath, index);
            if (pair.action === "copy") {
                const target = createExclusiveCopy(pair, hooks, index);
                created.push(target);
                hooks?.afterCopy?.(pair.sourcePath, pair.targetPath, index);
            }
            else if (pair.action === "unchanged" && pair.target && !revalidateSnapshot(pair.target)) {
                throw new Error("race-detected");
            }
        }
        for (const change of plan.settingsChanges) {
            hooks?.beforeSettings?.(change.path);
            revalidateTransactionInputs(plan, created, committedSettings, true);
            const backupPath = backupPathWithTimestamp(change.path, { marker: "tlh-defaults" });
            change.backupPath = backupPath;
            try {
                writeProfileFileWithBackup(change.path, change.afterBytes, {
                    targetLabel: "MCP migration settings",
                    sourceLabel: "MCP migration settings",
                    backupLabel: "MCP migration settings backup",
                    backupPath,
                });
            }
            catch {
                uncertainSettings.add(change.path);
                const observed = readRegularSnapshot(change.path, false);
                if (observed.kind === "present" && bytesEqual(observed.snapshot.bytes, change.afterBytes)) {
                    change.committedIdentity = observed.snapshot.identity;
                    committedSettings.push(change);
                }
                throw new Error("race-detected");
            }
            committedSettings.push(change);
            change.committedIdentity = committedFileIdentity(change.path);
            hooks?.afterSettings?.(change.path);
            const current = readRegularSnapshot(change.path, false);
            if (current.kind !== "present" ||
                !change.committedIdentity ||
                !sameIdentity(current.snapshot.identity, change.committedIdentity) ||
                !bytesEqual(current.snapshot.bytes, change.afterBytes)) {
                throw new Error("race-detected");
            }
        }
        return {
            copied: created.length,
            unchanged: plan.pairs.filter((pair) => pair.action === "unchanged").length,
        };
    }
    catch {
        let rollbackVerified = uncertainSettings.size === 0;
        for (let index = committedSettings.length - 1; index >= 0; index -= 1) {
            const change = committedSettings[index];
            if (change && !restoreOwnSettings(change))
                rollbackVerified = false;
        }
        const retainedCopies = [];
        if (rollbackVerified) {
            for (let index = created.length - 1; index >= 0; index -= 1) {
                const target = created[index];
                if (target) {
                    try {
                        if (!removeOwnTarget(target))
                            retainedCopies.push(target.path);
                    }
                    catch {
                        retainedCopies.push(target.path);
                    }
                }
            }
        }
        else {
            retainedCopies.push(...created.map((target) => target.path));
        }
        throw new MigrationExecutionError(retainedCopies, existingBackupPaths(plan.settingsChanges), rollbackVerified && retainedCopies.length === 0);
    }
}
function formatPlan(plan, mode, result) {
    const lines = [
        `MCP migration ${mode}: ${plan.pairs.length} selected configuration file(s).`,
        mode === "preview"
            ? "Preview only: no writes will be made."
            : "Apply committed writes transactionally.",
    ];
    for (const pair of plan.pairs) {
        if (pair.action === "copy")
            lines.push(`  COPY ${pair.sourcePath} -> ${pair.targetPath}`);
        else if (pair.action === "unchanged")
            lines.push(`  UNCHANGED ${pair.targetPath}`);
        else {
            lines.push(`  MANUAL ${pair.sourcePath} (${reasonForOutput(pair.reason)})`);
        }
    }
    if (plan.settingsChanges.length > 0) {
        lines.push(`Settings updates: ${plan.settingsChanges.length} owned adapter pin(s).`);
        for (const change of plan.settingsChanges)
            lines.push(`  SETTINGS ${change.path}`);
    }
    else {
        lines.push("Settings updates: 0.");
    }
    if (plan.blockers.length > 0) {
        lines.push(`Refused reasons: ${plan.blockers.join(", ")}.`);
        lines.push(`Manual migration is required; keep original files unchanged and review ${MCP_ADAPTER_CONFIG_NAME} separately.`);
    }
    lines.push("Safety limits: selected files only; unvisited/ancestor/explicit-config files, exclusive-mode settings, project trust/headless restrictions, mcpScript/lifecycle/auth changes, credential-store differences, and leftover native notices require separate manual review; this is not a universal equivalence guarantee.");
    if (mode === "preview") {
        lines.push(`Apply requires both --apply and ${ACK_FLAG}; --force/--yes do not replace acknowledgement.`);
    }
    else if (result) {
        lines.push(`Applied copies: ${result.copied}; unchanged targets: ${result.unchanged}.`);
    }
    return lines.join("\n");
}
export function runMcpAdapterMigration(options = {}) {
    if (options.apply === true && options.preview === true) {
        return {
            applied: false,
            exitCode: 1,
            copied: 0,
            unchanged: 0,
            manual: 0,
            blockers: ["conflicting-options"],
            output: "Refusing MCP migration: --apply cannot be combined with --preview or --dry-run.",
        };
    }
    const apply = options.apply === true;
    const acknowledgement = options.acknowledgeUnverifiedMcpConfigs === true;
    if (apply && !acknowledgement) {
        const output = `Refusing MCP migration apply: both --apply and ${ACK_FLAG} are required.`;
        return {
            applied: false,
            exitCode: 1,
            copied: 0,
            unchanged: 0,
            manual: 0,
            blockers: ["acknowledgement-required"],
            output,
        };
    }
    let plan;
    try {
        plan = planMcpAdapterMigration(options);
    }
    catch {
        const output = "MCP migration could not be safely planned; no files were changed.";
        return {
            applied: false,
            exitCode: 1,
            copied: 0,
            unchanged: 0,
            manual: 0,
            blockers: ["io-unknown"],
            output,
        };
    }
    const manual = plan.pairs.filter((pair) => pair.action === "manual").length;
    if (!apply || plan.missingAcknowledgement || plan.blockers.length > 0) {
        return {
            applied: false,
            exitCode: apply && plan.blockers.length > 0 ? 1 : 0,
            copied: 0,
            unchanged: plan.pairs.filter((pair) => pair.action === "unchanged").length,
            manual,
            blockers: plan.blockers,
            output: formatPlan(plan, "preview"),
        };
    }
    try {
        const committed = executePlan(plan, options.hooks);
        return {
            applied: true,
            exitCode: 0,
            copied: committed.copied,
            unchanged: committed.unchanged,
            manual,
            blockers: [],
            output: formatPlan(plan, "apply", committed),
        };
    }
    catch (error) {
        const details = error instanceof MigrationExecutionError ? error : new MigrationExecutionError([], [], false);
        const lines = [
            details.rollbackVerified
                ? "MCP migration aborted safely; owned writes were rolled back and no required copies remain."
                : "MCP migration aborted safely; rollback could not be fully verified.",
        ];
        if (details.retainedCopies.length > 0) {
            lines.push(`Required adapter copies were retained (${details.retainedCopies.length}); inspect the residual state before retrying.`);
        }
        if (details.backupPaths.length > 0) {
            lines.push(`Settings backups retained: ${details.backupPaths.join(", ")}.`);
        }
        return {
            applied: false,
            exitCode: 1,
            copied: 0,
            unchanged: 0,
            manual,
            blockers: ["race-detected"],
            output: lines.join("\n"),
        };
    }
}
export function parseMcpMigrationArgs(args) {
    const projectDirs = [];
    let apply = false;
    let acknowledge = false;
    let force = false;
    let yes = false;
    let preview = false;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--apply") {
            apply = true;
            continue;
        }
        if (arg === ACK_FLAG) {
            acknowledge = true;
            continue;
        }
        if (arg === "--force") {
            force = true;
            continue;
        }
        if (arg === "--yes") {
            yes = true;
            continue;
        }
        if (arg === "--preview" || arg === "--dry-run") {
            preview = true;
            continue;
        }
        if (arg === "--project") {
            const project = args[index + 1];
            if (!project || project.startsWith("-"))
                throw new Error("migrate-mcp --project requires a directory");
            projectDirs.push(project);
            index += 1;
            continue;
        }
        throw new Error("Unknown migrate-mcp option.");
    }
    return {
        projectDirs,
        apply,
        acknowledgeUnverifiedMcpConfigs: acknowledge,
        force,
        yes,
        preview,
    };
}

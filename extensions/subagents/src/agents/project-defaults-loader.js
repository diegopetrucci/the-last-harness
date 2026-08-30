import * as fs from "node:fs";
import * as path from "node:path";
import { resolveValidatedGitWorktreeRoot, } from "../../../shared/project-agent-worktree.js";
import { getPiAgentDir } from "../shared/profile.js";
export const PROJECT_DEFAULTS_FILE = path.join(".tlh", "defaults.json");
const PROJECT_DEFAULTS_WARNING_FILE = ".tlh/defaults.json";
export const MAX_PROJECT_DEFAULTS_FILE_BYTES = 64 * 1024;
export const MAX_PROJECT_DEFAULT_WARNINGS = 20;
export const MAX_PROJECT_DEFAULT_WARNING_LENGTH = 512;
const PROJECT_CONFIG_TRUST_UI_TIMEOUT_MS = 10_000;
const PROJECT_CONFIG_TRUST_SESSION_CACHE_LIMIT = 128;
const PROJECT_CONFIG_SESSION_TRUST_DECISIONS = new Map();
const VALID_PRIMARY_AGENTS = new Set([
    "architect",
    "rush",
    "product",
    "bug-hunter",
]);
const VALID_SUBAGENT_ROLES = new Set([
    "code-reviewer",
    "contrarian",
    "developer",
    "diff-summarizer",
    "librarian",
    "oracle",
    "repo-scout",
    "web-scout",
]);
const VALID_EFFORT_LEVELS = new Set([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
]);
const VALID_ENTRY_KEYS = new Set(["model", "effort"]);
const DEFAULT_FILE_SYSTEM = {
    lstatSync: (filePath) => fs.lstatSync(filePath),
    realpathSync: (filePath) => fs.realpathSync(filePath),
    readFileSync: (filePath) => fs.readFileSync(filePath),
    openSync: (filePath, flags) => fs.openSync(filePath, flags),
    fstatSync: (fd) => fs.fstatSync(fd),
    readSync: (fd, buffer, offset, length, position) => fs.readSync(fd, buffer, offset, length, position),
    closeSync: (fd) => fs.closeSync(fd),
    noFollowFlag: fs.constants.O_NOFOLLOW,
};
function isErrno(error, code) {
    return (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === code);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function truncateWarning(message) {
    if (message.length <= MAX_PROJECT_DEFAULT_WARNING_LENGTH)
        return message;
    return `${message.slice(0, MAX_PROJECT_DEFAULT_WARNING_LENGTH - 1)}…`;
}
function formatWarningSummary(omittedCount) {
    return truncateWarning(`…and ${omittedCount} more issues in ${PROJECT_DEFAULTS_WARNING_FILE}`);
}
class ProjectDefaultsWarningCollector {
    retained = [];
    omittedCount = 0;
    add(message) {
        const warning = truncateWarning(message);
        if (warning.length === 0 || this.retained.includes(warning))
            return;
        if (this.retained.length < MAX_PROJECT_DEFAULT_WARNINGS) {
            this.retained.push(warning);
            return;
        }
        this.omittedCount += 1;
    }
    toArray() {
        return this.omittedCount === 0
            ? [...this.retained]
            : [...this.retained, formatWarningSummary(this.omittedCount)];
    }
}
function boundedWarnings(...messages) {
    const collector = new ProjectDefaultsWarningCollector();
    for (const message of messages)
        collector.add(message);
    return collector.toArray();
}
function isPathWithin(parentPath, childPath) {
    const rel = path.relative(parentPath, childPath);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
function isValidModelReference(value) {
    if (typeof value !== "string")
        return false;
    const slash = value.indexOf("/");
    return slash > 0 && slash < value.length - 1;
}
function statSignature(stat) {
    return [
        String(stat.dev),
        String(stat.ino),
        String(stat.mode),
        String(stat.size),
        String(stat.mtimeMs),
        String(stat.ctimeMs),
    ].join(":");
}
function fileIdentity(stat) {
    if (!Number.isSafeInteger(stat.dev) ||
        !Number.isSafeInteger(stat.ino) ||
        stat.dev <= 0 ||
        stat.ino <= 0) {
        return undefined;
    }
    return { dev: stat.dev, ino: stat.ino };
}
function sameFileIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
function isUsableConfigTrustStore(value) {
    try {
        return (Boolean(value) &&
            typeof value === "object" &&
            typeof value.getEntry === "function");
    }
    catch {
        return false;
    }
}
function configTrustResult(trusted, source) {
    return { kind: "project-config", trusted, source };
}
function trustEntryPathApplies(entryPath, projectRoot) {
    if (typeof entryPath !== "string" || entryPath.trim().length === 0)
        return false;
    try {
        const canonicalEntryPath = fs.realpathSync(entryPath);
        const canonicalProjectRoot = fs.realpathSync(projectRoot);
        return isPathWithin(canonicalEntryPath, canonicalProjectRoot);
    }
    catch {
        return false;
    }
}
function defaultConfigTrustStore(options) {
    if (options.trustStore) {
        if (!isUsableConfigTrustStore(options.trustStore)) {
            throw new Error("Project configuration trust-store dependency returned an invalid store.");
        }
        return options.trustStore;
    }
    const agentDir = options.agentDir ?? getPiAgentDir();
    if (!fs.existsSync(path.join(agentDir, "trust.json")))
        return undefined;
    if (typeof options.createProjectTrustStore !== "function") {
        throw new Error("Project configuration trust-store dependency is unavailable.");
    }
    const store = options.createProjectTrustStore(agentDir);
    if (!isUsableConfigTrustStore(store)) {
        throw new Error("Project configuration trust-store dependency returned an invalid store.");
    }
    return store;
}
function resolveConfigTrustUiTimeoutMs(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : PROJECT_CONFIG_TRUST_UI_TIMEOUT_MS;
}
function waitForConfigTrustDecision(decision, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            resolve(undefined);
        }, timeoutMs);
        Promise.resolve(decision)
            .then((value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        })
            .catch(() => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(undefined);
        });
    });
}
export async function resolveProjectConfigTrust(projectRoot, options = {}) {
    if (options.trustOverride === false) {
        return configTrustResult(false, "explicit-negative");
    }
    try {
        const store = defaultConfigTrustStore(options);
        if (store) {
            const entry = store.getEntry(projectRoot);
            if (entry !== null && typeof entry !== "object") {
                return configTrustResult(false, "trust-store-error");
            }
            if (entry && (typeof entry.path !== "string" || typeof entry.decision !== "boolean")) {
                return configTrustResult(false, "trust-store-error");
            }
            if (entry && trustEntryPathApplies(entry.path, projectRoot)) {
                return configTrustResult(entry.decision, entry.decision ? "saved-positive" : "saved-negative");
            }
        }
    }
    catch {
        return configTrustResult(false, "trust-store-error");
    }
    let hasTrustResources = false;
    try {
        hasTrustResources = options.hasTrustRequiringProjectResources?.(projectRoot) === true;
    }
    catch {
    }
    let upstreamDecision;
    try {
        upstreamDecision = options.isProjectTrusted?.();
    }
    catch {
        upstreamDecision = undefined;
    }
    if (upstreamDecision === false) {
        return configTrustResult(false, "explicit-negative");
    }
    if (hasTrustResources && upstreamDecision === true) {
        return configTrustResult(true, "upstream-positive");
    }
    const sessionId = typeof options.sessionId === "string" && options.sessionId.trim().length > 0
        ? options.sessionId.trim()
        : undefined;
    const sessionKey = sessionId
        ? `project-config\u0000${sessionId}\u0000${path.resolve(projectRoot)}`
        : undefined;
    const cachedDecision = sessionKey
        ? PROJECT_CONFIG_SESSION_TRUST_DECISIONS.get(sessionKey)
        : undefined;
    if (cachedDecision !== undefined) {
        return configTrustResult(cachedDecision, cachedDecision ? "session-positive" : "session-negative");
    }
    switch (options.defaultProjectTrust ?? "ask") {
        case "always":
            return configTrustResult(true, "default-always");
        case "never":
            return configTrustResult(false, "default-never");
        case "ask":
            break;
    }
    if (options.hasUI === false || (!options.confirm && !options.ui)) {
        return configTrustResult(false, "session-unavailable");
    }
    try {
        const timeoutMs = resolveConfigTrustUiTimeoutMs(options.trustUiTimeoutMs);
        const decision = await waitForConfigTrustDecision(options.confirm
            ? options.confirm(projectRoot)
            : options.ui
                ? options.ui.confirm("Trust project-local TLH defaults?", `This allows repository-owned model/effort defaults in ${path.join(projectRoot, PROJECT_DEFAULTS_FILE)} to be applied for this session only. Project custom agents require persisted /trust authorization.`, { timeout: timeoutMs })
                : undefined, timeoutMs);
        if (decision === true || decision === false) {
            if (sessionKey) {
                PROJECT_CONFIG_SESSION_TRUST_DECISIONS.set(sessionKey, decision);
                if (PROJECT_CONFIG_SESSION_TRUST_DECISIONS.size > PROJECT_CONFIG_TRUST_SESSION_CACHE_LIMIT) {
                    const oldestKey = PROJECT_CONFIG_SESSION_TRUST_DECISIONS.keys().next().value;
                    if (oldestKey)
                        PROJECT_CONFIG_SESSION_TRUST_DECISIONS.delete(oldestKey);
                }
            }
            return configTrustResult(decision, decision ? "session-positive" : "session-negative");
        }
    }
    catch {
        return configTrustResult(false, "session-unavailable");
    }
    return configTrustResult(false, "session-unavailable");
}
function normalizeMaxFileBytes(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
        ? value
        : MAX_PROJECT_DEFAULTS_FILE_BYTES;
}
function preflightDefaultsFile(projectRoot, fileSystem, maxFileBytes) {
    const tlhPath = path.join(projectRoot, ".tlh");
    const filePath = path.join(projectRoot, PROJECT_DEFAULTS_FILE);
    let tlhStat;
    try {
        tlhStat = fileSystem.lstatSync(tlhPath);
    }
    catch (error) {
        if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
            return { kind: "absent" };
        }
        return {
            kind: "unsafe",
            reason: `Cannot inspect .tlh directory: ${errorMessage(error)}`,
        };
    }
    if (tlhStat.isSymbolicLink() || !tlhStat.isDirectory()) {
        return {
            kind: "unsafe",
            reason: `.tlh is not a regular directory (symlinks are not allowed)`,
        };
    }
    let fileStat;
    try {
        fileStat = fileSystem.lstatSync(filePath);
    }
    catch (error) {
        if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
            return { kind: "absent" };
        }
        return {
            kind: "unsafe",
            reason: `Cannot inspect ${PROJECT_DEFAULTS_FILE}: ${errorMessage(error)}`,
        };
    }
    if (fileStat.isSymbolicLink()) {
        return {
            kind: "unsafe",
            reason: `${PROJECT_DEFAULTS_FILE} is a symlink (symlinks are not allowed)`,
        };
    }
    if (!fileStat.isFile()) {
        return {
            kind: "unsafe",
            reason: `${PROJECT_DEFAULTS_FILE} is not a regular file`,
        };
    }
    if (fileStat.size > maxFileBytes) {
        return {
            kind: "unsafe",
            reason: `${PROJECT_DEFAULTS_FILE} exceeds maximum allowed size of ${maxFileBytes} bytes`,
        };
    }
    return { kind: "present" };
}
function inspectDefaultsPath(projectRoot, fileSystem, maxFileBytes) {
    const tlhPath = path.join(projectRoot, ".tlh");
    const filePath = path.join(projectRoot, PROJECT_DEFAULTS_FILE);
    let tlhStat;
    try {
        tlhStat = fileSystem.lstatSync(tlhPath);
    }
    catch (error) {
        if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
            return { kind: "absent" };
        }
        return {
            kind: "error",
            reason: `Cannot inspect .tlh directory: ${errorMessage(error)}`,
        };
    }
    const tlhIdentity = fileIdentity(tlhStat);
    if (tlhStat.isSymbolicLink() || !tlhStat.isDirectory()) {
        return {
            kind: "error",
            reason: `.tlh is not a regular directory (symlinks are not allowed)`,
        };
    }
    if (!tlhIdentity) {
        return {
            kind: "error",
            reason: `.tlh directory identity cannot be proven`,
        };
    }
    let tlhCanonicalPath;
    try {
        tlhCanonicalPath = fileSystem.realpathSync(tlhPath);
    }
    catch (error) {
        return {
            kind: "error",
            reason: `Cannot canonicalize .tlh directory: ${errorMessage(error)}`,
        };
    }
    if (!isPathWithin(projectRoot, tlhCanonicalPath)) {
        return {
            kind: "error",
            reason: `.tlh canonical path is outside the project root`,
        };
    }
    let fileStat;
    try {
        fileStat = fileSystem.lstatSync(filePath);
    }
    catch (error) {
        if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
            return { kind: "absent" };
        }
        return {
            kind: "error",
            reason: `Cannot inspect ${PROJECT_DEFAULTS_FILE}: ${errorMessage(error)}`,
        };
    }
    const fileIdentityValue = fileIdentity(fileStat);
    if (fileStat.isSymbolicLink()) {
        return {
            kind: "error",
            reason: `${PROJECT_DEFAULTS_FILE} is a symlink (symlinks are not allowed)`,
        };
    }
    if (!fileStat.isFile()) {
        return {
            kind: "error",
            reason: `${PROJECT_DEFAULTS_FILE} is not a regular file`,
        };
    }
    if (!fileIdentityValue) {
        return {
            kind: "error",
            reason: `${PROJECT_DEFAULTS_FILE} file identity cannot be proven`,
        };
    }
    if (!Number.isSafeInteger(fileStat.size) || fileStat.size < 0) {
        return {
            kind: "error",
            reason: `${PROJECT_DEFAULTS_FILE} size cannot be bounded safely`,
        };
    }
    if (fileStat.size > maxFileBytes) {
        return {
            kind: "error",
            reason: `${PROJECT_DEFAULTS_FILE} exceeds maximum allowed size of ${maxFileBytes} bytes`,
        };
    }
    let canonicalPath;
    try {
        canonicalPath = fileSystem.realpathSync(filePath);
    }
    catch (error) {
        return {
            kind: "error",
            reason: `Cannot canonicalize ${PROJECT_DEFAULTS_FILE}: ${errorMessage(error)}`,
        };
    }
    if (!isPathWithin(projectRoot, canonicalPath) ||
        path.dirname(canonicalPath) !== tlhCanonicalPath) {
        return {
            kind: "error",
            reason: `${PROJECT_DEFAULTS_FILE} canonical path is outside the project root`,
        };
    }
    return {
        kind: "valid",
        tlhCanonicalPath,
        tlhStat,
        tlhIdentity,
        canonicalPath,
        fileStat,
        fileIdentity: fileIdentityValue,
    };
}
function sameDefaultsPath(left, right) {
    if (left.kind !== "valid" || right.kind !== "valid")
        return false;
    return (left.tlhCanonicalPath === right.tlhCanonicalPath &&
        sameFileIdentity(left.tlhIdentity, right.tlhIdentity) &&
        statSignature(left.tlhStat) === statSignature(right.tlhStat) &&
        left.canonicalPath === right.canonicalPath &&
        sameFileIdentity(left.fileIdentity, right.fileIdentity) &&
        statSignature(left.fileStat) === statSignature(right.fileStat));
}
function pathInspectionError(inspection, phase) {
    if (inspection.kind === "absent") {
        return {
            kind: "error",
            reason: `${PROJECT_DEFAULTS_FILE} disappeared ${phase}`,
        };
    }
    if (inspection.kind === "error") {
        const reason = inspection.reason.includes("is a symlink")
            ? `${PROJECT_DEFAULTS_FILE} became a symlink ${phase}`
            : `${PROJECT_DEFAULTS_FILE} changed ${phase}: ${inspection.reason}`;
        return { kind: "error", reason };
    }
    return {
        kind: "error",
        reason: `${PROJECT_DEFAULTS_FILE} changed ${phase}`,
    };
}
function readDefaultsFile(projectRoot, fileSystem, maxFileBytes) {
    const initial = inspectDefaultsPath(projectRoot, fileSystem, maxFileBytes);
    if (initial.kind !== "valid") {
        return pathInspectionError(initial, "before reading");
    }
    const beforeOpen = inspectDefaultsPath(projectRoot, fileSystem, maxFileBytes);
    if (beforeOpen.kind !== "valid")
        return pathInspectionError(beforeOpen, "before reading");
    if (!sameDefaultsPath(initial, beforeOpen)) {
        return {
            kind: "error",
            reason: `${PROJECT_DEFAULTS_FILE} changed before reading`,
        };
    }
    const noFollow = fileSystem.noFollowFlag;
    if (typeof noFollow !== "number" || !Number.isSafeInteger(noFollow) || noFollow <= 0) {
        return {
            kind: "error",
            reason: "the O_NOFOLLOW open flag is unavailable; refusing an unbound defaults read",
        };
    }
    if (typeof fileSystem.openSync !== "function" ||
        typeof fileSystem.fstatSync !== "function" ||
        typeof fileSystem.readSync !== "function" ||
        typeof fileSystem.closeSync !== "function") {
        return {
            kind: "error",
            reason: "safe descriptor operations are unavailable; refusing to read project defaults",
        };
    }
    let descriptor;
    try {
        descriptor = fileSystem.openSync(beforeOpen.canonicalPath, fs.constants.O_RDONLY | noFollow);
    }
    catch (error) {
        if (isErrno(error, "ENOENT") || isErrno(error, "ELOOP")) {
            return {
                kind: "error",
                reason: `${PROJECT_DEFAULTS_FILE} changed before reading`,
            };
        }
        return {
            kind: "error",
            reason: `Cannot open ${PROJECT_DEFAULTS_FILE} safely: ${errorMessage(error)}`,
        };
    }
    try {
        const descriptorStat = fileSystem.fstatSync(descriptor);
        const descriptorIdentity = fileIdentity(descriptorStat);
        if (descriptorStat.isSymbolicLink() || !descriptorStat.isFile() || !descriptorIdentity) {
            return {
                kind: "error",
                reason: `${PROJECT_DEFAULTS_FILE} opened descriptor is not a regular file`,
            };
        }
        if (!sameFileIdentity(beforeOpen.fileIdentity, descriptorIdentity) ||
            descriptorStat.size !== beforeOpen.fileStat.size ||
            statSignature(descriptorStat) !== statSignature(beforeOpen.fileStat)) {
            return {
                kind: "error",
                reason: `${PROJECT_DEFAULTS_FILE} changed before reading`,
            };
        }
        if (descriptorStat.size > maxFileBytes) {
            return {
                kind: "error",
                reason: `${PROJECT_DEFAULTS_FILE} exceeds maximum allowed size of ${maxFileBytes} bytes`,
            };
        }
        const afterOpen = inspectDefaultsPath(projectRoot, fileSystem, maxFileBytes);
        if (afterOpen.kind !== "valid")
            return pathInspectionError(afterOpen, "before reading");
        if (!sameDefaultsPath(beforeOpen, afterOpen)) {
            return {
                kind: "error",
                reason: `${PROJECT_DEFAULTS_FILE} changed before reading`,
            };
        }
        const readLimit = maxFileBytes === Number.MAX_SAFE_INTEGER ? maxFileBytes : maxFileBytes + 1;
        const chunks = [];
        let bytesRead = 0;
        while (bytesRead < readLimit) {
            const remaining = readLimit - bytesRead;
            const buffer = Buffer.allocUnsafe(Math.min(8192, remaining));
            const count = fileSystem.readSync(descriptor, buffer, 0, buffer.byteLength, null);
            if (!Number.isSafeInteger(count) || count < 0 || count > buffer.byteLength) {
                return {
                    kind: "error",
                    reason: "safe descriptor read returned an invalid byte count",
                };
            }
            if (count === 0)
                break;
            chunks.push(buffer.subarray(0, count));
            bytesRead += count;
            if (bytesRead > maxFileBytes) {
                return {
                    kind: "error",
                    reason: `${PROJECT_DEFAULTS_FILE} exceeds maximum allowed size of ${maxFileBytes} bytes`,
                };
            }
        }
        const bytes = Buffer.concat(chunks, bytesRead);
        const afterReadDescriptorStat = fileSystem.fstatSync(descriptor);
        const afterReadDescriptorIdentity = fileIdentity(afterReadDescriptorStat);
        if (afterReadDescriptorStat.isSymbolicLink() ||
            !afterReadDescriptorStat.isFile() ||
            !afterReadDescriptorIdentity ||
            !sameFileIdentity(descriptorIdentity, afterReadDescriptorIdentity) ||
            statSignature(afterReadDescriptorStat) !== statSignature(beforeOpen.fileStat)) {
            return {
                kind: "error",
                reason: `${PROJECT_DEFAULTS_FILE} changed while reading`,
            };
        }
        if (bytes.byteLength !== beforeOpen.fileStat.size) {
            return {
                kind: "error",
                reason: `${PROJECT_DEFAULTS_FILE} size changed while reading`,
            };
        }
        const afterRead = inspectDefaultsPath(projectRoot, fileSystem, maxFileBytes);
        if (afterRead.kind !== "valid")
            return pathInspectionError(afterRead, "while reading");
        if (!sameDefaultsPath(beforeOpen, afterRead)) {
            return {
                kind: "error",
                reason: `${PROJECT_DEFAULTS_FILE} changed while reading`,
            };
        }
        let text;
        try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        }
        catch (error) {
            return {
                kind: "error",
                reason: `${PROJECT_DEFAULTS_FILE} contains invalid UTF-8: ${errorMessage(error)}`,
            };
        }
        return { kind: "content", text };
    }
    catch (error) {
        if (isErrno(error, "ENOENT") || isErrno(error, "ELOOP")) {
            return {
                kind: "error",
                reason: `${PROJECT_DEFAULTS_FILE} changed while reading`,
            };
        }
        return {
            kind: "error",
            reason: `Cannot read ${PROJECT_DEFAULTS_FILE} safely: ${errorMessage(error)}`,
        };
    }
    finally {
        try {
            fileSystem.closeSync(descriptor);
        }
        catch {
        }
    }
}
function validateDefaultsEntry(section, role, rawEntry, warnings) {
    if (section === "primaryAgents") {
        if (!VALID_PRIMARY_AGENTS.has(role)) {
            warnings.add(`Ignoring unknown primary agent name "${role}" in ${PROJECT_DEFAULTS_FILE}` +
                ` (valid names: ${[...VALID_PRIMARY_AGENTS].join(", ")}).`);
            return null;
        }
    }
    else {
        if (!VALID_SUBAGENT_ROLES.has(role)) {
            warnings.add(`Ignoring unknown subagent role "${role}" in ${PROJECT_DEFAULTS_FILE}` +
                ` (valid roles: ${[...VALID_SUBAGENT_ROLES].join(", ")}).`);
            return null;
        }
    }
    if (rawEntry === null || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
        warnings.add(`Ignoring ${section}["${role}"] in ${PROJECT_DEFAULTS_FILE}: entry must be an object.`);
        return null;
    }
    const entryObj = rawEntry;
    const unknownKeys = Object.keys(entryObj).filter((key) => !VALID_ENTRY_KEYS.has(key));
    if (unknownKeys.length > 0) {
        warnings.add(`Ignoring ${section}["${role}"] in ${PROJECT_DEFAULTS_FILE}: unknown key(s)` +
            ` ${unknownKeys.map((k) => `"${k}"`).join(", ")}.`);
        return null;
    }
    let model;
    if (Object.prototype.hasOwnProperty.call(entryObj, "model")) {
        if (!isValidModelReference(entryObj.model)) {
            warnings.add(`Ignoring ${section}["${role}"] in ${PROJECT_DEFAULTS_FILE}:` +
                ` "model" must be a provider/model reference with non-empty provider and model id.`);
            return null;
        }
        model = entryObj.model;
    }
    let effort;
    if (Object.prototype.hasOwnProperty.call(entryObj, "effort")) {
        if (typeof entryObj.effort !== "string" ||
            !VALID_EFFORT_LEVELS.has(entryObj.effort)) {
            warnings.add(`Ignoring ${section}["${role}"] in ${PROJECT_DEFAULTS_FILE}:` +
                ` "effort" must be one of ${[...VALID_EFFORT_LEVELS].join(", ")} (case-sensitive).`);
            return null;
        }
        effort = entryObj.effort;
    }
    if (model === undefined && effort === undefined) {
        warnings.add(`Ignoring ${section}["${role}"] in ${PROJECT_DEFAULTS_FILE}:` +
            ` entry must have at least one of "model" or "effort".`);
        return null;
    }
    const entry = {};
    if (model !== undefined)
        entry.model = model;
    if (effort !== undefined)
        entry.effort = effort;
    return entry;
}
function parseDefaultsContent(text, warnings) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        warnings.add(`${PROJECT_DEFAULTS_FILE} is not valid JSON: ${errorMessage(error)}. No defaults applied.`);
        return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        warnings.add(`${PROJECT_DEFAULTS_FILE} must be a JSON object at the top level. No defaults applied.`);
        return null;
    }
    const root = parsed;
    const primaryAgents = {};
    const subagents = {};
    if (Object.prototype.hasOwnProperty.call(root, "primaryAgents")) {
        const section = root.primaryAgents;
        if (section !== null && typeof section === "object" && !Array.isArray(section)) {
            for (const [role, rawEntry] of Object.entries(section)) {
                const entry = validateDefaultsEntry("primaryAgents", role, rawEntry, warnings);
                if (entry !== null) {
                    primaryAgents[role] = entry;
                }
            }
        }
        else {
            warnings.add(`${PROJECT_DEFAULTS_FILE} "primaryAgents" must be an object if present; section ignored.`);
        }
    }
    if (Object.prototype.hasOwnProperty.call(root, "subagents")) {
        const section = root.subagents;
        if (section !== null && typeof section === "object" && !Array.isArray(section)) {
            for (const [role, rawEntry] of Object.entries(section)) {
                const entry = validateDefaultsEntry("subagents", role, rawEntry, warnings);
                if (entry !== null) {
                    subagents[role] = entry;
                }
            }
        }
        else {
            warnings.add(`${PROJECT_DEFAULTS_FILE} "subagents" must be an object if present; section ignored.`);
        }
    }
    return { primaryAgents, subagents };
}
function mergeTrustOptions(options) {
    return {
        ...options.trust,
        sessionId: options.trust?.sessionId ?? options.sessionId,
        agentDir: options.trust?.agentDir ?? options.agentDir,
        trustOverride: options.trust?.trustOverride ?? options.trustOverride,
        defaultProjectTrust: options.trust?.defaultProjectTrust ?? options.defaultProjectTrust,
    };
}
export async function loadProjectDefaults(options) {
    const fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
    const maxFileBytes = normalizeMaxFileBytes(options.maxFileBytes);
    const projectRoot = resolveValidatedGitWorktreeRoot(options.cwd, { fileSystem });
    if (!projectRoot) {
        return {
            status: "unavailable",
            warnings: boundedWarnings("Current directory is not inside a canonical Git worktree."),
        };
    }
    if (typeof options.sessionId !== "string" || options.sessionId.trim().length === 0) {
        return {
            status: "unavailable",
            projectRoot,
            warnings: boundedWarnings("Session identity is unavailable; project-defaults loading is disabled."),
        };
    }
    const preflight = preflightDefaultsFile(projectRoot, fileSystem, maxFileBytes);
    if (preflight.kind === "absent") {
        return {
            status: "loaded",
            projectRoot,
            defaults: { primaryAgents: {}, subagents: {} },
            warnings: boundedWarnings(),
        };
    }
    if (preflight.kind === "unsafe") {
        return {
            status: "unavailable",
            projectRoot,
            warnings: boundedWarnings(preflight.reason),
        };
    }
    const trustOptions = mergeTrustOptions(options);
    if (typeof trustOptions.hasTrustRequiringProjectResources !== "function" ||
        (typeof trustOptions.createProjectTrustStore !== "function" &&
            !isUsableConfigTrustStore(trustOptions.trustStore))) {
        return {
            status: "unavailable",
            projectRoot,
            warnings: boundedWarnings("Project-defaults trust dependencies are unavailable; loading is disabled."),
        };
    }
    const trust = await resolveProjectConfigTrust(projectRoot, trustOptions);
    if (!trust.trusted) {
        return {
            status: "denied",
            projectRoot,
            trust,
            warnings: boundedWarnings(`Project-defaults loading denied (${trust.source}).`),
        };
    }
    const readResult = readDefaultsFile(projectRoot, fileSystem, maxFileBytes);
    if (readResult.kind === "error") {
        return {
            status: "unavailable",
            projectRoot,
            trust,
            warnings: boundedWarnings(readResult.reason),
        };
    }
    const warnings = new ProjectDefaultsWarningCollector();
    const defaults = parseDefaultsContent(readResult.text, warnings);
    return {
        status: "loaded",
        projectRoot,
        trust,
        defaults: defaults ?? { primaryAgents: {}, subagents: {} },
        warnings: warnings.toArray(),
    };
}

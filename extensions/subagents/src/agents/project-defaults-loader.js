import * as fs from "node:fs";
import * as path from "node:path";
import { resolveCanonicalGitWorktreeRoot, resolveProjectAgentTrust, } from "./project-agent-loader.js";
export const PROJECT_DEFAULTS_FILE = path.join(".tlh", "defaults.json");
const PROJECT_DEFAULTS_WARNING_FILE = ".tlh/defaults.json";
export const MAX_PROJECT_DEFAULTS_FILE_BYTES = 64 * 1024;
export const MAX_PROJECT_DEFAULT_WARNINGS = 20;
export const MAX_PROJECT_DEFAULT_WARNING_LENGTH = 512;
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
    readdirSync: (filePath, options) => fs.readdirSync(filePath, options),
    realpathSync: (filePath) => fs.realpathSync(filePath),
    readFileSync: (filePath) => fs.readFileSync(filePath),
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
function isUsableTrustStore(value) {
    try {
        return (Boolean(value) &&
            typeof value === "object" &&
            (typeof value.getEntry === "function" ||
                typeof value.get === "function"));
    }
    catch {
        return false;
    }
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
function readDefaultsFile(projectRoot, fileSystem, maxFileBytes) {
    const tlhPath = path.join(projectRoot, ".tlh");
    const filePath = path.join(projectRoot, PROJECT_DEFAULTS_FILE);
    let tlhStat;
    try {
        tlhStat = fileSystem.lstatSync(tlhPath);
    }
    catch (error) {
        if (isErrno(error, "ENOENT"))
            return { kind: "absent" };
        return {
            kind: "error",
            reason: `Cannot inspect .tlh directory: ${errorMessage(error)}`,
        };
    }
    if (tlhStat.isSymbolicLink() || !tlhStat.isDirectory()) {
        return {
            kind: "error",
            reason: `.tlh is not a regular directory (symlinks are not allowed)`,
        };
    }
    let fileStat;
    try {
        fileStat = fileSystem.lstatSync(filePath);
    }
    catch (error) {
        if (isErrno(error, "ENOENT"))
            return { kind: "absent" };
        return {
            kind: "error",
            reason: `Cannot inspect ${PROJECT_DEFAULTS_FILE}: ${errorMessage(error)}`,
        };
    }
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
    if (!isPathWithin(projectRoot, canonicalPath)) {
        return {
            kind: "error",
            reason: `${PROJECT_DEFAULTS_FILE} canonical path is outside the project root`,
        };
    }
    const initialSignature = statSignature(fileStat);
    let beforeReadStat;
    try {
        beforeReadStat = fileSystem.lstatSync(filePath);
    }
    catch (error) {
        return {
            kind: "error",
            reason: `Cannot recheck ${PROJECT_DEFAULTS_FILE} before reading: ${errorMessage(error)}`,
        };
    }
    if (beforeReadStat.isSymbolicLink()) {
        return {
            kind: "error",
            reason: `${PROJECT_DEFAULTS_FILE} became a symlink before reading`,
        };
    }
    if (!beforeReadStat.isFile()) {
        return {
            kind: "error",
            reason: `${PROJECT_DEFAULTS_FILE} is no longer a regular file before reading`,
        };
    }
    if (statSignature(beforeReadStat) !== initialSignature) {
        return {
            kind: "error",
            reason: `${PROJECT_DEFAULTS_FILE} changed before reading`,
        };
    }
    let raw;
    try {
        raw = fileSystem.readFileSync(canonicalPath);
    }
    catch (error) {
        return {
            kind: "error",
            reason: `Cannot read ${PROJECT_DEFAULTS_FILE}: ${errorMessage(error)}`,
        };
    }
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf-8");
    if (bytes.byteLength !== fileStat.size) {
        return {
            kind: "error",
            reason: `${PROJECT_DEFAULTS_FILE} size changed while reading`,
        };
    }
    let afterReadStat;
    try {
        afterReadStat = fileSystem.lstatSync(filePath);
    }
    catch (error) {
        return {
            kind: "error",
            reason: `Cannot recheck ${PROJECT_DEFAULTS_FILE} after reading: ${errorMessage(error)}`,
        };
    }
    if (afterReadStat.isSymbolicLink()) {
        return {
            kind: "error",
            reason: `${PROJECT_DEFAULTS_FILE} became a symlink while reading`,
        };
    }
    if (!afterReadStat.isFile()) {
        return {
            kind: "error",
            reason: `${PROJECT_DEFAULTS_FILE} is no longer a regular file after reading`,
        };
    }
    if (statSignature(afterReadStat) !== initialSignature) {
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
    const projectRoot = resolveCanonicalGitWorktreeRoot(options.cwd, {
        git: options.git,
        fileSystem,
    });
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
    const trustOptions = mergeTrustOptions(options);
    if (typeof trustOptions.hasTrustRequiringProjectResources !== "function" ||
        (typeof trustOptions.createProjectTrustStore !== "function" &&
            !isUsableTrustStore(trustOptions.trustStore))) {
        return {
            status: "unavailable",
            projectRoot,
            warnings: boundedWarnings("Project-defaults trust dependencies are unavailable; loading is disabled."),
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
    const trust = await resolveProjectAgentTrust(projectRoot, trustOptions);
    if (!trust.trusted) {
        return {
            status: "denied",
            projectRoot,
            trust,
            warnings: boundedWarnings(`Project-defaults loading denied (${trust.source}).`),
        };
    }
    const readResult = readDefaultsFile(projectRoot, fileSystem, maxFileBytes);
    if (readResult.kind === "absent") {
        return {
            status: "loaded",
            projectRoot,
            trust,
            defaults: { primaryAgents: {}, subagents: {} },
            warnings: boundedWarnings(),
        };
    }
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

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../shared/utils.js";
import { getProjectAgentSnapshotProvenance, registerProjectAgentSnapshot, resolveProjectAgentSnapshot, } from "./project-agent-snapshot.js";
import { parseFrontmatter } from "./frontmatter.js";
import { buildRuntimeName } from "./identity.js";
import { validateToolBudgetConfig } from "../runs/shared/tool-budget.js";
export const PROJECT_AGENT_DIRECTORY = path.join(".tlh", "agents");
export const PROJECT_AGENT_PACKAGE = "embedded";
export const MAX_PROJECT_AGENT_FILE_BYTES = 512 * 1024;
export const PROJECT_AGENT_TRUST_UI_TIMEOUT_MS = 60_000;
export const MAX_PROJECT_AGENT_FILES = 128;
export const MAX_PROJECT_AGENT_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_PROJECT_AGENT_DEPTH = 16;
export const MAX_PROJECT_AGENT_DIRECTORIES = 256;
export const MAX_PROJECT_AGENT_SCAN_ATTEMPTS = 3;
const PROJECT_AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PROJECT_AGENT_RUNTIME_NAME_PATTERN = /^embedded\.[a-z0-9][a-z0-9-]*$/;
const PROJECT_AGENT_TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PROJECT_AGENT_DEFINITION_SUFFIX = ".md";
const PROJECT_AGENT_CHAIN_SUFFIX = ".chain.md";
const KNOWN_FRONTMATTER_FIELDS = new Set([
    "name",
    "package",
    "description",
    "tools",
    "model",
    "fallbackModels",
    "thinking",
    "systemPromptMode",
    "inheritProjectContext",
    "inheritSkills",
    "defaultContext",
    "acceptanceRole",
    "skill",
    "skills",
    "extensions",
    "subagentOnlyExtensions",
    "output",
    "defaultReads",
    "defaultProgress",
    "interactive",
    "maxSubagentDepth",
    "maxExecutionTimeMs",
    "completionGuard",
    "toolBudget",
]);
const DEFAULT_FILE_SYSTEM = {
    lstatSync: (filePath) => fs.lstatSync(filePath),
    statSync: (filePath) => fs.statSync(filePath),
    readdirSync: (filePath, options) => fs.readdirSync(filePath, options),
    realpathSync: (filePath) => fs.realpathSync(filePath),
    readFileSync: (filePath) => fs.readFileSync(filePath),
};
const SESSION_TRUST_DECISIONS = new Map();
const DEFAULT_GIT = {
    showToplevel(cwd) {
        try {
            const output = execFileSync("git", ["-C", path.resolve(cwd), "rev-parse", "--show-toplevel"], {
                encoding: "utf-8",
                maxBuffer: 64 * 1024,
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 5000,
            });
            const root = output.trim();
            return root || undefined;
        }
        catch {
            return undefined;
        }
    },
};
export class ProjectAgentDefinitionError extends Error {
    code = "INVALID_PROJECT_AGENT_DEFINITION";
    constructor(filePath, reason) {
        super(`Invalid TLH project agent '${filePath}': ${reason}`);
        this.name = "ProjectAgentDefinitionError";
    }
}
function isErrno(error, code) {
    return (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === code);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isPathWithin(parentPath, childPath) {
    const relativePath = path.relative(parentPath, childPath);
    return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}
function canonicalExistingDirectory(value, label) {
    if (typeof value !== "string" || value.trim().length === 0) {
        return { valid: false, reason: `${label} must be an existing directory path.` };
    }
    try {
        const canonical = fs.realpathSync(value);
        if (!fs.statSync(canonical).isDirectory()) {
            return { valid: false, reason: `${label} is not a directory: ${value}` };
        }
        return { valid: true, path: canonical };
    }
    catch {
        return { valid: false, reason: `${label} does not exist or cannot be resolved: ${value}` };
    }
}
export function validateProjectAgentCwdContainment(projectRoot, cwd, taskCwds = []) {
    const canonicalRoot = canonicalExistingDirectory(projectRoot, "Project root");
    if (!canonicalRoot.valid)
        return canonicalRoot;
    const canonicalCwd = canonicalExistingDirectory(cwd, "Execution cwd");
    if (!canonicalCwd.valid)
        return canonicalCwd;
    if (!isPathWithin(canonicalRoot.path, canonicalCwd.path)) {
        return {
            valid: false,
            reason: `Execution cwd is outside the canonical project root: ${cwd}`,
        };
    }
    if (typeof cwd !== "string") {
        return { valid: false, reason: "Execution cwd must be an existing directory path." };
    }
    const canonicalTaskCwds = [];
    for (let index = 0; index < taskCwds.length; index += 1) {
        const requested = taskCwds[index];
        if (requested !== undefined && typeof requested !== "string") {
            return {
                valid: false,
                reason: `Task ${index + 1} cwd must be an existing directory path.`,
            };
        }
        const taskPath = requested === undefined || requested === "" ? cwd : path.resolve(cwd, requested);
        const canonicalTask = canonicalExistingDirectory(taskPath, `Task ${index + 1} cwd`);
        if (!canonicalTask.valid)
            return canonicalTask;
        if (!isPathWithin(canonicalRoot.path, canonicalTask.path)) {
            return {
                valid: false,
                reason: `Task ${index + 1} cwd is outside the canonical project root: ${taskPath}`,
            };
        }
        canonicalTaskCwds.push(canonicalTask.path);
    }
    return {
        valid: true,
        canonicalRoot: canonicalRoot.path,
        canonicalCwd: canonicalCwd.path,
        canonicalTaskCwds,
    };
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
function isDefinitionFile(fileName) {
    return (fileName.endsWith(PROJECT_AGENT_DEFINITION_SUFFIX) &&
        !fileName.endsWith(PROJECT_AGENT_CHAIN_SUFFIX));
}
function candidateBasename(fileName) {
    return fileName.endsWith(PROJECT_AGENT_DEFINITION_SUFFIX)
        ? fileName.slice(0, -PROJECT_AGENT_DEFINITION_SUFFIX.length)
        : fileName;
}
function runtimeNameForBasename(basename) {
    if (!PROJECT_AGENT_NAME_PATTERN.test(basename))
        return undefined;
    const runtimeName = buildRuntimeName(basename, PROJECT_AGENT_PACKAGE);
    return PROJECT_AGENT_RUNTIME_NAME_PATTERN.test(runtimeName) ? runtimeName : undefined;
}
function normalizeBound(value, fallback) {
    return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}
function normalizeAttempts(value) {
    return value !== undefined && Number.isSafeInteger(value) && value > 0
        ? value
        : MAX_PROJECT_AGENT_SCAN_ATTEMPTS;
}
function canonicalRootFromGit(cwd, git, fileSystem) {
    if (typeof cwd !== "string" || cwd.trim().length === 0)
        return undefined;
    let reportedRoot;
    try {
        reportedRoot = git.showToplevel(cwd);
    }
    catch {
        return undefined;
    }
    if (!reportedRoot || reportedRoot.trim().length === 0)
        return undefined;
    try {
        const resolvedReportedRoot = path.resolve(cwd, reportedRoot.trim());
        const canonicalRoot = fileSystem.realpathSync(resolvedReportedRoot);
        const stat = fileSystem.lstatSync(canonicalRoot);
        if (stat.isSymbolicLink() || !stat.isDirectory())
            return undefined;
        return canonicalRoot;
    }
    catch {
        return undefined;
    }
}
export function resolveCanonicalGitWorktreeRoot(cwd, options = {}) {
    return canonicalRootFromGit(cwd, options.git ?? DEFAULT_GIT, options.fileSystem ?? DEFAULT_FILE_SYSTEM);
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
        try {
            return isPathWithin(path.resolve(entryPath), path.resolve(projectRoot));
        }
        catch {
            return false;
        }
    }
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
function defaultTrustStore(options) {
    if (options.trustStore) {
        if (!isUsableTrustStore(options.trustStore)) {
            throw new Error("Project trust-store dependency returned an invalid store.");
        }
        return options.trustStore;
    }
    const agentDir = options.agentDir ?? getAgentDir();
    if (!fs.existsSync(path.join(agentDir, "trust.json")))
        return {};
    if (typeof options.createProjectTrustStore !== "function") {
        throw new Error("Project trust-store dependency is unavailable.");
    }
    const store = options.createProjectTrustStore(agentDir);
    if (!isUsableTrustStore(store)) {
        throw new Error("Project trust-store dependency returned an invalid store.");
    }
    return store;
}
function resolveTrustUiTimeoutMs(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : PROJECT_AGENT_TRUST_UI_TIMEOUT_MS;
}
function waitForTrustDecision(decision, timeoutMs) {
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
export async function resolveProjectAgentTrust(projectRoot, options = {}) {
    if (options.trustOverride === false) {
        return { trusted: false, source: "explicit-negative" };
    }
    let store;
    try {
        store = defaultTrustStore(options);
        if (store.getEntry) {
            const entry = store.getEntry(projectRoot);
            if (entry !== null && typeof entry !== "object") {
                return { trusted: false, source: "trust-store-error" };
            }
            if (entry && (typeof entry.path !== "string" || typeof entry.decision !== "boolean")) {
                return { trusted: false, source: "trust-store-error" };
            }
            if (entry && trustEntryPathApplies(entry.path, projectRoot)) {
                return entry.decision
                    ? { trusted: true, source: "saved-positive" }
                    : { trusted: false, source: "saved-negative" };
            }
        }
        else if (store.get) {
            const decision = store.get(projectRoot);
            if (decision === true)
                return { trusted: true, source: "saved-positive" };
            if (decision === false)
                return { trusted: false, source: "saved-negative" };
            if (decision !== null && decision !== undefined) {
                return { trusted: false, source: "trust-store-error" };
            }
        }
    }
    catch {
        return { trusted: false, source: "trust-store-error" };
    }
    const hasTrustResources = (() => {
        if (typeof options.hasTrustRequiringProjectResources !== "function")
            return false;
        try {
            return options.hasTrustRequiringProjectResources(projectRoot);
        }
        catch {
            return false;
        }
    })();
    try {
        const upstreamDecision = options.isProjectTrusted?.();
        if (upstreamDecision === false) {
            return { trusted: false, source: "explicit-negative" };
        }
        if (hasTrustResources && upstreamDecision === true) {
            return { trusted: true, source: "upstream-positive" };
        }
    }
    catch {
    }
    const sessionKey = typeof options.sessionId === "string" && options.sessionId.trim().length > 0
        ? `${options.sessionId.trim()}\u0000${path.resolve(projectRoot)}`
        : undefined;
    const cachedSessionDecision = sessionKey ? SESSION_TRUST_DECISIONS.get(sessionKey) : undefined;
    if (cachedSessionDecision !== undefined) {
        return cachedSessionDecision
            ? { trusted: true, source: "session-positive" }
            : { trusted: false, source: "session-negative" };
    }
    switch (options.defaultProjectTrust ?? "ask") {
        case "always":
            return { trusted: true, source: "default-always" };
        case "never":
            return { trusted: false, source: "default-never" };
        case "ask":
            break;
    }
    if (options.hasUI === false) {
        return { trusted: false, source: "session-unavailable" };
    }
    try {
        const timeoutMs = resolveTrustUiTimeoutMs(options.trustUiTimeoutMs);
        const trusted = await waitForTrustDecision(options.confirm
            ? options.confirm(projectRoot)
            : options.ui
                ? options.ui.confirm("Trust project-local TLH agents?", `This allows repository-owned agent definitions under ${path.join(projectRoot, PROJECT_AGENT_DIRECTORY)} to be loaded for this session only.`, { timeout: timeoutMs })
                : undefined, timeoutMs);
        if (trusted === true || trusted === false) {
            if (sessionKey) {
                SESSION_TRUST_DECISIONS.set(sessionKey, trusted);
                if (SESSION_TRUST_DECISIONS.size > 128) {
                    const oldestKey = SESSION_TRUST_DECISIONS.keys().next().value;
                    if (oldestKey)
                        SESSION_TRUST_DECISIONS.delete(oldestKey);
                }
            }
            return trusted
                ? { trusted: true, source: "session-positive" }
                : { trusted: false, source: "session-negative" };
        }
    }
    catch {
        return { trusted: false, source: "session-unavailable" };
    }
    return { trusted: false, source: "session-unavailable" };
}
function pathParts(relativePath) {
    return relativePath.split(path.sep).filter((part) => part.length > 0 && part !== ".");
}
function symlinkTargetIsDirectory(filePath, fileSystem) {
    if (!fileSystem.statSync)
        return undefined;
    try {
        return fileSystem.statSync(filePath).isDirectory();
    }
    catch {
        return undefined;
    }
}
function inspectCandidate(projectRoot, agentsDirectory, filePath, fileName, stat, fileSystem) {
    const relativePath = path.relative(agentsDirectory, filePath);
    const regular = stat.isFile() && !stat.isSymbolicLink();
    const symlink = stat.isSymbolicLink();
    if (!symlink && regular) {
        try {
            const canonicalFilePath = fileSystem.realpathSync(filePath);
            if (!isPathWithin(projectRoot, canonicalFilePath)) {
                return {
                    filePath,
                    relativePath,
                    basename: candidateBasename(fileName),
                    signature: statSignature(stat),
                    stat,
                    regular: false,
                    symlink: true,
                };
            }
        }
        catch {
        }
    }
    return {
        filePath,
        relativePath,
        basename: candidateBasename(fileName),
        signature: statSignature(stat),
        stat,
        regular,
        symlink,
    };
}
function collectCandidateInventory(projectRoot, options) {
    const agentsDirectory = path.join(projectRoot, PROJECT_AGENT_DIRECTORY);
    const candidates = [];
    const diagnostics = [];
    let totalBytes = 0;
    let directoryCount = 0;
    let status = "ok";
    let tlhDirectoryStat;
    try {
        tlhDirectoryStat = options.fileSystem.lstatSync(path.join(projectRoot, ".tlh"));
    }
    catch (error) {
        if (isErrno(error, "ENOENT")) {
            return { status: "ok", candidates: [], diagnostics: [], totalBytes: 0 };
        }
        return {
            status: "unavailable",
            candidates: [],
            diagnostics: [
                `Unable to inspect project-agent directory '${agentsDirectory}': ${errorMessage(error)}`,
            ],
            totalBytes: 0,
        };
    }
    if (tlhDirectoryStat.isSymbolicLink() || !tlhDirectoryStat.isDirectory()) {
        return {
            status: "unavailable",
            candidates: [],
            diagnostics: [
                `Project-agent directory component is not a regular directory: ${path.join(projectRoot, ".tlh")}`,
            ],
            totalBytes: 0,
        };
    }
    const walk = (directory, depth) => {
        if (status !== "ok")
            return;
        let directoryStat;
        try {
            directoryStat = options.fileSystem.lstatSync(directory);
        }
        catch (error) {
            status = isErrno(error, "ENOENT") ? "unstable" : "unavailable";
            diagnostics.push(`Unable to inspect project-agent directory '${directory}': ${errorMessage(error)}`);
            return;
        }
        if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
            status = "unavailable";
            diagnostics.push(`Project-agent directory component is not a regular directory: ${directory}`);
            return;
        }
        if (depth > options.maxDepth) {
            status = "bounded";
            diagnostics.push(`Project-agent directory depth exceeds ${options.maxDepth}: ${directory}`);
            return;
        }
        directoryCount += 1;
        if (directoryCount > options.maxDirectories) {
            status = "bounded";
            diagnostics.push(`Project-agent directory count exceeds ${options.maxDirectories}.`);
            return;
        }
        let entries;
        try {
            entries = options.fileSystem
                .readdirSync(directory, { withFileTypes: true })
                .slice()
                .sort((left, right) => left.name.localeCompare(right.name));
        }
        catch (error) {
            status = isErrno(error, "ENOENT") ? "unstable" : "unavailable";
            diagnostics.push(`Unable to enumerate project-agent directory '${directory}': ${errorMessage(error)}`);
            return;
        }
        for (const entry of entries) {
            if (status !== "ok")
                return;
            const filePath = path.join(directory, entry.name);
            let stat;
            try {
                stat = options.fileSystem.lstatSync(filePath);
            }
            catch (error) {
                status = isErrno(error, "ENOENT") ? "unstable" : "unavailable";
                diagnostics.push(`Unable to inspect project-agent path '${filePath}': ${errorMessage(error)}`);
                return;
            }
            if (stat.isSymbolicLink()) {
                const targetIsDirectory = symlinkTargetIsDirectory(filePath, options.fileSystem);
                if (targetIsDirectory !== false) {
                    status = "unavailable";
                    diagnostics.push(`Symlinked project-agent directory/path is not allowed: ${filePath}`);
                    return;
                }
                if (!isDefinitionFile(entry.name))
                    continue;
            }
            if (isDefinitionFile(entry.name)) {
                const candidate = inspectCandidate(projectRoot, agentsDirectory, filePath, entry.name, stat, options.fileSystem);
                candidates.push(candidate);
                totalBytes += candidate.stat.size;
                if (candidates.length > options.maxFiles || totalBytes > options.maxTotalBytes) {
                    status = "bounded";
                    diagnostics.push(candidates.length > options.maxFiles
                        ? `Project-agent file count exceeds ${options.maxFiles}.`
                        : `Project-agent byte count exceeds ${options.maxTotalBytes}.`);
                    return;
                }
                continue;
            }
            if (stat.isDirectory() && !stat.isSymbolicLink()) {
                walk(filePath, depth + 1);
                continue;
            }
        }
    };
    let agentsStat;
    try {
        agentsStat = options.fileSystem.lstatSync(agentsDirectory);
    }
    catch (error) {
        if (isErrno(error, "ENOENT")) {
            return {
                status: "ok",
                candidates: [],
                diagnostics: [],
                totalBytes: 0,
            };
        }
        return {
            status: "unavailable",
            diagnostics: [
                `Unable to inspect project-agent directory '${agentsDirectory}': ${errorMessage(error)}`,
            ],
            candidates: [],
            totalBytes: 0,
        };
    }
    if (agentsStat.isSymbolicLink() || !agentsStat.isDirectory()) {
        return {
            status: "unavailable",
            candidates: [],
            diagnostics: [`Project-agent directory is not a regular directory: ${agentsDirectory}`],
            totalBytes: 0,
        };
    }
    walk(agentsDirectory, 0);
    candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return { status, candidates, diagnostics, totalBytes };
}
function sameInventory(left, right) {
    if (left.status !== "ok" || right.status !== "ok")
        return false;
    if (left.candidates.length !== right.candidates.length)
        return false;
    return left.candidates.every((candidate, index) => {
        const other = right.candidates[index];
        return (other !== undefined &&
            candidate.relativePath === other.relativePath &&
            candidate.signature === other.signature &&
            candidate.regular === other.regular &&
            candidate.symlink === other.symlink);
    });
}
function validateCandidatePath(projectRoot, candidate, fileSystem) {
    if (!candidate.regular || candidate.symlink) {
        return { valid: false, reason: "candidate is not a regular non-symlink file" };
    }
    const relative = path.relative(projectRoot, candidate.filePath);
    if (!isPathWithin(projectRoot, candidate.filePath) || relative === "") {
        return { valid: false, reason: "candidate is outside the canonical project root" };
    }
    const parts = pathParts(relative);
    if (parts.length < 1)
        return { valid: false, reason: "candidate path is empty" };
    let current = projectRoot;
    for (const component of parts.slice(0, -1)) {
        current = path.join(current, component);
        let stat;
        try {
            stat = fileSystem.lstatSync(current);
        }
        catch (error) {
            return { valid: false, reason: `path component cannot be inspected: ${errorMessage(error)}` };
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            return { valid: false, reason: "path component is not a regular non-symlink directory" };
        }
    }
    let stat;
    try {
        stat = fileSystem.lstatSync(candidate.filePath);
    }
    catch (error) {
        return { valid: false, reason: `file cannot be inspected: ${errorMessage(error)}` };
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        return { valid: false, reason: "candidate is not a regular non-symlink file" };
    }
    let canonicalPath;
    try {
        canonicalPath = fileSystem.realpathSync(candidate.filePath);
    }
    catch (error) {
        return { valid: false, reason: `file cannot be canonicalized: ${errorMessage(error)}` };
    }
    if (!isPathWithin(projectRoot, canonicalPath)) {
        return { valid: false, reason: "canonical file path is outside the project root" };
    }
    return { valid: true, canonicalPath, stat };
}
function bytesFromRead(value) {
    return Buffer.isBuffer(value) ? value : Buffer.from(value, "utf-8");
}
function parseUtf8(bytes) {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    catch (error) {
        throw new Error(`definition bytes are not valid UTF-8: ${errorMessage(error)}`, {
            cause: error,
        });
    }
}
function splitCommaList(value) {
    if (value === undefined)
        return undefined;
    const values = value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    return values.length > 0 ? values : undefined;
}
function parseStrictBoolean(frontmatter, field, defaultValue, filePath) {
    const value = frontmatter[field];
    if (value === undefined)
        return defaultValue;
    if (value === "true")
        return true;
    if (value === "false")
        return false;
    throw new ProjectAgentDefinitionError(filePath, `${field} must be true or false when provided`);
}
function parseStrictPositiveInteger(frontmatter, field, filePath) {
    const value = frontmatter[field];
    if (value === undefined || value.trim() === "")
        return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new ProjectAgentDefinitionError(filePath, `${field} must be a positive safe integer`);
    }
    return parsed;
}
function parseStrictNonNegativeInteger(frontmatter, field, filePath) {
    const value = frontmatter[field];
    if (value === undefined || value.trim() === "")
        return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new ProjectAgentDefinitionError(filePath, `${field} must be a non-negative safe integer`);
    }
    return parsed;
}
function parseToolBudget(value, filePath) {
    if (value === undefined || value.trim() === "")
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(value);
    }
    catch (error) {
        throw new ProjectAgentDefinitionError(filePath, `toolBudget is not valid JSON: ${errorMessage(error)}`);
    }
    const normalized = validateToolBudgetConfig(parsed, "toolBudget");
    if (normalized.error) {
        throw new ProjectAgentDefinitionError(filePath, normalized.error);
    }
    if (!normalized.budget) {
        throw new ProjectAgentDefinitionError(filePath, "toolBudget must define a valid budget");
    }
    return normalized.budget;
}
function frontmatterEnvelopeError(content) {
    const normalized = content.replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---"))
        return "frontmatter must start with '---'";
    const firstLineEnd = normalized.indexOf("\n");
    if (firstLineEnd === -1 || normalized.slice(0, firstLineEnd).trim() !== "---") {
        return "frontmatter opening delimiter is invalid";
    }
    const endIndex = normalized.indexOf("\n---", 3);
    if (endIndex === -1)
        return "frontmatter closing delimiter is missing";
    const closeLineEnd = normalized.indexOf("\n", endIndex + 1);
    const closeLine = closeLineEnd === -1
        ? normalized.slice(endIndex + 1)
        : normalized.slice(endIndex + 1, closeLineEnd);
    if (closeLine.trim() !== "---")
        return "frontmatter closing delimiter is invalid";
    return undefined;
}
function duplicateFrontmatterField(content) {
    const normalized = content.replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---"))
        return undefined;
    const endIndex = normalized.indexOf("\n---", 3);
    if (endIndex === -1)
        return undefined;
    const fields = new Set();
    for (const line of normalized.slice(4, endIndex).split("\n")) {
        const match = line.match(/^([\w-]+):\s*(.*)$/);
        if (!match)
            continue;
        const field = match[1];
        if (fields.has(field))
            return field;
        fields.add(field);
    }
    return undefined;
}
function parseProjectAgentDefinitionFromText(filePath, content, exactBytes = Buffer.from(content, "utf-8")) {
    const basename = candidateBasename(path.basename(filePath));
    const envelopeError = frontmatterEnvelopeError(content);
    if (envelopeError)
        throw new ProjectAgentDefinitionError(filePath, envelopeError);
    const { frontmatter, body } = parseFrontmatter(content);
    const frontmatterFields = Object.keys(frontmatter);
    const duplicateField = duplicateFrontmatterField(content);
    if (duplicateField) {
        throw new ProjectAgentDefinitionError(filePath, `frontmatter field '${duplicateField}' is declared more than once`);
    }
    if (!PROJECT_AGENT_NAME_PATTERN.test(basename)) {
        throw new ProjectAgentDefinitionError(filePath, "file basename is not a valid agent name");
    }
    if (frontmatter.name !== basename) {
        throw new ProjectAgentDefinitionError(filePath, `frontmatter name must exactly equal file basename '${basename}'`);
    }
    if (frontmatter.package !== PROJECT_AGENT_PACKAGE) {
        throw new ProjectAgentDefinitionError(filePath, `package must exactly be '${PROJECT_AGENT_PACKAGE}'`);
    }
    if (frontmatter.description === undefined || frontmatter.description.trim() === "") {
        throw new ProjectAgentDefinitionError(filePath, "description must be non-empty");
    }
    if (!Object.prototype.hasOwnProperty.call(frontmatter, "tools")) {
        throw new ProjectAgentDefinitionError(filePath, "tools must be explicitly declared");
    }
    const rawTools = splitCommaList(frontmatter.tools) ?? [];
    const tools = rawTools.filter((tool) => !tool.startsWith("mcp:"));
    if (tools.length === 0) {
        throw new ProjectAgentDefinitionError(filePath, "tools must declare at least one usable tool");
    }
    for (const tool of tools) {
        if (!PROJECT_AGENT_TOOL_NAME_PATTERN.test(tool)) {
            throw new ProjectAgentDefinitionError(filePath, `tool '${tool}' is not a valid runtime tool name`);
        }
    }
    if (Object.prototype.hasOwnProperty.call(frontmatter, "extensions") ||
        Object.prototype.hasOwnProperty.call(frontmatter, "subagentOnlyExtensions")) {
        throw new ProjectAgentDefinitionError(filePath, "extensions and subagentOnlyExtensions are prohibited for project agents");
    }
    const runtimeName = buildRuntimeName(basename, PROJECT_AGENT_PACKAGE);
    if (!PROJECT_AGENT_RUNTIME_NAME_PATTERN.test(runtimeName)) {
        throw new ProjectAgentDefinitionError(filePath, "runtime name is invalid");
    }
    const fallbackModels = splitCommaList(frontmatter.fallbackModels);
    const skillString = frontmatter.skill || frontmatter.skills;
    const skills = splitCommaList(skillString);
    const defaultReads = splitCommaList(frontmatter.defaultReads);
    const systemPromptMode = frontmatter.systemPromptMode;
    if (systemPromptMode !== undefined &&
        systemPromptMode !== "append" &&
        systemPromptMode !== "replace") {
        throw new ProjectAgentDefinitionError(filePath, "systemPromptMode must be 'append' or 'replace'");
    }
    const defaultContext = frontmatter.defaultContext;
    if (defaultContext !== undefined && defaultContext !== "fresh" && defaultContext !== "fork") {
        throw new ProjectAgentDefinitionError(filePath, "defaultContext must be 'fresh' or 'fork'");
    }
    let acceptanceRole;
    if (frontmatter.acceptanceRole !== undefined && frontmatter.acceptanceRole.trim() !== "") {
        if (frontmatter.acceptanceRole !== "read-only" && frontmatter.acceptanceRole !== "writer") {
            throw new ProjectAgentDefinitionError(filePath, "acceptanceRole must be 'read-only' or 'writer'");
        }
        acceptanceRole = frontmatter.acceptanceRole;
    }
    const parsedMaxSubagentDepth = parseStrictNonNegativeInteger(frontmatter, "maxSubagentDepth", filePath);
    const maxExecutionTimeMs = parseStrictPositiveInteger(frontmatter, "maxExecutionTimeMs", filePath);
    const toolBudget = parseToolBudget(frontmatter.toolBudget, filePath);
    const completionGuard = frontmatter.completionGuard === undefined
        ? undefined
        : parseStrictBoolean(frontmatter, "completionGuard", false, filePath);
    const defaultProgress = parseStrictBoolean(frontmatter, "defaultProgress", false, filePath);
    const interactive = parseStrictBoolean(frontmatter, "interactive", false, filePath);
    const inheritProjectContext = parseStrictBoolean(frontmatter, "inheritProjectContext", basename === "delegate", filePath);
    const inheritSkills = parseStrictBoolean(frontmatter, "inheritSkills", false, filePath);
    const extraFields = {};
    for (const [key, value] of Object.entries(frontmatter)) {
        if (!KNOWN_FRONTMATTER_FIELDS.has(key))
            extraFields[key] = value;
    }
    const agent = {
        name: runtimeName,
        localName: basename,
        packageName: PROJECT_AGENT_PACKAGE,
        description: frontmatter.description,
        tools,
        model: frontmatter.model,
        fallbackModels,
        thinking: frontmatter.thinking === "false" ? false : frontmatter.thinking,
        systemPromptMode: systemPromptMode === "append"
            ? "append"
            : systemPromptMode === "replace"
                ? "replace"
                : basename === "delegate"
                    ? "append"
                    : "replace",
        inheritProjectContext,
        inheritSkills,
        defaultContext,
        acceptanceRole,
        systemPrompt: body,
        source: "project",
        filePath,
        skills,
        output: frontmatter.output,
        defaultReads,
        defaultProgress,
        interactive,
        maxSubagentDepth: parsedMaxSubagentDepth,
        completionGuard,
        toolBudget,
        maxExecutionTimeMs,
        extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
    };
    const digest = createHash("sha256").update(exactBytes).digest("hex");
    return { agent, digest, frontmatterFields };
}
export function parseProjectAgentDefinition(filePath, content) {
    const bytes = bytesFromRead(content);
    return parseProjectAgentDefinitionFromText(filePath, parseUtf8(bytes), bytes);
}
function readCandidate(projectRoot, candidate, options) {
    const validation = validateCandidatePath(projectRoot, candidate, options.fileSystem);
    if (!validation.valid)
        return { status: "invalid", reason: validation.reason };
    if (validation.stat.size > options.maxFileBytes) {
        return {
            status: "invalid",
            reason: `file size exceeds ${options.maxFileBytes} bytes`,
        };
    }
    if (statSignature(validation.stat) !== candidate.signature) {
        return { status: "unstable", reason: "candidate changed before reading" };
    }
    let raw;
    try {
        raw = options.fileSystem.readFileSync(validation.canonicalPath);
    }
    catch (error) {
        let current;
        try {
            current = options.fileSystem.lstatSync(candidate.filePath);
        }
        catch {
            return { status: "unstable", reason: "candidate disappeared while reading" };
        }
        return statSignature(current) === candidate.signature
            ? { status: "invalid", reason: `file cannot be read: ${errorMessage(error)}` }
            : { status: "unstable", reason: "candidate changed while reading" };
    }
    const bytes = bytesFromRead(raw);
    if (bytes.byteLength !== validation.stat.size) {
        return { status: "unstable", reason: "file size changed while reading" };
    }
    let afterRead;
    try {
        afterRead = options.fileSystem.lstatSync(candidate.filePath);
    }
    catch {
        return { status: "unstable", reason: "candidate disappeared after reading" };
    }
    if (statSignature(afterRead) !== candidate.signature) {
        return { status: "unstable", reason: "candidate changed after reading" };
    }
    try {
        const entry = parseProjectAgentDefinitionFromText(candidate.filePath, parseUtf8(bytes), bytes);
        return { status: "valid", entry };
    }
    catch (error) {
        return {
            status: "invalid",
            reason: error instanceof ProjectAgentDefinitionError ? error.message : errorMessage(error),
        };
    }
}
function emptyScanResult(projectRoot, status, diagnostics = []) {
    return {
        status,
        projectRoot,
        agentsDirectory: path.join(projectRoot, PROJECT_AGENT_DIRECTORY),
        entries: [],
        tombstones: [],
        diagnostics,
        candidateCount: 0,
        totalBytes: 0,
    };
}
function scanProjectAgentsOnce(projectRoot, options) {
    const before = collectCandidateInventory(projectRoot, options);
    if (before.status !== "ok") {
        return emptyScanResult(projectRoot, before.status, before.diagnostics);
    }
    const basenameCounts = new Map();
    for (const candidate of before.candidates) {
        basenameCounts.set(candidate.basename, (basenameCounts.get(candidate.basename) ?? 0) + 1);
    }
    const entries = [];
    const tombstones = new Set();
    const diagnostics = [...before.diagnostics];
    let unstable = false;
    for (const candidate of before.candidates) {
        const runtimeName = runtimeNameForBasename(candidate.basename);
        if (!runtimeName) {
            diagnostics.push(`Ignoring invalid project-agent basename '${candidate.basename}'.`);
            continue;
        }
        if ((basenameCounts.get(candidate.basename) ?? 0) > 1) {
            tombstones.add(runtimeName);
            diagnostics.push(`Duplicate project-agent basename '${candidate.basename}' fails closed.`);
            continue;
        }
        const result = readCandidate(projectRoot, candidate, options);
        if (result.status === "unstable") {
            unstable = true;
            diagnostics.push(`${candidate.filePath}: ${result.reason}`);
            continue;
        }
        if (result.status === "invalid") {
            tombstones.add(runtimeName);
            diagnostics.push(`${candidate.filePath}: ${result.reason}`);
            continue;
        }
        entries.push(result.entry);
    }
    const after = collectCandidateInventory(projectRoot, options);
    if (unstable || after.status !== "ok" || !sameInventory(before, after)) {
        const instabilityDiagnostics = after.status === "ok"
            ? ["Project-agent candidate inventory changed during scan."]
            : after.diagnostics;
        return emptyScanResult(projectRoot, "unstable", [...diagnostics, ...instabilityDiagnostics]);
    }
    entries.sort((left, right) => left.agent.name.localeCompare(right.agent.name));
    const sortedTombstones = [...tombstones].sort((left, right) => left.localeCompare(right));
    return {
        status: "stable",
        projectRoot,
        agentsDirectory: path.join(projectRoot, PROJECT_AGENT_DIRECTORY),
        entries,
        tombstones: sortedTombstones,
        diagnostics,
        candidateCount: before.candidates.length,
        totalBytes: before.totalBytes,
    };
}
export function scanProjectAgentDefinitions(projectRoot, options = {}) {
    const fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
    let canonicalRoot;
    try {
        canonicalRoot = fileSystem.realpathSync(projectRoot);
        const rootStat = fileSystem.lstatSync(canonicalRoot);
        if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
            return emptyScanResult(projectRoot, "unavailable", [
                "Canonical project root is not a regular directory.",
            ]);
        }
    }
    catch (error) {
        return emptyScanResult(projectRoot, "unavailable", [
            `Unable to inspect canonical project root: ${errorMessage(error)}`,
        ]);
    }
    const scanOptions = {
        fileSystem,
        maxFileBytes: normalizeBound(options.maxFileBytes, MAX_PROJECT_AGENT_FILE_BYTES),
        maxFiles: normalizeBound(options.maxFiles, MAX_PROJECT_AGENT_FILES),
        maxTotalBytes: normalizeBound(options.maxTotalBytes, MAX_PROJECT_AGENT_TOTAL_BYTES),
        maxDepth: normalizeBound(options.maxDepth, MAX_PROJECT_AGENT_DEPTH),
        maxDirectories: normalizeBound(options.maxDirectories, MAX_PROJECT_AGENT_DIRECTORIES),
    };
    return scanProjectAgentsOnce(canonicalRoot, scanOptions);
}
function projectAgentDirectoryExists(projectRoot, fileSystem) {
    const tlhDirectory = path.join(projectRoot, ".tlh");
    const agentsDirectory = path.join(projectRoot, PROJECT_AGENT_DIRECTORY);
    try {
        const tlhStat = fileSystem.lstatSync(tlhDirectory);
        if (tlhStat.isSymbolicLink() || !tlhStat.isDirectory())
            return true;
        fileSystem.lstatSync(agentsDirectory);
        return true;
    }
    catch (error) {
        return !isErrno(error, "ENOENT");
    }
}
function registerLoadedProjectAgentSnapshot(projectRoot, options, trust, scan) {
    const generationId = typeof options.generationId === "string" && options.generationId.trim().length > 0
        ? options.generationId.trim()
        : randomUUID();
    const sessionId = options.sessionId.trim();
    const capability = registerProjectAgentSnapshot({
        projectRoot,
        sessionId,
        generationId,
        entries: scan.entries,
        tombstones: scan.tombstones,
    });
    const expected = getProjectAgentSnapshotProvenance(capability);
    const manifest = resolveProjectAgentSnapshot(capability, expected);
    return {
        status: "loaded",
        projectRoot,
        agentsDirectory: scan.agentsDirectory,
        capability,
        provenance: manifest.provenance,
        manifest,
        trust,
        scan,
        diagnostics: scan.diagnostics,
    };
}
function mergeTrustOptions(options) {
    return {
        ...options.trust,
        sessionId: options.trust?.sessionId ?? options.sessionId,
        agentDir: options.trust?.agentDir ?? options.agentDir,
        trustOverride: options.trust?.trustOverride ?? options.trustOverride,
        defaultProjectTrust: options.trust?.defaultProjectTrust ?? options.defaultProjectTrust,
        isProjectTrusted: options.trust?.isProjectTrusted ?? options.context?.isProjectTrusted,
        hasUI: options.trust?.hasUI ?? options.context?.hasUI,
        ui: options.trust?.ui ?? options.context?.ui,
        createProjectTrustStore: options.trust?.createProjectTrustStore ?? options.trustDependencies?.createProjectTrustStore,
        hasTrustRequiringProjectResources: options.trust?.hasTrustRequiringProjectResources ??
            options.trustDependencies?.hasTrustRequiringProjectResources,
    };
}
export async function loadProjectAgentSnapshot(options) {
    const fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
    const projectRoot = resolveCanonicalGitWorktreeRoot(options.cwd, {
        git: options.git,
        fileSystem,
    });
    if (!projectRoot) {
        return {
            status: "unavailable",
            diagnostics: ["Current directory is not inside a canonical Git worktree."],
        };
    }
    if (typeof options.sessionId !== "string" || options.sessionId.trim().length === 0) {
        return {
            status: "unavailable",
            projectRoot,
            diagnostics: ["Session identity is unavailable; project-agent loading is disabled."],
        };
    }
    const trustOptions = mergeTrustOptions(options);
    if (typeof trustOptions.hasTrustRequiringProjectResources !== "function" ||
        (typeof trustOptions.createProjectTrustStore !== "function" &&
            !isUsableTrustStore(trustOptions.trustStore))) {
        return {
            status: "unavailable",
            projectRoot,
            agentsDirectory: path.join(projectRoot, PROJECT_AGENT_DIRECTORY),
            diagnostics: ["Project-agent trust dependencies are unavailable; loading is disabled."],
        };
    }
    const projectAgentDirectoryPresent = projectAgentDirectoryExists(projectRoot, fileSystem);
    if (!projectAgentDirectoryPresent && trustOptions.trustOverride !== false) {
        let upstreamDenied = false;
        try {
            upstreamDenied = trustOptions.isProjectTrusted?.() === false;
        }
        catch {
            upstreamDenied = false;
        }
        if (upstreamDenied) {
            const trust = {
                trusted: false,
                source: "explicit-negative",
            };
            return {
                status: "denied",
                projectRoot,
                agentsDirectory: path.join(projectRoot, PROJECT_AGENT_DIRECTORY),
                trust,
                diagnostics: [`Project-agent loading denied (${trust.source}).`],
            };
        }
        const trust = {
            trusted: true,
            source: "no-project-agents",
        };
        return registerLoadedProjectAgentSnapshot(projectRoot, options, trust, emptyScanResult(projectRoot, "stable"));
    }
    const trust = await resolveProjectAgentTrust(projectRoot, trustOptions);
    if (!trust.trusted) {
        return {
            status: "denied",
            projectRoot,
            agentsDirectory: path.join(projectRoot, PROJECT_AGENT_DIRECTORY),
            trust,
            diagnostics: [`Project-agent loading denied (${trust.source}).`],
        };
    }
    const scanOptions = {
        fileSystem,
        maxFileBytes: options.maxFileBytes,
        maxFiles: options.maxFiles,
        maxTotalBytes: options.maxTotalBytes,
        maxDepth: options.maxDepth,
        maxDirectories: options.maxDirectories,
    };
    const maxAttempts = normalizeAttempts(options.maxAttempts);
    let scan = emptyScanResult(projectRoot, "unstable");
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        scan = scanProjectAgentDefinitions(projectRoot, scanOptions);
        if (scan.status !== "unstable")
            break;
    }
    if (scan.status !== "stable") {
        return {
            status: scan.status,
            projectRoot,
            agentsDirectory: scan.agentsDirectory,
            trust,
            scan,
            diagnostics: scan.diagnostics,
        };
    }
    return registerLoadedProjectAgentSnapshot(projectRoot, options, trust, scan);
}

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveValidatedGitWorktreeRoot, } from "../../../shared/project-agent-worktree.js";
import { getAgentDir } from "../shared/utils.js";
import { parseAgentDefinition } from "./agents.js";
import { resolveCustomAgentMaxExecutionTimeMs } from "./execution-ceiling.js";
export const PROJECT_AGENT_DIRECTORY = path.join(".tlh", "agents", "custom");
export const PROJECT_AGENT_PACKAGE = "embedded";
export const MAX_PROJECT_AGENT_FILE_BYTES = 64 * 1024;
const PROJECT_AGENT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PROJECT_AGENT_NAME_PATTERN = /^embedded\.([a-z0-9][a-z0-9-]*)$/;
const PROJECT_AGENT_FILE_PATTERN = /^[A-Z0-9][A-Z0-9-]*\.md$/;
const DEFAULT_FILE_SYSTEM = {
    lstatSync: (filePath) => fs.lstatSync(filePath),
    realpathSync: (filePath) => fs.realpathSync(filePath),
    readFileSync: (filePath) => fs.readFileSync(filePath),
    readdirSync: (directoryPath) => fs.readdirSync(directoryPath),
    openSync: (filePath, flags) => fs.openSync(filePath, flags),
    fstatSync: (fd) => fs.fstatSync(fd),
    readSync: (fd, buffer, offset, length, position) => fs.readSync(fd, buffer, offset, length, position),
    closeSync: (fd) => fs.closeSync(fd),
};
export class ProjectAgentDefinitionError extends Error {
    code = "INVALID_PROJECT_AGENT_DEFINITION";
    constructor(filePath, reason) {
        super(`Invalid TLH project agent '${filePath}': ${reason}`);
        this.name = "ProjectAgentDefinitionError";
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isErrno(error, code) {
    return (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === code);
}
function isPathWithin(parentPath, childPath) {
    const relativePath = path.relative(parentPath, childPath);
    return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}
function positiveIdentity(stat) {
    return (Number.isSafeInteger(stat.dev) && Number.isSafeInteger(stat.ino) && stat.dev > 0 && stat.ino > 0);
}
function canonicalExistingDirectory(value, label) {
    if (typeof value !== "string" || value.trim().length === 0) {
        return { valid: false, reason: `${label} must be an existing directory path.` };
    }
    try {
        const canonical = fs.realpathSync(value);
        const stat = fs.lstatSync(canonical);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            return { valid: false, reason: `${label} is not a directory: ${value}` };
        }
        return { valid: true, path: canonical };
    }
    catch {
        return { valid: false, reason: `${label} does not exist or cannot be resolved: ${value}` };
    }
}
export function validateProjectAgentCwdContainment(projectRoot, cwd, taskCwds = []) {
    const root = canonicalExistingDirectory(projectRoot, "Project root");
    if (!root.valid)
        return root;
    const execution = canonicalExistingDirectory(cwd, "Execution cwd");
    if (!execution.valid)
        return execution;
    if (!isPathWithin(root.path, execution.path)) {
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
        const task = canonicalExistingDirectory(taskPath, `Task ${index + 1} cwd`);
        if (!task.valid)
            return task;
        if (!isPathWithin(root.path, task.path)) {
            return {
                valid: false,
                reason: `Task ${index + 1} cwd is outside the canonical project root: ${taskPath}`,
            };
        }
        canonicalTaskCwds.push(task.path);
    }
    return {
        valid: true,
        canonicalRoot: root.path,
        canonicalCwd: execution.path,
        canonicalTaskCwds,
    };
}
export function resolveCanonicalGitWorktreeRoot(cwd, options = {}) {
    return resolveValidatedGitWorktreeRoot(cwd, {
        fileSystem: options.fileSystem ?? DEFAULT_FILE_SYSTEM,
    });
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
function usableTrustStore(value) {
    return (typeof value === "object" &&
        value !== null &&
        typeof value.getEntry === "function");
}
function defaultTrustStore(options) {
    if (options.trustStore !== undefined) {
        if (!usableTrustStore(options.trustStore)) {
            throw new Error("Project trust-store dependency returned an invalid store.");
        }
        return options.trustStore;
    }
    const agentDir = options.agentDir ?? getAgentDir();
    if (!fs.existsSync(path.join(agentDir, "trust.json")))
        return undefined;
    if (typeof options.createProjectTrustStore !== "function") {
        throw new Error("Project trust-store dependency is unavailable.");
    }
    const store = options.createProjectTrustStore(agentDir);
    if (!usableTrustStore(store)) {
        throw new Error("Project trust-store dependency returned an invalid store.");
    }
    return store;
}
export async function resolveProjectAgentTrust(projectRoot, options = {}) {
    if (options.trustOverride === false) {
        return { kind: "project-agent", trusted: false, source: "explicit-negative" };
    }
    try {
        const store = defaultTrustStore(options);
        if (!store)
            return { kind: "project-agent", trusted: false, source: "no-persisted-trust" };
        const entry = store.getEntry(projectRoot);
        if (entry !== null && typeof entry !== "object") {
            return { kind: "project-agent", trusted: false, source: "trust-store-error" };
        }
        if (entry && (typeof entry.path !== "string" || typeof entry.decision !== "boolean")) {
            return { kind: "project-agent", trusted: false, source: "trust-store-error" };
        }
        if (!entry)
            return { kind: "project-agent", trusted: false, source: "no-persisted-trust" };
        if (!trustEntryPathApplies(entry.path, projectRoot)) {
            return { kind: "project-agent", trusted: false, source: "trust-path-mismatch" };
        }
        return entry.decision
            ? { kind: "project-agent", trusted: true, source: "saved-positive" }
            : { kind: "project-agent", trusted: false, source: "saved-negative" };
    }
    catch {
        return { kind: "project-agent", trusted: false, source: "trust-store-error" };
    }
}
function mergeTrustOptions(options) {
    const trust = options.trust ?? {};
    return {
        ...trust,
        agentDir: trust.agentDir ?? options.agentDir,
        trustStore: trust.trustStore ?? options.trustStore,
        trustOverride: trust.trustOverride ?? options.trustOverride,
        createProjectTrustStore: trust.createProjectTrustStore ?? options.trustDependencies?.createProjectTrustStore,
    };
}
function rejectInvalidSlug(slug) {
    if (typeof slug !== "string" || !PROJECT_AGENT_SLUG_PATTERN.test(slug)) {
        throw new ProjectAgentDefinitionError(`${PROJECT_AGENT_PACKAGE}.${String(slug)}`, "embedded target slug must be lowercase ASCII letters, digits, and hyphens");
    }
}
function expectedDefinitionPath(projectRoot, slug) {
    return path.join(projectRoot, PROJECT_AGENT_DIRECTORY, `${slug.toUpperCase()}.md`);
}
function requireExactDirectoryEntry(fileSystem, parentPath, entryName, label) {
    try {
        if (fileSystem.readdirSync(parentPath).includes(entryName))
            return;
        throw new ProjectAgentDefinitionError(path.join(parentPath, entryName), `${label} does not exist`);
    }
    catch (error) {
        if (error instanceof ProjectAgentDefinitionError)
            throw error;
        throw new ProjectAgentDefinitionError(path.join(parentPath, entryName), isErrno(error, "ENOENT") ? `${label} does not exist` : `${label} cannot be inspected`);
    }
}
function sameFileIdentity(left, right) {
    return (positiveIdentity(left) &&
        positiveIdentity(right) &&
        left.dev === right.dev &&
        left.ino === right.ino);
}
function inspectFixedDirectory(fileSystem, projectRoot, directoryPath, label) {
    if (directoryPath !== projectRoot) {
        requireExactDirectoryEntry(fileSystem, path.dirname(directoryPath), path.basename(directoryPath), label);
    }
    let stat;
    try {
        stat = fileSystem.lstatSync(directoryPath);
    }
    catch (error) {
        throw new ProjectAgentDefinitionError(directoryPath, isErrno(error, "ENOENT")
            ? `${label} does not exist`
            : `${label} cannot be inspected: ${errorMessage(error)}`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || !positiveIdentity(stat)) {
        throw new ProjectAgentDefinitionError(directoryPath, `${label} must be a regular non-symlink directory`);
    }
    let canonical;
    try {
        canonical = fileSystem.realpathSync(directoryPath);
    }
    catch (error) {
        throw new ProjectAgentDefinitionError(directoryPath, `${label} cannot be canonicalized: ${errorMessage(error)}`);
    }
    if (!isPathWithin(projectRoot, canonical)) {
        throw new ProjectAgentDefinitionError(directoryPath, `${label} is outside the Git worktree`);
    }
    return stat;
}
function inspectFixedLayout(fileSystem, projectRoot, filePath) {
    return [
        [projectRoot, "Git worktree root"],
        [path.join(projectRoot, ".tlh"), ".tlh"],
        [path.join(projectRoot, ".tlh", "agents"), ".tlh/agents"],
        [path.dirname(filePath), PROJECT_AGENT_DIRECTORY],
    ].map(([directoryPath, label]) => inspectFixedDirectory(fileSystem, projectRoot, directoryPath, label));
}
function validateDefinitionFileStat(filePath, stat) {
    if (stat.isSymbolicLink() || !stat.isFile() || !positiveIdentity(stat)) {
        throw new ProjectAgentDefinitionError(filePath, "definition file must be a regular non-symlink file");
    }
    if (!Number.isSafeInteger(stat.size) ||
        stat.size < 0 ||
        stat.size > MAX_PROJECT_AGENT_FILE_BYTES) {
        throw new ProjectAgentDefinitionError(filePath, `definition file exceeds ${MAX_PROJECT_AGENT_FILE_BYTES} bytes`);
    }
}
function readFixedDefinition(projectRoot, slug, fileSystem) {
    const filePath = expectedDefinitionPath(projectRoot, slug);
    const initialDirectories = inspectFixedLayout(fileSystem, projectRoot, filePath);
    requireExactDirectoryEntry(fileSystem, path.dirname(filePath), path.basename(filePath), "definition file");
    if (!PROJECT_AGENT_FILE_PATTERN.test(path.basename(filePath))) {
        throw new ProjectAgentDefinitionError(filePath, "definition filename is not canonical");
    }
    const { noFollow, nonBlocking } = fileSystem.secureOpenFlags ?? {
        noFollow: fs.constants.O_NOFOLLOW,
        nonBlocking: fs.constants.O_NONBLOCK,
    };
    if (typeof noFollow !== "number" ||
        !Number.isSafeInteger(noFollow) ||
        noFollow <= 0 ||
        typeof nonBlocking !== "number" ||
        !Number.isSafeInteger(nonBlocking) ||
        nonBlocking <= 0) {
        throw new ProjectAgentDefinitionError(filePath, "secure definition-file access is unavailable");
    }
    let fd;
    try {
        fd = fileSystem.openSync(filePath, fs.constants.O_RDONLY | noFollow | nonBlocking);
        const descriptorStat = fileSystem.fstatSync(fd);
        validateDefinitionFileStat(filePath, descriptorStat);
        const currentDirectories = inspectFixedLayout(fileSystem, projectRoot, filePath);
        if (currentDirectories.some((stat, index) => !sameFileIdentity(stat, initialDirectories[index]))) {
            throw new ProjectAgentDefinitionError(filePath, "definition parent directory changed during access");
        }
        let pathStat;
        try {
            pathStat = fileSystem.lstatSync(filePath);
        }
        catch {
            throw new ProjectAgentDefinitionError(filePath, "definition file cannot be inspected safely");
        }
        validateDefinitionFileStat(filePath, pathStat);
        if (!sameFileIdentity(pathStat, descriptorStat)) {
            throw new ProjectAgentDefinitionError(filePath, "definition file changed during access");
        }
        let canonicalFile;
        try {
            canonicalFile = fileSystem.realpathSync(filePath);
        }
        catch {
            throw new ProjectAgentDefinitionError(filePath, "definition file cannot be canonicalized safely");
        }
        if (!isPathWithin(projectRoot, canonicalFile) ||
            path.dirname(canonicalFile) !== path.dirname(filePath)) {
            throw new ProjectAgentDefinitionError(filePath, "definition file is outside the custom-agent directory");
        }
        const buffer = Buffer.alloc(MAX_PROJECT_AGENT_FILE_BYTES + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.byteLength) {
            const count = fileSystem.readSync(fd, buffer, bytesRead, buffer.byteLength - bytesRead, null);
            if (!Number.isSafeInteger(count) || count < 0 || count > buffer.byteLength - bytesRead) {
                throw new Error("invalid secure definition-file read result");
            }
            if (count === 0)
                break;
            bytesRead += count;
        }
        const finalStat = fileSystem.fstatSync(fd);
        if (bytesRead > MAX_PROJECT_AGENT_FILE_BYTES || finalStat.size > MAX_PROJECT_AGENT_FILE_BYTES) {
            throw new ProjectAgentDefinitionError(filePath, `definition file exceeds ${MAX_PROJECT_AGENT_FILE_BYTES} bytes`);
        }
        const bytes = Buffer.from(buffer.subarray(0, bytesRead));
        fileSystem.closeSync(fd);
        fd = undefined;
        try {
            new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        }
        catch (error) {
            throw new ProjectAgentDefinitionError(filePath, `definition file is not valid UTF-8: ${errorMessage(error)}`);
        }
        return { filePath, bytes };
    }
    catch (error) {
        if (fd !== undefined) {
            try {
                fileSystem.closeSync(fd);
            }
            catch {
            }
        }
        if (error instanceof ProjectAgentDefinitionError)
            throw error;
        if (isErrno(error, "ELOOP")) {
            throw new ProjectAgentDefinitionError(filePath, "definition file must be a regular non-symlink file");
        }
        throw new ProjectAgentDefinitionError(filePath, "definition file could not be read securely");
    }
}
export function parseProjectAgentDefinition(filePath, content) {
    const text = Buffer.isBuffer(content)
        ? new TextDecoder("utf-8", { fatal: true }).decode(content)
        : content;
    const agent = parseAgentDefinition(text, "project", filePath);
    if (!agent)
        throw new ProjectAgentDefinitionError(filePath, "frontmatter is required");
    agent.maxExecutionTimeMs = resolveCustomAgentMaxExecutionTimeMs(agent.maxExecutionTimeMs);
    return agent;
}
function validateLoadedAgent(filePath, slug, projectRoot, agent) {
    const expectedName = `${PROJECT_AGENT_PACKAGE}.${slug}`;
    if (agent.name !== expectedName ||
        agent.localName !== slug ||
        agent.packageName !== PROJECT_AGENT_PACKAGE ||
        agent.source !== "project") {
        throw new ProjectAgentDefinitionError(filePath, `frontmatter name/package must identify '${expectedName}' exactly`);
    }
    if (typeof agent.description !== "string" || agent.description.trim().length === 0) {
        throw new ProjectAgentDefinitionError(filePath, "description must be non-empty");
    }
    if (!Array.isArray(agent.tools) || agent.tools.length === 0) {
        throw new ProjectAgentDefinitionError(filePath, "tools must declare at least one usable tool");
    }
    if (agent.extensions !== undefined || agent.subagentOnlyExtensions !== undefined) {
        throw new ProjectAgentDefinitionError(filePath, "extensions and subagentOnlyExtensions are prohibited for project agents");
    }
    if (agent.filePath !== filePath || filePath !== expectedDefinitionPath(projectRoot, slug)) {
        throw new ProjectAgentDefinitionError(filePath, "definition path is not canonical");
    }
}
export async function loadProjectAgent(options) {
    rejectInvalidSlug(options.slug);
    const fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
    const projectRoot = resolveCanonicalGitWorktreeRoot(options.cwd, { fileSystem });
    if (!projectRoot) {
        throw new ProjectAgentDefinitionError(options.cwd, "cwd is not inside a validated Git worktree");
    }
    const cwd = validateProjectAgentCwdContainment(projectRoot, options.cwd);
    if (!cwd.valid)
        throw new ProjectAgentDefinitionError(options.cwd, cwd.reason);
    const trustOptions = mergeTrustOptions(options);
    const trust = await resolveProjectAgentTrust(projectRoot, trustOptions);
    if (!trust.trusted) {
        const trustReason = trust.source === "trust-store-error" &&
            trustOptions.trustStore === undefined &&
            trustOptions.createProjectTrustStore === undefined
            ? "trust-store dependency is unavailable"
            : `project trust is not persisted (${trust.source})`;
        throw new ProjectAgentDefinitionError(expectedDefinitionPath(projectRoot, options.slug), trustReason);
    }
    const { filePath, bytes } = readFixedDefinition(projectRoot, options.slug, fileSystem);
    const agent = parseProjectAgentDefinition(filePath, bytes);
    validateLoadedAgent(filePath, options.slug, projectRoot, agent);
    return {
        agent,
        identity: Object.freeze({ slug: options.slug, root: projectRoot, cwd: cwd.canonicalCwd }),
        trust,
    };
}
export function normalizeProjectAgentIdentity(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    const raw = value;
    if (typeof raw.slug !== "string" ||
        !PROJECT_AGENT_SLUG_PATTERN.test(raw.slug) ||
        typeof raw.root !== "string" ||
        raw.root.trim().length === 0 ||
        typeof raw.cwd !== "string" ||
        raw.cwd.trim().length === 0) {
        return undefined;
    }
    return { slug: raw.slug, root: raw.root, cwd: raw.cwd };
}
export function embeddedSlugFromName(value) {
    if (typeof value !== "string")
        return undefined;
    const match = PROJECT_AGENT_NAME_PATTERN.exec(value);
    return match?.[1];
}
export function isEmbeddedProjectAgentName(value) {
    return embeddedSlugFromName(value) !== undefined;
}

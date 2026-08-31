import * as fs from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { findValidatedGitWorktree, } from "./project-agent-worktree.js";
import { getAgentDir, ProjectTrustStore, } from "@earendil-works/pi-coding-agent";
export { resolveValidatedGitWorktreeRoot } from "./project-agent-worktree.js";
export const PROJECT_AGENT_GUIDANCE_MAX_BYTES = 64 * 1024;
export const PROJECT_AGENT_GUIDANCE_DIRECTORY = ".tlh";
const PROJECT_AGENT_GUIDANCE_AGENTS_DIRECTORY = "agents";
const PROJECT_AGENT_GUIDANCE_BUILTIN_DIRECTORY = "builtin";
export const PACKAGED_PRIMARY_AGENT_ROLES = ["architect", "rush", "product", "bug-hunter"];
export const PACKAGED_MINOR_AGENT_ROLES = [
    "developer",
    "test-runner",
    "code-reviewer",
    "repo-scout",
    "diff-summarizer",
    "librarian",
    "web-scout",
    "oracle",
    "contrarian",
];
export const PROJECT_AGENT_GUIDANCE_ROLES = [
    ...PACKAGED_PRIMARY_AGENT_ROLES,
    ...PACKAGED_MINOR_AGENT_ROLES,
];
const ROLE_FILENAMES = {
    architect: "ARCHITECT_PROMPT_APPEND.md",
    rush: "RUSH_PROMPT_APPEND.md",
    product: "PRODUCT_PROMPT_APPEND.md",
    "bug-hunter": "BUG-HUNTER_PROMPT_APPEND.md",
    developer: "DEVELOPER_PROMPT_APPEND.md",
    "test-runner": "TEST-RUNNER_PROMPT_APPEND.md",
    "code-reviewer": "CODE-REVIEWER_PROMPT_APPEND.md",
    "repo-scout": "REPO-SCOUT_PROMPT_APPEND.md",
    "diff-summarizer": "DIFF-SUMMARIZER_PROMPT_APPEND.md",
    librarian: "LIBRARIAN_PROMPT_APPEND.md",
    "web-scout": "WEB-SCOUT_PROMPT_APPEND.md",
    oracle: "ORACLE_PROMPT_APPEND.md",
    contrarian: "CONTRARIAN_PROMPT_APPEND.md",
};
export const PROJECT_GUIDANCE_OPEN_DELIMITER = "<tlh_project_agent_guidance>";
export const PROJECT_GUIDANCE_CLOSE_DELIMITER = "</tlh_project_agent_guidance>";
function errorCode(error) {
    if (typeof error !== "object" || error === null || !("code" in error))
        return undefined;
    const code = error.code;
    return typeof code === "string" ? code : undefined;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isMissingError(error) {
    return errorCode(error) === "ENOENT";
}
function pushDiagnostic(diagnostics, diagnostic) {
    diagnostics.push(diagnostic);
}
function resolveInputPath(value, label, diagnostics) {
    if (typeof value !== "string" || value.trim().length === 0) {
        pushDiagnostic(diagnostics, {
            code: label === "cwd" ? "invalid-cwd" : "invalid-agent-dir",
            message: `Project-agent guidance ${label} must be a non-empty path.`,
        });
        return undefined;
    }
    try {
        const resolved = resolve(value);
        if (resolved.includes("\0")) {
            throw new Error("path contains a NUL byte");
        }
        return resolved;
    }
    catch (error) {
        pushDiagnostic(diagnostics, {
            code: label === "cwd" ? "invalid-cwd" : "invalid-agent-dir",
            message: `Could not resolve project-agent guidance ${label} '${value}': ${errorMessage(error)}`,
        });
        return undefined;
    }
}
function findGitWorktree(cwd) {
    return findValidatedGitWorktree(cwd);
}
function searchDirectories(cwd, worktreeRoot) {
    if (!worktreeRoot)
        return [cwd];
    const directories = [];
    let current = cwd;
    while (true) {
        directories.push(current);
        if (current === worktreeRoot)
            return directories;
        const parent = dirname(current);
        if (parent === current)
            return [cwd];
        current = parent;
    }
}
function checkGuidanceDirectory(directory, diagnostics) {
    const guidanceRoot = join(directory, PROJECT_AGENT_GUIDANCE_DIRECTORY);
    let parentEntries;
    try {
        parentEntries = fs.readdirSync(directory);
    }
    catch (error) {
        if (isMissingError(error))
            return { status: "missing" };
        pushDiagnostic(diagnostics, {
            code: "directory-inspection-failed",
            message: `Could not inspect project-agent guidance directory '${guidanceRoot}': ${errorMessage(error)}`,
            path: guidanceRoot,
        });
        return { status: "blocked" };
    }
    if (!parentEntries.includes(PROJECT_AGENT_GUIDANCE_DIRECTORY)) {
        return { status: "missing" };
    }
    let tlhStat;
    try {
        tlhStat = fs.lstatSync(guidanceRoot);
    }
    catch (error) {
        if (isMissingError(error))
            return { status: "missing" };
        pushDiagnostic(diagnostics, {
            code: "directory-inspection-failed",
            message: `Could not inspect project-agent guidance directory '${guidanceRoot}': ${errorMessage(error)}`,
            path: guidanceRoot,
        });
        return { status: "blocked" };
    }
    if (tlhStat.isSymbolicLink()) {
        pushDiagnostic(diagnostics, {
            code: "symlink-directory",
            message: `Project-agent guidance directory '${guidanceRoot}' is a symlink; refusing to inspect it. Use a real '.tlh' directory containing 'agents/builtin'.`,
            path: guidanceRoot,
        });
        return { status: "blocked" };
    }
    if (!tlhStat.isDirectory()) {
        pushDiagnostic(diagnostics, {
            code: "invalid-directory",
            message: `Project-agent guidance path '${guidanceRoot}' is not a directory; refusing to inspect it.`,
            path: guidanceRoot,
        });
        return { status: "blocked" };
    }
    let tlhEntries;
    try {
        tlhEntries = fs.readdirSync(guidanceRoot);
    }
    catch (error) {
        pushDiagnostic(diagnostics, {
            code: "directory-inspection-failed",
            message: `Could not inspect project-agent guidance directory '${guidanceRoot}': ${errorMessage(error)}`,
            path: guidanceRoot,
        });
        return { status: "blocked" };
    }
    if (!tlhEntries.includes(PROJECT_AGENT_GUIDANCE_AGENTS_DIRECTORY)) {
        return { status: "missing" };
    }
    const agentsDirectory = join(guidanceRoot, PROJECT_AGENT_GUIDANCE_AGENTS_DIRECTORY);
    let agentsStat;
    try {
        agentsStat = fs.lstatSync(agentsDirectory);
    }
    catch (error) {
        if (isMissingError(error))
            return { status: "missing" };
        pushDiagnostic(diagnostics, {
            code: "directory-inspection-failed",
            message: `Could not inspect project-agent guidance directory '${agentsDirectory}': ${errorMessage(error)}`,
            path: agentsDirectory,
        });
        return { status: "blocked" };
    }
    if (agentsStat.isSymbolicLink()) {
        pushDiagnostic(diagnostics, {
            code: "symlink-directory",
            message: `Project-agent guidance directory '${agentsDirectory}' is a symlink; refusing to inspect it. Use a real '.tlh/agents' directory.`,
            path: agentsDirectory,
        });
        return { status: "blocked" };
    }
    if (!agentsStat.isDirectory()) {
        pushDiagnostic(diagnostics, {
            code: "invalid-directory",
            message: `Project-agent guidance path '${agentsDirectory}' is not a directory; refusing to inspect it.`,
            path: agentsDirectory,
        });
        return { status: "blocked" };
    }
    let agentsEntries;
    try {
        agentsEntries = fs.readdirSync(agentsDirectory);
    }
    catch (error) {
        pushDiagnostic(diagnostics, {
            code: "directory-inspection-failed",
            message: `Could not inspect project-agent guidance directory '${agentsDirectory}': ${errorMessage(error)}`,
            path: agentsDirectory,
        });
        return { status: "blocked" };
    }
    if (!agentsEntries.includes(PROJECT_AGENT_GUIDANCE_BUILTIN_DIRECTORY)) {
        return { status: "missing" };
    }
    const builtinDirectory = join(agentsDirectory, PROJECT_AGENT_GUIDANCE_BUILTIN_DIRECTORY);
    let builtinStat;
    try {
        builtinStat = fs.lstatSync(builtinDirectory);
    }
    catch (error) {
        if (isMissingError(error))
            return { status: "missing" };
        pushDiagnostic(diagnostics, {
            code: "directory-inspection-failed",
            message: `Could not inspect project-agent guidance directory '${builtinDirectory}': ${errorMessage(error)}`,
            path: builtinDirectory,
        });
        return { status: "blocked" };
    }
    if (builtinStat.isSymbolicLink()) {
        pushDiagnostic(diagnostics, {
            code: "symlink-directory",
            message: `Project-agent guidance directory '${builtinDirectory}' is a symlink; refusing to inspect it. Use a real '.tlh/agents/builtin' directory.`,
            path: builtinDirectory,
        });
        return { status: "blocked" };
    }
    if (!builtinStat.isDirectory()) {
        pushDiagnostic(diagnostics, {
            code: "invalid-directory",
            message: `Project-agent guidance path '${builtinDirectory}' is not a directory; refusing to inspect it.`,
            path: builtinDirectory,
        });
        return { status: "blocked" };
    }
    let builtinEntries;
    try {
        builtinEntries = fs.readdirSync(builtinDirectory);
    }
    catch (error) {
        pushDiagnostic(diagnostics, {
            code: "directory-inspection-failed",
            message: `Could not inspect project-agent guidance directory '${builtinDirectory}': ${errorMessage(error)}`,
            path: builtinDirectory,
        });
        return { status: "blocked" };
    }
    return {
        status: "valid",
        entries: new Set(builtinEntries),
        identities: {
            tlh: fileIdentity(tlhStat),
            agents: fileIdentity(agentsStat),
            builtin: fileIdentity(builtinStat),
        },
    };
}
function canonicalPathForCompare(value) {
    try {
        return fs.realpathSync(value);
    }
    catch {
        return resolve(value);
    }
}
function strictCanonicalPath(value) {
    try {
        return fs.realpathSync(value);
    }
    catch {
        return undefined;
    }
}
function isCanonicalPathWithin(parentPath, childPath) {
    const childRelative = relative(parentPath, childPath);
    return (childRelative === "" ||
        (childRelative !== ".." && !childRelative.startsWith(`..${sep}`) && !isAbsolute(childRelative)));
}
function fileIdentity(stat) {
    if (!Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino) || stat.ino <= 0) {
        return undefined;
    }
    return { dev: stat.dev, ino: stat.ino };
}
function sameFileIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
function isPathWithin(parentPath, childPath) {
    const childRelative = relative(canonicalPathForCompare(parentPath), canonicalPathForCompare(childPath));
    return (childRelative === "" ||
        (childRelative !== ".." && !childRelative.startsWith(`..${sep}`) && !isAbsolute(childRelative)));
}
function scanRoleCandidates(role, directories, diagnostics, directoryChecks) {
    const filename = ROLE_FILENAMES[role];
    for (const directory of directories) {
        let directoryCheck = directoryChecks.get(directory);
        if (directoryCheck === undefined) {
            directoryCheck = checkGuidanceDirectory(directory, diagnostics);
            directoryChecks.set(directory, directoryCheck);
        }
        if (directoryCheck.status === "missing")
            continue;
        if (directoryCheck.status === "blocked")
            return {};
        if (!directoryCheck.entries?.has(filename))
            continue;
        const builtinDirectory = join(directory, PROJECT_AGENT_GUIDANCE_DIRECTORY, PROJECT_AGENT_GUIDANCE_AGENTS_DIRECTORY, PROJECT_AGENT_GUIDANCE_BUILTIN_DIRECTORY);
        const filePath = join(builtinDirectory, filename);
        let stat;
        try {
            stat = fs.lstatSync(filePath);
        }
        catch (error) {
            if (!isMissingError(error)) {
                pushDiagnostic(diagnostics, {
                    code: "file-inspection-failed",
                    message: `Could not inspect project-agent guidance file '${filePath}': ${errorMessage(error)}`,
                    path: filePath,
                    role,
                });
            }
            return {};
        }
        if (stat.isSymbolicLink()) {
            pushDiagnostic(diagnostics, {
                code: "symlink-file",
                message: `Project-agent guidance file '${filePath}' is a symlink; refusing to read it. Replace it with a regular file.`,
                path: filePath,
                role,
            });
            return {};
        }
        if (!stat.isFile()) {
            pushDiagnostic(diagnostics, {
                code: "non-regular-file",
                message: `Project-agent guidance path '${filePath}' is not a regular file; refusing to read it.`,
                path: filePath,
                role,
            });
            return {};
        }
        if (stat.size > PROJECT_AGENT_GUIDANCE_MAX_BYTES) {
            pushDiagnostic(diagnostics, {
                code: "file-too-large",
                message: `Project-agent guidance file '${filePath}' is larger than ${PROJECT_AGENT_GUIDANCE_MAX_BYTES} bytes (64 KiB); refusing to read it.`,
                path: filePath,
                role,
            });
            return {};
        }
        return {
            candidate: {
                role,
                path: filePath,
                guidanceDirectoryIdentities: directoryCheck.identities,
            },
        };
    }
    return {};
}
function addFileReadFailure(diagnostics, candidate, detail) {
    pushDiagnostic(diagnostics, {
        code: "file-read-failed",
        message: `Could not safely read project-agent guidance file '${candidate.path}': ${detail}`,
        path: candidate.path,
        role: candidate.role,
    });
}
function readGuidanceFileCore(candidate, trustBoundaryPath, diagnostics, noFollowFlag) {
    let descriptor;
    try {
        const noFollow = noFollowFlag;
        if (typeof noFollow !== "number" || noFollow === 0) {
            addFileReadFailure(diagnostics, candidate, "the O_NOFOLLOW open flag is unavailable; refusing an unbound path read");
            return undefined;
        }
        descriptor = fs.openSync(candidate.path, fs.constants.O_RDONLY | noFollow);
        const builtinDirectory = dirname(candidate.path);
        const agentsDirectory = dirname(builtinDirectory);
        const tlhDirectory = dirname(agentsDirectory);
        const expectedDirectoryIdentities = candidate.guidanceDirectoryIdentities;
        const directoryChecks = [
            { label: ".tlh", path: tlhDirectory, identity: expectedDirectoryIdentities?.tlh },
            {
                label: ".tlh/agents",
                path: agentsDirectory,
                identity: expectedDirectoryIdentities?.agents,
            },
            {
                label: ".tlh/agents/builtin",
                path: builtinDirectory,
                identity: expectedDirectoryIdentities?.builtin,
            },
        ];
        for (const directoryCheck of directoryChecks) {
            const stat = fs.lstatSync(directoryCheck.path);
            if (stat.isSymbolicLink()) {
                pushDiagnostic(diagnostics, {
                    code: "symlink-directory",
                    message: `Project-agent guidance directory '${directoryCheck.path}' became a symlink before the file could be read; refusing to inspect it.`,
                    path: directoryCheck.path,
                    role: candidate.role,
                });
                return undefined;
            }
            if (!stat.isDirectory()) {
                pushDiagnostic(diagnostics, {
                    code: "invalid-directory",
                    message: `Project-agent guidance path '${directoryCheck.path}' is no longer a directory; refusing to inspect it.`,
                    path: directoryCheck.path,
                    role: candidate.role,
                });
                return undefined;
            }
            const currentIdentity = fileIdentity(stat);
            if (!directoryCheck.identity || !currentIdentity) {
                addFileReadFailure(diagnostics, candidate, `the ${directoryCheck.label} directory identity could not be proven`);
                return undefined;
            }
            if (!sameFileIdentity(directoryCheck.identity, currentIdentity)) {
                addFileReadFailure(diagnostics, candidate, `the ${directoryCheck.label} directory changed while the file was being opened`);
                return undefined;
            }
        }
        const pathStat = fs.lstatSync(candidate.path);
        if (pathStat.isSymbolicLink()) {
            pushDiagnostic(diagnostics, {
                code: "symlink-file",
                message: `Project-agent guidance file '${candidate.path}' became a symlink before it could be read; refusing to read it.`,
                path: candidate.path,
                role: candidate.role,
            });
            return undefined;
        }
        if (!pathStat.isFile()) {
            pushDiagnostic(diagnostics, {
                code: "non-regular-file",
                message: `Project-agent guidance file '${candidate.path}' is no longer a regular file; refusing to read it.`,
                path: candidate.path,
                role: candidate.role,
            });
            return undefined;
        }
        const canonicalTrustBoundary = strictCanonicalPath(trustBoundaryPath);
        if (!canonicalTrustBoundary || canonicalTrustBoundary !== trustBoundaryPath) {
            addFileReadFailure(diagnostics, candidate, "the persisted trust boundary could not be strictly canonicalized");
            return undefined;
        }
        const canonicalTlhDirectory = strictCanonicalPath(tlhDirectory);
        const canonicalAgentsDirectory = strictCanonicalPath(agentsDirectory);
        const canonicalBuiltinDirectory = strictCanonicalPath(builtinDirectory);
        const canonicalCandidatePath = strictCanonicalPath(candidate.path);
        if (!canonicalTlhDirectory ||
            !canonicalAgentsDirectory ||
            !canonicalBuiltinDirectory ||
            !canonicalCandidatePath) {
            addFileReadFailure(diagnostics, candidate, "the guidance directories and file could not be strictly canonicalized");
            return undefined;
        }
        if (!isCanonicalPathWithin(canonicalTrustBoundary, canonicalTlhDirectory) ||
            !isCanonicalPathWithin(canonicalTrustBoundary, canonicalAgentsDirectory) ||
            !isCanonicalPathWithin(canonicalTrustBoundary, canonicalBuiltinDirectory) ||
            !isCanonicalPathWithin(canonicalTrustBoundary, canonicalCandidatePath)) {
            pushDiagnostic(diagnostics, {
                code: "source-outside-trusted-subtree",
                message: `Skipped project-agent guidance file '${candidate.path}' because its opened path is outside the persisted trusted subtree '${trustBoundaryPath}'. Run \`/trust\` for the source project path, persist that decision, then run \`/reload\` or restart.`,
                path: candidate.path,
                role: candidate.role,
            });
            return undefined;
        }
        if (dirname(canonicalAgentsDirectory) !== canonicalTlhDirectory ||
            dirname(canonicalBuiltinDirectory) !== canonicalAgentsDirectory ||
            dirname(canonicalCandidatePath) !== canonicalBuiltinDirectory) {
            addFileReadFailure(diagnostics, candidate, "the opened file no longer resolves directly under its validated .tlh/agents/builtin directory");
            return undefined;
        }
        const descriptorStat = fs.fstatSync(descriptor);
        if (!descriptorStat.isFile()) {
            pushDiagnostic(diagnostics, {
                code: "non-regular-file",
                message: `Project-agent guidance file '${candidate.path}' is not a regular file; refusing to read it.`,
                path: candidate.path,
                role: candidate.role,
            });
            return undefined;
        }
        const currentPathLstat = fs.lstatSync(candidate.path);
        if (currentPathLstat.isSymbolicLink()) {
            pushDiagnostic(diagnostics, {
                code: "symlink-file",
                message: `Project-agent guidance file '${candidate.path}' became a symlink before it could be read; refusing to read it.`,
                path: candidate.path,
                role: candidate.role,
            });
            return undefined;
        }
        if (!currentPathLstat.isFile()) {
            pushDiagnostic(diagnostics, {
                code: "non-regular-file",
                message: `Project-agent guidance file '${candidate.path}' is no longer a regular file; refusing to read it.`,
                path: candidate.path,
                role: candidate.role,
            });
            return undefined;
        }
        const currentPathStat = fs.statSync(canonicalCandidatePath);
        if (!currentPathStat.isFile()) {
            pushDiagnostic(diagnostics, {
                code: "non-regular-file",
                message: `Project-agent guidance file '${candidate.path}' no longer resolves to a regular file; refusing to read it.`,
                path: candidate.path,
                role: candidate.role,
            });
            return undefined;
        }
        const descriptorIdentity = fileIdentity(descriptorStat);
        const currentPathIdentity = fileIdentity(currentPathStat);
        if (!descriptorIdentity || !currentPathIdentity) {
            addFileReadFailure(diagnostics, candidate, "opened-file identity could not be proven");
            return undefined;
        }
        if (!sameFileIdentity(descriptorIdentity, currentPathIdentity)) {
            addFileReadFailure(diagnostics, candidate, "the opened file no longer matches the currently resolved path");
            return undefined;
        }
        if (descriptorStat.size > PROJECT_AGENT_GUIDANCE_MAX_BYTES) {
            pushDiagnostic(diagnostics, {
                code: "file-too-large",
                message: `Project-agent guidance file '${candidate.path}' is larger than ${PROJECT_AGENT_GUIDANCE_MAX_BYTES} bytes (64 KiB); refusing to read it.`,
                path: candidate.path,
                role: candidate.role,
            });
            return undefined;
        }
        const chunks = [];
        let bytesRead = 0;
        while (bytesRead <= PROJECT_AGENT_GUIDANCE_MAX_BYTES) {
            const remaining = PROJECT_AGENT_GUIDANCE_MAX_BYTES + 1 - bytesRead;
            if (remaining <= 0)
                break;
            const buffer = Buffer.allocUnsafe(Math.min(8192, remaining));
            const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
            if (count === 0)
                break;
            chunks.push(buffer.subarray(0, count));
            bytesRead += count;
            if (bytesRead > PROJECT_AGENT_GUIDANCE_MAX_BYTES) {
                pushDiagnostic(diagnostics, {
                    code: "file-too-large",
                    message: `Project-agent guidance file '${candidate.path}' grew beyond ${PROJECT_AGENT_GUIDANCE_MAX_BYTES} bytes (64 KiB) while being read; refusing to use it.`,
                    path: candidate.path,
                    role: candidate.role,
                });
                return undefined;
            }
        }
        const content = Buffer.concat(chunks, bytesRead).toString("utf8");
        return content.trim().length === 0 ? "" : content;
    }
    catch (error) {
        if (errorCode(error) === "ELOOP") {
            pushDiagnostic(diagnostics, {
                code: "symlink-file",
                message: `Project-agent guidance file '${candidate.path}' is a symlink; refusing to read it. Replace it with a regular file.`,
                path: candidate.path,
                role: candidate.role,
            });
        }
        else {
            pushDiagnostic(diagnostics, {
                code: "file-read-failed",
                message: `Could not read project-agent guidance file '${candidate.path}': ${errorMessage(error)}`,
                path: candidate.path,
                role: candidate.role,
            });
        }
        return undefined;
    }
    finally {
        if (descriptor !== undefined) {
            try {
                fs.closeSync(descriptor);
            }
            catch {
            }
        }
    }
}
function readGuidanceFile(candidate, trustBoundaryPath, diagnostics) {
    return readGuidanceFileCore(candidate, trustBoundaryPath, diagnostics, fs.constants.O_NOFOLLOW);
}
function trustState(decision) {
    if (decision === true)
        return "trusted";
    if (decision === false)
        return "denied";
    return "undecided";
}
function inspectProjectTrust(cwd, agentDir, diagnostics) {
    try {
        const entry = new ProjectTrustStore(agentDir).getEntry(cwd);
        const decision = entry?.decision ?? null;
        return {
            state: trustState(decision),
            decision,
            entryPath: entry?.path,
        };
    }
    catch (error) {
        pushDiagnostic(diagnostics, {
            code: "trust-inspection-failed",
            message: `Could not inspect persisted project trust for '${cwd}': ${errorMessage(error)} Project-agent guidance remains disabled until a readable trust decision is available. Run \`/trust\`, persist the decision, then run \`/reload\` or restart.`,
            path: agentDir,
        });
        return { state: "unavailable", decision: null };
    }
}
function addTrustDiagnostic(inventory) {
    if (inventory.trust === "trusted" || inventory.trust === "unavailable")
        return;
    const detail = inventory.trust === "denied"
        ? "persisted project trust is denied"
        : "no persisted project trust decision was found";
    pushDiagnostic(inventory.diagnostics, {
        code: "project-not-trusted",
        message: `Project-agent guidance is disabled because ${detail} for '${inventory.cwd}'. Run \`/trust\`, persist the decision, then run \`/reload\` or restart before using files under '${PROJECT_AGENT_GUIDANCE_DIRECTORY}/agents/builtin'.`,
        path: inventory.cwd,
    });
}
function addSkippedSourceDiagnostic(inventory, candidate) {
    if (inventory.trust !== "trusted")
        return false;
    if (inventory.trustEntryPath === undefined) {
        pushDiagnostic(inventory.diagnostics, {
            code: "source-outside-trusted-subtree",
            message: `Skipped project-agent guidance file '${candidate.path}' because the trusted project containment boundary could not be established. Run \`/trust\`, persist the decision, then run \`/reload\` or restart.`,
            path: candidate.path,
            role: candidate.role,
        });
        return true;
    }
    if (isPathWithin(inventory.trustEntryPath, candidate.path))
        return false;
    pushDiagnostic(inventory.diagnostics, {
        code: "source-outside-trusted-subtree",
        message: `Skipped project-agent guidance file '${candidate.path}' because persisted trust for '${inventory.cwd}' covers '${inventory.trustEntryPath}' but not this source. Run \`/trust\` for the source project path, persist that decision, then run \`/reload\` or restart.`,
        path: candidate.path,
        role: candidate.role,
    });
    return true;
}
export function isCanonicalPackagedMinorAgent(agent) {
    if (typeof agent !== "object" || agent === null || Array.isArray(agent))
        return false;
    const candidate = agent;
    if (typeof candidate.name !== "string" || typeof candidate.filePath !== "string")
        return false;
    const role = PACKAGED_MINOR_AGENT_ROLES.find((packagedRole) => packagedRole === candidate.name);
    if (!role)
        return false;
    let canonicalPath;
    try {
        canonicalPath = resolve(getAgentDir(), "tlh", "agents", "subagents", `${role}.md`);
        return resolve(candidate.filePath) === canonicalPath;
    }
    catch {
        return false;
    }
}
export function projectAgentGuidanceFilename(role) {
    if (typeof role !== "string" || !Object.hasOwn(ROLE_FILENAMES, role))
        return undefined;
    return ROLE_FILENAMES[role];
}
export function inventoryProjectAgentGuidance(cwdInput, agentDirInput) {
    const diagnostics = [];
    const cwd = resolveInputPath(cwdInput, "cwd", diagnostics);
    const agentDir = resolveInputPath(agentDirInput, "agent directory", diagnostics);
    const inventory = {
        cwd: cwd ?? "",
        trust: "unavailable",
        trustDecision: null,
        files: [],
        diagnostics,
    };
    if (!cwd || !agentDir)
        return inventory;
    const worktree = findGitWorktree(cwd);
    if (worktree.root)
        inventory.worktreeRoot = worktree.root;
    const directories = searchDirectories(worktree.searchCwd, worktree.root);
    const directoryChecks = new Map();
    const scans = new Map();
    let hasReadableCandidate = false;
    for (const role of PROJECT_AGENT_GUIDANCE_ROLES) {
        const scan = scanRoleCandidates(role, directories, diagnostics, directoryChecks);
        scans.set(role, scan);
        if (scan.candidate !== undefined)
            hasReadableCandidate = true;
    }
    if (!hasReadableCandidate) {
        inventory.trust = "not-evaluated";
        return inventory;
    }
    const trust = inspectProjectTrust(cwd, agentDir, diagnostics);
    inventory.trust = trust.state;
    inventory.trustDecision = trust.decision;
    inventory.trustEntryPath = trust.entryPath;
    addTrustDiagnostic(inventory);
    for (const role of PROJECT_AGENT_GUIDANCE_ROLES) {
        const scan = scans.get(role);
        const candidate = scan?.candidate;
        if (!candidate)
            continue;
        if (inventory.trust !== "trusted") {
            inventory.files.push({ role, path: candidate.path });
            continue;
        }
        if (addSkippedSourceDiagnostic(inventory, candidate)) {
            inventory.files.push({ role, path: candidate.path });
            continue;
        }
        const trustBoundaryPath = inventory.trustEntryPath;
        if (trustBoundaryPath === undefined) {
            inventory.files.push({ role, path: candidate.path });
            continue;
        }
        const content = readGuidanceFile(candidate, trustBoundaryPath, diagnostics);
        if (content === undefined) {
            continue;
        }
        if (content.length === 0) {
            continue;
        }
        inventory.files.push({ role, path: candidate.path, content });
    }
    return inventory;
}
export function resolveProjectAgentGuidanceFromInventory(inventory, roleInput) {
    const role = typeof roleInput === "string" && Object.hasOwn(ROLE_FILENAMES, roleInput)
        ? roleInput
        : undefined;
    if (!role)
        return { inventory };
    const file = inventory.files.find((candidate) => candidate.role === role);
    return file?.content === undefined
        ? { role, inventory }
        : { role, guidance: file.content, sourcePath: file.path, inventory };
}
export function resolveProjectAgentGuidance(cwdInput, agentDirInput, roleInput) {
    const inventory = inventoryProjectAgentGuidance(cwdInput, agentDirInput);
    return resolveProjectAgentGuidanceFromInventory(inventory, roleInput);
}
function encodeProjectGuidanceSourceLabel(value) {
    return Array.from(value, (character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint <= 0x1f ||
            (codePoint >= 0x7f && codePoint <= 0x9f) ||
            codePoint === 0x2028 ||
            codePoint === 0x2029) {
            return `\\u${codePoint.toString(16).padStart(4, "0")}`;
        }
        if (character === "\\") {
            return "\\\\";
        }
        return character;
    }).join("");
}
function projectGuidanceSourceLabel(inventory, sourcePath) {
    const root = inventory.worktreeRoot ?? inventory.cwd;
    const relativePath = relative(root, sourcePath);
    const outsideRoot = isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`);
    const label = outsideRoot ? "[outside-worktree]" : relativePath || ".";
    return encodeProjectGuidanceSourceLabel(label.split(sep).join("/"));
}
function escapeProjectGuidanceDelimiter(guidance) {
    return guidance.replaceAll(PROJECT_GUIDANCE_CLOSE_DELIMITER, "<\\/tlh_project_agent_guidance>");
}
export function formatProjectAgentGuidance(inventory, role) {
    if (!inventory) {
        return "";
    }
    const result = resolveProjectAgentGuidanceFromInventory(inventory, role);
    if (!result.guidance || !result.sourcePath) {
        return "";
    }
    return [
        "## TLH Project Agent Guidance",
        "",
        `Source: ${projectGuidanceSourceLabel(inventory, result.sourcePath)}`,
        "",
        PROJECT_GUIDANCE_OPEN_DELIMITER,
        escapeProjectGuidanceDelimiter(result.guidance.trim()),
        PROJECT_GUIDANCE_CLOSE_DELIMITER,
    ].join("\n");
}
export const __testing = {
    readGuidanceFileCore,
};

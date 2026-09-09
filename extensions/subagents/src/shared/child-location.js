import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { normalizeComparableCwd } from "./utils.js";
import { shortenPath } from "./formatters.js";
export function parsePersistedChildLocationSnapshot(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== "object" || Array.isArray(value))
        return undefined;
    const v = value;
    if (typeof v["childCwd"] !== "string")
        return undefined;
    if (typeof v["displayPath"] !== "string")
        return undefined;
    if (v["branch"] !== undefined && typeof v["branch"] !== "string")
        return undefined;
    if (v["detachedHead"] !== undefined && typeof v["detachedHead"] !== "string")
        return undefined;
    if (v["repoName"] !== undefined && typeof v["repoName"] !== "string")
        return undefined;
    if (v["linkedWorktree"] !== undefined && v["linkedWorktree"] !== true)
        return undefined;
    if (v["notAGitRepo"] !== undefined && v["notAGitRepo"] !== true)
        return undefined;
    const snapshot = {
        childCwd: v["childCwd"],
        displayPath: v["displayPath"],
    };
    if (typeof v["branch"] === "string")
        snapshot.branch = v["branch"];
    if (typeof v["detachedHead"] === "string")
        snapshot.detachedHead = v["detachedHead"];
    if (typeof v["repoName"] === "string")
        snapshot.repoName = v["repoName"];
    if (v["linkedWorktree"] === true)
        snapshot.linkedWorktree = true;
    if (v["notAGitRepo"] === true)
        snapshot.notAGitRepo = true;
    return snapshot;
}
const GIT_TIMEOUT_MS = 500;
function parseGitRevParseOutput(stdout) {
    const rawLines = stdout.split("\n");
    const lines = rawLines.length > 0 && rawLines[rawLines.length - 1] === "" ? rawLines.slice(0, -1) : rawLines;
    if (lines.length > 4) {
        return { toplevel: undefined, commonDir: undefined, abbrevRef: undefined, shortSha: undefined };
    }
    const toplevel = lines[0]?.trim() || undefined;
    const rawCommonDir = lines[1]?.trim() || undefined;
    const fullSha = lines[2]?.trim() || undefined;
    const abbrevRef = lines[3]?.trim() || undefined;
    const shortSha = fullSha && /^[0-9a-f]{40}$/i.test(fullSha) ? fullSha.slice(0, 7) : undefined;
    let commonDir = rawCommonDir;
    if (commonDir && toplevel && !path.isAbsolute(commonDir)) {
        commonDir = path.resolve(toplevel, commonDir);
    }
    if (commonDir)
        commonDir = commonDir.replace(/[/\\]+$/, "");
    return { toplevel, commonDir, abbrevRef, shortSha };
}
const productionGitRunner = (normalizedCwd) => {
    let result;
    try {
        result = spawnSync("git", ["rev-parse", "--show-toplevel", "--git-common-dir", "HEAD", "--abbrev-ref", "HEAD"], {
            cwd: normalizedCwd,
            encoding: "utf-8",
            timeout: GIT_TIMEOUT_MS,
            windowsHide: true,
            env: { ...process.env, LC_ALL: "C" },
        });
    }
    catch {
        return { stdout: "", processError: true, exitStatus: null, stderr: "" };
    }
    const processError = result.error !== undefined;
    return {
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        processError,
        exitStatus: processError ? null : typeof result.status === "number" ? result.status : null,
        stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
};
function runGitForCwd(normalizedCwd, runner) {
    const { stdout, processError, exitStatus, stderr } = runner(normalizedCwd);
    return { ...parseGitRevParseOutput(stdout), processError, exitStatus, stderr };
}
function buildDisplayPath(normalizedChild, normalizedParent) {
    const rel = path.relative(normalizedParent, normalizedChild);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        return rel;
    }
    return shortenPath(normalizedChild);
}
function captureParentGitFacts(parentCwd, gitRunner = productionGitRunner) {
    const normalizedParent = normalizeComparableCwd(parentCwd);
    return { _rawInfo: runGitForCwd(normalizedParent, gitRunner) };
}
export function makeParentGitFactsAccessor(parentCwd, gitRunner = productionGitRunner) {
    let cached;
    return () => {
        if (cached === undefined) {
            cached = captureParentGitFacts(parentCwd, gitRunner);
        }
        return cached;
    };
}
export function captureChildLocationSnapshot(parentCwd, childCwd, gitRunner = productionGitRunner, parentFactsAccessor) {
    const normalizedParent = normalizeComparableCwd(parentCwd);
    const normalizedChild = normalizeComparableCwd(childCwd);
    if (normalizedParent === normalizedChild)
        return undefined;
    const displayPath = buildDisplayPath(normalizedChild, normalizedParent);
    const snapshot = { childCwd, displayPath };
    if (/[\r\n]/.test(normalizedChild) || /[\r\n]/.test(normalizedParent)) {
        return snapshot;
    }
    const parentGit = parentFactsAccessor !== undefined
        ? parentFactsAccessor()._rawInfo
        : runGitForCwd(normalizedParent, gitRunner);
    const childGit = runGitForCwd(normalizedChild, gitRunner);
    if (childGit.toplevel === undefined &&
        !childGit.processError &&
        childGit.exitStatus === 128 &&
        /not a git repository/i.test(childGit.stderr) &&
        !parentGit.processError &&
        parentGit.toplevel !== undefined) {
        snapshot.notAGitRepo = true;
        return snapshot;
    }
    if (childGit.processError || childGit.toplevel === undefined) {
        return snapshot;
    }
    const parentPositivelyKnown = !parentGit.processError &&
        (parentGit.exitStatus === 0 ||
            (parentGit.exitStatus === 128 && /not a git repository/i.test(parentGit.stderr)));
    if (parentPositivelyKnown) {
        if (childGit.commonDir !== parentGit.commonDir) {
            snapshot.repoName = path.basename(childGit.toplevel);
        }
        else {
            if (childGit.toplevel !== parentGit.toplevel && parentGit.toplevel !== undefined) {
                snapshot.linkedWorktree = true;
            }
        }
    }
    if (childGit.abbrevRef === "HEAD") {
        snapshot.detachedHead = childGit.shortSha;
    }
    else if (parentPositivelyKnown &&
        childGit.abbrevRef !== undefined &&
        childGit.abbrevRef !== parentGit.abbrevRef) {
        snapshot.branch = childGit.abbrevRef;
    }
    return snapshot;
}

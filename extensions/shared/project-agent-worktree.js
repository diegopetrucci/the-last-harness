import * as fs from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
const DEFAULT_FILE_SYSTEM = {
    lstatSync: (filePath) => fs.lstatSync(filePath),
    realpathSync: (filePath) => fs.realpathSync(filePath),
    readFileSync: (filePath) => fs.readFileSync(filePath),
};
const GIT_MARKER_MAX_BYTES = 8 * 1024;
function errorCode(error) {
    if (typeof error !== "object" || error === null || !("code" in error))
        return undefined;
    const code = error.code;
    return typeof code === "string" ? code : undefined;
}
function isMissingError(error) {
    return errorCode(error) === "ENOENT";
}
function bytesFromRead(value) {
    return Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
}
function hasPositiveIdentity(stat) {
    return (Number.isSafeInteger(stat.dev) && Number.isSafeInteger(stat.ino) && stat.dev > 0 && stat.ino > 0);
}
function isSafeDirectory(filePath, fileSystem) {
    try {
        const stat = fileSystem.lstatSync(filePath);
        return !stat.isSymbolicLink() && stat.isDirectory() && hasPositiveIdentity(stat);
    }
    catch {
        return false;
    }
}
function isSafeRegularFile(filePath, fileSystem) {
    try {
        const stat = fileSystem.lstatSync(filePath);
        return !stat.isSymbolicLink() && stat.isFile() && hasPositiveIdentity(stat);
    }
    catch {
        return false;
    }
}
function readGitMarkerLine(filePath, fileSystem) {
    try {
        const stat = fileSystem.lstatSync(filePath);
        if (stat.isSymbolicLink() ||
            !stat.isFile() ||
            !hasPositiveIdentity(stat) ||
            stat.size > GIT_MARKER_MAX_BYTES) {
            return undefined;
        }
        const value = bytesFromRead(fileSystem.readFileSync(filePath));
        if (value.byteLength > GIT_MARKER_MAX_BYTES)
            return undefined;
        let text = value.toString("utf8");
        if (text.endsWith("\n"))
            text = text.slice(0, -1);
        if (text.endsWith("\r"))
            text = text.slice(0, -1);
        return text.includes("\n") || text.includes("\r") ? undefined : text;
    }
    catch {
        return undefined;
    }
}
function hasValidGitHead(gitDirectory, fileSystem) {
    const head = readGitMarkerLine(join(gitDirectory, "HEAD"), fileSystem);
    if (!head)
        return false;
    return /^ref: refs\/\S+$/.test(head) || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head);
}
function canonicalPathForCompare(filePath, fileSystem) {
    try {
        return fileSystem.realpathSync(filePath);
    }
    catch {
        return resolve(filePath);
    }
}
function hasGitDirectoryLayout(gitDirectory, fileSystem) {
    return (isSafeDirectory(gitDirectory, fileSystem) &&
        hasValidGitHead(gitDirectory, fileSystem) &&
        isSafeRegularFile(join(gitDirectory, "config"), fileSystem) &&
        isSafeDirectory(join(gitDirectory, "objects"), fileSystem) &&
        isSafeDirectory(join(gitDirectory, "refs"), fileSystem));
}
function readGitDirectoryTarget(markerPath, fileSystem) {
    const marker = readGitMarkerLine(markerPath, fileSystem);
    if (!marker?.startsWith("gitdir: "))
        return undefined;
    const target = marker.slice("gitdir: ".length);
    return target.length > 0 ? target : undefined;
}
function isValidLinkedWorktreeDirectory(adminDirectory, markerPath, fileSystem) {
    if (!isSafeDirectory(adminDirectory, fileSystem) ||
        !hasValidGitHead(adminDirectory, fileSystem)) {
        return false;
    }
    const linkedMarker = readGitMarkerLine(join(adminDirectory, "gitdir"), fileSystem);
    const commonMarker = readGitMarkerLine(join(adminDirectory, "commondir"), fileSystem);
    if (!linkedMarker || !commonMarker)
        return false;
    let linkedMarkerPath;
    let commonDirectory;
    try {
        linkedMarkerPath = resolve(adminDirectory, linkedMarker);
        commonDirectory = resolve(adminDirectory, commonMarker);
    }
    catch {
        return false;
    }
    return (canonicalPathForCompare(linkedMarkerPath, fileSystem) ===
        canonicalPathForCompare(markerPath, fileSystem) &&
        hasGitDirectoryLayout(commonDirectory, fileSystem));
}
function inspectGitWorktreeMarker(directory, fileSystem) {
    const markerPath = join(directory, ".git");
    let stat;
    try {
        stat = fileSystem.lstatSync(markerPath);
    }
    catch (error) {
        return isMissingError(error) ? "absent" : "malformed";
    }
    if (!hasPositiveIdentity(stat) || stat.isSymbolicLink())
        return "malformed";
    if (stat.isDirectory()) {
        return hasGitDirectoryLayout(markerPath, fileSystem) ? "valid" : "malformed";
    }
    if (!stat.isFile())
        return "malformed";
    const target = readGitDirectoryTarget(markerPath, fileSystem);
    if (!target)
        return "malformed";
    let gitDirectory;
    try {
        gitDirectory = resolve(dirname(markerPath), target);
    }
    catch {
        return "malformed";
    }
    if (!isSafeDirectory(gitDirectory, fileSystem))
        return "malformed";
    return hasGitDirectoryLayout(gitDirectory, fileSystem) ||
        isValidLinkedWorktreeDirectory(gitDirectory, markerPath, fileSystem)
        ? "valid"
        : "malformed";
}
function findValidatedGitWorktreeRootAt(startDirectory, fileSystem) {
    let directory = startDirectory;
    while (true) {
        const markerState = inspectGitWorktreeMarker(directory, fileSystem);
        if (markerState === "valid")
            return directory;
        if (markerState === "malformed")
            return undefined;
        const parent = dirname(directory);
        if (parent === directory)
            return undefined;
        directory = parent;
    }
}
function strictCanonicalPath(filePath, fileSystem) {
    try {
        return fileSystem.realpathSync(filePath);
    }
    catch {
        return undefined;
    }
}
export function findValidatedGitWorktree(cwdInput, options = {}) {
    const fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
    if (typeof cwdInput !== "string" || cwdInput.trim().length === 0) {
        return { searchCwd: "" };
    }
    let cwd;
    try {
        cwd = resolve(cwdInput);
        if (cwd.includes("\0"))
            return { searchCwd: cwd };
    }
    catch {
        return { searchCwd: "" };
    }
    let canonicalCwd;
    try {
        canonicalCwd = fileSystem.realpathSync(cwd);
    }
    catch {
        const lexicalRoot = findValidatedGitWorktreeRootAt(cwd, fileSystem);
        return lexicalRoot ? { searchCwd: cwd, root: lexicalRoot } : { searchCwd: cwd };
    }
    const canonicalRoot = findValidatedGitWorktreeRootAt(canonicalCwd, fileSystem);
    if (!canonicalRoot)
        return { searchCwd: cwd };
    const lexicalRoot = findValidatedGitWorktreeRootAt(cwd, fileSystem);
    if (lexicalRoot !== undefined &&
        canonicalPathForCompare(lexicalRoot, fileSystem) ===
            canonicalPathForCompare(canonicalRoot, fileSystem) &&
        relative(lexicalRoot, cwd) === relative(canonicalRoot, canonicalCwd)) {
        return { searchCwd: cwd, root: lexicalRoot };
    }
    return { searchCwd: canonicalCwd, root: canonicalRoot };
}
export function resolveValidatedGitWorktreeRoot(cwdInput, options = {}) {
    const fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
    if (typeof cwdInput !== "string" || cwdInput.trim().length === 0)
        return undefined;
    let cwd;
    try {
        cwd = resolve(cwdInput);
        if (cwd.includes("\0"))
            return undefined;
    }
    catch {
        return undefined;
    }
    const canonicalCwd = strictCanonicalPath(cwd, fileSystem);
    if (!canonicalCwd || !isSafeDirectory(canonicalCwd, fileSystem))
        return undefined;
    const search = findValidatedGitWorktree(canonicalCwd, { fileSystem });
    if (!search.root)
        return undefined;
    return strictCanonicalPath(search.root, fileSystem);
}
export const __testing = {
    findValidatedGitWorktreeRootAt,
    inspectGitWorktreeMarker,
};

import { lstatSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
export const SESSION_MIRROR_ATTESTATION_PHASES = Object.freeze([
    "directory-only",
    "session-file",
]);
export const SESSION_MIRROR_ATTESTATION_REASONS = Object.freeze([
    "missing-profile-selection",
    "missing-home",
    "default-or-normal-profile",
    "profile-mismatch",
    "unsafe-profile-metadata",
    "ephemeral-session",
    "session-escape",
    "unsafe-session-metadata",
]);
const PRODUCTION_FILE_SYSTEM = Object.freeze({
    lstat: (path) => lstatSync(path),
    realpath: (path) => realpathSync.native(path),
});
function success(phase) {
    return Object.freeze({ ok: true, phase });
}
function failure(reason) {
    return Object.freeze({ ok: false, reason });
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}
function errorCode(error) {
    if (typeof error !== "object" || error === null || !("code" in error))
        return undefined;
    const code = error.code;
    return typeof code === "string" ? code : undefined;
}
function isMissingPathError(error) {
    const code = errorCode(error);
    return code === "ENOENT" || code === "ENOTDIR";
}
function absolutePath(value, homePath) {
    let expanded = value;
    if (homePath && expanded === "~") {
        expanded = homePath;
    }
    else if (homePath && (expanded.startsWith("~/") || expanded.startsWith(`~${sep}`))) {
        expanded = join(homePath, expanded.slice(2));
    }
    return resolve(expanded);
}
function requireAbsolutePath(value) {
    if (!isNonEmptyString(value) || !isAbsolute(value)) {
        throw new Error("non-absolute metadata");
    }
    return value;
}
function pathWithinOrEqual(root, child) {
    const childRelativePath = relative(root, child);
    return (childRelativePath === "" ||
        (!childRelativePath.startsWith("..") && !isAbsolute(childRelativePath)));
}
function realpathForComparison(path, fileSystem) {
    const resolved = resolve(path);
    try {
        return requireAbsolutePath(fileSystem.realpath(resolved));
    }
    catch (error) {
        if (!isMissingPathError(error))
            throw error;
        const parent = dirname(resolved);
        if (parent === resolved)
            return resolved;
        return join(realpathForComparison(parent, fileSystem), basename(resolved));
    }
}
function assertRegularDirectory(path, fileSystem) {
    const stats = fileSystem.lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error("unsafe directory metadata");
    }
}
function attestHome(value, fileSystem, requireExistingDirectory) {
    const lexicalPath = absolutePath(value);
    const canonicalPath = requireExistingDirectory
        ? requireAbsolutePath(fileSystem.realpath(lexicalPath))
        : realpathForComparison(lexicalPath, fileSystem);
    if (requireExistingDirectory)
        assertRegularDirectory(canonicalPath, fileSystem);
    return { lexicalPath, canonicalPath };
}
function attestHomes(dependencies) {
    const envHomeValues = [dependencies.env.HOME, dependencies.env.USERPROFILE].filter(isNonEmptyString);
    let accountHomeValue;
    try {
        accountHomeValue = dependencies.getAccountHome();
    }
    catch {
        accountHomeValue = undefined;
    }
    if (envHomeValues.length === 0 && !isNonEmptyString(accountHomeValue)) {
        return failure("missing-home");
    }
    if (!isNonEmptyString(accountHomeValue) || !isAbsolute(accountHomeValue)) {
        return failure("unsafe-profile-metadata");
    }
    const fileSystem = dependencies.fileSystem;
    const homeValues = [...envHomeValues, accountHomeValue];
    const homes = homeValues.map((value, index) => attestHome(value, fileSystem, index === homeValues.length - 1));
    const protectedPiRoots = homes.map((home) => {
        const lexicalPath = join(home.lexicalPath, ".pi");
        return {
            lexicalPath,
            canonicalPath: realpathForComparison(lexicalPath, fileSystem),
        };
    });
    return {
        expansionPath: homes[0]?.lexicalPath ?? homes[homes.length - 1].lexicalPath,
        protectedPiRoots,
    };
}
function isWithinProtectedPiRoot(profile, protectedPiRoots) {
    return protectedPiRoots.some((root) => pathWithinOrEqual(root.lexicalPath, profile.lexicalPath) ||
        pathWithinOrEqual(root.canonicalPath, profile.canonicalPath) ||
        pathWithinOrEqual(root.lexicalPath, profile.runtimeLexicalPath) ||
        pathWithinOrEqual(root.canonicalPath, profile.runtimeCanonicalPath));
}
function attestProfile(dependencies) {
    const selectedValue = dependencies.env.PI_CODING_AGENT_DIR;
    if (!isNonEmptyString(selectedValue))
        return failure("missing-profile-selection");
    const homes = attestHomes(dependencies);
    if ("ok" in homes)
        return homes;
    const fileSystem = dependencies.fileSystem;
    const selectedPath = absolutePath(selectedValue, homes.expansionPath);
    let runtimeValue;
    try {
        runtimeValue = dependencies.getAgentDir();
    }
    catch {
        return failure("profile-mismatch");
    }
    if (!isNonEmptyString(runtimeValue))
        return failure("profile-mismatch");
    const runtimePath = absolutePath(runtimeValue, homes.expansionPath);
    try {
        assertRegularDirectory(selectedPath, fileSystem);
        assertRegularDirectory(runtimePath, fileSystem);
    }
    catch {
        return failure("unsafe-profile-metadata");
    }
    let selectedCanonicalPath;
    let runtimeCanonicalPath;
    try {
        selectedCanonicalPath = requireAbsolutePath(fileSystem.realpath(selectedPath));
        runtimeCanonicalPath = requireAbsolutePath(fileSystem.realpath(runtimePath));
    }
    catch {
        return failure("unsafe-profile-metadata");
    }
    if (selectedCanonicalPath !== runtimeCanonicalPath) {
        return failure("profile-mismatch");
    }
    const profile = {
        lexicalPath: selectedPath,
        canonicalPath: selectedCanonicalPath,
        runtimeLexicalPath: runtimePath,
        runtimeCanonicalPath,
    };
    try {
        if (isWithinProtectedPiRoot(profile, homes.protectedPiRoots)) {
            return failure("default-or-normal-profile");
        }
    }
    catch {
        return failure("unsafe-profile-metadata");
    }
    return profile;
}
function assertNoSymlinkedComponents(rootPath, targetPath, fileSystem) {
    const childRelativePath = relative(rootPath, targetPath);
    if (childRelativePath !== "" &&
        (childRelativePath.startsWith("..") || isAbsolute(childRelativePath))) {
        throw new Error("path escapes profile");
    }
    let currentPath = rootPath;
    for (const component of childRelativePath.split(sep).filter(Boolean)) {
        currentPath = join(currentPath, component);
        const stats = fileSystem.lstat(currentPath);
        if (stats.isSymbolicLink())
            throw new Error("symlinked session component");
        if (currentPath !== targetPath && !stats.isDirectory()) {
            throw new Error("non-directory session component");
        }
    }
}
function attestSessionPath(sessionFile, profile, fileSystem) {
    const sessionPath = resolve(sessionFile);
    if (!pathWithinOrEqual(profile.lexicalPath, sessionPath)) {
        return failure("session-escape");
    }
    let sessionStats;
    try {
        sessionStats = fileSystem.lstat(sessionPath);
    }
    catch (error) {
        if (!isMissingPathError(error))
            return failure("unsafe-session-metadata");
        const sessionDirectory = dirname(sessionPath);
        try {
            assertRegularDirectory(sessionDirectory, fileSystem);
            const canonicalDirectory = requireAbsolutePath(fileSystem.realpath(sessionDirectory));
            if (!pathWithinOrEqual(profile.canonicalPath, canonicalDirectory)) {
                return failure("session-escape");
            }
            assertNoSymlinkedComponents(profile.lexicalPath, sessionDirectory, fileSystem);
            return success("directory-only");
        }
        catch {
            return failure("unsafe-session-metadata");
        }
    }
    if (sessionStats.isSymbolicLink() || !sessionStats.isFile()) {
        return failure("unsafe-session-metadata");
    }
    try {
        const canonicalSessionPath = requireAbsolutePath(fileSystem.realpath(sessionPath));
        if (!pathWithinOrEqual(profile.canonicalPath, canonicalSessionPath)) {
            return failure("session-escape");
        }
        assertNoSymlinkedComponents(profile.lexicalPath, sessionPath, fileSystem);
        return success("session-file");
    }
    catch {
        return failure("unsafe-session-metadata");
    }
}
export function attestSessionMirrorSessionCore(input, dependencies) {
    let sessionFile;
    try {
        if (typeof input !== "object" || input === null || Array.isArray(input)) {
            return failure("unsafe-session-metadata");
        }
        sessionFile = input.sessionFile;
    }
    catch {
        return failure("unsafe-session-metadata");
    }
    if (sessionFile === undefined)
        return failure("ephemeral-session");
    if (!isNonEmptyString(sessionFile))
        return failure("unsafe-session-metadata");
    let profile;
    try {
        profile = attestProfile(dependencies);
    }
    catch {
        return failure("unsafe-profile-metadata");
    }
    if (!profile || "ok" in profile)
        return profile;
    try {
        return attestSessionPath(sessionFile, profile, dependencies.fileSystem);
    }
    catch {
        return failure("unsafe-session-metadata");
    }
}
export function attestSessionMirrorSession(input) {
    try {
        return attestSessionMirrorSessionCore(input, {
            env: process.env,
            getAgentDir,
            getAccountHome: () => userInfo().homedir,
            fileSystem: PRODUCTION_FILE_SYSTEM,
        });
    }
    catch {
        return failure("unsafe-profile-metadata");
    }
}

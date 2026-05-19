import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const DEFAULT_VALID_UPDATE_TRACKS = Object.freeze(["latest-release", "pinned-tag", "ref", "custom"]);

export function stripTrailingSlashes(path) {
	let result = String(path);
	while (result !== sep && result.endsWith(sep)) {
		result = result.slice(0, -1);
	}
	return result;
}

export function realpathForCompare(path) {
	const resolved = resolve(path);
	if (existsSync(resolved)) return realpathSync.native(resolved);
	const parent = dirname(resolved);
	if (parent === resolved) return resolved;
	return join(realpathForCompare(parent), basename(resolved));
}

export function pathWithinOrEqual(root, child) {
	const normalizedRoot = stripTrailingSlashes(root);
	const normalizedChild = stripTrailingSlashes(child);
	if (normalizedRoot === sep) return normalizedChild.startsWith(sep);
	return normalizedChild === normalizedRoot || normalizedChild.startsWith(`${normalizedRoot}${sep}`);
}

export function pathIsProtectedPiConfig(path, { homeDir = homedir(), alreadyNormalized = false } = {}) {
	const normalizedPath = alreadyNormalized ? stripTrailingSlashes(path) : realpathForCompare(path);
	const normalPiRoot = realpathForCompare(join(homeDir, ".pi"));
	const normalPiAgentRoot = realpathForCompare(join(homeDir, ".pi", "agent"));
	return pathWithinOrEqual(normalPiRoot, normalizedPath) || pathWithinOrEqual(normalPiAgentRoot, normalizedPath);
}

export function validateInstallerTargets(config, { homeDir = homedir(), validUpdateTracks = DEFAULT_VALID_UPDATE_TRACKS } = {}) {
	if (!/^[A-Za-z0-9._-]+$/.test(config.wrapperName)) {
		throw new Error("--wrapper-name must be a simple command name containing only letters, numbers, dot, underscore, or dash");
	}
	if (!new Set(validUpdateTracks).has(config.updateTrack)) {
		throw new Error("--track must be one of: latest-release, pinned-tag, ref, custom");
	}

	const normalizedAgent = realpathForCompare(config.agentDir);
	const normalizedBin = realpathForCompare(config.binDir);
	const normalizedWrapper = realpathForCompare(config.wrapperPath);
	if (pathIsProtectedPiConfig(normalizedAgent, { homeDir, alreadyNormalized: true })) {
		throw new Error(`refusing to place The Last Harness agent dir under normal Pi config root: ${config.agentDir}`);
	}
	if (pathIsProtectedPiConfig(normalizedBin, { homeDir, alreadyNormalized: true })) {
		throw new Error(`refusing to place The Last Harness wrapper dir under normal Pi config root: ${config.binDir}`);
	}
	if (pathIsProtectedPiConfig(normalizedWrapper, { homeDir, alreadyNormalized: true })) {
		throw new Error(`refusing to place The Last Harness wrapper under normal Pi config root: ${config.wrapperPath}`);
	}
}

function isMissingPath(error) {
	return error?.code === "ENOENT";
}

function noFollowOpenFlag() {
	return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function fileIdentity(stats) {
	return { dev: stats.dev, ino: stats.ino };
}

function fileMode(stats) {
	return stats.mode & 0o777;
}

function sameFileIdentity(stats, identity) {
	return stats.dev === identity.dev && stats.ino === identity.ino;
}

function lstatIdentity(path) {
	return fileIdentity(lstatSync(path));
}

function removeOwnedFile(path, identity) {
	if (!identity) return false;
	try {
		const stats = lstatSync(path);
		if (!stats.isFile() || !sameFileIdentity(stats, identity)) return false;
		rmSync(path, { force: true });
		return true;
	} catch (error) {
		if (isMissingPath(error)) return false;
		throw error;
	}
}

function removeOwnedTempDir(path, identity) {
	if (!identity) return false;
	try {
		const stats = lstatSync(path);
		if (!stats.isDirectory() || !sameFileIdentity(stats, identity)) return false;
		rmSync(path, { recursive: true, force: true });
		return true;
	} catch (error) {
		if (isMissingPath(error)) return false;
		throw error;
	}
}

function openExclusiveFile(path, label, mode = 0o666) {
	try {
		const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowOpenFlag(), mode);
		return { fd, identity: fileIdentity(fstatSync(fd)) };
	} catch (error) {
		if (error?.code === "EEXIST" || error?.code === "ELOOP") {
			throw new Error(`refusing to overwrite existing ${label}: ${path}`);
		}
		throw error;
	}
}

function writeExclusiveFile(path, data, label, mode = 0o666) {
	let fd;
	let identity;
	try {
		const opened = openExclusiveFile(path, label, mode);
		fd = opened.fd;
		identity = opened.identity;
		writeFileSync(fd, data);
		closeSync(fd);
		fd = undefined;
		return identity;
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		removeOwnedFile(path, identity);
		throw error;
	}
}

export function isSymlink(path) {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch (error) {
		if (isMissingPath(error)) return false;
		throw error;
	}
}

export function validateProfileRelativePath(relativePath, label = "TLH profile path") {
	if (!relativePath || relativePath.startsWith("/") || relativePath.endsWith("/") || relativePath.includes("\\")) {
		throw new Error(`refusing unsafe ${label}: ${relativePath}`);
	}
	for (const component of relativePath.split("/")) {
		if (!component || component === "." || component === "..") {
			throw new Error(`refusing unsafe ${label}: ${relativePath}`);
		}
	}
}

export function assertProfilePathWithinAgent(config, path, label = "TLH profile path", { homeDir = homedir() } = {}) {
	const normalizedAgent = realpathForCompare(config.agentDir);
	const normalizedPath = realpathForCompare(path);
	if (!pathWithinOrEqual(normalizedAgent, normalizedPath)) {
		throw new Error(`refusing to write ${label} outside the isolated TLH profile: ${path}`);
	}
	if (pathIsProtectedPiConfig(normalizedPath, { homeDir, alreadyNormalized: true })) {
		throw new Error(`refusing to write ${label} under normal Pi config root: ${path}`);
	}
}

function ensureSafeProfileRoot(config, label = "TLH profile root", options = {}) {
	const { createParents = true, homeDir = homedir() } = options;
	const root = realpathForCompare(config.agentDir);
	if (pathIsProtectedPiConfig(root, { homeDir, alreadyNormalized: true })) {
		throw new Error(`refusing to write ${label} under normal Pi config root: ${config.agentDir}`);
	}
	if (isSymlink(config.agentDir)) {
		throw new Error(`refusing to write ${label} through symlinked TLH profile root: ${config.agentDir}`);
	}
	if (existsSync(root) && !lstatSync(root).isDirectory()) {
		throw new Error(`refusing to use non-directory TLH profile root for ${label}: ${config.agentDir}`);
	}
	if (!existsSync(root) && createParents) mkdirSync(root, { recursive: true });
	if (isSymlink(config.agentDir)) {
		throw new Error(`refusing to write ${label} through symlinked TLH profile root: ${config.agentDir}`);
	}
	if (existsSync(root) && !lstatSync(root).isDirectory()) {
		throw new Error(`refusing to use non-directory TLH profile root for ${label}: ${config.agentDir}`);
	}
	return root;
}

export function ensureSafeProfileDir(config, relativePath, label = "TLH profile directory", options = {}) {
	validateProfileRelativePath(relativePath, label);
	const root = ensureSafeProfileRoot(config, label, options);
	const { createParents = true } = options;

	let cursor = root;
	for (const component of relativePath.split("/")) {
		cursor = join(cursor, component);
		if (isSymlink(cursor)) {
			throw new Error(`refusing to write ${label} through symlinked TLH profile path: ${cursor}`);
		}
		if (existsSync(cursor) && !lstatSync(cursor).isDirectory()) {
			throw new Error(`refusing to use non-directory TLH profile path for ${label}: ${cursor}`);
		}
		if (!existsSync(cursor) && createParents) mkdirSync(cursor);
		if (isSymlink(cursor)) {
			throw new Error(`refusing to write ${label} through symlinked TLH profile path: ${cursor}`);
		}
		if (existsSync(cursor) && !lstatSync(cursor).isDirectory()) {
			throw new Error(`refusing to use non-directory TLH profile path for ${label}: ${cursor}`);
		}
		assertProfilePathWithinAgent(config, cursor, label, options);
	}
	return cursor;
}

function validateExistingProfileFile(path, label) {
	try {
		const stats = lstatSync(path);
		if (stats.isSymbolicLink()) {
			throw new Error(`refusing to replace symlinked ${label}: ${path}`);
		}
		if (!stats.isFile()) {
			throw new Error(`refusing to replace non-file ${label}: ${path}`);
		}
	} catch (error) {
		if (isMissingPath(error)) return;
		throw error;
	}
}

function validateRawProfileParentComponents(profileRoot, relativePath, label) {
	const parentSeparatorIndex = relativePath.lastIndexOf("/");
	if (parentSeparatorIndex === -1) return;

	let cursor = profileRoot;
	for (const component of relativePath.slice(0, parentSeparatorIndex).split("/")) {
		cursor = join(cursor, component);
		try {
			const stats = lstatSync(cursor);
			if (stats.isSymbolicLink()) {
				throw new Error(`refusing to write ${label} parent directory through symlinked TLH profile path: ${cursor}`);
			}
			if (!stats.isDirectory()) {
				throw new Error(`refusing to use non-directory TLH profile path for ${label} parent directory: ${cursor}`);
			}
		} catch (error) {
			if (isMissingPath(error)) return;
			throw error;
		}
	}
}

function rawAbsoluteProfileRelativePath(config, rawPath, label) {
	const rawTarget = stripTrailingSlashes(resolve(rawPath));
	validateExistingProfileFile(rawTarget, label);

	const rawAgent = stripTrailingSlashes(resolve(config.agentDir));
	const normalizedAgent = stripTrailingSlashes(realpathForCompare(config.agentDir));
	const profileRoot = pathWithinOrEqual(rawAgent, rawTarget)
		? rawAgent
		: (pathWithinOrEqual(normalizedAgent, rawTarget) ? normalizedAgent : "");
	if (!profileRoot) {
		throw new Error(`refusing to write ${label} outside the isolated TLH profile: ${rawPath}`);
	}

	const relativePath = relative(profileRoot, rawTarget).split(sep).join("/");
	validateProfileRelativePath(relativePath, label);
	validateRawProfileParentComponents(profileRoot, relativePath, label);
	return relativePath;
}

function profileRelativeFilePath(config, profilePath, label, options) {
	const rawPath = String(profilePath);
	if (!isAbsolute(rawPath)) {
		validateProfileRelativePath(rawPath, label);
		return rawPath;
	}

	const allowedAbsoluteBasenames = new Set(options.allowLegacyAbsoluteSettingsPath ? ["settings.json"] : []);
	for (const allowedName of options.allowLegacyAbsoluteProfileBasenames ?? []) allowedAbsoluteBasenames.add(allowedName);
	if (!allowedAbsoluteBasenames.has(basename(rawPath))) {
		throw new Error(`refusing absolute ${label}; use a TLH profile-relative path: ${profilePath}`);
	}

	return rawAbsoluteProfileRelativePath(config, rawPath, label);
}

function safeProfileFileTargetInfo(config, profilePath, label = "TLH profile file", options = {}) {
	const relativePath = profileRelativeFilePath(config, profilePath, label, options);
	const parentSeparatorIndex = relativePath.lastIndexOf("/");
	const parentRelative = parentSeparatorIndex === -1 ? "" : relativePath.slice(0, parentSeparatorIndex);
	const base = parentSeparatorIndex === -1 ? relativePath : basename(relativePath);
	const parent = parentRelative
		? ensureSafeProfileDir(config, parentRelative, `${label} parent directory`, options)
		: ensureSafeProfileRoot(config, `${label} parent directory`, options);
	const target = join(parent, base);
	if (isSymlink(target)) {
		throw new Error(`refusing to replace symlinked ${label}: ${target}`);
	}
	if (existsSync(target) && !lstatSync(target).isFile()) {
		throw new Error(`refusing to replace non-file ${label}: ${target}`);
	}
	assertProfilePathWithinAgent(config, target, label, options);
	return { target, parent, base };
}

export function safeProfileFileTarget(config, profilePath, label = "TLH profile file", options = {}) {
	return safeProfileFileTargetInfo(config, profilePath, label, options).target;
}

function currentTargetIdentity(target, label, options = {}) {
	try {
		const stats = lstatSync(target);
		if (stats.isSymbolicLink()) {
			throw new Error(`refusing to replace symlinked ${label}: ${target}`);
		}
		if (!stats.isFile()) {
			throw new Error(`refusing to replace non-file ${label}: ${target}`);
		}
		if (options.exclusive) {
			throw new Error(`refusing to overwrite existing ${label}: ${target}`);
		}
		return { ...fileIdentity(stats), mode: fileMode(stats) };
	} catch (error) {
		if (isMissingPath(error)) return undefined;
		throw error;
	}
}

function revalidateProfileWriteTarget({ parent, parentIdentity, target, targetIdentity, label }) {
	const parentStats = lstatSync(parent);
	if (!parentStats.isDirectory() || !sameFileIdentity(parentStats, parentIdentity)) {
		throw new Error(`refusing to replace ${label}; parent directory changed before rename: ${parent}`);
	}

	try {
		const targetStats = lstatSync(target);
		if (targetStats.isSymbolicLink()) {
			throw new Error(`refusing to replace symlinked ${label}: ${target}`);
		}
		if (!targetStats.isFile()) {
			throw new Error(`refusing to replace non-file ${label}: ${target}`);
		}
		if (!targetIdentity) {
			throw new Error(`refusing to replace ${label}; target appeared before rename: ${target}`);
		}
		if (!sameFileIdentity(targetStats, targetIdentity)) {
			throw new Error(`refusing to replace ${label}; target changed before rename: ${target}`);
		}
	} catch (error) {
		if (!isMissingPath(error)) throw error;
		if (targetIdentity) {
			throw new Error(`refusing to replace ${label}; target disappeared before rename: ${target}`);
		}
	}
}

function revalidateTempWriteTarget(tempTarget, tempFileIdentity, label) {
	try {
		const stats = lstatSync(tempTarget);
		if (stats.isSymbolicLink()) {
			throw new Error(`refusing to replace ${label}; temp file changed to symlink before rename: ${tempTarget}`);
		}
		if (!stats.isFile()) {
			throw new Error(`refusing to replace ${label}; temp file is not a regular file before rename: ${tempTarget}`);
		}
		if (!sameFileIdentity(stats, tempFileIdentity)) {
			throw new Error(`refusing to replace ${label}; temp file changed before rename: ${tempTarget}`);
		}
	} catch (error) {
		if (isMissingPath(error)) {
			throw new Error(`refusing to replace ${label}; temp file disappeared before rename: ${tempTarget}`);
		}
		throw error;
	}
}

function backupPathForTarget(config, target, parent, label, options) {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupPath = realpathForCompare(options.backupPath || `${target}.backup-${stamp}`);
	if (dirname(backupPath) !== parent) {
		throw new Error(`refusing to write ${label} backup outside the target directory: ${backupPath}`);
	}
	assertProfilePathWithinAgent(config, backupPath, `${label} backup`, options);
	if (isSymlink(backupPath) || existsSync(backupPath)) {
		throw new Error(`refusing to overwrite existing ${label} backup: ${backupPath}`);
	}
	return backupPath;
}

function createTargetBackup(config, writeTarget, targetIdentity, options) {
	if (!options.backup || !targetIdentity) return undefined;
	const { parent, target, label } = writeTarget;
	const backupPath = backupPathForTarget(config, target, parent, label, options);
	revalidateProfileWriteTarget({ ...writeTarget, targetIdentity });
	writeExclusiveFile(backupPath, readFileSync(target), `${label} backup`, options.backupMode ?? targetIdentity.mode ?? 0o666);
	return backupPath;
}

// Best-effort portable safe replacement for files inside the isolated TLH profile.
// Node does not expose fd-anchored openat(2)/renameat(2) primitives, so a residual TOCTOU
// window remains between path identity revalidation and renameSync.
export function replaceSafeProfileFile(config, profilePath, writeTempFile, label = "TLH profile file", options = {}) {
	if (typeof writeTempFile !== "function") throw new TypeError("writeTempFile must be a function");
	if (options.dryRun) {
		const { target } = safeProfileFileTargetInfo(config, profilePath, label, { ...options, createParents: false });
		return { target, backupPath: undefined, dryRun: true };
	}

	const { target, parent, base } = safeProfileFileTargetInfo(config, profilePath, label, options);
	const parentIdentity = lstatIdentity(parent);
	const targetIdentity = currentTargetIdentity(target, label, options);
	const replacementMode = options.mode ?? targetIdentity?.mode ?? options.defaultMode ?? 0o666;
	const writeTarget = { parent, parentIdentity, target, label };
	const tempDir = mkdtempSync(join(parent, `.${base}.tmp.`));
	const tempDirIdentity = lstatIdentity(tempDir);
	const tempTarget = join(tempDir, base);
	let tempFd;
	let tempFileIdentity;

	try {
		const opened = openExclusiveFile(tempTarget, `${label} temp file`, replacementMode);
		tempFd = opened.fd;
		tempFileIdentity = opened.identity;
		writeTempFile({ fd: tempFd, tempPath: tempTarget, tempDir, target });
		closeSync(tempFd);
		tempFd = undefined;
		revalidateTempWriteTarget(tempTarget, tempFileIdentity, label);

		revalidateProfileWriteTarget({ ...writeTarget, targetIdentity });
		const backupPath = createTargetBackup(config, writeTarget, targetIdentity, options);
		revalidateProfileWriteTarget({ ...writeTarget, targetIdentity });
		revalidateTempWriteTarget(tempTarget, tempFileIdentity, label);
		renameSync(tempTarget, target);
		tempFileIdentity = undefined;
		return { target, backupPath };
	} catch (error) {
		if (tempFd !== undefined) closeSync(tempFd);
		removeOwnedFile(tempTarget, tempFileIdentity);
		throw error;
	} finally {
		removeOwnedTempDir(tempDir, tempDirIdentity);
	}
}

export function writeSafeProfileFile(config, profilePath, data, label = "TLH profile file", options = {}) {
	return replaceSafeProfileFile(config, profilePath, ({ fd }) => writeFileSync(fd, data), label, options);
}

export function copySafeProfileFile(config, source, relativePath, label = "TLH profile file", options = {}) {
	const sourceStats = lstatSync(source);
	return writeSafeProfileFile(config, relativePath, readFileSync(source), label, {
		...options,
		defaultMode: fileMode(sourceStats),
	});
}

export function fileLinkCount(path) {
	return lstatSync(path).nlink;
}

export function assertSafeSettingsTarget(config, options = {}) {
	const settingsDir = dirname(config.settingsPath);
	const settingsBase = basename(config.settingsPath);
	assertProfilePathWithinAgent(config, settingsDir, "Pi settings directory", options);
	if (isSymlink(config.settingsPath)) {
		throw new Error(`refusing to let Pi write through symlinked isolated settings file: ${config.settingsPath}`);
	}
	if (existsSync(config.settingsPath) && !lstatSync(config.settingsPath).isFile()) {
		throw new Error(`refusing to let Pi replace non-file isolated settings path: ${config.settingsPath}`);
	}
	assertProfilePathWithinAgent(config, config.settingsPath, "Pi settings file", options);
	if (existsSync(config.settingsPath) && fileLinkCount(config.settingsPath) !== 1) {
		throw new Error(`refusing to let Pi mutate hard-linked isolated settings file: ${config.settingsPath}`);
	}
	if (settingsBase !== "settings.json") {
		throw new Error(`unexpected Pi settings filename: ${config.settingsPath}`);
	}
}

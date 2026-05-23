import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { pathIsProtectedPiConfig, pathWithinOrEqual, realpathForCompare } from "./tlh-install-paths.mjs";

const FILE_PERMISSION_MASK = 0o777;
const FILE_MODE_COMPARISON_MASK = 0o7777;
const REQUIRED_OWNER_READ_WRITE_BITS = 0o600;
const DISALLOWED_GROUP_OTHER_WRITE_BITS = 0o022;
const INITIAL_CREATED_FILE_MODE = REQUIRED_OWNER_READ_WRITE_BITS;

function formatMode(mode) {
	return `0o${mode.toString(8)}`;
}

function validateSafeWriteMode(mode, label) {
	if (!Number.isSafeInteger(mode)) {
		throw new Error(`refusing to write ${label} with invalid file mode: ${mode}`);
	}
	if (mode < 0 || mode > FILE_PERMISSION_MASK) {
		throw new Error(`refusing to write ${label} with unsupported file mode outside 0o000-0o777: ${formatMode(mode)}`);
	}
	if ((mode & REQUIRED_OWNER_READ_WRITE_BITS) !== REQUIRED_OWNER_READ_WRITE_BITS) {
		throw new Error(`refusing to write ${label} with unsupported file mode missing owner read/write bits: ${formatMode(mode)}`);
	}
	if ((mode & DISALLOWED_GROUP_OTHER_WRITE_BITS) !== 0) {
		throw new Error(`refusing to write ${label} with unsupported file mode containing group or other write bits: ${formatMode(mode)}`);
	}
	return mode;
}

function lstatIfExists(path) {
	try {
		return lstatSync(path);
	} catch (error) {
		if (error && typeof error === "object" && ["ENOENT", "ENOTDIR"].includes(error.code)) return undefined;
		throw error;
	}
}

function sameFileStats(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}

function assertNotProtectedPiPath(path, label, { homeDir = homedir() } = {}) {
	if (pathIsProtectedPiConfig(path, { homeDir })) {
		throw new Error(`refusing to write ${label} under normal Pi config root: ${path}`);
	}
}

function stableRealpathOfExistingDirectory(path, firstStats, label) {
	const resolved = realpathSync(path);
	const secondStats = lstatIfExists(path);
	if (!secondStats) {
		throw new Error(`refusing to write ${label} because a directory component changed while planning: ${path}`);
	}
	if (secondStats.isSymbolicLink()) {
		throw new Error(`refusing to write ${label} through symlinked directory component: ${path}`);
	}
	if (!secondStats.isDirectory()) {
		throw new Error(`refusing to write ${label} because a directory component is not a directory: ${path}`);
	}
	if (!sameFileStats(firstStats, secondStats)) {
		throw new Error(`refusing to write ${label} because a directory component changed while planning: ${path}`);
	}
	return resolved;
}

function intendedPathFromNearestExistingNonSymlinkAncestor(path, label) {
	const suffixParts = [];
	let current = resolve(path);

	while (true) {
		const stats = lstatIfExists(current);
		if (stats && !stats.isSymbolicLink()) {
			if (!stats.isDirectory()) {
				throw new Error(`refusing to write ${label} because an ancestor is not a directory: ${current}`);
			}
			const resolvedAncestor = stableRealpathOfExistingDirectory(current, stats, `${label} ancestor`);
			return resolve(resolvedAncestor, ...suffixParts);
		}

		const parent = dirname(current);
		if (parent === current) {
			throw new Error(`refusing to write ${label} because no non-symlink directory ancestor was found: ${path}`);
		}
		suffixParts.unshift(basename(current));
		current = parent;
	}
}

function captureIntendedProfileRoot(agentRoot, label) {
	const stats = lstatIfExists(agentRoot);
	if (!stats) return intendedPathFromNearestExistingNonSymlinkAncestor(agentRoot, label);
	if (stats.isSymbolicLink()) {
		throw new Error(`refusing to write ${label} through symlinked TLH profile root: ${agentRoot}`);
	}
	if (!stats.isDirectory()) {
		throw new Error(`refusing to write ${label} because the TLH profile root is not a directory: ${agentRoot}`);
	}
	return stableRealpathOfExistingDirectory(agentRoot, stats, label);
}

function assertProfileRootSafe(plan) {
	assertNotProtectedPiPath(plan.agentRoot, `${plan.label} profile root`, { homeDir: plan.homeDir });
	const stats = lstatIfExists(plan.agentRoot);
	let resolvedAgentRoot;

	if (stats) {
		if (stats.isSymbolicLink()) {
			throw new Error(`refusing to write ${plan.label} through symlinked TLH profile root: ${plan.agentRoot}`);
		}
		if (!stats.isDirectory()) {
			throw new Error(`refusing to write ${plan.label} because the TLH profile root is not a directory: ${plan.agentRoot}`);
		}
		resolvedAgentRoot = stableRealpathOfExistingDirectory(plan.agentRoot, stats, `${plan.label} profile root`);
	} else {
		resolvedAgentRoot = intendedPathFromNearestExistingNonSymlinkAncestor(plan.agentRoot, `${plan.label} profile root`);
	}

	if (resolvedAgentRoot !== plan.intendedAgentDir) {
		throw new Error(`refusing to write ${plan.label} outside the intended TLH profile: ${plan.agentRoot} (resolves to ${resolvedAgentRoot}; intended profile: ${plan.intendedAgentDir})`);
	}
}

function assertNoSymlinkedTargetParents(target, boundary, label) {
	const parent = dirname(target);
	if (!pathWithinOrEqual(boundary, parent)) return;

	const relativeParent = relative(boundary, parent);
	if (!relativeParent) return;

	let current = boundary;
	for (const part of relativeParent.split(sep).filter(Boolean)) {
		current = join(current, part);
		const stats = lstatIfExists(current);
		if (!stats) return;
		if (stats.isSymbolicLink()) {
			throw new Error(`refusing to write ${label} through symlinked target parent component: ${current}`);
		}
		if (!stats.isDirectory()) {
			throw new Error(`refusing to write ${label} because a target parent component is not a directory: ${current}`);
		}
	}
}

function resolvedPathFromRoot(path, root, resolvedRoot) {
	const relativePath = relative(root, path);
	if (relativePath === "") return resolvedRoot;
	if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
		throw new Error(`path is outside the configured root: ${path} (root: ${root})`);
	}
	return resolve(resolvedRoot, relativePath);
}

function assertTargetParentSafe(plan) {
	assertNotProtectedPiPath(plan.targetParent, `${plan.label} parent directory`, { homeDir: plan.homeDir });
	const parentStats = lstatIfExists(plan.targetParent);
	let resolvedTargetParent;

	if (parentStats) {
		if (parentStats.isSymbolicLink()) {
			throw new Error(`refusing to write ${plan.label} through symlinked target parent: ${plan.targetParent}`);
		}
		if (!parentStats.isDirectory()) {
			throw new Error(`refusing to write ${plan.label} because the target parent is not a directory: ${plan.targetParent}`);
		}
		resolvedTargetParent = realpathSync(plan.targetParent);
	} else {
		resolvedTargetParent = realpathForCompare(plan.targetParent);
	}

	if (!pathWithinOrEqual(plan.intendedAgentDir, resolvedTargetParent)) {
		throw new Error(`refusing to write ${plan.label} outside the isolated TLH profile: ${plan.targetParent} (resolves to ${resolvedTargetParent}; profile: ${plan.intendedAgentDir})`);
	}
	if (resolvedTargetParent !== plan.intendedTargetParent) {
		throw new Error(`refusing to write ${plan.label} outside the intended target parent: ${plan.targetParent} (resolves to ${resolvedTargetParent}; intended parent: ${plan.intendedTargetParent})`);
	}
}

function validateAnchoredDirectory(path, expectedResolvedPath, label, firstStats) {
	const stats = firstStats || lstatIfExists(path);
	if (!stats) {
		throw new Error(`refusing to create ${label} because a directory component is missing: ${path}`);
	}
	if (stats.isSymbolicLink()) {
		throw new Error(`refusing to create ${label} through symlinked directory component: ${path}`);
	}
	if (!stats.isDirectory()) {
		throw new Error(`refusing to create ${label} because a directory component is not a directory: ${path}`);
	}

	const resolved = stableRealpathOfExistingDirectory(path, stats, label);
	if (resolved !== expectedResolvedPath) {
		throw new Error(`refusing to create ${label} outside the intended directory: ${path} (resolves to ${resolved}; intended directory: ${expectedResolvedPath})`);
	}
	return resolved;
}

function cleanupCreatedDirectories(createdDirs) {
	for (const created of [...createdDirs].reverse()) {
		try {
			const stats = lstatSync(created.path);
			if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
			if (!sameFileStats(stats, created.stats)) continue;
			rmdirSync(created.path);
		} catch {
			// Best effort only; keep pre-existing, changed, symlinked, or non-empty directories intact.
		}
	}
}

function ensureDirectorySafely(directory, intendedDirectory, label) {
	const targetDir = resolve(directory);
	const intendedDir = resolve(intendedDirectory);
	const missingParts = [];
	let current = targetDir;
	let expectedCurrent = intendedDir;

	while (true) {
		const stats = lstatIfExists(current);
		if (stats) {
			validateAnchoredDirectory(current, expectedCurrent, label, stats);
			break;
		}

		const parent = dirname(current);
		const expectedParent = dirname(expectedCurrent);
		if (parent === current || expectedParent === expectedCurrent) {
			throw new Error(`refusing to create ${label} because no anchored directory ancestor was found: ${directory}`);
		}
		missingParts.unshift(basename(current));
		current = parent;
		expectedCurrent = expectedParent;
	}

	const createdDirs = [];
	try {
		for (const part of missingParts) {
			validateAnchoredDirectory(current, expectedCurrent, label);
			const child = join(current, part);
			const expectedChild = resolve(expectedCurrent, part);
			const childStats = lstatIfExists(child);

			if (childStats) {
				validateAnchoredDirectory(child, expectedChild, label, childStats);
			} else {
				try {
					mkdirSync(child);
				} catch (error) {
					if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
					const racedStats = lstatIfExists(child);
					validateAnchoredDirectory(child, expectedChild, label, racedStats);
					current = child;
					expectedCurrent = expectedChild;
					continue;
				}

				validateAnchoredDirectory(current, expectedCurrent, label);
				const createdStats = lstatSync(child);
				validateAnchoredDirectory(child, expectedChild, label, createdStats);
				createdDirs.push({ path: child, stats: createdStats });
			}

			current = child;
			expectedCurrent = expectedChild;
		}

		validateAnchoredDirectory(targetDir, intendedDir, label);
	} catch (error) {
		cleanupCreatedDirectories(createdDirs);
		throw error;
	}
}

function validateOpenedFileForDirectWrite(fd, path, intendedRoot, label) {
	const fdStats = fstatSync(fd);
	if (!fdStats.isFile()) {
		throw new Error(`refusing to write ${label} because the opened path is not a regular file: ${path}`);
	}

	let pathStats;
	try {
		pathStats = lstatSync(path);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`refusing to write ${label} because the opened path could not be validated: ${path} (${message})`);
	}

	if (pathStats.isSymbolicLink()) {
		throw new Error(`refusing to write ${label} through a symlinked path: ${path}`);
	}
	if (!pathStats.isFile()) {
		throw new Error(`refusing to write ${label} because the path is not a regular file: ${path}`);
	}
	if (!sameFileStats(fdStats, pathStats)) {
		throw new Error(`refusing to write ${label} because the opened file no longer matches the target path: ${path}`);
	}
	if (fdStats.nlink !== 1) {
		throw new Error(`refusing to write ${label} because the target has ${fdStats.nlink} hard links: ${path}`);
	}

	const resolvedPath = realpathSync(path);
	if (!pathWithinOrEqual(intendedRoot, resolvedPath)) {
		throw new Error(`refusing to write ${label} outside the intended directory: ${path} (resolves to ${resolvedPath}; intended directory: ${intendedRoot})`);
	}
}

function cleanupCreatedEmptyFile(fd, path) {
	let fdStats;
	let pathStats;
	try {
		fdStats = fstatSync(fd);
		pathStats = lstatSync(path);
	} catch {
		return false;
	}

	if (!fdStats.isFile() || !pathStats.isFile() || pathStats.isSymbolicLink()) return false;
	if (!sameFileStats(fdStats, pathStats)) return false;
	if (fdStats.size !== 0 || pathStats.size !== 0) return false;
	if (fdStats.nlink !== 1 || pathStats.nlink !== 1) return false;

	try {
		closeSync(fd);
	} catch {
		return false;
	}
	try {
		unlinkSync(path);
	} catch {
		// Best effort only; validation has already failed and no content was written.
	}
	return true;
}

function shouldTightenModeBeforeWrite(currentMode, requestedMode) {
	return requestedMode !== currentMode && (requestedMode & ~currentMode) === 0;
}

function writeDirectValidated(path, content, { mode, intendedRoot, label, exclusive = false, replace = false, validateParent }) {
	let fd;
	let createdByUs = false;
	let validationComplete = false;
	try {
		if (validateParent) validateParent();
		const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		const targetStats = lstatIfExists(path);
		if (targetStats) {
			if (targetStats.isSymbolicLink()) {
				throw new Error(`refusing to write ${label} through a symlinked path: ${path}`);
			}
			if (!targetStats.isFile()) {
				throw new Error(`refusing to write ${label} because the path is not a regular file: ${path}`);
			}
			if (exclusive) {
				throw new Error(`refusing to write ${label} because the path already exists: ${path}`);
			}
			fd = openSync(path, constants.O_RDWR | noFollowFlag, mode);
		} else {
			fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollowFlag, INITIAL_CREATED_FILE_MODE);
			createdByUs = true;
		}
		if (validateParent) validateParent();
		validateOpenedFileForDirectWrite(fd, path, intendedRoot, label);
		validationComplete = true;

		const currentMode = fstatSync(fd).mode & FILE_MODE_COMPARISON_MASK;
		if (!createdByUs && shouldTightenModeBeforeWrite(currentMode, mode)) {
			fchmodSync(fd, mode);
		}
		if (replace) ftruncateSync(fd, 0);
		writeFileSync(fd, content);
		fchmodSync(fd, mode);
	} catch (error) {
		if (createdByUs && !validationComplete && fd !== undefined && cleanupCreatedEmptyFile(fd, path)) {
			fd = undefined;
		}
		throw error;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * Captures a direct-write plan for a managed tlh profile file.
 *
 * Safety policy:
 * - anchor all later containment checks to the captured realpath of the configured profile root
 * - allow symlink ancestors above `agentDir` only when that resolved profile root and the resolved target still stay inside the intended profile
 * - reject symlinked profile roots, target parents, and final targets inside the managed profile path
 */
export function createSafeTlhProfileWritePlan({ agentDir, targetPath, label = "TLH profile file", homeDir = homedir() }) {
	const agentRoot = resolve(agentDir);
	const target = resolve(targetPath);
	assertNotProtectedPiPath(agentRoot, `${label} profile root`, { homeDir });
	assertNotProtectedPiPath(target, label, { homeDir });
	if (target === agentRoot) {
		throw new Error(`refusing to write ${label} over the configured TLH profile directory: ${target}`);
	}
	if (!pathWithinOrEqual(agentRoot, target)) {
		throw new Error(`refusing to write ${label} outside the configured TLH profile path: ${target} (profile: ${agentRoot})`);
	}

	const intendedAgentDir = captureIntendedProfileRoot(agentRoot, `${label} profile root`);
	const plan = {
		agentRoot,
		homeDir,
		intendedAgentDir,
		intendedTargetParent: "",
		label,
		targetPath: target,
		targetParent: dirname(target),
	};
	assertProfileRootSafe(plan);

	const targetStats = lstatIfExists(target);
	if (targetStats?.isSymbolicLink()) {
		throw new Error(`refusing to write ${label} through a symlinked path: ${target}`);
	}
	if (targetStats && !targetStats.isFile()) {
		throw new Error(`refusing to write ${label} because the path is not a regular file: ${target}`);
	}

	assertNoSymlinkedTargetParents(target, agentRoot, label);

	const resolvedTarget = realpathForCompare(target);
	if (!pathWithinOrEqual(intendedAgentDir, resolvedTarget)) {
		throw new Error(`refusing to write ${label} outside the isolated TLH profile: ${target} (resolves to ${resolvedTarget}; profile: ${intendedAgentDir})`);
	}

	plan.intendedTargetParent = resolvedPathFromRoot(plan.targetParent, agentRoot, intendedAgentDir);
	assertTargetParentSafe(plan);
	return Object.freeze(plan);
}

/**
 * Writes directly to `plan.targetPath` in place.
 *
 * This helper does not provide atomic rename semantics, backups, or rollback/crash-recovery guarantees.
 * Callers that need recovery must create backups before writing.
 *
 * `replace: true` truncates before writing. `replace: false` writes from offset 0 without truncating,
 * so shorter content can leave trailing bytes behind.
 *
 * Accepted modes are safe integer permission bits within `0o000..0o777` that keep owner read/write,
 * reject special bits, and reject group/other write bits. This preserves `0o600`/`0o640` behavior while
 * still allowing future managed executable profile artifacts such as `0o755`.
 */
export function writeSafeTlhProfileFile(plan, content, { mode = 0o600, exclusive = false, replace } = {}) {
	const validatedMode = validateSafeWriteMode(mode, plan.label);
	const replaceContent = replace ?? !exclusive;
	ensureDirectorySafely(plan.targetParent, plan.intendedTargetParent, `${plan.label} parent directory`);
	assertProfileRootSafe(plan);
	assertTargetParentSafe(plan);
	writeDirectValidated(plan.targetPath, content, {
		exclusive,
		intendedRoot: plan.intendedTargetParent,
		label: plan.label,
		mode: validatedMode,
		replace: replaceContent,
		validateParent: () => {
			assertProfileRootSafe(plan);
			assertTargetParentSafe(plan);
		},
	});
	return plan.targetPath;
}

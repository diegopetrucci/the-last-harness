import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

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

export function isSymlink(path) {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

export function validateProfileRelativePath(relativePath, label = "TLH profile path") {
	if (!relativePath || relativePath.startsWith("/") || relativePath.endsWith("/")) {
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

export function ensureSafeProfileDir(config, relativePath, label = "TLH profile directory", options = {}) {
	validateProfileRelativePath(relativePath, label);
	if (isSymlink(config.agentDir)) {
		throw new Error(`refusing to write ${label} through symlinked TLH profile path: ${config.agentDir}`);
	}
	const root = realpathForCompare(config.agentDir);
	assertProfilePathWithinAgent(config, root, label, options);
	if (existsSync(root) && !lstatSync(root).isDirectory()) {
		throw new Error(`refusing to use non-directory TLH profile root for ${label}: ${config.agentDir}`);
	}
	if (!existsSync(root)) mkdirSync(root, { recursive: true });

	let cursor = root;
	for (const component of relativePath.split("/")) {
		cursor = join(cursor, component);
		if (isSymlink(cursor)) {
			throw new Error(`refusing to write ${label} through symlinked TLH profile path: ${cursor}`);
		}
		if (existsSync(cursor) && !lstatSync(cursor).isDirectory()) {
			throw new Error(`refusing to use non-directory TLH profile path for ${label}: ${cursor}`);
		}
		if (!existsSync(cursor)) mkdirSync(cursor);
		assertProfilePathWithinAgent(config, cursor, label, options);
	}
	return cursor;
}

export function safeProfileFileTarget(config, relativePath, label = "TLH profile file", options = {}) {
	validateProfileRelativePath(relativePath, label);
	const parentSeparatorIndex = relativePath.lastIndexOf("/");
	if (parentSeparatorIndex < 1 || parentSeparatorIndex === relativePath.length - 1) {
		throw new Error(`refusing unsafe ${label}: ${relativePath}`);
	}
	const parentRelative = relativePath.slice(0, parentSeparatorIndex);
	const base = basename(relativePath);
	const parent = ensureSafeProfileDir(config, parentRelative, `${label} parent directory`, options);
	const target = join(parent, base);
	if (isSymlink(target)) {
		throw new Error(`refusing to replace symlinked ${label}: ${target}`);
	}
	if (existsSync(target) && !lstatSync(target).isFile()) {
		throw new Error(`refusing to replace non-file ${label}: ${target}`);
	}
	assertProfilePathWithinAgent(config, target, label, options);
	return target;
}

export function copySafeProfileFile(config, source, relativePath, label = "TLH profile file", options = {}) {
	const target = safeProfileFileTarget(config, relativePath, label, options);
	const tempDir = mkdtempSync(join(dirname(target), `.${basename(target)}.tmp.`));
	const tempTarget = join(tempDir, basename(target));
	try {
		copyFileSync(source, tempTarget);
		renameSync(tempTarget, target);
	} catch (error) {
		rmSync(tempTarget, { force: true });
		throw error;
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
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
	if (existsSync(config.settingsPath) && lstatSync(config.settingsPath).nlink !== 1) {
		throw new Error(`refusing to let Pi mutate hard-linked isolated settings file: ${config.settingsPath}`);
	}
	if (settingsBase !== "settings.json") {
		throw new Error(`unexpected Pi settings filename: ${config.settingsPath}`);
	}
}

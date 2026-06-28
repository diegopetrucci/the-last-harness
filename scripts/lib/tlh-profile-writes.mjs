import { homedir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";

import {
	pathIsProtectedPiConfig,
	pathWithinOrEqual,
	realpathForCompare,
	validateProfileRelativePath,
} from "./tlh-install-paths.mjs";
import { writeSafeProfileFile } from "./tlh-safe-profile-write.mjs";

// Historical stage-0 installers fetched this path from main.
// Keep this file as a compatibility shim that forwards safe profile writes to
// the current helper surface without affecting modern TLH install behavior.
function validateMode(mode, label) {
	if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) {
		throw new Error(`refusing to write ${label} with invalid file mode: ${mode}`);
	}
	if ((mode & 0o022) !== 0) {
		throw new Error(`refusing to write ${label} with unsafe group/world-writable file mode: ${mode.toString(8)}`);
	}
	return mode;
}

function relativeProfilePath(agentDir, targetPath, label) {
	const resolvedAgentDir = resolve(agentDir);
	const resolvedTargetPath = resolve(targetPath);
	if (resolvedTargetPath === resolvedAgentDir) {
		throw new Error(`refusing to write ${label} over the configured TLH profile directory: ${resolvedTargetPath}`);
	}
	if (!pathWithinOrEqual(resolvedAgentDir, resolvedTargetPath)) {
		throw new Error(`refusing to write ${label} outside the configured TLH profile path: ${resolvedTargetPath} (profile: ${resolvedAgentDir})`);
	}
	const relativePath = relative(resolvedAgentDir, resolvedTargetPath);
	if (!relativePath || relativePath === ".") {
		throw new Error(`refusing unsafe ${label}: ${targetPath}`);
	}
	for (const component of relativePath.split(sep)) {
		if (!component || component === "." || component === "..") {
			throw new Error(`refusing unsafe ${label}: ${targetPath}`);
		}
	}
	validateProfileRelativePath(relativePath, label);
	return relativePath;
}

export function createSafeTlhProfileWritePlan({ agentDir, targetPath, label = "TLH profile file", homeDir = homedir() }) {
	const resolvedAgentDir = resolve(agentDir);
	const resolvedTargetPath = resolve(targetPath);
	const normalizedAgentDir = realpathForCompare(resolvedAgentDir);
	const normalizedTargetPath = realpathForCompare(resolvedTargetPath);
	if (pathIsProtectedPiConfig(normalizedAgentDir, { homeDir, alreadyNormalized: true })) {
		throw new Error(`refusing to write ${label} under normal Pi config root: ${resolvedAgentDir}`);
	}
	if (pathIsProtectedPiConfig(normalizedTargetPath, { homeDir, alreadyNormalized: true })) {
		throw new Error(`refusing to write ${label} under normal Pi config root: ${resolvedTargetPath}`);
	}
	const relativePath = relativeProfilePath(resolvedAgentDir, resolvedTargetPath, label);
	return Object.freeze({
		agentDir: resolvedAgentDir,
		agentRoot: resolvedAgentDir,
		homeDir,
		intendedAgentDir: normalizedAgentDir,
		intendedTargetParent: realpathForCompare(dirname(resolvedTargetPath)),
		label,
		targetPath: resolvedTargetPath,
		targetParent: dirname(resolvedTargetPath),
		relativePath,
	});
}

export function writeSafeTlhProfileFile(plan, content, { mode = 0o600, exclusive = false } = {}) {
	const agentDir = plan.agentRoot || plan.agentDir;
	const label = plan.label || "TLH profile file";
	const targetPath = plan.targetPath;
	const validatedMode = validateMode(mode, label);
	if (exclusive) {
		throw new Error(`refusing to write ${label} with exclusive mode through the stale compatibility shim because atomic exclusive writes are unsupported`);
	}
	return writeSafeProfileFile(
		{ agentDir },
		plan.relativePath || relativeProfilePath(agentDir, targetPath, label),
		content,
		label,
		{ mode: validatedMode },
	);
}

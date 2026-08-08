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
		throw new Error(
			`refusing to write ${label} outside the configured TLH profile path: ${resolvedTargetPath} (profile: ${resolvedAgentDir})`,
		);
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

function presentPlanString(plan, key, label) {
	if (plan?.[key] === undefined) {
		return undefined;
	}
	if (typeof plan[key] !== "string" || plan[key].length === 0) {
		throw new Error(`refusing to write ${label} with malformed compatibility plan ${key}`);
	}
	return plan[key];
}

function validatedPlanPaths(plan, label) {
	const agentRoot = presentPlanString(plan, "agentRoot", label);
	const legacyAgentDir = presentPlanString(plan, "agentDir", label);
	const agentDir = agentRoot ?? legacyAgentDir;
	const targetPath = presentPlanString(plan, "targetPath", label);
	if (agentDir === undefined || targetPath === undefined) {
		throw new Error(`refusing to write ${label} with malformed compatibility plan`);
	}
	if (agentRoot !== undefined && legacyAgentDir !== undefined && resolve(agentRoot) !== resolve(legacyAgentDir)) {
		throw new Error(`refusing to write ${label} with mismatched compatibility plan profile roots`);
	}

	const intendedAgentDir = presentPlanString(plan, "intendedAgentDir", label);
	if (intendedAgentDir !== undefined && resolve(intendedAgentDir) !== realpathForCompare(agentDir)) {
		throw new Error(`refusing to write ${label} with mismatched compatibility plan intended profile root`);
	}
	const lexicalTargetParent = dirname(resolve(targetPath));
	const targetParent = presentPlanString(plan, "targetParent", label);
	if (targetParent !== undefined && resolve(targetParent) !== lexicalTargetParent) {
		throw new Error(`refusing to write ${label} with mismatched compatibility plan target parent`);
	}
	const intendedTargetParent = presentPlanString(plan, "intendedTargetParent", label);
	if (intendedTargetParent !== undefined && resolve(intendedTargetParent) !== realpathForCompare(lexicalTargetParent)) {
		throw new Error(`refusing to write ${label} with mismatched compatibility plan intended target parent`);
	}

	const derivedRelativePath = relativeProfilePath(agentDir, targetPath, label);
	if (plan.relativePath === undefined) {
		return { agentDir, relativePath: derivedRelativePath };
	}
	if (typeof plan.relativePath !== "string") {
		throw new Error(`refusing to write ${label} with malformed compatibility plan relative path`);
	}
	validateProfileRelativePath(plan.relativePath, label);
	if (plan.relativePath !== derivedRelativePath) {
		throw new Error(
			`refusing to write ${label} with forged compatibility plan target: ${plan.relativePath} (expected ${derivedRelativePath})`,
		);
	}
	return { agentDir, relativePath: derivedRelativePath };
}

export function createSafeTlhProfileWritePlan({
	agentDir,
	targetPath,
	label = "TLH profile file",
	homeDir = homedir(),
}) {
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
	const label = plan?.label || "TLH profile file";
	const validatedMode = validateMode(mode, label);
	if (exclusive) {
		throw new Error(
			`refusing to write ${label} with exclusive mode through the stale compatibility shim because atomic exclusive writes are unsupported`,
		);
	}
	const { agentDir, relativePath } = validatedPlanPaths(plan, label);
	return writeSafeProfileFile({ agentDir }, relativePath, content, label, { mode: validatedMode });
}

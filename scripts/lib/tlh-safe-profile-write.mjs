import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import {
	assertProfilePathWithinAgent,
	ensureSafeProfileDir,
	realpathForCompare,
	validateProfileRelativePath,
	isSymlink,
} from "./tlh-install-paths.mjs";

function ensureSafeProfileRoot(config, label, options) {
	if (isSymlink(config.agentDir)) {
		throw new Error(`refusing to write ${label} through symlinked TLH profile path: ${config.agentDir}`);
	}
	const root = realpathForCompare(config.agentDir);
	assertProfilePathWithinAgent(config, root, label, options);
	if (existsSync(root) && !lstatSync(root).isDirectory()) {
		throw new Error(`refusing to use non-directory TLH profile root for ${label}: ${config.agentDir}`);
	}
	if (!existsSync(root)) mkdirSync(root, { recursive: true });
	return root;
}

function safeProfileWriteTarget(config, relativePath, label, options) {
	validateProfileRelativePath(relativePath, label);
	const base = basename(relativePath);
	const parentRelative = dirname(relativePath);
	const parent = parentRelative === "."
		? ensureSafeProfileRoot(config, `${label} parent directory`, options)
		: ensureSafeProfileDir(config, parentRelative, `${label} parent directory`, options);
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

function writeOptionsFor(content, mode, encoding) {
	const options = {};
	if (mode !== undefined) options.mode = mode;
	if (typeof content === "string") options.encoding = encoding || "utf8";
	return options;
}

function tempDirIdentity(tempDir) {
	const stats = lstatSync(tempDir);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error(`refusing to clean up unexpected temp directory type: ${tempDir}`);
	}
	return { dev: stats.dev, ino: stats.ino };
}

function cleanupTempDir(tempDir, expectedIdentity) {
	if (!existsSync(tempDir)) return;
	const stats = lstatSync(tempDir);
	if (!stats.isDirectory() || stats.isSymbolicLink()) return;
	if (stats.dev !== expectedIdentity.dev || stats.ino !== expectedIdentity.ino) return;
	rmSync(tempDir, { recursive: true, force: true });
}

export function writeSafeProfileFile(config, relativePath, content, label = "TLH profile file", options = {}) {
	const target = safeProfileWriteTarget(config, relativePath, label, options);
	const resolvedMode = options.mode ?? (existsSync(target) ? (lstatSync(target).mode & 0o777) : undefined);
	const parent = dirname(target);
	const base = basename(target);
	const tempDir = mkdtempSync(join(parent, `.${base}.tmp.`));
	const expectedTempDirIdentity = tempDirIdentity(tempDir);
	const tempTarget = join(tempDir, base);

	try {
		writeFileSync(tempTarget, content, writeOptionsFor(content, resolvedMode, options.encoding));
		if (resolvedMode !== undefined) chmodSync(tempTarget, resolvedMode);
		if (typeof options.beforeCommit === "function") {
			options.beforeCommit({ parent, target, tempDir, tempTarget });
		}
		const verifiedTarget = safeProfileWriteTarget(config, relativePath, label, options);
		if (verifiedTarget !== target) {
			throw new Error(`refusing to replace moved ${label}: ${target}`);
		}
		renameSync(tempTarget, target);
	} finally {
		cleanupTempDir(tempDir, expectedTempDirIdentity);
	}

	return target;
}

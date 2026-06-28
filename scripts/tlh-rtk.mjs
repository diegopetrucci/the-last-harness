#!/usr/bin/env node
import { accessSync, closeSync, constants, existsSync, fchmodSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

import {
	assignOptionValue,
	expandHomePath,
	resolveTlhAgentDir,
} from "./lib/tlh-install-utils.mjs";

const VALIDATION_TIMEOUT_MS = 5_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_RTK_REPO = "rtk-ai/rtk";
const DEFAULT_RTK_VERSION = "0.42.4";
const SAFE_HELPER_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);
const PINNED_RTK_RELEASES = Object.freeze({
	"darwin-arm64": Object.freeze({
		assetName: "rtk-aarch64-apple-darwin.tar.gz",
		assetSha256: "f223ca074a0215af002679bc1d34ca92b93e25b3e8ae16aace6e84c06e586802",
		binarySha256: "bd5caeed9bade5fa95984be42b5801b6c1a7b0c0cc158a1c698de09104d1ab2f",
	}),
	"darwin-x64": Object.freeze({
		assetName: "rtk-x86_64-apple-darwin.tar.gz",
		assetSha256: "84121316867613e61925c209607f033b2113bb0ce312c267a79d3e3e8f221e49",
		binarySha256: "93279fcc6de69a5572870b08c79365505279ab9122aa9534d6ed71a357897070",
	}),
	"linux-arm64": Object.freeze({
		assetName: "rtk-aarch64-unknown-linux-gnu.tar.gz",
		assetSha256: "cc2b91c064eb670c097c184913c8fbcb1a943d53d7fe505375e96ba0c5b6459f",
		binarySha256: "de3ad14d390bef0b102be4c8153b714f3ee0a85b4defc3a438155de86fc8e3a8",
	}),
	"linux-x64": Object.freeze({
		assetName: "rtk-x86_64-unknown-linux-musl.tar.gz",
		assetSha256: "34975116da11e09e502501daf758143e0b22ed3a42a10eb67fb693a6270d9e36",
		binarySha256: "1d8bf5f1861f5ce33236400b1d93b967aec30b6a456e9a0b43b1584c5200119a",
	}),
});

function usage() {
	return `Usage: tlh-rtk.mjs <command>

Installer-internal helper for managing the The Last Harness RTK binary.

Commands:
  install-managed      Ensure the pinned managed rtk binary exists in the isolated profile
  validate [path]      Validate a pinned rtk binary, or print the first valid candidate

Options:
  --agent-dir <dir>    Isolated Pi agent dir (default: ~/.the-last-harness/agent, or PI_CODING_AGENT_DIR)
  --target <path>      Managed rtk install target (default: <agent-dir>/bin/rtk)
  --detail             Print verbose/dry-run installer details
  --dry-run            Print intended changes without writing
  --quiet              Only print errors
  -h, --help           Show this help
`;
}

function parseArgs(argv) {
	const args = {
		agentDir: undefined,
		target: undefined,
		rtkRepo: DEFAULT_RTK_REPO,
		rtkVersion: DEFAULT_RTK_VERSION,
		unsafeTestDownloadUrl: undefined,
		unsafeTestAssetName: undefined,
		unsafeTestAssetSha256: undefined,
		unsafeTestBinarySha256: undefined,
		command: undefined,
		commandArgs: [],
		dryRun: false,
		detail: false,
		quiet: false,
		help: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "-h" || arg === "--help") {
			args.help = true;
			continue;
		}
		if (arg === "--dry-run") {
			args.dryRun = true;
			continue;
		}
		if (arg === "--detail") {
			args.detail = true;
			continue;
		}
		if (arg === "--quiet") {
			args.quiet = true;
			continue;
		}
		const agentDirIndex = assignOptionValue(args, "agentDir", argv, index, "--agent-dir");
		if (agentDirIndex !== undefined) {
			index = agentDirIndex;
			continue;
		}
		const targetIndex = assignOptionValue(args, "target", argv, index, "--target");
		if (targetIndex !== undefined) {
			index = targetIndex;
			continue;
		}
		const versionIndex = assignOptionValue(args, "rtkVersion", argv, index, "--unsafe-test-rtk-version");
		if (versionIndex !== undefined) {
			index = versionIndex;
			continue;
		}
		const urlIndex = assignOptionValue(args, "unsafeTestDownloadUrl", argv, index, "--unsafe-test-download-url");
		if (urlIndex !== undefined) {
			index = urlIndex;
			continue;
		}
		const assetNameIndex = assignOptionValue(args, "unsafeTestAssetName", argv, index, "--unsafe-test-asset-name");
		if (assetNameIndex !== undefined) {
			index = assetNameIndex;
			continue;
		}
		const assetShaIndex = assignOptionValue(args, "unsafeTestAssetSha256", argv, index, "--unsafe-test-asset-sha256");
		if (assetShaIndex !== undefined) {
			index = assetShaIndex;
			continue;
		}
		const binaryShaIndex = assignOptionValue(args, "unsafeTestBinarySha256", argv, index, "--unsafe-test-binary-sha256");
		if (binaryShaIndex !== undefined) {
			index = binaryShaIndex;
			continue;
		}
		if (arg.startsWith("-")) {
			throw new Error(`Unknown option: ${arg}`);
		}
		if (!args.command) {
			args.command = arg;
		} else {
			args.commandArgs.push(arg);
		}
	}

	return args;
}

function logStderr(args, message) {
	if (!args.quiet) console.error(message);
}

function warnStderr(args, message) {
	if (!args.quiet) console.error(`warning: ${message}`);
}

function detailLog(args, message) {
	if (!args.quiet && args.detail) console.error(message);
}

function realpathIfPossible(path) {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

function sanitizedHelperPath(pathValue, agentDir) {
	const cwd = resolve(process.cwd());
	const cwdRealpath = realpathIfPossible(cwd);
	const managedBin = resolve(agentDir, "bin");
	const managedBinRealpath = realpathIfPossible(managedBin);
	const sanitizedPath = (pathValue === undefined ? [] : String(pathValue).split(delimiter))
		.filter((entry) => {
			if (!entry) return false;
			const resolvedEntry = resolve(entry);
			if (resolvedEntry === cwd || resolvedEntry === managedBin) return false;
			const entryRealpath = realpathIfPossible(resolvedEntry);
			if (entryRealpath && cwdRealpath && entryRealpath === cwdRealpath) return false;
			if (entryRealpath && managedBinRealpath && entryRealpath === managedBinRealpath) return false;
			return true;
		})
		.join(delimiter);
	return sanitizedPath || SAFE_HELPER_PATH;
}

function helperEnv(agentDir, extraEnv = {}) {
	const env = { ...process.env, ...extraEnv };
	return {
		...env,
		PATH: sanitizedHelperPath(env.PATH, agentDir),
	};
}

function safeHelperEnv(extraEnv = {}) {
	return {
		...process.env,
		...extraEnv,
		PATH: SAFE_HELPER_PATH,
	};
}

function commandHasPathSeparator(command) {
	return command.includes("/") || command.includes("\\");
}

function isExecutableFile(path) {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		const fd = openSync(path, constants.O_RDONLY | noFollowFlag);
		try {
			return true;
		} finally {
			closeSync(fd);
		}
	} catch {
		return false;
	}
}

function resolveCommandFromPath(command, pathValue = process.env.PATH) {
	if (commandHasPathSeparator(command)) return resolve(command);
	for (const entry of String(pathValue || "").split(delimiter)) {
		if (!entry) continue;
		const candidate = resolve(entry, command);
		if (isExecutableFile(candidate)) return candidate;
	}
	return undefined;
}

function commandPath(command, agentDir) {
	return resolveCommandFromPath(command, helperEnv(agentDir).PATH);
}

function safeHelperCommandPath(command) {
	for (const entry of SAFE_HELPER_PATH.split(delimiter)) {
		if (!entry) continue;
		const candidate = resolve(entry, command);
		const resolvedCandidate = realpathIfPossible(candidate);
		if (resolvedCandidate && isExecutableFile(resolvedCandidate)) {
			return resolvedCandidate;
		}
	}
	throw new Error(`Required helper command was not found in the safe helper PATH: ${command}`);
}

function normalizeValidCandidate(candidate, agentDir) {
	if (candidate === "rtk") return commandPath("rtk", agentDir) || candidate;
	return candidate;
}

function realpathForCompare(path) {
	const resolved = resolve(path);
	if (existsSync(resolved)) return realpathSync(resolved);
	const parent = dirname(resolved);
	if (parent === resolved) return resolved;
	return join(realpathForCompare(parent), basename(resolved));
}

function isUnderNormalPiConfig(path) {
	const normalPiRoot = realpathForCompare(join(homedir(), ".pi"));
	const resolvedPath = realpathForCompare(path);
	return resolvedPath === normalPiRoot || resolvedPath.startsWith(`${normalPiRoot}${sep}`);
}

function assertNotNormalPiPath(path, label) {
	if (isUnderNormalPiConfig(path)) {
		throw new Error(`Refusing to modify normal Pi config from The Last Harness RTK command (${label}): ${path}`);
	}
}

function lstatIfExists(path) {
	try {
		return lstatSync(path);
	} catch (error) {
		if (error && typeof error === "object" && ["ENOENT", "ENOTDIR"].includes(error.code)) return undefined;
		throw error;
	}
}

function isPathInsideOrEqual(path, root) {
	const relativePath = relative(root, path);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function sameFileStats(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}

function stableRealpathOfExistingDirectory(path, firstStats, label) {
	const resolved = realpathSync(path);
	const secondStats = lstatIfExists(path);
	if (!secondStats) {
		throw new Error(`Refusing to install managed RTK because ${label} changed while planning: ${path}`);
	}
	if (secondStats.isSymbolicLink()) {
		throw new Error(`Refusing to install managed RTK through symlinked ${label}: ${path}`);
	}
	if (!secondStats.isDirectory()) {
		throw new Error(`Refusing to install managed RTK because ${label} is not a directory: ${path}`);
	}
	if (!sameFileStats(firstStats, secondStats)) {
		throw new Error(`Refusing to install managed RTK because ${label} changed while planning: ${path}`);
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
				throw new Error(`Refusing to install managed RTK because ${label} ancestor is not a directory: ${current}`);
			}
			const resolvedAncestor = stableRealpathOfExistingDirectory(current, stats, `${label} ancestor`);
			return resolve(resolvedAncestor, ...suffixParts);
		}

		const parent = dirname(current);
		if (parent === current) {
			throw new Error(`Refusing to install managed RTK because no non-symlink directory ancestor was found for ${label}: ${path}`);
		}
		suffixParts.unshift(basename(current));
		current = parent;
	}
}

function captureIntendedManagedAgentDir(agentRoot) {
	const stats = lstatIfExists(agentRoot);
	if (!stats) return intendedPathFromNearestExistingNonSymlinkAncestor(agentRoot, "managed agent root");
	if (stats.isSymbolicLink()) {
		throw new Error(`Refusing to install managed RTK through symlinked managed agent root: ${agentRoot}`);
	}
	if (!stats.isDirectory()) {
		throw new Error(`Refusing to install managed RTK because managed agent root is not a directory: ${agentRoot}`);
	}
	return stableRealpathOfExistingDirectory(agentRoot, stats, "managed agent root");
}

function assertManagedRtkAgentRootSafe({ agentRoot, intendedAgentDir }) {
	const stats = lstatIfExists(agentRoot);
	let resolvedAgentDir;

	if (stats) {
		if (stats.isSymbolicLink()) {
			throw new Error(`Refusing to install managed RTK through symlinked managed agent root: ${agentRoot}`);
		}
		if (!stats.isDirectory()) {
			throw new Error(`Refusing to install managed RTK because managed agent root is not a directory: ${agentRoot}`);
		}
		resolvedAgentDir = stableRealpathOfExistingDirectory(agentRoot, stats, "managed agent root");
	} else {
		resolvedAgentDir = intendedPathFromNearestExistingNonSymlinkAncestor(agentRoot, "managed agent root");
	}

	if (resolvedAgentDir !== intendedAgentDir) {
		throw new Error(`Refusing to install managed RTK outside the intended tlh profile: ${agentRoot} (resolves to ${resolvedAgentDir}; intended profile: ${intendedAgentDir})`);
	}
}

function assertNoSymlinkedManagedTargetParents(target, boundary) {
	const parent = dirname(target);
	if (!isPathInsideOrEqual(parent, boundary)) return;

	const relativeParent = relative(boundary, parent);
	if (!relativeParent) return;

	let current = boundary;
	for (const part of relativeParent.split(sep).filter(Boolean)) {
		current = join(current, part);
		const stats = lstatIfExists(current);
		if (!stats) return;
		if (stats.isSymbolicLink()) {
			throw new Error(`Refusing to install managed RTK through symlinked target parent component: ${current}`);
		}
		if (!stats.isDirectory()) {
			throw new Error(`Refusing to install managed RTK because target parent component is not a directory: ${current}`);
		}
	}
}

function resolvedPathFromRoot(path, root, resolvedRoot) {
	const relativePath = relative(root, path);
	if (relativePath === "") return resolvedRoot;
	if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
		throw new Error(`Path is outside the configured root: ${path} (root: ${root})`);
	}
	return resolve(resolvedRoot, relativePath);
}

function managedRtkTargetPath(args, agentDir) {
	const agentRoot = resolve(expandHomePath(agentDir));
	return resolve(expandHomePath(args.target || join(agentRoot, "bin", "rtk")));
}

function managedRtkTargetPlan(args, agentDir) {
	const agentRoot = resolve(expandHomePath(agentDir));
	const target = managedRtkTargetPath(args, agentDir);

	assertNotNormalPiPath(agentRoot, "agent dir");
	assertNotNormalPiPath(target, "managed rtk target");
	if (target === agentRoot) {
		throw new Error(`Refusing to install managed RTK over the configured tlh profile directory: ${target}`);
	}
	if (!isPathInsideOrEqual(target, agentRoot)) {
		throw new Error(`Refusing to install managed RTK outside the configured tlh profile path: ${target} (profile: ${agentRoot})`);
	}
	if (basename(target) !== "rtk") {
		throw new Error(`Refusing to install managed RTK because the target basename must be exactly "rtk": ${target}`);
	}

	const intendedAgentDir = captureIntendedManagedAgentDir(agentRoot);
	const planBase = { agentRoot, intendedAgentDir };
	assertManagedRtkAgentRootSafe(planBase);

	const targetStats = lstatIfExists(target);
	if (targetStats?.isSymbolicLink()) {
		throw new Error(`Refusing to install managed RTK over symlinked target file: ${target}`);
	}
	if (targetStats && !targetStats.isFile()) {
		throw new Error(`Refusing to install managed RTK over non-file target: ${target}`);
	}

	assertNoSymlinkedManagedTargetParents(target, agentRoot);

	const resolvedTarget = realpathForCompare(target);
	if (!isPathInsideOrEqual(resolvedTarget, intendedAgentDir)) {
		throw new Error(`Refusing to install managed RTK outside the isolated tlh profile: ${target} (resolves to ${resolvedTarget}; profile: ${intendedAgentDir})`);
	}

	const targetParent = dirname(target);
	const intendedTargetParent = resolvedPathFromRoot(targetParent, agentRoot, intendedAgentDir);
	const plan = { ...planBase, target, targetParent, intendedTargetParent };
	assertManagedRtkTargetParentSafe(plan);
	return plan;
}

function validateManagedRtkTarget(args, agentDir) {
	return managedRtkTargetPlan(args, agentDir).target;
}

function assertManagedRtkTargetParentSafe({ targetParent, intendedAgentDir, intendedTargetParent }) {
	const parentStats = lstatIfExists(targetParent);
	let resolvedTargetParent;

	if (parentStats) {
		if (parentStats.isSymbolicLink()) {
			throw new Error(`Refusing to install managed RTK through symlinked target parent: ${targetParent}`);
		}
		if (!parentStats.isDirectory()) {
			throw new Error(`Refusing to install managed RTK because target parent is not a directory: ${targetParent}`);
		}
		resolvedTargetParent = realpathSync(targetParent);
	} else {
		resolvedTargetParent = realpathForCompare(targetParent);
	}

	if (!isPathInsideOrEqual(resolvedTargetParent, intendedAgentDir)) {
		throw new Error(`Refusing to install managed RTK outside the isolated tlh profile: ${targetParent} (resolves to ${resolvedTargetParent}; profile: ${intendedAgentDir})`);
	}
	if (resolvedTargetParent !== intendedTargetParent) {
		throw new Error(`Refusing to install managed RTK outside the intended target parent: ${targetParent} (resolves to ${resolvedTargetParent}; intended parent: ${intendedTargetParent})`);
	}
}

function stableRealpathOfSafeDirectory(path, firstStats, label) {
	const resolved = realpathSync(path);
	const secondStats = lstatIfExists(path);
	if (!secondStats) {
		throw new Error(`Refusing to create ${label} because a directory component changed while planning: ${path}`);
	}
	if (secondStats.isSymbolicLink()) {
		throw new Error(`Refusing to create ${label} through symlinked directory component: ${path}`);
	}
	if (!secondStats.isDirectory()) {
		throw new Error(`Refusing to create ${label} because a directory component is not a directory: ${path}`);
	}
	if (!sameFileStats(firstStats, secondStats)) {
		throw new Error(`Refusing to create ${label} because a directory component changed while planning: ${path}`);
	}
	return resolved;
}

function validateAnchoredDirectory(path, expectedResolvedPath, label, firstStats) {
	const stats = firstStats || lstatIfExists(path);
	if (!stats) {
		throw new Error(`Refusing to create ${label} because a directory component is missing: ${path}`);
	}
	if (stats.isSymbolicLink()) {
		throw new Error(`Refusing to create ${label} through symlinked directory component: ${path}`);
	}
	if (!stats.isDirectory()) {
		throw new Error(`Refusing to create ${label} because a directory component is not a directory: ${path}`);
	}

	const resolved = stableRealpathOfSafeDirectory(path, stats, label);
	if (resolved !== expectedResolvedPath) {
		throw new Error(`Refusing to create ${label} outside the intended directory: ${path} (resolves to ${resolved}; intended directory: ${expectedResolvedPath})`);
	}
	return resolved;
}

function cleanupCreatedDirectories(createdDirs) {
	for (const created of [...createdDirs].reverse()) {
		try {
			const stats = lstatSync(created.path);
			if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
			if (!sameFileStats(stats, created.stats)) continue;
			rmSync(created.path, { recursive: false, force: false });
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
			throw new Error(`Refusing to create ${label} because no anchored directory ancestor was found: ${directory}`);
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

function assertManagedRtkTempPath(path, plan, label, { mustExist = false, expectDirectory = false, expectFile = false } = {}) {
	const stats = lstatIfExists(path);
	if (!stats) {
		if (mustExist) {
			throw new Error(`Refusing to install managed RTK because temporary ${label} was not created: ${path}`);
		}
	} else {
		if (stats.isSymbolicLink()) {
			throw new Error(`Refusing to install managed RTK through symlinked temporary ${label}: ${path}`);
		}
		if (expectDirectory && !stats.isDirectory()) {
			throw new Error(`Refusing to install managed RTK because temporary ${label} is not a directory: ${path}`);
		}
		if (expectFile && !stats.isFile()) {
			throw new Error(`Refusing to install managed RTK because temporary ${label} is not a file: ${path}`);
		}
	}

	const resolvedPath = stats ? realpathSync(path) : realpathForCompare(path);
	if (!isPathInsideOrEqual(resolvedPath, plan.intendedTargetParent)) {
		throw new Error(`Refusing to install managed RTK because temporary ${label} resolves outside the isolated tlh profile: ${path} (resolves to ${resolvedPath}; target parent: ${plan.intendedTargetParent})`);
	}
}

function createManagedRtkTempTarget(plan) {
	ensureDirectorySafely(plan.targetParent, plan.intendedTargetParent, "managed rtk target parent");
	assertManagedRtkAgentRootSafe(plan);
	assertManagedRtkTargetParentSafe(plan);

	const tempDir = mkdtempSync(join(plan.targetParent, ".tlh-rtk-"));
	assertManagedRtkTempPath(tempDir, plan, "install directory", { mustExist: true, expectDirectory: true });

	const tempTarget = join(tempDir, "rtk");
	assertManagedRtkTempPath(tempTarget, plan, "binary", { mustExist: false });
	return { tempDir, tempTarget };
}

function copyFileExclusive(source, target, mode) {
	let fd;
	try {
		const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag, mode);
		writeFileSync(fd, readFileSync(source));
		fchmodSync(fd, mode);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function sha256File(path) {
	const hash = createHash("sha256");
	hash.update(readFileSync(path));
	return hash.digest("hex");
}

function isHexSha256(value) {
	return /^[a-f0-9]{64}$/i.test(String(value || ""));
}

function platformKey(platform = process.platform, arch = process.arch) {
	if (!new Set(["darwin", "linux"]).has(platform)) return undefined;
	if (!new Set(["arm64", "x64"]).has(arch)) return undefined;
	return `${platform}-${arch}`;
}

function unsupportedRtkPlatformMessage() {
	return `Unsupported platform for managed RTK install: ${process.platform}/${process.arch}. Prebuilt rtk binaries are only supported for darwin/linux on x64/arm64.`;
}

function managedRtkRelease(args) {
	const key = platformKey();
	if (!key) return undefined;
	const defaults = PINNED_RTK_RELEASES[key];
	if (!defaults) return undefined;

	const version = String(args.rtkVersion || DEFAULT_RTK_VERSION).replace(/^v/, "");
	const assetName = args.unsafeTestAssetName || defaults.assetName;
	const assetSha256 = (args.unsafeTestAssetSha256 || defaults.assetSha256).toLowerCase();
	const binarySha256 = (args.unsafeTestBinarySha256 || defaults.binarySha256).toLowerCase();
	const downloadUrl = args.unsafeTestDownloadUrl || `https://github.com/${args.rtkRepo}/releases/download/v${version}/${assetName}`;

	if (!version) throw new Error("RTK version is empty");
	if (!assetName) throw new Error("RTK asset name is empty");
	if (!isHexSha256(assetSha256)) throw new Error(`RTK asset SHA256 must be a 64-character hex digest (got ${JSON.stringify(assetSha256)})`);
	if (!isHexSha256(binarySha256)) throw new Error(`RTK binary SHA256 must be a 64-character hex digest (got ${JSON.stringify(binarySha256)})`);
	if (!downloadUrl || typeof downloadUrl !== "string") throw new Error("RTK download URL is empty");

	return {
		key,
		version,
		assetName,
		assetSha256,
		binarySha256,
		downloadUrl,
	};
}

async function fetchWithTimeout(url, options = {}) {
	const response = await fetch(url, {
		...options,
		headers: {
			"User-Agent": "tlh-rtk-installer",
			...(options.headers || {}),
		},
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText}`);
	}
	return response;
}

async function downloadToFile(url, path) {
	const response = await fetchWithTimeout(url);
	const content = Buffer.from(await response.arrayBuffer());
	writeFileSync(path, content);
}

function verifyRtkArchive(release, archivePath) {
	const actual = sha256File(archivePath);
	if (actual !== release.assetSha256) {
		throw new Error(`RTK archive checksum verification failed for ${release.assetName} (expected ${release.assetSha256}, got ${actual})`);
	}
}

function listTarGzipEntries(archivePath) {
	const tarPath = safeHelperCommandPath("tar");
	const result = spawnSync(tarPath, ["-tzf", archivePath], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, env: safeHelperEnv() });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error("failed to list RTK release archive");
	return result.stdout.split(/\r?\n/).filter(Boolean);
}

function isSafeArchiveEntry(entry) {
	if (!entry || entry.startsWith("/") || isAbsolute(entry) || entry.includes("\\")) return false;
	const parts = entry.split("/");
	return parts.every((part) => part && part !== "." && part !== ".." && !part.startsWith("-"));
}

function isRtkBinaryEntry(entry) {
	return isSafeArchiveEntry(entry) && !entry.endsWith("/") && basename(entry) === "rtk";
}

function rtkArchiveEntry(archivePath) {
	const entries = listTarGzipEntries(archivePath);
	if (entries.includes("rtk")) return "rtk";

	const candidates = entries.filter(isRtkBinaryEntry);
	if (candidates.length === 1) return candidates[0];
	if (candidates.length > 1) {
		throw new Error("RTK release archive contained multiple rtk binary entries");
	}
	throw new Error("RTK release archive did not contain an rtk binary");
}

function extractRtkBinary(archivePath, extractDir) {
	const tarPath = safeHelperCommandPath("tar");
	const entry = rtkArchiveEntry(archivePath);
	const result = spawnSync(tarPath, ["-xzf", archivePath, "-C", extractDir, "--", entry], { stdio: "ignore", env: safeHelperEnv() });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error("failed to extract RTK binary from release archive");

	const extracted = join(extractDir, ...entry.split("/"));
	const stats = lstatIfExists(extracted);
	if (!stats) throw new Error("RTK binary was not extracted from release archive");
	if (stats.isSymbolicLink()) throw new Error("RTK binary in release archive is a symlink");
	if (!stats.isFile()) throw new Error("RTK binary in release archive is not a file");
	return extracted;
}

function validateRtkCommand(command, agentDir, release) {
	try {
		const resolvedCommand = commandHasPathSeparator(command)
			? resolve(command)
			: resolveCommandFromPath(command, helperEnv(agentDir).PATH);
		if (!resolvedCommand || !isExecutableFile(resolvedCommand)) return false;
		if (sha256File(resolvedCommand).toLowerCase() !== release.binarySha256) return false;

		const versionResult = spawnSync(resolvedCommand, ["--version"], { encoding: "utf8", timeout: VALIDATION_TIMEOUT_MS, env: helperEnv(agentDir) });
		if (versionResult.error || versionResult.status !== 0) return false;
		if ((versionResult.stdout || "").trim() !== `rtk ${release.version}`) return false;

		const rewriteResult = spawnSync(resolvedCommand, ["rewrite", "git", "status"], { encoding: "utf8", timeout: VALIDATION_TIMEOUT_MS, env: helperEnv(agentDir) });
		if (rewriteResult.error || rewriteResult.status !== 0) return false;
		return (rewriteResult.stdout || "").trim() === "rtk git status";
	} catch {
		return false;
	}
}

function candidateCommands(args, agentDir) {
	const candidates = [managedRtkTargetPath(args, agentDir), "rtk"];
	const seen = new Set();
	const unique = [];
	for (const candidate of candidates) {
		const key = candidate === "rtk" ? candidate : resolve(candidate);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(candidate);
	}
	return unique;
}

function findValidRtk(args, agentDir, release) {
	for (const candidate of candidateCommands(args, agentDir)) {
		if (validateRtkCommand(candidate, agentDir, release)) return normalizeValidCandidate(candidate, agentDir);
	}
	return undefined;
}

async function installManagedRtk(args, agentDir) {
	const plan = managedRtkTargetPlan(args, agentDir);
	const release = managedRtkRelease(args);
	if (!release) throw new Error(unsupportedRtkPlatformMessage());
	const target = plan.target;

	if (validateRtkCommand(target, agentDir, release)) {
		detailLog(args, `Managed RTK already satisfies pin: ${target}`);
		if (args.dryRun) logStderr(args, `Would keep pinned RTK ${release.version} in isolated profile: ${target}`);
		return target;
	}

	if (args.dryRun) {
		logStderr(args, `Would install RTK ${release.version} into isolated profile: ${target}`);
		logStderr(args, `Would download pinned RTK asset: ${release.downloadUrl}`);
		logStderr(args, `Would verify archive SHA256: ${release.assetSha256}`);
		logStderr(args, `Would verify installed binary SHA256: ${release.binarySha256}`);
		return target;
	}

	let downloadTempDir;
	let installTempDir;
	let tempTarget;

	try {
		downloadTempDir = mkdtempSync(join(tmpdir(), "tlh-rtk-"));
		const archivePath = join(downloadTempDir, "rtk.tar.gz");
		const extractDir = join(downloadTempDir, "extract");
		mkdirSync(extractDir, { recursive: true });

		logStderr(args, `Installing RTK ${release.version} into isolated profile: ${target}`);
		await downloadToFile(release.downloadUrl, archivePath);
		verifyRtkArchive(release, archivePath);
		const extracted = extractRtkBinary(archivePath, extractDir);
		if (sha256File(extracted).toLowerCase() !== release.binarySha256) {
			throw new Error(`RTK binary checksum verification failed for ${release.assetName}`);
		}
		if (!validateRtkCommand(extracted, agentDir, release)) {
			throw new Error("downloaded RTK binary did not validate");
		}

		({ tempDir: installTempDir, tempTarget } = createManagedRtkTempTarget(plan));
		copyFileExclusive(extracted, tempTarget, 0o755);
		assertManagedRtkTempPath(tempTarget, plan, "binary", { mustExist: true, expectFile: true });
		if (!validateRtkCommand(tempTarget, agentDir, release)) {
			throw new Error("staged RTK binary did not validate");
		}

		assertManagedRtkAgentRootSafe(plan);
		assertManagedRtkTargetParentSafe(plan);
		const finalTarget = validateManagedRtkTarget(args, agentDir);
		renameSync(tempTarget, finalTarget);
		if (!validateRtkCommand(finalTarget, agentDir, release)) {
			throw new Error("installed RTK binary did not validate");
		}
		return finalTarget;
	} catch (error) {
		if (tempTarget) rmSync(tempTarget, { force: true });
		const message = error instanceof Error ? error.message : String(error);
		warnStderr(args, message);
		return undefined;
	} finally {
		if (installTempDir) rmSync(installTempDir, { recursive: true, force: true });
		if (downloadTempDir) rmSync(downloadTempDir, { recursive: true, force: true });
	}
}

async function commandInstallManaged(args, agentDir) {
	const installedPath = await installManagedRtk(args, agentDir);
	if (!installedPath) {
		console.error("tlh-rtk: managed RTK was not installed");
		process.exitCode = 1;
		return;
	}
	console.log(installedPath);
}

function commandValidate(args, agentDir) {
	const release = managedRtkRelease(args);
	if (!release) {
		process.exitCode = 1;
		return;
	}

	const candidate = args.commandArgs[0];
	if (candidate) {
		if (!validateRtkCommand(candidate, agentDir, release)) {
			process.exitCode = 1;
			return;
		}
		console.log(candidate);
		return;
	}

	const valid = findValidRtk(args, agentDir, release);
	if (!valid) {
		process.exitCode = 1;
		return;
	}
	console.log(valid);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.command) {
		console.log(usage());
		return;
	}

	const agentDir = resolve(resolveTlhAgentDir(args.agentDir));

	if (args.command === "validate") {
		commandValidate(args, agentDir);
		return;
	}
	if (args.command === "install-managed") {
		await commandInstallManaged(args, agentDir);
		return;
	}

	throw new Error(`Unknown command: ${args.command}`);
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`tlh-rtk: ${message}`);
	process.exit(1);
});

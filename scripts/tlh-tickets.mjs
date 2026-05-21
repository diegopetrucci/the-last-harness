#!/usr/bin/env node
import { accessSync, chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import process from "node:process";

import {
	backupPathWithTimestamp,
	readJsonFile,
	requiredValue,
} from "./lib/tlh-install-utils.mjs";

const VALIDATION_TIMEOUT_MS = 5000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_TICKET_VERSION = "0.3.2";
const DEFAULT_TICKET_SOURCE_URL = `https://github.com/wedow/ticket/archive/refs/tags/v${DEFAULT_TICKET_VERSION}.tar.gz`;
const DEFAULT_TICKET_SHA256 = "5d4c82ed1c5cb4a2aeb63b47c3c8931738c3287e555f43bf831d3d323687db0f";
const DEFAULT_TICKET_ARCHIVE_ENTRY = `ticket-${DEFAULT_TICKET_VERSION}/ticket`;
const NEW_SETTINGS_FILE_MODE = 0o600;
const SAFE_HELPER_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);

function usage() {
	return `Usage: tlh tickets <command>

Manage tk ticket CLI integration in the isolated tlh profile.

Commands:
  status               Show integration status and detected tk command
  enable               Enable tk integration after validating a tk command

Options:
  --settings <path>    Settings file to update (default: ~/.the-last-harness/agent/settings.json, or PI_CODING_AGENT_DIR/settings.json)
  --agent-dir <dir>    Isolated Pi agent dir (default: ~/.the-last-harness/agent, or PI_CODING_AGENT_DIR)
  --install-path <p>   Store this tk command path when enabling
  -h, --help           Show this help
`;
}

function parseArgs(argv) {
	const args = {
		settingsPath: undefined,
		agentDir: undefined,
		installPath: undefined,
		target: undefined,
		ticketSourceUrl: DEFAULT_TICKET_SOURCE_URL,
		ticketSourceSha256: DEFAULT_TICKET_SHA256,
		ticketArchiveEntry: DEFAULT_TICKET_ARCHIVE_ENTRY,
		wrapperName: "tlh",
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
		if (arg === "--settings") {
			args.settingsPath = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--settings=")) {
			args.settingsPath = arg.slice("--settings=".length);
			continue;
		}
		if (arg === "--agent-dir") {
			args.agentDir = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--agent-dir=")) {
			args.agentDir = arg.slice("--agent-dir=".length);
			continue;
		}
		if (arg === "--install-path") {
			args.installPath = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--install-path=")) {
			args.installPath = arg.slice("--install-path=".length);
			continue;
		}
		if (arg === "--target") {
			args.target = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--target=")) {
			args.target = arg.slice("--target=".length);
			continue;
		}
		if (arg === "--unsafe-test-ticket-source-url") {
			args.ticketSourceUrl = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--unsafe-test-ticket-source-url=")) {
			args.ticketSourceUrl = arg.slice("--unsafe-test-ticket-source-url=".length);
			continue;
		}
		if (arg === "--unsafe-test-ticket-source-sha256") {
			args.ticketSourceSha256 = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--unsafe-test-ticket-source-sha256=")) {
			args.ticketSourceSha256 = arg.slice("--unsafe-test-ticket-source-sha256=".length);
			continue;
		}
		if (arg === "--unsafe-test-ticket-archive-entry") {
			args.ticketArchiveEntry = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--unsafe-test-ticket-archive-entry=")) {
			args.ticketArchiveEntry = arg.slice("--unsafe-test-ticket-archive-entry=".length);
			continue;
		}
		if (arg === "--wrapper-name") {
			args.wrapperName = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--wrapper-name=")) {
			args.wrapperName = arg.slice("--wrapper-name=".length);
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

function expandHome(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function getAgentDir(argAgentDir) {
	return expandHome(argAgentDir || process.env.PI_CODING_AGENT_DIR || process.env.TLH_AGENT_DIR || join(homedir(), ".the-last-harness", "agent"));
}

function defaultSettingsPath(agentDir) {
	return join(agentDir, "settings.json");
}

function isPlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateSettings(settings) {
	if (!isPlainObject(settings)) {
		throw new Error("Settings must be a JSON object");
	}
	if (settings.tlh !== undefined && !isPlainObject(settings.tlh)) {
		throw new Error("Settings field 'tlh' must be an object if present");
	}
	if (settings.tlh?.tickets !== undefined && !isPlainObject(settings.tlh.tickets)) {
		throw new Error("Settings field 'tlh.tickets' must be an object if present");
	}
}

function ensureMutableSettings(settings) {
	validateSettings(settings);
	settings.tlh ??= {};
	settings.tlh.tickets ??= {};
}

function loadSettings(settingsPath) {
	const previousRaw = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "") : "";
	const settings = readJsonFile(settingsPath, { missingValue: {} });
	validateSettings(settings);
	return { settings, previousRaw };
}

function legacyTicketsState(settings) {
	const enabled = settings.tlh?.tickets?.enabled;
	if (enabled === true) return "enabled";
	if (enabled === false) return "disabled";
	return "unset";
}

function ticketsState(settings) {
	const state = legacyTicketsState(settings);
	return state === "disabled" ? "enabled" : state;
}

function normalizedInstallPath(path) {
	if (!path) return undefined;
	return resolve(expandHome(path));
}

function configuredInstallPath(settings) {
	const path = settings.tlh?.tickets?.installPath;
	return typeof path === "string" && path.trim() ? normalizedInstallPath(path.trim()) : undefined;
}

function managedTkPinIsFresh(settings, expectedSha256) {
	const recorded = settings?.tlh?.tickets?.installedSha256;
	if (typeof recorded !== "string" || typeof expectedSha256 !== "string") return false;
	return recorded.toLowerCase() === expectedSha256.toLowerCase();
}

function managedTkTargetPath(args, agentDir) {
	const agentRoot = resolve(expandHome(agentDir));
	return resolve(expandHome(args.target || join(agentRoot, "bin", "tk")));
}

function candidateCommands(args, settings, agentDir) {
	const candidates = [configuredInstallPath(settings), managedTkTargetPath(args, agentDir), "tk"].filter(Boolean);
	const seen = new Set();
	const unique = [];
	for (const candidate of candidates) {
		const key = candidate === "tk" ? candidate : resolve(candidate);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(candidate);
	}
	return unique;
}

function hasTkCommandName(candidate) {
	return candidate === "tk" || basename(candidate) === "tk";
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

function commandHasPathSeparator(command) {
	return command.includes("/") || command.includes("\\");
}

function isExecutableFile(path) {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveCommandFromPath(command, pathValue = process.env.PATH) {
	if (commandHasPathSeparator(command)) return command;
	for (const entry of String(pathValue || "").split(delimiter)) {
		if (!entry) continue;
		const candidate = resolve(entry, command);
		if (isExecutableFile(candidate)) return candidate;
	}
	return undefined;
}

function validateTkCommand(command, agentDir) {
	const resolvedCommand = resolveCommandFromPath(command);
	if (!resolvedCommand) return false;
	const result = spawnSync(resolvedCommand, ["help"], { encoding: "utf8", timeout: VALIDATION_TIMEOUT_MS, env: helperEnv(agentDir) });
	if (result.error || result.status !== 0) return false;
	const output = `${result.stdout || ""}\n${result.stderr || ""}`;
	return /Usage:\s+tk\b/.test(output) && /ticket/i.test(output);
}

function commandPath(command) {
	return resolveCommandFromPath(command);
}

function normalizeValidCandidate(candidate) {
	if (candidate === "tk") return commandPath("tk") || candidate;
	return candidate;
}

function findValidTk(args, settings, agentDir) {
	for (const candidate of candidateCommands(args, settings, agentDir)) {
		if (!hasTkCommandName(candidate)) continue;
		if (validateTkCommand(candidate, agentDir)) return normalizeValidCandidate(candidate);
	}
	return undefined;
}

function samePathForCompare(left, right) {
	return realpathForCompare(left) === realpathForCompare(right);
}

function findValidTkForConfigure(args, settings, agentDir) {
	const configured = configuredInstallPath(settings);
	const managedTargetPath = managedTkTargetPath(args, agentDir);
	const configuredIsManagedTarget = configured && samePathForCompare(configured, managedTargetPath);
	if (configured && !configuredIsManagedTarget && hasTkCommandName(configured) && validateTkCommand(configured, agentDir)) return normalizeValidCandidate(configured);

	const managedTarget = validateManagedTkTarget(args, agentDir);
	for (const candidate of [managedTarget, "tk"]) {
		if (!hasTkCommandName(candidate)) continue;
		if (validateTkCommand(candidate, agentDir)) return normalizeValidCandidate(candidate);
	}
	return undefined;
}

function log(args, message) {
	if (!args.quiet) console.log(message);
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

function backupPathFor(settingsPath) {
	return backupPathWithTimestamp(settingsPath, { marker: "tlh-tickets" });
}

function realpathForCompare(path) {
	const resolved = resolve(path);
	if (existsSync(resolved)) return realpathSync(resolved);
	const parent = dirname(resolved);
	if (parent === resolved) return resolved;
	return join(realpathForCompare(parent), basename(resolved));
}

function normalPiAgentRoot() {
	// Tickets only writes agent-scoped settings/bin state, so keep the narrower ~/.pi/agent guard local.
	return realpathForCompare(join(homedir(), ".pi", "agent"));
}

function isUnderNormalPiAgent(path) {
	const normalRoot = normalPiAgentRoot();
	const resolvedPath = realpathForCompare(path);
	return resolvedPath === normalRoot || resolvedPath.startsWith(`${normalRoot}${sep}`);
}

function assertNotNormalPiSettings(settingsPath) {
	if (isUnderNormalPiAgent(settingsPath)) {
		throw new Error(`Refusing to modify normal Pi config from The Last Harness tickets command: ${settingsPath}`);
	}
}

function assertNotNormalPiPath(path, label) {
	if (isUnderNormalPiAgent(path)) {
		throw new Error(`Refusing to modify normal Pi config from The Last Harness tickets command (${label}): ${path}`);
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

function stableRealpathOfExistingDirectory(path, firstStats, label) {
	const resolved = realpathSync(path);
	const secondStats = lstatIfExists(path);
	if (!secondStats) {
		throw new Error(`Refusing to install managed tk because ${label} changed while planning: ${path}`);
	}
	if (secondStats.isSymbolicLink()) {
		throw new Error(`Refusing to install managed tk through symlinked ${label}: ${path}`);
	}
	if (!secondStats.isDirectory()) {
		throw new Error(`Refusing to install managed tk because ${label} is not a directory: ${path}`);
	}
	if (!sameFileStats(firstStats, secondStats)) {
		throw new Error(`Refusing to install managed tk because ${label} changed while planning: ${path}`);
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
				throw new Error(`Refusing to install managed tk because ${label} ancestor is not a directory: ${current}`);
			}
			const resolvedAncestor = stableRealpathOfExistingDirectory(current, stats, `${label} ancestor`);
			return resolve(resolvedAncestor, ...suffixParts);
		}

		const parent = dirname(current);
		if (parent === current) {
			throw new Error(`Refusing to install managed tk because no non-symlink directory ancestor was found for ${label}: ${path}`);
		}
		suffixParts.unshift(basename(current));
		current = parent;
	}
}

function captureIntendedManagedAgentDir(agentRoot) {
	const stats = lstatIfExists(agentRoot);
	if (!stats) return intendedPathFromNearestExistingNonSymlinkAncestor(agentRoot, "managed agent root");
	if (stats.isSymbolicLink()) {
		throw new Error(`Refusing to install managed tk through symlinked managed agent root: ${agentRoot}`);
	}
	if (!stats.isDirectory()) {
		throw new Error(`Refusing to install managed tk because managed agent root is not a directory: ${agentRoot}`);
	}
	return stableRealpathOfExistingDirectory(agentRoot, stats, "managed agent root");
}

function assertManagedTkAgentRootSafe({ agentRoot, intendedAgentDir }) {
	const stats = lstatIfExists(agentRoot);
	let resolvedAgentDir;

	if (stats) {
		if (stats.isSymbolicLink()) {
			throw new Error(`Refusing to install managed tk through symlinked managed agent root: ${agentRoot}`);
		}
		if (!stats.isDirectory()) {
			throw new Error(`Refusing to install managed tk because managed agent root is not a directory: ${agentRoot}`);
		}
		resolvedAgentDir = stableRealpathOfExistingDirectory(agentRoot, stats, "managed agent root");
	} else {
		resolvedAgentDir = intendedPathFromNearestExistingNonSymlinkAncestor(agentRoot, "managed agent root");
	}

	if (resolvedAgentDir !== intendedAgentDir) {
		throw new Error(`Refusing to install managed tk outside the intended tlh profile: ${agentRoot} (resolves to ${resolvedAgentDir}; intended profile: ${intendedAgentDir})`);
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
			throw new Error(`Refusing to install managed tk through symlinked target parent component: ${current}`);
		}
		if (!stats.isDirectory()) {
			throw new Error(`Refusing to install managed tk because target parent component is not a directory: ${current}`);
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

function managedTkTargetPlan(args, agentDir) {
	const agentRoot = resolve(expandHome(agentDir));
	const target = managedTkTargetPath(args, agentDir);

	assertNotNormalPiPath(agentRoot, "agent dir");
	assertNotNormalPiPath(target, "managed tk target");
	if (target === agentRoot) {
		throw new Error(`Refusing to install managed tk over the configured tlh profile directory: ${target}`);
	}
	if (!isPathInsideOrEqual(target, agentRoot)) {
		throw new Error(`Refusing to install managed tk outside the configured tlh profile path: ${target} (profile: ${agentRoot})`);
	}
	if (basename(target) !== "tk") {
		throw new Error(`Refusing to install managed tk because the target basename must be exactly "tk": ${target}`);
	}

	const intendedAgentDir = captureIntendedManagedAgentDir(agentRoot);
	const planBase = { agentRoot, intendedAgentDir };
	assertManagedTkAgentRootSafe(planBase);

	const targetStats = lstatIfExists(target);
	if (targetStats?.isSymbolicLink()) {
		throw new Error(`Refusing to install managed tk over symlinked target file: ${target}`);
	}
	if (targetStats && !targetStats.isFile()) {
		throw new Error(`Refusing to install managed tk over non-file target: ${target}`);
	}

	assertNoSymlinkedManagedTargetParents(target, agentRoot);

	const resolvedTarget = realpathForCompare(target);
	if (!isPathInsideOrEqual(resolvedTarget, intendedAgentDir)) {
		throw new Error(`Refusing to install managed tk outside the isolated tlh profile: ${target} (resolves to ${resolvedTarget}; profile: ${intendedAgentDir})`);
	}

	const targetParent = dirname(target);
	const intendedTargetParent = resolvedPathFromRoot(targetParent, agentRoot, intendedAgentDir);
	const plan = { ...planBase, target, targetParent, intendedTargetParent };
	assertManagedTkTargetParentSafe(plan);

	return plan;
}

function validateManagedTkTarget(args, agentDir) {
	return managedTkTargetPlan(args, agentDir).target;
}

function assertManagedTkTargetParentSafe({ targetParent, intendedAgentDir, intendedTargetParent }) {
	const parentStats = lstatIfExists(targetParent);
	let resolvedTargetParent;

	if (parentStats) {
		if (parentStats.isSymbolicLink()) {
			throw new Error(`Refusing to install managed tk through symlinked target parent: ${targetParent}`);
		}
		if (!parentStats.isDirectory()) {
			throw new Error(`Refusing to install managed tk because target parent is not a directory: ${targetParent}`);
		}
		resolvedTargetParent = realpathSync(targetParent);
	} else {
		resolvedTargetParent = realpathForCompare(targetParent);
	}

	if (!isPathInsideOrEqual(resolvedTargetParent, intendedAgentDir)) {
		throw new Error(`Refusing to install managed tk outside the isolated tlh profile: ${targetParent} (resolves to ${resolvedTargetParent}; profile: ${intendedAgentDir})`);
	}
	if (resolvedTargetParent !== intendedTargetParent) {
		throw new Error(`Refusing to install managed tk outside the intended target parent: ${targetParent} (resolves to ${resolvedTargetParent}; intended parent: ${intendedTargetParent})`);
	}
}

function sameFileStats(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
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

function validateOpenedFileForDirectWrite(fd, path, intendedRoot, label) {
	const fdStats = fstatSync(fd);
	if (!fdStats.isFile()) {
		throw new Error(`Refusing to write ${label} because the opened path is not a regular file: ${path}`);
	}

	let pathStats;
	try {
		pathStats = lstatSync(path);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Refusing to write ${label} because the opened path could not be validated: ${path} (${message})`);
	}

	if (pathStats.isSymbolicLink()) {
		throw new Error(`Refusing to write ${label} through a symlinked path: ${path}`);
	}
	if (!pathStats.isFile()) {
		throw new Error(`Refusing to write ${label} because the path is not a regular file: ${path}`);
	}
	if (!sameFileStats(fdStats, pathStats)) {
		throw new Error(`Refusing to write ${label} because the opened file no longer matches the target path: ${path}`);
	}
	if (fdStats.nlink !== 1) {
		throw new Error(`Refusing to write ${label} because the target has ${fdStats.nlink} hard links: ${path}`);
	}

	const resolvedPath = realpathSync(path);
	if (!isPathInsideOrEqual(resolvedPath, intendedRoot)) {
		throw new Error(`Refusing to write ${label} outside the intended directory: ${path} (resolves to ${resolvedPath}; intended directory: ${intendedRoot})`);
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
				throw new Error(`Refusing to write ${label} through a symlinked path: ${path}`);
			}
			if (!targetStats.isFile()) {
				throw new Error(`Refusing to write ${label} because the path is not a regular file: ${path}`);
			}
			if (exclusive) {
				throw new Error(`Refusing to write ${label} because the path already exists: ${path}`);
			}
			fd = openSync(path, constants.O_RDWR | noFollowFlag, mode);
		} else {
			fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollowFlag, mode);
			createdByUs = true;
		}
		if (validateParent) validateParent();
		validateOpenedFileForDirectWrite(fd, path, intendedRoot, label);
		validationComplete = true;
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

function writeManagedTkTarget(args, agentDir, content) {
	const plan = managedTkTargetPlan(args, agentDir);
	ensureDirectorySafely(plan.targetParent, plan.intendedTargetParent, "managed tk target parent");
	assertManagedTkAgentRootSafe(plan);
	assertManagedTkTargetParentSafe(plan);
	writeDirectValidated(plan.target, content, {
		mode: 0o755,
		intendedRoot: plan.intendedTargetParent,
		label: "managed tk command",
		replace: true,
		validateParent: () => {
			assertManagedTkAgentRootSafe(plan);
			assertManagedTkTargetParentSafe(plan);
		},
	});
}

function validateTicketSourceConfig(args) {
	if (!args.ticketSourceUrl || typeof args.ticketSourceUrl !== "string") {
		throw new Error("Ticket source URL is empty");
	}
	if (!args.ticketSourceUrl.startsWith("https://")) {
		const schemeEnd = args.ticketSourceUrl.indexOf("://");
		const prefix = schemeEnd >= 0
			? args.ticketSourceUrl.slice(0, schemeEnd + 3)
			: args.ticketSourceUrl.slice(0, 32);
		throw new Error(`Ticket source URL must use https:// (got: ${prefix})`);
	}
	if (!/^[a-f0-9]{64}$/i.test(args.ticketSourceSha256 || "")) {
		throw new Error("Ticket source SHA256 must be a 64-character hex digest");
	}
	if (!isSafeArchiveEntry(args.ticketArchiveEntry || "")) {
		throw new Error(`Ticket archive entry is unsafe: ${args.ticketArchiveEntry || ""}`);
	}
}

async function fetchWithTimeout(url, options = {}) {
	const response = await fetch(url, {
		...options,
		headers: {
			"User-Agent": "tlh-tickets-installer",
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

function sha256File(path) {
	const hash = createHash("sha256");
	hash.update(readFileSync(path));
	return hash.digest("hex");
}

function verifyTicketArchive(args, archivePath) {
	const expected = args.ticketSourceSha256.toLowerCase();
	const actual = sha256File(archivePath);
	if (actual !== expected) {
		throw new Error(`Ticket source checksum verification failed (expected ${expected}, got ${actual})`);
	}
}

function listTarGzipEntries(archivePath, agentDir) {
	const result = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, env: helperEnv(agentDir) });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error("failed to list ticket source archive");
	return result.stdout.split(/\r?\n/).filter(Boolean);
}

function isSafeArchiveEntry(entry) {
	if (!entry || entry.startsWith("/") || isAbsolute(entry) || entry.includes("\\")) return false;
	const parts = entry.split("/");
	return parts.every((part) => part && part !== "." && part !== ".." && !part.startsWith("-"));
}

function isTicketScriptEntry(entry) {
	return isSafeArchiveEntry(entry) && !entry.endsWith("/") && basename(entry) === "ticket";
}

function ticketArchiveEntry(archivePath, preferredEntry, agentDir) {
	const entries = listTarGzipEntries(archivePath, agentDir);
	if (entries.includes(preferredEntry)) return preferredEntry;

	const candidates = entries.filter(isTicketScriptEntry);
	if (candidates.length === 1) return candidates[0];
	if (candidates.length > 1) {
		throw new Error(`Ticket source archive contained multiple ticket script entries; expected ${preferredEntry}`);
	}
	throw new Error(`Ticket source archive did not contain ${preferredEntry}`);
}

function extractTicketScript(archivePath, extractDir, preferredEntry, agentDir) {
	const entry = ticketArchiveEntry(archivePath, preferredEntry, agentDir);
	if (!isSafeArchiveEntry(entry)) throw new Error(`Ticket archive entry is unsafe: ${entry}`);

	const result = spawnSync("tar", ["-xzf", archivePath, "-C", extractDir, "--", entry], { stdio: "ignore", env: helperEnv(agentDir) });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error("failed to extract ticket script from source archive");

	const extracted = join(extractDir, ...entry.split("/"));
	const stats = lstatIfExists(extracted);
	if (!stats) throw new Error("ticket script was not extracted from source archive");
	if (stats.isSymbolicLink()) throw new Error("ticket script in source archive is a symlink");
	if (!stats.isFile()) throw new Error("ticket script in source archive is not a file");
	return extracted;
}

function stageTkCommand(extracted, stagingDir) {
	const staged = join(stagingDir, "tk");
	writeFileSync(staged, readFileSync(extracted));
	chmodSync(staged, 0o755);
	return staged;
}

async function installManagedTk(args, agentDir) {
	const target = validateManagedTkTarget(args, agentDir);
	validateTicketSourceConfig(args);

	if (args.dryRun) {
		logStderr(args, `Would install tk into isolated profile: ${target}`);
		logStderr(args, `Would download pinned wedow/ticket source: ${args.ticketSourceUrl}`);
		logStderr(args, `Would verify SHA256: ${args.ticketSourceSha256.toLowerCase()}`);
		return target;
	}

	let downloadTempDir;

	try {
		downloadTempDir = mkdtempSync(join(tmpdir(), "tlh-tickets-"));
		const archivePath = join(downloadTempDir, "ticket.tar.gz");
		const extractDir = join(downloadTempDir, "extract");
		mkdirSync(extractDir, { recursive: true });

		logStderr(args, `Installing tk ${DEFAULT_TICKET_VERSION} into isolated profile: ${target}`);
		await downloadToFile(args.ticketSourceUrl, archivePath);
		verifyTicketArchive(args, archivePath);
		const extracted = extractTicketScript(archivePath, extractDir, args.ticketArchiveEntry, agentDir);
		const staged = stageTkCommand(extracted, downloadTempDir);
		if (!validateTkCommand(staged, agentDir)) {
			throw new Error("downloaded tk command did not validate");
		}

		validateManagedTkTarget(args, agentDir);
		writeManagedTkTarget(args, agentDir, readFileSync(staged));
		const installedTarget = validateManagedTkTarget(args, agentDir);
		if (!validateTkCommand(installedTarget, agentDir)) {
			throw new Error("installed tk command did not validate");
		}
		return installedTarget;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warnStderr(args, message);
		return undefined;
	} finally {
		if (downloadTempDir) rmSync(downloadTempDir, { recursive: true, force: true });
	}
}

async function commandInstallManaged(args, agentDir) {
	const installedPath = await installManagedTk(args, agentDir);
	if (!installedPath) {
		console.error("tlh tickets: managed tk was not installed");
		process.exitCode = 1;
		return;
	}
	console.log(installedPath);
}

function settingsFileMode(settingsPath) {
	const stats = lstatIfExists(settingsPath);
	if (stats?.isFile() && !stats.isSymbolicLink()) return stats.mode & 0o777;
	return NEW_SETTINGS_FILE_MODE;
}

function shouldBackupSettings(settingsPath) {
	const stats = lstatIfExists(settingsPath);
	return Boolean(stats?.isFile() && !stats.isSymbolicLink());
}

function settingsWritePlan(settingsPath) {
	assertNotNormalPiSettings(settingsPath);
	const settingsDir = dirname(settingsPath);
	const intendedSettingsDir = realpathForCompare(settingsDir);
	const plan = { settingsPath, settingsDir, intendedSettingsDir };
	assertSettingsDirSafe(plan);
	return plan;
}

function assertSettingsDirSafe({ settingsPath, settingsDir, intendedSettingsDir }) {
	assertNotNormalPiSettings(settingsPath);
	const dirStats = lstatIfExists(settingsDir);
	let resolvedSettingsDir;

	if (dirStats) {
		if (dirStats.isSymbolicLink()) {
			throw new Error(`Refusing to write settings outside the intended directory through a symlinked settings directory: ${settingsDir}`);
		}
		if (!dirStats.isDirectory()) {
			throw new Error(`Refusing to write settings because the settings directory is not a directory: ${settingsDir}`);
		}
		resolvedSettingsDir = realpathSync(settingsDir);
	} else {
		resolvedSettingsDir = realpathForCompare(settingsDir);
	}

	if (resolvedSettingsDir !== intendedSettingsDir) {
		throw new Error(`Refusing to write settings outside the intended settings directory: ${settingsDir} (resolves to ${resolvedSettingsDir}; intended directory: ${intendedSettingsDir})`);
	}
}

function writeSettingsBackup(settingsPath, previousRaw, mode, plan) {
	const backupPath = backupPathFor(settingsPath);
	writeDirectValidated(backupPath, previousRaw, {
		mode,
		intendedRoot: plan.intendedSettingsDir,
		label: "settings backup",
		exclusive: true,
		validateParent: () => assertSettingsDirSafe(plan),
	});
	return backupPath;
}

function writeSettingsDirect(settingsPath, formatted, mode, plan) {
	writeDirectValidated(settingsPath, formatted, {
		mode,
		intendedRoot: plan.intendedSettingsDir,
		label: "settings",
		replace: true,
		validateParent: () => assertSettingsDirSafe(plan),
	});
}

function writeSettings(settingsPath, value, previousRaw, { dryRun }) {
	const formatted = `${JSON.stringify(value, null, 2)}\n`;
	if (formatted === previousRaw) return "unchanged";
	if (dryRun) return "dry-run";

	const plan = settingsWritePlan(settingsPath);
	ensureDirectorySafely(plan.settingsDir, plan.intendedSettingsDir, "settings directory");
	assertSettingsDirSafe(plan);
	const mode = settingsFileMode(settingsPath);

	let backupPath;
	if (shouldBackupSettings(settingsPath)) {
		backupPath = writeSettingsBackup(settingsPath, previousRaw, mode, plan);
	}

	writeSettingsDirect(settingsPath, formatted, mode, plan);
	return backupPath || "written";
}

function logWriteResult(args, writeResult) {
	if (!args.detail) return;
	if (writeResult && !["dry-run", "unchanged", "written"].includes(writeResult)) {
		detailLog(args, `Backed up previous settings to: ${writeResult}`);
	}
	if (writeResult === "unchanged") detailLog(args, "No settings changes were needed.");
}

function setTicketsEnabled(args, settingsPath, settings, previousRaw, installPath, installedSha256) {
	assertNotNormalPiSettings(settingsPath);
	ensureMutableSettings(settings);
	settings.tlh.tickets.enabled = true;
	const normalized = normalizedInstallPath(installPath);
	if (normalized) settings.tlh.tickets.installPath = normalized;
	if (typeof installedSha256 === "string" && installedSha256.trim()) {
		settings.tlh.tickets.installedSha256 = installedSha256.trim().toLowerCase();
	} else if (settings.tlh.tickets.installedSha256 !== undefined) {
		delete settings.tlh.tickets.installedSha256;
	}
	const writeResult = writeSettings(settingsPath, settings, previousRaw, { dryRun: args.dryRun });
	detailLog(args, `${args.dryRun ? "Would enable" : "Enabled"} tk integration for the tlh profile.`);
	logWriteResult(args, writeResult);
}

function validatedRequestedInstallPath(args, agentDir, installPath) {
	const normalized = normalizedInstallPath(installPath);
	if (!normalized) return undefined;
	const managedTarget = managedTkTargetPath(args, agentDir);
	if (samePathForCompare(normalized, managedTarget)) {
		validateManagedTkTarget(args, agentDir);
	}
	if (!hasTkCommandName(normalized)) {
		throw new Error(`Refusing to enable tk integration because the command basename must be exactly "tk": ${normalized}`);
	}
	if (!validateTkCommand(normalized, agentDir)) {
		throw new Error(`Refusing to enable tk integration because the command did not validate: ${normalized}`);
	}
	return normalized;
}

function validTkForEnable(args, settings, agentDir) {
	const requested = args.installPath || args.commandArgs[0];
	if (requested) return validatedRequestedInstallPath(args, agentDir, requested);
	return findValidTkForConfigure(args, settings, agentDir);
}

async function commandConfigureInstall(args, settingsPath, settings, previousRaw, agentDir) {
	assertNotNormalPiSettings(settingsPath);

	const currentState = legacyTicketsState(settings);
	if (currentState === "disabled") {
		detailLog(args, "Re-enabling existing tk opt-out because ticket integration is required.");
	} else if (currentState === "enabled") {
		detailLog(args, "Validating existing tk integration setting: enabled.");
	} else {
		detailLog(args, "Installing and enabling tk integration by default.");
	}

	const managedTarget = managedTkTargetPath(args, agentDir);
	const configured = configuredInstallPath(settings);
	const managedPinIsFresh = managedTkPinIsFresh(settings, args.ticketSourceSha256);
	const pathOfInterestIsManaged = !configured || samePathForCompare(configured, managedTarget);
	if (pathOfInterestIsManaged
		&& !managedPinIsFresh
		&& validateTkCommand(managedTarget, agentDir)) {
		detailLog(args, "Managed tk pin changed; reinstalling.");
		const reinstalledPath = await installManagedTk(args, agentDir);
		if (reinstalledPath) {
			setTicketsEnabled(args, settingsPath, settings, previousRaw, reinstalledPath, args.ticketSourceSha256);
			log(args, `Ticket CLI integration: enabled (${reinstalledPath})`);
			return;
		}
		warnStderr(args, "tk pin changed but reinstall failed; falling back to existing tk discovery.");
	}

	const validPath = findValidTkForConfigure(args, settings, agentDir);
	if (validPath) {
		detailLog(args, `Found valid tk command: ${validPath}`);
		const sha = samePathForCompare(validPath, managedTarget) && managedPinIsFresh ? args.ticketSourceSha256 : undefined;
		setTicketsEnabled(args, settingsPath, settings, previousRaw, validPath, sha);
		log(args, `Ticket CLI integration: enabled (${validPath})`);
		return;
	}

	const managedPath = await installManagedTk(args, agentDir);
	if (managedPath) {
		setTicketsEnabled(args, settingsPath, settings, previousRaw, managedPath, args.ticketSourceSha256);
		log(args, `Ticket CLI integration: enabled (${managedPath})`);
		return;
	}

	throw new Error(`tk ticket integration is required, but no valid tk command was found and managed tk could not be installed. Install tk manually and run: ${args.wrapperName} tickets enable`);
}

function commandStatus(args, settings, agentDir) {
	const state = ticketsState(settings);
	const valid = findValidTk(args, settings, agentDir);
	const active = Boolean(valid);
	console.log("Ticket CLI integration for tlh:");
	console.log(`  setting: ${state}`);
	console.log(`  active: ${active ? "yes" : "no"}`);
	console.log(`  command: ${valid || "not found"}`);
	console.log(`  managed target: ${managedTkTargetPath(args, agentDir)}`);
	if (state === "enabled" && !valid) {
		console.log("  note: integration is enabled, but no valid `tk` command was found.");
	}
}

function commandEnable(args, settingsPath, settings, previousRaw, agentDir) {
	assertNotNormalPiSettings(settingsPath);
	const validPath = validTkForEnable(args, settings, agentDir);
	if (!validPath) {
		throw new Error("Refusing to enable tk integration because no valid tk command was found");
	}
	setTicketsEnabled(args, settingsPath, settings, previousRaw, validPath);
	log(args, `${args.dryRun ? "Would enable" : "Enabled"} tk integration for the tlh profile.`);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.command) {
		console.log(usage());
		return;
	}

	const agentDir = resolve(getAgentDir(args.agentDir));
	const settingsPath = resolve(expandHome(args.settingsPath || defaultSettingsPath(agentDir)));
	if (args.command === "disable") {
		throw new Error("disable is no longer supported because tk ticket integration is required");
	}
	const { settings, previousRaw } = loadSettings(settingsPath);

	if (args.command === "status") {
		commandStatus(args, settings, agentDir);
		return;
	}
	if (args.command === "install-managed") {
		await commandInstallManaged(args, agentDir);
		return;
	}
	if (args.command === "configure-install") {
		await commandConfigureInstall(args, settingsPath, settings, previousRaw, agentDir);
		return;
	}
	if (args.command === "enable") {
		commandEnable(args, settingsPath, settings, previousRaw, agentDir);
		return;
	}
	throw new Error(`Unknown command: ${args.command}`);
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`tlh tickets: ${message}`);
	process.exit(1);
});

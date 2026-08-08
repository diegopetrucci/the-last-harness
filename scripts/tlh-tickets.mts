#!/usr/bin/env node
import {
	accessSync,
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	fstatSync,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	rmdirSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	type Stats,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import process from "node:process";

import {
	backupPathWithTimestamp,
	defaultTlhSettingsPath,
	expandHomePath,
	readJsonFile,
	readOptionValue,
	resolveTlhAgentDir,
} from "./lib/tlh-install-utils.mjs";

const VALIDATION_TIMEOUT_MS = 5000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_TICKET_VERSION = "0.3.2";
const DEFAULT_TICKET_SOURCE_URL = `https://github.com/wedow/ticket/archive/refs/tags/v${DEFAULT_TICKET_VERSION}.tar.gz`;
const DEFAULT_TICKET_SHA256 = "5d4c82ed1c5cb4a2aeb63b47c3c8931738c3287e555f43bf831d3d323687db0f";
const DEFAULT_TICKET_ARCHIVE_ENTRY = `ticket-${DEFAULT_TICKET_VERSION}/ticket`;
const NEW_SETTINGS_FILE_MODE = 0o600;
const SAFE_HELPER_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);

type JsonObject = Record<string, unknown>;
type TicketsStateValue = "enabled" | "disabled" | "unset";
type WriteResult = "unchanged" | "dry-run" | "written" | string;
type FileContent = string | NodeJS.ArrayBufferView;

type TicketsConfig = JsonObject & {
	enabled?: boolean;
	installPath?: string;
	installedSha256?: string;
};

type TlhConfig = JsonObject & {
	tickets?: TicketsConfig;
};

type Settings = JsonObject & {
	tlh?: TlhConfig;
};

interface CliArgs {
	settingsPath?: string;
	agentDir?: string;
	installPath?: string;
	target?: string;
	ticketSourceUrl: string;
	ticketSourceSha256: string;
	ticketArchiveEntry: string;
	wrapperName: string;
	command?: string;
	commandArgs: string[];
	dryRun: boolean;
	detail: boolean;
	quiet: boolean;
	help: boolean;
}

type CliStringOptionKey = {
	[Key in keyof CliArgs]-?: string extends NonNullable<CliArgs[Key]> ? Key : never;
}[keyof CliArgs];

function assignCliOptionValue(
	args: CliArgs,
	key: CliStringOptionKey,
	argv: readonly string[],
	index: number,
	flags: string | readonly string[],
): number | undefined {
	const match = readOptionValue(argv, index, flags);
	if (!match) return undefined;
	args[key] = match.value;
	return match.nextIndex;
}

interface ManagedTkPlan {
	agentRoot: string;
	intendedAgentDir: string;
	target: string;
	targetParent: string;
	intendedTargetParent: string;
}

interface SettingsWritePlan {
	settingsPath: string;
	settingsDir: string;
	intendedSettingsDir: string;
}

interface CreatedDirectory {
	path: string;
	stats: Stats;
}

interface DirectWriteOptions {
	mode: number;
	intendedRoot: string;
	label: string;
	exclusive?: boolean;
	replace?: boolean;
	validateParent?: () => void;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error !== null && typeof error === "object" && "code" in error;
}

function usage(): string {
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

function parseArgs(argv: readonly string[]): CliArgs {
	const args: CliArgs = {
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
		const settingsIndex = assignCliOptionValue(args, "settingsPath", argv, index, "--settings");
		if (settingsIndex !== undefined) {
			index = settingsIndex;
			continue;
		}
		const agentDirIndex = assignCliOptionValue(args, "agentDir", argv, index, "--agent-dir");
		if (agentDirIndex !== undefined) {
			index = agentDirIndex;
			continue;
		}
		const installPathIndex = assignCliOptionValue(args, "installPath", argv, index, "--install-path");
		if (installPathIndex !== undefined) {
			index = installPathIndex;
			continue;
		}
		const targetIndex = assignCliOptionValue(args, "target", argv, index, "--target");
		if (targetIndex !== undefined) {
			index = targetIndex;
			continue;
		}
		const sourceUrlIndex = assignCliOptionValue(
			args,
			"ticketSourceUrl",
			argv,
			index,
			"--unsafe-test-ticket-source-url",
		);
		if (sourceUrlIndex !== undefined) {
			index = sourceUrlIndex;
			continue;
		}
		const sourceShaIndex = assignCliOptionValue(
			args,
			"ticketSourceSha256",
			argv,
			index,
			"--unsafe-test-ticket-source-sha256",
		);
		if (sourceShaIndex !== undefined) {
			index = sourceShaIndex;
			continue;
		}
		const archiveEntryIndex = assignCliOptionValue(
			args,
			"ticketArchiveEntry",
			argv,
			index,
			"--unsafe-test-ticket-archive-entry",
		);
		if (archiveEntryIndex !== undefined) {
			index = archiveEntryIndex;
			continue;
		}
		const wrapperNameIndex = assignCliOptionValue(args, "wrapperName", argv, index, "--wrapper-name");
		if (wrapperNameIndex !== undefined) {
			index = wrapperNameIndex;
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

function isPlainObject(value: unknown): value is JsonObject {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateSettings(settings: unknown): asserts settings is Settings {
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

function ensureMutableSettings(
	settings: Settings,
): asserts settings is Settings & { tlh: TlhConfig & { tickets: TicketsConfig } } {
	validateSettings(settings);
	settings.tlh ??= {};
	settings.tlh.tickets ??= {};
}

function loadSettings(settingsPath: string): { settings: Settings; previousRaw: string } {
	const previousRaw = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "") : "";
	const settings = readJsonFile(settingsPath, { missingValue: {} });
	validateSettings(settings);
	return { settings, previousRaw };
}

function legacyTicketsState(settings: Settings): TicketsStateValue {
	const enabled = settings.tlh?.tickets?.enabled;
	if (enabled === true) return "enabled";
	if (enabled === false) return "disabled";
	return "unset";
}

function ticketsState(settings: Settings): TicketsStateValue | "enabled" {
	const state = legacyTicketsState(settings);
	return state === "disabled" ? "enabled" : state;
}

function normalizedInstallPath(path: string | undefined): string | undefined {
	if (!path) return undefined;
	const expandedPath = expandHomePath(path);
	if (typeof expandedPath !== "string" || !expandedPath) return undefined;
	return resolve(expandedPath);
}

function configuredInstallPath(settings: Settings): string | undefined {
	const path = settings.tlh?.tickets?.installPath;
	return typeof path === "string" && path.trim() ? normalizedInstallPath(path.trim()) : undefined;
}

function managedTkPinIsFresh(settings: Settings, expectedSha256: string): boolean {
	const recorded = settings?.tlh?.tickets?.installedSha256;
	if (typeof recorded !== "string" || typeof expectedSha256 !== "string") return false;
	return recorded.toLowerCase() === expectedSha256.toLowerCase();
}

function managedTkTargetPath(args: CliArgs, agentDir: string): string {
	const expandedAgentDir = expandHomePath(agentDir);
	if (typeof expandedAgentDir !== "string" || !expandedAgentDir) {
		throw new Error(`Invalid tlh agent dir: ${agentDir}`);
	}
	const agentRoot = resolve(expandedAgentDir);
	const targetPath = args.target ?? join(agentRoot, "bin", "tk");
	const expandedTargetPath = expandHomePath(targetPath);
	if (typeof expandedTargetPath !== "string" || !expandedTargetPath) {
		throw new Error(`Invalid managed tk target path: ${targetPath}`);
	}
	return resolve(expandedTargetPath);
}

function candidateCommands(args: CliArgs, settings: Settings, agentDir: string): string[] {
	const candidates = [configuredInstallPath(settings), managedTkTargetPath(args, agentDir), "tk"].filter(
		(candidate): candidate is string => Boolean(candidate),
	);
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const candidate of candidates) {
		const key = candidate === "tk" ? candidate : resolve(candidate);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(candidate);
	}
	return unique;
}

function hasTkCommandName(candidate: string): boolean {
	return candidate === "tk" || basename(candidate) === "tk";
}

function realpathIfPossible(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

function sanitizedHelperPath(pathValue: string | undefined, agentDir: string): string {
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

function helperEnv(agentDir: string, extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env = { ...process.env, ...extraEnv };
	return {
		...env,
		PATH: sanitizedHelperPath(env.PATH, agentDir),
	};
}

function commandHasPathSeparator(command: string): boolean {
	return command.includes("/") || command.includes("\\");
}

function isExecutableFile(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveCommandFromPath(command: string, pathValue: string | undefined = process.env.PATH): string | undefined {
	if (commandHasPathSeparator(command)) return command;
	for (const entry of String(pathValue || "").split(delimiter)) {
		if (!entry) continue;
		const candidate = resolve(entry, command);
		if (isExecutableFile(candidate)) return candidate;
	}
	return undefined;
}

function validateTkCommand(command: string, agentDir: string): boolean {
	const resolvedCommand = resolveCommandFromPath(command);
	if (!resolvedCommand) return false;
	const result = spawnSync(resolvedCommand, ["help"], {
		encoding: "utf8",
		timeout: VALIDATION_TIMEOUT_MS,
		env: helperEnv(agentDir),
	});
	if (result.error || result.status !== 0) return false;
	const output = `${result.stdout || ""}\n${result.stderr || ""}`;
	return /Usage:\s+tk\b/.test(output) && /ticket/i.test(output);
}

function commandPath(command: string): string | undefined {
	return resolveCommandFromPath(command);
}

function normalizeValidCandidate(candidate: string): string {
	if (candidate === "tk") return commandPath("tk") || candidate;
	return candidate;
}

function findValidTk(args: CliArgs, settings: Settings, agentDir: string): string | undefined {
	for (const candidate of candidateCommands(args, settings, agentDir)) {
		if (!hasTkCommandName(candidate)) continue;
		if (validateTkCommand(candidate, agentDir)) return normalizeValidCandidate(candidate);
	}
	return undefined;
}

function samePathForCompare(left: string, right: string): boolean {
	return realpathForCompare(left) === realpathForCompare(right);
}

function findValidTkForConfigure(args: CliArgs, settings: Settings, agentDir: string): string | undefined {
	const configured = configuredInstallPath(settings);
	const managedTargetPath = managedTkTargetPath(args, agentDir);
	const configuredIsManagedTarget = configured && samePathForCompare(configured, managedTargetPath);
	if (
		configured &&
		!configuredIsManagedTarget &&
		hasTkCommandName(configured) &&
		validateTkCommand(configured, agentDir)
	)
		return normalizeValidCandidate(configured);

	const managedTarget = validateManagedTkTarget(args, agentDir);
	for (const candidate of [managedTarget, "tk"]) {
		if (!hasTkCommandName(candidate)) continue;
		if (validateTkCommand(candidate, agentDir)) return normalizeValidCandidate(candidate);
	}
	return undefined;
}

function log(args: CliArgs, message: string): void {
	if (!args.quiet) console.log(message);
}

function logStderr(args: CliArgs, message: string): void {
	if (!args.quiet) console.error(message);
}

function warnStderr(args: CliArgs, message: string): void {
	if (!args.quiet) console.error(`warning: ${message}`);
}

function detailLog(args: CliArgs, message: string): void {
	if (!args.quiet && args.detail) console.error(message);
}

function backupPathFor(settingsPath: string): string {
	return backupPathWithTimestamp(settingsPath, { marker: "tlh-tickets" });
}

function realpathForCompare(path: string): string {
	const resolved = resolve(path);
	if (existsSync(resolved)) return realpathSync(resolved);
	const parent = dirname(resolved);
	if (parent === resolved) return resolved;
	return join(realpathForCompare(parent), basename(resolved));
}

function normalPiAgentRoot(): string {
	// Tickets only writes agent-scoped settings/bin state, so keep the narrower ~/.pi/agent guard local.
	return realpathForCompare(join(homedir(), ".pi", "agent"));
}

function isUnderNormalPiAgent(path: string): boolean {
	const normalRoot = normalPiAgentRoot();
	const resolvedPath = realpathForCompare(path);
	return resolvedPath === normalRoot || resolvedPath.startsWith(`${normalRoot}${sep}`);
}

function assertNotNormalPiSettings(settingsPath: string): void {
	if (isUnderNormalPiAgent(settingsPath)) {
		throw new Error(`Refusing to modify normal Pi config from The Last Harness tickets command: ${settingsPath}`);
	}
}

function assertNotNormalPiPath(path: string, label: string): void {
	if (isUnderNormalPiAgent(path)) {
		throw new Error(`Refusing to modify normal Pi config from The Last Harness tickets command (${label}): ${path}`);
	}
}

function lstatIfExists(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if (isErrnoException(error) && ["ENOENT", "ENOTDIR"].includes(error.code ?? "")) return undefined;
		throw error;
	}
}

function isPathInsideOrEqual(path: string, root: string): boolean {
	const relativePath = relative(root, path);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function stableRealpathOfExistingDirectory(path: string, firstStats: Stats, label: string): string {
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

function intendedPathFromNearestExistingNonSymlinkAncestor(path: string, label: string): string {
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
			throw new Error(
				`Refusing to install managed tk because no non-symlink directory ancestor was found for ${label}: ${path}`,
			);
		}
		suffixParts.unshift(basename(current));
		current = parent;
	}
}

function captureIntendedManagedAgentDir(agentRoot: string): string {
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

function assertManagedTkAgentRootSafe({
	agentRoot,
	intendedAgentDir,
}: Pick<ManagedTkPlan, "agentRoot" | "intendedAgentDir">): void {
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
		throw new Error(
			`Refusing to install managed tk outside the intended tlh profile: ${agentRoot} (resolves to ${resolvedAgentDir}; intended profile: ${intendedAgentDir})`,
		);
	}
}

function assertNoSymlinkedManagedTargetParents(target: string, boundary: string): void {
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

function resolvedPathFromRoot(path: string, root: string, resolvedRoot: string): string {
	const relativePath = relative(root, path);
	if (typeof relativePath !== "string") {
		throw new Error(`Failed to resolve relative path from ${root} to ${path}`);
	}
	if (relativePath === "") return resolvedRoot;
	if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
		throw new Error(`Path is outside the configured root: ${path} (root: ${root})`);
	}
	return resolve(resolvedRoot, relativePath);
}

function managedTkTargetPlan(args: CliArgs, agentDir: string): ManagedTkPlan {
	const expandedAgentDir = expandHomePath(agentDir);
	if (typeof expandedAgentDir !== "string" || !expandedAgentDir) {
		throw new Error(`Invalid tlh agent dir: ${agentDir}`);
	}
	const agentRoot = resolve(expandedAgentDir);
	const target = managedTkTargetPath(args, agentDir);

	assertNotNormalPiPath(agentRoot, "agent dir");
	assertNotNormalPiPath(target, "managed tk target");
	if (target === agentRoot) {
		throw new Error(`Refusing to install managed tk over the configured tlh profile directory: ${target}`);
	}
	if (!isPathInsideOrEqual(target, agentRoot)) {
		throw new Error(
			`Refusing to install managed tk outside the configured tlh profile path: ${target} (profile: ${agentRoot})`,
		);
	}
	if (basename(target) !== "tk") {
		throw new Error(`Refusing to install managed tk because the target basename must be exactly "tk": ${target}`);
	}

	const intendedAgentDir = captureIntendedManagedAgentDir(agentRoot);
	const planBase: Pick<ManagedTkPlan, "agentRoot" | "intendedAgentDir"> = { agentRoot, intendedAgentDir };
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
		throw new Error(
			`Refusing to install managed tk outside the isolated tlh profile: ${target} (resolves to ${resolvedTarget}; profile: ${intendedAgentDir})`,
		);
	}

	const targetParent = dirname(target);
	const intendedTargetParent = resolvedPathFromRoot(targetParent, agentRoot, intendedAgentDir);
	const plan = { ...planBase, target, targetParent, intendedTargetParent };
	assertManagedTkTargetParentSafe(plan);

	return plan;
}

function validateManagedTkTarget(args: CliArgs, agentDir: string): string {
	return managedTkTargetPlan(args, agentDir).target;
}

function assertManagedTkTargetParentSafe({
	targetParent,
	intendedAgentDir,
	intendedTargetParent,
}: Pick<ManagedTkPlan, "targetParent" | "intendedAgentDir" | "intendedTargetParent">): void {
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
		throw new Error(
			`Refusing to install managed tk outside the isolated tlh profile: ${targetParent} (resolves to ${resolvedTargetParent}; profile: ${intendedAgentDir})`,
		);
	}
	if (resolvedTargetParent !== intendedTargetParent) {
		throw new Error(
			`Refusing to install managed tk outside the intended target parent: ${targetParent} (resolves to ${resolvedTargetParent}; intended parent: ${intendedTargetParent})`,
		);
	}
}

function sameFileStats(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function stableRealpathOfSafeDirectory(path: string, firstStats: Stats, label: string): string {
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

function validateAnchoredDirectory(
	path: string,
	expectedResolvedPath: string,
	label: string,
	firstStats?: Stats,
): string {
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
		throw new Error(
			`Refusing to create ${label} outside the intended directory: ${path} (resolves to ${resolved}; intended directory: ${expectedResolvedPath})`,
		);
	}
	return resolved;
}

function cleanupCreatedDirectories(createdDirs: readonly CreatedDirectory[]): void {
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

function ensureDirectorySafely(directory: string, intendedDirectory: string, label: string): void {
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

	const createdDirs: CreatedDirectory[] = [];
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
					if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
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

function validateOpenedFileForDirectWrite(fd: number, path: string, intendedRoot: string, label: string): void {
	const fdStats = fstatSync(fd);
	if (!fdStats.isFile()) {
		throw new Error(`Refusing to write ${label} because the opened path is not a regular file: ${path}`);
	}

	let pathStats;
	try {
		pathStats = lstatSync(path);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Refusing to write ${label} because the opened path could not be validated: ${path} (${message})`, {
			cause: error,
		});
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
		throw new Error(
			`Refusing to write ${label} outside the intended directory: ${path} (resolves to ${resolvedPath}; intended directory: ${intendedRoot})`,
		);
	}
}

function cleanupCreatedEmptyFile(fd: number, path: string): boolean {
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

function writeDirectValidated(
	path: string,
	content: FileContent,
	{ mode, intendedRoot, label, exclusive = false, replace = false, validateParent }: DirectWriteOptions,
): void {
	let fd: number | undefined;
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

function writeManagedTkTarget(args: CliArgs, agentDir: string, content: FileContent): void {
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

function validateTicketSourceConfig(args: CliArgs): void {
	if (!args.ticketSourceUrl || typeof args.ticketSourceUrl !== "string") {
		throw new Error("Ticket source URL is empty");
	}
	if (!args.ticketSourceUrl.startsWith("https://")) {
		const schemeEnd = args.ticketSourceUrl.indexOf("://");
		const prefix = schemeEnd >= 0 ? args.ticketSourceUrl.slice(0, schemeEnd + 3) : args.ticketSourceUrl.slice(0, 32);
		throw new Error(`Ticket source URL must use https:// (got: ${prefix})`);
	}
	if (!/^[a-f0-9]{64}$/i.test(args.ticketSourceSha256 || "")) {
		throw new Error("Ticket source SHA256 must be a 64-character hex digest");
	}
	if (!isSafeArchiveEntry(args.ticketArchiveEntry || "")) {
		throw new Error(`Ticket archive entry is unsafe: ${args.ticketArchiveEntry || ""}`);
	}
}

async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
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

async function downloadToFile(url: string, path: string): Promise<void> {
	const response = await fetchWithTimeout(url);
	const content = Buffer.from(await response.arrayBuffer());
	writeFileSync(path, content);
}

function sha256File(path: string): string {
	const hash = createHash("sha256");
	hash.update(readFileSync(path));
	return hash.digest("hex");
}

function verifyTicketArchive(args: CliArgs, archivePath: string): void {
	const expected = args.ticketSourceSha256.toLowerCase();
	const actual = sha256File(archivePath);
	if (actual !== expected) {
		throw new Error(`Ticket source checksum verification failed (expected ${expected}, got ${actual})`);
	}
}

function listTarGzipEntries(archivePath: string, agentDir: string): string[] {
	const result = spawnSync("tar", ["-tzf", archivePath], {
		encoding: "utf8",
		maxBuffer: 10 * 1024 * 1024,
		env: helperEnv(agentDir),
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error("failed to list ticket source archive");
	return result.stdout.split(/\r?\n/).filter(Boolean);
}

function isSafeArchiveEntry(entry: string): boolean {
	if (!entry || entry.startsWith("/") || isAbsolute(entry) || entry.includes("\\")) return false;
	const parts = entry.split("/");
	return parts.every((part) => part && part !== "." && part !== ".." && !part.startsWith("-"));
}

function isTicketScriptEntry(entry: string): boolean {
	return isSafeArchiveEntry(entry) && !entry.endsWith("/") && basename(entry) === "ticket";
}

function ticketArchiveEntry(archivePath: string, preferredEntry: string, agentDir: string): string {
	const entries = listTarGzipEntries(archivePath, agentDir);
	if (entries.includes(preferredEntry)) return preferredEntry;

	const candidates = entries.filter(isTicketScriptEntry);
	if (candidates.length === 1) return candidates[0];
	if (candidates.length > 1) {
		throw new Error(`Ticket source archive contained multiple ticket script entries; expected ${preferredEntry}`);
	}
	throw new Error(`Ticket source archive did not contain ${preferredEntry}`);
}

function extractTicketScript(
	archivePath: string,
	extractDir: string,
	preferredEntry: string,
	agentDir: string,
): string {
	const entry = ticketArchiveEntry(archivePath, preferredEntry, agentDir);
	if (!isSafeArchiveEntry(entry)) throw new Error(`Ticket archive entry is unsafe: ${entry}`);

	const result = spawnSync("tar", ["-xzf", archivePath, "-C", extractDir, "--", entry], {
		stdio: "ignore",
		env: helperEnv(agentDir),
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error("failed to extract ticket script from source archive");

	const extracted = join(extractDir, ...entry.split("/"));
	const stats = lstatIfExists(extracted);
	if (!stats) throw new Error("ticket script was not extracted from source archive");
	if (stats.isSymbolicLink()) throw new Error("ticket script in source archive is a symlink");
	if (!stats.isFile()) throw new Error("ticket script in source archive is not a file");
	return extracted;
}

function stageTkCommand(extracted: string, stagingDir: string): string {
	const staged = join(stagingDir, "tk");
	writeFileSync(staged, readFileSync(extracted));
	chmodSync(staged, 0o755);
	return staged;
}

async function installManagedTk(args: CliArgs, agentDir: string): Promise<string | undefined> {
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

async function commandInstallManaged(args: CliArgs, agentDir: string): Promise<void> {
	const installedPath = await installManagedTk(args, agentDir);
	if (!installedPath) {
		console.error("tlh tickets: managed tk was not installed");
		process.exitCode = 1;
		return;
	}
	console.log(installedPath);
}

function settingsFileMode(settingsPath: string): number {
	const stats = lstatIfExists(settingsPath);
	if (stats?.isFile() && !stats.isSymbolicLink()) return stats.mode & 0o777;
	return NEW_SETTINGS_FILE_MODE;
}

function shouldBackupSettings(settingsPath: string): boolean {
	const stats = lstatIfExists(settingsPath);
	return Boolean(stats?.isFile() && !stats.isSymbolicLink());
}

function settingsWritePlan(settingsPath: string): SettingsWritePlan {
	assertNotNormalPiSettings(settingsPath);
	const settingsDir = dirname(settingsPath);
	const intendedSettingsDir = realpathForCompare(settingsDir);
	const plan: SettingsWritePlan = { settingsPath, settingsDir, intendedSettingsDir };
	assertSettingsDirSafe(plan);
	return plan;
}

function assertSettingsDirSafe({ settingsPath, settingsDir, intendedSettingsDir }: SettingsWritePlan): void {
	assertNotNormalPiSettings(settingsPath);
	const dirStats = lstatIfExists(settingsDir);
	let resolvedSettingsDir;

	if (dirStats) {
		if (dirStats.isSymbolicLink()) {
			throw new Error(
				`Refusing to write settings outside the intended directory through a symlinked settings directory: ${settingsDir}`,
			);
		}
		if (!dirStats.isDirectory()) {
			throw new Error(`Refusing to write settings because the settings directory is not a directory: ${settingsDir}`);
		}
		resolvedSettingsDir = realpathSync(settingsDir);
	} else {
		resolvedSettingsDir = realpathForCompare(settingsDir);
	}

	if (resolvedSettingsDir !== intendedSettingsDir) {
		throw new Error(
			`Refusing to write settings outside the intended settings directory: ${settingsDir} (resolves to ${resolvedSettingsDir}; intended directory: ${intendedSettingsDir})`,
		);
	}
}

function writeSettingsBackup(settingsPath: string, previousRaw: string, mode: number, plan: SettingsWritePlan): string {
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

function writeSettingsDirect(settingsPath: string, formatted: string, mode: number, plan: SettingsWritePlan): void {
	writeDirectValidated(settingsPath, formatted, {
		mode,
		intendedRoot: plan.intendedSettingsDir,
		label: "settings",
		replace: true,
		validateParent: () => assertSettingsDirSafe(plan),
	});
}

function writeSettings(
	settingsPath: string,
	value: Settings,
	previousRaw: string,
	{ dryRun }: { dryRun: boolean },
): WriteResult {
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

function logWriteResult(args: CliArgs, writeResult: WriteResult): void {
	if (!args.detail) return;
	if (writeResult && !["dry-run", "unchanged", "written"].includes(writeResult)) {
		detailLog(args, `Backed up previous settings to: ${writeResult}`);
	}
	if (writeResult === "unchanged") detailLog(args, "No settings changes were needed.");
}

function setTicketsEnabled(
	args: CliArgs,
	settingsPath: string,
	settings: Settings,
	previousRaw: string,
	installPath: string | undefined,
	installedSha256?: string,
): void {
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

function validatedRequestedInstallPath(args: CliArgs, agentDir: string, installPath: string): string | undefined {
	const normalized = normalizedInstallPath(installPath);
	if (!normalized) return undefined;
	const managedTarget = managedTkTargetPath(args, agentDir);
	if (samePathForCompare(normalized, managedTarget)) {
		validateManagedTkTarget(args, agentDir);
	}
	if (!hasTkCommandName(normalized)) {
		throw new Error(
			`Refusing to enable tk integration because the command basename must be exactly "tk": ${normalized}`,
		);
	}
	if (!validateTkCommand(normalized, agentDir)) {
		throw new Error(`Refusing to enable tk integration because the command did not validate: ${normalized}`);
	}
	return normalized;
}

function validTkForEnable(args: CliArgs, settings: Settings, agentDir: string): string | undefined {
	const requested = args.installPath || args.commandArgs[0];
	if (requested) return validatedRequestedInstallPath(args, agentDir, requested);
	return findValidTkForConfigure(args, settings, agentDir);
}

async function commandConfigureInstall(
	args: CliArgs,
	settingsPath: string,
	settings: Settings,
	previousRaw: string,
	agentDir: string,
): Promise<void> {
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
	if (pathOfInterestIsManaged && !managedPinIsFresh && validateTkCommand(managedTarget, agentDir)) {
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

	throw new Error(
		`tk ticket integration is required, but no valid tk command was found and managed tk could not be installed. Install tk manually and run: ${args.wrapperName} tickets enable`,
	);
}

function commandStatus(args: CliArgs, settings: Settings, agentDir: string): void {
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

function commandEnable(
	args: CliArgs,
	settingsPath: string,
	settings: Settings,
	previousRaw: string,
	agentDir: string,
): void {
	assertNotNormalPiSettings(settingsPath);
	const validPath = validTkForEnable(args, settings, agentDir);
	if (!validPath) {
		throw new Error("Refusing to enable tk integration because no valid tk command was found");
	}
	setTicketsEnabled(args, settingsPath, settings, previousRaw, validPath);
	log(args, `${args.dryRun ? "Would enable" : "Enabled"} tk integration for the tlh profile.`);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.command) {
		console.log(usage());
		return;
	}

	const resolvedAgentDir = resolveTlhAgentDir(args.agentDir);
	if (typeof resolvedAgentDir !== "string" || !resolvedAgentDir) {
		throw new Error("Failed to resolve the tlh agent dir");
	}
	const agentDir = resolve(resolvedAgentDir);
	const configuredSettingsPath = args.settingsPath ?? defaultTlhSettingsPath({ agentDir });
	const expandedSettingsPath = expandHomePath(configuredSettingsPath);
	if (typeof expandedSettingsPath !== "string" || !expandedSettingsPath) {
		throw new Error(`Invalid settings path: ${configuredSettingsPath}`);
	}
	const settingsPath = resolve(expandedSettingsPath);
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

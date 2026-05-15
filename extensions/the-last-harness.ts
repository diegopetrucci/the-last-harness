import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Dirent } from "node:fs";
import { arch as osArch, homedir, platform as osPlatform, release as osRelease, type as osType } from "node:os";
import { basename, delimiter, dirname, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
	truncateToWidth,
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	DefaultPackageManager,
	SettingsManager,
	getAgentDir,
	keyText,
	loadProjectContextFiles,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadonlyFooterDataProvider,
	type ResolvedResource,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	ALLOWED_SUBAGENTS,
	registerTlhStartupMode,
	validateSubagentToolInput,
} from "./the-last-harness-subagent-safety.mjs";

const TLH_NAME = "tlh";
const TLH_PACKAGE_NAME = "The Last Harness";
const TLH_REPO = "diegopetrucci/the-last-harness";
const TLH_RELEASES_URL = `https://github.com/${TLH_REPO}/releases`;
const TLH_LATEST_RELEASE_API_URL = `https://api.github.com/repos/${TLH_REPO}/releases/latest`;
const TLH_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TLH_UPDATE_CHECK_TIMEOUT_MS = 3000;
// TelemetryDeck appID/namespace are public client analytics identifiers, not secrets.
// Env overrides support local verification against mock TelemetryDeck endpoints.
const TLH_TELEMETRY_NAMESPACE = "com.gordicorp";
const TLH_TELEMETRY_APP_ID = "A4B1E0A4-E03B-450A-B0FA-2ED9895353F3";
const TLH_TELEMETRY_INGEST_BASE_URL = "https://nom.telemetrydeck.com/v2/namespace";
const TLH_TELEMETRY_EVENT_TYPE = "Tlh.launched";
const TLH_TELEMETRY_TIMEOUT_MS = 1500;
const TLH_TELEMETRY_STATE_SCHEMA_VERSION = 1;
const DUMB_ZONE_THRESHOLD_TOKENS = 200_000;
const DUMB_ZONE_LABEL = "DUMB ZONE";
// Pi prefixes package-backed commands with provenance tags like [u:git:github.com/org/repo@ref].
// tlh keeps autocomplete focused on the command description instead.
const AUTOCOMPLETE_SOURCE_TAG_PATTERN = /(^|—\s*)\[(?:u|p|t)(?::(?:npm|git):[^\]]+)?\]\s*/g;
const execFileAsync = promisify(execFile);
const ACTIVE_PRIMARY_AGENT = "architect";
const PRIMARY_AGENT_CYCLE_SHORTCUT = "shift+tab";
const PRIMARY_AGENT_SESSION_STATE_ENTRY = "tlh-primary-agent-state";

const HARNESS_PROMPT = `
## The Last Harness Defaults

The Last Harness (tlh) profile is active. Prefer safe, transparent, and reviewable changes:

- Refer to this environment as "tlh" or "The Last Harness" in user-facing text.
- Mention Pi only when specifically discussing the upstream Pi runtime or compatibility.
- Explain high-impact actions before taking them.
- Use the narrowest tool or command that solves the task.
- Preserve user-owned configuration unless explicitly asked to change it.
- Make installer and setup changes idempotent whenever possible.
- Document how to undo any persistent change.
`;

const GNOSIS_PROMPT = [
	"At the start of any task, run `gn help plan` and follow its instructions.",
	"After finishing a task, run `gn help review`.",
].join("\n");

const CHILD_SUBAGENT_PROMPT = `
## TLH Child Subagent Defaults

You are running inside a delegated TLH child subagent session.

- Follow your assigned minor-agent prompt and task brief.
- Do not run Gnosis (\`gn\`) planning, review, write, edit, or removal commands, and do not update project memory directly.
- If you learn something durable that should be recorded in project memory, report it to the parent architect or supervisor instead.
`;

const GNOSIS_VALIDATION_TIMEOUT_MS = 5000;

type StartupResources = {
	context: string[];
	skills: string[];
	prompts: string[];
	extensions: string[];
	themes: string[];
};

type TlhGnosisConfig = {
	enabled?: boolean;
	installPath?: string;
};

type TlhGnosisState = "enabled" | "disabled" | "unset";

type TlhGnosisSlashAction = "toggle" | "status" | "enable" | "disable";

type TlhUpdateCheckConfig = {
	enabled?: boolean;
};

type TlhTelemetryConfig = {
	enabled?: boolean;
};

type TlhPrimaryAgentConfig = {
	enabled?: boolean;
	applyModel?: boolean;
	applyThinking?: boolean;
};

type TlhPrimaryAgentSessionState = {
	enabled?: boolean;
};

type TlhPrimaryAgentWriteResult = {
	settingsPath: string;
	backupPath?: string;
	changed: boolean;
};

type TlhSettings = {
	tlh?: {
		gnosis?: TlhGnosisConfig;
		updateCheck?: TlhUpdateCheckConfig;
		telemetry?: TlhTelemetryConfig;
		primaryAgent?: TlhPrimaryAgentConfig;
	};
};

type TlhStartupState = {
	lastSeenVersion?: string;
	updateCheck?: {
		checkedAt?: string;
		latestVersion?: string;
		latestTagName?: string;
		latestReleaseUrl?: string;
		lastNotifiedVersion?: string;
	};
};

type TlhInstallState = {
	track?: string;
	ref?: string;
};

type TlhTelemetryState = {
	schemaVersion?: number;
	installId?: string;
};

type TlhTelemetrySnapshot = {
	version: string;
	modelId?: string;
};

type TlhOsMetadata = {
	osName: string;
	osVersion: string;
	osArch: string;
};

type TlhHeaderUpdate = {
	version: string;
	releasesUrl: string;
};

type TlhLatestRelease = {
	version: string;
	tagName: string;
	releaseUrl: string;
};

type AgentPrompt = {
	name: string;
	description: string;
	model?: string;
	thinking?: ThinkingLevel;
	tools: string[];
	systemPrompt: string;
	filePath: string;
};

type SubagentMetadata = {
	name: string;
	description: string;
};

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type ReasoningModel = {
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
};

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const FALLBACK_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

const THINKING_LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No extra reasoning effort",
	minimal: "Smallest reasoning budget",
	low: "Light reasoning budget",
	medium: "Balanced default reasoning budget",
	high: "Deeper reasoning budget",
	xhigh: "Maximum reasoning budget when the model supports it",
};

let checkedTlhHeaderUpdate = false;
let cachedTlhHeaderUpdate: TlhHeaderUpdate | undefined;
let sentTlhLaunchTelemetry = false;

function packageRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function getTlhVersion(): string {
	try {
		const packageJson = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8"));
		return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function realpathForCompare(path: string): string {
	const resolved = resolve(path);
	if (existsSync(resolved)) {
		return realpathSync(resolved);
	}
	const parent = dirname(resolved);
	if (parent === resolved) {
		return resolved;
	}
	return join(realpathForCompare(parent), basename(resolved));
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isFalseyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "0" || normalized === "false" || normalized === "no";
}

function stripTrailingPathSeparators(path: string): string {
	let stripped = path;
	while (stripped.length > sep.length && stripped.endsWith(sep)) {
		stripped = stripped.slice(0, -sep.length);
	}
	return stripped;
}

function pathWithinOrEqual(root: string, child: string): boolean {
	const normalizedRoot = stripTrailingPathSeparators(root);
	const normalizedChild = stripTrailingPathSeparators(child);
	if (normalizedRoot === sep) {
		return normalizedChild.startsWith(sep);
	}
	return normalizedChild === normalizedRoot || normalizedChild.startsWith(`${normalizedRoot}${sep}`);
}

function isDefaultPiAgentDir(agentDir: string): boolean {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return false;
	try {
		return realpathForCompare(agentDir) === realpathForCompare(join(home, ".pi", "agent"));
	} catch {
		return resolve(agentDir) === resolve(home, ".pi", "agent");
	}
}

function isNormalPiConfigPath(resolvedPath: string): boolean {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) {
		return false;
	}
	const normalPiRoot = realpathForCompare(join(home, ".pi"));
	return pathWithinOrEqual(normalPiRoot, resolvedPath);
}

function safeTlhProfileFilePath(relativePath: string): string | undefined {
	const agentDir = getAgentDir();
	if (!process.env.PI_CODING_AGENT_DIR || isDefaultPiAgentDir(agentDir)) {
		return undefined;
	}

	const targetPath = join(agentDir, relativePath);
	try {
		const resolvedAgentDir = realpathForCompare(agentDir);
		const resolvedTargetPath = realpathForCompare(targetPath);
		if (!pathWithinOrEqual(resolvedAgentDir, resolvedTargetPath) || isNormalPiConfigPath(resolvedTargetPath)) {
			return undefined;
		}
		return targetPath;
	} catch {
		return undefined;
	}
}

function tlhStateDir(): string | undefined {
	return safeTlhProfileFilePath("tlh");
}

function tlhStatePath(fileName: string): string | undefined {
	return safeTlhProfileFilePath(join("tlh", fileName));
}

function tlhStartupStatePath(): string | undefined {
	// Only persist state when the wrapper has selected an isolated profile and
	// the TLH support path resolves inside that profile. This avoids mutating
	// normal Pi config through a symlinked `${AGENT_DIR}/tlh` directory.
	return tlhStatePath("startup-state.json");
}

function tlhTelemetryStatePath(): string | undefined {
	return tlhStatePath("telemetry-state.json");
}

function readTlhStartupState(): TlhStartupState {
	const statePath = tlhStartupStatePath();
	const content = statePath ? readText(statePath) : undefined;
	if (!content) {
		return {};
	}
	try {
		const parsed = JSON.parse(content) as TlhStartupState;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function tlhInstallStatePath(): string | undefined {
	return safeTlhProfileFilePath(join("tlh", "install-state.json"));
}

function readTlhInstallState(): TlhInstallState {
	const statePath = tlhInstallStatePath();
	const content = statePath ? readText(statePath) : undefined;
	if (!content) {
		return {};
	}
	try {
		const parsed = JSON.parse(content) as TlhInstallState;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function canUseTlhStartupStateDir(statePath: string): boolean {
	const stateDir = dirname(statePath);
	try {
		const dirStat = lstatSync(stateDir);
		if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
			return false;
		}
	} catch (error) {
		if (!isRecord(error) || error.code !== "ENOENT") {
			return false;
		}
	}

	try {
		mkdirSync(stateDir, { recursive: true });
		const dirStat = lstatSync(stateDir);
		if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
			return false;
		}
		return tlhStartupStatePath() === statePath;
	} catch {
		return false;
	}
}

function canReplaceTlhStartupStateFile(statePath: string): boolean {
	try {
		const stateStat = lstatSync(statePath);
		return !stateStat.isSymbolicLink() && stateStat.isFile();
	} catch (error) {
		return isRecord(error) && error.code === "ENOENT";
	}
}

function writeTlhStartupStateAtomically(statePath: string, content: string): void {
	const nofollowFlag = constants.O_NOFOLLOW;
	// Startup state is best-effort. If this platform cannot protect the temp
	// file's final component from symlinks, fail closed instead of weakening the
	// atomic replacement by silently dropping O_NOFOLLOW.
	if (typeof nofollowFlag !== "number" || nofollowFlag === 0) {
		return;
	}

	const stateDir = dirname(statePath);
	const stateBase = basename(statePath);
	const tempPath = join(stateDir, `.${stateBase}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`);
	let fd: number | undefined;
	try {
		fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollowFlag, 0o600);
		writeFileSync(fd, content, { encoding: "utf8" });
		closeSync(fd);
		fd = undefined;
		renameSync(tempPath, statePath);
	} finally {
		if (fd !== undefined) {
			closeSync(fd);
		}
		try {
			unlinkSync(tempPath);
		} catch (error) {
			if (!isRecord(error) || error.code !== "ENOENT") {
				throw error;
			}
		}
	}
}

function writeTlhStartupState(state: TlhStartupState): void {
	try {
		const statePath = tlhStartupStatePath();
		if (!statePath || !canUseTlhStartupStateDir(statePath) || !canReplaceTlhStartupStateFile(statePath)) {
			return;
		}
		writeTlhStartupStateAtomically(statePath, `${JSON.stringify(state, null, 2)}\n`);
	} catch {
		// Startup state is best-effort; never block launch.
	}
}

function updateTlhStartupState(updates: Partial<TlhStartupState>): void {
	writeTlhStartupState({ ...readTlhStartupState(), ...updates });
}

function getTlhHeaderUpdate(): TlhHeaderUpdate | undefined {
	if (checkedTlhHeaderUpdate) {
		return cachedTlhHeaderUpdate;
	}

	checkedTlhHeaderUpdate = true;
	const currentVersion = getTlhVersion();
	const lastSeenVersion = readTlhStartupState().lastSeenVersion;

	if (lastSeenVersion !== currentVersion) {
		updateTlhStartupState({ lastSeenVersion: currentVersion });
	}
	if (typeof lastSeenVersion === "string" && lastSeenVersion.length > 0 && lastSeenVersion !== currentVersion) {
		cachedTlhHeaderUpdate = { version: currentVersion, releasesUrl: TLH_RELEASES_URL };
	}

	return cachedTlhHeaderUpdate;
}

function normalizeTlhVersion(version: string): string {
	return version.trim().replace(/^v/i, "");
}

type ParsedTlhVersion = {
	major: number;
	minor: number;
	patch: number;
	prerelease?: string;
};

function parseTlhVersion(version: string): ParsedTlhVersion | undefined {
	const match = normalizeTlhVersion(version).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
	if (!match) {
		return undefined;
	}
	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		prerelease: match[4],
	};
}

function compareTlhVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = parseTlhVersion(leftVersion);
	const right = parseTlhVersion(rightVersion);
	if (!left || !right) {
		return undefined;
	}
	if (left.major !== right.major) return left.major - right.major;
	if (left.minor !== right.minor) return left.minor - right.minor;
	if (left.patch !== right.patch) return left.patch - right.patch;
	if (left.prerelease === right.prerelease) return 0;
	if (!left.prerelease) return 1;
	if (!right.prerelease) return -1;
	return left.prerelease.localeCompare(right.prerelease);
}

function isNewerTlhVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = compareTlhVersions(candidateVersion, currentVersion);
	return comparison !== undefined && comparison > 0;
}

function getCachedTlhLatestRelease(state: TlhStartupState): TlhLatestRelease | undefined {
	const latestVersion = state.updateCheck?.latestVersion;
	if (typeof latestVersion !== "string" || !latestVersion.trim()) {
		return undefined;
	}
	const version = normalizeTlhVersion(latestVersion);
	const tagName = state.updateCheck?.latestTagName || `v${version}`;
	return {
		version,
		tagName,
		releaseUrl: state.updateCheck?.latestReleaseUrl || `${TLH_RELEASES_URL}/tag/${tagName}`,
	};
}

function shouldRefreshTlhLatestRelease(state: TlhStartupState): boolean {
	const checkedAt = state.updateCheck?.checkedAt;
	const checkedAtMs = typeof checkedAt === "string" ? Date.parse(checkedAt) : Number.NaN;
	return !Number.isFinite(checkedAtMs) || Date.now() - checkedAtMs >= TLH_UPDATE_CHECK_INTERVAL_MS;
}

function shouldSkipTlhUpdateCheck(cwd: string): boolean {
	if (!tlhStartupStatePath() || process.env.PI_OFFLINE || process.env.PI_SKIP_VERSION_CHECK || process.env.TLH_SKIP_UPDATE_CHECK) {
		return true;
	}
	return getTlhUpdateCheckConfig(cwd)?.enabled === false;
}

async function fetchLatestTlhRelease(currentVersion: string): Promise<TlhLatestRelease | undefined> {
	const response = await fetch(TLH_LATEST_RELEASE_API_URL, {
		headers: {
			Accept: "application/vnd.github+json",
			"User-Agent": `${TLH_NAME}/${currentVersion}`,
		},
		signal: AbortSignal.timeout(TLH_UPDATE_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) {
		return undefined;
	}

	const data = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
	if (typeof data.tag_name !== "string" || !data.tag_name.trim()) {
		return undefined;
	}
	const tagName = data.tag_name.trim();
	const version = normalizeTlhVersion(tagName);
	const releaseUrl = typeof data.html_url === "string" && data.html_url.trim() ? data.html_url.trim() : `${TLH_RELEASES_URL}/tag/${tagName}`;
	return { version, tagName, releaseUrl };
}

function notifyTlhUpdate(ctx: ExtensionContext, currentVersion: string, latestRelease: TlhLatestRelease): void {
	const currentLabel = `v${normalizeTlhVersion(currentVersion)}`;
	const latestLabel = latestRelease.tagName.startsWith("v") ? latestRelease.tagName : `v${latestRelease.version}`;
	const installTrack = readTlhInstallState().track;
	const updateCommand = installTrack === "pinned-tag" ? "tlh update --track latest-release" : "tlh update";
	ctx.ui.notify(
		`${TLH_PACKAGE_NAME} update available: ${latestLabel} installed: ${currentLabel}. Release notes: ${latestRelease.releaseUrl}. Update: ${updateCommand}`,
		"warning",
	);
}

function maybeNotifyCachedTlhUpdate(ctx: ExtensionContext, currentVersion: string, state: TlhStartupState): boolean {
	const latestRelease = getCachedTlhLatestRelease(state);
	if (!latestRelease || !isNewerTlhVersion(latestRelease.version, currentVersion)) {
		return false;
	}
	if (state.updateCheck?.lastNotifiedVersion === latestRelease.version) {
		return false;
	}
	notifyTlhUpdate(ctx, currentVersion, latestRelease);
	updateTlhStartupState({
		updateCheck: {
			...state.updateCheck,
			latestVersion: latestRelease.version,
			latestTagName: latestRelease.tagName,
			latestReleaseUrl: latestRelease.releaseUrl,
			lastNotifiedVersion: latestRelease.version,
		},
	});
	return true;
}

async function maybeNotifyAvailableTlhUpdate(ctx: ExtensionContext): Promise<void> {
	if (shouldSkipTlhUpdateCheck(ctx.cwd)) {
		return;
	}

	const currentVersion = getTlhVersion();
	let state = readTlhStartupState();
	if (!shouldRefreshTlhLatestRelease(state)) {
		maybeNotifyCachedTlhUpdate(ctx, currentVersion, state);
		return;
	}

	updateTlhStartupState({
		updateCheck: {
			...state.updateCheck,
			checkedAt: new Date().toISOString(),
		},
	});

	let latestRelease: TlhLatestRelease | undefined;
	try {
		latestRelease = await fetchLatestTlhRelease(currentVersion);
	} catch {
		return;
	}
	if (!latestRelease) {
		return;
	}

	state = readTlhStartupState();
	updateTlhStartupState({
		updateCheck: {
			...state.updateCheck,
			latestVersion: latestRelease.version,
			latestTagName: latestRelease.tagName,
			latestReleaseUrl: latestRelease.releaseUrl,
		},
	});

	state = readTlhStartupState();
	if (!isNewerTlhVersion(latestRelease.version, currentVersion) || state.updateCheck?.lastNotifiedVersion === latestRelease.version) {
		return;
	}

	notifyTlhUpdate(ctx, currentVersion, latestRelease);
	updateTlhStartupState({
		updateCheck: {
			...state.updateCheck,
			lastNotifiedVersion: latestRelease.version,
		},
	});
}

function expandHomePath(path: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && path === "~") {
		return home;
	}
	if (home && path.startsWith("~/")) {
		return join(home, path.slice(2));
	}
	return path;
}

function getTlhGnosisConfig(cwd: string): TlhGnosisConfig | undefined {
	try {
		const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as TlhSettings;
		return settings.tlh?.gnosis;
	} catch {
		return undefined;
	}
}

function getTlhUpdateCheckConfig(cwd: string): TlhUpdateCheckConfig | undefined {
	try {
		const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as TlhSettings;
		return settings.tlh?.updateCheck;
	} catch {
		return undefined;
	}
}

function getTlhPrimaryAgentConfig(cwd: string): TlhPrimaryAgentConfig | undefined {
	try {
		const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as TlhSettings;
		return settings.tlh?.primaryAgent;
	} catch {
		return undefined;
	}
}

function configuredTlhTelemetryNamespace(): string {
	return (process.env.TLH_TELEMETRY_NAMESPACE || TLH_TELEMETRY_NAMESPACE).trim();
}

function configuredTlhTelemetryAppId(): string {
	return (process.env.TLH_TELEMETRY_APP_ID || TLH_TELEMETRY_APP_ID).trim();
}

function configuredTlhTelemetryIngestBaseUrl(): string {
	return (process.env.TLH_TELEMETRY_INGEST_BASE_URL || TLH_TELEMETRY_INGEST_BASE_URL).trim().replace(/\/+$/, "");
}

function readTlhTelemetrySettings(): { ok: true; config?: TlhTelemetryConfig } | { ok: false } {
	const stateDir = tlhStateDir();
	if (!stateDir) {
		return { ok: false };
	}

	const settingsPath = join(dirname(stateDir), "settings.json");
	if (!existsSync(settingsPath)) {
		return { ok: true };
	}
	const settingsContent = readText(settingsPath);
	if (settingsContent === undefined) {
		return { ok: false };
	}
	if (!settingsContent.trim()) {
		return { ok: true };
	}

	let settings: unknown;
	try {
		settings = JSON.parse(settingsContent);
	} catch {
		return { ok: false };
	}
	if (!isPlainObject(settings)) {
		return { ok: false };
	}

	const tlh = settings.tlh;
	if (tlh !== undefined && !isPlainObject(tlh)) {
		return { ok: false };
	}
	const telemetry = isPlainObject(tlh) ? tlh.telemetry : undefined;
	if (telemetry !== undefined && !isPlainObject(telemetry)) {
		return { ok: false };
	}
	const enabled = isPlainObject(telemetry) ? telemetry.enabled : undefined;
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return { ok: false };
	}
	return { ok: true, config: telemetry as TlhTelemetryConfig | undefined };
}

function shouldSkipTlhLaunchTelemetry(): boolean {
	if (!tlhTelemetryStatePath()) return true;
	if (!configuredTlhTelemetryNamespace() || !configuredTlhTelemetryAppId() || !configuredTlhTelemetryIngestBaseUrl()) return true;
	if (isTruthyEnvFlag(process.env.PI_OFFLINE)) return true;
	if (isTruthyEnvFlag(process.env.TLH_SKIP_TELEMETRY)) return true;
	if (isTruthyEnvFlag(process.env.TLH_TELEMETRY_DISABLED)) return true;
	if (isFalseyEnvFlag(process.env.PI_TELEMETRY)) return true;

	const telemetrySettings = readTlhTelemetrySettings();
	if (!telemetrySettings.ok) return true;
	return telemetrySettings.config?.enabled === false;
}

function isUuid(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function readTlhTelemetryState(): TlhTelemetryState | undefined {
	const statePath = tlhTelemetryStatePath();
	const content = statePath ? readText(statePath) : undefined;
	if (!content) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(content) as TlhTelemetryState;
		return parsed && typeof parsed === "object" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function writeTlhTelemetryState(state: TlhTelemetryState): boolean {
	try {
		const statePath = tlhTelemetryStatePath();
		if (!statePath) return false;
		mkdirSync(dirname(statePath), { recursive: true });
		writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
}

function getOrCreateTlhTelemetryInstallId(): string | undefined {
	const existing = readTlhTelemetryState();
	if (existing?.schemaVersion === TLH_TELEMETRY_STATE_SCHEMA_VERSION && isUuid(existing.installId)) {
		return existing.installId;
	}

	const installId = randomUUID();
	return writeTlhTelemetryState({ schemaVersion: TLH_TELEMETRY_STATE_SCHEMA_VERSION, installId }) ? installId : undefined;
}

function hashTlhTelemetryClientUser(installId: string): string {
	return createHash("sha256").update(installId).digest("hex");
}

const PUBLIC_MODEL_ID_PATTERNS: RegExp[] = [
	/^gpt-[a-z0-9._-]+$/,
	/^o[0-9][a-z0-9._-]*$/,
	/^chatgpt-[a-z0-9._-]+$/,
	/^claude-[a-z0-9._-]+$/,
	/^gemini-[a-z0-9._-]+$/,
	/^grok-[a-z0-9._-]+$/,
	/^deepseek-[a-z0-9._-]+$/,
	/^qwen[a-z0-9._-]*$/,
	/^kimi-[a-z0-9._-]+$/,
	/^mistral-[a-z0-9._-]+$/,
	/^codestral-[a-z0-9._-]+$/,
	/^devstral-[a-z0-9._-]+$/,
	/^llama-[a-z0-9._-]+$/,
	/^command-[a-z0-9._-]+$/,
	/^nova-[a-z0-9._-]+$/,
	/^mimo-[a-z0-9._-]+$/,
];

function privacySafeTlhTelemetryModelId(modelId: string | undefined): string {
	if (typeof modelId !== "string" || !modelId.trim()) {
		return "unknown";
	}
	const lastSegment = modelId.trim().split("/").pop()?.trim() || "";
	const normalized = lastSegment.toLowerCase();
	if (!normalized || normalized.length > 80 || !/^[a-z0-9._-]+$/.test(normalized)) {
		return "custom";
	}
	return PUBLIC_MODEL_ID_PATTERNS.some((pattern) => pattern.test(normalized)) ? normalized : "custom";
}

function unknownIfEmpty(value: string | undefined): string {
	return value && value.trim() ? value.trim() : "unknown";
}

function majorMinorVersion(version: string): string {
	const match = version.trim().match(/^(\d+)(?:\.(\d+))?/);
	if (!match) return unknownIfEmpty(version);
	return match[2] ? `${match[1]}.${match[2]}` : match[1];
}

function parseOsRelease(content: string | undefined): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const line of (content || "").split(/\r?\n/)) {
		const match = line.match(/^([A-Z][A-Z0-9_]+)=(.*)$/);
		if (!match) continue;
		let value = match[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		fields[match[1]] = value.replace(/\\(["'`$\\])/g, "$1");
	}
	return fields;
}

async function getMacOsVersion(): Promise<string> {
	try {
		const { stdout } = await execFileAsync("sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 750 });
		return majorMinorVersion(stdout.trim());
	} catch {
		return majorMinorVersion(osRelease());
	}
}

async function getTlhOsMetadata(): Promise<TlhOsMetadata> {
	const architecture = unknownIfEmpty(osArch());
	try {
		const platform = osPlatform();
		if (platform === "darwin") {
			return { osName: "macOS", osVersion: await getMacOsVersion(), osArch: architecture };
		}
		if (platform === "linux") {
			const osReleaseFields = parseOsRelease(readText("/etc/os-release"));
			return {
				osName: unknownIfEmpty(osReleaseFields.NAME || osReleaseFields.ID || "Linux"),
				osVersion: unknownIfEmpty(osReleaseFields.VERSION_ID || majorMinorVersion(osRelease())),
				osArch: architecture,
			};
		}
		if (platform === "win32") {
			return { osName: "Windows", osVersion: majorMinorVersion(osRelease()), osArch: architecture };
		}
		return { osName: unknownIfEmpty(osType()), osVersion: majorMinorVersion(osRelease()), osArch: architecture };
	} catch {
		return { osName: "unknown", osVersion: "unknown", osArch: architecture };
	}
}

async function maybeSendTlhLaunchTelemetry(snapshot: TlhTelemetrySnapshot): Promise<void> {
	if (shouldSkipTlhLaunchTelemetry()) return;

	const namespace = configuredTlhTelemetryNamespace();
	const appID = configuredTlhTelemetryAppId();
	const installId = getOrCreateTlhTelemetryInstallId();
	if (!namespace || !appID || !installId) return;

	const osMetadata = await getTlhOsMetadata();
	const body = [
		{
			appID,
			clientUser: hashTlhTelemetryClientUser(installId),
			type: TLH_TELEMETRY_EVENT_TYPE,
			payload: {
				"Tlh.App.version": snapshot.version,
				"Tlh.Runtime.model": privacySafeTlhTelemetryModelId(snapshot.modelId),
				"Tlh.Device.osName": osMetadata.osName,
				"Tlh.Device.osVersion": osMetadata.osVersion,
				"Tlh.Device.osArch": osMetadata.osArch,
			},
		},
	];

	try {
		await fetch(`${configuredTlhTelemetryIngestBaseUrl()}/${encodeURIComponent(namespace)}/`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				"User-Agent": `${TLH_NAME}/${snapshot.version}`,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TLH_TELEMETRY_TIMEOUT_MS),
		});
	} catch {
		// Launch telemetry is best-effort; never block or notify during startup.
	}
}

function getTlhPrimaryAgentDefaultEnabled(cwd: string): boolean {
	return getTlhPrimaryAgentConfig(cwd)?.enabled !== false;
}

function tlhSettingsPathForWrite(): string | undefined {
	const agentDir = getAgentDir();
	if (!process.env.PI_CODING_AGENT_DIR || isDefaultPiAgentDir(agentDir)) {
		return undefined;
	}
	return join(agentDir, "settings.json");
}

function assertSafeTlhSettingsPath(settingsPath: string): void {
	try {
		const settingsStat = lstatSync(settingsPath);
		if (settingsStat.isSymbolicLink()) {
			throw new Error(`Refusing to write symlinked TLH settings file: ${settingsPath}`);
		}
		if (!settingsStat.isFile()) {
			throw new Error(`Refusing to write non-file TLH settings path: ${settingsPath}`);
		}
		if (settingsStat.nlink > 1) {
			throw new Error(`Refusing to write hardlinked TLH settings file: ${settingsPath}`);
		}
	} catch (error) {
		if (!isRecord(error) || error.code !== "ENOENT") {
			throw error;
		}
	}

	const agentDir = realpathForCompare(getAgentDir());
	const resolvedSettingsPath = realpathForCompare(settingsPath);
	if (!pathWithinOrEqual(agentDir, resolvedSettingsPath)) {
		throw new Error(`Refusing to write settings outside the isolated TLH profile: ${settingsPath}`);
	}

	if (isNormalPiConfigPath(resolvedSettingsPath)) {
		throw new Error(`Refusing to modify normal Pi config from The Last Harness: ${settingsPath}`);
	}
}

function parseTlhSettingsContent(content: string | undefined): Record<string, unknown> {
	if (!content) {
		return {};
	}
	const parsed = JSON.parse(content) as unknown;
	if (!isRecord(parsed)) {
		throw new Error("settings.json must contain a JSON object");
	}
	return parsed;
}

function settingsBackupTimestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

type SettingsStorageLike = {
	withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined): void;
};

function getSettingsStorageForWrite(cwd: string): SettingsStorageLike {
	const manager = SettingsManager.create(cwd, getAgentDir()) as unknown as { storage?: SettingsStorageLike };
	if (!manager.storage || typeof manager.storage.withLock !== "function") {
		throw new Error("Pi settings storage is unavailable.");
	}
	return manager.storage;
}

function writeTlhPrimaryAgentDefault(cwd: string, enabled: boolean | undefined): TlhPrimaryAgentWriteResult {
	const settingsPath = tlhSettingsPathForWrite();
	if (!settingsPath) {
		throw new Error("Refusing to write primary-agent settings outside the isolated TLH profile.");
	}
	assertSafeTlhSettingsPath(settingsPath);

	let result: TlhPrimaryAgentWriteResult | undefined;
	getSettingsStorageForWrite(cwd).withLock("global", (current) => {
		const settings = parseTlhSettingsContent(current);
		const rawTlh = settings.tlh;
		let tlh: Record<string, unknown>;
		if (rawTlh === undefined) {
			tlh = {};
			settings.tlh = tlh;
		} else if (isRecord(rawTlh)) {
			tlh = rawTlh;
		} else {
			throw new Error("settings.tlh must be an object to update primary-agent settings.");
		}

		const rawPrimaryAgent = tlh.primaryAgent;
		let primaryAgent: Record<string, unknown>;
		if (rawPrimaryAgent === undefined) {
			primaryAgent = {};
			tlh.primaryAgent = primaryAgent;
		} else if (isRecord(rawPrimaryAgent)) {
			primaryAgent = rawPrimaryAgent;
		} else {
			throw new Error("settings.tlh.primaryAgent must be an object to update architect defaults.");
		}

		const currentEnabled = primaryAgent.enabled;
		let changed = false;
		if (enabled === undefined) {
			if (Object.prototype.hasOwnProperty.call(primaryAgent, "enabled")) {
				delete primaryAgent.enabled;
				changed = true;
			}
		} else if (currentEnabled !== enabled) {
			primaryAgent.enabled = enabled;
			changed = true;
		}

		if (!changed) {
			result = { settingsPath, changed: false };
			return undefined;
		}

		const backupPath = current ? `${settingsPath}.bak-${settingsBackupTimestamp()}` : undefined;
		if (backupPath) {
			writeFileSync(backupPath, current, { encoding: "utf8", flag: "wx", mode: 0o600 });
		}
		result = { settingsPath, backupPath, changed: true };
		return `${JSON.stringify(settings, null, 2)}\n`;
	});

	if (!result) {
		throw new Error("Pi settings storage did not return a write result.");
	}
	return result;
}

function configuredGnosisPath(config: TlhGnosisConfig | undefined): string | undefined {
	const installPath = config?.installPath;
	if (typeof installPath !== "string" || !installPath.trim()) {
		return undefined;
	}
	return resolve(expandHomePath(installPath.trim()));
}

function validateTlhSettings(settings: unknown): asserts settings is TlhSettings {
	if (!isPlainObject(settings)) {
		throw new Error("settings.json must contain a JSON object");
	}
	const tlh = settings.tlh;
	if (tlh !== undefined && !isPlainObject(tlh)) {
		throw new Error("settings field 'tlh' must be an object if present");
	}
	const gnosis = isPlainObject(tlh) ? tlh.gnosis : undefined;
	if (gnosis !== undefined && !isPlainObject(gnosis)) {
		throw new Error("settings field 'tlh.gnosis' must be an object if present");
	}
}

function ensureMutableGnosisSettings(settings: TlhSettings): asserts settings is TlhSettings & { tlh: { gnosis: TlhGnosisConfig } } {
	validateTlhSettings(settings);
	settings.tlh ??= {};
	settings.tlh.gnosis ??= {};
}

function readTlhSettingsForWrite(settingsPath: string): { settings: TlhSettings; previousRaw: string } {
	const previousRaw = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "") : "";
	if (!previousRaw.trim()) {
		return { settings: {}, previousRaw };
	}

	let settings: unknown;
	try {
		settings = JSON.parse(previousRaw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid JSON in ${formatHomePath(settingsPath)}: ${message}`);
	}
	validateTlhSettings(settings);
	return { settings, previousRaw };
}

function gnosisState(settings: TlhSettings): TlhGnosisState {
	const enabled = settings.tlh?.gnosis?.enabled;
	if (enabled === true) return "enabled";
	if (enabled === false) return "disabled";
	return "unset";
}

function currentGnosisState(): TlhGnosisState {
	try {
		const settingsPath = join(getAgentDir(), "settings.json");
		const { settings } = readTlhSettingsForWrite(settingsPath);
		return gnosisState(settings);
	} catch {
		return "unset";
	}
}

function formatGnosisToggleDescription(state: TlhGnosisState = currentGnosisState()): string {
	return `Toggle gnosis ${state === "enabled" ? "off" : "on"}`;
}

function backupPathFor(settingsPath: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `${settingsPath}.backup-tlh-gnosis-${stamp}`;
}

function assertNotNormalPiSettings(settingsPath: string): void {
	const normalPiRoot = realpathForCompare(join(homedir(), ".pi"));
	const resolvedSettingsPath = realpathForCompare(settingsPath);
	if (resolvedSettingsPath === normalPiRoot || resolvedSettingsPath.startsWith(`${normalPiRoot}${sep}`)) {
		throw new Error(`Refusing to modify normal Pi config from tlh: ${formatHomePath(settingsPath)}`);
	}
}

function writeTlhSettings(settingsPath: string, settings: TlhSettings, previousRaw: string): { changed: boolean; backupPath?: string } {
	const formatted = `${JSON.stringify(settings, null, 2)}\n`;
	if (formatted === previousRaw) {
		return { changed: false };
	}

	mkdirSync(dirname(settingsPath), { recursive: true });
	let backupPath: string | undefined;
	if (existsSync(settingsPath)) {
		backupPath = backupPathFor(settingsPath);
		copyFileSync(settingsPath, backupPath);
	}

	const tempPath = `${settingsPath}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tempPath, formatted, "utf8");
	renameSync(tempPath, settingsPath);
	return { changed: true, backupPath };
}

function uniqueGnosisCandidates(candidates: Array<string | undefined>): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const candidate of candidates) {
		if (!candidate) continue;
		const key = candidate === "gn" ? candidate : resolve(candidate);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(candidate);
	}
	return unique;
}

function validateGnosisCommand(command: string): boolean {
	try {
		for (const args of [["help", "plan"], ["help", "review"]]) {
			execFileSync(command, args, { stdio: "ignore", timeout: GNOSIS_VALIDATION_TIMEOUT_MS });
		}
		return true;
	} catch {
		return false;
	}
}

function prependProcessPath(dir: string): void {
	const currentPath = process.env.PATH || "";
	const entries = currentPath.split(delimiter).filter(Boolean);
	if (entries.includes(dir)) {
		return;
	}
	process.env.PATH = [dir, ...entries].join(delimiter);
}

function findValidGnosisCommand(config: TlhGnosisConfig | undefined, agentDir: string, options: { prependPath?: boolean } = {}): string | undefined {
	const candidates = uniqueGnosisCandidates([configuredGnosisPath(config), join(agentDir, "bin", "gn"), "gn"]);
	for (const candidate of candidates) {
		if (!validateGnosisCommand(candidate)) continue;
		if (options.prependPath && candidate !== "gn") {
			prependProcessPath(dirname(candidate));
		}
		return candidate;
	}
	return undefined;
}

function findEnabledGnosisCommand(cwd: string): string | undefined {
	const config = getTlhGnosisConfig(cwd);
	if (config?.enabled !== true) {
		return undefined;
	}

	return findValidGnosisCommand(config, getAgentDir(), { prependPath: true });
}

function shouldAppendGnosisPrompt(cwd: string): boolean {
	return Boolean(findEnabledGnosisCommand(cwd));
}

function readMarkdownFilesRecursive(dir: string): string[] {
	if (!existsSync(dir)) {
		return [];
	}

	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}

	const files: string[] = [];
	for (const entry of entries) {
		const filePath = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...readMarkdownFilesRecursive(filePath));
			continue;
		}
		if (!entry.isFile() && !entry.isSymbolicLink()) {
			continue;
		}
		if (entry.name.endsWith(".md")) {
			files.push(filePath);
		}
	}
	return files;
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	if (!content.startsWith("---")) {
		return { frontmatter: {}, body: content.trim() };
	}
	const end = content.indexOf("\n---", 3);
	if (end === -1) {
		return { frontmatter: {}, body: content.trim() };
	}

	const frontmatter: Record<string, string> = {};
	for (const line of content.slice(3, end).split(/\r?\n/)) {
		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match) {
			continue;
		}
		frontmatter[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
	}

	return { frontmatter, body: content.slice(content.indexOf("\n", end + 1) + 1).trim() };
}

function splitCommaList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function parseThinkingLevelValue(value: string | undefined): ThinkingLevel | undefined {
	return value && isThinkingLevel(value) ? value : undefined;
}

function parseAgentPrompt(filePath: string): AgentPrompt | undefined {
	const content = readText(filePath);
	if (!content) {
		return undefined;
	}
	const { frontmatter, body } = parseFrontmatter(content);
	const name = frontmatter.name?.trim();
	const description = frontmatter.description?.trim();
	if (!name || !description) {
		return undefined;
	}
	return {
		name,
		description,
		model: frontmatter.model?.trim() || undefined,
		thinking: parseThinkingLevelValue(frontmatter.thinking),
		tools: splitCommaList(frontmatter.tools),
		systemPrompt: body,
		filePath,
	};
}

function loadPrimaryAgent(): AgentPrompt | undefined {
	return parseAgentPrompt(join(packageRoot(), "agents", "primary", `${ACTIVE_PRIMARY_AGENT}.md`));
}

function loadSubagentMetadata(): SubagentMetadata[] {
	return readMarkdownFilesRecursive(join(packageRoot(), "agents", "subagents"))
		.map((filePath) => parseAgentPrompt(filePath))
		.filter((agent): agent is AgentPrompt => Boolean(agent))
		.map((agent) => ({ name: agent.name, description: agent.description }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

function formatAllowedSubagents(subagents: SubagentMetadata[]): string {
	const allowed = new Set(ALLOWED_SUBAGENTS);
	const lines = subagents
		.filter((agent) => allowed.has(agent.name))
		.map((agent) => `- ${agent.name}: ${agent.description}`);
	if (lines.length === 0) {
		return "";
	}
	return `## TLH Allowed Minor Subagents\n\nYou may delegate only to these minor agents via the subagent tool:\n\n${lines.join("\n")}`;
}

function buildTlhSystemPrompt(primary: AgentPrompt | undefined, subagents: SubagentMetadata[], architectEnabled: boolean): string {
	const prompts = [HARNESS_PROMPT.trim()];
	if (architectEnabled) {
		prompts.push(primary?.systemPrompt.trim(), formatAllowedSubagents(subagents));
	}
	return prompts.filter(Boolean).join("\n\n");
}

function buildChildSubagentSystemPrompt(): string {
	return [HARNESS_PROMPT.trim(), CHILD_SUBAGENT_PROMPT.trim()].filter(Boolean).join("\n\n");
}

function parseFrontmatterValue(content: string | undefined, key: string): string | undefined {
	if (!content?.startsWith("---")) {
		return undefined;
	}
	const end = content.indexOf("\n---", 3);
	if (end === -1) {
		return undefined;
	}
	const frontmatter = content.slice(3, end).split(/\r?\n/);
	for (const line of frontmatter) {
		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match || match[1] !== key) {
			continue;
		}
		return match[2].trim().replace(/^['"]|['"]$/g, "") || undefined;
	}
	return undefined;
}

function uniqueSorted(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function stripAutocompleteSourceTag(description: string | undefined): string | undefined {
	if (!description) {
		return description;
	}
	const stripped = description.replace(AUTOCOMPLETE_SOURCE_TAG_PATTERN, "$1").trim();
	return stripped || undefined;
}

function stripAutocompleteSourceTags(suggestions: AutocompleteSuggestions | null): AutocompleteSuggestions | null {
	if (!suggestions) {
		return suggestions;
	}

	let changed = false;
	const isSlashCommandList = suggestions.prefix.startsWith("/");
	const items = suggestions.items.map((item) => {
		let description = stripAutocompleteSourceTag(item.description);
		if (isSlashCommandList && item.value === "gnosis" && item.label === "gnosis") {
			description = formatGnosisToggleDescription();
		}
		if (description === item.description) {
			return item;
		}
		changed = true;
		if (description) {
			return { ...item, description };
		}
		const next = { ...item };
		delete next.description;
		return next;
	});

	return changed ? { ...suggestions, items } : suggestions;
}

function createTlhAutocompleteProvider(current: AutocompleteProvider): AutocompleteProvider {
	return {
		async getSuggestions(
			lines: string[],
			cursorLine: number,
			cursorCol: number,
			options: { signal: AbortSignal; force?: boolean },
		) {
			return stripAutocompleteSourceTags(await current.getSuggestions(lines, cursorLine, cursorCol, options));
		},
		applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

function formatTokens(count: number): string {
	if (count < 1000) {
		return count.toString();
	}
	if (count < 10000) {
		return `${(count / 1000).toFixed(1)}k`;
	}
	if (count < 1000000) {
		return `${Math.round(count / 1000)}k`;
	}
	if (count < 10000000) {
		return `${(count / 1000000).toFixed(1)}M`;
	}
	return `${Math.round(count / 1000000)}M`;
}

function formatHomePath(path: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && (path === home || path.startsWith(`${home}/`))) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

function formatCost(cost: number): string {
	return cost < 0.001 ? "<$0.001" : `$${cost.toFixed(3)}`;
}

function getCurrentThinkingLevel(pi: ExtensionAPI): string {
	try {
		return pi.getThinkingLevel();
	} catch {
		return "off";
	}
}

function collectUsageTotals(ctx: ExtensionContext) {
	const totals = { cost: 0 };
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") {
			continue;
		}
		const usage = entry.message.usage;
		if (!usage) {
			continue;
		}
		totals.cost += Number(usage.cost?.total) || 0;
	}
	return totals;
}

function parseProviderModel(model: string): { provider: string; id: string } | undefined {
	const slash = model.indexOf("/");
	if (slash <= 0 || slash === model.length - 1) {
		return undefined;
	}
	return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

function primaryToolAllowlist(primary: AgentPrompt | undefined): string[] {
	return primary?.tools.length
		? primary.tools
		: ["read", "grep", "find", "ls", "bash", "subagent", "intercom"];
}

function sameToolSet(left: string[] | undefined, right: string[] | undefined): boolean {
	if (!left || !right || left.length !== right.length) {
		return false;
	}
	const rightSet = new Set(right);
	return left.every((tool) => rightSet.has(tool));
}

function filterAvailableTools(toolNames: string[], availableToolNames: Set<string>): string[] {
	return toolNames.filter((toolName) => availableToolNames.has(toolName));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type BranchEntryLike = {
	type: string;
	customType?: string;
	data?: unknown;
};

function primaryAgentOverrideFromBranch(entries: BranchEntryLike[]): boolean | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== PRIMARY_AGENT_SESSION_STATE_ENTRY) {
			continue;
		}
		if (typeof entry.data === "boolean") {
			return entry.data;
		}
		if (isRecord(entry.data) && typeof entry.data.enabled === "boolean") {
			return entry.data.enabled;
		}
		return undefined;
	}
	return undefined;
}

function primaryAgentLabel(enabled: boolean): string {
	return enabled ? ACTIVE_PRIMARY_AGENT : "disabled";
}

function primaryAgentDefaultLabel(enabled: boolean | undefined): string {
	if (enabled === undefined) {
		return "unset (TLH default: architect)";
	}
	return enabled ? "architect" : "disabled";
}

function primaryAgentOverrideLabel(enabled: boolean | undefined): string {
	if (enabled === undefined) {
		return "none";
	}
	return enabled ? "architect" : "disabled";
}

function formatPathFromCwd(cwd: string, filePath: string): string {
	const absolutePath = resolve(filePath);
	const rel = relative(cwd, absolutePath);
	if (rel && !rel.startsWith("..") && !rel.startsWith("/")) {
		return rel;
	}
	const home = process.env.HOME;
	if (home && (absolutePath === home || absolutePath.startsWith(`${home}/`))) {
		return `~${absolutePath.slice(home.length)}`;
	}
	return absolutePath;
}

function packageSourceLabel(source: string | undefined): string | undefined {
	if (!source) {
		return undefined;
	}
	const github = source.match(/^git:github\.com\/([^@]+)(?:@.*)?$/);
	if (github) {
		return github[1];
	}
	const npm = source.match(/^npm:(.+)$/);
	if (npm) {
		return npm[1];
	}
	return source;
}

function labelSkill(resource: ResolvedResource): string {
	const content = readText(resource.path);
	return parseFrontmatterValue(content, "name") ?? basename(dirname(resource.path));
}

function labelPrompt(resource: ResolvedResource): string {
	const content = readText(resource.path);
	const name = parseFrontmatterValue(content, "name") ?? basename(resource.path, extname(resource.path));
	return `/${name}`;
}

function labelExtension(resource: ResolvedResource): string {
	const sourceLabel = packageSourceLabel(resource.metadata.source);
	const fileLabel = basename(resource.path);
	return sourceLabel ? `${sourceLabel}:${fileLabel}` : fileLabel;
}

function labelTheme(resource: ResolvedResource): string {
	try {
		const theme = JSON.parse(readFileSync(resource.path, "utf8"));
		if (typeof theme.name === "string" && theme.name.trim()) {
			return theme.name.trim();
		}
	} catch {
		// fall through to filename
	}
	return basename(resource.path, extname(resource.path));
}

function getAvailableThinkingLevels(model: ReasoningModel | undefined): ThinkingLevel[] {
	if (!model) {
		return FALLBACK_THINKING_LEVELS;
	}
	if (!model.reasoning) {
		return ["off"];
	}

	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) {
			return false;
		}
		if (level === "xhigh") {
			return mapped !== undefined;
		}
		return true;
	});
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return THINKING_LEVELS.includes(value as ThinkingLevel);
}

function formatThinkingLevelOption(level: ThinkingLevel, currentLevel: ThinkingLevel): string {
	const marker = level === currentLevel ? "✓" : " ";
	return `${marker} ${level} — ${THINKING_LEVEL_DESCRIPTIONS[level]}`;
}

function parseThinkingLevelOption(option: string): ThinkingLevel | undefined {
	return THINKING_LEVELS.find((level) => option.includes(` ${level} —`));
}

function parseGnosisSlashAction(args: string): TlhGnosisSlashAction | undefined {
	const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (parts.length === 0) {
		return "toggle";
	}
	if (parts.length > 1) {
		return undefined;
	}
	const [action] = parts;
	if (action === "toggle") return "toggle";
	if (action === "status") return "status";
	if (action === "enable" || action === "on") return "enable";
	if (action === "disable" || action === "off") return "disable";
	return undefined;
}

function formatGnosisStatus(settings: TlhSettings, validCommand: string | undefined): string {
	const state = gnosisState(settings);
	const active = state === "enabled" && Boolean(validCommand);
	const binary = validCommand ? formatHomePath(validCommand) : "not found";
	return `Gnosis setting: ${state}. Active: ${active ? "yes" : "no"}. Binary: ${binary}.`;
}

function notifyGnosisWriteResult(ctx: ExtensionContext, result: { changed: boolean; backupPath?: string }): void {
	if (!result.changed) {
		ctx.ui.notify("No Gnosis settings changes were needed.", "info");
	}
}

async function collectStartupResources(cwd: string): Promise<StartupResources> {
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const resolved = await packageManager.resolve(async () => "skip");
	const enabled = (resources: ResolvedResource[]) => resources.filter((resource) => resource.enabled && existsSync(resource.path));

	return {
		context: loadProjectContextFiles({ cwd, agentDir }).map((contextFile) => formatPathFromCwd(cwd, contextFile.path)),
		skills: uniqueSorted(enabled(resolved.skills).map(labelSkill)),
		prompts: uniqueSorted(enabled(resolved.prompts).map(labelPrompt)),
		extensions: uniqueSorted(enabled(resolved.extensions).map(labelExtension)),
		themes: uniqueSorted(enabled(resolved.themes).map(labelTheme)),
	};
}

function createTlhFooter(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	theme: Theme,
	getPrimaryName: () => string,
	footerData?: ReadonlyFooterDataProvider,
) {
	return {
		render(width: number): string[] {
			const model = ctx.model;
			const totals = collectUsageTotals(ctx);
			const contextUsage = ctx.getContextUsage();
			const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
			const contextPercentValue = contextUsage?.percent ?? 0;
			const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

			let pwd = formatHomePath(ctx.sessionManager.getCwd());
			const branch = footerData?.getGitBranch?.();
			if (branch) {
				pwd = `${pwd} (${branch})`;
			}
			const sessionName = ctx.sessionManager.getSessionName();
			if (sessionName) {
				pwd = `${pwd} • ${sessionName}`;
			}

			const statsParts: string[] = [];
			const usingSubscription = model ? ctx.modelRegistry.isUsingOAuth(model) : false;
			// In tlh, subscription users should not see dollar-cost estimates in the footer.
			if (totals.cost > 0 && !usingSubscription) {
				statsParts.push(formatCost(totals.cost));
			}

			const contextPercentDisplay =
				contextPercent === "?" ? `?/${formatTokens(contextWindow)}` : `${contextPercent}%/${formatTokens(contextWindow)}`;
			let contextPercentStr: string;
			if (contextPercentValue > 90) {
				contextPercentStr = theme.fg("error", contextPercentDisplay);
			} else if (contextPercentValue > 70) {
				contextPercentStr = theme.fg("warning", contextPercentDisplay);
			} else {
				contextPercentStr = contextPercentDisplay;
			}
			let contextStats = contextPercentStr;
			if ((contextUsage?.tokens ?? 0) > DUMB_ZONE_THRESHOLD_TOKENS) {
				contextStats += `${theme.fg("dim", " • ")}${theme.fg("error", DUMB_ZONE_LABEL)}`;
			}
			statsParts.push(contextStats);

			let statsLeft = statsParts.join(" ");
			let statsLeftWidth = visibleWidth(statsLeft);
			if (statsLeftWidth > width) {
				statsLeft = truncateToWidth(statsLeft, width, "...");
				statsLeftWidth = visibleWidth(statsLeft);
			}

			const modelName = model?.id || "no-model";
			let rightSideWithoutProvider = modelName;
			if (model?.reasoning) {
				const thinkingLevel = getCurrentThinkingLevel(pi);
				rightSideWithoutProvider =
					thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
			}

			const minPadding = 2;
			let rightSide = rightSideWithoutProvider;
			if ((footerData?.getAvailableProviderCount?.() ?? 1) > 1 && model) {
				rightSide = `(${model.provider}) ${rightSideWithoutProvider}`;
				if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
					rightSide = rightSideWithoutProvider;
				}
			}

			const rightSideWidth = visibleWidth(rightSide);
			const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;
			let statsLine: string;
			if (totalNeeded <= width) {
				const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
				statsLine = statsLeft + padding + rightSide;
			} else {
				const availableForRight = width - statsLeftWidth - minPadding;
				if (availableForRight > 0) {
					const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
					const truncatedRightWidth = visibleWidth(truncatedRight);
					const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
					statsLine = statsLeft + padding + truncatedRight;
				} else {
					statsLine = statsLeft;
				}
			}

			const dimStatsLeft = theme.fg("dim", statsLeft);
			const remainder = statsLine.slice(statsLeft.length);
			const dimRemainder = theme.fg("dim", remainder);
			const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
			const agentLine = truncateToWidth(theme.fg("dim", `agent: ${getPrimaryName()}`), width, theme.fg("dim", "..."));
			const lines = [pwdLine, dimStatsLeft + dimRemainder, agentLine];

			const editorText = ctx.ui.getEditorText();
			if (editorText.length > 0 && !ctx.isIdle()) {
				const steerKey = keyText("tui.input.submit") || "enter";
				const queueKey = keyText("app.message.followUp") || "alt+enter";
				const steeringHint = `${theme.fg("dim", steerKey)}${theme.fg("muted", " steer")}`;
				const queueHint = `${theme.fg("dim", queueKey)}${theme.fg("muted", " queue follow-up")}`;
				lines.push(truncateToWidth(`${steeringHint}${theme.fg("muted", " · ")}${queueHint}`, width, theme.fg("dim", "...")));
			}

			const extensionStatuses = footerData?.getExtensionStatuses?.();
			if (extensionStatuses && extensionStatuses.size > 0) {
				const statusLine = Array.from(extensionStatuses.entries())
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([, text]) => sanitizeStatusText(text))
					.join(" ");
				lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
			}

			return lines;
		},
		invalidate() {},
	};
}

function createTlhHeader(theme: Theme, resources: StartupResources, headerUpdate: TlhHeaderUpdate | undefined) {
	let expanded = false;
	const color = {
		heading: (text: string) => theme.fg("mdHeading", text),
		dim: (text: string) => theme.fg("dim", text),
		accent: (text: string) => theme.fg("accent", text),
	};

	const logo = headerUpdate
		? `${theme.bold(color.accent(TLH_NAME))}${color.dim(` v${headerUpdate.version}`)} ${color.accent(headerUpdate.releasesUrl)}`
		: theme.bold(color.accent(TLH_NAME));

	const section = (name: string, items: string[]): string[] => {
		if (items.length === 0) {
			return [];
		}
		return [color.heading(`[${name}]`), color.dim(`  ${items.join(", ")}`)];
	};

	const contextLine = (items: string[], width: number): string[] => {
		if (items.length === 0) {
			return [];
		}
		return [truncateToWidth(color.dim(`Context: ${items.join(", ")}`), width, color.dim("..."))];
	};

	const renderCollapsed = (width: number) => {
		const lines = [logo];
		const contextLines = contextLine(resources.context, width);
		if (contextLines.length > 0) {
			lines.push("", ...contextLines);
		}
		return lines;
	};

	const renderExpanded = (width: number) => {
		const lines = renderCollapsed(width);
		const resourceSections = [
			section("Skills", resources.skills),
			section("Prompts", resources.prompts),
			section("Extensions", resources.extensions),
			section("Themes", resources.themes),
		].filter((resourceSection) => resourceSection.length > 0);

		for (const resourceSection of resourceSections) {
			lines.push("", ...resourceSection);
		}
		return lines;
	};

	return {
		render(width: number): string[] {
			return expanded ? renderExpanded(width) : renderCollapsed(width);
		},
		setExpanded(nextExpanded: boolean) {
			expanded = nextExpanded;
		},
		invalidate() {},
	};
}

export default function theLastHarness(pi: ExtensionAPI) {
	if (registerTlhStartupMode(pi, { env: process.env, buildChildSubagentSystemPrompt }) === "child") {
		return;
	}

	const primaryAgent = loadPrimaryAgent();
	const subagentMetadata = loadSubagentMetadata();
	const warned = new Set<string>();
	let primaryModelAttempted = false;
	let primaryAgentDefaultEnabled = true;
	let sessionPrimaryAgentOverride: boolean | undefined;
	let prePrimaryActiveTools: string[] | undefined;
	let appliedPrimaryTools: string[] | undefined;

	function warnOnce(ctx: ExtensionContext, key: string, message: string): void {
		if (warned.has(key)) {
			return;
		}
		warned.add(key);
		ctx.ui.notify(message, "warning");
	}

	function syncPrimaryAgentState(ctx: ExtensionContext): void {
		primaryAgentDefaultEnabled = getTlhPrimaryAgentDefaultEnabled(ctx.cwd);
		sessionPrimaryAgentOverride = primaryAgentOverrideFromBranch(ctx.sessionManager.getBranch());
	}

	function isArchitectEnabled(): boolean {
		return sessionPrimaryAgentOverride ?? primaryAgentDefaultEnabled;
	}

	function currentPrimaryAgentLabel(): string {
		return primaryAgentLabel(isArchitectEnabled());
	}

	function primaryAgentStatusMessage(ctx: ExtensionContext): string {
		syncPrimaryAgentState(ctx);
		const primaryConfig = getTlhPrimaryAgentConfig(ctx.cwd);
		const override = sessionPrimaryAgentOverride;
		const effective = isArchitectEnabled();
		const settingsPath = tlhSettingsPathForWrite();
		const settingsLabel = settingsPath ? formatHomePath(settingsPath) : "unavailable outside isolated TLH profile";
		return [
			`${TLH_PACKAGE_NAME} (${TLH_NAME}) is active.`,
			`Primary agent: ${primaryAgentLabel(effective)}.`,
			`Session override: ${primaryAgentOverrideLabel(override)}.`,
			`Persistent default: ${primaryAgentDefaultLabel(primaryConfig?.enabled)}.`,
			`Settings: ${settingsLabel}.`,
		].join("\n");
	}

	function setSessionPrimaryAgentOverride(enabled: boolean | undefined): void {
		sessionPrimaryAgentOverride = enabled;
		if (enabled === undefined) {
			pi.appendEntry<TlhPrimaryAgentSessionState>(PRIMARY_AGENT_SESSION_STATE_ENTRY, {});
			return;
		}
		pi.appendEntry<TlhPrimaryAgentSessionState>(PRIMARY_AGENT_SESSION_STATE_ENTRY, { enabled });
	}

	function getValidPrimaryTools(ctx: ExtensionContext): string[] {
		const desiredTools = primaryToolAllowlist(primaryAgent);
		const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
		const validTools = filterAvailableTools(desiredTools, allToolNames);
		const missingTools = desiredTools.filter((tool) => !allToolNames.has(tool));
		if (missingTools.length > 0) {
			warnOnce(ctx, "missing-primary-tools", `TLH primary agent tools are not available yet: ${missingTools.join(", ")}`);
		}
		return validTools;
	}

	function applyPrimaryTools(ctx: ExtensionContext): void {
		const validTools = getValidPrimaryTools(ctx);
		if (validTools.length === 0) {
			return;
		}
		const currentTools = pi.getActiveTools();
		if (prePrimaryActiveTools === undefined) {
			prePrimaryActiveTools = currentTools;
		}
		pi.setActiveTools(validTools);
		appliedPrimaryTools = validTools;
	}

	function restorePrimaryToolsIfAppropriate(): void {
		if (prePrimaryActiveTools === undefined) {
			return;
		}
		const currentTools = pi.getActiveTools();
		if (appliedPrimaryTools && !sameToolSet(currentTools, appliedPrimaryTools)) {
			prePrimaryActiveTools = undefined;
			appliedPrimaryTools = undefined;
			return;
		}
		const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
		pi.setActiveTools(filterAvailableTools(prePrimaryActiveTools, allToolNames));
		prePrimaryActiveTools = undefined;
		appliedPrimaryTools = undefined;
	}

	async function applyPrimaryModel(ctx: ExtensionContext): Promise<void> {
		if (!primaryAgent?.model || primaryModelAttempted) {
			return;
		}
		primaryModelAttempted = true;
		const parsedModel = parseProviderModel(primaryAgent.model);
		if (!parsedModel) {
			warnOnce(ctx, "invalid-primary-model", `TLH primary agent model is invalid: ${primaryAgent.model}`);
			return;
		}
		const model = ctx.modelRegistry.find(parsedModel.provider, parsedModel.id);
		if (!model) {
			warnOnce(ctx, "missing-primary-model", `TLH primary agent model not found: ${primaryAgent.model}`);
			return;
		}
		if (ctx.model?.provider === model.provider && ctx.model?.id === model.id) {
			return;
		}
		const success = await pi.setModel(model);
		if (!success) {
			warnOnce(ctx, "primary-model-unavailable", `TLH could not switch to primary agent model: ${primaryAgent.model}`);
		}
	}

	async function applyPrimaryDefaults(ctx: ExtensionContext): Promise<void> {
		if (!isArchitectEnabled()) {
			restorePrimaryToolsIfAppropriate();
			return;
		}

		applyPrimaryTools(ctx);

		const primaryConfig = getTlhPrimaryAgentConfig(ctx.cwd);
		if (primaryConfig?.applyModel === true) {
			await applyPrimaryModel(ctx);
		}
		if (primaryConfig?.applyThinking === true && primaryAgent?.thinking) {
			pi.setThinkingLevel(primaryAgent.thinking);
		}
	}

	async function applyArchitectModeChange(ctx: ExtensionContext): Promise<void> {
		await applyPrimaryDefaults(ctx);
	}

	function cleanNonArchitectSessionHint(enabled: boolean): string {
		return enabled
			? ""
			: " Existing conversation history may still contain architect guidance; start a new session for a completely clean non-architect context.";
	}

	async function cycleSessionPrimaryAgent(ctx: ExtensionContext): Promise<void> {
		syncPrimaryAgentState(ctx);
		const nextOverride = !isArchitectEnabled();
		const nextPrimaryAgent = primaryAgentLabel(nextOverride);
		setSessionPrimaryAgentOverride(nextOverride);
		await applyArchitectModeChange(ctx);
		ctx.ui.notify(
			`Shift+Tab switched TLH primary agent to ${nextPrimaryAgent} for this session.${cleanNonArchitectSessionHint(nextOverride)}`,
			"info",
		);
	}

	function architectCommandCompletions(prefix: string) {
		const options = [
			{ value: "status", description: "Show architect mode status" },
			{ value: "on", description: "Enable architect for this session" },
			{ value: "off", description: "Disable architect for this session" },
			{ value: "toggle", description: "Toggle architect for this session" },
			{ value: "reset", description: "Clear the session override" },
			{ value: "default on", description: "Persistently enable architect for future sessions" },
			{ value: "default off", description: "Persistently disable architect for future sessions" },
			{ value: "default reset", description: "Remove the persistent architect setting" },
		];
		const normalizedPrefix = prefix.trim().toLowerCase();
		const completions = options
			.filter((option) => option.value.startsWith(normalizedPrefix))
			.map((option) => ({ value: option.value, label: option.value, description: option.description }));
		return completions.length > 0 ? completions : null;
	}

	pi.registerCommand("tlh", {
		description: "Show tlh package status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(primaryAgentStatusMessage(ctx), "info");
		},
	});

	pi.registerCommand("harness", {
		description: "Alias for /tlh",
		handler: async (_args, ctx) => {
			ctx.ui.notify(primaryAgentStatusMessage(ctx), "info");
		},
	});

	pi.registerCommand("agent", {
		description: "Show the active TLH primary agent",
		handler: async (_args, ctx) => {
			syncPrimaryAgentState(ctx);
			ctx.ui.notify(`Active TLH primary agent: ${currentPrimaryAgentLabel()}.`, "info");
		},
	});

	pi.registerShortcut(PRIMARY_AGENT_CYCLE_SHORTCUT, {
		description: "Cycle TLH primary agent (architect/disabled)",
		handler: async (ctx) => {
			await cycleSessionPrimaryAgent(ctx);
		},
	});

	pi.registerCommand("architect", {
		description: "Show or change TLH architect primary-agent mode",
		getArgumentCompletions: architectCommandCompletions,
		handler: async (args, ctx) => {
			syncPrimaryAgentState(ctx);
			const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const [command, value] = parts;

			if (!command || command === "status") {
				ctx.ui.notify(primaryAgentStatusMessage(ctx), "info");
				return;
			}

			if (command === "on" || command === "off" || command === "toggle" || command === "reset") {
				if (parts.length > 1) {
					ctx.ui.notify("Usage: /architect on|off|toggle|reset", "error");
					return;
				}

				let nextOverride: boolean | undefined;
				if (command === "on") {
					nextOverride = true;
				} else if (command === "off") {
					nextOverride = false;
				} else if (command === "toggle") {
					nextOverride = !isArchitectEnabled();
				}

				setSessionPrimaryAgentOverride(nextOverride);
				await applyArchitectModeChange(ctx);
				if (nextOverride === undefined) {
					ctx.ui.notify(`Cleared architect session override. Primary agent: ${currentPrimaryAgentLabel()}.`, "info");
					return;
				}
				ctx.ui.notify(`Architect ${nextOverride ? "enabled" : "disabled"} for this session.${cleanNonArchitectSessionHint(nextOverride)}`, "info");
				return;
			}

			if (command === "default") {
				if (parts.length !== 2 || !["on", "off", "reset"].includes(value)) {
					ctx.ui.notify("Usage: /architect default on|off|reset", "error");
					return;
				}

				const nextDefault = value === "reset" ? undefined : value === "on";
				try {
					const result = writeTlhPrimaryAgentDefault(ctx.cwd, nextDefault);
					syncPrimaryAgentState(ctx);
					await applyArchitectModeChange(ctx);
					const changedLabel = result.changed ? "Updated" : "No change to";
					const backupLabel = result.backupPath ? ` Backup: ${formatHomePath(result.backupPath)}.` : "";
					ctx.ui.notify(
						`${changedLabel} architect persistent default at ${formatHomePath(result.settingsPath)}. Primary agent: ${currentPrimaryAgentLabel()}.${backupLabel}`,
						"info",
					);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Could not update architect persistent default: ${message}`, "error");
				}
				return;
			}

			ctx.ui.notify("Usage: /architect [status|on|off|toggle|reset|default on|default off|default reset]", "error");
		},
	});

	pi.registerCommand("gnosis", {
		description: formatGnosisToggleDescription(),
		getArgumentCompletions: (prefix) => {
			const normalizedPrefix = prefix.trim().toLowerCase();
			const actions = [
				{ value: "status", label: "status", description: "Show the current Gnosis setting and detected binary" },
				{ value: "enable", label: "enable", description: "Turn gnosis on" },
				{ value: "disable", label: "disable", description: "Turn gnosis off" },
				{ value: "toggle", label: "toggle", description: formatGnosisToggleDescription() },
			];
			const completions = actions.filter((action) => action.value.startsWith(normalizedPrefix));
			return completions.length > 0 ? completions : null;
		},
		handler: async (args, ctx) => {
			const action = parseGnosisSlashAction(args);
			if (!action) {
				ctx.ui.notify("Usage: /gnosis [status|enable|disable|toggle]. With no argument, /gnosis toggles the integration.", "error");
				return;
			}

			try {
				const agentDir = getAgentDir();
				const settingsPath = join(agentDir, "settings.json");
				assertNotNormalPiSettings(settingsPath);

				const { settings, previousRaw } = readTlhSettingsForWrite(settingsPath);
				const validCommand = findValidGnosisCommand(settings.tlh?.gnosis, agentDir);

				if (action === "status") {
					ctx.ui.notify(formatGnosisStatus(settings, validCommand), "info");
					return;
				}

				const shouldEnable = action === "enable" || (action === "toggle" && gnosisState(settings) !== "enabled");
				ensureMutableGnosisSettings(settings);
				settings.tlh.gnosis.enabled = shouldEnable;
				if (shouldEnable && validCommand && validCommand !== "gn") {
					settings.tlh.gnosis.installPath = resolve(validCommand);
					prependProcessPath(dirname(validCommand));
				}

				const writeResult = writeTlhSettings(settingsPath, settings, previousRaw);
				if (shouldEnable && validCommand) {
					ctx.ui.notify("Gnosis enabled for tlh. Prompt instructions will apply on the next agent turn.", "info");
				} else if (shouldEnable) {
					ctx.ui.notify("Gnosis enabled in tlh settings, but no valid `gn` binary was found. Run `tlh update --with-gnosis` or install Gnosis manually.", "warning");
				} else {
					ctx.ui.notify("Gnosis disabled for tlh. Existing .gnosis project memory was not deleted.", "info");
				}
				notifyGnosisWriteResult(ctx, writeResult);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Unable to update Gnosis integration: ${message}`, "error");
			}
		},
	});

	pi.registerCommand("effort", {
		description: "Pick the model reasoning effort / thinking level",
		getArgumentCompletions: (prefix) => {
			const normalizedPrefix = prefix.trim().toLowerCase();
			const completions = THINKING_LEVELS.filter((level) => level.startsWith(normalizedPrefix)).map((level) => ({
				value: level,
				label: level,
				description: THINKING_LEVEL_DESCRIPTIONS[level],
			}));
			return completions.length > 0 ? completions : null;
		},
		handler: async (args, ctx) => {
			const currentLevel = pi.getThinkingLevel();
			const availableLevels = getAvailableThinkingLevels(ctx.model as ReasoningModel | undefined);
			const requestedLevel = args.trim().toLowerCase();

			if (requestedLevel) {
				if (!isThinkingLevel(requestedLevel)) {
					ctx.ui.notify(`Unknown effort "${args.trim()}". Available: ${availableLevels.join(", ")}.`, "error");
					return;
				}
				if (!availableLevels.includes(requestedLevel)) {
					ctx.ui.notify(`Effort "${requestedLevel}" is not available for the current model. Available: ${availableLevels.join(", ")}.`, "warning");
					return;
				}
				pi.setThinkingLevel(requestedLevel);
				ctx.ui.notify(`Effort set to ${pi.getThinkingLevel()}.`, "info");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(`Available efforts: ${availableLevels.join(", ")}. Current: ${currentLevel}.`, "info");
				return;
			}

			const options = availableLevels.map((level) => formatThinkingLevelOption(level, currentLevel));
			const selected = await ctx.ui.select("Pick reasoning effort", options);
			const selectedLevel = selected ? parseThinkingLevelOption(selected) : undefined;
			if (!selectedLevel) {
				return;
			}

			pi.setThinkingLevel(selectedLevel);
			ctx.ui.notify(`Effort set to ${pi.getThinkingLevel()}.`, "info");
		},
	});

	pi.on("session_start", async (event, ctx) => {
		syncPrimaryAgentState(ctx);
		await applyPrimaryDefaults(ctx);

		if (!ctx.hasUI) {
			return;
		}

		if (!sentTlhLaunchTelemetry && event.reason === "startup") {
			sentTlhLaunchTelemetry = true;
			const telemetrySnapshot: TlhTelemetrySnapshot = {
				version: getTlhVersion(),
				modelId: ctx.model?.id,
			};
			const timer = setTimeout(() => {
				void maybeSendTlhLaunchTelemetry(telemetrySnapshot).catch(() => undefined);
			}, 0) as ReturnType<typeof setTimeout> & { unref?: () => void };
			timer.unref?.();
		}

		ctx.ui.addAutocompleteProvider(createTlhAutocompleteProvider);

		let resources: StartupResources = { context: [], skills: [], prompts: [], extensions: [], themes: [] };
		try {
			resources = await collectStartupResources(ctx.cwd);
		} catch {
			// Keep startup resilient. The header can still render without resource details.
		}

		const headerUpdate = getTlhHeaderUpdate();

		if (typeof ctx.ui.setFooter === "function") {
			ctx.ui.setFooter((_tui, theme, footerData) =>
				createTlhFooter(pi, ctx, theme, () => currentPrimaryAgentLabel(), footerData),
			);
		}
		if (typeof ctx.ui.setHeader === "function") {
			ctx.ui.setHeader((_tui, theme) => createTlhHeader(theme, resources, headerUpdate));
		}

		void maybeNotifyAvailableTlhUpdate(ctx).catch(() => undefined);
	});

	pi.on("session_tree", async (_event, ctx) => {
		syncPrimaryAgentState(ctx);
		await applyPrimaryDefaults(ctx);
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		restorePrimaryToolsIfAppropriate();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		syncPrimaryAgentState(ctx);
		const architectEnabled = isArchitectEnabled();
		if (architectEnabled) {
			applyPrimaryTools(ctx);
		} else {
			restorePrimaryToolsIfAppropriate();
		}
		const prompts = [event.systemPrompt, buildTlhSystemPrompt(primaryAgent, subagentMetadata, architectEnabled)];
		if (shouldAppendGnosisPrompt(ctx.cwd)) {
			prompts.push(GNOSIS_PROMPT);
		}
		return { systemPrompt: prompts.filter(Boolean).join("\n\n") };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "subagent") {
			return undefined;
		}
		syncPrimaryAgentState(ctx);
		if (!isArchitectEnabled()) {
			return undefined;
		}
		const reason = validateSubagentToolInput(event.input);
		return reason ? { block: true, reason } : undefined;
	});
}

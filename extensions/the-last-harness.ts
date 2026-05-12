import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

const TLH_NAME = "tlh";
const TLH_PACKAGE_NAME = "The Last Harness";
const TLH_REPO = "diegopetrucci/the-last-harness";
const TLH_RELEASES_URL = `https://github.com/${TLH_REPO}/releases`;
const TLH_LATEST_RELEASE_API_URL = `https://api.github.com/repos/${TLH_REPO}/releases/latest`;
const TLH_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TLH_UPDATE_CHECK_TIMEOUT_MS = 3000;
const DUMB_ZONE_THRESHOLD_TOKENS = 200_000;
const DUMB_ZONE_LABEL = "DUMB ZONE";

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

type TlhUpdateCheckConfig = {
	enabled?: boolean;
};

type TlhSettings = {
	tlh?: {
		gnosis?: TlhGnosisConfig;
		updateCheck?: TlhUpdateCheckConfig;
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

type TlhHeaderUpdate = {
	version: string;
	releasesUrl: string;
};

type TlhLatestRelease = {
	version: string;
	tagName: string;
	releaseUrl: string;
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

function isDefaultPiAgentDir(agentDir: string): boolean {
	const home = process.env.HOME || process.env.USERPROFILE;
	return Boolean(home && resolve(agentDir) === resolve(home, ".pi", "agent"));
}

function tlhStartupStatePath(): string | undefined {
	// Only persist state when the wrapper has selected an isolated profile.
	// This avoids mutating normal Pi config.
	const agentDir = getAgentDir();
	if (!process.env.PI_CODING_AGENT_DIR || isDefaultPiAgentDir(agentDir)) {
		return undefined;
	}
	return join(agentDir, "tlh", "startup-state.json");
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
	const startupStatePath = tlhStartupStatePath();
	return startupStatePath ? join(dirname(startupStatePath), "install-state.json") : undefined;
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

function writeTlhStartupState(state: TlhStartupState): void {
	try {
		const statePath = tlhStartupStatePath();
		if (!statePath) {
			return;
		}
		mkdirSync(dirname(statePath), { recursive: true });
		writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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

function configuredGnosisPath(config: TlhGnosisConfig | undefined): string | undefined {
	const installPath = config?.installPath;
	if (typeof installPath !== "string" || !installPath.trim()) {
		return undefined;
	}
	return resolve(expandHomePath(installPath.trim()));
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

function findEnabledGnosisCommand(cwd: string): string | undefined {
	const config = getTlhGnosisConfig(cwd);
	if (config?.enabled !== true) {
		return undefined;
	}

	const agentDir = getAgentDir();
	const candidates = uniqueGnosisCandidates([configuredGnosisPath(config), join(agentDir, "bin", "gn"), "gn"]);
	for (const candidate of candidates) {
		if (!validateGnosisCommand(candidate)) continue;
		if (candidate !== "gn") {
			prependProcessPath(dirname(candidate));
		}
		return candidate;
	}
	return undefined;
}

function shouldAppendGnosisPrompt(cwd: string): boolean {
	return Boolean(findEnabledGnosisCommand(cwd));
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
			const lines = [pwdLine, dimStatsLeft + dimRemainder];

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
	pi.registerCommand("tlh", {
		description: "Show tlh package status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`${TLH_PACKAGE_NAME} (${TLH_NAME}) profile is installed and active.`, "info");
		},
	});

	pi.registerCommand("harness", {
		description: "Alias for /tlh",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`${TLH_PACKAGE_NAME} (${TLH_NAME}) profile is installed and active.`, "info");
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

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}

		let resources: StartupResources = { context: [], skills: [], prompts: [], extensions: [], themes: [] };
		try {
			resources = await collectStartupResources(ctx.cwd);
		} catch {
			// Keep startup resilient. The header can still render without resource details.
		}

		const headerUpdate = getTlhHeaderUpdate();

		if (typeof ctx.ui.setFooter === "function") {
			ctx.ui.setFooter((_tui, theme, footerData) => createTlhFooter(pi, ctx, theme, footerData));
		}
		if (typeof ctx.ui.setHeader === "function") {
			ctx.ui.setHeader((_tui, theme) => createTlhHeader(theme, resources, headerUpdate));
		}

		void maybeNotifyAvailableTlhUpdate(ctx).catch(() => undefined);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const prompts = [event.systemPrompt, HARNESS_PROMPT];
		if (shouldAppendGnosisPrompt(ctx.cwd)) {
			prompts.push(GNOSIS_PROMPT);
		}
		return { systemPrompt: prompts.join("\n") };
	});
}

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, arch as osArch, platform as osPlatform, release as osRelease, type as osType } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	THINKING_LEVELS,
	TLH_LAUNCH_TELEMETRY_EVENT_TYPE,
	TLH_NAME,
	TLH_TELEMETRY_APP_ID,
	TLH_TELEMETRY_INGEST_BASE_URL,
	TLH_TELEMETRY_NAMESPACE,
	TLH_TELEMETRY_STATE_SCHEMA_VERSION,
	TLH_TELEMETRY_TIMEOUT_MS,
} from "./constants.js";
import { isFalseyEnvFlag, isPlainObject, isTruthyEnvFlag, readText } from "./common.js";
import { buildExperimentalFeatureTelemetryPayload } from "./experimental.js";
import type { AgentModelDefaults, ProviderModelReference } from "./model-defaults.js";
import { formatProviderModelReference, parseProviderModelReference, selectProviderAwareAgentDefaults } from "./model-defaults.js";
import { getUnfilteredAvailableModels } from "./model-visibility.js";
import { getTlhVersion } from "./package-version.js";
import { tlhStateDir, tlhTelemetryStatePath } from "./profile-state.js";
import { parseFrontmatter } from "./prompts.js";
import { isThinkingLevel } from "./thinking.js";
import type {
	TlhExperimentalConfig,
	TlhOsMetadata,
	TlhTelemetryConfig,
	TlhTelemetryEnvelope,
	TlhTelemetrySnapshot,
	TlhTelemetryState,
} from "./types.js";

const PUBLIC_PROVIDER_IDS = new Set([
	"amazon-bedrock",
	"ant-ling",
	"anthropic",
	"azure-openai-responses",
	"cerebras",
	"cloudflare-ai-gateway",
	"cloudflare-workers-ai",
	"deepseek",
	"fireworks",
	"github-copilot",
	"google",
	"google-vertex",
	"groq",
	"huggingface",
	"kimi-coding",
	"llama.cpp",
	"minimax",
	"minimax-cn",
	"mistral",
	"moonshotai",
	"moonshotai-cn",
	"nvidia",
	"openai",
	"openai-codex",
	"opencode",
	"opencode-go",
	"openrouter",
	"qwen-token-plan",
	"qwen-token-plan-cn",
	"radius",
	"together",
	"vercel-ai-gateway",
	"xai",
	"xiaomi",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-sgp",
	"zai",
	"zai-coding-cn",
]);

const BUNDLED_PRIMARY_AGENT_NAMES = new Set(["architect", "bug-hunter", "product", "rush"]);

// Ordered to match the TLH_SUBAGENT_PROMPTS list in scripts/lib/tlh-install-subagents.mts.
// Never emit a telemetry key for an agent name outside this set.
const BUNDLED_SUBAGENT_NAMES = Object.freeze([
	"code-reviewer",
	"contrarian",
	"developer",
	"diff-summarizer",
	"librarian",
	"oracle",
	"repo-scout",
	"web-scout",
]) as readonly string[];

const execFileAsync = promisify(execFile);

let sentTlhLaunchTelemetry = false;

function configuredTlhTelemetryNamespace(): string {
	return (process.env.TLH_TELEMETRY_NAMESPACE || TLH_TELEMETRY_NAMESPACE).trim();
}

function configuredTlhTelemetryAppId(): string {
	return (process.env.TLH_TELEMETRY_APP_ID || TLH_TELEMETRY_APP_ID).trim();
}

function configuredTlhTelemetryIngestBaseUrl(): string {
	return (process.env.TLH_TELEMETRY_INGEST_BASE_URL || TLH_TELEMETRY_INGEST_BASE_URL).trim().replace(/\/+$/, "");
}

type SubagentOverrideEntry = {
	/**
	 * `false` means the user explicitly cleared this value via `thinking: false` in
	 * `subagents.agentOverrides`. Unlike `undefined` (no override), a `false` value must NOT
	 * fall back to the frontmatter default — it is reported as the sentinel "cleared".
	 */
	thinking?: string | false;
	/**
	 * `false` means the user explicitly cleared this value via `model: false` in
	 * `subagents.agentOverrides`. Unlike `undefined` (no override), a `false` value must NOT
	 * fall back to the frontmatter default — it is reported as the sentinel "cleared".
	 */
	model?: string | false;
	disabled?: boolean;
};

type TlhLaunchSettings = {
	telemetry?: TlhTelemetryConfig;
	experimental?: TlhExperimentalConfig;
	/**
	 * Per-agent overrides extracted from settings.subagents.agentOverrides, restricted to the
	 * eight bundled subagent names. Any name outside BUNDLED_SUBAGENT_NAMES is dropped here
	 * so it can never appear as a telemetry key.
	 *
	 * This is the USER-scope layer only. Project-scope overrides outrank it; see
	 * resolveEffectiveSubagentOverrides.
	 */
	subagentOverrides?: Record<string, SubagentOverrideEntry>;
};

/**
 * Extract `subagents.agentOverrides` from an already-parsed settings object, keeping only the
 * eight bundled subagent names so a user-authored agent name can never become a telemetry key.
 */
function extractBundledSubagentOverrides(settings: Record<string, unknown>): Record<string, SubagentOverrideEntry> | undefined {
	const subagentsSection = isPlainObject(settings.subagents) ? settings.subagents : undefined;
	const rawOverrides = isPlainObject(subagentsSection) && isPlainObject(subagentsSection.agentOverrides)
		? subagentsSection.agentOverrides
		: undefined;
	if (!rawOverrides) return undefined;

	let subagentOverrides: Record<string, SubagentOverrideEntry> | undefined;
	for (const name of BUNDLED_SUBAGENT_NAMES) {
		const entry = rawOverrides[name];
		if (!isPlainObject(entry)) continue;
		const overrideEntry: SubagentOverrideEntry = {};
		if (typeof entry.thinking === "string" || entry.thinking === false) overrideEntry.thinking = entry.thinking as string | false;
		if (typeof entry.model === "string" || entry.model === false) overrideEntry.model = entry.model as string | false;
		if (typeof entry.disabled === "boolean") overrideEntry.disabled = entry.disabled;
		if (Object.keys(overrideEntry).length > 0) {
			subagentOverrides ??= {};
			subagentOverrides[name] = overrideEntry;
		}
	}
	return subagentOverrides;
}

function isDirectorySync(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Locate the nearest project root above `cwd`, mirroring findNearestProjectRoot in
 * extensions/subagents/src/agents/agents.ts:533. A directory qualifies when it contains the Pi
 * project config dir (`CONFIG_DIR_NAME`) or a legacy `.agents` dir. The isolated profile's own
 * parent and `~/<CONFIG_DIR_NAME>` are ignored so the user profile is never mistaken for a project.
 *
 * NOTE — Do NOT replace with `SettingsManager.getProjectSettings()`. `FileSettingsStorage` (from
 * `@earendil-works/pi-coding-agent`) sets `projectSettingsPath = join(resolvedCwd, CONFIG_DIR_NAME,
 * "settings.json")` — cwd-only, no upward walk — while the subagents runtime uses
 * `findNearestProjectRoot` + `getProjectAgentSettingsPath` (both in
 * `extensions/subagents/src/agents/agents.ts`) to walk parent directories. Swapping would
 * silently miss a project's `settings.json` when `tlh` is launched from a subdirectory, causing
 * telemetry to report user-scope overrides as effective when a project-scope override should have
 * won. Empty/malformed/absent cases do align between the two APIs; root resolution is the sole
 * blocking difference.
 */
function findNearestTlhProjectRoot(cwd: string): string | undefined {
	let ignored: Set<string>;
	try {
		ignored = new Set([resolve(dirname(getAgentDir())), resolve(homedir(), CONFIG_DIR_NAME)]);
	} catch {
		ignored = new Set<string>();
	}

	let currentDir = resolve(cwd);
	while (true) {
		const projectConfigDir = join(currentDir, CONFIG_DIR_NAME);
		if (isDirectorySync(projectConfigDir) && !ignored.has(resolve(projectConfigDir))) return currentDir;
		if (isDirectorySync(join(currentDir, ".agents"))) return currentDir;

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) return undefined;
		currentDir = parentDir;
	}
}

/**
 * Read project-scope `subagents.agentOverrides` from `<nearest project root>/<CONFIG_DIR_NAME>/settings.json`,
 * mirroring getProjectAgentSettingsPath in extensions/subagents/src/agents/agents.ts:560.
 *
 * An absent project settings file is the normal case, not an error. Anything unreadable or
 * malformed degrades quietly to `undefined` so reporting falls back to user scope rather than
 * dropping the whole telemetry event.
 *
 * Performs file I/O — must only be called from the deferred (setTimeout) send path.
 */
function readTlhProjectSubagentOverrides(cwd: string): Record<string, SubagentOverrideEntry> | undefined {
	try {
		const projectRoot = findNearestTlhProjectRoot(cwd);
		if (!projectRoot) return undefined;
		const settingsPath = join(projectRoot, CONFIG_DIR_NAME, "settings.json");
		const content = readText(settingsPath);
		if (!content || !content.trim()) return undefined;
		const settings: unknown = JSON.parse(content);
		return isPlainObject(settings) ? extractBundledSubagentOverrides(settings) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve the effective per-agent override the subagents runtime would actually apply.
 *
 * TLH's eight subagents are installed under `tlh/agents/subagents` and reach the runtime via
 * `subagents.agentDirs`, so they are resolved as USER-scope custom agents by
 * applyCustomAgentOverrides (extensions/subagents/src/agents/agents.ts:1035-1054), NOT by
 * applyBuiltinOverrides. That gives a two-rule precedence:
 *   1. project-scope `agentOverrides[name]`
 *   2. user-scope `agentOverrides[name]`
 *   3. otherwise unmodified
 *
 * The winning entry replaces the loser WHOLESALE — the runtime picks one scope's override object
 * and never merges fields across scopes, so a project entry setting only `thinking` also discards
 * a user entry's `model`. Mirror that exactly.
 *
 * `subagents.disableBuiltins` / `disableThinking` deliberately play no part here: both are read
 * only by applyBuiltinOverrides (agents.ts:895-906, applied via applyGlobalThinking at 903-939)
 * and apply solely to Pi's native BUILTIN_AGENT_NAMES (agents.ts:27-36), never to custom agents.
 */
function resolveEffectiveSubagentOverrides(
	userOverrides: Record<string, SubagentOverrideEntry> | undefined,
	projectOverrides: Record<string, SubagentOverrideEntry> | undefined,
): Record<string, SubagentOverrideEntry> {
	const resolved: Record<string, SubagentOverrideEntry> = {};
	for (const name of BUNDLED_SUBAGENT_NAMES) {
		const effective = projectOverrides?.[name] ?? userOverrides?.[name];
		if (effective) resolved[name] = effective;
	}
	return resolved;
}

function readTlhLaunchSettings(): { ok: true; config: TlhLaunchSettings } | { ok: false } {
	const stateDir = tlhStateDir();
	if (!stateDir) {
		return { ok: false };
	}

	const settingsPath = join(dirname(stateDir), "settings.json");
	if (!existsSync(settingsPath)) {
		return { ok: true, config: {} };
	}
	const settingsContent = readText(settingsPath);
	if (settingsContent === undefined) {
		return { ok: false };
	}
	if (!settingsContent.trim()) {
		return { ok: true, config: {} };
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
	const experimental = isPlainObject(tlh) && isPlainObject(tlh.experimental) ? (tlh.experimental as TlhExperimentalConfig) : undefined;

	// Extract subagents.agentOverrides — the whole settings object is already parsed above;
	// this avoids a second file read. Only retain overrides for bundled subagent names so
	// user-authored agent names can never appear as telemetry keys.
	const subagentOverrides = extractBundledSubagentOverrides(settings);

	return { ok: true, config: { telemetry: telemetry as TlhTelemetryConfig | undefined, experimental, subagentOverrides } };
}

export function shouldSkipTlhLaunchTelemetry(launchSettings: ReturnType<typeof readTlhLaunchSettings> = readTlhLaunchSettings()): boolean {
	if (!tlhTelemetryStatePath()) return true;
	if (!configuredTlhTelemetryNamespace() || !configuredTlhTelemetryAppId() || !configuredTlhTelemetryIngestBaseUrl()) return true;
	if (isTruthyEnvFlag(process.env.PI_OFFLINE)) return true;
	if (isTruthyEnvFlag(process.env.TLH_SKIP_TELEMETRY)) return true;
	if (isTruthyEnvFlag(process.env.TLH_TELEMETRY_DISABLED)) return true;
	if (isFalseyEnvFlag(process.env.PI_TELEMETRY)) return true;
	if (!launchSettings.ok) return true;
	return launchSettings.config.telemetry?.enabled === false;
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

export function privacySafeTlhTelemetryProviderId(providerId: string | undefined): string {
	if (typeof providerId !== "string" || !providerId.trim()) {
		return "unknown";
	}
	const normalized = providerId.trim().toLowerCase();
	if (!/^[a-z0-9._-]+$/.test(normalized) || normalized.length > 80) {
		return "custom";
	}
	return PUBLIC_PROVIDER_IDS.has(normalized) ? normalized : "custom";
}

// Intentionally case-SENSITIVE (no .toLowerCase()), unlike privacySafeTlhTelemetryModelId and
// privacySafeTlhTelemetryProviderId. Upstream pi-subagents performs a case-sensitive membership
// check in applyThinkingSuffix (it only trims, never lowercases), so a value like "High" is not
// a level upstream would honour. Reporting it as "custom" is therefore accurate and avoids
// silently masking a misconfiguration. Do NOT add .toLowerCase() here.
export function privacySafeTlhTelemetryThinkingLevel(thinkingLevel: string | undefined): string {
	if (typeof thinkingLevel !== "string" || !thinkingLevel.trim()) {
		return "unknown";
	}
	const normalized = thinkingLevel.trim();
	return (THINKING_LEVELS as readonly string[]).includes(normalized) ? normalized : "custom";
}

export function privacySafeTlhTelemetryPrimaryAgentName(primaryAgentName: string | undefined): string {
	if (typeof primaryAgentName !== "string" || !primaryAgentName.trim()) {
		return "unknown";
	}
	const normalized = primaryAgentName.trim().toLowerCase();
	if (!/^[a-z0-9._-]+$/.test(normalized) || normalized.length > 80) {
		return "custom";
	}
	return BUNDLED_PRIMARY_AGENT_NAMES.has(normalized) ? normalized : "custom";
}

export function privacySafeTlhTelemetryModelId(modelId: string | undefined): string {
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

export async function sendTlhTelemetry(
	envelopes: readonly TlhTelemetryEnvelope[],
	version: string,
	/**
	 * Already-read settings from the caller. Threaded through so a single send reads and parses
	 * settings.json once instead of twice (and evaluates the opt-out once). Omitted by callers
	 * that have not read settings yet.
	 */
	preReadLaunchSettings?: ReturnType<typeof readTlhLaunchSettings>,
): Promise<void> {
	if (envelopes.length === 0) {
		return;
	}
	const launchSettings = preReadLaunchSettings ?? readTlhLaunchSettings();
	if (shouldSkipTlhLaunchTelemetry(launchSettings)) return;
	if (!launchSettings.ok) return;

	const namespace = configuredTlhTelemetryNamespace();
	const appID = configuredTlhTelemetryAppId();
	const installId = getOrCreateTlhTelemetryInstallId();
	if (!namespace || !appID || !installId) return;

	const body = envelopes.map((envelope) => ({
		appID,
		clientUser: hashTlhTelemetryClientUser(installId),
		type: envelope.type,
		payload: envelope.payload,
	}));

	try {
		await fetch(`${configuredTlhTelemetryIngestBaseUrl()}/${encodeURIComponent(namespace)}/`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				"User-Agent": `${TLH_NAME}/${version}`,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TLH_TELEMETRY_TIMEOUT_MS),
		});
	} catch {
		// Telemetry is best-effort; never block runtime behavior.
	}
}

/**
 * Read provider-aware thinking and model from the installed subagent frontmatter file.
 *
 * Parses provider-aware keys (tlhOpenaiModels, tlhAnthropicModels, tlhOpenaiThinking,
 * tlhAnthropicThinking) using parseFrontmatter, then resolves the effective model and
 * thinking level for the active provider via selectProviderAwareAgentDefaults. This is
 * the same resolver the runtime uses for model selection, ensuring reported values match
 * what would actually be used.
 *
 * Falls back to generic `model:` and `thinking:` keys for compatibility with user-hand-edited
 * frontmatter that predates the provider-aware format.
 *
 * Install path set by scripts/lib/tlh-install-subagents.mts: <agentDir>/tlh/agents/subagents/<name>.md.
 * Returns empty object if the file is absent or unreadable.
 *
 * Must only be called from the deferred (setTimeout) send path, never synchronously.
 */
function readSubagentFrontmatterConfig(
	agentDir: string,
	name: string,
	providerId: string | undefined,
	availableModels: readonly ProviderModelReference[],
): { thinking?: string; model?: string } {
	const filePath = join(agentDir, "tlh", "agents", "subagents", `${name}.md`);
	const content = readText(filePath);
	if (!content) return {};
	const { frontmatter } = parseFrontmatter(content);

	// Split comma-separated model lists (e.g. "openai-codex/gpt-5.6-luna, openai/gpt-4o")
	const splitList = (val: string | undefined): string[] =>
		(val ?? "").split(",").map((s) => s.trim()).filter(Boolean);

	const agentDefaults: AgentModelDefaults = {
		name,
		model: frontmatter.model || undefined,
		tlhOpenaiModels: splitList(frontmatter.tlhOpenaiModels),
		tlhAnthropicModels: splitList(frontmatter.tlhAnthropicModels),
		thinking: frontmatter.thinking && isThinkingLevel(frontmatter.thinking) ? frontmatter.thinking : undefined,
		tlhOpenaiThinking: frontmatter.tlhOpenaiThinking && isThinkingLevel(frontmatter.tlhOpenaiThinking) ? frontmatter.tlhOpenaiThinking : undefined,
		tlhAnthropicThinking: frontmatter.tlhAnthropicThinking && isThinkingLevel(frontmatter.tlhAnthropicThinking) ? frontmatter.tlhAnthropicThinking : undefined,
		preferOppositeProvider: frontmatter.preferOppositeProvider?.trim() === "true" ? true
			: frontmatter.preferOppositeProvider?.trim() === "false" ? false : undefined,
		preferCurrentOpenaiModel: frontmatter.preferCurrentOpenaiModel?.trim() === "true" ? true
			: frontmatter.preferCurrentOpenaiModel?.trim() === "false" ? false : undefined,
	};

	// Resolve against the real available-models list captured at schedule time rather than
	// a synthetic list built from frontmatter candidates. This ensures the reported model
	// matches what the runtime would actually select.
	const result = selectProviderAwareAgentDefaults(agentDefaults, availableModels, providerId);
	const thinking = result.thinking;

	// For provider-qualified model names (e.g. "anthropic/claude-opus-5"), only report
	// the model if it was found in the real available list — a plausible-but-wrong value
	// is worse than "unknown". For bare model names (no slash, e.g. "claude-opus-4-5"),
	// fall back to the raw frontmatter value since they cannot be verified against the
	// registry; reporting them is still useful and matches historical behaviour.
	const model = result.model
		? formatProviderModelReference(result.model)
		: parseProviderModelReference(agentDefaults.model) === undefined
			? agentDefaults.model   // bare name: cannot verify, report as-is
			: undefined;            // provider-qualified but not in available list: report unknown

	return { thinking, model };
}

/**
 * Build the per-agent Tlh.Subagent.NAME.{thinking,model} telemetry payload for all eight
 * bundled minor agents.
 *
 * Precedence (highest first):
 *   1. The effective settings override for <name>, already resolved across project and user scope
 *      by resolveEffectiveSubagentOverrides (project outranks user).
 *   2. Provider-aware frontmatter in <agentDir>/tlh/agents/subagents/<name>.md, resolved via
 *      selectProviderAwareAgentDefaults for the active provider.
 *
 * When an agent override has disabled: true the agent will not run at all. In that case
 * both keys are reported as "disabled" — a value that does not collide with any THINKING_LEVELS
 * member and signals clearly that the agent is turned off.
 *
 * When an override key is explicitly set to false (model: false / thinking: false), the value
 * is reported as "cleared" — a sentinel that does not collide with any canonical thinking level
 * or public model ID pattern, and signals that the user explicitly cleared the bundled default.
 * Unlike undefined (no override), false must NOT silently fall back to the frontmatter default.
 *
 * Values are routed through privacy filters before being emitted. Agent names outside
 * BUNDLED_SUBAGENT_NAMES are never emitted as keys.
 */
function buildSubagentTelemetryPayload(
	effectiveOverrides: Record<string, SubagentOverrideEntry>,
	agentDir: string | undefined,
	providerId: string | undefined,
	availableModels: readonly ProviderModelReference[],
): Record<string, string> {
	const payload: Record<string, string> = {};
	for (const name of BUNDLED_SUBAGENT_NAMES) {
		const override = effectiveOverrides[name];

		// A disabled override means the agent won't run; report that clearly.
		if (override?.disabled === true) {
			payload[`Tlh.Subagent.${name}.thinking`] = "disabled";
			payload[`Tlh.Subagent.${name}.model`] = "disabled";
			continue;
		}

		// Read frontmatter only when at least one key is not covered by an override.
		// false overrides count as resolved (they clear the value explicitly), so we skip
		// frontmatter only when BOTH keys are set (to string or false).
		const needFrontmatter = agentDir !== undefined
			&& (override?.thinking === undefined || override?.model === undefined);
		const fm = needFrontmatter ? readSubagentFrontmatterConfig(agentDir, name, providerId, availableModels) : undefined;

		// "cleared" is the telemetry sentinel for an explicit false override.
		// It does not collide with any THINKING_LEVELS member and is not a valid model ID
		// pattern, making it unambiguous as a telemetry value. It is emitted directly
		// (not routed through the privacy filter) because false is a boolean, not a
		// user-authored string, and "cleared" is a controlled sentinel we define.
		payload[`Tlh.Subagent.${name}.thinking`] = override?.thinking === false
			? "cleared"
			: privacySafeTlhTelemetryThinkingLevel(override?.thinking ?? fm?.thinking);
		payload[`Tlh.Subagent.${name}.model`] = override?.model === false
			? "cleared"
			: privacySafeTlhTelemetryModelId(override?.model ?? fm?.model);
	}
	return payload;
}

export async function sendTlhLaunchTelemetry(snapshot: TlhTelemetrySnapshot): Promise<void> {
	const launchSettings = readTlhLaunchSettings();
	if (shouldSkipTlhLaunchTelemetry(launchSettings)) {
		return;
	}
	const stateDir = tlhStateDir();
	const agentDir = stateDir ? dirname(stateDir) : undefined;
	// Project settings read happens here, inside the deferred send — never on the startup path.
	// Absent project settings are the normal case and degrade quietly to user scope.
	const effectiveSubagentOverrides = resolveEffectiveSubagentOverrides(
		launchSettings.ok ? launchSettings.config.subagentOverrides : undefined,
		readTlhProjectSubagentOverrides(snapshot.cwd ?? process.cwd()),
	);
	const osMetadata = await getTlhOsMetadata();
	await sendTlhTelemetry(
		[
			{
				type: TLH_LAUNCH_TELEMETRY_EVENT_TYPE,
				payload: {
					"Tlh.App.version": snapshot.version,
					"Tlh.Runtime.provider": privacySafeTlhTelemetryProviderId(snapshot.providerId),
					"Tlh.Runtime.model": privacySafeTlhTelemetryModelId(snapshot.modelId),
					"Tlh.Runtime.thinking": privacySafeTlhTelemetryThinkingLevel(snapshot.thinkingLevel),
					"Tlh.PrimaryAgent.name": privacySafeTlhTelemetryPrimaryAgentName(snapshot.primaryAgentName),
					"Tlh.Device.osName": osMetadata.osName,
					"Tlh.Device.osVersion": osMetadata.osVersion,
					"Tlh.Device.osArch": osMetadata.osArch,
					...buildExperimentalFeatureTelemetryPayload(launchSettings.ok ? launchSettings.config.experimental : undefined),
					...buildSubagentTelemetryPayload(effectiveSubagentOverrides, agentDir, snapshot.providerId, snapshot.availableModels ?? []),
				},
			},
		],
		snapshot.version,
		launchSettings,
	);
}

export function scheduleTlhLaunchTelemetry(ctx: ExtensionContext, primaryAgentName?: string): void {
	if (sentTlhLaunchTelemetry) {
		return;
	}
	sentTlhLaunchTelemetry = true;
	// ctx.thinkingLevel is a live getter delegating to runtime.getThinkingLevel() — read it now,
	// after applySessionStart has applied the primary agent's thinking level. Storing it in the
	// snapshot freezes the value at schedule time rather than at send time.
	//
	// ctx.modelRegistry.getAvailable() is an in-memory synchronous call (no file I/O);
	// capturing it here ensures subagent model resolution uses the same registry the runtime
	// uses (see primary-agent-runtime.ts:868 applyProviderAwareSubagentModels) without
	// reading ctx inside the deferred timer where ctx state could have moved.
	const telemetrySnapshot: TlhTelemetrySnapshot = {
		version: getTlhVersion(),
		providerId: ctx.model?.provider,
		modelId: ctx.model?.id,
		primaryAgentName,
		thinkingLevel: ctx.thinkingLevel,
		availableModels: getUnfilteredAvailableModels(ctx.modelRegistry),
		// In-memory property read (no I/O). The project settings.json lookup it enables happens
		// later, inside the deferred send.
		cwd: ctx.cwd,
	};
	const timer = setTimeout(() => {
		void sendTlhLaunchTelemetry(telemetrySnapshot).catch(() => undefined);
	}, 0) as ReturnType<typeof setTimeout> & { unref?: () => void };
	timer.unref?.();
}

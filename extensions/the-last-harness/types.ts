import type { ProviderModelReference } from "./model-defaults.js";

export type StartupResources = {
	context: string[];
	skills: string[];
	prompts: string[];
	extensions: string[];
	themes: string[];
};

export type StartupPromptResourceMetadata = {
	contextFiles: Array<{ path: string; content: string }>;
	skills: Array<{ name: string; description: string; filePath: string }>;
};

export type StartupResourceSnapshot = {
	resources: StartupResources;
	promptMetadata: StartupPromptResourceMetadata;
};

export type TlhLaunchContextTokenAllocation = {
	tlh: number;
	agentsClaude: number;
	skills: number;
	tools: number;
	other: number;
};

export type TlhLaunchContextAllocation = {
	contextWindow: number;
	estimatedTokens: TlhLaunchContextTokenAllocation;
};

export type TlhUsageLimitsConfig = {
	showWeekly?: boolean;
};

export type TlhUsageWeeklyAction = "on" | "off" | "toggle";

export type TlhAttributionConfig = {
	commit?: boolean;
};

export type TlhCommitAttributionState = {
	enabled: boolean;
	footer?: string;
};

export type TlhSubscriptionUsageProvider = "openai-codex" | "anthropic";

export type TlhSubscriptionUsageWindow = {
	key: string;
	label: string;
	used?: number;
	limit?: number;
	remaining?: number;
	percent?: number;
	resetsAt?: string;
	durationMs?: number;
};

export type TlhSubscriptionUsageSnapshot = {
	provider: TlhSubscriptionUsageProvider;
	fetchedAt: number;
	windows: {
		session: TlhSubscriptionUsageWindow;
		weekly?: TlhSubscriptionUsageWindow;
	};
};

export type TlhSubscriptionUsageSnapshotProvider = {
	getSnapshot(provider?: string): TlhSubscriptionUsageSnapshot | undefined;
	getSnapshotForContext?(ctx: unknown): TlhSubscriptionUsageSnapshot | undefined;
	isEligible?(target?: unknown): boolean;
};

export type TlhUsageRefreshOptions = {
	force?: boolean;
};

export type TlhUsageLimitsWriteResult = {
	settingsPath: string;
	backupPath?: string;
	changed: boolean;
};

export type TlhAttributionWriteResult = {
	settingsPath: string;
	backupPath?: string;
	changed: boolean;
	state: TlhCommitAttributionState;
};

export type TlhUpdateCheckConfig = {
	enabled?: boolean;
};

export type TlhTelemetryConfig = {
	enabled?: boolean;
};

export type TlhTicketsConfig = {
	enabled?: boolean;
	installPath?: string;
	installedSha256?: string;
};

export type TlhPrimaryAgentConfig = {
	enabled?: boolean;
	selected?: string;
	applyModel?: boolean;
	applyThinking?: boolean;
	modelOverrides?: Record<string, string>;
};

export type TlhExperimentalFeatureId = string;

export type TlhExperimentalConfig = {
	enabledFeatures?: string[];
};

export type TlhPrimaryAgentSelection = "architect" | "rush" | "product" | "bug-hunter" | "disabled";

export type TlhPrimaryAgentSessionState = {
	enabled?: boolean;
	selected?: TlhPrimaryAgentSelection;
};

export type TlhPrimaryAgentWriteResult = {
	settingsPath: string;
	backupPath?: string;
	changed: boolean;
};

export type TlhContextCapConfig = {
	disabled?: boolean;
};

export type TlhModelVisibilityConfig = {
	disabled?: boolean;
	hidden?: string[];
	visible?: string[];
	unhide?: string[];
};

export type TlhSubagentOverride = {
	model?: string | false;
	thinking?: string | false;
};

export type TlhSubagentsConfig = {
	agentOverrides?: Record<string, TlhSubagentOverride>;
};

export type TlhSettings = {
	subagents?: TlhSubagentsConfig;
	tlh?: {
		usageLimits?: TlhUsageLimitsConfig;
		attribution?: TlhAttributionConfig;
		updateCheck?: TlhUpdateCheckConfig;
		telemetry?: TlhTelemetryConfig;
		tickets?: TlhTicketsConfig;
		primaryAgent?: TlhPrimaryAgentConfig;
		experimental?: TlhExperimentalConfig;
		contextCap?: TlhContextCapConfig;
		modelVisibility?: TlhModelVisibilityConfig;
	};
};

export type TlhStartupState = {
	lastSeenVersion?: string;
	updateCheck?: {
		checkedAt?: string;
		latestVersion?: string;
		latestTagName?: string;
		latestReleaseUrl?: string;
		lastNotifiedVersion?: string;
	};
};

export type TlhInstallState = {
	schemaVersion?: number;
	repo?: string;
	ref?: string;
	track?: string;
	packageSource?: string;
	packageSourceIsDefault?: boolean;
	rawBase?: string;
	agentDir?: string;
	binDir?: string;
	wrapperName?: string;
	installedAt?: string;
};

export type TlhInstallNoticeKind =
	| "pinned-tag"
	| "ref"
	| "custom-track"
	| "custom-package-source"
	| "non-default-repo"
	| "unknown";

export type TlhInstallNotice = {
	kind: TlhInstallNoticeKind;
	summary: string;
	detail?: string;
};

export type TlhTelemetryState = {
	schemaVersion?: number;
	installId?: string;
};

export type TlhTelemetrySnapshot = {
	version: string;
	providerId?: string;
	modelId?: string;
	primaryAgentName?: string;
	/** Primary-agent thinking level, captured from ctx.thinkingLevel at schedule time (after applySessionStart). */
	thinkingLevel?: string;
	/**
	 * Available models captured from ctx.modelRegistry at schedule time via getUnfilteredAvailableModels.
	 * Used to resolve the effective model for each bundled subagent against the real registry.
	 * When absent or empty the subagent model fields are resolved as-is (bare model names only).
	 */
	availableModels?: readonly ProviderModelReference[];
	/**
	 * Working directory captured from ctx.cwd at schedule time (an in-memory read, no I/O).
	 * Used inside the deferred send to locate the nearest project settings.json so reported
	 * subagent overrides honour the runtime's project-over-user precedence. Falls back to
	 * process.cwd() when absent.
	 */
	cwd?: string;
};

export type TlhTelemetryEnvelope = {
	type: string;
	payload: Record<string, string>;
};

export type TlhOsMetadata = {
	osName: string;
	osVersion: string;
	osArch: string;
};

export type TlhHeaderUpdate = {
	version: string;
	releasesUrl: string;
};

export type TlhLatestRelease = {
	version: string;
	tagName: string;
	releaseUrl: string;
};

export type AgentPrompt = {
	name: string;
	description: string;
	model?: string;
	tlhOpenaiModels?: string[];
	tlhAnthropicModels?: string[];
	thinking?: ThinkingLevel;
	tlhOpenaiThinking?: ThinkingLevel;
	tlhAnthropicThinking?: ThinkingLevel;
	preferCurrentOpenaiModel?: boolean;
	preferOppositeProvider?: boolean;
	applyModel?: boolean;
	applyThinking?: boolean;
	lockThinking?: boolean;
	minThinking?: ThinkingLevel;
	tools: string[];
	systemPrompt: string;
	filePath: string;
};

export type SubagentMetadata = {
	name: string;
	description: string;
	model?: string;
	tlhOpenaiModels?: string[];
	tlhAnthropicModels?: string[];
	thinking?: ThinkingLevel;
	tlhOpenaiThinking?: ThinkingLevel;
	tlhAnthropicThinking?: ThinkingLevel;
	preferOppositeProvider?: boolean;
};

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ReasoningModel = {
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
};

export type SettingsStorageLike = {
	withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined): void;
};

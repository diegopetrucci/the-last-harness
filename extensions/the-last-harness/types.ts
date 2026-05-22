export type StartupResources = {
	context: string[];
	skills: string[];
	prompts: string[];
	extensions: string[];
	themes: string[];
};

export type TlhUsageLimitsConfig = {
	showWeekly?: boolean;
};

export type TlhUsageWeeklyAction = "on" | "off" | "toggle";

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
};

export type TlhPrimaryAgentSelection = "architect" | "product" | "bug-hunter" | "disabled";

export type TlhPrimaryAgentSessionState = {
	enabled?: boolean;
	selected?: TlhPrimaryAgentSelection;
};

export type TlhPrimaryAgentWriteResult = {
	settingsPath: string;
	backupPath?: string;
	changed: boolean;
};

export type TlhSettings = {
	tlh?: {
		usageLimits?: TlhUsageLimitsConfig;
		updateCheck?: TlhUpdateCheckConfig;
		telemetry?: TlhTelemetryConfig;
		tickets?: TlhTicketsConfig;
		primaryAgent?: TlhPrimaryAgentConfig;
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
	modelId?: string;
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
	thinking?: ThinkingLevel;
	tools: string[];
	systemPrompt: string;
	filePath: string;
};

export type SubagentMetadata = {
	name: string;
	description: string;
	model?: string;
	tlhOpenaiModels?: string[];
};

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ReasoningModel = {
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
};

export type SettingsStorageLike = {
	withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined): void;
};

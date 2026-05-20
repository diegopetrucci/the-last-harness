export type StartupResources = {
	context: string[];
	skills: string[];
	prompts: string[];
	extensions: string[];
	themes: string[];
};

export type TlhGnosisConfig = {
	enabled?: boolean;
	installPath?: string;
};

export type TlhGnosisState = "enabled" | "disabled" | "unset";

export type TlhGnosisSlashAction = "toggle" | "status" | "enable" | "disable";

export type TlhUpdateCheckConfig = {
	enabled?: boolean;
};

export type TlhTelemetryConfig = {
	enabled?: boolean;
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
		gnosis?: TlhGnosisConfig;
		updateCheck?: TlhUpdateCheckConfig;
		telemetry?: TlhTelemetryConfig;
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
	track?: string;
	ref?: string;
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
	thinking?: ThinkingLevel;
	tools: string[];
	systemPrompt: string;
	filePath: string;
};

export type SubagentMetadata = {
	name: string;
	description: string;
};

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ReasoningModel = {
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
};

export type SettingsStorageLike = {
	withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined): void;
};

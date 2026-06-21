import { SettingsManager, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	DEFAULT_PRIMARY_AGENT,
	DISABLED_PRIMARY_AGENT,
	PRIMARY_AGENT_CYCLE,
	PRIMARY_AGENT_SESSION_STATE_ENTRY,
	isEnabledPrimaryAgentSelection,
	nextPrimaryAgentSelection,
	primaryAgentDefaultLabel,
	primaryAgentSelectionFromBranch,
	resolvePrimaryAgentConfig,
} from "../the-last-harness-primary-agent.mjs";
import { createPrimaryToolState, filterAvailableTools } from "../the-last-harness-primary-tools.mjs";
import { registerTlhStartupMode, validateSubagentToolInput } from "../the-last-harness-subagent-safety.mjs";
import {
	buildTlhCommitAttributionPrompt,
	getTlhGitCommitAttributionBlockReason,
	resolveTlhCommitAttribution,
} from "./attribution.js";
import { formatHomePath, isRecord } from "./common.js";
import { GNOSIS_PROMPT, PRIMARY_AGENT_CYCLE_SHORTCUT, TLH_NAME, TLH_PACKAGE_NAME } from "./constants.js";
import { buildChildExperimentalPrompt, buildPrimaryExperimentalPrompt } from "./experimental.js";
import { shouldAppendGnosisPrompt } from "./gnosis.js";
import { applyProviderAwareSubagentModels, selectProviderAwareAgentDefaults } from "./model-defaults.js";
import { getUnfilteredAvailableModels } from "./model-visibility.js";
import { isThinkingLevel, thinkingLevelAtLeast } from "./thinking.js";
import {
	buildChildSubagentSystemPrompt,
	buildTlhSystemPrompt,
	loadPrimaryAgents,
	loadSubagentMetadata,
} from "./prompts.js";
import { activateTlhTicketRuntime } from "./tickets.js";
import { tlhSettingsPathForWrite, withLockedTlhSettingsWrite } from "./profile-state.js";
import type {
	AgentPrompt,
	SubagentMetadata,
	TlhPrimaryAgentConfig,
	TlhPrimaryAgentSelection,
	TlhPrimaryAgentSessionState,
	TlhPrimaryAgentWriteResult,
	TlhSettings,
} from "./types.js";

type TlhPrimaryAgentRuntimeOptions = {
	env?: Record<string, string | undefined>;
	primaryAgents?: Map<TlhPrimaryAgentSelection, AgentPrompt>;
	subagentMetadata?: SubagentMetadata[];
};

type ActiveModel = NonNullable<ExtensionContext["model"]>;

export type TlhPrimaryAgentRuntime = {
	applySessionStart(ctx: ExtensionContext): Promise<void>;
	currentPrimaryAgentLabel(): string;
	activePrimaryAgentPrompt(): AgentPrompt | undefined;
};

function getTlhGlobalSettings(cwd: string): TlhSettings {
	try {
		const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as unknown;
		return isRecord(settings) ? (settings as TlhSettings) : {};
	} catch {
		return {};
	}
}

function getTlhPrimaryAgentConfig(cwd: string): TlhPrimaryAgentConfig | undefined {
	return getTlhGlobalSettings(cwd).tlh?.primaryAgent;
}

function resolvePrimaryAutoApplySetting(
	primaryConfig: TlhPrimaryAgentConfig | undefined,
	primary: AgentPrompt,
	key: "applyModel" | "applyThinking",
): boolean {
	const configured = primaryConfig?.[key];
	if (typeof configured === "boolean") {
		return configured;
	}
	return primary[key] === true;
}

function shouldForceApplyForLock(primary: AgentPrompt): boolean {
	return primary.lockThinking === true;
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

function writeTlhPrimaryAgentModelOverride(
	cwd: string,
	primary: TlhPrimaryAgentSelection,
	modelKey: string | undefined,
): TlhPrimaryAgentWriteResult {
	return withLockedTlhSettingsWrite(cwd, "Refusing to write model-override settings outside the isolated TLH profile.", (current) => {
		const settings = parseTlhSettingsContent(current);
		const rawTlh = settings.tlh;
		let tlh: Record<string, unknown>;
		if (rawTlh === undefined) {
			tlh = {};
			settings.tlh = tlh;
		} else if (isRecord(rawTlh)) {
			tlh = rawTlh;
		} else {
			throw new Error("settings.tlh must be an object to update model-override settings.");
		}

		const rawPrimaryAgent = tlh.primaryAgent;
		let primaryAgent: Record<string, unknown>;
		if (rawPrimaryAgent === undefined) {
			primaryAgent = {};
			tlh.primaryAgent = primaryAgent;
		} else if (isRecord(rawPrimaryAgent)) {
			primaryAgent = rawPrimaryAgent;
		} else {
			throw new Error("settings.tlh.primaryAgent must be an object to update model-override settings.");
		}

		const rawModelOverrides = primaryAgent.modelOverrides;
		let modelOverrides: Record<string, unknown>;
		if (rawModelOverrides === undefined) {
			modelOverrides = {};
			primaryAgent.modelOverrides = modelOverrides;
		} else if (isRecord(rawModelOverrides)) {
			modelOverrides = rawModelOverrides;
		} else {
			throw new Error("settings.tlh.primaryAgent.modelOverrides must be an object.");
		}

		const existingOverride = modelOverrides[primary];
		if (modelKey === undefined) {
			if (!Object.prototype.hasOwnProperty.call(modelOverrides, primary)) {
				return { changed: false };
			}
			delete modelOverrides[primary];
		} else {
			if (existingOverride === modelKey) {
				return { changed: false };
			}
			modelOverrides[primary] = modelKey;
		}

		// Clean up empty modelOverrides object
		if (Object.keys(modelOverrides).length === 0) {
			delete primaryAgent.modelOverrides;
		}

		return {
			changed: true,
			nextContent: `${JSON.stringify(settings, null, 2)}\n`,
		};
	});
}

function writeTlhPrimaryAgentDefault(cwd: string, selection: TlhPrimaryAgentSelection | undefined): TlhPrimaryAgentWriteResult {
	return withLockedTlhSettingsWrite(cwd, "Refusing to write primary-agent settings outside the isolated TLH profile.", (current) => {
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
			throw new Error("settings.tlh.primaryAgent must be an object to update primary-agent defaults.");
		}

		let changed = false;
		const setField = (key: "enabled" | "selected", value: boolean | string | undefined) => {
			if (value === undefined) {
				if (Object.prototype.hasOwnProperty.call(primaryAgent, key)) {
					delete primaryAgent[key];
					changed = true;
				}
				return;
			}
			if (primaryAgent[key] !== value) {
				primaryAgent[key] = value;
				changed = true;
			}
		};

		if (selection === undefined) {
			setField("enabled", undefined);
			setField("selected", undefined);
		} else if (selection === DISABLED_PRIMARY_AGENT) {
			setField("enabled", false);
			setField("selected", DISABLED_PRIMARY_AGENT);
		} else {
			setField("enabled", true);
			setField("selected", selection);
		}

		if (!changed) {
			return { changed: false };
		}

		return {
			changed: true,
			nextContent: `${JSON.stringify(settings, null, 2)}\n`,
		};
	});
}

function primaryToolAllowlist(primary: AgentPrompt | undefined): string[] {
	return primary?.tools.length
		? primary.tools
		: ["read", "grep", "find", "ls", "bash", "subagent", "intercom"];
}

function primaryAgentLabel(selection: TlhPrimaryAgentSelection): string {
	return selection;
}

function primaryAgentOverrideLabel(selection: TlhPrimaryAgentSelection | undefined): string {
	return selection ?? "none";
}

function matchesSubagentName(value: unknown, target: string): boolean {
	return typeof value === "string" && value.trim().toLowerCase() === target;
}

function isSubagentResumeAction(input: unknown): boolean {
	return isRecord(input) && matchesSubagentName(input.action, "resume");
}

function subagentCallTargetsAgent(input: unknown, target: string): boolean {
	if (!isRecord(input)) {
		return false;
	}
	if (matchesSubagentName(input.agent, target)) {
		return true;
	}
	if (Array.isArray(input.tasks) && input.tasks.some((task) => subagentCallTargetsAgent(task, target))) {
		return true;
	}
	if (!Array.isArray(input.chain)) {
		return false;
	}
	for (const step of input.chain) {
		if (!isRecord(step)) {
			continue;
		}
		if (matchesSubagentName(step.agent, target)) {
			return true;
		}
		if (Array.isArray(step.parallel) && step.parallel.some((task) => subagentCallTargetsAgent(task, target))) {
			return true;
		}
	}
	return false;
}

function rushResumeDelegationReason(): string {
	return "TLH Rush may not use subagent action=resume because resuming by run id or index can continue a prior developer subagent without an explicit safe target. Rush must edit directly or start a new allowed subagent with an explicit agent target.";
}

function rushDeveloperDelegationReason(): string {
	return "TLH Rush may not delegate implementation to developer. Rush must edit directly; use code-reviewer, repo-scout, diff-summarizer, librarian, or oracle only when Rush prompt rules allow it.";
}

function registerChildSubagentRuntime(
	pi: ExtensionAPI,
	buildChildPrompt: () => string,
	env: Record<string, string | undefined>,
): void {
	pi.on("before_agent_start", async (event, ctx) => {
		const settings = getTlhGlobalSettings(ctx.cwd);
		const commitAttributionState = resolveTlhCommitAttribution(settings.tlh?.attribution);
		const childAgentName = env.PI_SUBAGENT_CHILD_AGENT;
		return {
			systemPrompt: [
				event.systemPrompt,
				buildChildPrompt(),
				buildChildExperimentalPrompt(childAgentName, settings.tlh?.experimental),
				buildTlhCommitAttributionPrompt(commitAttributionState),
			]
				.filter(Boolean)
				.join("\n\n"),
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") {
			return undefined;
		}
		// `toolName` narrows the branch, but not the shared mutable `input` payload.
		// Keep a runtime guard so direct/custom tool-call objects cannot pass a non-string command.
		if (typeof event.input.command !== "string") {
			return undefined;
		}
		const commitAttributionState = resolveTlhCommitAttribution(getTlhGlobalSettings(ctx.cwd).tlh?.attribution);
		const reason = getTlhGitCommitAttributionBlockReason(event.input.command, commitAttributionState);
		return reason ? { block: true, reason } : undefined;
	});
}

function createTlhPrimaryAgentRuntime(
	pi: ExtensionAPI,
	primaryAgents: Map<TlhPrimaryAgentSelection, AgentPrompt>,
	subagentMetadata: SubagentMetadata[],
): TlhPrimaryAgentRuntime & { registerCommands(): void; registerLifecycleHooks(): void } {
	const warned = new Set<string>();
	const primaryToolState = createPrimaryToolState();
	const subagentsByName = new Map(subagentMetadata.map((agent) => [agent.name, agent]));
	let primaryAgentDefaultSelection: TlhPrimaryAgentSelection = DEFAULT_PRIMARY_AGENT;
	let sessionPrimaryAgentOverride: TlhPrimaryAgentSelection | undefined;

	function warnOnce(ctx: ExtensionContext, key: string, message: string): void {
		if (warned.has(key)) {
			return;
		}
		warned.add(key);
		ctx.ui.notify(message, "warning");
	}

	function warnInvalidPrimarySelection(ctx: ExtensionContext, source: string, value: string): void {
		warnOnce(
			ctx,
			`invalid-primary-agent-${source}-${value}`,
			`TLH primary agent "${value}" is not valid; falling back to ${DEFAULT_PRIMARY_AGENT}. Available: ${PRIMARY_AGENT_CYCLE.join(", ")}.`,
		);
	}

	function ensureLoadedPrimarySelection(ctx: ExtensionContext, selection: TlhPrimaryAgentSelection, source: string): TlhPrimaryAgentSelection {
		if (selection === DISABLED_PRIMARY_AGENT || primaryAgents.has(selection)) {
			return selection;
		}
		warnOnce(
			ctx,
			`missing-primary-agent-${source}-${selection}`,
			`TLH primary agent "${selection}" is not available; falling back to ${DEFAULT_PRIMARY_AGENT}.`,
		);
		return primaryAgents.has(DEFAULT_PRIMARY_AGENT) ? DEFAULT_PRIMARY_AGENT : DISABLED_PRIMARY_AGENT;
	}

	function syncPrimaryAgentState(ctx: ExtensionContext): void {
		const primaryConfig = getTlhPrimaryAgentConfig(ctx.cwd);
		const defaultResolution = resolvePrimaryAgentConfig(primaryConfig) as { selection: TlhPrimaryAgentSelection; invalidSelected?: string };
		if (defaultResolution.invalidSelected) {
			warnInvalidPrimarySelection(ctx, "default", defaultResolution.invalidSelected);
		}
		primaryAgentDefaultSelection = ensureLoadedPrimarySelection(ctx, defaultResolution.selection, "default");

		const sessionResolution = primaryAgentSelectionFromBranch(ctx.sessionManager.getBranch()) as {
			selection?: TlhPrimaryAgentSelection;
			invalidSelected?: string;
		};
		if (sessionResolution.invalidSelected) {
			warnInvalidPrimarySelection(ctx, "session", sessionResolution.invalidSelected);
		}
		sessionPrimaryAgentOverride = sessionResolution.selection
			? ensureLoadedPrimarySelection(ctx, sessionResolution.selection, "session")
			: undefined;
	}

	function currentPrimaryAgentSelection(): TlhPrimaryAgentSelection {
		return sessionPrimaryAgentOverride ?? primaryAgentDefaultSelection;
	}

	function activePrimaryAgent(): AgentPrompt | undefined {
		const selection = currentPrimaryAgentSelection();
		return selection === DISABLED_PRIMARY_AGENT ? undefined : primaryAgents.get(selection);
	}

	function currentPrimaryAgentLabel(): string {
		return primaryAgentLabel(currentPrimaryAgentSelection());
	}

	function primaryAgentStatusMessage(ctx: ExtensionContext): string {
		syncPrimaryAgentState(ctx);
		const primaryConfig = getTlhPrimaryAgentConfig(ctx.cwd);
		const override = sessionPrimaryAgentOverride;
		const effective = currentPrimaryAgentSelection();
		const settingsPath = tlhSettingsPathForWrite();
		const settingsLabel = settingsPath ? formatHomePath(settingsPath) : "unavailable outside isolated TLH profile";
		const activePrimary = effective !== DISABLED_PRIMARY_AGENT ? primaryAgents.get(effective) : undefined;
		const rawModelOverrides = primaryConfig?.modelOverrides as unknown;
		const modelOverride =
			activePrimary && !shouldForceApplyForLock(activePrimary) && isRecord(rawModelOverrides) && typeof rawModelOverrides[effective] === "string"
				? rawModelOverrides[effective]
				: "none";
		return [
			`${TLH_PACKAGE_NAME} (${TLH_NAME}) is active.`,
			`Primary agent: ${primaryAgentLabel(effective)}.`,
			`Session override: ${primaryAgentOverrideLabel(override)}.`,
			`Persistent default: ${primaryAgentDefaultLabel(primaryConfig)}.`,
			`Model override: ${modelOverride}.`,
			`Settings: ${settingsLabel}.`,
		].join("\n");
	}

	function setSessionPrimaryAgentOverride(selection: TlhPrimaryAgentSelection | undefined): void {
		sessionPrimaryAgentOverride = selection;
		if (selection === undefined) {
			pi.appendEntry<TlhPrimaryAgentSessionState>(PRIMARY_AGENT_SESSION_STATE_ENTRY, {});
			return;
		}
		pi.appendEntry<TlhPrimaryAgentSessionState>(PRIMARY_AGENT_SESSION_STATE_ENTRY, {
			enabled: selection !== DISABLED_PRIMARY_AGENT,
			selected: selection,
		});
	}

	function getValidPrimaryTools(ctx: ExtensionContext, primary: AgentPrompt): string[] {
		const desiredTools = primaryToolAllowlist(primary);
		const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
		const validTools = filterAvailableTools(desiredTools, allToolNames);
		const missingTools = desiredTools.filter((tool) => !allToolNames.has(tool));
		if (missingTools.length > 0) {
			warnOnce(ctx, `missing-primary-tools-${primary.name}`, `TLH primary agent tools are not available yet: ${missingTools.join(", ")}`);
		}
		return validTools;
	}

	function applyPrimaryTools(ctx: ExtensionContext, primary: AgentPrompt): void {
		const validTools = getValidPrimaryTools(ctx, primary);
		if (validTools.length === 0) {
			return;
		}
		pi.setActiveTools(primaryToolState.apply(validTools, pi.getActiveTools()));
	}

	function restorePrimaryToolsIfAppropriate(): void {
		if (!primaryToolState.hasPrePrimaryTools()) {
			return;
		}
		const restoredTools = primaryToolState.restoreIfAppropriate(
			pi.getActiveTools(),
			() => new Set(pi.getAllTools().map((tool) => tool.name)),
		);
		if (restoredTools) {
			pi.setActiveTools(restoredTools);
		}
	}

	let tlhApplyingModel = false;

	async function applyPrimaryModel(
		ctx: ExtensionContext,
		primary: AgentPrompt,
		model: ActiveModel | undefined,
	): Promise<ActiveModel | undefined> {
		if (!model) {
			const candidates = [primary.model, ...(primary.tlhOpenaiModels ?? [])].filter(Boolean).join(", ");
			warnOnce(ctx, `missing-primary-model-${primary.name}`, `TLH primary agent models are not available for configured providers: ${candidates}`);
			return undefined;
		}
		if (ctx.model?.provider === model.provider && ctx.model?.id === model.id) {
			return model;
		}
		tlhApplyingModel = true;
		let success: boolean;
		try {
			success = await pi.setModel(model);
		} finally {
			tlhApplyingModel = false;
		}
		if (!success) {
			warnOnce(ctx, `primary-model-unavailable-${primary.name}`, `TLH could not switch to primary agent model: ${model.provider}/${model.id}`);
			return undefined;
		}
		return model;
	}

	function currentThinkingSatisfiesPrimaryFloor(primary: AgentPrompt, currentThinking: string): boolean {
		return primary.lockThinking !== true
			&& primary.minThinking !== undefined
			&& isThinkingLevel(currentThinking)
			&& thinkingLevelAtLeast(currentThinking, primary.minThinking);
	}

	function applyPrimaryThinking(primary: AgentPrompt, thinking: AgentPrompt["thinking"]): void {
		if (!thinking) {
			return;
		}
		const currentThinking = pi.getThinkingLevel();
		if (currentThinking === thinking || currentThinkingSatisfiesPrimaryFloor(primary, currentThinking)) {
			return;
		}
		pi.setThinkingLevel(thinking);
	}

	async function applyPrimaryDefaults(ctx: ExtensionContext): Promise<void> {
		const selection = currentPrimaryAgentSelection();
		if (!isEnabledPrimaryAgentSelection(selection)) {
			restorePrimaryToolsIfAppropriate();
			return;
		}

		const primary = activePrimaryAgent();
		if (!primary) {
			restorePrimaryToolsIfAppropriate();
			return;
		}

		applyPrimaryTools(ctx, primary);

		const primaryConfig = getTlhPrimaryAgentConfig(ctx.cwd);
		const forceApply = shouldForceApplyForLock(primary);
		const shouldApplyModel = forceApply || resolvePrimaryAutoApplySetting(primaryConfig, primary, "applyModel");
		const shouldApplyThinking = forceApply || resolvePrimaryAutoApplySetting(primaryConfig, primary, "applyThinking");
		const availableModels = getUnfilteredAvailableModels(ctx.modelRegistry);
		const primaryDefaults = selectProviderAwareAgentDefaults(primary, availableModels, ctx.model?.provider);
		const currentProviderDefaults = selectProviderAwareAgentDefaults(primary, [], ctx.model?.provider);

		// Resolve model: stored override (if still available in registry) takes precedence over frontmatter default
		let resolvedModel = primaryDefaults.model;
		if (!forceApply) {
			const storedOverride = primaryConfig?.modelOverrides?.[selection];
			if (storedOverride) {
				const overrideRef = availableModels.find(
					(m) => `${m.provider}/${m.id}` === storedOverride,
				);
				if (overrideRef) {
					resolvedModel = overrideRef;
				}
				// If override is unavailable, fall through to primaryDefaults.model (no error)
			}
		}

		const activePrimaryModel = shouldApplyModel ? await applyPrimaryModel(ctx, primary, resolvedModel) : undefined;
		if (shouldApplyThinking) {
			applyPrimaryThinking(primary, activePrimaryModel ? primaryDefaults.thinking : currentProviderDefaults.thinking);
		}
	}

	async function applyPrimaryModeChange(ctx: ExtensionContext): Promise<void> {
		await applyPrimaryDefaults(ctx);
	}

	function cleanDisabledPrimarySessionHint(selection: TlhPrimaryAgentSelection): string {
		return selection === DISABLED_PRIMARY_AGENT
			? " Existing conversation history may still contain TLH primary-agent guidance; start a new session for a completely clean context."
			: "";
	}

	async function cycleSessionPrimaryAgent(ctx: ExtensionContext): Promise<void> {
		syncPrimaryAgentState(ctx);
		const nextOverride = nextPrimaryAgentSelection(currentPrimaryAgentSelection()) as TlhPrimaryAgentSelection;
		setSessionPrimaryAgentOverride(nextOverride);
		await applyPrimaryModeChange(ctx);
		ctx.ui.notify(
			`Shift+Tab switched TLH primary agent to ${primaryAgentLabel(nextOverride)} for this session.${cleanDisabledPrimarySessionHint(nextOverride)}`,
			"info",
		);
	}

	function parsePrimaryAgentSelection(value: string | undefined): TlhPrimaryAgentSelection | undefined {
		const normalized = value?.trim().toLowerCase();
		return normalized !== undefined && PRIMARY_AGENT_CYCLE.includes(normalized) ? (normalized as TlhPrimaryAgentSelection) : undefined;
	}

	function switchPrimaryAgentCommandCompletions(prefix: string) {
		const options = [
			{ value: "status", description: "Show TLH primary-agent status" },
			{ value: "architect", description: "Use the architect primary agent for this session" },
			{ value: "rush", description: "Use the Rush primary agent for this session" },
			{ value: "product", description: "Use the product primary agent for this session" },
			{ value: "bug-hunter", description: "Use the bug-hunter primary agent for this session" },
			{ value: "disabled", description: "Disable TLH primary agents for this session" },
			{ value: "reset", description: "Clear the session primary-agent override" },
			{ value: "model reset", description: "Clear the active primary's persisted model override" },
			{ value: "default architect", description: "Persistently select architect for future sessions" },
			{ value: "default rush", description: "Persistently select Rush for future sessions" },
			{ value: "default product", description: "Persistently select product for future sessions" },
			{ value: "default bug-hunter", description: "Persistently select bug-hunter for future sessions" },
			{ value: "default disabled", description: "Persistently disable TLH primaries for future sessions" },
			{ value: "default reset", description: "Remove the persistent primary-agent setting" },
		];
		const normalizedPrefix = prefix.trim().toLowerCase();
		const completions = options
			.filter((option) => option.value.startsWith(normalizedPrefix))
			.map((option) => ({ value: option.value, label: option.value, description: option.description }));
		return completions.length > 0 ? completions : null;
	}

	function registerCommands(): void {
		pi.registerCommand("switch-primary-agent", {
			description: "Show or switch the TLH primary agent",
			getArgumentCompletions: switchPrimaryAgentCommandCompletions,
			handler: async (args, ctx) => {
				syncPrimaryAgentState(ctx);
				const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
				const [command, value] = parts;

				if (!command || command === "status") {
					ctx.ui.notify(primaryAgentStatusMessage(ctx), "info");
					return;
				}

				if (command === "reset") {
					if (parts.length !== 1) {
						ctx.ui.notify("Usage: /switch-primary-agent reset", "error");
						return;
					}
					setSessionPrimaryAgentOverride(undefined);
					await applyPrimaryModeChange(ctx);
					ctx.ui.notify(`Cleared TLH primary-agent session override. Primary agent: ${currentPrimaryAgentLabel()}.`, "info");
					return;
				}

				if (command === "model") {
					if (parts.length !== 2 || value !== "reset") {
						ctx.ui.notify("Usage: /switch-primary-agent model reset", "error");
						return;
					}
					const selection = currentPrimaryAgentSelection();
					if (selection === DISABLED_PRIMARY_AGENT) {
						ctx.ui.notify(
							"Cannot clear model override: primary agents are disabled. Enable a primary agent first with /switch-primary-agent <agent>.",
							"error",
						);
						return;
					}
					const primary = activePrimaryAgent();
					const primaryConfig = getTlhPrimaryAgentConfig(ctx.cwd);
					const rawModelOverrides = primaryConfig?.modelOverrides as unknown;
					const hasStoredOverride = isRecord(rawModelOverrides) && Object.prototype.hasOwnProperty.call(rawModelOverrides, selection);
					if (primary && shouldForceApplyForLock(primary) && !hasStoredOverride) {
						ctx.ui.notify(
							`No model override to clear: ${primaryAgentLabel(selection)} uses fixed model defaults and does not persist overrides.`,
							"info",
						);
						return;
					}
					try {
						const result = writeTlhPrimaryAgentModelOverride(ctx.cwd, selection, undefined);
						await applyPrimaryModeChange(ctx);
						const backupLabel = result.backupPath ? ` Backup: ${formatHomePath(result.backupPath)}.` : "";
						const message = primary && shouldForceApplyForLock(primary)
							? `Cleared stale ignored model override for ${primaryAgentLabel(selection)}. Primary agent: ${currentPrimaryAgentLabel()} uses fixed model defaults.${backupLabel}`
							: `${result.changed ? "Cleared" : "No override to clear for"} model override for ${primaryAgentLabel(selection)}. Primary agent: ${currentPrimaryAgentLabel()}.${backupLabel}`;
						ctx.ui.notify(message, "info");
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(`Could not clear model override: ${message}`, "error");
					}
					return;
				}

				const selected = parsePrimaryAgentSelection(command);
				if (selected) {
					if (parts.length !== 1) {
						ctx.ui.notify("Usage: /switch-primary-agent architect|rush|product|bug-hunter|disabled", "error");
						return;
					}
					setSessionPrimaryAgentOverride(selected);
					await applyPrimaryModeChange(ctx);
					ctx.ui.notify(
						`TLH primary agent set to ${primaryAgentLabel(selected)} for this session.${cleanDisabledPrimarySessionHint(selected)}`,
						"info",
					);
					return;
				}

				if (command === "default") {
					if (parts.length !== 2) {
						ctx.ui.notify("Usage: /switch-primary-agent default architect|rush|product|bug-hunter|disabled|reset", "error");
						return;
					}
					const defaultSelection = value === "reset" ? undefined : parsePrimaryAgentSelection(value);
					if (value !== "reset" && !defaultSelection) {
						ctx.ui.notify("Usage: /switch-primary-agent default architect|rush|product|bug-hunter|disabled|reset", "error");
						return;
					}

					try {
						const result = writeTlhPrimaryAgentDefault(ctx.cwd, defaultSelection);
						syncPrimaryAgentState(ctx);
						await applyPrimaryModeChange(ctx);
						const changedLabel = result.changed ? "Updated" : "No change to";
						const backupLabel = result.backupPath ? ` Backup: ${formatHomePath(result.backupPath)}.` : "";
						ctx.ui.notify(
							`${changedLabel} TLH primary-agent persistent default at ${formatHomePath(result.settingsPath)}. Primary agent: ${currentPrimaryAgentLabel()}.${backupLabel}`,
							"info",
						);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(`Could not update TLH primary-agent persistent default: ${message}`, "error");
					}
					return;
				}

				ctx.ui.notify("Usage: /switch-primary-agent [status|architect|rush|product|bug-hunter|disabled|reset|model reset|default architect|default rush|default product|default bug-hunter|default disabled|default reset]", "error");
			},
		});

		pi.registerShortcut(PRIMARY_AGENT_CYCLE_SHORTCUT, {
			description: "Cycle TLH primary agent (architect/rush/product/bug-hunter/disabled)",
			handler: async (ctx) => {
				await cycleSessionPrimaryAgent(ctx);
			},
		});
	}

	async function applySessionStart(ctx: ExtensionContext): Promise<void> {
		syncPrimaryAgentState(ctx);
		await applyPrimaryDefaults(ctx);
	}

	function registerLifecycleHooks(): void {
		pi.on("model_select", async (event, ctx) => {
			// Ignore events emitted by TLH's own applyPrimaryModel to avoid a feedback loop.
			if (tlhApplyingModel) {
				return;
			}
			// Only handle user-initiated model selections (source "set" is emitted by /model and pi.setModel alike).
			if (event.source !== "set") {
				return;
			}
			syncPrimaryAgentState(ctx);
			const selection = currentPrimaryAgentSelection();
			if (!isEnabledPrimaryAgentSelection(selection)) {
				return;
			}
			const primary = activePrimaryAgent();
			if (!primary) {
				return;
			}
			// Locked primaries (e.g. rush) keep their fixed provider defaults and do not persist user model overrides.
			if (shouldForceApplyForLock(primary)) {
				return;
			}
			const chosenKey = `${event.model.provider}/${event.model.id}`;
			// Determine the primary's bundled default model to know whether to clear the override.
			const primaryDefaults = selectProviderAwareAgentDefaults(primary, getUnfilteredAvailableModels(ctx.modelRegistry), event.model.provider);
			const bundledKey = primaryDefaults.model ? `${primaryDefaults.model.provider}/${primaryDefaults.model.id}` : undefined;
			// If user picked the bundled default, clear the override; otherwise record it.
			const nextOverride = chosenKey === bundledKey ? undefined : chosenKey;
			try {
				writeTlhPrimaryAgentModelOverride(ctx.cwd, selection, nextOverride);
			} catch {
				// Best-effort: model override persistence is non-blocking.
			}
		});

		pi.on("session_tree", async (_event, ctx) => {
			syncPrimaryAgentState(ctx);
			await applyPrimaryDefaults(ctx);
		});

		pi.on("session_shutdown", async (_event, _ctx) => {
			restorePrimaryToolsIfAppropriate();
		});

		pi.on("before_agent_start", async (event, ctx) => {
			const settings = getTlhGlobalSettings(ctx.cwd);
			const commitAttributionState = resolveTlhCommitAttribution(settings.tlh?.attribution);
			syncPrimaryAgentState(ctx);
			const selection = currentPrimaryAgentSelection();
			const primaryEnabled = isEnabledPrimaryAgentSelection(selection);
			activateTlhTicketRuntime(settings, getAgentDir());
			await applyPrimaryDefaults(ctx);
			const prompts = [
				event.systemPrompt,
				buildTlhSystemPrompt(activePrimaryAgent(), subagentMetadata, primaryEnabled),
				buildPrimaryExperimentalPrompt(activePrimaryAgent(), settings.tlh?.experimental),
				buildTlhCommitAttributionPrompt(commitAttributionState),
			];
			if (shouldAppendGnosisPrompt(ctx.cwd)) {
				prompts.push(GNOSIS_PROMPT);
			}
			return { systemPrompt: prompts.filter(Boolean).join("\n\n") };
		});

		pi.on("tool_call", async (event, ctx) => {
			if (event.toolName === "bash") {
				// `toolName` narrows this branch, but not the shared mutable `input` payload.
				// Keep a runtime guard so direct/custom tool-call objects cannot pass a non-string command.
				if (typeof event.input.command !== "string") {
					return undefined;
				}
				const commitAttributionState = resolveTlhCommitAttribution(getTlhGlobalSettings(ctx.cwd).tlh?.attribution);
				const reason = getTlhGitCommitAttributionBlockReason(event.input.command, commitAttributionState);
				return reason ? { block: true, reason } : undefined;
			}
			if (event.toolName !== "subagent") {
				return undefined;
			}
			applyProviderAwareSubagentModels(event.input, subagentsByName, getUnfilteredAvailableModels(ctx.modelRegistry), ctx.model?.provider);
			syncPrimaryAgentState(ctx);
			const selection = currentPrimaryAgentSelection();
			if (!isEnabledPrimaryAgentSelection(selection)) {
				return undefined;
			}
			if (selection === "rush" && isSubagentResumeAction(event.input)) {
				return { block: true, reason: rushResumeDelegationReason() };
			}
			if (selection === "rush" && subagentCallTargetsAgent(event.input, "developer")) {
				return { block: true, reason: rushDeveloperDelegationReason() };
			}
			const reason = validateSubagentToolInput(event.input);
			return reason ? { block: true, reason } : undefined;
		});
	}

	return { applySessionStart, currentPrimaryAgentLabel, activePrimaryAgentPrompt: activePrimaryAgent, registerCommands, registerLifecycleHooks };
}

export function registerTlhPrimaryAgentRuntime(
	pi: ExtensionAPI,
	options: TlhPrimaryAgentRuntimeOptions = {},
): TlhPrimaryAgentRuntime | undefined {
	const env = options.env ?? process.env;
	const childPromptBuilder = (): string => buildChildSubagentSystemPrompt();
	if (
		registerTlhStartupMode(pi, {
			env,
			buildChildSubagentSystemPrompt: childPromptBuilder,
			registerChild: () => {
				registerChildSubagentRuntime(pi, childPromptBuilder, env);
			},
		}) === "child"
	) {
		return undefined;
	}

	const runtime = createTlhPrimaryAgentRuntime(
		pi,
		options.primaryAgents ?? loadPrimaryAgents(),
		options.subagentMetadata ?? loadSubagentMetadata(),
	);
	runtime.registerCommands();
	runtime.registerLifecycleHooks();
	return runtime;
}

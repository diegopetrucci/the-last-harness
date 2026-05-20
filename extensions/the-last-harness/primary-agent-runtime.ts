import { writeFileSync } from "node:fs";

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
import { formatHomePath, isRecord } from "./common.js";
import { GNOSIS_PROMPT, PRIMARY_AGENT_CYCLE_SHORTCUT, TLH_NAME, TLH_PACKAGE_NAME } from "./constants.js";
import { shouldAppendGnosisPrompt } from "./gnosis.js";
import {
	buildChildSubagentSystemPrompt,
	buildTlhSystemPrompt,
	loadPrimaryAgents,
	loadSubagentMetadata,
} from "./prompts.js";
import { assertSafeTlhSettingsPath, tlhSettingsPathForWrite } from "./profile-state.js";
import type {
	AgentPrompt,
	SettingsStorageLike,
	SubagentMetadata,
	TlhPrimaryAgentConfig,
	TlhPrimaryAgentSelection,
	TlhPrimaryAgentSessionState,
	TlhPrimaryAgentWriteResult,
	TlhSettings,
} from "./types.js";

type TlhPrimaryAgentRuntimeOptions = {
	env?: Record<string, string | undefined>;
};

export type TlhPrimaryAgentRuntime = {
	applySessionStart(ctx: ExtensionContext): Promise<void>;
	currentPrimaryAgentLabel(): string;
};

function getTlhPrimaryAgentConfig(cwd: string): TlhPrimaryAgentConfig | undefined {
	try {
		const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as TlhSettings;
		return settings.tlh?.primaryAgent;
	} catch {
		return undefined;
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

function getSettingsStorageForWrite(cwd: string): SettingsStorageLike {
	const manager = SettingsManager.create(cwd, getAgentDir()) as unknown as { storage?: SettingsStorageLike };
	if (!manager.storage || typeof manager.storage.withLock !== "function") {
		throw new Error("Pi settings storage is unavailable.");
	}
	return manager.storage;
}

function writeTlhPrimaryAgentDefault(cwd: string, selection: TlhPrimaryAgentSelection | undefined): TlhPrimaryAgentWriteResult {
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

function primaryAgentLabel(selection: TlhPrimaryAgentSelection): string {
	return selection;
}

function primaryAgentOverrideLabel(selection: TlhPrimaryAgentSelection | undefined): string {
	return selection ?? "none";
}

function createTlhPrimaryAgentRuntime(
	pi: ExtensionAPI,
	primaryAgents: Map<TlhPrimaryAgentSelection, AgentPrompt>,
	subagentMetadata: SubagentMetadata[],
): TlhPrimaryAgentRuntime & { registerCommands(): void; registerLifecycleHooks(): void } {
	const warned = new Set<string>();
	const primaryToolState = createPrimaryToolState();
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
		return [
			`${TLH_PACKAGE_NAME} (${TLH_NAME}) is active.`,
			`Primary agent: ${primaryAgentLabel(effective)}.`,
			`Session override: ${primaryAgentOverrideLabel(override)}.`,
			`Persistent default: ${primaryAgentDefaultLabel(primaryConfig)}.`,
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

	async function applyPrimaryModel(ctx: ExtensionContext, primary: AgentPrompt): Promise<void> {
		if (!primary.model) {
			return;
		}
		const parsedModel = parseProviderModel(primary.model);
		if (!parsedModel) {
			warnOnce(ctx, `invalid-primary-model-${primary.name}`, `TLH primary agent model is invalid: ${primary.model}`);
			return;
		}
		const model = ctx.modelRegistry.find(parsedModel.provider, parsedModel.id);
		if (!model) {
			warnOnce(ctx, `missing-primary-model-${primary.name}`, `TLH primary agent model not found: ${primary.model}`);
			return;
		}
		if (ctx.model?.provider === model.provider && ctx.model?.id === model.id) {
			return;
		}
		const success = await pi.setModel(model);
		if (!success) {
			warnOnce(ctx, `primary-model-unavailable-${primary.name}`, `TLH could not switch to primary agent model: ${primary.model}`);
		}
	}

	function applyPrimaryThinking(primary: AgentPrompt): void {
		if (!primary.thinking || pi.getThinkingLevel() === primary.thinking) {
			return;
		}
		pi.setThinkingLevel(primary.thinking);
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
		if (primaryConfig?.applyModel === true) {
			await applyPrimaryModel(ctx, primary);
		}
		if (primaryConfig?.applyThinking === true) {
			applyPrimaryThinking(primary);
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
		return PRIMARY_AGENT_CYCLE.includes(normalized) ? (normalized as TlhPrimaryAgentSelection) : undefined;
	}

	function agentCommandCompletions(prefix: string) {
		const options = [
			{ value: "status", description: "Show TLH primary-agent status" },
			{ value: "architect", description: "Use the architect primary agent for this session" },
			{ value: "product", description: "Use the product primary agent for this session" },
			{ value: "bug-hunter", description: "Use the bug-hunter primary agent for this session" },
			{ value: "disabled", description: "Disable TLH primary agents for this session" },
			{ value: "reset", description: "Clear the session primary-agent override" },
			{ value: "default architect", description: "Persistently select architect for future sessions" },
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

	function registerCommands(): void {
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
			description: "Show or change the TLH primary agent",
			getArgumentCompletions: agentCommandCompletions,
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
						ctx.ui.notify("Usage: /agent reset", "error");
						return;
					}
					setSessionPrimaryAgentOverride(undefined);
					await applyPrimaryModeChange(ctx);
					ctx.ui.notify(`Cleared TLH primary-agent session override. Primary agent: ${currentPrimaryAgentLabel()}.`, "info");
					return;
				}

				const selected = parsePrimaryAgentSelection(command);
				if (selected) {
					if (parts.length !== 1) {
						ctx.ui.notify("Usage: /agent architect|product|bug-hunter|disabled", "error");
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
						ctx.ui.notify("Usage: /agent default architect|product|bug-hunter|disabled|reset", "error");
						return;
					}
					const defaultSelection = value === "reset" ? undefined : parsePrimaryAgentSelection(value);
					if (value !== "reset" && !defaultSelection) {
						ctx.ui.notify("Usage: /agent default architect|product|bug-hunter|disabled|reset", "error");
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

				ctx.ui.notify("Usage: /agent [status|architect|product|bug-hunter|disabled|reset|default architect|default product|default bug-hunter|default disabled|default reset]", "error");
			},
		});

		pi.registerShortcut(PRIMARY_AGENT_CYCLE_SHORTCUT, {
			description: "Cycle TLH primary agent (architect/product/bug-hunter/disabled)",
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

					let nextOverride: TlhPrimaryAgentSelection | undefined;
					if (command === "on") {
						nextOverride = "architect";
					} else if (command === "off") {
						nextOverride = DISABLED_PRIMARY_AGENT;
					} else if (command === "toggle") {
						nextOverride = currentPrimaryAgentSelection() === "architect" ? DISABLED_PRIMARY_AGENT : "architect";
					}

					setSessionPrimaryAgentOverride(nextOverride);
					await applyPrimaryModeChange(ctx);
					if (nextOverride === undefined) {
						ctx.ui.notify(`Cleared architect session override. Primary agent: ${currentPrimaryAgentLabel()}.`, "info");
						return;
					}
					ctx.ui.notify(
						`Architect ${nextOverride === "architect" ? "enabled" : "disabled"} for this session.${cleanDisabledPrimarySessionHint(nextOverride)}`,
						"info",
					);
					return;
				}

				if (command === "default") {
					if (parts.length !== 2 || !["on", "off", "reset"].includes(value)) {
						ctx.ui.notify("Usage: /architect default on|off|reset", "error");
						return;
					}

					const nextDefault = value === "reset" ? undefined : value === "on" ? "architect" : DISABLED_PRIMARY_AGENT;
					try {
						const result = writeTlhPrimaryAgentDefault(ctx.cwd, nextDefault);
						syncPrimaryAgentState(ctx);
						await applyPrimaryModeChange(ctx);
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
	}

	async function applySessionStart(ctx: ExtensionContext): Promise<void> {
		syncPrimaryAgentState(ctx);
		await applyPrimaryDefaults(ctx);
	}

	function registerLifecycleHooks(): void {
		pi.on("session_tree", async (_event, ctx) => {
			syncPrimaryAgentState(ctx);
			await applyPrimaryDefaults(ctx);
		});

		pi.on("session_shutdown", async (_event, _ctx) => {
			restorePrimaryToolsIfAppropriate();
		});

		pi.on("before_agent_start", async (event, ctx) => {
			syncPrimaryAgentState(ctx);
			const selection = currentPrimaryAgentSelection();
			const primaryEnabled = isEnabledPrimaryAgentSelection(selection);
			await applyPrimaryDefaults(ctx);
			const prompts = [event.systemPrompt, buildTlhSystemPrompt(activePrimaryAgent(), subagentMetadata, primaryEnabled)];
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
			if (!isEnabledPrimaryAgentSelection(currentPrimaryAgentSelection())) {
				return undefined;
			}
			const reason = validateSubagentToolInput(event.input);
			return reason ? { block: true, reason } : undefined;
		});
	}

	return { applySessionStart, currentPrimaryAgentLabel, registerCommands, registerLifecycleHooks };
}

export function registerTlhPrimaryAgentRuntime(
	pi: ExtensionAPI,
	options: TlhPrimaryAgentRuntimeOptions = {},
): TlhPrimaryAgentRuntime | undefined {
	if (registerTlhStartupMode(pi, { env: options.env ?? process.env, buildChildSubagentSystemPrompt }) === "child") {
		return undefined;
	}

	const runtime = createTlhPrimaryAgentRuntime(pi, loadPrimaryAgents(), loadSubagentMetadata());
	runtime.registerCommands();
	runtime.registerLifecycleHooks();
	return runtime;
}

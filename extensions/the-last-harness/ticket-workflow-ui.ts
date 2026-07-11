import { spawnSync, type SpawnSyncReturns } from "node:child_process";

import { SettingsManager, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	isTlhExperimentalFeatureEnabled,
	TICKET_WORKFLOW_UI_FEATURE,
	TLH_EXPERIMENTAL_FEATURE_CHANGED_EVENT,
} from "./experimental.js";
import { isRecord } from "./common.js";
import { findValidTlhTicketCommand } from "./tickets.js";
import { TK_WORKFLOW_STATUS_KEY, TK_WORKFLOW_WIDGET_KEY } from "./ticket-workflow-ui-constants.js";
import type { TlhSettings } from "./types.js";

const TK_STATUS_COMMAND = "tk-status";
const TK_COMMAND_TIMEOUT_MS = 4000;
const TK_USER_BASH_REFRESH_DELAY_MS = 250;
const TK_STATUS_HELP = "Use /tk-status for details.";
const TK_WORKING_ON_PREFIX = "working on tk: ";

type TkWorkflowSnapshot =
	| { kind: "disabled" }
	| { kind: "unavailable"; message: string }
	| { kind: "no-repo"; message: string }
	| { kind: "no-tickets" }
	| {
			kind: "ok";
			total: number;
			active: number;
			ready: string[];
			blocked: string[];
		};

type TkCommandResult = SpawnSyncReturns<string>;

function getTlhGlobalSettings(cwd: string): TlhSettings {
	try {
		const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as unknown;
		return isRecord(settings) ? (settings as TlhSettings) : {};
	} catch {
		return {};
	}
}

function isTicketWorkflowUiEnabled(cwd: string): boolean {
	return isTlhExperimentalFeatureEnabled(getTlhGlobalSettings(cwd).tlh?.experimental, TICKET_WORKFLOW_UI_FEATURE);
}

function firstOutputLine(result: TkCommandResult): string | undefined {
	return `${result.stdout || ""}\n${result.stderr || ""}`
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
}

function isNoRepoMessage(message: string | undefined): boolean {
	return typeof message === "string" && /no \.tickets directory found/i.test(message);
}

function runTkCommand(command: string, cwd: string, args: string[]): TkCommandResult {
	return spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		timeout: TK_COMMAND_TIMEOUT_MS,
	});
}

function parseJsonLines(output: string): Array<{ status?: string }> {
	const lines = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	return lines.map((line) => JSON.parse(line) as { status?: string });
}

function parseListLines(output: string): string[] {
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

function getTkWorkflowSnapshot(cwd: string): TkWorkflowSnapshot {
	if (!isTicketWorkflowUiEnabled(cwd)) {
		return { kind: "disabled" };
	}

	const settings = getTlhGlobalSettings(cwd);
	const command = findValidTlhTicketCommand(settings, getAgentDir());
	if (!command) {
		return { kind: "unavailable", message: "tk is unavailable for this TLH profile." };
	}

	const queryResult = runTkCommand(command, cwd, ["query"]);
	const queryFailure = firstOutputLine(queryResult);
	if (queryResult.error) {
		return { kind: "unavailable", message: queryResult.error.message };
	}
	if (queryResult.status !== 0) {
		return isNoRepoMessage(queryFailure)
			? { kind: "no-repo", message: "No .tickets directory found for this repo." }
			: { kind: "unavailable", message: queryFailure ?? "tk query failed." };
	}

	let tickets: Array<{ status?: string }>;
	try {
		tickets = parseJsonLines(queryResult.stdout || "");
	} catch {
		return { kind: "unavailable", message: "Could not parse tk query output." };
	}
	if (tickets.length === 0) {
		return { kind: "no-tickets" };
	}

	const readyResult = runTkCommand(command, cwd, ["ready"]);
	if (readyResult.error) {
		return { kind: "unavailable", message: readyResult.error.message };
	}
	if (readyResult.status !== 0) {
		const failure = firstOutputLine(readyResult);
		return isNoRepoMessage(failure)
			? { kind: "no-repo", message: "No .tickets directory found for this repo." }
			: { kind: "unavailable", message: failure ?? "tk ready failed." };
	}

	const blockedResult = runTkCommand(command, cwd, ["blocked"]);
	if (blockedResult.error) {
		return { kind: "unavailable", message: blockedResult.error.message };
	}
	if (blockedResult.status !== 0) {
		const failure = firstOutputLine(blockedResult);
		return isNoRepoMessage(failure)
			? { kind: "no-repo", message: "No .tickets directory found for this repo." }
			: { kind: "unavailable", message: failure ?? "tk blocked failed." };
	}

	const active = tickets.filter((ticket) => ticket.status === "open" || ticket.status === "in_progress").length;
	return {
		kind: "ok",
		total: tickets.length,
		active,
		ready: parseListLines(readyResult.stdout || ""),
		blocked: parseListLines(blockedResult.stdout || ""),
	};
}

function isTerminalControlCharCode(code: number): boolean {
	return (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
}

function stripTerminalControlSequences(text: string): string {
	let sanitized = "";

	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code === 0x1b) {
			const nextCode = text.charCodeAt(index + 1);
			if (nextCode === 0x5d) {
				index += 2;
				while (index < text.length) {
					const oscCode = text.charCodeAt(index);
					if (oscCode === 0x07) {
						break;
					}
					if (oscCode === 0x1b && text.charCodeAt(index + 1) === 0x5c) {
						index += 1;
						break;
					}
					index += 1;
				}
				continue;
			}
			if (nextCode === 0x5b) {
				index += 2;
				while (index < text.length) {
					const csiCode = text.charCodeAt(index);
					if (csiCode >= 0x40 && csiCode <= 0x7e) {
						break;
					}
					index += 1;
				}
				continue;
			}
			if (nextCode >= 0x40 && nextCode <= 0x5f) {
				index += 1;
			}
			continue;
		}
		if (!isTerminalControlCharCode(code)) {
			sanitized += text[index];
		}
	}

	return sanitized;
}

function extractNextReadyTicketTitle(snapshot: Extract<TkWorkflowSnapshot, { kind: "ok" }>): string | undefined {
	const nextReady = snapshot.ready[0]?.trim();
	if (!nextReady) {
		return undefined;
	}
	const titleSeparatorIndex = nextReady.indexOf(" - ");
	const title = titleSeparatorIndex >= 0 ? nextReady.slice(titleSeparatorIndex + 3).trim() : "";
	return title || nextReady;
}

function formatTkWorkflowFooterStatus(snapshot: TkWorkflowSnapshot): string | undefined {
	if (snapshot.kind !== "ok") {
		return undefined;
	}
	const title = extractNextReadyTicketTitle(snapshot);
	const safeTitle = title ? stripTerminalControlSequences(title).trim() : undefined;
	return safeTitle ? `${TK_WORKING_ON_PREFIX}${safeTitle}\n${TK_STATUS_HELP}` : undefined;
}

function formatTkWorkflowDetails(snapshot: TkWorkflowSnapshot): string {
	if (snapshot.kind === "disabled") {
		return `Ticket workflow UI is disabled. Enable it with /experimental enable ${TICKET_WORKFLOW_UI_FEATURE}.`;
	}
	if (snapshot.kind === "unavailable") {
		return `Ticket workflow status unavailable: ${snapshot.message}`;
	}
	if (snapshot.kind === "no-repo") {
		return `Ticket workflow status unavailable: ${snapshot.message}`;
	}
	if (snapshot.kind === "no-tickets") {
		return "tk: no tickets in this repo.";
	}

	const lines = [
		`tk: ${snapshot.ready.length} ready • ${snapshot.blocked.length} blocked • ${snapshot.active} active • ${snapshot.total} total`,
	];
	if (snapshot.ready.length > 0) {
		lines.push("Ready:", ...snapshot.ready.slice(0, 3).map((line) => `- ${line}`));
	}
	if (snapshot.blocked.length > 0) {
		lines.push("Blocked:", ...snapshot.blocked.slice(0, 3).map((line) => `- ${line}`));
	}
	return lines.join("\n");
}

function setTkWorkflowUi(ctx: ExtensionContext, snapshot: TkWorkflowSnapshot): void {
	ctx.ui.setStatus?.(TK_WORKFLOW_STATUS_KEY, formatTkWorkflowFooterStatus(snapshot));
	ctx.ui.setWidget?.(TK_WORKFLOW_WIDGET_KEY, undefined);
}

function shouldRefreshFromBashCommand(command: string): boolean {
	const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]?.replace(/^['"]|['"]$/g, "");
		if (!token) continue;
		if (/(^|\/)tk$/.test(token)) {
			return true;
		}
		if (/^(?:bash|sh|zsh)$/.test(token)) {
			const nextIndex = tokens.findIndex((candidate, candidateIndex) => candidateIndex > index && /^-[^-]*c/.test(candidate));
			if (nextIndex > index && nextIndex + 1 < tokens.length) {
				const nested = tokens[nextIndex + 1]?.replace(/^['"]|['"]$/g, "") ?? "";
				if (nested && shouldRefreshFromBashCommand(nested)) {
					return true;
				}
			}
		}
	}
	return false;
}

export type TlhTicketWorkflowUiRuntime = {
	applyCurrentSettings(ctx: ExtensionContext): void;
	handleExperimentalFeatureChange(event: unknown): void;
	handleUserBash(event: { command: string }, ctx: ExtensionContext): void;
	handleToolResult(event: { toolName: string; input: { command?: unknown } }, ctx: ExtensionContext): void;
};

export function createTlhTicketWorkflowUiRuntime(pi: ExtensionAPI): TlhTicketWorkflowUiRuntime {
	let commandRegistered = false;
	let activeContext: ExtensionContext | undefined;

	const refresh = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			return;
		}
		setTkWorkflowUi(ctx, getTkWorkflowSnapshot(ctx.cwd));
	};

	const ensureCommandRegistered = () => {
		if (commandRegistered) {
			return;
		}
		pi.registerCommand(TK_STATUS_COMMAND, {
			description: "Show TLH ticket workflow status",
			handler: async (_args, commandCtx) => {
				commandCtx.ui.notify(formatTkWorkflowDetails(getTkWorkflowSnapshot(commandCtx.cwd)), "info");
			},
		});
		commandRegistered = true;
	};

	const applyCurrentSettings = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			return;
		}
		activeContext = ctx;
		const enabled = isTicketWorkflowUiEnabled(ctx.cwd);
		if (!enabled) {
			setTkWorkflowUi(ctx, { kind: "disabled" });
			return;
		}
		ensureCommandRegistered();
		refresh(ctx);
	};

	return {
		applyCurrentSettings,
		handleExperimentalFeatureChange(event: unknown) {
			if (!isRecord(event) || event.featureId !== TICKET_WORKFLOW_UI_FEATURE || !activeContext?.hasUI) {
				return;
			}
			if (typeof event.cwd === "string" && event.cwd !== activeContext.cwd) {
				return;
			}
			applyCurrentSettings(activeContext);
		},
		handleUserBash(event: { command: string }, ctx: ExtensionContext) {
			if (!ctx.hasUI || !isTicketWorkflowUiEnabled(ctx.cwd) || !shouldRefreshFromBashCommand(event.command)) {
				return;
			}
			const timeout = setTimeout(() => refresh(ctx), TK_USER_BASH_REFRESH_DELAY_MS);
			timeout.unref?.();
		},
		handleToolResult(event: { toolName: string; input: { command?: unknown } }, ctx: ExtensionContext) {
			if (!ctx.hasUI || !isTicketWorkflowUiEnabled(ctx.cwd) || event.toolName !== "bash") {
				return;
			}
			const command = typeof event.input.command === "string" ? event.input.command : undefined;
			if (!command || !shouldRefreshFromBashCommand(command)) {
				return;
			}
			refresh(ctx);
		},
	};
}

export function registerTlhTicketWorkflowUi(pi: ExtensionAPI): void {
	const runtime = createTlhTicketWorkflowUiRuntime(pi);

	pi.events?.on?.(TLH_EXPERIMENTAL_FEATURE_CHANGED_EVENT, (event: unknown) => {
		runtime.handleExperimentalFeatureChange(event);
	});

	pi.on("session_start", async (_event, ctx) => {
		runtime.applyCurrentSettings(ctx);
	});

	pi.on("user_bash", (event, ctx) => {
		runtime.handleUserBash(event, ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		runtime.handleToolResult(event, ctx);
	});
}

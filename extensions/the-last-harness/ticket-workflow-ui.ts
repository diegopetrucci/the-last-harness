import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { performance } from "node:perf_hooks";

import {
	SettingsManager,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { isRecord } from "./common.js";
import { activateTlhTicketSessionScope, findValidTlhTicketCommand } from "./tickets.js";
import { TK_WORKFLOW_STATUS_KEY, TK_WORKFLOW_WIDGET_KEY } from "./ticket-workflow-ui-constants.js";
import type { TlhSettings } from "./types.js";

const TK_STATUS_COMMAND = "tickets";
const TK_COMMAND_TIMEOUT_MS = 4000;
const TK_TITLE_RESOLUTION_BUDGET_MS = TK_COMMAND_TIMEOUT_MS;
const TK_USER_BASH_REFRESH_DELAY_MS = 250;
const TK_STATUS_HINT = " (/tickets)";
const TK_WORKING_ON_PREFIX = "ticket: ";

type TkWorkflowTicket = { id?: string; status?: string };
type TkWorkflowInProgressTicket = { id: string; title?: string };

type TkWorkflowSnapshot =
	| { kind: "unavailable"; message: string }
	| { kind: "no-repo"; message: string }
	| { kind: "no-tickets" }
	| {
			kind: "ok";
			total: number;
			active: number;
			ready: string[];
			blocked: string[];
			inProgress: TkWorkflowInProgressTicket[];
	  };

type TkCommandResult = SpawnSyncReturns<string>;
type TkCommandRunner = (command: string, cwd: string, args: string[], timeoutMs: number) => TkCommandResult;

export type TlhTicketWorkflowUiRuntimeOptions = {
	runner?: TkCommandRunner;
	now?: () => number;
};

function getTlhGlobalSettings(cwd: string): TlhSettings {
	try {
		const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as unknown;
		return isRecord(settings) ? (settings as TlhSettings) : {};
	} catch {
		return {};
	}
}

function firstOutputLine(result: TkCommandResult): string | undefined {
	return `${result.stdout || ""}\n${result.stderr || ""}`
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
}

function isNoRepoMessage(message: string | undefined): boolean {
	return (
		typeof message === "string" &&
		(/no \.tickets directory found/i.test(message) || /tickets directory ['"].+['"] does not exist/i.test(message))
	);
}

function runTkCommand(command: string, cwd: string, args: string[], timeoutMs: number): TkCommandResult {
	return spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		timeout: timeoutMs,
	});
}

function parseJsonLines(output: string): TkWorkflowTicket[] {
	const lines = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	return lines.map((line) => JSON.parse(line) as TkWorkflowTicket);
}

function parseListLines(output: string): string[] {
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

function extractTicketTitleFromShowOutput(output: string): string | undefined {
	const lines = output.split(/\r?\n/);
	let inFrontmatter = false;
	let frontmatterComplete = false;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!frontmatterComplete && line === "---") {
			if (!inFrontmatter) {
				inFrontmatter = true;
				continue;
			}
			frontmatterComplete = true;
			continue;
		}
		if (inFrontmatter && !frontmatterComplete) {
			continue;
		}
		if (!line) {
			continue;
		}
		if (line.startsWith("# ")) {
			return line.slice(2).trim() || undefined;
		}
		return line;
	}

	return undefined;
}

function getInProgressTicketTitle(
	command: string,
	cwd: string,
	ticketId: string,
	timeoutMs: number,
	runner: TkCommandRunner,
): string | undefined {
	const showResult = runner(command, cwd, ["show", ticketId], timeoutMs);
	if (showResult.error || showResult.status !== 0) {
		return undefined;
	}
	return extractTicketTitleFromShowOutput(showResult.stdout || "");
}

function resolveInProgressTickets(
	command: string,
	cwd: string,
	ticketIds: string[],
	runner: TkCommandRunner,
	now: () => number,
): TkWorkflowInProgressTicket[] {
	const deadlineMs = now() + TK_TITLE_RESOLUTION_BUDGET_MS;
	return ticketIds.map((ticketId) => {
		const timeoutMs = Math.floor(deadlineMs - now());
		const title = timeoutMs > 0 ? getInProgressTicketTitle(command, cwd, ticketId, timeoutMs, runner) : undefined;
		return { id: ticketId, title };
	});
}

function getTkWorkflowSnapshot(cwd: string, options: TlhTicketWorkflowUiRuntimeOptions): TkWorkflowSnapshot {
	activateTlhTicketSessionScope(cwd);
	const settings = getTlhGlobalSettings(cwd);
	const command = findValidTlhTicketCommand(settings, getAgentDir());
	if (!command) {
		return { kind: "unavailable", message: "tk is unavailable for this TLH profile." };
	}
	const runner = options.runner ?? runTkCommand;
	const now = options.now ?? (() => performance.now());

	const queryResult = runner(command, cwd, ["query"], TK_COMMAND_TIMEOUT_MS);
	const queryFailure = firstOutputLine(queryResult);
	if (queryResult.error) {
		return { kind: "unavailable", message: queryResult.error.message };
	}
	if (queryResult.status !== 0) {
		return isNoRepoMessage(queryFailure)
			? { kind: "no-repo", message: "No .tickets directory found for this repo." }
			: { kind: "unavailable", message: queryFailure ?? "tk query failed." };
	}

	let tickets: TkWorkflowTicket[];
	try {
		tickets = parseJsonLines(queryResult.stdout || "");
	} catch {
		return { kind: "unavailable", message: "Could not parse tk query output." };
	}
	if (tickets.length === 0) {
		return { kind: "no-tickets" };
	}

	const readyResult = runner(command, cwd, ["ready"], TK_COMMAND_TIMEOUT_MS);
	if (readyResult.error) {
		return { kind: "unavailable", message: readyResult.error.message };
	}
	if (readyResult.status !== 0) {
		const failure = firstOutputLine(readyResult);
		return isNoRepoMessage(failure)
			? { kind: "no-repo", message: "No .tickets directory found for this repo." }
			: { kind: "unavailable", message: failure ?? "tk ready failed." };
	}

	const blockedResult = runner(command, cwd, ["blocked"], TK_COMMAND_TIMEOUT_MS);
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
	const inProgressTicketIds = tickets
		.filter((ticket) => ticket.status === "in_progress")
		.map((ticket) => ticket.id?.trim())
		.filter((ticketId): ticketId is string => Boolean(ticketId));
	const inProgress = resolveInProgressTickets(command, cwd, inProgressTicketIds, runner, now);
	return {
		kind: "ok",
		total: tickets.length,
		active,
		ready: parseListLines(readyResult.stdout || ""),
		blocked: parseListLines(blockedResult.stdout || ""),
		inProgress,
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

function getSafeInProgressTicketId(ticket: TkWorkflowInProgressTicket): string {
	return stripTerminalControlSequences(ticket.id).trim();
}

function getSafeInProgressTicketTitle(ticket: TkWorkflowInProgressTicket): string | undefined {
	const safeTitle = ticket.title ? stripTerminalControlSequences(ticket.title).trim() : undefined;
	return safeTitle || undefined;
}

function formatTkWorkflowFooterStatus(snapshot: TkWorkflowSnapshot): string | undefined {
	if (snapshot.kind !== "ok" || snapshot.inProgress.length === 0) {
		return undefined;
	}
	return snapshot.inProgress
		.map((ticket) => {
			const label = getSafeInProgressTicketTitle(ticket) ?? getSafeInProgressTicketId(ticket);
			return `${TK_WORKING_ON_PREFIX}${label}${TK_STATUS_HINT}`;
		})
		.join("\n");
}

function formatTkWorkflowDetails(snapshot: TkWorkflowSnapshot): string {
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
		`tk: ${snapshot.ready.length} ready • ${snapshot.blocked.length} blocked • ${snapshot.inProgress.length} in progress • ${snapshot.active} active • ${snapshot.total} total`,
	];
	if (snapshot.inProgress.length === 0) {
		lines.push("In progress: none. Footer stays quiet.");
	} else if (snapshot.inProgress.length === 1) {
		const [ticket] = snapshot.inProgress;
		const id = getSafeInProgressTicketId(ticket);
		const title = getSafeInProgressTicketTitle(ticket);
		lines.push(`In progress: ${title ? `${id} - ${title}` : id}`);
	} else {
		lines.push(
			"In progress:",
			...snapshot.inProgress.map((ticket) => {
				const id = getSafeInProgressTicketId(ticket);
				const title = getSafeInProgressTicketTitle(ticket);
				return `- ${title ? `${id} - ${title}` : id}`;
			}),
		);
	}
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
			const nextIndex = tokens.findIndex(
				(candidate, candidateIndex) => candidateIndex > index && /^-[^-]*c/.test(candidate),
			);
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
	handleSessionShutdown(): void;
	handleUserBash(event: { command: string }, ctx: ExtensionContext): void;
	handleToolResult(event: { toolName: string; input: { command?: unknown } }, ctx: ExtensionContext): void;
};

export function createTlhTicketWorkflowUiRuntime(
	pi: ExtensionAPI,
	options: TlhTicketWorkflowUiRuntimeOptions = {},
): TlhTicketWorkflowUiRuntime {
	let commandRegistered = false;
	const pendingUserBashRefreshes = new Set<ReturnType<typeof setTimeout>>();

	const refresh = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			return;
		}
		setTkWorkflowUi(ctx, getTkWorkflowSnapshot(ctx.cwd, options));
	};

	const ensureCommandRegistered = () => {
		if (commandRegistered) {
			return;
		}
		pi.registerCommand(TK_STATUS_COMMAND, {
			description: "Show TLH ticket workflow status",
			handler: async (_args, commandCtx) => {
				commandCtx.ui.notify(formatTkWorkflowDetails(getTkWorkflowSnapshot(commandCtx.cwd, options)), "info");
			},
		});
		commandRegistered = true;
	};

	const applyCurrentSettings = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			return;
		}
		ensureCommandRegistered();
		refresh(ctx);
	};

	return {
		applyCurrentSettings,
		handleSessionShutdown() {
			for (const timeout of pendingUserBashRefreshes) {
				clearTimeout(timeout);
			}
			pendingUserBashRefreshes.clear();
		},
		handleUserBash(event: { command: string }, ctx: ExtensionContext) {
			if (!ctx.hasUI || !shouldRefreshFromBashCommand(event.command)) {
				return;
			}
			const timeout = setTimeout(() => {
				pendingUserBashRefreshes.delete(timeout);
				refresh(ctx);
			}, TK_USER_BASH_REFRESH_DELAY_MS);
			pendingUserBashRefreshes.add(timeout);
			timeout.unref?.();
		},
		handleToolResult(event: { toolName: string; input: { command?: unknown } }, ctx: ExtensionContext) {
			if (!ctx.hasUI || event.toolName !== "bash") {
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

	pi.on("session_start", async (_event, ctx) => {
		activateTlhTicketSessionScope(ctx.cwd);
		runtime.applyCurrentSettings(ctx);
	});

	pi.on("session_shutdown", () => {
		runtime.handleSessionShutdown();
	});

	pi.on("user_bash", (event, ctx) => {
		runtime.handleUserBash(event, ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		runtime.handleToolResult(event, ctx);
	});
}

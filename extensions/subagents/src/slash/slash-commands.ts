import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { formatTokens } from "../shared/formatters.ts";
import { liveDetailShortcutDisplay } from "../shared/subagent-shortcuts.ts";
import type { SlashSubagentResponse, SlashSubagentUpdate } from "./slash-bridge.ts";
import {
	applySlashUpdate,
	buildSlashInitialResult,
	failSlashResult,
	finalizeSlashResult,
	resolveSlashMessageDetails,
} from "./slash-live-state.ts";
import {
	SLASH_RESULT_TYPE,
	SLASH_TEXT_RESULT_TYPE,
	SLASH_SUBAGENT_CANCEL_EVENT,
	SLASH_SUBAGENT_REQUEST_EVENT,
	SLASH_SUBAGENT_RESPONSE_EVENT,
	SLASH_SUBAGENT_STARTED_EVENT,
	SLASH_SUBAGENT_UPDATE_EVENT,
	type Details,
	type SingleResult,
	type SubagentState,
	type Usage,
} from "../shared/types.ts";

function sendSlashText(pi: ExtensionAPI, text: string): void {
	pi.sendMessage({ customType: SLASH_TEXT_RESULT_TYPE, content: text, display: true });
}

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function addUsage(target: Usage, source: Usage): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
	target.turns += source.turns;
}

function usageHasValue(usage: Usage): boolean {
	return usage.input !== 0 || usage.output !== 0 || usage.cacheRead !== 0 || usage.cacheWrite !== 0 || usage.cost !== 0 || usage.turns !== 0;
}

function assistantUsageFromMessage(message: unknown): Usage | undefined {
	if (!message || typeof message !== "object") return undefined;
	const msg = message as { role?: unknown; usage?: unknown };
	if (msg.role !== "assistant" || !msg.usage || typeof msg.usage !== "object") return undefined;
	const usage = msg.usage as {
		input?: unknown;
		output?: unknown;
		cacheRead?: unknown;
		cacheWrite?: unknown;
		cost?: { total?: unknown };
	};
	return {
		input: typeof usage.input === "number" ? usage.input : 0,
		output: typeof usage.output === "number" ? usage.output : 0,
		cacheRead: typeof usage.cacheRead === "number" ? usage.cacheRead : 0,
		cacheWrite: typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0,
		cost: typeof usage.cost?.total === "number" ? usage.cost.total : 0,
		turns: 1,
	};
}

function isSubagentDetails(value: unknown): value is Details {
	if (!value || typeof value !== "object") return false;
	const details = value as { mode?: unknown; results?: unknown };
	return typeof details.mode === "string" && Array.isArray(details.results);
}

function detailsFromSessionEntry(entry: unknown): Details | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as { type?: unknown; customType?: unknown; details?: unknown; message?: unknown };
	if (record.type === "custom_message" && record.customType === SLASH_RESULT_TYPE) {
		const details = resolveSlashMessageDetails(record.details)?.result.details;
		return isSubagentDetails(details) ? details : undefined;
	}
	if (record.type !== "message" || !record.message || typeof record.message !== "object") return undefined;
	const message = record.message as { role?: unknown; toolName?: unknown; details?: unknown };
	if (message.role !== "toolResult" || message.toolName !== "subagent") return undefined;
	return isSubagentDetails(message.details) ? message.details : undefined;
}

function formatCostUsage(label: string, usage: Usage): string {
	const extras = [
		usage.cacheRead ? `cache read ${formatTokens(usage.cacheRead)}` : "",
		usage.cacheWrite ? `cache write ${formatTokens(usage.cacheWrite)}` : "",
		usage.turns ? `${usage.turns} turn${usage.turns === 1 ? "" : "s"}` : "",
	].filter(Boolean);
	return `${label}: ↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)} $${usage.cost.toFixed(4)}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}

function buildSubagentCostReport(ctx: ExtensionContext): string {
	const parent = emptyUsage();
	const childTotal = emptyUsage();
	const total = emptyUsage();
	const children: Array<{ label: string; usage: Usage; sessionFile?: string }> = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		const message = entry.type === "message" ? (entry as { message?: unknown }).message : undefined;
		const parentUsage = assistantUsageFromMessage(message);
		if (parentUsage) addUsage(parent, parentUsage);
		const details = detailsFromSessionEntry(entry);
		if (!details) continue;
		for (const result of details.results) {
			if (!usageHasValue(result.usage)) continue;
			const usage = { ...result.usage };
			children.push({
				label: `Child ${children.length + 1} (${result.agent})`,
				usage,
				...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
			});
			addUsage(childTotal, usage);
		}
	}
	addUsage(total, parent);
	addUsage(total, childTotal);
	const lines = [
		"Subagent cost",
		"",
		formatCostUsage("Parent", parent),
	];
	if (children.length === 0) {
		lines.push("No subagent child usage found in this session.");
	} else {
		for (const child of children) {
			lines.push(formatCostUsage(child.label, child.usage));
			if (child.sessionFile) lines.push(`  Session: ${child.sessionFile}`);
		}
	}
	lines.push("────────────────────────────", formatCostUsage("Children", childTotal), formatCostUsage("Total", total));
	return lines.join("\n");
}

async function requestSlashRun(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	requestId: string,
	params: SubagentParamsLike,
): Promise<SlashSubagentResponse> {
	return new Promise((resolve, reject) => {
		let done = false;
		let started = false;

		const startTimeoutMs = 15_000;
		const startTimeout = setTimeout(() => {
			finish(() => reject(new Error(
				"Slash subagent bridge did not start within 15s. Ensure the extension is loaded correctly.",
			)));
		}, startTimeoutMs);

		const onStarted = (data: unknown) => {
			if (done || !data || typeof data !== "object") return;
			if ((data as { requestId?: unknown }).requestId !== requestId) return;
			started = true;
			clearTimeout(startTimeout);
			if (ctx.hasUI) ctx.ui.setStatus("subagent-slash", "running...");
		};

		const onResponse = (data: unknown) => {
			if (done || !data || typeof data !== "object") return;
			const response = data as Partial<SlashSubagentResponse>;
			if (response.requestId !== requestId) return;
			clearTimeout(startTimeout);
			finish(() => resolve(response as SlashSubagentResponse));
		};

		const onUpdate = (data: unknown) => {
			if (done || !data || typeof data !== "object") return;
			const update = data as SlashSubagentUpdate;
			if (update.requestId !== requestId) return;
			applySlashUpdate(requestId, update);
			if (!ctx.hasUI) return;
			const tool = update.currentTool ? ` ${update.currentTool}` : "";
			const count = update.toolCount ?? 0;
			ctx.ui.setStatus("subagent-slash", `${count} tools${tool} | ${liveDetailShortcutDisplay()} live detail`);
		};

		const onTerminalInput = ctx.hasUI
			? ctx.ui.onTerminalInput((input) => {
				if (!matchesKey(input, Key.escape)) return undefined;
				pi.events.emit(SLASH_SUBAGENT_CANCEL_EVENT, { requestId });
				finish(() => reject(new Error("Cancelled")));
				return { consume: true };
			})
			: undefined;

		const unsubStarted = pi.events.on(SLASH_SUBAGENT_STARTED_EVENT, onStarted);
		const unsubResponse = pi.events.on(SLASH_SUBAGENT_RESPONSE_EVENT, onResponse);
		const unsubUpdate = pi.events.on(SLASH_SUBAGENT_UPDATE_EVENT, onUpdate);

		const finish = (next: () => void) => {
			if (done) return;
			done = true;
			clearTimeout(startTimeout);
			unsubStarted();
			unsubResponse();
			unsubUpdate();
			onTerminalInput?.();
			next();
		};

		pi.events.emit(SLASH_SUBAGENT_REQUEST_EVENT, { requestId, params, ctx });

		// Bridge emits STARTED synchronously during REQUEST emit.
		// If not started, no bridge received the request.
		if (!started && done) return;
		if (!started) {
			finish(() => reject(new Error(
				"No slash subagent bridge responded. Ensure the subagent extension is loaded correctly.",
			)));
		}
	});
}

function extractSlashMessageText(content: string | Array<{ type?: string; text?: string }>): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function formatExportPathList(paths: string[]): string {
	return paths.map((file) => `- \`${file}\``).join("\n");
}

function collectResultPaths(results: SingleResult[], getPath: (result: SingleResult) => string | undefined): string[] {
	return results
		.map(getPath)
		.filter((file): file is string => typeof file === "string" && file.length > 0);
}

function buildSlashExportText(response: SlashSubagentResponse): string {
	const output = extractSlashMessageText(response.result.content) || response.errorText || "(no output)";
	const results = response.result.details?.results ?? [];
	const sessionFiles = collectResultPaths(results, (result) => result.sessionFile);
	const savedOutputs = collectResultPaths(results, (result) => result.savedOutputPath);
	const artifactOutputs = collectResultPaths(results, (result) => result.artifactPaths?.outputPath);
	const sections = ["## Subagent result", output];
	if (sessionFiles.length > 0) sections.push("## Child session exports", formatExportPathList(sessionFiles));
	if (savedOutputs.length > 0) sections.push("## Saved outputs", formatExportPathList(savedOutputs));
	if (artifactOutputs.length > 0) sections.push("## Artifact outputs", formatExportPathList(artifactOutputs));
	return sections.join("\n\n");
}

function persistSlashSessionSnapshot(ctx: ExtensionContext): void {
	try {
		if (!ctx.sessionManager) return;
		const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
			_rewriteFile?: () => void;
			flushed?: boolean;
		};
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile || typeof sessionManager._rewriteFile !== "function") return;
		fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
		sessionManager._rewriteFile();
		sessionManager.flushed = true;
	} catch (error) {
		console.error("Failed to persist slash session snapshot for export:", error);
	}
}

async function runSlashSubagent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: SubagentParamsLike,
): Promise<void> {
	const requestId = randomUUID();
	const initialDetails = buildSlashInitialResult(requestId, params);
	const initialText = extractSlashMessageText(initialDetails.result.content) || "Running subagent...";
	pi.sendMessage({
		customType: SLASH_RESULT_TYPE,
		content: initialText,
		display: true,
		details: initialDetails,
	});
	persistSlashSessionSnapshot(ctx);

	try {
		const response = await requestSlashRun(pi, ctx, requestId, params);
		const finalDetails = finalizeSlashResult(response);
		pi.sendMessage({
			customType: SLASH_RESULT_TYPE,
			content: buildSlashExportText(response),
			display: !ctx.hasUI,
			details: finalDetails,
		});
		persistSlashSessionSnapshot(ctx);
		if (ctx.hasUI) {
			ctx.ui.setStatus("subagent-slash", undefined);
		}
		if (response.isError && ctx.hasUI) {
			ctx.ui.notify(response.errorText || "Subagent failed", "error");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const failedDetails = failSlashResult(requestId, params, message);
		pi.sendMessage({
			customType: SLASH_RESULT_TYPE,
			content: `## Subagent result\n\n${message}`,
			display: !ctx.hasUI,
			details: failedDetails,
		});
		persistSlashSessionSnapshot(ctx);
		if (ctx.hasUI) {
			ctx.ui.setStatus("subagent-slash", undefined);
		}
		if (message === "Cancelled") {
			if (ctx.hasUI) ctx.ui.notify("Cancelled", "warning");
			return;
		}
		if (ctx.hasUI) ctx.ui.notify(message, "error");
	}
}

export function registerSlashCommands(
	pi: ExtensionAPI,
	state: SubagentState,
): void {
	pi.registerCommand("subagent-cost", {
		description: "Show parent and subagent child usage cost for this session",
		handler: async (_args, ctx) => {
			sendSlashText(pi, buildSubagentCostReport(ctx));
		},
	});

	pi.registerCommand("subagents-doctor", {
		description: "Show subagent diagnostics",
		handler: async (_args, ctx) => {
			await runSlashSubagent(pi, ctx, { action: "doctor" });
		},
	});

	pi.registerCommand("subagents-fleet", {
		description: "Show active subagent fleet status and transcript commands",
		handler: async (_args, ctx) => {
			await runSlashSubagent(pi, ctx, { action: "status", view: "fleet" });
		},
	});

	void state; // state parameter reserved for future slash command extensions
}

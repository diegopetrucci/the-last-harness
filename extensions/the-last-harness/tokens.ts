import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { formatHomePath } from "./common.js";
import {
	analyzeCurrentSessionUsage,
	type TlhAgentProviderUsage,
	type TlhCacheMissEvent,
	type TlhModelUsage,
	type TlhSanitizedReference,
	type TlhSessionUsageAnalysis,
	type TlhToolLatency,
	type TlhToolSourceUsage,
	type TlhToolUsage,
	type TlhUsageTimelineTurn,
	type TlhUsageTotals,
} from "./tokens-analyzer.js";

const TOKENS_COMMAND_HELP = "Usage: /tokens";
export const TOKENS_COMMAND_DESCRIPTION = "Generate and open a local TLH token-spend report";
const REPORT_FILE_NAME = "tokens-report.html";
const execFileAsync = promisify(execFile);
const INTEGER_FORMATTER = new Intl.NumberFormat("en-US");
const USD_FORMATTER = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
	maximumFractionDigits: 4,
});
const PERCENT_FORMATTER = new Intl.NumberFormat("en-US", {
	style: "percent",
	minimumFractionDigits: 0,
	maximumFractionDigits: 1,
});

type TokensCommandDependencies = {
	openReport?: (path: string) => Promise<void>;
	now?: () => Date;
	getPrimaryAgentLabel?: () => string | undefined;
};

type LocalTokensReport = {
	path: string;
	directory: string;
};

type OpenCommand = {
	command: string;
	args: string[];
};

export type TokensReportSessionManager = Pick<ExtensionContext["sessionManager"], "getSessionDir" | "getSessionFile">;

export function createTokensCommandHandler(pi: ExtensionAPI, dependencies: TokensCommandDependencies = {}) {
	const openReport = dependencies.openReport ?? openLocalReport;
	const now = dependencies.now ?? (() => new Date());
	const getPrimaryAgentLabel = dependencies.getPrimaryAgentLabel;

	return async (args: string, ctx: ExtensionContext): Promise<void> => {
		if (args.trim()) {
			ctx.ui.notify(TOKENS_COMMAND_HELP, "error");
			return;
		}

		try {
			const analysis = analyzeCurrentSessionUsage(ctx.sessionManager, typeof pi.getAllTools === "function" ? pi.getAllTools() : [], ctx.modelRegistry);
			let primaryAgentLabel: string | undefined;
			try {
				primaryAgentLabel = getPrimaryAgentLabel?.();
			} catch {
				// Fall back to default label if the source throws.
			}
			const html = buildTokensReportHtml(analysis, { generatedAt: now().toISOString(), primaryAgentLabel });
			const report = writeLocalTokensReport(ctx.sessionManager, html);

			try {
				await openReport(report.path);
				ctx.ui.notify(
					`Opened local TLH token report at ${formatHomePath(report.path)}. Delete ${formatHomePath(report.directory)} when you no longer need it.`,
					"info",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(
					`Generated local TLH token report at ${formatHomePath(report.path)}, but could not open it automatically: ${message}. Open the file manually and delete ${formatHomePath(report.directory)} when you no longer need it.`,
					"warning",
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Could not generate TLH token report: ${message}`, "error");
		}
	};
}

export function registerTokensCommand(pi: ExtensionAPI, dependencies: TokensCommandDependencies = {}): void {
	pi.registerCommand("tokens", {
		description: TOKENS_COMMAND_DESCRIPTION,
		handler: createTokensCommandHandler(pi, dependencies),
	});
}

export function buildTokensReportHtml(analysis: TlhSessionUsageAnalysis, options: { generatedAt?: string; primaryAgentLabel?: string } = {}): string {
	const generatedAt = options.generatedAt ?? new Date().toISOString();
	const primaryLabel = (options.primaryAgentLabel && options.primaryAgentLabel.trim()) ? options.primaryAgentLabel.trim() : "Primary assistant";
	const coverage = analysis.primaryAssistant.usageCoverage;
	const combinedCacheTotal =
		analysis.totals.combined.cacheReadTokens + analysis.totals.combined.cacheWriteTokens;
	const cacheTurns = analysis.primaryAssistant.timeline.filter(
		(turn) => turn.usage.cacheReadTokens > 0 || turn.usage.cacheWriteTokens > 0,
	);
	const privacyCaveat = "This local report omits raw transcript text, raw tool arguments, and raw tool-result payloads by design.";
	const coverageCaveat =
		coverage.withoutUsage > 0
			? `${coverage.withoutUsage} assistant turn${coverage.withoutUsage === 1 ? " was" : "s were"} missing provider usage data, so some totals may be incomplete.`
			: "All assistant turns on this session had provider usage data recorded.";
	const title = analysis.session.sessionName ? `TLH tokens report • ${analysis.session.sessionName}` : "TLH tokens report";

	return [
		"<!doctype html>",
		"<html lang=\"en\">",
		"<head>",
		"<meta charset=\"utf-8\">",
		"<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
		`<title>${escapeHtml(title)}</title>`,
		`<style>${TOKENS_REPORT_CSS}</style>`,
		"</head>",
		"<body>",
		"<main class=\"page\">",
		"<header class=\"hero\">",
		`<p class="eyebrow">${escapeHtml("Local/private TLH report")}</p>`,
		`<h1>${escapeHtml(title)}</h1>`,
		`<p class="lede">${escapeHtml("Built from sanitized session analysis only. No raw transcript text or raw tool payloads are embedded in this HTML.")}</p>`,
		`<p class="meta">Generated ${escapeHtml(generatedAt)}</p>`,
		"</header>",
		renderSection(
			"Overview",
			[
				"<div class=\"grid cards three\">",
				renderMetricCard("Combined total", formatInteger(analysis.totals.combined.totalTokens), `${formatCurrency(analysis.totals.combined.costUsd)} • ${formatInteger(analysis.totals.combined.turns)} turns`),
				renderMetricCard(primaryLabel, formatInteger(analysis.totals.primary.totalTokens), `${formatCurrency(analysis.totals.primary.costUsd)} • ${formatCoverage(coverage)}`),

				renderMetricCard("Subagents", formatInteger(analysis.totals.subagents.totalTokens), `${formatCurrency(analysis.totals.subagents.costUsd)} • ${formatInteger(analysis.subagents.runCount)} discovered runs`),
				"</div>",
				renderKeyValueGrid([
					["Session name", analysis.session.sessionName ?? "—"],
					["Session id", analysis.session.sessionId ?? "—"],
					["Started", analysis.session.startedAt ?? "—"],
					["Entries", formatInteger(analysis.session.entryCount)],
					["Leaves", formatInteger(analysis.session.leafCount)],
					[
						"Assistant turns",
						`${formatInteger(analysis.session.assistantTurnsOnActiveBranch)} active-branch • ${formatInteger(analysis.session.assistantTurnsOffActiveBranch)} off-branch`,
					],
					["Tool calls", formatInteger(analysis.tools.totalCalls)],
					["Cache tokens", `${formatInteger(combinedCacheTotal)} total • ${formatCacheShare(combinedCacheTotal, analysis.totals.combined.totalTokens)}`],
				]),
				renderUsageTotalsTable(analysis, primaryLabel),
			].join(""),
		),
		renderSection(
			"Tools/MCP",
			[
				"<div class=\"grid cards four\">",
				renderMetricCard("Tool calls", formatInteger(analysis.tools.totalCalls), `${formatInteger(analysis.tools.totalResults)} results`),
				renderMetricCard("Tool errors", formatInteger(analysis.tools.totalErrors), `${formatErrorRate(analysis.tools.totalErrors, analysis.tools.totalResults)} result error rate`),
				renderMetricCard("MCP calls", formatInteger(analysis.tools.mcpCalls), `${formatInteger(analysis.tools.mcpProxyCalls)} proxy • ${formatInteger(analysis.tools.mcpDirectCalls)} direct`),
				renderMetricCard("Source precision", analysis.tools.precision, "Estimated from tool names and current catalog"),
				renderMetricCard("MCP est. tokens", formatInteger(analysis.tools.mcpApproxTokens), `${formatInteger(analysis.tools.totalToolApproxTokens)} all-tools est.`),
				"</div>",
				renderToolSourceTable(analysis.tools.bySource),
				renderToolTable(analysis.tools.byTool),
			].join(""),
		),
		renderCacheMissesSection(analysis),
		renderSection(
			"Timeline",
			[
				`<p class="section-note">${escapeHtml("Each row is one assistant turn. Branch status, usage, tools, and discoveries are summarized without transcript text.")}</p>`,
				renderTimelineTable(analysis.primaryAssistant.timeline),
			].join(""),
		),
		renderSection(
			"Agents/subagents",
			[
				`<p class="section-note">${escapeHtml("Primary totals are exact where the provider reported usage. Subagent totals are discoverable-only and may undercount hidden work.")}</p>`,
				renderModelUsageTable(`${primaryLabel} models`, analysis.primaryAssistant.models),
				renderModelUsageTable("Discovered subagent models", analysis.subagents.models),
				renderSubagentRunsTable(analysis),
			].join(""),
		),
		renderSection(
			"Cache",
			[
				`<p class="section-note">${escapeHtml("Cache totals combine provider-reported cache read/write usage across primary assistant turns and any discovered subagent usage.")}</p>`,
				renderCacheTotalsTable(analysis, primaryLabel),
				renderCacheTimelineTable(cacheTurns),
			].join(""),
		),
		renderSection(
			"Caveats",
			[
				"<ul class=\"caveats\">",
				...([privacyCaveat, coverageCaveat, ...analysis.caveats].map((item) => `<li>${escapeHtml(item)}</li>`)),
				"</ul>",
			].join(""),
		),
		"</main>",
		"</body>",
		"</html>",
	].join("");
}

export function renderSection(title: string, body: string): string {
	return `<section class="section"><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

export function renderMetricCard(title: string, value: string, detail: string): string {
	return [
		'<article class="card">',
		`<p class="card-label">${escapeHtml(title)}</p>`,
		`<p class="card-value">${escapeHtml(value)}</p>`,
		`<p class="card-detail">${escapeHtml(detail)}</p>`,
		"</article>",
	].join("");
}

export function renderKeyValueGrid(items: Array<[string, string]>): string {
	return [
		'<dl class="kv-grid">',
		...items.flatMap(([label, value]) => [`<dt>${escapeHtml(label)}</dt>`, `<dd>${escapeHtml(value)}</dd>`]),
		"</dl>",
	].join("");
}

function renderUsageTotalsTable(analysis: TlhSessionUsageAnalysis, primaryLabel = "Primary assistant"): string {
	const em = "\u2014";
	const usageRow = (label: string, provider: string, usage: TlhUsageTotals): string[] => [
		label,
		provider,
		formatInteger(usage.inputTokens),
		formatInteger(usage.outputTokens),
		formatInteger(usage.cacheReadTokens),
		formatInteger(usage.cacheWriteTokens),
		formatInteger(usage.totalTokens),
		formatCurrency(usage.costUsd),
		formatInteger(usage.turns),
	];
	const subAgentRows: string[][] = analysis.subagents.byAgent.map((entry: TlhAgentProviderUsage) =>
		usageRow(entry.agent ?? "unknown", entry.provider ?? em, entry.usage),
	);
	const rows: string[][] = [
		usageRow(primaryLabel, em, analysis.totals.primary),
		...subAgentRows,
		usageRow("Subagents (all)", em, analysis.totals.subagents),
		usageRow("Combined", em, analysis.totals.combined),
	];
	return renderTable(
		["Bucket", "Provider", "Input", "Output", "Cache read", "Cache write", "Total", "Cost", "Turns"],
		rows,
		"No usage totals recorded.",
	);
}

function renderTimelineTable(timeline: TlhUsageTimelineTurn[]): string {
	return renderTable(
		["Turn", "Timestamp", "Branch", "Model", "Tokens", "Cache", "Tools", "Results", "Discoveries"],
		timeline.map((turn) => [
			String(turn.turnIndex),
			turn.timestamp,
			turn.activeBranch ? "active" : "off-branch",
			turn.modelId ? (turn.provider ? `${turn.provider}/${turn.modelId}` : turn.modelId) : "—",
			`${formatInteger(turn.usage.totalTokens)}${turn.usageReported ? "" : " (missing usage)"}`,
			formatCacheUsage(turn.usage),
			formatTimelineTools(turn),
			`${formatInteger(turn.toolResults.total)} total • ${formatInteger(turn.toolResults.errors)} errors`,
			formatTimelineDiscoveries(turn),
		]),
		"No assistant turns recorded.",
	);
}

function renderModelUsageTable(title: string, models: TlhModelUsage[]): string {
	return [
		`<h3>${escapeHtml(title)}</h3>`,
		renderTable(
			["Model", "Provider", "Tokens", "Cost", "Turns", "Assistant messages"],
			models.map((model) => [
				model.modelId,
				model.provider ?? "—",
				formatInteger(model.usage.totalTokens),
				formatCurrency(model.usage.costUsd),
				formatInteger(model.usage.turns),
				formatInteger(model.usage.assistantMessages),
			]),
			"None observed.",
		),
	].join("");
}

function renderSubagentRunsTable(analysis: TlhSessionUsageAnalysis): string {
	const rows = analysis.subagents.runs.map((run) => [
		run.agent ?? (run.agents?.join(", ") ?? "—"),
		run.mode ?? "—",
		run.model ?? (run.attemptedModels?.join(", ") ?? "—"),
		run.usage ? formatInteger(run.usage.totalTokens) : "—",
		run.usage ? formatCurrency(run.usage.costUsd) : "—",
		run.session?.label ?? "—",
		run.artifacts.length > 0 ? run.artifacts.map((artifact) => artifact.label).join(", ") : "—",
		formatRunStatus(run.success, run.exitCode),
	]);
	const references = [
		renderReferenceSummary("Sanitized session refs", analysis.references.sessions),
		renderReferenceSummary("Sanitized artifact refs", analysis.references.artifacts),
		renderIntercomSummary(analysis.references.intercomTargets),
	].join("");
	return [
		"<h3>Discovered subagent runs</h3>",
		renderTable(["Agent", "Mode", "Model", "Tokens", "Cost", "Session", "Artifacts", "Status"], rows, "No structured subagent runs discovered."),
		references,
	].join("");
}

function renderToolSourceTable(sources: TlhToolSourceUsage[]): string {
	return [
		"<h3>Tool sources</h3>",
		renderTable(
			["Source", "Kind", "Calls", "Est. tokens", "Tools", "Scope", "Origin"],
			sources.map((bucket) => [
				bucket.source.label,
				bucket.source.kind,
				formatInteger(bucket.callCount),
				formatInteger(bucket.approxTokens),
				bucket.tools.join(", "),
				bucket.source.scope ?? "—",
				bucket.source.origin ?? "—",
			]),
			"No tool source data recorded.",
		),
	].join("");
}

function renderToolTable(tools: TlhToolUsage[]): string {
	return [
		"<h3>Tools</h3>",
		`<p class="section-note">${escapeHtml("Obs. wall-clock latency is the elapsed time between the tool-call event and its result event in the session log — not tool execution time. It includes idle periods, supervisor pauses, and human hold time. Values exceeding several minutes usually indicate the run was paused awaiting input, not that the tool itself was slow. \u2018Med.\u2019 is the median across matched call/result pairs; \u2018\u2014\u2019 means no matched pairs (e.g. session still active or IDs unmatched).")}</p>`,
		renderTable(
			["Tool", "Source", "Calls", "Results", "Errors", "MCP", "Est. tokens", "Med. obs. wall-clock latency"],
			tools.map((tool) => [
				tool.toolName,
				tool.source.label,
				formatInteger(tool.callCount),
				formatInteger(tool.resultCount),
				formatInteger(tool.errorCount),
				tool.mcp ? "yes" : "no",
				formatInteger(tool.approxTokens),
				formatToolLatency(tool.observedLatency),
			]),
			"No tool calls recorded.",
		),
	].join("");
}

function renderCacheTotalsTable(analysis: TlhSessionUsageAnalysis, primaryLabel = "Primary assistant"): string {
	const rows: Array<[string, TlhUsageTotals]> = [
		[primaryLabel, analysis.totals.primary],
		["Subagents", analysis.totals.subagents],
		["Combined", analysis.totals.combined],
	];
	return renderTable(
		["Bucket", "Cache read", "Cache write", "Cache total", "Share of bucket total"],
		rows.map(([label, usage]) => {
			const cacheTotal = usage.cacheReadTokens + usage.cacheWriteTokens;
			return [
				label,
				formatInteger(usage.cacheReadTokens),
				formatInteger(usage.cacheWriteTokens),
				formatInteger(cacheTotal),
				formatCacheShare(cacheTotal, usage.totalTokens),
			];
		}),
		"No cache usage recorded.",
	);
}

function renderCacheTimelineTable(turns: TlhUsageTimelineTurn[]): string {
	return [
		"<h3>Assistant turns with cache activity</h3>",
		renderTable(
			["Turn", "Timestamp", "Model", "Cache read", "Cache write", "Cache share"],
			turns.map((turn) => {
				const cacheTotal = turn.usage.cacheReadTokens + turn.usage.cacheWriteTokens;
				return [
					String(turn.turnIndex),
					turn.timestamp,
					turn.modelId ? (turn.provider ? `${turn.provider}/${turn.modelId}` : turn.modelId) : "—",
					formatInteger(turn.usage.cacheReadTokens),
					formatInteger(turn.usage.cacheWriteTokens),
					formatCacheShare(cacheTotal, turn.usage.totalTokens),
				];
			}),
			"No primary assistant turns reported cache activity.",
		),
	].join("");
}

function renderCacheMissesSection(analysis: TlhSessionUsageAnalysis): string {
	const { cacheMisses } = analysis;
	const explanatoryNote = `<p class="section-note">${escapeHtml("A cache miss is prompt content that was sent on an earlier turn but had to be re-sent and re-billed at full price instead of being served from the provider's prompt cache. Misses commonly happen after an idle gap longer than the cache TTL (~5 min), when the model is switched mid-session, or after a context reset (compaction). Only misses above a small noise floor are counted.")}</p>`;

	if (cacheMisses.missCount === 0) {
		return renderSection(
			"Cache misses",
			[
				explanatoryNote,
				`<p class="section-note">${escapeHtml("No significant cache misses detected.")}</p>`,
			].join(""),
		);
	}

	return renderSection(
		"Cache misses",
		[
			explanatoryNote,
			"<div class=\"grid cards three\">",
			renderMetricCard("Missed tokens", formatInteger(cacheMisses.missedTokens), ""),
			renderMetricCard("Extra cost", formatCurrency(cacheMisses.missedCost), ""),
			renderMetricCard("Miss count", formatInteger(cacheMisses.missCount), ""),
			"</div>",
			renderWorstMissesTable(cacheMisses.worst),
		].join(""),
	);
}

function renderWorstMissesTable(worst: TlhCacheMissEvent[]): string {
	return renderTable(
		["Turn", "Idle gap", "Model changed", "Missed tokens", "Extra cost"],
		worst.map((event) => [
			String(event.turnIndex + 1),
			formatIdleMs(event.idleMs),
			event.modelChanged ? "yes" : "no",
			formatInteger(event.missedTokens),
			formatCurrency(event.missedCost),
		]),
		"No significant cache miss events recorded.",
	);
}

function renderReferenceSummary(title: string, refs: TlhSanitizedReference[]): string {
	return [
		`<h3>${escapeHtml(title)}</h3>`,
		refs.length > 0
			? `<p class="text-list">${escapeHtml(refs.map((ref) => ref.label).join(", "))}</p>`
			: '<p class="empty">None observed.</p>',
	].join("");
}

function renderIntercomSummary(targets: string[]): string {
	return [
		`<h3>${escapeHtml("Intercom targets")}</h3>`,
		targets.length > 0
			? `<p class="text-list">${escapeHtml(targets.join(", "))}</p>`
			: '<p class="empty">None observed.</p>',
	].join("");
}

export function renderTable(headers: string[], rows: string[][], emptyMessage: string): string {
	if (rows.length === 0) {
		return `<p class="empty">${escapeHtml(emptyMessage)}</p>`;
	}
	return [
		"<div class=\"table-wrap\"><table><thead><tr>",
		...headers.map((header) => `<th>${escapeHtml(header)}</th>`),
		"</tr></thead><tbody>",
		...rows.map(
			(row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`,
		),
		"</tbody></table></div>",
	].join("");
}

export function writeLocalTokensReport(sessionManager: TokensReportSessionManager, html: string, fileName: string = REPORT_FILE_NAME): LocalTokensReport {
	const reportDirectory = createPrivateReportDirectory(preferredReportParent(sessionManager));
	const reportPath = join(reportDirectory, fileName);
	writeFileSync(reportPath, html, { encoding: "utf8", flag: "wx", mode: 0o600 });
	setPrivateMode(reportPath, 0o600);
	return { path: reportPath, directory: reportDirectory };
}

function preferredReportParent(sessionManager: TokensReportSessionManager): string | undefined {
	const sessionFile = sessionManager.getSessionFile();
	if (sessionFile) {
		const parent = dirname(sessionFile);
		if (existsSync(parent)) {
			return parent;
		}
	}
	const sessionDir = sessionManager.getSessionDir();
	if (sessionDir && existsSync(sessionDir)) {
		return sessionDir;
	}
	return undefined;
}

function createPrivateReportDirectory(preferredParent?: string): string {
	const parents = dedupeParents([preferredParent, tmpdir()]);
	let lastError: unknown;
	for (const parent of parents) {
		try {
			const prefix = join(parent, parent === tmpdir() ? "tlh-tokens-" : ".tlh-tokens-");
			const directory = mkdtempSync(prefix);
			setPrivateMode(directory, 0o700);
			return directory;
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError instanceof Error ? lastError : new Error("Could not create a private local report directory.");
}

export async function openLocalReport(path: string): Promise<void> {
	let lastError: unknown;
	for (const command of buildOpenReportCommands(path)) {
		try {
			await execFileAsync(command.command, command.args, {
				windowsHide: process.platform === "win32",
				timeout: 10_000,
			});
			return;
		} catch (error) {
			lastError = error;
		}
	}
	throw normalizeOpenError(lastError);
}

function buildOpenReportCommands(path: string, platform: NodeJS.Platform = process.platform): OpenCommand[] {
	switch (platform) {
		case "darwin":
			return [{ command: "open", args: [path] }];
		case "win32":
			return [{ command: "cmd.exe", args: ["/d", "/s", "/c", `start "" "${path.replaceAll('"', '""')}"`] }];
		default:
			return [
				{ command: "xdg-open", args: [path] },
				{ command: "gio", args: ["open", path] },
			];
	}
}

function normalizeOpenError(error: unknown): Error {
	if (error instanceof Error) {
		return error;
	}
	return new Error(error ? String(error) : "Unknown report-open error.");
}

function setPrivateMode(path: string, mode: number): void {
	if (process.platform === "win32") {
		return;
	}
	try {
		chmodSync(path, mode);
	} catch {
		// Best effort only. The file contents remain local even if chmod is unsupported.
	}
}

function dedupeParents(values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function formatInteger(value: number): string {
	return INTEGER_FORMATTER.format(value);
}

function formatCurrency(value: number): string {
	return USD_FORMATTER.format(value);
}

function formatCoverage(coverage: TlhSessionUsageAnalysis["primaryAssistant"]["usageCoverage"]): string {
	if (coverage.assistantMessages === 0) {
		return "0 of 0 turns reported usage";
	}
	return `${formatInteger(coverage.withUsage)} of ${formatInteger(coverage.assistantMessages)} turns reported usage`;
}

function formatCacheUsage(usage: TlhUsageTotals): string {
	const cacheTotal = usage.cacheReadTokens + usage.cacheWriteTokens;
	if (cacheTotal === 0) {
		return "none";
	}
	return `${formatInteger(usage.cacheReadTokens)} read • ${formatInteger(usage.cacheWriteTokens)} write`;
}

function formatTimelineTools(turn: TlhUsageTimelineTurn): string {
	if (turn.toolCalls.byTool.length === 0) {
		return "none";
	}
	const tools = turn.toolCalls.byTool.map((tool) => `${tool.toolName} ×${tool.count}`).join(", ");
	return `${tools}${turn.toolCalls.mcp > 0 ? ` • ${formatInteger(turn.toolCalls.mcp)} MCP` : ""}`;
}

function formatTimelineDiscoveries(turn: TlhUsageTimelineTurn): string {
	const parts: string[] = [];
	if (turn.discoveries.subagentRuns > 0) {
		parts.push(`${formatInteger(turn.discoveries.subagentRuns)} subagent`);
	}
	if (turn.discoveries.artifactReferences > 0) {
		parts.push(`${formatInteger(turn.discoveries.artifactReferences)} artifact`);
	}
	if (turn.discoveries.sessionReferences > 0) {
		parts.push(`${formatInteger(turn.discoveries.sessionReferences)} session`);
	}
	if (turn.discoveries.intercomTargets > 0) {
		parts.push(`${formatInteger(turn.discoveries.intercomTargets)} intercom`);
	}
	return parts.length > 0 ? parts.join(" • ") : "none";
}

function formatRunStatus(success: boolean | undefined, exitCode: number | undefined): string {
	const status = success === undefined ? "unknown" : success ? "success" : "failure";
	if (exitCode === undefined) {
		return status;
	}
	return `${status} • exit ${formatInteger(exitCode)}`;
}

function formatCacheShare(cacheTokens: number, totalTokens: number): string {
	if (cacheTokens === 0 || totalTokens === 0) {
		return "0%";
	}
	return PERCENT_FORMATTER.format(cacheTokens / totalTokens);
}

function formatToolLatency(latency: TlhToolLatency | undefined): string {
	if (!latency || latency.pairedCount === 0) {
		return "\u2014";
	}
	return formatWallClockMs(latency.medianMs);
}

function formatWallClockMs(ms: number): string {
	if (ms < 1_000) {
		return `${ms}ms`;
	}
	if (ms < 60_000) {
		return `${Math.round(ms / 100) / 10}s`;
	}
	if (ms < 3_600_000) {
		return `${Math.round(ms / 60_000)}min`;
	}
	return `${Math.round((ms / 3_600_000) * 10) / 10}h`;
}

function formatIdleMs(ms: number): string {
	if (ms < 60_000) {
		return `${Math.round(ms / 1000)}s`;
	}
	return `${Math.round(ms / 60_000)} min`;
}

function formatErrorRate(errors: number, results: number): string {
	if (errors === 0 || results === 0) {
		return "0%";
	}
	return PERCENT_FORMATTER.format(errors / results);
}

export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

export const TOKENS_REPORT_CSS = `
:root {
	color-scheme: light dark;
	font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	background: #0b1020;
	color: #e5ecff;
}
body {
	margin: 0;
	background: linear-gradient(180deg, #09111f 0%, #111827 100%);
	color: inherit;
}
.page {
	max-width: 1200px;
	margin: 0 auto;
	padding: 32px 20px 56px;
}
.hero,
.section {
	background: rgba(15, 23, 42, 0.82);
	border: 1px solid rgba(148, 163, 184, 0.22);
	border-radius: 18px;
	padding: 24px;
	box-shadow: 0 18px 48px rgba(0, 0, 0, 0.22);
}
.hero {
	margin-bottom: 20px;
}
.section + .section {
	margin-top: 20px;
}
h1,
 h2,
 h3,
 p,
 dl {
	margin-top: 0;
}
h1 {
	font-size: 2.1rem;
	margin-bottom: 12px;
}
h2 {
	font-size: 1.35rem;
	margin-bottom: 16px;
}
h3 {
	font-size: 1rem;
	margin: 20px 0 12px;
}
.eyebrow,
.meta,
.card-label,
.card-detail,
.section-note,
.empty,
.text-list,
.kv-grid dt,
.kv-grid dd {
	color: #bfdbfe;
}
.lede {
	font-size: 1rem;
	max-width: 76ch;
}
.grid {
	display: grid;
	gap: 12px;
}
.cards {
	margin-bottom: 16px;
}
.cards.three {
	grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}
.cards.four {
	grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
}
.card {
	background: rgba(30, 41, 59, 0.72);
	border: 1px solid rgba(148, 163, 184, 0.16);
	border-radius: 14px;
	padding: 16px;
}
.card-label {
	font-size: 0.82rem;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	margin-bottom: 8px;
}
.card-value {
	font-size: 1.5rem;
	font-weight: 700;
	margin: 0 0 6px;
}
.card-detail {
	margin-bottom: 0;
}
.kv-grid {
	display: grid;
	grid-template-columns: max-content 1fr;
	gap: 8px 14px;
	margin-bottom: 16px;
}
.kv-grid dt {
	font-weight: 600;
}
.kv-grid dd {
	margin: 0;
}
.table-wrap {
	overflow-x: auto;
	margin-top: 12px;
}
table {
	width: 100%;
	border-collapse: collapse;
	font-size: 0.95rem;
}
th,
 td {
	padding: 10px 12px;
	border-bottom: 1px solid rgba(148, 163, 184, 0.16);
	text-align: left;
	vertical-align: top;
}
th {
	font-size: 0.84rem;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	color: #bfdbfe;
}
.caveats {
	margin: 0;
	padding-left: 20px;
}
.caveats li + li {
	margin-top: 8px;
}
@media (max-width: 700px) {
	.page {
		padding: 20px 12px 40px;
	}
	.hero,
	.section {
		padding: 18px;
	}
	h1 {
		font-size: 1.7rem;
	}
}
`;

export const __testing = {
	buildOpenReportCommands,
	writeLocalTokensReport,
};

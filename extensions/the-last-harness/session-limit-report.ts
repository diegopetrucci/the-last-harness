import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { formatHomePath } from "./common.js";
import {
  aggregateSessionUsage,
  type SessionAggregateResult,
  type SessionAggregateRow,
} from "./session-limit-report-aggregator.js";
import {
  discoverSessionFiles,
  parseSessionJsonl,
  resolveSessionLimitWindow,
  type RawSessionEntry,
  type SessionLimitWindow,
} from "./session-limit-report-scan.js";
import {
  escapeHtml,
  openLocalReport,
  renderMetricCard,
  renderSection,
  renderTable,
  TOKENS_REPORT_CSS,
  type TokensReportSessionManager,
  writeLocalTokensReport,
} from "./tokens.js";
import type { TlhSubscriptionUsageSnapshot } from "./types.js";

export const SESSION_LIMIT_REPORT_COMMAND_NAME = "what-consumed-my-session-limit-and-tokens";
export const SESSION_LIMIT_REPORT_COMMAND_DESCRIPTION =
  "Generate and open a local TLH session-limit usage report across all in-window sessions";
const COMMAND_HELP = `Usage: /${SESSION_LIMIT_REPORT_COMMAND_NAME}`;
const REPORT_FILE_NAME = "session-limit-report.html";

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

type SessionLimitReportDependencies = {
  /** Override for opening the report (injectable for tests). */
  openReport?: (path: string) => Promise<void>;
  /** Override for current time (injectable for tests). */
  now?: () => Date;
  /** Override for snapshot retrieval (injectable for tests). Pass ctx to get snapshot. */
  getSnapshot?: (ctx: ExtensionContext) => TlhSubscriptionUsageSnapshot | undefined;
};

export function createSessionLimitReportCommandHandler(
  _pi: ExtensionAPI,
  dependencies: SessionLimitReportDependencies = {},
) {
  const openReport = dependencies.openReport ?? openLocalReport;
  const now = dependencies.now ?? (() => new Date());
  const getSnapshot = dependencies.getSnapshot ?? (() => undefined);

  return async (args: string, ctx: ExtensionContext): Promise<void> => {
    if (args.trim()) {
      ctx.ui.notify(COMMAND_HELP, "error");
      return;
    }

    try {
      const sessionDir = ctx.sessionManager.getSessionDir();
      if (!sessionDir) {
        ctx.ui.notify("Could not determine session directory for session-limit report.", "error");
        return;
      }

      const sessionsRoot = dirname(sessionDir);
      if (!existsSync(sessionsRoot)) {
        ctx.ui.notify(
          `Sessions directory not found at ${formatHomePath(sessionsRoot)}. Cannot generate session-limit report.`,
          "error",
        );
        return;
      }

      const nowMs = now().getTime();
      const snapshot = getSnapshot(ctx);
      const window = resolveSessionLimitWindow(snapshot, nowMs);

      const { files, caveats: scanCaveats } = discoverSessionFiles(sessionsRoot, window.startMs);

      const parsedFiles: Array<{
        filePath: string;
        entries: RawSessionEntry[];
        malformedLineCount: number;
      }> = [];
      const parseFailureCaveats: string[] = [];

      for (const filePath of files) {
        try {
          const parsed = await parseSessionJsonl(filePath);
          const slimmedEntries = slimEntries(parsed.entries);
          parsedFiles.push({
            filePath,
            entries: slimmedEntries,
            malformedLineCount: parsed.malformedLineCount,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          parseFailureCaveats.push(`Could not read session file ${basename(filePath)}: ${message}`);
        }
      }

      const result = aggregateSessionUsage(window, sessionsRoot, parsedFiles, [
        ...scanCaveats,
        ...parseFailureCaveats,
      ]);
      const html = buildSessionLimitReportHtml(window, result, snapshot, nowMs, {
        generatedAt: now().toISOString(),
      });

      const sessionManager: TokensReportSessionManager = ctx.sessionManager;
      const report = writeLocalTokensReport(sessionManager, html, REPORT_FILE_NAME);

      try {
        await openReport(report.path);
        ctx.ui.notify(
          `Opened local TLH session-limit report at ${formatHomePath(report.path)}. Delete ${formatHomePath(report.directory)} when you no longer need it.`,
          "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(
          `Generated local TLH session-limit report at ${formatHomePath(report.path)}, but could not open it automatically: ${message}. Open the file manually and delete ${formatHomePath(report.directory)} when you no longer need it.`,
          "warning",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not generate TLH session-limit report: ${message}`, "error");
    }
  };
}

// ---------------------------------------------------------------------------
// Entry slimming
// ---------------------------------------------------------------------------

/**
 * Slim parsed session entries before retaining them in memory.
 *
 * Keeps only the entry types needed for aggregation:
 *   - `"session"` and `"session_info"`: header metadata (id, name, cwd, timestamp).
 *   - `"model_change"`: provider / model tracking.
 *   - `"message"` with `role === "assistant"`: usage accounting only; content and
 *     thinking payloads are stripped, keeping just
 *     `{ type, timestamp, message: { role, usage, provider, model } }`.  `provider`
 *     and `model` are short identifier strings retained for authoritative per-turn
 *     attribution (they are not transcript content).
 *
 * All other entry types (user messages, tool calls, etc.) are discarded.
 * This bounds peak memory and guarantees that no transcript text reaches later stages.
 */
function slimEntries(entries: RawSessionEntry[]): RawSessionEntry[] {
  const result: RawSessionEntry[] = [];
  for (const entry of entries) {
    if (
      entry.type === "session" ||
      entry.type === "session_info" ||
      entry.type === "model_change"
    ) {
      result.push(entry);
      continue;
    }
    if (entry.type === "message") {
      const message = entry.message;
      if (
        message !== null &&
        typeof message === "object" &&
        !Array.isArray(message) &&
        (message as Record<string, unknown>).role === "assistant"
      ) {
        const msg = message as Record<string, unknown>;
        result.push({
          type: entry.type,
          timestamp: entry.timestamp,
          message: { role: msg.role, usage: msg.usage, provider: msg.provider, model: msg.model },
        } as RawSessionEntry);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// HTML report builder
// ---------------------------------------------------------------------------

export function buildSessionLimitReportHtml(
  window: SessionLimitWindow,
  result: SessionAggregateResult,
  snapshot: TlhSubscriptionUsageSnapshot | undefined,
  nowMs: number,
  options: { generatedAt?: string } = {},
): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const title = "TLH session-limit report";

  const sessionWindow = snapshot?.windows?.session;
  const provider = snapshot?.provider ?? "—";
  const percentUsed = sessionWindow?.percent;
  const resetsAtRaw = sessionWindow?.resetsAt;
  const resetsAtMs = resetsAtRaw ? Date.parse(resetsAtRaw) : NaN;

  const resetsInDisplay = Number.isFinite(resetsAtMs) ? formatResetsIn(resetsAtMs - nowMs) : "—";
  const percentDisplay = percentUsed != null ? PERCENT_FORMATTER.format(percentUsed / 100) : "—";
  const windowStartDisplay = new Date(window.startMs).toISOString();
  const windowEndDisplay = new Date(window.endMs).toISOString();
  const resolutionSourceDisplay =
    window.source === "snapshot" ? "provider snapshot" : "fallback (5h trailing)";

  // Caveats — required items come first
  const requiredCaveats = [
    "Relative attribution only: local token counts do not equal provider quota accounting.",
    "External consumers (claude.ai, Claude Code, vanilla pi, other machines) are not visible to this report.",
    "This report contains no raw transcript text or tool payloads.",
  ];
  if (window.source === "fallback") {
    requiredCaveats.push(
      "Fallback window: no subscription usage snapshot was available; showing a trailing 5-hour window ending now. Results may not align with your actual provider quota window.",
    );
  }
  const allCaveats = [...requiredCaveats, ...result.caveats];

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${TOKENS_REPORT_CSS}</style>`,
    "</head>",
    "<body>",
    '<main class="page">',
    '<header class="hero">',
    `<p class="eyebrow">${escapeHtml("Local/private TLH report")}</p>`,
    `<h1>${escapeHtml(title)}</h1>`,
    `<p class="lede">${escapeHtml("Covers all TLH sessions within the current session-limit window. No raw transcript text or tool payloads are embedded in this HTML.")}</p>`,
    `<p class="meta">Generated ${escapeHtml(generatedAt)}</p>`,
    "</header>",
    renderSection(
      "Window",
      [
        '<div class="grid cards three">',
        renderMetricCard("Provider", provider, ""),
        renderMetricCard("Session usage", percentDisplay, "of session limit used"),
        renderMetricCard("Resets in", resetsInDisplay, ""),
        "</div>",
        renderKeyValueCard([
          ["Window start", windowStartDisplay],
          ["Window end", windowEndDisplay],
          ["Resolution source", resolutionSourceDisplay],
          ["Sessions found", formatInteger(result.rows.length)],
          ["Grand total tokens", formatInteger(result.grandTotals.totalTokens)],
          ["Grand total turns", formatInteger(result.grandTotals.turns)],
        ]),
      ].join(""),
    ),
    renderSection(
      "Sessions",
      [
        `<p class="section-note">${escapeHtml("Sessions ranked by in-window token usage, descending. Coverage shows how many assistant turns had provider usage data.")}</p>`,
        renderSessionsTable(result.rows),
      ].join(""),
    ),
    renderSection(
      "Per-provider totals",
      [
        `<p class="section-note">${escapeHtml("Totals summed across all sessions in the window, broken down by provider.")}</p>`,
        renderProviderTotalsTable(result),
      ].join(""),
    ),
    renderSection(
      "Caveats",
      [
        '<ul class="caveats">',
        ...allCaveats.map((item) => `<li>${escapeHtml(item)}</li>`),
        "</ul>",
      ].join(""),
    ),
    "</main>",
    "</body>",
    "</html>",
  ].join("");
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderKeyValueCard(items: Array<[string, string]>): string {
  return [
    '<dl class="kv-grid">',
    ...items.flatMap(([label, value]) => [
      `<dt>${escapeHtml(label)}</dt>`,
      `<dd>${escapeHtml(value)}</dd>`,
    ]),
    "</dl>",
  ].join("");
}

function renderSessionsTable(rows: SessionAggregateRow[]): string {
  if (rows.length === 0) {
    return `<p class="empty">${escapeHtml("No sessions found in the window.")}</p>`;
  }
  return renderTable(
    [
      "#",
      "Project",
      "Session",
      "Kind",
      "Providers",
      "Input",
      "Output",
      "Cache read",
      "Cache write",
      "Total",
      "Cost (USD)",
      "Turns",
      "Coverage",
    ],
    rows.map((row, index) => {
      const sessionLabel = row.sessionName
        ? `${row.sessionName}${row.sessionId ? ` (${row.sessionId.slice(0, 8)})` : ""}`
        : row.sessionId
          ? row.sessionId.slice(0, 8)
          : "—";
      const providers = row.providerTotals.map((pt) => pt.provider).join(", ") || "—";
      const coverage =
        row.coverage.assistantMessages > 0
          ? `${formatInteger(row.coverage.withUsage)}/${formatInteger(row.coverage.assistantMessages)}`
          : "0/0";
      return [
        String(index + 1),
        row.projectLabel,
        sessionLabel,
        row.fileKind === "primary" ? "primary" : "subagent",
        providers,
        formatInteger(row.windowTotals.inputTokens),
        formatInteger(row.windowTotals.outputTokens),
        formatInteger(row.windowTotals.cacheReadTokens),
        formatInteger(row.windowTotals.cacheWriteTokens),
        formatInteger(row.windowTotals.totalTokens),
        formatCurrency(row.windowTotals.costUsd),
        formatInteger(row.windowTotals.turns),
        coverage,
      ];
    }),
    "No sessions found in the window.",
  );
}

function renderProviderTotalsTable(result: SessionAggregateResult): string {
  const { perProviderTotals, grandTotals } = result;
  if (perProviderTotals.length === 0) {
    return `<p class="empty">${escapeHtml("No in-window provider usage recorded.")}</p>`;
  }
  const rows: string[][] = [
    ...perProviderTotals.map((pt) => [
      pt.provider,
      formatInteger(pt.usage.inputTokens),
      formatInteger(pt.usage.outputTokens),
      formatInteger(pt.usage.cacheReadTokens),
      formatInteger(pt.usage.cacheWriteTokens),
      formatInteger(pt.usage.totalTokens),
      formatCurrency(pt.usage.costUsd),
      formatInteger(pt.usage.turns),
    ]),
    // Grand totals row
    [
      "All providers",
      formatInteger(grandTotals.inputTokens),
      formatInteger(grandTotals.outputTokens),
      formatInteger(grandTotals.cacheReadTokens),
      formatInteger(grandTotals.cacheWriteTokens),
      formatInteger(grandTotals.totalTokens),
      formatCurrency(grandTotals.costUsd),
      formatInteger(grandTotals.turns),
    ],
  ];
  return renderTable(
    ["Provider", "Input", "Output", "Cache read", "Cache write", "Total", "Cost (USD)", "Turns"],
    rows,
    "No provider usage data.",
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatInteger(value: number): string {
  return INTEGER_FORMATTER.format(value);
}

function formatCurrency(value: number): string {
  return USD_FORMATTER.format(value);
}

function formatResetsIn(deltaMs: number): string {
  if (deltaMs <= 0) {
    return "soon";
  }
  const totalSeconds = Math.round(deltaMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return "< 1m";
}

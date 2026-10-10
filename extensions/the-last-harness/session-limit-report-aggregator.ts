import { basename, relative } from "node:path";

import type { TlhUsageCoverage, TlhUsageTotals } from "./tokens-analyzer.js";
import { addUsage, createUsageTotals, normalizeUsage } from "./tokens-analyzer.js";
import type { RawSessionEntry } from "./session-limit-report-scan.js";

type AggregationWindow = {
  startMs: number;
  endMs: number;
};

type ParsedSessionFileInput = {
  filePath: string;
  entries: RawSessionEntry[];
  malformedLineCount: number;
};

type SessionProviderTotals = {
  /** Per-message `provider`, else the latest `model_change`, else `"unknown"`. */
  provider: string;
  modelId?: string;
  usage: TlhUsageTotals;
};

export type SessionAggregateRow = {
  filePath: string;
  /**
   * `primary` at depth 2 (`<proj>/<file>.jsonl`); `subagent-child` when deeper.
   */
  fileKind: "primary" | "subagent-child";
  /**
   * `basename(cwd)` from the session header or `session_info` when present.
   * Otherwise the Pi-escaped project directory (`--Users-foo-my-project--` → `my-project`).
   * That encoding is lossy: hyphens in path components are indistinguishable from
   * separators, so the fallback keeps the last non-empty segment after replacing `-` with `/`.
   */
  projectLabel: string;
  sessionId?: string;
  /**
   * Latest `session_info.name`, otherwise the session header `name`.
   */
  sessionName?: string;
  providerTotals: SessionProviderTotals[];
  windowTotals: TlhUsageTotals;
  coverage: TlhUsageCoverage;
  malformedLineCount: number;
};

export type SessionAggregateResult = {
  /** Zero-usage files stay so coverage is preserved. */
  rows: SessionAggregateRow[];
  perProviderTotals: SessionProviderTotals[];
  grandTotals: TlhUsageTotals;
  caveats: string[];
};

/**
 * Usage is counted only from entries in the provided files. Discovered-subagent
 * totals embedded in tokens-analyzer output are not included, which prevents
 * double-counting of child session usage.
 */
export function aggregateSessionUsage(
  window: AggregationWindow,
  sessionsRoot: string,
  parsedFiles: ParsedSessionFileInput[],
  scanCaveats: string[] = [],
): SessionAggregateResult {
  const caveats: string[] = [...scanCaveats];
  const providerTotalsMap = new Map<string, SessionProviderTotals>();
  const grandTotals = createUsageTotals();
  const rows: SessionAggregateRow[] = [];

  for (const file of parsedFiles) {
    const row = aggregateFile(window, sessionsRoot, file, caveats);
    rows.push(row);

    for (const pt of row.providerTotals) {
      const existing = providerTotalsMap.get(pt.provider);
      if (existing) {
        addUsage(existing.usage, pt.usage);
      } else {
        providerTotalsMap.set(pt.provider, {
          provider: pt.provider,
          modelId: pt.modelId,
          usage: { ...pt.usage },
        });
      }
    }

    addUsage(grandTotals, row.windowTotals);
  }

  rows.sort((a, b) => b.windowTotals.totalTokens - a.windowTotals.totalTokens);

  const perProviderTotals = [...providerTotalsMap.values()].sort(
    (a, b) => b.usage.totalTokens - a.usage.totalTokens,
  );

  return { rows, perProviderTotals, grandTotals, caveats };
}

function aggregateFile(
  window: AggregationWindow,
  sessionsRoot: string,
  file: ParsedSessionFileInput,
  caveats: string[],
): SessionAggregateRow {
  const { filePath, entries, malformedLineCount } = file;

  const fileKind = classifyFileKind(filePath, sessionsRoot);

  let sessionId: string | undefined;
  let sessionHeaderName: string | undefined;
  let sessionInfoName: string | undefined;
  let sessionCwd: string | undefined;
  let currentProvider = "unknown";
  let currentModelId: string | undefined;

  const providerUsageMap = new Map<string, SessionProviderTotals>();
  const windowTotals = createUsageTotals();
  const coverage: TlhUsageCoverage = { assistantMessages: 0, withUsage: 0, withoutUsage: 0 };

  for (const entry of entries) {
    if (entry.type === "session") {
      if (sessionId === undefined && typeof entry.id === "string") {
        sessionId = entry.id;
      }
      if (sessionHeaderName === undefined && typeof entry.name === "string") {
        sessionHeaderName = entry.name;
      }
      if (sessionCwd === undefined && typeof entry.cwd === "string" && entry.cwd.length > 0) {
        sessionCwd = entry.cwd;
      }
      continue;
    }

    if (entry.type === "session_info") {
      // session_info records user-visible renames; later entry wins.
      if (typeof entry.name === "string" && entry.name.length > 0) {
        sessionInfoName = entry.name;
      }
      if (sessionCwd === undefined && typeof entry.cwd === "string" && entry.cwd.length > 0) {
        sessionCwd = entry.cwd;
      }
      continue;
    }

    if (entry.type === "model_change") {
      if (typeof entry.provider === "string" && entry.provider.length > 0) {
        currentProvider = entry.provider;
      }
      currentModelId = typeof entry.modelId === "string" ? entry.modelId : undefined;
      continue;
    }

    if (entry.type !== "message") {
      continue;
    }

    const message = entry.message;
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }

    const entryTs = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(entryTs) || entryTs < window.startMs || entryTs > window.endMs) {
      continue;
    }

    coverage.assistantMessages += 1;

    const usage = normalizeUsage(message.usage);
    if (usage) {
      coverage.withUsage += 1;

      // Prefer per-message provider/model (authoritative, branch-aware); fall back
      // to the most recent model_change tracking when the message fields are absent.
      const msgProvider =
        typeof message.provider === "string" && (message.provider as string).length > 0
          ? (message.provider as string)
          : undefined;
      const msgModel =
        typeof message.model === "string" && (message.model as string).length > 0
          ? (message.model as string)
          : undefined;
      const turnProvider = msgProvider ?? currentProvider;
      const turnModelId = msgModel ?? currentModelId;

      const existing = providerUsageMap.get(turnProvider);
      if (existing) {
        addUsage(existing.usage, usage, { turns: 1, assistantMessages: 1 });
        existing.modelId = turnModelId;
      } else {
        const providerTotals = createUsageTotals();
        addUsage(providerTotals, usage, { turns: 1, assistantMessages: 1 });
        providerUsageMap.set(turnProvider, {
          provider: turnProvider,
          modelId: turnModelId,
          usage: providerTotals,
        });
      }

      addUsage(windowTotals, usage, { turns: 1, assistantMessages: 1 });
    } else {
      coverage.withoutUsage += 1;
      windowTotals.turns += 1;
      windowTotals.assistantMessages += 1;
    }
  }

  if (coverage.withoutUsage > 0) {
    caveats.push(
      `${basename(filePath)}: ${coverage.withoutUsage} of ${coverage.assistantMessages} in-window assistant message(s) had no usage data`,
    );
  }
  if (malformedLineCount > 0) {
    caveats.push(`${basename(filePath)}: ${malformedLineCount} malformed line(s) skipped`);
  }

  const providerTotals = [...providerUsageMap.values()].sort(
    (a, b) => b.usage.totalTokens - a.usage.totalTokens,
  );

  const projectLabel = sessionCwd
    ? basename(sessionCwd)
    : deriveProjectLabel(filePath, sessionsRoot);

  const sessionName = sessionInfoName ?? sessionHeaderName;

  return {
    filePath,
    fileKind,
    projectLabel,
    sessionId,
    sessionName,
    providerTotals,
    windowTotals,
    coverage,
    malformedLineCount,
  };
}

function classifyFileKind(filePath: string, sessionsRoot: string): "primary" | "subagent-child" {
  const rel = relative(sessionsRoot, filePath);
  // Supported sessions roots are POSIX paths; splitting on `/` is intentional.
  const parts = rel.split("/").filter((p) => p.length > 0);
  return parts.length <= 2 ? "primary" : "subagent-child";
}

function deriveProjectLabel(filePath: string, sessionsRoot: string): string {
  const rel = relative(sessionsRoot, filePath);
  const parts = rel.split("/").filter((p) => p.length > 0);
  const projDir = parts[0] ?? "";
  return decodeProjectDirName(projDir);
}

export function decodeProjectDirName(dirName: string): string {
  if (dirName.startsWith("--") && dirName.endsWith("--") && dirName.length > 4) {
    const inner = dirName.slice(2, -2);
    const segments = inner.split("-").filter((s) => s.length > 0);
    const lastSegment = segments[segments.length - 1];
    return lastSegment ?? dirName;
  }
  return dirName;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

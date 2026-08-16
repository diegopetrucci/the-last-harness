#!/usr/bin/env node
/**
 * tlh-sessions — read-only session analysis CLI.
 *
 * Emits JSON to stdout so callers can pipe to jq.
 * Never writes to or mutates session files.
 * Never reads run-history.jsonl.
 *
 * This script is for out-of-process CLI use only.  Do NOT import it from
 * the extension startup path.
 */

import { createHash } from "node:crypto";
import { readdirSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import {
  aggregateCoverage,
  extractSubagentCorrelations,
  scanSessionFile,
  type ExtraCoverageData,
  type ScanCoverage,
  type SessionScanResult,
} from "./lib/session-analysis.mjs";
import { resolveTlhAgentDir } from "./lib/tlh-install-utils.mjs";
import { computeMedian } from "../extensions/the-last-harness/tool-pairing.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = "1";

/**
 * Required timing-quality label.  Every output object carries this field to
 * make clear that `observedLatencyMs` is wall-clock, not execution time.
 */
const TIMING_QUALITY_NOTE =
  "observedLatencyMs is wall-clock between recorded events; includes queueing, subprocess startup, streaming, supervisor pauses, and in-tool retries. It is not execution time.";

/** Filename that must never be read. */
const RUN_HISTORY_FILENAME = "run-history.jsonl";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OutputMode = "per-session" | "per-tool";

// Fix 8: accurate provenance source values.
type ProfileSource = "flag" | "PI_CODING_AGENT_DIR" | "TLH_AGENT_DIR" | "default";

interface CliArgs {
  mode: OutputMode;
  agentDir?: string;
  includePaths: boolean;
  help: boolean;
}

interface PerSessionOutput {
  schemaVersion: string;
  mode: "per-session";
  generatedAt: string;
  timingQualityNote: string;
  provenance: ProvenanceRecord;
  coverage: ScanCoverage;
  sessions: SessionRecord[];
}

interface PerToolOutput {
  schemaVersion: string;
  mode: "per-tool";
  generatedAt: string;
  timingQualityNote: string;
  provenance: ProvenanceRecord;
  coverage: ScanCoverage;
  tools: ToolRecord[];
}

interface ProvenanceRecord {
  toolName: string;
  // Fix 8: reflects which source actually provided the agent dir.
  profileSource: ProfileSource;
  profileId: string;
  agentDir?: string;
  sessionsDir?: string;
}

interface LatencyStats {
  median: number | null;
  min: number | null;
  max: number | null;
  p95: number | null;
}

interface SessionRecord {
  sessionId: string | null;
  startedAt: string | null;
  projectLabel?: string;
  filePath?: string;
  // Fix 4: honest count of all observed tool calls (including unmatched).
  toolCallCount: number;
  errorCount: number;
  observedLatencyMs: LatencyStats;
  malformedLines: number;
  unmatchedToolCalls: number;
  unmatchedToolResults: number;
  fileSizeChangedDuringScan: boolean;
  subagentCorrelationCount?: number;
  subagentCorrelations?: SubagentCorrelationRecord[];
}

interface SubagentCorrelationRecord {
  parentSessionId: string;
  toolCallId: string;
  runId: string;
  agent?: string;
  parentSessionFile?: string;
  childSessionFile?: string;
  childResolved?: boolean;
  childSessionId?: string;
  childStartedAt?: string;
}

interface ToolRecord {
  toolName: string;
  callCount: number;
  errorCount: number;
  observedLatencyMs: LatencyStats;
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

// Fix 3: correct the usage string — this is contributor tooling, not a tlh subcommand.
function usage(): string {
  return `Usage: tlh sessions [options]

Read-only session analysis. Emits JSON to stdout.

Options:
  --mode <mode>        Output mode: per-session (default) or per-tool
  --agent-dir <dir>    Isolated tlh agent dir (default: PI_CODING_AGENT_DIR or ~/.the-last-harness/agent)
  --include-paths      Include raw file paths and cwd-derived project labels in output
  -h, --help           Show this help

Output modes:
  per-session    One record per session file with tool pair statistics and coverage.
  per-tool       Aggregated statistics per tool name across all scanned sessions.

Notes:
  - Never reads run-history.jsonl.
  - Default output contains no raw paths, cwd values, or project labels.
  - observedLatencyMs is wall-clock, not execution time; see timingQualityNote in output.
`;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    mode: "per-session",
    agentDir: undefined,
    includePaths: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
      continue;
    }
    if (arg === "--include-paths") {
      args.includePaths = true;
      continue;
    }
    if (arg === "--mode") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error("--mode requires a value: per-session or per-tool");
      }
      if (next !== "per-session" && next !== "per-tool") {
        throw new Error(`Unknown mode: ${next}. Expected per-session or per-tool`);
      }
      args.mode = next as OutputMode;
      i++;
      continue;
    }
    if (arg === "--agent-dir") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error("--agent-dir requires a value");
      }
      args.agentDir = next;
      i++;
      continue;
    }
    if (arg !== undefined && arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (arg !== undefined) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

interface DiscoveryResult {
  files: string[];
  unreadableDirectories: number;
}

/**
 * Recursively enumerate all .jsonl files under `dir`, excluding
 * run-history.jsonl at every level.  Returns absolute paths and a count of
 * directories that could not be read (Fix 5).
 */
function findSessionFiles(dir: string): DiscoveryResult {
  const files: string[] = [];
  let unreadableDirectories = 0;
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    // Directory missing or unreadable — return empty with a count.
    return { files, unreadableDirectories: 1 };
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = findSessionFiles(fullPath);
      files.push(...sub.files);
      unreadableDirectories += sub.unreadableDirectories;
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".jsonl") &&
      entry.name !== RUN_HISTORY_FILENAME
    ) {
      files.push(fullPath);
    }
  }
  return { files, unreadableDirectories };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function computePercentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)]!;
}

function computeLatencyStats(latencies: number[]): LatencyStats {
  if (latencies.length === 0) {
    return { median: null, min: null, max: null, p95: null };
  }
  // Fix 6: use iteration instead of spread to avoid argument-limit on large corpora.
  let min = latencies[0]!;
  let max = latencies[0]!;
  for (let i = 1; i < latencies.length; i++) {
    const v = latencies[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return {
    median: computeMedian(latencies),
    min,
    max,
    p95: computePercentile(latencies, 95),
  };
}

// ---------------------------------------------------------------------------
// Per-session rollup
// ---------------------------------------------------------------------------

/**
 * Derive a project label (the cwd-slug component) from a session file path
 * and the sessions directory.  Returns null when the path is not under the
 * expected prefix.
 */
function projectLabelFromPath(filePath: string, sessionsDir: string): string | null {
  const prefix = sessionsDir.endsWith("/") ? sessionsDir : sessionsDir + "/";
  if (!filePath.startsWith(prefix)) return null;
  const rel = filePath.slice(prefix.length);
  const firstSegment = rel.split("/")[0];
  return firstSegment ?? null;
}

async function buildSessionRecord(
  scanResult: SessionScanResult,
  sessionsDir: string,
  includePaths: boolean,
): Promise<SessionRecord> {
  // Fix 4: use observedToolCallCount so truncated sessions are not under-reported.
  const latencies = scanResult.toolPairs.map((p) => p.observedLatencyMs);

  const record: SessionRecord = {
    sessionId: scanResult.sessionHeader?.id ?? null,
    startedAt: scanResult.sessionHeader?.timestamp ?? null,
    toolCallCount: scanResult.observedToolCallCount,
    errorCount: scanResult.toolPairs.filter((p) => p.isError).length,
    observedLatencyMs: computeLatencyStats(latencies),
    malformedLines: scanResult.malformedLines,
    unmatchedToolCalls: scanResult.unmatchedToolCallCount,
    unmatchedToolResults: scanResult.unmatchedToolResultCount,
    fileSizeChangedDuringScan: scanResult.fileSizeChangedDuringScan,
  };

  if (includePaths) {
    record.filePath = scanResult.filePath;
    // Project label from the cwd-slug directory component, falling back to
    // the basename of cwd when the file is not under the sessions directory.
    const { basename } = await import("node:path");
    const slugLabel = projectLabelFromPath(scanResult.filePath, sessionsDir);
    if (slugLabel) {
      record.projectLabel = slugLabel;
    } else if (scanResult.sessionHeader?.cwd) {
      record.projectLabel = basename(scanResult.sessionHeader.cwd);
    }
    // Fix 2: pass sessionsDir so child paths are validated against the boundary.
    const correlations = await extractSubagentCorrelations(scanResult, sessionsDir);
    record.subagentCorrelationCount = correlations.length;
    record.subagentCorrelations = correlations.map((c) => ({
      parentSessionId: c.parentSessionId,
      toolCallId: c.toolCallId,
      runId: c.runId,
      ...(c.agent !== undefined ? { agent: c.agent } : {}),
      parentSessionFile: c.parentSessionFile,
      childSessionFile: c.childSessionFile,
      childResolved: c.childResolved,
      ...(c.childSessionId !== undefined ? { childSessionId: c.childSessionId } : {}),
      ...(c.childStartedAt !== undefined ? { childStartedAt: c.childStartedAt } : {}),
    }));
  } else {
    // Always include a count of subagent correlations so callers know
    // whether child sessions exist, even without path details.
    const correlations = await extractSubagentCorrelations(scanResult, sessionsDir);
    record.subagentCorrelationCount = correlations.length;
  }

  return record;
}

function computeProfileId(agentDir: string): string {
  return createHash("sha256").update(agentDir).digest("hex").slice(0, 12);
}

function buildProvenance(
  agentDir: string,
  sessionsDir: string,
  includePaths: boolean,
  profileSource: ProfileSource,
): ProvenanceRecord {
  const provenance: ProvenanceRecord = {
    toolName: "tlh-sessions",
    profileSource,
    profileId: computeProfileId(agentDir),
  };
  if (includePaths) {
    provenance.agentDir = agentDir;
    provenance.sessionsDir = sessionsDir;
  }
  return provenance;
}

async function buildPerSessionOutput(
  scanResults: SessionScanResult[],
  coverage: ScanCoverage,
  sessionsDir: string,
  agentDir: string,
  includePaths: boolean,
  profileSource: ProfileSource,
): Promise<PerSessionOutput> {
  const sessions = await Promise.all(
    scanResults.map((r) => buildSessionRecord(r, sessionsDir, includePaths)),
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: "per-session",
    generatedAt: new Date().toISOString(),
    timingQualityNote: TIMING_QUALITY_NOTE,
    provenance: buildProvenance(agentDir, sessionsDir, includePaths, profileSource),
    coverage,
    sessions,
  };
}

// ---------------------------------------------------------------------------
// Per-tool rollup
// ---------------------------------------------------------------------------

function buildPerToolOutput(
  scanResults: SessionScanResult[],
  coverage: ScanCoverage,
  sessionsDir: string,
  agentDir: string,
  includePaths: boolean,
  profileSource: ProfileSource,
): PerToolOutput {
  const byTool = new Map<string, { latencies: number[]; errorCount: number }>();

  for (const result of scanResults) {
    for (const pair of result.toolPairs) {
      const existing = byTool.get(pair.toolName);
      if (existing) {
        existing.latencies.push(pair.observedLatencyMs);
        if (pair.isError) existing.errorCount++;
      } else {
        byTool.set(pair.toolName, {
          latencies: [pair.observedLatencyMs],
          errorCount: pair.isError ? 1 : 0,
        });
      }
    }
  }

  const tools: ToolRecord[] = [...byTool.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([toolName, stats]) => ({
      toolName,
      callCount: stats.latencies.length,
      errorCount: stats.errorCount,
      observedLatencyMs: computeLatencyStats(stats.latencies),
    }));

  return {
    schemaVersion: SCHEMA_VERSION,
    mode: "per-tool",
    generatedAt: new Date().toISOString(),
    timingQualityNote: TIMING_QUALITY_NOTE,
    provenance: buildProvenance(agentDir, sessionsDir, includePaths, profileSource),
    coverage,
    tools,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  // Fix 8: track the real source of the agent dir for accurate provenance.
  let profileSource: ProfileSource;
  if (args.agentDir) {
    profileSource = "flag";
  } else if (process.env["PI_CODING_AGENT_DIR"]) {
    profileSource = "PI_CODING_AGENT_DIR";
  } else if (process.env["TLH_AGENT_DIR"]) {
    profileSource = "TLH_AGENT_DIR";
  } else {
    profileSource = "default";
  }

  const agentDir = resolve(resolveTlhAgentDir(args.agentDir));
  const sessionsDir = join(agentDir, "sessions");

  // Fix 5: track discovery counts alongside scan failures.
  const discovery = findSessionFiles(sessionsDir);
  const sessionFiles = discovery.files;
  const extraCoverage: ExtraCoverageData = {
    filesDiscovered: sessionFiles.length,
    failedScans: 0,
    unreadableDirectories: discovery.unreadableDirectories,
  };

  const scanResults: SessionScanResult[] = [];
  for (const filePath of sessionFiles) {
    try {
      const result = await scanSessionFile(filePath);
      scanResults.push(result);
    } catch {
      // Fix 5: count files that could not be read or parsed.
      extraCoverage.failedScans = (extraCoverage.failedScans ?? 0) + 1;
    }
  }

  const coverage = aggregateCoverage(scanResults, extraCoverage);

  let output: PerSessionOutput | PerToolOutput;
  if (args.mode === "per-tool") {
    output = buildPerToolOutput(
      scanResults,
      coverage,
      sessionsDir,
      agentDir,
      args.includePaths,
      profileSource,
    );
  } else {
    output = await buildPerSessionOutput(
      scanResults,
      coverage,
      sessionsDir,
      agentDir,
      args.includePaths,
      profileSource,
    );
  }

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`tlh sessions: ${message}`);
  process.exit(1);
});

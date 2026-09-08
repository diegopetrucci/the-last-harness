/**
 * Stateless support shared by the split single-execution integration suites.
 *
 * This module intentionally does not register tests or create mutable test
 * fixtures. Each suite owns its mock process, temporary directory, and hooks.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tryImport } from "./helpers.ts";
import type { AgentConfig } from "./helpers.ts";
import type {
  AsyncStatus,
  ChildProcessCleanupResult,
  ContextUsageDiagnostics,
  SingleResult,
} from "../../src/shared/types.ts";

export interface ModelAttempt {
  success?: boolean;
  exitCode?: number;
  error?: string;
}

export interface ProgressSummary {
  agent: string;
  index: number;
  status: string;
  activityState?: string;
  idleEpisodeId?: string;
  durableAttentionReasons?: string[];
  compaction?: { reason?: string };
  lastActivityAt?: number;
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartedAt?: number;
  currentPath?: string;
  turnCount?: number;
  tokens?: number;
  durationMs: number;
  toolCount: number;
  recentOutput: string[];
}

export interface ArtifactPaths {
  inputPath: string;
  outputPath: string;
  jsonlPath: string;
  metadataPath: string;
  transcriptPath?: string;
}

export interface RunSyncResult {
  exitCode: number;
  agent: string;
  messages: unknown[];
  error?: string;
  model?: string;
  skills?: string[];
  skillsWarning?: string;
  attemptedModels?: string[];
  modelAttempts?: ModelAttempt[];
  modelFallbackNotice?: string;
  modelIdentity?: { provider: string; model: string; thinking?: string };
  modelResolution?: {
    kind?: string;
    original?: { provider: string; model: string; thinking?: string };
    resumed?: { provider: string; model: string; thinking?: string };
    reason?: string;
  };
  usage: { turns: number; input: number; output: number };
  /** Typed from production ContextUsageDiagnostics so new fields are caught. */
  contextUsage?: ContextUsageDiagnostics;
  contextPressure?: {
    severity?: string;
    crossedThreshold?: string;
    contextTokens?: number;
    contextWindow?: number;
    contextPercent?: number;
    remainingTokens?: number;
    warnedAt?: number;
  };
  contextPressureCrossedThresholds?: string[];
  terminationReason?: string;
  progress: ProgressSummary;
  controlEvents?: Array<{
    type?: string;
    message: string;
    reason?: string;
    idleEpisodeId?: string;
    contextPressureSeverity?: string;
    contextPressureThreshold?: string;
    turns?: number;
    tokens?: number;
    currentPath?: string;
    recentFailureSummary?: string;
  }>;
  artifactPaths?: ArtifactPaths;
  transcriptPath?: string;
  transcriptError?: string;
  finalOutput?: string;
  interrupted?: boolean;
  timedOut?: boolean;
  pause?: {
    kind?: string;
    summary?: string;
    requestedAt?: number;
    pausedAt?: number;
    ownerPid?: number;
    request?: {
      tool?: string;
      action?: string;
      reason?: string;
      requestId?: string;
      summary?: string;
    };
  };
  cancel?: { summary?: string; cancelledAt?: number };
  savedOutputPath?: string;
  outputMode?: "inline" | "file-only";
  outputReference?: { path: string; bytes: number; lines: number; message: string };
  outputSaveError?: string;
  sessionFile?: string;
  tkTicket?: { id: string; title: string };
  acceptance?: {
    explicit?: boolean;
    status?: string;
    verifyRuns?: Array<{ status?: string }>;
    runtimeChecks?: Array<{ id?: string; status?: string; message?: string }>;
  };
  /** Typed from production ChildProcessCleanupResult so new fields are caught. */
  processCleanup?: ChildProcessCleanupResult;
}

export interface MockPiCallRecord {
  args?: string[];
  systemPrompts?: Array<{ mode?: string; path?: string; text?: string; error?: string }>;
}

export function mockAssistantMessage(text: string, stopReason: "stop" | "tool_use" = "stop") {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content:
        stopReason === "tool_use"
          ? [
              { type: "text", text },
              { type: "toolCall", name: "bash", arguments: { command: "echo test" } },
            ]
          : [{ type: "text", text }],
      model: "mock/test-model",
      stopReason,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 0.001 },
      },
    },
  };
}

export function explicitAcceptanceRejectionOutput(output: string): string {
  return [
    output,
    "```acceptance-report",
    JSON.stringify({
      criteriaSatisfied: [
        {
          id: "criterion-1",
          status: "not-satisfied",
          evidence: "The fixture intentionally rejects this criterion.",
        },
      ],
      changedFiles: ["src/report.md"],
      testsAddedOrUpdated: ["test/report.test.ts"],
      commandsRun: [
        { command: "false", result: "failed", summary: "Intentional rejection fixture." },
      ],
      validationOutput: ["Intentional rejection fixture."],
      residualRisks: [],
      noStagedFiles: true,
      diffSummary: "Intentional rejection fixture.",
      reviewFindings: [],
      manualNotes: "Intentional rejection fixture.",
    }),
    "```",
  ].join("\n");
}

export function inferredAcceptanceRejectionOutput(output: string): string {
  return [
    output,
    "```acceptance-report",
    JSON.stringify({
      criteriaSatisfied: [],
      changedFiles: [],
      testsAddedOrUpdated: ["test/report.test.ts"],
      commandsRun: [
        { command: "true", result: "passed", summary: "Intentional rejection fixture." },
      ],
      residualRisks: [],
      noStagedFiles: true,
    }),
    "```",
  ].join("\n");
}

export interface ExecutionModule {
  runSync(
    runtimeCwd: string,
    agents: AgentConfig[],
    agentName: string,
    task: string,
    options: Record<string, unknown>,
  ): Promise<RunSyncResult>;
}

export interface UtilsModule {
  getFinalOutput(messages: unknown[]): string;
}

export interface ExecutorToolResult {
  content: Array<{ text?: string }>;
  isError?: boolean;
  details?: {
    totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
    timeoutMs?: number;
    deadlineAt?: number;
    asyncId?: string;
    /** Typed from production SingleResult so structural drift is caught. */
    results?: Pick<
      SingleResult,
      | "agent"
      | "exitCode"
      | "error"
      | "attemptedModels"
      | "modelFallbackNotice"
      | "progress"
      | "tkTicket"
      | "controlEvents"
      | "finalOutput"
      | "artifactPaths"
      | "savedOutputPath"
      | "outputMode"
      | "outputReference"
      | "acceptance"
    >[];
  };
}

export interface ExecutorModule {
  createSubagentExecutor?: (...args: unknown[]) => {
    execute: (...args: unknown[]) => Promise<ExecutorToolResult>;
  };
}

export type ExecuteAsyncSingleOverride = (
  id: string,
  params: Record<string, unknown>,
) => ExecutorToolResult;
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function readPersistedStatus(statusPath: string): AsyncStatus {
  const parsed: unknown = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`Expected persisted status object at ${statusPath}`);
  const record = parsed as Record<string, unknown>;
  assert.equal(typeof record.runId, "string");
  assert.equal(typeof record.state, "string");
  return parsed as AsyncStatus;
}

export function writePackageSkill(packageRoot: string, skillName: string): void {
  const skillDir = path.join(packageRoot, "skills", skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify(
      { name: `${skillName}-pkg`, version: "1.0.0", pi: { skills: [`./skills/${skillName}`] } },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: test skill\n---\nbody\n`,
    "utf-8",
  );
}

const execution = await tryImport<ExecutionModule>("./src/runs/foreground/execution.ts");
const utils = await tryImport<UtilsModule>("./src/shared/utils.ts");
const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
export const available = !!(execution && utils);

export const runSync = execution?.runSync;
export const getFinalOutput = utils?.getFinalOutput;
export const createSubagentExecutor = executorMod?.createSubagentExecutor;

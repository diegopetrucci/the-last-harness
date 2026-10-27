/**
 * Type definitions for the subagent extension
 */

import * as path from "node:path";
import { resolveTempRootDir } from "../../../shared/subagent-temp-root.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { FSWatcher } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentLiveDetailController } from "./subagent-shortcuts.ts";
import type { ProjectAgentIdentity } from "../agents/project-agent-loader.ts";
import type { ChildLocationSnapshot } from "./child-location.ts";
import { MAX_TOP_LEVEL_PARALLEL_TASKS } from "./parallel-limits.ts";
import type { SubagentRunTelemetry } from "./telemetry.ts";

// ============================================================================
// Basic Types
// ============================================================================

export interface MaxOutputConfig {
  bytes?: number;
  lines?: number;
}

export type OutputMode = "inline" | "file-only";

/** Internal result shape retained until the Pi 0.83 tool-result hook applies the error flag. */
export type SubagentToolResult<T> = AgentToolResult<T> & { isError?: boolean };

export interface SavedOutputReference {
  path: string;
  bytes: number;
  lines: number;
  message: string;
}

interface TruncationResult {
  text: string;
  truncated: boolean;
  originalBytes?: number;
  originalLines?: number;
  artifactPath?: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

/** Terminal state recorded for one child, independent of the async lifecycle state. */
export type SubagentTerminalState = "completed" | "failed" | "cancelled" | "paused";

/** Provider usage is explicitly tagged so unavailable usage is not confused with zero. */
export type ProviderTokenUsage =
  | { status: "available"; usage: TokenUsage }
  | { status: "unavailable" };

export type WorkspaceSnapshotUnavailableReason =
  | "not_git_repository"
  | "command_failed"
  | "not_captured";

/** Bounded evidence from one git workspace observation. */
export type GitWorkspaceSnapshot =
  | {
      status: "available";
      statusPorcelainZ: string;
      worktreeDiffStat: string;
      indexDiffStat: string;
    }
  | {
      status: "unavailable";
      reason: WorkspaceSnapshotUnavailableReason;
    };

export type SubagentWorkspaceAttribution = "exclusive" | "shared" | "unknown";

/** Evidence captured for one spawn-to-exit attempt of a child. */
export interface SubagentAttemptFacts {
  /** Attempts are one-based and contiguous across fallback/resume attempts. */
  attempt: number;
  exit: {
    code: number | null;
    signal: string | null;
  };
  durationMs: number;
  providerTokens: ProviderTokenUsage;
  /** Requested calls, not successful mutations or completed tool executions. */
  requestedToolCalls: {
    edit: number;
    write: number;
    bash: number;
  };
  workspace: {
    baseline: GitWorkspaceSnapshot;
    post: GitWorkspaceSnapshot;
    attribution: SubagentWorkspaceAttribution;
  };
}

/** Post-run evidence aggregated in explicit attempt order for one child. */
export interface PostRunFacts {
  attempts: SubagentAttemptFacts[];
}

/** Atomic per-child terminal result and its evidence-only post-run facts. */
export interface SubagentTerminalResult {
  state: SubagentTerminalState;
  facts: PostRunFacts;
}

export type ActivityState = "needs_attention";
export type ControlEventType = "needs_attention";
export type ControlNotificationChannel = "event" | "async";

export type ControlEventReason = "idle" | "context_pressure";

/** Reasons reported by the pinned coding-agent compaction lifecycle events. */
export type CompactionReason = "manual" | "threshold" | "overflow";

export type ContextPressureSeverity = "warning" | "critical";
export type ContextPressureThreshold = ContextPressureSeverity;

/** Latest measured context pressure crossing for one child execution. */
export interface ContextPressureProjection {
  severity: ContextPressureSeverity;
  crossedThreshold: ContextPressureThreshold;
  contextTokens: number;
  contextWindow: number;
  contextPercent: number;
  remainingTokens: number;
  warnedAt: number;
}

export interface ControlConfig {
  enabled?: boolean;
  needsAttentionAfterMs?: number;
  notifyOn?: ControlEventType[];
  notifyChannels?: ControlNotificationChannel[];
}

export interface ResolvedControlConfig {
  enabled: boolean;
  needsAttentionAfterMs: number;
  notifyOn: ControlEventType[];
  notifyChannels: ControlNotificationChannel[];
}

export interface ControlEvent {
  type: ControlEventType;
  from?: ActivityState;
  to: ActivityState;
  ts: number;
  agent: string;
  index?: number;
  /** Lifecycle generation that owns this attention episode. */
  generation?: number;
  runId: string;
  message: string;
  /** Context-pressure diagnostics are carried through every control channel. */
  contextPressureSeverity?: ContextPressureSeverity;
  contextPressureThreshold?: ContextPressureThreshold;
  /** Stable identity for the current validated idle episode, when applicable. */
  idleEpisodeId?: string;
  reason?: ControlEventReason;
  turns?: number;
  tokens?: number;
  toolCount?: number;
  currentTool?: string;
  currentToolDurationMs?: number;
  currentPath?: string;
  elapsedMs?: number;
}

export type SubagentResultStatus = "completed" | "failed" | "paused";
export type SubagentRunMode = "single" | "parallel";

/**
 * Normalize a persisted run mode for supported runtime projections.
 * Historical artifacts may still contain the retired `chain` value; callers
 * must read those files without treating the value as an executable mode.
 */
export function normalizeSubagentRunMode(value: unknown): SubagentRunMode {
  return value === "parallel" ? "parallel" : "single";
}

/** Acceptance ledger status values; used by telemetry for schema compatibility. */
export type AcceptanceLedgerStatus =
  | "not-required"
  | "claimed"
  | "attested"
  | "checked"
  | "verified"
  | "reviewed"
  | "accepted"
  | "rejected"
  | "skipped";

/** Stable machine-readable reason why a child execution segment terminated. */
export type SubagentTerminationReason =
  | "completed"
  | "output_limit"
  | "model_error"
  | "interrupted"
  | "timed_out"
  | "tool_budget_blocked"
  | "paused"
  | "cancelled"
  | "process_exit"
  | "context_exhausted"
  | "unknown";

/** Per-response child context diagnostics. Values are never cumulative billed-token totals. */
export interface ContextUsageDiagnostics {
  /** First valid response context observed after restoring an existing child session. */
  restoredTokens?: number;
  /** Latest valid assistant-response context total. */
  contextTokens?: number;
  /** Maximum valid assistant-response context total observed in this execution segment. */
  peakTokens?: number;
  /** Effective model context window, when it can be resolved safely. */
  contextWindow?: number;
  /** Latest contextTokens as a percentage of contextWindow. */
  contextPercent?: number;
}
export const SUBAGENT_LIFECYCLE_ARTIFACT_VERSION = 1;
type SubagentLifecycleArtifactVersion = typeof SUBAGENT_LIFECYCLE_ARTIFACT_VERSION;
type AsyncLifecycleState =
  | "queued"
  | "running"
  | "pausing"
  | "complete"
  | "failed"
  | "paused"
  | "cancelled"
  /** Historical spellings accepted only at the persisted-status read boundary. */
  | "completed"
  | "continued";
export type AsyncPauseState = "awaiting_supervisor" | "cohort_pause";

export interface AsyncPauseMetadata {
  kind: AsyncPauseState;
  summary?: string;
  requestedAt?: number;
  pausedAt?: number;
  ownerPid?: number;
  request?: AwaitedSupervisorRequestMetadata;
}

export interface AsyncCancellationMetadata {
  summary?: string;
  cancelledAt?: number;
}

export interface AwaitedSupervisorRequestMetadata {
  tool: "contact_supervisor";
  reason?: "need_decision" | "interview_request";
  requestId?: string;
  summary?: string;
}

interface AwaitedPauseMetadata extends AsyncPauseMetadata {
  request?: AwaitedSupervisorRequestMetadata;
}

export type AsyncLifecycleContinuationPhase =
  | "claimed"
  | "reserved"
  | "launched"
  | "completed"
  | "continued";

export interface AsyncLifecycleContinuationMetadata {
  phase?: AsyncLifecycleContinuationPhase;
  claimToken?: string;
  claimedAt?: number;
  ownerPid?: number;
  launchedAt?: number;
  completedAt?: number;
  /** Historical spelling accepted only while reading old status files. */
  continuedAt?: number;
  continuationRunId?: string;
}

interface AsyncLifecycleMetadata {
  generation?: number;
  continuation?: AsyncLifecycleContinuationMetadata;
  continuationsByIndex?: Record<string, AsyncLifecycleContinuationMetadata>;
  /** A fail-closed supervisor lifecycle failure cannot be resumed. */
  resumeBlockedReason?: "supervisor_lifecycle_failure";
}

export type CostSummary = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export interface SubagentResultChild {
  agent: string;
  status: SubagentResultStatus;
  summary: string;
  index?: number;
  artifactPath?: string;
  sessionPath?: string;
  /** Per-child terminal state and evidence-only facts, when persisted. */
  terminalResult?: SubagentTerminalResult;
}

// ============================================================================
// Progress Tracking
// ============================================================================

export interface AgentProgress {
  index: number;
  agent: string;
  status: "pending" | "running" | "completed" | "failed";
  activityState?: ActivityState;
  /** Stable identity for the currently active idle episode, when any. */
  idleEpisodeId?: string;
  /** Compaction is an active operation independent of tool-call state. */
  compaction?: { reason: CompactionReason };
  task: string;
  skills?: string[];
  lastActivityAt?: number;
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartedAt?: number;
  currentPath?: string;
  recentTools: Array<{ tool: string; args: string; endMs: number }>;
  recentOutput: string[];
  toolCount: number;
  turnCount?: number;
  tokens: number;
  durationMs: number;
  /** Wall-clock ms when this execution started; used for live-clock phrase selection. */
  startedAt?: number;
  error?: string;
  failedTool?: string;
}

interface ToolCallSummary {
  text: string;
  expandedText?: string;
}

interface ProgressSummary {
  toolCount: number;
  tokens: number;
  durationMs: number;
}

// ============================================================================
// Results
// ============================================================================

export interface ModelAttempt {
  model: string;
  success: boolean;
  exitCode?: number | null;
  error?: string;
  usage?: Usage;
}

/** Bounded diagnostic emitted when a child protocol line cannot be retained safely. */
export interface ProtocolOutputLimit {
  code: "protocol_output_limit";
  stream: "stdout" | "stderr";
  limitBytes: number;
  observedBytes: number;
  diagnosticPrefix: string;
  diagnosticTail: string;
}

export type ChildProcessCleanupSkippedReason =
  | "soft_pause"
  | "unsupported_platform"
  | "process_group_unavailable";

export interface ChildProcessCleanupResult {
  supported: boolean;
  attempted: boolean;
  terminated: boolean;
  processGroupId?: number;
  liveProcessesDetected?: boolean;
  escalatedToSigkill?: boolean;
  signals?: Array<"SIGINT" | "SIGTERM" | "SIGKILL">;
  skippedReason?: ChildProcessCleanupSkippedReason;
  warnings?: string[];
}

export interface SingleResult {
  agent: string;
  task: string;
  /** Exact approved project-agent config/provenance; never includes a capability. */
  projectAgent?: ProjectAgentIdentity;
  exitCode: number;
  exitSignal?: NodeJS.Signals;
  interrupted?: boolean;
  timedOut?: boolean;
  /** Internal timeout boundary that owns a timed-out child, when known. */
  timeoutOwner?: "role" | "run";
  contextUsage?: ContextUsageDiagnostics;
  contextPressure?: ContextPressureProjection;
  contextPressureCrossedThresholds?: ContextPressureThreshold[];
  terminationReason?: SubagentTerminationReason;
  messages?: Message[];
  usage: Usage;
  model?: string;
  thinking?: string;
  modelIdentity?: SubagentModelIdentity;
  modelResolution?: SubagentModelResolution;
  attemptedModels?: string[];
  modelAttempts?: ModelAttempt[];
  modelFallbackNotice?: string;
  controlEvents?: ControlEvent[];
  error?: string;
  /**
   * Bounded stderr tail retained for diagnostics. Raw stderr is durable in
   * output-N.log for both awaited and detached runs and, when enabled, in the
   * debug child transcript.
   */
  stderr?: string;
  stderrTruncated?: boolean;
  protocolOutputLimit?: ProtocolOutputLimit;
  sessionFile?: string;
  skills?: string[];
  skillsWarning?: string;
  progress?: AgentProgress;
  progressSummary?: ProgressSummary;
  toolCalls?: ToolCallSummary[];
  artifactPaths?: ArtifactPaths;
  processCleanup?: ChildProcessCleanupResult;
  truncation?: TruncationResult;
  finalOutput?: string;
  outputMode?: OutputMode;
  savedOutputPath?: string;
  outputReference?: SavedOutputReference;
  outputSaveError?: string;
  /** Per-child terminal state and evidence-only facts, when persisted. */
  terminalResult?: SubagentTerminalResult;
  pause?: AwaitedPauseMetadata;
  cancel?: AsyncCancellationMetadata;
  transcriptPath?: string;
  transcriptError?: string;
  /** Normalized ticket ID, when assigned. */
  ticketId?: string;
  /**
   * Dispatch-time snapshot of child-location facts. Present only when the
   * child cwd differs from the parent session cwd at the time of dispatch;
   * absent (undefined) for same-cwd runs. Never mutated after initial set.
   */
  childLocation?: ChildLocationSnapshot;
  /** Active runtime tracking for telemetry; optional, not accumulated cumulatively. */
  activeRuntimeMs?: number;
  /** Acceptance ledger snapshot, when available from acceptance-aware callers. */
  acceptance?: { status: AcceptanceLedgerStatus } & Record<string, unknown>;
}

export interface Details {
  mode: SubagentRunMode | "management";
  runId?: string;
  results: SingleResult[];
  /** Optional privacy-safe run-level telemetry envelope. */
  telemetry?: import("./telemetry.ts").SubagentRunTelemetry;
  controlEvents?: ControlEvent[];
  asyncId?: string;
  asyncDir?: string;
  timeoutMs?: number;
  deadlineAt?: number;
  timedOut?: boolean;
  progress?: AgentProgress[];
  progressSummary?: ProgressSummary;
  artifacts?: {
    dir: string;
    files: ArtifactPaths[];
  };
  truncation?: {
    truncated: boolean;
    originalBytes?: number;
    originalLines?: number;
    artifactPath?: string;
  };
  /** Number of direct children in the execution plan. */
  totalSteps?: number;
  // Aggregated child usage across all agents in the run
  totalChildUsage?: Usage;
  // Aggregated cost across all agents in the run
  totalCost?: CostSummary;
  /** True when the parent blocked on this run (awaited path). Absent on detached runs. */
  awaited?: boolean;
}

// ============================================================================
// Artifacts
// ============================================================================

export interface ArtifactPaths {
  inputPath: string;
  outputPath: string;
  jsonlPath: string;
  transcriptPath: string;
  metadataPath: string;
}

export type ArtifactMode = "compact" | "debug";

/**
 * Resolved per-child artifact policy. `mode` remains optional for readers of
 * historical detached-run configs written before artifact profiles existed;
 * newly created configs always persist it explicitly.
 */
export interface ArtifactConfig {
  mode?: ArtifactMode;
  enabled: boolean;
  includeInput: boolean;
  includeOutput: boolean;
  includeJsonl: boolean;
  includeTranscript?: boolean;
  includeMetadata: boolean;
  cleanupDays: number;
}

/** Fully resolved policy used for newly launched child executions. */
export interface ResolvedArtifactConfig extends Omit<ArtifactConfig, "mode" | "includeTranscript"> {
  mode: ArtifactMode;
  includeTranscript: boolean;
  /** Internal provenance gate for high-volume child-derived event projections. */
  includeChildEventProjections: boolean;
}

/** Boundary-facing artifact settings: `mode` is the only consumed field. */
interface ExtensionArtifactConfig {
  mode?: unknown;
}

// ============================================================================
// Async Execution
// ============================================================================

/** Canonical provider/model/thinking identity persisted with resumable children. */
export interface SubagentModelIdentity {
  provider: string;
  model: string;
  thinking?: string;
}

/** Durable explanation for a restored, overridden, or fallback model selection. */
export interface SubagentModelResolution {
  kind: "restored" | "override" | "fallback";
  original?: SubagentModelIdentity;
  resumed?: SubagentModelIdentity;
  reason: string;
}

export interface AsyncStartedEvent {
  lifecycleArtifactVersion?: SubagentLifecycleArtifactVersion;
  telemetry?: import("./telemetry.ts").SubagentRunTelemetry;
  /** Safe per-child project-agent captures; no opaque capability crosses this event. */
  projectAgents?: ProjectAgentIdentity[];
  id?: string;
  asyncDir?: string;
  pid?: number;
  sessionId?: string;
  mode?: SubagentRunMode;
  agent?: string;
  agents?: string[];
  timeoutMs?: number;
  deadlineAt?: number;
}

export interface AsyncStatus {
  lifecycleArtifactVersion?: SubagentLifecycleArtifactVersion;
  /** Internal-only marker for a caller that owns terminal settlement. */
  awaited?: boolean;
  /** Optional privacy-safe run-level telemetry envelope. */
  telemetry?: SubagentRunTelemetry;
  runId: string;
  sessionId?: string;
  mode: SubagentRunMode;
  state: AsyncLifecycleState;
  /** Evidence-only terminal settlement for the run, when available. */
  terminalResult?: SubagentTerminalResult;
  lifecycle?: AsyncLifecycleMetadata;
  pause?: AsyncPauseMetadata;
  cancel?: AsyncCancellationMetadata;
  error?: string;
  activityState?: ActivityState;
  lastActivityAt?: number;
  activeRuntimeMs?: number;
  /** Timestamp of the last authoritative active-runtime checkpoint. */
  activeRuntimeCheckpointAt?: number;
  currentTool?: string;
  currentToolStartedAt?: number;
  currentPath?: string;
  turnCount?: number;
  toolCount?: number;
  steerCount?: number;
  lastSteerAt?: number;
  startedAt: number;
  endedAt?: number;
  lastUpdate?: number;
  timeoutMs?: number;
  deadlineAt?: number;
  timedOut?: boolean;
  /** Run-level cleanup evidence retained when the owner stops the runner. */
  processCleanup?: ChildProcessCleanupResult;
  /** Internal timeout boundary that owns a timed-out child, when known. */
  timeoutOwner?: "role" | "run";
  pid?: number;
  cwd?: string;
  currentStep?: number;
  pendingAppends?: number;
  steps?: Array<{
    agent: string;
    status:
      | "pending"
      | "running"
      | "pausing"
      | "complete"
      | "completed"
      | "failed"
      | "paused"
      | "continued"
      | "cancelled";
    sessionFile?: string;
    transcriptPath?: string;
    transcriptError?: string;
    activityState?: ActivityState;
    /** Stable identity for the currently active idle attention episode. */
    idleEpisodeId?: string;
    /** Active compaction operation, when one is in progress. */
    compaction?: { reason: CompactionReason };
    lastActivityAt?: number;
    currentTool?: string;
    currentToolArgs?: string;
    currentToolStartedAt?: number;
    currentPath?: string;
    interruptRequestedAt?: number;
    recentTools?: Array<{ tool: string; args: string; endMs: number }>;
    recentOutput?: string[];
    turnCount?: number;
    toolCount?: number;
    startedAt?: number;
    endedAt?: number;
    durationMs?: number;
    /** Consumed active runtime for this child instance's role budget. */
    activeRuntimeMs?: number;
    /** Timestamp of the last authoritative active-runtime checkpoint. */
    activeRuntimeCheckpointAt?: number;
    /** Normalized ticket ID, when assigned. */
    ticketId?: string;
    /** Per-child terminal state and evidence-only facts, when persisted. */
    terminalResult?: SubagentTerminalResult;
    timeoutMs?: number;
    deadlineAt?: number;
    exitCode?: number | null;
    exitSignal?: NodeJS.Signals;
    timedOut?: boolean;
    /** Internal timeout boundary that owns a timed-out child, when known. */
    timeoutOwner?: "role" | "run";
    contextUsage?: ContextUsageDiagnostics;
    contextPressure?: ContextPressureProjection;
    contextPressureCrossedThresholds?: ContextPressureThreshold[];
    terminationReason?: SubagentTerminationReason;
    tokens?: TokenUsage;
    skills?: string[];
    skillsWarning?: string;
    model?: string;
    thinking?: string;
    modelIdentity?: SubagentModelIdentity;
    modelResolution?: SubagentModelResolution;
    attemptedModels?: string[];
    modelAttempts?: ModelAttempt[];
    modelFallbackNotice?: string;
    totalCost?: CostSummary;
    steerCount?: number;
    lastSteerAt?: number;
    error?: string;
    stderr?: string;
    stderrTruncated?: boolean;
    protocolOutputLimit?: ProtocolOutputLimit;
    processCleanup?: ChildProcessCleanupResult;
    pause?: AsyncPauseMetadata;
    cancel?: AsyncCancellationMetadata;
    /** Exact approved project-agent config/provenance; never includes a capability. */
    projectAgent?: ProjectAgentIdentity;
    /**
     * Dispatch-time snapshot of child location facts. Present only when the
     * child cwd differs from the parent session cwd; absent for same-cwd steps.
     */
    childLocation?: ChildLocationSnapshot;
    /**
     * Fully resolved per-child dispatch cwd. Written by the status owner from
     * the plan task cwd at run start. Preferred over childLocation.childCwd and
     * run-level cwd on revival; absent in artifacts written before this field
     * was introduced.
     */
    cwd?: string;
  }>;
  sessionDir?: string;
  outputFile?: string;
  totalTokens?: TokenUsage;
  totalCost?: CostSummary;
  sessionFile?: string;
  /** Safe per-child project-agent captures retained for status/control display. */
  projectAgents?: ProjectAgentIdentity[];
}

export type AsyncJobStep = NonNullable<AsyncStatus["steps"]>[number] & {
  index?: number;
};

// ============================================================================
// Async Result Artifact
// ============================================================================

/**
 * Shape of one child step entry in the async result artifact.
 * All four result writers must be structurally compatible with this type.
 */
export interface AsyncResultArtifactResultItem {
  agent: string;
  /** Exact approved project-agent config/provenance; never includes a capability. */
  projectAgent?: ProjectAgentIdentity;
  success: boolean;
  output: string;
  /** Raw child output before notices or output-mode formatting. */
  finalOutput?: string;
  error?: string;
  stderr?: string;
  stderrTruncated?: boolean;
  protocolOutputLimit?: ProtocolOutputLimit;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals;
  skipped?: boolean;
  interrupted?: boolean;
  timedOut?: boolean;
  /** Internal timeout boundary that owns a timed-out child, when known. */
  timeoutOwner?: "role" | "run";
  contextUsage?: ContextUsageDiagnostics;
  contextPressure?: ContextPressureProjection;
  contextPressureCrossedThresholds?: ContextPressureThreshold[];
  terminationReason?: SubagentTerminationReason;
  sessionFile?: string;
  model?: string;
  /** Per-child activity projection retained for result-only async resume recovery. */
  activityState?: ActivityState;
  modelIdentity?: SubagentModelIdentity;
  modelResolution?: SubagentModelResolution;
  attemptedModels?: string[];
  modelAttempts?: ModelAttempt[];
  modelFallbackNotice?: string;
  totalCost?: CostSummary;
  artifactPaths?: ArtifactPaths;
  processCleanup?: ChildProcessCleanupResult;
  truncated?: boolean;
  transcriptPath?: string;
  transcriptError?: string;
  skills?: string[];
  skillsWarning?: string;
  outputMode?: OutputMode;
  savedOutputPath?: string;
  outputReference?: SavedOutputReference;
  outputSaveError?: string;
  childLocation?: ChildLocationSnapshot;
  pause?: AsyncPauseMetadata;
  cancel?: AsyncCancellationMetadata;
  /** Normalized ticket ID, when assigned. */
  ticketId?: string;
  /** Per-child terminal state and evidence-only facts, when persisted. */
  terminalResult?: SubagentTerminalResult;
  activeRuntimeMs?: number;
  /** Timestamp of the last authoritative active-runtime checkpoint. */
  activeRuntimeCheckpointAt?: number;
  /**
   * Fully resolved per-child dispatch cwd. Written by the runner from the plan
   * task cwd so result-only revival (status.json absent) uses the correct child
   * working directory instead of falling back to the run-level cwd.
   */
  cwd?: string;
}

/**
 * Canonical shape of the async result artifact written to disk by all four
 * result writers. Apply with `satisfies AsyncResultArtifact` — never with a
 * type annotation or cast — so literals are validated without widening and
 * the emitted JSON remains byte-identical.
 *
 * Fields are optional when any writer legitimately omits them:
 * - `lifecycleArtifactVersion` — omitted by the stale-run repair writer
 * - Most top-level fields — omitted by gate-rejection and repair writers
 */
export interface AsyncResultArtifact {
  lifecycleArtifactVersion?: SubagentLifecycleArtifactVersion;
  /** Internal-only marker for an awaited caller; detached runs omit it. */
  awaited?: boolean;
  generation?: number;
  /** Optional privacy-safe run-level telemetry envelope. */
  telemetry?: SubagentRunTelemetry;
  id: string;
  agent: string;
  mode: SubagentRunMode;
  success: boolean;
  state: AsyncLifecycleState;
  summary: string;
  error?: string;
  timeoutMs?: number;
  deadlineAt?: number;
  timedOut?: boolean;
  pause?: AsyncPauseMetadata;
  cancel?: AsyncCancellationMetadata;
  results: AsyncResultArtifactResultItem[];
  exitCode: number;
  timestamp: number;
  durationMs: number;
  totalTokens?: TokenUsage;
  totalCost?: CostSummary;
  truncated?: boolean;
  artifactsDir?: string;
  cwd?: string;
  asyncDir: string;
  sessionId?: string | null;
  sessionFile?: string;
  /** Safe per-child captures mirrored into the result artifact. */
  projectAgents?: ProjectAgentIdentity[];
  shareUrl?: string;
  gistUrl?: string;
  shareError?: string;
  taskIndex?: number;
  totalTasks?: number;
}

export interface AsyncJobState {
  /** Optional privacy-safe run-level telemetry restored with the lifecycle. */
  telemetry?: import("./telemetry.ts").SubagentRunTelemetry;
  asyncId: string;
  asyncDir: string;
  /** Internal-only marker retained while an awaited run is visible. */
  awaited?: boolean;
  status: AsyncLifecycleState;
  /** Continuation metadata projects launch semantics without a legacy status label. */
  lifecycle?: AsyncStatus["lifecycle"];
  pid?: number;
  sessionId?: string;
  activityState?: ActivityState;
  lastActivityAt?: number;
  currentTool?: string;
  currentToolStartedAt?: number;
  currentPath?: string;
  interruptRequestedAt?: number;
  turnCount?: number;
  toolCount?: number;
  steerCount?: number;
  lastSteerAt?: number;
  mode?: SubagentRunMode;
  agents?: string[];
  currentStep?: number;
  steps?: AsyncJobStep[];
  stepsTotal?: number;
  runningSteps?: number;
  completedSteps?: number;
  startedAt?: number;
  updatedAt?: number;
  timeoutMs?: number;
  deadlineAt?: number;
  timedOut?: boolean;
  sessionDir?: string;
  outputFile?: string;
  totalTokens?: TokenUsage;
  sessionFile?: string;
  controlEventCursor?: number;
  /** True while the cursor is inside an oversized JSONL record. */
  controlEventSkippingOversizedLine?: boolean;
  /** Device/inode identity of the events file at the cursor. */
  controlEventFileIdentity?: string;
  /** Safe per-child captures retained for the run lifecycle. */
  projectAgents?: ProjectAgentIdentity[];
}

export interface SubagentState {
  baseCwd: string;
  currentSessionId: string | null;
  subagentInProgress?: boolean;
  asyncJobs: Map<string, AsyncJobState>;
  cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
  lastUiContext: ExtensionContext | null;
  liveDetailController?: SubagentLiveDetailController;
  poller: NodeJS.Timeout | null;
  watcher: FSWatcher | null;
  watcherRestartTimer: ReturnType<typeof setTimeout> | null;
  resultFileCoalescer: {
    schedule(file: string, delayMs?: number): boolean;
    clear(): void;
  };
}

// ============================================================================
// Display
// ============================================================================

export type DisplayItem =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; args: Record<string, unknown> };

// ============================================================================
// Error Handling
// ============================================================================

export interface ErrorInfo {
  hasError: boolean;
  exitCode?: number;
  errorType?: string;
  details?: string;
}

export interface SubagentEventBus {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
}

export const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
/** Internal lifecycle event emitted when an awaited run owner settles. */
export const SUBAGENT_ASYNC_OWNER_COMPLETE_EVENT = "subagent:async-owner-complete";
export const SUBAGENT_CONTROL_EVENT = "subagent:control-event";
// Keep this literal local to the subagents shared types module so detached
// runtime imports never cross out of the generated subagents source root.
export const SUBAGENT_ASYNC_RESTORED_EVENT = "subagent:async-restored";

export type SubagentAsyncRestoredJob = {
  runId: string;
  asyncDir: string;
  sessionId: string;
  pid?: number;
};

export type SubagentAsyncRestoredEvent = {
  sessionId: string;
  jobs: readonly SubagentAsyncRestoredJob[];
};

interface TopLevelParallelConfig {
  maxTasks?: number;
  concurrency?: number;
}

export interface ExtensionConfig {
  maxSubagentDepth?: number;
  control?: ControlConfig;
  parallel?: TopLevelParallelConfig;
  artifacts?: ExtensionArtifactConfig;
  /** External execution settings remain unknown until the policy boundary validates them. */
  execution?: unknown;
  /** Unknown settings remain tolerated and are preserved by the boundary reader. */
  [key: string]: unknown;
}

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_MAX_OUTPUT: Required<MaxOutputConfig> = {
  bytes: 200 * 1024,
  lines: 5000,
};

export const DEFAULT_ARTIFACT_CONFIG: ResolvedArtifactConfig = {
  mode: "compact",
  enabled: true,
  includeInput: false,
  includeOutput: true,
  includeJsonl: false,
  includeTranscript: false,
  includeChildEventProjections: false,
  includeMetadata: true,
  cleanupDays: 7,
};

export { MAX_TOP_LEVEL_PARALLEL_TASKS };
const MAX_CONCURRENCY = 4;

export { resolveTempRootDir };

export const TEMP_ROOT_DIR = resolveTempRootDir();
export const RESULTS_DIR = path.join(TEMP_ROOT_DIR, "async-subagent-results");
export const ASYNC_DIR = path.join(TEMP_ROOT_DIR, "async-subagent-runs");
export const TEMP_ARTIFACTS_DIR = path.join(TEMP_ROOT_DIR, "artifacts");
export const WIDGET_KEY = "subagent-async";
export const SLASH_TEXT_RESULT_TYPE = "subagent-slash-text-result";
export const POLL_INTERVAL_MS = 250;
export const MAX_WIDGET_JOBS = 4;
const DEFAULT_SUBAGENT_MAX_DEPTH = 2;
export const SUBAGENT_ACTIONS = [
  "list",
  "get",
  "status",
  "interrupt",
  "resume",
  "steer",
  "result",
  "doctor",
] as const;

function normalizeTopLevelParallelValue(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  return parsed;
}

export function resolveTopLevelParallelMaxTasks(value: unknown): number {
  const normalized = normalizeTopLevelParallelValue(value);
  return normalized === undefined
    ? MAX_TOP_LEVEL_PARALLEL_TASKS
    : Math.min(normalized, MAX_TOP_LEVEL_PARALLEL_TASKS);
}

export function resolveTopLevelParallelConcurrency(configValue: unknown): number {
  return normalizeTopLevelParallelValue(configValue) ?? MAX_CONCURRENCY;
}

export function getAsyncConfigPath(suffix: string): string {
  return path.join(TEMP_ROOT_DIR, `async-cfg-${suffix}.json`);
}

// ============================================================================
// Recursion Depth Guard
// ============================================================================

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

export function normalizeMaxSubagentDepth(value: unknown): number | undefined {
  return normalizeNonNegativeInteger(value);
}

export function resolveCurrentMaxSubagentDepth(configMaxDepth?: number): number {
  return (
    normalizeMaxSubagentDepth(process.env.PI_SUBAGENT_MAX_DEPTH) ??
    normalizeMaxSubagentDepth(configMaxDepth) ??
    DEFAULT_SUBAGENT_MAX_DEPTH
  );
}

export function resolveChildMaxSubagentDepth(
  parentMaxDepth: number,
  agentMaxDepth?: number,
): number {
  const normalizedParent = normalizeMaxSubagentDepth(parentMaxDepth) ?? DEFAULT_SUBAGENT_MAX_DEPTH;
  const normalizedAgent = normalizeMaxSubagentDepth(agentMaxDepth);
  return normalizedAgent === undefined
    ? normalizedParent
    : Math.min(normalizedParent, normalizedAgent);
}

export function checkSubagentDepth(configMaxDepth?: number): {
  blocked: boolean;
  depth: number;
  maxDepth: number;
} {
  const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
  const maxDepth = resolveCurrentMaxSubagentDepth(configMaxDepth);
  const blocked = Number.isFinite(depth) && depth >= maxDepth;
  return { blocked, depth, maxDepth };
}

export function getSubagentDepthEnv(maxDepth?: number): Record<string, string> {
  const parentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
  const nextDepth = Number.isFinite(parentDepth) ? parentDepth + 1 : 1;
  return {
    PI_SUBAGENT_DEPTH: String(nextDepth),
    PI_SUBAGENT_MAX_DEPTH: String(
      normalizeMaxSubagentDepth(maxDepth) ?? resolveCurrentMaxSubagentDepth(),
    ),
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncateOutput(
  output: string,
  config: Required<MaxOutputConfig>,
  artifactPath?: string,
): TruncationResult {
  const lines = output.split("\n");
  const bytes = Buffer.byteLength(output, "utf-8");

  if (bytes <= config.bytes && lines.length <= config.lines) {
    return { text: output, truncated: false };
  }

  let truncatedLines = lines;
  if (lines.length > config.lines) {
    truncatedLines = lines.slice(0, config.lines);
  }

  let result = truncatedLines.join("\n");
  if (Buffer.byteLength(result, "utf-8") > config.bytes) {
    let low = 0;
    let high = result.length;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (Buffer.byteLength(result.slice(0, mid), "utf-8") <= config.bytes) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    result = result.slice(0, low);
  }

  const keptLines = result.split("\n").length;
  const marker = `[TRUNCATED: showing first ${keptLines} of ${lines.length} lines, ${formatBytes(Buffer.byteLength(result))} of ${formatBytes(bytes)}${artifactPath ? ` - full output at ${artifactPath}` : ""}]\n`;

  return {
    text: marker + result,
    truncated: true,
    originalBytes: bytes,
    originalLines: lines.length,
    artifactPath,
  };
}

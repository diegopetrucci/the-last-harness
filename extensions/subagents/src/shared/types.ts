/**
 * Type definitions for the subagent extension
 */

import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { FSWatcher } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelScopeConfig } from "../runs/shared/model-scope.ts";
import type { SubagentLiveDetailController } from "./subagent-shortcuts.ts";
import type { ProjectAgentRunCapture } from "../agents/project-agent-snapshot.ts";

// ============================================================================
// Basic Types
// ============================================================================

export interface MaxOutputConfig {
  bytes?: number;
  lines?: number;
}

export type OutputMode = "inline" | "file-only";

export type AcceptanceRole = "read-only" | "writer";

export type JsonSchemaObject = Record<string, unknown>;

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

export interface ToolBudgetConfig {
  soft?: number;
  hard: number;
  block?: string[] | "*";
}

export interface ResolvedToolBudget {
  soft?: number;
  hard: number;
  block: string[] | "*";
}

type ToolBudgetOutcome = "within-budget" | "soft-reached" | "hard-blocked";

export interface ToolBudgetState extends ResolvedToolBudget {
  outcome: ToolBudgetOutcome;
  toolCount: number;
  softReachedAt?: number;
  hardReachedAt?: number;
  blockedTool?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

export type ActivityState = "active_long_running" | "needs_attention";
export type ControlEventType = "active_long_running" | "needs_attention";
export type ControlNotificationChannel = "event" | "async";

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
  activeNoticeAfterMs?: number;
  activeNoticeAfterTurns?: number;
  activeNoticeAfterTokens?: number;
  failedToolAttemptsBeforeAttention?: number;
  notifyOn?: ControlEventType[];
  notifyChannels?: ControlNotificationChannel[];
}

export interface ResolvedControlConfig {
  enabled: boolean;
  needsAttentionAfterMs: number;
  activeNoticeAfterMs: number;
  activeNoticeAfterTurns?: number;
  activeNoticeAfterTokens?: number;
  failedToolAttemptsBeforeAttention: number;
  notifyOn: ControlEventType[];
  notifyChannels: ControlNotificationChannel[];
}

/**
 * Smart completion batching for async-completion notifications. Successful
 * sibling completions are held briefly so they arrive as one grouped message;
 * failure and attention signals bypass grouping and always fire immediately.
 */
export interface CompletionBatchConfig {
  enabled?: boolean;
  /** Idle window after each arrival; resets on every new item. */
  debounceMs?: number;
  /** Hard cap measured from the first item in a group. */
  maxWaitMs?: number;
  /** Shorter idle window for straggler groups. */
  stragglerDebounceMs?: number;
  /** Shorter hard cap for straggler groups. */
  stragglerMaxWaitMs?: number;
  /** Arrivals within this window after an emit join a straggler group. */
  stragglerWindowMs?: number;
}

export interface ControlEvent {
  type: ControlEventType;
  from?: ActivityState;
  to: ActivityState;
  ts: number;
  agent: string;
  index?: number;
  runId: string;
  nestedRunId?: string;
  nestingPath?: NestedRunAddress["path"];
  message: string;
  /** Context-pressure diagnostics are carried through every control channel. */
  contextPressureSeverity?: ContextPressureSeverity;
  contextPressureThreshold?: ContextPressureThreshold;
  reason?:
    | "idle"
    | "completion_guard"
    | "active_long_running"
    | "tool_failures"
    | "time_threshold"
    | "turn_threshold"
    | "token_threshold"
    | "context_pressure";
  turns?: number;
  tokens?: number;
  toolCount?: number;
  currentTool?: string;
  currentToolDurationMs?: number;
  currentPath?: string;
  elapsedMs?: number;
  recentFailureSummary?: string;
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
  | "continued";
export type AsyncPauseState = "awaiting_supervisor" | "cohort_pause";

export interface AsyncPauseMetadata {
  kind: AsyncPauseState;
  summary?: string;
  requestedAt?: number;
  pausedAt?: number;
  ownerPid?: number;
  request?: ForegroundSupervisorRequestMetadata;
}

export interface AsyncCancellationMetadata {
  summary?: string;
  cancelledAt?: number;
}

export interface ForegroundSupervisorRequestMetadata {
  tool: "contact_supervisor";
  reason?: "need_decision" | "interview_request";
  requestId?: string;
  summary?: string;
}

interface ForegroundPauseMetadata extends AsyncPauseMetadata {
  request?: ForegroundSupervisorRequestMetadata;
}

export type AsyncLifecycleContinuationPhase = "claimed" | "reserved" | "launched" | "continued";

export interface AsyncLifecycleContinuationMetadata {
  phase?: AsyncLifecycleContinuationPhase;
  claimToken?: string;
  claimedAt?: number;
  ownerPid?: number;
  launchedAt?: number;
  continuedAt?: number;
  continuationRunId?: string;
}

interface AsyncLifecycleMetadata {
  generation?: number;
  continuation?: AsyncLifecycleContinuationMetadata;
  continuationsByIndex?: Record<string, AsyncLifecycleContinuationMetadata>;
}

type PublicNestedStepSummary = Pick<
  NestedStepSummary,
  | "agent"
  | "status"
  | "sessionFile"
  | "transcriptPath"
  | "transcriptError"
  | "activityState"
  | "lastActivityAt"
  | "currentTool"
  | "currentToolStartedAt"
  | "currentPath"
  | "turnCount"
  | "toolCount"
  | "toolBudget"
  | "toolBudgetBlocked"
  | "startedAt"
  | "endedAt"
  | "error"
  | "timedOut"
  | "terminationReason"
  | "contextUsage"
  | "contextPressure"
  | "contextPressureCrossedThresholds"
> & {
  children?: PublicNestedRunSummary[];
};

export type CostSummary = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type PublicNestedRunSummary = Pick<
  NestedRunSummary,
  | "id"
  | "parentRunId"
  | "parentStepIndex"
  | "parentAgent"
  | "depth"
  | "path"
  | "asyncDir"
  | "sessionId"
  | "sessionFile"
  | "ownerState"
  | "mode"
  | "state"
  | "agent"
  | "agents"
  | "currentStep"
  | "activityState"
  | "lastActivityAt"
  | "currentTool"
  | "currentToolStartedAt"
  | "currentPath"
  | "turnCount"
  | "toolCount"
  | "toolBudget"
  | "toolBudgetBlocked"
  | "totalTokens"
  | "totalCost"
  | "startedAt"
  | "endedAt"
  | "lastUpdate"
  | "error"
  | "timeoutMs"
  | "deadlineAt"
  | "timedOut"
> & {
  steps?: PublicNestedStepSummary[];
  children?: PublicNestedRunSummary[];
};

export interface SubagentResultChild {
  agent: string;
  status: SubagentResultStatus;
  summary: string;
  index?: number;
  artifactPath?: string;
  sessionPath?: string;
  children?: PublicNestedRunSummary[];
}

// ============================================================================
// Progress Tracking
// ============================================================================

export interface AgentProgress {
  index: number;
  agent: string;
  status: "pending" | "running" | "completed" | "failed";
  activityState?: ActivityState;
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
  error?: string;
  failedTool?: string;
}

export interface ToolCallSummary {
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

export type AcceptanceLevel = "auto" | "none" | "attested" | "checked" | "verified" | "reviewed";

export type AcceptanceEvidenceKind =
  | "changed-files"
  | "tests-added"
  | "commands-run"
  | "validation-output"
  | "residual-risks"
  | "no-staged-files"
  | "diff-summary"
  | "review-findings"
  | "manual-notes";

interface AcceptanceGate {
  id: string;
  must: string;
  evidence?: AcceptanceEvidenceKind[];
  severity?: "required" | "recommended";
}

export interface AcceptanceVerifyCommand {
  id: string;
  command: string;
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
  allowFailure?: boolean;
}

interface AcceptanceReviewGate {
  agent?: string;
  focus?: string;
  required?: boolean;
}

export interface AcceptanceConfig {
  level?: AcceptanceLevel;
  criteria?: Array<string | AcceptanceGate>;
  evidence?: AcceptanceEvidenceKind[];
  verify?: AcceptanceVerifyCommand[];
  review?: AcceptanceReviewGate | false;
  stopRules?: string[];
  reason?: string;
}

export type AcceptanceInput = AcceptanceLevel | false | AcceptanceConfig;

export interface ResolvedAcceptanceGate extends AcceptanceGate {
  id: string;
  must: string;
  evidence: AcceptanceEvidenceKind[];
  severity: "required" | "recommended";
}

export interface ResolvedAcceptanceConfig {
  level: Exclude<AcceptanceLevel, "auto">;
  explicit: boolean;
  inferredReason: string[];
  criteria: ResolvedAcceptanceGate[];
  evidence: AcceptanceEvidenceKind[];
  verify: AcceptanceVerifyCommand[];
  review?: AcceptanceReviewGate | false;
  stopRules: string[];
  reason?: string;
}

export interface AcceptanceReport {
  criteriaSatisfied?: Array<{
    id?: string;
    status: "satisfied" | "not-satisfied" | "not-applicable";
    evidence: string;
  }>;
  changedFiles?: string[];
  testsAddedOrUpdated?: string[];
  commandsRun?: Array<{
    command: string;
    result: string;
    summary: string;
  }>;
  validationOutput?: string[];
  residualRisks?: string[];
  noStagedFiles?: boolean;
  diffSummary?: string;
  reviewFindings?: string[];
  manualNotes?: string;
  notes?: string;
}

export type AcceptanceRuntimeCheckStatus = "passed" | "failed" | "not-applicable";

export interface AcceptanceRuntimeCheck {
  id: string;
  status: AcceptanceRuntimeCheckStatus;
  message: string;
}

export interface AcceptanceVerifyResult {
  id: string;
  command: string;
  cwd?: string;
  exitCode: number | null;
  status: "passed" | "failed" | "timed-out" | "allowed-failure";
  stdout?: string;
  stderr?: string;
  durationMs: number;
}

export interface AcceptanceReviewResult {
  status: "no-blockers" | "blockers" | "needs-parent-decision";
  findings: Array<{
    severity: "blocker" | "non-blocking";
    file?: string;
    issue: string;
    rationale: string;
  }>;
}

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

export interface AcceptanceLedger {
  status: AcceptanceLedgerStatus;
  explicit: boolean;
  effectiveAcceptance: ResolvedAcceptanceConfig;
  inferredReason: string[];
  criteria: ResolvedAcceptanceGate[];
  childReport?: AcceptanceReport;
  childReportParseError?: string;
  runtimeChecks: AcceptanceRuntimeCheck[];
  verifyRuns: AcceptanceVerifyResult[];
  reviewResult?: AcceptanceReviewResult;
  parentDecision?: {
    status: "accepted" | "rejected";
    at: string;
    reason?: string;
  };
}

export interface SingleResult {
  agent: string;
  task: string;
  /** Exact approved project-agent config/provenance; never includes a capability. */
  projectAgent?: ProjectAgentRunCapture;
  exitCode: number;
  exitSignal?: NodeJS.Signals;
  interrupted?: boolean;
  timedOut?: boolean;
  toolBudget?: ToolBudgetState;
  toolBudgetBlocked?: boolean;
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
  /** Bounded stderr tail retained for diagnostics; durable raw stderr stays in the transcript. */
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
  structuredOutput?: unknown;
  structuredOutputPath?: string;
  structuredOutputSchemaPath?: string;
  acceptance?: AcceptanceLedger;
  pause?: ForegroundPauseMetadata;
  cancel?: AsyncCancellationMetadata;
  transcriptPath?: string;
  transcriptError?: string;
  activeRuntimeMs?: number;
  tkTicket?: TkTicketMetadata;
  children?: NestedRunSummary[];
}

export interface Details {
  mode: SubagentRunMode | "management";
  runId?: string;
  results: SingleResult[];
  controlEvents?: ControlEvent[];
  asyncId?: string;
  asyncDir?: string;
  timeoutMs?: number;
  deadlineAt?: number;
  timedOut?: boolean;
  toolBudget?: ResolvedToolBudget;
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

export interface ArtifactConfig {
  enabled: boolean;
  includeInput: boolean;
  includeOutput: boolean;
  includeJsonl: boolean;
  includeTranscript?: boolean;
  includeMetadata: boolean;
  cleanupDays: number;
}

// ============================================================================
// Async Execution
// ============================================================================

export type NestedRunState = "queued" | "running" | "complete" | "failed" | "paused";
type NestedOwnerState = "live" | "gone" | "unknown";

interface NestedRunAddress {
  id: string;
  parentRunId: string;
  parentStepIndex?: number;
  parentAgent?: string;
  depth: number;
  path: Array<{ runId: string; stepIndex?: number; agent?: string }>;
}

export interface NestedStepSummary {
  agent: string;
  projectAgent?: ProjectAgentRunCapture;
  /** Deny-only signal retained when a persisted project-agent marker is malformed. */
  projectAgentMarker?: true;
  status: "pending" | "running" | "complete" | "completed" | "failed" | "paused";
  terminationReason?: SubagentTerminationReason;
  sessionFile?: string;
  transcriptPath?: string;
  transcriptError?: string;
  activityState?: ActivityState;
  lastActivityAt?: number;
  currentTool?: string;
  currentToolStartedAt?: number;
  currentPath?: string;
  turnCount?: number;
  toolCount?: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  timedOut?: boolean;
  toolBudget?: ToolBudgetState;
  toolBudgetBlocked?: boolean;
  contextUsage?: ContextUsageDiagnostics;
  contextPressure?: ContextPressureProjection;
  contextPressureCrossedThresholds?: ContextPressureThreshold[];
  children?: NestedRunSummary[];
}

export interface NestedRunSummary extends NestedRunAddress {
  projectAgent?: ProjectAgentRunCapture;
  /** Deny-only signal retained when a persisted project-agent marker is malformed. */
  projectAgentMarker?: true;
  /** Persisted execution cwd used to validate a process-starting revival. */
  cwd?: string;
  asyncDir?: string;
  pid?: number;
  sessionId?: string;
  sessionFile?: string;
  ownerState?: NestedOwnerState;
  controlInbox?: string;
  capabilityToken?: string;
  mode?: SubagentRunMode;
  state: NestedRunState;
  agent?: string;
  agents?: string[];
  currentStep?: number;
  steps?: NestedStepSummary[];
  children?: NestedRunSummary[];
  activityState?: ActivityState;
  lastActivityAt?: number;
  currentTool?: string;
  currentToolStartedAt?: number;
  currentPath?: string;
  turnCount?: number;
  toolCount?: number;
  totalTokens?: TokenUsage;
  totalCost?: CostSummary;
  startedAt?: number;
  endedAt?: number;
  lastUpdate?: number;
  timeoutMs?: number;
  deadlineAt?: number;
  timedOut?: boolean;
  toolBudget?: ToolBudgetState;
  toolBudgetBlocked?: boolean;
  error?: string;
}

export interface NestedRouteInfo {
  rootRunId: string;
  eventSink: string;
  controlInbox: string;
  capabilityToken: string;
}

export interface TkTicketMetadata {
  id: string;
  title: string;
}

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
  /** Safe per-child project-agent captures; no opaque capability crosses this event. */
  projectAgents?: ProjectAgentRunCapture[];
  id?: string;
  asyncDir?: string;
  pid?: number;
  sessionId?: string;
  mode?: SubagentRunMode;
  agent?: string;
  agents?: string[];
  timeoutMs?: number;
  deadlineAt?: number;
  nestedRoute?: NestedRouteInfo;
  tkTicket?: TkTicketMetadata;
}

export interface AsyncStatus {
  lifecycleArtifactVersion?: SubagentLifecycleArtifactVersion;
  runId: string;
  sessionId?: string;
  mode: SubagentRunMode;
  state: AsyncLifecycleState;
  lifecycle?: AsyncLifecycleMetadata;
  pause?: AsyncPauseMetadata;
  cancel?: AsyncCancellationMetadata;
  error?: string;
  activityState?: ActivityState;
  lastActivityAt?: number;
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
  toolBudget?: ToolBudgetState;
  toolBudgetBlocked?: boolean;
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
    children?: NestedRunSummary[];
    sessionFile?: string;
    transcriptPath?: string;
    transcriptError?: string;
    activityState?: ActivityState;
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
    activeRuntimeMs?: number;
    timeoutMs?: number;
    deadlineAt?: number;
    exitCode?: number | null;
    exitSignal?: NodeJS.Signals;
    timedOut?: boolean;
    toolBudget?: ToolBudgetState;
    toolBudgetBlocked?: boolean;
    contextUsage?: ContextUsageDiagnostics;
    contextPressure?: ContextPressureProjection;
    contextPressureCrossedThresholds?: ContextPressureThreshold[];
    terminationReason?: SubagentTerminationReason;
    tokens?: TokenUsage;
    skills?: string[];
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
    structuredOutput?: unknown;
    structuredOutputPath?: string;
    structuredOutputSchemaPath?: string;
    acceptance?: AcceptanceLedger;
    pause?: AsyncPauseMetadata;
    cancel?: AsyncCancellationMetadata;
    /** Exact approved project-agent config/provenance; never includes a capability. */
    projectAgent?: ProjectAgentRunCapture;
  }>;
  sessionDir?: string;
  outputFile?: string;
  totalTokens?: TokenUsage;
  totalCost?: CostSummary;
  sessionFile?: string;
  tkTicket?: TkTicketMetadata;
  /** Safe per-child project-agent captures retained for status/control display. */
  projectAgents?: ProjectAgentRunCapture[];
}

export type AsyncJobStep = NonNullable<AsyncStatus["steps"]>[number] & {
  index?: number;
};

// ============================================================================
// Async Result Artifact
// ============================================================================

/**
 * Shape of one child step entry in the async result artifact.
 * All three result writers must be structurally compatible with this type.
 */
export interface AsyncResultArtifactResultItem {
  agent: string;
  /** Exact approved project-agent config/provenance; never includes a capability. */
  projectAgent?: ProjectAgentRunCapture;
  success: boolean;
  output: string;
  error?: string;
  stderr?: string;
  stderrTruncated?: boolean;
  protocolOutputLimit?: ProtocolOutputLimit;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals;
  skipped?: boolean;
  interrupted?: boolean;
  timedOut?: boolean;
  toolBudget?: ToolBudgetState;
  toolBudgetBlocked?: boolean;
  contextUsage?: ContextUsageDiagnostics;
  contextPressure?: ContextPressureProjection;
  contextPressureCrossedThresholds?: ContextPressureThreshold[];
  terminationReason?: SubagentTerminationReason;
  sessionFile?: string;
  model?: string;
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
  structuredOutput?: unknown;
  structuredOutputPath?: string;
  structuredOutputSchemaPath?: string;
  acceptance?: AcceptanceLedger;
  pause?: AsyncPauseMetadata;
  activeRuntimeMs?: number;
}

/**
 * Canonical shape of the async result artifact written to disk by all three
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
  id: string;
  agent: string;
  mode: SubagentRunMode;
  success: boolean;
  state: AsyncLifecycleState;
  summary: string;
  error?: string;
  timeoutMs?: number;
  deadlineAt?: number;
  toolBudget?: ToolBudgetState;
  toolBudgetBlocked?: boolean;
  timedOut?: boolean;
  pause?: AsyncPauseMetadata;
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
  projectAgents?: ProjectAgentRunCapture[];
  shareUrl?: string;
  gistUrl?: string;
  shareError?: string;
  taskIndex?: number;
  totalTasks?: number;
}

export interface AsyncJobState {
  asyncId: string;
  asyncDir: string;
  status: AsyncLifecycleState;
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
  toolBudget?: ToolBudgetState;
  toolBudgetBlocked?: boolean;
  sessionDir?: string;
  outputFile?: string;
  totalTokens?: TokenUsage;
  sessionFile?: string;
  controlEventCursor?: number;
  /** True while the cursor is inside an oversized JSONL record. */
  controlEventSkippingOversizedLine?: boolean;
  /** Device/inode identity of the events file at the cursor. */
  controlEventFileIdentity?: string;
  nestedRoute?: NestedRouteInfo;
  nestedChildren?: NestedRunSummary[];
  tkTicket?: TkTicketMetadata;
  /** Safe per-child captures retained for the run lifecycle. */
  projectAgents?: ProjectAgentRunCapture[];
}

export interface ForegroundResumeChild {
  agent: string;
  /** Exact approved project-agent config/provenance; never includes a capability. */
  projectAgent?: ProjectAgentRunCapture;
  index: number;
  sessionFile?: string;
  status: SubagentResultStatus;
  exitCode?: number;
  model?: string;
  thinking?: string;
  modelIdentity?: SubagentModelIdentity;
  modelResolution?: SubagentModelResolution;
  finalOutput?: string;
  artifactPaths?: ArtifactPaths;
  transcriptPath?: string;
  transcriptError?: string;
  acceptance?: AcceptanceLedger;
  pause?: ForegroundPauseMetadata;
  cancel?: AsyncCancellationMetadata;
  contextUsage?: ContextUsageDiagnostics;
  contextPressure?: ContextPressureProjection;
  contextPressureCrossedThresholds?: ContextPressureThreshold[];
  terminationReason?: SubagentTerminationReason;
  activeRuntimeMs?: number;
  updatedAt?: number;
}

export interface ForegroundResumeRun {
  runId: string;
  mode: SubagentRunMode;
  cwd: string;
  updatedAt: number;
  children: ForegroundResumeChild[];
}

export interface ForegroundRunControl {
  runId: string;
  mode: SubagentRunMode;
  startedAt: number;
  updatedAt: number;
  currentAgent?: string;
  currentIndex?: number;
  currentActivityState?: ActivityState;
  lastActivityAt?: number;
  currentTool?: string;
  currentToolStartedAt?: number;
  currentPath?: string;
  turnCount?: number;
  tokens?: number;
  toolCount?: number;
  nestedRoute?: NestedRouteInfo;
  nestedChildren?: NestedRunSummary[];
  interrupt?: () => boolean;
  activeInterrupts?: Map<number, () => boolean>;
  messageInboxRoot?: string;
  activeMessageInboxes?: Map<number, string>;
}

export interface SubagentState {
  baseCwd: string;
  currentSessionId: string | null;
  subagentInProgress?: boolean;
  asyncJobs: Map<string, AsyncJobState>;
  foregroundRuns?: Map<string, ForegroundResumeRun>;
  foregroundControls: Map<string, ForegroundRunControl>;
  lastForegroundControlId: string | null;
  pendingForegroundControlNotices?: Map<string, ReturnType<typeof setTimeout>>;
  cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
  lastUiContext: ExtensionContext | null;
  liveDetailController?: SubagentLiveDetailController;
  poller: NodeJS.Timeout | null;
  completionSeen: Map<string, number>;
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
export const SUBAGENT_CONTROL_EVENT = "subagent:control-event";

// ============================================================================
// Execution Options
// ============================================================================

export interface RunSyncOptions {
  /** Session id of the direct parent session for permission-system ask forwarding. */
  parentSessionId?: string;
  /** Exact approved project-agent config/provenance; never includes a capability. */
  projectAgent?: ProjectAgentRunCapture;
  tkTicket?: TkTicketMetadata;
  onSupervisorPauseTransition?: (
    input:
      | { stage: "pausing"; result: SingleResult; ownerPid?: number }
      | { stage: "paused"; result: SingleResult },
  ) => void;
  cwd?: string;
  signal?: AbortSignal;
  interruptSignal?: AbortSignal;
  timeoutMs?: number;
  deadlineAt?: number;
  toolBudget?: ResolvedToolBudget;
  pauseBlockingSupervisor?: boolean;
  onUpdate?: (r: SubagentToolResult<Details>) => void;
  onControlEvent?: (event: ControlEvent) => void;
  controlConfig?: ResolvedControlConfig;
  maxOutput?: MaxOutputConfig;
  artifactsDir?: string;
  artifactConfig?: ArtifactConfig;
  runId: string;
  index?: number;
  sessionDir?: string;
  sessionFile?: string;
  share?: boolean;
  outputPath?: string;
  outputMode?: OutputMode;
  maxSubagentDepth?: number;
  nestedRoute?: NestedRouteInfo;
  /** Override the agent's default model (format: "provider/id" or just "id") */
  modelOverride?: string;
  /** Durable explanation for a restored or explicitly overridden model selection. */
  modelResolution?: SubagentModelResolution;
  /** Per-execution fallback models tried before agent frontmatter fallback models. */
  fallbackModels?: string[];
  /** Latest persisted display projection restored for the same execution segment. */
  contextPressure?: ContextPressureProjection;
  /** Thresholds already crossed in this execution, used for restart-safe deduplication. */
  contextPressureCrossedThresholds?: ContextPressureThreshold[];
  /** Optional bounded notice for a supplied fallback retry and/or registry filtering. */
  modelFallbackNotice?: string;
  /** Registry models available for model resolution and thinking-capability checks */
  availableModels?: import("./model-info.ts").ModelInfo[];
  /** Catalog/error evidence used to conservatively filter unavailable fallbacks. */
  modelRegistry?: import("../runs/shared/model-fallback.ts").ModelRegistryEvidence;
  /** Current parent-session provider to prefer for ambiguous bare model ids */
  preferredModelProvider?: string;
  /** Optional subagent model-scope enforcement for fallback candidates */
  modelScope?: ModelScopeConfig;
  /** Skills to make available (overrides agent default if provided) */
  skills?: string[];
  structuredOutput?: {
    schema: JsonSchemaObject;
    schemaPath: string;
    outputPath: string;
  };
  steerInboxDir?: string;
  acceptance?: AcceptanceInput;
  acceptanceContext?: {
    mode?: SubagentRunMode;
    async?: boolean;
  };
}

interface TopLevelParallelConfig {
  maxTasks?: number;
  concurrency?: number;
}

export interface ExtensionConfig {
  maxSubagentDepth?: number;
  control?: ControlConfig;
  parallel?: TopLevelParallelConfig;
  heartbeat?: import("../runs/shared/heartbeat-config.ts").HeartbeatConfig;
}

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_MAX_OUTPUT: Required<MaxOutputConfig> = {
  bytes: 200 * 1024,
  lines: 5000,
};

export const DEFAULT_ARTIFACT_CONFIG: ArtifactConfig = {
  enabled: true,
  includeInput: true,
  includeOutput: true,
  includeJsonl: false,
  includeTranscript: true,
  includeMetadata: true,
  cleanupDays: 7,
};

function sanitizeTempScopeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}

function resolveTempScopeId(options?: {
  env?: NodeJS.ProcessEnv;
  getuid?: (() => number) | undefined;
  userInfo?: (() => { username?: string | null }) | undefined;
  homedir?: (() => string) | undefined;
}): string {
  const env = options?.env ?? process.env;
  const getuid =
    options && Object.hasOwn(options, "getuid") ? options.getuid : process.getuid?.bind(process);
  if (typeof getuid === "function") {
    return `uid-${getuid()}`;
  }

  for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
    const value = env[key];
    if (value) return `user-${sanitizeTempScopeSegment(value)}`;
  }

  const userInfo = options && Object.hasOwn(options, "userInfo") ? options.userInfo : os.userInfo;
  try {
    const username = userInfo?.().username;
    if (username) return `user-${sanitizeTempScopeSegment(username)}`;
  } catch {
    // Fall through to home-directory-based scoping.
  }

  const homedir = env.USERPROFILE ?? env.HOME;
  if (homedir) return `home-${sanitizeTempScopeSegment(homedir)}`;

  const resolveHomedir =
    options && Object.hasOwn(options, "homedir") ? options.homedir : os.homedir;
  try {
    const fallbackHomedir = resolveHomedir?.();
    if (fallbackHomedir) return `home-${sanitizeTempScopeSegment(fallbackHomedir)}`;
  } catch {
    // Fall through to the last-resort shared scope.
  }

  return "shared";
}

const MAX_PARALLEL = 8;
const MAX_CONCURRENCY = 4;

/**
 * Resolve the temp root directory used for async run state.
 *
 * Fork delta (GitHub issue #45): integration tests previously shared the
 * uid-scoped temp root with live sessions, causing ghost notifications when
 * test runs left stale async/result files behind. Setting
 * PI_SUBAGENTS_TEMP_ROOT to a non-empty (trimmed) path redirects the temp
 * root (and all directories derived from it) away from the shared
 * os.tmpdir()+scope-id location, without changing default behavior when the
 * variable is unset or blank.
 */
export function resolveTempRootDir(options?: {
  env?: NodeJS.ProcessEnv;
  getuid?: (() => number) | undefined;
  userInfo?: (() => { username?: string | null }) | undefined;
  homedir?: (() => string) | undefined;
}): string {
  const env = options?.env ?? process.env;
  const override = env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  if (override) {
    return override;
  }
  return path.join(os.tmpdir(), `pi-subagents-${resolveTempScopeId(options)}`);
}

export const TEMP_ROOT_DIR = resolveTempRootDir();
export const RESULTS_DIR = path.join(TEMP_ROOT_DIR, "async-subagent-results");
export const ASYNC_DIR = path.join(TEMP_ROOT_DIR, "async-subagent-runs");
export const TEMP_ARTIFACTS_DIR = path.join(TEMP_ROOT_DIR, "artifacts");
export const WIDGET_KEY = "subagent-async";
export const SLASH_TEXT_RESULT_TYPE = "subagent-slash-text-result";
export const POLL_INTERVAL_MS = 250;
export const MAX_WIDGET_JOBS = 4;
export const DEFAULT_SUBAGENT_MAX_DEPTH = 2;
export const SUBAGENT_ACTIONS = [
  "list",
  "get",
  "status",
  "interrupt",
  "resume",
  "steer",
  "doctor",
] as const;

function normalizeTopLevelParallelValue(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  return parsed;
}

export function resolveTopLevelParallelMaxTasks(value: unknown): number {
  return normalizeTopLevelParallelValue(value) ?? MAX_PARALLEL;
}

export function resolveTopLevelParallelConcurrency(
  override: unknown,
  configValue: unknown,
): number {
  return (
    normalizeTopLevelParallelValue(override) ??
    normalizeTopLevelParallelValue(configValue) ??
    MAX_CONCURRENCY
  );
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

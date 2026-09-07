import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentDiscoveryDiagnostic } from "../../agents/agents.ts";
import { validateProjectAgentCwdContainment } from "../../agents/project-agent-loader.ts";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.ts";
import { resolveCurrentMaxSubagentDepth, checkSubagentDepth } from "../../shared/types.ts";
import {
  PROJECT_AGENT_TERMINAL_RETENTION_MS,
  normalizeProjectAgentRunCapture,
  projectAgentRunCaptureEquals,
  releaseProjectAgentRunReference,
  type ProjectAgentRunCapture,
  type ProjectAgentRunReferenceLookup,
} from "../../agents/project-agent-snapshot.ts";
import { getArtifactsDir } from "../../shared/artifacts.ts";
import {
  FOREGROUND_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE,
  UNCHANGED_SUPERVISOR_RESUME_MESSAGE,
} from "../../shared/foreground-pause.ts";
import { toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import {
  canonicalSubagentModelIdentity,
  modelReferenceFromIdentity,
  sanitizeSubagentModelIdentity,
  sanitizeSubagentModelResolution,
} from "../shared/model-fallback.ts";
import type { ModelRegistryEvidence } from "../shared/model-fallback.ts";
import { executeAsyncSingle, formatAsyncStartedMessage } from "../background/async-execution.ts";
import {
  formatControlNoticeMessage,
  resolveControlConfig,
  shouldNotifyControlEvent,
} from "../shared/subagent-control.ts";
import {
  buildRevivedAsyncTask,
  resolveAsyncResumeTarget,
  resolveAsyncRunLocation,
} from "../background/async-resume.ts";
import {
  lifecycleContinuationForIndex,
  lifecycleGeneration,
  markLifecycleContinuationSpawned,
  recoverStaleLifecycleContinuationClaim,
  recoverStaleLifecycleContinuationStatus,
  transitionLifecycleStatus,
  withLifecycleContinuation,
  withLifecycleStatusLock,
  writeNormalizedLifecycleStatus,
} from "../shared/lifecycle-state.ts";
import {
  childMessageAckPath,
  deliverInterruptRequest,
  requestAsyncResume,
  requestAsyncSteer,
  waitForChildMessageAcceptance,
} from "../background/control-channel.ts";
import { reconcileAsyncRun } from "../background/stale-run-reconciler.ts";
import { resolveNestedAsyncDir } from "../shared/nested-events.ts";
import { resolveSubagentRunId, type ResolvedSubagentRunId } from "../background/run-id-resolver.ts";
import {
  assessDurableResumeContext,
  formatDurableResumeContextBlock,
  parseContextPressureCrossedThresholds,
  parseContextPressureProjection,
  parseContextUsageDiagnostics,
  resolveEffectiveContextWindow,
} from "../../shared/context-diagnostics.ts";
import { formatNestedRunStatusLines } from "../shared/nested-render.ts";
import { readStatus } from "../../shared/utils.ts";
import { getProviderAwareFallbackModels } from "../../../../the-last-harness-subagent-safety.mjs";
import {
  type AsyncStatus,
  type ControlEvent,
  type Details,
  type NestedRunSummary,
  type ResolvedArtifactConfig,
  type ResolvedControlConfig,
  type SingleResult,
  type SubagentModelResolution,
  type SubagentRunMode,
  type SubagentState,
  type SubagentToolResult,
  ASYNC_DIR,
  RESULTS_DIR,
  SUBAGENT_CONTROL_EVENT,
  TEMP_ROOT_DIR,
} from "../../shared/types.ts";
import {
  remainingExecutionTimeMs,
  type ResolvedExecutionPolicy,
} from "../../agents/execution-ceiling.ts";
import type { AuthorizedProjectAgentRun } from "./project-agent-control.ts";
import {
  hasMalformedProjectAgentControlMarker,
  hasProjectAgentControlMarker,
  isRecordValue,
  lookupPrivateProjectActionReference,
  projectRunAuthorizationError,
  requirePersistedProjectCaptureForTarget,
  authorizePersistedProjectAgentRun,
  rejectMissingPrivateProjectReference,
} from "./project-agent-control.ts";
import type { ExecutorDeps, SubagentParamsLike } from "./subagent-executor.ts";
import {
  indexedLifecycleContinuation,
  isClaimedPausedLifecycle,
  pausedForegroundStatusPath,
  pausedForegroundTerminationReason,
} from "./foreground-pause-state.ts";
import {
  normalizeActiveRuntimeCheckpointAt,
  normalizeActiveRuntimeMs,
} from "../shared/lifecycle-state.ts";
import { resolveSubagentResultStatus } from "../../shared/result-formatting.ts";
import { updateForegroundNestedProjection } from "../shared/nested-events.ts";
import {
  retainProjectAgentRunReference,
  retainProjectAgentRunReferenceFrom,
} from "../../agents/project-agent-snapshot.ts";
import type { AgentScope } from "../../agents/agents.ts";

const NESTED_ASYNC_RUNS_DIR = path.join(TEMP_ROOT_DIR, "nested-subagent-runs");
const FOREGROUND_LIVE_MESSAGE_INBOXES_DIR = path.join(
  TEMP_ROOT_DIR,
  "foreground-live-message-inboxes",
);

interface ModelRegistrySnapshot {
  availableModels: ModelInfo[];
  evidence: ModelRegistryEvidence;
}

/**
 * Capture both registry views used by fallback policy. `getAvailable()` is an
 * auth-filtered view; `getAll()` is the catalog needed to distinguish a model
 * that is positively unavailable from one omitted by a partial/stale view.
 * Test/legacy facades may expose only getAvailable(), so missing methods fail
 * open and preserve configured fallbacks.
 */
export function readModelRegistrySnapshot(ctx: ExtensionContext): ModelRegistrySnapshot {
  // Test/legacy facades may expose only getAvailable(); keep the optional
  // compatibility surface separate from the typed availability call.
  type ModelRegistryEntry = Parameters<typeof toModelInfo>[0];
  const optionalRegistry = ctx.modelRegistry as {
    getAll?: () => ModelRegistryEntry[];
    getError?: () => string | undefined;
  };
  const availableModels = ctx.modelRegistry.getAvailable().map(toModelInfo);
  let allModels: ModelInfo[] | undefined;
  let error: string | undefined;
  if (typeof optionalRegistry.getAll === "function") {
    try {
      allModels = optionalRegistry.getAll().map(toModelInfo);
    } catch {
      error = "model catalog unavailable";
    }
  }
  if (typeof optionalRegistry.getError === "function") {
    try {
      error ??= optionalRegistry.getError();
    } catch {
      error = "model availability status unavailable";
    }
  }
  return {
    availableModels,
    evidence: {
      ...(allModels ? { allModels } : {}),
      ...(error ? { error } : {}),
    },
  };
}

export const providerFallbackModelsForTarget = getProviderAwareFallbackModels;

export function resolveSingleRunOutputBaseDir(artifactsDir: string, runId: string): string {
  return path.join(artifactsDir, "outputs", runId);
}

function diagnosticMatchesAgent(diagnostic: AgentDiscoveryDiagnostic, agentName: string): boolean {
  if (diagnostic.error.includes(`Agent '${agentName}'`)) return true;
  const localName = diagnostic.error.match(/Agent '([^']+)'/)?.[1];
  if (localName !== undefined && agentName.endsWith(`.${localName}`)) return true;
  const fileName = path.basename(diagnostic.filePath, path.extname(diagnostic.filePath));
  return agentName === fileName || agentName.endsWith(`.${fileName}`);
}

export function unknownAgentMessage(
  agentName: string,
  agentDiagnostics: AgentDiscoveryDiagnostic[] | undefined,
  prefix = "Unknown agent",
): string {
  const diagnostic = agentDiagnostics?.find((candidate) =>
    diagnosticMatchesAgent(candidate, agentName),
  );
  if (!diagnostic) return `${prefix}: ${agentName}`;
  return `${prefix}: ${agentName}. Malformed definition at '${diagnostic.filePath}': ${diagnostic.error}`;
}
function releaseProjectSourceAfterContinuation(target: ResumeSourceTarget): void {
  if (!("projectAgent" in target) || !target.projectAgent) return;
  const sourceStatus =
    "asyncDir" in target && target.asyncDir ? readStatus(target.asyncDir) : undefined;
  const state = sourceStatus?.state ?? target.state;
  if (state === "paused" || state === "pausing" || state === "running" || state === "queued") {
    // A cohort source can retain other paused/running children after one child
    // launches a continuation; its generation must stay alive for them.
    return;
  }
  if (state === "complete" || state === "failed") {
    const releaseTimer = setTimeout(
      () => releaseProjectAgentRunReference(target.runId),
      PROJECT_AGENT_TERMINAL_RETENTION_MS,
    );
    releaseTimer.unref?.();
    return;
  }
  releaseProjectAgentRunReference(target.runId);
}

export function getForegroundControl(state: SubagentState, runId: string | undefined) {
  if (runId) return state.foregroundControls.get(runId);
  if (state.lastForegroundControlId) {
    const latest = state.foregroundControls.get(state.lastForegroundControlId);
    if (latest) return latest;
  }
  let newest:
    | (SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never)
    | undefined;
  for (const control of state.foregroundControls.values()) {
    if (!newest || control.updatedAt > newest.updatedAt) newest = control;
  }
  return newest;
}

function formatForegroundActivity(
  control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never,
): string | undefined {
  const facts: string[] = [];
  if (control.currentTool && control.currentToolStartedAt)
    facts.push(
      `tool ${control.currentTool} for ${Math.floor(Math.max(0, Date.now() - control.currentToolStartedAt) / 1000)}s`,
    );
  else if (control.currentTool) facts.push(`tool ${control.currentTool}`);
  if (control.currentPath) facts.push(`path ${control.currentPath}`);
  if (control.turnCount !== undefined) facts.push(`${control.turnCount} turns`);
  if (control.tokens !== undefined) facts.push(`${control.tokens} tokens`);
  if (control.toolCount !== undefined) facts.push(`${control.toolCount} tools`);
  if (!control.lastActivityAt) {
    if (control.currentActivityState === "needs_attention")
      return ["needs attention", ...facts].join(" | ");
    if (control.currentActivityState === "active_long_running")
      return ["active but long-running", ...facts].join(" | ");
    return facts.length ? facts.join(" | ") : undefined;
  }
  const seconds = Math.floor(Math.max(0, Date.now() - control.lastActivityAt) / 1000);
  if (control.currentActivityState === "needs_attention")
    return [`no activity for ${seconds}s`, ...facts].join(" | ");
  if (control.currentActivityState === "active_long_running")
    return [`active but long-running; last activity ${seconds}s ago`, ...facts].join(" | ");
  return [`active ${seconds}s ago`, ...facts].join(" | ");
}

export function trustedSessionRootsForStatus(ctx: ExtensionContext, deps: ExecutorDeps): string[] {
  const roots: string[] = [];
  const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
  if (parentSessionFile) roots.push(deps.getSubagentSessionRoot(parentSessionFile));
  return [...new Set(roots)];
}

export function foregroundStatusResult(
  control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never,
): SubagentToolResult<Details> {
  let nestedWarning: string | undefined;
  try {
    updateForegroundNestedProjection(control);
  } catch (error) {
    nestedWarning = `Nested status unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  const activity = formatForegroundActivity(control);
  const lines = [
    `Run: ${control.runId}`,
    "State: running",
    `Mode: ${control.mode}`,
    control.currentAgent
      ? `Current: ${control.currentAgent}${control.currentIndex !== undefined ? ` step ${control.currentIndex + 1}` : ""}`
      : undefined,
    activity ? `Activity: ${activity}` : undefined,
  ].filter((line): line is string => Boolean(line));
  lines.push(
    ...formatNestedRunStatusLines(control.nestedChildren, {
      indent: "",
      commandHints: true,
      maxLines: 20,
    }),
  );
  if (nestedWarning) lines.push(`Warning: ${nestedWarning}`);
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { mode: "management", results: [] },
  };
}

function foregroundRunHasResumableState(run: {
  runId: string;
  children: readonly {
    status: string;
    sessionFile?: string;
  }[];
}): boolean {
  const persistedPath = pausedForegroundStatusPath(run.runId);
  try {
    const status = readStatus(persistedPath);
    if (status) {
      if (status.state === "paused" || status.state === "pausing" || status.state === "running") {
        return true;
      }
      if (
        status.steps?.some(
          (step) =>
            step.status !== "continued" &&
            step.status !== "cancelled" &&
            (step.status === "paused" ||
              step.status === "pausing" ||
              step.status === "pending" ||
              step.status === "running" ||
              step.sessionFile !== undefined),
        )
      ) {
        return true;
      }
      return false;
    }
  } catch {
    // Unknown persisted state is retained rather than releasing authority.
    return true;
  }
  return (
    run.children.length === 0 ||
    run.children.some(
      (child) =>
        child.status === "paused" ||
        child.status === "pausing" ||
        child.status === "pending" ||
        child.status === "running" ||
        ((child.status === "completed" || child.status === "failed") &&
          child.sessionFile !== undefined),
    )
  );
}

function scheduleForegroundProjectReferenceRelease(runId: string): void {
  const releaseTimer = setTimeout(
    () => releaseProjectAgentRunReference(runId),
    PROJECT_AGENT_TERMINAL_RETENTION_MS,
  );
  releaseTimer.unref?.();
}

export function trimRememberedForegroundRuns(state: SubagentState): void {
  if (!state.foregroundRuns) return;
  while (state.foregroundRuns.size > 50) {
    const oldest = [...state.foregroundRuns.values()].sort(
      (left, right) => left.updatedAt - right.updatedAt,
    )[0];
    if (!oldest) break;
    state.foregroundRuns.delete(oldest.runId);
    if (!foregroundRunHasResumableState(oldest)) {
      scheduleForegroundProjectReferenceRelease(oldest.runId);
    }
  }
}

export function rememberForegroundRun(
  state: SubagentState,
  input: {
    runId: string;
    mode: SubagentRunMode;
    cwd: string;
    results: SingleResult[];
  },
): void {
  state.foregroundRuns ??= new Map();
  const updatedAt = Date.now();
  state.foregroundRuns.set(input.runId, {
    runId: input.runId,
    mode: input.mode,
    cwd: input.cwd,
    updatedAt,
    children: input.results.map((result, index) => {
      const activeRuntimeMs =
        normalizeActiveRuntimeMs(result.activeRuntimeMs) ??
        normalizeActiveRuntimeMs(result.progress?.durationMs);
      const child = {
        agent: result.agent,
        ...(result.projectAgent ? { projectAgent: result.projectAgent } : {}),
        index,
        status: resolveSubagentResultStatus({
          exitCode: result.exitCode,
          interrupted: result.interrupted,
        }),
        updatedAt,
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        ...(result.model ? { model: result.model } : {}),
        ...(result.thinking ? { thinking: result.thinking } : {}),
        ...(result.modelIdentity ? { modelIdentity: result.modelIdentity } : {}),
        ...(result.modelResolution ? { modelResolution: result.modelResolution } : {}),
        ...(result.finalOutput ? { finalOutput: result.finalOutput } : {}),
        ...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
        ...(result.artifactPaths ? { artifactPaths: result.artifactPaths } : {}),
        ...(result.transcriptPath ? { transcriptPath: result.transcriptPath } : {}),
        ...(result.transcriptError ? { transcriptError: result.transcriptError } : {}),
        ...(result.acceptance ? { acceptance: result.acceptance } : {}),
        ...(result.pause ? { pause: result.pause } : {}),
        ...(result.cancel ? { cancel: result.cancel } : {}),
        ...(result.contextUsage ? { contextUsage: result.contextUsage } : {}),
        ...(result.contextPressure ? { contextPressure: { ...result.contextPressure } } : {}),
        ...(result.contextPressureCrossedThresholds
          ? { contextPressureCrossedThresholds: [...result.contextPressureCrossedThresholds] }
          : {}),
        ...(pausedForegroundTerminationReason(result)
          ? { terminationReason: pausedForegroundTerminationReason(result) }
          : {}),
        ...(activeRuntimeMs !== undefined ? { activeRuntimeMs } : {}),
        ...(normalizeActiveRuntimeCheckpointAt(result.activeRuntimeCheckpointAt) !== undefined
          ? {
              activeRuntimeCheckpointAt: normalizeActiveRuntimeCheckpointAt(
                result.activeRuntimeCheckpointAt,
              ),
            }
          : {}),
      };
      return child;
    }),
  });
  trimRememberedForegroundRuns(state);
}

export function updateRememberedForegroundChild(
  state: SubagentState,
  input: {
    runId: string;
    mode: SubagentRunMode;
    cwd: string;
    index: number;
    result: SingleResult;
  },
): void {
  state.foregroundRuns ??= new Map();
  const updatedAt = Date.now();
  let run = state.foregroundRuns.get(input.runId);
  if (!run) {
    run = { runId: input.runId, mode: input.mode, cwd: input.cwd, updatedAt, children: [] };
    state.foregroundRuns.set(input.runId, run);
  }
  run.updatedAt = updatedAt;
  const child = run.children[input.index] ?? {
    agent: input.result.agent,
    index: input.index,
  };
  const activeRuntimeMs =
    normalizeActiveRuntimeMs(input.result.activeRuntimeMs) ??
    normalizeActiveRuntimeMs(input.result.progress?.durationMs);
  run.children[input.index] = {
    ...child,
    agent: input.result.agent,
    ...(input.result.projectAgent ? { projectAgent: input.result.projectAgent } : {}),
    index: input.index,
    status: resolveSubagentResultStatus({
      exitCode: input.result.exitCode,
      interrupted: input.result.interrupted,
    }),
    updatedAt,
    ...(input.result.exitCode !== undefined ? { exitCode: input.result.exitCode } : {}),
    ...(input.result.model ? { model: input.result.model } : {}),
    ...(input.result.thinking ? { thinking: input.result.thinking } : {}),
    ...(input.result.modelIdentity ? { modelIdentity: input.result.modelIdentity } : {}),
    ...(input.result.modelResolution ? { modelResolution: input.result.modelResolution } : {}),
    ...(input.result.finalOutput ? { finalOutput: input.result.finalOutput } : {}),
    ...(input.result.sessionFile ? { sessionFile: input.result.sessionFile } : {}),
    ...(input.result.artifactPaths ? { artifactPaths: input.result.artifactPaths } : {}),
    ...(input.result.transcriptPath ? { transcriptPath: input.result.transcriptPath } : {}),
    ...(input.result.transcriptError ? { transcriptError: input.result.transcriptError } : {}),
    ...(input.result.acceptance ? { acceptance: input.result.acceptance } : {}),
    ...(input.result.pause ? { pause: input.result.pause } : {}),
    ...(input.result.cancel ? { cancel: input.result.cancel } : {}),
    ...(input.result.contextUsage ? { contextUsage: input.result.contextUsage } : {}),
    ...(input.result.contextPressure
      ? { contextPressure: { ...input.result.contextPressure } }
      : {}),
    ...(input.result.contextPressureCrossedThresholds
      ? { contextPressureCrossedThresholds: [...input.result.contextPressureCrossedThresholds] }
      : {}),
    ...(pausedForegroundTerminationReason(input.result)
      ? { terminationReason: pausedForegroundTerminationReason(input.result) }
      : {}),
    ...(activeRuntimeMs !== undefined ? { activeRuntimeMs } : {}),
    ...(normalizeActiveRuntimeCheckpointAt(input.result.activeRuntimeCheckpointAt) !== undefined
      ? {
          activeRuntimeCheckpointAt: normalizeActiveRuntimeCheckpointAt(
            input.result.activeRuntimeCheckpointAt,
          ),
        }
      : {}),
  };
  trimRememberedForegroundRuns(state);
}

export function resolveRememberedForegroundRun(
  params: SubagentParamsLike,
  state: SubagentState,
):
  | {
      run: import("../../shared/types.ts").ForegroundResumeRun;
      index: number;
      child: import("../../shared/types.ts").ForegroundResumeChild;
    }
  | undefined {
  const requested = params.id?.trim();
  if (!requested || !state.foregroundRuns?.size) return undefined;
  const direct = state.foregroundRuns.get(requested);
  const matches = direct
    ? [direct]
    : [...state.foregroundRuns.values()].filter((run) => run.runId.startsWith(requested));
  if (matches.length === 0) return undefined;
  if (matches.length > 1)
    throw new Error(
      `Ambiguous foreground run id prefix '${requested}' matched: ${matches.map((run) => run.runId).join(", ")}. Provide a longer id.`,
    );
  const run = matches[0]!;
  if (run.children.length > 1 && params.index === undefined)
    throw new Error(
      `Foreground run '${run.runId}' has ${run.children.length} children. Provide index to choose one.`,
    );
  const index = params.index ?? 0;
  if (!Number.isInteger(index))
    throw new Error(`Foreground run '${run.runId}' index must be an integer.`);
  if (index < 0 || index >= run.children.length)
    throw new Error(
      `Foreground run '${run.runId}' has ${run.children.length} children. Index ${index} is out of range.`,
    );
  return { run, index, child: run.children[index]! };
}

function resolveForegroundResumeTarget(
  params: SubagentParamsLike,
  state: SubagentState,
):
  | {
      runId: string;
      mode: SubagentRunMode;
      state: "complete" | "failed" | "paused";
      agent: string;
      index: number;
      cwd: string;
      sessionFile: string;
      asyncDir?: string;
      pauseKind?: "awaiting_supervisor" | "cohort_pause";
      continuationAcceptance?: import("../../shared/types.ts").ResolvedAcceptanceConfig;
      modelIdentity?: import("../../shared/types.ts").SubagentModelIdentity;
      modelResolution?: import("../../shared/types.ts").SubagentModelResolution;
      contextUsage?: import("../../shared/types.ts").ContextUsageDiagnostics;
      contextPressure?: import("../../shared/types.ts").ContextPressureProjection;
      contextPressureCrossedThresholds?: import("../../shared/types.ts").ContextPressureThreshold[];
      activeRuntimeMs?: number;
      activeRuntimeCheckpointAt?: number;
      projectAgents?: ProjectAgentRunCapture[];
    }
  | undefined {
  const resolved = resolveRememberedForegroundRun(params, state);
  if (!resolved) return undefined;
  const { run, index, child } = resolved;
  if (child.cancel?.cancelledAt)
    throw new Error(
      `Foreground run '${run.runId}' child ${index} was cancelled while paused and cannot be resumed. Inspect status and any retained output/session artifacts if needed; compact mode may omit the diagnostic child transcript.`,
    );
  if (!child.sessionFile)
    throw new Error(
      `Foreground run '${run.runId}' child ${index} does not have a persisted session file to resume from.`,
    );
  if (path.extname(child.sessionFile) !== ".jsonl")
    throw new Error(
      `Foreground run '${run.runId}' child ${index} session file must be a .jsonl file.`,
    );
  const sessionFile = path.resolve(child.sessionFile);
  if (!fs.existsSync(sessionFile))
    throw new Error(`Foreground run '${run.runId}' child ${index} session file is missing.`);
  const childState = child.status === "completed" ? "complete" : child.status;
  const projectAgentMarker = Object.hasOwn(child, "projectAgent")
    ? normalizeProjectAgentRunCapture(child.projectAgent)
    : undefined;
  if (Object.hasOwn(child, "projectAgent") && !projectAgentMarker) {
    throw projectRunAuthorizationError(
      `Foreground run '${run.runId}' child ${index} has an invalid project-agent marker.`,
    );
  }
  const projectAgentMarkers = run.children.flatMap((candidate) => {
    if (!Object.hasOwn(candidate, "projectAgent")) return [];
    const marker = normalizeProjectAgentRunCapture(candidate.projectAgent);
    if (!marker) {
      throw projectRunAuthorizationError(
        `Foreground run '${run.runId}' has an invalid project-agent marker on child ${candidate.index}.`,
      );
    }
    return [marker];
  });
  const childModelIdentity =
    child.modelIdentity ?? canonicalSubagentModelIdentity(child.model, child.thinking);
  const continuationAcceptance =
    childState === "paused" && child.acceptance?.status === "skipped"
      ? child.acceptance.effectiveAcceptance
      : undefined;
  return {
    runId: run.runId,
    mode: run.mode,
    state: childState,
    agent: child.agent,
    ...(projectAgentMarker ? { projectAgent: projectAgentMarker } : {}),
    index,
    cwd: run.cwd,
    sessionFile,
    ...(fs.existsSync(pausedForegroundStatusPath(run.runId))
      ? { asyncDir: pausedForegroundStatusPath(run.runId) }
      : {}),
    ...(child.pause?.kind ? { pauseKind: child.pause.kind } : {}),
    ...(continuationAcceptance ? { continuationAcceptance } : {}),
    ...(childModelIdentity ? { modelIdentity: childModelIdentity } : {}),
    ...(projectAgentMarkers.length > 0 ? { projectAgents: projectAgentMarkers } : {}),
    ...(child.modelResolution ? { modelResolution: child.modelResolution } : {}),
    ...(parseContextUsageDiagnostics(child.contextUsage)
      ? { contextUsage: parseContextUsageDiagnostics(child.contextUsage) }
      : {}),
    ...(parseContextPressureProjection(child.contextPressure)
      ? { contextPressure: parseContextPressureProjection(child.contextPressure) }
      : {}),
    ...(parseContextPressureCrossedThresholds(child.contextPressureCrossedThresholds)
      ? {
          contextPressureCrossedThresholds: parseContextPressureCrossedThresholds(
            child.contextPressureCrossedThresholds,
          ),
        }
      : {}),
    ...(normalizeActiveRuntimeMs(child.activeRuntimeMs) !== undefined
      ? { activeRuntimeMs: normalizeActiveRuntimeMs(child.activeRuntimeMs) }
      : {}),
    ...(normalizeActiveRuntimeCheckpointAt(child.activeRuntimeCheckpointAt) !== undefined
      ? {
          activeRuntimeCheckpointAt: normalizeActiveRuntimeCheckpointAt(
            child.activeRuntimeCheckpointAt,
          ),
        }
      : {}),
  };
}

type AsyncResumeSourceTarget = ReturnType<typeof resolveAsyncResumeTarget> & { source: "async" };
type ForegroundResumeSourceTarget = NonNullable<
  ReturnType<typeof resolveForegroundResumeTarget>
> & {
  kind: "revive";
  source: "foreground";
};
type NestedResumeSourceTarget = {
  kind: "revive";
  source: "nested";
  runId: string;
  state: "complete" | "failed" | "paused";
  agent: string;
  projectAgent?: ProjectAgentRunCapture;
  index: number;
  cwd?: string;
  sessionFile: string;
  pauseKind?: "awaiting_supervisor" | "cohort_pause";
  continuationAcceptance?: import("../../shared/types.ts").ResolvedAcceptanceConfig;
  modelIdentity?: import("../../shared/types.ts").SubagentModelIdentity;
  modelResolution?: import("../../shared/types.ts").SubagentModelResolution;
  contextUsage?: import("../../shared/types.ts").ContextUsageDiagnostics;
  contextPressure?: import("../../shared/types.ts").ContextPressureProjection;
  contextPressureCrossedThresholds?: import("../../shared/types.ts").ContextPressureThreshold[];
  activeRuntimeMs?: number;
  activeRuntimeCheckpointAt?: number;
  asyncDir?: string;
};
type ResumeSourceTarget =
  | AsyncResumeSourceTarget
  | ForegroundResumeSourceTarget
  | NestedResumeSourceTarget;

type AsyncInterruptRequestResult = ReturnType<typeof requestAsyncInterruptForTarget>;

function isAsyncInterruptFailure(
  result: AsyncInterruptRequestResult,
): result is Extract<AsyncInterruptRequestResult, { ok: false }> {
  return !result.ok;
}

function isAsyncInterruptNotRunning(
  result: AsyncInterruptRequestResult,
): result is Extract<AsyncInterruptRequestResult, { ok: false; kind: "not_running" }> {
  return "kind" in result && result.kind === "not_running";
}

export function buildRunStatusParams(params: SubagentParamsLike) {
  return {
    action: "status" as const,
    id: params.id,
    dir: params.dir,
    index: params.index,
    view: params.view,
    lines: params.lines,
  };
}

export function buildManagementActionParams(params: SubagentParamsLike) {
  return {
    action: params.action,
    agent: params.agent,
    chainName: params.chainName,
    agentScope: params.agentScope,
    config: params.config,
  };
}

const UNSUPPORTED_SAVED_CHAIN_INPUT_MESSAGE =
  "Saved chains are deliberately unsupported in The Last Harness; existing .chain.md/.chain.json files are left untouched.";

export function unsupportedSavedChainInputResult(
  params: SubagentParamsLike,
  detail: string,
): SubagentToolResult<Details> {
  const text = detail.startsWith("The Last Harness")
    ? detail
    : `${UNSUPPORTED_SAVED_CHAIN_INPUT_MESSAGE} ${detail}`;
  return {
    content: [{ type: "text", text }],
    isError: true,
    details: { mode: params.action ? "management" : getRequestedModeLabel(params), results: [] },
  };
}

export function unsupportedSavedChainInput(params: SubagentParamsLike): string | undefined {
  if (params.chain !== undefined) return "Omit 'chain'.";
  if (params.chainName !== undefined) return "Omit 'chainName'.";
  if (params.chainDir !== undefined) return "Omit 'chainDir'.";
  if (params.clarify !== undefined)
    return "The Last Harness does not support the chain clarify UI; omit 'clarify'.";
  return undefined;
}

export function getRequestedModeLabel(params: SubagentParamsLike): Details["mode"] {
  if ((params.tasks?.length ?? 0) > 0) return "parallel";
  if (params.agent) return "single";
  return "single";
}

function isAsyncRunNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Async run not found.");
}

function isResumeAmbiguity(error: unknown): boolean {
  return error instanceof Error && /Ambiguous .*run id prefix/.test(error.message);
}

function resumeTargetExact(target: { runId: string } | undefined, requested: string): boolean {
  return target?.runId === requested;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isExactResumeError(
  error: unknown,
  source: "async" | "foreground",
  requested: string,
): boolean {
  if (!(error instanceof Error) || !requested) return false;
  return new RegExp(`\\b${source} run '${escapeRegExp(requested)}'`, "i").test(error.message);
}

function resolveResumeTarget(
  params: SubagentParamsLike,
  state: SubagentState,
  options: { asyncRequireSessionFile?: boolean; readOnly?: boolean } = {},
): ResumeSourceTarget {
  const requested = params.id?.trim() ?? "";
  let foregroundTarget: ForegroundResumeSourceTarget | undefined;
  let foregroundError: unknown;
  let asyncTarget: AsyncResumeSourceTarget | undefined;
  let asyncError: unknown;

  try {
    const target = resolveForegroundResumeTarget(params, state);
    if (target) foregroundTarget = { kind: "revive", source: "foreground", ...target };
  } catch (error) {
    foregroundError = error;
  }
  try {
    asyncTarget = {
      source: "async",
      ...resolveAsyncResumeTarget(
        params,
        {},
        {
          requireSessionFile: options.asyncRequireSessionFile,
          readOnly: options.readOnly,
        },
      ),
    };
  } catch (error) {
    asyncError = error;
  }

  if (foregroundTarget && asyncTarget) {
    const foregroundExact = resumeTargetExact(foregroundTarget, requested);
    const asyncExact = resumeTargetExact(asyncTarget, requested);
    if (foregroundExact && asyncExact && foregroundTarget.runId === asyncTarget.runId)
      return foregroundTarget;
    if (foregroundExact && !asyncExact) return foregroundTarget;
    if (asyncExact && !foregroundExact) return asyncTarget;
    throw new Error(
      `Resume id '${requested}' is ambiguous between foreground run '${foregroundTarget.runId}' and async run '${asyncTarget.runId}'. Provide a full run id.`,
    );
  }
  if (foregroundTarget) {
    if (
      isExactResumeError(asyncError, "async", requested) &&
      !resumeTargetExact(foregroundTarget, requested)
    )
      throw asyncError;
    if (isResumeAmbiguity(asyncError) && !resumeTargetExact(foregroundTarget, requested))
      throw asyncError;
    return foregroundTarget;
  }
  if (asyncTarget) {
    if (isExactResumeError(foregroundError, "foreground", requested)) throw foregroundError;
    if (isResumeAmbiguity(foregroundError) && !resumeTargetExact(asyncTarget, requested))
      throw foregroundError;
    return asyncTarget;
  }
  if (foregroundError && !isAsyncRunNotFound(asyncError)) throw foregroundError;
  if (foregroundError) throw foregroundError;
  if (asyncError) throw asyncError;
  throw new Error("Run not found. Provide id.");
}

type PausedContinuationClaim = {
  asyncDir: string;
  claimToken: string;
  rollbackReserved: () => void;
  markSpawned: () => void;
};

type ContinuationClaimDecision = PausedContinuationClaim | { blockedMessage: string } | undefined;

function claimPausedAwaitingSupervisorTarget(
  target: ResumeSourceTarget,
  continuationRunId: string,
  effectiveContextWindow?: number,
): ContinuationClaimDecision {
  if (target.kind !== "revive" || !("asyncDir" in target) || !target.asyncDir) return undefined;
  const asyncDir = target.asyncDir;
  // A result-only or nested target can retain a historical async-dir path even
  // after that lifecycle directory has been removed. Do not recreate it merely
  // to discover that there is no persisted lifecycle state. A paused target is
  // still fail-closed when its lifecycle directory is absent.
  if (!fs.existsSync(asyncDir)) {
    if (target.state === "paused") throw new Error(`Paused run '${target.runId}' was not found.`);
    return undefined;
  }
  const decision = withLifecycleStatusLock<
    { claimToken: string } | { blockedMessage: string } | undefined
  >(asyncDir, (persisted) => {
    if (!persisted) {
      if (target.state === "paused") throw new Error(`Paused run '${target.runId}' was not found.`);
      return undefined;
    }
    let current = persisted;
    const recovered = recoverStaleLifecycleContinuationStatus(current, asyncDir, target.index);
    if (recovered.recovered) current = recovered.status;
    const currentStep = current.steps?.[target.index];
    if (current.state === "cancelled" || currentStep?.status === "cancelled")
      throw new Error(
        `Paused run '${target.runId}' child ${target.index} was cancelled and cannot be resumed.`,
      );
    if (current.state === "continued" || currentStep?.status === "continued")
      throw new Error(
        `Paused run '${target.runId}' child ${target.index} already launched its continuation and cannot be resumed again.`,
      );
    const latestContextUsage =
      parseContextUsageDiagnostics(currentStep?.contextUsage) ?? target.contextUsage;
    const contextAssessment = assessDurableResumeContext(
      latestContextUsage,
      effectiveContextWindow,
    );
    if (contextAssessment.blocked)
      return { blockedMessage: formatDurableResumeContextBlock(contextAssessment) };
    if (
      current.state !== "paused" ||
      !currentStep ||
      (currentStep.status !== "paused" && currentStep.status !== "pausing")
    ) {
      if (isClaimedPausedLifecycle(current, target.index))
        throw new Error(
          `Paused run '${target.runId}' child ${target.index} was already claimed for continuation and cannot be resumed again.`,
        );
      if (target.state === "paused")
        throw new Error(
          `Paused run '${target.runId}' child ${target.index} is not paused and cannot be resumed.`,
        );
      return undefined;
    }
    if (isClaimedPausedLifecycle(current, target.index))
      throw new Error(
        `Paused run '${target.runId}' child ${target.index} was already claimed for continuation and cannot be resumed again.`,
      );
    const claimToken = `claim-${target.runId}-${target.index}-${Date.now()}`;
    const claimedAt = Date.now();
    const nextStatus: AsyncStatus = {
      ...current,
      lastUpdate: claimedAt,
      pause: current.pause ? { ...current.pause, ownerPid: undefined } : current.pause,
      lifecycle: {
        ...withLifecycleContinuation(current, target.index, {
          phase: "reserved",
          claimToken,
          claimedAt,
          ownerPid: process.pid,
          continuationRunId,
        }),
        generation: lifecycleGeneration(current) + 1,
      },
    };
    writeNormalizedLifecycleStatus(asyncDir, nextStatus);
    return { claimToken };
  });
  if (!decision || "blockedMessage" in decision) return decision;
  return {
    asyncDir,
    claimToken: decision.claimToken,
    rollbackReserved: () => {
      const latest = readStatus(asyncDir);
      if (!latest || latest.state !== "paused") return;
      const latestContinuation = indexedLifecycleContinuation(latest, target.index);
      if (
        latestContinuation?.claimToken !== decision.claimToken ||
        latestContinuation.continuationRunId !== continuationRunId ||
        latestContinuation.phase !== "reserved"
      )
        return;
      transitionLifecycleStatus({
        asyncDir,
        expectedGeneration: lifecycleGeneration(latest),
        mutate: (status) => ({
          ...status,
          lastUpdate: Date.now(),
          lifecycle: withLifecycleContinuation(status, target.index, undefined),
        }),
      });
    },
    markSpawned: () => {
      markLifecycleContinuationSpawned(
        asyncDir,
        target.index,
        decision.claimToken,
        continuationRunId,
      );
    },
  };
}

export function recoverFailedPausedForegroundTransition(input: {
  runId: string;
  error: unknown;
}): void {
  const asyncDir = pausedForegroundStatusPath(input.runId);
  const message = FOREGROUND_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
  try {
    const current = readStatus(asyncDir);
    if (!current || current.state !== "pausing") return;
    const failedAt = Date.now();
    transitionLifecycleStatus({
      asyncDir,
      expectedGeneration: lifecycleGeneration(current),
      mutate: (status) => ({
        ...status,
        state: "failed",
        pid: undefined,
        lastUpdate: failedAt,
        endedAt: failedAt,
        error: message,
        pause: status.pause ? { ...status.pause, ownerPid: undefined } : status.pause,
        steps: status.steps?.map((step, index) =>
          index === 0 && (step.status === "pausing" || step.status === "paused")
            ? {
                ...step,
                status: "failed",
                endedAt: failedAt,
                exitCode: 1,
                terminationReason: "process_exit",
                error: step.error ?? message,
              }
            : step,
        ),
      }),
    });
  } catch {
    // Best effort only; the explicit foreground failure still propagates.
  }
}

export function enrichPersistedPausedForegroundSingleRun(input: {
  runId: string;
  result: SingleResult;
}): void {
  const asyncDir = pausedForegroundStatusPath(input.runId);
  const activeRuntimeMs = normalizeActiveRuntimeMs(input.result.activeRuntimeMs);
  const activeRuntimeCheckpointAt = normalizeActiveRuntimeCheckpointAt(
    input.result.activeRuntimeCheckpointAt,
  );
  const current = readStatus(asyncDir);
  if (
    current?.pause?.kind === "awaiting_supervisor" &&
    (current.state === "paused" || current.state === "pausing")
  ) {
    transitionLifecycleStatus({
      asyncDir,
      expectedGeneration: lifecycleGeneration(current),
      mutate: (status) => ({
        ...status,
        lastUpdate: Date.now(),
        ...(activeRuntimeMs !== undefined
          ? {
              activeRuntimeMs: Math.max(
                normalizeActiveRuntimeMs(status.activeRuntimeMs) ?? 0,
                activeRuntimeMs,
              ),
            }
          : {}),
        ...(activeRuntimeCheckpointAt !== undefined
          ? {
              activeRuntimeCheckpointAt: Math.max(
                normalizeActiveRuntimeCheckpointAt(status.activeRuntimeCheckpointAt) ?? 0,
                activeRuntimeCheckpointAt,
              ),
            }
          : {}),
        sessionFile: input.result.sessionFile ?? status.sessionFile,
        steps: status.steps?.map((step, index) =>
          index === 0
            ? {
                ...step,
                projectAgent: input.result.projectAgent ?? step.projectAgent,
                sessionFile: input.result.sessionFile ?? step.sessionFile,
                transcriptPath: input.result.transcriptPath ?? step.transcriptPath,
                transcriptError: input.result.transcriptError ?? step.transcriptError,
                terminationReason: step.terminationReason ?? "paused",
                ...(input.result.contextUsage ? { contextUsage: input.result.contextUsage } : {}),
                ...(input.result.contextPressure
                  ? { contextPressure: { ...input.result.contextPressure } }
                  : {}),
                ...(input.result.contextPressureCrossedThresholds
                  ? {
                      contextPressureCrossedThresholds: [
                        ...input.result.contextPressureCrossedThresholds,
                      ],
                    }
                  : {}),
                ...(input.result.acceptance ? { acceptance: input.result.acceptance } : {}),
                ...(activeRuntimeMs !== undefined
                  ? {
                      activeRuntimeMs: Math.max(
                        normalizeActiveRuntimeMs(step.activeRuntimeMs) ?? 0,
                        activeRuntimeMs,
                      ),
                    }
                  : {}),
                ...(activeRuntimeCheckpointAt !== undefined
                  ? {
                      activeRuntimeCheckpointAt: Math.max(
                        normalizeActiveRuntimeCheckpointAt(step.activeRuntimeCheckpointAt) ?? 0,
                        activeRuntimeCheckpointAt,
                      ),
                    }
                  : {}),
              }
            : step,
        ),
      }),
    });
  }
}

export function getAsyncInterruptTarget(
  state: SubagentState,
  runId: string | undefined,
  location?: { asyncDir: string | null; resolvedId?: string },
): { asyncId: string; asyncDir: string } | undefined {
  if (location) {
    if (location.asyncDir) {
      return {
        asyncId: location.resolvedId ?? runId ?? path.basename(location.asyncDir),
        asyncDir: location.asyncDir,
      };
    }
    if (runId) {
      const direct = state.asyncJobs.get(runId);
      if (direct) return { asyncId: direct.asyncId, asyncDir: direct.asyncDir };
    }
    return undefined;
  }
  if (runId) {
    const direct = state.asyncJobs.get(runId);
    if (direct) return { asyncId: direct.asyncId, asyncDir: direct.asyncDir };
    return undefined;
  }
  let newest: { asyncId: string; asyncDir: string; updatedAt: number } | undefined;
  for (const job of state.asyncJobs.values()) {
    if (job.status !== "running") continue;
    if (!newest || (job.updatedAt ?? 0) > newest.updatedAt) {
      newest = { asyncId: job.asyncId, asyncDir: job.asyncDir, updatedAt: job.updatedAt ?? 0 };
    }
  }
  return newest ? { asyncId: newest.asyncId, asyncDir: newest.asyncDir } : undefined;
}

export function resolvedAsyncInterruptTarget(target: {
  asyncId: string;
  asyncDir: string;
}): Extract<ResolvedSubagentRunId, { kind: "async" }> {
  return {
    kind: "async",
    id: target.asyncId,
    location: {
      asyncDir: target.asyncDir,
      resultPath: null,
      resolvedId: target.asyncId,
    },
  };
}

/** Resolve the target before any project marker fallback or interrupt signal. */
export function selectInterruptTarget(
  params: SubagentParamsLike,
  state: SubagentState,
): { target: ResolvedSubagentRunId | undefined; params: SubagentParamsLike } {
  const requestedId = params.id?.trim();
  if (params.dir) {
    const location = resolveAsyncRunLocation(params, ASYNC_DIR, RESULTS_DIR);
    const runId = location.resolvedId ?? path.basename(path.resolve(params.dir));
    if (!runId) return { target: undefined, params };
    return {
      target: { kind: "async", id: runId, location },
      params: { ...params, id: runId },
    };
  }
  if (requestedId) {
    const resolved = resolveSubagentRunId(requestedId, { state });
    if (resolved) return { target: resolved, params: { ...params, id: resolved.id } };
    const foreground = getForegroundControl(state, requestedId);
    if (foreground) {
      const target = { kind: "foreground" as const, id: foreground.runId };
      return { target, params: { ...params, id: target.id } };
    }
    const asyncTarget = getAsyncInterruptTarget(state, requestedId);
    if (asyncTarget) {
      const target = resolvedAsyncInterruptTarget(asyncTarget);
      return {
        target,
        params: { ...params, id: target.id, dir: asyncTarget.asyncDir },
      };
    }
    return { target: undefined, params };
  }
  const foreground = getForegroundControl(state, undefined);
  if (foreground) {
    const target = { kind: "foreground" as const, id: foreground.runId };
    return { target, params: { ...params, id: target.id } };
  }
  const asyncTarget = getAsyncInterruptTarget(state, undefined);
  if (!asyncTarget) return { target: undefined, params };
  const target = resolvedAsyncInterruptTarget(asyncTarget);
  return {
    target,
    params: { ...params, id: target.id, dir: asyncTarget.asyncDir },
  };
}

export function requestForegroundInterrupt(
  control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never,
): boolean {
  if (!control?.interrupt) return false;
  const interrupted = control.interrupt();
  if (interrupted) {
    control.updatedAt = Date.now();
    control.currentActivityState = undefined;
  }
  return interrupted;
}

function updateRememberedForegroundCancellation(
  state: SubagentState,
  runId: string,
  cancelledAt: number,
  summary: string,
  index = 0,
): void {
  const run = state.foregroundRuns?.get(runId);
  const child = run?.children[index];
  if (!run || !child) return;
  run.updatedAt = cancelledAt;
  run.children[index] = {
    ...child,
    cancel: { summary, cancelledAt },
    terminationReason: "cancelled",
  };
}

function hasResumableSiblingStep(
  steps: NonNullable<AsyncStatus["steps"]> | undefined,
  targetIndex: number,
): boolean {
  return (
    steps?.some(
      (step, stepIndex) =>
        stepIndex !== targetIndex && step.status !== "continued" && step.status !== "cancelled",
    ) ?? false
  );
}

export function cancelPersistedPausedForegroundRun(
  state: SubagentState,
  asyncDir: string,
  runId: string,
  index?: number,
): SubagentToolResult<Details> {
  try {
    let current = readStatus(asyncDir);
    if (!current) {
      return {
        content: [{ type: "text", text: `Paused foreground run '${runId}' was not found.` }],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
    const stepCount = current.steps?.length ?? 0;
    const targetIndex = index ?? (stepCount <= 1 ? 0 : undefined);
    if (stepCount > 1 && targetIndex === undefined) {
      return {
        content: [
          {
            type: "text",
            text: `Foreground run '${runId}' has ${stepCount} children. Provide index to cancel one paused child.`,
          },
        ],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
    if (targetIndex === undefined || targetIndex < 0 || targetIndex >= stepCount) {
      return {
        content: [
          {
            type: "text",
            text: `Foreground run '${runId}' has ${stepCount} children. Index ${targetIndex ?? -1} is out of range.`,
          },
        ],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
    const recovered = recoverStaleLifecycleContinuationClaim(asyncDir, targetIndex);
    if (recovered.recovered && recovered.status) current = recovered.status;
    const targetStep = current.steps?.[targetIndex];
    const targetPause = targetStep?.pause ?? (stepCount <= 1 ? current.pause : undefined);
    if (targetStep?.status === "cancelled") {
      return {
        content: [
          {
            type: "text",
            text: `Foreground run '${runId}' child ${targetIndex} is already cancelled.`,
          },
        ],
        details: { mode: "management", results: [] },
      };
    }
    if (targetStep?.status === "continued") {
      return {
        content: [
          {
            type: "text",
            text: `Foreground run '${runId}' child ${targetIndex} already continued and cannot be cancelled.`,
          },
        ],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
    if (current.state === "continued" && stepCount <= 1) {
      return {
        content: [
          {
            type: "text",
            text: `Foreground run '${runId}' already continued into '${lifecycleContinuationForIndex(current, targetIndex)?.continuationRunId ?? current.lifecycle?.continuation?.continuationRunId ?? "unknown"}' and can no longer be cancelled from the paused supervisor lifecycle.`,
          },
        ],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
    if (isClaimedPausedLifecycle(current, targetIndex)) {
      return {
        content: [
          {
            type: "text",
            text: `Foreground run '${runId}' child ${targetIndex} is already claimed for continuation and cannot be cancelled through the paused supervisor lifecycle.`,
          },
        ],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
    if (
      current.state !== "paused" ||
      !targetStep ||
      (targetStep.status !== "paused" && targetStep.status !== "pausing") ||
      !targetPause
    ) {
      return {
        content: [
          {
            type: "text",
            text: `Foreground run '${runId}' child ${targetIndex} is not a paused child.`,
          },
        ],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
    const cancelledAt = Date.now();
    const summary =
      targetPause.kind === "awaiting_supervisor"
        ? "Cancelled while paused awaiting supervisor."
        : "Cancelled while paused with the cohort.";
    const transitioned = transitionLifecycleStatus({
      asyncDir,
      expectedGeneration: lifecycleGeneration(current),
      mutate: (status) => {
        const nextSteps = status.steps?.map((step, stepIndex) =>
          stepIndex === targetIndex
            ? {
                ...step,
                status: "cancelled" as const,
                endedAt: cancelledAt,
                exitCode: 0,
                cancel: { summary, cancelledAt },
                terminationReason: "cancelled" as const,
              }
            : step,
        );
        const remainingActionable =
          nextSteps?.some(
            (step) =>
              step.status === "paused" || step.status === "pausing" || step.status === "pending",
          ) ?? false;
        const remainingResumable = hasResumableSiblingStep(nextSteps, targetIndex);
        return {
          ...status,
          state: remainingActionable || remainingResumable ? "paused" : "cancelled",
          pid: undefined,
          ...(remainingActionable || remainingResumable
            ? {}
            : { cancel: { summary, cancelledAt } }),
          pause: remainingActionable
            ? nextSteps?.find(
                (step) =>
                  step.pause?.kind === "awaiting_supervisor" &&
                  (step.status === "paused" || step.status === "pausing"),
              )?.pause
            : undefined,
          lastUpdate: cancelledAt,
          endedAt: cancelledAt,
          lifecycle: withLifecycleContinuation(status, targetIndex, undefined),
          steps: nextSteps,
        };
      },
    });
    if (transitioned.status.state === "cancelled") releaseProjectAgentRunReference(runId);
    updateRememberedForegroundCancellation(state, runId, cancelledAt, summary, targetIndex);
    return {
      content: [
        {
          type: "text",
          text: `Cancelled paused foreground run ${runId} child ${targetIndex}. Existing enabled artifacts and the canonical child session were preserved; compact mode may omit the diagnostic child transcript. Resume is no longer available for that child.`,
        },
      ],
      details: { mode: "management", results: [] },
    };
  } catch {
    return {
      content: [
        {
          type: "text",
          text: `Paused foreground run '${runId}' could not be updated safely. ${FOREGROUND_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE}`,
        },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
}

function resolveAsyncResultsDir(asyncDir: string): string | undefined {
  const relative = path.relative(NESTED_ASYNC_RUNS_DIR, path.resolve(asyncDir));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  const [rootRunId, runId] = relative.split(path.sep).filter(Boolean);
  if (!rootRunId || !runId) return undefined;
  return path.join(RESULTS_DIR, "nested", rootRunId);
}

function requestAsyncInterruptForTarget(
  state: SubagentState,
  target: { asyncId: string; asyncDir: string },
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean,
): { ok: true } | { ok: false; kind: "not_running" | "error"; error?: string } {
  const resultsDir = resolveAsyncResultsDir(target.asyncDir);
  const status = reconcileAsyncRun(
    target.asyncDir,
    resultsDir ? { kill, resultsDir } : { kill },
  ).status;
  if (!status || status.state !== "running" || typeof status.pid !== "number") {
    return { ok: false, kind: "not_running" };
  }
  try {
    deliverInterruptRequest({
      asyncDir: target.asyncDir,
      pid: status.pid,
      kill,
      source: "interrupt-action",
    });
    const tracked = state.asyncJobs.get(target.asyncId);
    if (tracked) {
      tracked.activityState = undefined;
      tracked.updatedAt = Date.now();
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, kind: "error", error: message };
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function normalizeComparableCwd(cwd: string): string {
  const resolved = path.resolve(cwd);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function diskOnlyAsyncStatusBelongsElsewhere(state: SubagentState, status: AsyncStatus): boolean {
  if (state.currentSessionId && status.sessionId)
    return state.currentSessionId !== status.sessionId;
  if (
    state.baseCwd &&
    status.cwd &&
    normalizeComparableCwd(state.baseCwd) !== normalizeComparableCwd(status.cwd)
  )
    return true;
  return false;
}

function discoverDiskOnlyRunningAsyncTargets(
  state: SubagentState,
  knownAsyncDirs: Set<string>,
): { targets: Array<{ asyncId: string; asyncDir: string }>; errors: string[] } {
  const targets: Array<{ asyncId: string; asyncDir: string }> = [];
  const errors: string[] = [];
  const candidates: Array<{ asyncDir: string; fallbackId: string }> = [];

  try {
    for (const entry of fs.readdirSync(ASYNC_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      candidates.push({ asyncDir: path.join(ASYNC_DIR, entry.name), fallbackId: entry.name });
    }
  } catch (error) {
    if (!isNotFoundError(error)) {
      return {
        targets,
        errors: [
          `Failed to list async runs in '${ASYNC_DIR}': ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  try {
    for (const rootEntry of fs.readdirSync(NESTED_ASYNC_RUNS_DIR, { withFileTypes: true })) {
      if (!rootEntry.isDirectory()) continue;
      const rootDir = path.join(NESTED_ASYNC_RUNS_DIR, rootEntry.name);
      try {
        for (const runEntry of fs.readdirSync(rootDir, { withFileTypes: true })) {
          if (!runEntry.isDirectory()) continue;
          candidates.push({
            asyncDir: path.join(rootDir, runEntry.name),
            fallbackId: runEntry.name,
          });
        }
      } catch (error) {
        if (isNotFoundError(error)) continue;
        errors.push(
          `Failed to list nested async runs in '${rootDir}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    if (!isNotFoundError(error)) {
      errors.push(
        `Failed to list nested async runs in '${NESTED_ASYNC_RUNS_DIR}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (const candidate of candidates) {
    if (knownAsyncDirs.has(candidate.asyncDir)) continue;
    try {
      const rawStatus = readStatus(candidate.asyncDir);
      if (
        !rawStatus ||
        rawStatus.state !== "running" ||
        diskOnlyAsyncStatusBelongsElsewhere(state, rawStatus)
      )
        continue;
      const resultsDir = resolveAsyncResultsDir(candidate.asyncDir);
      const status = reconcileAsyncRun(candidate.asyncDir, resultsDir ? { resultsDir } : {}).status;
      if (status?.state === "running") {
        targets.push({
          asyncId:
            typeof status.runId === "string" && status.runId ? status.runId : candidate.fallbackId,
          asyncDir: candidate.asyncDir,
        });
      }
    } catch (error) {
      errors.push(
        `Failed to inspect async run ${candidate.fallbackId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { targets, errors };
}

interface InterruptAllRunningSubagentRunsResult {
  foregroundRunIds: string[];
  asyncRunIds: string[];
  skippedForegroundRunIds: string[];
  skippedAsyncRunIds: string[];
  errors: string[];
}

export function requestInterruptAllRunningSubagentRuns(
  state: SubagentState,
): InterruptAllRunningSubagentRunsResult {
  const result: InterruptAllRunningSubagentRunsResult = {
    foregroundRunIds: [],
    asyncRunIds: [],
    skippedForegroundRunIds: [],
    skippedAsyncRunIds: [],
    errors: [],
  };
  for (const control of state.foregroundControls.values()) {
    if (requestForegroundInterrupt(control)) result.foregroundRunIds.push(control.runId);
    else result.skippedForegroundRunIds.push(control.runId);
  }
  const knownAsyncDirs = new Set<string>();
  for (const job of state.asyncJobs.values()) {
    knownAsyncDirs.add(job.asyncDir);
    const interruptResult = requestAsyncInterruptForTarget(state, {
      asyncId: job.asyncId,
      asyncDir: job.asyncDir,
    });
    if (!isAsyncInterruptFailure(interruptResult)) {
      result.asyncRunIds.push(job.asyncId);
    } else if (interruptResult.kind === "error") {
      result.errors.push(
        `Failed to interrupt async run ${job.asyncId}: ${interruptResult.error ?? "unknown error"}`,
      );
    } else {
      result.skippedAsyncRunIds.push(job.asyncId);
    }
  }
  const diskOnly = discoverDiskOnlyRunningAsyncTargets(state, knownAsyncDirs);
  for (const target of diskOnly.targets) {
    const interruptResult = requestAsyncInterruptForTarget(state, target);
    if (!isAsyncInterruptFailure(interruptResult)) {
      result.asyncRunIds.push(target.asyncId);
    } else if (interruptResult.kind === "error") {
      result.errors.push(
        `Failed to interrupt async run ${target.asyncId}: ${interruptResult.error ?? "unknown error"}`,
      );
    } else {
      result.skippedAsyncRunIds.push(target.asyncId);
    }
  }
  result.errors.push(...diskOnly.errors);
  return result;
}

export function emitControlNotification(input: {
  pi: ExtensionAPI;
  controlConfig: ResolvedControlConfig;
  event: ControlEvent;
}): void {
  if (!shouldNotifyControlEvent(input.controlConfig, input.event)) return;
  if (!input.controlConfig.notifyChannels.includes("event")) return;
  input.pi.events.emit(SUBAGENT_CONTROL_EVENT, {
    event: input.event,
    source: "foreground" as const,
    noticeText: formatControlNoticeMessage(input.event),
  });
}

export function interruptAsyncRun(
  state: SubagentState,
  runId: string | undefined,
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean,
  location?: { asyncDir: string | null; resolvedId?: string },
): SubagentToolResult<Details> | null {
  const target = getAsyncInterruptTarget(state, runId, location);
  if (!target) return null;
  const interruptResult = requestAsyncInterruptForTarget(state, target, kill);
  if (!isAsyncInterruptFailure(interruptResult)) {
    return {
      content: [{ type: "text", text: `Interrupt requested for async run ${target.asyncId}.` }],
      details: { mode: "management", results: [] },
    };
  }
  return {
    content: [
      {
        type: "text",
        text: isAsyncInterruptNotRunning(interruptResult)
          ? `No running async run with an interrupt-capable pid was found for '${runId ?? "current"}'.`
          : `Failed to interrupt async run ${target.asyncId}: ${interruptResult.error ?? "unknown error"}`,
      },
    ],
    isError: true,
    details: { mode: "management", results: [] },
  };
}

function asyncControlOwnedByCurrentSession(state: SubagentState, status: AsyncStatus): boolean {
  return (
    typeof state.currentSessionId === "string" &&
    state.currentSessionId.length > 0 &&
    typeof status.sessionId === "string" &&
    status.sessionId === state.currentSessionId
  );
}

export function steerAsyncRun(input: {
  state: SubagentState;
  runId: string;
  message: string;
  index?: number;
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
  location: { asyncDir: string | null; resolvedId?: string };
  projectLookup: ProjectAgentRunReferenceLookup;
}): SubagentToolResult<Details> {
  if (!input.location.asyncDir) {
    return {
      content: [
        { type: "text", text: `Async run '${input.runId}' has no live run directory to steer.` },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
  const status = reconcileAsyncRun(input.location.asyncDir, { kill: input.kill }).status;
  if (input.projectLookup.status === "missing" && hasProjectAgentControlMarker(status)) {
    return {
      content: [
        {
          type: "text",
          text: projectRunAuthorizationError(
            "the persisted run carries a project-agent marker, but its process-private reference is unavailable; refusing ordinary control fallback.",
          ).message,
        },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
  if (!status || (status.state !== "running" && status.state !== "queued")) {
    return {
      content: [
        {
          type: "text",
          text: `Async run '${input.runId}' is not running or queued and cannot be steered.`,
        },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
  if (!asyncControlOwnedByCurrentSession(input.state, status)) {
    return {
      content: [
        {
          type: "text",
          text: `Async run '${status.runId}' is owned by another session and cannot be steered from this session.`,
        },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
  const steps = status.steps ?? [];
  if (input.index !== undefined) {
    if (input.index < 0 || input.index >= steps.length) {
      return {
        content: [
          {
            type: "text",
            text: `Async run '${status.runId}' has ${steps.length} children. Index ${input.index} is out of range.`,
          },
        ],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
    const targetStep = steps[input.index];
    if (targetStep && targetStep.status !== "running" && targetStep.status !== "pending") {
      return {
        content: [
          {
            type: "text",
            text: `Async run '${status.runId}' child ${input.index} is ${targetStep.status} and cannot be steered.`,
          },
        ],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
  } else {
    const running = steps.filter((step) => step.status === "running");
    if (running.length === 0 && steps.length > 1) {
      return {
        content: [
          {
            type: "text",
            text: `Async run '${status.runId}' has no running child yet. Provide index to steer a queued child.`,
          },
        ],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
  }
  requestAsyncSteer(input.location.asyncDir, {
    message: input.message,
    targetIndex: input.index,
    source: "steer-action",
  });
  const tracked = input.state.asyncJobs.get(status.runId);
  if (tracked) tracked.updatedAt = Date.now();
  const childText = input.index !== undefined ? ` child ${input.index}` : " running child";
  return {
    content: [
      {
        type: "text",
        text: `Steering queued for async run ${status.runId}${childText}. Delivery requires a live Pi child session that supports mid-run steering.`,
      },
    ],
    details: { mode: "management", results: [] },
  };
}

function nestedRunSessionFile(run: NestedRunSummary): string | undefined {
  return run.sessionFile ?? (run.steps?.length === 1 ? run.steps[0]?.sessionFile : undefined);
}

function nestedRunAgent(run: NestedRunSummary): string | undefined {
  return (
    run.agent ?? run.agents?.[0] ?? (run.steps?.length === 1 ? run.steps[0]?.agent : undefined)
  );
}

function pathWithin(base: string, candidate: string): boolean {
  const resolvedBase = path.resolve(base);
  const resolvedCandidate = path.resolve(candidate);
  return (
    resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`)
  );
}

function validateNestedSessionFile(run: NestedRunSummary, trustedSessionRoots: string[]): string {
  const sessionFile = nestedRunSessionFile(run);
  if (!sessionFile)
    throw new Error(
      `Nested run '${run.id}' does not have a persisted session file to resume from.`,
    );
  if (path.extname(sessionFile) !== ".jsonl")
    throw new Error(`Nested run '${run.id}' session file must be a .jsonl file: ${sessionFile}`);
  const resolved = path.resolve(sessionFile);
  if (!path.isAbsolute(sessionFile))
    throw new Error(`Nested run '${run.id}' session file must be absolute: ${sessionFile}`);
  if (!fs.existsSync(resolved))
    throw new Error(`Nested run '${run.id}' session file does not exist: ${sessionFile}`);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`Nested run '${run.id}' session file is not a regular file: ${sessionFile}`);
  const realSessionFile = fs.realpathSync(resolved);
  const trustedRoots = trustedSessionRoots
    .filter((root) => fs.existsSync(root))
    .map((root) => fs.realpathSync(root));
  if (!trustedRoots.some((root) => pathWithin(root, realSessionFile))) {
    throw new Error(
      `Nested run '${run.id}' session file is outside trusted nested session roots: ${sessionFile}`,
    );
  }
  if (!realSessionFile.split(path.sep).includes(run.id)) {
    throw new Error(
      `Nested run '${run.id}' session file is not under that nested run's session directory: ${sessionFile}`,
    );
  }
  return realSessionFile;
}

type NestedResumeStatusStep = {
  cwd?: string;
  status?: string;
  acceptance?: import("../../shared/types.ts").AcceptanceLedger;
  model?: string;
  thinking?: string;
  modelIdentity?: import("../../shared/types.ts").SubagentModelIdentity;
  modelResolution?: import("../../shared/types.ts").SubagentModelResolution;
  contextUsage?: import("../../shared/types.ts").ContextUsageDiagnostics;
  contextPressure?: import("../../shared/types.ts").ContextPressureProjection;
  contextPressureCrossedThresholds?: import("../../shared/types.ts").ContextPressureThreshold[];
  activeRuntimeMs?: number;
  activeRuntimeCheckpointAt?: number;
  projectAgentMarker?: true;
};

function readNestedResumeStatusStep(
  runId: string,
  asyncDir: string | undefined,
): NestedResumeStatusStep | undefined {
  if (!asyncDir) return undefined;
  let parsed: { cwd?: unknown; steps?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as {
      cwd?: unknown;
      steps?: unknown;
    };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code === "ENOENT") return undefined;
    throw new Error(`Nested run '${runId}' persisted status could not be read safely.`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed.steps))
    throw new Error(`Nested run '${runId}' persisted status has invalid steps metadata.`);
  const malformedProjectAgentMarker = hasMalformedProjectAgentControlMarker(parsed);
  const step = parsed.steps[0];
  if (!step || typeof step !== "object" || Array.isArray(step))
    throw new Error(
      `Nested run '${runId}' persisted status does not have a valid step at index 0.`,
    );
  const activeRuntimeMs = (step as { activeRuntimeMs?: unknown }).activeRuntimeMs;
  const activeRuntimeCheckpointAt = (step as { activeRuntimeCheckpointAt?: unknown })
    .activeRuntimeCheckpointAt;
  if (
    activeRuntimeMs !== undefined &&
    (typeof activeRuntimeMs !== "number" ||
      !Number.isFinite(activeRuntimeMs) ||
      activeRuntimeMs < 0)
  ) {
    throw new Error(
      `Nested run '${runId}' persisted step activeRuntimeMs must be a non-negative finite number.`,
    );
  }
  const raw = step as Record<string, unknown>;
  const modelIdentity =
    sanitizeSubagentModelIdentity(raw.modelIdentity) ??
    canonicalSubagentModelIdentity(
      typeof raw.model === "string" ? raw.model : undefined,
      typeof raw.thinking === "string" ? raw.thinking : undefined,
    );
  const modelResolution = sanitizeSubagentModelResolution(raw.modelResolution);
  const contextUsage = parseContextUsageDiagnostics(raw.contextUsage);
  const contextPressure = parseContextPressureProjection(raw.contextPressure);
  const contextPressureCrossedThresholds = parseContextPressureCrossedThresholds(
    raw.contextPressureCrossedThresholds,
  );
  return {
    ...(typeof parsed.cwd === "string" ? { cwd: parsed.cwd } : {}),
    ...(typeof raw.status === "string" ? { status: raw.status } : {}),
    ...(modelIdentity ? { modelIdentity } : {}),
    ...(modelResolution ? { modelResolution } : {}),
    ...(contextUsage ? { contextUsage } : {}),
    ...(contextPressure ? { contextPressure } : {}),
    ...(contextPressureCrossedThresholds ? { contextPressureCrossedThresholds } : {}),
    ...(typeof activeRuntimeMs === "number" ? { activeRuntimeMs } : {}),
    ...(normalizeActiveRuntimeCheckpointAt(activeRuntimeCheckpointAt) !== undefined
      ? {
          activeRuntimeCheckpointAt: normalizeActiveRuntimeCheckpointAt(activeRuntimeCheckpointAt),
        }
      : {}),
    ...(malformedProjectAgentMarker ? { projectAgentMarker: true as const } : {}),
    ...(raw.acceptance
      ? { acceptance: raw.acceptance as NestedResumeStatusStep["acceptance"] }
      : {}),
  };
}

function resolveNestedContinuationAcceptance(
  runId: string,
  step: NestedResumeStatusStep | undefined,
): import("../../shared/types.ts").ResolvedAcceptanceConfig | undefined {
  const failClosed = () =>
    new Error(
      `Nested run '${runId}' is paused but its skipped acceptance ledger could not be read. Retry the resume once pause metadata is persisted.`,
    );
  if (!step?.acceptance) throw failClosed();
  return step.acceptance.status === "skipped" ? step.acceptance.effectiveAcceptance : undefined;
}

function resolveTrustedNestedResumeCwd(asyncDir: string | undefined): string | undefined {
  if (!asyncDir) return undefined;
  try {
    const canonicalRoot = fs.realpathSync(NESTED_ASYNC_RUNS_DIR);
    const canonicalParent = fs.realpathSync(path.dirname(asyncDir));
    if (!pathWithin(canonicalRoot, canonicalParent)) return undefined;
    return fs.statSync(canonicalParent).isDirectory() ? canonicalParent : undefined;
  } catch {
    return undefined;
  }
}

function resolveNestedResumeTarget(
  match: ResolvedSubagentRunId & { kind: "nested" },
  trustedSessionRoots: string[],
): NestedResumeSourceTarget {
  const run = match.match.run;
  if (run.state === "running" || run.state === "queued")
    throw new Error(
      `Nested run '${run.id}' is live; route the follow-up to the owner process instead.`,
    );
  const agent = nestedRunAgent(run);
  if (!agent) throw new Error(`Could not determine child agent for nested run '${run.id}'.`);
  const state =
    run.state === "complete" || run.state === "failed" || run.state === "paused"
      ? run.state
      : "failed";
  if (hasMalformedProjectAgentControlMarker(run)) {
    throw projectRunAuthorizationError(
      `Nested run '${run.id}' has a malformed project-agent marker.`,
    );
  }
  const projectAgentMarker = Object.hasOwn(run, "projectAgent")
    ? normalizeProjectAgentRunCapture(run.projectAgent)
    : undefined;
  const asyncDir = resolveNestedAsyncDir(match.match.rootRunId, run);
  const statusStep = readNestedResumeStatusStep(run.id, asyncDir);
  if (statusStep?.projectAgentMarker) {
    throw projectRunAuthorizationError(
      `Nested run '${run.id}' has a malformed project-agent marker in persisted status.`,
    );
  }
  const statusModelIdentity = statusStep?.modelIdentity;
  const statusModelResolution = statusStep?.modelResolution;
  const contextUsage = statusStep?.contextUsage;
  const contextPressure = statusStep?.contextPressure;
  const contextPressureCrossedThresholds = statusStep?.contextPressureCrossedThresholds;
  const continuationAcceptance =
    state === "paused" ? resolveNestedContinuationAcceptance(run.id, statusStep) : undefined;
  let cwd = resolveTrustedNestedResumeCwd(asyncDir);
  if (projectAgentMarker) {
    const persistedCwd = statusStep?.cwd ?? run.cwd;
    const cwdValidation = validateProjectAgentCwdContainment(
      projectAgentMarker.provenance.projectRoot,
      persistedCwd,
    );
    if (!cwdValidation.valid) {
      throw projectRunAuthorizationError(
        `Nested project-agent run '${run.id}' has an invalid persisted execution cwd: ${cwdValidation.reason}`,
      );
    }
    cwd = cwdValidation.canonicalCwd;
  }
  return {
    kind: "revive",
    source: "nested",
    runId: run.id,
    state,
    agent,
    index: 0,
    ...(projectAgentMarker ? { projectAgent: projectAgentMarker } : {}),
    ...(continuationAcceptance ? { continuationAcceptance } : {}),
    ...(statusModelIdentity ? { modelIdentity: statusModelIdentity } : {}),
    ...(statusModelResolution ? { modelResolution: statusModelResolution } : {}),
    ...(contextUsage ? { contextUsage } : {}),
    ...(contextPressure ? { contextPressure: { ...contextPressure } } : {}),
    ...(contextPressureCrossedThresholds
      ? { contextPressureCrossedThresholds: [...contextPressureCrossedThresholds] }
      : {}),
    ...(statusStep?.activeRuntimeMs !== undefined
      ? { activeRuntimeMs: statusStep.activeRuntimeMs }
      : {}),
    ...(statusStep?.activeRuntimeCheckpointAt !== undefined
      ? { activeRuntimeCheckpointAt: statusStep.activeRuntimeCheckpointAt }
      : {}),
    ...(asyncDir ? { asyncDir } : {}),
    ...(run.state === "paused" ? { pauseKind: "cohort_pause" as const } : {}),
    // Ordinary nested resumes use only the validated nested storage root. A
    // project marker opts into its separately validated canonical project cwd.
    ...(cwd ? { cwd } : {}),
    sessionFile: validateNestedSessionFile(run, trustedSessionRoots),
  };
}

function directNestedAsyncInterrupt(
  target: ResolvedSubagentRunId & { kind: "nested" },
): SubagentToolResult<Details> | undefined {
  const run = target.match.run;
  const asyncDir = resolveNestedAsyncDir(target.match.rootRunId, run);
  if (!asyncDir) return undefined;
  const status = reconcileAsyncRun(asyncDir, {
    resultsDir: path.join(RESULTS_DIR, "nested", target.match.rootRunId),
  }).status;
  if (status && hasMalformedProjectAgentControlMarker(status)) {
    return {
      content: [
        {
          type: "text",
          text: projectRunAuthorizationError(
            "the nested target has a malformed project-agent marker; refusing interrupt fallback.",
          ).message,
        },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
  const pid = typeof status?.pid === "number" && status.pid > 0 ? status.pid : run.pid;
  if (!status || status.state !== "running" || typeof pid !== "number" || pid <= 0)
    return undefined;
  try {
    deliverInterruptRequest({ asyncDir, pid, source: "nested-interrupt" });
    return {
      content: [{ type: "text", text: `Interrupt requested for nested async run ${run.id}.` }],
      details: { mode: "management", results: [] },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        { type: "text", text: `Failed to interrupt nested async run ${run.id}: ${message}` },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
}

export function registerForegroundMessageInbox(
  control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never,
  _runId: string,
  index: number,
): string {
  control.messageInboxRoot ??= path.join(FOREGROUND_LIVE_MESSAGE_INBOXES_DIR, randomUUID());
  const dir = path.join(control.messageInboxRoot, String(index));
  fs.mkdirSync(dir, { recursive: true });
  if (!control.activeMessageInboxes) control.activeMessageInboxes = new Map();
  control.activeMessageInboxes.set(index, dir);
  return dir;
}

export function clearForegroundMessageInbox(
  control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never,
  index: number,
): void {
  const dir = control.activeMessageInboxes?.get(index);
  if (dir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Best effort foreground inbox cleanup. */
    }
  }
  control.activeMessageInboxes?.delete(index);
  if (control.activeMessageInboxes?.size === 0) {
    control.activeMessageInboxes = undefined;
    if (control.messageInboxRoot) {
      try {
        fs.rmSync(control.messageInboxRoot, { recursive: true, force: true });
      } catch {
        /* Best effort foreground inbox-root cleanup. */
      }
    }
    control.messageInboxRoot = undefined;
  }
}

function directNestedAsyncSteer(input: {
  target: ResolvedSubagentRunId & { kind: "nested" };
  message: string;
  index?: number;
}): SubagentToolResult<Details> | undefined {
  const run = input.target.match.run;
  const asyncDir = resolveNestedAsyncDir(input.target.match.rootRunId, run);
  if (!asyncDir) return undefined;
  const status = reconcileAsyncRun(asyncDir, {
    resultsDir: path.join(RESULTS_DIR, "nested", input.target.match.rootRunId),
  }).status;
  if (status && hasMalformedProjectAgentControlMarker(status)) {
    return {
      content: [
        {
          type: "text",
          text: projectRunAuthorizationError(
            "the nested target has a malformed project-agent marker; refusing steer fallback.",
          ).message,
        },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
  if (!status || (status.state !== "running" && status.state !== "queued")) return undefined;
  const steps = status.steps ?? [];
  if (input.index !== undefined) {
    if (input.index < 0 || input.index >= steps.length)
      return {
        content: [
          {
            type: "text",
            text: `Nested async run ${run.id} has ${steps.length} children. Index ${input.index} is out of range.`,
          },
        ],
        isError: true,
        details: { mode: "management", results: [] },
      };
    const step = steps[input.index];
    if (step && step.status !== "running" && step.status !== "pending")
      return {
        content: [
          {
            type: "text",
            text: `Nested async run ${run.id} child ${input.index} is ${step.status} and cannot be steered.`,
          },
        ],
        isError: true,
        details: { mode: "management", results: [] },
      };
  }
  requestAsyncSteer(asyncDir, {
    message: input.message,
    targetIndex: input.index,
    source: "nested-steer",
  });
  return {
    content: [
      {
        type: "text",
        text: `Steering queued for nested async run ${run.id}. Delivery requires a live Pi child session that supports mid-run steering.`,
      },
    ],
    details: { mode: "management", results: [] },
  };
}

export function interruptNestedRun(
  target: ResolvedSubagentRunId & { kind: "nested" },
): SubagentToolResult<Details> {
  const run = target.match.run;
  if (run.state === "complete")
    return {
      content: [
        {
          type: "text",
          text: `Nested run ${run.id} is already complete and cannot be interrupted.`,
        },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  if (run.state === "failed")
    return {
      content: [
        { type: "text", text: `Nested run ${run.id} has failed and cannot be interrupted.` },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  if (run.state === "paused")
    return {
      content: [{ type: "text", text: `Nested run ${run.id} is already paused.` }],
      isError: true,
      details: { mode: "management", results: [] },
    };
  const direct = directNestedAsyncInterrupt(target);
  if (direct) return direct;
  return {
    content: [
      {
        type: "text",
        text: `Nested run ${run.id} has no live async target (async run directory/pid), so no safe direct interrupt is available.`,
      },
    ],
    isError: true,
    details: { mode: "management", results: [] },
  };
}

function resumeLiveNestedRun(
  target: ResolvedSubagentRunId & { kind: "nested" },
): SubagentToolResult<Details> {
  const run = target.match.run;
  return {
    content: [
      {
        type: "text",
        text: `Nested run ${run.id} is live; no supported live nested resume path is available. Wait for completion, then retry action='resume' with a follow-up message.`,
      },
    ],
    isError: true,
    details: { mode: "management", results: [] },
  };
}

export function steerNestedRun(input: {
  target: ResolvedSubagentRunId & { kind: "nested" };
  message: string;
  index?: number;
}): SubagentToolResult<Details> {
  const run = input.target.match.run;
  if (run.state !== "running" && run.state !== "queued")
    return {
      content: [
        { type: "text", text: `Nested run ${run.id} is ${run.state} and cannot be steered.` },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  const direct = directNestedAsyncSteer(input);
  if (direct) return direct;
  return {
    content: [
      {
        type: "text",
        text: `Nested run ${run.id} is not a live async Pi child session with a steering inbox. action='steer' cannot target foreground nested runs.`,
      },
    ],
    isError: true,
    details: { mode: "management", results: [] },
  };
}

async function queueLiveAsyncResume(input: {
  target: AsyncResumeSourceTarget & { kind: "live" };
  followUp: string;
  state: SubagentState;
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
}): Promise<SubagentToolResult<Details>> {
  if (!input.target.asyncDir) {
    return {
      content: [
        {
          type: "text",
          text: `Async run '${input.target.runId}' has no live run directory to resume.`,
        },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
  const status = reconcileAsyncRun(input.target.asyncDir, {
    kill: input.kill,
    resultsDir: RESULTS_DIR,
  }).status;
  if (!status || status.state !== "running") {
    return {
      content: [
        {
          type: "text",
          text: `Async run '${input.target.runId}' is not running and cannot accept a live resume follow-up.`,
        },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
  if (!asyncControlOwnedByCurrentSession(input.state, status)) {
    return {
      content: [
        {
          type: "text",
          text: `Async run '${status.runId}' is owned by another session and cannot be resumed from this session.`,
        },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
  const step = status.steps?.[input.target.index];
  if (!step) {
    return {
      content: [
        {
          type: "text",
          text: `Async run '${status.runId}' no longer has child ${input.target.index}. Wait for completion, then retry action='resume' if revival is still needed.`,
        },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
  if (step.status !== "running") {
    return {
      content: [
        {
          type: "text",
          text: `Async run '${status.runId}' child ${input.target.index} is ${step.status} and cannot accept a live resume follow-up.`,
        },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
  const requestId = randomUUID();
  const requestPath = requestAsyncResume(input.target.asyncDir, {
    id: requestId,
    message: input.followUp,
    targetIndex: input.target.index,
    source: "async-resume",
  });
  const acceptance = await waitForChildMessageAcceptance({
    asyncDir: input.target.asyncDir,
    requestId,
    isRunnerAlive: () => {
      if (typeof status.pid !== "number" || status.pid <= 0) return false;
      try {
        (input.kill ?? process.kill)(status.pid, 0);
        return true;
      } catch {
        return false;
      }
    },
  });
  if (
    acceptance.outcome !== "acknowledged" ||
    acceptance.acceptance.status !== "accepted" ||
    !acceptance.acceptance.acceptedIndexes.includes(input.target.index)
  ) {
    try {
      fs.rmSync(requestPath, { force: true });
    } catch {
      /* Best effort request cleanup after failed acceptance. */
    }
    const lateAckPath = childMessageAckPath(input.target.asyncDir, requestId);
    try {
      fs.rmSync(lateAckPath, { force: true });
    } catch {
      /* Best effort immediate ack cleanup. */
    }
    const lateAckCleanup = setTimeout(() => {
      try {
        fs.rmSync(lateAckPath, { force: true });
      } catch {
        /* Best effort cleanup for an acknowledgement racing the timeout. */
      }
    }, 2_500);
    lateAckCleanup.unref?.();
    const reason =
      acceptance.outcome === "runner_gone"
        ? "the runner disappeared before accepting it"
        : acceptance.outcome === "timeout"
          ? "the runner did not acknowledge it before the acceptance timeout"
          : (acceptance.acceptance.reason ??
            acceptance.acceptance.rejected?.[0]?.reason ??
            "the target child rejected it");
    return {
      content: [
        {
          type: "text",
          text: `Live resume follow-up for async run '${status.runId}' child ${input.target.index} was not accepted: ${reason}.`,
        },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
  const tracked = input.state.asyncJobs.get(status.runId);
  if (tracked) tracked.updatedAt = Date.now();
  return {
    content: [
      {
        type: "text",
        text: `Resume follow-up accepted for live async run ${status.runId} child ${input.target.index} and queued in its native inbox.`,
      },
    ],
    details: { mode: "management", results: [] },
  };
}

function explicitResumeModel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "inherit" ? trimmed : undefined;
}

export function buildResumeModelResolution(
  target: ResumeSourceTarget,
  requestedModel: string | undefined,
): SubagentModelResolution | undefined {
  const persisted = target.kind === "revive" ? target.modelResolution : undefined;
  const persistedEffective =
    target.kind === "revive" ? (target.modelIdentity ?? persisted?.resumed) : undefined;
  const persistedOriginal =
    target.kind === "revive" ? (persisted?.original ?? persistedEffective) : undefined;
  const explicit = explicitResumeModel(requestedModel);
  if (explicit) {
    const explicitIdentity = canonicalSubagentModelIdentity(explicit);
    const reference = persistedEffective ?? persistedOriginal;
    return {
      kind: "override",
      ...(reference ? { original: reference } : {}),
      ...(explicitIdentity ? { resumed: explicitIdentity } : {}),
      reason: [
        persisted?.reason,
        reference
          ? `Caller explicitly overrode persisted selection ${reference.provider}/${reference.model}${reference.thinking ? `:${reference.thinking}` : ""} with '${explicit}'.`
          : `Caller explicitly selected '${explicit}' for the resumed child.`,
      ]
        .filter(Boolean)
        .join(" "),
    };
  }
  if (!persistedEffective) return undefined;
  const restoration = `Restored persisted child selection ${persistedEffective.provider}/${persistedEffective.model}${persistedEffective.thinking ? `:${persistedEffective.thinking}` : ""} instead of the current parent model.`;
  return persisted?.kind === "fallback"
    ? {
        ...persisted,
        ...(persistedOriginal ? { original: persistedOriginal } : {}),
        resumed: persistedEffective,
        reason: [persisted.reason, restoration].join(" "),
      }
    : {
        kind: "restored",
        original: persistedOriginal!,
        resumed: persistedEffective,
        reason: [persisted?.reason, restoration].filter(Boolean).join(" "),
      };
}

export async function authorizeProjectSteerTarget(input: {
  params: SubagentParamsLike;
  lookup: ProjectAgentRunReferenceLookup;
  ctx: ExtensionContext;
  deps: ExecutorDeps;
}): Promise<void> {
  if (input.lookup.status === "missing") return;
  if (input.lookup.status === "ambiguous") {
    throw projectRunAuthorizationError(
      `the requested run id is ambiguous in the retained project-agent registry (${input.lookup.runIds.join(", ")}). Provide a full run id.`,
    );
  }
  const runId = input.lookup.runId;
  let location: ReturnType<typeof resolveAsyncRunLocation>;
  try {
    location = resolveAsyncRunLocation(
      { id: runId, dir: input.params.dir, index: input.params.index },
      ASYNC_DIR,
      RESULTS_DIR,
    );
  } catch (error) {
    throw projectRunAuthorizationError(
      error instanceof Error ? error.message : "the persisted control target is invalid.",
    );
  }
  if (!location.asyncDir) {
    throw projectRunAuthorizationError("the retained run has no live async control directory.");
  }
  const status = readStatus(location.asyncDir);
  if (!status) throw projectRunAuthorizationError("the persisted control status is unavailable.");
  if (status.runId !== runId) {
    throw projectRunAuthorizationError(
      "the persisted control status does not match the retained run.",
    );
  }
  const candidateSteps = status.steps ?? [];
  if (candidateSteps.length === 0) {
    throw projectRunAuthorizationError("the persisted run has no selectable child steps.");
  }
  let candidates: NonNullable<AsyncStatus["steps"]>[number][];
  if (input.params.index !== undefined) {
    if (
      !Number.isInteger(input.params.index) ||
      input.params.index < 0 ||
      input.params.index >= candidateSteps.length
    ) {
      throw projectRunAuthorizationError(
        `the selected child index ${input.params.index} is out of range for the retained run.`,
      );
    }
    candidates = [candidateSteps[input.params.index]!];
  } else if (candidateSteps.length === 1) {
    candidates = [candidateSteps[0]!];
  } else {
    candidates = candidateSteps.filter(
      (step) => step.status === "running" || step.status === "pending",
    );
    if (candidates.length === 0) {
      throw projectRunAuthorizationError(
        "the retained run has no running or pending child selected for steering; refusing ordinary control fallback.",
      );
    }
  }

  for (const candidate of candidates) {
    const retainedCapture = input.lookup.captures.find(
      (capture) => capture.provenance.agent === candidate.agent,
    );
    if (!retainedCapture) {
      throw projectRunAuthorizationError(
        `the selected child '${candidate.agent}' has no matching retained project-agent capture; ordinary siblings in a mixed run cannot be controlled safely.`,
      );
    }
    const persistedCapture = normalizeProjectAgentRunCapture(candidate.projectAgent);
    if (!persistedCapture || !projectAgentRunCaptureEquals(persistedCapture, retainedCapture)) {
      throw projectRunAuthorizationError(
        `the selected child '${candidate.agent}' is missing or has corrupt persisted project-agent provenance/config.`,
      );
    }
    await authorizePersistedProjectAgentRun({
      target: {
        runId,
        agent: candidate.agent,
        cwd: status.cwd,
        projectAgent: persistedCapture,
      },
      ctx: input.ctx,
      deps: input.deps,
    });
  }
}

export function projectInterruptResolutionMismatch(
  lookup: ProjectAgentRunReferenceLookup,
  resolvedId: string | undefined,
): Error | undefined {
  if (lookup.status !== "found" || lookup.runId === resolvedId) return undefined;
  return projectRunAuthorizationError(
    resolvedId
      ? `the retained project-agent run '${lookup.runId}' does not match the resolved interrupt target '${resolvedId}'; refusing cancellation.`
      : "the retained project-agent run could not be resolved to a cancellable target; refusing cancellation.",
  );
}

export function projectInterruptAuthorizationResult(error: Error): SubagentToolResult<Details> {
  return {
    content: [{ type: "text", text: error.message }],
    isError: true,
    details: { mode: "management", results: [] },
  };
}

export async function authorizeProjectInterruptTarget(input: {
  params: SubagentParamsLike;
  lookup: ProjectAgentRunReferenceLookup;
  ctx: ExtensionContext;
  deps: ExecutorDeps;
}): Promise<void> {
  let location: ReturnType<typeof resolveAsyncRunLocation>;
  try {
    location = resolveAsyncRunLocation(
      input.lookup.status === "found"
        ? { id: input.lookup.runId, dir: input.params.dir }
        : input.params,
      ASYNC_DIR,
      RESULTS_DIR,
    );
  } catch (error) {
    throw projectRunAuthorizationError(
      error instanceof Error ? error.message : "the persisted interrupt target is invalid.",
    );
  }
  let status: AsyncStatus | null | undefined;
  let statusReadError = false;
  let rawStatusMarker = false;
  if (location.asyncDir) {
    try {
      status = readStatus(location.asyncDir);
    } catch {
      statusReadError = true;
      try {
        rawStatusMarker = /["']projectAgents?["']\s*:/u.test(
          fs.readFileSync(path.join(location.asyncDir, "status.json"), "utf8"),
        );
      } catch {
        // Preserve the ordinary interrupt lifecycle error for malformed
        // marker-free files; unreadable state cannot authorize a control.
      }
    }
  }
  let result: unknown;
  if (!status && location.resultPath) {
    try {
      result = JSON.parse(fs.readFileSync(location.resultPath, "utf8")) as unknown;
    } catch {
      // The normal result parser will report malformed artifacts later; this
      // deny-only probe still refuses marker-shaped result files below.
      try {
        result = /["']projectAgents?["']\s*:/u.test(fs.readFileSync(location.resultPath, "utf8"))
          ? { projectAgents: [] }
          : undefined;
      } catch {
        result = undefined;
      }
    }
  }
  if (input.lookup.status === "missing") {
    if (
      rawStatusMarker ||
      hasProjectAgentControlMarker(status) ||
      hasProjectAgentControlMarker(result)
    ) {
      throw projectRunAuthorizationError(
        "the persisted run carries a project-agent marker, but its process-private reference is unavailable; refusing ordinary interrupt fallback.",
      );
    }
    return;
  }
  if (input.lookup.status === "ambiguous") {
    throw projectRunAuthorizationError(
      `the requested run id is ambiguous in the retained project-agent registry (${input.lookup.runIds.join(", ")}). Provide a full run id.`,
    );
  }
  if (!location.asyncDir || !status || statusReadError) {
    throw projectRunAuthorizationError("the retained run has no persisted interrupt status.");
  }
  if (status.runId !== input.lookup.runId) {
    throw projectRunAuthorizationError(
      "the persisted interrupt status does not match the retained run.",
    );
  }
  const projectSteps = (status.steps ?? []).filter((step) => step.projectAgent !== undefined);
  const projectMarkers = [
    ...projectSteps.map((step) => ({ agent: step.agent, projectAgent: step.projectAgent })),
    ...(status.projectAgents ?? []).map((projectAgent) => ({
      agent:
        isRecordValue(projectAgent) &&
        isRecordValue(projectAgent.provenance) &&
        typeof projectAgent.provenance.agent === "string"
          ? projectAgent.provenance.agent
          : undefined,
      projectAgent,
    })),
  ];
  if (projectMarkers.length === 0) {
    if (hasProjectAgentControlMarker(status)) {
      throw projectRunAuthorizationError(
        "the persisted project-agent interrupt marker has no selectable child capture.",
      );
    }
    return;
  }
  for (const marker of projectMarkers) {
    const persistedCapture = normalizeProjectAgentRunCapture(marker.projectAgent);
    if (!persistedCapture) {
      throw projectRunAuthorizationError(
        "the persisted project-agent interrupt capture is invalid.",
      );
    }
    const agent = marker.agent ?? persistedCapture.provenance.agent;
    const retainedCapture = input.lookup.captures.find(
      (capture) => capture.provenance.agent === agent,
    );
    if (!retainedCapture || !projectAgentRunCaptureEquals(persistedCapture, retainedCapture)) {
      throw projectRunAuthorizationError(
        `the project-agent interrupt child '${agent}' is missing or has corrupt persisted provenance/config.`,
      );
    }
    // Interrupt is a stop-only control and remains available to every primary
    // mode. The retained capture check above still prevents a project marker
    // from silently becoming an ordinary control path.
  }
}

async function resolveResumeActionTarget(input: {
  params: SubagentParamsLike;
  requestedId: string | undefined;
  requestedFollowUp: string;
  privateProjectLookup: ProjectAgentRunReferenceLookup;
  ctx: ExtensionContext;
  deps: ExecutorDeps;
  requestCwd: string;
  parentSessionFile: string | null;
}): Promise<ResumeSourceTarget | SubagentToolResult<Details>> {
  let target: ResumeSourceTarget;
  try {
    let resolved: ResolvedSubagentRunId | undefined;
    try {
      resolved = input.requestedId
        ? resolveSubagentRunId(input.requestedId, { state: input.deps.state })
        : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const asyncMatches = message.match(/async:/g)?.length ?? 0;
      if (!isResumeAmbiguity(error) || !message.includes("foreground:") || asyncMatches !== 1)
        throw error;
    }
    if (resolved?.kind === "nested") {
      if (input.privateProjectLookup.status === "found") {
        throw projectRunAuthorizationError(
          "the retained project-agent run resolved to an unsupported nested control target.",
        );
      }
      if (resolved.match.run.state === "running" || resolved.match.run.state === "queued") {
        return resumeLiveNestedRun(resolved);
      }
      const trustedSessionRoots = input.parentSessionFile
        ? [input.deps.getSubagentSessionRoot(input.parentSessionFile)]
        : [];
      target = resolveNestedResumeTarget(resolved, trustedSessionRoots);
    } else if (resolved?.kind === "async" || input.params.dir) {
      const preResolutionDir =
        resolved?.kind === "async"
          ? resolved.location.asyncDir
          : input.params.dir
            ? path.resolve(input.params.dir)
            : null;
      const preResolutionStatus = preResolutionDir ? readStatus(preResolutionDir) : undefined;
      const hadLiveResumeIntent = Boolean(
        input.requestedFollowUp && preResolutionStatus?.state === "running",
      );
      const asyncTarget: AsyncResumeSourceTarget = {
        source: "async",
        ...resolveAsyncResumeTarget(
          input.privateProjectLookup.status === "found"
            ? { ...input.params, id: input.privateProjectLookup.runId }
            : input.params,
          { kill: input.deps.kill, resultsDir: RESULTS_DIR },
          { requireSessionFile: true, readOnly: preResolutionStatus?.state !== "running" },
        ),
      };
      rejectMissingPrivateProjectReference(input.privateProjectLookup, asyncTarget, {
        allowFreshResume: asyncTarget.kind === "revive",
      });
      if (hadLiveResumeIntent && asyncTarget.kind !== "live") {
        return {
          content: [
            {
              type: "text",
              text: `Async run '${asyncTarget.runId}' was running when resume began, but its runner or selected child went stale before the live follow-up could be accepted. No durable revival was started.`,
            },
          ],
          isError: true,
          details: { mode: "management", results: [] },
        };
      }
      if (asyncTarget.kind === "live") {
        if (!input.requestedFollowUp)
          return {
            content: [{ type: "text", text: "action='resume' requires message." }],
            isError: true,
            details: { mode: "management", results: [] },
          };
        if (input.privateProjectLookup.status === "found") {
          try {
            requirePersistedProjectCaptureForTarget(input.privateProjectLookup, asyncTarget);
            await authorizePersistedProjectAgentRun({
              target: asyncTarget,
              ctx: input.ctx,
              deps: input.deps,
            });
          } catch (error) {
            return {
              content: [
                { type: "text", text: error instanceof Error ? error.message : String(error) },
              ],
              isError: true,
              details: { mode: "management", results: [] },
            };
          }
        }
        return queueLiveAsyncResume({
          target: asyncTarget as AsyncResumeSourceTarget & { kind: "live" },
          followUp: input.requestedFollowUp,
          state: input.deps.state,
          kill: input.deps.kill,
        });
      }
      target = asyncTarget;
    } else {
      target = resolveResumeTarget(input.params, input.deps.state, {
        asyncRequireSessionFile: true,
        readOnly: true,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: message }],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
  return target;
}

function resolveSuccessfulResumeCompletion(target: {
  state: AsyncStatus["state"];
  successfulCompletion?: boolean;
}): boolean {
  return (
    ("successfulCompletion" in target ? target.successfulCompletion : undefined) ??
    target.state === "complete"
  );
}

type ResumeRuntimePolicyPreflight =
  | {
      kind: "ready";
      activeRuntimeMs: number;
      activeRuntimeCheckpointAt?: number;
      successfulCompletion: boolean;
      runTimeoutMs?: number;
    }
  | { kind: "error"; message: string };

function preflightResumeRuntimePolicy(
  target: ResumeSourceTarget,
  agentConfig: AgentConfig,
  executionPolicy: ResolvedExecutionPolicy,
): ResumeRuntimePolicyPreflight {
  const runTimeoutMs =
    executionPolicy.maxRunTimeMs === false ? undefined : executionPolicy.maxRunTimeMs;
  const successfulCompletion = resolveSuccessfulResumeCompletion(target);
  // A successful selected child is the sole reset boundary. Every other
  // resumable outcome carries only validated logical runtime evidence; paused
  // wall time never enters the continuation budget. The aggregate lifecycle
  // state remains independent because a parallel cohort may have failed after
  // this selected child completed successfully.
  const normalizedTargetActiveRuntimeMs = normalizeActiveRuntimeMs(target.activeRuntimeMs);
  if (
    !successfulCompletion &&
    target.activeRuntimeMs !== undefined &&
    normalizedTargetActiveRuntimeMs === undefined
  ) {
    return {
      kind: "error",
      message: "Invalid active runtime evidence; continuation cannot start.",
    };
  }
  const activeRuntimeCheckpointAt = normalizeActiveRuntimeCheckpointAt(
    target.activeRuntimeCheckpointAt,
  );
  if (
    !successfulCompletion &&
    target.activeRuntimeCheckpointAt !== undefined &&
    activeRuntimeCheckpointAt === undefined
  ) {
    return {
      kind: "error",
      message: "Invalid active runtime checkpoint; continuation cannot start.",
    };
  }
  const activeRuntimeMs = successfulCompletion ? 0 : (normalizedTargetActiveRuntimeMs ?? 0);
  const remainingAgentTimeMs = remainingExecutionTimeMs(
    agentConfig.maxExecutionTimeMs,
    activeRuntimeMs,
  );
  if (remainingAgentTimeMs === 0) {
    return {
      kind: "error",
      message: `Agent '${target.agent}' has exhausted its maxExecutionTimeMs ceiling after ${activeRuntimeMs}ms of active runtime.`,
    };
  }
  return {
    kind: "ready",
    activeRuntimeMs,
    ...(activeRuntimeCheckpointAt !== undefined ? { activeRuntimeCheckpointAt } : {}),
    successfulCompletion,
    ...(runTimeoutMs !== undefined ? { runTimeoutMs } : {}),
  };
}

type ResumeContextPolicyPreflight =
  | { kind: "ready"; modelContextWindow?: number }
  | { kind: "error"; message: string };

function preflightResumeContextPolicy(
  target: ResumeSourceTarget,
  agentConfig: AgentConfig,
  modelOverride: string | undefined,
  currentModel: { provider: string; id: string } | undefined,
  availableModels: ModelInfo[],
): ResumeContextPolicyPreflight {
  if (target.kind !== "revive") return { kind: "ready" };
  const selectedModel =
    explicitResumeModel(modelOverride) ??
    (target.modelIdentity ? modelReferenceFromIdentity(target.modelIdentity) : undefined) ??
    agentConfig.model ??
    (currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined);
  const modelContextWindow = resolveEffectiveContextWindow(
    selectedModel,
    availableModels,
    currentModel?.provider,
  );
  const contextAssessment = assessDurableResumeContext(
    target.contextUsage,
    modelContextWindow ?? target.contextUsage?.contextWindow,
  );
  if (contextAssessment.blocked) {
    return { kind: "error", message: formatDurableResumeContextBlock(contextAssessment) };
  }
  return { kind: "ready", modelContextWindow };
}

export async function resumeAsyncRun(input: {
  params: SubagentParamsLike;
  requestCwd: string;
  ctx: ExtensionContext;
  deps: ExecutorDeps;
  artifactConfig: ResolvedArtifactConfig;
  executionPolicy: ResolvedExecutionPolicy;
}): Promise<SubagentToolResult<Details>> {
  const requestedFollowUp = (input.params.message ?? input.params.task ?? "").trim();
  input.deps.state.currentSessionId = resolveCurrentSessionId(input.ctx.sessionManager);
  const privateProjectLookup = lookupPrivateProjectActionReference(input.params);
  if (privateProjectLookup.status === "ambiguous") {
    return {
      content: [
        {
          type: "text",
          text: projectRunAuthorizationError(
            `the requested run id is ambiguous in the retained project-agent registry (${privateProjectLookup.runIds.join(", ")}). Provide a full run id.`,
          ).message,
        },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
  const resolutionParams =
    privateProjectLookup.status === "found"
      ? { ...input.params, id: privateProjectLookup.runId }
      : input.params;
  const requestedId = resolutionParams.id;

  const parentSessionFile = input.ctx.sessionManager.getSessionFile() ?? null;
  const targetResolution = await resolveResumeActionTarget({
    params: resolutionParams,
    requestedId,
    requestedFollowUp,
    privateProjectLookup,
    ctx: input.ctx,
    deps: input.deps,
    requestCwd: input.requestCwd,
    parentSessionFile,
  });
  if ("content" in targetResolution) return targetResolution;
  const target = targetResolution;

  try {
    rejectMissingPrivateProjectReference(privateProjectLookup, target, {
      allowFreshResume: target.kind === "revive",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: message }],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }

  const followUp =
    requestedFollowUp ||
    (target.kind === "revive" &&
    target.state === "paused" &&
    target.pauseKind === "awaiting_supervisor"
      ? UNCHANGED_SUPERVISOR_RESUME_MESSAGE
      : "");
  if (!followUp) {
    return {
      content: [{ type: "text", text: "action='resume' requires message." }],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }

  let persistedProjectAuthorization: AuthorizedProjectAgentRun | undefined;
  const targetProjectCapture = "projectAgent" in target ? target.projectAgent : undefined;
  if (privateProjectLookup.status === "found" || targetProjectCapture !== undefined) {
    try {
      requirePersistedProjectCaptureForTarget(privateProjectLookup, target);
      persistedProjectAuthorization = await authorizePersistedProjectAgentRun({
        target,
        ctx: input.ctx,
        deps: input.deps,
      });
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
  }

  const { blocked, depth, maxDepth } = checkSubagentDepth(input.deps.config.maxSubagentDepth);
  if (blocked) {
    return {
      content: [
        {
          type: "text",
          text: `Nested subagent resume blocked (depth=${depth}, max=${maxDepth}). Complete the follow-up directly instead.`,
        },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }

  input.deps.state.currentSessionId = resolveCurrentSessionId(input.ctx.sessionManager);
  const effectiveCwd =
    persistedProjectAuthorization?.canonicalCwd ?? target.cwd ?? input.requestCwd;
  const scope: AgentScope = resolveExecutionAgentScope(input.params.agentScope);
  const discovered = persistedProjectAuthorization
    ? {
        agents: [persistedProjectAuthorization.agentConfig],
        modelScope: persistedProjectAuthorization.modelScope,
      }
    : input.deps.discoverAgents(effectiveCwd, scope);
  const discoveredAgents = discovered.agents;
  const modelScope = discovered.modelScope;
  const agents = discoveredAgents;
  const agentConfig =
    agents.find((agent) => agent.name === target.agent) ??
    persistedProjectAuthorization?.agentConfig;
  if (!agentConfig) {
    return {
      content: [
        {
          type: "text",
          text: unknownAgentMessage(
            target.agent,
            discovered.agentDiagnostics,
            "Unknown agent for resume",
          ),
        },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }

  const runtimePolicy = preflightResumeRuntimePolicy(target, agentConfig, input.executionPolicy);
  if (runtimePolicy.kind === "error") {
    return {
      content: [{ type: "text", text: runtimePolicy.message }],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
  const { activeRuntimeMs, activeRuntimeCheckpointAt, successfulCompletion, runTimeoutMs } =
    runtimePolicy;

  const modelRegistrySnapshot = readModelRegistrySnapshot(input.ctx);
  const { availableModels } = modelRegistrySnapshot;
  const contextPolicy = preflightResumeContextPolicy(
    target,
    agentConfig,
    input.params.model,
    input.ctx.model,
    availableModels,
  );
  if (contextPolicy.kind === "error") {
    return {
      content: [{ type: "text", text: contextPolicy.message }],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
  const { modelContextWindow } = contextPolicy;

  const continuationRunId = randomUUID().slice(0, 8);
  let claimedPause: PausedContinuationClaim | undefined;
  try {
    const claimDecision = claimPausedAwaitingSupervisorTarget(
      target,
      continuationRunId,
      modelContextWindow,
    );
    if (claimDecision && "blockedMessage" in claimDecision) {
      return {
        content: [{ type: "text", text: claimDecision.blockedMessage }],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
    claimedPause = claimDecision;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: message }],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }

  const runId = continuationRunId;
  const artifactsDir = getArtifactsDir(parentSessionFile);
  const resumeModelResolution = buildResumeModelResolution(target, input.params.model);
  const restoredModelIdentity =
    explicitResumeModel(input.params.model) || target.kind !== "revive"
      ? undefined
      : target.modelIdentity;
  let projectRunTransferred = false;
  if (persistedProjectAuthorization) {
    try {
      if (persistedProjectAuthorization.freshRebind) {
        retainProjectAgentRunReference(persistedProjectAuthorization.capability, runId, [
          persistedProjectAuthorization.capture,
        ]);
      } else {
        retainProjectAgentRunReferenceFrom(target.runId, runId);
      }
      projectRunTransferred = true;
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `TLH project-agent control rejected: could not retain the authorized generation: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
  }
  let result: ReturnType<typeof executeAsyncSingle>;
  try {
    result = (input.deps.executeAsyncSingle ?? executeAsyncSingle)(runId, {
      agent: target.agent,
      ...(claimedPause
        ? {
            continuationSource: {
              asyncDir: claimedPause.asyncDir,
              runId: target.runId,
              index: target.index,
              claimToken: claimedPause.claimToken,
              ...(persistedProjectAuthorization
                ? { projectAgent: persistedProjectAuthorization.capture }
                : {}),
            },
          }
        : {}),
      ...(target.source === "async" && target.tkTicket
        ? { inheritedTkTicket: target.tkTicket }
        : {}),
      task: buildRevivedAsyncTask(target, followUp),
      modelOverride: input.params.model,
      ...(restoredModelIdentity ? { restoredModelIdentity } : {}),
      ...(resumeModelResolution ? { modelResolution: resumeModelResolution } : {}),
      ...(target.kind === "revive" && "contextUsage" in target && target.contextUsage
        ? { contextUsage: target.contextUsage }
        : {}),
      // A same-segment revival restores the latest display projection and the
      // machine deduplication history independently. A claimed pause creates a
      // new continuation segment and intentionally starts with neither.
      ...(target.kind === "revive" && !claimedPause && "contextPressure" in target
        ? { contextPressure: target.contextPressure }
        : {}),
      ...(target.kind === "revive" && !claimedPause && "contextPressureCrossedThresholds" in target
        ? { contextPressureCrossedThresholds: target.contextPressureCrossedThresholds }
        : {}),
      agentConfig,
      projectAgent: persistedProjectAuthorization?.capture,
      ctx: {
        pi: input.deps.pi,
        cwd: persistedProjectAuthorization?.canonicalCwd ?? input.requestCwd,
        currentSessionId: input.deps.state.currentSessionId,
        parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
        currentModelProvider: input.ctx.model?.provider,
        currentModel: input.ctx.model,
        modelScope,
      },
      cwd: effectiveCwd,
      maxOutput: input.params.maxOutput,
      artifactsDir,
      artifactConfig: input.artifactConfig,
      shareEnabled: input.params.share === true,
      sessionRoot: input.deps.getSubagentSessionRoot(parentSessionFile),
      sessionFile: target.sessionFile,
      acceptance: input.params.acceptance,
      continuationAcceptance: target.state === "paused" ? target.continuationAcceptance : undefined,
      activeRuntimeMs,
      ...(!successfulCompletion && activeRuntimeCheckpointAt !== undefined
        ? { activeRuntimeCheckpointAt }
        : {}),
      timeoutMs: runTimeoutMs,
      outputBaseDir: resolveSingleRunOutputBaseDir(artifactsDir, runId),
      maxSubagentDepth: resolveCurrentMaxSubagentDepth(input.deps.config.maxSubagentDepth),
      controlConfig: resolveControlConfig(input.deps.config.control, input.params.control),
      availableModels,
      modelRegistry: modelRegistrySnapshot.evidence,
      providerFallbackModels: providerFallbackModelsForTarget(input.params),
      modelFallbackNotice: input.params.modelFallbackNotice,
    });
  } catch (error) {
    claimedPause?.rollbackReserved();
    if (projectRunTransferred) releaseProjectAgentRunReference(runId);
    throw error;
  }
  if (result.isError) {
    claimedPause?.rollbackReserved();
    if (projectRunTransferred) releaseProjectAgentRunReference(runId);
    return result;
  }

  const revivedId = result.details.asyncId ?? runId;
  claimedPause?.markSpawned();
  if (persistedProjectAuthorization) releaseProjectSourceAfterContinuation(target);
  if (target.source === "foreground") input.deps.state.foregroundRuns?.delete(target.runId);

  const sourceLabel = target.source;
  const privacySafeSupervisorResume =
    target.kind === "revive" &&
    target.state === "paused" &&
    target.pauseKind === "awaiting_supervisor";
  const lines = [
    `Revived ${sourceLabel} subagent from ${target.runId}.`,
    `Revived run: ${revivedId}`,
    `Agent: ${target.agent}`,
    persistedProjectAuthorization?.digestChangeNotice
      ? `Notice: ${persistedProjectAuthorization.digestChangeNotice}`
      : undefined,
    privacySafeSupervisorResume ? undefined : `Session: ${target.sessionFile}`,
    !privacySafeSupervisorResume && result.details.asyncDir
      ? `Async dir: ${result.details.asyncDir}`
      : undefined,
    `Status if needed: subagent({ action: "status", id: "${revivedId}" })`,
  ].filter((line): line is string => Boolean(line));
  return {
    content: [{ type: "text", text: formatAsyncStartedMessage(lines.join("\n")) }],
    details: result.details,
  };
}

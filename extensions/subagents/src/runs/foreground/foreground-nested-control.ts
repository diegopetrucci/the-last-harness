import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { NestedRunSummary } from "../../shared/types.ts";
import type { ResolvedSubagentRunId } from "../background/run-id-resolver.ts";
import { validateProjectAgentCwdContainment } from "../../agents/project-agent-loader.ts";
import {
  normalizeProjectAgentRunCapture,
  type ProjectAgentRunCapture,
} from "../../agents/project-agent-snapshot.ts";
import {
  canonicalSubagentModelIdentity,
  sanitizeSubagentModelIdentity,
  sanitizeSubagentModelResolution,
} from "../shared/model-fallback.ts";
import {
  parseContextPressureCrossedThresholds,
  parseContextPressureProjection,
  parseContextUsageDiagnostics,
} from "../../shared/context-diagnostics.ts";
import { resolveNestedAsyncDir } from "../shared/nested-events.ts";
import { normalizeActiveRuntimeCheckpointAt } from "../shared/lifecycle-state.ts";
import { reconcileAsyncRun } from "../background/stale-run-reconciler.ts";
import { deliverInterruptRequest, requestAsyncSteer } from "../background/control-channel.ts";
import {
  type Details,
  type SubagentToolResult,
  RESULTS_DIR,
  TEMP_ROOT_DIR,
} from "../../shared/types.ts";
import {
  hasMalformedProjectAgentControlMarker,
  projectRunAuthorizationError,
} from "./project-agent-control.ts";
import type { SubagentState } from "../../shared/types.ts";

export const NESTED_ASYNC_RUNS_DIR = path.join(TEMP_ROOT_DIR, "nested-subagent-runs");
const FOREGROUND_LIVE_MESSAGE_INBOXES_DIR = path.join(
  TEMP_ROOT_DIR,
  "foreground-live-message-inboxes",
);

export type NestedResumeSourceTarget = {
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

export function resolveNestedResumeTarget(
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

export function resumeLiveNestedRun(
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

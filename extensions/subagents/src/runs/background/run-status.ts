import * as fs from "node:fs";
import * as path from "node:path";
import {
  formatAsyncRunList,
  formatAsyncRunOutputPath,
  formatAsyncRunProgressLabel,
  listAsyncRuns,
} from "./async-status.ts";
import { formatModelThinking, shortenPath } from "../../shared/formatters.ts";
import { formatActivityLabel } from "../../shared/status-format.ts";
import {
  ASYNC_DIR,
  RESULTS_DIR,
  type AsyncStatus,
  type Details,
  type ForegroundResumeRun,
  type SubagentState,
  type SubagentToolResult,
  normalizeSubagentRunMode,
} from "../../shared/types.ts";
import { resolveAsyncRunLocation } from "./async-resume.ts";
import { resolveSubagentRunId } from "./run-id-resolver.ts";
import { reconcileAsyncRun } from "./stale-run-reconciler.ts";
import { formatOwnedProcessGroupCleanup } from "../shared/process-group-cleanup.ts";
import { formatForegroundSupervisorPauseMessage } from "../../shared/foreground-pause.ts";
import { lifecycleContinuationForIndex } from "../shared/lifecycle-state.ts";
import {
  formatProtectedLifecycleCleanup,
  isProtectedPausedLifecycle,
  protectedLifecycleText,
} from "../shared/lifecycle-privacy.ts";
import {
  safeTerminalDocument,
  safeTerminalDocumentLeaf,
  safeTerminalText,
} from "../../shared/display-text.ts";
import { acceptanceRejectionReason } from "../shared/acceptance.ts";
import { formatRejectionReason } from "../../shared/string-utils.ts";

interface RunStatusParams {
  action?: "status";
  id?: string;
  dir?: string;
  /** Select a direct async child for pause/continuation guidance. */
  index?: number;
}

interface RunStatusDeps {
  asyncDirRoot?: string;
  resultsDir?: string;
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
  now?: () => number;
  state?: SubagentState;
}

type AsyncStatusStep = NonNullable<AsyncStatus["steps"]>[number];

type AsyncResultStatusData = {
  id?: string;
  runId?: string;
  agent?: string;
  success?: boolean;
  summary?: string;
  output?: string;
  exitCode?: number;
  state?: string;
  pause?: { kind?: string };
  timedOut?: boolean;
  timeoutOwner?: "role" | "run";
  terminationReason?: string;
  sessionFile?: string;
  results?: Array<{
    agent?: string;
    output?: string;
    summary?: string;
    sessionFile?: string;
    state?: string;
    success?: boolean;
    exitCode?: number | null;
    timedOut?: boolean;
    timeoutOwner?: "role" | "run";
    terminationReason?: string;
  }>;
};

const BUDGET_EXHAUSTION_GUIDANCE =
  "Budget exhausted: this child instance is permanently expired. Inspect partial output, artifacts, and files before deciding on a fresh dispatch; do not resume or mechanically redispatch the unchanged task.";

function isRoleBudgetExhausted(value: {
  timedOut?: unknown;
  timeoutOwner?: unknown;
  terminationReason?: unknown;
}): boolean {
  return (
    value.timeoutOwner === "role" &&
    (value.timedOut === true || value.terminationReason === "timed_out")
  );
}

function hasExistingSessionFile(value: unknown): value is string {
  return typeof value === "string" && fs.existsSync(value);
}

function formatResumeGuidance(
  runId: string | undefined,
  children: Array<{
    agent?: unknown;
    sessionFile?: unknown;
    timedOut?: unknown;
    timeoutOwner?: unknown;
    terminationReason?: unknown;
  }>,
  fallbackSessionFile?: unknown,
  runExhausted = false,
): string {
  const exhaustedChildren = children.filter(isRoleBudgetExhausted);
  const knownChildren = children
    .map((child, index) => ({ child, index }))
    .filter(({ child }) => typeof child.agent === "string" && !isRoleBudgetExhausted(child));
  const exhausted = runExhausted || exhaustedChildren.length > 0;
  if (!runId || knownChildren.length === 0)
    return exhausted
      ? `Resume: unavailable; ${BUDGET_EXHAUSTION_GUIDANCE}`
      : "Resume: unavailable; no child session file was persisted.";
  const safeRunId = safeTerminalText(runId);
  const singleSessionFile = knownChildren[0]?.child.sessionFile ?? fallbackSessionFile;
  if (
    children.length === 1 &&
    knownChildren.length === 1 &&
    hasExistingSessionFile(singleSessionFile)
  ) {
    if (runExhausted) return `Resume: unavailable; ${BUDGET_EXHAUSTION_GUIDANCE}`;
    return `Revive: subagent({ action: "resume", id: "${safeRunId}", message: "..." })`;
  }
  const childWithSession = knownChildren.find(({ child }) =>
    hasExistingSessionFile(child.sessionFile),
  );
  if (childWithSession) {
    return `Revive child: subagent({ action: "resume", id: "${safeRunId}", index: ${childWithSession.index}, message: "..." })`;
  }
  return exhausted
    ? `Resume: unavailable; ${BUDGET_EXHAUSTION_GUIDANCE}`
    : "Resume: unavailable; no child session file was persisted.";
}

function isPausedAwaitingSupervisorStatus(status: AsyncStatus): boolean {
  return status.state === "paused" && status.pause?.kind === "awaiting_supervisor";
}

function isPausedAwaitingSupervisorStep(
  status: AsyncStatus,
  step: NonNullable<AsyncStatus["steps"]>[number],
): boolean {
  return (
    status.state === "paused" &&
    step.status === "paused" &&
    step.pause?.kind === "awaiting_supervisor"
  );
}

function isPausedCohortStep(
  status: AsyncStatus,
  step: NonNullable<AsyncStatus["steps"]>[number],
): boolean {
  return (
    status.state === "paused" && step.status === "paused" && step.pause?.kind === "cohort_pause"
  );
}

function isPausingLifecycleStep(
  status: AsyncStatus,
  step: NonNullable<AsyncStatus["steps"]>[number],
): boolean {
  return Boolean(step.pause?.kind) && (status.state === "pausing" || step.status === "pausing");
}

function stepLineLabel(status: AsyncStatus, index: number): string {
  const steps = status.steps ?? [];
  return status.mode === "parallel"
    ? `Agent ${index + 1}/${steps.length || 1}`
    : `Step ${index + 1}`;
}

function formatSteeringSummary(input: {
  steerCount?: number;
  lastSteerAt?: number;
}): string | undefined {
  const parts: string[] = [];
  if (input.steerCount !== undefined)
    parts.push(`${input.steerCount} steer${input.steerCount === 1 ? "" : "s"}`);
  if (typeof input.lastSteerAt === "number" && Number.isFinite(input.lastSteerAt))
    parts.push(`last ${new Date(input.lastSteerAt).toISOString()}`);
  return parts.length ? parts.join(", ") : undefined;
}

function formatAsyncStepStatusLines(
  status: AsyncStatus,
  step: AsyncStatusStep,
  index: number,
  asyncDir: string,
  outputPath: string | undefined,
  privacySafeAwaitingSupervisorLifecycle: boolean,
): string[] {
  const lines: string[] = [];
  const stepActivityText =
    step.status === "running"
      ? formatActivityLabel(step.lastActivityAt, step.activityState)
      : undefined;
  const modelThinking = safeTerminalText(formatModelThinking(step.model, step.thinking));
  const modelText = modelThinking ? ` (${modelThinking})` : "";
  const steeringText = formatSteeringSummary(step);
  const steeringSuffix = steeringText ? `, steering: ${steeringText}` : "";
  const errorText = step.error
    ? `, error: ${privacySafeAwaitingSupervisorLifecycle ? protectedLifecycleText("error").replace(/\.$/, "") : safeTerminalText(step.error)}`
    : "";
  const acceptanceText = step.acceptance?.status
    ? `, acceptance: ${safeTerminalText(step.acceptance.status)}`
    : "";
  lines.push(
    `${stepLineLabel(status, index)}: ${safeTerminalText(step.agent)} ${safeTerminalText(step.status)}${modelText}${stepActivityText ? `, ${safeTerminalText(stepActivityText)}` : ""}${steeringSuffix}${acceptanceText}${errorText}`,
  );
  if (step.acceptance?.status === "rejected" && !privacySafeAwaitingSupervisorLifecycle) {
    const reason = acceptanceRejectionReason(step.acceptance);
    if (reason)
      lines.push(`  Acceptance reason: ${safeTerminalText(formatRejectionReason(reason))}`);
  }
  const stepContinuation = lifecycleContinuationForIndex(status, index);
  const stepClaimed =
    typeof stepContinuation?.claimToken === "string" && stepContinuation.claimToken.length > 0;
  if (isRoleBudgetExhausted(step)) {
    lines.push(`  ${BUDGET_EXHAUSTION_GUIDANCE}`);
  } else if (isPausedAwaitingSupervisorStep(status, step)) {
    lines.push(
      `  Pause: awaiting supervisor${step.pause?.summary ? ` (${safeTerminalText(step.pause.summary)})` : ""}`,
    );
    lines.push("  No child process is running.");
    if (stepClaimed) {
      lines.push(
        "  Resume unchanged: unavailable; this paused child is already claimed for continuation.",
      );
      lines.push(
        "  Resume with guidance: unavailable; this paused child is already claimed for continuation.",
      );
      lines.push("  Cancel: unavailable while continuation launch is finalizing.");
    } else {
      lines.push(
        `  Resume unchanged: subagent({ action: "resume", id: "${safeTerminalText(status.runId)}", index: ${index} })`,
      );
      lines.push(
        `  Resume with guidance: subagent({ action: "resume", id: "${safeTerminalText(status.runId)}", index: ${index}, message: "Supervisor replied: ..." })`,
      );
      lines.push(
        `  Cancel: subagent({ action: "interrupt", id: "${safeTerminalText(status.runId)}", index: ${index} })`,
      );
    }
  } else if (isPausedCohortStep(status, step)) {
    lines.push("  Pause: cohort pause while another child awaited supervisor.");
    lines.push(
      `  Resume child: subagent({ action: "resume", id: "${safeTerminalText(status.runId)}", index: ${index}, message: "..." })`,
    );
    lines.push(
      `  Cancel child: subagent({ action: "interrupt", id: "${safeTerminalText(status.runId)}", index: ${index} })`,
    );
  } else if (isPausingLifecycleStep(status, step)) {
    if (step.pause?.kind === "awaiting_supervisor")
      lines.push(
        `  Pause: awaiting supervisor${step.pause.summary ? ` (${safeTerminalText(step.pause.summary)})` : ""}`,
      );
    else lines.push("  Pause: cohort pause while another child awaited supervisor.");
    lines.push("  Stopping/reaping child; not resumable yet; check status again.");
  }
  if (step.exitCode !== undefined) lines.push(`  Exit code: ${step.exitCode}`);
  if (step.exitSignal) lines.push(`  Exit signal: ${step.exitSignal}`);
  if (step.processCleanup) {
    lines.push(
      `  Cleanup: ${privacySafeAwaitingSupervisorLifecycle ? formatProtectedLifecycleCleanup(step.processCleanup) : formatOwnedProcessGroupCleanup(step.processCleanup)}`,
    );
    if (!privacySafeAwaitingSupervisorLifecycle)
      for (const warning of step.processCleanup.warnings ?? [])
        lines.push(`  Cleanup warning: ${safeTerminalText(warning)}`);
  }
  const stepOutputPath = path.join(asyncDir, `output-${index}.log`);
  if (
    !privacySafeAwaitingSupervisorLifecycle &&
    stepOutputPath !== outputPath &&
    fs.existsSync(stepOutputPath)
  )
    lines.push(`  Output: ${safeTerminalText(stepOutputPath)}`);
  if (step.status === "running") {
    lines.push(
      `  Steer: subagent({ action: "steer", id: "${safeTerminalText(status.runId)}", index: ${index}, message: "..." })`,
    );
  }
  return lines;
}

function rememberedForegroundChildOutput(child: ForegroundResumeRun["children"][number]): string {
  const outputPath = child.artifactPaths?.outputPath;
  if (outputPath && fs.existsSync(outputPath)) {
    try {
      const artifactOutput = fs.readFileSync(outputPath, "utf-8").trim();
      if (artifactOutput) return artifactOutput;
    } catch {
      // Fall back to the remembered snapshot below.
    }
  }
  return child.finalOutput ?? "";
}

function formatRememberedForegroundStatus(run: ForegroundResumeRun): string {
  const runId = safeTerminalText(run.runId);
  const lines = [
    `Run: ${runId}`,
    "State: remembered foreground",
    `Mode: ${safeTerminalText(run.mode)}`,
    `Updated: ${new Date(run.updatedAt).toISOString()}`,
  ];
  for (const child of run.children) {
    const output = safeTerminalDocumentLeaf(rememberedForegroundChildOutput(child))
      .trim()
      .split(/\r?\n/)
      .find((line) => line.trim());
    const budgetExhausted = isRoleBudgetExhausted(child);
    const statusLabel = child.cancel?.cancelledAt ? "cancelled" : safeTerminalText(child.status);
    const parts = [
      `${child.index + 1}. ${safeTerminalText(child.agent)} ${statusLabel}`,
      child.exitCode !== undefined ? `exit ${child.exitCode}` : undefined,
      child.pause?.kind === "awaiting_supervisor" && !child.cancel?.cancelledAt
        ? "awaiting supervisor"
        : undefined,
      output ? `output: ${output.slice(0, 160)}` : undefined,
    ].filter(Boolean);
    lines.push(parts.join(", "));
    if (budgetExhausted) lines.push(`  ${BUDGET_EXHAUSTION_GUIDANCE}`);
    if (child.pause?.kind !== "awaiting_supervisor") {
      if (child.transcriptPath)
        lines.push(
          `  Diagnostic transcript: ${safeTerminalText(shortenPath(child.transcriptPath))}`,
        );
      if (child.artifactPaths?.outputPath)
        lines.push(`  Output: ${safeTerminalText(shortenPath(child.artifactPaths.outputPath))}`);
    }
    if (child.transcriptError)
      lines.push(`  Diagnostic transcript warning: ${safeTerminalText(child.transcriptError)}`);
    if (child.pause?.kind === "awaiting_supervisor" && !child.cancel?.cancelledAt) {
      lines.push(
        ...formatForegroundSupervisorPauseMessage({
          headline: `Child ${child.index + 1} is paused awaiting supervisor.`,
          runId,
          agent: safeTerminalText(child.agent),
          requestSummary: child.pause.summary
            ? safeTerminalText(child.pause.summary)
            : child.pause.summary,
          index: child.index,
        })
          .split("\n")
          .map((line) => `  ${line}`),
      );
    }
  }
  lines.push("", `Status: subagent({ action: "status", id: "${runId}" })`);
  const resumable = run.children.find(
    (child) =>
      !child.cancel?.cancelledAt &&
      !isRoleBudgetExhausted(child) &&
      hasExistingSessionFile(child.sessionFile),
  );
  const awaitingSupervisor = run.children.some(
    (child) => child.pause?.kind === "awaiting_supervisor" && !child.cancel?.cancelledAt,
  );
  if (resumable && !awaitingSupervisor) {
    lines.push(
      run.children.length === 1
        ? `Resume with guidance: subagent({ action: "resume", id: "${runId}", message: "..." })`
        : `Resume child with guidance: subagent({ action: "resume", id: "${runId}", index: ${resumable.index}, message: "..." })`,
    );
  } else if (run.children.some((child) => child.cancel?.cancelledAt)) {
    lines.push(
      "Resume: unavailable; this paused foreground run was cancelled and kept its retained output/session artifacts; compact mode may omit the diagnostic child transcript.",
    );
  } else if (run.children.some(isRoleBudgetExhausted)) {
    lines.push(`Resume: unavailable; ${BUDGET_EXHAUSTION_GUIDANCE}`);
  } else {
    lines.push("Resume: unavailable; no child session file was persisted.");
  }
  return safeTerminalDocument(lines.join("\n"));
}

function formatDetailedAsyncStatus(
  status: AsyncStatus,
  asyncDir: string,
  outputPath: string | undefined,
  reconciliation: ReturnType<typeof reconcileAsyncRun>,
  requestedIndex: number | undefined,
  logPath: string,
  eventsPath: string,
): string {
  const progressLabel = formatAsyncRunProgressLabel({
    mode: normalizeSubagentRunMode(status.mode),
    state: status.state,
    currentStep: status.currentStep,
    steps: (status.steps ?? []).map((step, index) => ({
      index,
      agent: step.agent,
      status: step.status,
    })),
  });
  const started = new Date(status.startedAt).toISOString();
  const updated = status.lastUpdate ? new Date(status.lastUpdate).toISOString() : "n/a";
  const statusActivityText =
    status.state === "running"
      ? formatActivityLabel(status.lastActivityAt, status.activityState)
      : undefined;
  const steeringText = formatSteeringSummary(status);

  const pausedAwaitingSupervisor = isPausedAwaitingSupervisorStatus(status);
  const privacySafeAwaitingSupervisorLifecycle = isProtectedPausedLifecycle(status);
  const lines = [
    `Run: ${safeTerminalText(status.runId)}`,
    `State: ${safeTerminalText(status.state)}`,
    status.error
      ? `Error: ${privacySafeAwaitingSupervisorLifecycle ? protectedLifecycleText("error") : safeTerminalText(status.error)}`
      : undefined,
    statusActivityText ? `Activity: ${statusActivityText}` : undefined,
    steeringText ? `Steering: ${steeringText}` : undefined,
    `Mode: ${safeTerminalText(normalizeSubagentRunMode(status.mode))}`,
    !privacySafeAwaitingSupervisorLifecycle && typeof status.pid === "number"
      ? `PID: ${status.pid}`
      : undefined,
    !privacySafeAwaitingSupervisorLifecycle && status.cwd
      ? `Cwd: ${safeTerminalText(status.cwd)}`
      : undefined,
    `Progress: ${safeTerminalText(progressLabel)}`,
    status.pendingAppends ? `Pending appends: ${status.pendingAppends}` : undefined,
    `Started: ${started}`,
    `Updated: ${updated}`,
    !privacySafeAwaitingSupervisorLifecycle ? `Dir: ${safeTerminalText(asyncDir)}` : undefined,
    !privacySafeAwaitingSupervisorLifecycle && outputPath
      ? `Output: ${safeTerminalText(outputPath)}`
      : undefined,
    reconciliation.message
      ? `Diagnosis: ${privacySafeAwaitingSupervisorLifecycle ? protectedLifecycleText("diagnosis") : safeTerminalText(reconciliation.message)}`
      : undefined,
    !privacySafeAwaitingSupervisorLifecycle &&
    reconciliation.resultPath &&
    fs.existsSync(reconciliation.resultPath)
      ? `Result: ${safeTerminalText(reconciliation.resultPath)}`
      : undefined,
  ].filter((line): line is string => Boolean(line));
  for (const [index, step] of (status.steps ?? []).entries())
    lines.push(
      ...formatAsyncStepStatusLines(
        status,
        step,
        index,
        asyncDir,
        outputPath,
        privacySafeAwaitingSupervisorLifecycle,
      ),
    );
  if (!privacySafeAwaitingSupervisorLifecycle && status.sessionFile)
    lines.push(`Session: ${safeTerminalText(status.sessionFile)}`);
  if (status.state === "running")
    lines.push(
      `Steer running child: subagent({ action: "steer", id: "${safeTerminalText(status.runId)}", message: "..." })`,
    );
  if (pausedAwaitingSupervisor && (status.steps?.length ?? 0) <= 1) {
    lines.push(
      ...formatForegroundSupervisorPauseMessage({
        headline: "Paused lifecycle actions:",
        runId: safeTerminalText(status.runId),
        agent: status.steps?.[0]?.agent ? safeTerminalText(status.steps[0].agent) : "subagent",
        requestSummary: status.pause?.summary
          ? safeTerminalText(status.pause.summary)
          : status.pause?.summary,
        claimUnavailable:
          typeof lifecycleContinuationForIndex(status, requestedIndex ?? 0)?.claimToken ===
            "string" &&
          lifecycleContinuationForIndex(status, requestedIndex ?? 0)!.claimToken!.length > 0,
        index: requestedIndex,
      }).split("\n"),
    );
  } else if (pausedAwaitingSupervisor) {
    lines.push("Paused lifecycle actions are listed per child above.");
  } else if (status.state === "continued") {
    lines.push(
      `Continuation: ${safeTerminalText(lifecycleContinuationForIndex(status, requestedIndex ?? 0)?.continuationRunId ?? status.lifecycle?.continuation?.continuationRunId ?? "unknown")}`,
    );
    lines.push(
      "Resume: unavailable; this paused supervisor run already launched its continuation.",
    );
  } else if (status.state !== "running" && status.state !== "pausing") {
    lines.push(
      formatResumeGuidance(
        status.runId,
        status.steps ?? [],
        status.sessionFile,
        isRoleBudgetExhausted(status),
      ),
    );
  }
  if (!privacySafeAwaitingSupervisorLifecycle && fs.existsSync(logPath))
    lines.push(`Log: ${safeTerminalText(logPath)}`);
  if (!privacySafeAwaitingSupervisorLifecycle && fs.existsSync(eventsPath))
    lines.push(`Events: ${safeTerminalText(eventsPath)}`);

  return safeTerminalDocument(lines.join("\n"));
}

function inspectAsyncResultFile(
  resultPath: string,
  resolvedId: string | undefined,
): SubagentToolResult<Details> {
  try {
    const raw = fs.readFileSync(resultPath, "utf-8");
    const data = JSON.parse(raw) as AsyncResultStatusData;
    const status = data.success
      ? "complete"
      : data.state === "cancelled" || data.state === "continued" || data.state === "pausing"
        ? data.state
        : data.state === "paused" || data.exitCode === 0
          ? "paused"
          : "failed";
    const runId = data.runId ?? data.id ?? resolvedId;
    const privacySafeResult = isProtectedPausedLifecycle({
      state: data.state,
      pause: data.pause,
    });
    const lines = [
      `Run: ${safeTerminalText(runId ?? "unknown")}`,
      `State: ${safeTerminalText(status)}`,
      ...(privacySafeResult ? [] : [`Result: ${safeTerminalText(resultPath)}`]),
    ];
    const children = Array.isArray(data.results)
      ? data.results
      : data.agent
        ? [
            {
              agent: data.agent,
              sessionFile: data.sessionFile,
              timedOut: data.timedOut,
              timeoutOwner: data.timeoutOwner,
              terminationReason: data.terminationReason,
            },
          ]
        : [];
    lines.push(
      formatResumeGuidance(runId, children, data.sessionFile, isRoleBudgetExhausted(data)),
    );
    if (data.summary)
      lines.push(
        "",
        privacySafeResult ? "Paused awaiting supervisor." : safeTerminalDocumentLeaf(data.summary),
      );
    return {
      content: [{ type: "text", text: safeTerminalDocument(lines.join("\n")) }],
      details: { mode: "single", results: [] },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Failed to read async result file: ${message}` }],
      isError: true,
      details: { mode: "single", results: [] },
    };
  }
}

export function inspectSubagentStatus(
  params: RunStatusParams,
  deps: RunStatusDeps = {},
): SubagentToolResult<Details> {
  const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
  const resultsDir = deps.resultsDir ?? RESULTS_DIR;
  const currentSessionId = deps.state?.currentSessionId ?? undefined;
  if (!params.id && !params.dir) {
    try {
      const runs = listAsyncRuns(asyncDirRoot, {
        states: ["queued", "running"],
        sessionId: currentSessionId,
        resultsDir,
        kill: deps.kill,
        now: deps.now,
      });
      return {
        content: [{ type: "text", text: formatAsyncRunList(runs) }],
        details: { mode: "single", results: [] },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: message }],
        isError: true,
        details: { mode: "single", results: [] },
      };
    }
  }

  let location: {
    asyncDir: string | null;
    resultPath: string | null;
    resolvedId?: string;
  };
  try {
    const requestedId = params.id;
    if (!params.dir && requestedId) {
      const resolved = resolveSubagentRunId(requestedId, {
        asyncDirRoot,
        resultsDir,
        state: deps.state,
      });
      if (resolved?.kind === "foreground") {
        const run = deps.state?.foregroundRuns?.get(resolved.id);
        if (run) {
          return {
            content: [{ type: "text", text: formatRememberedForegroundStatus(run) }],
            details: { mode: "single", results: [] },
          };
        }
      }
      if (resolved?.kind === "async") location = resolved.location;
      else location = { asyncDir: null, resultPath: null, resolvedId: requestedId };
    } else {
      location = resolveAsyncRunLocation(params, asyncDirRoot, resultsDir);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: message }],
      isError: true,
      details: { mode: "single", results: [] },
    };
  }
  const { asyncDir, resultPath, resolvedId } = location;

  if (!asyncDir && !resultPath) {
    return {
      content: [{ type: "text", text: "Async run not found. Provide id or dir." }],
      isError: true,
      details: { mode: "single", results: [] },
    };
  }

  if (asyncDir) {
    let reconciliation;
    try {
      reconciliation = reconcileAsyncRun(asyncDir, { resultsDir, kill: deps.kill, now: deps.now });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: message }],
        isError: true,
        details: { mode: "single", results: [] },
      };
    }
    const status = reconciliation.status;
    const effectiveRunId = status?.runId ?? resolvedId ?? "unknown";
    const logPath = path.join(asyncDir, `subagent-log-${effectiveRunId}.md`);
    const eventsPath = path.join(asyncDir, "events.jsonl");
    if (status) {
      const outputPath = formatAsyncRunOutputPath({ asyncDir, outputFile: status.outputFile });
      return {
        content: [
          {
            type: "text",
            text: formatDetailedAsyncStatus(
              status,
              asyncDir,
              outputPath,
              reconciliation,
              params.index,
              logPath,
              eventsPath,
            ),
          },
        ],
        details: { mode: "single", results: [] },
      };
    }
  }

  if (resultPath) return inspectAsyncResultFile(resultPath, resolvedId);

  return {
    content: [{ type: "text", text: "Status file not found." }],
    isError: true,
    details: { mode: "single", results: [] },
  };
}

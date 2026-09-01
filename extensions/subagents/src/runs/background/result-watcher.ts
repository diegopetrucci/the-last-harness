import * as fs from "node:fs";
import * as path from "node:path";
import { buildCompletionKey, markSeenWithTtl } from "./completion-dedupe.ts";
import { createFileCoalescer } from "../../shared/file-coalescer.ts";
import {
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  type SubagentEventBus,
  type AsyncStatus,
  type NestedRunSummary,
  type SubagentResultChild,
  type SubagentState,
} from "../../shared/types.ts";
import {
  attachNestedChildrenToResultChildren,
  compactNestedResultChildren,
  resolveSubagentResultStatus,
} from "../../shared/result-formatting.ts";
import {
  lifecycleContinuationForIndex,
  withLifecycleStatusLock,
} from "../shared/lifecycle-state.ts";
import { projectNestedRegistryForRoot, sanitizeSummary } from "../shared/nested-events.ts";
import { readStatus } from "../../shared/utils.ts";
import {
  PROJECT_AGENT_TERMINAL_RETENTION_MS,
  lookupProjectAgentRunReference,
  releaseProjectAgentRunReference,
} from "../../agents/project-agent-snapshot.ts";

const WATCHER_RESTART_DELAY_MS = 3000;
const POLL_INTERVAL_MS = 3000;

type ResultWatcherFs = Pick<
  typeof fs,
  | "existsSync"
  | "readFileSync"
  | "unlinkSync"
  | "readdirSync"
  | "mkdirSync"
  | "realpathSync"
  | "watch"
>;

type ResultWatcherTimers = {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
};

type ResultWatcherDeps = {
  fs?: ResultWatcherFs;
  timers?: ResultWatcherTimers;
  /** Test seam; production uses the shared project terminal retention window. */
  projectAgentTerminalRetentionMs?: number;
};

type ResultFileChild = {
  agent?: string;
  output?: string;
  error?: string;
  success?: boolean;
  exitCode?: number;
  interrupted?: boolean;
  sessionFile?: string;
  artifactPaths?: { outputPath?: string };
  children?: unknown;
};

type ResultFileData = {
  id?: string;
  runId?: string;
  agent?: string;
  success?: boolean;
  state?: string;
  mode?: string;
  summary?: string;
  results?: ResultFileChild[];
  nestedChildren?: unknown;
  sessionId?: string;
  cwd?: string;
  sessionFile?: string;
  asyncDir?: string;
  lifecycleArtifactVersion?: number;
};

function sanitizeNestedResultChildren(
  value: unknown,
  resultPath: string,
  label: string,
): NestedRunSummary[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    console.error(
      `Ignoring invalid nested children in subagent result file '${resultPath}' at ${label}: expected an array.`,
    );
    return undefined;
  }
  const children = value
    .map((child) => sanitizeSummary(child))
    .filter((child): child is NestedRunSummary => Boolean(child));
  if (children.length !== value.length) {
    console.error(
      `Ignoring ${value.length - children.length} invalid nested child record(s) in subagent result file '${resultPath}' at ${label}.`,
    );
  }
  return children.length ? children : undefined;
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function isNotFoundError(error: unknown): boolean {
  return getErrorCode(error) === "ENOENT";
}

function shouldFallBackToPolling(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === "EMFILE" || code === "ENOSPC";
}

function resolveNativeWatchDir(fsApi: ResultWatcherFs, resultsDir: string): string {
  try {
    return fsApi.realpathSync.native(resultsDir);
  } catch {
    return resultsDir;
  }
}

function resolveResultFileChildStatus(
  result: ResultFileChild,
  parentState: string | undefined,
): ReturnType<typeof resolveSubagentResultStatus> {
  const hasChildStatusMetadata =
    typeof result.success === "boolean" || typeof result.exitCode === "number";
  const interrupted =
    result.interrupted === true ||
    (result.interrupted === undefined &&
      parentState === "paused" &&
      result.success === false &&
      result.exitCode === 0);
  return resolveSubagentResultStatus({
    interrupted,
    success: result.success,
    exitCode: result.exitCode,
    state: !hasChildStatusMetadata && parentState !== "paused" ? parentState : undefined,
  });
}

type PausedArtifactDecision = "notify" | "discard" | "retry" | "compat";

function resolvePausedArtifactTargetIndex(data: ResultFileData): number | undefined {
  const children = Array.isArray(data.results) ? data.results : [];
  if (children.length <= 1) return 0;
  const pausedChild = children.find(
    (child) =>
      resolveResultFileChildStatus(child, data.state) === "paused" &&
      typeof child.sessionFile === "string" &&
      child.sessionFile.length > 0,
  );
  return pausedChild ? children.indexOf(pausedChild) : undefined;
}

function hasUsableProjectSessionFile(sessionFile: unknown, fsApi: ResultWatcherFs): boolean {
  if (typeof sessionFile !== "string" || sessionFile.trim().length === 0) return false;
  const resolved = path.resolve(sessionFile);
  return path.extname(resolved) === ".jsonl" && fsApi.existsSync(resolved);
}

function hasResumableProjectSibling(
  data: ResultFileData,
  fsApi: ResultWatcherFs,
  includeTerminalProjectSibling = true,
): boolean {
  if (typeof data.asyncDir !== "string" || data.asyncDir.length === 0) {
    // Without a status file we cannot prove that a multi-child artifact has no
    // resumable sibling. Keep the private generation rather than releasing it
    // on mutable/incomplete result metadata.
    return true;
  }
  let status: AsyncStatus | null;
  try {
    status = readStatus(data.asyncDir);
  } catch {
    return true;
  }
  if (!status || !status.steps || status.steps.length === 0) return true;
  return status.steps.some((step) => {
    const stepStatus = step.status as string;
    if (
      stepStatus === "paused" ||
      stepStatus === "pausing" ||
      stepStatus === "pending" ||
      stepStatus === "running" ||
      stepStatus === "queued"
    ) {
      return true;
    }
    if (stepStatus === "complete" || stepStatus === "completed" || stepStatus === "failed") {
      return (
        includeTerminalProjectSibling &&
        step.projectAgent !== undefined &&
        hasUsableProjectSessionFile(step.sessionFile, fsApi)
      );
    }
    if (stepStatus === "continued" || stepStatus === "cancelled") return false;
    return true;
  });
}

function resolvePausedArtifactDecision(data: ResultFileData): PausedArtifactDecision {
  if (data.state !== "paused") return "compat";
  if (
    typeof data.asyncDir !== "string" ||
    data.asyncDir.length === 0 ||
    data.lifecycleArtifactVersion !== 1
  )
    return "compat";
  try {
    return withLifecycleStatusLock(
      data.asyncDir,
      (status) => {
        if (!status || status.state === "pausing") return "retry";
        if (status.state === "continued" || status.state === "cancelled") return "discard";
        if (status.state !== "paused") return "retry";
        const targetIndex = resolvePausedArtifactTargetIndex(data);
        if (targetIndex === undefined) return "retry";
        const targetStep = status.steps?.[targetIndex];
        if (targetStep?.status === "continued" || targetStep?.status === "cancelled")
          return "discard";
        if (targetStep?.status === "pausing") return "retry";
        const continuation = lifecycleContinuationForIndex(status, targetIndex);
        if (continuation?.phase === "continued") return "discard";
        if (
          continuation?.phase === "claimed" ||
          continuation?.phase === "reserved" ||
          continuation?.phase === "launched"
        )
          return "retry";
        if (!targetStep || targetStep.status === "paused") return "notify";
        return "retry";
      },
      { retryDelaysMs: [] },
    );
  } catch {
    return "retry";
  }
}

export function createResultWatcher(
  pi: { events: SubagentEventBus },
  state: SubagentState,
  resultsDir: string,
  completionTtlMs: number,
  deps: ResultWatcherDeps = {},
): {
  startResultWatcher: () => void;
  primeExistingResults: () => void;
  stopResultWatcher: () => void;
} {
  const fsApi = deps.fs ?? fs;
  const timers = deps.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
  const projectAgentTerminalRetentionMs =
    deps.projectAgentTerminalRetentionMs ?? PROJECT_AGENT_TERMINAL_RETENTION_MS;
  const projectReferenceReleaseTimers = new Map<
    string,
    ReturnType<ResultWatcherTimers["setTimeout"]>
  >();
  const cancelProjectReferenceRelease = (runId: string): void => {
    const timer = projectReferenceReleaseTimers.get(runId);
    if (!timer) return;
    timers.clearTimeout(timer);
    projectReferenceReleaseTimers.delete(runId);
  };
  const scheduleProjectReferenceRelease = (data: ResultFileData, runId: string): void => {
    const lookup = lookupProjectAgentRunReference(runId);
    if (lookup.status !== "found" || lookup.runId !== runId) return;
    cancelProjectReferenceRelease(runId);
    const timer = timers.setTimeout(() => {
      projectReferenceReleaseTimers.delete(runId);
      // A missing directory is an uninspectable cohort, not proof that all
      // siblings are terminal. Never release a project reference unguarded.
      if (!data.asyncDir) return;
      // Terminal project siblings are retained only through this timer. Active,
      // paused, and unknown siblings remain protected and are checked again.
      if (hasResumableProjectSibling(data, fsApi, false)) {
        scheduleProjectReferenceRelease(data, runId);
        return;
      }
      releaseProjectAgentRunReference(runId);
    }, projectAgentTerminalRetentionMs);
    timer.unref?.();
    projectReferenceReleaseTimers.set(runId, timer);
  };
  const retainOrReleaseProjectReference = (data: ResultFileData, runId: string): void => {
    const lookup = lookupProjectAgentRunReference(runId);
    if (lookup.status !== "found" || lookup.runId !== runId) return;
    if (hasResumableProjectSibling(data, fsApi)) {
      scheduleProjectReferenceRelease(data, runId);
      return;
    }
    releaseProjectAgentRunReference(runId);
  };

  const handleResult = (file: string) => {
    const resultPath = path.join(resultsDir, file);
    if (!fsApi.existsSync(resultPath)) return;
    try {
      const data = JSON.parse(fsApi.readFileSync(resultPath, "utf-8")) as ResultFileData;
      // Session-exact delivery (upstream v0.34.0 cutover). This also preserves the
      // issue #45 defense in depth: foreign/fixture files without a sessionId are
      // skipped without unlinking, so we never emit a ghost 'Background task
      // completed' notification for them.
      if (typeof data.sessionId !== "string" || data.sessionId !== state.currentSessionId) return;

      const runId = data.runId ?? data.id ?? file.replace(/\.json$/i, "");
      const hasExplicitNestedChildren = data.nestedChildren !== undefined;
      let nestedChildren = compactNestedResultChildren(
        sanitizeNestedResultChildren(data.nestedChildren, resultPath, "nestedChildren"),
      );
      if (!nestedChildren?.length && !hasExplicitNestedChildren) {
        try {
          nestedChildren = compactNestedResultChildren(
            projectNestedRegistryForRoot(runId)?.children,
          );
        } catch (error) {
          console.error(
            `Failed to enrich subagent result file '${resultPath}' with nested registry children; will retry later:`,
            error,
          );
          return;
        }
      }
      const now = Date.now();
      const pausedDecision = resolvePausedArtifactDecision(data);
      if (pausedDecision === "retry") return;
      if (pausedDecision === "discard") {
        retainOrReleaseProjectReference(data, runId);
        fsApi.unlinkSync(resultPath);
        return;
      }

      const hasResultChildren = Array.isArray(data.results) && data.results.length > 0;
      const resultChildren = hasResultChildren
        ? data.results!
        : [
            {
              agent: data.agent,
              output: data.summary,
              success: data.success,
            },
          ];
      const normalizedChildren = attachNestedChildrenToResultChildren(
        runId,
        resultChildren.map((result = {}, arrayIndex): SubagentResultChild => {
          const baseOutput = result.output ?? data.summary;
          const hasRealOutput = typeof baseOutput === "string" && baseOutput.trim().length > 0;
          const output = hasRealOutput ? baseOutput : "(no output)";
          const summary =
            result.success === false && result.error
              ? `${result.error}${hasRealOutput ? `\n\nOutput:\n${baseOutput}` : ""}`
              : output;
          const sessionPath =
            result.sessionFile ?? (resultChildren.length === 1 ? data.sessionFile : undefined);
          const childNestedChildren = sanitizeNestedResultChildren(
            result.children,
            resultPath,
            `results[${arrayIndex}].children`,
          );
          return {
            agent: result.agent ?? data.agent ?? `step-${arrayIndex + 1}`,
            status: resolveResultFileChildStatus(result, data.state),
            summary,
            index: arrayIndex,
            artifactPath: result.artifactPaths?.outputPath,
            ...(typeof sessionPath === "string" && fsApi.existsSync(sessionPath)
              ? { sessionPath }
              : {}),
            ...(childNestedChildren ? { children: childNestedChildren } : {}),
          };
        }),
        nestedChildren,
      );

      const completionKey = buildCompletionKey(data, `result:${file}`);
      if (markSeenWithTtl(state.completionSeen, completionKey, now, completionTtlMs)) {
        if (data.state === "cancelled" || data.state === "continued") {
          retainOrReleaseProjectReference(data, runId);
        }
        fsApi.unlinkSync(resultPath);
        return;
      }
      pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
        ...data,
        runId,
        ...(nestedChildren?.length ? { nestedChildren } : {}),
        ...(Array.isArray(data.results)
          ? {
              results: hasResultChildren
                ? normalizedChildren.map((child, index) => ({
                    ...data.results![index],
                    agent: child.agent,
                    status: child.status,
                    summary: child.summary,
                    index: child.index,
                    artifactPath: child.artifactPath,
                    sessionPath: child.sessionPath,
                    children: child.children,
                  }))
                : [],
            }
          : {}),
      });
      // Complete/failed project results remain resumable through the terminal
      // retention window. Cancelled/continued sources release immediately only
      // when every sibling is terminal and non-resumable; a terminal project
      // sibling with a usable session gets the same bounded window.
      if (data.state === "cancelled" || data.state === "continued") {
        retainOrReleaseProjectReference(data, runId);
      } else if (data.state === "complete" || data.state === "failed") {
        scheduleProjectReferenceRelease(data, runId);
      }
      fsApi.unlinkSync(resultPath);
    } catch (error) {
      if (isNotFoundError(error)) return;
      console.error(`Failed to process subagent result file '${resultPath}':`, error);
    }
  };

  state.resultFileCoalescer = createFileCoalescer((file) => {
    void handleResult(file);
  }, 50);

  const primeExistingResults = () => {
    try {
      fsApi
        .readdirSync(resultsDir)
        .filter((f) => f.endsWith(".json"))
        .forEach((file) => state.resultFileCoalescer.schedule(file, 0));
    } catch (error) {
      if (isNotFoundError(error)) return;
      console.error(`Failed to scan subagent result directory '${resultsDir}':`, error);
    }
  };

  const startPollingFallback = (reason: unknown) => {
    state.watcher?.close();
    state.watcher = null;
    if (state.watcherRestartTimer) return;

    console.error(
      `Subagent result watcher for '${resultsDir}' fell back to polling because native fs.watch is unavailable (${getErrorCode(reason) ?? "unknown error"}).`,
    );
    primeExistingResults();
    state.watcherRestartTimer = timers.setInterval(primeExistingResults, POLL_INTERVAL_MS);
    state.watcherRestartTimer.unref?.();
  };

  const scheduleRestart = () => {
    if (state.watcherRestartTimer) return;
    state.watcherRestartTimer = timers.setTimeout(() => {
      state.watcherRestartTimer = null;
      try {
        fsApi.mkdirSync(resultsDir, { recursive: true });
        startResultWatcher();
      } catch (error) {
        if (shouldFallBackToPolling(error)) {
          startPollingFallback(error);
          return;
        }
        console.error(`Failed to restart subagent result watcher for '${resultsDir}':`, error);
        scheduleRestart();
      }
    }, WATCHER_RESTART_DELAY_MS);
    state.watcherRestartTimer.unref?.();
  };

  const startResultWatcher = () => {
    if (state.watcher) return;
    if (state.watcherRestartTimer) {
      timers.clearTimeout(state.watcherRestartTimer);
      timers.clearInterval(state.watcherRestartTimer);
      state.watcherRestartTimer = null;
    }
    try {
      const watchDir = resolveNativeWatchDir(fsApi, resultsDir);
      state.watcher = fsApi.watch(watchDir, (ev, file) => {
        if (ev !== "rename" || !file) return;
        const fileName = file.toString();
        if (!fileName.endsWith(".json")) return;
        state.resultFileCoalescer.schedule(fileName);
      });
      state.watcher.on("error", (error) => {
        if (shouldFallBackToPolling(error)) {
          startPollingFallback(error);
          return;
        }
        console.error(`Subagent result watcher failed for '${resultsDir}':`, error);
        state.watcher?.close();
        state.watcher = null;
        scheduleRestart();
      });
      state.watcher.unref?.();
    } catch (error) {
      if (shouldFallBackToPolling(error)) {
        startPollingFallback(error);
        return;
      }
      console.error(`Failed to start subagent result watcher for '${resultsDir}':`, error);
      state.watcher = null;
      scheduleRestart();
    }
  };

  const stopResultWatcher = () => {
    state.watcher?.close();
    state.watcher = null;
    if (state.watcherRestartTimer) {
      timers.clearTimeout(state.watcherRestartTimer);
      timers.clearInterval(state.watcherRestartTimer);
    }
    state.watcherRestartTimer = null;
    state.resultFileCoalescer.clear();
    // Keep project-reference timers alive across extension reloads. The
    // process-private registry intentionally survives reload, and clearing a
    // fallback result timer here would retain that reference indefinitely.
  };

  return { startResultWatcher, primeExistingResults, stopResultWatcher };
}

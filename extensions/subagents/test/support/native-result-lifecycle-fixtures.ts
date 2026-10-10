/**
 * Stateless helpers shared by the native-result-lifecycle integration suites.
 *
 * This module intentionally does not register tests or create mutable test
 * fixtures. Each suite owns its mock process, temporary directory, and hooks.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ASYNC_DIR, RESULTS_DIR, type ArtifactPaths } from "../../src/shared/types.ts";
import type { executeAsyncSingle } from "../../src/runs/background/async-execution.ts";
import type { runSync } from "../../src/runs/foreground/execution.ts";
import type { MockPi } from "./helpers.ts";
import { makeAgent, makeMinimalCtx, tryImport } from "./helpers.ts";
import { type ScaledMs, scaleTestTimeout } from "./scale-timeout.ts";
import {
  startedMockPiPids,
  waitForAsyncState as waitForAsyncDirState,
  waitForAsyncStatusPredicate as waitForAsyncDirStatusPredicate,
  waitForMarker,
  waitForMockPiArgs,
  waitForMockPiCall as waitForRecordedMockPiCall,
} from "./async-execution-helpers.ts";

export { startedMockPiPids };

export interface ExecutorResult {
  content: Array<{ text?: string }>;
  isError?: boolean;
  details?: {
    mode?: string;
    runId?: string;
    results?: Array<{
      agent?: string;
      finalOutput?: string;
      outputMode?: string;
      savedOutputPath?: string;
      outputSaveError?: string;
      truncation?: { truncated?: boolean; text?: string };
      attemptedModels?: string[];
      modelFallbackNotice?: string;
      sessionFile?: string;
      artifactPaths?: ArtifactPaths;
    }>;
    asyncId?: string;
  };
}

export interface NativeExecutor {
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: ((result: unknown) => void) | undefined,
    ctx: unknown,
  ): Promise<ExecutorResult>;
}

interface ExecutorModule {
  createSubagentExecutor?: (...args: unknown[]) => NativeExecutor;
}

export interface NativeExecutorOptions {
  agents?: ReturnType<typeof makeAgent>[];
  config?: Record<string, unknown>;
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
  runSync?: typeof runSync;
  executeAsyncSingle?: typeof executeAsyncSingle;
}

export interface NativeExecutorState {
  baseCwd: string;
  currentSessionId: null;
  asyncJobs: Map<unknown, unknown>;
  foregroundRuns: Map<string, unknown>;
  foregroundControls: Map<string, unknown>;
  lastForegroundControlId: string | null;
  cleanupTimers: Map<unknown, unknown>;
  lastUiContext: null;
  poller: null;
  completionSeen: Map<unknown, unknown>;
  watcher: null;
  watcherRestartTimer: null;
  resultFileCoalescer: { schedule: () => boolean; clear: () => void };
}

const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
export const available = !!executorMod?.createSubagentExecutor;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

export function normalizePathForComparison(targetPath: string): string {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

export function createRecordingEventBus() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const emitted: Array<{ channel: string; payload: unknown }> = [];
  const bus = {
    emitted,
    on(channel: string, handler: (payload: unknown) => void) {
      const channelListeners = listeners.get(channel) ?? new Set();
      channelListeners.add(handler);
      listeners.set(channel, channelListeners);
      return () => {
        channelListeners.delete(handler);
        if (channelListeners.size === 0) listeners.delete(channel);
      };
    },
    emit(channel: string, payload: unknown) {
      emitted.push({ channel, payload });
      for (const handler of listeners.get(channel) ?? []) {
        handler(payload);
      }
    },
  };
  return bus;
}

export function readMockCallArgs(mockPi: MockPi, index: number): Promise<string[]> {
  return waitForMockPiArgs(mockPi, index, scaleTestTimeout(10_000));
}

export function waitForFile(
  filePath: string,
  timeoutMs: ScaledMs = scaleTestTimeout(10_000),
): Promise<void> {
  return waitForMarker(filePath, timeoutMs);
}

export function waitForAsyncState(
  runId: string,
  expected: string,
  timeoutMs: ScaledMs = scaleTestTimeout(10_000),
): Promise<void> {
  return waitForAsyncDirState(path.join(ASYNC_DIR, runId), expected, timeoutMs);
}

export interface AsyncStatusProbe {
  state?: string;
  currentStep?: number;
  sessionFile?: string;
  steps?: Array<{ status?: string; sessionFile?: string; acceptance?: { status?: string } }>;
}

export async function waitForAsyncStatusPredicate(
  runId: string,
  predicate: (status: AsyncStatusProbe) => boolean,
  label: string,
  timeoutMs: ScaledMs = scaleTestTimeout(10_000),
): Promise<void> {
  await waitForAsyncDirStatusPredicate(
    path.join(ASYNC_DIR, runId),
    (status) => predicate(status),
    label,
    timeoutMs,
  );
}

export function readAsyncStatusJson<T>(runId: string): T {
  return JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, runId, "status.json"), "utf-8")) as T;
}

export async function waitForMockPiCall(
  mockPi: MockPi,
  index: number,
  timeoutMs: ScaledMs = scaleTestTimeout(10_000),
): Promise<void> {
  await waitForRecordedMockPiCall(mockPi, index, timeoutMs);
}

export async function waitForRevivedAsyncResult(
  result: ExecutorResult,
  timeoutMs = scaleTestTimeout(10_000),
): Promise<string> {
  const revivedId = result.details?.asyncId;
  assert.ok(revivedId, "expected revived async id");
  const resultPath = path.join(RESULTS_DIR, `${revivedId}.json`);
  await waitForFile(resultPath, timeoutMs);
  return revivedId;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}

export function makeNativeResultLifecycleExecutor(
  tempDir: string,
  options: NativeExecutorOptions = {},
): {
  executor: NativeExecutor;
  events: ReturnType<typeof createRecordingEventBus>;
  state: NativeExecutorState;
} {
  const events = createRecordingEventBus();
  const state: NativeExecutorState = {
    baseCwd: tempDir,
    currentSessionId: null,
    asyncJobs: new Map(),
    foregroundRuns: new Map(),
    foregroundControls: new Map(),
    lastForegroundControlId: null as string | null,
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: {
      schedule: () => false,
      clear: () => {},
    },
  };
  const executor = createSubagentExecutor!({
    pi: {
      events,
      getSessionName: () => "orchestrator",
      setSessionName: () => {},
    },
    state,
    config: options.config ?? {},
    tempArtifactsDir: tempDir,
    getSubagentSessionRoot: () => tempDir,
    expandTilde: (value: string) => value,
    discoverAgents: () => ({ agents: options.agents ?? [makeAgent("worker")] }),
    kill: options.kill,
    runSync: options.runSync,
    executeAsyncSingle: options.executeAsyncSingle,
  });
  return { executor, events, state };
}

export async function expectUnsupportedChainRequest(
  executor: NativeExecutor,
  requestId: string,
  request: Record<string, unknown>,
  tempDir: string,
  mockPi: MockPi,
): Promise<ExecutorResult> {
  const beforeCalls = mockPi.callCount();
  const result = await executor.execute(
    requestId,
    request,
    new AbortController().signal,
    undefined,
    makeMinimalCtx(tempDir),
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /Saved chains are deliberately unsupported/);
  assert.match(result.content[0]?.text ?? "", /Omit 'chain'/);
  assert.equal(mockPi.callCount(), beforeCalls);
  return result;
}

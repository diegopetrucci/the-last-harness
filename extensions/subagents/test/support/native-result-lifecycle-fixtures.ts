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
import type { MockPi } from "./helpers.ts";
import { makeAgent, makeMinimalCtx, tryImport } from "./helpers.ts";
import { scaleTestTimeout } from "./scale-timeout.ts";

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
      truncation?: { truncated?: boolean };
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

export async function readMockCallArgs(mockPi: MockPi, index: number): Promise<string[]> {
  const deadline = Date.now() + 10_000;
  let callFile: string | undefined;
  while (!callFile) {
    callFile = fs
      .readdirSync(mockPi.dir)
      .filter((name) => name.startsWith("call-") && name.endsWith(".json"))
      .sort()[index];
    if (callFile || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(callFile, `expected mock pi call at index ${index}`);
  return JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
}

export async function waitForFile(
  filePath: string,
  timeoutMs = scaleTestTimeout(10_000),
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for file: ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function waitForAsyncState(
  runId: string,
  expected: string,
  timeoutMs = scaleTestTimeout(10_000),
): Promise<void> {
  const statusPath = path.join(ASYNC_DIR, runId, "status.json");
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (fs.existsSync(statusPath)) {
      const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as { state?: string };
      if (status.state === expected) return;
    }
    if (Date.now() > deadline)
      assert.fail(`Timed out waiting for async state '${expected}' for ${runId}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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
  timeoutMs = scaleTestTimeout(10_000),
): Promise<void> {
  const statusPath = path.join(ASYNC_DIR, runId, "status.json");
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (fs.existsSync(statusPath)) {
      const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusProbe;
      if (predicate(status)) return;
    }
    if (Date.now() > deadline)
      assert.fail(`Timed out waiting for async status predicate '${label}' for ${runId}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function readAsyncStatusJson<T>(runId: string): T {
  return JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, runId, "status.json"), "utf-8")) as T;
}

export async function waitForMockPiCall(
  mockPi: MockPi,
  index: number,
  timeoutMs = scaleTestTimeout(10_000),
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const callFile = fs
      .readdirSync(mockPi.dir)
      .filter((name) => name.startsWith("call-") && name.endsWith(".json"))
      .sort()
      .at(index);
    if (callFile) return;
    if (Date.now() > deadline) assert.fail(`Timed out waiting for recorded mock pi call ${index}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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

export function startedMockPiPids(mockPi: MockPi): number[] {
  return fs
    .readdirSync(mockPi.dir)
    .filter((name) => name.startsWith("call-") && name.endsWith(".json"))
    .map((name) => Number(name.split("-")[2]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
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

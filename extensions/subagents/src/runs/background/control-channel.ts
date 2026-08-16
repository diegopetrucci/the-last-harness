/**
 * Cross-OS control channel for async subagent runs.
 *
 * Background runs are detached OS processes. The original control path delivered
 * an interrupt with `process.kill(pid, SIGUSR2|SIGBREAK)`, but Windows cannot
 * deliver those signals cross-process via `process.kill` and throws `ENOSYS`,
 * which left async runs uninterruptible (no stop, no live steer) on Windows.
 *
 * This module adds a portable, file-based control inbox inside the run directory.
 * The parent drops an interrupt request file; the runner watches the inbox and
 * routes the request into its existing graceful `interruptRunner()` (pause +
 * resumable), identically on every platform. The OS signal is kept only as an
 * opportunistic fast-path; its failure is non-fatal because the file inbox is
 * authoritative.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { POLL_INTERVAL_MS } from "../../shared/types.ts";

/**
 * Opportunistic fast-path interrupt signal. On Unix `SIGUSR2` is trapped by the
 * runner; on Windows `process.kill(pid, "SIGBREAK")` is not deliverable
 * cross-process and throws `ENOSYS`, so the file inbox below is the real channel.
 */
export const INTERRUPT_SIGNAL: NodeJS.Signals =
  process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";

export type ControlChannelFs = Pick<
  typeof fs,
  "mkdirSync" | "existsSync" | "rmSync" | "watch" | "readdirSync" | "readFileSync"
>;
export type ControlChannelTimers = {
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
};
type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => unknown;

export interface InterruptRequest {
  type: "interrupt";
  ts?: number;
  source?: string;
  reason?: string;
}

export interface TimeoutRequest {
  type: "timeout";
  ts?: number;
  source?: string;
  reason?: string;
}

interface ChildMessageRequestBase {
  id: string;
  ts: number;
  message: string;
  targetIndex?: number;
  deliveryDeadlineAt?: number;
  source?: string;
}

export interface SteerRequest extends ChildMessageRequestBase {
  type: "steer";
}
export interface ResumeRequest extends ChildMessageRequestBase {
  type: "resume";
}
export type ChildMessageRequest = SteerRequest | ResumeRequest;

const STEER_REQUESTS_DIR = "steer-requests";
const STEER_TARGETS_DIR = "steer-targets";
const CHILD_MESSAGE_ACKS_DIR = "message-acks";

export interface ChildMessageAcceptance {
  requestId: string;
  type: ChildMessageRequest["type"];
  status: "accepted" | "rejected";
  ts: number;
  acceptedIndexes: number[];
  rejected?: Array<{ index: number; reason: string }>;
  reason?: string;
}

export type ChildMessageAcceptanceWaitResult =
  | { outcome: "acknowledged"; acceptance: ChildMessageAcceptance }
  | { outcome: "timeout" }
  | { outcome: "runner_gone" };

/** Control inbox directory inside an async run dir. */
export function controlInboxDir(asyncDir: string): string {
  return path.join(asyncDir, "control");
}

/** Path of the portable interrupt request file. */
export function interruptRequestPath(asyncDir: string): string {
  return path.join(controlInboxDir(asyncDir), "interrupt.json");
}

/** Path of the portable timeout request file. */
export function timeoutRequestPath(asyncDir: string): string {
  return path.join(controlInboxDir(asyncDir), "timeout.json");
}

/** Directory of parent-to-runner steering requests. */
export function steerRequestsDir(asyncDir: string): string {
  return path.join(controlInboxDir(asyncDir), STEER_REQUESTS_DIR);
}

/** Atomic runner acceptance acknowledgements consumed by request originators. */
export function childMessageAcksDir(asyncDir: string): string {
  return path.join(controlInboxDir(asyncDir), CHILD_MESSAGE_ACKS_DIR);
}

export function childMessageAckPath(asyncDir: string, requestId: string): string {
  return path.join(
    childMessageAcksDir(asyncDir),
    `${Buffer.from(requestId).toString("base64url")}.json`,
  );
}

/** Per-child inbox consumed by the child prompt runtime inside the Pi process. */
export function stepSteerInboxDir(asyncDir: string, index: number): string {
  return path.join(controlInboxDir(asyncDir), STEER_TARGETS_DIR, String(index));
}

function childMessageRequestFileName(request: ChildMessageRequest): string {
  return `${String(request.ts).padStart(13, "0")}-${Buffer.from(request.id).toString("base64url")}.json`;
}

export function writeChildMessageRequestToDir(dir: string, request: ChildMessageRequest): string {
  const requestPath = path.join(dir, childMessageRequestFileName(request));
  writeAtomicJson(requestPath, request);
  return requestPath;
}

export function writeSteerRequestToDir(dir: string, request: SteerRequest): string {
  return writeChildMessageRequestToDir(dir, request);
}

/**
 * Parent side: drop a portable interrupt request the runner's inbox watcher will
 * pick up regardless of OS. Written atomically (temp + rename), dir auto-created.
 */
export function requestAsyncInterrupt(
  asyncDir: string,
  payload: Omit<InterruptRequest, "type"> = {},
  deps: { now?: () => number } = {},
): string {
  const requestPath = interruptRequestPath(asyncDir);
  const request: InterruptRequest = {
    ...payload,
    ts: payload.ts ?? deps.now?.() ?? Date.now(),
    type: "interrupt",
  };
  writeAtomicJson(requestPath, request);
  return requestPath;
}

export function requestAsyncTimeout(
  asyncDir: string,
  payload: Omit<TimeoutRequest, "type"> = {},
  deps: { now?: () => number } = {},
): string {
  const requestPath = timeoutRequestPath(asyncDir);
  const request: TimeoutRequest = {
    ...payload,
    ts: payload.ts ?? deps.now?.() ?? Date.now(),
    type: "timeout",
  };
  writeAtomicJson(requestPath, request);
  return requestPath;
}

function requestAsyncChildMessage(
  asyncDir: string,
  type: ChildMessageRequest["type"],
  payload: {
    message: string;
    targetIndex?: number;
    deliveryDeadlineAt?: number;
    source?: string;
    id?: string;
    ts?: number;
  },
  deps: { now?: () => number; randomId?: () => string } = {},
): string {
  const message = payload.message.trim();
  if (!message) throw new Error(`${type} message must not be empty.`);
  if (
    payload.targetIndex !== undefined &&
    (!Number.isInteger(payload.targetIndex) || payload.targetIndex < 0)
  ) {
    throw new Error(`${type} targetIndex must be a non-negative integer.`);
  }
  if (
    payload.deliveryDeadlineAt !== undefined &&
    (!Number.isFinite(payload.deliveryDeadlineAt) || payload.deliveryDeadlineAt <= 0)
  ) {
    throw new Error(`${type} deliveryDeadlineAt must be a positive finite timestamp.`);
  }
  const request: ChildMessageRequest = {
    type,
    id: payload.id ?? deps.randomId?.() ?? randomUUID(),
    ts: payload.ts ?? deps.now?.() ?? Date.now(),
    message,
    ...(payload.targetIndex !== undefined ? { targetIndex: payload.targetIndex } : {}),
    ...(payload.deliveryDeadlineAt !== undefined
      ? { deliveryDeadlineAt: payload.deliveryDeadlineAt }
      : {}),
    ...(payload.source ? { source: payload.source } : {}),
  };
  return writeChildMessageRequestToDir(steerRequestsDir(asyncDir), request);
}

export function requestAsyncSteer(
  asyncDir: string,
  payload: {
    message: string;
    targetIndex?: number;
    deliveryDeadlineAt?: number;
    source?: string;
    id?: string;
    ts?: number;
  },
  deps: { now?: () => number; randomId?: () => string } = {},
): string {
  return requestAsyncChildMessage(asyncDir, "steer", payload, deps);
}

export function requestAsyncResume(
  asyncDir: string,
  payload: {
    message: string;
    targetIndex?: number;
    deliveryDeadlineAt?: number;
    source?: string;
    id?: string;
    ts?: number;
  },
  deps: { now?: () => number; randomId?: () => string } = {},
): string {
  return requestAsyncChildMessage(asyncDir, "resume", payload, deps);
}

export function enqueueStepChildMessage(
  asyncDir: string,
  index: number,
  request: ChildMessageRequest,
): string {
  if (!Number.isInteger(index) || index < 0)
    throw new Error("child message index must be a non-negative integer.");
  return writeChildMessageRequestToDir(stepSteerInboxDir(asyncDir, index), {
    ...request,
    targetIndex: index,
  });
}

export function enqueueStepSteer(asyncDir: string, index: number, request: SteerRequest): string {
  return enqueueStepChildMessage(asyncDir, index, { ...request, type: "steer" });
}

export function acceptChildMessageRequest(input: {
  request: ChildMessageRequest;
  steps: Array<{ status: string }>;
  enqueue: (index: number, request: ChildMessageRequest) => void;
  now?: () => number;
}): { acceptedIndexes: number[]; rejected: Array<{ index: number; reason: string }> } {
  const runningIndexes = input.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.status === "running")
    .map(({ index }) => index);
  const targets =
    input.request.targetIndex !== undefined ? [input.request.targetIndex] : runningIndexes;
  const acceptedIndexes: number[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  if (
    input.request.deliveryDeadlineAt !== undefined &&
    (input.now?.() ?? Date.now()) >= input.request.deliveryDeadlineAt
  ) {
    return {
      acceptedIndexes,
      rejected: targets.map((index) => ({ index, reason: "delivery deadline expired" })),
    };
  }
  for (const index of targets) {
    const step = input.steps[index];
    if (!step) {
      rejected.push({ index, reason: "child index out of range" });
      continue;
    }
    if (step.status !== "running") {
      rejected.push({ index, reason: `child is ${step.status}` });
      continue;
    }
    try {
      input.enqueue(index, input.request);
    } catch (error) {
      rejected.push({
        index,
        reason: `leaf inbox enqueue failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    acceptedIndexes.push(index);
  }
  return { acceptedIndexes, rejected };
}

export function writeChildMessageAcceptance(
  asyncDir: string,
  acceptance: ChildMessageAcceptance,
): string {
  const acceptancePath = childMessageAckPath(asyncDir, acceptance.requestId);
  writeAtomicJson(acceptancePath, acceptance);
  return acceptancePath;
}

export function childMessageRequestRequiresAcceptance(request: ChildMessageRequest): boolean {
  return request.type === "resume";
}

export function writeChildMessageAcceptanceForRequest(
  asyncDir: string,
  request: ChildMessageRequest,
  acceptance: Omit<ChildMessageAcceptance, "requestId" | "type">,
): string | undefined {
  if (!childMessageRequestRequiresAcceptance(request)) return undefined;
  return writeChildMessageAcceptance(asyncDir, {
    ...acceptance,
    requestId: request.id,
    type: request.type,
  });
}

function parseChildMessageAcceptance(
  raw: unknown,
  requestId: string,
): ChildMessageAcceptance | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const input = raw as Partial<ChildMessageAcceptance>;
  if (input.requestId !== requestId || (input.type !== "steer" && input.type !== "resume"))
    return undefined;
  if (input.status !== "accepted" && input.status !== "rejected") return undefined;
  if (
    typeof input.ts !== "number" ||
    !Number.isFinite(input.ts) ||
    !Array.isArray(input.acceptedIndexes) ||
    !input.acceptedIndexes.every(Number.isInteger)
  )
    return undefined;
  return input as ChildMessageAcceptance;
}

export function consumeChildMessageAcceptance(
  asyncDir: string,
  requestId: string,
): ChildMessageAcceptance | undefined {
  const acceptancePath = childMessageAckPath(asyncDir, requestId);
  try {
    const parsed = parseChildMessageAcceptance(
      JSON.parse(fs.readFileSync(acceptancePath, "utf-8")),
      requestId,
    );
    fs.rmSync(acceptancePath, { force: true });
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    try {
      fs.rmSync(acceptancePath, { force: true });
    } catch {
      /* Best effort malformed ack cleanup. */
    }
    return undefined;
  }
}

export async function waitForChildMessageAcceptance(input: {
  asyncDir: string;
  requestId: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  isRunnerAlive?: () => boolean;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
}): Promise<ChildMessageAcceptanceWaitResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const timeoutMs = input.timeoutMs ?? 2_000;
  const delay =
    input.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  while (now() - startedAt < timeoutMs) {
    const acceptance = consumeChildMessageAcceptance(input.asyncDir, input.requestId);
    if (acceptance) return { outcome: "acknowledged", acceptance };
    if (input.isRunnerAlive && !input.isRunnerAlive()) return { outcome: "runner_gone" };
    await delay(input.pollIntervalMs ?? 25);
  }
  const acceptance = consumeChildMessageAcceptance(input.asyncDir, input.requestId);
  return acceptance ? { outcome: "acknowledged", acceptance } : { outcome: "timeout" };
}

function parseChildMessageRequest(raw: unknown): ChildMessageRequest | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const input = raw as Partial<ChildMessageRequest>;
  if (input.type !== "steer" && input.type !== "resume") return undefined;
  if (typeof input.id !== "string" || !input.id.trim()) return undefined;
  if (typeof input.ts !== "number" || !Number.isFinite(input.ts)) return undefined;
  if (typeof input.message !== "string" || !input.message.trim()) return undefined;
  if (
    input.targetIndex !== undefined &&
    (!Number.isInteger(input.targetIndex) || input.targetIndex < 0)
  )
    return undefined;
  if (
    input.deliveryDeadlineAt !== undefined &&
    (typeof input.deliveryDeadlineAt !== "number" ||
      !Number.isFinite(input.deliveryDeadlineAt) ||
      input.deliveryDeadlineAt <= 0)
  )
    return undefined;
  return {
    type: input.type,
    id: input.id.trim(),
    ts: input.ts,
    message: input.message.trim(),
    ...(input.targetIndex !== undefined ? { targetIndex: input.targetIndex } : {}),
    ...(input.deliveryDeadlineAt !== undefined
      ? { deliveryDeadlineAt: input.deliveryDeadlineAt }
      : {}),
    ...(typeof input.source === "string" && input.source.trim() ? { source: input.source } : {}),
  };
}

function consumeMatchingChildMessageRequestsFromDir<T extends ChildMessageRequest>(
  dir: string,
  matches: (request: ChildMessageRequest) => request is T,
  fsImpl: Pick<typeof fs, "existsSync" | "rmSync" | "readdirSync" | "readFileSync"> = fs,
): T[] {
  if (!fsImpl.existsSync(dir)) return [];
  const requests: T[] = [];
  for (const entry of fsImpl
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    const requestPath = path.join(dir, entry);
    let parsed: ChildMessageRequest | undefined;
    try {
      parsed = parseChildMessageRequest(JSON.parse(fsImpl.readFileSync(requestPath, "utf-8")));
    } catch {
      parsed = undefined;
    }
    if (parsed && !matches(parsed)) continue;
    try {
      fsImpl.rmSync(requestPath, { recursive: true });
    } catch {
      // Already removed by a concurrent check — do not execute it twice.
      continue;
    }
    if (parsed) requests.push(parsed as T);
  }
  return requests.sort((left, right) => left.ts - right.ts || left.id.localeCompare(right.id));
}

export function consumeChildMessageRequestsFromDir(
  dir: string,
  fsImpl: Pick<typeof fs, "existsSync" | "rmSync" | "readdirSync" | "readFileSync"> = fs,
): ChildMessageRequest[] {
  return consumeMatchingChildMessageRequestsFromDir(
    dir,
    (request): request is ChildMessageRequest =>
      request.type === "steer" || request.type === "resume",
    fsImpl,
  );
}

export function consumeSteerRequestsFromDir(
  dir: string,
  fsImpl: Pick<typeof fs, "existsSync" | "rmSync" | "readdirSync" | "readFileSync"> = fs,
): SteerRequest[] {
  return consumeMatchingChildMessageRequestsFromDir(
    dir,
    (request): request is SteerRequest => request.type === "steer",
    fsImpl,
  );
}

export function consumeSteerRequests(
  asyncDir: string,
  fsImpl: Pick<typeof fs, "existsSync" | "rmSync" | "readdirSync" | "readFileSync"> = fs,
): SteerRequest[] {
  return consumeSteerRequestsFromDir(steerRequestsDir(asyncDir), fsImpl);
}

export function consumeChildMessageRequests(
  asyncDir: string,
  fsImpl: Pick<typeof fs, "existsSync" | "rmSync" | "readdirSync" | "readFileSync"> = fs,
): ChildMessageRequest[] {
  return consumeChildMessageRequestsFromDir(steerRequestsDir(asyncDir), fsImpl);
}

/**
 * Runner side: consume a pending interrupt request. Idempotent — removes the file
 * so each distinct request fires exactly once. Returns whether one was pending.
 */
export function readInterruptRequest(
  asyncDir: string,
  fsImpl: Pick<typeof fs, "readFileSync"> = fs,
): InterruptRequest | undefined {
  const requestPath = interruptRequestPath(asyncDir);
  try {
    return JSON.parse(fsImpl.readFileSync(requestPath, "utf-8")) as InterruptRequest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function consumeInterruptRequest(
  asyncDir: string,
  fsImpl: Pick<typeof fs, "existsSync" | "rmSync"> = fs,
): boolean {
  const requestPath = interruptRequestPath(asyncDir);
  if (!fsImpl.existsSync(requestPath)) return false;
  try {
    fsImpl.rmSync(requestPath, { force: true, recursive: true });
  } catch {
    // Already removed by a concurrent check — still counts as consumed.
  }
  return true;
}

export function consumeTimeoutRequest(
  asyncDir: string,
  fsImpl: Pick<typeof fs, "existsSync" | "rmSync"> = fs,
): boolean {
  const requestPath = timeoutRequestPath(asyncDir);
  if (!fsImpl.existsSync(requestPath)) return false;
  try {
    fsImpl.rmSync(requestPath, { force: true, recursive: true });
  } catch {
    // Already removed by a concurrent check — still counts as consumed.
  }
  return true;
}

/**
 * Parent side: portable interrupt = authoritative file request + best-effort OS
 * signal. The signal is only a latency optimization on Unix; ENOSYS on Windows
 * is swallowed because the file inbox is authoritative there. Other signal
 * failures are surfaced because they usually mean the runner is not alive to
 * consume the request.
 */
export function deliverInterruptRequest(input: {
  asyncDir: string;
  pid?: number;
  kill?: KillFn;
  signal?: NodeJS.Signals;
  now?: () => number;
  source?: string;
}): void {
  const requestPath = requestAsyncInterrupt(
    input.asyncDir,
    input.source ? { source: input.source } : {},
    {
      now: input.now,
    },
  );
  if (typeof input.pid === "number" && input.pid > 0) {
    try {
      (input.kill ?? process.kill)(input.pid, input.signal ?? INTERRUPT_SIGNAL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOSYS") {
        // File inbox is authoritative when custom cross-process signals are unavailable.
        return;
      }
      try {
        fs.rmSync(requestPath, { force: true });
      } catch {
        // Best effort cleanup; the caller still gets the signal failure.
      }
      throw error;
    }
  }
}

export function deliverTimeoutRequest(input: {
  asyncDir: string;
  pid?: number;
  kill?: KillFn;
  signal?: NodeJS.Signals;
  now?: () => number;
  source?: string;
}): void {
  requestAsyncTimeout(input.asyncDir, input.source ? { source: input.source } : {}, {
    now: input.now,
  });
}

/**
 * Runner side: watch the control inbox and route interrupt requests into
 * `onInterrupt`. Uses `fs.watch` when available plus an interval poll as a
 * portable safety net (covers filesystems/platforms where `fs.watch` is
 * unreliable). Fires once per distinct request. Returns a disposer.
 */
export function watchAsyncControlInbox(
  asyncDir: string,
  opts: {
    onInterrupt: () => void;
    onTimeout?: () => void;
    onSteer?: (request: SteerRequest) => void;
    onResume?: (request: ResumeRequest) => void;
    pollIntervalMs?: number;
    fs?: ControlChannelFs;
    timers?: ControlChannelTimers;
  },
): () => void {
  const fsImpl = opts.fs ?? fs;
  const timers = opts.timers ?? { setInterval, clearInterval };
  const dir = controlInboxDir(asyncDir);
  try {
    fsImpl.mkdirSync(dir, { recursive: true });
  } catch {
    // Best effort — the poll/watch below tolerates a missing dir.
  }

  let disposed = false;
  const check = (): void => {
    if (disposed) return;
    try {
      if (consumeTimeoutRequest(asyncDir, fsImpl)) opts.onTimeout?.();
      if (consumeInterruptRequest(asyncDir, fsImpl)) opts.onInterrupt();
      for (const request of consumeChildMessageRequests(asyncDir, fsImpl)) {
        if (request.type === "resume") opts.onResume?.(request);
        else opts.onSteer?.(request);
      }
    } catch {
      // Never let inbox errors crash the runner.
    }
  };

  // Handle a request that may have arrived before the watcher started.
  check();

  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fsImpl.watch(dir, () => check());
    watcher.on?.("error", () => {
      // fs.watch can emit on transient FS errors; the interval poll keeps us live.
    });
  } catch {
    watcher = undefined;
  }

  const interval = timers.setInterval(check, opts.pollIntervalMs ?? POLL_INTERVAL_MS);
  interval.unref?.();

  return () => {
    if (disposed) return;
    disposed = true;
    try {
      watcher?.close();
    } catch {
      // ignore
    }
    timers.clearInterval(interval);
  };
}

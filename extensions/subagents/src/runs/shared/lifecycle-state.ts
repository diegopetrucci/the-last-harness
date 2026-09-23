import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { waitSync, writeAtomicJson } from "../../shared/atomic-json.ts";
import { invalidateStatusCache, readStatus } from "../../shared/utils.ts";
import type {
  AsyncCancellationMetadata,
  AsyncLifecycleContinuationMetadata,
  AsyncLifecycleContinuationPhase,
  AsyncPauseMetadata,
  AsyncStatus,
} from "../../shared/types.ts";
import {
  boundSubagentAttemptFacts,
  parseSubagentTerminalResult,
  terminalResultForStatusStep,
} from "../../shared/terminal-result.ts";
import {
  canonicalLifecycleState,
  canonicalLifecycleStepState,
} from "../background/async-status-boundary.ts";
import { normalizeIdleEpisodeId } from "./subagent-control.ts";

const DEFAULT_MAX_SUMMARY_BYTES = 280;

const DEFAULT_MAX_TOKEN_BYTES = 120;

const SAFE_LIFECYCLE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const DEFAULT_LOCK_RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const;

const TERMINAL_RUN_STATES = new Set(["complete", "failed", "cancelled", "paused"]);

const ACTIVE_RUN_STATES = new Set(["queued", "running", "pausing"]);

type StatusStep = NonNullable<AsyncStatus["steps"]>[number];

type AnyRecord = Record<string, unknown>;

export const isActiveLifecycleState = (value: unknown): boolean =>
  ACTIVE_RUN_STATES.has(canonicalLifecycleState(value));

export const isTerminalLifecycleState = (value: unknown): boolean =>
  TERMINAL_RUN_STATES.has(canonicalLifecycleState(value));

export const isCompletedLifecycleState = (value: unknown): boolean =>
  canonicalLifecycleState(value) === "complete";

export const isCompletedLifecycleStepState = (value: unknown): boolean =>
  canonicalLifecycleStepState(value) === "complete";

export type PidLiveness = "alive" | "dead" | "unknown";

type ContinuationClaimLiveness =
  | PidLiveness
  | "missing-owner"
  | "completed"
  | "blocked"
  | "unclaimed";

class LifecycleLockExhaustedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LifecycleLockExhaustedError";
  }
}

export class LifecycleGenerationConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LifecycleGenerationConflictError";
  }
}

export const isLifecycleTransitionContentionError = (error: unknown): boolean =>
  error instanceof LifecycleGenerationConflictError || error instanceof LifecycleLockExhaustedError;

type LifecycleLockOptions = {
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
  now?: () => number;
  retryDelaysMs?: readonly number[];
};

type LifecycleTransitionOptions = {
  asyncDir: string;
  expectedGeneration: number;
  mutate: (status: AsyncStatus) => AsyncStatus;
  lockOptions?: LifecycleLockOptions;
};

type LifecycleTransitionResult = {
  previousGeneration: number;
  nextGeneration: number;
  status: AsyncStatus;
};

type TransitionLockOwner = { token?: string; pid?: number; acquiredAt?: number };

const isRecord = (value: unknown): value is AnyRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const codeOf = (error: unknown): string | undefined =>
  isRecord(error) && typeof error.code === "string" ? error.code : undefined;

const finiteTimestamp = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const positivePid = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

function boundedToken(value: unknown, maxBytes = DEFAULT_MAX_TOKEN_BYTES): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  return token && Buffer.byteLength(token, "utf8") <= maxBytes && SAFE_LIFECYCLE_TOKEN.test(token)
    ? token
    : undefined;
}

function replaceControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x08 ||
        code === 0x0b ||
        code === 0x0c ||
        (code >= 0x0e && code <= 0x1f) ||
        code === 0x7f
        ? " "
        : character;
    })
    .join("");
}

export function boundSupervisorSummary(
  summary: unknown,
  maxBytes = DEFAULT_MAX_SUMMARY_BYTES,
): string | undefined {
  if (typeof summary !== "string") return undefined;
  const normalized = replaceControlCharacters(summary).replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  let bounded = normalized;
  while (Buffer.byteLength(bounded, "utf8") > maxBytes && bounded.length > 1)
    bounded = `${bounded.slice(0, -2).trimEnd()}…`;
  return bounded;
}

function definedObject<T extends object = AnyRecord>(
  entries: readonly (readonly [string, unknown])[],
): T {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined)) as T;
}

function normalizePause(value: unknown): AsyncPauseMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const kind =
    value.kind === "awaiting_supervisor" || value.kind === "cohort_pause" ? value.kind : undefined;

  if (!kind) return undefined;
  const request =
    isRecord(value.request) && value.request.tool === "contact_supervisor"
      ? definedObject([
          ["tool", "contact_supervisor"],
          [
            "reason",
            value.request.reason === "need_decision" || value.request.reason === "interview_request"
              ? value.request.reason
              : undefined,
          ],
          ["requestId", boundedToken(value.request.requestId)],
          ["summary", boundSupervisorSummary(value.request.summary)],
        ])
      : undefined;
  return definedObject<AsyncPauseMetadata>([
    ["kind", kind],
    ["summary", boundSupervisorSummary(value.summary)],
    ["requestedAt", finiteTimestamp(value.requestedAt)],
    ["pausedAt", finiteTimestamp(value.pausedAt)],
    ["ownerPid", positivePid(value.ownerPid)],
    ["request", request],
  ]);
}

const CONTINUATION_PHASES = new Set(["claimed", "reserved", "launched", "completed", "continued"]);

function normalizeContinuation(value: unknown): AsyncLifecycleContinuationMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const phase = CONTINUATION_PHASES.has(String(value.phase))
    ? (value.phase as AsyncLifecycleContinuationPhase)
    : undefined;
  const result = definedObject<AsyncLifecycleContinuationMetadata>([
    ["phase", phase],
    ["claimToken", boundedToken(value.claimToken)],
    ["claimedAt", finiteTimestamp(value.claimedAt)],
    ["ownerPid", positivePid(value.ownerPid)],
    ["launchedAt", finiteTimestamp(value.launchedAt)],
    ["completedAt", finiteTimestamp(value.completedAt)],
    ["continuedAt", finiteTimestamp(value.continuedAt)],
    ["continuationRunId", boundedToken(value.continuationRunId)],
  ]);
  return Object.keys(result).length ? result : undefined;
}

function continuationKey(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? String(number) : undefined;
}

function normalizeContinuationMap(
  value: unknown,
): Record<string, AsyncLifecycleContinuationMetadata> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, AsyncLifecycleContinuationMetadata> = {};
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = continuationKey(key);
    const continuation = normalizeContinuation(item);
    if (normalizedKey && continuation) result[normalizedKey] = continuation;
  }
  return Object.keys(result).length ? result : undefined;
}

export function lifecycleContinuationForIndex(
  status: Pick<AsyncStatus, "lifecycle"> | null | undefined,
  index: number,
): AsyncLifecycleContinuationMetadata | undefined {
  const key = continuationKey(index);
  return key
    ? (status?.lifecycle?.continuationsByIndex?.[key] ??
        (index === 0 ? status?.lifecycle?.continuation : undefined))
    : undefined;
}

export function withLifecycleContinuation(
  status: AsyncStatus,
  index: number,
  continuation: AsyncLifecycleContinuationMetadata | undefined,
): AsyncStatus["lifecycle"] {
  const key = continuationKey(index);
  const current = status.lifecycle ?? { generation: lifecycleGeneration(status) };
  if (!key) return current;
  const byIndex = { ...current.continuationsByIndex };
  if (continuation) byIndex[key] = continuation;
  else delete byIndex[key];
  const next = { ...current };
  if (index === 0) {
    if (continuation) next.continuation = continuation;
    else delete next.continuation;
  }
  if (Object.keys(byIndex).length) next.continuationsByIndex = byIndex;
  else delete next.continuationsByIndex;
  return next;
}

const RETIRED_FIELDS = [
  "activeRuntimeMs",
  "activeRuntimeCheckpointAt",
  "durableAttentionReasons",
] as const;

function normalizeRecord(raw: AnyRecord, fields: readonly string[]): AnyRecord {
  const result = { ...raw };
  for (const field of [...RETIRED_FIELDS, ...fields]) delete result[field];
  if (raw.activityState === "needs_attention") result.activityState = raw.activityState;
  const terminalResult = parseSubagentTerminalResult(raw.terminalResult);
  if (terminalResult) result.terminalResult = terminalResult;
  else delete result.terminalResult;
  return result;
}

function normalizeStep(value: StatusStep): StatusStep {
  const raw = value as StatusStep & AnyRecord;
  const result = normalizeRecord(raw, ["activityState", "compaction"]);
  const idleEpisodeId = normalizeIdleEpisodeId(raw.idleEpisodeId);
  const compaction =
    isRecord(raw.compaction) &&
    (raw.compaction.reason === "manual" ||
      raw.compaction.reason === "threshold" ||
      raw.compaction.reason === "overflow")
      ? { reason: raw.compaction.reason }
      : undefined;
  if (idleEpisodeId) result.idleEpisodeId = idleEpisodeId;
  if (compaction) result.compaction = compaction;
  result.status = canonicalLifecycleStepState(raw.status);
  return result as StatusStep;
}

export function normalizeAsyncLifecycleStatus(status: AsyncStatus): AsyncStatus {
  const raw = status as AsyncStatus & AnyRecord;
  const lifecycle = isRecord(raw.lifecycle) ? raw.lifecycle : undefined;
  const result = normalizeRecord(raw, ["activityState", "lifecycle", "pause", "cancel", "steps"]);
  const pause = normalizePause(raw.pause);
  const cancel = isRecord(raw.cancel)
    ? definedObject<AsyncCancellationMetadata>([
        ["summary", boundSupervisorSummary(raw.cancel.summary)],
        ["cancelledAt", finiteTimestamp(raw.cancel.cancelledAt)],
      ])
    : undefined;
  const normalizedContinuation = normalizeContinuation(lifecycle?.continuation);
  const normalizedByIndex = normalizeContinuationMap(lifecycle?.continuationsByIndex);
  const resumeBlockedReason =
    lifecycle?.resumeBlockedReason === "supervisor_lifecycle_failure"
      ? lifecycle.resumeBlockedReason
      : undefined;
  result.state = canonicalLifecycleState(raw.state);
  if (pause) result.pause = pause;
  if (cancel) result.cancel = cancel;
  if (Array.isArray(raw.steps)) result.steps = raw.steps.map(normalizeStep);
  result.lifecycle = {
    generation: lifecycleGeneration(status),
    ...(resumeBlockedReason ? { resumeBlockedReason } : {}),
    ...(normalizedContinuation ? { continuation: normalizedContinuation } : {}),
    ...(normalizedByIndex ? { continuationsByIndex: normalizedByIndex } : {}),
  };
  return result as AsyncStatus & AnyRecord;
}

export function writeNormalizedLifecycleStatus(asyncDir: string, status: AsyncStatus): AsyncStatus {
  const normalized = normalizeAsyncLifecycleStatus(status);
  const statusFile = path.join(asyncDir, "status.json");
  writeAtomicJson(statusFile, normalized);
  invalidateStatusCache(statusFile);
  return normalized;
}

const runLabel = (asyncDir: string): string =>
  path.basename(path.resolve(asyncDir)) || "unknown-run";

const lockDir = (asyncDir: string): string => path.join(asyncDir, ".lifecycle-transition.lock");

const ownerPath = (asyncDir: string): string => path.join(lockDir(asyncDir), "owner.json");

function readLockOwner(asyncDir: string): TransitionLockOwner {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(ownerPath(asyncDir), "utf8"));
    return isRecord(parsed)
      ? {
          token: boundedToken(parsed.token),
          pid: positivePid(parsed.pid),
          acquiredAt: finiteTimestamp(parsed.acquiredAt),
        }
      : {};
  } catch {
    return {};
  }
}

function lockSnapshot(asyncDir: string): TransitionLockOwner | undefined {
  try {
    fs.statSync(lockDir(asyncDir));
    return readLockOwner(asyncDir);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return undefined;
    throw error;
  }
}

function completeOwner(owner: TransitionLockOwner): owner is Required<TransitionLockOwner> {
  return owner.token !== undefined && owner.pid !== undefined && owner.acquiredAt !== undefined;
}

export function checkPidLiveness(
  pid: number,
  kill: (pid: number, signal?: NodeJS.Signals | 0) => boolean = process.kill,
): PidLiveness {
  try {
    kill(pid, 0);
    return "alive";
  } catch (error) {
    return codeOf(error) === "ESRCH" ? "dead" : "unknown";
  }
}

function liveLock(asyncDir: string): boolean {
  try {
    const snapshot = lockSnapshot(asyncDir);
    if (!snapshot) return false;
    // A lock directory without a complete owner is indistinguishable from the
    // mkdir-before-owner.json publication window. Treat that unknown state as
    // live so lock-exhausted callers fail closed in memory and never rewrite disk.
    return !completeOwner(snapshot) || checkPidLiveness(snapshot.pid) !== "dead";
  } catch {
    // A lock stat/read failure is unknown ownership, never proof that a
    // lockless rewrite is safe.
    return true;
  }
}

function recoverLock(asyncDir: string, options: LifecycleLockOptions): boolean {
  const snapshot = lockSnapshot(asyncDir);
  if (!snapshot) return false;

  const owner = snapshot;
  // Only a complete owner record whose pid is proven dead can be recovered.
  // Missing, malformed, or partially written owner metadata stays protected.
  if (!completeOwner(owner) || checkPidLiveness(owner.pid, options.kill) !== "dead") return false;
  const latest = lockSnapshot(asyncDir);
  if (
    !latest ||
    !completeOwner(latest) ||
    latest.token !== owner.token ||
    latest.pid !== owner.pid ||
    latest.acquiredAt !== owner.acquiredAt
  )
    return false;

  try {
    fs.rmSync(lockDir(asyncDir), { recursive: true, force: false });
    return true;
  } catch (error) {
    if (codeOf(error) === "ENOENT") return false;
    throw error;
  }
}

function acquireLock(asyncDir: string, options: LifecycleLockOptions): () => void {
  fs.mkdirSync(asyncDir, { recursive: true });
  const directory = lockDir(asyncDir);
  const owner = {
    token: randomUUID(),
    pid: process.pid,
    acquiredAt: options.now?.() ?? Date.now(),
  };
  const delays = options.retryDelaysMs ?? DEFAULT_LOCK_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(directory);
      break;
    } catch (error) {
      if (codeOf(error) !== "EEXIST") throw error;
      if (recoverLock(asyncDir, options)) continue;
      const delay = delays[attempt];
      if (delay !== undefined) {
        waitSync(delay);
        continue;
      }
      const held = readLockOwner(asyncDir);
      const acquired =
        held.acquiredAt === undefined ? "unknown time" : new Date(held.acquiredAt).toISOString();
      throw new LifecycleLockExhaustedError(
        `Lifecycle transition rejected for run '${runLabel(asyncDir)}': status lock (pid ${held.pid ?? "unknown"}, acquired ${acquired}) is held by another transition.`,
        { cause: error },
      );
    }
  }

  try {
    fs.writeFileSync(ownerPath(asyncDir), JSON.stringify(owner), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (readLockOwner(asyncDir).token === owner.token)
        fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      /* Never remove an unverified replacement lock. */
    }
  };
}

export function withLifecycleStatusLock<T>(
  asyncDir: string,
  operation: (status: AsyncStatus | null) => T,
  options: LifecycleLockOptions = {},
): T {
  const release = acquireLock(asyncDir, options);

  try {
    return operation(readStatus(asyncDir, { cache: false }));
  } finally {
    release();
  }
}

const immutableTerminal = (value: unknown): boolean =>
  isTerminalLifecycleState(value) && value !== "paused";

export const lifecycleGeneration = (status: AsyncStatus | null | undefined): number => {
  const generation = status?.lifecycle?.generation;
  return typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0
    ? generation
    : 0;
};

export function transitionLifecycleStatus(
  options: LifecycleTransitionOptions,
): LifecycleTransitionResult {
  return withLifecycleStatusLock(
    options.asyncDir,
    (current) => {
      if (!current)
        throw new Error(
          `Cannot transition lifecycle state for run '${runLabel(options.asyncDir)}': persisted status was not found.`,
        );

      const generation = lifecycleGeneration(current);
      if (generation !== options.expectedGeneration)
        throw new LifecycleGenerationConflictError(
          `Lifecycle transition rejected for run '${runLabel(options.asyncDir)}': expected generation ${options.expectedGeneration}, found ${generation}.`,
        );

      const mutated = normalizeAsyncLifecycleStatus(options.mutate(current));
      const next =
        immutableTerminal(current.state) && mutated.state !== current.state
          ? {
              ...current,
              lifecycle: mutated.lifecycle,
              lastUpdate: mutated.lastUpdate ?? current.lastUpdate,
            }
          : mutated;

      const status = writeNormalizedLifecycleStatus(options.asyncDir, {
        ...next,
        lifecycle: { ...next.lifecycle, generation: generation + 1 },
      });
      return { previousGeneration: generation, nextGeneration: generation + 1, status };
    },
    options.lockOptions,
  );
}

const SAFE_ROOT_FACTS = [
  "sessionFile",
  "processCleanup",
  "endedAt",
  "terminalResult",
  "totalTokens",
  "totalCost",
] as const;

const TERMINAL_ONLY_ROOT_FACTS = new Set(["endedAt", "terminalResult"]);

const SAFE_NONTERMINAL_ROOT_FACTS = SAFE_ROOT_FACTS.filter(
  (field) => !TERMINAL_ONLY_ROOT_FACTS.has(field),
);

const SAFE_STEP_FACTS = [
  "sessionFile",
  "processCleanup",
  "exitCode",
  "exitSignal",
  "endedAt",
  "durationMs",
  "terminationReason",
  "transcriptPath",
  "transcriptError",
  "childLocation",
  "terminalResult",
  "tokens",
  "totalCost",
  "model",
  "thinking",
  "modelIdentity",
  "modelResolution",
  "attemptedModels",
  "modelAttempts",
  "modelFallbackNotice",
  "contextUsage",
  "contextPressure",
  "contextPressureCrossedThresholds",
  "skills",
  "skillsWarning",
  "ticketId",
] as const;

const TERMINAL_ONLY_STEP_FACTS = new Set([
  "exitCode",
  "exitSignal",
  "endedAt",
  "durationMs",
  "terminationReason",
  "terminalResult",
]);

const SAFE_NONTERMINAL_STEP_FACTS = SAFE_STEP_FACTS.filter(
  (field) => !TERMINAL_ONLY_STEP_FACTS.has(field),
);

const IMMUTABLE_STEP_STATES = new Set(["complete", "failed", "cancelled"]);

function recordOf(value: AnyRecord | AsyncStatus | StatusStep): AnyRecord {
  return { ...value };
}

function appendMissing(target: AnyRecord, source: AnyRecord, fields: readonly string[]): void {
  for (const field of fields)
    if (target[field] === undefined && source[field] !== undefined) target[field] = source[field];
}

function maxNumber(left: unknown, right: unknown): number | undefined {
  const values = [left, right].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  return values.length ? Math.max(...values) : undefined;
}

function projectTerminalResult(
  result: ReturnType<typeof parseSubagentTerminalResult> | undefined,
  status: unknown,
): ReturnType<typeof parseSubagentTerminalResult> | undefined {
  if (!result) return undefined;
  return terminalResultForStatusStep(
    { terminalResult: result },
    canonicalLifecycleStepState(status),
  );
}

function mergeTerminalResult(
  persisted: unknown,
  memory: unknown,
  status: unknown,
): ReturnType<typeof parseSubagentTerminalResult> | undefined {
  const left = parseSubagentTerminalResult(persisted);
  const right = parseSubagentTerminalResult(memory);
  if (!left) return projectTerminalResult(right, status);
  if (!right) return projectTerminalResult(left, status);
  const attempts = new Map(left.facts.attempts.map((attempt) => [attempt.attempt, attempt]));
  for (const attempt of right.facts.attempts)
    if (!attempts.has(attempt.attempt)) attempts.set(attempt.attempt, attempt);
  return projectTerminalResult(
    {
      state: left.state,
      facts: {
        attempts: boundSubagentAttemptFacts(
          [...attempts.values()].sort((a, b) => a.attempt - b.attempt),
        ),
      },
    },
    status,
  );
}

function mergeStep(
  persisted: StatusStep | undefined,
  memory: StatusStep | undefined,
  changed: boolean,
): StatusStep | undefined {
  if (!persisted) return changed ? undefined : memory;
  if (!memory) return persisted;
  const immutable = IMMUTABLE_STEP_STATES.has(canonicalLifecycleStepState(persisted.status));

  if (changed || immutable) {
    const merged = { ...persisted } as StatusStep & AnyRecord;
    appendMissing(
      merged,
      recordOf(memory),
      immutable ? SAFE_STEP_FACTS : SAFE_NONTERMINAL_STEP_FACTS,
    );

    if (!changed && Object.hasOwn(memory, "compaction")) {
      if (memory.compaction) merged.compaction = memory.compaction;
      else delete merged.compaction;
    }
    if (immutable) {
      const terminalResult = mergeTerminalResult(
        persisted.terminalResult,
        memory.terminalResult,
        persisted.status,
      );
      if (terminalResult) merged.terminalResult = terminalResult;
    }

    return merged;
  }
  return { ...persisted, ...memory };
}

function mergeStatus(current: AsyncStatus, memory: AsyncStatus, changed: boolean): AsyncStatus {
  if (changed) {
    const merged = { ...current } as AsyncStatus & AnyRecord;
    appendMissing(
      merged,
      recordOf(memory),
      immutableTerminal(current.state) ? SAFE_ROOT_FACTS : SAFE_NONTERMINAL_ROOT_FACTS,
    );
    if (current.steps)
      merged.steps = current.steps
        .map((step, index) => mergeStep(step, memory.steps?.[index], true))
        .filter((step): step is StatusStep => step !== undefined);

    return merged;
  }

  const currentState = canonicalLifecycleState(current.state);
  const memoryState = canonicalLifecycleState(memory.state);
  const immutable = immutableTerminal(currentState);
  const continuationsByIndex = {
    ...current.lifecycle?.continuationsByIndex,
    ...memory.lifecycle?.continuationsByIndex,
  };
  const root =
    immutable && currentState !== memoryState
      ? { ...current }
      : immutable
        ? { ...current }
        : { ...current, ...memory };
  const rootRecord = root as AsyncStatus & AnyRecord;
  if (immutable) appendMissing(rootRecord, recordOf(memory), SAFE_ROOT_FACTS);

  const steps = memory.steps?.map((step, index) => mergeStep(current.steps?.[index], step, false));
  return {
    ...root,
    lifecycle: immutable
      ? current.lifecycle
      : {
          ...current.lifecycle,
          ...memory.lifecycle,
          ...(Object.keys(continuationsByIndex).length ? { continuationsByIndex } : {}),
        },
    ...(steps ? { steps: steps.filter((step): step is StatusStep => step !== undefined) } : {}),
  };
}

export function mergeAndWriteSourceRunnerStatus(
  asyncDir: string,
  inMemory: AsyncStatus,
): AsyncStatus {
  const memoryGeneration = lifecycleGeneration(inMemory);
  try {
    return withLifecycleStatusLock(asyncDir, (persisted) => {
      if (!persisted) return writeNormalizedLifecycleStatus(asyncDir, inMemory);
      const current = normalizeAsyncLifecycleStatus(persisted);
      return writeNormalizedLifecycleStatus(
        asyncDir,
        mergeStatus(current, inMemory, lifecycleGeneration(current) !== memoryGeneration),
      );
    });
  } catch (error) {
    if (!(error instanceof LifecycleLockExhaustedError)) throw error;

    const persisted = readStatus(asyncDir, { cache: false });
    // Unknown lock state is fail-closed in memory: do not rewrite status.json
    // without a lock merely because owner.json was absent or incomplete.
    if (
      persisted &&
      inMemory.state === "failed" &&
      isActiveLifecycleState(persisted.state) &&
      lifecycleGeneration(persisted) === memoryGeneration &&
      !liveLock(asyncDir)
    ) {
      const merged = mergeStatus(normalizeAsyncLifecycleStatus(persisted), inMemory, false);
      return writeNormalizedLifecycleStatus(asyncDir, {
        ...persisted,
        state: "failed",
        pid: undefined,
        pause: undefined,
        activityState: undefined,
        currentTool: undefined,
        currentToolStartedAt: undefined,
        currentPath: undefined,
        error: inMemory.error,
        endedAt: inMemory.endedAt ?? persisted.endedAt,
        lastUpdate: maxNumber(persisted.lastUpdate, inMemory.lastUpdate),
        lifecycle: {
          ...persisted.lifecycle,
          ...(inMemory.lifecycle?.resumeBlockedReason
            ? { resumeBlockedReason: inMemory.lifecycle.resumeBlockedReason }
            : {}),
          generation: memoryGeneration + 1,
        },
        steps: merged.steps ?? persisted.steps,
      });
    }
    return persisted ?? normalizeAsyncLifecycleStatus(inMemory);
  }
}

function continuationTargetExists(
  sourceAsyncDir: string,
  id: string,
  options: { asyncDirRoot?: string; resultsDir?: string },
): boolean {
  const root = path.resolve(options.asyncDirRoot ?? path.dirname(path.resolve(sourceAsyncDir)));
  return (
    fs.existsSync(path.join(root, id)) ||
    Boolean(options.resultsDir && fs.existsSync(path.join(options.resultsDir, `${id}.json`)))
  );
}

const continuationDone = (continuation?: AsyncLifecycleContinuationMetadata): boolean =>
  continuation?.phase === "completed" ||
  continuation?.phase === "continued" ||
  continuation?.completedAt !== undefined ||
  continuation?.continuedAt !== undefined;

function continuationResult(
  status: AsyncStatus,
  index: number,
  continuation: AsyncLifecycleContinuationMetadata,
  at: number,
  runId: string,
): AsyncStatus {
  const steps = status.steps?.map((step, stepIndex) =>
    stepIndex === index
      ? { ...step, status: "complete" as const, endedAt: at, exitCode: 0, pause: undefined }
      : step,
  );
  const actionable =
    steps?.some(
      (step) => step.status === "paused" || step.status === "pausing" || step.status === "pending",
    ) ?? false;
  return {
    ...status,
    state: actionable ? "paused" : "complete",
    pid: undefined,
    endedAt: at,
    lastUpdate: at,
    pause: actionable ? status.pause : undefined,
    lifecycle: withLifecycleContinuation(status, index, {
      ...continuation,
      phase: "completed",
      ownerPid: undefined,
      completedAt: at,
      continuationRunId: runId,
    }),
    ...(steps ? { steps } : {}),
  };
}

type ContinuationGate =
  | { kind: "done"; same: boolean }
  | { kind: "lost" }
  | { kind: "launched" | "ready"; continuation: AsyncLifecycleContinuationMetadata };

function continuationGate(
  status: AsyncStatus,
  index: number,
  claimToken: string,
  runId: string,
): ContinuationGate {
  const continuation = lifecycleContinuationForIndex(status, index);
  if (continuationDone(continuation))
    return {
      kind: "done",
      same: continuation?.claimToken === claimToken && continuation.continuationRunId === runId,
    };
  if (continuation?.claimToken !== claimToken || continuation.continuationRunId !== runId)
    return { kind: "lost" };
  return { kind: continuation.phase === "launched" ? "launched" : "ready", continuation };
}

type ContinuationAdvance = {
  status: AsyncStatus | null;
  changed: boolean;
  done: boolean;
  lost: boolean;
};

export function advanceLifecycleContinuation(
  asyncDir: string,
  index: number,
  claimToken: string,
  runId: string,
  finalize: boolean,
  now?: () => number,
): ContinuationAdvance {
  const current = readStatus(asyncDir, { cache: false });
  if (!current) return { status: null, changed: false, done: false, lost: true };
  const gate = continuationGate(current, index, claimToken, runId);
  if (gate.kind === "done")
    return { status: current, changed: false, done: gate.same, lost: !gate.same };
  if (gate.kind === "lost") return { status: current, changed: false, done: false, lost: true };
  if (!finalize && gate.kind === "launched")
    return { status: current, changed: false, done: false, lost: false };

  const at = now?.() ?? Date.now();
  try {
    const result = transitionLifecycleStatus({
      asyncDir,
      expectedGeneration: lifecycleGeneration(current),
      mutate: (status) =>
        finalize
          ? continuationResult(status, index, gate.continuation, at, runId)
          : {
              ...status,
              lastUpdate: at,
              lifecycle: withLifecycleContinuation(status, index, {
                ...gate.continuation,
                phase: "launched",
                ownerPid: undefined,
                launchedAt: at,
                continuationRunId: runId,
              }),
            },
    });

    return { status: result.status, changed: true, done: false, lost: false };
  } catch (error) {
    if (error instanceof LifecycleGenerationConflictError)
      return advanceLifecycleContinuation(asyncDir, index, claimToken, runId, finalize, now);
    throw error;
  }
}

interface ContinuationRecoveryOptions {
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
  now?: () => number;
  asyncDirRoot?: string;
  resultsDir?: string;
}

export function recoverStaleLifecycleContinuationStatus(
  current: AsyncStatus,
  asyncDir: string,
  index: number,
  options: ContinuationRecoveryOptions = {},
): { status: AsyncStatus; recovered: boolean; liveness: ContinuationClaimLiveness } {
  const continuation = lifecycleContinuationForIndex(current, index);

  if (!continuation?.claimToken)
    return { status: current, recovered: false, liveness: "unclaimed" };
  if (continuationDone(continuation))
    return { status: current, recovered: false, liveness: "completed" };
  if (continuation.ownerPid === undefined)
    return {
      status: current,
      recovered: false,
      liveness: continuation.continuationRunId ? "blocked" : "missing-owner",
    };

  const liveness = checkPidLiveness(continuation.ownerPid, options.kill);
  if (liveness !== "dead") return { status: current, recovered: false, liveness };
  if (
    continuation.continuationRunId &&
    continuationTargetExists(asyncDir, continuation.continuationRunId, options)
  )
    return { status: current, recovered: false, liveness: "blocked" };
  return {
    status: {
      ...current,
      lastUpdate: options.now?.() ?? Date.now(),
      lifecycle: withLifecycleContinuation(current, index, undefined),
    },
    recovered: true,
    liveness,
  };
}

export function recoverStaleLifecycleContinuationClaim(
  asyncDir: string,
  index: number,
  options: ContinuationRecoveryOptions = {},
): { status: AsyncStatus | null; recovered: boolean; liveness: ContinuationClaimLiveness } {
  const current = readStatus(asyncDir, { cache: false });
  if (!current) return { status: null, recovered: false, liveness: "unclaimed" };
  const inspected = recoverStaleLifecycleContinuationStatus(current, asyncDir, index, options);
  if (!inspected.recovered) return inspected;
  const generation = lifecycleGeneration(current);
  const token = lifecycleContinuationForIndex(current, index)?.claimToken;
  return withLifecycleStatusLock(
    asyncDir,
    (locked) => {
      if (!locked) return { status: null, recovered: false, liveness: inspected.liveness };
      const lockedContinuation = lifecycleContinuationForIndex(locked, index);
      const generationChanged = lifecycleGeneration(locked) !== generation;
      const claimChanged = lockedContinuation?.claimToken !== token;
      if (
        (generationChanged || claimChanged || isTerminalLifecycleState(locked.state)) &&
        lockedContinuation?.ownerPid !== undefined
      )
        checkPidLiveness(lockedContinuation.ownerPid, options.kill);
      if (generationChanged || claimChanged)
        return { status: locked, recovered: false, liveness: inspected.liveness };
      const terminalLocked = isTerminalLifecycleState(locked.state);
      const again = terminalLocked
        ? { status: locked, recovered: true, liveness: "dead" as const }
        : recoverStaleLifecycleContinuationStatus(locked, asyncDir, index, options);
      if (!again.recovered) return again;
      const at = options.now?.() ?? Date.now();
      return {
        status: writeNormalizedLifecycleStatus(asyncDir, {
          ...locked,
          lastUpdate: Math.max(locked.lastUpdate ?? 0, again.status.lastUpdate ?? at),
          lifecycle: {
            ...withLifecycleContinuation(locked, index, undefined),
            generation: generation + 1,
          },
        }),
        recovered: true,
        liveness: again.liveness,
      };
    },
    { kill: options.kill, now: options.now },
  );
}

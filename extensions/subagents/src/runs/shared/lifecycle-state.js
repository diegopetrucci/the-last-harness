import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { writeAtomicJson } from "../../shared/atomic-json.js";
import { invalidateStatusCache } from "../../shared/utils.js";
const DEFAULT_MAX_SUMMARY_BYTES = 280;
const DEFAULT_MAX_TOKEN_BYTES = 120;
export const ACTIVE_RUNTIME_CHECKPOINT_INTERVAL_MS = 30_000;
const SAFE_LIFECYCLE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DEFAULT_LOCK_RETRY_DELAYS_MS = [10, 25, 50, 100, 200];
const DEFAULT_OWNERLESS_LOCK_STALE_MS = 30_000;
const WAIT_BUFFER = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(4) : undefined;
const WAIT_VIEW = WAIT_BUFFER ? new Int32Array(WAIT_BUFFER) : undefined;
export function normalizeActiveRuntimeMs(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(value))
        : undefined;
}
export function normalizeActiveRuntimeCheckpointAt(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
        : undefined;
}
export function boundedActiveRuntimeMs(value, fallback = 0) {
    return normalizeActiveRuntimeMs(value) ?? normalizeActiveRuntimeMs(fallback) ?? 0;
}
export function shouldPersistActiveRuntimeCheckpoint(input) {
    if (input.trackerFrozen)
        return false;
    const current = normalizeActiveRuntimeMs(input.currentActiveRuntimeMs);
    const previous = normalizeActiveRuntimeMs(input.previousActiveRuntimeMs);
    return current !== undefined && (previous === undefined || current > previous);
}
export function applyActiveRuntimeCheckpoint(candidates, input) {
    let advanced = false;
    for (const candidate of candidates) {
        const trackerFrozen = candidate.tracker.isFrozen();
        const runtime = input.freeze
            ? candidate.tracker.freeze(input.now)
            : candidate.tracker.checkpoint(input.now);
        if (!shouldPersistActiveRuntimeCheckpoint({
            previousActiveRuntimeMs: candidate.previousActiveRuntimeMs,
            currentActiveRuntimeMs: runtime,
            trackerFrozen,
        }))
            continue;
        candidate.apply({
            activeRuntimeMs: Math.max(normalizeActiveRuntimeMs(candidate.previousActiveRuntimeMs) ?? 0, runtime),
            activeRuntimeCheckpointAt: Math.max(normalizeActiveRuntimeCheckpointAt(candidate.previousActiveRuntimeCheckpointAt) ?? 0, normalizeActiveRuntimeCheckpointAt(input.now) ?? 0),
        });
        advanced = true;
    }
    if (advanced)
        input.persist?.();
    return advanced;
}
export function createActiveRuntimeTracker(input = {}) {
    const now = input.now ?? (() => Date.now());
    const suppliedSegmentStart = normalizeActiveRuntimeCheckpointAt(input.segmentStartedAt);
    const initialNow = suppliedSegmentStart ?? normalizeActiveRuntimeCheckpointAt(now()) ?? Date.now();
    let total = boundedActiveRuntimeMs(input.priorActiveRuntimeMs);
    let segmentStartedAt = suppliedSegmentStart ?? initialNow;
    let frozen = false;
    const current = (at = now()) => {
        if (frozen)
            return total;
        const normalizedAt = normalizeActiveRuntimeCheckpointAt(at);
        const elapsed = normalizedAt === undefined ? 0 : Math.max(0, normalizedAt - segmentStartedAt);
        return Math.min(Number.MAX_SAFE_INTEGER, total + elapsed);
    };
    const checkpoint = (at = now()) => {
        const normalizedAt = normalizeActiveRuntimeCheckpointAt(at) ?? segmentStartedAt;
        const checkpointAt = Math.max(segmentStartedAt, normalizedAt);
        total = current(checkpointAt);
        segmentStartedAt = checkpointAt;
        return total;
    };
    const freeze = (at = now()) => {
        if (!frozen) {
            checkpoint(at);
            frozen = true;
        }
        return total;
    };
    return {
        current,
        checkpoint,
        freeze,
        isFrozen: () => frozen,
        finalize: (at = now()) => (frozen ? total : checkpoint(at)),
    };
}
class LifecycleLockExhaustedError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "LifecycleLockExhaustedError";
    }
}
function replaceControlCharacters(value) {
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
export function boundSupervisorSummary(summary, maxBytes = DEFAULT_MAX_SUMMARY_BYTES) {
    if (typeof summary !== "string")
        return undefined;
    const normalized = replaceControlCharacters(summary).replace(/\s+/g, " ").trim();
    if (!normalized)
        return undefined;
    let bounded = normalized;
    while (Buffer.byteLength(bounded, "utf-8") > maxBytes && bounded.length > 1) {
        bounded = `${bounded.slice(0, -2).trimEnd()}…`;
    }
    return bounded;
}
function parsePauseKind(value) {
    return value === "awaiting_supervisor" || value === "cohort_pause" ? value : undefined;
}
function parseTimestamp(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function parsePid(value) {
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
function boundLifecycleToken(value, maxBytes = DEFAULT_MAX_TOKEN_BYTES) {
    if (typeof value !== "string")
        return undefined;
    const normalized = value.trim();
    if (!normalized || Buffer.byteLength(normalized, "utf-8") > maxBytes)
        return undefined;
    return SAFE_LIFECYCLE_TOKEN.test(normalized) ? normalized : undefined;
}
function normalizeSupervisorRequestMetadata(request) {
    if (!request || typeof request !== "object" || Array.isArray(request))
        return undefined;
    const raw = request;
    const tool = raw.tool === "contact_supervisor" ? raw.tool : undefined;
    if (!tool)
        return undefined;
    const reason = raw.reason === "need_decision" || raw.reason === "interview_request" ? raw.reason : undefined;
    const requestId = boundLifecycleToken(raw.requestId);
    const summary = boundSupervisorSummary(raw.summary);
    return {
        tool,
        ...(reason ? { reason } : {}),
        ...(requestId ? { requestId } : {}),
        ...(summary ? { summary } : {}),
    };
}
function normalizePauseMetadata(pause) {
    if (!pause || typeof pause !== "object" || Array.isArray(pause))
        return undefined;
    const raw = pause;
    const kind = parsePauseKind(raw.kind);
    if (!kind)
        return undefined;
    const summary = boundSupervisorSummary(raw.summary);
    const requestedAt = parseTimestamp(raw.requestedAt);
    const pausedAt = parseTimestamp(raw.pausedAt);
    const ownerPid = parsePid(raw.ownerPid);
    const request = normalizeSupervisorRequestMetadata(raw.request);
    return {
        kind,
        ...(summary ? { summary } : {}),
        ...(requestedAt !== undefined ? { requestedAt } : {}),
        ...(pausedAt !== undefined ? { pausedAt } : {}),
        ...(ownerPid !== undefined ? { ownerPid } : {}),
        ...(request ? { request } : {}),
    };
}
function normalizeCancellationMetadata(cancel) {
    if (!cancel || typeof cancel !== "object" || Array.isArray(cancel))
        return undefined;
    const raw = cancel;
    const summary = boundSupervisorSummary(raw.summary);
    const cancelledAt = parseTimestamp(raw.cancelledAt);
    return {
        ...(summary ? { summary } : {}),
        ...(cancelledAt !== undefined ? { cancelledAt } : {}),
    };
}
function parseContinuationPhase(value) {
    return value === "claimed" ||
        value === "reserved" ||
        value === "launched" ||
        value === "continued"
        ? value
        : undefined;
}
function normalizeContinuationMetadata(continuation) {
    if (!continuation || typeof continuation !== "object" || Array.isArray(continuation))
        return undefined;
    const raw = continuation;
    const phase = parseContinuationPhase(raw.phase);
    const claimToken = boundLifecycleToken(raw.claimToken);
    const claimedAt = parseTimestamp(raw.claimedAt);
    const ownerPid = parsePid(raw.ownerPid);
    const launchedAt = parseTimestamp(raw.launchedAt);
    const continuedAt = parseTimestamp(raw.continuedAt);
    const continuationRunId = boundLifecycleToken(raw.continuationRunId);
    if (!phase &&
        !claimToken &&
        claimedAt === undefined &&
        ownerPid === undefined &&
        launchedAt === undefined &&
        continuedAt === undefined &&
        !continuationRunId)
        return undefined;
    return {
        ...(phase ? { phase } : {}),
        ...(claimToken ? { claimToken } : {}),
        ...(claimedAt !== undefined ? { claimedAt } : {}),
        ...(ownerPid !== undefined ? { ownerPid } : {}),
        ...(launchedAt !== undefined ? { launchedAt } : {}),
        ...(continuedAt !== undefined ? { continuedAt } : {}),
        ...(continuationRunId ? { continuationRunId } : {}),
    };
}
function normalizeContinuationIndexKey(value) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0)
        return String(value);
    if (typeof value !== "string" || !/^\d+$/.test(value))
        return undefined;
    return String(Number(value));
}
function normalizeContinuationMap(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const entries = Object.entries(value)
        .map(([key, continuation]) => {
        const normalizedKey = normalizeContinuationIndexKey(key);
        const normalizedContinuation = normalizeContinuationMetadata(continuation);
        return normalizedKey && normalizedContinuation
            ? [normalizedKey, normalizedContinuation]
            : undefined;
    })
        .filter((entry) => entry !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
export function lifecycleContinuationForIndex(status, index) {
    const normalizedIndex = normalizeContinuationIndexKey(index);
    if (!normalizedIndex)
        return undefined;
    const indexed = status?.lifecycle?.continuationsByIndex?.[normalizedIndex];
    if (indexed)
        return indexed;
    return index === 0 ? status?.lifecycle?.continuation : undefined;
}
export function withLifecycleContinuation(status, index, continuation) {
    const key = normalizeContinuationIndexKey(index);
    if (!key)
        return status.lifecycle ?? { generation: lifecycleGeneration(status) };
    const nextIndexed = { ...status.lifecycle?.continuationsByIndex };
    if (continuation)
        nextIndexed[key] = continuation;
    else
        delete nextIndexed[key];
    return {
        ...status.lifecycle,
        ...(index === 0 ? { continuation } : {}),
        ...(Object.keys(nextIndexed).length > 0 ? { continuationsByIndex: nextIndexed } : {}),
        ...(Object.keys(nextIndexed).length > 0 ? {} : { continuationsByIndex: undefined }),
    };
}
function hasActionablePausedChildren(status) {
    return (status?.some((step) => step.status === "paused" || step.status === "pausing" || step.status === "pending") ?? false);
}
function finalizeLifecycleContinuationStatus(status, index, continuation, continuedAt, continuationRunId) {
    const nextSteps = status.steps?.map((step, stepIndex) => stepIndex === index
        ? {
            ...step,
            status: "continued",
            endedAt: continuedAt,
            exitCode: 0,
            pause: undefined,
        }
        : step);
    const remainingActionable = hasActionablePausedChildren(nextSteps);
    const nextRootPause = remainingActionable
        ? nextSteps?.find((step) => step.pause?.kind === "awaiting_supervisor" &&
            (step.status === "paused" || step.status === "pausing"))?.pause
        : (status.steps?.length ?? 0) <= 1
            ? status.pause
            : undefined;
    return {
        ...status,
        state: remainingActionable ? "paused" : "continued",
        pid: undefined,
        endedAt: continuedAt,
        lastUpdate: continuedAt,
        pause: nextRootPause,
        lifecycle: withLifecycleContinuation(status, index, remainingActionable
            ? undefined
            : {
                ...continuation,
                phase: "continued",
                ownerPid: undefined,
                continuedAt,
                continuationRunId,
            }),
        steps: nextSteps,
    };
}
export function checkPidLiveness(pid, kill = process.kill) {
    try {
        kill(pid, 0);
        return "alive";
    }
    catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
            ? error.code
            : undefined;
        if (code === "ESRCH")
            return "dead";
        if (code === "EPERM")
            return "unknown";
        return "unknown";
    }
}
export function lifecycleGeneration(status) {
    const generation = status?.lifecycle?.generation;
    return typeof generation === "number" && Number.isInteger(generation) && generation >= 0
        ? generation
        : 0;
}
export function normalizeAsyncLifecycleStatus(status) {
    const pause = normalizePauseMetadata(status.pause);
    const cancel = normalizeCancellationMetadata(status.cancel);
    const continuation = normalizeContinuationMetadata(status.lifecycle?.continuation);
    const continuationsByIndex = normalizeContinuationMap(status.lifecycle?.continuationsByIndex);
    const generation = lifecycleGeneration(status);
    const activeRuntimeMs = normalizeActiveRuntimeMs(status.activeRuntimeMs);
    const activeRuntimeCheckpointAt = normalizeActiveRuntimeCheckpointAt(status.activeRuntimeCheckpointAt);
    const { activeRuntimeMs: _activeRuntimeMs, activeRuntimeCheckpointAt: _checkpointAt, ...rest } = status;
    const steps = status.steps?.map((step) => {
        const stepActiveRuntimeMs = normalizeActiveRuntimeMs(step.activeRuntimeMs);
        const stepCheckpointAt = normalizeActiveRuntimeCheckpointAt(step.activeRuntimeCheckpointAt);
        const { activeRuntimeMs: _stepActiveRuntimeMs, activeRuntimeCheckpointAt: _stepCheckpointAt, ...stepRest } = step;
        return {
            ...stepRest,
            ...(stepActiveRuntimeMs !== undefined ? { activeRuntimeMs: stepActiveRuntimeMs } : {}),
            ...(stepCheckpointAt !== undefined ? { activeRuntimeCheckpointAt: stepCheckpointAt } : {}),
        };
    });
    return {
        ...rest,
        ...(activeRuntimeMs !== undefined ? { activeRuntimeMs } : {}),
        ...(activeRuntimeCheckpointAt !== undefined ? { activeRuntimeCheckpointAt } : {}),
        ...(typeof status.state === "string"
            ? { state: status.state }
            : { state: "failed" }),
        ...(pause ? { pause } : {}),
        ...(pause ? {} : { pause: undefined }),
        ...(cancel ? { cancel } : {}),
        ...(cancel ? {} : { cancel: undefined }),
        ...(steps !== undefined ? { steps } : {}),
        lifecycle: {
            generation,
            ...(continuation ? { continuation } : {}),
            ...(continuationsByIndex ? { continuationsByIndex } : {}),
        },
    };
}
function statusPath(asyncDir) {
    return path.join(asyncDir, "status.json");
}
function readLifecycleStatus(asyncDir) {
    try {
        return normalizeAsyncLifecycleStatus(JSON.parse(fs.readFileSync(statusPath(asyncDir), "utf-8")));
    }
    catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
            ? error.code
            : undefined;
        if (code === "ENOENT")
            return null;
        throw error;
    }
}
export function writeNormalizedLifecycleStatus(asyncDir, status) {
    const normalized = normalizeAsyncLifecycleStatus(status);
    const filePath = statusPath(asyncDir);
    writeAtomicJson(filePath, normalized);
    invalidateStatusCache(filePath);
    return normalized;
}
export const TERMINAL_RUN_STATES = new Set([
    "continued",
    "cancelled",
    "failed",
    "complete",
]);
const TERMINAL_STEP_STATUSES = new Set([
    "continued",
    "cancelled",
    "failed",
    "complete",
    "completed",
]);
function mergeActiveRuntimeEvidence(inMemory, persisted) {
    const values = [
        normalizeActiveRuntimeMs(inMemory.activeRuntimeMs),
        normalizeActiveRuntimeMs(persisted?.activeRuntimeMs),
    ].filter((value) => value !== undefined);
    const checkpoints = [
        normalizeActiveRuntimeCheckpointAt(inMemory.activeRuntimeCheckpointAt),
        normalizeActiveRuntimeCheckpointAt(persisted?.activeRuntimeCheckpointAt),
    ].filter((value) => value !== undefined);
    return {
        ...(values.length > 0 ? { activeRuntimeMs: Math.max(...values) } : {}),
        ...(checkpoints.length > 0 ? { activeRuntimeCheckpointAt: Math.max(...checkpoints) } : {}),
    };
}
function mergeAndWriteStatus(asyncDir, inMemory, persisted) {
    if (!persisted) {
        return writeNormalizedLifecycleStatus(asyncDir, inMemory);
    }
    const persistedGen = lifecycleGeneration(persisted);
    const inMemoryGen = lifecycleGeneration(inMemory);
    const lifecycle = persistedGen > inMemoryGen ? persisted.lifecycle : inMemory.lifecycle;
    let state = inMemory.state;
    if (TERMINAL_RUN_STATES.has(persisted.state) && persisted.state !== state) {
        state = persisted.state;
    }
    const steps = inMemory.steps?.map((step, i) => {
        const persistedStep = persisted.steps?.[i];
        const runtimeStep = { ...step, ...mergeActiveRuntimeEvidence(step, persistedStep) };
        if (!persistedStep || !TERMINAL_STEP_STATUSES.has(persistedStep.status))
            return runtimeStep;
        const lifecycleOverrides = {
            status: persistedStep.status,
            endedAt: persistedStep.endedAt,
            exitCode: persistedStep.exitCode,
            cancel: persistedStep.cancel,
            error: persistedStep.error,
            pause: undefined,
        };
        if (persistedStep.status === runtimeStep.status) {
            return { ...runtimeStep, ...lifecycleOverrides };
        }
        return { ...runtimeStep, ...lifecycleOverrides };
    });
    const terminalRunOverrides = TERMINAL_RUN_STATES.has(persisted.state) && persisted.state !== inMemory.state
        ? {
            cancel: persisted.cancel,
            endedAt: persisted.endedAt,
            error: persisted.error,
            pid: undefined,
            pause: undefined,
        }
        : {};
    const merged = {
        ...inMemory,
        ...mergeActiveRuntimeEvidence(inMemory, persisted),
        ...terminalRunOverrides,
        state,
        ...(steps !== undefined ? { steps } : {}),
        lifecycle,
    };
    return writeNormalizedLifecycleStatus(asyncDir, merged);
}
export function mergeAndWriteSourceRunnerStatus(asyncDir, inMemory) {
    try {
        return withLifecycleStatusLock(asyncDir, (persisted) => mergeAndWriteStatus(asyncDir, inMemory, persisted));
    }
    catch (error) {
        if (!(error instanceof LifecycleLockExhaustedError))
            throw error;
        const persisted = readLifecycleStatus(asyncDir);
        return persisted ?? inMemory;
    }
}
function waitSync(delayMs) {
    if (delayMs <= 0)
        return;
    if (WAIT_VIEW) {
        try {
            Atomics.wait(WAIT_VIEW, 0, 0, delayMs);
            return;
        }
        catch {
        }
    }
    const end = Date.now() + delayMs;
    while (Date.now() < end) {
        void 0;
    }
}
function runLabel(asyncDir) {
    const base = path.basename(path.resolve(asyncDir));
    return base || "unknown-run";
}
function transitionLockDir(asyncDir) {
    return path.join(asyncDir, ".lifecycle-transition.lock");
}
function transitionLockInfoPath(asyncDir) {
    return path.join(transitionLockDir(asyncDir), "owner.json");
}
function transitionLockOwnerSummary(owner) {
    const details = [
        owner.pid !== undefined ? `pid ${owner.pid}` : undefined,
        owner.acquiredAt !== undefined
            ? `acquired ${new Date(owner.acquiredAt).toISOString()}`
            : undefined,
    ].filter(Boolean);
    return details.length > 0 ? details.join(", ") : undefined;
}
function readTransitionLockOwner(asyncDir) {
    try {
        const raw = JSON.parse(fs.readFileSync(transitionLockInfoPath(asyncDir), "utf-8"));
        return {
            token: boundLifecycleToken(raw.token),
            pid: parsePid(raw.pid),
            acquiredAt: parseTimestamp(raw.acquiredAt),
        };
    }
    catch {
        return {};
    }
}
function readTransitionLockSnapshot(asyncDir) {
    try {
        const stats = fs.statSync(transitionLockDir(asyncDir));
        return {
            mtimeMs: stats.mtimeMs,
            owner: readTransitionLockOwner(asyncDir),
        };
    }
    catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
            ? error.code
            : undefined;
        if (code === "ENOENT")
            return undefined;
        throw error;
    }
}
function isCompleteTransitionLockOwner(owner) {
    return (typeof owner.token === "string" &&
        owner.token.length > 0 &&
        typeof owner.pid === "number" &&
        typeof owner.acquiredAt === "number");
}
function tryRecoverStaleTransitionLock(asyncDir, options = {}) {
    const snapshot = readTransitionLockSnapshot(asyncDir);
    if (!snapshot)
        return false;
    const now = options.now?.() ?? Date.now();
    const ownerlessStaleMs = options.ownerlessStaleMs ?? DEFAULT_OWNERLESS_LOCK_STALE_MS;
    if (isCompleteTransitionLockOwner(snapshot.owner)) {
        if (checkPidLiveness(snapshot.owner.pid, options.kill) !== "dead")
            return false;
        const latest = readTransitionLockSnapshot(asyncDir);
        if (!latest || !isCompleteTransitionLockOwner(latest.owner))
            return false;
        if (latest.owner.token !== snapshot.owner.token ||
            latest.owner.pid !== snapshot.owner.pid ||
            latest.owner.acquiredAt !== snapshot.owner.acquiredAt) {
            return false;
        }
    }
    else {
        if (now - snapshot.mtimeMs < ownerlessStaleMs)
            return false;
        const latest = readTransitionLockSnapshot(asyncDir);
        if (!latest || isCompleteTransitionLockOwner(latest.owner))
            return false;
        if (latest.mtimeMs !== snapshot.mtimeMs || now - latest.mtimeMs < ownerlessStaleMs)
            return false;
    }
    try {
        fs.rmSync(transitionLockDir(asyncDir), { recursive: true, force: false });
        return true;
    }
    catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
            ? error.code
            : undefined;
        if (code === "ENOENT")
            return false;
        throw error;
    }
}
function acquireTransitionLock(asyncDir, options = {}) {
    const lockDir = transitionLockDir(asyncDir);
    const owner = {
        token: randomUUID(),
        pid: process.pid,
        acquiredAt: options.now?.() ?? Date.now(),
    };
    const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_LOCK_RETRY_DELAYS_MS;
    fs.mkdirSync(asyncDir, { recursive: true });
    for (let attempt = 0;; attempt++) {
        try {
            fs.mkdirSync(lockDir);
            break;
        }
        catch (error) {
            const code = typeof error === "object" && error !== null && "code" in error
                ? error.code
                : undefined;
            if (code !== "EEXIST")
                throw error;
            if (tryRecoverStaleTransitionLock(asyncDir, options))
                continue;
            const delayMs = retryDelaysMs[attempt];
            if (delayMs !== undefined) {
                waitSync(delayMs);
                continue;
            }
            const ownerSummary = transitionLockOwnerSummary(readTransitionLockOwner(asyncDir));
            throw new LifecycleLockExhaustedError(`Lifecycle transition rejected for run '${runLabel(asyncDir)}': another transition holds the status lock${ownerSummary ? ` (${ownerSummary})` : ""}. Wait for it to finish or clear the stale lifecycle lock only after verifying the run is idle.`, { cause: error });
        }
    }
    try {
        fs.writeFileSync(transitionLockInfoPath(asyncDir), JSON.stringify(owner, null, 2), "utf-8");
    }
    catch (error) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        throw error;
    }
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        try {
            if (readTransitionLockOwner(asyncDir).token !== owner.token)
                return;
            fs.rmSync(lockDir, { recursive: true, force: true });
        }
        catch {
        }
    };
}
export function withLifecycleStatusLock(asyncDir, operation, options = {}) {
    const releaseLock = acquireTransitionLock(asyncDir, options);
    try {
        return operation(readLifecycleStatus(asyncDir));
    }
    finally {
        releaseLock();
    }
}
export function transitionLifecycleStatus(options) {
    return withLifecycleStatusLock(options.asyncDir, (current) => {
        if (!current)
            throw new Error(`Cannot transition lifecycle state for run '${runLabel(options.asyncDir)}': persisted status was not found.`);
        const normalizedCurrent = normalizeAsyncLifecycleStatus(current);
        const currentGeneration = lifecycleGeneration(normalizedCurrent);
        if (currentGeneration !== options.expectedGeneration) {
            throw new Error(`Lifecycle transition rejected for run '${runLabel(options.asyncDir)}': expected generation ${options.expectedGeneration}, found ${currentGeneration}.`);
        }
        const mutated = normalizeAsyncLifecycleStatus(options.mutate(normalizedCurrent));
        const nextStatus = {
            ...mutated,
            lifecycle: {
                ...mutated.lifecycle,
                generation: currentGeneration + 1,
            },
        };
        writeNormalizedLifecycleStatus(options.asyncDir, nextStatus);
        return {
            previousGeneration: currentGeneration,
            nextGeneration: currentGeneration + 1,
            status: nextStatus,
        };
    }, options.lockOptions);
}
function continuationTargetExists(sourceAsyncDir, continuationRunId, options) {
    const asyncDirRoot = path.resolve(options.asyncDirRoot ?? path.dirname(path.resolve(sourceAsyncDir)));
    const asyncTargetDir = path.join(asyncDirRoot, continuationRunId);
    if (fs.existsSync(asyncTargetDir))
        return true;
    if (options.resultsDir &&
        fs.existsSync(path.join(options.resultsDir, `${continuationRunId}.json`)))
        return true;
    return false;
}
export function markLifecycleContinuationSpawned(asyncDir, index, claimToken, continuationRunId, options = {}) {
    const current = readLifecycleStatus(asyncDir);
    if (!current)
        return { status: null, transitioned: false, final: false, lost: true };
    const continuation = lifecycleContinuationForIndex(current, index);
    if (current.state === "continued" || current.steps?.[index]?.status === "continued") {
        const sameTarget = continuation?.claimToken === claimToken &&
            continuation.continuationRunId === continuationRunId;
        return { status: current, transitioned: false, final: sameTarget, lost: !sameTarget };
    }
    if (continuation?.claimToken !== claimToken ||
        continuation.continuationRunId !== continuationRunId) {
        return { status: current, transitioned: false, final: false, lost: true };
    }
    if (continuation.phase === "launched" || continuation.phase === "continued") {
        return {
            status: current,
            transitioned: false,
            final: continuation.phase === "continued",
            lost: false,
        };
    }
    const launchedAt = options.now?.() ?? Date.now();
    try {
        const transitioned = transitionLifecycleStatus({
            asyncDir,
            expectedGeneration: lifecycleGeneration(current),
            mutate: (status) => ({
                ...status,
                lastUpdate: launchedAt,
                lifecycle: withLifecycleContinuation(status, index, {
                    ...continuation,
                    phase: "launched",
                    ownerPid: undefined,
                    launchedAt,
                    continuationRunId,
                }),
            }),
        });
        return { status: transitioned.status, transitioned: true, final: false, lost: false };
    }
    catch (error) {
        if (error instanceof Error && /expected generation/.test(error.message)) {
            return markLifecycleContinuationSpawned(asyncDir, index, claimToken, continuationRunId, options);
        }
        throw error;
    }
}
export function finalizeLifecycleContinuationLaunch(asyncDir, index, claimToken, continuationRunId, options = {}) {
    const current = readLifecycleStatus(asyncDir);
    if (!current)
        return { status: null, finalized: false, lost: true };
    const continuation = lifecycleContinuationForIndex(current, index);
    if (current.state === "continued" || current.steps?.[index]?.status === "continued") {
        const sameTarget = continuation?.claimToken === claimToken &&
            continuation.continuationRunId === continuationRunId;
        return { status: current, finalized: sameTarget, lost: !sameTarget };
    }
    if (continuation?.claimToken !== claimToken ||
        continuation.continuationRunId !== continuationRunId) {
        return { status: current, finalized: false, lost: true };
    }
    const continuedAt = options.now?.() ?? Date.now();
    try {
        const transitioned = transitionLifecycleStatus({
            asyncDir,
            expectedGeneration: lifecycleGeneration(current),
            mutate: (status) => finalizeLifecycleContinuationStatus(status, index, continuation, continuedAt, continuationRunId),
        });
        return { status: transitioned.status, finalized: true, lost: false };
    }
    catch (error) {
        if (error instanceof Error && /expected generation/.test(error.message)) {
            return finalizeLifecycleContinuationLaunch(asyncDir, index, claimToken, continuationRunId, options);
        }
        throw error;
    }
}
export function recoverStaleLifecycleContinuationStatus(current, asyncDir, index, options = {}) {
    const continuation = lifecycleContinuationForIndex(current, index);
    if (!continuation?.claimToken)
        return { status: current, recovered: false, liveness: "unclaimed" };
    if (continuation.continuedAt !== undefined ||
        continuation.phase === "continued" ||
        current.state === "continued" ||
        current.steps?.[index]?.status === "continued") {
        return { status: current, recovered: false, liveness: "completed" };
    }
    if (continuation.ownerPid === undefined) {
        if (continuation.continuationRunId)
            return { status: current, recovered: false, liveness: "blocked" };
        return { status: current, recovered: false, liveness: "missing-owner" };
    }
    const liveness = checkPidLiveness(continuation.ownerPid, options.kill);
    if (liveness !== "dead")
        return { status: current, recovered: false, liveness };
    if (continuation.continuationRunId &&
        continuationTargetExists(asyncDir, continuation.continuationRunId, options)) {
        return { status: current, recovered: false, liveness: "blocked" };
    }
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
export function recoverStaleLifecycleContinuationClaim(asyncDir, index, options = {}) {
    const current = readLifecycleStatus(asyncDir);
    if (!current)
        return { status: null, recovered: false, liveness: "unclaimed" };
    const inspected = recoverStaleLifecycleContinuationStatus(current, asyncDir, index, options);
    if (!inspected.recovered)
        return inspected;
    const expectedGeneration = lifecycleGeneration(current);
    const inspectedClaimToken = lifecycleContinuationForIndex(current, index)?.claimToken;
    return withLifecycleStatusLock(asyncDir, (lockedStatus) => {
        if (!lockedStatus) {
            throw new Error(`Cannot transition lifecycle state for run '${runLabel(asyncDir)}': persisted status was not found.`);
        }
        const normalizedLockedStatus = normalizeAsyncLifecycleStatus(lockedStatus);
        const lockedGeneration = lifecycleGeneration(normalizedLockedStatus);
        if (lockedGeneration !== expectedGeneration) {
            return { status: normalizedLockedStatus, recovered: false, liveness: inspected.liveness };
        }
        const rechecked = recoverStaleLifecycleContinuationStatus(normalizedLockedStatus, asyncDir, index, options);
        if (!rechecked.recovered)
            return rechecked;
        if (lifecycleContinuationForIndex(normalizedLockedStatus, index)?.claimToken !==
            inspectedClaimToken) {
            return { status: normalizedLockedStatus, recovered: false, liveness: rechecked.liveness };
        }
        const recoveryLastUpdate = rechecked.status.lastUpdate ?? Date.now();
        const lastUpdate = typeof normalizedLockedStatus.lastUpdate === "number" &&
            Number.isFinite(normalizedLockedStatus.lastUpdate)
            ? Math.max(normalizedLockedStatus.lastUpdate, recoveryLastUpdate)
            : recoveryLastUpdate;
        const nextStatus = writeNormalizedLifecycleStatus(asyncDir, {
            ...normalizedLockedStatus,
            lastUpdate,
            lifecycle: {
                ...withLifecycleContinuation(normalizedLockedStatus, index, undefined),
                generation: lockedGeneration + 1,
            },
        });
        return { status: nextStatus, recovered: true, liveness: rechecked.liveness };
    }, options);
}
export function recoverStoppedLifecycleOwnership(status, options = {}) {
    const normalized = normalizeAsyncLifecycleStatus(status);
    if ((normalized.state !== "paused" &&
        normalized.state !== "cancelled" &&
        normalized.state !== "continued" &&
        normalized.state !== "pausing") ||
        typeof normalized.pid !== "number") {
        return { status: normalized, repaired: false };
    }
    const now = options.now?.() ?? normalized.lastUpdate;
    const pidLiveness = checkPidLiveness(normalized.pid, options.kill);
    const pause = normalized.pause
        ? {
            ...normalized.pause,
            ownerPid: undefined,
        }
        : undefined;
    if (normalized.state === "pausing") {
        if (pidLiveness !== "dead")
            return { status: normalized, repaired: false, pidLiveness };
        const hasResumeCheckpoint = Boolean(pause?.kind &&
            (pause.requestedAt !== undefined || pause.pausedAt !== undefined) &&
            (normalized.sessionFile ||
                normalized.steps?.some((step) => typeof step.sessionFile === "string" && step.sessionFile.length > 0)));
        if (!hasResumeCheckpoint)
            return { status: normalized, repaired: false, pidLiveness };
        const pausedAt = pause?.pausedAt ?? now ?? Date.now();
        return {
            status: {
                ...normalized,
                state: "paused",
                pid: undefined,
                endedAt: normalized.endedAt ?? pausedAt,
                lastUpdate: now ?? pausedAt,
                ...(pause ? { pause: { ...pause, pausedAt } } : {}),
                steps: normalized.steps?.map((step) => step.status === "pausing"
                    ? { ...step, status: "paused", endedAt: step.endedAt ?? pausedAt, exitCode: 0 }
                    : step),
            },
            repaired: true,
            pidLiveness,
        };
    }
    const repaired = {
        ...normalized,
        pid: undefined,
        ...(pause ? { pause } : {}),
        lastUpdate: now,
    };
    return { status: repaired, repaired: true, pidLiveness };
}

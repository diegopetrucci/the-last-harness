import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { waitSync, writeAtomicJson } from "../../shared/atomic-json.js";
import { invalidateStatusCache, readStatus } from "../../shared/utils.js";
import { boundSubagentAttemptFacts, parseSubagentTerminalResult, terminalResultForStatusStep, } from "../../shared/terminal-result.js";
import { canonicalLifecycleState, canonicalLifecycleStepState, } from "../background/async-status-boundary.js";
import { normalizeIdleEpisodeId } from "./subagent-control.js";
const DEFAULT_MAX_SUMMARY_BYTES = 280;
const DEFAULT_MAX_TOKEN_BYTES = 120;
const SAFE_LIFECYCLE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DEFAULT_LOCK_RETRY_DELAYS_MS = [10, 25, 50, 100, 200];
const TERMINAL_RUN_STATES = new Set(["complete", "failed", "cancelled", "paused"]);
const ACTIVE_RUN_STATES = new Set(["queued", "running", "pausing"]);
export const isActiveLifecycleState = (value) => ACTIVE_RUN_STATES.has(canonicalLifecycleState(value));
export const isTerminalLifecycleState = (value) => TERMINAL_RUN_STATES.has(canonicalLifecycleState(value));
export const isCompletedLifecycleState = (value) => canonicalLifecycleState(value) === "complete";
export const isCompletedLifecycleStepState = (value) => canonicalLifecycleStepState(value) === "complete";
class LifecycleLockExhaustedError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "LifecycleLockExhaustedError";
    }
}
export class LifecycleGenerationConflictError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "LifecycleGenerationConflictError";
    }
}
export const isLifecycleTransitionContentionError = (error) => error instanceof LifecycleGenerationConflictError || error instanceof LifecycleLockExhaustedError;
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const codeOf = (error) => isRecord(error) && typeof error.code === "string" ? error.code : undefined;
const finiteTimestamp = (value) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const positivePid = (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
function boundedToken(value, maxBytes = DEFAULT_MAX_TOKEN_BYTES) {
    if (typeof value !== "string")
        return undefined;
    const token = value.trim();
    return token && Buffer.byteLength(token, "utf8") <= maxBytes && SAFE_LIFECYCLE_TOKEN.test(token)
        ? token
        : undefined;
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
    while (Buffer.byteLength(bounded, "utf8") > maxBytes && bounded.length > 1)
        bounded = `${bounded.slice(0, -2).trimEnd()}…`;
    return bounded;
}
function definedObject(entries) {
    return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}
function normalizePause(value) {
    if (!isRecord(value))
        return undefined;
    const kind = value.kind === "awaiting_supervisor" || value.kind === "cohort_pause" ? value.kind : undefined;
    if (!kind)
        return undefined;
    const request = isRecord(value.request) && value.request.tool === "contact_supervisor"
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
    return definedObject([
        ["kind", kind],
        ["summary", boundSupervisorSummary(value.summary)],
        ["requestedAt", finiteTimestamp(value.requestedAt)],
        ["pausedAt", finiteTimestamp(value.pausedAt)],
        ["ownerPid", positivePid(value.ownerPid)],
        ["request", request],
    ]);
}
const CONTINUATION_PHASES = new Set(["claimed", "reserved", "launched", "completed", "continued"]);
function normalizeContinuation(value) {
    if (!isRecord(value))
        return undefined;
    const phase = CONTINUATION_PHASES.has(String(value.phase))
        ? value.phase
        : undefined;
    const result = definedObject([
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
function continuationKey(value) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
        return String(value);
    if (typeof value !== "string" || !/^\d+$/.test(value))
        return undefined;
    const number = Number(value);
    return Number.isSafeInteger(number) ? String(number) : undefined;
}
function normalizeContinuationMap(value) {
    if (!isRecord(value))
        return undefined;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
        const normalizedKey = continuationKey(key);
        const continuation = normalizeContinuation(item);
        if (normalizedKey && continuation)
            result[normalizedKey] = continuation;
    }
    return Object.keys(result).length ? result : undefined;
}
export function lifecycleContinuationForIndex(status, index) {
    const key = continuationKey(index);
    return key
        ? (status?.lifecycle?.continuationsByIndex?.[key] ??
            (index === 0 ? status?.lifecycle?.continuation : undefined))
        : undefined;
}
export function withLifecycleContinuation(status, index, continuation) {
    const key = continuationKey(index);
    const current = status.lifecycle ?? { generation: lifecycleGeneration(status) };
    if (!key)
        return current;
    const byIndex = { ...current.continuationsByIndex };
    if (continuation)
        byIndex[key] = continuation;
    else
        delete byIndex[key];
    const next = { ...current };
    if (index === 0) {
        if (continuation)
            next.continuation = continuation;
        else
            delete next.continuation;
    }
    if (Object.keys(byIndex).length)
        next.continuationsByIndex = byIndex;
    else
        delete next.continuationsByIndex;
    return next;
}
const RETIRED_FIELDS = [
    "activeRuntimeMs",
    "activeRuntimeCheckpointAt",
    "durableAttentionReasons",
];
function normalizeRecord(raw, fields) {
    const result = { ...raw };
    for (const field of [...RETIRED_FIELDS, ...fields])
        delete result[field];
    if (raw.activityState === "needs_attention")
        result.activityState = raw.activityState;
    const terminalResult = parseSubagentTerminalResult(raw.terminalResult);
    if (terminalResult)
        result.terminalResult = terminalResult;
    else
        delete result.terminalResult;
    return result;
}
function normalizeStep(value) {
    const raw = value;
    const result = normalizeRecord(raw, ["activityState", "compaction"]);
    const idleEpisodeId = normalizeIdleEpisodeId(raw.idleEpisodeId);
    const compaction = isRecord(raw.compaction) &&
        (raw.compaction.reason === "manual" ||
            raw.compaction.reason === "threshold" ||
            raw.compaction.reason === "overflow")
        ? { reason: raw.compaction.reason }
        : undefined;
    if (idleEpisodeId)
        result.idleEpisodeId = idleEpisodeId;
    if (compaction)
        result.compaction = compaction;
    result.status = canonicalLifecycleStepState(raw.status);
    return result;
}
export function normalizeAsyncLifecycleStatus(status) {
    const raw = status;
    const lifecycle = isRecord(raw.lifecycle) ? raw.lifecycle : undefined;
    const result = normalizeRecord(raw, ["activityState", "lifecycle", "pause", "cancel", "steps"]);
    const pause = normalizePause(raw.pause);
    const cancel = isRecord(raw.cancel)
        ? definedObject([
            ["summary", boundSupervisorSummary(raw.cancel.summary)],
            ["cancelledAt", finiteTimestamp(raw.cancel.cancelledAt)],
        ])
        : undefined;
    const normalizedContinuation = normalizeContinuation(lifecycle?.continuation);
    const normalizedByIndex = normalizeContinuationMap(lifecycle?.continuationsByIndex);
    const resumeBlockedReason = lifecycle?.resumeBlockedReason === "supervisor_lifecycle_failure"
        ? lifecycle.resumeBlockedReason
        : undefined;
    result.state = canonicalLifecycleState(raw.state);
    if (pause)
        result.pause = pause;
    if (cancel)
        result.cancel = cancel;
    if (Array.isArray(raw.steps))
        result.steps = raw.steps.map(normalizeStep);
    result.lifecycle = {
        generation: lifecycleGeneration(status),
        ...(resumeBlockedReason ? { resumeBlockedReason } : {}),
        ...(normalizedContinuation ? { continuation: normalizedContinuation } : {}),
        ...(normalizedByIndex ? { continuationsByIndex: normalizedByIndex } : {}),
    };
    return result;
}
export function writeNormalizedLifecycleStatus(asyncDir, status) {
    const normalized = normalizeAsyncLifecycleStatus(status);
    const statusFile = path.join(asyncDir, "status.json");
    writeAtomicJson(statusFile, normalized);
    invalidateStatusCache(statusFile);
    return normalized;
}
const runLabel = (asyncDir) => path.basename(path.resolve(asyncDir)) || "unknown-run";
const lockDir = (asyncDir) => path.join(asyncDir, ".lifecycle-transition.lock");
const ownerPath = (asyncDir) => path.join(lockDir(asyncDir), "owner.json");
function readLockOwner(asyncDir) {
    try {
        const parsed = JSON.parse(fs.readFileSync(ownerPath(asyncDir), "utf8"));
        return isRecord(parsed)
            ? {
                token: boundedToken(parsed.token),
                pid: positivePid(parsed.pid),
                acquiredAt: finiteTimestamp(parsed.acquiredAt),
            }
            : {};
    }
    catch {
        return {};
    }
}
function lockSnapshot(asyncDir) {
    try {
        fs.statSync(lockDir(asyncDir));
        return readLockOwner(asyncDir);
    }
    catch (error) {
        if (codeOf(error) === "ENOENT")
            return undefined;
        throw error;
    }
}
function completeOwner(owner) {
    return owner.token !== undefined && owner.pid !== undefined && owner.acquiredAt !== undefined;
}
export function checkPidLiveness(pid, kill = process.kill) {
    try {
        kill(pid, 0);
        return "alive";
    }
    catch (error) {
        return codeOf(error) === "ESRCH" ? "dead" : "unknown";
    }
}
function liveLock(asyncDir) {
    try {
        const snapshot = lockSnapshot(asyncDir);
        if (!snapshot)
            return false;
        return !completeOwner(snapshot) || checkPidLiveness(snapshot.pid) !== "dead";
    }
    catch {
        return true;
    }
}
function recoverLock(asyncDir, options) {
    const snapshot = lockSnapshot(asyncDir);
    if (!snapshot)
        return false;
    const owner = snapshot;
    if (!completeOwner(owner) || checkPidLiveness(owner.pid, options.kill) !== "dead")
        return false;
    const latest = lockSnapshot(asyncDir);
    if (!latest ||
        !completeOwner(latest) ||
        latest.token !== owner.token ||
        latest.pid !== owner.pid ||
        latest.acquiredAt !== owner.acquiredAt)
        return false;
    try {
        fs.rmSync(lockDir(asyncDir), { recursive: true, force: false });
        return true;
    }
    catch (error) {
        if (codeOf(error) === "ENOENT")
            return false;
        throw error;
    }
}
function acquireLock(asyncDir, options) {
    fs.mkdirSync(asyncDir, { recursive: true });
    const directory = lockDir(asyncDir);
    const owner = {
        token: randomUUID(),
        pid: process.pid,
        acquiredAt: options.now?.() ?? Date.now(),
    };
    const delays = options.retryDelaysMs ?? DEFAULT_LOCK_RETRY_DELAYS_MS;
    for (let attempt = 0;; attempt++) {
        try {
            fs.mkdirSync(directory);
            break;
        }
        catch (error) {
            if (codeOf(error) !== "EEXIST")
                throw error;
            if (recoverLock(asyncDir, options))
                continue;
            const delay = delays[attempt];
            if (delay !== undefined) {
                waitSync(delay);
                continue;
            }
            const held = readLockOwner(asyncDir);
            const acquired = held.acquiredAt === undefined ? "unknown time" : new Date(held.acquiredAt).toISOString();
            throw new LifecycleLockExhaustedError(`Lifecycle transition rejected for run '${runLabel(asyncDir)}': status lock (pid ${held.pid ?? "unknown"}, acquired ${acquired}) is held by another transition.`, { cause: error });
        }
    }
    try {
        fs.writeFileSync(ownerPath(asyncDir), JSON.stringify(owner), { encoding: "utf8", mode: 0o600 });
    }
    catch (error) {
        fs.rmSync(directory, { recursive: true, force: true });
        throw error;
    }
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        try {
            if (readLockOwner(asyncDir).token === owner.token)
                fs.rmSync(directory, { recursive: true, force: true });
        }
        catch {
        }
    };
}
export function withLifecycleStatusLock(asyncDir, operation, options = {}) {
    const release = acquireLock(asyncDir, options);
    try {
        return operation(readStatus(asyncDir, { cache: false }));
    }
    finally {
        release();
    }
}
const immutableTerminal = (value) => isTerminalLifecycleState(value) && value !== "paused";
export const lifecycleGeneration = (status) => {
    const generation = status?.lifecycle?.generation;
    return typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0
        ? generation
        : 0;
};
export function transitionLifecycleStatus(options) {
    return withLifecycleStatusLock(options.asyncDir, (current) => {
        if (!current)
            throw new Error(`Cannot transition lifecycle state for run '${runLabel(options.asyncDir)}': persisted status was not found.`);
        const generation = lifecycleGeneration(current);
        if (generation !== options.expectedGeneration)
            throw new LifecycleGenerationConflictError(`Lifecycle transition rejected for run '${runLabel(options.asyncDir)}': expected generation ${options.expectedGeneration}, found ${generation}.`);
        const mutated = normalizeAsyncLifecycleStatus(options.mutate(current));
        const next = immutableTerminal(current.state) && mutated.state !== current.state
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
    }, options.lockOptions);
}
const SAFE_ROOT_FACTS = [
    "sessionFile",
    "processCleanup",
    "endedAt",
    "terminalResult",
    "totalTokens",
    "totalCost",
];
const TERMINAL_ONLY_ROOT_FACTS = new Set(["endedAt", "terminalResult"]);
const SAFE_NONTERMINAL_ROOT_FACTS = SAFE_ROOT_FACTS.filter((field) => !TERMINAL_ONLY_ROOT_FACTS.has(field));
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
];
const TERMINAL_ONLY_STEP_FACTS = new Set([
    "exitCode",
    "exitSignal",
    "endedAt",
    "durationMs",
    "terminationReason",
    "terminalResult",
]);
const SAFE_NONTERMINAL_STEP_FACTS = SAFE_STEP_FACTS.filter((field) => !TERMINAL_ONLY_STEP_FACTS.has(field));
const IMMUTABLE_STEP_STATES = new Set(["complete", "failed", "cancelled"]);
function recordOf(value) {
    return { ...value };
}
function appendMissing(target, source, fields) {
    for (const field of fields)
        if (target[field] === undefined && source[field] !== undefined)
            target[field] = source[field];
}
function maxNumber(left, right) {
    const values = [left, right].filter((value) => typeof value === "number" && Number.isFinite(value));
    return values.length ? Math.max(...values) : undefined;
}
function projectTerminalResult(result, status) {
    if (!result)
        return undefined;
    return terminalResultForStatusStep({ terminalResult: result }, canonicalLifecycleStepState(status));
}
function mergeTerminalResult(persisted, memory, status) {
    const left = parseSubagentTerminalResult(persisted);
    const right = parseSubagentTerminalResult(memory);
    if (!left)
        return projectTerminalResult(right, status);
    if (!right)
        return projectTerminalResult(left, status);
    const attempts = new Map(left.facts.attempts.map((attempt) => [attempt.attempt, attempt]));
    for (const attempt of right.facts.attempts)
        if (!attempts.has(attempt.attempt))
            attempts.set(attempt.attempt, attempt);
    return projectTerminalResult({
        state: left.state,
        facts: {
            attempts: boundSubagentAttemptFacts([...attempts.values()].sort((a, b) => a.attempt - b.attempt)),
        },
    }, status);
}
function mergeStep(persisted, memory, changed) {
    if (!persisted)
        return changed ? undefined : memory;
    if (!memory)
        return persisted;
    const immutable = IMMUTABLE_STEP_STATES.has(canonicalLifecycleStepState(persisted.status));
    if (changed || immutable) {
        const merged = { ...persisted };
        appendMissing(merged, recordOf(memory), immutable ? SAFE_STEP_FACTS : SAFE_NONTERMINAL_STEP_FACTS);
        if (!changed && Object.hasOwn(memory, "compaction")) {
            if (memory.compaction)
                merged.compaction = memory.compaction;
            else
                delete merged.compaction;
        }
        if (immutable) {
            const terminalResult = mergeTerminalResult(persisted.terminalResult, memory.terminalResult, persisted.status);
            if (terminalResult)
                merged.terminalResult = terminalResult;
        }
        return merged;
    }
    return { ...persisted, ...memory };
}
function mergeStatus(current, memory, changed) {
    if (changed) {
        const merged = { ...current };
        appendMissing(merged, recordOf(memory), immutableTerminal(current.state) ? SAFE_ROOT_FACTS : SAFE_NONTERMINAL_ROOT_FACTS);
        if (current.steps)
            merged.steps = current.steps
                .map((step, index) => mergeStep(step, memory.steps?.[index], true))
                .filter((step) => step !== undefined);
        return merged;
    }
    const currentState = canonicalLifecycleState(current.state);
    const memoryState = canonicalLifecycleState(memory.state);
    const immutable = immutableTerminal(currentState);
    const continuationsByIndex = {
        ...current.lifecycle?.continuationsByIndex,
        ...memory.lifecycle?.continuationsByIndex,
    };
    const root = immutable && currentState !== memoryState
        ? { ...current }
        : immutable
            ? { ...current }
            : { ...current, ...memory };
    const rootRecord = root;
    if (immutable)
        appendMissing(rootRecord, recordOf(memory), SAFE_ROOT_FACTS);
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
        ...(steps ? { steps: steps.filter((step) => step !== undefined) } : {}),
    };
}
export function mergeAndWriteSourceRunnerStatus(asyncDir, inMemory) {
    const memoryGeneration = lifecycleGeneration(inMemory);
    try {
        return withLifecycleStatusLock(asyncDir, (persisted) => {
            if (!persisted)
                return writeNormalizedLifecycleStatus(asyncDir, inMemory);
            const current = normalizeAsyncLifecycleStatus(persisted);
            return writeNormalizedLifecycleStatus(asyncDir, mergeStatus(current, inMemory, lifecycleGeneration(current) !== memoryGeneration));
        });
    }
    catch (error) {
        if (!(error instanceof LifecycleLockExhaustedError))
            throw error;
        const persisted = readStatus(asyncDir, { cache: false });
        if (persisted &&
            inMemory.state === "failed" &&
            isActiveLifecycleState(persisted.state) &&
            lifecycleGeneration(persisted) === memoryGeneration &&
            !liveLock(asyncDir)) {
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
function continuationTargetExists(sourceAsyncDir, id, options) {
    const root = path.resolve(options.asyncDirRoot ?? path.dirname(path.resolve(sourceAsyncDir)));
    return (fs.existsSync(path.join(root, id)) ||
        Boolean(options.resultsDir && fs.existsSync(path.join(options.resultsDir, `${id}.json`))));
}
const continuationDone = (continuation) => continuation?.phase === "completed" ||
    continuation?.phase === "continued" ||
    continuation?.completedAt !== undefined ||
    continuation?.continuedAt !== undefined;
function continuationResult(status, index, continuation, at, runId) {
    const steps = status.steps?.map((step, stepIndex) => stepIndex === index
        ? { ...step, status: "complete", endedAt: at, exitCode: 0, pause: undefined }
        : step);
    const actionable = steps?.some((step) => step.status === "paused" || step.status === "pausing" || step.status === "pending") ?? false;
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
function continuationGate(status, index, claimToken, runId) {
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
export function advanceLifecycleContinuation(asyncDir, index, claimToken, runId, finalize, now) {
    const current = readStatus(asyncDir, { cache: false });
    if (!current)
        return { status: null, changed: false, done: false, lost: true };
    const gate = continuationGate(current, index, claimToken, runId);
    if (gate.kind === "done")
        return { status: current, changed: false, done: gate.same, lost: !gate.same };
    if (gate.kind === "lost")
        return { status: current, changed: false, done: false, lost: true };
    if (!finalize && gate.kind === "launched")
        return { status: current, changed: false, done: false, lost: false };
    const at = now?.() ?? Date.now();
    try {
        const result = transitionLifecycleStatus({
            asyncDir,
            expectedGeneration: lifecycleGeneration(current),
            mutate: (status) => finalize
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
    }
    catch (error) {
        if (error instanceof LifecycleGenerationConflictError)
            return advanceLifecycleContinuation(asyncDir, index, claimToken, runId, finalize, now);
        throw error;
    }
}
export function recoverStaleLifecycleContinuationStatus(current, asyncDir, index, options = {}) {
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
    if (liveness !== "dead")
        return { status: current, recovered: false, liveness };
    if (continuation.continuationRunId &&
        continuationTargetExists(asyncDir, continuation.continuationRunId, options))
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
export function recoverStaleLifecycleContinuationClaim(asyncDir, index, options = {}) {
    const current = readStatus(asyncDir, { cache: false });
    if (!current)
        return { status: null, recovered: false, liveness: "unclaimed" };
    const inspected = recoverStaleLifecycleContinuationStatus(current, asyncDir, index, options);
    if (!inspected.recovered)
        return inspected;
    const generation = lifecycleGeneration(current);
    const token = lifecycleContinuationForIndex(current, index)?.claimToken;
    return withLifecycleStatusLock(asyncDir, (locked) => {
        if (!locked)
            return { status: null, recovered: false, liveness: inspected.liveness };
        const lockedContinuation = lifecycleContinuationForIndex(locked, index);
        const generationChanged = lifecycleGeneration(locked) !== generation;
        const claimChanged = lockedContinuation?.claimToken !== token;
        if ((generationChanged || claimChanged || isTerminalLifecycleState(locked.state)) &&
            lockedContinuation?.ownerPid !== undefined)
            checkPidLiveness(lockedContinuation.ownerPid, options.kill);
        if (generationChanged || claimChanged)
            return { status: locked, recovered: false, liveness: inspected.liveness };
        const terminalLocked = isTerminalLifecycleState(locked.state);
        const again = terminalLocked
            ? { status: locked, recovered: true, liveness: "dead" }
            : recoverStaleLifecycleContinuationStatus(locked, asyncDir, index, options);
        if (!again.recovered)
            return again;
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
    }, { kill: options.kill, now: options.now });
}

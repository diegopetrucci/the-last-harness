import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { invalidateStatusCache } from "../../shared/utils.ts";
import type {
	AsyncCancellationMetadata,
	AsyncLifecycleContinuationMetadata,
	AsyncLifecycleContinuationPhase,
	AsyncPauseMetadata,
	AsyncPauseState,
	AsyncStatus,
	ForegroundSupervisorRequestMetadata,
} from "../../shared/types.ts";

const DEFAULT_MAX_SUMMARY_BYTES = 280;
const DEFAULT_MAX_TOKEN_BYTES = 120;
const SAFE_LIFECYCLE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DEFAULT_LOCK_RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const;
const DEFAULT_OWNERLESS_LOCK_STALE_MS = 30_000;
const WAIT_BUFFER = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(4) : undefined;
const WAIT_VIEW = WAIT_BUFFER ? new Int32Array(WAIT_BUFFER) : undefined;

export type PidLiveness = "alive" | "dead" | "unknown";
export type ContinuationClaimLiveness = PidLiveness | "missing-owner" | "completed" | "blocked" | "unclaimed";

/**
 * Thrown by acquireTransitionLock when the retry budget is exhausted without
 * acquiring the lock. Callers that want to distinguish lock-contention from
 * genuine I/O errors catch this specific class.
 */
export class LifecycleLockExhaustedError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "LifecycleLockExhaustedError";
	}
}

export interface LifecycleLockOptions {
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
	retryDelaysMs?: readonly number[];
	ownerlessStaleMs?: number;
}

export interface LifecycleTransitionOptions {
	asyncDir: string;
	expectedGeneration: number;
	mutate: (status: AsyncStatus) => AsyncStatus;
	lockOptions?: LifecycleLockOptions;
}

export interface LifecycleTransitionResult {
	previousGeneration: number;
	nextGeneration: number;
	status: AsyncStatus;
}

interface TransitionLockOwnerRecord {
	token?: string;
	pid?: number;
	acquiredAt?: number;
}

interface TransitionLockSnapshot {
	mtimeMs: number;
	owner: TransitionLockOwnerRecord;
}

function replaceControlCharacters(value: string): string {
	return [...value]
		.map((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f
				? " "
				: character;
		})
		.join("");
}

export function boundSupervisorSummary(summary: unknown, maxBytes = DEFAULT_MAX_SUMMARY_BYTES): string | undefined {
	if (typeof summary !== "string") return undefined;
	const normalized = replaceControlCharacters(summary).replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	let bounded = normalized;
	while (Buffer.byteLength(bounded, "utf-8") > maxBytes && bounded.length > 1) {
		bounded = `${bounded.slice(0, -2).trimEnd()}…`;
	}
	return bounded;
}

function parsePauseKind(value: unknown): AsyncPauseState | undefined {
	return value === "awaiting_supervisor" || value === "cohort_pause" ? value : undefined;
}

function parseTimestamp(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parsePid(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function boundLifecycleToken(value: unknown, maxBytes = DEFAULT_MAX_TOKEN_BYTES): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	if (!normalized || Buffer.byteLength(normalized, "utf-8") > maxBytes) return undefined;
	return SAFE_LIFECYCLE_TOKEN.test(normalized) ? normalized : undefined;
}

function normalizeSupervisorRequestMetadata(request: unknown): ForegroundSupervisorRequestMetadata | undefined {
	if (!request || typeof request !== "object" || Array.isArray(request)) return undefined;
	const raw = request as Record<string, unknown>;
	const tool = raw.tool === "intercom" || raw.tool === "contact_supervisor" ? raw.tool : undefined;
	if (!tool) return undefined;
	const action = tool === "intercom" && raw.action === "ask" ? "ask" : undefined;
	const reason =
		tool === "contact_supervisor" && (raw.reason === "need_decision" || raw.reason === "interview_request")
			? raw.reason
			: undefined;
	const requestId = boundLifecycleToken(raw.requestId);
	const summary = boundSupervisorSummary(raw.summary);
	return {
		tool,
		...(action ? { action } : {}),
		...(reason ? { reason } : {}),
		...(requestId ? { requestId } : {}),
		...(summary ? { summary } : {}),
	};
}

function normalizePauseMetadata(pause: unknown): AsyncPauseMetadata | undefined {
	if (!pause || typeof pause !== "object" || Array.isArray(pause)) return undefined;
	const raw = pause as Record<string, unknown>;
	const kind = parsePauseKind(raw.kind);
	if (!kind) return undefined;
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

function normalizeCancellationMetadata(cancel: unknown): AsyncCancellationMetadata | undefined {
	if (!cancel || typeof cancel !== "object" || Array.isArray(cancel)) return undefined;
	const raw = cancel as Record<string, unknown>;
	const summary = boundSupervisorSummary(raw.summary);
	const cancelledAt = parseTimestamp(raw.cancelledAt);
	return {
		...(summary ? { summary } : {}),
		...(cancelledAt !== undefined ? { cancelledAt } : {}),
	};
}

function parseContinuationPhase(value: unknown): AsyncLifecycleContinuationPhase | undefined {
	return value === "claimed" || value === "reserved" || value === "launched" || value === "continued"
		? value
		: undefined;
}

function normalizeContinuationMetadata(continuation: unknown): AsyncLifecycleContinuationMetadata | undefined {
	if (!continuation || typeof continuation !== "object" || Array.isArray(continuation)) return undefined;
	const raw = continuation as Record<string, unknown>;
	const phase = parseContinuationPhase(raw.phase);
	const claimToken = boundLifecycleToken(raw.claimToken);
	const claimedAt = parseTimestamp(raw.claimedAt);
	const ownerPid = parsePid(raw.ownerPid);
	const launchedAt = parseTimestamp(raw.launchedAt);
	const continuedAt = parseTimestamp(raw.continuedAt);
	const continuationRunId = boundLifecycleToken(raw.continuationRunId);
	if (
		!phase &&
		!claimToken &&
		claimedAt === undefined &&
		ownerPid === undefined &&
		launchedAt === undefined &&
		continuedAt === undefined &&
		!continuationRunId
	)
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

function normalizeContinuationIndexKey(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value >= 0) return String(value);
	if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
	return String(Number(value));
}

function normalizeContinuationMap(value: unknown): Record<string, AsyncLifecycleContinuationMetadata> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entries = Object.entries(value as Record<string, unknown>)
		.map(([key, continuation]) => {
			const normalizedKey = normalizeContinuationIndexKey(key);
			const normalizedContinuation = normalizeContinuationMetadata(continuation);
			return normalizedKey && normalizedContinuation ? ([normalizedKey, normalizedContinuation] as const) : undefined;
		})
		.filter((entry): entry is readonly [string, AsyncLifecycleContinuationMetadata] => entry !== undefined);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function lifecycleContinuationForIndex(
	status: AsyncStatus | null | undefined,
	index: number,
): AsyncLifecycleContinuationMetadata | undefined {
	const normalizedIndex = normalizeContinuationIndexKey(index);
	if (!normalizedIndex) return undefined;
	const indexed = status?.lifecycle?.continuationsByIndex?.[normalizedIndex];
	if (indexed) return indexed;
	return index === 0 ? status?.lifecycle?.continuation : undefined;
}

export function withLifecycleContinuation(
	status: AsyncStatus,
	index: number,
	continuation: AsyncLifecycleContinuationMetadata | undefined,
): AsyncStatus["lifecycle"] {
	const key = normalizeContinuationIndexKey(index);
	if (!key) return status.lifecycle ?? { generation: lifecycleGeneration(status) };
	const nextIndexed = { ...(status.lifecycle?.continuationsByIndex ?? {}) };
	if (continuation) nextIndexed[key] = continuation;
	else delete nextIndexed[key];
	return {
		...status.lifecycle,
		...(index === 0 ? { continuation } : {}),
		...(Object.keys(nextIndexed).length > 0 ? { continuationsByIndex: nextIndexed } : {}),
		...(Object.keys(nextIndexed).length > 0 ? {} : { continuationsByIndex: undefined }),
	};
}

function hasActionablePausedChildren(status: AsyncStatus["steps"] | undefined): boolean {
	return (
		status?.some((step) => step.status === "paused" || step.status === "pausing" || step.status === "pending") ?? false
	);
}

export function finalizeLifecycleContinuationStatus(
	status: AsyncStatus,
	index: number,
	continuation: AsyncLifecycleContinuationMetadata,
	continuedAt: number,
	continuationRunId: string,
): AsyncStatus {
	const nextSteps = status.steps?.map((step, stepIndex) =>
		stepIndex === index
			? { ...step, status: "continued" as const, endedAt: continuedAt, exitCode: 0, pause: undefined }
			: step,
	);
	const remainingActionable = hasActionablePausedChildren(nextSteps);
	const nextRootPause = remainingActionable
		? nextSteps?.find(
				(step) => step.pause?.kind === "awaiting_supervisor" && (step.status === "paused" || step.status === "pausing"),
			)?.pause
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
		lifecycle: withLifecycleContinuation(
			status,
			index,
			remainingActionable
				? undefined
				: {
						...continuation,
						phase: "continued",
						ownerPid: undefined,
						continuedAt,
						continuationRunId,
					},
		),
		steps: nextSteps,
	};
}

export function checkPidLiveness(
	pid: number,
	kill: (pid: number, signal?: NodeJS.Signals | 0) => boolean = process.kill,
): PidLiveness {
	try {
		kill(pid, 0);
		return "alive";
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? (error as NodeJS.ErrnoException).code
				: undefined;
		if (code === "ESRCH") return "dead";
		if (code === "EPERM") return "unknown";
		return "unknown";
	}
}

export function lifecycleGeneration(status: AsyncStatus | null | undefined): number {
	const generation = status?.lifecycle?.generation;
	return typeof generation === "number" && Number.isInteger(generation) && generation >= 0 ? generation : 0;
}

export function normalizeAsyncLifecycleStatus(status: AsyncStatus): AsyncStatus {
	const pause = normalizePauseMetadata(status.pause);
	const cancel = normalizeCancellationMetadata(status.cancel);
	const continuation = normalizeContinuationMetadata(status.lifecycle?.continuation);
	const continuationsByIndex = normalizeContinuationMap(status.lifecycle?.continuationsByIndex);
	const generation = lifecycleGeneration(status);
	return {
		...status,
		...(typeof status.state === "string"
			? { state: status.state as AsyncStatus["state"] }
			: { state: "failed" as const }),
		...(pause ? { pause } : {}),
		...(pause ? {} : { pause: undefined }),
		...(cancel ? { cancel } : {}),
		...(cancel ? {} : { cancel: undefined }),
		lifecycle: {
			generation,
			...(continuation ? { continuation } : {}),
			...(continuationsByIndex ? { continuationsByIndex } : {}),
		},
	};
}

function statusPath(asyncDir: string): string {
	return path.join(asyncDir, "status.json");
}

function readLifecycleStatus(asyncDir: string): AsyncStatus | null {
	try {
		return normalizeAsyncLifecycleStatus(JSON.parse(fs.readFileSync(statusPath(asyncDir), "utf-8")) as AsyncStatus);
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? (error as NodeJS.ErrnoException).code
				: undefined;
		if (code === "ENOENT") return null;
		throw error;
	}
}

export function writeNormalizedLifecycleStatus(asyncDir: string, status: AsyncStatus): AsyncStatus {
	const normalized = normalizeAsyncLifecycleStatus(status);
	const filePath = statusPath(asyncDir);
	writeAtomicJson(filePath, normalized);
	invalidateStatusCache(filePath);
	return normalized;
}

// Terminal run states: states that a concurrent lock/CAS writer can commit and
// that a stale source-runner write must never downgrade.
//
// Rationale for each value:
//   "continued" — the resuming actor finalized the continuation via lock/CAS.
//   "cancelled" — the cancel action commits through the same lock/CAS path as
//                 a continuation reservation; a stale paused write from the
//                 source runner must not resurrect the run.
//   "failed"    — a concurrent failure (e.g. a timeout committed via lock/CAS)
//                 must not be overwritten with a stale "paused" payload.
//   "complete"  — a concurrent successful completion committed via lock/CAS must
//                 not be overwritten.
//
// "queued", "running", "pausing", and "paused" are non-terminal: the source
// runner legitimately owns writes in those states without going through lock/CAS.
//
// Exported so callers (e.g. writeStatusPayload in subagent-runner) can inspect
// the set without duplicating the definition.
export const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set(["continued", "cancelled", "failed", "complete"]);

// Terminal step statuses: same reasoning at the per-step level. "completed" is
// a legacy alias for "complete" that also appears in the union; both are guarded.
const TERMINAL_STEP_STATUSES: ReadonlySet<string> = new Set([
	"continued",
	"cancelled",
	"failed",
	"complete",
	"completed",
]);

/**
 * Merge in-memory status with persisted status and write atomically.
 */
function mergeAndWriteStatus(asyncDir: string, inMemory: AsyncStatus, persisted: AsyncStatus | null): AsyncStatus {
	if (!persisted) {
		// No persisted status yet — write in-memory as-is.
		return writeNormalizedLifecycleStatus(asyncDir, inMemory);
	}
	const persistedGen = lifecycleGeneration(persisted);
	const inMemoryGen = lifecycleGeneration(inMemory);
	// If persisted generation is ahead of ours, a lifecycle transition occurred
	// after our last sync (e.g. a continuation reservation by the resuming actor).
	// Preserve the persisted lifecycle verbatim so the reservation is not clobbered.
	// Ordering invariant: persistedGen can only advance, never retreat, so this
	// check is monotonically safe across multiple consecutive writes.
	const lifecycle = persistedGen > inMemoryGen ? persisted.lifecycle : inMemory.lifecycle;
	// Preserve any terminal run state committed by a concurrent lock/CAS writer.
	// The source runner's in-memory state is stale once a terminal transition has
	// been committed; allowing a non-terminal in-memory state to overwrite it
	// would, for example, turn a cancelled or continued run back to "paused".
	// Persisted terminal run state always wins over any in-memory state —
	// including another terminal state — because it was committed through the
	// lifecycle lock/CAS path. The exiting source runner is the loser in every
	// conflicting-terminal scenario (e.g. persisted="cancelled", in-memory="failed").
	//
	// Precedence rule: persisted terminal beats any non-matching in-memory state.
	// "Same terminal" (both sides agree on state) is left unchanged — no conflict.
	let state = inMemory.state;
	if (TERMINAL_RUN_STATES.has(persisted.state) && persisted.state !== state) {
		state = persisted.state;
	}
	// Preserve persisted terminal step transitions; the source runner's in-memory
	// step status may be stale. For each terminal persisted step we keep the
	// terminal status and its associated lifecycle metadata (cancel, endedAt,
	// exitCode) while still merging in source-owned settlement fields (tokens,
	// model info, acceptance, etc.) from the in-memory step for unaffected steps.
	const steps = inMemory.steps?.map((step, i) => {
		const persistedStep = persisted.steps?.[i];
		if (!persistedStep || !TERMINAL_STEP_STATUSES.has(persistedStep.status)) return step;
		// Lifecycle-owned metadata comes from the persisted winner authoritatively,
		// including its absence: status, endedAt, exitCode, cancel, error, pause.
		// Source-owned settlement data (model, tokens, acceptance, processCleanup)
		// continues to come from the in-memory step so it is not lost.
		const lifecycleOverrides = {
			status: persistedStep.status,
			endedAt: persistedStep.endedAt,
			exitCode: persistedStep.exitCode,
			cancel: persistedStep.cancel,
			error: persistedStep.error,
			// A terminal step has no active pause.
			pause: undefined as undefined,
		};
		if (persistedStep.status === step.status) {
			// Both sides agree on the terminal status. The concurrent writer may have
			// committed lifecycle metadata (cancel, endedAt, error) after the source
			// runner's last sync. Apply persisted lifecycle fields authoritatively,
			// including clearing fields absent from the persisted winner (e.g. a
			// cancelled step has no error — a stale in-memory error must not survive).
			return { ...step, ...lifecycleOverrides };
		}
		// Persisted step is terminal and in-memory step has a different status.
		// Carry the terminal lifecycle metadata from disk; take source-owned
		// settlement fields (model, tokens, acceptance, processCleanup, etc.)
		// from the in-memory step so settlement data is not lost.
		return { ...step, ...lifecycleOverrides };
	});
	// When the persisted run state is terminal and differs from the in-memory state,
	// lifecycle-owned metadata comes from the persisted winner authoritatively —
	// INCLUDING its absence. A stale in-memory error/cancel/endedAt/exitCode/pid/pause
	// must NOT survive onto the persisted winner's record. Source-owned settlement
	// data (model, attempts, tokens, acceptance, processCleanup) continues to come
	// from the in-memory record. This applies to both terminal-vs-non-terminal and
	// terminal-vs-conflicting-terminal scenarios.
	const terminalRunOverrides =
		TERMINAL_RUN_STATES.has(persisted.state) && persisted.state !== inMemory.state
			? {
					// Lifecycle-owned fields from the persisted winner — set unconditionally
					// so that absence on the winner clears any stale value from inMemory.
					cancel: persisted.cancel,
					endedAt: persisted.endedAt,
					error: persisted.error,
					// A terminal run has no live PID and no active pause owner.
					// Explicitly set undefined so absence is preserved, not just the value.
					pid: undefined,
					pause: undefined,
				}
			: {};
	const merged: AsyncStatus = {
		...inMemory,
		...terminalRunOverrides,
		state,
		...(steps !== undefined ? { steps } : {}),
		lifecycle,
	};
	return writeNormalizedLifecycleStatus(asyncDir, merged);
}

/**
 * Safe post-pause variant of writeNormalizedLifecycleStatus for source-runner
 * writes that happen after a paused checkpoint was committed to disk.
 *
 * Reads the currently persisted status and merges the in-memory status against
 * it before writing. This preserves any continuation reservation (or finalized
 * continuation) that a concurrent resuming actor may have committed between the
 * source runner's last sync and this write call.
 *
 * Invariants maintained:
 *   - A persisted "continued" run state is never downgraded to "paused".
 *   - A step already moved to "continued" on disk is never reverted to "paused".
 *   - When persisted generation > in-memory generation (a lifecycle transition
 *     the source runner doesn't know about has occurred), the persisted lifecycle
 *     section – including continuation reservation and generation – is kept intact.
 *
 * Callers MUST update their in-memory lifecycle from the returned status so that
 * subsequent writes see the correct generation and continuation metadata.
 *
 * Lock-acquisition semantics: the lifecycle lock is attempted with the default
 * retry schedule so that the read-merge-write is atomic with respect to other
 * CAS lifecycle transitions (e.g. the resume actor reserving a continuation).
 * If the lock cannot be acquired after retries, the function SKIPS THE WRITE
 * entirely and returns the currently persisted status (or the in-memory status
 * if nothing is persisted yet). This is the correct ownership model: once a
 * paused checkpoint exists, the exiting source runner's status write is a
 * best-effort observability update, while the resuming actor owns the lifecycle
 * through the lock/CAS path. Losing that observability update is strictly
 * preferable to introducing a lockless read-merge-write window that can erase
 * a reservation and hang a waiter forever — which is exactly the race this
 * function exists to eliminate.
 *
 * This function is intentionally synchronous: withLifecycleStatusLock uses
 * Atomics.wait, so no new await window is opened and no concurrent timer or
 * event-loop observer can mutate shared state between the lock acquisition,
 * the disk read, and the write.
 */
export function mergeAndWriteSourceRunnerStatus(asyncDir: string, inMemory: AsyncStatus): AsyncStatus {
	try {
		// Primary path: acquire the lifecycle lock so that the read-merge-write
		// is atomic with respect to other CAS lifecycle transitions (e.g. the
		// resume actor reserving or finalizing a continuation).
		return withLifecycleStatusLock(asyncDir, (persisted) => mergeAndWriteStatus(asyncDir, inMemory, persisted));
	} catch (error) {
		// Re-throw genuine I/O or logic errors immediately.
		if (!(error instanceof LifecycleLockExhaustedError)) throw error;
		// Lock-acquisition exhaustion: the lifecycle is currently owned by a
		// concurrent CAS writer (e.g. the resume actor reserving or finalizing a
		// continuation). DO NOT WRITE. Returning the persisted status (or the
		// in-memory status if the run directory is brand-new) skips this
		// observability write without risking a lockless read-merge-write that
		// could erase the reservation between the read and the write.
		const persisted = readLifecycleStatus(asyncDir);
		return persisted ?? inMemory;
	}
}

function waitSync(delayMs: number): void {
	if (delayMs <= 0) return;
	if (WAIT_VIEW) {
		try {
			Atomics.wait(WAIT_VIEW, 0, 0, delayMs);
			return;
		} catch {
			// Fall through to the portable busy wait below.
		}
	}
	const end = Date.now() + delayMs;
	while (Date.now() < end) {
		// Portable fallback for runtimes where Atomics.wait is unavailable.
		void 0;
	}
}

function runLabel(asyncDir: string): string {
	const base = path.basename(path.resolve(asyncDir));
	return base || "unknown-run";
}

function transitionLockDir(asyncDir: string): string {
	return path.join(asyncDir, ".lifecycle-transition.lock");
}

function transitionLockInfoPath(asyncDir: string): string {
	return path.join(transitionLockDir(asyncDir), "owner.json");
}

function transitionLockOwnerSummary(owner: TransitionLockOwnerRecord): string | undefined {
	const details = [
		owner.pid !== undefined ? `pid ${owner.pid}` : undefined,
		owner.acquiredAt !== undefined ? `acquired ${new Date(owner.acquiredAt).toISOString()}` : undefined,
	].filter(Boolean);
	return details.length > 0 ? details.join(", ") : undefined;
}

function readTransitionLockOwner(asyncDir: string): TransitionLockOwnerRecord {
	try {
		const raw = JSON.parse(fs.readFileSync(transitionLockInfoPath(asyncDir), "utf-8")) as {
			token?: unknown;
			pid?: unknown;
			acquiredAt?: unknown;
		};
		return {
			token: boundLifecycleToken(raw.token),
			pid: parsePid(raw.pid),
			acquiredAt: parseTimestamp(raw.acquiredAt),
		};
	} catch {
		return {};
	}
}

function readTransitionLockSnapshot(asyncDir: string): TransitionLockSnapshot | undefined {
	try {
		const stats = fs.statSync(transitionLockDir(asyncDir));
		return {
			mtimeMs: stats.mtimeMs,
			owner: readTransitionLockOwner(asyncDir),
		};
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? (error as NodeJS.ErrnoException).code
				: undefined;
		if (code === "ENOENT") return undefined;
		throw error;
	}
}

function isCompleteTransitionLockOwner(owner: TransitionLockOwnerRecord): owner is Required<TransitionLockOwnerRecord> {
	return (
		typeof owner.token === "string" &&
		owner.token.length > 0 &&
		typeof owner.pid === "number" &&
		typeof owner.acquiredAt === "number"
	);
}

function tryRecoverStaleTransitionLock(asyncDir: string, options: LifecycleLockOptions = {}): boolean {
	const snapshot = readTransitionLockSnapshot(asyncDir);
	if (!snapshot) return false;
	const now = options.now?.() ?? Date.now();
	const ownerlessStaleMs = options.ownerlessStaleMs ?? DEFAULT_OWNERLESS_LOCK_STALE_MS;
	if (isCompleteTransitionLockOwner(snapshot.owner)) {
		if (checkPidLiveness(snapshot.owner.pid, options.kill) !== "dead") return false;
		const latest = readTransitionLockSnapshot(asyncDir);
		if (!latest || !isCompleteTransitionLockOwner(latest.owner)) return false;
		if (
			latest.owner.token !== snapshot.owner.token ||
			latest.owner.pid !== snapshot.owner.pid ||
			latest.owner.acquiredAt !== snapshot.owner.acquiredAt
		) {
			return false;
		}
	} else {
		if (now - snapshot.mtimeMs < ownerlessStaleMs) return false;
		const latest = readTransitionLockSnapshot(asyncDir);
		if (!latest || isCompleteTransitionLockOwner(latest.owner)) return false;
		if (latest.mtimeMs !== snapshot.mtimeMs || now - latest.mtimeMs < ownerlessStaleMs) return false;
	}
	try {
		fs.rmSync(transitionLockDir(asyncDir), { recursive: true, force: false });
		return true;
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? (error as NodeJS.ErrnoException).code
				: undefined;
		if (code === "ENOENT") return false;
		throw error;
	}
}

function acquireTransitionLock(asyncDir: string, options: LifecycleLockOptions = {}): () => void {
	const lockDir = transitionLockDir(asyncDir);
	const owner: Required<TransitionLockOwnerRecord> = {
		token: randomUUID(),
		pid: process.pid,
		acquiredAt: options.now?.() ?? Date.now(),
	};
	const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_LOCK_RETRY_DELAYS_MS;
	fs.mkdirSync(asyncDir, { recursive: true });
	for (let attempt = 0; ; attempt++) {
		try {
			fs.mkdirSync(lockDir);
			break;
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? (error as NodeJS.ErrnoException).code
					: undefined;
			if (code !== "EEXIST") throw error;
			if (tryRecoverStaleTransitionLock(asyncDir, options)) continue;
			const delayMs = retryDelaysMs[attempt];
			if (delayMs !== undefined) {
				waitSync(delayMs);
				continue;
			}
			const ownerSummary = transitionLockOwnerSummary(readTransitionLockOwner(asyncDir));
			throw new LifecycleLockExhaustedError(
				`Lifecycle transition rejected for run '${runLabel(asyncDir)}': another transition holds the status lock${ownerSummary ? ` (${ownerSummary})` : ""}. Wait for it to finish or clear the stale lifecycle lock only after verifying the run is idle.`,
				{ cause: error },
			);
		}
	}
	try {
		fs.writeFileSync(transitionLockInfoPath(asyncDir), JSON.stringify(owner, null, 2), "utf-8");
	} catch (error) {
		fs.rmSync(lockDir, { recursive: true, force: true });
		throw error;
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		try {
			if (readTransitionLockOwner(asyncDir).token !== owner.token) return;
			fs.rmSync(lockDir, { recursive: true, force: true });
		} catch {
			// Best effort only; never remove a replacement owner we can no longer verify.
		}
	};
}

export function withLifecycleStatusLock<T>(
	asyncDir: string,
	operation: (status: AsyncStatus | null) => T,
	options: LifecycleLockOptions = {},
): T {
	const releaseLock = acquireTransitionLock(asyncDir, options);
	try {
		return operation(readLifecycleStatus(asyncDir));
	} finally {
		releaseLock();
	}
}

export function transitionLifecycleStatus(options: LifecycleTransitionOptions): LifecycleTransitionResult {
	return withLifecycleStatusLock(
		options.asyncDir,
		(current) => {
			if (!current)
				throw new Error(
					`Cannot transition lifecycle state for run '${runLabel(options.asyncDir)}': persisted status was not found.`,
				);
			const normalizedCurrent = normalizeAsyncLifecycleStatus(current);
			const currentGeneration = lifecycleGeneration(normalizedCurrent);
			if (currentGeneration !== options.expectedGeneration) {
				throw new Error(
					`Lifecycle transition rejected for run '${runLabel(options.asyncDir)}': expected generation ${options.expectedGeneration}, found ${currentGeneration}.`,
				);
			}
			const mutated = normalizeAsyncLifecycleStatus(options.mutate(normalizedCurrent));
			const nextStatus: AsyncStatus = {
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
		},
		options.lockOptions,
	);
}

function continuationTargetExists(
	sourceAsyncDir: string,
	continuationRunId: string,
	options: { asyncDirRoot?: string; resultsDir?: string },
): boolean {
	const asyncDirRoot = path.resolve(options.asyncDirRoot ?? path.dirname(path.resolve(sourceAsyncDir)));
	const asyncTargetDir = path.join(asyncDirRoot, continuationRunId);
	if (fs.existsSync(asyncTargetDir)) return true;
	if (options.resultsDir && fs.existsSync(path.join(options.resultsDir, `${continuationRunId}.json`))) return true;
	return false;
}

export function markLifecycleContinuationSpawned(
	asyncDir: string,
	index: number,
	claimToken: string,
	continuationRunId: string,
	options: { now?: () => number } = {},
): { status: AsyncStatus | null; transitioned: boolean; final: boolean; lost: boolean } {
	const current = readLifecycleStatus(asyncDir);
	if (!current) return { status: null, transitioned: false, final: false, lost: true };
	const continuation = lifecycleContinuationForIndex(current, index);
	if (current.state === "continued" || current.steps?.[index]?.status === "continued") {
		const sameTarget = continuation?.claimToken === claimToken && continuation.continuationRunId === continuationRunId;
		return { status: current, transitioned: false, final: sameTarget, lost: !sameTarget };
	}
	if (continuation?.claimToken !== claimToken || continuation.continuationRunId !== continuationRunId) {
		return { status: current, transitioned: false, final: false, lost: true };
	}
	if (continuation.phase === "launched" || continuation.phase === "continued") {
		return { status: current, transitioned: false, final: continuation.phase === "continued", lost: false };
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
	} catch (error) {
		if (error instanceof Error && /expected generation/.test(error.message)) {
			return markLifecycleContinuationSpawned(asyncDir, index, claimToken, continuationRunId, options);
		}
		throw error;
	}
}

export function finalizeLifecycleContinuationLaunch(
	asyncDir: string,
	index: number,
	claimToken: string,
	continuationRunId: string,
	options: { now?: () => number } = {},
): { status: AsyncStatus | null; finalized: boolean; lost: boolean } {
	const current = readLifecycleStatus(asyncDir);
	if (!current) return { status: null, finalized: false, lost: true };
	const continuation = lifecycleContinuationForIndex(current, index);
	if (current.state === "continued" || current.steps?.[index]?.status === "continued") {
		const sameTarget = continuation?.claimToken === claimToken && continuation.continuationRunId === continuationRunId;
		return { status: current, finalized: sameTarget, lost: !sameTarget };
	}
	if (continuation?.claimToken !== claimToken || continuation.continuationRunId !== continuationRunId) {
		return { status: current, finalized: false, lost: true };
	}
	const continuedAt = options.now?.() ?? Date.now();
	try {
		const transitioned = transitionLifecycleStatus({
			asyncDir,
			expectedGeneration: lifecycleGeneration(current),
			mutate: (status) =>
				finalizeLifecycleContinuationStatus(status, index, continuation, continuedAt, continuationRunId),
		});
		return { status: transitioned.status, finalized: true, lost: false };
	} catch (error) {
		if (error instanceof Error && /expected generation/.test(error.message)) {
			return finalizeLifecycleContinuationLaunch(asyncDir, index, claimToken, continuationRunId, options);
		}
		throw error;
	}
}

export interface StaleLifecycleContinuationRecoveryOptions {
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
	asyncDirRoot?: string;
	resultsDir?: string;
}

/**
 * Inspect a status that is already protected by the lifecycle lock and, when
 * safe, return the in-memory recovery. Callers can compose this with another
 * guarded decision before persisting either change.
 */
export function recoverStaleLifecycleContinuationStatus(
	current: AsyncStatus,
	asyncDir: string,
	index: number,
	options: StaleLifecycleContinuationRecoveryOptions = {},
): { status: AsyncStatus; recovered: boolean; liveness: ContinuationClaimLiveness } {
	const continuation = lifecycleContinuationForIndex(current, index);
	if (!continuation?.claimToken) return { status: current, recovered: false, liveness: "unclaimed" };
	if (
		continuation.continuedAt !== undefined ||
		continuation.phase === "continued" ||
		current.state === "continued" ||
		current.steps?.[index]?.status === "continued"
	) {
		return { status: current, recovered: false, liveness: "completed" };
	}
	if (continuation.ownerPid === undefined) {
		if (continuation.continuationRunId) return { status: current, recovered: false, liveness: "blocked" };
		return { status: current, recovered: false, liveness: "missing-owner" };
	}
	const liveness = checkPidLiveness(continuation.ownerPid, options.kill);
	if (liveness !== "dead") return { status: current, recovered: false, liveness };
	if (continuation.continuationRunId && continuationTargetExists(asyncDir, continuation.continuationRunId, options)) {
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

export function recoverStaleLifecycleContinuationClaim(
	asyncDir: string,
	index: number,
	options: StaleLifecycleContinuationRecoveryOptions = {},
): { status: AsyncStatus | null; recovered: boolean; liveness: ContinuationClaimLiveness } {
	const current = readLifecycleStatus(asyncDir);
	if (!current) return { status: null, recovered: false, liveness: "unclaimed" };
	const inspected = recoverStaleLifecycleContinuationStatus(current, asyncDir, index, options);
	if (!inspected.recovered) return inspected;
	const expectedGeneration = lifecycleGeneration(current);
	const inspectedClaimToken = lifecycleContinuationForIndex(current, index)?.claimToken;
	return withLifecycleStatusLock(
		asyncDir,
		(lockedStatus) => {
			if (!lockedStatus) {
				throw new Error(
					`Cannot transition lifecycle state for run '${runLabel(asyncDir)}': persisted status was not found.`,
				);
			}
			const normalizedLockedStatus = normalizeAsyncLifecycleStatus(lockedStatus);
			const lockedGeneration = lifecycleGeneration(normalizedLockedStatus);
			if (lockedGeneration !== expectedGeneration) {
				return { status: normalizedLockedStatus, recovered: false, liveness: inspected.liveness };
			}
			const rechecked = recoverStaleLifecycleContinuationStatus(normalizedLockedStatus, asyncDir, index, options);
			if (!rechecked.recovered) return rechecked;
			// A same-generation write may have replaced the claim without advancing
			// the lifecycle CAS generation. Never clear a newer claim just because the
			// pre-lock inspection found a dead owner for the old one. This call is
			// deliberately conservative: a later invocation may recover the
			// replacement after inspecting its claim instead of clearing a claim
			// different from the preinspection target.
			if (lifecycleContinuationForIndex(normalizedLockedStatus, index)?.claimToken !== inspectedClaimToken) {
				return { status: normalizedLockedStatus, recovered: false, liveness: rechecked.liveness };
			}
			const recoveryLastUpdate = rechecked.status.lastUpdate ?? Date.now();
			const lastUpdate =
				typeof normalizedLockedStatus.lastUpdate === "number" && Number.isFinite(normalizedLockedStatus.lastUpdate)
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
		},
		options,
	);
}

export function recoverStoppedLifecycleOwnership(
	status: AsyncStatus,
	options: { kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean; now?: () => number } = {},
): { status: AsyncStatus; repaired: boolean; pidLiveness?: PidLiveness } {
	const normalized = normalizeAsyncLifecycleStatus(status);
	if (
		(normalized.state !== "paused" &&
			normalized.state !== "cancelled" &&
			normalized.state !== "continued" &&
			normalized.state !== "pausing") ||
		typeof normalized.pid !== "number"
	) {
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
		if (pidLiveness !== "dead") return { status: normalized, repaired: false, pidLiveness };
		const hasResumeCheckpoint = Boolean(
			pause?.kind &&
				(pause.requestedAt !== undefined || pause.pausedAt !== undefined) &&
				(normalized.sessionFile ||
					normalized.steps?.some((step) => typeof step.sessionFile === "string" && step.sessionFile.length > 0)),
		);
		if (!hasResumeCheckpoint) return { status: normalized, repaired: false, pidLiveness };
		const pausedAt = pause?.pausedAt ?? now ?? Date.now();
		return {
			status: {
				...normalized,
				state: "paused",
				pid: undefined,
				endedAt: normalized.endedAt ?? pausedAt,
				lastUpdate: now ?? pausedAt,
				...(pause ? { pause: { ...pause, pausedAt } } : {}),
				steps: normalized.steps?.map((step) =>
					step.status === "pausing"
						? { ...step, status: "paused", endedAt: step.endedAt ?? pausedAt, exitCode: 0 }
						: step,
				),
			},
			repaired: true,
			pidLiveness,
		};
	}
	const repaired: AsyncStatus = {
		...normalized,
		pid: undefined,
		...(pause ? { pause } : {}),
		lastUpdate: now,
	};
	return { status: repaired, repaired: true, pidLiveness };
}

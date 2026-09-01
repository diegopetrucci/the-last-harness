import type {
  SessionMirrorAttestationFailure,
  SessionMirrorAttestationInput,
  SessionMirrorAttestationReason,
  SessionMirrorAttestationResult,
} from "./profile-attestation.js";
import {
  projectSessionMirrorSnapshot,
  type SessionMirrorReadonlySessionManager,
  type SessionMirrorSnapshotProjectionMetadata,
  type SessionMirrorSnapshotProjectionReason,
  type SessionMirrorSnapshotProjectionResult,
  type SessionMirrorSnapshotProjectionEnvelope,
  type SessionMirrorSnapshotProjectionStatus,
} from "./session-adapter.js";

/** The default number of deferred lifecycle markers retained by one generation. */
export const SESSION_MIRROR_OBSERVER_DEFAULT_QUEUE_CAPACITY = 8;

/** The largest queue accepted by the bounded observer seam. */
export const SESSION_MIRROR_OBSERVER_MAX_QUEUE_CAPACITY = 32;

/**
 * Marker scheduling is deliberately a one-way seam. Production schedulers
 * arrange for the callback after the caller returns; the runtime also guards
 * against an inline injected scheduler.
 */
export type SessionMirrorObserverScheduler = (task: () => void) => void;

/** A sink receives one complete, already-projected snapshot at a time. */
export type SessionMirrorObserverSink = (
  envelope: SessionMirrorSnapshotProjectionEnvelope,
) => void | PromiseLike<void>;

/** Injectable attestation boundary used by the deferred worker. */
export type SessionMirrorObserverAttestor = (
  input: SessionMirrorAttestationInput,
) => SessionMirrorAttestationResult;

/** Injectable source projection boundary used by the deferred worker. */
export type SessionMirrorObserverProjector = (
  sessionManager: SessionMirrorReadonlySessionManager,
  metadata: SessionMirrorSnapshotProjectionMetadata,
) => SessionMirrorSnapshotProjectionResult;

/** Stable aggregate-only diagnostics exposed by the observer. */
export type SessionMirrorObserverDiagnosticCode =
  | "queue-overflow"
  | "stale-generation"
  | "scheduler-failure"
  | "session-unavailable"
  | "attestation-failure"
  | "attestation-not-ready"
  | "projection-failure"
  | "sink-throw"
  | "sink-reject";

export const SESSION_MIRROR_OBSERVER_DIAGNOSTIC_CODES = Object.freeze([
  "queue-overflow",
  "stale-generation",
  "scheduler-failure",
  "session-unavailable",
  "attestation-failure",
  "attestation-not-ready",
  "projection-failure",
  "sink-throw",
  "sink-reject",
] as const);

export type SessionMirrorObserverAttestationState =
  | "pending"
  | "attested"
  | "directory-only"
  | "disabled"
  | "shutdown";

interface DiagnosticCounts {
  queueOverflow: number;
  staleGeneration: number;
  schedulerFailure: number;
  sessionUnavailable: number;
  attestationFailure: number;
  attestationNotReady: number;
  projectionFailure: number;
  sinkThrow: number;
  sinkReject: number;
}

export interface SessionMirrorObserverDiagnostics {
  readonly queueOverflow: number;
  readonly staleGeneration: number;
  readonly schedulerFailure: number;
  readonly sessionUnavailable: number;
  readonly attestationFailure: number;
  readonly attestationNotReady: number;
  readonly projectionFailure: number;
  readonly sinkThrow: number;
  readonly sinkReject: number;
}

/**
 * Aggregate-only state. No source manager, event, envelope, path, or sink
 * error is retained in this view.
 */
export interface SessionMirrorObserverState {
  readonly generation: number;
  readonly enabled: boolean;
  readonly attestation: SessionMirrorObserverAttestationState;
  readonly status: SessionMirrorSnapshotProjectionStatus;
  readonly settled: boolean;
  readonly dirty: boolean;
  readonly snapshotRequired: boolean;
  readonly publicationPending: boolean;
  readonly queueDepth: number;
  readonly queueCapacity: number;
  readonly sinkInFlight: boolean;
  readonly revision: number;
  readonly successfulPublications: number;
  readonly failedPublications: number;
  readonly coalescedMarkers: number;
  readonly droppedMarkers: number;
  readonly diagnostics: SessionMirrorObserverDiagnostics;
  readonly lastDiagnostic: SessionMirrorObserverDiagnosticCode | undefined;
  readonly lastAttestationFailure: SessionMirrorAttestationReason | undefined;
  readonly lastProjectionFailure: SessionMirrorSnapshotProjectionReason | undefined;
}

export interface SessionMirrorObserverRuntimeOptions {
  /** Prefer this getter so replacement sessions never reuse an old manager. */
  readonly getSessionManager?: () => SessionMirrorReadonlySessionManager | undefined;
  /** Convenience seam for tests and callers with one stable in-memory manager. */
  readonly sessionManager?: SessionMirrorReadonlySessionManager;
  readonly sink?: SessionMirrorObserverSink;
  readonly scheduler?: SessionMirrorObserverScheduler;
  readonly attest?: SessionMirrorObserverAttestor;
  readonly project?: SessionMirrorObserverProjector;
  readonly runtimeVersion?: string;
  readonly sessionSchemaVersion?: string;
  readonly queueCapacity?: number;
}

export interface SessionMirrorObserverRuntime {
  /** Enqueue a new-session attestation marker and reset the generation. */
  sessionStart(): void;
  /** Record coarse active status without looking at the event payload. */
  agentStart(): void;
  /** Mark source state dirty; this method never projects or publishes it. */
  messageEnd(): void;
  /** Mark source state dirty; this method never projects or publishes it. */
  turnEnd(): void;
  /** The sole normal lifecycle trigger for a settled snapshot. */
  agentSettled(): void;
  /** Force a replacement snapshot after tree navigation. */
  sessionTree(): void;
  /** Force a replacement snapshot after compaction. */
  sessionCompact(): void;
  /** Invalidate the generation and drop queued work without flushing. */
  sessionShutdown(): void;
  /** Request a replacement snapshot from an idle/settled generation. */
  requestSnapshot(): void;
  /** Return a fresh, immutable aggregate-only state view. */
  getState(): SessionMirrorObserverState;
}

interface Marker {
  readonly kind: MarkerKind;
}

type MarkerKind = "session-start" | "agent-start" | "dirty" | "agent-settled" | "snapshot-required";

interface GenerationToken {
  readonly serial: number;
}

interface SinkOperation {
  readonly token: GenerationToken;
  readonly mutationSerial: number;
}

interface SessionView {
  readonly manager: SessionMirrorReadonlySessionManager;
  readonly sessionFile: string | undefined;
}

interface SessionViewFailure {
  readonly ok: false;
}

interface SessionViewSuccess {
  readonly ok: true;
  readonly value: SessionView;
}

type SessionViewResult = SessionViewFailure | SessionViewSuccess;

interface InternalState {
  generation: number;
  token: GenerationToken;
  attestation: SessionMirrorObserverAttestationState;
  enabled: boolean;
  status: SessionMirrorSnapshotProjectionStatus;
  settled: boolean;
  dirty: boolean;
  snapshotRequired: boolean;
  publicationPending: boolean;
  queue: Marker[];
  queueCapacity: number;
  revision: number;
  publicationSerial: number;
  mutationSerial: number;
  successfulPublications: number;
  failedPublications: number;
  coalescedMarkers: number;
  droppedMarkers: number;
  diagnostics: DiagnosticCounts;
  lastDiagnostic: SessionMirrorObserverDiagnosticCode | undefined;
  lastAttestationFailure: SessionMirrorAttestationReason | undefined;
  lastProjectionFailure: SessionMirrorSnapshotProjectionReason | undefined;
}

const MAX_COUNTER = 2_000_000_000;
const MAX_METADATA_CHARACTERS = 256;
const DEFAULT_RUNTIME_VERSION = "tlh-session-mirror-runtime-v1";
const DEFAULT_SESSION_SCHEMA_VERSION = "pi-session-schema-v3";

function nextCounter(value: number): number {
  return value >= MAX_COUNTER ? 1 : value + 1;
}

function boundedQueueCapacity(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value === undefined || value < 1) {
    return SESSION_MIRROR_OBSERVER_DEFAULT_QUEUE_CAPACITY;
  }
  return Math.min(value, SESSION_MIRROR_OBSERVER_MAX_QUEUE_CAPACITY);
}

function boundedMetadata(value: string | undefined, fallback: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_METADATA_CHARACTERS) {
    return fallback;
  }
  return value;
}

function emptyDiagnostics(): DiagnosticCounts {
  return {
    queueOverflow: 0,
    staleGeneration: 0,
    schedulerFailure: 0,
    sessionUnavailable: 0,
    attestationFailure: 0,
    attestationNotReady: 0,
    projectionFailure: 0,
    sinkThrow: 0,
    sinkReject: 0,
  };
}

function initialState(queueCapacity: number): InternalState {
  return {
    generation: 0,
    token: { serial: 0 },
    attestation: "shutdown",
    enabled: false,
    status: "unknown",
    settled: true,
    dirty: false,
    snapshotRequired: false,
    publicationPending: false,
    queue: [],
    queueCapacity,
    revision: 0,
    publicationSerial: 0,
    mutationSerial: 0,
    successfulPublications: 0,
    failedPublications: 0,
    coalescedMarkers: 0,
    droppedMarkers: 0,
    diagnostics: emptyDiagnostics(),
    lastDiagnostic: undefined,
    lastAttestationFailure: undefined,
    lastProjectionFailure: undefined,
  };
}

function freezeDiagnostics(counts: DiagnosticCounts): SessionMirrorObserverDiagnostics {
  return Object.freeze({
    queueOverflow: counts.queueOverflow,
    staleGeneration: counts.staleGeneration,
    schedulerFailure: counts.schedulerFailure,
    sessionUnavailable: counts.sessionUnavailable,
    attestationFailure: counts.attestationFailure,
    attestationNotReady: counts.attestationNotReady,
    projectionFailure: counts.projectionFailure,
    sinkThrow: counts.sinkThrow,
    sinkReject: counts.sinkReject,
  });
}

function incrementCounter(value: number): number {
  return value >= MAX_COUNTER ? MAX_COUNTER : value + 1;
}

function normalizedAttestationFailure(
  reason: SessionMirrorAttestationReason,
): SessionMirrorAttestationFailure {
  switch (reason) {
    case "missing-profile-selection":
    case "missing-home":
    case "default-or-normal-profile":
    case "profile-mismatch":
    case "unsafe-profile-metadata":
    case "ephemeral-session":
    case "session-escape":
    case "unsafe-session-metadata":
      return { ok: false, reason };
    default:
      return { ok: false, reason: "unsafe-profile-metadata" };
  }
}

function normalizeAttestationResult(
  result: SessionMirrorAttestationResult,
): "session-file" | "directory-only" | SessionMirrorAttestationFailure {
  try {
    if (result.ok === false) return normalizedAttestationFailure(result.reason);
    if (result.ok === true && result.phase === "session-file") return "session-file";
    if (result.ok === true && result.phase === "directory-only") return "directory-only";
  } catch {
    // A hostile injected seam is treated as a closed attestation failure.
  }
  return { ok: false, reason: "unsafe-profile-metadata" };
}

function normalizedProjectionReason(
  reason: SessionMirrorSnapshotProjectionReason,
): SessionMirrorSnapshotProjectionReason {
  switch (reason) {
    case "invalid-metadata":
    case "session-unavailable":
    case "unsafe-session-data":
    case "bounds-exceeded":
      return reason;
    default:
      return "unsafe-session-data";
  }
}

function markerIndex(queue: readonly Marker[], kind: MarkerKind): number {
  return queue.findIndex((marker) => marker.kind === kind);
}

/**
 * Create the dormant in-process session-mirror observer.
 *
 * The returned lifecycle methods are intentionally synchronous. They only
 * mutate bounded aggregate flags/counters and enqueue content-free markers.
 * Attestation, source projection, and sink work happen later on the injected
 * scheduler. This module does not register extension handlers; the opt-in
 * integration is owned by a later task.
 */
export function createSessionMirrorObserverRuntime(
  options: SessionMirrorObserverRuntimeOptions = {},
): SessionMirrorObserverRuntime {
  const queueCapacity = boundedQueueCapacity(options.queueCapacity);
  const scheduler = options.scheduler ?? ((task: () => void) => setImmediate(task));
  const sink: SessionMirrorObserverSink = options.sink ?? (() => undefined);
  // Native dynamic imports cannot resolve the peer-only upstream runtime. The
  // eager integration supplies the production attestor; a missing attestor is
  // deliberately fail-closed for direct consumers and tests.
  const attest: SessionMirrorObserverAttestor =
    options.attest ?? (() => ({ ok: false as const, reason: "unsafe-profile-metadata" as const }));
  const project = options.project ?? projectSessionMirrorSnapshot;
  const runtimeVersion = boundedMetadata(options.runtimeVersion, DEFAULT_RUNTIME_VERSION);
  const sessionSchemaVersion = boundedMetadata(
    options.sessionSchemaVersion,
    DEFAULT_SESSION_SCHEMA_VERSION,
  );
  const getSessionManager = options.getSessionManager ?? (() => options.sessionManager);

  const state = initialState(queueCapacity);
  // This slot is global rather than generation-scoped. Invalidation swaps the
  // token and drops queued work, but cannot cancel a sink Promise; retaining
  // activeSink until settlement prevents an uncancellable old operation from
  // allowing repeated generation changes to create unbounded sink calls.
  let activeSink: SinkOperation | undefined;
  let workerScheduled = false;
  let workerRunning = false;
  let workerAgain = false;
  let lifecycleDepth = 0;

  const currentToken = (): GenerationToken => state.token;

  const isCurrent = (token: GenerationToken): boolean => token === state.token;

  const recordDiagnostic = (code: SessionMirrorObserverDiagnosticCode): void => {
    state.lastDiagnostic = code;
    const diagnostics = state.diagnostics;
    switch (code) {
      case "queue-overflow":
        diagnostics.queueOverflow = incrementCounter(diagnostics.queueOverflow);
        break;
      case "stale-generation":
        diagnostics.staleGeneration = incrementCounter(diagnostics.staleGeneration);
        break;
      case "scheduler-failure":
        diagnostics.schedulerFailure = incrementCounter(diagnostics.schedulerFailure);
        break;
      case "session-unavailable":
        diagnostics.sessionUnavailable = incrementCounter(diagnostics.sessionUnavailable);
        break;
      case "attestation-failure":
        diagnostics.attestationFailure = incrementCounter(diagnostics.attestationFailure);
        break;
      case "attestation-not-ready":
        diagnostics.attestationNotReady = incrementCounter(diagnostics.attestationNotReady);
        break;
      case "projection-failure":
        diagnostics.projectionFailure = incrementCounter(diagnostics.projectionFailure);
        break;
      case "sink-throw":
        diagnostics.sinkThrow = incrementCounter(diagnostics.sinkThrow);
        break;
      case "sink-reject":
        diagnostics.sinkReject = incrementCounter(diagnostics.sinkReject);
        break;
    }
  };

  const scheduleWorker = (): void => {
    if (workerRunning) {
      workerAgain = true;
      return;
    }
    if (workerScheduled || activeSink !== undefined || state.queue.length === 0) return;
    workerScheduled = true;
    try {
      scheduler(() => {
        if (lifecycleDepth > 0) {
          queueMicrotask(() => {
            workerScheduled = false;
            runWorker();
          });
          return;
        }
        workerScheduled = false;
        runWorker();
      });
    } catch {
      workerScheduled = false;
      state.snapshotRequired = true;
      state.dirty = true;
      state.publicationPending = true;
      recordDiagnostic("scheduler-failure");
    }
  };

  const enqueue = (kind: MarkerKind): void => {
    if (markerIndex(state.queue, kind) >= 0) {
      state.coalescedMarkers = incrementCounter(state.coalescedMarkers);
      scheduleWorker();
      return;
    }

    // A replacement snapshot supersedes dirty and settled markers. Keeping one
    // force marker is both safer and smaller than retaining every precursor.
    if (markerIndex(state.queue, "snapshot-required") >= 0) {
      if (kind !== "snapshot-required") {
        state.coalescedMarkers = incrementCounter(state.coalescedMarkers);
      }
      scheduleWorker();
      return;
    }

    if (state.queue.length >= state.queueCapacity) {
      state.droppedMarkers = Math.min(MAX_COUNTER, state.droppedMarkers + state.queue.length);
      state.queue = [{ kind: "snapshot-required" }];
      state.snapshotRequired = true;
      state.dirty = true;
      state.publicationPending = true;
      recordDiagnostic("queue-overflow");
      scheduleWorker();
      return;
    }

    state.queue.push({ kind });
    scheduleWorker();
  };

  const markMutation = (): void => {
    state.mutationSerial = nextCounter(state.mutationSerial);
  };

  const markDirty = (): void => {
    state.dirty = true;
    state.publicationPending = true;
    markMutation();
    enqueue("dirty");
  };

  const markForceSnapshot = (): void => {
    state.snapshotRequired = true;
    state.dirty = true;
    state.publicationPending = true;
    markMutation();
    enqueue("snapshot-required");
  };

  const readSessionView = (): SessionViewResult => {
    let manager: SessionMirrorReadonlySessionManager | undefined;
    try {
      manager = getSessionManager();
    } catch {
      return { ok: false };
    }
    if (manager === undefined || manager === null || typeof manager !== "object") {
      return { ok: false };
    }

    let sessionFile: string | undefined;
    try {
      sessionFile = manager.getSessionFile();
    } catch {
      return { ok: false };
    }
    if (sessionFile !== undefined && typeof sessionFile !== "string") {
      return { ok: false };
    }
    return { ok: true, value: { manager, sessionFile } };
  };

  const disableForAttestation = (
    token: GenerationToken,
    failure: SessionMirrorAttestationFailure,
  ): void => {
    if (!isCurrent(token)) {
      recordDiagnostic("stale-generation");
      return;
    }
    state.enabled = false;
    state.attestation = "disabled";
    state.lastAttestationFailure = failure.reason;
    state.lastProjectionFailure = undefined;
    state.publicationPending = false;
    recordDiagnostic("attestation-failure");
  };

  const attestGeneration = (token: GenerationToken): boolean => {
    if (!isCurrent(token)) {
      recordDiagnostic("stale-generation");
      return false;
    }
    const view = readSessionView();
    if (!isCurrent(token)) {
      recordDiagnostic("stale-generation");
      return false;
    }
    if (!view.ok) {
      if (isCurrent(token)) {
        state.enabled = false;
        state.attestation = "disabled";
        state.publicationPending = false;
        recordDiagnostic("session-unavailable");
      } else {
        recordDiagnostic("stale-generation");
      }
      return false;
    }

    let result: SessionMirrorAttestationResult;
    try {
      result = attest({ sessionFile: view.value.sessionFile });
    } catch {
      if (isCurrent(token)) {
        state.enabled = false;
        state.attestation = "disabled";
        state.publicationPending = false;
        state.lastAttestationFailure = "unsafe-profile-metadata";
        recordDiagnostic("attestation-failure");
      } else {
        recordDiagnostic("stale-generation");
      }
      return false;
    }
    if (!isCurrent(token)) {
      recordDiagnostic("stale-generation");
      return false;
    }
    const outcome = normalizeAttestationResult(result);
    if (typeof outcome !== "string") {
      disableForAttestation(token, outcome);
      return false;
    }
    state.enabled = true;
    state.attestation = outcome === "session-file" ? "attested" : "directory-only";
    state.lastAttestationFailure = undefined;
    return true;
  };

  const createMetadata = (): SessionMirrorSnapshotProjectionMetadata => {
    state.publicationSerial = nextCounter(state.publicationSerial);
    state.revision = nextCounter(state.revision);
    const serial = state.publicationSerial;
    const generation = state.generation;
    return {
      eventId: `g${generation}-e${serial}`,
      revision: state.revision,
      cursor: `g${generation}-c${serial}`,
      snapshotId: `g${generation}-s${serial}`,
      runtimeVersion,
      sessionSchemaVersion,
      status: state.status,
    };
  };

  const completeSink = (operation: SinkOperation, succeeded: boolean): void => {
    if (activeSink === operation) activeSink = undefined;
    if (!isCurrent(operation.token)) {
      recordDiagnostic("stale-generation");
      scheduleWorker();
      return;
    }
    if (!succeeded) {
      state.failedPublications = incrementCounter(state.failedPublications);
      state.snapshotRequired = true;
      state.dirty = true;
      state.publicationPending = true;
      scheduleWorker();
      return;
    }

    state.successfulPublications = incrementCounter(state.successfulPublications);
    if (state.mutationSerial === operation.mutationSerial) {
      state.snapshotRequired = false;
      state.dirty = false;
      state.publicationPending = false;
    } else {
      state.snapshotRequired = true;
      state.dirty = true;
      state.publicationPending = true;
    }
    scheduleWorker();
  };

  const beginSink = (
    token: GenerationToken,
    envelope: SessionMirrorSnapshotProjectionEnvelope,
    mutationSerial: number,
  ): void => {
    if (!isCurrent(token)) {
      recordDiagnostic("stale-generation");
      return;
    }
    if (activeSink !== undefined) return;
    const operation: SinkOperation = { token, mutationSerial };
    activeSink = operation;
    let result: void | PromiseLike<void>;
    try {
      result = sink(envelope);
    } catch {
      if (activeSink === operation) activeSink = undefined;
      if (isCurrent(token)) {
        state.failedPublications = incrementCounter(state.failedPublications);
        state.snapshotRequired = true;
        state.dirty = true;
        state.publicationPending = true;
        recordDiagnostic("sink-throw");
      } else {
        recordDiagnostic("stale-generation");
      }
      scheduleWorker();
      return;
    }

    if (result === undefined) {
      completeSink(operation, true);
      return;
    }

    Promise.resolve(result).then(
      () => completeSink(operation, true),
      () => {
        if (activeSink === operation) activeSink = undefined;
        if (!isCurrent(token)) {
          recordDiagnostic("stale-generation");
          scheduleWorker();
          return;
        }
        state.failedPublications = incrementCounter(state.failedPublications);
        state.snapshotRequired = true;
        state.dirty = true;
        state.publicationPending = true;
        recordDiagnostic("sink-reject");
        scheduleWorker();
      },
    );
  };

  const publishIfReady = (token: GenerationToken): void => {
    if (!isCurrent(token)) {
      recordDiagnostic("stale-generation");
      return;
    }
    if (!state.enabled || !state.settled || !state.publicationPending || activeSink !== undefined) {
      return;
    }

    const view = readSessionView();
    if (!isCurrent(token)) {
      recordDiagnostic("stale-generation");
      return;
    }
    if (!view.ok) {
      state.enabled = false;
      state.attestation = "disabled";
      state.publicationPending = false;
      recordDiagnostic("session-unavailable");
      return;
    }

    let attestation: SessionMirrorAttestationResult;
    try {
      // The concrete file is re-attested immediately before source projection.
      attestation = attest({ sessionFile: view.value.sessionFile });
    } catch {
      if (isCurrent(token)) {
        state.enabled = false;
        state.attestation = "disabled";
        state.publicationPending = false;
        state.lastAttestationFailure = "unsafe-profile-metadata";
        recordDiagnostic("attestation-failure");
      } else {
        recordDiagnostic("stale-generation");
      }
      return;
    }
    if (!isCurrent(token)) {
      recordDiagnostic("stale-generation");
      return;
    }
    const attestationOutcome = normalizeAttestationResult(attestation);
    if (typeof attestationOutcome !== "string") {
      disableForAttestation(token, attestationOutcome);
      return;
    }
    if (attestationOutcome !== "session-file") {
      state.attestation = "directory-only";
      state.snapshotRequired = true;
      state.dirty = true;
      recordDiagnostic("attestation-not-ready");
      return;
    }
    state.enabled = true;
    state.attestation = "attested";

    const metadata = createMetadata();
    const projectionMutationSerial = state.mutationSerial;
    let projection: SessionMirrorSnapshotProjectionResult;
    try {
      projection = project(view.value.manager, metadata);
    } catch {
      if (isCurrent(token)) {
        state.snapshotRequired = true;
        state.dirty = true;
        state.publicationPending = true;
        state.lastProjectionFailure = "unsafe-session-data";
        state.failedPublications = incrementCounter(state.failedPublications);
        recordDiagnostic("projection-failure");
      } else {
        recordDiagnostic("stale-generation");
      }
      return;
    }
    if (!isCurrent(token)) {
      recordDiagnostic("stale-generation");
      return;
    }
    try {
      if (!projection.ok) {
        state.snapshotRequired = true;
        state.dirty = true;
        state.publicationPending = true;
        state.lastProjectionFailure = normalizedProjectionReason(projection.reason);
        state.failedPublications = incrementCounter(state.failedPublications);
        recordDiagnostic("projection-failure");
        return;
      }
      state.lastProjectionFailure = undefined;
      beginSink(token, projection.envelope, projectionMutationSerial);
    } catch {
      if (isCurrent(token)) {
        state.snapshotRequired = true;
        state.dirty = true;
        state.publicationPending = true;
        state.lastProjectionFailure = "unsafe-session-data";
        state.failedPublications = incrementCounter(state.failedPublications);
        recordDiagnostic("projection-failure");
      } else {
        recordDiagnostic("stale-generation");
      }
    }
  };

  function runWorker(): void {
    if (workerRunning) {
      workerAgain = true;
      return;
    }
    if (activeSink !== undefined || state.queue.length === 0) return;
    workerRunning = true;
    workerAgain = false;
    const token = currentToken();
    let publicationRequested = false;
    try {
      while (isCurrent(token) && state.queue.length > 0) {
        const marker = state.queue.shift();
        if (!marker) break;
        switch (marker.kind) {
          case "session-start":
            attestGeneration(token);
            break;
          case "agent-start":
            state.status = "active";
            state.settled = false;
            break;
          case "dirty":
            state.dirty = true;
            break;
          case "agent-settled":
            state.status = "idle";
            state.settled = true;
            publicationRequested = true;
            break;
          case "snapshot-required":
            // Overflow may replace a pending session-start marker. Re-attest
            // before honoring the replacement request when that happens.
            if (state.attestation === "pending") attestGeneration(token);
            publicationRequested = true;
            break;
        }
      }
      if (isCurrent(token) && publicationRequested) publishIfReady(token);
    } catch {
      if (isCurrent(token)) {
        state.snapshotRequired = true;
        state.dirty = true;
        state.publicationPending = true;
        state.lastProjectionFailure = "unsafe-session-data";
        state.failedPublications = incrementCounter(state.failedPublications);
        recordDiagnostic("projection-failure");
      } else {
        recordDiagnostic("stale-generation");
      }
    } finally {
      workerRunning = false;
      if (workerAgain) {
        workerAgain = false;
        scheduleWorker();
      } else if (state.queue.length > 0 && activeSink === undefined) {
        scheduleWorker();
      }
    }
  }

  const sessionStart = (): void => {
    lifecycleDepth += 1;
    try {
      state.generation = nextCounter(state.generation);
      state.token = { serial: state.generation };
      state.attestation = "pending";
      state.enabled = false;
      state.status = "idle";
      state.settled = true;
      state.dirty = true;
      state.snapshotRequired = true;
      state.publicationPending = false;
      state.queue = [];
      state.revision = 0;
      state.publicationSerial = 0;
      state.mutationSerial = 0;
      state.lastDiagnostic = undefined;
      state.lastAttestationFailure = undefined;
      state.lastProjectionFailure = undefined;
      enqueue("session-start");
    } finally {
      lifecycleDepth -= 1;
    }
  };

  const agentStart = (): void => {
    lifecycleDepth += 1;
    try {
      state.status = "active";
      state.settled = false;
      markMutation();
      enqueue("agent-start");
    } finally {
      lifecycleDepth -= 1;
    }
  };

  const messageEnd = (): void => {
    lifecycleDepth += 1;
    try {
      markDirty();
    } finally {
      lifecycleDepth -= 1;
    }
  };

  const turnEnd = (): void => {
    lifecycleDepth += 1;
    try {
      markDirty();
    } finally {
      lifecycleDepth -= 1;
    }
  };

  const agentSettled = (): void => {
    lifecycleDepth += 1;
    try {
      state.status = "idle";
      state.settled = true;
      state.publicationPending = true;
      markMutation();
      enqueue("agent-settled");
    } finally {
      lifecycleDepth -= 1;
    }
  };

  const sessionTree = (): void => {
    lifecycleDepth += 1;
    try {
      markForceSnapshot();
    } finally {
      lifecycleDepth -= 1;
    }
  };

  const sessionCompact = (): void => {
    lifecycleDepth += 1;
    try {
      markForceSnapshot();
    } finally {
      lifecycleDepth -= 1;
    }
  };

  const requestSnapshot = (): void => {
    lifecycleDepth += 1;
    try {
      markForceSnapshot();
    } finally {
      lifecycleDepth -= 1;
    }
  };

  const sessionShutdown = (): void => {
    lifecycleDepth += 1;
    try {
      state.generation = nextCounter(state.generation);
      state.token = { serial: state.generation };
      state.attestation = "shutdown";
      state.enabled = false;
      state.status = "unknown";
      state.settled = true;
      state.dirty = false;
      state.snapshotRequired = false;
      state.publicationPending = false;
      state.queue = [];
      state.revision = 0;
      state.publicationSerial = 0;
      state.mutationSerial = 0;
      state.lastDiagnostic = undefined;
      state.lastAttestationFailure = undefined;
      state.lastProjectionFailure = undefined;
    } finally {
      lifecycleDepth -= 1;
    }
  };

  const getState = (): SessionMirrorObserverState =>
    Object.freeze({
      generation: state.generation,
      enabled: state.enabled,
      attestation: state.attestation,
      status: state.status,
      settled: state.settled,
      dirty: state.dirty,
      snapshotRequired: state.snapshotRequired,
      publicationPending: state.publicationPending,
      queueDepth: state.queue.length,
      queueCapacity: state.queueCapacity,
      sinkInFlight: activeSink !== undefined,
      revision: state.revision,
      successfulPublications: state.successfulPublications,
      failedPublications: state.failedPublications,
      coalescedMarkers: state.coalescedMarkers,
      droppedMarkers: state.droppedMarkers,
      diagnostics: freezeDiagnostics(state.diagnostics),
      lastDiagnostic: state.lastDiagnostic,
      lastAttestationFailure: state.lastAttestationFailure,
      lastProjectionFailure: state.lastProjectionFailure,
    });

  return Object.freeze({
    sessionStart,
    agentStart,
    messageEnd,
    turnEnd,
    agentSettled,
    sessionTree,
    sessionCompact,
    sessionShutdown,
    requestSnapshot,
    getState,
  });
}

/** Short public alias used by the future opt-in extension integration. */
export const createSessionMirrorObserver = createSessionMirrorObserverRuntime;

export default createSessionMirrorObserverRuntime;

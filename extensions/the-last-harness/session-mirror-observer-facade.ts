import { performance } from "node:perf_hooks";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import {
  getTlhExperimentalConfig,
  isTlhExperimentalFeatureEnabled,
  SESSION_MIRROR_OBSERVER_FEATURE,
} from "./experimental.js";
import { attestSessionMirrorSession } from "./session-mirror/profile-attestation.js";
import type {
  SessionMirrorAttestationReason,
  SessionMirrorAttestationResult,
} from "./session-mirror/profile-attestation.js";
import type {
  SessionMirrorObserverAttestor,
  SessionMirrorObserverState,
} from "./session-mirror/observer.js";
import type {
  SessionMirrorObserverEnvelopeCategory,
  SessionMirrorObserverProbe,
  SessionMirrorObserverProbeMetrics,
  SessionMirrorObserverProbeState,
  SessionMirrorObserverTimingBucket,
} from "./session-mirror-observer-probe.js";

type SessionMirrorObserverProbeModule = typeof import("./session-mirror-observer-probe.js");

type FacadeLoadState = "not-loaded" | "loading" | "loaded" | "failed" | "shutdown";
type FacadeActiveState = "disabled" | "pending" | "enabled";
type FacadeAttestationState =
  | "not-run"
  | "pending"
  | "attested"
  | "directory-only"
  | "disabled"
  | "shutdown"
  | "failed";

export const SESSION_MIRROR_OBSERVER_RUNTIME_VERSION = "tlh-session-mirror-runtime-v1";
export const SESSION_MIRROR_OBSERVER_SESSION_SCHEMA_VERSION = "pi-session-schema-v3";
export const SESSION_MIRROR_OBSERVER_COMMAND = "session-mirror-observer";

const DEFAULT_QUEUE_CAPACITY = 8;
const MAX_FACADE_GENERATION = 2_000_000_000;
const ZERO_TIMING: SessionMirrorObserverTimingBucket = "unknown";

type SessionMirrorObserverActivationSnapshot = {
  readonly sessionConfigured: boolean;
};

const SESSION_MIRROR_OBSERVER_ACTIVATION_SNAPSHOT_KEY = Symbol.for(
  "the-last-harness.session-mirror-observer-activation-snapshot",
);
const SESSION_MIRROR_OBSERVER_GLOBAL = globalThis as typeof globalThis & {
  [SESSION_MIRROR_OBSERVER_ACTIVATION_SNAPSHOT_KEY]?: SessionMirrorObserverActivationSnapshot;
};

function closedActivationSnapshotValue(value: unknown): boolean | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 1 || keys[0] !== "sessionConfigured") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, "sessionConfigured");
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "boolean"
    ) {
      return undefined;
    }
    return descriptor.value;
  } catch {
    // Descriptor/proxy failures are closed snapshot failures. In particular,
    // never read a potentially hostile snapshot accessor.
    return undefined;
  }
}

function allowedActivationSnapshotDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } {
  return (
    descriptor !== undefined &&
    Object.hasOwn(descriptor, "value") &&
    descriptor.writable === true &&
    descriptor.configurable === true
  );
}

function readActivationSnapshot(): boolean | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      SESSION_MIRROR_OBSERVER_GLOBAL,
      SESSION_MIRROR_OBSERVER_ACTIVATION_SNAPSHOT_KEY,
    );
    if (!allowedActivationSnapshotDescriptor(descriptor)) return undefined;
    return closedActivationSnapshotValue(descriptor.value);
  } catch {
    return undefined;
  }
}

function writeActivationSnapshot(sessionConfigured: boolean, isCurrent: () => boolean): boolean {
  try {
    if (!isCurrent()) return false;
    const existing = Object.getOwnPropertyDescriptor(
      SESSION_MIRROR_OBSERVER_GLOBAL,
      SESSION_MIRROR_OBSERVER_ACTIVATION_SNAPSHOT_KEY,
    );
    if (!isCurrent()) return false;
    if (existing) {
      // Accessor properties are never invoked or replaced. Requiring both
      // attributes also keeps an unmanaged Symbol property fail-closed.
      if (!allowedActivationSnapshotDescriptor(existing)) return false;
      const existingValue = existing.value;
      if (closedActivationSnapshotValue(existingValue) === undefined) return false;
      if (!isCurrent()) return false;

      const reread = Object.getOwnPropertyDescriptor(
        SESSION_MIRROR_OBSERVER_GLOBAL,
        SESSION_MIRROR_OBSERVER_ACTIVATION_SNAPSHOT_KEY,
      );
      if (!isCurrent()) return false;
      if (!allowedActivationSnapshotDescriptor(reread) || reread.value !== existingValue) {
        return false;
      }
    } else if (!isCurrent()) {
      return false;
    }

    // Guard both snapshot creation and the write itself so a hostile
    // reflection trap cannot let a stale generation overwrite its successor.
    if (!isCurrent()) return false;
    const snapshot = Object.freeze({ sessionConfigured });
    if (!isCurrent()) return false;
    const defined = Reflect.defineProperty(
      SESSION_MIRROR_OBSERVER_GLOBAL,
      SESSION_MIRROR_OBSERVER_ACTIVATION_SNAPSHOT_KEY,
      {
        value: snapshot,
        writable: true,
        enumerable: existing?.enumerable ?? false,
        configurable: true,
      },
    );
    if (!defined || !isCurrent()) return false;

    const verification = Object.getOwnPropertyDescriptor(
      SESSION_MIRROR_OBSERVER_GLOBAL,
      SESSION_MIRROR_OBSERVER_ACTIVATION_SNAPSHOT_KEY,
    );
    if (!isCurrent()) return false;
    return (
      allowedActivationSnapshotDescriptor(verification) &&
      verification.value === snapshot &&
      closedActivationSnapshotValue(verification.value) === sessionConfigured
    );
  } catch {
    return false;
  }
}

/**
 * Injectable seams keep facade tests on synthetic/temp fixtures while the
 * production default remains a retryable native dynamic import.
 */
export interface SessionMirrorObserverFacadeOptions {
  readonly loadProbe?: () => Promise<SessionMirrorObserverProbeModule>;
  readonly attest?: SessionMirrorObserverAttestor;
  readonly now?: () => number;
}

export interface SessionMirrorObserverFacadeStatus {
  readonly configured: boolean;
  readonly sessionConfigured: boolean | undefined;
  readonly nextSessionConfigured: boolean;
  readonly active: FacadeActiveState;
  readonly load: FacadeLoadState;
  readonly attestation: FacadeAttestationState;
  readonly attestationReason: SessionMirrorAttestationReason | undefined;
  readonly queueDepth: number;
  readonly queueCapacity: number;
  readonly sinkInFlight: boolean;
  readonly snapshotRequired: boolean;
  readonly envelopeCategory: SessionMirrorObserverEnvelopeCategory;
  readonly entryCount: number;
  readonly rootCount: number;
  readonly maxDepth: number;
  readonly envelopeBytes: number;
  readonly timing: {
    readonly load: SessionMirrorObserverTimingBucket;
    readonly attestation: SessionMirrorObserverTimingBucket;
    readonly projection: SessionMirrorObserverTimingBucket;
    readonly sink: SessionMirrorObserverTimingBucket;
  };
  readonly diagnostics: SessionMirrorObserverState["diagnostics"];
  readonly lastDiagnostic: SessionMirrorObserverState["lastDiagnostic"];
  readonly lastProjectionFailure: SessionMirrorObserverState["lastProjectionFailure"];
  readonly runtimeFailures: number;
}

export interface SessionMirrorObserverFacade {
  readonly sessionStart: (
    ctx: ExtensionContext,
    reason?: SessionStartEvent["reason"],
  ) => Promise<void>;
  readonly sessionShutdown: () => void;
  readonly agentStart: () => void;
  readonly messageEnd: () => void;
  readonly turnEnd: () => void;
  readonly agentSettled: () => void;
  readonly sessionTree: () => void;
  readonly sessionCompact: () => void;
  readonly requestSnapshot: () => boolean;
  readonly getStatus: (
    ctx: ExtensionContext | ExtensionCommandContext,
  ) => SessionMirrorObserverFacadeStatus;
  readonly handleStatus: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

type InternalState = {
  generation: number;
  sessionConfigured: boolean | undefined;
  load: FacadeLoadState;
  attestation: FacadeAttestationState;
  attestationReason: SessionMirrorAttestationReason | undefined;
  probe: SessionMirrorObserverProbe | undefined;
  loadTiming: SessionMirrorObserverTimingBucket;
  attestationTiming: SessionMirrorObserverTimingBucket;
};

function nextGeneration(value: number): number {
  return value >= MAX_FACADE_GENERATION ? 1 : value + 1;
}

function safeNow(now: () => number): number | undefined {
  try {
    const value = now();
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function timingBucket(duration: number | undefined): SessionMirrorObserverTimingBucket {
  if (duration === undefined || !Number.isFinite(duration) || duration < 0) return ZERO_TIMING;
  if (duration <= 1) return "fast";
  if (duration <= 10) return "moderate";
  if (duration <= 100) return "slow";
  return "extended";
}

function measuredTiming(
  startedAt: number | undefined,
  now: () => number,
): SessionMirrorObserverTimingBucket {
  const finishedAt = safeNow(now);
  return startedAt === undefined || finishedAt === undefined
    ? ZERO_TIMING
    : timingBucket(Math.max(0, finishedAt - startedAt));
}

function initialState(): InternalState {
  return {
    generation: 0,
    sessionConfigured: undefined,
    load: "not-loaded",
    attestation: "not-run",
    attestationReason: undefined,
    probe: undefined,
    loadTiming: ZERO_TIMING,
    attestationTiming: ZERO_TIMING,
  };
}

function configuredForCwd(cwd: string): boolean {
  try {
    return isTlhExperimentalFeatureEnabled(
      getTlhExperimentalConfig(cwd),
      SESSION_MIRROR_OBSERVER_FEATURE,
    );
  } catch {
    return false;
  }
}

function configuredForContext(ctx: ExtensionContext | ExtensionCommandContext): boolean {
  try {
    return configuredForCwd(ctx.cwd);
  } catch {
    return false;
  }
}

function safeSessionFile(
  sessionManager: ExtensionContext["sessionManager"] | undefined,
): string | undefined {
  try {
    const sessionFile = sessionManager?.getSessionFile();
    return typeof sessionFile === "string" ? sessionFile : undefined;
  } catch {
    return undefined;
  }
}

function safeAttest(
  attest: SessionMirrorObserverAttestor,
  sessionFile: string | undefined,
): SessionMirrorAttestationResult {
  try {
    const result = attest({ sessionFile });
    if (result && result.ok === true) {
      const phase = result.phase;
      if (phase === "session-file" || phase === "directory-only") {
        return { ok: true, phase };
      }
    }
    if (result && result.ok === false) {
      const reason = result.reason;
      if (
        typeof reason === "string" &&
        [
          "missing-profile-selection",
          "missing-home",
          "default-or-normal-profile",
          "profile-mismatch",
          "unsafe-profile-metadata",
          "ephemeral-session",
          "session-escape",
          "unsafe-session-metadata",
        ].includes(reason)
      ) {
        return { ok: false, reason };
      }
    }
  } catch {
    // A production or injected attestor failure is deliberately aggregate-only.
  }
  return { ok: false, reason: "unsafe-profile-metadata" };
}

const OBSERVER_ATTESTATION_STATES = [
  "pending",
  "attested",
  "directory-only",
  "disabled",
  "shutdown",
] as const;
const OBSERVER_STATUS_VALUES = ["idle", "active", "waiting", "error", "unknown"] as const;
const OBSERVER_DIAGNOSTIC_CODES = [
  "queue-overflow",
  "stale-generation",
  "scheduler-failure",
  "session-unavailable",
  "attestation-failure",
  "attestation-not-ready",
  "projection-failure",
  "sink-throw",
  "sink-reject",
] as const;
const ATTESTATION_REASONS = [
  "missing-profile-selection",
  "missing-home",
  "default-or-normal-profile",
  "profile-mismatch",
  "unsafe-profile-metadata",
  "ephemeral-session",
  "session-escape",
  "unsafe-session-metadata",
] as const;
const PROJECTION_REASONS = [
  "invalid-metadata",
  "session-unavailable",
  "unsafe-session-data",
  "bounds-exceeded",
] as const;
const PROBE_ENVELOPE_CATEGORIES = [
  "none",
  "empty",
  "text",
  "placeholder",
  "mixed",
  "error",
] as const;
const TIMING_BUCKET_VALUES = ["unknown", "fast", "moderate", "slow", "extended"] as const;
const MAX_OBSERVER_COUNTER = 2_000_000_000;
const MAX_OBSERVER_QUEUE_CAPACITY = 32;

function boundedCounter(value: unknown, maximum = MAX_OBSERVER_COUNTER): number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0
    ? Math.min(value, maximum)
    : 0;
}

function boundedBoolean(value: unknown): boolean {
  return value === true;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && values.includes(value as T) ? (value as T) : fallback;
}

function optionalEnumValue<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === "string" && values.includes(value as T) ? (value as T) : undefined;
}

function boundedDiagnosticCounts(value: unknown): SessionMirrorObserverState["diagnostics"] {
  const source = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  const count = (key: string): number => {
    try {
      return boundedCounter((source as Record<string, unknown>)[key]);
    } catch {
      return 0;
    }
  };
  return Object.freeze({
    queueOverflow: count("queueOverflow"),
    staleGeneration: count("staleGeneration"),
    schedulerFailure: count("schedulerFailure"),
    sessionUnavailable: count("sessionUnavailable"),
    attestationFailure: count("attestationFailure"),
    attestationNotReady: count("attestationNotReady"),
    projectionFailure: count("projectionFailure"),
    sinkThrow: count("sinkThrow"),
    sinkReject: count("sinkReject"),
  });
}

function normalizeProbeState(value: unknown): SessionMirrorObserverProbeState | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const source = value as Record<string, unknown>;
    const queueCapacity = Math.min(
      Math.max(boundedCounter(source.queueCapacity, MAX_OBSERVER_QUEUE_CAPACITY), 1),
      MAX_OBSERVER_QUEUE_CAPACITY,
    );
    const timing = source.timing;
    const timingRecord =
      timing !== null && typeof timing === "object" && !Array.isArray(timing)
        ? (timing as Record<string, unknown>)
        : {};
    return Object.freeze({
      generation: boundedCounter(source.generation),
      enabled: boundedBoolean(source.enabled),
      attestation: enumValue(source.attestation, OBSERVER_ATTESTATION_STATES, "disabled"),
      status: enumValue(source.status, OBSERVER_STATUS_VALUES, "unknown"),
      settled: boundedBoolean(source.settled),
      dirty: boundedBoolean(source.dirty),
      snapshotRequired: boundedBoolean(source.snapshotRequired),
      publicationPending: boundedBoolean(source.publicationPending),
      queueDepth: Math.min(boundedCounter(source.queueDepth, queueCapacity), queueCapacity),
      queueCapacity,
      sinkInFlight: boundedBoolean(source.sinkInFlight),
      revision: boundedCounter(source.revision),
      successfulPublications: boundedCounter(source.successfulPublications),
      failedPublications: boundedCounter(source.failedPublications),
      coalescedMarkers: boundedCounter(source.coalescedMarkers),
      droppedMarkers: boundedCounter(source.droppedMarkers),
      diagnostics: boundedDiagnosticCounts(source.diagnostics),
      lastDiagnostic: optionalEnumValue(source.lastDiagnostic, OBSERVER_DIAGNOSTIC_CODES),
      lastAttestationFailure: optionalEnumValue(source.lastAttestationFailure, ATTESTATION_REASONS),
      lastProjectionFailure: optionalEnumValue(source.lastProjectionFailure, PROJECTION_REASONS),
      envelopeCategory: enumValue(source.envelopeCategory, PROBE_ENVELOPE_CATEGORIES, "none"),
      entryCount: boundedCounter(source.entryCount, 1024),
      rootCount: boundedCounter(source.rootCount, 1024),
      maxDepth: boundedCounter(source.maxDepth, 128),
      envelopeBytes: boundedCounter(source.envelopeBytes, 256 * 1024),
      timing: Object.freeze({
        attestation: enumValue(timingRecord.attestation, TIMING_BUCKET_VALUES, "unknown"),
        projection: enumValue(timingRecord.projection, TIMING_BUCKET_VALUES, "unknown"),
        sink: enumValue(timingRecord.sink, TIMING_BUCKET_VALUES, "unknown"),
      }),
      runtimeFailures: boundedCounter(source.runtimeFailures),
    });
  } catch {
    return undefined;
  }
}

function safeProbeState(
  probe: SessionMirrorObserverProbe | undefined,
): SessionMirrorObserverProbeState | undefined {
  if (!probe) return undefined;
  try {
    return normalizeProbeState(probe.getState());
  } catch {
    return undefined;
  }
}

function safeNotify(ctx: ExtensionCommandContext, message: string): void {
  try {
    ctx.ui.notify(message, "info");
  } catch {
    // Command output is best effort and must not turn observer diagnostics into errors.
  }
}

function noProbeMetrics(): SessionMirrorObserverProbeMetrics {
  return {
    envelopeCategory: "none",
    entryCount: 0,
    rootCount: 0,
    maxDepth: 0,
    envelopeBytes: 0,
    timing: {
      attestation: ZERO_TIMING,
      projection: ZERO_TIMING,
      sink: ZERO_TIMING,
    },
    runtimeFailures: 0,
  };
}

function noProbeDiagnostics(): SessionMirrorObserverState["diagnostics"] {
  return Object.freeze({
    queueOverflow: 0,
    staleGeneration: 0,
    schedulerFailure: 0,
    sessionUnavailable: 0,
    attestationFailure: 0,
    attestationNotReady: 0,
    projectionFailure: 0,
    sinkThrow: 0,
    sinkReject: 0,
  });
}

function formatValue(value: boolean): "enabled" | "disabled" {
  return value ? "enabled" : "disabled";
}

function pressure(value: number, limit: number): "none" | "low" | "medium" | "high" | "full" {
  if (value <= 0) return "none";
  if (value >= limit) return "full";
  const percentage = value / limit;
  if (percentage <= 0.25) return "low";
  if (percentage <= 0.5) return "medium";
  return "high";
}

function formatReason(reason: SessionMirrorAttestationReason | undefined): string {
  return reason ? `(${reason})` : "";
}

function formatDiagnostics(diagnostics: SessionMirrorObserverState["diagnostics"]): string {
  const values = Object.entries(diagnostics).filter(([, value]) => value > 0);
  return values.length === 0 ? "none" : values.map(([name, value]) => `${name}=${value}`).join(",");
}

export function formatSessionMirrorObserverStatus(
  status: SessionMirrorObserverFacadeStatus,
): string {
  const entryPressure = pressure(status.entryCount, 1024);
  const rootPressure = pressure(status.rootCount, 1024);
  const depthPressure = pressure(status.maxDepth, 128);
  const bytePressure = pressure(status.envelopeBytes, 256 * 1024);
  return [
    `${SESSION_MIRROR_OBSERVER_COMMAND}:`,
    `configured=${formatValue(status.configured)}`,
    `session-configured=${status.sessionConfigured === undefined ? "none" : formatValue(status.sessionConfigured)}`,
    `active=${status.active}`,
    `next-session=${formatValue(status.nextSessionConfigured)}`,
    "changes=next-session-only",
    `load=${status.load}`,
    `attestation=${status.attestation}${formatReason(status.attestationReason)}`,
    `queue=${status.queueDepth}/${status.queueCapacity}`,
    `sink=${status.sinkInFlight ? "in-flight" : "idle"}`,
    `snapshot-required=${status.snapshotRequired ? "yes" : "no"}`,
    `envelope=${status.envelopeCategory}`,
    `entries=${status.entryCount}/1024(${entryPressure})`,
    `roots=${status.rootCount}/1024(${rootPressure})`,
    `depth=${status.maxDepth}/128(${depthPressure})`,
    `envelope-bytes=${status.envelopeBytes}/262144(${bytePressure})`,
    `timing=load:${status.timing.load},attestation:${status.timing.attestation},projection:${status.timing.projection},sink:${status.timing.sink}`,
    `diagnostics=${formatDiagnostics(status.diagnostics)}`,
  ].join(" ");
}

function observerActiveState(
  load: FacadeLoadState,
  probeState: SessionMirrorObserverProbeState | undefined,
): FacadeActiveState {
  if (probeState?.enabled) return "enabled";
  if (load === "loading" || probeState?.attestation === "pending") return "pending";
  return "disabled";
}

function safeShutdownProbe(probe: SessionMirrorObserverProbe | undefined): void {
  if (!probe) return;
  try {
    probe.sessionShutdown();
  } catch {
    // A stale probe cannot block replacement or shutdown.
  }
}

type SessionMirrorObserverActivationInput = {
  readonly state: InternalState;
  readonly isCurrent: (state: InternalState) => boolean;
  readonly sessionManager: NonNullable<ExtensionContext["sessionManager"]>;
  readonly loadProbe: () => Promise<SessionMirrorObserverProbeModule>;
  readonly attest: SessionMirrorObserverAttestor;
  readonly now: () => number;
};

/**
 * Continue activation after synchronous context extraction and attestation.
 * This helper deliberately accepts no ExtensionContext, so a pending loader
 * retains only the pinned manager, per-start state/token, and bounded seams.
 */
function continueSessionMirrorObserverActivation(
  input: SessionMirrorObserverActivationInput,
): Promise<void> {
  const { state, isCurrent, sessionManager, loadProbe, attest, now } = input;
  const current = (): boolean => isCurrent(state);

  if (!current()) return Promise.resolve();
  state.load = "loading";
  const loadStartedAt = safeNow(now);
  if (!current()) return Promise.resolve();

  let pendingModule: Promise<SessionMirrorObserverProbeModule>;
  try {
    pendingModule = loadProbe();
  } catch {
    if (!current()) return Promise.resolve();
    const loadTiming = measuredTiming(loadStartedAt, now);
    if (!current()) return Promise.resolve();
    state.loadTiming = loadTiming;
    if (!current()) return Promise.resolve();
    state.load = "failed";
    return Promise.resolve();
  }
  if (!current()) return Promise.resolve();

  return Promise.resolve(pendingModule).then(
    (module) => {
      if (!current()) return;
      const loadTiming = measuredTiming(loadStartedAt, now);
      if (!current()) return;
      state.loadTiming = loadTiming;
      if (!current()) return;

      let probe: SessionMirrorObserverProbe;
      try {
        if (!current()) return;
        probe = module.createSessionMirrorObserverProbe({
          getSessionManager: () => sessionManager,
          attest,
          runtimeVersion: SESSION_MIRROR_OBSERVER_RUNTIME_VERSION,
          sessionSchemaVersion: SESSION_MIRROR_OBSERVER_SESSION_SCHEMA_VERSION,
        });
      } catch {
        if (!current()) return;
        state.load = "failed";
        return;
      }

      if (!current()) {
        safeShutdownProbe(probe);
        return;
      }
      state.probe = probe;
      state.load = "loaded";
      if (!current()) {
        if (state.probe === probe) state.probe = undefined;
        safeShutdownProbe(probe);
        return;
      }

      try {
        probe.sessionStart();
      } catch {
        if (!current()) {
          if (state.probe === probe) state.probe = undefined;
          safeShutdownProbe(probe);
          return;
        }
        if (state.probe === probe) state.probe = undefined;
        state.load = "failed";
        safeShutdownProbe(probe);
        return;
      }
      if (!current()) {
        if (state.probe === probe) state.probe = undefined;
        safeShutdownProbe(probe);
      }
    },
    () => {
      if (!current()) return;
      const loadTiming = measuredTiming(loadStartedAt, now);
      if (!current()) return;
      state.loadTiming = loadTiming;
      if (!current()) return;
      state.load = "failed";
    },
  );
}

/**
 * Eager, aggregate-only registration facade. It owns config snapshots,
 * attestation-before-import gating, command output, and lifecycle forwarding;
 * the observer/probe implementation remains behind one retryable lazy import.
 */
export function createSessionMirrorObserverFacade(
  options: SessionMirrorObserverFacadeOptions = {},
): SessionMirrorObserverFacade {
  const now = options.now ?? (() => performance.now());
  const attest = options.attest ?? attestSessionMirrorSession;
  const loadProbe = createRetryableLazyImport(
    options.loadProbe ?? (() => import("./session-mirror-observer-probe.js")),
  );
  let state = initialState();
  const isCurrent = (candidate: InternalState): boolean => state === candidate;

  const sessionStart = (
    ctx: ExtensionContext,
    reason: SessionStartEvent["reason"] = "startup",
  ): Promise<void> => {
    const previousState = state;
    const nextState: InternalState = {
      ...initialState(),
      generation: nextGeneration(previousState.generation),
    };
    const previousProbe = previousState.probe;
    // Commit replacement state before invoking any old probe method. An old
    // probe may synchronously re-enter sessionStart/sessionShutdown.
    state = nextState;
    previousState.probe = undefined;
    safeShutdownProbe(previousProbe);
    if (!isCurrent(nextState)) return Promise.resolve();

    // Capture only bounded context values before the lazy import can suspend.
    // The continuation below receives no ExtensionContext and therefore cannot
    // retain UI, model, event, or other session data through a pending load.
    let sessionManager: ExtensionContext["sessionManager"] | undefined;
    try {
      sessionManager = ctx?.sessionManager;
    } catch {
      sessionManager = undefined;
    }
    if (!isCurrent(nextState)) return Promise.resolve();

    let cwd = "";
    try {
      cwd = ctx?.cwd ?? "";
    } catch {
      // A malformed context is treated as disabled below.
    }
    if (!isCurrent(nextState)) return Promise.resolve();

    const previousActivation = reason === "reload" ? readActivationSnapshot() : undefined;
    if (!isCurrent(nextState)) return Promise.resolve();
    const configured = previousActivation ?? configuredForCwd(cwd);
    if (!isCurrent(nextState)) return Promise.resolve();
    if (reason !== "reload" || previousActivation === undefined) {
      const stored = writeActivationSnapshot(configured, () => isCurrent(nextState));
      if (!isCurrent(nextState)) return Promise.resolve();
      if (!stored) {
        nextState.sessionConfigured = false;
        return Promise.resolve();
      }
    }
    if (!isCurrent(nextState)) return Promise.resolve();
    nextState.sessionConfigured = configured;
    if (!configured) return Promise.resolve();
    if (!sessionManager) {
      nextState.attestation = "failed";
      nextState.attestationReason = "unsafe-session-metadata";
      return Promise.resolve();
    }

    nextState.attestation = "pending";
    const attestationStartedAt = safeNow(now);
    if (!isCurrent(nextState)) return Promise.resolve();
    const sessionFile = safeSessionFile(sessionManager);
    if (!isCurrent(nextState)) return Promise.resolve();
    const attestation = safeAttest(attest, sessionFile);
    if (!isCurrent(nextState)) return Promise.resolve();
    const attestationTiming = measuredTiming(attestationStartedAt, now);
    if (!isCurrent(nextState)) return Promise.resolve();
    nextState.attestationTiming = attestationTiming;
    if (!isCurrent(nextState)) return Promise.resolve();
    if (!attestation.ok) {
      nextState.attestation = "failed";
      nextState.attestationReason = attestation.reason;
      return Promise.resolve();
    }
    nextState.attestation = attestation.phase === "session-file" ? "attested" : "directory-only";

    return continueSessionMirrorObserverActivation({
      state: nextState,
      isCurrent,
      sessionManager,
      loadProbe,
      attest,
      now,
    });
  };

  const sessionShutdown = (): void => {
    const previousState = state;
    const previousProbe = previousState.probe;
    const next = nextGeneration(previousState.generation);
    // Commit shutdown state before invoking an old probe's potentially
    // reentrant shutdown method.
    state = {
      ...initialState(),
      generation: next,
      load: "shutdown",
      attestation: "shutdown",
    };
    previousState.probe = undefined;
    safeShutdownProbe(previousProbe);
  };

  const forward = (
    method: keyof Pick<
      SessionMirrorObserverProbe,
      "agentStart" | "messageEnd" | "turnEnd" | "agentSettled" | "sessionTree" | "sessionCompact"
    >,
  ): void => {
    const probe = state.probe;
    if (!probe) return;
    try {
      probe[method]();
    } catch {
      // Probe methods are fail-open and lifecycle forwarding never propagates errors.
    }
  };

  const requestSnapshot = (): boolean => {
    const probe = state.probe;
    if (!probe) return false;
    try {
      probe.requestSnapshot();
      return true;
    } catch {
      return false;
    }
  };

  const getStatus = (
    ctx: ExtensionContext | ExtensionCommandContext,
  ): SessionMirrorObserverFacadeStatus => {
    const probeState = safeProbeState(state.probe);
    const metrics = probeState ?? noProbeMetrics();
    const observerState = probeState;
    const configured = configuredForContext(ctx);
    const attestation = observerState ? observerState.attestation : state.attestation;
    const attestationState: FacadeAttestationState =
      attestation === "pending" ||
      attestation === "attested" ||
      attestation === "directory-only" ||
      attestation === "disabled" ||
      attestation === "shutdown"
        ? attestation
        : attestation === "failed"
          ? "failed"
          : "not-run";
    const diagnostics = observerState?.diagnostics ?? noProbeDiagnostics();
    const queueDepth = observerState?.queueDepth ?? 0;
    const queueCapacity = observerState?.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
    return Object.freeze({
      configured,
      sessionConfigured: state.sessionConfigured,
      nextSessionConfigured: configured,
      active: observerActiveState(state.load, observerState),
      load: state.load,
      attestation: attestationState,
      attestationReason: observerState?.lastAttestationFailure ?? state.attestationReason,
      queueDepth,
      queueCapacity,
      sinkInFlight: observerState?.sinkInFlight ?? false,
      snapshotRequired: observerState?.snapshotRequired ?? false,
      envelopeCategory: metrics.envelopeCategory,
      entryCount: metrics.entryCount,
      rootCount: metrics.rootCount,
      maxDepth: metrics.maxDepth,
      envelopeBytes: metrics.envelopeBytes,
      timing: Object.freeze({
        load: state.loadTiming,
        attestation:
          metrics.timing.attestation === ZERO_TIMING
            ? state.attestationTiming
            : metrics.timing.attestation,
        projection: metrics.timing.projection,
        sink: metrics.timing.sink,
      }),
      diagnostics,
      lastDiagnostic: observerState?.lastDiagnostic,
      lastProjectionFailure: observerState?.lastProjectionFailure,
      runtimeFailures: metrics.runtimeFailures,
    });
  };

  const handleStatus = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const command = typeof args === "string" ? args.trim().toLowerCase() : "";
    if (command !== "" && command !== "status" && command !== "snapshot") {
      safeNotify(ctx, `Usage: /${SESSION_MIRROR_OBSERVER_COMMAND} [status|snapshot]`);
      return;
    }
    if (command === "snapshot") {
      const requested = requestSnapshot();
      safeNotify(
        ctx,
        requested
          ? `Session-mirror observer snapshot requested; work remains deferred and nonblocking. ${formatSessionMirrorObserverStatus(getStatus(ctx))}`
          : `Session-mirror observer is not active; no snapshot was started. Changes apply on the next session. ${formatSessionMirrorObserverStatus(getStatus(ctx))}`,
      );
      return;
    }
    safeNotify(ctx, formatSessionMirrorObserverStatus(getStatus(ctx)));
  };

  return Object.freeze({
    sessionStart,
    sessionShutdown,
    agentStart: () => forward("agentStart"),
    messageEnd: () => forward("messageEnd"),
    turnEnd: () => forward("turnEnd"),
    agentSettled: () => forward("agentSettled"),
    sessionTree: () => forward("sessionTree"),
    sessionCompact: () => forward("sessionCompact"),
    requestSnapshot,
    getStatus,
    handleStatus,
  });
}

export function registerSessionMirrorObserverFacade(
  pi: ExtensionAPI,
  options: SessionMirrorObserverFacadeOptions = {},
): SessionMirrorObserverFacade {
  const facade = createSessionMirrorObserverFacade(options);
  pi.registerCommand(SESSION_MIRROR_OBSERVER_COMMAND, {
    description: "Show aggregate session-mirror observer status or request a deferred snapshot",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim().toLowerCase();
      const values = ["status", "snapshot"]
        .filter((value) => value.startsWith(normalized))
        .map((value) => ({ value, label: value }));
      return values.length > 0 ? values : null;
    },
    handler: (args, ctx) => facade.handleStatus(args, ctx),
  });

  pi.on("session_start", (event, ctx) => facade.sessionStart(ctx, event.reason));
  pi.on("session_shutdown", () => facade.sessionShutdown());
  pi.on("agent_start", () => facade.agentStart());
  pi.on("message_end", () => facade.messageEnd());
  pi.on("turn_end", () => facade.turnEnd());
  pi.on("agent_settled", () => facade.agentSettled());
  pi.on("session_tree", () => facade.sessionTree());
  pi.on("session_compact", () => facade.sessionCompact());
  return facade;
}

function createRetryableLazyImport<TModule>(
  loader: () => Promise<TModule>,
): () => Promise<TModule> {
  let modulePromise: Promise<TModule> | undefined;
  return () => {
    if (!modulePromise) {
      modulePromise = loader().catch((error) => {
        modulePromise = undefined;
        throw error;
      });
    }
    return modulePromise;
  };
}

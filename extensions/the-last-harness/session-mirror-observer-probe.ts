import { performance } from "node:perf_hooks";

import { createSessionMirrorObserverRuntime } from "./session-mirror/observer.js";
import {
  projectSessionMirrorSnapshot,
  type SessionMirrorReadonlySessionManager,
  type SessionMirrorSnapshotProjectionEnvelope,
} from "./session-mirror/session-adapter.js";
import type {
  SessionMirrorAttestationInput,
  SessionMirrorAttestationResult,
} from "./session-mirror/profile-attestation.js";
import type {
  SessionMirrorObserverAttestor,
  SessionMirrorObserverProjector,
  SessionMirrorObserverRuntime,
  SessionMirrorObserverRuntimeOptions,
  SessionMirrorObserverScheduler,
  SessionMirrorObserverSink,
  SessionMirrorObserverState,
} from "./session-mirror/observer.js";

/** Fixed bounds mirrored from the repository-only session-mirror v1 profile. */
export const SESSION_MIRROR_OBSERVER_PROBE_BOUNDS = Object.freeze({
  maxEnvelopeBytes: 256 * 1024,
  maxTreeEntries: 1024,
  maxTreeRoots: 1024,
  maxTreeDepth: 128,
});

export const SESSION_MIRROR_OBSERVER_TIMING_BUCKETS = Object.freeze([
  "unknown",
  "fast",
  "moderate",
  "slow",
  "extended",
] as const);

export type SessionMirrorObserverTimingBucket =
  (typeof SESSION_MIRROR_OBSERVER_TIMING_BUCKETS)[number];

export type SessionMirrorObserverEnvelopeCategory =
  | "none"
  | "empty"
  | "text"
  | "placeholder"
  | "mixed"
  | "error";

export interface SessionMirrorObserverProbeMetrics {
  readonly envelopeCategory: SessionMirrorObserverEnvelopeCategory;
  readonly entryCount: number;
  readonly rootCount: number;
  readonly maxDepth: number;
  readonly envelopeBytes: number;
  readonly timing: {
    readonly attestation: SessionMirrorObserverTimingBucket;
    readonly projection: SessionMirrorObserverTimingBucket;
    readonly sink: SessionMirrorObserverTimingBucket;
  };
  readonly runtimeFailures: number;
}

export type SessionMirrorObserverProbeState = SessionMirrorObserverState &
  SessionMirrorObserverProbeMetrics;

export interface SessionMirrorObserverProbeOptions {
  readonly getSessionManager?: () => SessionMirrorReadonlySessionManager | undefined;
  readonly sessionManager?: SessionMirrorReadonlySessionManager;
  readonly attest?: SessionMirrorObserverAttestor;
  readonly project?: SessionMirrorObserverProjector;
  readonly scheduler?: SessionMirrorObserverScheduler;
  readonly runtimeVersion?: string;
  readonly sessionSchemaVersion?: string;
  readonly queueCapacity?: number;
  /** Injectable clock used only to select bounded timing buckets. */
  readonly now?: () => number;
}

export interface SessionMirrorObserverProbe {
  sessionStart(): void;
  agentStart(): void;
  messageEnd(): void;
  turnEnd(): void;
  agentSettled(): void;
  sessionTree(): void;
  sessionCompact(): void;
  sessionShutdown(): void;
  requestSnapshot(): void;
  getState(): SessionMirrorObserverProbeState;
}

type TimingKey = "attestation" | "projection" | "sink";

type InternalMetrics = {
  envelopeCategory: SessionMirrorObserverEnvelopeCategory;
  entryCount: number;
  rootCount: number;
  maxDepth: number;
  envelopeBytes: number;
  timing: Record<TimingKey, SessionMirrorObserverTimingBucket>;
  runtimeFailures: number;
};

const MAX_RUNTIME_FAILURES = 2_000_000_000;
const MAX_DEPTH_WALK = SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxTreeDepth + 1;

function initialMetrics(): InternalMetrics {
  return {
    envelopeCategory: "none",
    entryCount: 0,
    rootCount: 0,
    maxDepth: 0,
    envelopeBytes: 0,
    timing: {
      attestation: "unknown",
      projection: "unknown",
      sink: "unknown",
    },
    runtimeFailures: 0,
  };
}

function incrementCounter(value: number): number {
  return value >= MAX_RUNTIME_FAILURES ? MAX_RUNTIME_FAILURES : value + 1;
}

function bucketDuration(duration: number | undefined): SessionMirrorObserverTimingBucket {
  if (duration === undefined || !Number.isFinite(duration) || duration < 0) return "unknown";
  if (duration <= 1) return "fast";
  if (duration <= 10) return "moderate";
  if (duration <= 100) return "slow";
  return "extended";
}

function readNow(now: () => number): number | undefined {
  try {
    const value = now();
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function setTiming(
  metrics: InternalMetrics,
  key: TimingKey,
  startedAt: number | undefined,
  now: () => number,
): void {
  if (startedAt === undefined) {
    metrics.timing[key] = "unknown";
    return;
  }
  const endedAt = readNow(now);
  metrics.timing[key] =
    endedAt === undefined ? "unknown" : bucketDuration(Math.max(0, endedAt - startedAt));
}

function classifyEnvelope(
  entries: readonly { readonly kind: unknown }[],
): SessionMirrorObserverEnvelopeCategory {
  if (entries.length === 0) return "empty";
  let placeholderCount = 0;
  let textCount = 0;
  for (const entry of entries) {
    if (entry.kind === "source-placeholder") {
      placeholderCount += 1;
    } else if (
      entry.kind === "user-turn" ||
      entry.kind === "assistant-turn" ||
      entry.kind === "summary" ||
      entry.kind === "compaction"
    ) {
      textCount += 1;
    }
  }
  if (placeholderCount === entries.length) return "placeholder";
  if (textCount === entries.length) return "text";
  return "mixed";
}

function measureDepth(
  entries: readonly { readonly id: unknown; readonly parentId: unknown }[],
): number {
  const parents = new Map<string, string | null>();
  for (const entry of entries) {
    if (typeof entry.id !== "string") return SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxTreeDepth;
    if (!(entry.parentId === null || typeof entry.parentId === "string")) {
      return SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxTreeDepth;
    }
    parents.set(entry.id, entry.parentId);
  }

  let maximum = 0;
  for (const entry of entries) {
    if (typeof entry.id !== "string") return SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxTreeDepth;
    const seen = new Set<string>();
    let current: string | null = entry.id;
    let depth = 0;
    while (current !== null && depth < MAX_DEPTH_WALK) {
      if (seen.has(current)) return SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxTreeDepth;
      seen.add(current);
      const parent = parents.get(current);
      if (parent === undefined) return SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxTreeDepth;
      depth += 1;
      current = parent;
    }
    if (current !== null) return SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxTreeDepth;
    maximum = Math.max(maximum, depth);
  }
  return Math.min(maximum, SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxTreeDepth);
}

function measureEnvelope(
  envelope: SessionMirrorSnapshotProjectionEnvelope,
): Omit<SessionMirrorObserverProbeMetrics, "timing" | "runtimeFailures"> {
  const tree = envelope.message.snapshot.tree;
  const entries = tree.entries;
  const rootIds = tree.rootIds;
  if (
    !Array.isArray(entries) ||
    !Array.isArray(rootIds) ||
    entries.length > SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxTreeEntries ||
    rootIds.length > SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxTreeRoots
  ) {
    throw new Error("session-mirror envelope bounds exceeded");
  }
  const entryCount = entries.length;
  const rootCount = rootIds.length;
  const maxDepth = measureDepth(entries);
  const serialized = JSON.stringify(envelope);
  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  return {
    envelopeCategory:
      serializedBytes > SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxEnvelopeBytes
        ? "error"
        : classifyEnvelope(entries),
    entryCount,
    rootCount,
    maxDepth,
    envelopeBytes: Math.min(serializedBytes, SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxEnvelopeBytes),
  };
}

function defaultAttestor(_input: SessionMirrorAttestationInput): SessionMirrorAttestationResult {
  return { ok: false, reason: "unsafe-profile-metadata" };
}

function invokeLifecycle(action: () => void, metrics: InternalMetrics): void {
  try {
    action();
  } catch {
    metrics.runtimeFailures = incrementCounter(metrics.runtimeFailures);
    metrics.envelopeCategory = "error";
  }
}

/**
 * Native-lazy observer/probe graph. It accepts the production attestor from
 * the eager facade rather than importing the peer-only upstream package.
 * No envelope is stored: the sink turns one production envelope into bounded
 * aggregate metrics and returns immediately.
 */
export function createSessionMirrorObserverProbe(
  options: SessionMirrorObserverProbeOptions = {},
): SessionMirrorObserverProbe {
  const now = options.now ?? (() => performance.now());
  const metrics = initialMetrics();
  const attest = options.attest ?? defaultAttestor;
  const project = options.project ?? projectSessionMirrorSnapshot;
  const getSessionManager = options.getSessionManager ?? (() => options.sessionManager);

  const measuredAttest: SessionMirrorObserverAttestor = (input) => {
    const startedAt = readNow(now);
    try {
      return attest(input);
    } finally {
      setTiming(metrics, "attestation", startedAt, now);
    }
  };

  const measuredProject: SessionMirrorObserverProjector = (sessionManager, metadata) => {
    const startedAt = readNow(now);
    try {
      const result = project(sessionManager, metadata);
      if (!result || result.ok !== true) metrics.envelopeCategory = "error";
      return result;
    } catch {
      metrics.envelopeCategory = "error";
      throw new Error("session-mirror projection failed");
    } finally {
      setTiming(metrics, "projection", startedAt, now);
    }
  };

  const consumeEnvelope: SessionMirrorObserverSink = (envelope) => {
    const startedAt = readNow(now);
    try {
      const measured = measureEnvelope(envelope);
      metrics.envelopeCategory = measured.envelopeCategory;
      metrics.entryCount = measured.entryCount;
      metrics.rootCount = measured.rootCount;
      metrics.maxDepth = measured.maxDepth;
      metrics.envelopeBytes = measured.envelopeBytes;
    } catch {
      metrics.envelopeCategory = "error";
      metrics.entryCount = 0;
      metrics.rootCount = 0;
      metrics.maxDepth = 0;
      metrics.envelopeBytes = 0;
      throw new Error("session-mirror envelope measurement failed");
    } finally {
      setTiming(metrics, "sink", startedAt, now);
    }
  };

  const runtimeOptions: SessionMirrorObserverRuntimeOptions = {
    getSessionManager,
    sink: consumeEnvelope,
    attest: measuredAttest,
    project: measuredProject,
    scheduler: options.scheduler,
    runtimeVersion: options.runtimeVersion,
    sessionSchemaVersion: options.sessionSchemaVersion,
    queueCapacity: options.queueCapacity,
  };
  const runtime: SessionMirrorObserverRuntime = createSessionMirrorObserverRuntime(runtimeOptions);

  const getState = (): SessionMirrorObserverProbeState => {
    let observer: SessionMirrorObserverState;
    try {
      observer = runtime.getState();
    } catch {
      metrics.runtimeFailures = incrementCounter(metrics.runtimeFailures);
      metrics.envelopeCategory = "error";
      observer = {
        generation: 0,
        enabled: false,
        attestation: "disabled",
        status: "unknown",
        settled: true,
        dirty: true,
        snapshotRequired: true,
        publicationPending: false,
        queueDepth: 0,
        queueCapacity: 0,
        sinkInFlight: false,
        revision: 0,
        successfulPublications: 0,
        failedPublications: 0,
        coalescedMarkers: 0,
        droppedMarkers: 0,
        diagnostics: {
          queueOverflow: 0,
          staleGeneration: 0,
          schedulerFailure: 0,
          sessionUnavailable: 0,
          attestationFailure: 0,
          attestationNotReady: 0,
          projectionFailure: 0,
          sinkThrow: 0,
          sinkReject: 0,
        },
        lastDiagnostic: "projection-failure",
        lastAttestationFailure: "unsafe-profile-metadata",
        lastProjectionFailure: "unsafe-session-data",
      };
    }
    return Object.freeze({
      ...observer,
      envelopeCategory: metrics.envelopeCategory,
      entryCount: metrics.entryCount,
      rootCount: metrics.rootCount,
      maxDepth: metrics.maxDepth,
      envelopeBytes: metrics.envelopeBytes,
      timing: Object.freeze({ ...metrics.timing }),
      runtimeFailures: metrics.runtimeFailures,
    });
  };

  const sessionStart = (): void => {
    metrics.envelopeCategory = "none";
    metrics.entryCount = 0;
    metrics.rootCount = 0;
    metrics.maxDepth = 0;
    metrics.envelopeBytes = 0;
    invokeLifecycle(() => runtime.sessionStart(), metrics);
  };
  const agentStart = (): void => invokeLifecycle(() => runtime.agentStart(), metrics);
  const messageEnd = (): void => invokeLifecycle(() => runtime.messageEnd(), metrics);
  const turnEnd = (): void => invokeLifecycle(() => runtime.turnEnd(), metrics);
  const agentSettled = (): void => invokeLifecycle(() => runtime.agentSettled(), metrics);
  const sessionTree = (): void => invokeLifecycle(() => runtime.sessionTree(), metrics);
  const sessionCompact = (): void => invokeLifecycle(() => runtime.sessionCompact(), metrics);
  const sessionShutdown = (): void => {
    invokeLifecycle(() => runtime.sessionShutdown(), metrics);
    metrics.envelopeCategory = "none";
    metrics.entryCount = 0;
    metrics.rootCount = 0;
    metrics.maxDepth = 0;
    metrics.envelopeBytes = 0;
  };
  const requestSnapshot = (): void => invokeLifecycle(() => runtime.requestSnapshot(), metrics);

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

export default createSessionMirrorObserverProbe;

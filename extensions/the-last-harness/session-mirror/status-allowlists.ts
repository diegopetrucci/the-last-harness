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

export type SessionMirrorObserverDiagnosticCode =
  (typeof SESSION_MIRROR_OBSERVER_DIAGNOSTIC_CODES)[number];

export const SESSION_MIRROR_PROJECTION_REASONS = Object.freeze([
  "invalid-metadata",
  "session-unavailable",
  "unsafe-session-data",
  "bounds-exceeded",
] as const);

export const SESSION_MIRROR_OBSERVER_PROFILE = Object.freeze({
  bounds: Object.freeze({
    maxEnvelopeBytes: 256 * 1024,
    maxTreeEntries: 1024,
    maxTreeRoots: 1024,
    maxTreeDepth: 128,
  }),
  defaultQueueCapacity: 8,
  maxQueueCapacity: 32,
  runtimeVersion: "tlh-session-mirror-runtime-v1",
  sessionSchemaVersion: "pi-session-schema-v3",
  fastTimingMs: 1,
  moderateTimingMs: 10,
  slowTimingMs: 100,
});

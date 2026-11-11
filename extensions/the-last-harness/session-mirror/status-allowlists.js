// Generated from extensions/the-last-harness/session-mirror/status-allowlists.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
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
]);
export const SESSION_MIRROR_PROJECTION_REASONS = Object.freeze([
    "invalid-metadata",
    "session-unavailable",
    "unsafe-session-data",
    "bounds-exceeded",
]);
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

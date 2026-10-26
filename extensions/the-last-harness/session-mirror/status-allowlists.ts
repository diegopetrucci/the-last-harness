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

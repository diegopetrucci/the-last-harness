export const DISABLED_ARTIFACT_CONFIG = {
  enabled: false,
  includeInput: false,
  includeOutput: false,
  includeJsonl: false,
  includeMetadata: false,
  cleanupDays: 7,
} as const;

export const DISABLED_COMPACT_ARTIFACT_CONFIG = {
  mode: "compact",
  enabled: false,
  includeInput: false,
  includeOutput: false,
  includeJsonl: false,
  includeTranscript: false,
  includeMetadata: false,
  includeChildEventProjections: false,
  cleanupDays: 7,
} as const;

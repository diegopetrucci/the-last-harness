/** Strict validation for persisted subagent telemetry before normalization. */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function finiteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeStepIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

const MAX_OPAQUE_ID_LENGTH = 512;

/** Structured telemetry IDs are opaque, bounded map keys (not file paths). */
function boundedOpaqueId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  if (!normalized || [...normalized].length > MAX_OPAQUE_ID_LENGTH) return false;
  return ![...normalized].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f;
  });
}

export const OUTCOME_STATES = new Set([
  "queued",
  "running",
  "completed",
  "failed",
  "paused",
  "cancelled",
  "continued",
]);
export const TERMINATION_REASONS = new Set([
  "completed",
  "output_limit",
  "model_error",
  "interrupted",
  "timed_out",
  "tool_budget_blocked",
  "paused",
  "cancelled",
  "process_exit",
  "context_exhausted",
  "unknown",
]);
export const ACCEPTANCE_STATUSES = new Set([
  "not-required",
  "claimed",
  "attested",
  "checked",
  "verified",
  "reviewed",
  "accepted",
  "rejected",
  "skipped",
]);

function strictOptionalFiniteFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.every((field) => !hasOwn(value, field) || finiteNonNegativeNumber(value[field]));
}

function strictOptionalNonEmptyStrings(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.every(
    (field) =>
      !hasOwn(value, field) || (typeof value[field] === "string" && value[field].trim() !== ""),
  );
}

function isStrictTelemetryUsage(value: unknown): boolean {
  return (
    isObject(value) &&
    finiteNonNegativeNumber(value.inputTokens) &&
    finiteNonNegativeNumber(value.outputTokens) &&
    finiteNonNegativeNumber(value.cacheReadTokens) &&
    finiteNonNegativeNumber(value.cacheWriteTokens) &&
    finiteNonNegativeNumber(value.costUsd)
  );
}

function isStrictTelemetryTiming(value: unknown): boolean {
  return (
    isObject(value) &&
    strictOptionalFiniteFields(value, ["startedAt", "endedAt", "durationMs", "activeRuntimeMs"]) &&
    ["startedAt", "endedAt", "durationMs", "activeRuntimeMs"].some((field) => hasOwn(value, field))
  );
}

function isStrictTelemetryModel(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.provider === "string" &&
    value.provider.trim() !== "" &&
    typeof value.model === "string" &&
    value.model.trim() !== "" &&
    strictOptionalNonEmptyStrings(value, ["thinking"])
  );
}

function isStrictTelemetryOutcome(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.state === "string" &&
    OUTCOME_STATES.has(value.state) &&
    (!hasOwn(value, "terminationReason") ||
      (typeof value.terminationReason === "string" &&
        TERMINATION_REASONS.has(value.terminationReason))) &&
    (!hasOwn(value, "acceptanceStatus") ||
      (typeof value.acceptanceStatus === "string" &&
        ACCEPTANCE_STATUSES.has(value.acceptanceStatus)))
  );
}

function isStrictTelemetryActivity(value: unknown): boolean {
  return (
    isObject(value) &&
    strictOptionalFiniteFields(value, ["turns", "toolCalls"]) &&
    ["turns", "toolCalls"].some((field) => hasOwn(value, field))
  );
}

function strictOptionalStepFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.every(
    (field) => !hasOwn(value, field) || safeStepIndex(value[field]) !== undefined,
  );
}

function isStrictLineageReference(value: unknown, fields: readonly string[]): boolean {
  if (!isObject(value)) return false;
  const numericFields = fields.filter((field) => field.endsWith("Index") || field === "depth");
  const stringFields = fields.filter((field) => !field.endsWith("Index") && field !== "depth");
  return (
    strictOptionalStepFields(value, numericFields) &&
    stringFields.every((field) => boundedOpaqueId(value[field]))
  );
}

function isStrictTelemetryLineage(value: unknown): boolean {
  if (!isObject(value)) return false;
  let recognized = false;
  if (hasOwn(value, "continuationFrom")) {
    recognized = true;
    if (!isStrictLineageReference(value.continuationFrom, ["sourceRunId", "sourceStepIndex"]))
      return false;
  }
  if (hasOwn(value, "continuations")) {
    recognized = true;
    if (!Array.isArray(value.continuations)) return false;
    for (const continuation of value.continuations) {
      if (!isStrictLineageReference(continuation, ["continuationRunId", "sourceStepIndex"]))
        return false;
    }
  }
  if (hasOwn(value, "nested")) {
    recognized = true;
    if (
      !isStrictLineageReference(value.nested, [
        "rootRunId",
        "parentRunId",
        "parentStepIndex",
        "depth",
      ])
    )
      return false;
  }
  return recognized;
}

function isStrictTelemetryStep(value: unknown): value is Record<string, unknown> {
  if (
    !isObject(value) ||
    safeStepIndex(value.index) === undefined ||
    typeof value.agent !== "string" ||
    value.agent.trim() === ""
  )
    return false;
  if (hasOwn(value, "model") && !isStrictTelemetryModel(value.model)) return false;
  if (hasOwn(value, "usage") && !isStrictTelemetryUsage(value.usage)) return false;
  if (hasOwn(value, "activity") && !isStrictTelemetryActivity(value.activity)) return false;
  if (hasOwn(value, "timing") && !isStrictTelemetryTiming(value.timing)) return false;
  return !hasOwn(value, "outcome") || isStrictTelemetryOutcome(value.outcome);
}

function isStrictTelemetryProvenance(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.tlhVersion === "string" &&
    value.tlhVersion.trim() !== "" &&
    typeof value.piVersion === "string" &&
    value.piVersion.trim() !== "" &&
    finiteNonNegativeNumber(value.loadedAt) &&
    strictOptionalNonEmptyStrings(value, ["installGeneration"])
  );
}

function isStrictTelemetryControls(value: unknown): boolean {
  if (
    !isObject(value) ||
    !finiteNonNegativeNumber(value.needsAttentionAfterMs) ||
    !finiteNonNegativeNumber(value.failedToolAttemptsBeforeAttention) ||
    !Array.isArray(value.notifyOn) ||
    !Array.isArray(value.notifyChannels)
  )
    return false;
  return (
    value.notifyOn.every((entry) => entry === "needs_attention") &&
    value.notifyChannels.every((entry) => entry === "event" || entry === "async")
  );
}

export function isStrictTelemetryEnvelope(value: unknown): boolean {
  if (!isObject(value) || value.schemaVersion !== 1 || !isObject(value.run)) return false;
  if (
    !boundedOpaqueId(value.run.id) ||
    (value.run.execution !== "foreground" && value.run.execution !== "async") ||
    (value.run.mode !== "single" && value.run.mode !== "parallel") ||
    !Array.isArray(value.steps) ||
    !isStrictTelemetryProvenance(value.provenance) ||
    !isStrictTelemetryControls(value.controls)
  )
    return false;
  const stepIndexes = new Set<number>();
  for (const step of value.steps) {
    if (!isStrictTelemetryStep(step)) return false;
    const index = safeStepIndex(step.index);
    if (index === undefined || stepIndexes.has(index)) return false;
    stepIndexes.add(index);
  }
  if (hasOwn(value, "usage") && !isStrictTelemetryUsage(value.usage)) return false;
  if (hasOwn(value, "timing") && !isStrictTelemetryTiming(value.timing)) return false;
  if (hasOwn(value, "outcome") && !isStrictTelemetryOutcome(value.outcome)) return false;
  return !hasOwn(value, "lineage") || isStrictTelemetryLineage(value.lineage);
}

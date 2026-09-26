import { splitKnownThinkingSuffix } from "./model-info.ts";
import type {
  AcceptanceLedgerStatus,
  ResolvedControlConfig,
  SingleResult,
  SubagentModelIdentity,
  SubagentRunMode,
  SubagentTerminationReason,
  Usage,
} from "./types.ts";

/** The version of the local, privacy-safe telemetry envelope. */
export const SUBAGENT_RUN_TELEMETRY_SCHEMA_VERSION = 1 as const;

export type SubagentTelemetryExecution = "foreground" | "async";
export type SubagentTelemetryState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "paused"
  | "cancelled"
  | "continued";

export interface SubagentTelemetryUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface SubagentTelemetryActivity {
  turns?: number;
  toolCalls?: number;
}

export interface SubagentTelemetryTiming {
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  activeRuntimeMs?: number;
}

export interface SubagentTelemetryOutcome {
  state: SubagentTelemetryState;
  terminationReason?: SubagentTerminationReason;
  acceptanceStatus?: AcceptanceLedgerStatus;
}

export interface SubagentTelemetryStep {
  index: number;
  agent: string;
  model?: SubagentModelIdentity;
  usage?: SubagentTelemetryUsage;
  activity?: SubagentTelemetryActivity;
  timing?: SubagentTelemetryTiming;
  outcome?: SubagentTelemetryOutcome;
}

export interface SubagentTelemetryLineage {
  continuationFrom?: {
    sourceRunId: string;
    sourceStepIndex?: number;
  };
  continuations?: Array<{
    sourceStepIndex?: number;
    continuationRunId: string;
  }>;
  nested?: {
    rootRunId: string;
    parentRunId: string;
    parentStepIndex?: number;
    depth?: number;
  };
}

export interface SubagentTelemetryProvenance {
  tlhVersion: string;
  piVersion: string;
  installGeneration?: string;
  /** Epoch milliseconds captured at extension load, never refreshed at completion. */
  loadedAt: number;
}

export interface SubagentTelemetryControls {
  needsAttentionAfterMs: number;
  failedToolAttemptsBeforeAttention: number;
  notifyOn: Array<"needs_attention">;
  notifyChannels: Array<"event" | "async">;
}

/**
 * Compact run-level envelope. This is intentionally separate from notification
 * details and from the child result shape so task/prompt/output/path data cannot
 * leak into local telemetry by object spreading.
 */
export interface SubagentRunTelemetry {
  schemaVersion: typeof SUBAGENT_RUN_TELEMETRY_SCHEMA_VERSION;
  run: {
    id: string;
    execution: SubagentTelemetryExecution;
    mode: SubagentRunMode;
  };
  steps: SubagentTelemetryStep[];
  usage?: SubagentTelemetryUsage;
  timing?: SubagentTelemetryTiming;
  outcome?: SubagentTelemetryOutcome;
  lineage?: SubagentTelemetryLineage;
  provenance: SubagentTelemetryProvenance;
  controls: SubagentTelemetryControls;
}

export type SubagentTelemetryStepInput = {
  index: number;
  agent: string;
  model?: SubagentModelIdentity;
  usage?: Usage | SubagentTelemetryUsage;
  activity?: SubagentTelemetryActivity;
  timing?: SubagentTelemetryTiming;
  outcome?: SubagentTelemetryOutcome;
};

export type BuildSubagentRunTelemetryInput = {
  runId: string;
  execution: SubagentTelemetryExecution;
  mode: SubagentRunMode;
  steps: SubagentTelemetryStepInput[];
  provenance: SubagentTelemetryProvenance;
  controls: ResolvedControlConfig | SubagentTelemetryControls;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  activeRuntimeMs?: number;
  outcome?: SubagentTelemetryOutcome;
  lineage?: SubagentTelemetryLineage;
};

const TERMINATION_REASONS: ReadonlySet<SubagentTerminationReason> = new Set([
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
const TELEMETRY_STATES: ReadonlySet<SubagentTelemetryState> = new Set([
  "queued",
  "running",
  "completed",
  "failed",
  "paused",
  "cancelled",
  "continued",
]);
const TERMINAL_STEP_OUTCOME_STATES: ReadonlySet<SubagentTelemetryState> = new Set([
  "completed",
  "failed",
  "cancelled",
  "continued",
]);
const ACCEPTANCE_STATUSES: ReadonlySet<AcceptanceLedgerStatus> = new Set([
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
const NOTIFY_ON: ReadonlySet<"needs_attention"> = new Set(["needs_attention"]);
const NOTIFY_CHANNELS: ReadonlySet<"event" | "async"> = new Set(["event", "async"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeModelIdentity(value: unknown): SubagentModelIdentity | undefined {
  if (!isRecord(value) || !nonEmptyString(value.provider) || !nonEmptyString(value.model)) {
    return undefined;
  }
  return {
    provider: value.provider.trim(),
    model: value.model.trim(),
    ...(nonEmptyString(value.thinking) ? { thinking: value.thinking.trim() } : {}),
  };
}

type TelemetryModelAttempt = {
  model?: string;
  usage?: Usage;
};

function modelReferenceKey(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return splitKnownThinkingSuffix(value.trim()).baseModel;
}

function modelReferenceMatchesIdentity(value: unknown, identity: SubagentModelIdentity): boolean {
  const reference = modelReferenceKey(value);
  if (!reference) return false;
  const separator = reference.indexOf("/");
  return (
    separator > 0 &&
    separator < reference.length - 1 &&
    reference.slice(0, separator) === identity.provider &&
    reference.slice(separator + 1) === identity.model
  );
}

/**
 * Keep model attribution only when attempt evidence identifies one complete,
 * consistent contributing model. An entirely absent attempt carrier retains
 * legacy attribution; present-but-empty or partial evidence is ambiguous.
 */
function modelForTelemetryStep(input: {
  model?: SubagentModelIdentity;
  attemptedModels?: readonly string[];
  modelAttempts?: readonly TelemetryModelAttempt[];
}): SubagentModelIdentity | undefined {
  const model = input.model;
  if (!model) return undefined;
  if (input.attemptedModels === undefined && input.modelAttempts === undefined) return model;

  if (
    input.attemptedModels !== undefined &&
    (input.attemptedModels.length !== 1 ||
      !modelReferenceMatchesIdentity(input.attemptedModels[0], model))
  ) {
    return undefined;
  }
  const attemptedReference =
    input.attemptedModels?.length === 1 ? modelReferenceKey(input.attemptedModels[0]) : undefined;

  if (input.modelAttempts !== undefined) {
    if (input.modelAttempts.length !== 1) return undefined;
    const attempt = input.modelAttempts[0];
    if (!attempt?.usage || !modelReferenceMatchesIdentity(attempt.model, model)) return undefined;
    if (attemptedReference !== undefined && modelReferenceKey(attempt.model) !== attemptedReference)
      return undefined;
  }

  return model;
}

function normalizeUsage(value: unknown): SubagentTelemetryUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = value.inputTokens;
  const outputTokens = value.outputTokens;
  const cacheReadTokens = value.cacheReadTokens;
  const cacheWriteTokens = value.cacheWriteTokens;
  const costUsd = value.costUsd;
  if (
    !finiteNonNegative(inputTokens) ||
    !finiteNonNegative(outputTokens) ||
    !finiteNonNegative(cacheReadTokens) ||
    !finiteNonNegative(cacheWriteTokens) ||
    !finiteNonNegative(costUsd)
  )
    return undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
  };
}

function usageFromSource(
  value: Usage | SubagentTelemetryUsage | undefined,
): SubagentTelemetryUsage | undefined {
  if (!value) return undefined;
  if ("inputTokens" in value) return normalizeUsage(value);
  if (
    !finiteNonNegative(value.input) ||
    !finiteNonNegative(value.output) ||
    !finiteNonNegative(value.cacheRead) ||
    !finiteNonNegative(value.cacheWrite) ||
    !finiteNonNegative(value.cost)
  ) {
    return undefined;
  }
  return {
    inputTokens: value.input,
    outputTokens: value.output,
    cacheReadTokens: value.cacheRead,
    cacheWriteTokens: value.cacheWrite,
    costUsd: value.cost,
  };
}

function normalizeActivity(value: unknown): SubagentTelemetryActivity | undefined {
  if (!isRecord(value)) return undefined;
  const turns =
    value.turns === undefined ? undefined : finiteNonNegative(value.turns) ? value.turns : null;
  const toolCalls =
    value.toolCalls === undefined
      ? undefined
      : finiteNonNegative(value.toolCalls)
        ? value.toolCalls
        : null;
  if (turns === null || toolCalls === null || (turns === undefined && toolCalls === undefined))
    return undefined;
  return {
    ...(turns !== undefined ? { turns } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
  };
}

function normalizeTiming(value: unknown): SubagentTelemetryTiming | undefined {
  if (!isRecord(value)) return undefined;
  const startedAt = value.startedAt;
  const endedAt = value.endedAt;
  const durationMs = value.durationMs;
  const activeRuntimeMs = value.activeRuntimeMs;
  if (
    (startedAt !== undefined && !finiteNonNegative(startedAt)) ||
    (endedAt !== undefined && !finiteNonNegative(endedAt)) ||
    (durationMs !== undefined && !finiteNonNegative(durationMs)) ||
    (activeRuntimeMs !== undefined && !finiteNonNegative(activeRuntimeMs))
  ) {
    return undefined;
  }
  if (
    startedAt === undefined &&
    endedAt === undefined &&
    durationMs === undefined &&
    activeRuntimeMs === undefined
  )
    return undefined;
  return {
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(activeRuntimeMs !== undefined ? { activeRuntimeMs } : {}),
  };
}

function normalizeOutcome(value: unknown): SubagentTelemetryOutcome | undefined {
  if (!isRecord(value) || !TELEMETRY_STATES.has(value.state as SubagentTelemetryState)) {
    return undefined;
  }
  const terminationReason = value.terminationReason;
  const acceptanceStatus = value.acceptanceStatus;
  if (
    terminationReason !== undefined &&
    !TERMINATION_REASONS.has(terminationReason as SubagentTerminationReason)
  )
    return undefined;
  if (
    acceptanceStatus !== undefined &&
    !ACCEPTANCE_STATUSES.has(acceptanceStatus as AcceptanceLedgerStatus)
  )
    return undefined;
  return {
    state: value.state as SubagentTelemetryState,
    ...(terminationReason !== undefined
      ? { terminationReason: terminationReason as SubagentTerminationReason }
      : {}),
    ...(acceptanceStatus !== undefined
      ? { acceptanceStatus: acceptanceStatus as AcceptanceLedgerStatus }
      : {}),
  };
}

function normalizeLineage(value: unknown): SubagentTelemetryLineage | undefined {
  if (!isRecord(value)) return undefined;

  let continuationFrom: SubagentTelemetryLineage["continuationFrom"];
  if (
    isRecord(value.continuationFrom) &&
    nonEmptyString(value.continuationFrom.sourceRunId) &&
    (value.continuationFrom.sourceStepIndex === undefined ||
      safeIndex(value.continuationFrom.sourceStepIndex))
  ) {
    continuationFrom = {
      sourceRunId: value.continuationFrom.sourceRunId.trim(),
      ...(value.continuationFrom.sourceStepIndex !== undefined
        ? { sourceStepIndex: value.continuationFrom.sourceStepIndex }
        : {}),
    };
  }

  let continuations: SubagentTelemetryLineage["continuations"];
  if (Array.isArray(value.continuations)) {
    const validContinuations: NonNullable<SubagentTelemetryLineage["continuations"]> = [];
    for (const entry of value.continuations) {
      if (!isRecord(entry)) continue;
      const continuationRunId = entry.continuationRunId;
      const sourceStepIndex = entry.sourceStepIndex;
      if (!nonEmptyString(continuationRunId)) continue;
      if (sourceStepIndex !== undefined && !safeIndex(sourceStepIndex)) continue;
      validContinuations.push({
        continuationRunId: continuationRunId.trim(),
        ...(sourceStepIndex !== undefined ? { sourceStepIndex } : {}),
      });
    }
    if (validContinuations.length > 0) continuations = validContinuations;
  }

  let nested: SubagentTelemetryLineage["nested"];
  if (
    isRecord(value.nested) &&
    nonEmptyString(value.nested.rootRunId) &&
    nonEmptyString(value.nested.parentRunId) &&
    (value.nested.parentStepIndex === undefined || safeIndex(value.nested.parentStepIndex)) &&
    (value.nested.depth === undefined || safeIndex(value.nested.depth))
  ) {
    nested = {
      rootRunId: value.nested.rootRunId.trim(),
      parentRunId: value.nested.parentRunId.trim(),
      ...(value.nested.parentStepIndex !== undefined
        ? { parentStepIndex: value.nested.parentStepIndex }
        : {}),
      ...(value.nested.depth !== undefined ? { depth: value.nested.depth } : {}),
    };
  }

  if (!continuationFrom && !continuations && !nested) return undefined;
  return {
    ...(continuationFrom ? { continuationFrom } : {}),
    ...(continuations ? { continuations } : {}),
    ...(nested ? { nested } : {}),
  };
}

function normalizeProvenance(value: unknown): SubagentTelemetryProvenance | undefined {
  if (!isRecord(value) || !nonEmptyString(value.tlhVersion) || !nonEmptyString(value.piVersion)) {
    return undefined;
  }
  if (!finiteNonNegative(value.loadedAt)) return undefined;
  return {
    tlhVersion: value.tlhVersion.trim(),
    piVersion: value.piVersion.trim(),
    ...(nonEmptyString(value.installGeneration)
      ? { installGeneration: value.installGeneration.trim() }
      : {}),
    loadedAt: value.loadedAt,
  };
}

function normalizeControls(value: unknown): SubagentTelemetryControls | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !finiteNonNegative(value.needsAttentionAfterMs) ||
    !finiteNonNegative(value.failedToolAttemptsBeforeAttention) ||
    !Array.isArray(value.notifyOn) ||
    !Array.isArray(value.notifyChannels)
  )
    return undefined;
  const notifyOn = value.notifyOn.filter((entry): entry is "needs_attention" =>
    NOTIFY_ON.has(entry as "needs_attention"),
  );
  const notifyChannels = value.notifyChannels.filter((entry): entry is "event" | "async" =>
    NOTIFY_CHANNELS.has(entry as "event" | "async"),
  );
  if (
    notifyOn.length !== value.notifyOn.length ||
    notifyChannels.length !== value.notifyChannels.length
  )
    return undefined;
  return {
    needsAttentionAfterMs: value.needsAttentionAfterMs,
    failedToolAttemptsBeforeAttention: value.failedToolAttemptsBeforeAttention,
    notifyOn,
    notifyChannels,
  };
}

/** Normalize external/persisted telemetry without allowing arbitrary fields through. */
export function normalizeSubagentRunTelemetry(value: unknown): SubagentRunTelemetry | undefined {
  if (!isRecord(value) || value.schemaVersion !== SUBAGENT_RUN_TELEMETRY_SCHEMA_VERSION)
    return undefined;
  if (!isRecord(value.run) || !nonEmptyString(value.run.id)) return undefined;
  if (value.run.execution !== "foreground" && value.run.execution !== "async") return undefined;
  if (value.run.mode !== "single" && value.run.mode !== "parallel") return undefined;
  if (!Array.isArray(value.steps)) return undefined;

  const steps: SubagentTelemetryStep[] = [];
  for (const entry of value.steps) {
    if (!isRecord(entry) || !safeIndex(entry.index) || !nonEmptyString(entry.agent))
      return undefined;
    const usage = entry.usage === undefined ? undefined : normalizeUsage(entry.usage);
    const activity = entry.activity === undefined ? undefined : normalizeActivity(entry.activity);
    const timing = entry.timing === undefined ? undefined : normalizeTiming(entry.timing);
    const outcome = entry.outcome === undefined ? undefined : normalizeOutcome(entry.outcome);
    const model = entry.model === undefined ? undefined : normalizeModelIdentity(entry.model);
    steps.push({
      index: entry.index,
      agent: entry.agent.trim(),
      ...(model ? { model } : {}),
      ...(usage ? { usage } : {}),
      ...(activity ? { activity } : {}),
      ...(timing ? { timing } : {}),
      ...(outcome ? { outcome } : {}),
    });
  }

  const provenance = normalizeProvenance(value.provenance);
  const controls = normalizeControls(value.controls);
  if (!provenance || !controls) return undefined;
  const usage = value.usage === undefined ? undefined : normalizeUsage(value.usage);
  const timing = value.timing === undefined ? undefined : normalizeTiming(value.timing);
  const outcome = value.outcome === undefined ? undefined : normalizeOutcome(value.outcome);
  const lineage = value.lineage === undefined ? undefined : normalizeLineage(value.lineage);
  return {
    schemaVersion: SUBAGENT_RUN_TELEMETRY_SCHEMA_VERSION,
    run: { id: value.run.id.trim(), execution: value.run.execution, mode: value.run.mode },
    steps,
    ...(usage ? { usage } : {}),
    ...(timing ? { timing } : {}),
    ...(outcome ? { outcome } : {}),
    ...(lineage ? { lineage } : {}),
    provenance,
    controls,
  };
}

/**
 * Add a durable continuation edge without copying notification or execution
 * details into the envelope. The returned value is a fresh serializable
 * snapshot, so a lifecycle writer cannot mutate a load-time carrier.
 */
export function appendSubagentTelemetryContinuation(
  telemetry: SubagentRunTelemetry | undefined,
  input: { sourceStepIndex?: number; continuationRunId: string },
): SubagentRunTelemetry | undefined {
  if (!telemetry || !nonEmptyString(input.continuationRunId)) return telemetry;
  if (input.sourceStepIndex !== undefined && !safeIndex(input.sourceStepIndex)) return telemetry;
  const existing = telemetry.lineage?.continuations ?? [];
  const continuation = {
    continuationRunId: input.continuationRunId.trim(),
    ...(input.sourceStepIndex !== undefined ? { sourceStepIndex: input.sourceStepIndex } : {}),
  };
  const alreadyRecorded = existing.some(
    (entry) =>
      entry.continuationRunId === continuation.continuationRunId &&
      entry.sourceStepIndex === continuation.sourceStepIndex,
  );
  const continuations = alreadyRecorded ? existing : [...existing, continuation];
  return {
    ...telemetry,
    ...(telemetry.lineage || continuations.length > 0
      ? {
          lineage: {
            ...telemetry.lineage,
            continuations,
          },
        }
      : {}),
  };
}

/** Build the direct lineage/provenance carriers for a new continuation run. */
export function continuationTelemetryMetadata(
  source: SubagentRunTelemetry | undefined,
  sourceRunId: string,
  sourceStepIndex?: number,
): {
  provenance?: SubagentTelemetryProvenance;
  lineage?: SubagentTelemetryLineage;
} {
  if (!source || !nonEmptyString(sourceRunId)) return {};
  if (sourceStepIndex !== undefined && !safeIndex(sourceStepIndex)) return {};
  return {
    provenance: source.provenance,
    lineage: {
      ...(source.lineage?.nested ? { nested: { ...source.lineage.nested } } : {}),
      continuationFrom: {
        sourceRunId: sourceRunId.trim(),
        ...(sourceStepIndex !== undefined ? { sourceStepIndex } : {}),
      },
    },
  };
}

function mergeTelemetryTiming(
  current: SubagentTelemetryTiming | undefined,
  persisted: SubagentTelemetryTiming | undefined,
  persistedWins: boolean,
): SubagentTelemetryTiming | undefined {
  if (!current && !persisted) return undefined;
  const merged = persistedWins ? { ...current, ...persisted } : { ...persisted, ...current };
  return normalizeTiming(merged);
}

function mergeTelemetryLineage(
  current: SubagentTelemetryLineage | undefined,
  persisted: SubagentTelemetryLineage | undefined,
): SubagentTelemetryLineage | undefined {
  if (!current && !persisted) return undefined;
  const continuations = [...(persisted?.continuations ?? []), ...(current?.continuations ?? [])];
  const uniqueContinuations = continuations.filter(
    (entry, index) =>
      continuations.findIndex(
        (candidate) =>
          candidate.continuationRunId === entry.continuationRunId &&
          candidate.sourceStepIndex === entry.sourceStepIndex,
      ) === index,
  );
  return {
    ...(current?.continuationFrom
      ? { continuationFrom: { ...current.continuationFrom } }
      : persisted?.continuationFrom
        ? { continuationFrom: { ...persisted.continuationFrom } }
        : {}),
    ...(uniqueContinuations.length > 0 ? { continuations: uniqueContinuations } : {}),
    ...(current?.nested
      ? { nested: { ...current.nested } }
      : persisted?.nested
        ? { nested: { ...persisted.nested } }
        : {}),
  };
}

/**
 * Merge a source-run write with a concurrently persisted lifecycle record.
 * Lifecycle callers use `persistedOutcomeWins` when the persisted state was
 * committed through a lock/CAS transition; usage and timing remain source
 * owned while continuation edges from either side are retained. The narrower
 * `persistedTerminalStepOutcomesWin` option protects direct child outcomes from
 * a stale source snapshot without changing the run-level outcome precedence.
 */
export function mergeSubagentRunTelemetry(
  currentValue: unknown,
  persistedValue: unknown,
  options: {
    persistedOutcomeWins?: boolean;
    persistedTerminalStepOutcomesWin?: boolean;
  } = {},
): SubagentRunTelemetry | undefined {
  const current = normalizeSubagentRunTelemetry(currentValue);
  const persisted = normalizeSubagentRunTelemetry(persistedValue);
  if (!current) return persisted;
  if (!persisted) return current;
  const persistedOutcomeWins = options.persistedOutcomeWins === true;
  const persistedSteps = new Map(persisted.steps.map((step) => [step.index, step]));
  const currentSteps = new Map(current.steps.map((step) => [step.index, step]));
  const indexes = [...new Set([...persistedSteps.keys(), ...currentSteps.keys()])].sort(
    (a, b) => a - b,
  );
  const steps = indexes.map((index) => {
    const currentStep = currentSteps.get(index);
    const persistedStep = persistedSteps.get(index);
    if (!currentStep) return { ...persistedStep! };
    if (!persistedStep) return { ...currentStep };
    const timing = mergeTelemetryTiming(
      currentStep.timing,
      persistedStep.timing,
      persistedOutcomeWins,
    );
    const persistedTerminalStepOutcomeWins =
      options.persistedTerminalStepOutcomesWin === true &&
      persistedStep.outcome !== undefined &&
      TERMINAL_STEP_OUTCOME_STATES.has(persistedStep.outcome.state);
    const persistedStepOutcome =
      (persistedOutcomeWins || persistedTerminalStepOutcomeWins) && persistedStep.outcome
        ? {
            ...persistedStep.outcome,
            // A lifecycle-only step merge keeps state and terminationReason from
            // disk, but a newer acceptance result remains source-owned. The
            // whole-outcome option intentionally retains its legacy behavior.
            ...(persistedTerminalStepOutcomeWins &&
            !persistedOutcomeWins &&
            currentStep.outcome?.acceptanceStatus !== undefined
              ? { acceptanceStatus: currentStep.outcome.acceptanceStatus }
              : {}),
          }
        : undefined;
    const mergedStep = {
      ...persistedStep,
      ...currentStep,
      ...(persistedStepOutcome ? { outcome: persistedStepOutcome } : {}),
      ...(persistedStep.model && !currentStep.model ? { model: { ...persistedStep.model } } : {}),
      ...(persistedStep.usage && !currentStep.usage ? { usage: { ...persistedStep.usage } } : {}),
      ...(persistedStep.activity && !currentStep.activity
        ? { activity: { ...persistedStep.activity } }
        : {}),
      ...(timing ? { timing } : {}),
    };
    if (currentStep.usage && !currentStep.model) delete mergedStep.model;
    return mergedStep;
  });
  const usage = current.usage ?? persisted.usage;
  const timing = mergeTelemetryTiming(current.timing, persisted.timing, persistedOutcomeWins);
  const outcome =
    persistedOutcomeWins && persisted.outcome
      ? persisted.outcome
      : (current.outcome ?? persisted.outcome);
  const lineage = mergeTelemetryLineage(current.lineage, persisted.lineage);
  return {
    ...current,
    steps,
    ...(usage ? { usage: { ...usage } } : {}),
    ...(timing ? { timing: { ...timing } } : {}),
    ...(outcome ? { outcome: { ...outcome } } : {}),
    ...(lineage ? { lineage } : {}),
    // Provenance and controls belong to the original envelope. Prefer the
    // persisted copy when available so a stale writer cannot replace them.
    provenance: { ...persisted.provenance },
    controls: {
      ...persisted.controls,
      notifyOn: [...persisted.controls.notifyOn],
      notifyChannels: [...persisted.controls.notifyChannels],
    },
  };
}

function controlsFromResolved(
  value: ResolvedControlConfig | SubagentTelemetryControls,
): SubagentTelemetryControls {
  return {
    needsAttentionAfterMs: value.needsAttentionAfterMs,
    failedToolAttemptsBeforeAttention: value.failedToolAttemptsBeforeAttention,
    notifyOn: [...value.notifyOn].filter(
      (entry): entry is "needs_attention" => entry === "needs_attention",
    ),
    notifyChannels: [...value.notifyChannels].filter(
      (entry): entry is "event" | "async" => entry === "event" || entry === "async",
    ),
  };
}

function addUsage(target: SubagentTelemetryUsage, source: SubagentTelemetryUsage): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.costUsd += source.costUsd;
}

function aggregateUsage(steps: SubagentTelemetryStep[]): SubagentTelemetryUsage | undefined {
  const sources = steps
    .map((step) => step.usage)
    .filter((usage): usage is SubagentTelemetryUsage => Boolean(usage));
  if (sources.length === 0) return undefined;
  const total: SubagentTelemetryUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
  for (const source of sources) addUsage(total, source);
  return total;
}

function timingFromInput(input: {
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  activeRuntimeMs?: number;
}): SubagentTelemetryTiming | undefined {
  const durationMs =
    input.durationMs ??
    (input.startedAt !== undefined && input.endedAt !== undefined
      ? Math.max(0, input.endedAt - input.startedAt)
      : undefined);
  const timing = {
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
    ...(input.endedAt !== undefined ? { endedAt: input.endedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(input.activeRuntimeMs !== undefined ? { activeRuntimeMs: input.activeRuntimeMs } : {}),
  };
  return Object.keys(timing).length > 0 ? timing : undefined;
}

export function buildSubagentRunTelemetry(
  input: BuildSubagentRunTelemetryInput,
): SubagentRunTelemetry {
  const steps = input.steps.map((step) => {
    const usage = usageFromSource(step.usage);
    const model = normalizeModelIdentity(step.model);
    const activity = step.activity ? normalizeActivity(step.activity) : undefined;
    const timing = step.timing ? timingFromInput(step.timing) : undefined;
    return {
      index: step.index,
      agent: step.agent,
      ...(model ? { model } : {}),
      ...(usage ? { usage } : {}),
      ...(activity ? { activity } : {}),
      ...(timing ? { timing } : {}),
      ...(step.outcome ? { outcome: { ...step.outcome } } : {}),
    } satisfies SubagentTelemetryStep;
  });
  const usage = aggregateUsage(steps);
  const timing = timingFromInput(input);
  const outcome = input.outcome ? { ...input.outcome } : undefined;
  const lineage = input.lineage ? normalizeLineage(input.lineage) : undefined;
  return {
    schemaVersion: SUBAGENT_RUN_TELEMETRY_SCHEMA_VERSION,
    run: { id: input.runId, execution: input.execution, mode: input.mode },
    steps,
    ...(usage ? { usage } : {}),
    ...(timing ? { timing } : {}),
    ...(outcome ? { outcome } : {}),
    ...(lineage ? { lineage } : {}),
    provenance: {
      tlhVersion: input.provenance.tlhVersion,
      piVersion: input.provenance.piVersion,
      ...(input.provenance.installGeneration
        ? { installGeneration: input.provenance.installGeneration }
        : {}),
      loadedAt: input.provenance.loadedAt,
    },
    controls: controlsFromResolved(input.controls),
  };
}

function stateFromValue(value: string | undefined): SubagentTelemetryState | undefined {
  if (value === "complete" || value === "completed") return "completed";
  if (value === "pausing") return "paused";
  if (
    value === "queued" ||
    value === "running" ||
    value === "failed" ||
    value === "paused" ||
    value === "cancelled" ||
    value === "continued"
  )
    return value;
  return undefined;
}

export function resolveSubagentTelemetryOutcome(input: {
  state?: string;
  success?: boolean;
  interrupted?: boolean;
  timedOut?: boolean;
  terminationReason?: SubagentTerminationReason;
  acceptanceStatus?: AcceptanceLedgerStatus;
}): SubagentTelemetryOutcome | undefined {
  const explicitState = stateFromValue(input.state);
  // A persisted terminal lifecycle state is authoritative. In particular, a
  // cancellation may arrive while the child is still draining and must not be
  // rewritten as paused merely because an interrupt flag is also present.
  const state =
    explicitState && !["queued", "running"].includes(explicitState)
      ? explicitState
      : input.terminationReason === "cancelled"
        ? "cancelled"
        : input.interrupted ||
            input.terminationReason === "interrupted" ||
            input.terminationReason === "paused"
          ? "paused"
          : input.timedOut || input.terminationReason === "timed_out"
            ? "failed"
            : (explicitState ??
              (input.success === true
                ? "completed"
                : input.success === false
                  ? "failed"
                  : undefined));
  if (!state) return undefined;
  return {
    state,
    ...(input.terminationReason ? { terminationReason: input.terminationReason } : {}),
    ...(input.acceptanceStatus ? { acceptanceStatus: input.acceptanceStatus } : {}),
  };
}

/**
 * Resolve one aggregate outcome from direct child outcomes without depending on
 * completion order. Lifecycle severity is deterministic: cancellation wins
 * over pause, pause wins over failure, failure wins over continuation, and
 * continuation wins over completion. The reason is taken from the selected
 * child rather than from the first child that happens to expose one.
 */
export type ParallelTelemetryOutcomeInput = {
  index?: number;
  agent?: string;
  state?: string;
  success?: boolean;
  interrupted?: boolean;
  timedOut?: boolean;
  terminationReason?: SubagentTerminationReason;
};

const PARALLEL_OUTCOME_STATE_PRECEDENCE: readonly SubagentTelemetryState[] = [
  "cancelled",
  "paused",
  "failed",
  "continued",
  "completed",
  "running",
  "queued",
];

const PARALLEL_OUTCOME_REASON_PRECEDENCE: readonly SubagentTerminationReason[] = [
  "cancelled",
  "paused",
  "interrupted",
  "timed_out",
  "output_limit",
  "context_exhausted",
  "model_error",
  "tool_budget_blocked",
  "process_exit",
  "unknown",
  "completed",
];

function parallelOutcomeReasonRank(reason: SubagentTerminationReason | undefined): number {
  if (!reason) return PARALLEL_OUTCOME_REASON_PRECEDENCE.length;
  return PARALLEL_OUTCOME_REASON_PRECEDENCE.indexOf(reason);
}

function compareParallelOutcomeCandidates(
  left: {
    outcome: SubagentTelemetryOutcome;
    index?: number;
    agent: string;
    inputOrder: number;
  },
  right: {
    outcome: SubagentTelemetryOutcome;
    index?: number;
    agent: string;
    inputOrder: number;
  },
): number {
  const reasonRank =
    parallelOutcomeReasonRank(left.outcome.terminationReason) -
    parallelOutcomeReasonRank(right.outcome.terminationReason);
  if (reasonRank !== 0) return reasonRank;
  if (left.index !== undefined && right.index !== undefined && left.index !== right.index)
    return left.index - right.index;
  if (left.index !== undefined && right.index === undefined) return -1;
  if (left.index === undefined && right.index !== undefined) return 1;
  if (left.agent < right.agent) return -1;
  if (left.agent > right.agent) return 1;
  return left.inputOrder - right.inputOrder;
}

export function resolveParallelSubagentTelemetryOutcome(
  inputs: readonly ParallelTelemetryOutcomeInput[],
): SubagentTelemetryOutcome | undefined {
  const candidates = inputs.flatMap((input, inputOrder) => {
    const outcome = resolveSubagentTelemetryOutcome(input);
    return outcome ? [{ outcome, index: input.index, agent: input.agent ?? "", inputOrder }] : [];
  });
  if (candidates.length === 0) return undefined;
  const aggregateState = PARALLEL_OUTCOME_STATE_PRECEDENCE.find((state) =>
    candidates.some((candidate) => candidate.outcome.state === state),
  );
  if (!aggregateState) return undefined;
  const selected = candidates
    .filter((candidate) => candidate.outcome.state === aggregateState)
    .sort(compareParallelOutcomeCandidates)[0];
  if (!selected) return undefined;
  return {
    state: selected.outcome.state,
    ...(selected.outcome.terminationReason
      ? { terminationReason: selected.outcome.terminationReason }
      : {}),
  };
}

/** Finalize a previously queued/running envelope without introducing text-bearing fields. */
export function finalizeSubagentRunTelemetry(
  telemetry: SubagentRunTelemetry | undefined,
  outcome: SubagentTelemetryOutcome,
  endedAt?: number,
): SubagentRunTelemetry | undefined {
  if (!telemetry) return undefined;
  const terminalStates = new Set<SubagentTelemetryState>([
    "completed",
    "failed",
    "paused",
    "cancelled",
    "continued",
  ]);
  const steps = telemetry.steps.map((step) => {
    const currentState = step.outcome?.state;
    if (currentState && terminalStates.has(currentState)) return { ...step };
    return { ...step, outcome: { ...outcome } };
  });
  const priorTiming = telemetry.timing;
  const startedAt = priorTiming?.startedAt;
  const timing =
    priorTiming && endedAt !== undefined
      ? {
          ...priorTiming,
          ...(priorTiming.endedAt === undefined ? { endedAt } : {}),
          ...(priorTiming.durationMs === undefined && startedAt !== undefined
            ? { durationMs: Math.max(0, endedAt - startedAt) }
            : {}),
        }
      : priorTiming
        ? { ...priorTiming }
        : undefined;
  return {
    ...telemetry,
    steps,
    ...(timing ? { timing } : {}),
    outcome: { ...outcome },
  };
}

/**
 * Apply a paused-lifecycle transition to the canonical run and its affected
 * direct step without rewriting sibling outcomes or provenance.
 */
export function transitionSubagentRunTelemetryLifecycle(input: {
  telemetry: SubagentRunTelemetry | undefined;
  runState: string;
  stepIndex: number;
  stepState: Extract<SubagentTelemetryState, "cancelled" | "continued">;
  endedAt?: number;
}): SubagentRunTelemetry | undefined {
  const telemetry = normalizeSubagentRunTelemetry(input.telemetry);
  if (!telemetry) return undefined;
  const runState = stateFromValue(input.runState);
  if (!runState) return telemetry;
  const timingForTransition = (
    timing: SubagentTelemetryTiming | undefined,
  ): SubagentTelemetryTiming | undefined => {
    if (!timing) return undefined;
    const endedAt = timing.endedAt ?? input.endedAt;
    return {
      ...timing,
      ...(timing.endedAt === undefined && input.endedAt !== undefined
        ? { endedAt: input.endedAt }
        : {}),
      ...(timing.durationMs === undefined && timing.startedAt !== undefined && endedAt !== undefined
        ? { durationMs: Math.max(0, endedAt - timing.startedAt) }
        : {}),
    };
  };
  const outcome: SubagentTelemetryOutcome = {
    ...telemetry.outcome,
    state: runState,
    ...(runState === "cancelled" ? { terminationReason: "cancelled" as const } : {}),
  };
  const steps = telemetry.steps.map((step) => {
    if (step.index !== input.stepIndex) return { ...step };
    const stepOutcome: SubagentTelemetryOutcome = {
      ...step.outcome,
      state: input.stepState,
      ...(input.stepState === "cancelled" ? { terminationReason: "cancelled" as const } : {}),
    };
    const timing = timingForTransition(step.timing);
    return { ...step, ...(timing ? { timing } : {}), outcome: stepOutcome };
  });
  const timing = timingForTransition(telemetry.timing);
  return {
    ...telemetry,
    steps,
    ...(timing ? { timing } : {}),
    outcome,
  };
}

/** Build the envelope used by foreground tool results and parent-session records. */
export function telemetryFromSingleResults(input: {
  runId: string;
  mode: SubagentRunMode;
  results: SingleResult[];
  /** Real flat indexes for partial per-child artifacts; defaults to result order. */
  stepIndexes?: readonly number[];
  provenance: SubagentTelemetryProvenance;
  controls: ResolvedControlConfig | SubagentTelemetryControls;
  startedAt?: number;
  endedAt?: number;
  lineage?: SubagentTelemetryLineage;
  outcome?: SubagentTelemetryOutcome;
}): SubagentRunTelemetry {
  const runOutcome =
    input.outcome ??
    (input.mode === "parallel"
      ? resolveParallelSubagentTelemetryOutcome(
          input.results.map((result, index) => ({
            index: input.stepIndexes?.[index] ?? index,
            agent: result.agent,
            state: result.cancel ? "cancelled" : result.pause ? "paused" : undefined,
            success: result.exitCode === 0 && !result.interrupted,
            interrupted: result.interrupted,
            timedOut: result.timedOut,
            terminationReason: result.terminationReason,
          })),
        )
      : undefined);
  return buildSubagentRunTelemetry({
    ...input,
    execution: "foreground",
    outcome: runOutcome,
    steps: input.results.map((result, index) => {
      const activityValues = {
        ...(result.usage ? { turns: result.usage.turns } : {}),
        ...(result.progressSummary?.toolCount !== undefined
          ? { toolCalls: result.progressSummary.toolCount }
          : {}),
      };
      const timingValues = {
        ...(result.progressSummary?.durationMs !== undefined
          ? { durationMs: result.progressSummary.durationMs }
          : {}),
        ...(result.activeRuntimeMs !== undefined
          ? { activeRuntimeMs: result.activeRuntimeMs }
          : {}),
      };
      return {
        index: input.stepIndexes?.[index] ?? index,
        agent: result.agent,
        model: modelForTelemetryStep({
          model: result.modelIdentity,
          attemptedModels: result.attemptedModels,
          modelAttempts: result.modelAttempts,
        }),
        usage: result.usage,
        ...(Object.keys(activityValues).length > 0 ? { activity: activityValues } : {}),
        ...(Object.keys(timingValues).length > 0 ? { timing: timingValues } : {}),
        outcome: resolveSubagentTelemetryOutcome({
          state: result.cancel ? "cancelled" : result.pause ? "paused" : undefined,
          success: result.exitCode === 0 && !result.interrupted,
          interrupted: result.interrupted,
          timedOut: result.timedOut,
          terminationReason: result.terminationReason,
          acceptanceStatus: result.acceptance?.status,
        }),
      };
    }),
  });
}

/** Build the envelope used by async status/result writers. */
export type RunnerTelemetryResult = {
  /** Real flat index for partial parallel result artifacts. */
  index?: number;
  agent: string;
  modelIdentity?: SubagentModelIdentity;
  attemptedModels?: string[];
  modelAttempts?: TelemetryModelAttempt[];
  success?: boolean;
  interrupted?: boolean;
  timedOut?: boolean;
  terminationReason?: SubagentTerminationReason;
  acceptance?: { status: AcceptanceLedgerStatus };
  activeRuntimeMs?: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  toolCount?: number;
};

function usageFromAttempts(attempts: RunnerTelemetryResult["modelAttempts"]): Usage | undefined {
  if (!attempts || attempts.length === 0) return undefined;
  let usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  };
  let found = false;
  for (const attempt of attempts) {
    if (!attempt.usage) continue;
    found = true;
    usage = {
      input: usage.input + attempt.usage.input,
      output: usage.output + attempt.usage.output,
      cacheRead: usage.cacheRead + attempt.usage.cacheRead,
      cacheWrite: usage.cacheWrite + attempt.usage.cacheWrite,
      cost: usage.cost + attempt.usage.cost,
      turns: usage.turns + attempt.usage.turns,
    };
  }
  return found ? usage : undefined;
}

/** Convert authoritative async runner results into the allowlisted envelope. */
export function telemetryFromRunnerResults(input: {
  runId: string;
  mode: SubagentRunMode;
  results: RunnerTelemetryResult[];
  provenance?: SubagentTelemetryProvenance;
  controls: ResolvedControlConfig | SubagentTelemetryControls;
  startedAt: number;
  endedAt: number;
  activeRuntimeMs?: number;
  statusSteps?: Array<{
    startedAt?: number;
    endedAt?: number;
    durationMs?: number;
    activeRuntimeMs?: number;
    modelIdentity?: SubagentModelIdentity;
    /** Checkpoint-only fields; never used as terminal attempt evidence. */
    attemptedModels?: string[];
    modelAttempts?: TelemetryModelAttempt[];
    toolCount?: number;
    turnCount?: number;
    status?: string;
    timedOut?: boolean;
    terminationReason?: SubagentTerminationReason;
    acceptance?: { status: AcceptanceLedgerStatus };
  }>;
  lineage?: SubagentTelemetryLineage;
  outcome?: SubagentTelemetryOutcome;
}): SubagentRunTelemetry | undefined {
  if (!input.provenance) return undefined;
  const steps = input.results.map((result, resultIndex) => {
    const index = result.index ?? resultIndex;
    const status = input.statusSteps?.[index];
    // Status checkpoints can expose planned candidates before any model request
    // runs. Only terminal result evidence is authoritative for usage and model
    // attribution; normal results carry the completed attempt history.
    const resultHasAttemptEvidence =
      result.attemptedModels !== undefined || result.modelAttempts !== undefined;
    const statusHasAttemptEvidence =
      status?.attemptedModels !== undefined || status?.modelAttempts !== undefined;
    const usage = usageFromAttempts(result.modelAttempts);
    const telemetryUsage = usageFromSource(usage);
    const model = modelForTelemetryStep({
      model:
        statusHasAttemptEvidence && !resultHasAttemptEvidence
          ? undefined
          : normalizeModelIdentity(result.modelIdentity ?? status?.modelIdentity),
      attemptedModels: result.attemptedModels,
      modelAttempts: result.modelAttempts,
    });
    const turns = usage?.turns ?? status?.turnCount;
    const toolCalls = result.toolCount ?? status?.toolCount;
    const activity =
      turns !== undefined || toolCalls !== undefined
        ? {
            ...(turns !== undefined ? { turns } : {}),
            ...(toolCalls !== undefined ? { toolCalls } : {}),
          }
        : undefined;
    const stepTiming = timingFromInput({
      startedAt: result.startedAt ?? status?.startedAt,
      endedAt: result.endedAt ?? status?.endedAt,
      durationMs: result.durationMs ?? status?.durationMs,
      activeRuntimeMs: result.activeRuntimeMs ?? status?.activeRuntimeMs,
    });
    const outcome = resolveSubagentTelemetryOutcome({
      state: status?.status,
      success: result.success,
      interrupted: result.interrupted,
      timedOut: result.timedOut || status?.timedOut,
      terminationReason: result.terminationReason ?? status?.terminationReason,
      acceptanceStatus: result.acceptance?.status ?? status?.acceptance?.status,
    });
    return {
      index,
      agent: result.agent,
      ...(model ? { model } : {}),
      ...(telemetryUsage ? { usage: telemetryUsage } : {}),
      ...(activity ? { activity } : {}),
      ...(stepTiming ? { timing: stepTiming } : {}),
      ...(outcome ? { outcome } : {}),
    } satisfies SubagentTelemetryStep;
  });
  const runOutcome =
    input.outcome ??
    (input.results.length === 0
      ? undefined
      : resolveParallelSubagentTelemetryOutcome(
          input.results.map((result, resultIndex) => {
            const index = result.index ?? resultIndex;
            const status = input.statusSteps?.[index];
            return {
              index,
              agent: result.agent,
              state: status?.status,
              success: result.success,
              interrupted: result.interrupted,
              timedOut: result.timedOut || status?.timedOut,
              terminationReason: result.terminationReason ?? status?.terminationReason,
            };
          }),
        ));
  return buildSubagentRunTelemetry({
    runId: input.runId,
    execution: "async",
    mode: input.mode,
    steps,
    provenance: input.provenance,
    controls: input.controls,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    activeRuntimeMs: input.activeRuntimeMs,
    outcome: runOutcome,
    lineage: input.lineage,
  });
}

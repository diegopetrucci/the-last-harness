/** Public, privacy-safe result types for local subagent session analysis. */

import type { ScanCoverage } from "./session-analysis-coverage.mjs";

/** Privacy-safe token and cost totals used by the subagent analysis output. */
export interface SubagentUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface SubagentRuntimeTotals {
  durationMs: number;
  activeRuntimeMs: number;
}

export interface SubagentAggregate {
  runs: number;
  steps: number;
  usageReportedSteps: number;
  runtimeReportedRuns: number;
  usage: SubagentUsageTotals;
  runtime: SubagentRuntimeTotals;
}

export type SubagentAggregateMap = Record<string, SubagentAggregate>;

export interface SubagentRunStepSummary {
  index: number;
  role: string;
  model?: { provider: string; model: string; thinking?: string };
  outcome?: { state: string; terminationReason?: string; acceptanceStatus?: string };
  usage?: SubagentUsageTotals;
  runtime?: { durationMs?: number; activeRuntimeMs?: number };
}

export interface SubagentRunSummary {
  runId: string;
  execution: "foreground" | "async" | "unknown";
  mode: "single" | "parallel" | "management" | "unknown";
  roles: string[];
  models: Array<{ provider: string; model: string; thinking?: string }>;
  outcome: { state: string; terminationReason?: string; acceptanceStatus?: string } | null;
  usage: SubagentUsageTotals | null;
  runtime: { durationMs: number | null; activeRuntimeMs: number | null };
  steps: SubagentRunStepSummary[];
  sourceKinds: string[];
  telemetryRecordCount: number;
  continuation?: {
    from?: { sourceRunId: string; sourceStepIndex?: number };
    to?: Array<{ continuationRunId: string; sourceStepIndex?: number }>;
    nested?: {
      rootRunId: string;
      parentRunId: string;
      childRunId: string;
      parentStepIndex?: number;
      depth?: number;
    };
  };
}

export interface SubagentOperationCounts {
  total: number;
  foreground: number;
  async: number;
  unknown: number;
  withRunId: number;
  withoutRunId: number;
  withResult: number;
  withoutResult: number;
}

export interface SubagentOperations {
  launches: SubagentOperationCounts;
  management: {
    total: number;
    byAction: Record<string, number>;
    withTarget: number;
    targetingKnownRun: number;
    unresolvedTargets: number;
  };
  unclassified: number;
  malformedArguments: number;
}

export interface SubagentTelemetryCoverageBucket {
  records: number;
  validRecords: number;
  invalidRecords: number;
  runs: number;
  runsWithUsage: number;
  steps: number;
  stepsWithUsage: number;
}

export interface SubagentRunCoverageBucket {
  runs: number;
  withTelemetry: number;
  withoutTelemetry: number;
  withUsage: number;
  withoutUsage: number;
  withOutcome: number;
  withoutOutcome: number;
  withRuntime: number;
  withoutRuntime: number;
}

export interface SubagentCoverage extends ScanCoverage {
  runsObserved: number;
  runsWithTelemetry: number;
  runsWithoutTelemetry: number;
  foreground: SubagentRunCoverageBucket;
  async: SubagentRunCoverageBucket;
  unknownExecution: SubagentRunCoverageBucket;
  telemetry: {
    recordsObserved: number;
    recordsValid: number;
    recordsInvalid: number;
    recordsDeduplicated: number;
    uniqueSourceIdentities: number;
    foreground: SubagentTelemetryCoverageBucket;
    async: SubagentTelemetryCoverageBucket;
    unknownExecution: SubagentTelemetryCoverageBucket;
  };
  evidence: {
    launchCalls: number;
    launchesWithoutRunId: number;
    managementCalls: number;
    completionNotifications: number;
    controlNotifications: number;
    legacyProseNotifications: number;
    malformedTelemetryRecords: number;
    malformedCompletionDetails: number;
    malformedControlDetails: number;
    unmatchedEvidence: number;
    completionBatchesObserved: number;
    completionBatchesComplete: number;
    completionBatchesIncomplete: number;
    completionBatchesMixedLegacy: number;
    completionBatchChunksObserved: number;
    completionBatchChunksValid: number;
    completionBatchChunksInvalid: number;
    completionBatchStateEvictions: number;
    completionFlushStateEvictions: number;
    completionBatchChunksDeduplicated: number;
    completionBatchChunksDuplicate: number;
    completionBatchChunksMissing: number;
    completionBatchEntriesObserved: number;
    completionBatchEntriesWithoutTelemetry: number;
  };
  wakeups: {
    observed: number;
    attributed: number;
    unattributed: number;
    interruptedByHumanInput: number;
    missingAssistantTurn: number;
    missingRunId: number;
    missingNudge: number;
    unmatchedNudges: number;
  };
  missingEvidence: {
    telemetryForRun: number;
    usageForStep: number;
    runtimeForRun: number;
    outcomeForRun: number;
    completionDetails: number;
    controlDetails: number;
    completionBatchChunks: number;
    completionBatchTelemetry: number;
    syntheticNudge: number;
    wakeupAssistantTurn: number;
    managementTarget: number;
  };
  lineage: {
    continuationEdges: number;
    nestedEdges: number;
    unresolvedReferences: number;
  };
}

export interface SyntheticWakeupRecord {
  kind: "completion" | "control";
  runId?: string;
  /** Present when one grouped completion wakeup covers multiple runs. */
  runIds?: string[];
  attributed: boolean;
  reason?:
    | "missing-run-id"
    | "missing-assistant-turn"
    | "interrupted-by-human-input"
    | "mismatched-nudge"
    | "ambiguous-next-turn";
  assistantUsage: SubagentUsageTotals | null;
  managementCalls: {
    total: number;
    byAction: Record<string, number>;
  };
}

export interface SubagentAnalysisOutput {
  schemaVersion: "1";
  mode: "subagents";
  coverage: SubagentCoverage;
  runs: SubagentRunSummary[];
  aggregates: {
    runs: number;
    steps: number;
    usage: SubagentUsageTotals;
    attributedWakeupUsage: SubagentUsageTotals;
    runtime: SubagentRuntimeTotals;
    byRole: SubagentAggregateMap;
    byModel: SubagentAggregateMap;
    byExecution: SubagentAggregateMap;
    byOutcome: SubagentAggregateMap;
  };
  operations: SubagentOperations;
  lineage: {
    continuationEdges: Array<{
      sourceRunId: string;
      continuationRunId: string;
      sourceStepIndex?: number;
    }>;
    nestedEdges: Array<{
      rootRunId: string;
      parentRunId: string;
      childRunId: string;
      parentStepIndex?: number;
      depth?: number;
    }>;
  };
  wakeups: SyntheticWakeupRecord[];
}

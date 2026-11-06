import {
  buildSubagentRunTelemetry,
  modelForTelemetryStep,
  resolveParallelSubagentTelemetryOutcome,
  resolveSubagentTelemetryOutcome,
  type SubagentRunTelemetry,
  type SubagentTelemetryControls,
  type SubagentTelemetryLineage,
  type SubagentTelemetryOutcome,
  type SubagentTelemetryProvenance,
} from "../../src/shared/telemetry.ts";
import type {
  ResolvedControlConfig,
  SingleResult,
  SubagentRunMode,
} from "../../src/shared/types.ts";

/**
 * Legacy-fixture builder: the production foreground telemetry producer was removed
 * with the foreground engine (tlhf-bm99), but historical `execution: "foreground"`
 * envelopes still decode, and these tests compare them with async outcomes.
 */
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

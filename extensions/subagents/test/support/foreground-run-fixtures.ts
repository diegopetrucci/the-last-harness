import { trimRememberedForegroundRuns } from "../../src/runs/foreground/foreground-run-state.ts";
import { pausedForegroundTerminationReason } from "./foreground-pause-fixtures.ts";
import {
  normalizeActiveRuntimeCheckpointAt,
  normalizeActiveRuntimeMs,
} from "../../src/runs/shared/lifecycle-state.ts";
import { resolveSubagentResultStatus } from "../../src/shared/result-formatting.ts";
import type { SubagentRunTelemetry } from "../../src/shared/telemetry.ts";
import type { SingleResult, SubagentRunMode, SubagentState } from "../../src/shared/types.ts";
import { normalizeTkTicketId } from "../../src/runs/shared/tk-ticket.ts";

/** Legacy-fixture builder (tlhf-bm99): seeds the in-memory remembered-foreground-run index. */
export function rememberForegroundRun(
  state: SubagentState,
  input: {
    runId: string;
    mode: SubagentRunMode;
    cwd: string;
    results: SingleResult[];
    telemetry?: SubagentRunTelemetry;
  },
): void {
  state.foregroundRuns ??= new Map();
  const updatedAt = Date.now();
  state.foregroundRuns.set(input.runId, {
    runId: input.runId,
    mode: input.mode,
    cwd: input.cwd,
    updatedAt,
    ...(input.telemetry ? { telemetry: input.telemetry } : {}),
    children: input.results.map((result, index) => {
      const activeRuntimeMs =
        normalizeActiveRuntimeMs(result.activeRuntimeMs) ??
        normalizeActiveRuntimeMs(result.progress?.durationMs);
      const child = {
        agent: result.agent,
        ...(result.projectAgent ? { projectAgent: result.projectAgent } : {}),
        ...(result.agent === "developer" && normalizeTkTicketId(result.tkTicketId)
          ? { tkTicketId: normalizeTkTicketId(result.tkTicketId) }
          : {}),
        index,
        status: resolveSubagentResultStatus({
          exitCode: result.exitCode,
          interrupted: result.interrupted,
        }),
        updatedAt,
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        ...(result.model ? { model: result.model } : {}),
        ...(result.thinking ? { thinking: result.thinking } : {}),
        ...(result.modelIdentity ? { modelIdentity: result.modelIdentity } : {}),
        ...(result.modelResolution ? { modelResolution: result.modelResolution } : {}),
        ...(result.finalOutput ? { finalOutput: result.finalOutput } : {}),
        ...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
        ...(result.artifactPaths ? { artifactPaths: result.artifactPaths } : {}),
        ...(result.transcriptPath ? { transcriptPath: result.transcriptPath } : {}),
        ...(result.transcriptError ? { transcriptError: result.transcriptError } : {}),
        ...(result.acceptance ? { acceptance: result.acceptance } : {}),
        ...(result.pause ? { pause: result.pause } : {}),
        ...(result.cancel ? { cancel: result.cancel } : {}),
        ...(result.progress?.activityState ? { activityState: result.progress.activityState } : {}),
        ...(result.progress?.idleEpisodeId ? { idleEpisodeId: result.progress.idleEpisodeId } : {}),
        ...(result.progress?.durableAttentionReasons
          ? { durableAttentionReasons: [...result.progress.durableAttentionReasons] }
          : {}),
        ...(result.progress?.compaction ? { compaction: { ...result.progress.compaction } } : {}),
        ...(result.contextUsage ? { contextUsage: result.contextUsage } : {}),
        ...(result.contextPressure ? { contextPressure: { ...result.contextPressure } } : {}),
        ...(result.contextPressureCrossedThresholds
          ? { contextPressureCrossedThresholds: [...result.contextPressureCrossedThresholds] }
          : {}),
        ...(pausedForegroundTerminationReason(result)
          ? { terminationReason: pausedForegroundTerminationReason(result) }
          : {}),
        ...(activeRuntimeMs !== undefined ? { activeRuntimeMs } : {}),
        ...(normalizeActiveRuntimeCheckpointAt(result.activeRuntimeCheckpointAt) !== undefined
          ? {
              activeRuntimeCheckpointAt: normalizeActiveRuntimeCheckpointAt(
                result.activeRuntimeCheckpointAt,
              ),
            }
          : {}),
      };
      return child;
    }),
  });
  trimRememberedForegroundRuns(state);
}

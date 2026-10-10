import { VERSION } from "@earendil-works/pi-coding-agent";
import { getTlhVersion } from "../../../the-last-harness/package-version.js";
import { readTlhInstallState } from "../../../the-last-harness/profile-state.js";
import type { SubagentTelemetryProvenance } from "../shared/telemetry.ts";

/**
 * Capture the local provenance snapshot at the eager extension boundary.
 * Detached runners receive this value through their config and must not load
 * installer/runtime state again when they finish.
 */
export function captureSubagentTelemetryProvenance(
  loadedAt = Date.now(),
): SubagentTelemetryProvenance {
  const installGeneration = readTlhInstallState().installedAt;
  return {
    tlhVersion: getTlhVersion(),
    piVersion: VERSION,
    ...(typeof installGeneration === "string" && installGeneration.trim()
      ? { installGeneration: installGeneration.trim() }
      : {}),
    loadedAt,
  };
}

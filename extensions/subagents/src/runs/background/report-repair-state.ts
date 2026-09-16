import type { AsyncStatus } from "../../shared/types.ts";
import type { RunnerSubagentStep } from "../shared/parallel-utils.ts";
import type { RunnerStatusStep } from "./run-status-owner.ts";

export function preserveReportRepairMarker(
  current: boolean | undefined,
  persisted: boolean | undefined,
): true | undefined {
  return current === true || persisted === true ? true : undefined;
}

export function markReportRepairStart(
  step: Pick<RunnerSubagentStep, "reportRepairAttempted">,
  statusStep: Pick<RunnerStatusStep, "reportRepairAttempted">,
  status: Pick<AsyncStatus, "lastUpdate">,
  writeStatusPayload: () => void,
): void {
  step.reportRepairAttempted = true;
  statusStep.reportRepairAttempted = true;
  status.lastUpdate = Date.now();
  writeStatusPayload();
}

export function createReportRepairState(
  status: Pick<AsyncStatus, "lastUpdate"> & { steps: RunnerStatusStep[] },
  writeStatusPayload: () => void,
) {
  return {
    start: (step: Pick<RunnerSubagentStep, "reportRepairAttempted">, index: number) => () =>
      markReportRepairStart(step, status.steps[index]!, status, writeStatusPayload),
    marker: (
      result: Pick<RunnerSubagentStep, "reportRepairAttempted">,
      index: number,
    ): true | undefined =>
      preserveReportRepairMarker(
        result.reportRepairAttempted,
        status.steps[index]?.reportRepairAttempted,
      ),
    apply: (result: Pick<RunnerSubagentStep, "reportRepairAttempted">, index: number): void => {
      if (result.reportRepairAttempted === true) status.steps[index]!.reportRepairAttempted = true;
    },
  };
}

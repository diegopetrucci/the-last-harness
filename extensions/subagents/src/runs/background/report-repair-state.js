export function preserveReportRepairMarker(current, persisted) {
    return current === true || persisted === true ? true : undefined;
}
export function markReportRepairStart(step, statusStep, status, writeStatusPayload) {
    step.reportRepairAttempted = true;
    statusStep.reportRepairAttempted = true;
    status.lastUpdate = Date.now();
    writeStatusPayload();
}
export function createReportRepairState(status, writeStatusPayload) {
    return {
        start: (step, index) => () => markReportRepairStart(step, status.steps[index], status, writeStatusPayload),
        marker: (result, index) => preserveReportRepairMarker(result.reportRepairAttempted, status.steps[index]?.reportRepairAttempted),
        apply: (result, index) => {
            if (result.reportRepairAttempted === true)
                status.steps[index].reportRepairAttempted = true;
        },
    };
}

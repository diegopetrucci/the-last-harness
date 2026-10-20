// Generated from extensions/subagents/src/runs/background/awaited-run-deadline.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import { PROCESS_GROUP_CLEANUP_MAX_WAIT_MS } from "../shared/process-group-cleanup.js";
function finite(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
export function computeAwaitedHardDeadlineAt(input) {
    const base = finite(input.abortStartedAt) ?? finite(input.deadlineAt);
    if (base === undefined)
        return undefined;
    const cleanupMaxWaitMs = Math.max(0, finite(input.cleanupMaxWaitMs) ?? PROCESS_GROUP_CLEANUP_MAX_WAIT_MS);
    return Math.min(Number.MAX_SAFE_INTEGER, base +
        cleanupMaxWaitMs +
        Math.max(0, finite(input.cleanupGraceMs) ?? 0) +
        Math.max(0, finite(input.artifactGraceMs) ?? 0));
}

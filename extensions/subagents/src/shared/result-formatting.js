// Generated from extensions/subagents/src/shared/result-formatting.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import {} from "./types.js";
export function resolveSubagentResultStatus(input) {
    if (input.interrupted || input.state === "paused")
        return "paused";
    if (typeof input.success === "boolean")
        return input.success ? "completed" : "failed";
    if (input.state === "complete")
        return "completed";
    if (input.state === "failed")
        return "failed";
    if (typeof input.exitCode === "number")
        return input.exitCode === 0 ? "completed" : "failed";
    return "failed";
}

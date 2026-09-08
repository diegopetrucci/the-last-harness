import * as path from "node:path";
import { getProviderAwareFallbackModels } from "../../../../the-last-harness-subagent-safety.mjs";
import { toModelInfo } from "../../shared/model-info.js";
export function readModelRegistrySnapshot(ctx) {
    const optionalRegistry = ctx.modelRegistry;
    const availableModels = ctx.modelRegistry.getAvailable().map(toModelInfo);
    let allModels;
    let error;
    if (typeof optionalRegistry.getAll === "function") {
        try {
            allModels = optionalRegistry.getAll().map(toModelInfo);
        }
        catch {
            error = "model catalog unavailable";
        }
    }
    if (typeof optionalRegistry.getError === "function") {
        try {
            error ??= optionalRegistry.getError();
        }
        catch {
            error = "model availability status unavailable";
        }
    }
    return {
        availableModels,
        evidence: {
            ...(allModels ? { allModels } : {}),
            ...(error ? { error } : {}),
        },
    };
}
export const providerFallbackModelsForTarget = getProviderAwareFallbackModels;
export function resolveSingleRunOutputBaseDir(artifactsDir, runId) {
    return path.join(artifactsDir, "outputs", runId);
}
function diagnosticMatchesAgent(diagnostic, agentName) {
    if (diagnostic.error.includes(`Agent '${agentName}'`))
        return true;
    const localName = diagnostic.error.match(/Agent '([^']+)'/)?.[1];
    if (localName !== undefined && agentName.endsWith(`.${localName}`))
        return true;
    const fileName = path.basename(diagnostic.filePath, path.extname(diagnostic.filePath));
    return agentName === fileName || agentName.endsWith(`.${fileName}`);
}
export function unknownAgentMessage(agentName, agentDiagnostics, prefix = "Unknown agent") {
    const diagnostic = agentDiagnostics?.find((candidate) => diagnosticMatchesAgent(candidate, agentName));
    if (!diagnostic)
        return `${prefix}: ${agentName}`;
    return `${prefix}: ${agentName}. Malformed definition at '${diagnostic.filePath}': ${diagnostic.error}`;
}

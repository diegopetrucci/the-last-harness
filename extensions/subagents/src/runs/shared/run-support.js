import * as path from "node:path";
import { getProviderAwareFallbackModels } from "../../../../the-last-harness-subagent-safety.mjs";
import { toModelInfo } from "../../shared/model-info.js";
export function readModelRegistrySnapshot(ctx) {
    return { availableModels: ctx.modelRegistry.getAvailable().map(toModelInfo) };
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
    const diagnostic = agentDiagnostics?.find((candidate) => candidate.kind !== "notice" && diagnosticMatchesAgent(candidate, agentName));
    if (!diagnostic)
        return `${prefix}: ${agentName}`;
    return `${prefix}: ${agentName}. Malformed definition at '${diagnostic.filePath}': ${diagnostic.error}`;
}

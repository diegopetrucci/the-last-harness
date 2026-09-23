import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentDiscoveryDiagnostic } from "../../agents/agents.ts";
import { getProviderAwareFallbackModels } from "../../../../the-last-harness-subagent-safety.mjs";
import { toModelInfo, type ModelInfo } from "../../shared/model-info.ts";

interface ModelRegistrySnapshot {
  availableModels: ModelInfo[];
}

/**
 * Capture the registry's current available view for model-default selection
 * and context-window diagnostics. Availability is not used to remove or
 * rewrite configured fallback candidates.
 */
export function readModelRegistrySnapshot(ctx: ExtensionContext): ModelRegistrySnapshot {
  return { availableModels: ctx.modelRegistry.getAvailable().map(toModelInfo) };
}

export const providerFallbackModelsForTarget = getProviderAwareFallbackModels;

export function resolveSingleRunOutputBaseDir(artifactsDir: string, runId: string): string {
  return path.join(artifactsDir, "outputs", runId);
}

function diagnosticMatchesAgent(diagnostic: AgentDiscoveryDiagnostic, agentName: string): boolean {
  if (diagnostic.error.includes(`Agent '${agentName}'`)) return true;
  const localName = diagnostic.error.match(/Agent '([^']+)'/)?.[1];
  if (localName !== undefined && agentName.endsWith(`.${localName}`)) return true;
  const fileName = path.basename(diagnostic.filePath, path.extname(diagnostic.filePath));
  return agentName === fileName || agentName.endsWith(`.${fileName}`);
}

export function unknownAgentMessage(
  agentName: string,
  agentDiagnostics: AgentDiscoveryDiagnostic[] | undefined,
  prefix = "Unknown agent",
): string {
  const diagnostic = agentDiagnostics?.find(
    (candidate) => candidate.kind !== "notice" && diagnosticMatchesAgent(candidate, agentName),
  );
  if (!diagnostic) return `${prefix}: ${agentName}`;
  return `${prefix}: ${agentName}. Malformed definition at '${diagnostic.filePath}': ${diagnostic.error}`;
}

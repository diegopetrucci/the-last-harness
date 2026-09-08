import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentDiscoveryDiagnostic } from "../../agents/agents.ts";
import { getProviderAwareFallbackModels } from "../../../../the-last-harness-subagent-safety.mjs";
import { toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import type { ModelRegistryEvidence } from "../shared/model-fallback.ts";

interface ModelRegistrySnapshot {
  availableModels: ModelInfo[];
  evidence: ModelRegistryEvidence;
}

/**
 * Capture both registry views used by fallback policy. `getAvailable()` is an
 * auth-filtered view; `getAll()` is the catalog needed to distinguish a model
 * that is positively unavailable from one omitted by a partial/stale view.
 * Test/legacy facades may expose only getAvailable(), so missing methods fail
 * open and preserve configured fallbacks.
 */
export function readModelRegistrySnapshot(ctx: ExtensionContext): ModelRegistrySnapshot {
  // Test/legacy facades may expose only getAvailable(); keep the optional
  // compatibility surface separate from the typed availability call.
  type ModelRegistryEntry = Parameters<typeof toModelInfo>[0];
  const optionalRegistry = ctx.modelRegistry as {
    getAll?: () => ModelRegistryEntry[];
    getError?: () => string | undefined;
  };
  const availableModels = ctx.modelRegistry.getAvailable().map(toModelInfo);
  let allModels: ModelInfo[] | undefined;
  let error: string | undefined;
  if (typeof optionalRegistry.getAll === "function") {
    try {
      allModels = optionalRegistry.getAll().map(toModelInfo);
    } catch {
      error = "model catalog unavailable";
    }
  }
  if (typeof optionalRegistry.getError === "function") {
    try {
      error ??= optionalRegistry.getError();
    } catch {
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
  const diagnostic = agentDiagnostics?.find((candidate) =>
    diagnosticMatchesAgent(candidate, agentName),
  );
  if (!diagnostic) return `${prefix}: ${agentName}`;
  return `${prefix}: ${agentName}. Malformed definition at '${diagnostic.filePath}': ${diagnostic.error}`;
}

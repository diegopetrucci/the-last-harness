import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import {
  DISABLED_PRIMARY_AGENT,
  isEnabledPrimaryAgentSelection,
} from "../the-last-harness-primary-agent.mjs";
import { setTlhProjectAgentAccessProvider } from "./project-agent-access.mjs";
import {
  inventoryProjectAgentGuidance,
  type ProjectAgentGuidanceInventory,
} from "../shared/project-agent-guidance.js";
import type { TlhPrimaryAgentSelection } from "./types.js";

/**
 * Resource lifecycle for the primary runtime.
 *
 * Embedded project agents are no longer loaded at session start. The subagent
 * executor resolves the requested fixed file on dispatch and re-resolves it
 * for every durable control action. This lifecycle only exposes the
 * host-owned role and trust-store dependency boundary.
 */
export type SessionStartOperation = {
  readonly requestId: number;
  readonly runtimeEpoch: number;
};

export type PrimaryAgentResourceLifecycle = {
  beginSessionStart(): SessionStartOperation;
  isCurrentRuntime(): boolean;
  isCurrentSessionStartOperation(operation: SessionStartOperation): boolean;
  loadSessionResources(ctx: ExtensionContext, operation: SessionStartOperation): Promise<void>;
  projectAgentGuidanceSnapshot(): ProjectAgentGuidanceInventory | undefined;
  shutdown(onCurrent?: () => void): Promise<boolean>;
};

let runtimeEpoch = 0;
let activeRuntimeEpoch = 0;

function createTrustStore(agentDir: string): ProjectTrustStore {
  return new ProjectTrustStore(agentDir);
}

export function retireTlhPrimaryAgentResourceRuntime(): void {
  activeRuntimeEpoch = ++runtimeEpoch;
  setTlhProjectAgentAccessProvider(undefined);
}

export function createTlhPrimaryAgentResourceLifecycle(options: {
  getPrimaryAgentSelection: () => TlhPrimaryAgentSelection;
  hasActivePrimaryAgent: () => boolean;
}): PrimaryAgentResourceLifecycle {
  const epoch = ++runtimeEpoch;
  activeRuntimeEpoch = epoch;
  let requestId = 0;
  let sessionProjectAgentGuidanceSnapshot: ProjectAgentGuidanceInventory | undefined;
  setTlhProjectAgentAccessProvider(() => {
    const selection = options.getPrimaryAgentSelection();
    const architect =
      selection === "architect" &&
      isEnabledPrimaryAgentSelection(selection) &&
      options.hasActivePrimaryAgent();
    return {
      architect,
      canInitiate: architect || selection === DISABLED_PRIMARY_AGENT,
      agentDir: getAgentDir(),
      createProjectTrustStore: createTrustStore,
    } as {
      architect: boolean;
      canInitiate: boolean;
      agentDir: string;
      createProjectTrustStore: (agentDir: string) => ProjectTrustStore;
    };
  });

  const isCurrentRuntime = (): boolean => activeRuntimeEpoch === epoch;
  const isCurrentSessionStartOperation = (operation: SessionStartOperation): boolean =>
    operation.runtimeEpoch === epoch && operation.requestId === requestId && isCurrentRuntime();

  const notifyUndecidedProjectAgentGuidance = (
    ctx: ExtensionContext,
    inventory: ProjectAgentGuidanceInventory,
  ): void => {
    if (ctx.hasUI === false || inventory.trust !== "undecided" || inventory.files.length === 0) {
      return;
    }
    const diagnostic = inventory.diagnostics.find(({ code }) => code === "project-not-trusted");
    if (!diagnostic) return;
    try {
      ctx.ui.notify(diagnostic.message, "warning");
    } catch {
      // Guidance diagnostics are advisory; a broken UI must not block startup.
    }
  };

  return {
    beginSessionStart: () => ({ requestId: ++requestId, runtimeEpoch: epoch }),
    isCurrentRuntime,
    isCurrentSessionStartOperation,
    loadSessionResources: async (ctx, operation) => {
      if (!isCurrentSessionStartOperation(operation)) return;
      const inventory = inventoryProjectAgentGuidance(ctx.cwd, getAgentDir());
      if (!isCurrentSessionStartOperation(operation)) return;
      sessionProjectAgentGuidanceSnapshot = inventory;
      notifyUndecidedProjectAgentGuidance(ctx, inventory);
    },
    projectAgentGuidanceSnapshot: () => sessionProjectAgentGuidanceSnapshot,
    shutdown: async (onCurrent) => {
      if (!isCurrentRuntime()) return false;
      ++requestId;
      sessionProjectAgentGuidanceSnapshot = undefined;
      onCurrent?.();
      return true;
    },
  };
}

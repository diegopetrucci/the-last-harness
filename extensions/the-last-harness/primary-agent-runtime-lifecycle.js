import { getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { DISABLED_PRIMARY_AGENT, isEnabledPrimaryAgentSelection, } from "../the-last-harness-primary-agent.mjs";
import { setTlhProjectAgentAccessProvider } from "./project-agent-access.mjs";
import { inventoryProjectAgentGuidance, } from "../shared/project-agent-guidance.js";
let runtimeEpoch = 0;
let activeRuntimeEpoch = 0;
function createTrustStore(agentDir) {
    return new ProjectTrustStore(agentDir);
}
export function retireTlhPrimaryAgentResourceRuntime() {
    activeRuntimeEpoch = ++runtimeEpoch;
    setTlhProjectAgentAccessProvider(undefined);
}
export function createTlhPrimaryAgentResourceLifecycle(options) {
    const epoch = ++runtimeEpoch;
    activeRuntimeEpoch = epoch;
    let requestId = 0;
    let sessionProjectAgentGuidanceSnapshot;
    setTlhProjectAgentAccessProvider(() => {
        const selection = options.getPrimaryAgentSelection();
        const architect = selection === "architect" &&
            isEnabledPrimaryAgentSelection(selection) &&
            options.hasActivePrimaryAgent();
        return {
            architect,
            canInitiate: architect || selection === DISABLED_PRIMARY_AGENT,
            agentDir: getAgentDir(),
            createProjectTrustStore: createTrustStore,
        };
    });
    const isCurrentRuntime = () => activeRuntimeEpoch === epoch;
    const isCurrentSessionStartOperation = (operation) => operation.runtimeEpoch === epoch && operation.requestId === requestId && isCurrentRuntime();
    const notifyUndecidedProjectAgentGuidance = (ctx, inventory) => {
        if (ctx.hasUI === false || inventory.trust !== "undecided" || inventory.files.length === 0) {
            return;
        }
        const diagnostic = inventory.diagnostics.find(({ code }) => code === "project-not-trusted");
        if (!diagnostic)
            return;
        try {
            ctx.ui.notify(diagnostic.message, "warning");
        }
        catch {
        }
    };
    return {
        beginSessionStart: () => ({ requestId: ++requestId, runtimeEpoch: epoch }),
        isCurrentRuntime,
        isCurrentSessionStartOperation,
        loadSessionResources: async (ctx, operation) => {
            if (!isCurrentSessionStartOperation(operation))
                return;
            const inventory = inventoryProjectAgentGuidance(ctx.cwd, getAgentDir());
            if (!isCurrentSessionStartOperation(operation))
                return;
            sessionProjectAgentGuidanceSnapshot = inventory;
            notifyUndecidedProjectAgentGuidance(ctx, inventory);
        },
        projectAgentGuidanceSnapshot: () => sessionProjectAgentGuidanceSnapshot,
        shutdown: async (onCurrent) => {
            if (!isCurrentRuntime())
                return false;
            ++requestId;
            sessionProjectAgentGuidanceSnapshot = undefined;
            onCurrent?.();
            return true;
        },
    };
}

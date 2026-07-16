import { isRecord } from "./common.js";
import { getTlhExperimentalConfig, isTlhExperimentalFeatureEnabled, TICKET_WORKFLOW_UI_FEATURE, TLH_EXPERIMENTAL_FEATURE_CHANGED_EVENT, } from "./experimental.js";
function createRetryableLazyImport(loader) {
    let modulePromise;
    return () => {
        if (!modulePromise) {
            modulePromise = loader().catch((error) => {
                modulePromise = undefined;
                throw error;
            });
        }
        return modulePromise;
    };
}
function isTicketWorkflowUiEnabled(cwd) {
    return isTlhExperimentalFeatureEnabled(getTlhExperimentalConfig(cwd), TICKET_WORKFLOW_UI_FEATURE);
}
export function registerLazyTlhTicketWorkflowUi(pi, options = {}) {
    const loadModule = createRetryableLazyImport(options.loadModule ?? (() => import("./ticket-workflow-ui.js")));
    let activeContext;
    let runtime;
    let runtimePromise;
    const getRuntime = async () => {
        if (runtime) {
            return runtime;
        }
        if (!runtimePromise) {
            runtimePromise = loadModule()
                .then((module) => module.createTlhTicketWorkflowUiRuntime(pi))
                .then((loadedRuntime) => {
                runtime = loadedRuntime;
                return loadedRuntime;
            })
                .catch((error) => {
                runtimePromise = undefined;
                throw error;
            });
        }
        return runtimePromise;
    };
    const applyCurrentSettings = (ctx) => {
        if (!ctx.hasUI) {
            return;
        }
        if (runtime) {
            runtime.applyCurrentSettings(ctx);
            return;
        }
        if (runtimePromise) {
            void runtimePromise
                .then((loadedRuntime) => {
                loadedRuntime.applyCurrentSettings(ctx);
            })
                .catch(() => undefined);
            return;
        }
        if (!isTicketWorkflowUiEnabled(ctx.cwd)) {
            return;
        }
        void getRuntime()
            .then((loadedRuntime) => {
            loadedRuntime.applyCurrentSettings(ctx);
        })
            .catch(() => undefined);
    };
    pi.events?.on?.(TLH_EXPERIMENTAL_FEATURE_CHANGED_EVENT, (event) => {
        const currentContext = activeContext;
        if (!isRecord(event) || event.featureId !== TICKET_WORKFLOW_UI_FEATURE || !currentContext?.hasUI) {
            return;
        }
        if (typeof event.cwd === "string" && event.cwd !== currentContext.cwd) {
            return;
        }
        if (event.enabled === true || isTicketWorkflowUiEnabled(currentContext.cwd)) {
            const existingRuntime = runtime;
            void getRuntime()
                .then((loadedRuntime) => {
                if (!existingRuntime) {
                    loadedRuntime.applyCurrentSettings(currentContext);
                    return;
                }
                loadedRuntime.handleExperimentalFeatureChange(event);
            })
                .catch(() => undefined);
            return;
        }
        runtime?.handleExperimentalFeatureChange(event);
    });
    pi.on("session_start", async (_event, ctx) => {
        activeContext = ctx;
        applyCurrentSettings(ctx);
    });
    pi.on("user_bash", (event, ctx) => {
        if (runtime) {
            runtime.handleUserBash(event, ctx);
            return;
        }
        if (!ctx.hasUI || !isTicketWorkflowUiEnabled(ctx.cwd)) {
            return;
        }
        void getRuntime()
            .then((loadedRuntime) => {
            loadedRuntime.handleUserBash(event, ctx);
        })
            .catch(() => undefined);
    });
    pi.on("tool_result", async (event, ctx) => {
        if (runtime) {
            runtime.handleToolResult(event, ctx);
            return;
        }
        if (!ctx.hasUI || !isTicketWorkflowUiEnabled(ctx.cwd)) {
            return;
        }
        void getRuntime()
            .then((loadedRuntime) => {
            loadedRuntime.handleToolResult(event, ctx);
        })
            .catch(() => undefined);
    });
}

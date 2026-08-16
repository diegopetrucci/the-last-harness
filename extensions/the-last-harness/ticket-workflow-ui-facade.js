import { createTlhTicketWorkflowUiRuntime } from "./ticket-workflow-ui.js";
import { activateTlhTicketSessionScope } from "./tickets.js";
export function registerLazyTlhTicketWorkflowUi(pi, options = {}) {
    const runtimeFactory = options.createRuntime ?? ((api) => createTlhTicketWorkflowUiRuntime(api));
    let runtime;
    let runtimePromise;
    const getRuntime = async () => {
        if (runtime) {
            return runtime;
        }
        if (!runtimePromise) {
            runtimePromise = Promise.resolve()
                .then(() => runtimeFactory(pi))
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
        void getRuntime()
            .then((loadedRuntime) => {
            loadedRuntime.applyCurrentSettings(ctx);
        })
            .catch(() => undefined);
    };
    pi.on("session_start", async (_event, ctx) => {
        activateTlhTicketSessionScope(ctx.cwd);
        applyCurrentSettings(ctx);
    });
    pi.on("session_shutdown", () => {
        if (runtime) {
            runtime.handleSessionShutdown();
            return;
        }
        void runtimePromise?.then((loadedRuntime) => loadedRuntime.handleSessionShutdown()).catch(() => undefined);
    });
    pi.on("user_bash", (event, ctx) => {
        if (runtime) {
            runtime.handleUserBash(event, ctx);
            return;
        }
        if (!ctx.hasUI) {
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
        if (!ctx.hasUI) {
            return;
        }
        void getRuntime()
            .then((loadedRuntime) => {
            loadedRuntime.handleToolResult(event, ctx);
        })
            .catch(() => undefined);
    });
}

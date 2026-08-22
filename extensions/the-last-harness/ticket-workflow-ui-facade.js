import { createTlhTicketWorkflowUiRuntime, } from "./ticket-workflow-ui.js";
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
}

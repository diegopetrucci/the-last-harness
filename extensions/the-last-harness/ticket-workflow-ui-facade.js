import { SettingsManager, getAgentDir, } from "@earendil-works/pi-coding-agent";
import { activateTlhTicketSessionScope } from "./tickets.js";
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
function getSettingsForFacade(cwd) {
    try {
        const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings();
        return settings !== null && typeof settings === "object" && !Array.isArray(settings)
            ? settings
            : {};
    }
    catch {
        return {};
    }
}
export function registerLazyTlhTicketWorkflowUi(pi, options = {}) {
    const loadModule = createRetryableLazyImport(options.loadModule ?? (() => import("./ticket-workflow-ui.js")));
    let runtime;
    let runtimePromise;
    const getRuntime = async () => {
        if (runtime) {
            return runtime;
        }
        if (!runtimePromise) {
            runtimePromise = loadModule()
                .then((module) => module.createTlhTicketWorkflowUiRuntime(pi, {
                getSettings: getSettingsForFacade,
                getAgentDir,
            }))
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

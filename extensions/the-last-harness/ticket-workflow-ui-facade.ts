import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  createTlhTicketWorkflowUiRuntime,
  type TlhTicketWorkflowUiRuntime,
} from "./ticket-workflow-ui.js";
import { activateTlhTicketSessionScope } from "./tickets.js";

type TlhTicketWorkflowUiFacadeOptions = {
  createRuntime?: (pi: ExtensionAPI) => TlhTicketWorkflowUiRuntime;
};
export function registerLazyTlhTicketWorkflowUi(
  pi: ExtensionAPI,
  options: TlhTicketWorkflowUiFacadeOptions = {},
): void {
  const runtimeFactory =
    options.createRuntime ?? ((api: ExtensionAPI) => createTlhTicketWorkflowUiRuntime(api));
  let runtime: TlhTicketWorkflowUiRuntime | undefined;
  let runtimePromise: Promise<TlhTicketWorkflowUiRuntime> | undefined;

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
  const applyCurrentSettings = (ctx: ExtensionContext) => {
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

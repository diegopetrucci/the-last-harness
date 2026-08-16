import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { TlhTicketWorkflowUiRuntime } from "./ticket-workflow-ui.js";
import { activateTlhTicketSessionScope } from "./tickets.js";

type TicketWorkflowUiModule = {
  createTlhTicketWorkflowUiRuntime(pi: ExtensionAPI): TlhTicketWorkflowUiRuntime;
};

type TlhTicketWorkflowUiFacadeOptions = {
  loadModule?: () => Promise<TicketWorkflowUiModule>;
};

function createRetryableLazyImport<TModule>(
  loader: () => Promise<TModule>,
): () => Promise<TModule> {
  let modulePromise: Promise<TModule> | undefined;
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

export function registerLazyTlhTicketWorkflowUi(
  pi: ExtensionAPI,
  options: TlhTicketWorkflowUiFacadeOptions = {},
): void {
  const loadModule = createRetryableLazyImport(
    options.loadModule ??
      (() => import("./ticket-workflow-ui.js") as Promise<TicketWorkflowUiModule>),
  );
  let runtime: TlhTicketWorkflowUiRuntime | undefined;
  let runtimePromise: Promise<TlhTicketWorkflowUiRuntime> | undefined;

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

  pi.on("session_shutdown", () => {
    if (runtime) {
      runtime.handleSessionShutdown();
      return;
    }
    void runtimePromise
      ?.then((loadedRuntime) => loadedRuntime.handleSessionShutdown())
      .catch(() => undefined);
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

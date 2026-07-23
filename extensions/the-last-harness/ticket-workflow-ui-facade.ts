import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isRecord } from "./common.js";
import {
	getTlhExperimentalConfig,
	isTlhExperimentalFeatureEnabled,
	TICKET_WORKFLOW_UI_FEATURE,
	TLH_EXPERIMENTAL_FEATURE_CHANGED_EVENT,
} from "./experimental.js";
import type { TlhTicketWorkflowUiRuntime } from "./ticket-workflow-ui.js";
import { activateTlhTicketSessionScope } from "./tickets.js";

type TicketWorkflowUiModule = {
	createTlhTicketWorkflowUiRuntime(pi: ExtensionAPI): TlhTicketWorkflowUiRuntime;
};

type TlhTicketWorkflowUiFacadeOptions = {
	loadModule?: () => Promise<TicketWorkflowUiModule>;
};

function createRetryableLazyImport<TModule>(loader: () => Promise<TModule>): () => Promise<TModule> {
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

function isTicketWorkflowUiEnabled(cwd: string): boolean {
	return isTlhExperimentalFeatureEnabled(getTlhExperimentalConfig(cwd), TICKET_WORKFLOW_UI_FEATURE);
}

export function registerLazyTlhTicketWorkflowUi(pi: ExtensionAPI, options: TlhTicketWorkflowUiFacadeOptions = {}): void {
	const loadModule = createRetryableLazyImport(
		options.loadModule ?? (() => import("./ticket-workflow-ui.js") as Promise<TicketWorkflowUiModule>),
	);
	let activeContext: ExtensionContext | undefined;
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
		if (!isTicketWorkflowUiEnabled(ctx.cwd)) {
			return;
		}
		void getRuntime()
			.then((loadedRuntime) => {
				loadedRuntime.applyCurrentSettings(ctx);
			})
			.catch(() => undefined);
	};

	pi.events?.on?.(TLH_EXPERIMENTAL_FEATURE_CHANGED_EVENT, (event: unknown) => {
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
		activateTlhTicketSessionScope(ctx.cwd, { refresh: true });
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

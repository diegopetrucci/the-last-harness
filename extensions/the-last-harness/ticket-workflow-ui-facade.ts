import {
	SettingsManager,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { TlhTicketWorkflowUiRuntime, TlhTicketWorkflowUiRuntimeOptions } from "./ticket-workflow-ui.js";
import { activateTlhTicketSessionScope } from "./tickets.js";
import type { TlhSettings } from "./types.js";

type TicketWorkflowUiModule = {
	createTlhTicketWorkflowUiRuntime(
		pi: ExtensionAPI,
		options?: TlhTicketWorkflowUiRuntimeOptions,
	): TlhTicketWorkflowUiRuntime;
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

function getSettingsForFacade(cwd: string): TlhSettings {
	try {
		const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as unknown;
		return settings !== null && typeof settings === "object" && !Array.isArray(settings)
			? (settings as TlhSettings)
			: {};
	} catch {
		return {};
	}
}

export function registerLazyTlhTicketWorkflowUi(
	pi: ExtensionAPI,
	options: TlhTicketWorkflowUiFacadeOptions = {},
): void {
	const loadModule = createRetryableLazyImport(
		options.loadModule ?? (() => import("./ticket-workflow-ui.js") as Promise<TicketWorkflowUiModule>),
	);
	let runtime: TlhTicketWorkflowUiRuntime | undefined;
	let runtimePromise: Promise<TlhTicketWorkflowUiRuntime> | undefined;

	const getRuntime = async () => {
		if (runtime) {
			return runtime;
		}
		if (!runtimePromise) {
			runtimePromise = loadModule()
				.then((module) =>
					module.createTlhTicketWorkflowUiRuntime(pi, {
						getSettings: getSettingsForFacade,
						getAgentDir,
					}),
				)
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

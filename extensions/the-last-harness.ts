import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerTlhActivityReporters } from "./the-last-harness/activity-reporters.js";
import { registerTlhEffectiveActivityTracker } from "./the-last-harness/activity-tracker.js";
import { registerToggleTlhGitAttributionCommand } from "./the-last-harness/attribution.js";
import { TLH_HEADER_TOGGLE_SHORTCUT } from "./the-last-harness/constants.js";
import { createTlhAutocompleteProvider } from "./the-last-harness/autocomplete.js";
import { registerContextCap } from "./the-last-harness/context-cap.js";
import { registerEffortCommand } from "./the-last-harness/effort.js";
import { registerExperimentalCommand } from "./the-last-harness/experimental.js";
import { createTlhFooter } from "./the-last-harness/footer.js";
import { FooterGitCache } from "./the-last-harness/footer-git-cache.js";
import { createTlhHeader } from "./the-last-harness/header.js";
import { readTlhInstallNotice } from "./the-last-harness/install-state.js";
import { installTlhModelVisibilityFilter } from "./the-last-harness/model-visibility.js";
import { installTlhNewVersionNotificationOverride } from "./the-last-harness/new-version-notice.js";
import { installTlhPackageUpdateNotificationOverride } from "./the-last-harness/package-update-notice.js";
import { registerTlhPrimaryAgentRuntime } from "./the-last-harness/primary-agent-runtime.js";
import { collectStartupResources } from "./the-last-harness/resources.js";
import { getTlhStartupTip } from "./the-last-harness/startup-tip.js";
import { createLazyTlhSubscriptionUsageService } from "./the-last-harness/subscription-usage-facade.js";
import { registerTlhTicketWorkflowUi } from "./the-last-harness/ticket-workflow-ui.js";
import { getTlhUsageLimitsConfig, registerUsageCommand, shouldShowTlhUsageWeekly } from "./the-last-harness/usage-limits.js";
import { getTlhHeaderUpdate, maybeNotifyAvailableTlhUpdate } from "./the-last-harness/update-check.js";
import { registerVersionCommand } from "./the-last-harness/version.js";
import type { StartupResources, TlhUsageRefreshOptions } from "./the-last-harness/types.js";

const REVIEW_COMMAND_DESCRIPTION = "Review code changes via an interactive mode picker";
const TOKENS_COMMAND_DESCRIPTION = "Generate and open a local TLH token-spend report";
const ANNOTATE_LAST_MESSAGE_COMMAND_DESCRIPTION = "Open a native annotation window for the latest assistant message";
const TLH_CHANGELOG_COMMAND_DESCRIPTION = "Show TLH release notes from the packaged changelog";

function getActiveProjectTrustDecision(ctx: ExtensionContext): boolean | undefined {
	const projectTrusted = (ctx as ExtensionContext & { isProjectTrusted?: () => unknown }).isProjectTrusted?.();
	return typeof projectTrusted === "boolean" ? projectTrusted : undefined;
}

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

export default function theLastHarness(pi: ExtensionAPI) {
	installTlhModelVisibilityFilter();
	registerContextCap(pi);
	const activityTracker = registerTlhEffectiveActivityTracker(pi);
	registerTlhActivityReporters(pi, activityTracker);

	const primaryAgentRuntime = registerTlhPrimaryAgentRuntime(pi, { env: process.env });
	if (!primaryAgentRuntime) {
		return;
	}

	installTlhPackageUpdateNotificationOverride();
	installTlhNewVersionNotificationOverride();
	registerToggleTlhGitAttributionCommand(pi);
	const loadReviewModule = createRetryableLazyImport(() => import("./the-last-harness/review.js"));
	const loadTokensModule = createRetryableLazyImport(() => import("./the-last-harness/tokens.js"));
	const loadAnnotateLastMessageModule = createRetryableLazyImport(() => import("./the-last-harness/annotate-last-message.js"));
	const loadTlhChangelogModule = createRetryableLazyImport(() => import("./the-last-harness/changelog.js"));
	let reviewCommandHandlerPromise: Promise<ReturnType<(typeof import("./the-last-harness/review.js"))["createReviewCommandHandler"]>> | undefined;
	let tokensCommandHandlerPromise: Promise<ReturnType<(typeof import("./the-last-harness/tokens.js"))["createTokensCommandHandler"]>> | undefined;
	let annotateLastMessageCommandPromise: Promise<ReturnType<(typeof import("./the-last-harness/annotate-last-message.js"))["buildAnnotateLastMessageCommand"]>> | undefined;
	let tlhChangelogCommandHandlerPromise: Promise<(typeof import("./the-last-harness/changelog.js"))["handleTlhChangelogCommand"]> | undefined;
	const getReviewCommandHandler = () => {
		if (!reviewCommandHandlerPromise) {
			reviewCommandHandlerPromise = loadReviewModule()
				.then((module) => module.createReviewCommandHandler(pi))
				.catch((error) => {
					reviewCommandHandlerPromise = undefined;
					throw error;
				});
		}
		return reviewCommandHandlerPromise;
	};
	const getTokensCommandHandler = () => {
		if (!tokensCommandHandlerPromise) {
			tokensCommandHandlerPromise = loadTokensModule()
				.then((module) => module.createTokensCommandHandler(pi))
				.catch((error) => {
					tokensCommandHandlerPromise = undefined;
					throw error;
				});
		}
		return tokensCommandHandlerPromise;
	};
	const getAnnotateLastMessageCommand = () => {
		if (!annotateLastMessageCommandPromise) {
			annotateLastMessageCommandPromise = loadAnnotateLastMessageModule()
				.then((module) => module.buildAnnotateLastMessageCommand())
				.catch((error) => {
					annotateLastMessageCommandPromise = undefined;
					throw error;
				});
		}
		return annotateLastMessageCommandPromise;
	};
	const getTlhChangelogCommandHandler = () => {
		if (!tlhChangelogCommandHandlerPromise) {
			tlhChangelogCommandHandlerPromise = loadTlhChangelogModule()
				.then((module) => module.handleTlhChangelogCommand)
				.catch((error) => {
					tlhChangelogCommandHandlerPromise = undefined;
					throw error;
				});
		}
		return tlhChangelogCommandHandlerPromise;
	};
	pi.registerCommand("annotate-last-message", {
		description: ANNOTATE_LAST_MESSAGE_COMMAND_DESCRIPTION,
		handler: async (args, ctx) => {
			const command = await getAnnotateLastMessageCommand();
			await command.handler(args, ctx);
		},
	});
	pi.on("session_shutdown", async () => {
		if (!annotateLastMessageCommandPromise) {
			return;
		}
		try {
			const command = await annotateLastMessageCommandPromise;
			command.handleSessionShutdown();
		} catch {
			// Swallow prior lazy-import/build failures during shutdown.
		}
	});
	registerEffortCommand(pi, primaryAgentRuntime);
	registerExperimentalCommand(pi);
	registerTlhTicketWorkflowUi(pi);
	pi.registerCommand("review", {
		description: REVIEW_COMMAND_DESCRIPTION,
		getArgumentCompletions: () => null,
		handler: async (args, ctx) => {
			const handler = await getReviewCommandHandler();
			await handler(args, ctx);
		},
	});
	pi.registerCommand("tlh-changelog", {
		description: TLH_CHANGELOG_COMMAND_DESCRIPTION,
		handler: async (args, ctx) => {
			const handler = await getTlhChangelogCommandHandler();
			await handler(pi, args, ctx);
		},
	});
	pi.registerCommand("tokens", {
		description: TOKENS_COMMAND_DESCRIPTION,
		handler: async (args, ctx) => {
			const handler = await getTokensCommandHandler();
			await handler(args, ctx);
		},
	});
	registerUsageCommand(pi);
	registerVersionCommand(pi);
	let activeTlhHeader: ReturnType<typeof createTlhHeader> | undefined;
	pi.registerShortcut(TLH_HEADER_TOGGLE_SHORTCUT, {
		description: "Toggle TLH startup header resources",
		handler: (ctx) => {
			if (!ctx.hasUI) {
				return;
			}
			activeTlhHeader?.toggleExpanded();
		},
	});

	const subscriptionUsageService = createLazyTlhSubscriptionUsageService();
	const refreshSubscriptionUsage = (ctx: ExtensionContext, options: TlhUsageRefreshOptions = {}) => {
		if (!ctx.hasUI) {
			return;
		}
		subscriptionUsageService.refresh(ctx, options);
	};

	pi.on("model_select", (_event, ctx) => {
		refreshSubscriptionUsage(ctx);
	});

	pi.on("turn_end", (_event, ctx) => {
		refreshSubscriptionUsage(ctx);
	});

	pi.on("session_start", async (event, ctx) => {
		await primaryAgentRuntime.applySessionStart(ctx);

		if (!ctx.hasUI) {
			return;
		}

		if (event.reason === "startup") {
			void import("./the-last-harness/launch-telemetry.js")
				.then(({ scheduleTlhLaunchTelemetry }) => {
					scheduleTlhLaunchTelemetry(ctx);
				})
				.catch(() => undefined);
		}

		ctx.ui.addAutocompleteProvider(createTlhAutocompleteProvider);

		let resources: StartupResources = { context: [], skills: [], prompts: [], extensions: [], themes: [] };
		try {
			resources = await collectStartupResources(ctx.cwd, {
				projectTrusted: getActiveProjectTrustDecision(ctx),
			});
		} catch {
			// Keep startup resilient. The header can still render without resource details.
		}

		const headerUpdate = getTlhHeaderUpdate();
		const installNotice = event.reason === "startup" ? readTlhInstallNotice() : undefined;
		const startupTip = event.reason === "startup" ? getTlhStartupTip() : undefined;

		if (typeof ctx.ui.setFooter === "function") {
			ctx.ui.setFooter((tui, theme, footerData) => {
				subscriptionUsageService.registerFooterRenderRequest(ctx, () => tui.requestRender());
				const gitCache = new FooterGitCache({
					cwd: () => ctx.sessionManager.getCwd(),
					onChange: () => tui.requestRender(),
					onBranchChangeSource:
						typeof footerData?.onBranchChange === "function" ? (cb) => footerData.onBranchChange(cb) : undefined,
				});
				return createTlhFooter(pi, ctx, theme, () => primaryAgentRuntime.currentPrimaryAgentLabel(), footerData, {
					subscriptionUsage: subscriptionUsageService,
					shouldShowWeekly: () => shouldShowTlhUsageWeekly(getTlhUsageLimitsConfig(ctx.cwd)),
				}, gitCache);
			});
		}
		if (typeof ctx.ui.setHeader === "function") {
			ctx.ui.setHeader((tui, theme) => {
				const header = createTlhHeader(theme, resources, headerUpdate, installNotice, {
					requestRender: () => tui.requestRender(),
					startupTip,
				});
				activeTlhHeader = header;
				return header;
			});
		}

		refreshSubscriptionUsage(ctx);
		void maybeNotifyAvailableTlhUpdate(ctx).catch(() => undefined);
	});
}

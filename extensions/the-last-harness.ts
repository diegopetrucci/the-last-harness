import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerToggleTlhGitAttributionCommand } from "./the-last-harness/attribution.js";
import { TLH_HEADER_TOGGLE_SHORTCUT } from "./the-last-harness/constants.js";
import { createTlhAutocompleteProvider } from "./the-last-harness/autocomplete.js";
import { registerContextCap } from "./the-last-harness/context-cap.js";
import { registerTlhChangelogCommand } from "./the-last-harness/changelog.js";
import { registerEffortCommand } from "./the-last-harness/effort.js";
import { registerExperimentalCommand } from "./the-last-harness/experimental.js";
import { createTlhFooter } from "./the-last-harness/footer.js";
import { FooterGitCache } from "./the-last-harness/footer-git-cache.js";
import { createTlhHeader } from "./the-last-harness/header.js";
import { readTlhInstallNotice } from "./the-last-harness/install-state.js";
import { scheduleTlhLaunchTelemetry } from "./the-last-harness/launch-telemetry.js";
import { installTlhModelVisibilityFilter } from "./the-last-harness/model-visibility.js";
import { installTlhNewVersionNotificationOverride } from "./the-last-harness/new-version-notice.js";
import { installTlhPackageUpdateNotificationOverride } from "./the-last-harness/package-update-notice.js";
import { registerTlhPrimaryAgentRuntime } from "./the-last-harness/primary-agent-runtime.js";
import { collectStartupResources } from "./the-last-harness/resources.js";
import { getTlhStartupTip } from "./the-last-harness/startup-tip.js";
import { createTlhSubscriptionUsageService } from "./the-last-harness/subscription-usage.js";
import { getTlhUsageLimitsConfig, registerUsageCommand, shouldShowTlhUsageWeekly } from "./the-last-harness/usage-limits.js";
import { getTlhHeaderUpdate, maybeNotifyAvailableTlhUpdate } from "./the-last-harness/update-check.js";
import { registerVersionCommand } from "./the-last-harness/version.js";
import type { StartupResources, TlhUsageRefreshOptions } from "./the-last-harness/types.js";

function getActiveProjectTrustDecision(ctx: ExtensionContext): boolean | undefined {
	const projectTrusted = (ctx as ExtensionContext & { isProjectTrusted?: () => unknown }).isProjectTrusted?.();
	return typeof projectTrusted === "boolean" ? projectTrusted : undefined;
}

export default function theLastHarness(pi: ExtensionAPI) {
	installTlhModelVisibilityFilter();
	registerContextCap(pi);

	const primaryAgentRuntime = registerTlhPrimaryAgentRuntime(pi, { env: process.env });
	if (!primaryAgentRuntime) {
		return;
	}

	installTlhPackageUpdateNotificationOverride();
	installTlhNewVersionNotificationOverride();
	registerToggleTlhGitAttributionCommand(pi);
	registerEffortCommand(pi, primaryAgentRuntime);
	registerExperimentalCommand(pi);
	registerTlhChangelogCommand(pi);
	registerUsageCommand(pi);
	registerVersionCommand(pi);

	// Lazy-loaded commands: the handler body (and its imported module subtree) is
	// deferred until the first invocation. Command metadata (name, description,
	// argument completions) is registered synchronously so discovery/autocomplete
	// are unaffected. See gnosis rhreyj for the rationale and pattern.

	// /review — lazily imports review.ts (~36 KB) on first use.
	pi.registerCommand("review", {
		description: "Review code changes via an interactive mode picker",
		getArgumentCompletions: () => null,
		handler: async (args, ctx) => {
			const { reviewCommandHandler } = await import("./the-last-harness/review.js");
			return reviewCommandHandler(pi, args, ctx);
		},
	});

	// /tokens — lazily imports tokens.ts + tokens-analyzer.ts (~59 KB combined) on first use.
	pi.registerCommand("tokens", {
		description: "Generate and open a local TLH token-spend report",
		handler: async (args, ctx) => {
			const { tokensCommandHandler } = await import("./the-last-harness/tokens.js");
			return tokensCommandHandler(pi, args, ctx);
		},
	});

	// /annotate-last-message — lazily imports annotate-last-message.ts and its ~15 KB
	// subtree (prompt/session/ui + shared/quiet-glimpse) on first use. The handler
	// is initialized once (creating closure state + session_shutdown listener) and
	// then reused for subsequent invocations.
	//
	// The Promise itself is memoized (not the resolved value) so that two
	// near-simultaneous first invocations of /annotate-last-message both receive
	// the same in-flight promise. This ensures the dynamic import and
	// buildAnnotateLastMessageCommandHandler run at most once even under concurrency,
	// preventing duplicate session_shutdown listeners.
	{
		type AnnotateHandlerFn = ReturnType<
			(typeof import("./the-last-harness/annotate-last-message.js"))["buildAnnotateLastMessageCommandHandler"]
		>;
		let annotateHandlerPromise: Promise<AnnotateHandlerFn> | null = null;
		const getAnnotateHandler = (): Promise<AnnotateHandlerFn> => {
			if (annotateHandlerPromise === null) {
				annotateHandlerPromise = import("./the-last-harness/annotate-last-message.js").then(
					(mod) => mod.buildAnnotateLastMessageCommandHandler(pi),
				);
			}
			return annotateHandlerPromise;
		};
		pi.registerCommand("annotate-last-message", {
			description: "Open a native annotation window for the latest assistant message",
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				return (await getAnnotateHandler())(args, ctx);
			},
		});
	}
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

	const subscriptionUsageService = createTlhSubscriptionUsageService();
	const requestFooterRenderByContext = new WeakMap<ExtensionContext, () => void>();
	const refreshSubscriptionUsage = (ctx: ExtensionContext, options: TlhUsageRefreshOptions = {}) => {
		if (!ctx.hasUI) {
			return;
		}
		const provider = ctx.model?.provider;
		const previousSnapshot = subscriptionUsageService.getSnapshotForContext(ctx);
		const previousEligible = subscriptionUsageService.isEligible(ctx);
		const previousProviderSnapshot = provider ? subscriptionUsageService.getSnapshot(provider) : undefined;
		const previousProviderEligible = provider ? subscriptionUsageService.isEligible(provider) : false;
		void subscriptionUsageService
			.refresh(ctx, options)
			.then(() => {
				const nextSnapshot = subscriptionUsageService.getSnapshotForContext(ctx);
				const nextEligible = subscriptionUsageService.isEligible(ctx);
				const nextProviderSnapshot = provider ? subscriptionUsageService.getSnapshot(provider) : undefined;
				const nextProviderEligible = provider ? subscriptionUsageService.isEligible(provider) : false;
				if (
					nextSnapshot !== previousSnapshot ||
					nextEligible !== previousEligible ||
					nextProviderSnapshot !== previousProviderSnapshot ||
					nextProviderEligible !== previousProviderEligible
				) {
					requestFooterRenderByContext.get(ctx)?.();
				}
			})
			.catch(() => undefined);
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
			scheduleTlhLaunchTelemetry(ctx);
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
				requestFooterRenderByContext.set(ctx, () => tui.requestRender());
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

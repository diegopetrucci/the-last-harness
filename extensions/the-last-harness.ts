import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerAnnotateLastMessageCommand } from "./the-last-harness/annotate-last-message.js";
import { registerToggleTlhGitAttributionCommand } from "./the-last-harness/attribution.js";
import { TLH_HEADER_TOGGLE_SHORTCUT } from "./the-last-harness/constants.js";
import { createTlhAutocompleteProvider } from "./the-last-harness/autocomplete.js";
import { registerContextCap } from "./the-last-harness/context-cap.js";
import { registerTlhChangelogCommand } from "./the-last-harness/changelog.js";
import { registerEffortCommand } from "./the-last-harness/effort.js";
import { registerExperimentalCommand } from "./the-last-harness/experimental.js";
import { registerReviewCommand } from "./the-last-harness/review.js";
import { createTlhFooter } from "./the-last-harness/footer.js";
import { FooterGitCache } from "./the-last-harness/footer-git-cache.js";
import { createTlhHeader } from "./the-last-harness/header.js";
import { readTlhInstallNotice } from "./the-last-harness/install-state.js";
import { scheduleTlhLaunchTelemetry } from "./the-last-harness/launch-telemetry.js";
import { installTlhPackageUpdateNotificationOverride } from "./the-last-harness/package-update-notice.js";
import { registerTlhPrimaryAgentRuntime } from "./the-last-harness/primary-agent-runtime.js";
import { collectStartupResources } from "./the-last-harness/resources.js";
import { getTlhStartupTip } from "./the-last-harness/startup-tip.js";
import { createTlhSubscriptionUsageService } from "./the-last-harness/subscription-usage.mjs";
import { registerTokensCommand } from "./the-last-harness/tokens.js";
import { getTlhUsageLimitsConfig, registerUsageCommand, shouldShowTlhUsageWeekly } from "./the-last-harness/usage-limits.js";
import { getTlhHeaderUpdate, maybeNotifyAvailableTlhUpdate } from "./the-last-harness/update-check.js";
import { registerVersionCommand } from "./the-last-harness/version.js";
import type { StartupResources, TlhUsageRefreshOptions } from "./the-last-harness/types.js";

function getActiveProjectTrustDecision(ctx: ExtensionContext): boolean | undefined {
	const projectTrusted = (ctx as ExtensionContext & { isProjectTrusted?: () => unknown }).isProjectTrusted?.();
	return typeof projectTrusted === "boolean" ? projectTrusted : undefined;
}

export default function theLastHarness(pi: ExtensionAPI) {
	registerContextCap(pi);

	const primaryAgentRuntime = registerTlhPrimaryAgentRuntime(pi, { env: process.env });
	if (!primaryAgentRuntime) {
		return;
	}

	installTlhPackageUpdateNotificationOverride();
	registerToggleTlhGitAttributionCommand(pi);
	registerAnnotateLastMessageCommand(pi);
	registerEffortCommand(pi, primaryAgentRuntime);
	registerExperimentalCommand(pi);
	registerReviewCommand(pi);
	registerTlhChangelogCommand(pi);
	registerTokensCommand(pi);
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

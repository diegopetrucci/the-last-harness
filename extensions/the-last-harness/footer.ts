import { truncateToWidth } from "@earendil-works/pi-tui";
import {
	keyText,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadonlyFooterDataProvider,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { DUMB_ZONE_LABEL, DUMB_ZONE_THRESHOLD_TOKENS } from "./constants.js";
import { formatCompactTokenCount, formatHomePath, sanitizeStatusText } from "./common.js";
import type { FooterGitCache } from "./footer-git-cache.js";
import { composeTlhFooterFirstLine } from "./footer-first-line.js";
import {
	getTlhSubscriptionUsageFooterState,
	type TlhFooterSubscriptionUsageOptions,
} from "./footer-subscription-usage.js";
export { formatTlhSubscriptionUsageFooterSegment } from "./footer-subscription-usage.js";

function formatCost(cost: number): string {
	return cost < 0.001 ? "<$0.001" : `$${cost.toFixed(3)}`;
}

function getCurrentThinkingLevel(pi: ExtensionAPI): string {
	try {
		return pi.getThinkingLevel();
	} catch {
		return "off";
	}
}

function collectUsageTotals(ctx: ExtensionContext) {
	const totals = { cost: 0 };
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") {
			continue;
		}
		const usage = entry.message.usage;
		if (!usage) {
			continue;
		}
		totals.cost += Number(usage.cost?.total) || 0;
	}
	return totals;
}

export type TlhFooterUsageOptions = TlhFooterSubscriptionUsageOptions;

export function createTlhFooter(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	theme: Theme,
	getPrimaryName: () => string,
	footerData?: ReadonlyFooterDataProvider,
	usageOptions: TlhFooterUsageOptions = {},
	gitCache?: FooterGitCache | null,
) {
	return {
		render(width: number): string[] {
			const model = ctx.model;
			const totals = collectUsageTotals(ctx);
			const contextUsage = ctx.getContextUsage();
			const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
			const contextPercentValue = contextUsage?.percent ?? 0;
			const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

			// Line 1: cwd • branch • git-status • PR • sessionName (unchanged)
			const pwd = composeTlhFooterFirstLine({
				cwd: formatHomePath(ctx.sessionManager.getCwd()),
				sessionName: ctx.sessionManager.getSessionName(),
				status: gitCache?.getStatusSnapshot(),
				pullRequest: gitCache?.getPullRequestSnapshot(),
				fallbackBranch: footerData?.getGitBranch?.(),
			});
			const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

			// Line 2 (single flowing left-justified line):
			//   agent: <primaryName> • [(provider)] <model|no-model> [• thinking] • context% [• DUMB ZONE]
			// Each segment is explicitly themed to avoid ANSI foreground-reset bleed from nested
			// theme.fg() calls. Non-default agent names are highlighted with the accent color.
			const modelOrNoModel = model?.id ?? "no-model";
			let modelPart: string = modelOrNoModel;
			if ((footerData?.getAvailableProviderCount?.() ?? 1) > 1 && model) {
				modelPart = `(${model.provider}) ${modelOrNoModel}`;
			}

			const primaryName = getPrimaryName();
			const dimSep = theme.fg("dim", " • ");
			const nameSegment =
				primaryName === "architect"
					? theme.fg("dim", primaryName)
					: theme.fg("accent", primaryName);

			let agentLine2Str = theme.fg("dim", "agent: ") + nameSegment + dimSep + theme.fg("dim", modelPart);

			if (model?.reasoning) {
				const thinkingLevel = getCurrentThinkingLevel(pi);
				agentLine2Str += dimSep + theme.fg("dim", thinkingLevel === "off" ? "thinking off" : thinkingLevel);
			}

			const contextPercentDisplay =
				contextPercent === "?" ? `?/${formatCompactTokenCount(contextWindow)}` : `${contextPercent}%/${formatCompactTokenCount(contextWindow)}`;
			let contextPercentStr: string;
			if (contextPercentValue > 90) {
				contextPercentStr = theme.fg("error", contextPercentDisplay);
			} else if (contextPercentValue > 70) {
				contextPercentStr = theme.fg("warning", contextPercentDisplay);
			} else {
				contextPercentStr = theme.fg("dim", contextPercentDisplay);
			}
			agentLine2Str += dimSep + contextPercentStr;

			if ((contextUsage?.tokens ?? 0) > DUMB_ZONE_THRESHOLD_TOKENS) {
				agentLine2Str += dimSep + theme.fg("error", DUMB_ZONE_LABEL);
			}
			const agentLine2 = truncateToWidth(agentLine2Str, width, theme.fg("dim", "..."));

			// Line 3 (optional): [<cost> · ]<subscription usage segment>
			// Omitted entirely when both parts are absent.
			const subscriptionUsageState = getTlhSubscriptionUsageFooterState(ctx, model, usageOptions);
			const costStr = totals.cost > 0 && !subscriptionUsageState.suppressCost ? formatCost(totals.cost) : undefined;
			const line3Parts: string[] = [];
			if (costStr) line3Parts.push(costStr);
			if (subscriptionUsageState.segment) line3Parts.push(subscriptionUsageState.segment);
			const line3 = line3Parts.length > 0 ? line3Parts.join(" · ") : undefined;

			const lines: string[] = [pwdLine, agentLine2];
			if (line3 !== undefined) {
				lines.push(truncateToWidth(theme.fg("dim", line3), width, theme.fg("dim", "...")));
			}

			// Hint line (conditional on pending editor text during an active turn)
			const editorText = ctx.ui.getEditorText();
			if (editorText.length > 0 && !ctx.isIdle()) {
				const steerKey = keyText("tui.input.submit") || "enter";
				const queueKey = keyText("app.message.followUp") || "alt+enter";
				const steeringHint = `${theme.fg("dim", steerKey)}${theme.fg("muted", " steer")}`;
				const queueHint = `${theme.fg("dim", queueKey)}${theme.fg("muted", " queue follow-up")}`;
				lines.push(truncateToWidth(`${steeringHint}${theme.fg("muted", " · ")}${queueHint}`, width, theme.fg("dim", "...")));
			}

			// Extension status line (conditional on registered extension statuses)
			const extensionStatuses = footerData?.getExtensionStatuses?.();
			if (extensionStatuses && extensionStatuses.size > 0) {
				const statusLine = Array.from(extensionStatuses.entries())
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([, text]) => sanitizeStatusText(text))
					.join(" ");
				lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
			}

			return lines;
		},
		invalidate() {},
		dispose() {
			gitCache?.dispose();
		},
	};
}

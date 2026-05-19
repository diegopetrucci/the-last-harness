import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	keyText,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadonlyFooterDataProvider,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { DUMB_ZONE_LABEL, DUMB_ZONE_THRESHOLD_TOKENS } from "./constants.js";
import { formatHomePath, sanitizeStatusText } from "./common.js";

function formatTokens(count: number): string {
	if (count < 1000) {
		return count.toString();
	}
	if (count < 10000) {
		return `${(count / 1000).toFixed(1)}k`;
	}
	if (count < 1000000) {
		return `${Math.round(count / 1000)}k`;
	}
	if (count < 10000000) {
		return `${(count / 1000000).toFixed(1)}M`;
	}
	return `${Math.round(count / 1000000)}M`;
}

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

export function createTlhFooter(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	theme: Theme,
	getPrimaryName: () => string,
	footerData?: ReadonlyFooterDataProvider,
) {
	return {
		render(width: number): string[] {
			const model = ctx.model;
			const totals = collectUsageTotals(ctx);
			const contextUsage = ctx.getContextUsage();
			const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
			const contextPercentValue = contextUsage?.percent ?? 0;
			const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

			let pwd = formatHomePath(ctx.sessionManager.getCwd());
			const branch = footerData?.getGitBranch?.();
			if (branch) {
				pwd = `${pwd} (${branch})`;
			}
			const sessionName = ctx.sessionManager.getSessionName();
			if (sessionName) {
				pwd = `${pwd} • ${sessionName}`;
			}

			const statsParts: string[] = [];
			const usingSubscription = model ? ctx.modelRegistry.isUsingOAuth(model) : false;
			// In tlh, subscription users should not see dollar-cost estimates in the footer.
			if (totals.cost > 0 && !usingSubscription) {
				statsParts.push(formatCost(totals.cost));
			}

			const contextPercentDisplay =
				contextPercent === "?" ? `?/${formatTokens(contextWindow)}` : `${contextPercent}%/${formatTokens(contextWindow)}`;
			let contextPercentStr: string;
			if (contextPercentValue > 90) {
				contextPercentStr = theme.fg("error", contextPercentDisplay);
			} else if (contextPercentValue > 70) {
				contextPercentStr = theme.fg("warning", contextPercentDisplay);
			} else {
				contextPercentStr = contextPercentDisplay;
			}
			let contextStats = contextPercentStr;
			if ((contextUsage?.tokens ?? 0) > DUMB_ZONE_THRESHOLD_TOKENS) {
				contextStats += `${theme.fg("dim", " • ")}${theme.fg("error", DUMB_ZONE_LABEL)}`;
			}
			statsParts.push(contextStats);

			let statsLeft = statsParts.join(" ");
			let statsLeftWidth = visibleWidth(statsLeft);
			if (statsLeftWidth > width) {
				statsLeft = truncateToWidth(statsLeft, width, "...");
				statsLeftWidth = visibleWidth(statsLeft);
			}

			const modelName = model?.id || "no-model";
			let rightSideWithoutProvider = modelName;
			if (model?.reasoning) {
				const thinkingLevel = getCurrentThinkingLevel(pi);
				rightSideWithoutProvider =
					thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
			}

			const minPadding = 2;
			let rightSide = rightSideWithoutProvider;
			if ((footerData?.getAvailableProviderCount?.() ?? 1) > 1 && model) {
				rightSide = `(${model.provider}) ${rightSideWithoutProvider}`;
				if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
					rightSide = rightSideWithoutProvider;
				}
			}

			const rightSideWidth = visibleWidth(rightSide);
			const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;
			let statsLine: string;
			if (totalNeeded <= width) {
				const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
				statsLine = statsLeft + padding + rightSide;
			} else {
				const availableForRight = width - statsLeftWidth - minPadding;
				if (availableForRight > 0) {
					const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
					const truncatedRightWidth = visibleWidth(truncatedRight);
					const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
					statsLine = statsLeft + padding + truncatedRight;
				} else {
					statsLine = statsLeft;
				}
			}

			const dimStatsLeft = theme.fg("dim", statsLeft);
			const remainder = statsLine.slice(statsLeft.length);
			const dimRemainder = theme.fg("dim", remainder);
			const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
			const agentLine = truncateToWidth(theme.fg("dim", `agent: ${getPrimaryName()}`), width, theme.fg("dim", "..."));
			const lines = [pwdLine, dimStatsLeft + dimRemainder, agentLine];

			const editorText = ctx.ui.getEditorText();
			if (editorText.length > 0 && !ctx.isIdle()) {
				const steerKey = keyText("tui.input.submit") || "enter";
				const queueKey = keyText("app.message.followUp") || "alt+enter";
				const steeringHint = `${theme.fg("dim", steerKey)}${theme.fg("muted", " steer")}`;
				const queueHint = `${theme.fg("dim", queueKey)}${theme.fg("muted", " queue follow-up")}`;
				lines.push(truncateToWidth(`${steeringHint}${theme.fg("muted", " · ")}${queueHint}`, width, theme.fg("dim", "...")));
			}

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
	};
}

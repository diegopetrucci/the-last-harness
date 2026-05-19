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
import type { FooterGitCache } from "./footer-git-cache.js";
import { composeTlhFooterFirstLine } from "./footer-first-line.js";
import type {
	TlhSubscriptionUsageSnapshot,
	TlhSubscriptionUsageSnapshotProvider,
	TlhSubscriptionUsageWindow,
} from "./types.js";

const TLH_SUBSCRIPTION_USAGE_PROVIDERS = new Set(["openai-codex", "anthropic"]);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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

function finiteNumber(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatUsagePercent(percent: number): string {
	const rounded = Math.round(percent * 10) / 10;
	return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatUsageCount(count: number): string {
	const normalized = Math.round(count * 10) / 10;
	return formatTokens(normalized);
}

function formatUsageDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0) {
		return undefined;
	}
	const hours = durationMs / HOUR_MS;
	if (Number.isInteger(hours) && hours < 24) {
		return `${hours}h`;
	}
	const days = durationMs / DAY_MS;
	if (Number.isInteger(days) && days < 14) {
		return `${days}d`;
	}
	return undefined;
}

function normalizedUsageLabel(value: string | undefined): string {
	return value?.trim().toLowerCase().replaceAll("_", "-").replaceAll(" ", "-") ?? "";
}

function formatUsageWindowLabel(
	provider: string,
	window: TlhSubscriptionUsageWindow,
	windowType: "session" | "weekly",
): string {
	if (windowType === "weekly") {
		return "weekly";
	}

	const duration = formatUsageDuration(window.durationMs);
	if (duration) {
		return duration;
	}

	const key = normalizedUsageLabel(window.key);
	const label = normalizedUsageLabel(window.label);
	if (provider === "anthropic" && [key, label].some((value) => ["five-hour", "five-hours", "5h"].includes(value))) {
		return "5h";
	}

	return window.label && window.label !== windowType ? window.label : "session";
}

function formatUsageWindow(
	provider: string,
	window: TlhSubscriptionUsageWindow | undefined,
	windowType: "session" | "weekly",
): string | undefined {
	if (!window) {
		return undefined;
	}

	const label = formatUsageWindowLabel(provider, window, windowType);
	const percent = finiteNumber(window.percent);
	if (percent !== undefined) {
		return `${label} ${formatUsagePercent(percent)}% used`;
	}

	const limit = finiteNumber(window.limit);
	let used = finiteNumber(window.used);
	const remaining = finiteNumber(window.remaining);
	if (used === undefined && limit !== undefined && remaining !== undefined) {
		used = Math.max(0, limit - remaining);
	}
	if (used !== undefined && limit !== undefined && limit > 0) {
		return `${label} ${formatUsageCount(used)}/${formatUsageCount(limit)} used`;
	}

	return undefined;
}

export function formatTlhSubscriptionUsageFooterSegment(
	snapshot: TlhSubscriptionUsageSnapshot | undefined,
	options: { showWeekly?: boolean } = {},
): string | undefined {
	if (!snapshot || !TLH_SUBSCRIPTION_USAGE_PROVIDERS.has(snapshot.provider)) {
		return undefined;
	}

	const sessionSegment = formatUsageWindow(snapshot.provider, snapshot.windows?.session, "session");
	if (!sessionSegment) {
		return undefined;
	}

	const segments = [sessionSegment];
	if (options.showWeekly) {
		const weeklySegment = formatUsageWindow(snapshot.provider, snapshot.windows?.weekly, "weekly");
		if (weeklySegment) {
			segments.push(weeklySegment);
		}
	}
	return segments.join(" · ");
}

function isUsingSubscription(ctx: ExtensionContext, model: ExtensionContext["model"]): boolean {
	if (!model) {
		return false;
	}
	try {
		return ctx.modelRegistry.isUsingOAuth(model);
	} catch {
		return false;
	}
}

function subscriptionUsageSnapshot(
	provider: string | undefined,
	usageProvider: TlhSubscriptionUsageSnapshotProvider | undefined,
): TlhSubscriptionUsageSnapshot | undefined {
	if (!provider || !TLH_SUBSCRIPTION_USAGE_PROVIDERS.has(provider) || !usageProvider) {
		return undefined;
	}
	try {
		const snapshot = usageProvider.getSnapshot(provider);
		return snapshot?.provider === provider ? snapshot : undefined;
	} catch {
		return undefined;
	}
}

function shouldShowWeeklyUsage(shouldShowWeekly: (() => boolean) | undefined): boolean {
	try {
		return shouldShowWeekly?.() === true;
	} catch {
		return false;
	}
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

export type TlhFooterUsageOptions = {
	subscriptionUsage?: TlhSubscriptionUsageSnapshotProvider;
	shouldShowWeekly?: () => boolean;
};

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

			const pwd = composeTlhFooterFirstLine({
				cwd: formatHomePath(ctx.sessionManager.getCwd()),
				sessionName: ctx.sessionManager.getSessionName(),
				status: gitCache?.getStatusSnapshot(),
				pullRequest: gitCache?.getPullRequestSnapshot(),
				fallbackBranch: footerData?.getGitBranch?.(),
			});

			const statsParts: string[] = [];
			const usingSubscription = isUsingSubscription(ctx, model);
			// In tlh, subscription users should not see dollar-cost estimates in the footer.
			if (totals.cost > 0 && !usingSubscription) {
				statsParts.push(formatCost(totals.cost));
			}

			if (usingSubscription) {
				const usageSegment = formatTlhSubscriptionUsageFooterSegment(
					subscriptionUsageSnapshot(model?.provider, usageOptions.subscriptionUsage),
					{ showWeekly: shouldShowWeeklyUsage(usageOptions.shouldShowWeekly) },
				);
				if (usageSegment) {
					statsParts.push(usageSegment);
				}
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
		dispose() {
			gitCache?.dispose();
		},
	};
}

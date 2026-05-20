import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	TlhSubscriptionUsageSnapshot,
	TlhSubscriptionUsageSnapshotProvider,
	TlhSubscriptionUsageWindow,
} from "./types.js";

const TLH_SUBSCRIPTION_USAGE_PROVIDERS = new Set(["openai-codex", "anthropic"]);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type TlhFooterSubscriptionUsageOptions = {
	subscriptionUsage?: TlhSubscriptionUsageSnapshotProvider;
	shouldShowWeekly?: () => boolean;
};

export type TlhSubscriptionUsageFooterState = {
	suppressCost: boolean;
	segment?: string;
};

function formatUsageTokens(count: number): string {
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

function finiteNumber(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatUsagePercent(percent: number): string {
	const rounded = Math.round(percent * 10) / 10;
	return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatUsageCount(count: number): string {
	const normalized = Math.round(count * 10) / 10;
	return formatUsageTokens(normalized);
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

function isSubscriptionUsageEligible(
	ctx: ExtensionContext,
	provider: string | undefined,
	usageProvider: TlhSubscriptionUsageSnapshotProvider | undefined,
): boolean {
	if (!provider || !TLH_SUBSCRIPTION_USAGE_PROVIDERS.has(provider) || typeof usageProvider?.isEligible !== "function") {
		return false;
	}
	try {
		return usageProvider.isEligible(ctx) === true;
	} catch {
		return false;
	}
}

function isModelUsingOAuth(ctx: ExtensionContext, model: ExtensionContext["model"]): boolean {
	if (!model || typeof ctx.modelRegistry?.isUsingOAuth !== "function") {
		return false;
	}
	try {
		return ctx.modelRegistry.isUsingOAuth(model) === true;
	} catch {
		return false;
	}
}

function subscriptionUsageSnapshot(
	ctx: ExtensionContext,
	provider: string | undefined,
	usageProvider: TlhSubscriptionUsageSnapshotProvider | undefined,
): TlhSubscriptionUsageSnapshot | undefined {
	if (!provider || !TLH_SUBSCRIPTION_USAGE_PROVIDERS.has(provider) || !usageProvider) {
		return undefined;
	}
	try {
		const snapshot =
			typeof usageProvider.getSnapshotForContext === "function" ? usageProvider.getSnapshotForContext(ctx) : usageProvider.getSnapshot(provider);
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

export function getTlhSubscriptionUsageFooterState(
	ctx: ExtensionContext,
	model: ExtensionContext["model"],
	options: TlhFooterSubscriptionUsageOptions = {},
): TlhSubscriptionUsageFooterState {
	const provider = model?.provider;
	const subscriptionEligible = isSubscriptionUsageEligible(ctx, provider, options.subscriptionUsage);
	const usingOAuth = isModelUsingOAuth(ctx, model);
	const segment = subscriptionEligible
		? formatTlhSubscriptionUsageFooterSegment(subscriptionUsageSnapshot(ctx, provider, options.subscriptionUsage), {
				showWeekly: shouldShowWeeklyUsage(options.shouldShowWeekly),
			})
		: undefined;

	return {
		suppressCost: subscriptionEligible || usingOAuth,
		...(segment ? { segment } : {}),
	};
}

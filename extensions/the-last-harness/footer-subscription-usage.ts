import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatCompactTokenCount } from "./common.js";
import type {
	TlhSubscriptionUsageSnapshot,
	TlhSubscriptionUsageSnapshotProvider,
	TlhSubscriptionUsageWindow,
} from "./types.js";

const TLH_SUBSCRIPTION_USAGE_PROVIDERS = new Set(["openai-codex", "anthropic"]);
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export type TlhFooterSubscriptionUsageOptions = {
	subscriptionUsage?: TlhSubscriptionUsageSnapshotProvider;
	shouldShowWeekly?: () => boolean | undefined;
	nowMs?: number;
};

export type TlhSubscriptionUsageFooterState = {
	suppressCost: boolean;
	segment?: string;
};

function finiteNumber(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatUsagePercent(percent: number): string {
	const rounded = Math.round(percent * 10) / 10;
	return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatUsageCount(count: number): string {
	const normalized = Math.round(count * 10) / 10;
	return formatCompactTokenCount(normalized);
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

function formatResetCountdown(
	resetsAt: string | undefined,
	nowMs: number,
	windowType: "session" | "weekly",
): string | undefined {
	if (!resetsAt) {
		return undefined;
	}
	const resetMs = Date.parse(resetsAt);
	if (!Number.isFinite(resetMs)) {
		return undefined;
	}
	const deltaMs = resetMs - nowMs;
	if (deltaMs <= 0) {
		return undefined;
	}
	const totalMinutes = Math.floor(deltaMs / MINUTE_MS);
	const totalHours = Math.floor(deltaMs / HOUR_MS);
	const totalDays = Math.floor(deltaMs / DAY_MS);
	if (windowType === "weekly" && totalDays >= 1) {
		const remainingHours = Math.floor((deltaMs - totalDays * DAY_MS) / HOUR_MS);
		return `${totalDays}d ${remainingHours}h`;
	}
	// Session-style format (also used as weekly fallback when delta < 1 day)
	if (totalMinutes < 1) {
		return "<1m";
	}
	if (totalHours < 1) {
		return `${totalMinutes}m`;
	}
	const remainingMinutes = totalMinutes - totalHours * 60;
	return `${totalHours}h${remainingMinutes}m`;
}

function normalizedUsageLabel(value: string | undefined): string {
	return value?.trim().toLowerCase().replaceAll("_", "-").replaceAll(" ", "-") ?? "";
}

function formatUsageWindowPresentation(
	window: TlhSubscriptionUsageWindow,
	windowType: "session" | "weekly",
): "session" | "weekly" {
	return window.durationMs === WEEK_MS ? "weekly" : windowType;
}

function formatUsageWindowLabel(
	provider: string,
	window: TlhSubscriptionUsageWindow,
	windowType: "session" | "weekly",
): string {
	const presentation = formatUsageWindowPresentation(window, windowType);
	if (presentation === "weekly") {
		return "weekly";
	}

	const duration = formatUsageDuration(window.durationMs);
	if (duration) {
		return `${duration} session`;
	}

	const key = normalizedUsageLabel(window.key);
	const label = normalizedUsageLabel(window.label);
	if (provider === "anthropic" && [key, label].some((value) => ["five-hour", "five-hours", "5h"].includes(value))) {
		return "5h session";
	}

	return "session";
}

function formatUsageWindow(
	provider: string,
	window: TlhSubscriptionUsageWindow | undefined,
	windowType: "session" | "weekly",
	nowMs: number,
): string | undefined {
	if (!window) {
		return undefined;
	}

	const presentation = formatUsageWindowPresentation(window, windowType);
	const label = formatUsageWindowLabel(provider, window, windowType);
	const percent = finiteNumber(window.percent);

	let base: string | undefined;
	if (percent !== undefined) {
		base = `${label} ${formatUsagePercent(percent)}% used`;
	} else {
		const limit = finiteNumber(window.limit);
		let used = finiteNumber(window.used);
		const remaining = finiteNumber(window.remaining);
		if (used === undefined && limit !== undefined && remaining !== undefined) {
			used = Math.max(0, limit - remaining);
		}
		if (used !== undefined && limit !== undefined && limit > 0) {
			base = `${label} ${formatUsageCount(used)}/${formatUsageCount(limit)} used`;
		}
	}

	if (!base) {
		return undefined;
	}

	const countdown = formatResetCountdown(window.resetsAt, nowMs, presentation);
	return countdown ? `${base}, resets in ${countdown}` : base;
}

export function formatTlhSubscriptionUsageFooterSegment(
	snapshot: TlhSubscriptionUsageSnapshot | undefined,
	options: { showWeekly?: boolean; nowMs?: number } = {},
): string | undefined {
	if (!snapshot || !TLH_SUBSCRIPTION_USAGE_PROVIDERS.has(snapshot.provider)) {
		return undefined;
	}

	const nowMs = options.nowMs ?? Date.now();
	const sessionSegment = formatUsageWindow(snapshot.provider, snapshot.windows?.session, "session", nowMs);
	if (!sessionSegment) {
		return undefined;
	}

	const segments = [sessionSegment];
	if (options.showWeekly) {
		const weeklySegment = formatUsageWindow(snapshot.provider, snapshot.windows?.weekly, "weekly", nowMs);
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
			typeof usageProvider.getSnapshotForContext === "function"
				? usageProvider.getSnapshotForContext(ctx)
				: usageProvider.getSnapshot(provider);
		return snapshot?.provider === provider ? snapshot : undefined;
	} catch {
		return undefined;
	}
}

function getWeeklyVisibilityPreference(shouldShowWeekly: (() => boolean | undefined) | undefined): boolean | undefined {
	try {
		const value = shouldShowWeekly?.();
		return value === undefined ? undefined : value === true;
	} catch {
		return undefined;
	}
}

function deriveWeeklyRemainingPercent(window: TlhSubscriptionUsageWindow | undefined): number | undefined {
	if (!window) {
		return undefined;
	}

	const percentUsed = finiteNumber(window.percent);
	if (percentUsed !== undefined) {
		return Math.max(0, Math.min(100, 100 - percentUsed));
	}

	const remaining = finiteNumber(window.remaining);
	const limit = finiteNumber(window.limit);
	if (remaining !== undefined && limit !== undefined && limit > 0) {
		return Math.max(0, Math.min(100, (remaining / limit) * 100));
	}

	return undefined;
}

function shouldAutoShowWeeklyUsage(snapshot: TlhSubscriptionUsageSnapshot | undefined): boolean {
	const remainingPercent = deriveWeeklyRemainingPercent(snapshot?.windows?.weekly);
	return remainingPercent !== undefined && remainingPercent < 25;
}

export function getTlhSubscriptionUsageFooterState(
	ctx: ExtensionContext,
	model: ExtensionContext["model"],
	options: TlhFooterSubscriptionUsageOptions = {},
): TlhSubscriptionUsageFooterState {
	const provider = model?.provider;
	const subscriptionEligible = isSubscriptionUsageEligible(ctx, provider, options.subscriptionUsage);
	const usingOAuth = isModelUsingOAuth(ctx, model);
	const snapshot = subscriptionEligible
		? subscriptionUsageSnapshot(ctx, provider, options.subscriptionUsage)
		: undefined;
	const weeklyVisibilityPreference = getWeeklyVisibilityPreference(options.shouldShowWeekly);
	const segment = subscriptionEligible
		? formatTlhSubscriptionUsageFooterSegment(snapshot, {
				showWeekly: weeklyVisibilityPreference ?? shouldAutoShowWeeklyUsage(snapshot),
				nowMs: options.nowMs,
			})
		: undefined;

	return {
		suppressCost: subscriptionEligible || usingOAuth,
		...(segment ? { segment } : {}),
	};
}

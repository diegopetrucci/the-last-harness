import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

import { createTlhSubscriptionUsageService } from "../extensions/the-last-harness/subscription-usage.ts";
import { DEFAULT_PRIMARY_AGENT } from "../extensions/the-last-harness-primary-agent.mjs";

const jiti = createJiti(import.meta.url);
const { createTlhFooter, formatTlhSubscriptionUsageFooterSegment } = await jiti.import(
	"../extensions/the-last-harness/footer.ts",
);

const NOW_MS = Date.parse("2026-05-19T19:00:00Z");
const WIDTH = 100;

const theme = {
	fg: (_color, text) => text,
};

const pi = {
	getThinkingLevel: () => "medium",
};

function createFooterData(options = {}) {
	return {
		getGitBranch: () => options.branch,
		getAvailableProviderCount: () => options.providerCount ?? 1,
		getExtensionStatuses: () => new Map(),
	};
}

function usageProvider(snapshot, onGetSnapshot, eligible = true) {
	return {
		getSnapshot(provider) {
			onGetSnapshot?.(provider);
			return eligible ? snapshot : undefined;
		},
		getSnapshotForContext(ctx) {
			onGetSnapshot?.(ctx?.model?.provider);
			return eligible ? snapshot : undefined;
		},
		isEligible() {
			return eligible;
		},
	};
}

function openAiSnapshot(weekly = { percent: 21.5 }) {
	return {
		provider: "openai-codex",
		fetchedAt: NOW_MS,
		windows: {
			session: { key: "primary_window", label: "session", percent: 42 },
			weekly: { key: "secondary_window", label: "weekly", ...weekly },
		},
	};
}

function anthropicSnapshot(weekly = { percent: 88.9 }) {
	return {
		provider: "anthropic",
		fetchedAt: NOW_MS,
		windows: {
			session: { key: "five_hour", label: "session", percent: 42 },
			weekly: { key: "seven_day", label: "weekly", ...weekly },
		},
	};
}

function assistantCostEntry(cost) {
	return {
		type: "message",
		message: {
			role: "assistant",
			usage: { cost: { total: cost } },
		},
	};
}

function createCtx(options = {}) {
	const provider = options.provider ?? "anthropic";
	return {
		hasUI: true,
		cwd: "/tmp/the-last-harness",
		model: options.model ?? {
			provider,
			id: options.modelId ?? (provider === "openai-codex" ? "gpt-5-codex" : "claude-sonnet-4-20250514"),
			contextWindow: 200000,
		},
		modelRegistry: {
			isUsingOAuth() {
				if (options.throwOAuth) {
					throw new Error("oauth state unavailable");
				}
				return options.usingOAuth ?? true;
			},
			authStorage: options.authStorage,
		},
		sessionManager: {
			getEntries: () => options.entries ?? [assistantCostEntry(1.25)],
			getCwd: () => "/tmp/the-last-harness",
			getSessionName: () => options.sessionName,
		},
		getContextUsage: () => options.contextUsage ?? { tokens: 1000, contextWindow: 200000, percent: 12.3 },
		ui: {
			getEditorText: () => options.editorText ?? "",
		},
		isIdle: () => options.idle ?? true,
	};
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function renderFooterLines(ctx, usageOptions, width = WIDTH, footerData = createFooterData()) {
	const footer = createTlhFooter(pi, ctx, theme, () => "architect", footerData, usageOptions);
	return footer.render(width);
}

/**
 * Line 2 (index 1): agent: <name> • [(provider)] <model> [• thinking] • context%
 */
function renderAgentLine(ctx, usageOptions, width = WIDTH, footerData = createFooterData()) {
	return renderFooterLines(ctx, usageOptions, width, footerData)[1] ?? "";
}

/**
 * Line 3 (index 2, optional): [<cost> · ]<subscription usage segment>
 * Returns "" when Line 3 is omitted.
 */
function renderSessionStatsLine(ctx, usageOptions, width = WIDTH, footerData = createFooterData()) {
	return renderFooterLines(ctx, usageOptions, width, footerData)[2] ?? "";
}

// ---------------------------------------------------------------------------
// Existing rendering tests (updated for three-line layout)
// ---------------------------------------------------------------------------

test("footer renders OpenAI/Codex session usage and hides weekly by default", () => {
	let requestedProvider;
	const usageOptions = {
		subscriptionUsage: usageProvider(openAiSnapshot(), (provider) => {
			requestedProvider = provider;
		}),
		shouldShowWeekly: () => false,
	};
	const ctx = createCtx({ provider: "openai-codex" });
	const lines = renderFooterLines(ctx, usageOptions);
	const agentLine = lines[1] ?? "";
	const sessionLine = lines[2] ?? "";

	assert.equal(requestedProvider, "openai-codex");
	assert.match(sessionLine, /session 42% used/);
	assert.doesNotMatch(sessionLine, /weekly/);
	assert.doesNotMatch(sessionLine, /\$/);
	assert.match(agentLine, /12\.3%\/200k/);
});

test("footer includes Anthropic weekly usage only when the preference enables it", () => {
	const snapshot = anthropicSnapshot();
	assert.equal(formatTlhSubscriptionUsageFooterSegment(snapshot, { showWeekly: false }), "5h session 42% used");
	assert.equal(formatTlhSubscriptionUsageFooterSegment(snapshot, { showWeekly: true }), "5h session 42% used · weekly 88.9% used");

	const ctx = createCtx({ provider: "anthropic" });
	const usageOptions = {
		subscriptionUsage: usageProvider(snapshot),
		shouldShowWeekly: () => true,
	};
	const sessionLine = renderSessionStatsLine(ctx, usageOptions);

	assert.match(sessionLine, /5h session 42% used/);
	assert.match(sessionLine, /weekly 88\.9% used/);
});


test("footer auto-shows weekly by default only below 25% remaining", () => {
	const ctx = createCtx({ provider: "openai-codex" });
	const belowThresholdLine = renderSessionStatsLine(ctx, {
		subscriptionUsage: usageProvider(openAiSnapshot({ percent: 80 })),
		shouldShowWeekly: () => undefined,
	});
	const atThresholdLine = renderSessionStatsLine(ctx, {
		subscriptionUsage: usageProvider(openAiSnapshot({ percent: 75 })),
		shouldShowWeekly: () => undefined,
	});
	const aboveThresholdLine = renderSessionStatsLine(ctx, {
		subscriptionUsage: usageProvider(openAiSnapshot({ percent: 74.9 })),
		shouldShowWeekly: () => undefined,
	});

	assert.match(belowThresholdLine, /weekly 80% used/);
	assert.doesNotMatch(atThresholdLine, /weekly/);
	assert.doesNotMatch(aboveThresholdLine, /weekly/);
});


test("footer auto-show prefers explicit weekly percent over conflicting counts", () => {
	const ctx = createCtx({ provider: "openai-codex" });
	const sessionLine = renderSessionStatsLine(ctx, {
		subscriptionUsage: usageProvider(openAiSnapshot({ percent: 80, used: 10, limit: 100, remaining: 90 })),
		shouldShowWeekly: () => undefined,
	});

	assert.match(sessionLine, /weekly 80% used/);
});


test("footer auto-show derives weekly remaining from counts when percent is absent", () => {
	const ctx = createCtx({ provider: "openai-codex" });
	const sessionLine = renderSessionStatsLine(ctx, {
		subscriptionUsage: usageProvider(openAiSnapshot({ used: 90, limit: 100, remaining: 10, percent: undefined })),
		shouldShowWeekly: () => undefined,
	});

	assert.match(sessionLine, /weekly 90\/100 used/);
});


test("footer explicit weekly on always shows weekly even above the default threshold", () => {
	const ctx = createCtx({ provider: "openai-codex" });
	const sessionLine = renderSessionStatsLine(ctx, {
		subscriptionUsage: usageProvider(openAiSnapshot({ percent: 21.5 })),
		shouldShowWeekly: () => true,
	});

	assert.match(sessionLine, /weekly 21\.5% used/);
});


test("footer explicit weekly off hides weekly even below the default threshold", () => {
	const ctx = createCtx({ provider: "openai-codex" });
	const sessionLine = renderSessionStatsLine(ctx, {
		subscriptionUsage: usageProvider(openAiSnapshot({ percent: 80 })),
		shouldShowWeekly: () => false,
	});

	assert.doesNotMatch(sessionLine, /weekly/);
});

test("footer context and subscription usage keep compact token formatting", () => {
	const snapshot = {
		provider: "openai-codex",
		fetchedAt: NOW_MS,
		windows: {
			session: { key: "primary_window", label: "session", used: 1500, limit: 9999 },
		},
	};
	const ctx = createCtx({
		provider: "openai-codex",
		contextUsage: { tokens: 1000, contextWindow: 9999, percent: 12.3 },
	});
	const usageOptions = {
		subscriptionUsage: usageProvider(snapshot),
		shouldShowWeekly: () => false,
	};

	assert.match(renderAgentLine(ctx, usageOptions), /12\.3%\/10\.0k/);
	assert.equal(formatTlhSubscriptionUsageFooterSegment(snapshot), "session 1.5k/10.0k used");
	assert.match(renderSessionStatsLine(ctx, usageOptions), /session 1\.5k\/10\.0k used/);
});

test("footer render reads cached usage snapshots without refreshing", () => {
	let refreshCalls = 0;
	const subscriptionUsage = {
		getSnapshot: () => openAiSnapshot(),
		getSnapshotForContext: () => openAiSnapshot(),
		isEligible: () => true,
		refresh: async () => {
			refreshCalls += 1;
			throw new Error("render must not refresh usage");
		},
	};

	const sessionLine = renderSessionStatsLine(createCtx({ provider: "openai-codex" }), {
		subscriptionUsage,
		shouldShowWeekly: () => false,
	});

	assert.match(sessionLine, /session 42% used/);
	assert.equal(refreshCalls, 0);
});

test("footer falls back to dollar cost when subscription usage is not strictly eligible", () => {
	// Non-OAuth Anthropic session (e.g. API-key user): no subscription tracking and no OAuth gate,
	// so the dollar fallback must remain visible.
	const ctx = createCtx({ provider: "anthropic", usingOAuth: false });
	const usageOptions = {
		subscriptionUsage: usageProvider(anthropicSnapshot(), undefined, false),
		shouldShowWeekly: () => true,
	};
	const agentLine = renderAgentLine(ctx, usageOptions);
	const sessionLine = renderSessionStatsLine(ctx, usageOptions);

	assert.match(sessionLine, /\$1\.250/);
	assert.doesNotMatch(sessionLine, /5h session 42% used/);
	assert.match(agentLine, /12\.3%\/200k/);
});

test("footer suppresses dollar cost for eligible OAuth sessions before usage is cached", () => {
	let fetchCalls = 0;
	const runtimeOverrides = new Map();
	const credential = { type: "oauth", access: "unused-oauth-access-token", expires: NOW_MS + 60_000 };
	const ctx = createCtx({
		provider: "anthropic",
		authStorage: {
			runtimeOverrides,
			get: (provider) => (provider === "anthropic" ? credential : undefined),
		},
	});
	const service = createTlhSubscriptionUsageService({
		fetch: async () => {
			fetchCalls += 1;
			throw new Error("render must not refresh usage");
		},
	});

	const usageOptions = {
		subscriptionUsage: service,
		shouldShowWeekly: () => true,
	};

	const lines = renderFooterLines(ctx, usageOptions);
	const agentLine = lines[1] ?? "";
	const sessionLine = lines[2] ?? "";

	assert.doesNotMatch(agentLine, /\$/);
	assert.doesNotMatch(agentLine, /used/);
	assert.match(agentLine, /12\.3%\/200k/);
	// Line 3 is omitted: cost suppressed (OAuth), no subscription segment yet
	assert.equal(sessionLine, "");
	assert.equal(fetchCalls, 0);

	runtimeOverrides.set("anthropic", "runtime-api-key");
	const runtimeLines = renderFooterLines(ctx, usageOptions);
	const runtimeAgentLine = runtimeLines[1] ?? "";
	const runtimeSessionLine = runtimeLines[2] ?? "";

	// The runtime override disables the subscription-usage panel, but the stored Anthropic
	// credential is still OAuth so isUsingOAuth(model) remains true and the dollar fallback
	// stays suppressed.
	assert.doesNotMatch(runtimeAgentLine, /\$/);
	assert.doesNotMatch(runtimeAgentLine, /used/);
	assert.equal(runtimeSessionLine, "");
	assert.equal(fetchCalls, 0);
});

test("footer leaves usage unchanged for unsupported providers and snapshot errors", () => {
	// API-key user on an unsupported provider: cost should still render as the fallback.
	const unsupportedCtx = createCtx({ provider: "openrouter", usingOAuth: false });
	const unsupportedUsage = {
		subscriptionUsage: usageProvider(openAiSnapshot()),
		shouldShowWeekly: () => true,
	};
	const unsupportedAgentLine = renderAgentLine(unsupportedCtx, unsupportedUsage);
	const unsupportedSessionLine = renderSessionStatsLine(unsupportedCtx, unsupportedUsage);

	assert.doesNotMatch(unsupportedSessionLine, /used/);
	assert.doesNotMatch(unsupportedSessionLine, /weekly/);
	assert.match(unsupportedSessionLine, /\$1\.250/);
	assert.match(unsupportedAgentLine, /12\.3%\/200k/);

	const errorCtx = createCtx({ provider: "anthropic" });
	const errorUsage = {
		subscriptionUsage: {
			getSnapshot() {
				throw new Error("cached usage unavailable");
			},
			getSnapshotForContext() {
				throw new Error("cached usage unavailable");
			},
			isEligible() {
				return true;
			},
		},
		shouldShowWeekly: () => true,
	};
	const errorAgentLine = renderAgentLine(errorCtx, errorUsage);
	const errorSessionLine = renderSessionStatsLine(errorCtx, errorUsage);

	assert.doesNotMatch(errorSessionLine, /used/);
	assert.doesNotMatch(errorSessionLine, /weekly/);
	assert.doesNotMatch(errorSessionLine, /\$/);
	assert.match(errorAgentLine, /12\.3%\/200k/);
});

test("footer suppresses dollar cost for OAuth users on unsupported providers", () => {
	const ctx = createCtx({ provider: "github-copilot", usingOAuth: true });
	const usageOptions = {
		subscriptionUsage: usageProvider(openAiSnapshot(), undefined, false),
		shouldShowWeekly: () => true,
	};
	const agentLine = renderAgentLine(ctx, usageOptions);
	const sessionLine = renderSessionStatsLine(ctx, usageOptions);

	assert.doesNotMatch(sessionLine, /\$/);
	assert.doesNotMatch(sessionLine, /used/);
	assert.match(agentLine, /12\.3%\/200k/);
});

test("footer shows dollar cost when neither OAuth nor subscription-eligible", () => {
	const ctx = createCtx({ provider: "openrouter", usingOAuth: false });
	const usageOptions = {
		subscriptionUsage: usageProvider(openAiSnapshot(), undefined, false),
		shouldShowWeekly: () => true,
	};
	const agentLine = renderAgentLine(ctx, usageOptions);
	const sessionLine = renderSessionStatsLine(ctx, usageOptions);

	assert.match(sessionLine, /\$1\.250/);
	assert.doesNotMatch(sessionLine, /used/);
	assert.match(agentLine, /12\.3%\/200k/);
});

test("usage footer stays within narrow terminal widths", () => {
	const ctx = createCtx({
		provider: "anthropic",
		modelId: "claude-sonnet-4-20250514-with-a-very-long-display-name",
	});
	const footer = createTlhFooter(pi, ctx, theme, () => "architect", createFooterData({ providerCount: 2 }), {
		subscriptionUsage: usageProvider(anthropicSnapshot()),
		shouldShowWeekly: () => true,
	});

	const width = 24;
	const lines = footer.render(width);
	assert.ok(lines.every((line) => visibleWidth(line) <= width));
	// Agent line (index 1) is truncated due to the long model name
	assert.match(lines[1], /\.\.\./);
	// Session stats line (index 2) starts with the subscription segment
	assert.match(lines[2], /^5h session 42% used/);
});

// ---------------------------------------------------------------------------
// NEW: focused line-2 composition tests
// ---------------------------------------------------------------------------

test("line 2 shows model without provider prefix when single provider", () => {
	const line = renderAgentLine(createCtx({ provider: "anthropic" }), {});
	assert.match(line, /^agent: architect • claude-sonnet-4-20250514 • /);
	assert.doesNotMatch(line, /\(anthropic\)/);
});

test("line 2 never shows provider prefix even when multiple providers are available", () => {
	const line = renderAgentLine(createCtx({ provider: "anthropic" }), {}, WIDTH, createFooterData({ providerCount: 2 }));
	assert.match(line, /^agent: architect • claude-sonnet-4-20250514 • /);
	assert.doesNotMatch(line, /\(anthropic\)/);
});

test("line 2 shows thinking level for reasoning models", () => {
	const ctx = createCtx({
		model: { provider: "anthropic", id: "claude-opus-4-reasoning", contextWindow: 200000, reasoning: true },
	});
	const line = renderAgentLine(ctx, {});
	assert.match(line, /claude-opus-4-reasoning • medium • /);
});

test("line 2 shows thinking off label when thinking is disabled on a reasoning model", () => {
	const piOff = { getThinkingLevel: () => "off" };
	const ctx = createCtx({
		model: { provider: "anthropic", id: "claude-opus-4-reasoning", contextWindow: 200000, reasoning: true },
	});
	const footer = createTlhFooter(piOff, ctx, theme, () => "architect", createFooterData(), {});
	const line = footer.render(WIDTH)[1];
	assert.match(line, /claude-opus-4-reasoning • thinking off • /);
});

test("line 2 shows no-model placeholder when context has no model", () => {
	const ctx = { ...createCtx(), model: undefined };
	const line = renderAgentLine(ctx, {});
	assert.match(line, /^agent: architect • no-model • /);
	assert.doesNotMatch(line, /\(undefined\)/);
});

test("line 2 includes context percent and omits provider prefix for no-model", () => {
	const ctx = { ...createCtx(), model: undefined };
	const line = renderAgentLine(ctx, {});
	assert.match(line, /12\.3%\/200k/);
	assert.doesNotMatch(line, /\(/);
});

// ---------------------------------------------------------------------------
// NEW: focused line-3 rendered omission and presence tests
// ---------------------------------------------------------------------------

test("line 3 is omitted when cost is zero and there is no subscription segment", () => {
	const ctx = createCtx({ entries: [], usingOAuth: false });
	const lines = renderFooterLines(ctx, {
		subscriptionUsage: usageProvider(openAiSnapshot(), undefined, false),
		shouldShowWeekly: () => false,
	});
	// Only pwd (index 0) and agent line (index 1) — no stats line
	assert.equal(lines.length, 2);
});

test("line 3 renders cost only when cost is present and subscription is absent", () => {
	const ctx = createCtx({ provider: "openrouter", usingOAuth: false });
	const sessionLine = renderSessionStatsLine(ctx, {
		subscriptionUsage: usageProvider(undefined, undefined, false),
		shouldShowWeekly: () => false,
	});
	assert.match(sessionLine, /^\$1\.250$/);
	assert.doesNotMatch(sessionLine, /·/);
});

test("line 3 renders subscription only when cost is suppressed and segment is present", () => {
	const ctx = createCtx({ provider: "anthropic" }); // usingOAuth: true → suppressCost
	const sessionLine = renderSessionStatsLine(ctx, {
		subscriptionUsage: usageProvider(anthropicSnapshot()),
		shouldShowWeekly: () => false,
	});
	assert.match(sessionLine, /^5h session 42% used$/);
	assert.doesNotMatch(sessionLine, /\$/);
});

// ---------------------------------------------------------------------------
// NEW: reset countdown in subscription usage footer segment
// ---------------------------------------------------------------------------

// Helper: build a minimal Anthropic snapshot with explicit window fields.
function anthropicSnapshotWithResets({ sessionResetsAt, weeklyResetsAt } = {}) {
	return {
		provider: "anthropic",
		fetchedAt: NOW_MS,
		windows: {
			session: { key: "five_hour", label: "session", percent: 42, ...(sessionResetsAt ? { resetsAt: sessionResetsAt } : {}) },
			weekly: { key: "seven_day", label: "weekly", percent: 88.9, ...(weeklyResetsAt ? { resetsAt: weeklyResetsAt } : {}) },
		},
	};
}

test("reset countdown: session 2h13m future appends ', resets in 2h13m'", () => {
	// 2026-05-19T19:00:00Z + 2h13m = 2026-05-19T21:13:00Z
	const snapshot = anthropicSnapshotWithResets({ sessionResetsAt: "2026-05-19T21:13:00.000Z" });
	const result = formatTlhSubscriptionUsageFooterSegment(snapshot, { nowMs: NOW_MS });
	assert.equal(result, "5h session 42% used, resets in 2h13m");
});

test("reset countdown: session 47m future appends ', resets in 47m'", () => {
	// 2026-05-19T19:00:00Z + 47m = 2026-05-19T19:47:00Z
	const snapshot = anthropicSnapshotWithResets({ sessionResetsAt: "2026-05-19T19:47:00.000Z" });
	const result = formatTlhSubscriptionUsageFooterSegment(snapshot, { nowMs: NOW_MS });
	assert.equal(result, "5h session 42% used, resets in 47m");
});

test("reset countdown: session 30s future appends ', resets in <1m'", () => {
	// 2026-05-19T19:00:00Z + 30s = 2026-05-19T19:00:30Z
	const snapshot = anthropicSnapshotWithResets({ sessionResetsAt: "2026-05-19T19:00:30.000Z" });
	const result = formatTlhSubscriptionUsageFooterSegment(snapshot, { nowMs: NOW_MS });
	assert.equal(result, "5h session 42% used, resets in <1m");
});

test("reset countdown: session resetsAt in the past produces no suffix", () => {
	// 2026-05-19T18:00:00Z is 1h before NOW_MS
	const snapshot = anthropicSnapshotWithResets({ sessionResetsAt: "2026-05-19T18:00:00.000Z" });
	const result = formatTlhSubscriptionUsageFooterSegment(snapshot, { nowMs: NOW_MS });
	assert.equal(result, "5h session 42% used");
});

test("reset countdown: session with no resetsAt produces no suffix", () => {
	const snapshot = anthropicSnapshotWithResets();
	const result = formatTlhSubscriptionUsageFooterSegment(snapshot, { nowMs: NOW_MS });
	assert.equal(result, "5h session 42% used");
});

test("reset countdown: session with unparseable resetsAt produces no suffix", () => {
	const snapshot = anthropicSnapshotWithResets({ sessionResetsAt: "not-a-date" });
	const result = formatTlhSubscriptionUsageFooterSegment(snapshot, { nowMs: NOW_MS });
	assert.equal(result, "5h session 42% used");
});

test("reset countdown: weekly 4d 6h future appends ', resets in 4d 6h'", () => {
	// 2026-05-19T19:00:00Z + 4d + 6h = 2026-05-24T01:00:00Z
	const snapshot = anthropicSnapshotWithResets({
		sessionResetsAt: "2026-05-19T21:13:00.000Z",
		weeklyResetsAt: "2026-05-24T01:00:00.000Z",
	});
	const result = formatTlhSubscriptionUsageFooterSegment(snapshot, { showWeekly: true, nowMs: NOW_MS });
	assert.equal(result, "5h session 42% used, resets in 2h13m · weekly 88.9% used, resets in 4d 6h");
});

test("reset countdown: weekly <1d (5h) falls back to session-style format '5h0m'", () => {
	// 2026-05-19T19:00:00Z + 5h = 2026-05-20T00:00:00Z
	const snapshot = anthropicSnapshotWithResets({
		weeklyResetsAt: "2026-05-20T00:00:00.000Z",
	});
	const result = formatTlhSubscriptionUsageFooterSegment(snapshot, { showWeekly: true, nowMs: NOW_MS });
	assert.equal(result, "5h session 42% used · weekly 88.9% used, resets in 5h0m");
});

test("reset countdown: session exactly 60s future appends ', resets in 1m' (boundary <1m→Mm)", () => {
	const resetsAt = new Date(NOW_MS + 60 * 1000).toISOString();
	const snapshot = anthropicSnapshotWithResets({ sessionResetsAt: resetsAt });
	const result = formatTlhSubscriptionUsageFooterSegment(snapshot, { nowMs: NOW_MS });
	assert.equal(result, "5h session 42% used, resets in 1m");
});

test("reset countdown: session exactly 1h future appends ', resets in 1h0m' (boundary Mm→XhYm, trailing 0m)", () => {
	const resetsAt = new Date(NOW_MS + 60 * 60 * 1000).toISOString();
	const snapshot = anthropicSnapshotWithResets({ sessionResetsAt: resetsAt });
	const result = formatTlhSubscriptionUsageFooterSegment(snapshot, { nowMs: NOW_MS });
	assert.equal(result, "5h session 42% used, resets in 1h0m");
});

test("reset countdown: weekly exactly 24h future appends ', resets in 1d 0h' (Xd Yh boundary, remainingHours=0)", () => {
	const weeklyResetsAt = new Date(NOW_MS + 24 * 60 * 60 * 1000).toISOString();
	const snapshot = anthropicSnapshotWithResets({ weeklyResetsAt });
	const result = formatTlhSubscriptionUsageFooterSegment(snapshot, { showWeekly: true, nowMs: NOW_MS });
	assert.equal(result, "5h session 42% used · weekly 88.9% used, resets in 1d 0h");
});

test("reset countdown: weekly exactly 25h future appends ', resets in 1d 1h' (day count and remainder)", () => {
	const weeklyResetsAt = new Date(NOW_MS + 25 * 60 * 60 * 1000).toISOString();
	const snapshot = anthropicSnapshotWithResets({ weeklyResetsAt });
	const result = formatTlhSubscriptionUsageFooterSegment(snapshot, { showWeekly: true, nowMs: NOW_MS });
	assert.equal(result, "5h session 42% used · weekly 88.9% used, resets in 1d 1h");
});

test("reset countdown: session+weekly segment joiner is intact when both have countdowns", () => {
	// Session: 2h13m future, weekly: 4d 6h future
	// Expected: "5h session 42% used, resets in 2h13m · weekly 88.9% used, resets in 4d 6h"
	// The single " · " between the two window segments is the inter-segment joiner.
	const snapshot = anthropicSnapshotWithResets({
		sessionResetsAt: "2026-05-19T21:13:00.000Z",
		weeklyResetsAt: "2026-05-24T01:00:00.000Z",
	});
	const result = formatTlhSubscriptionUsageFooterSegment(snapshot, { showWeekly: true, nowMs: NOW_MS });
	// Full string assertion
	assert.equal(result, "5h session 42% used, resets in 2h13m · weekly 88.9% used, resets in 4d 6h");
	// Splitting on " · " (the inter-segment joiner) yields exactly two window segments
	const parts = result?.split(" · ");
	assert.equal(parts?.length, 2);
	assert.equal(parts?.[0], "5h session 42% used, resets in 2h13m");
	assert.equal(parts?.[1], "weekly 88.9% used, resets in 4d 6h");
});

// ---------------------------------------------------------------------------
// NEW: per-segment color tests for line 2 (color-aware theme stub)
// ---------------------------------------------------------------------------

// Color-aware theme: wraps each segment in XML-style tags so assertions can
// check which color each piece of text was rendered with.
const colorTheme = {
	fg: (color, text) => `<${color}>${text}</${color}>`,
};
// Use a generous width so truncateToWidth never truncates the color-tagged line.
// The XML tags are counted as visible characters, so a standard 100-char width
// would truncate the line before all segments are visible.
const COLOR_WIDTH = 1000;

test("line 2 (color-aware): architect name renders with dim, not accent", () => {
	const ctx = createCtx({ provider: "anthropic" });
	const footer = createTlhFooter(pi, ctx, colorTheme, () => "architect", createFooterData(), {});
	const line = footer.render(COLOR_WIDTH)[1] ?? "";

	// Name must appear inside <dim>, not <accent>
	assert.match(line, /<dim>architect<\/dim>/);
	assert.doesNotMatch(line, /<accent>architect<\/accent>/);
	// Surrounding structure must also carry dim
	assert.match(line, /<dim>agent: <\/dim>/);
	assert.match(line, /<dim> \u2022 <\/dim>/);
	assert.match(line, /<dim>claude-sonnet-4-20250514<\/dim>/);
});

test("line 2 (color-aware): rush name renders with accent, not dim", () => {
	const ctx = createCtx({ provider: "anthropic" });
	const footer = createTlhFooter(pi, ctx, colorTheme, () => "rush", createFooterData(), {});
	const line = footer.render(COLOR_WIDTH)[1] ?? "";

	// Name must appear inside <accent>
	assert.match(line, /<accent>rush<\/accent>/);
	assert.doesNotMatch(line, /<dim>rush<\/dim>/);
	// Surrounding label and separators must remain dim
	assert.match(line, /<dim>agent: <\/dim>/);
	assert.match(line, /<dim> \u2022 <\/dim>/);
	assert.match(line, /<dim>claude-sonnet-4-20250514<\/dim>/);
});

test("line 2 (color-aware): disabled renders name with accent", () => {
	const ctx = createCtx({ provider: "anthropic" });
	const footer = createTlhFooter(pi, ctx, colorTheme, () => "disabled", createFooterData(), {});
	const line = footer.render(COLOR_WIDTH)[1] ?? "";

	assert.match(line, /<accent>disabled<\/accent>/);
	assert.doesNotMatch(line, /<dim>disabled<\/dim>/);
});

test("line 2 (color-aware): default primary agent renders name with dim, regardless of constant value", () => {
	const ctx = createCtx({ provider: "anthropic" });
	const footer = createTlhFooter(pi, ctx, colorTheme, () => DEFAULT_PRIMARY_AGENT, createFooterData(), {});
	const line = footer.render(COLOR_WIDTH)[1] ?? "";

	// Name must appear inside <dim>, not <accent>
	assert.match(line, new RegExp(`<dim>${DEFAULT_PRIMARY_AGENT}</dim>`));
	assert.doesNotMatch(line, new RegExp(`<accent>${DEFAULT_PRIMARY_AGENT}</accent>`));
});

test("line 2 (color-aware): product and bug-hunter render name with accent", () => {
	const ctx = createCtx({ provider: "anthropic" });

	const productFooter = createTlhFooter(pi, ctx, colorTheme, () => "product", createFooterData(), {});
	assert.match(productFooter.render(COLOR_WIDTH)[1] ?? "", /<accent>product<\/accent>/);

	const bugFooter = createTlhFooter(pi, ctx, colorTheme, () => "bug-hunter", createFooterData(), {});
	assert.match(bugFooter.render(COLOR_WIDTH)[1] ?? "", /<accent>bug-hunter<\/accent>/);
});

// ---------------------------------------------------------------------------
// NEW: extension status line rendering
// ---------------------------------------------------------------------------

test("tk workflow status renders as dim footer lines between agent and usage without generic duplication", () => {
	const ctx = createCtx({ provider: "anthropic", usingOAuth: false });
	const footerData = {
		getGitBranch: () => undefined,
		getAvailableProviderCount: () => 1,
		getExtensionStatuses: () => new Map([
			["tlh-ticket-workflow", "working on tk: Implement read-only ticket workflow status UI\nUse /tk-status for details."],
			["my-ext", "my-ext: active"],
		]),
	};
	const footer = createTlhFooter(pi, ctx, colorTheme, () => "architect", footerData, {});
	const lines = footer.render(COLOR_WIDTH);

	assert.match(lines[1] ?? "", /<dim>agent: <\/dim>/);
	assert.equal(lines[2], "<dim>working on tk: Implement read-only ticket workflow status UI</dim>");
	assert.equal(lines[3], "<dim>Use /tk-status for details.</dim>");
	assert.equal(lines[4], "<dim>$1.250</dim>");
	assert.equal(lines[5], "my-ext: active");
	assert.doesNotMatch(lines[5] ?? "", /working on tk|tk-status/);
});

test("non-context-cap extension statuses are still rendered in the footer", () => {
	// An unrelated extension status must not be affected by the tk workflow status filter.
	const ctx = createCtx({ entries: [] });
	const footerData = {
		getGitBranch: () => undefined,
		getAvailableProviderCount: () => 1,
		getExtensionStatuses: () => new Map([["my-ext", "my-ext: active"]]),
	};
	const lines = renderFooterLines(ctx, {}, WIDTH, footerData);
	// pwd + agent + extension-status line
	assert.equal(lines.length, 3);
	assert.match(lines[2] ?? "", /my-ext: active/);
});


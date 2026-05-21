import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

import { createTlhSubscriptionUsageService } from "../extensions/the-last-harness/subscription-usage.mjs";

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

function openAiSnapshot() {
	return {
		provider: "openai-codex",
		fetchedAt: NOW_MS,
		windows: {
			session: { key: "primary_window", label: "session", percent: 42 },
			weekly: { key: "secondary_window", label: "weekly", percent: 21.5 },
		},
	};
}

function anthropicSnapshot() {
	return {
		provider: "anthropic",
		fetchedAt: NOW_MS,
		windows: {
			session: { key: "five_hour", label: "session", percent: 42 },
			weekly: { key: "seven_day", label: "weekly", percent: 88.9 },
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

test("line 2 shows provider prefix when multiple providers available", () => {
	const line = renderAgentLine(createCtx({ provider: "anthropic" }), {}, WIDTH, createFooterData({ providerCount: 2 }));
	assert.match(line, /^agent: architect • \(anthropic\) claude-sonnet-4-20250514 • /);
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

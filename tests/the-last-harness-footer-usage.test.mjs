import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createTlhFooter, formatTlhSubscriptionUsageFooterSegment } = await jiti.import("../extensions/the-last-harness/footer.ts");

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

function usageProvider(snapshot, onGetSnapshot) {
	return {
		getSnapshot(provider) {
			onGetSnapshot?.(provider);
			return snapshot;
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

function renderFooterStatsLine(ctx, usageOptions, width = WIDTH, footerData = createFooterData()) {
	const footer = createTlhFooter(pi, ctx, theme, () => "architect", footerData, usageOptions);
	return footer.render(width)[1];
}

test("footer renders OpenAI/Codex session usage and hides weekly by default", () => {
	let requestedProvider;
	const line = renderFooterStatsLine(createCtx({ provider: "openai-codex" }), {
		subscriptionUsage: usageProvider(openAiSnapshot(), (provider) => {
			requestedProvider = provider;
		}),
		shouldShowWeekly: () => false,
	});

	assert.equal(requestedProvider, "openai-codex");
	assert.match(line, /session 42% used/);
	assert.doesNotMatch(line, /weekly/);
	assert.doesNotMatch(line, /\$/);
	assert.match(line, /12\.3%\/200k/);
});

test("footer includes Anthropic weekly usage only when the preference enables it", () => {
	const snapshot = anthropicSnapshot();
	assert.equal(formatTlhSubscriptionUsageFooterSegment(snapshot, { showWeekly: false }), "5h 42% used");
	assert.equal(formatTlhSubscriptionUsageFooterSegment(snapshot, { showWeekly: true }), "5h 42% used · weekly 88.9% used");

	const line = renderFooterStatsLine(createCtx({ provider: "anthropic" }), {
		subscriptionUsage: usageProvider(snapshot),
		shouldShowWeekly: () => true,
	});

	assert.match(line, /5h 42% used/);
	assert.match(line, /weekly 88\.9% used/);
});

test("footer render reads cached usage snapshots without refreshing", () => {
	let refreshCalls = 0;
	const subscriptionUsage = {
		getSnapshot: () => openAiSnapshot(),
		refresh: async () => {
			refreshCalls += 1;
			throw new Error("render must not refresh usage");
		},
	};

	const line = renderFooterStatsLine(createCtx({ provider: "openai-codex" }), {
		subscriptionUsage,
		shouldShowWeekly: () => false,
	});

	assert.match(line, /session 42% used/);
	assert.equal(refreshCalls, 0);
});

test("footer leaves usage unchanged for unsupported providers and snapshot errors", () => {
	const unsupportedLine = renderFooterStatsLine(createCtx({ provider: "openrouter" }), {
		subscriptionUsage: usageProvider(openAiSnapshot()),
		shouldShowWeekly: () => true,
	});
	assert.doesNotMatch(unsupportedLine, /used/);
	assert.doesNotMatch(unsupportedLine, /weekly/);
	assert.doesNotMatch(unsupportedLine, /\$/);
	assert.match(unsupportedLine, /12\.3%\/200k/);

	const errorLine = renderFooterStatsLine(createCtx({ provider: "anthropic" }), {
		subscriptionUsage: {
			getSnapshot() {
				throw new Error("cached usage unavailable");
			},
		},
		shouldShowWeekly: () => true,
	});
	assert.doesNotMatch(errorLine, /used/);
	assert.doesNotMatch(errorLine, /weekly/);
	assert.doesNotMatch(errorLine, /\$/);
	assert.match(errorLine, /12\.3%\/200k/);
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
	assert.match(lines[1], /\.\.\./);
	assert.match(lines[1], /^5h 42% used/);
});

import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

import { createTlhSubscriptionUsageService } from "../extensions/the-last-harness/subscription-usage.ts";
import { DEFAULT_PRIMARY_AGENT } from "../extensions/the-last-harness-primary-agent.mjs";
import { createProviderAuthHealthStore } from "../extensions/the-last-harness/provider-auth-health.ts";

const jiti = createJiti(import.meta.url);
const { createTlhFooter, formatTlhSubscriptionUsageFooterSegment, formatReauthWarningLine } =
  await jiti.import("../extensions/the-last-harness/footer.ts");

const NOW_MS = Date.parse("2026-05-19T19:00:00Z");
const WIDTH = 100;

const theme = {
  fg: (_color, text) => text,
};

const pi = {
  getThinkingLevel: () => "medium",
  getActiveTools: () => [],
  getAllTools: () => [],
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

function openAiPrimaryWeeklySnapshot({ percent = 42, resetsAt } = {}) {
  return {
    provider: "openai-codex",
    fetchedAt: NOW_MS,
    windows: {
      session: {
        key: "primary_window",
        label: "session",
        percent,
        durationMs: 7 * 24 * 60 * 60 * 1000,
        ...(resetsAt ? { resetsAt } : {}),
      },
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
      id:
        options.modelId ??
        (provider === "openai-codex" ? "gpt-5-codex" : "claude-sonnet-4-20250514"),
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
      buildContextEntries: () =>
        options.contextEntries ?? options.entries ?? [assistantCostEntry(1.25)],
      getLeafId: () => options.leafId ?? "leaf-1",
      getCwd: () => "/tmp/the-last-harness",
      getSessionName: () => options.sessionName,
    },
    getContextUsage: () =>
      options.contextUsage ?? { tokens: 1000, contextWindow: 200000, percent: 12.3 },
    ui: {
      getEditorText: () => options.editorText ?? "",
    },
    isIdle: () => options.idle ?? true,
  };
}

function createToolInfo(name, source = "built-in", path = `/tmp/${name}.ts`) {
  return {
    name,
    description: `${name} description`,
    parameters: { type: "object", properties: { value: { type: "string" } } },
    promptGuidelines: [`Use ${name}`],
    sourceInfo: {
      source,
      path,
      scope: "project",
      origin: "top-level",
    },
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

test("footer formats an exact seven-day OpenAI primary window as weekly without showing secondary usage", () => {
  const snapshot = openAiPrimaryWeeklySnapshot({ resetsAt: "2026-05-24T01:00:00.000Z" });
  const ctx = createCtx({ provider: "openai-codex" });
  const sessionLine = renderSessionStatsLine(ctx, {
    subscriptionUsage: usageProvider(snapshot),
    shouldShowWeekly: () => false,
  });

  assert.equal(
    formatTlhSubscriptionUsageFooterSegment(snapshot, { nowMs: NOW_MS }),
    "weekly 42% used, resets in 4d 6h",
  );
  assert.equal(sessionLine, "weekly 42% used");
});

test("footer includes Anthropic weekly usage only when the preference enables it", () => {
  const snapshot = anthropicSnapshot();
  assert.equal(
    formatTlhSubscriptionUsageFooterSegment(snapshot, { showWeekly: false }),
    "5h session 42% used",
  );
  assert.equal(
    formatTlhSubscriptionUsageFooterSegment(snapshot, { showWeekly: true }),
    "5h session 42% used · weekly 88.9% used",
  );

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
    subscriptionUsage: usageProvider(
      openAiSnapshot({ percent: 80, used: 10, limit: 100, remaining: 90 }),
    ),
    shouldShowWeekly: () => undefined,
  });

  assert.match(sessionLine, /weekly 80% used/);
});

test("footer auto-show derives weekly remaining from counts when percent is absent", () => {
  const ctx = createCtx({ provider: "openai-codex" });
  const sessionLine = renderSessionStatsLine(ctx, {
    subscriptionUsage: usageProvider(
      openAiSnapshot({ used: 90, limit: 100, remaining: 10, percent: undefined }),
    ),
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
  const credential = {
    type: "oauth",
    access: "unused-oauth-access-token",
    expires: NOW_MS + 60_000,
  };
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
  const footer = createTlhFooter(
    pi,
    ctx,
    theme,
    () => "architect",
    createFooterData({ providerCount: 2 }),
    {
      subscriptionUsage: usageProvider(anthropicSnapshot()),
      shouldShowWeekly: () => true,
    },
  );

  const width = 24;
  const lines = footer.render(width);
  assert.ok(lines.every((line) => visibleWidth(line) <= width));
  // Agent line (index 1) is truncated due to the long model name
  assert.match(lines[1], /\.\.\./);
  // Session stats line (index 2) starts with the subscription segment
  assert.match(lines[2], /^5h session 42% used/);
});

// ---------------------------------------------------------------------------
// NEW: no-provider warning tests
// ---------------------------------------------------------------------------

test("footer warns when the upstream provider count is zero", () => {
  const lines = renderFooterLines(
    createCtx({ entries: [] }),
    {},
    WIDTH,
    createFooterData({ providerCount: 0 }),
  );

  assert.ok(lines.includes("⚠ no provider — run /login"));
});

test("footer omits the no-provider warning when a provider is available", () => {
  const lines = renderFooterLines(
    createCtx({ entries: [] }),
    {},
    WIDTH,
    createFooterData({ providerCount: 1 }),
  );

  assert.doesNotMatch(lines.join("\n"), /no provider|run \/login/);
});

test("footer dismisses the no-provider warning after the provider count becomes nonzero", () => {
  let providerCount = 0;
  const footerData = {
    ...createFooterData(),
    getAvailableProviderCount: () => providerCount,
  };
  const footer = createTlhFooter(
    pi,
    createCtx({ entries: [] }),
    theme,
    () => "architect",
    footerData,
    {},
  );

  assert.match(footer.render(WIDTH).join("\n"), /⚠ no provider — run \/login/);

  providerCount = 1;
  assert.doesNotMatch(footer.render(WIDTH).join("\n"), /no provider|run \/login/);
});

test("footer renders the no-provider warning with warning styling", () => {
  const lines = createTlhFooter(
    pi,
    createCtx({ entries: [] }),
    colorTheme,
    () => "architect",
    createFooterData({ providerCount: 0 }),
    {},
  ).render(COLOR_WIDTH);

  assert.equal(lines.at(-1), "<warning>⚠ no provider — run /login</warning>");
});

test("no-provider warning respects narrow footer widths", () => {
  const width = 12;
  const lines = renderFooterLines(
    createCtx({ entries: [] }),
    {},
    width,
    createFooterData({ providerCount: 0 }),
  );
  const warningLine = lines.at(-1) ?? "";

  assert.ok(visibleWidth(warningLine) <= width);
  assert.ok(warningLine.length > 0);
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
  const line = renderAgentLine(
    createCtx({ provider: "anthropic" }),
    {},
    WIDTH,
    createFooterData({ providerCount: 2 }),
  );
  assert.match(line, /^agent: architect • claude-sonnet-4-20250514 • /);
  assert.doesNotMatch(line, /\(anthropic\)/);
});

test("line 2 shows thinking level for reasoning models", () => {
  const ctx = createCtx({
    model: {
      provider: "anthropic",
      id: "claude-opus-4-reasoning",
      contextWindow: 200000,
      reasoning: true,
    },
  });
  const line = renderAgentLine(ctx, {});
  assert.match(line, /claude-opus-4-reasoning • medium • /);
});

test("line 2 shows thinking off label when thinking is disabled on a reasoning model", () => {
  const piOff = { getThinkingLevel: () => "off" };
  const ctx = createCtx({
    model: {
      provider: "anthropic",
      id: "claude-opus-4-reasoning",
      contextWindow: 200000,
      reasoning: true,
    },
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
      session: {
        key: "five_hour",
        label: "session",
        percent: 42,
        ...(sessionResetsAt ? { resetsAt: sessionResetsAt } : {}),
      },
      weekly: {
        key: "seven_day",
        label: "weekly",
        percent: 88.9,
        ...(weeklyResetsAt ? { resetsAt: weeklyResetsAt } : {}),
      },
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
  const result = formatTlhSubscriptionUsageFooterSegment(snapshot, {
    showWeekly: true,
    nowMs: NOW_MS,
  });
  assert.equal(result, "5h session 42% used, resets in 2h13m · weekly 88.9% used, resets in 4d 6h");
});

test("reset countdown: weekly <1d (5h) falls back to session-style format '5h0m'", () => {
  // 2026-05-19T19:00:00Z + 5h = 2026-05-20T00:00:00Z
  const snapshot = anthropicSnapshotWithResets({
    weeklyResetsAt: "2026-05-20T00:00:00.000Z",
  });
  const result = formatTlhSubscriptionUsageFooterSegment(snapshot, {
    showWeekly: true,
    nowMs: NOW_MS,
  });
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
  const result = formatTlhSubscriptionUsageFooterSegment(snapshot, {
    showWeekly: true,
    nowMs: NOW_MS,
  });
  assert.equal(result, "5h session 42% used · weekly 88.9% used, resets in 1d 0h");
});

test("reset countdown: weekly exactly 25h future appends ', resets in 1d 1h' (day count and remainder)", () => {
  const weeklyResetsAt = new Date(NOW_MS + 25 * 60 * 60 * 1000).toISOString();
  const snapshot = anthropicSnapshotWithResets({ weeklyResetsAt });
  const result = formatTlhSubscriptionUsageFooterSegment(snapshot, {
    showWeekly: true,
    nowMs: NOW_MS,
  });
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
  const result = formatTlhSubscriptionUsageFooterSegment(snapshot, {
    showWeekly: true,
    nowMs: NOW_MS,
  });
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
  const footer = createTlhFooter(
    pi,
    ctx,
    colorTheme,
    () => DEFAULT_PRIMARY_AGENT,
    createFooterData(),
    {},
  );
  const line = footer.render(COLOR_WIDTH)[1] ?? "";

  // Name must appear inside <dim>, not <accent>
  assert.match(line, new RegExp(`<dim>${DEFAULT_PRIMARY_AGENT}</dim>`));
  assert.doesNotMatch(line, new RegExp(`<accent>${DEFAULT_PRIMARY_AGENT}</accent>`));
});

test("line 2 (color-aware): product and bug-hunter render name with accent", () => {
  const ctx = createCtx({ provider: "anthropic" });

  const productFooter = createTlhFooter(
    pi,
    ctx,
    colorTheme,
    () => "product",
    createFooterData(),
    {},
  );
  assert.match(productFooter.render(COLOR_WIDTH)[1] ?? "", /<accent>product<\/accent>/);

  const bugFooter = createTlhFooter(
    pi,
    ctx,
    colorTheme,
    () => "bug-hunter",
    createFooterData(),
    {},
  );
  assert.match(bugFooter.render(COLOR_WIDTH)[1] ?? "", /<accent>bug-hunter<\/accent>/);
});

// ---------------------------------------------------------------------------
// NEW: extension status line rendering
// ---------------------------------------------------------------------------

test("fast extension status renders as a dim line-2 segment without generic duplication", () => {
  const ctx = createCtx({ entries: [] });
  const footerData = {
    getGitBranch: () => undefined,
    getAvailableProviderCount: () => 1,
    getExtensionStatuses: () => new Map([["fast", "Fast on"]]),
  };
  const lines = createTlhFooter(pi, ctx, colorTheme, () => "architect", footerData, {}).render(
    COLOR_WIDTH,
  );

  assert.equal(lines.length, 2, "fast should not create a separate extension-status line");
  assert.match(lines[1] ?? "", /<dim> • <\/dim><dim>fast<\/dim>$/);
  assert.doesNotMatch(lines[1] ?? "", /Fast on/);
});

test("fast extension status coexists with MCP and unrelated extension statuses", () => {
  const ctx = createCtx({ entries: [] });
  const footerData = {
    getGitBranch: () => undefined,
    getAvailableProviderCount: () => 1,
    getExtensionStatuses: () =>
      new Map([
        ["fast", "Fast on"],
        ["mcp", "MCP: 1/1 servers"],
        ["my-ext", "my-ext: active"],
      ]),
  };
  const lines = createTlhFooter(pi, ctx, colorTheme, () => "architect", footerData, {}).render(
    COLOR_WIDTH,
  );

  assert.match(lines[1] ?? "", /<dim> • <\/dim><dim>fast<\/dim>$/);
  assert.equal(lines.length, 3, "MCP and unrelated statuses should share one generic line");
  assert.match(lines[2] ?? "", /MCP: 1\/1 servers/);
  assert.match(lines[2] ?? "", /my-ext: active/);
  assert.doesNotMatch(lines[2] ?? "", /fast|Fast on/);
});

test("fast extension status remains visible when line 2 is truncated", () => {
  const ctx = createCtx({ entries: [] });
  const footerData = {
    getGitBranch: () => undefined,
    getAvailableProviderCount: () => 1,
    getExtensionStatuses: () => new Map([["fast", "Fast on"]]),
  };
  const width = 60;
  const line =
    createTlhFooter(pi, ctx, theme, () => "architect", footerData, {}).render(width)[1] ?? "";

  assert.ok(visibleWidth(line) <= width);
  assert.match(line, /\.\.\./);
  assert.match(line, / • fast$/);
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

// ---------------------------------------------------------------------------
// NEW: install notice warning line (last line of footer)
// ---------------------------------------------------------------------------

function makeInstallNotice(kind, detail, commitSubject) {
  return {
    kind,
    summary: "TLH install notice",
    detail,
    ...(commitSubject !== undefined ? { commitSubject } : {}),
  };
}

test("footer appends no warning line when no install notice is provided", () => {
  const ctx = createCtx({ entries: [] });
  const footer = createTlhFooter(
    pi,
    ctx,
    theme,
    () => "architect",
    createFooterData(),
    {},
    null,
    undefined,
  );
  const lines = footer.render(WIDTH);
  assert.doesNotMatch(lines.join("\n"), /running TLH from/);
});

test("footer warning line is absent when installNotice is undefined", () => {
  const ctx = createCtx({ entries: [] });
  const footer = createTlhFooter(
    pi,
    ctx,
    theme,
    () => "architect",
    createFooterData(),
    {},
    null,
    undefined,
  );
  const lines = footer.render(WIDTH);
  assert.doesNotMatch(lines.join("\n"), /running TLH from/);
});

test("footer warning line is the last line when a ref notice is present", () => {
  const ctx = createCtx({ entries: [] });
  const notice = makeInstallNotice("ref", "my-branch");
  const footer = createTlhFooter(
    pi,
    ctx,
    theme,
    () => "architect",
    createFooterData(),
    {},
    null,
    notice,
  );
  const lines = footer.render(WIDTH);
  const lastLine = lines.at(-1) ?? "";
  assert.equal(lastLine, "TLH my-branch");
});

test("footer warning line is the last line when a pinned-tag notice is present", () => {
  const ctx = createCtx({ entries: [] });
  const notice = makeInstallNotice("pinned-tag", "v0.27.0");
  const footer = createTlhFooter(
    pi,
    ctx,
    theme,
    () => "architect",
    createFooterData(),
    {},
    null,
    notice,
  );
  const lines = footer.render(WIDTH);
  const lastLine = lines.at(-1) ?? "";
  assert.equal(lastLine, "TLH v0.27.0");
});

test("footer warning line is the last line when an unknown notice is present", () => {
  const ctx = createCtx({ entries: [] });
  const notice = makeInstallNotice("unknown");
  const footer = createTlhFooter(
    pi,
    ctx,
    theme,
    () => "architect",
    createFooterData(),
    {},
    null,
    notice,
  );
  const lines = footer.render(WIDTH);
  const lastLine = lines.at(-1) ?? "";
  assert.equal(lastLine, "TLH unknown");
});

test("footer install notice line uses dim for 'TLH ' prefix and warning color for the label (color-aware theme)", () => {
  const ctx = createCtx({ entries: [] });
  const notice = makeInstallNotice("ref", "main");
  const footer = createTlhFooter(
    pi,
    ctx,
    colorTheme,
    () => "architect",
    createFooterData(),
    {},
    null,
    notice,
  );
  const lines = footer.render(COLOR_WIDTH);
  const lastLine = lines.at(-1) ?? "";
  assert.match(lastLine, /<dim>TLH <\/dim>/);
  assert.match(lastLine, /<warning>main<\/warning>/);
});

test("footer appends a persisted subject to the main ref label with a dim suffix", () => {
  const ctx = createCtx({ entries: [] });
  const notice = makeInstallNotice("ref", "main", "Add the main footer subject");
  const footer = createTlhFooter(
    pi,
    ctx,
    theme,
    () => "architect",
    createFooterData(),
    {},
    null,
    notice,
  );
  assert.equal(footer.render(WIDTH).at(-1), "TLH main • Add the main footer subject");
});

test("footer dims both the main subject separator and subject without changing main styling", () => {
  const ctx = createCtx({ entries: [] });
  const notice = makeInstallNotice("ref", "main", "Add the main footer subject");
  const footer = createTlhFooter(
    pi,
    ctx,
    colorTheme,
    () => "architect",
    createFooterData(),
    {},
    null,
    notice,
  );
  const lastLine = footer.render(COLOR_WIDTH).at(-1) ?? "";
  assert.equal(
    lastLine,
    "<dim>TLH </dim><warning>main</warning><dim> • </dim><dim>Add the main footer subject</dim>",
  );
});

test("footer omits the subject for legacy, invalid, and non-main install notices", () => {
  const cases = [
    [makeInstallNotice("ref", "main"), "TLH main"],
    [makeInstallNotice("ref", "main", "   "), "TLH main"],
    [makeInstallNotice("ref", "main", 42), "TLH main"],
    [makeInstallNotice("ref", "feature/footer", "Feature commit subject"), "TLH feature/footer"],
    [makeInstallNotice("pinned-tag", "main", "Pinned commit subject"), "TLH main"],
    [makeInstallNotice("custom-track", "custom", "Custom commit subject"), "TLH custom"],
    [makeInstallNotice("unknown", undefined, "Unknown commit subject"), "TLH unknown"],
  ];

  for (const [notice, expected] of cases) {
    const ctx = createCtx({ entries: [] });
    const footer = createTlhFooter(
      pi,
      ctx,
      theme,
      () => "architect",
      createFooterData(),
      {},
      null,
      notice,
    );
    assert.equal(footer.render(WIDTH).at(-1), expected);
  }
});

test("footer warning line stays within narrow widths", () => {
  const ctx = createCtx({ entries: [] });
  const notice = makeInstallNotice("ref", "a-very-long-branch-name-that-should-get-truncated");
  const footer = createTlhFooter(
    pi,
    ctx,
    theme,
    () => "architect",
    createFooterData(),
    {},
    null,
    notice,
  );
  const width = 20;
  const lines = footer.render(width);
  assert.ok(
    lines.every((line) => visibleWidth(line) <= width),
    `all lines must fit in ${width} chars`,
  );
});

function renderMcpStatus({
  activeTools = [],
  allTools = [],
  contextEntries = [],
  contextTokens = 100000,
  status = "MCP: 0/1 servers",
} = {}) {
  const mcpPi = {
    ...pi,
    getActiveTools: () => activeTools,
    getAllTools: () => allTools,
  };
  const ctx = createCtx({
    entries: [],
    contextUsage: { tokens: contextTokens, contextWindow: 200000, percent: 50 },
    contextEntries,
  });
  const footerData = {
    ...createFooterData(),
    getExtensionStatuses: () => new Map([["mcp-status", status]]),
  };
  return (
    createTlhFooter(mcpPi, ctx, theme, () => "architect", footerData, {})
      .render(WIDTH)
      .at(-1) ?? ""
  );
}

function mcpStatusPercent(options) {
  return Number(renderMcpStatus(options).match(/\((\d+\.\d)% of context\)$/)?.[1]);
}

test("footer appends a one-decimal MCP context estimate to the existing status", () => {
  const status = renderMcpStatus({
    activeTools: ["mcp"],
    allTools: [createToolInfo("mcp", "mcp-proxy")],
    contextTokens: 1000,
  });
  assert.equal(status, "MCP: 0/1 servers • (3.8% of context)");
});

test("footer independently attributes proxy and direct MCP definitions, arguments, and results", () => {
  const proxyTool = {
    ...createToolInfo("mcp", "npm:pi-mcp-adapter", "extensions/mcp.mjs"),
    description: "p".repeat(4000),
  };
  const directTool = {
    ...createToolInfo(
      "jiraSearch",
      "npm:@diegopetrucci/pi-mcp-adapter@2.10.1",
      "extensions/direct-tools/jira.mjs",
    ),
    description: "d".repeat(4000),
  };
  const allTools = [proxyTool, directTool];
  const baseline = mcpStatusPercent({ allTools });
  const proxyDefinition = mcpStatusPercent({ activeTools: ["mcp"], allTools });
  const directDefinition = mcpStatusPercent({ activeTools: ["jiraSearch"], allTools });

  assert.equal(proxyDefinition - baseline, 1, "proxy definition contributes independently");
  assert.equal(directDefinition - baseline, 1, "direct definition contributes independently");

  const proxyCall = mcpStatusPercent({
    activeTools: ["mcp"],
    allTools,
    contextEntries: [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "mcp", arguments: { payload: "x".repeat(4000) } }],
        },
      },
    ],
  });
  const directCall = mcpStatusPercent({
    activeTools: ["jiraSearch"],
    allTools,
    contextEntries: [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", name: "jiraSearch", arguments: { payload: "x".repeat(4000) } },
          ],
        },
      },
    ],
  });
  assert.equal(proxyCall - proxyDefinition, 1, "proxy call arguments contribute independently");
  assert.equal(directCall - directDefinition, 1, "direct call arguments contribute independently");

  const proxyResult = mcpStatusPercent({
    activeTools: ["mcp"],
    allTools,
    contextEntries: [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "mcp",
          content: [{ type: "text", text: "x".repeat(4000) }],
        },
      },
    ],
  });
  const directResult = mcpStatusPercent({
    activeTools: ["jiraSearch"],
    allTools,
    contextEntries: [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "jiraSearch",
          content: [{ type: "text", text: "x".repeat(4000) }],
        },
      },
    ],
  });
  assert.equal(proxyResult - proxyDefinition, 1, "proxy result content contributes independently");
  assert.equal(
    directResult - directDefinition,
    1,
    "direct result content contributes independently",
  );
});

test("footer ignores unrelated non-adapter provenance even when source paths include mcp", () => {
  const misleadingTool = createToolInfo(
    "jiraSearch",
    "npm:acme-helper",
    "extensions/mcp-utils/jira.mjs",
  );
  const baseline = mcpStatusPercent({ allTools: [misleadingTool] });
  const definition = mcpStatusPercent({ activeTools: ["jiraSearch"], allTools: [misleadingTool] });
  const call = mcpStatusPercent({
    activeTools: ["jiraSearch"],
    allTools: [misleadingTool],
    contextEntries: [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", name: "jiraSearch", arguments: { payload: "x".repeat(4000) } },
          ],
        },
      },
    ],
  });
  const result = mcpStatusPercent({
    activeTools: ["jiraSearch"],
    allTools: [misleadingTool],
    contextEntries: [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "jiraSearch",
          content: [{ type: "text", text: "x".repeat(4000) }],
        },
      },
    ],
  });

  assert.equal(baseline, 0);
  assert.equal(definition, 0);
  assert.equal(call, 0);
  assert.equal(result, 0);
});

test("footer releases all pending cold-catalog direct calls after real adapter provenance is established", () => {
  const recovered = mcpStatusPercent({
    activeTools: ["jira_search_issues"],
    allTools: [],
    contextEntries: [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "jira_search_issues",
              arguments: { payload: "x".repeat(4000) },
            },
            {
              type: "toolCall",
              id: "call-2",
              name: "jira_search_issues",
              arguments: { payload: "x".repeat(4000) },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "jira_search_issues",
          toolCallId: "call-1",
          details: { server: "jira", tool: "search_issues" },
          content: [{ type: "text", text: "x".repeat(4000) }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "jira_search_issues",
          toolCallId: "call-2",
          details: { error: "tool_error", server: "jira" },
          content: [{ type: "text", text: "x".repeat(4000) }],
        },
      },
    ],
  });

  assert.equal(recovered, 4);
});

test("footer rejects generic paired server/tool details that do not match adapter direct-tool naming", () => {
  const lookalike = mcpStatusPercent({
    activeTools: ["jiraSearch"],
    allTools: [],
    contextEntries: [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "other-call",
              name: "jiraSearch",
              arguments: { payload: "x".repeat(4000) },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "jiraSearch",
          toolCallId: "other-call",
          details: { server: "jira", tool: "search_issues" },
          content: [{ type: "text", text: "x".repeat(4000) }],
        },
      },
    ],
  });

  assert.equal(lookalike, 0);
});

test("footer clamps MCP context share to a finite 0–100% range", () => {
  const tool = createToolInfo("mcp", "mcp-proxy");
  assert.equal(
    renderMcpStatus({ activeTools: ["mcp"], allTools: [tool], contextTokens: 1 }),
    "MCP: 0/1 servers • (100.0% of context)",
  );
  assert.equal(
    renderMcpStatus({ activeTools: ["mcp"], allTools: [tool], contextTokens: Number.NaN }),
    "MCP: 0/1 servers",
  );
});

test("footer MCP context estimate counts each tool-result image as 1200 tokens", () => {
  const mcpPi = {
    ...pi,
    getActiveTools: () => ["mcp"],
    getAllTools: () => [createToolInfo("mcp", "mcp-proxy")],
  };
  const footerData = {
    ...createFooterData(),
    getExtensionStatuses: () => new Map([["mcp-status", "MCP: 1/1 servers"]]),
  };
  const renderPercent = (content) => {
    const ctx = createCtx({
      entries: [],
      contextUsage: { tokens: 120000, contextWindow: 200000, percent: 60 },
      contextEntries: [
        { type: "message", message: { role: "toolResult", toolName: "mcp", content } },
      ],
    });
    const status =
      createTlhFooter(mcpPi, ctx, theme, () => "architect", footerData, {})
        .render(WIDTH)
        .at(-1) ?? "";
    return Number(status.match(/\((\d+\.\d)% of context\)$/)?.[1]);
  };

  const withoutImage = renderPercent([{ type: "text", text: "ok" }]);
  const withImage = renderPercent([
    { type: "text", text: "ok" },
    { type: "image", data: "ignored-base64-data", mimeType: "image/png" },
  ]);
  assert.equal(withImage - withoutImage, 1);
});

test("footer MCP context estimate uses active compaction-aware entries and omits unknown context totals", () => {
  const mcpPi = {
    ...pi,
    getActiveTools: () => ["mcp"],
    getAllTools: () => [createToolInfo("mcp", "mcp-proxy")],
  };
  const archivedPayload = "x".repeat(800);
  const activePayload = "ok";
  const footerData = {
    ...createFooterData(),
    getExtensionStatuses: () => new Map([["mcp-status", "MCP: 1/1 servers"]]),
  };
  const ctx = createCtx({
    entries: [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "mcp",
          content: [{ type: "text", text: archivedPayload }],
        },
      },
    ],
    contextEntries: [
      { type: "compaction", summary: "older history compacted" },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "mcp",
          content: [{ type: "text", text: activePayload }],
        },
      },
    ],
    contextUsage: { tokens: 1000, contextWindow: 200000, percent: 12.3 },
  });
  const lines = createTlhFooter(mcpPi, ctx, theme, () => "architect", footerData, {}).render(WIDTH);
  assert.match(lines.at(-1) ?? "", /MCP: 1\/1 servers • \(3\.9% of context\)$/);

  const unknownContextCtx = createCtx({
    entries: [],
    contextEntries: ctx.sessionManager.buildContextEntries(),
    contextUsage: { tokens: null, contextWindow: 200000, percent: null },
  });
  const unknownLines = createTlhFooter(
    mcpPi,
    unknownContextCtx,
    theme,
    () => "architect",
    footerData,
    {},
  ).render(WIDTH);
  assert.equal(unknownLines.at(-1), "MCP: 1/1 servers");
});

test("footer caches repeated MCP context estimates until the active context changes", () => {
  let getAllToolsCalls = 0;
  let buildContextEntriesCalls = 0;
  const leafState = { current: "leaf-1" };
  const mcpPi = {
    ...pi,
    getActiveTools: () => ["mcp"],
    getAllTools: () => {
      getAllToolsCalls += 1;
      return [createToolInfo("mcp", "mcp-proxy")];
    },
  };
  const ctx = createCtx({
    entries: [],
    leafId: leafState.current,
    contextUsage: { tokens: 1000, contextWindow: 200000, percent: 12.3 },
    contextEntries: [
      {
        type: "message",
        message: { role: "toolResult", toolName: "mcp", content: [{ type: "text", text: "ok" }] },
      },
    ],
  });
  ctx.sessionManager.getLeafId = () => leafState.current;
  ctx.sessionManager.buildContextEntries = () => {
    buildContextEntriesCalls += 1;
    return [
      {
        type: "message",
        message: { role: "toolResult", toolName: "mcp", content: [{ type: "text", text: "ok" }] },
      },
    ];
  };
  const footerData = {
    ...createFooterData(),
    getExtensionStatuses: () => new Map([["mcp-status", "MCP: 1/1 servers"]]),
  };
  const footer = createTlhFooter(mcpPi, ctx, theme, () => "architect", footerData, {});

  footer.render(WIDTH);
  footer.render(WIDTH);
  assert.equal(getAllToolsCalls, 1);
  assert.equal(buildContextEntriesCalls, 1);

  leafState.current = "leaf-2";
  footer.render(WIDTH);
  assert.equal(getAllToolsCalls, 2);
  assert.equal(buildContextEntriesCalls, 2);
});

test("footer keeps the MCP status estimate within narrow widths", () => {
  const mcpPi = {
    ...pi,
    getActiveTools: () => ["mcp"],
    getAllTools: () => [createToolInfo("mcp", "mcp-proxy")],
  };
  const footerData = {
    ...createFooterData(),
    getExtensionStatuses: () => new Map([["mcp-status", "MCP: 0/1 servers"]]),
  };
  const ctx = createCtx({
    entries: [],
    contextUsage: { tokens: 1000, contextWindow: 200000, percent: 12.3 },
    contextEntries: [
      {
        type: "message",
        message: { role: "toolResult", toolName: "mcp", content: [{ type: "text", text: "ok" }] },
      },
    ],
  });
  const lines = createTlhFooter(mcpPi, ctx, theme, () => "architect", footerData, {}).render(24);
  assert.ok(lines.every((line) => visibleWidth(line) <= 24));
  assert.match(lines.at(-1) ?? "", /\.\.\./);
});

// ---------------------------------------------------------------------------
// NEW: provider auth-health reauth warning line
// ---------------------------------------------------------------------------

// Helper: record a status directly into a fresh store by exploiting clearProvider
// (which writes 'healthy') then probing with a stub that returns the desired status.
// For reauth-required, we use clearProvider to set healthy then manually override
// via probeProvider with a failing registry. For simplicity, use probeProvider with
// a registry whose getProviderAuth throws the right error shape.

function makeReauthRegistry(provider) {
  return {
    getProviderAuth: async (p) => {
      if (p === provider) {
        // Throws a plain error that classifyProviderAuthError maps to reauth-required
        // via the 401 / revoke path.
        throw Object.assign(new Error("token has been revoked"), { status: 401 });
      }
    },
  };
}

function makeTransientRegistry(provider) {
  return {
    getProviderAuth: async (p) => {
      if (p === provider) {
        throw Object.assign(new Error("network timeout"), { code: "ETIMEDOUT" });
      }
    },
  };
}

async function storeWithReauth(...providers) {
  const store = createProviderAuthHealthStore();
  for (const provider of providers) {
    await store.probeProvider(makeReauthRegistry(provider), provider);
  }
  return store;
}

function createFooterWithAuthHealth(store) {
  const ctx = createCtx({ entries: [] });
  return createTlhFooter(
    pi,
    ctx,
    theme,
    () => "architect",
    createFooterData(),
    {},
    null,
    undefined,
    store,
  );
}

function createFooterWithAuthHealthColorTheme(store) {
  const ctx = createCtx({ entries: [] });
  return createTlhFooter(
    pi,
    ctx,
    colorTheme,
    () => "architect",
    createFooterData(),
    {},
    null,
    undefined,
    store,
  );
}

test("reauth warning: no warning line when no providers are flagged", () => {
  const store = createProviderAuthHealthStore();
  const footer = createFooterWithAuthHealth(store);
  const lines = footer.render(WIDTH);
  assert.doesNotMatch(lines.join("\n"), /reauth/);
});

test("reauth warning: renders '⚠ reauth: anthropic' when anthropic is reauth-required", async () => {
  const store = await storeWithReauth("anthropic");
  const footer = createFooterWithAuthHealth(store);
  const lines = footer.render(WIDTH);
  assert.ok(
    lines.some((line) => line.includes("⚠ reauth: anthropic")),
    `Expected '⚠ reauth: anthropic' in: ${JSON.stringify(lines)}`,
  );
});

test("reauth warning: renders both providers in one comma-separated line when both are reauth-required", async () => {
  const store = await storeWithReauth("anthropic", "openai-codex");
  const footer = createFooterWithAuthHealth(store);
  const lines = footer.render(WIDTH);
  assert.ok(
    lines.some((line) => line.includes("⚠ reauth: anthropic, openai-codex")),
    `Expected '⚠ reauth: anthropic, openai-codex' in: ${JSON.stringify(lines)}`,
  );
});

test("reauth warning: uses warning color (color-aware theme)", async () => {
  const store = await storeWithReauth("anthropic");
  const footer = createFooterWithAuthHealthColorTheme(store);
  const lines = footer.render(COLOR_WIDTH);
  const warningLine = lines.find((l) => l.includes("reauth")) ?? "";
  assert.match(warningLine, /<warning>.*reauth.*<\/warning>/);
});

test("reauth warning: transient-unavailable renders nothing", async () => {
  const store = createProviderAuthHealthStore();
  await store.probeProvider(makeTransientRegistry("anthropic"), "anthropic");
  const footer = createFooterWithAuthHealth(store);
  const lines = footer.render(WIDTH);
  assert.doesNotMatch(lines.join("\n"), /reauth/);
});

test("reauth warning: unknown status renders nothing", async () => {
  const store = createProviderAuthHealthStore();
  // probeProvider on a registry without getProviderAuth resolves to 'unknown'
  // without recording any entry — await it so the store is settled before render.
  const status = await store.probeProvider({}, "anthropic");
  assert.equal(status, "unknown", "probe on registry without getProviderAuth must return unknown");
  // unknown status leaves no entry → footer must not show any reauth warning
  const footer = createFooterWithAuthHealth(store);
  const lines = footer.render(WIDTH);
  assert.doesNotMatch(lines.join("\n"), /reauth/);
});

test("reauth warning: warning is a dedicated line, not merged into extension-status line", async () => {
  const store = await storeWithReauth("anthropic");
  const ctx = createCtx({ entries: [] });
  const footerData = {
    ...createFooterData(),
    getExtensionStatuses: () => new Map([["ext-key", "ext-status-text"]]),
  };
  const footer = createTlhFooter(
    pi,
    ctx,
    theme,
    () => "architect",
    footerData,
    {},
    null,
    undefined,
    store,
  );
  const lines = footer.render(WIDTH);
  // The reauth warning and the extension status must not be on the same line.
  const reauthLine = lines.find((l) => l.includes("reauth"));
  const extStatusLine = lines.find((l) => l.includes("ext-status-text"));
  assert.ok(reauthLine, "expected a reauth warning line");
  assert.ok(extStatusLine, "expected an extension-status line");
  assert.notEqual(
    reauthLine,
    extStatusLine,
    "reauth warning and extension status must not share a line",
  );
});

test("reauth warning: warning line appears before cost/subscription lines", async () => {
  const store = await storeWithReauth("anthropic");
  // usingOAuth: false ensures suppressCost is false, so the cost line renders.
  const ctx = createCtx({ entries: [assistantCostEntry(1.0)], usingOAuth: false });
  const footer = createTlhFooter(
    pi,
    ctx,
    theme,
    () => "architect",
    createFooterData(),
    {},
    null,
    undefined,
    store,
  );
  const lines = footer.render(WIDTH);
  const reauthIdx = lines.findIndex((l) => l.includes("reauth"));
  const costIdx = lines.findIndex((l) => l.includes("$"));
  assert.ok(reauthIdx !== -1, "expected a reauth warning line");
  assert.ok(costIdx !== -1, "expected a cost line");
  assert.ok(
    reauthIdx < costIdx,
    `reauth line (${reauthIdx}) should appear before cost line (${costIdx})`,
  );
});

// ---------------------------------------------------------------------------
// formatReauthWarningLine — progressive degradation variant selection
// ---------------------------------------------------------------------------
// The identity theme is used throughout; colorTheme is used for color assertions.
// Widths are derived from visibleWidth() to remain robust if ⚠ has ambiguous width.

test("formatReauthWarningLine: returns undefined for empty provider list", () => {
  assert.equal(formatReauthWarningLine([], WIDTH, theme), undefined);
});

test("formatReauthWarningLine: single provider — full variant at generous width", () => {
  const result = formatReauthWarningLine(["anthropic"], WIDTH, theme);
  assert.equal(result, "⚠ reauth: anthropic");
});

test("formatReauthWarningLine: two providers — full variant when it fits", () => {
  const fullText = "⚠ reauth: anthropic, openai-codex";
  const fullWidth = visibleWidth(fullText);
  const result = formatReauthWarningLine(["anthropic", "openai-codex"], fullWidth, theme);
  assert.equal(
    result,
    fullText,
    `full variant must be chosen at its exact visible width (${fullWidth})`,
  );
});

test("formatReauthWarningLine: two providers — short-label variant when full does not fit", () => {
  const fullText = "⚠ reauth: anthropic, openai-codex";
  const shortText = "⚠ reauth: anthropic, codex";
  const fullWidth = visibleWidth(fullText);
  const shortWidth = visibleWidth(shortText);
  // Use a width that is one less than the full text but still accommodates the short variant.
  const testWidth = fullWidth - 1;
  assert.ok(
    shortWidth <= testWidth,
    "short variant must fit at testWidth for this test to be meaningful",
  );
  const result = formatReauthWarningLine(["anthropic", "openai-codex"], testWidth, theme);
  assert.equal(result, shortText, `short variant must be chosen at width=${testWidth}`);
});

test("formatReauthWarningLine: two providers — count-only variant when short label does not fit", () => {
  const shortText = "⚠ reauth: anthropic, codex";
  const countText = "⚠ reauth ×2";
  const shortWidth = visibleWidth(shortText);
  const testWidth = shortWidth - 1; // forces the count variant
  const result = formatReauthWarningLine(["anthropic", "openai-codex"], testWidth, theme);
  assert.equal(result, countText, `count variant must be chosen at width=${testWidth}`);
});

test('formatReauthWarningLine: "×2" count variant tells user both providers need attention at narrow width', () => {
  // At any width below the short label's visible width, the user must still see ×2.
  const shortText = "⚠ reauth: anthropic, codex";
  const shortWidth = visibleWidth(shortText);
  const tinyWidth = shortWidth - 1;
  const result = formatReauthWarningLine(["anthropic", "openai-codex"], tinyWidth, theme);
  assert.ok(
    result?.includes("×2"),
    `count variant must include "×2" at width ${tinyWidth}, got: ${result}`,
  );
});

test("formatReauthWarningLine: count-only variant never exceeds requested width — width contract at extreme narrowness", () => {
  // The count-only variant (e.g. '⚠ reauth ×2') is itself ~11-12 columns wide.
  // At a width below that, the prior code returned it unconditionally and violated
  // the invariant that every footer line fits within `width`. This test asserts
  // visibleWidth(result) <= width at a width of 5 — well below the count text.
  // It must FAIL against the un-patched code and PASS after the truncateToWidth fix.
  const narrowWidth = 5;
  const result = formatReauthWarningLine(["anthropic", "openai-codex"], narrowWidth, theme);
  assert.ok(
    result !== undefined,
    "result must not be undefined — count variant should always return something",
  );
  assert.ok(
    visibleWidth(result) <= narrowWidth,
    `visibleWidth(${JSON.stringify(result)}) must be <= ${narrowWidth}, got ${visibleWidth(result)}`,
  );
});

test('formatReauthWarningLine: short-label variant for openai-codex uses last hyphen-segment "codex"', () => {
  // Confirm the shortening rule: last segment after splitting on '-'.
  const fullText = "⚠ reauth: anthropic, openai-codex";
  const fullWidth = visibleWidth(fullText);
  const result = formatReauthWarningLine(["anthropic", "openai-codex"], fullWidth - 1, theme);
  assert.ok(
    result?.includes("codex") && !result.includes("openai"),
    `short label must use 'codex', got: ${result}`,
  );
});

test("formatReauthWarningLine: warning color applied to all variants (color-aware theme)", () => {
  const fullText = "⚠ reauth: anthropic, openai-codex";
  const fullWidth = visibleWidth(fullText);
  // full
  const r1 = formatReauthWarningLine(["anthropic", "openai-codex"], fullWidth, colorTheme);
  assert.match(r1 ?? "", /<warning>/, "full variant must use warning color");
  // short
  const r2 = formatReauthWarningLine(["anthropic", "openai-codex"], fullWidth - 1, colorTheme);
  assert.match(r2 ?? "", /<warning>/, "short variant must use warning color");
  // count
  const shortText = "⚠ reauth: anthropic, codex";
  const shortWidth = visibleWidth(shortText);
  const r3 = formatReauthWarningLine(["anthropic", "openai-codex"], shortWidth - 1, colorTheme);
  assert.match(r3 ?? "", /<warning>/, "count variant must use warning color");
});

test("reauth warning: footer integration — full variant renders at generous width", async () => {
  const store = await storeWithReauth("anthropic", "openai-codex");
  const footer = createFooterWithAuthHealth(store);
  const lines = footer.render(WIDTH);
  const warningLine = lines.find((l) => l.includes("reauth")) ?? "";
  assert.ok(
    warningLine.includes("anthropic") && warningLine.includes("openai-codex"),
    `Both full provider names must be present at width=${WIDTH}: ${warningLine}`,
  );
});

test("reauth warning: footer integration — count variant at narrow width keeps both-provider signal", async () => {
  const shortText = "⚠ reauth: anthropic, codex";
  const shortWidth = visibleWidth(shortText);
  const tinyWidth = shortWidth - 1; // forces count variant
  const store = await storeWithReauth("anthropic", "openai-codex");
  const ctx = createCtx({ entries: [] });
  const footer = createTlhFooter(
    pi,
    ctx,
    theme,
    () => "architect",
    createFooterData(),
    {},
    null,
    undefined,
    store,
  );
  const lines = footer.render(tinyWidth);
  const warningLine = lines.find((l) => l.includes("reauth")) ?? "";
  assert.ok(
    warningLine.includes("×2"),
    `count variant (×2) must appear at narrow width=${tinyWidth}, got: ${warningLine}`,
  );
});

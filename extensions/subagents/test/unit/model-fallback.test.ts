import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendRuntimeFallbackResolution,
  buildFallbackModelList,
  buildModelCandidatePlan,
  buildModelCandidates,
  combineModelFallbackNotices,
  canonicalSubagentModelIdentity,
  fuzzyResolveModel,
  isRetryableModelFailure,
  modelReferenceFromIdentity,
  normalizeModelSegment,
  resolveModelCandidate,
  resolveRuntimeModelContext,
  resolveSubagentModelOverride,
  sanitizeModelFallbackNotice,
  sanitizeSubagentModelIdentity,
} from "../../src/runs/shared/model-fallback.ts";
import type { ModelScopeConfig } from "../../src/runs/shared/model-scope.ts";

describe("model fallback helpers", () => {
  const availableModels = [
    { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
    { provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
  ];

  it("keeps explicit provider/model ids unchanged", () => {
    assert.equal(resolveModelCandidate("openai/gpt-5-mini", availableModels), "openai/gpt-5-mini");
  });

  it("resolves exact runtime identities with nested slash and colon model ids", () => {
    const contextWindows = {
      "mock/test-model": 1000,
      "openrouter/anthropic/claude-3.5-sonnet": 4096,
      "ollama/qwen3:8b": 8192,
    };
    assert.deepEqual(resolveRuntimeModelContext("mock", "test-model", contextWindows), {
      identity: { provider: "mock", model: "test-model" },
      contextWindow: 1000,
    });
    assert.deepEqual(
      resolveRuntimeModelContext("openrouter", "anthropic/claude-3.5-sonnet:high", contextWindows),
      {
        identity: {
          provider: "openrouter",
          model: "anthropic/claude-3.5-sonnet",
          thinking: "high",
        },
        contextWindow: 4096,
      },
    );
    assert.deepEqual(resolveRuntimeModelContext("ollama", "qwen3:8b", contextWindows), {
      identity: { provider: "ollama", model: "qwen3:8b" },
      contextWindow: 8192,
    });
    assert.deepEqual(
      resolveRuntimeModelContext(
        undefined,
        "openrouter/anthropic/claude-3.5-sonnet:low",
        contextWindows,
      ),
      {
        identity: { provider: "openrouter", model: "anthropic/claude-3.5-sonnet", thinking: "low" },
        contextWindow: 4096,
      },
    );
  });

  it("rejects malformed, mismatched, missing, inherited, and unregistered runtime identities", () => {
    const contextWindows = { "mock/test-model": 1000, "other/test-model": 2000 };
    assert.equal(resolveRuntimeModelContext(undefined, undefined, contextWindows), undefined);
    assert.equal(resolveRuntimeModelContext(undefined, 42, contextWindows), undefined);
    assert.equal(resolveRuntimeModelContext(null, "test-model", contextWindows), undefined);
    assert.equal(
      resolveRuntimeModelContext("bad provider", "test-model", contextWindows),
      undefined,
    );
    assert.equal(resolveRuntimeModelContext("mock", "/model", contextWindows), undefined);
    assert.equal(resolveRuntimeModelContext("mock", "model/", contextWindows), undefined);
    assert.equal(resolveRuntimeModelContext("other", "mock/test-model", contextWindows), undefined);
    assert.equal(resolveRuntimeModelContext("mock", "missing-model", contextWindows), undefined);
    assert.equal(resolveRuntimeModelContext(undefined, "test-model", contextWindows), undefined);

    const inheritedContextWindows = Object.create({ "mock/inherited-model": 3000 }) as Record<
      string,
      number
    >;
    assert.equal(
      resolveRuntimeModelContext("mock", "inherited-model", inheritedContextWindows),
      undefined,
    );
  });

  it("resolves a bare id when there is exactly one registry match", () => {
    assert.equal(resolveModelCandidate("gpt-5-mini", availableModels), "openai/gpt-5-mini");
  });

  it("preserves thinking suffix when resolving a bare id", () => {
    assert.equal(
      resolveModelCandidate("gpt-5-mini:high", availableModels),
      "openai/gpt-5-mini:high",
    );
  });

  it("leaves ambiguous bare ids untouched", () => {
    const ambiguous = [
      ...availableModels,
      { provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
    ];
    assert.equal(resolveModelCandidate("gpt-5-mini", ambiguous), "gpt-5-mini");
  });

  it("prefers the current provider when an ambiguous bare id exists there", () => {
    const ambiguous = [
      ...availableModels,
      { provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
    ];
    assert.equal(
      resolveModelCandidate("gpt-5-mini", ambiguous, "github-copilot"),
      "github-copilot/gpt-5-mini",
    );
  });

  it("falls back to the unique registry match when the current provider does not offer the model", () => {
    assert.equal(
      resolveModelCandidate("claude-sonnet-4", availableModels, "github-copilot"),
      "anthropic/claude-sonnet-4",
    );
  });

  it("builds a deduplicated ordered candidate list", () => {
    assert.deepEqual(
      buildModelCandidates(
        "gpt-5-mini",
        ["openai/gpt-5-mini", "anthropic/claude-sonnet-4", "gpt-5-mini"],
        availableModels,
      ),
      ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"],
    );
  });

  it("filters only positively unavailable catalog entries and keeps partial unknowns", () => {
    const primary = { provider: "openai", id: "primary", fullId: "openai/primary" };
    const knownUnavailable = {
      provider: "anthropic",
      id: "known-backup",
      fullId: "anthropic/known-backup",
    };
    const availableBackup = {
      provider: "google",
      id: "available-backup",
      fullId: "google/available-backup",
    };
    const plan = buildModelCandidatePlan(
      primary.fullId,
      [knownUnavailable.fullId, "stale/unknown-backup", availableBackup.fullId],
      [primary, availableBackup],
      undefined,
      { registry: { allModels: [primary, knownUnavailable, availableBackup] } },
    );

    assert.deepEqual(plan.candidates, [
      primary.fullId,
      "stale/unknown-backup",
      availableBackup.fullId,
    ]);
    assert.deepEqual(plan.filteredFallbackModels, [knownUnavailable.fullId]);
    assert.match(plan.filteringNotice ?? "", /provider credentials|fallbackModels/);
  });

  it("fails open for empty, stale, and missing registry views", () => {
    const primary = "openai/primary";
    const fallback = "anthropic/backup";
    const catalog = [
      { provider: "openai", id: "primary", fullId: primary },
      { provider: "anthropic", id: "backup", fullId: fallback },
    ];
    for (const registry of [
      { allModels: [] },
      { allModels: catalog, error: "availability refresh failed" },
      undefined,
    ]) {
      const plan = buildModelCandidatePlan(
        primary,
        [fallback],
        [],
        undefined,
        registry ? { registry } : undefined,
      );
      assert.deepEqual(plan.candidates, [primary, fallback]);
      assert.deepEqual(plan.filteredFallbackModels, []);
      assert.equal(plan.filteringNotice, undefined);
    }
  });

  it("keeps the full configured fallback chain for a populated catalog with empty availability", () => {
    const catalog = [
      { provider: "openai", id: "primary", fullId: "openai/primary" },
      { provider: "anthropic", id: "backup", fullId: "anthropic/backup" },
    ];
    const plan = buildModelCandidatePlan(
      catalog[0]!.fullId,
      [catalog[1]!.fullId, "stale/unknown-backup"],
      [],
      undefined,
      { registry: { allModels: catalog } },
    );
    assert.deepEqual(plan.candidates, [
      catalog[0]!.fullId,
      catalog[1]!.fullId,
      "stale/unknown-backup",
    ]);
    assert.deepEqual(plan.filteredFallbackModels, []);
    assert.equal(plan.filteringNotice, undefined);
  });

  it("preserves the primary while filtering every known fallback in a complete catalog", () => {
    const catalog = [
      { provider: "openai", id: "primary", fullId: "openai/primary" },
      { provider: "anthropic", id: "backup-a", fullId: "anthropic/backup-a" },
      { provider: "google", id: "backup-b", fullId: "google/backup-b" },
    ];
    const plan = buildModelCandidatePlan(
      catalog[0]!.fullId,
      [catalog[1]!.fullId, catalog[2]!.fullId],
      [catalog[0]!],
      undefined,
      { registry: { allModels: catalog } },
    );
    assert.deepEqual(plan.candidates, [catalog[0]!.fullId]);
    assert.deepEqual(plan.filteredFallbackModels, [catalog[1]!.fullId, catalog[2]!.fullId]);
    assert.ok(plan.filteringNotice);
    assert.ok(plan.filteringNotice!.length <= 240);
  });

  it("matches qualified ids but retains ambiguous unqualified ids", () => {
    const catalog = [
      { provider: "openai", id: "primary", fullId: "openai/primary" },
      { provider: "openai", id: "backup", fullId: "openai/backup" },
      { provider: "anthropic", id: "backup", fullId: "anthropic/backup" },
    ];
    const plan = buildModelCandidatePlan(
      "openai/primary",
      ["openai/backup", "backup"],
      [catalog[0]!],
      undefined,
      { registry: { allModels: catalog } },
    );
    assert.deepEqual(plan.candidates, ["openai/primary", "backup"]);
    assert.deepEqual(plan.filteredFallbackModels, ["openai/backup"]);
  });

  it("matches registry ids that contain a colon without losing the fallback suffix", () => {
    const catalog = [
      { provider: "openai", id: "primary", fullId: "openai/primary" },
      { provider: "ollama", id: "qwen3:high", fullId: "ollama/qwen3:high" },
    ];
    const plan = buildModelCandidatePlan(
      catalog[0]!.fullId,
      [catalog[1]!.fullId],
      [catalog[0]!],
      undefined,
      { registry: { allModels: catalog } },
    );
    assert.deepEqual(plan.candidates, [catalog[0]!.fullId]);
    assert.deepEqual(plan.filteredFallbackModels, [catalog[1]!.fullId]);
  });

  it("keeps a dated alias when its normalized dispatch candidate is available", () => {
    const primary = { provider: "openai", id: "primary", fullId: "openai/primary" };
    const canonical = {
      provider: "anthropic",
      id: "claude-haiku-4-5",
      fullId: "anthropic/claude-haiku-4-5",
    };
    const datedAlias = "anthropic/claude-haiku-4-5-20251001";
    const plan = buildModelCandidatePlan(
      primary.fullId,
      [datedAlias],
      [primary, canonical],
      undefined,
      { registry: { allModels: [primary, canonical] } },
    );
    assert.deepEqual(plan.candidates, [primary.fullId, canonical.fullId]);
    assert.deepEqual(plan.filteredFallbackModels, []);
    assert.equal(plan.filteringNotice, undefined);
  });

  it("keeps a preferred-provider bare id when its normalized candidate is available", () => {
    const primary = { provider: "openai", id: "primary", fullId: "openai/primary" };
    const openaiModel = { provider: "openai", id: "shared", fullId: "openai/shared" };
    const preferredModel = {
      provider: "github-copilot",
      id: "shared",
      fullId: "github-copilot/shared",
    };
    const plan = buildModelCandidatePlan(
      primary.fullId,
      ["shared"],
      [primary, preferredModel],
      "github-copilot",
      { registry: { allModels: [primary, openaiModel, preferredModel] } },
    );
    assert.deepEqual(plan.candidates, [primary.fullId, preferredModel.fullId]);
    assert.deepEqual(plan.filteredFallbackModels, []);
    assert.equal(plan.filteringNotice, undefined);
  });

  it("deduplicates duplicate filtered and retained fallback candidates", () => {
    const catalog = [
      { provider: "openai", id: "primary", fullId: "openai/primary" },
      { provider: "anthropic", id: "backup", fullId: "anthropic/backup" },
    ];
    const filtered = buildModelCandidatePlan(
      catalog[0]!.fullId,
      ["anthropic/backup", "anthropic/backup"],
      [catalog[0]!],
      undefined,
      { registry: { allModels: catalog } },
    );
    assert.deepEqual(filtered.candidates, [catalog[0]!.fullId]);
    assert.deepEqual(filtered.filteredFallbackModels, ["anthropic/backup"]);

    const retained = buildModelCandidatePlan(
      catalog[0]!.fullId,
      ["unknown/backup", "unknown/backup"],
      [catalog[0]!],
      undefined,
      { registry: { allModels: catalog } },
    );
    assert.deepEqual(retained.candidates, [catalog[0]!.fullId, "unknown/backup"]);
  });

  it("applies the current provider preference to fallback candidates too", () => {
    const ambiguous = [
      ...availableModels,
      { provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
    ];
    assert.deepEqual(
      buildModelCandidates(
        "gpt-5-mini",
        ["gpt-5-mini", "anthropic/claude-sonnet-4"],
        ambiguous,
        "github-copilot",
      ),
      ["github-copilot/gpt-5-mini", "anthropic/claude-sonnet-4"],
    );
  });

  it("orders per-dispatch fallback models before agent fallback models and dedupes overlaps", () => {
    assert.deepEqual(
      buildFallbackModelList(
        ["anthropic/claude-sonnet-4", "openai/gpt-5-mini", "anthropic/claude-sonnet-4"],
        ["openai/gpt-5-mini", "google/gemini-2.5-pro"],
      ),
      ["anthropic/claude-sonnet-4", "openai/gpt-5-mini", "google/gemini-2.5-pro"],
    );
    assert.equal(buildFallbackModelList(undefined, undefined), undefined);
  });

  it("records every completed fallback transition in order", () => {
    const original = canonicalSubagentModelIdentity("openai/a")!;
    const b = canonicalSubagentModelIdentity("anthropic/b")!;
    const c = canonicalSubagentModelIdentity("google/c")!;
    const aAttempt = { model: "openai/a", success: false, exitCode: 1, error: "a unavailable" };
    const bAttempt = { model: "anthropic/b", success: false, exitCode: 1, error: "b unavailable" };
    const afterB = appendRuntimeFallbackResolution({
      sourceAttempt: aAttempt,
      currentIdentity: b,
      originalIdentity: original,
    });
    const afterC = appendRuntimeFallbackResolution({
      previous: afterB,
      sourceAttempt: bAttempt,
      currentIdentity: c,
      originalIdentity: original,
    });
    assert.deepEqual(afterC?.original, original);
    assert.deepEqual(afterC?.resumed, c);
    assert.match(afterC?.reason ?? "", /openai\/a.*anthropic\/b/);
    assert.match(afterC?.reason ?? "", /anthropic\/b.*google\/c/);
  });

  it("sanitizes fallback notices for one-line display", () => {
    assert.equal(
      sanitizeModelFallbackNotice("  quota hit\nretry on the backup\tmodel  "),
      "quota hit retry on the backup model",
    );
    assert.equal(sanitizeModelFallbackNotice("\u0000\u0001\n\t"), undefined);
    assert.equal(sanitizeModelFallbackNotice(undefined), undefined);
  });

  it("detects retryable provider/model failures", () => {
    assert.equal(isRetryableModelFailure("rate limit exceeded for provider"), true);
    assert.equal(isRetryableModelFailure("model unavailable"), true);
    assert.equal(isRetryableModelFailure("authentication failed"), true);
    assert.equal(
      isRetryableModelFailure(
        "Subagent produced no output (possible model cold-start or empty response).",
      ),
      true,
    );
    assert.equal(isRetryableModelFailure("model load failed"), true);
  });

  it("does not treat ordinary task/tool failures as retryable model failures", () => {
    assert.equal(isRetryableModelFailure("bash failed (exit 1): command not found"), false);
    assert.equal(isRetryableModelFailure("read failed (exit 1): no such file or directory"), false);
    assert.equal(isRetryableModelFailure(undefined), false);
  });

  it("ports only the verified usage-limit and stream-end retry signals", () => {
    // Added retry classifications: /usage\\s*limit/i and the exact Pi provider
    // error /stream ended without finish_reason/i. A generic finish_reason is
    // intentionally not retryable.
    assert.equal(isRetryableModelFailure("The usage limit has been reached"), true);
    assert.equal(isRetryableModelFailure("Stream ended without finish_reason"), true);
    assert.equal(isRetryableModelFailure("Provider finish_reason: length"), false);
    assert.equal(isRetryableModelFailure("Provider finish_reason: content_filter"), false);
    assert.equal(isRetryableModelFailure("Provider finish_reason: network_error"), false);
    assert.equal(isRetryableModelFailure("provider transport failed"), false);
    assert.equal(isRetryableModelFailure("usage limit"), true);
  });

  it("does not retry network-flavored child tool failures", () => {
    // The tool-failure guard is a classification correction, not a new retry
    // pattern: retrying another model would rerun the failed task unchanged.
    assert.equal(
      isRetryableModelFailure(
        "bash failed (exit 1): requests.exceptions.ConnectionError: Connection error.",
      ),
      false,
    );
    assert.equal(isRetryableModelFailure("mcp.server/write failed with exit code 1"), false);
    assert.equal(isRetryableModelFailure("Provider error: request timed out"), true);
  });

  it("combines notices within the same bounded display contract", () => {
    const combined = combineModelFallbackNotices(
      "Skipped unavailable fallback model (backup). Check provider credentials or update fallbackModels; the primary model was retained.",
      "Configured review fallback used",
    );
    assert.ok(combined);
    assert.ok(combined!.length <= 240);
    assert.match(combined!, /Skipped unavailable fallback model/);
    assert.match(combined!, /provider credentials/);

    const longConfigured = combineModelFallbackNotices("x".repeat(240), combined);
    assert.ok(longConfigured!.length <= 240);
    assert.match(longConfigured!, /provider credentials|fallbackModels/);

    const highPriority = `Registry filtering notice ${"detail ".repeat(30)}`;
    const safeHighPriority = sanitizeModelFallbackNotice(highPriority)!;
    const droppedFragment = combineModelFallbackNotices(
      "Configured fallback was used",
      highPriority,
    );
    assert.equal(droppedFragment, safeHighPriority);
    assert.ok(droppedFragment.length <= 240);
    assert.doesNotMatch(droppedFragment, /Configured|Config/);
  });
});

describe("resolveSubagentModelOverride (cross-session inherit, issue #266)", () => {
  const availableModels = [
    { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
    { provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
  ];
  const parentModel = { provider: "deepseek", id: "deepseek-v4-flash" };

  it("inherits the parent session model when no model is requested", () => {
    // The crux of the bug: an undefined model must NOT collapse to `undefined`
    // (which leaves the child to read the shared global settings.json), but
    // must pin the parent session's in-memory provider/id.
    assert.equal(
      resolveSubagentModelOverride(undefined, parentModel, availableModels),
      "deepseek/deepseek-v4-flash",
    );
  });

  it('inherits the parent session model when the model is the "inherit" sentinel', () => {
    assert.equal(
      resolveSubagentModelOverride("inherit", parentModel, availableModels),
      "deepseek/deepseek-v4-flash",
    );
  });

  it("inherits the parent session model when the agent config sets model: false (delegate)", () => {
    assert.equal(
      resolveSubagentModelOverride(false, parentModel, availableModels),
      "deepseek/deepseek-v4-flash",
    );
  });

  it("treats an empty or whitespace-only model as inherit", () => {
    assert.equal(
      resolveSubagentModelOverride("", parentModel, availableModels),
      "deepseek/deepseek-v4-flash",
    );
    assert.equal(
      resolveSubagentModelOverride("   ", parentModel, availableModels),
      "deepseek/deepseek-v4-flash",
    );
  });

  it('trims surrounding whitespace from the "inherit" sentinel', () => {
    assert.equal(
      resolveSubagentModelOverride("  inherit  ", parentModel, availableModels),
      "deepseek/deepseek-v4-flash",
    );
  });

  it("keeps an explicit provider/id model unchanged", () => {
    assert.equal(
      resolveSubagentModelOverride("anthropic/claude-sonnet-4", parentModel, availableModels),
      "anthropic/claude-sonnet-4",
    );
  });

  it("resolves an explicit bare id against the registry, not the parent", () => {
    assert.equal(
      resolveSubagentModelOverride("gpt-5-mini", parentModel, availableModels),
      "openai/gpt-5-mini",
    );
  });

  it("returns undefined when inheriting but no parent model is known", () => {
    // No parent session model available: fall back to the prior behavior of
    // emitting no override rather than inventing an invalid one.
    assert.equal(resolveSubagentModelOverride(undefined, undefined, availableModels), undefined);
    assert.equal(resolveSubagentModelOverride("inherit", undefined, availableModels), undefined);
    assert.equal(resolveSubagentModelOverride(false, undefined, availableModels), undefined);
  });

  it('never emits the literal "inherit" string as a model', () => {
    // Regression guard: the old resolveModelCandidate returned "inherit" verbatim
    // (no registry match), which the child rejected and silently fell back to
    // the global default.
    assert.notEqual(
      resolveSubagentModelOverride("inherit", parentModel, availableModels),
      "inherit",
    );
    assert.notEqual(resolveSubagentModelOverride("inherit", undefined, availableModels), "inherit");
  });
});

describe("fuzzyResolveModel / normalizeModelSegment", () => {
  const registry = [
    { provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
    { provider: "anthropic", id: "claude-haiku-4-5", fullId: "anthropic/claude-haiku-4-5" },
    { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
    { provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
  ];

  it("normalizes dots, underscores, case, and repeated dashes", () => {
    assert.equal(normalizeModelSegment("Claude.Sonnet_4"), "claude-sonnet-4");
    assert.equal(normalizeModelSegment("GPT--5.Mini"), "gpt-5-mini");
  });

  it("fuzzy-matches a bare id with separator/case differences", () => {
    assert.equal(fuzzyResolveModel("Claude-Sonnet-4", registry), "anthropic/claude-sonnet-4");
    assert.equal(fuzzyResolveModel("claude.haiku.4.5", registry), "anthropic/claude-haiku-4-5");
  });

  it("fuzzy-matches a bare id with an optional trailing date stamp", () => {
    assert.equal(
      fuzzyResolveModel("claude-haiku-4-5-20251001", registry),
      "anthropic/claude-haiku-4-5",
    );
    assert.equal(
      fuzzyResolveModel("claude-haiku-4-5-2025-10-01", registry),
      "anthropic/claude-haiku-4-5",
    );
  });

  it("does not strip arbitrary trailing 8-digit numbers as date stamps", () => {
    const numbered = [{ provider: "test", id: "model", fullId: "test/model" }];
    assert.equal(fuzzyResolveModel("model-12345678", numbered), undefined);
  });

  it("fuzzy-matches an undated query against a dated registry id", () => {
    const dated = [
      {
        provider: "anthropic",
        id: "claude-3-5-sonnet-20241022",
        fullId: "anthropic/claude-3-5-sonnet-20241022",
      },
      { provider: "openai", id: "gpt-5-2025-10-01", fullId: "openai/gpt-5-2025-10-01" },
    ];
    assert.equal(
      fuzzyResolveModel("claude-3-5-sonnet", dated),
      "anthropic/claude-3-5-sonnet-20241022",
    );
    assert.equal(fuzzyResolveModel("gpt-5", dated), "openai/gpt-5-2025-10-01");
  });

  it("fuzzy-matches a qualified provider/id with case/separator differences", () => {
    assert.equal(
      fuzzyResolveModel("Anthropic/Claude-Sonnet-4", registry),
      "anthropic/claude-sonnet-4",
    );
    assert.equal(
      fuzzyResolveModel("Anthropic:Claude-Sonnet-4", registry),
      "anthropic/claude-sonnet-4",
    );
    assert.equal(
      fuzzyResolveModel("anthropic.claude.haiku.4.5", registry),
      "anthropic/claude-haiku-4-5",
    );
    assert.equal(
      fuzzyResolveModel("anthropic/claude.haiku.4.5", registry),
      "anthropic/claude-haiku-4-5",
    );
  });

  it("does not switch providers for a qualified query", () => {
    // Named provider has no such model; do not fall back to another provider.
    assert.equal(fuzzyResolveModel("openai/claude-sonnet-4", registry), undefined);
    assert.equal(fuzzyResolveModel("github-copilot/claude-haiku-4-5", registry), undefined);
  });

  it("prefers the current provider for an ambiguous bare fuzzy id", () => {
    assert.equal(
      fuzzyResolveModel("GPT.5.Mini", registry, "github-copilot"),
      "github-copilot/gpt-5-mini",
    );
  });

  it("returns undefined for an ambiguous bare fuzzy id with no preferred provider", () => {
    assert.equal(fuzzyResolveModel("gpt-5-mini", registry), undefined);
  });

  it("returns undefined when nothing fuzzy-matches", () => {
    assert.equal(fuzzyResolveModel("does-not-exist", registry), undefined);
    assert.equal(fuzzyResolveModel("anthropic/does-not-exist", registry), undefined);
  });
});

describe("resolveModelCandidate fuzzy fallback", () => {
  const registry = [
    { provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
    { provider: "anthropic", id: "claude-haiku-4-5", fullId: "anthropic/claude-haiku-4-5" },
  ];

  it("resolves a bare id with case/separator differences via fuzzy fallback", () => {
    assert.equal(resolveModelCandidate("Claude-Sonnet-4", registry), "anthropic/claude-sonnet-4");
    assert.equal(resolveModelCandidate("claude.haiku.4.5", registry), "anthropic/claude-haiku-4-5");
  });

  it("resolves a bare id with a trailing date stamp via fuzzy fallback", () => {
    assert.equal(
      resolveModelCandidate("claude-haiku-4-5-20251001", registry),
      "anthropic/claude-haiku-4-5",
    );
  });

  it("resolves a qualified provider/id with case differences via fuzzy fallback", () => {
    assert.equal(
      resolveModelCandidate("Anthropic/Claude-Sonnet-4", registry),
      "anthropic/claude-sonnet-4",
    );
    assert.equal(
      resolveModelCandidate("Anthropic:Claude-Sonnet-4", registry),
      "anthropic/claude-sonnet-4",
    );
  });

  it("preserves the thinking suffix through fuzzy resolution", () => {
    assert.equal(
      resolveModelCandidate("claude.haiku.4.5:high", registry),
      "anthropic/claude-haiku-4-5:high",
    );
    assert.equal(
      resolveModelCandidate("anthropic:claude.sonnet.4:high", registry),
      "anthropic/claude-sonnet-4:high",
    );
  });

  it("still prefers exact registry matches over fuzzy", () => {
    assert.equal(
      resolveModelCandidate("anthropic/claude-sonnet-4", registry),
      "anthropic/claude-sonnet-4",
    );
  });

  it("leaves an unknown qualified model unchanged instead of switching providers", () => {
    assert.equal(
      resolveModelCandidate("openai/claude-sonnet-4", registry),
      "openai/claude-sonnet-4",
    );
  });

  it("leaves an unknown bare id unchanged when no fuzzy match exists", () => {
    assert.equal(resolveModelCandidate("does-not-exist", registry), "does-not-exist");
  });
});

describe("resolveSubagentModelOverride scope enforcement", () => {
  const availableModels = [
    { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
    { provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
    { provider: "deepseek", id: "deepseek-v4", fullId: "deepseek/deepseek-v4" },
  ];
  const parentModel = { provider: "deepseek", id: "deepseek-v4" };
  const scope: ModelScopeConfig = { enforce: true, allow: ["anthropic/*", "openai/gpt-5-*"] };

  it("is a no-op when scope is not enforced", () => {
    assert.equal(
      resolveSubagentModelOverride(
        "deepseek/deepseek-v4",
        parentModel,
        availableModels,
        undefined,
        {
          scope: { enforce: false, allow: ["anthropic/*"] },
          source: "explicit",
        },
      ),
      "deepseek/deepseek-v4",
    );
  });

  it("throws for an explicit out-of-scope model", () => {
    assert.throws(
      () =>
        resolveSubagentModelOverride(
          "deepseek/deepseek-v4",
          parentModel,
          availableModels,
          undefined,
          {
            scope,
            source: "explicit",
          },
        ),
      /outside the configured subagent model scope/,
    );
  });

  it("warns (and still returns the model) for an inherited out-of-scope model", () => {
    const warnings: string[] = [];
    const resolved = resolveSubagentModelOverride(
      "deepseek/deepseek-v4",
      parentModel,
      availableModels,
      undefined,
      {
        scope,
        source: "inherited",
        onWarn: (v) => warnings.push(v.message),
      },
    );
    assert.equal(resolved, "deepseek/deepseek-v4");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /outside the configured subagent model scope/);
  });

  it("warns for an inherited parent-session model that is out of scope", () => {
    const warnings: string[] = [];
    // No explicit model requested: inherits the parent (deepseek), which is out of scope.
    const resolved = resolveSubagentModelOverride(
      undefined,
      parentModel,
      availableModels,
      undefined,
      {
        scope,
        onWarn: (v) => warnings.push(v.message),
      },
    );
    assert.equal(resolved, "deepseek/deepseek-v4");
    assert.equal(warnings.length, 1);
  });

  it("passes through an in-scope explicit model without warning or error", () => {
    const warnings: string[] = [];
    const resolved = resolveSubagentModelOverride(
      "gpt-5-mini",
      parentModel,
      availableModels,
      undefined,
      {
        scope,
        source: "explicit",
        onWarn: (v) => warnings.push(v.message),
      },
    );
    assert.equal(resolved, "openai/gpt-5-mini");
    assert.equal(warnings.length, 0);
  });

  it("checks the resolved (canonicalized) model against the scope", () => {
    // Fuzzy-resolves Claude-Sonnet-4 -> anthropic/claude-sonnet-4, which is in scope.
    const warnings: string[] = [];
    const resolved = resolveSubagentModelOverride(
      "Claude-Sonnet-4",
      parentModel,
      availableModels,
      undefined,
      {
        scope,
        source: "explicit",
        onWarn: (v) => warnings.push(v.message),
      },
    );
    assert.equal(resolved, "anthropic/claude-sonnet-4");
    assert.equal(warnings.length, 0);
  });

  it("ignores a thinking suffix when checking scope", () => {
    const warnings: string[] = [];
    const resolved = resolveSubagentModelOverride(
      "gpt-5-mini:high",
      parentModel,
      availableModels,
      undefined,
      {
        scope,
        source: "explicit",
        onWarn: (v) => warnings.push(v.message),
      },
    );
    assert.equal(resolved, "openai/gpt-5-mini:high");
    assert.equal(warnings.length, 0);
  });

  it("warns for out-of-scope fallback models while keeping them available", () => {
    const warnings: string[] = [];
    const candidates = buildModelCandidates(
      "gpt-5-mini",
      ["deepseek/deepseek-v4"],
      availableModels,
      undefined,
      {
        scope,
        onWarn: (v) => warnings.push(v.message),
      },
    );
    assert.deepEqual(candidates, ["openai/gpt-5-mini", "deepseek/deepseek-v4"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /deepseek\/deepseek-v4/);
  });
});

describe("canonical subagent model identity", () => {
  it("trims persisted provider/model identity before downstream reference use", () => {
    const persisted = { provider: "  anthropic  ", model: "  claude-sonnet-4  ", thinking: "high" };
    const identity = sanitizeSubagentModelIdentity(persisted);

    assert.deepEqual(identity, {
      provider: "anthropic",
      model: "claude-sonnet-4",
      thinking: "high",
    });
    assert.notEqual(identity, persisted);
    assert.equal(modelReferenceFromIdentity(identity!), "anthropic/claude-sonnet-4");
    assert.deepEqual(
      canonicalSubagentModelIdentity(modelReferenceFromIdentity(identity!), identity?.thinking),
      identity,
    );
  });

  it("extracts provider, model, and thinking from a suffixed reference", () => {
    assert.deepEqual(canonicalSubagentModelIdentity("anthropic/claude-sonnet-4:high"), {
      provider: "anthropic",
      model: "claude-sonnet-4",
      thinking: "high",
    });
  });

  it("preserves separately supplied effective thinking when the model has no suffix", () => {
    // Regression: the async runner's running/crash-recovery status updates
    // must not drop thinking that is supplied alongside a bare model arg.
    assert.deepEqual(canonicalSubagentModelIdentity("anthropic/claude-sonnet-4", "high"), {
      provider: "anthropic",
      model: "claude-sonnet-4",
      thinking: "high",
    });
  });

  it("prefers an explicit model suffix over separately supplied thinking", () => {
    assert.deepEqual(canonicalSubagentModelIdentity("anthropic/claude-sonnet-4:low", "high"), {
      provider: "anthropic",
      model: "claude-sonnet-4",
      thinking: "low",
    });
  });

  it("ignores unknown thinking values instead of persisting them", () => {
    assert.deepEqual(canonicalSubagentModelIdentity("anthropic/claude-sonnet-4", "turbo"), {
      provider: "anthropic",
      model: "claude-sonnet-4",
    });
  });

  it("returns undefined for provider-less or empty model references", () => {
    assert.equal(canonicalSubagentModelIdentity("claude-sonnet-4", "high"), undefined);
    assert.equal(canonicalSubagentModelIdentity(undefined, "high"), undefined);
  });

  it("round-trips identities back to provider/model references", () => {
    assert.equal(
      modelReferenceFromIdentity({
        provider: "anthropic",
        model: "claude-sonnet-4",
        thinking: "high",
      }),
      "anthropic/claude-sonnet-4",
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendRuntimeFallbackResolution,
  buildFallbackModelList,
  buildModelCandidatePlan,
  canonicalSubagentModelIdentity,
  deduplicateModelCandidates,
  isRetryableModelFailure,
  modelReferenceFromIdentity,
  resolveSubagentModelOverride,
  sanitizeModelFallbackNotice,
  sanitizeSubagentModelIdentity,
} from "../../src/runs/shared/model-fallback.ts";
import type { ModelScopeConfig } from "../../src/runs/shared/model-scope.ts";

describe("model fallback helpers", () => {
  it("forwards explicit model overrides exactly without registry resolution", () => {
    const explicit = "Anthropic/Claude.Sonnet-4-20251001:high";
    assert.equal(
      resolveSubagentModelOverride(explicit, { provider: "openai", id: "gpt-5" }),
      explicit,
    );
  });

  it("inherits the parent model for omitted, false, empty, and inherit values", () => {
    const parent = { provider: "deepseek", id: "deepseek-v4" };
    for (const requested of [undefined, false, "", "  ", " inherit "]) {
      assert.equal(resolveSubagentModelOverride(requested, parent), "deepseek/deepseek-v4");
    }
    assert.equal(resolveSubagentModelOverride(undefined, undefined), undefined);
  });

  it("builds a stable exact-string candidate order and deduplicates only exact repeats", () => {
    assert.deepEqual(
      buildModelCandidatePlan("openai/GPT-5", [
        "anthropic/claude-4",
        "openai/GPT-5",
        "anthropic/claude-4",
      ]),
      { candidates: ["openai/GPT-5", "anthropic/claude-4"] },
    );
    assert.deepEqual(buildModelCandidatePlan(undefined, ["  backup  ", "backup"]), {
      candidates: ["backup"],
    });
  });

  it("merges provider-aware and frontmatter fallback lists in order", () => {
    assert.deepEqual(
      buildFallbackModelList(
        ["anthropic/claude-sonnet-4", "openai/gpt-5", "anthropic/claude-sonnet-4"],
        ["openai/gpt-5", "google/gemini"],
      ),
      ["anthropic/claude-sonnet-4", "openai/gpt-5", "google/gemini"],
    );
    assert.equal(buildFallbackModelList(undefined, undefined), undefined);
  });

  it("does nothing when model scope enforcement is disabled", () => {
    assert.equal(
      resolveSubagentModelOverride(
        "deepseek/deepseek-v4",
        { provider: "deepseek", id: "deepseek-v4" },
        {
          scope: { enforce: false, allow: ["anthropic/*"] },
          source: "explicit",
        },
      ),
      "deepseek/deepseek-v4",
    );
  });

  it("rejects an explicit model outside the enforced scope", () => {
    assert.throws(
      () =>
        resolveSubagentModelOverride(
          "deepseek/deepseek-v4",
          { provider: "deepseek", id: "deepseek-v4" },
          { scope: { enforce: true, allow: ["anthropic/*"] }, source: "explicit" },
        ),
      /outside the configured subagent model scope/,
    );
  });

  it("warns for inherited parent and explicit out-of-scope models without changing them", () => {
    const warnings: string[] = [];
    const options = {
      scope: { enforce: true, allow: ["anthropic/*"] },
      source: "inherited" as const,
      onWarn: (violation: { message: string }) => warnings.push(violation.message),
    };
    assert.equal(
      resolveSubagentModelOverride(
        undefined,
        { provider: "deepseek", id: "deepseek-v4" },
        { ...options },
      ),
      "deepseek/deepseek-v4",
    );
    assert.equal(
      resolveSubagentModelOverride("deepseek/deepseek-v4", undefined, { ...options }),
      "deepseek/deepseek-v4",
    );
    assert.equal(warnings.length, 2);
  });

  it("passes an in-scope explicit model without warning", () => {
    const warnings: string[] = [];
    assert.equal(
      resolveSubagentModelOverride("anthropic/claude-sonnet-4", undefined, {
        scope: { enforce: true, allow: ["anthropic/*"] },
        source: "explicit",
        onWarn: (violation) => warnings.push(violation.message),
      }),
      "anthropic/claude-sonnet-4",
    );
    assert.equal(warnings.length, 0);
  });

  it("ignores a thinking suffix when applying the scope allow-list", () => {
    const warnings: string[] = [];
    assert.equal(
      resolveSubagentModelOverride("anthropic/claude-sonnet-4:high", undefined, {
        scope: { enforce: true, allow: ["anthropic/*"] },
        source: "explicit",
        onWarn: (violation) => warnings.push(violation.message),
      }),
      "anthropic/claude-sonnet-4:high",
    );
    assert.equal(warnings.length, 0);
  });

  it("keeps model scope as a pure allow-list warning for inherited fallbacks", () => {
    const warnings: string[] = [];
    const scope: ModelScopeConfig = { enforce: true, allow: ["anthropic/*"] };
    const plan = buildModelCandidatePlan("anthropic/claude-sonnet-4", ["openai/gpt-5"], {
      scope,
      onWarn: (violation) => warnings.push(violation.message),
    });
    assert.deepEqual(plan.candidates, ["anthropic/claude-sonnet-4", "openai/gpt-5"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /outside the configured subagent model scope/);
  });

  it("records each ordered fallback transition in durable resolution history", () => {
    const original = canonicalSubagentModelIdentity("openai/a")!;
    const b = canonicalSubagentModelIdentity("anthropic/b")!;
    const c = canonicalSubagentModelIdentity("google/c")!;
    const afterB = appendRuntimeFallbackResolution({
      sourceAttempt: { model: "openai/a", success: false, error: "rate limit" },
      currentIdentity: b,
      originalIdentity: original,
    });
    const afterC = appendRuntimeFallbackResolution({
      previous: afterB,
      sourceAttempt: { model: "anthropic/b", success: false, error: "502 upstream" },
      currentIdentity: c,
      originalIdentity: original,
    });
    assert.deepEqual(afterC?.original, original);
    assert.deepEqual(afterC?.resumed, c);
    assert.match(afterC?.reason ?? "", /openai\/a.*anthropic\/b/);
    assert.match(afterC?.reason ?? "", /anthropic\/b.*google\/c/);
  });

  it("classifies only transient provider/model failures as retryable", () => {
    for (const error of [
      "rate limit exceeded",
      "The provider returned 503 Service Unavailable",
      "HTTP 502 Bad Gateway",
      "HTTP 504 Gateway Timeout",
      "HTTP 500 Internal Server Error",
      "provider overloaded",
      "overloaded_error",
      "request timed out",
      "ECONNRESET while contacting provider",
      "Stream ended without finish_reason",
    ]) {
      assert.equal(isRetryableModelFailure(error), true, error);
    }
    for (const error of [
      "Unknown model: openai/not-real",
      "Pi rejected --model openai/not-real",
      "authentication failed",
      "model unavailable",
      "unrelated unavailable resource",
      "bash failed (exit 1): network error",
      "Provider finish_reason: content_filter",
      "cost 0.503 USD",
      "ticket 503 is unrelated to the provider",
      "503 provider unavailable",
      "503",
    ]) {
      assert.equal(isRetryableModelFailure(error), false, error);
    }
    assert.equal(isRetryableModelFailure(undefined), false);
  });

  it("deduplicates effective model argv values after suffix application", () => {
    assert.deepEqual(
      deduplicateModelCandidates([
        "openai/primary:high",
        "anthropic/backup:high",
        "openai/primary:high",
        "anthropic/backup:low",
      ]),
      ["openai/primary:high", "anthropic/backup:high", "anthropic/backup:low"],
    );
  });

  it("sanitizes bounded fallback notices", () => {
    assert.equal(
      sanitizeModelFallbackNotice(" quota hit\nretry on the backup\tmodel "),
      "quota hit retry on the backup model",
    );
    assert.equal(sanitizeModelFallbackNotice("\u0000\u0001\n\t"), undefined);
    assert.equal(sanitizeModelFallbackNotice(undefined), undefined);
  });
});

describe("model identity persistence", () => {
  it("round-trips provider, model, and effective thinking", () => {
    const identity = canonicalSubagentModelIdentity("anthropic/claude-sonnet-4:high")!;
    assert.deepEqual(identity, {
      provider: "anthropic",
      model: "claude-sonnet-4",
      thinking: "high",
    });
    assert.equal(modelReferenceFromIdentity(identity), "anthropic/claude-sonnet-4");
  });

  it("preserves separately supplied effective thinking for a bare model", () => {
    assert.deepEqual(canonicalSubagentModelIdentity("anthropic/model", "high"), {
      provider: "anthropic",
      model: "model",
      thinking: "high",
    });
  });

  it("prefers a model suffix and ignores unsupported thinking values", () => {
    assert.deepEqual(canonicalSubagentModelIdentity("anthropic/model:low", "high"), {
      provider: "anthropic",
      model: "model",
      thinking: "low",
    });
    assert.deepEqual(canonicalSubagentModelIdentity("anthropic/model", "turbo"), {
      provider: "anthropic",
      model: "model",
    });
  });

  it("rejects provider-less or empty model references", () => {
    assert.equal(canonicalSubagentModelIdentity("model", "high"), undefined);
    assert.equal(canonicalSubagentModelIdentity(undefined, "high"), undefined);
  });

  it("sanitizes persisted identities and rejects malformed values", () => {
    assert.deepEqual(
      sanitizeSubagentModelIdentity({
        provider: "  anthropic ",
        model: " claude ",
        thinking: "high",
      }),
      { provider: "anthropic", model: "claude", thinking: "high" },
    );
    assert.equal(sanitizeSubagentModelIdentity({ provider: "anthropic" }), undefined);
    assert.equal(sanitizeSubagentModelIdentity("anthropic/claude"), undefined);
  });
});

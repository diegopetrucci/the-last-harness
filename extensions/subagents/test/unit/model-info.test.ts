import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findModelInfo,
  resolveRuntimeModelContext,
  splitKnownThinkingSuffix,
  type ModelInfo,
} from "../../src/shared/model-info.ts";

describe("model info helpers", () => {
  const ambiguousModels: ModelInfo[] = [
    {
      provider: "openai",
      id: "gpt-5-mini",
      fullId: "openai/gpt-5-mini",
    },
    {
      provider: "github-copilot",
      id: "gpt-5-mini",
      fullId: "github-copilot/gpt-5-mini",
    },
  ];

  it("resolves exact runtime context metadata and preserves opaque model ids", () => {
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
  });

  it("rejects malformed runtime model context boundaries without coercion", () => {
    const contextWindows = {
      "mock/test-model": 1000,
      "openrouter/anthropic/claude-3.5-sonnet": 4096,
    };
    for (const [provider, model] of [
      [null, "test-model"],
      ["mock", 42],
      [undefined, undefined],
      ["mock", "/test-model"],
      ["mock", "test-model/"],
      ["other", "test-model"],
    ] as const) {
      assert.equal(resolveRuntimeModelContext(provider, model, contextWindows), undefined);
    }
    assert.deepEqual(
      resolveRuntimeModelContext(
        undefined,
        "openrouter/anthropic/claude-3.5-sonnet:high",
        contextWindows,
      ),
      {
        identity: {
          provider: "openrouter",
          model: "anthropic/claude-3.5-sonnet",
          thinking: "high",
        },
        contextWindow: 4096,
      },
    );
  });

  it("does not invent a context denominator for unknown or malformed models", () => {
    const contextWindows = { "mock/test-model": 1000 };
    assert.equal(resolveRuntimeModelContext("mock", "missing-model", contextWindows), undefined);
    assert.equal(resolveRuntimeModelContext(undefined, "test-model", contextWindows), undefined);
    assert.equal(
      resolveRuntimeModelContext("bad provider", "test-model", contextWindows),
      undefined,
    );
    const inherited = Object.create({ "mock/inherited": 3000 }) as Record<string, number>;
    assert.equal(resolveRuntimeModelContext("mock", "inherited", inherited), undefined);
  });

  it("does not let a separately reported provider reinterpret a qualified model id", () => {
    const contextWindows = {
      "mock/test-model": 1000,
      "other/test-model": 2000,
    };
    assert.equal(resolveRuntimeModelContext("other", "mock/test-model", contextWindows), undefined);
  });

  it("does not choose arbitrary metadata for ambiguous bare model ids", () => {
    assert.equal(findModelInfo("gpt-5-mini", ambiguousModels), undefined);
  });

  it("uses the preferred provider for ambiguous bare model metadata", () => {
    assert.equal(
      findModelInfo("gpt-5-mini", ambiguousModels, "github-copilot")?.fullId,
      "github-copilot/gpt-5-mini",
    );
  });

  it("matches provider-qualified model metadata before bare ids", () => {
    assert.equal(
      findModelInfo("openai/gpt-5-mini:high", ambiguousModels, "github-copilot")?.fullId,
      "openai/gpt-5-mini",
    );
  });

  it("recognizes max suffixes without consulting model capabilities", () => {
    assert.deepEqual(splitKnownThinkingSuffix("openai/gpt-5:max"), {
      baseModel: "openai/gpt-5",
      thinkingSuffix: ":max",
    });
  });
});

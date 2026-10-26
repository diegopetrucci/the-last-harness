import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROVIDER_AWARE_FALLBACK_MODELS } from "../../../the-last-harness-subagent-safety.mjs";
import {
  readModelRegistrySnapshot,
  providerFallbackModelsForTarget,
  resolveSingleRunOutputBaseDir,
  unknownAgentMessage,
} from "../../src/runs/shared/run-support.ts";

describe("run-support helpers", () => {
  it("captures available model metadata for context diagnostics", () => {
    const snapshot = readModelRegistrySnapshot({
      modelRegistry: {
        getAvailable: () => [
          { provider: "mock", id: "test-model", contextWindow: 2048 },
          { provider: "other", id: "other-model" },
        ],
      },
    } as never);
    assert.deepEqual(snapshot, {
      availableModels: [
        {
          provider: "mock",
          id: "test-model",
          fullId: "mock/test-model",
          contextWindow: 2048,
        },
        {
          provider: "other",
          id: "other-model",
          fullId: "other/other-model",
          contextWindow: undefined,
        },
      ],
    });
  });

  it("retains provider-aware fallback resolution for in-process targets", () => {
    const target = {
      [PROVIDER_AWARE_FALLBACK_MODELS]: [" anthropic/backup ", "openai/backup"],
    };
    assert.deepEqual(providerFallbackModelsForTarget(target), [
      " anthropic/backup ",
      "openai/backup",
    ]);
    assert.equal(providerFallbackModelsForTarget(undefined), undefined);
  });

  it("builds the isolated output base directory", () => {
    assert.equal(
      resolveSingleRunOutputBaseDir("/tmp/artifacts", "run-123"),
      "/tmp/artifacts/outputs/run-123",
    );
  });

  it("keeps unknown and malformed-agent messages bounded and actionable", () => {
    assert.equal(unknownAgentMessage("worker", undefined), "Unknown agent: worker");
    assert.equal(
      unknownAgentMessage(
        "worker",
        [
          {
            source: "project",
            filePath: "/tmp/worker.md",
            error: "Agent 'worker' has malformed frontmatter",
          },
        ],
        "Cannot dispatch agent",
      ),
      "Cannot dispatch agent: worker. Malformed definition at '/tmp/worker.md': Agent 'worker' has malformed frontmatter",
    );
    assert.equal(
      unknownAgentMessage("worker", [
        {
          source: "project",
          filePath: "/tmp/worker.md",
          kind: "notice",
          error: "Agent 'worker' is legacy",
        },
      ]),
      "Unknown agent: worker",
    );
  });
});

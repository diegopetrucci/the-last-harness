import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeTempDir } from "./test-fixture-helpers.mjs";

export function sessionHeader(id = "sess-001", cwd = "/workspace") {
  return JSON.stringify({
    type: "session",
    version: 1,
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd,
  });
}

export function assistantMessageLine(timestamp, toolCalls = []) {
  const content = toolCalls.map(({ toolCallId, toolName }) => ({
    type: "toolCall",
    toolCallId,
    toolName,
  }));
  return JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      model: "claude-opus-5",
      provider: "anthropic",
      api: "bedrock",
      responseId: "resp-1",
      stopReason: "tool_use",
      usage: {},
      content,
      timestamp,
    },
  });
}

export function toolResultLine(timestamp, toolCallId, toolName = "bash", options = {}) {
  return JSON.stringify({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      isError: options.isError ?? false,
      content: [{ type: "text", text: options.output ?? "ok" }],
      ...(options.details ? { details: options.details } : {}),
      timestamp,
    },
  });
}

export function writeFixture(
  t,
  lines,
  { noTrailingNewline = false, filename = "session.jsonl" } = {},
) {
  const dir = makeTempDir("session-analysis-test-", t);
  const filePath = join(dir, filename);
  const content = lines.join("\n") + (noTrailingNewline ? "" : "\n");
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

export function messageEntry(message) {
  return JSON.stringify({ type: "message", message });
}

export function completionBatchMessage(details, content = "") {
  return messageEntry({
    role: "custom",
    customType: "subagent-notify",
    content,
    details,
  });
}

export function telemetryEnvelope(
  runId,
  execution,
  { agent = "code-agent", index = 0, outcome = { state: "running" } } = {},
) {
  const usage = {
    inputTokens: 10 + index,
    outputTokens: 20 + index,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    costUsd: 0.25 + index * 0.01,
  };
  return {
    schemaVersion: 1,
    run: { id: runId, execution, mode: "single" },
    steps: [
      {
        index,
        agent,
        model: { provider: "anthropic", model: "claude-test" },
        usage,
        timing: { durationMs: 100 + index, activeRuntimeMs: 90 + index },
        outcome,
      },
    ],
    usage,
    timing: { startedAt: 1000, endedAt: 1100, durationMs: 100, activeRuntimeMs: 90 },
    outcome,
    provenance: { tlhVersion: "test", piVersion: "test", loadedAt: 1 },
    controls: {
      needsAttentionAfterMs: 1000,
      failedToolAttemptsBeforeAttention: 2,
      notifyOn: ["needs_attention"],
      notifyChannels: ["event", "async"],
    },
  };
}

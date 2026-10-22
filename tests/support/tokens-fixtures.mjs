export function assistantEntry(id, parentId, timestamp, options = {}) {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      provider: options.provider ?? "openai-codex",
      model: options.model ?? "gpt-5.5",
      stopReason: options.stopReason ?? "stop",
      content: options.content ?? [{ type: "text", text: options.text ?? "assistant text" }],
      usage: options.usage,
    },
  };
}

export function userEntry(id, parentId, timestamp, text) {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
  };
}

export function toolResultEntry(
  id,
  parentId,
  timestamp,
  toolName,
  details,
  isError = false,
  contentText = "tool output",
) {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "toolResult",
      toolName,
      toolCallId: `${id}-call`,
      isError,
      content: [{ type: "text", text: contentText }],
      details,
    },
  };
}

export function usage({
  input,
  output,
  cacheRead = 0,
  cacheWrite = 0,
  cost,
  turns = 0,
  assistantMessages = 0,
}) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cost: {
      total: cost,
      input: cost / 2,
      output: cost / 2,
      cacheRead: 0,
      cacheWrite: 0,
    },
    turns,
    assistantMessages,
  };
}

export const toolCatalog = [
  {
    name: "bash",
    sourceInfo: {
      source: "built-in",
      path: "core/tools/bash.ts",
      scope: "user",
      origin: "top-level",
    },
  },
  {
    name: "subagent",
    sourceInfo: {
      source: "npm:pi-subagents",
      path: "extensions/subagent.mjs",
      scope: "user",
      origin: "package",
    },
  },
  {
    name: "mcp",
    sourceInfo: {
      source: "npm:pi-mcp-adapter",
      path: "extensions/mcp.mjs",
      scope: "user",
      origin: "package",
    },
  },
  {
    name: "exa_search",
    sourceInfo: {
      source: "npm:pi-mcp-adapter",
      path: "extensions/direct-tools/exa.mjs",
      scope: "user",
      origin: "package",
    },
  },
];

export function createSecretBearingSession() {
  return [
    userEntry("u1", null, "2026-06-15T12:00:00Z", "SECRET USER PROMPT"),
    assistantEntry("a1", "u1", "2026-06-15T12:00:05Z", {
      stopReason: "tool_use",
      content: [
        { type: "text", text: "Planning text that should stay out of the report." },
        { type: "toolCall", id: "call-bash-1", name: "bash", arguments: { command: "ls" } },
        {
          type: "toolCall",
          id: "call-subagent-1",
          name: "subagent",
          arguments: { task: "RAW SUBAGENT TASK" },
        },
      ],
      usage: usage({ input: 100, output: 20, cacheRead: 30, cacheWrite: 5, cost: 0.35 }),
    }),
    toolResultEntry(
      "tr1",
      "a1",
      "2026-06-15T12:00:06Z",
      "bash",
      { exitCode: 0 },
      false,
      "RAW TOOL OUTPUT",
    ),
    toolResultEntry(
      "tr2",
      "a1",
      "2026-06-15T12:00:08Z",
      "subagent",
      {
        agent: "developer",
        mode: "single",
        model: "openai-codex/gpt-5.4",
        intercomTarget: "subagent-chat-123",
        sessionFile: "/Users/me/.the-last-harness/agent/sessions/--repo--/run-42/session.jsonl",
        artifactPaths: {
          outputPath: "/Users/me/.the-last-harness/agent/artifacts/run-42/output.md",
          metadataPath: "/Users/me/.the-last-harness/agent/artifacts/run-42/metadata.json",
        },
        modelAttempts: [
          {
            model: "openai-codex/gpt-5.4",
            success: true,
            usage: usage({
              input: 50,
              output: 10,
              cacheRead: 4,
              cacheWrite: 1,
              cost: 0.12,
              turns: 1,
              assistantMessages: 1,
            }),
          },
        ],
        output: "raw scratchpad",
      },
      false,
      "RAW SUBAGENT RESULT",
    ),
    assistantEntry("a2", "tr2", "2026-06-15T12:00:15Z", {
      stopReason: "tool_use",
      content: [
        { type: "text", text: "Fetching MCP data." },
        {
          type: "toolCall",
          id: "call-mcp-1",
          name: "mcp",
          arguments: { server: "exa", prompt: "secret query" },
        },
      ],
      usage: usage({ input: 80, output: 15, cost: 0.25 }),
    }),
    toolResultEntry(
      "tr3",
      "a2",
      "2026-06-15T12:00:18Z",
      "mcp",
      { server: "exa" },
      false,
      "MCP RAW RESULT",
    ),
    assistantEntry("a3", "tr3", "2026-06-15T12:00:25Z", {
      text: "Done.",
      usage: usage({ input: 60, output: 25, cacheRead: 10, cost: 0.22 }),
    }),
    assistantEntry("a-branch", "u1", "2026-06-15T12:01:00Z", {
      text: "Alternate branch",
      usage: usage({ input: 10, output: 5, cost: 0.04 }),
    }),
  ];
}

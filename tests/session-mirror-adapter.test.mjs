import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const { SESSION_MIRROR_PROJECTION_REASONS, projectSessionMirrorSnapshot } = await jiti.import(
  "../extensions/the-last-harness/session-mirror/session-adapter.ts",
);
const { validateSessionMirrorEnvelope } = await jiti.import(
  "../protocol/session-mirror/v1/conformance.ts",
);

const METADATA = {
  eventId: "synthetic-event-1",
  revision: 7,
  cursor: "synthetic-cursor-7",
  snapshotId: "synthetic-snapshot-7",
  runtimeVersion: "synthetic-runtime-0.1",
  sessionSchemaVersion: "synthetic-session-schema-0.1",
  status: "idle",
};

function manager(entries, activeLeafId = entries.at(-1)?.id ?? null, overrides = {}) {
  return {
    getSessionFile: () =>
      Object.hasOwn(overrides, "sessionFile")
        ? overrides.sessionFile
        : "/private/synthetic/session.jsonl",
    getSessionId: () =>
      Object.hasOwn(overrides, "sessionId") ? overrides.sessionId : "synthetic-session-id",
    getLeafId: () => activeLeafId,
    getEntries: () => entries,
  };
}

function sourceEntry(type, id, parentId, fields = {}) {
  return { type, id, parentId, timestamp: "2026-01-01T00:00:00.000Z", ...fields };
}

function userMessage(content) {
  return { role: "user", content, timestamp: 1 };
}

function assistantMessage(content, stopReason = "stop") {
  return {
    role: "assistant",
    content,
    api: "synthetic-api",
    provider: "synthetic-provider",
    model: "synthetic-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 2,
  };
}

function assertSuccessful(result) {
  assert.equal(result.ok, true);
  assert.equal(validateSessionMirrorEnvelope(result.envelope).ok, true);
  return result.envelope;
}

function assertDeepFrozen(value) {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test("projects a real persisted ReadonlySessionManager view into a valid snapshot", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tlh-session-mirror-adapter-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const session = SessionManager.create(join(root, "project"), join(root, "sessions"));
  const userId = session.appendMessage(userMessage("synthetic user request"));
  const assistantId = session.appendMessage(
    assistantMessage([{ type: "text", text: "synthetic final response" }]),
  );

  const envelope = assertSuccessful(projectSessionMirrorSnapshot(session, METADATA));
  assert.equal(envelope.sessionId, session.getSessionId());
  assert.equal(envelope.message.eventId, METADATA.eventId);
  assert.equal(envelope.message.revision, METADATA.revision);
  assert.equal(envelope.message.cursor, METADATA.cursor);
  assert.equal(envelope.message.snapshot.snapshotId, METADATA.snapshotId);
  assert.equal(envelope.message.snapshot.status, METADATA.status);
  assert.deepEqual(
    envelope.message.snapshot.tree.entries.map((entry) => entry.id),
    [userId, assistantId],
  );
  assert.deepEqual(envelope.message.snapshot.tree.rootIds, [userId]);
  assert.equal(envelope.message.snapshot.tree.activeLeafId, assistantId);
  assert.deepEqual(envelope.message.snapshot.tree.entries[0].payload, {
    content: { format: "text", text: "synthetic user request" },
  });
  assert.deepEqual(envelope.message.snapshot.tree.entries[1].payload, {
    content: { format: "text", text: "synthetic final response" },
  });
  assertDeepFrozen(envelope);
});

test("projects an empty persisted tree with a null active pointer", () => {
  const envelope = assertSuccessful(projectSessionMirrorSnapshot(manager([]), METADATA));
  assert.deepEqual(envelope.message.snapshot.tree, {
    rootIds: [],
    activeLeafId: null,
    entries: [],
  });
});

test("preserves two sibling entries with an interior active pointer", () => {
  const entries = [
    sourceEntry("message", "root", null, { message: userMessage("synthetic root") }),
    sourceEntry("message", "sibling-a", "root", {
      message: assistantMessage([{ type: "text", text: "synthetic sibling A" }]),
    }),
    sourceEntry("message", "sibling-b", "root", {
      message: assistantMessage([{ type: "text", text: "synthetic sibling B" }]),
    }),
  ];
  const envelope = assertSuccessful(
    projectSessionMirrorSnapshot(manager(entries, "root"), METADATA),
  );
  const tree = envelope.message.snapshot.tree;

  assert.deepEqual(tree.rootIds, ["root"]);
  assert.equal(tree.activeLeafId, "root");
  assert.deepEqual(
    tree.entries.map((entry) => [entry.id, entry.parentId, entry.kind]),
    [
      ["root", null, "user-turn"],
      ["sibling-a", "root", "assistant-turn"],
      ["sibling-b", "root", "assistant-turn"],
    ],
  );
});

test("preserves forest order, interior/null active pointers, branch summaries, and compaction", () => {
  const entries = [
    sourceEntry("message", "root-a", null, { message: userMessage("synthetic root A") }),
    sourceEntry("message", "child-a", "root-a", {
      message: assistantMessage([{ type: "text", text: "synthetic answer A" }]),
    }),
    sourceEntry("message", "root-b", null, { message: userMessage("synthetic root B") }),
    sourceEntry("branch_summary", "branch-summary", "root-b", {
      fromId: "child-a",
      summary: "synthetic branch summary",
    }),
    sourceEntry("compaction", "compaction", "branch-summary", {
      summary: "synthetic compaction summary",
      firstKeptEntryId: "child-a",
    }),
  ];
  const sourceBefore = structuredClone(entries);
  const envelope = assertSuccessful(projectSessionMirrorSnapshot(manager(entries, null), METADATA));
  const tree = envelope.message.snapshot.tree;

  assert.deepEqual(tree.rootIds, ["root-a", "root-b"]);
  assert.equal(tree.activeLeafId, null);
  assert.deepEqual(
    tree.entries.map((entry) => [entry.id, entry.parentId, entry.kind]),
    [
      ["root-a", null, "user-turn"],
      ["child-a", "root-a", "assistant-turn"],
      ["root-b", null, "user-turn"],
      ["branch-summary", "root-b", "summary"],
      ["compaction", "branch-summary", "compaction"],
    ],
  );
  assert.equal(tree.entries[3].fromId, "child-a");
  assert.deepEqual(tree.entries[4].payload, {
    summary: "synthetic compaction summary",
    firstKeptEntryId: "child-a",
  });
  assert.deepEqual(entries, sourceBefore);
});

test("publishes only text-only users and settled final assistant text", () => {
  const entries = [
    sourceEntry("message", "user-string", null, {
      message: userMessage("synthetic user string"),
    }),
    sourceEntry("message", "user-blocks", "user-string", {
      message: userMessage([
        { type: "text", text: "synthetic user " },
        { type: "text", text: "blocks" },
      ]),
    }),
    sourceEntry("message", "assistant-final", "user-blocks", {
      message: assistantMessage([
        { type: "text", text: "synthetic first " },
        { type: "thinking", thinking: "SENTINEL_THINKING_TEXT" },
        { type: "text", text: "final" },
      ]),
    }),
    sourceEntry("message", "assistant-tool", "assistant-final", {
      message: assistantMessage([{ type: "toolCall", id: "call", name: "read", arguments: {} }]),
    }),
    ...["length", "error", "aborted", "pending", "deferred", "unknown", undefined].map(
      (stopReason, index) =>
        sourceEntry("message", `assistant-${index}`, "assistant-tool", {
          message: assistantMessage(
            [{ type: "text", text: `SENTINEL_NONFINAL_${index}` }],
            stopReason ?? null,
          ),
        }),
    ),
    sourceEntry("message", "user-image", "assistant-6", {
      message: userMessage([
        { type: "text", text: "SENTINEL_IMAGE_TEXT" },
        { type: "image", data: "SENTINEL_IMAGE_DATA", mimeType: "image/png" },
      ]),
    }),
    sourceEntry("message", "user-unknown", "user-image", {
      message: userMessage([
        { type: "text", text: "SENTINEL_UNKNOWN_TEXT" },
        { type: "unknown", value: "SENTINEL_UNKNOWN_BLOCK" },
      ]),
    }),
  ];
  const envelope = assertSuccessful(projectSessionMirrorSnapshot(manager(entries), METADATA));
  const projected = envelope.message.snapshot.tree.entries;

  assert.deepEqual(
    projected.map((entry) => [entry.id, entry.kind, entry.payload.sourceType ?? null]),
    [
      ["user-string", "user-turn", null],
      ["user-blocks", "user-turn", null],
      ["assistant-final", "assistant-turn", null],
      ["assistant-tool", "source-placeholder", "tool"],
      ["assistant-0", "source-placeholder", "unsupported"],
      ["assistant-1", "source-placeholder", "unsupported"],
      ["assistant-2", "source-placeholder", "unsupported"],
      ["assistant-3", "source-placeholder", "unsupported"],
      ["assistant-4", "source-placeholder", "unsupported"],
      ["assistant-5", "source-placeholder", "unsupported"],
      ["assistant-6", "source-placeholder", "unsupported"],
      ["user-image", "source-placeholder", "image"],
      ["user-unknown", "source-placeholder", "unsupported"],
    ],
  );
  assert.equal(projected[1].payload.content.text, "synthetic user blocks");
  assert.equal(projected[2].payload.content.text, "synthetic first final");
  assert.doesNotMatch(JSON.stringify(envelope), /SENTINEL_/);
});

test("joins bounded text blocks without changing surrogate semantics", () => {
  const envelope = assertSuccessful(
    projectSessionMirrorSnapshot(
      manager([
        sourceEntry("message", "split-surrogate", null, {
          message: userMessage([
            { type: "text", text: "\ud83d" },
            { type: "text", text: "\ude00" },
          ]),
        }),
      ]),
      METADATA,
    ),
  );
  assert.equal(envelope.message.snapshot.tree.entries[0].payload.content.text, "😀");

  const cursorBoundaryEnvelope = assertSuccessful(
    projectSessionMirrorSnapshot(manager([]), {
      ...METADATA,
      cursor: "😀".repeat(256),
    }),
  );
  assert.equal(cursorBoundaryEnvelope.message.cursor, "😀".repeat(256));
});

test("handles split-surrogate text at the UTF-8 byte boundary", () => {
  const lowSurrogate = "\ude00";
  const successfulEnvelope = assertSuccessful(
    projectSessionMirrorSnapshot(
      manager([
        sourceEntry("message", "split-boundary-success", null, {
          message: userMessage([
            { type: "text", text: "x".repeat(32 * 1024 - 4) + "\ud83d" },
            { type: "text", text: lowSurrogate },
          ]),
        }),
      ]),
      METADATA,
    ),
  );
  assert.equal(
    successfulEnvelope.message.snapshot.tree.entries[0].payload.content.text,
    "x".repeat(32 * 1024 - 4) + "😀",
  );

  assert.deepEqual(
    projectSessionMirrorSnapshot(
      manager([
        sourceEntry("message", "split-boundary-failure", null, {
          message: userMessage([
            { type: "text", text: "x".repeat(32 * 1024 - 3) + "\ud83d" },
            { type: "text", text: lowSurrogate },
          ]),
        }),
      ]),
      METADATA,
    ),
    { ok: false, reason: "bounds-exceeded" },
  );
});

test("redacts tool, provider, image, custom, and unsupported source payloads", () => {
  const secrets = {
    toolOutput: "SENTINEL_TOOL_OUTPUT",
    toolArgs: "SENTINEL_TOOL_ARGUMENTS",
    bashCommand: "SENTINEL_BASH_COMMAND",
    bashOutput: "SENTINEL_BASH_OUTPUT",
    provider: "SENTINEL_PROVIDER_ID",
    model: "SENTINEL_MODEL_ID",
    image: "SENTINEL_IMAGE_DATA",
    custom: "SENTINEL_CUSTOM_DATA",
    thinking: "SENTINEL_THINKING_TEXT",
    path: "/private/synthetic/secret/path",
  };
  const entries = [
    sourceEntry("message", "user", null, { message: userMessage("synthetic prompt") }),
    sourceEntry("message", "final", "user", {
      message: assistantMessage([
        { type: "thinking", thinking: secrets.thinking },
        { type: "text", text: "synthetic final answer" },
      ]),
    }),
    sourceEntry("message", "tool-call", "final", {
      message: assistantMessage(
        [
          { type: "text", text: "synthetic progress" },
          {
            type: "toolCall",
            id: "synthetic-call",
            name: "write",
            arguments: { value: secrets.toolArgs },
          },
        ],
        "toolUse",
      ),
    }),
    sourceEntry("message", "tool-result", "tool-call", {
      message: {
        role: "toolResult",
        toolCallId: "synthetic-call",
        toolName: "write",
        content: [{ type: "text", text: secrets.toolOutput }],
        details: { path: secrets.path },
        isError: false,
        timestamp: 3,
      },
    }),
    sourceEntry("message", "bash-result", "tool-result", {
      message: {
        role: "bashExecution",
        command: secrets.bashCommand,
        output: secrets.bashOutput,
        cwd: secrets.path,
        exitCode: 0,
        timestamp: 4,
      },
    }),
    sourceEntry("message", "image", "bash-result", {
      message: {
        role: "user",
        content: [{ type: "image", data: secrets.image, mimeType: "image/png" }],
        timestamp: 4,
      },
    }),
    sourceEntry("model_change", "model-change", "image", {
      provider: secrets.provider,
      modelId: secrets.model,
    }),
    sourceEntry("thinking_level_change", "thinking-change", "model-change", {
      thinkingLevel: secrets.thinking,
    }),
    sourceEntry("custom", "custom-entry", "thinking-change", { data: secrets.custom }),
    sourceEntry("custom_message", "custom-message", "custom-entry", {
      content: secrets.custom,
      details: { path: secrets.path },
    }),
    sourceEntry("label", "label", "custom-message", { targetId: "final", label: secrets.custom }),
    sourceEntry("session_info", "session-info", "label", { name: secrets.custom }),
    sourceEntry("message", "failed", "session-info", {
      message: assistantMessage([{ type: "text", text: secrets.toolOutput }], "error"),
    }),
    sourceEntry("message", "unknown-block", "failed", {
      message: assistantMessage([{ type: "mystery", value: secrets.custom }]),
    }),
    sourceEntry("future_entry", "future", "unknown-block", { payload: secrets.custom }),
  ];
  const envelope = assertSuccessful(projectSessionMirrorSnapshot(manager(entries), METADATA));
  const projected = envelope.message.snapshot.tree.entries;
  const serialized = JSON.stringify(envelope);

  assert.deepEqual(
    projected.map((entry) => [entry.id, entry.kind, entry.payload.sourceType ?? null]),
    [
      ["user", "user-turn", null],
      ["final", "assistant-turn", null],
      ["tool-call", "source-placeholder", "tool"],
      ["tool-result", "source-placeholder", "tool"],
      ["bash-result", "source-placeholder", "tool"],
      ["image", "source-placeholder", "image"],
      ["model-change", "source-placeholder", "provider"],
      ["thinking-change", "source-placeholder", "provider"],
      ["custom-entry", "source-placeholder", "custom"],
      ["custom-message", "source-placeholder", "custom"],
      ["label", "source-placeholder", "custom"],
      ["session-info", "source-placeholder", "custom"],
      ["failed", "source-placeholder", "unsupported"],
      ["unknown-block", "source-placeholder", "unsupported"],
      ["future", "source-placeholder", "unsupported"],
    ],
  );
  assert.equal(projected[1].payload.content.text, "synthetic final answer");
  for (const secret of Object.values(secrets)) assert.doesNotMatch(serialized, new RegExp(secret));
  for (const entry of projected) {
    if (entry.kind === "source-placeholder") {
      assert.deepEqual(Object.keys(entry).sort(), ["id", "kind", "parentId", "payload", "status"]);
      assert.deepEqual(Object.keys(entry.payload), ["sourceType"]);
    }
  }
});

test("returns closed failures for duplicate, cyclic, dangling, and incomplete trees", () => {
  const assertUnsafe = (entries, activeLeafId = entries.at(-1)?.id ?? null) => {
    assert.deepEqual(projectSessionMirrorSnapshot(manager(entries, activeLeafId), METADATA), {
      ok: false,
      reason: "unsafe-session-data",
    });
  };

  assertUnsafe(
    [
      sourceEntry("message", "duplicate", null, { message: userMessage("synthetic first") }),
      sourceEntry("message", "duplicate", null, { message: userMessage("synthetic second") }),
    ],
    null,
  );
  assertUnsafe(
    [
      sourceEntry("message", "cycle-a", "cycle-b", { message: userMessage("synthetic A") }),
      sourceEntry("message", "cycle-b", "cycle-a", { message: userMessage("synthetic B") }),
    ],
    null,
  );
  assertUnsafe(
    [sourceEntry("message", "root", null, { message: userMessage("synthetic root") })],
    "dangling-active",
  );
  assertUnsafe([], "non-null-empty-active");
  assertUnsafe(
    [
      sourceEntry("message", "root", null, { message: userMessage("synthetic root") }),
      sourceEntry("compaction", "compaction", "root", {
        summary: "synthetic compaction summary",
      }),
    ],
    null,
  );
  assertUnsafe(
    [
      sourceEntry("message", "root", null, { message: userMessage("synthetic root") }),
      sourceEntry("compaction", "compaction-undefined", "root", {
        summary: "synthetic compaction summary",
        firstKeptEntryId: undefined,
      }),
    ],
    null,
  );
  assertUnsafe(
    [
      sourceEntry("message", "root", null, { message: userMessage("synthetic root") }),
      sourceEntry("compaction", "compaction-ghost", "root", {
        summary: "synthetic compaction summary",
        firstKeptEntryId: "ghost",
      }),
    ],
    null,
  );
});

test("returns closed failures for invalid metadata, unavailable sessions, malformed trees, and bounds", () => {
  assert.deepEqual(SESSION_MIRROR_PROJECTION_REASONS, [
    "invalid-metadata",
    "session-unavailable",
    "unsafe-session-data",
    "bounds-exceeded",
  ]);
  assert.deepEqual(projectSessionMirrorSnapshot(manager([]), undefined), {
    ok: false,
    reason: "invalid-metadata",
  });
  assert.deepEqual(
    projectSessionMirrorSnapshot(manager([]), { ...METADATA, status: "streaming" }),
    { ok: false, reason: "invalid-metadata" },
  );
  assert.deepEqual(
    projectSessionMirrorSnapshot(manager([], null, { sessionFile: undefined }), METADATA),
    { ok: false, reason: "session-unavailable" },
  );
  assert.deepEqual(
    projectSessionMirrorSnapshot(
      manager([sourceEntry("message", "child", "missing", { message: userMessage("synthetic") })]),
      METADATA,
    ),
    { ok: false, reason: "unsafe-session-data" },
  );

  const oversizedId = "x".repeat(129);
  assert.deepEqual(
    projectSessionMirrorSnapshot(
      manager([sourceEntry("message", oversizedId, null, { message: userMessage("synthetic") })]),
      METADATA,
    ),
    { ok: false, reason: "bounds-exceeded" },
  );
  assert.deepEqual(
    projectSessionMirrorSnapshot(manager([]), { ...METADATA, eventId: oversizedId }),
    { ok: false, reason: "bounds-exceeded" },
  );
  assert.deepEqual(
    projectSessionMirrorSnapshot(
      manager([
        sourceEntry("message", "large", null, {
          message: assistantMessage([{ type: "text", text: "x".repeat(32 * 1024 + 1) }]),
        }),
      ]),
      METADATA,
    ),
    { ok: false, reason: "bounds-exceeded" },
  );
  assert.deepEqual(
    projectSessionMirrorSnapshot(
      manager([
        sourceEntry("message", "split-large", null, {
          message: userMessage([
            { type: "text", text: "x".repeat(16 * 1024) },
            { type: "text", text: "x".repeat(16 * 1024 + 1) },
          ]),
        }),
      ]),
      METADATA,
    ),
    { ok: false, reason: "bounds-exceeded" },
  );
  assert.deepEqual(
    projectSessionMirrorSnapshot(
      manager([
        sourceEntry("message", "multibyte-overflow", null, {
          message: userMessage([
            { type: "text", text: "é".repeat(16 * 1024) },
            { type: "text", text: "é".repeat(16 * 1024) },
          ]),
        }),
      ]),
      METADATA,
    ),
    { ok: false, reason: "bounds-exceeded" },
  );

  assert.deepEqual(
    projectSessionMirrorSnapshot(manager(Array.from({ length: 1025 }), null), METADATA),
    {
      ok: false,
      reason: "bounds-exceeded",
    },
  );

  const deepEntries = [];
  let parentId = null;
  for (let index = 0; index < 129; index += 1) {
    const id = `deep-${index}`;
    deepEntries.push(sourceEntry("message", id, parentId, { message: userMessage("x") }));
    parentId = id;
  }
  assert.deepEqual(projectSessionMirrorSnapshot(manager(deepEntries), METADATA), {
    ok: false,
    reason: "bounds-exceeded",
  });

  const oversizedBlocks = Array.from({ length: 1025 }, () => ({ type: "thinking" }));
  assert.deepEqual(
    projectSessionMirrorSnapshot(
      manager([
        sourceEntry("message", "too-many-blocks", null, {
          message: assistantMessage(oversizedBlocks),
        }),
      ]),
      METADATA,
    ),
    { ok: false, reason: "bounds-exceeded" },
  );

  const aggregateEntries = Array.from({ length: 8 }, (_, index) =>
    sourceEntry("message", `aggregate-${index}`, null, {
      message: userMessage("x".repeat(32 * 1024)),
    }),
  );
  assert.deepEqual(projectSessionMirrorSnapshot(manager(aggregateEntries), METADATA), {
    ok: false,
    reason: "bounds-exceeded",
  });

  const escapedPayloadText = "\u0000".repeat(32 * 1024);
  assert.deepEqual(
    projectSessionMirrorSnapshot(
      manager([
        sourceEntry("message", "escaped-payload", null, {
          message: userMessage(escapedPayloadText),
        }),
      ]),
      METADATA,
    ),
    { ok: false, reason: "bounds-exceeded" },
  );

  const oversizedUtf16Identity = "😀".repeat(129);
  assert.deepEqual(
    projectSessionMirrorSnapshot(
      manager([
        sourceEntry("message", oversizedUtf16Identity, null, { message: userMessage("x") }),
      ]),
      METADATA,
    ),
    { ok: false, reason: "bounds-exceeded" },
  );
  assert.deepEqual(
    projectSessionMirrorSnapshot(manager([]), {
      ...METADATA,
      runtimeVersion: "x".repeat(256 * 1024 + 1),
    }),
    { ok: false, reason: "bounds-exceeded" },
  );
});

test("rejects unavailable manager shapes without invoking accessors", () => {
  const assertUnavailable = (sessionManager) => {
    const result = projectSessionMirrorSnapshot(sessionManager, METADATA);
    assert.deepEqual(result, { ok: false, reason: "session-unavailable" });
    assert.equal(Object.isFrozen(result), true);
  };

  assertUnavailable(null);
  assertUnavailable("not-a-session-manager");
  assertUnavailable({});

  const missingMethodManager = manager([]);
  delete missingMethodManager.getEntries;
  assertUnavailable(missingMethodManager);

  let methodGetterReads = 0;
  const accessorMethodManager = manager([]);
  Object.defineProperty(accessorMethodManager, "getEntries", {
    enumerable: true,
    get() {
      methodGetterReads += 1;
      throw new Error("manager method getter must not run");
    },
  });
  assertUnavailable(accessorMethodManager);
  assert.equal(methodGetterReads, 0);

  let overDepthManager = manager([]);
  for (let depth = 0; depth < 17; depth += 1) {
    overDepthManager = Object.create(overDepthManager);
  }
  assertUnavailable(overDepthManager);
});

test("does not invoke mutating methods or retain source objects", () => {
  const entries = [
    sourceEntry("message", "user", null, { message: userMessage("synthetic user") }),
    sourceEntry("message", "assistant", "user", {
      message: assistantMessage([{ type: "text", text: "synthetic assistant" }]),
    }),
  ];
  const before = structuredClone(entries);
  let mutations = 0;
  const source = {
    ...manager(entries, "assistant"),
    branch() {
      mutations += 1;
    },
    appendMessage() {
      mutations += 1;
    },
  };
  const result = projectSessionMirrorSnapshot(source, METADATA);
  assert.equal(result.ok, true);
  assert.equal(mutations, 0);
  assert.deepEqual(entries, before);
  assertDeepFrozen(result);
});

test("fails safely around hostile shapes and ignores cyclic custom payloads", () => {
  let accessorReads = 0;
  const accessorEntry = sourceEntry("message", "accessor", null, {
    message: userMessage("synthetic"),
  });
  Object.defineProperty(accessorEntry, "id", {
    enumerable: true,
    get() {
      accessorReads += 1;
      throw new Error("getter must not run");
    },
  });
  assert.deepEqual(projectSessionMirrorSnapshot(manager([accessorEntry], null), METADATA), {
    ok: false,
    reason: "unsafe-session-data",
  });
  assert.equal(accessorReads, 0);

  const sparseEntries = [];
  sparseEntries.length = 1;
  assert.deepEqual(projectSessionMirrorSnapshot(manager(sparseEntries, null), METADATA), {
    ok: false,
    reason: "unsafe-session-data",
  });
  const sparseBlocks = [];
  sparseBlocks.length = 1;
  assert.deepEqual(
    projectSessionMirrorSnapshot(
      manager(
        [
          sourceEntry("message", "sparse-blocks", null, {
            message: userMessage(sparseBlocks),
          }),
        ],
        null,
      ),
      METADATA,
    ),
    { ok: false, reason: "unsafe-session-data" },
  );

  let managerProxyGets = 0;
  const proxiedManager = new Proxy(
    manager([sourceEntry("message", "manager-proxy", null, { message: userMessage("synthetic") })]),
    {
      get() {
        managerProxyGets += 1;
        throw new Error("manager getter must not run");
      },
    },
  );
  const managerProxyEnvelope = assertSuccessful(
    projectSessionMirrorSnapshot(proxiedManager, METADATA),
  );
  assert.equal(managerProxyEnvelope.message.snapshot.tree.entries[0].id, "manager-proxy");
  assert.equal(managerProxyGets, 0);

  let proxyGets = 0;
  const proxiedEntry = new Proxy(
    sourceEntry("message", "proxied", null, { message: userMessage("synthetic proxy") }),
    {
      get(_target, property, _receiver) {
        proxyGets += 1;
        throw new Error(`proxy getter must not run for ${String(property)}`);
      },
    },
  );
  const proxiedEntries = new Proxy([proxiedEntry], {
    get(_target, property, _receiver) {
      proxyGets += 1;
      throw new Error(`array getter must not run for ${String(property)}`);
    },
  });
  const proxiedEnvelope = assertSuccessful(
    projectSessionMirrorSnapshot(manager(proxiedEntries, "proxied"), METADATA),
  );
  assert.equal(proxiedEnvelope.message.snapshot.tree.entries[0].id, "proxied");
  assert.equal(proxyGets, 0);

  let cyclicPayloadReads = 0;
  const cyclicPayload = {};
  cyclicPayload.self = cyclicPayload;
  Object.defineProperty(cyclicPayload, "secret", {
    enumerable: true,
    get() {
      cyclicPayloadReads += 1;
      throw new Error("cyclic payload getter must not run");
    },
  });
  const cyclicEnvelope = assertSuccessful(
    projectSessionMirrorSnapshot(
      manager([sourceEntry("custom", "cyclic-custom", null, { data: cyclicPayload })]),
      METADATA,
    ),
  );
  assert.equal(cyclicPayloadReads, 0);
  assert.deepEqual(cyclicEnvelope.message.snapshot.tree.entries[0].payload, {
    sourceType: "custom",
  });
  assert.doesNotMatch(JSON.stringify(cyclicEnvelope), /secret/);
});

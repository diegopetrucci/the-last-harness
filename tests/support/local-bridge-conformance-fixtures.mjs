import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";

export const repoRoot = resolve(import.meta.dirname, "../..");
export const profileDir = join(repoRoot, "protocol", "local-bridge", "v0");
export const fixtureDir = join(profileDir, "fixtures");
export const manifest = JSON.parse(readFileSync(join(profileDir, "manifest.json"), "utf8"));
export const jiti = createJiti(import.meta.url);
export const bridge = await jiti.import("../../protocol/local-bridge/v0/conformance.ts");
export const { SESSION_MIRROR_BOUNDS } = await jiti.import(
  "../../protocol/session-mirror/v1/conformance.ts",
);
export const {
  LOCAL_BRIDGE_BOUNDS,
  LOCAL_BRIDGE_CAPABILITIES,
  LOCAL_BRIDGE_ERROR_CODES,
  LOCAL_BRIDGE_NORMALIZATION_FORMULA,
  LOCAL_BRIDGE_PROTOCOL,
  LOCAL_BRIDGE_READ_ONLY_PROTOCOL,
  LOCAL_BRIDGE_REPLY_PROTOCOL,
  LOCAL_BRIDGE_RESULT_CODES,
  LOCAL_BRIDGE_REPLY_CAPABILITY,
  LOCAL_BRIDGE_REPLY_RECEIPT_CODES,
  LOCAL_BRIDGE_REPLY_CLOSE_REASONS,
  LOCAL_BRIDGE_REPLY_DIRECTIONS,
  LOCAL_BRIDGE_REPLY_OUTCOME_CODES,
  LOCAL_BRIDGE_RUNTIME_ONLY_ERROR_CODES,
  acceptLocalBridgeHandshake,
  applyLocalBridgeData,
  acceptLocalBridgeReplyHandshake,
  closeLocalBridgeReplyChannel,
  createLocalBridgeState,
  decodeLengthPrefixedFrame,
  disconnectLocalBridge,
  evictIdleLocalBridge,
  encodeLengthPrefixedFrame,
  encodeLocalBridgeReplyFrame,
  encodeLocalBridgeReplyHandshakeFrame,
  encodeLocalBridgeResultFrame,
  parseLocalBridgeDataFrame,
  parseLocalBridgeHandshakeFrame,
  parseLocalBridgeRendezvousJson,
  parseLocalBridgeReplyFrame,
  parseLocalBridgeReplyHandshakeFrame,
  parseLocalBridgeResultFrame,
  teardownLocalBridge,
  routeLocalBridgeReply,
  settleLocalBridgeReply,
  validateLocalBridgeDirectoryPath,
  validateLocalBridgeHandshake,
  validateLocalBridgeReplyFrame,
  validateLocalBridgeReplyHandshake,
  isLocalBridgeReplyExpired,
  validateLocalBridgeRendezvous,
  validateLocalBridgeResult,
  validateLocalBridgeSocketPath,
} = bridge;

export const INSTALLATION_ID = "fixture-installation";
export const LAUNCH_TOKEN = "0123456789abcdef0123456789abcdef";
export const CAPABILITIES = [...LOCAL_BRIDGE_CAPABILITIES];
export const SESSION_CAPABILITIES = [
  "session-tree",
  "completed-turns-only",
  "snapshot",
  "cursor-recovery",
  "custom-entries",
  "coarse-status",
];
export const SOURCE_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const SOURCE_C = "cccccccccccccccccccccccccccccccc";
export const RESULT_CODES = new Set(LOCAL_BRIDGE_RESULT_CODES);
export const RUNTIME_ONLY_ERROR_CODES = new Set(LOCAL_BRIDGE_RUNTIME_ONLY_ERROR_CODES);

export function readFixture(id) {
  return JSON.parse(readFileSync(join(fixtureDir, `${id}.json`), "utf8"));
}

export function assertFailure(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
  assert.equal(Object.keys(result.error).sort().join(","), "code");
}

export function stateFrom(config = {}) {
  const result = createLocalBridgeState({
    installationId: INSTALLATION_ID,
    launchToken: LAUNCH_TOKEN,
    ...config,
  });
  assert.equal(result.ok, true);
  return result.state;
}

export function hello(sessionId, sourceInstanceId, overrides = {}) {
  return {
    kind: "hello",
    protocol: { ...LOCAL_BRIDGE_PROTOCOL },
    installationId: INSTALLATION_ID,
    sessionId,
    sourceInstanceId,
    launchToken: LAUNCH_TOKEN,
    capabilities: [...CAPABILITIES],
    ...overrides,
  };
}

export function accept(state, sessionId, sourceInstanceId, overrides = {}) {
  const result = acceptLocalBridgeHandshake(state, hello(sessionId, sourceInstanceId, overrides));
  assert.equal(result.ok, true);
  return result;
}

export function snapshotEnvelope(sessionId, values) {
  return {
    protocol: { family: "session-mirror", major: 1, minor: 0 },
    source: {
      runtimeVersion: "fixture-runtime-0.1.0",
      sessionSchemaVersion: "fixture-session-schema-0.1",
    },
    sessionId,
    capabilities: [...SESSION_CAPABILITIES],
    message: {
      kind: "snapshot",
      eventId: values.eventId,
      revision: values.revision,
      cursor: values.cursor,
      operation: "replace",
      snapshot: {
        snapshotId: values.snapshotId,
        status: values.status,
        tree: { rootIds: [], activeLeafId: null, entries: [] },
      },
    },
  };
}

export function largeSnapshotEnvelope(sessionId, values) {
  const text = "x".repeat(values.textBytes);
  const entries = Array.from({ length: values.entryCount }, (_, index) => ({
    id: `${values.snapshotId}-entry-${index}`,
    parentId: null,
    kind: "user-turn",
    status: "completed",
    payload: { content: { format: "text", text } },
  }));
  const base = snapshotEnvelope(sessionId, values);
  return {
    ...base,
    message: {
      ...base.message,
      snapshot: {
        ...base.message.snapshot,
        tree: { rootIds: entries.map((entry) => entry.id), activeLeafId: null, entries },
      },
    },
  };
}

export function statusEventEnvelope(sessionId, values) {
  return {
    protocol: { family: "session-mirror", major: 1, minor: 0 },
    source: {
      runtimeVersion: "fixture-runtime-0.1.0",
      sessionSchemaVersion: "fixture-session-schema-0.1",
    },
    sessionId,
    capabilities: [...SESSION_CAPABILITIES],
    message: {
      kind: "event",
      eventId: values.eventId,
      revision: values.revision,
      baseRevision: values.baseRevision,
      cursor: values.cursor,
      operation: "append",
      event: {
        type: values.type ?? "status.changed",
        status: values.status,
        ...(values.metadata === undefined ? {} : { metadata: values.metadata }),
      },
    },
  };
}

export function largeEventEnvelope(sessionId, values) {
  return statusEventEnvelope(sessionId, {
    ...values,
    metadata: { padding: "x".repeat(values.paddingBytes) },
  });
}

export function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function frameFor(value) {
  const encoded = encodeLengthPrefixedFrame(jsonBytes(value));
  assert.equal(encoded.ok, true);
  return encoded.frame;
}

export function dataCommand(sessionId, sourceInstanceId, value) {
  return {
    sessionId,
    sourceInstanceId,
    frame: frameFor(value),
  };
}

export function dataCommandWithRaw(sessionId, sourceInstanceId, raw) {
  const encoded = encodeLengthPrefixedFrame(new TextEncoder().encode(raw));
  assert.equal(encoded.ok, true);
  return { sessionId, sourceInstanceId, frame: encoded.frame };
}

export function publish(state, sessionId, sourceInstanceId, value) {
  const result = applyLocalBridgeData(state, dataCommand(sessionId, sourceInstanceId, value));
  assert.equal(result.ok, true);
  return result;
}

export function disconnect(state, sessionId, sourceInstanceId) {
  const result = disconnectLocalBridge(state, { sessionId, sourceInstanceId });
  assert.equal(result.ok, true);
  return result;
}

export function idleCommand(state, sessionId, elapsedMonotonicMinutes) {
  const conversation = state.conversations.find((item) => item.sessionId === sessionId);
  assert.ok(conversation);
  return {
    sessionId,
    sourceInstanceId: conversation.ownerSourceInstanceId,
    sourceEpoch: conversation.sourceEpoch,
    activityGeneration: conversation.activityGeneration,
    elapsedMonotonicMinutes,
  };
}

export function assertRoundTripResult(result) {
  assert.equal(result.ok, true);
  const validated = validateLocalBridgeResult(result.result);
  assert.equal(validated.ok, true);
  const encoded = encodeLocalBridgeResultFrame(result.result);
  assert.equal(encoded.ok, true);
  const parsed = parseLocalBridgeResultFrame(encoded.frame);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.result, result.result);
}

export function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseObjectKeys(child)]),
  );
}

export function assertSafeWireResult(result, forbiddenValue) {
  assert.equal(typeof result.result.kind, "string");
  assert.equal(typeof result.result.code, "string");
  assert.equal(
    LOCAL_BRIDGE_ERROR_CODES.includes(result.result.code) || RESULT_CODES.has(result.result.code),
    true,
  );
  assert.equal(JSON.stringify(result.result).includes(forbiddenValue), false);
  assert.equal(Object.hasOwn(result.result, "error"), false);
}

export function assertFrozenNormativeHashes() {
  const files = manifest.frozenDependencies[0].normativeFiles;
  for (const file of files) {
    const digest = createHash("sha256")
      .update(readFileSync(join(repoRoot, file.path)))
      .digest("hex");
    assert.equal(digest, file.sha256, file.path);
  }
}

export function assertRepositoryOnlyPackageDryRun() {
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--dry-run", "--json"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const entries = JSON.parse(result.stdout);
  const files = new Set(entries.flatMap((entry) => entry.files ?? []).map((entry) => entry.path));
  assert.equal(
    files.has("extensions/the-last-harness.js"),
    true,
    "npm pack must include its packaged runtime sentinel",
  );
  assert.equal(
    [...files].some((file) => file.startsWith("protocol/local-bridge/")),
    false,
  );
  assert.equal(
    [...files].some((file) => file.startsWith("protocol/session-mirror/")),
    false,
  );
  assert.equal(
    [...files].some((file) => file === "tests/local-bridge-conformance.test.mjs"),
    false,
  );
}

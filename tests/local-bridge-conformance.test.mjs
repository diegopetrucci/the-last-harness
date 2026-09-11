import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const repoRoot = resolve(import.meta.dirname, "..");
const profileDir = join(repoRoot, "protocol", "local-bridge", "v0");
const fixtureDir = join(profileDir, "fixtures");
const manifest = JSON.parse(readFileSync(join(profileDir, "manifest.json"), "utf8"));
const jiti = createJiti(import.meta.url);
const bridge = await jiti.import("../protocol/local-bridge/v0/conformance.ts");
const { SESSION_MIRROR_BOUNDS } = await jiti.import("../protocol/session-mirror/v1/conformance.ts");
const {
  LOCAL_BRIDGE_BOUNDS,
  LOCAL_BRIDGE_CAPABILITIES,
  LOCAL_BRIDGE_ERROR_CODES,
  LOCAL_BRIDGE_NORMALIZATION_FORMULA,
  LOCAL_BRIDGE_PROTOCOL,
  LOCAL_BRIDGE_RESULT_CODES,
  LOCAL_BRIDGE_RUNTIME_ONLY_ERROR_CODES,
  acceptLocalBridgeHandshake,
  applyLocalBridgeData,
  createLocalBridgeState,
  decodeLengthPrefixedFrame,
  disconnectLocalBridge,
  evictIdleLocalBridge,
  encodeLengthPrefixedFrame,
  encodeLocalBridgeResultFrame,
  parseLocalBridgeDataFrame,
  parseLocalBridgeHandshakeFrame,
  parseLocalBridgeRendezvousJson,
  parseLocalBridgeResultFrame,
  teardownLocalBridge,
  validateLocalBridgeDirectoryPath,
  validateLocalBridgeHandshake,
  validateLocalBridgeRendezvous,
  validateLocalBridgeResult,
  validateLocalBridgeSocketPath,
} = bridge;

const INSTALLATION_ID = "fixture-installation";
const LAUNCH_TOKEN = "0123456789abcdef0123456789abcdef";
const CAPABILITIES = [...LOCAL_BRIDGE_CAPABILITIES];
const SESSION_CAPABILITIES = [
  "session-tree",
  "completed-turns-only",
  "snapshot",
  "cursor-recovery",
  "custom-entries",
  "coarse-status",
];
const SOURCE_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SOURCE_C = "cccccccccccccccccccccccccccccccc";
const RESULT_CODES = new Set(LOCAL_BRIDGE_RESULT_CODES);
const RUNTIME_ONLY_ERROR_CODES = new Set(LOCAL_BRIDGE_RUNTIME_ONLY_ERROR_CODES);

function readFixture(id) {
  return JSON.parse(readFileSync(join(fixtureDir, `${id}.json`), "utf8"));
}

function assertFailure(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
  assert.equal(Object.keys(result.error).sort().join(","), "code");
}

function stateFrom(config = {}) {
  const result = createLocalBridgeState({
    installationId: INSTALLATION_ID,
    launchToken: LAUNCH_TOKEN,
    ...config,
  });
  assert.equal(result.ok, true);
  return result.state;
}

function hello(sessionId, sourceInstanceId, overrides = {}) {
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

function accept(state, sessionId, sourceInstanceId, overrides = {}) {
  const result = acceptLocalBridgeHandshake(state, hello(sessionId, sourceInstanceId, overrides));
  assert.equal(result.ok, true);
  return result;
}

function snapshotEnvelope(sessionId, values) {
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

function largeSnapshotEnvelope(sessionId, values) {
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

function statusEventEnvelope(sessionId, values) {
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

function largeEventEnvelope(sessionId, values) {
  return statusEventEnvelope(sessionId, {
    ...values,
    metadata: { padding: "x".repeat(values.paddingBytes) },
  });
}

function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

function frameFor(value) {
  const encoded = encodeLengthPrefixedFrame(jsonBytes(value));
  assert.equal(encoded.ok, true);
  return encoded.frame;
}

function dataCommand(sessionId, sourceInstanceId, value) {
  return {
    sessionId,
    sourceInstanceId,
    frame: frameFor(value),
  };
}

function dataCommandWithRaw(sessionId, sourceInstanceId, raw) {
  const encoded = encodeLengthPrefixedFrame(new TextEncoder().encode(raw));
  assert.equal(encoded.ok, true);
  return { sessionId, sourceInstanceId, frame: encoded.frame };
}

function publish(state, sessionId, sourceInstanceId, value) {
  const result = applyLocalBridgeData(state, dataCommand(sessionId, sourceInstanceId, value));
  assert.equal(result.ok, true);
  return result;
}

function disconnect(state, sessionId, sourceInstanceId) {
  const result = disconnectLocalBridge(state, { sessionId, sourceInstanceId });
  assert.equal(result.ok, true);
  return result;
}

function idleCommand(state, sessionId, elapsedMonotonicMinutes) {
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

function assertRoundTripResult(result) {
  assert.equal(result.ok, true);
  const validated = validateLocalBridgeResult(result.result);
  assert.equal(validated.ok, true);
  const encoded = encodeLocalBridgeResultFrame(result.result);
  assert.equal(encoded.ok, true);
  const parsed = parseLocalBridgeResultFrame(encoded.frame);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.result, result.result);
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseObjectKeys(child)]),
  );
}

function assertSafeWireResult(result, forbiddenValue) {
  assert.equal(typeof result.result.kind, "string");
  assert.equal(typeof result.result.code, "string");
  assert.equal(
    LOCAL_BRIDGE_ERROR_CODES.includes(result.result.code) || RESULT_CODES.has(result.result.code),
    true,
  );
  assert.equal(JSON.stringify(result.result).includes(forbiddenValue), false);
  assert.equal(Object.hasOwn(result.result, "error"), false);
}

test("manifest inventories deterministic local-bridge fixtures and closed codes", () => {
  assert.deepStrictEqual(manifest.profile, {
    family: "local-bridge",
    major: 0,
    minor: 0,
  });
  assert.equal(manifest.manifestVersion, 1);
  assert.deepStrictEqual(manifest.bounds, LOCAL_BRIDGE_BOUNDS);
  assert.deepStrictEqual(manifest.normalization, LOCAL_BRIDGE_NORMALIZATION_FORMULA);
  assert.equal(
    LOCAL_BRIDGE_BOUNDS.maxNormalizationBytes,
    LOCAL_BRIDGE_NORMALIZATION_FORMULA.budgetBytes,
  );
  assert.deepStrictEqual(manifest.requiredCapabilities, CAPABILITIES);
  assert.deepStrictEqual(manifest.resultCodes, [...LOCAL_BRIDGE_RESULT_CODES]);
  assert.deepStrictEqual(manifest.runtimeOnlyErrorCodes, [
    ...LOCAL_BRIDGE_RUNTIME_ONLY_ERROR_CODES,
  ]);
  assert.deepStrictEqual(manifest.failureCodes, [...LOCAL_BRIDGE_ERROR_CODES]);

  const manifestPaths = new Set();
  for (const fixture of manifest.fixtures) {
    assert.match(fixture.id, /^(?:valid|invalid)-[a-z0-9-]+$/);
    assert.equal(fixture.path, `fixtures/${fixture.id}.json`);
    assert.equal(manifestPaths.has(fixture.path), false);
    manifestPaths.add(fixture.path);
    assert.equal(typeof fixture.valid, "boolean");
    assert.ok(Array.isArray(fixture.covers) && fixture.covers.length > 0);
    if (!fixture.valid) {
      const expectedCodes = fixture.expectedCodes ?? [fixture.expectedCode];
      assert.ok(expectedCodes.length > 0);
      for (const code of expectedCodes) assert.equal(LOCAL_BRIDGE_ERROR_CODES.includes(code), true);
    }
    assert.doesNotThrow(() => readFixture(fixture.id));
  }
  const actualPaths = readdirSync(fixtureDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => `fixtures/${name}`)
    .sort();
  assert.deepEqual([...manifestPaths].sort(), actualPaths);
});

test("rendezvous is versioned, randomized, bounded, and lexically path-restricted", () => {
  const fixture = readFixture("valid-rendezvous");
  assert.equal(fixture.agentDirectory, `${fixture.installationRoot}/agent`);
  assert.equal(fixture.companionDirectory, `${fixture.installationRoot}/companion`);
  const parsed = parseLocalBridgeRendezvousJson(JSON.stringify(fixture.rendezvous));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.rendezvous, fixture.rendezvous);
  const directory = validateLocalBridgeDirectoryPath(fixture.companionDirectory);
  assert.equal(directory.ok, true);
  assert.equal(
    validateLocalBridgeSocketPath(fixture.socketPath, fixture.companionDirectory, parsed.rendezvous)
      .ok,
    true,
  );
  assertFailure(validateLocalBridgeSocketPath(fixture.socketPath), "unsafe-rendezvous");

  const lexicalTemporaryDirectory = validateLocalBridgeDirectoryPath("/tmp");
  assert.equal(lexicalTemporaryDirectory.ok, true);
  assert.equal(
    validateLocalBridgeSocketPath(
      `/tmp/${fixture.rendezvous.socketName}`,
      "/tmp",
      fixture.rendezvous,
    ).ok,
    true,
  );

  const invalid = readFixture("invalid-unsafe-rendezvous");
  const invalidDirectory = validateLocalBridgeDirectoryPath(invalid.companionDirectory);
  assert.equal(invalidDirectory.ok, true);
  const invalidRendezvous = parseLocalBridgeRendezvousJson({
    ...fixture.rendezvous,
    socketName: invalid.rendezvousSocketName,
  });
  assert.equal(invalidRendezvous.ok, true);
  for (const socketPath of invalid.invalidPaths) {
    assertFailure(
      validateLocalBridgeSocketPath(
        socketPath,
        invalid.companionDirectory,
        invalidRendezvous.rendezvous,
      ),
      invalid.expectedCode,
    );
  }
  const overlongDirectory = validateLocalBridgeDirectoryPath(invalid.overlongCompanionDirectory);
  assert.equal(overlongDirectory.ok, true);
  const overlongPath = `${invalid.overlongCompanionDirectory}/${invalid.rendezvousSocketName}`;
  assert.equal(
    Buffer.byteLength(overlongPath, "utf8") > LOCAL_BRIDGE_BOUNDS.maxSocketPathBytes,
    true,
  );
  assertFailure(
    validateLocalBridgeSocketPath(
      overlongPath,
      invalid.overlongCompanionDirectory,
      invalidRendezvous.rendezvous,
    ),
    invalid.expectedCode,
  );

  const malformed = { ...fixture.rendezvous, socketName: "predictable.sock" };
  assertFailure(parseLocalBridgeRendezvousJson(malformed), "malformed-rendezvous");
  assertFailure(
    parseLocalBridgeRendezvousJson("x".repeat(LOCAL_BRIDGE_BOUNDS.maxRendezvousBytes + 1)),
    "unsafe-rendezvous",
  );
});

test("frames use exact u32 big-endian lengths and preserve raw data bytes", () => {
  const body = new TextEncoder().encode("{}\n");
  const encoded = encodeLengthPrefixedFrame(body);
  assert.equal(encoded.ok, true);
  assert.deepEqual(Array.from(encoded.frame.slice(0, 4)), [0, 0, 0, 3]);
  const decoded = decodeLengthPrefixedFrame(encoded.frame);
  assert.equal(decoded.ok, true);
  assert.deepEqual([...decoded.body], [...body]);

  const exact = encodeLengthPrefixedFrame(new Uint8Array(LOCAL_BRIDGE_BOUNDS.maxFrameBodyBytes));
  assert.equal(exact.ok, true);
  assert.equal(decodeLengthPrefixedFrame(exact.frame).ok, true);

  const session = "conversation-raw";
  const envelope = snapshotEnvelope(session, {
    eventId: "g1-e1",
    revision: 1,
    cursor: "g1-c1",
    snapshotId: "g1-s1",
    status: "idle",
  });
  const raw = JSON.stringify(envelope);
  const dataFrame = dataCommandWithRaw(session, SOURCE_A, raw).frame;
  const dataDecoded = decodeLengthPrefixedFrame(dataFrame);
  assert.equal(dataDecoded.ok, true);
  assert.equal(new TextDecoder().decode(dataDecoded.body), raw);
  assert.equal(raw.includes('"kind":"data"'), false);
  const parsed = parseLocalBridgeDataFrame(dataFrame);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.rawJson, raw);
});

test("malformed, truncated, oversized, and non-UTF-8 frames fail closed", () => {
  const fixture = readFixture("invalid-frames");
  const oversized = new Uint8Array([0, 4, 0, 1]);
  assertFailure(decodeLengthPrefixedFrame(oversized), fixture.expected[0].code);
  assertFailure(
    decodeLengthPrefixedFrame(new Uint8Array([0, 0, 0, 5, 123])),
    fixture.expected[1].code,
  );
  const invalidJson = encodeLengthPrefixedFrame(new TextEncoder().encode("{"));
  assert.equal(invalidJson.ok, true);
  assertFailure(parseLocalBridgeHandshakeFrame(invalidJson.frame), fixture.expected[2].code);
  const invalidUtf8 = encodeLengthPrefixedFrame(new Uint8Array([0xc3, 0x28]));
  assert.equal(invalidUtf8.ok, true);
  assertFailure(parseLocalBridgeHandshakeFrame(invalidUtf8.frame), fixture.expected[3].code);

  const oversizedControl = encodeLengthPrefixedFrame(
    jsonBytes({ padding: "x".repeat(LOCAL_BRIDGE_BOUNDS.maxControlFrameBytes) }),
  );
  assert.equal(oversizedControl.ok, true);
  assertFailure(parseLocalBridgeHandshakeFrame(oversizedControl.frame), "control-frame-too-large");

  const oversizedDataBody = new Uint8Array(LOCAL_BRIDGE_BOUNDS.maxFrameBodyBytes + 1);
  const oversizedDataFrame = new Uint8Array(oversizedDataBody.byteLength + 4);
  oversizedDataFrame[0] = 0;
  oversizedDataFrame[1] = 4;
  oversizedDataFrame[2] = 0;
  oversizedDataFrame[3] = 1;
  oversizedDataFrame.set(oversizedDataBody, 4);
  assertFailure(parseLocalBridgeDataFrame(oversizedDataFrame), "frame-too-large");
});

test("handshake performs version, installation, token, and capability checks", () => {
  const major = readFixture("invalid-major-version");
  const state = stateFrom({
    installationId: major.installationId,
    launchToken: major.launchToken,
  });
  assertFailure(
    validateLocalBridgeHandshake({
      ...hello(major.sessionId, major.sourceInstanceId, { protocol: major.protocol }),
      installationId: major.installationId,
      launchToken: major.launchToken,
    }),
    major.expectedCode,
  );
  assertFailure(
    acceptLocalBridgeHandshake(
      state,
      hello("conversation-version", SOURCE_A, {
        protocol: { family: "local-bridge", major: 1, minor: 0 },
      }),
    ),
    "incompatible-protocol",
  );
  assertFailure(
    acceptLocalBridgeHandshake(
      state,
      hello("conversation-install", SOURCE_A, {
        installationId: "other-installation",
      }),
    ),
    "installation-mismatch",
  );
  assertFailure(
    acceptLocalBridgeHandshake(
      state,
      hello("conversation-token", SOURCE_A, {
        launchToken: "ffffffffffffffffffffffffffffffff",
      }),
    ),
    "token-mismatch",
  );
  const incompatible = readFixture("invalid-incompatible-capability");
  assertFailure(
    validateLocalBridgeHandshake({
      ...hello(incompatible.sessionId, incompatible.sourceInstanceId, {
        capabilities: incompatible.capabilities,
      }),
      installationId: incompatible.installationId,
      launchToken: incompatible.launchToken,
    }),
    incompatible.expectedCode,
  );
  assertFailure(
    validateLocalBridgeHandshake(
      hello("conversation-capability-missing", SOURCE_A, {
        capabilities: ["snapshot-replace"],
      }),
    ),
    "incompatible-capability",
  );
  assertFailure(
    validateLocalBridgeHandshake(
      hello("conversation-capability-duplicate", SOURCE_A, {
        capabilities: ["snapshot-replace", "cursor-recovery", "cursor-recovery"],
      }),
    ),
    "incompatible-capability",
  );
  assertFailure(
    validateLocalBridgeHandshake(
      hello("conversation-capability-malformed", SOURCE_A, {
        capabilities: ["snapshot-replace", 1],
      }),
    ),
    "malformed-frame",
  );
  assert.equal(RUNTIME_ONLY_ERROR_CODES.has("handshake-required"), true);
  assert.equal(RUNTIME_ONLY_ERROR_CODES.has("wrong-direction"), true);
  assert.equal(state.conversations.length, 0);
});

test("LocalBridge outer identities count Unicode code points and reject malformed scalars", () => {
  const exactIdentity = "\u{1f600}".repeat(LOCAL_BRIDGE_BOUNDS.maxIdentityCharacters);
  const overIdentity = "\u{1f600}".repeat(LOCAL_BRIDGE_BOUNDS.maxIdentityCharacters + 1);
  const overAsciiIdentity = "a".repeat(LOCAL_BRIDGE_BOUNDS.maxIdentityCharacters + 1);
  const malformedIdentities = ["\ud800", "\udfff", "prefix\ud800", "\udfff-suffix"];
  assert.equal([...exactIdentity].length, LOCAL_BRIDGE_BOUNDS.maxIdentityCharacters);
  assert.equal([...overIdentity].length, LOCAL_BRIDGE_BOUNDS.maxIdentityCharacters + 1);
  assert.equal([...overAsciiIdentity].length, LOCAL_BRIDGE_BOUNDS.maxIdentityCharacters + 1);

  const rendezvous = readFixture("valid-rendezvous").rendezvous;
  const validRendezvous = validateLocalBridgeRendezvous({
    ...rendezvous,
    installationId: exactIdentity,
  });
  assert.equal(validRendezvous.ok, true);
  const parsedRendezvous = parseLocalBridgeRendezvousJson(
    JSON.stringify({ ...rendezvous, installationId: exactIdentity }),
  );
  assert.equal(parsedRendezvous.ok, true);
  for (const installationId of [overIdentity, overAsciiIdentity, ...malformedIdentities]) {
    const candidate = { ...rendezvous, installationId };
    assertFailure(validateLocalBridgeRendezvous(candidate), "malformed-rendezvous");
    assertFailure(
      parseLocalBridgeRendezvousJson(JSON.stringify(candidate)),
      "malformed-rendezvous",
    );
  }

  const exactHello = hello(exactIdentity, SOURCE_A, { installationId: exactIdentity });
  const validHandshake = validateLocalBridgeHandshake(exactHello);
  assert.equal(validHandshake.ok, true);
  const parsedHandshake = parseLocalBridgeHandshakeFrame(frameFor(exactHello));
  assert.equal(parsedHandshake.ok, true);

  for (const field of ["installationId", "sessionId"]) {
    for (const value of [overIdentity, overAsciiIdentity, ...malformedIdentities]) {
      const candidate = { ...hello("valid-session", SOURCE_A), [field]: value };
      assertFailure(validateLocalBridgeHandshake(candidate), "malformed-frame");
      assertFailure(parseLocalBridgeHandshakeFrame(frameFor(candidate)), "malformed-frame");
    }
  }

  const exactState = createLocalBridgeState({
    installationId: exactIdentity,
    launchToken: LAUNCH_TOKEN,
  });
  assert.equal(exactState.ok, true);
  const accepted = acceptLocalBridgeHandshake(exactState.state, exactHello);
  assert.equal(accepted.ok, true);
  for (const installationId of [overIdentity, overAsciiIdentity, ...malformedIdentities]) {
    assertFailure(
      createLocalBridgeState({ installationId, launchToken: LAUNCH_TOKEN }),
      "invalid-input",
    );
  }
  for (const sessionId of [overIdentity, overAsciiIdentity, ...malformedIdentities]) {
    assertFailure(
      acceptLocalBridgeHandshake(
        exactState.state,
        hello(sessionId, SOURCE_A, { installationId: exactIdentity }),
      ),
      "malformed-frame",
    );
    assertFailure(
      applyLocalBridgeData(
        accepted.nextState,
        dataCommand(
          sessionId,
          SOURCE_A,
          snapshotEnvelope(exactIdentity, {
            eventId: "identity-boundary",
            revision: 0,
            cursor: "identity-cursor",
            snapshotId: "identity-snapshot",
            status: "idle",
          }),
        ),
      ),
      "invalid-input",
    );
  }
});

test("data remains bound to the handshaken session scope", () => {
  let state = stateFrom();
  state = accept(state, "conversation-bound", SOURCE_A).nextState;
  const mismatched = applyLocalBridgeData(
    state,
    dataCommand(
      "conversation-bound",
      SOURCE_A,
      snapshotEnvelope("different-conversation", {
        eventId: "g1-e1",
        revision: 1,
        cursor: "g1-c1",
        snapshotId: "g1-s1",
        status: "idle",
      }),
    ),
  );
  assertFailure(mismatched, "session-mismatch");
  assert.equal(state.bridgeRevision, 0);
});

test("sequential producer epochs reset v1 apply state while bridge revisions continue", () => {
  const fixture = readFixture("valid-sequential-source-epochs");
  let state = stateFrom({
    installationId: fixture.installationId,
    launchToken: fixture.launchToken,
  });
  const first = accept(state, fixture.sessionId, fixture.epochs[0].sourceInstanceId);
  state = first.nextState;
  const firstEnvelope = snapshotEnvelope(fixture.sessionId, fixture.epochs[0].snapshot);
  const firstPublication = publish(
    state,
    fixture.sessionId,
    fixture.epochs[0].sourceInstanceId,
    firstEnvelope,
  );
  assert.equal(firstPublication.result.code, fixture.expected.outcomes[0]);
  assert.equal(firstPublication.result.bridgeRevision, fixture.expected.bridgeRevisions[0]);
  state = firstPublication.nextState;
  state = disconnect(state, fixture.sessionId, fixture.epochs[0].sourceInstanceId).nextState;

  const second = accept(state, fixture.sessionId, fixture.epochs[1].sourceInstanceId);
  assert.equal(second.result.sourceEpoch, fixture.expected.sourceEpochs[1]);
  state = second.nextState;
  const secondEnvelope = snapshotEnvelope(fixture.sessionId, fixture.epochs[1].snapshot);
  const secondPublication = publish(
    state,
    fixture.sessionId,
    fixture.epochs[1].sourceInstanceId,
    secondEnvelope,
  );
  assert.equal(secondPublication.result.code, fixture.expected.outcomes[1]);
  assert.equal(secondPublication.result.bridgeRevision, fixture.expected.bridgeRevisions[1]);
  assert.equal(secondPublication.result.sourceEpoch, fixture.expected.sourceEpochs[1]);
  assertSafeWireResult(secondPublication, "g1-e1");
});

test("same source reconnect retains epoch and apply state", () => {
  const fixture = readFixture("valid-source-reconnect");
  let state = stateFrom({
    installationId: fixture.installationId,
    launchToken: fixture.launchToken,
  });
  state = accept(state, fixture.sessionId, fixture.sourceInstanceId).nextState;
  const first = publish(
    state,
    fixture.sessionId,
    fixture.sourceInstanceId,
    snapshotEnvelope(fixture.sessionId, fixture.snapshot),
  );
  assert.equal(first.result.bridgeRevision, fixture.expected.bridgeRevisions[0]);
  state = disconnect(first.nextState, fixture.sessionId, fixture.sourceInstanceId).nextState;
  const reconnect = accept(state, fixture.sessionId, fixture.sourceInstanceId);
  assert.equal(reconnect.result.sourceEpoch, fixture.expected.sourceEpoch);
  state = reconnect.nextState;
  const event = publish(
    state,
    fixture.sessionId,
    fixture.sourceInstanceId,
    statusEventEnvelope(fixture.sessionId, fixture.event),
  );
  assert.equal(event.result.code, fixture.expected.outcomes[1]);
  assert.equal(event.result.bridgeRevision, fixture.expected.bridgeRevisions[1]);
  assert.equal(event.nextState.conversations[0].sessionMirrorState.revision, 2);
});

test("one active owner rejects a concurrent source without changing state", () => {
  const fixture = readFixture("invalid-concurrent-owner");
  let state = stateFrom({
    installationId: fixture.installationId,
    launchToken: fixture.launchToken,
  });
  state = accept(state, fixture.sessionId, fixture.currentSourceInstanceId).nextState;
  const before = state;
  const competing = acceptLocalBridgeHandshake(
    state,
    hello(fixture.sessionId, fixture.competingSourceInstanceId),
  );
  assertFailure(competing, fixture.expectedCode);
  assert.equal(state, before);
  assert.equal(state.conversations[0].ownerSourceInstanceId, fixture.currentSourceInstanceId);
});

test("a superseded source can never reclaim a conversation", () => {
  const fixture = readFixture("invalid-superseded-source");
  let state = stateFrom({
    installationId: fixture.installationId,
    launchToken: fixture.launchToken,
  });
  state = accept(state, fixture.sessionId, fixture.firstSourceInstanceId).nextState;
  state = disconnect(state, fixture.sessionId, fixture.firstSourceInstanceId).nextState;
  state = accept(state, fixture.sessionId, fixture.replacementSourceInstanceId).nextState;
  const stale = acceptLocalBridgeHandshake(
    state,
    hello(fixture.sessionId, fixture.firstSourceInstanceId),
  );
  assertFailure(stale, fixture.expectedCode);
  const staleData = applyLocalBridgeData(
    state,
    dataCommand(
      fixture.sessionId,
      fixture.firstSourceInstanceId,
      snapshotEnvelope(fixture.sessionId, {
        eventId: "g1-e1",
        revision: 1,
        cursor: "g1-c1",
        snapshotId: "g1-s1",
        status: "error",
      }),
    ),
  );
  assertFailure(staleData, fixture.expectedCode);
  assert.equal(state.conversations[0].ownerSourceInstanceId, fixture.replacementSourceInstanceId);
});

test("eight conversation keys are admitted and the ninth is busy", () => {
  const fixture = readFixture("valid-eight-conversations");
  let state = stateFrom({
    installationId: fixture.installationId,
    launchToken: fixture.launchToken,
  });
  for (const [index, sessionId] of fixture.conversations.entries()) {
    const sourceId = `${String(index + 1).padStart(2, "0")}${"1".repeat(30)}`;
    state = accept(state, sessionId, sourceId).nextState;
  }
  assert.equal(state.conversations.length, fixture.expected.acceptedConnections);
  const ninth = readFixture("invalid-ninth-conversation");
  const rejected = acceptLocalBridgeHandshake(
    state,
    hello(ninth.ninthConversation, "99999999999999999999999999999999"),
  );
  assertFailure(rejected, ninth.expectedCode);
  assert.equal(state.conversations.length, fixture.expected.acceptedConnections);
});

test("idle eviction frees active state without forgetting ownership history", () => {
  const fixture = readFixture("valid-idle-eviction");
  let state = stateFrom({
    installationId: fixture.installationId,
    launchToken: fixture.launchToken,
  });
  state = accept(state, fixture.sessionId, fixture.initialSourceInstanceId).nextState;
  state = publish(
    state,
    fixture.sessionId,
    fixture.initialSourceInstanceId,
    snapshotEnvelope(fixture.sessionId, {
      eventId: "g1-e1",
      revision: 1,
      cursor: "g1-c1",
      snapshotId: "g1-s1",
      status: "idle",
    }),
  ).nextState;
  for (const [index, sessionId] of fixture.activeSlotSessions.slice(0, -1).entries()) {
    const sourceId = `${String(index + 1).padStart(2, "0")}${"2".repeat(30)}`;
    state = accept(state, sessionId, sourceId).nextState;
  }
  const beforeIdleThreshold = evictIdleLocalBridge(
    state,
    idleCommand(state, fixture.sessionId, fixture.idleMinutes - 1),
  );
  assertFailure(beforeIdleThreshold, "invalid-input");
  const evicted = evictIdleLocalBridge(
    state,
    idleCommand(state, fixture.sessionId, fixture.idleMinutes),
  );
  assert.equal(evicted.ok, true);
  assert.equal(evicted.result.code, fixture.expectedEvictionCode);
  state = evicted.nextState;
  const dormant = state.conversations.find(
    (conversation) => conversation.sessionId === fixture.sessionId,
  );
  assert.equal(dormant.dormant, true);
  assert.equal(dormant.connected, false);
  assert.equal(dormant.sessionMirrorState.sessionId, null);
  assert.equal(dormant.supersededSourceInstanceIds.length, 0);
  const repeatedEviction = evictIdleLocalBridge(
    state,
    idleCommand(state, fixture.sessionId, fixture.idleMinutes),
  );
  assert.equal(repeatedEviction.ok, true);
  assert.equal(repeatedEviction.result.code, fixture.expectedEvictionCode);
  assert.deepEqual(repeatedEviction.nextState, state);

  const admitted = accept(state, fixture.activeSlotSessions.at(-1), `${"8"}${"2".repeat(31)}`);
  assert.equal(admitted.result.code, "ready");
  state = admitted.nextState;
  const evictedSlot = evictIdleLocalBridge(
    state,
    idleCommand(state, fixture.activeSlotSessions.at(-1), fixture.idleMinutes),
  );
  assert.equal(evictedSlot.ok, true);
  state = evictedSlot.nextState;

  const reconnect = accept(state, fixture.sessionId, fixture.initialSourceInstanceId);
  assert.equal(reconnect.result.code, fixture.expectedReconnectCode);
  assert.equal(reconnect.result.snapshotRequired, true);
  state = reconnect.nextState;
  const gap = applyLocalBridgeData(
    state,
    dataCommand(
      fixture.sessionId,
      fixture.initialSourceInstanceId,
      statusEventEnvelope(fixture.sessionId, {
        eventId: "g1-e2",
        revision: 1,
        baseRevision: 0,
        cursor: "g1-c2",
        status: "active",
      }),
    ),
  );
  assertFailure(gap, "session-mirror-revision-gap");
  state = disconnect(state, fixture.sessionId, fixture.initialSourceInstanceId).nextState;
  state = accept(state, fixture.sessionId, fixture.replacementSourceInstanceId).nextState;
  const stale = acceptLocalBridgeHandshake(
    state,
    hello(fixture.sessionId, fixture.initialSourceInstanceId),
  );
  assertFailure(stale, fixture.expectedStaleCode);

  for (let index = 0; index < fixture.takeoverCountBeforeHistoryFull; index += 1) {
    const current = state.conversations.find(
      (conversation) => conversation.sessionId === fixture.sessionId,
    );
    state = disconnect(state, fixture.sessionId, current.ownerSourceInstanceId).nextState;
    const sourceId = `${(index + 16).toString(16).padStart(2, "0")}${fixture.takeoverSourceHex.repeat(30)}`;
    state = accept(state, fixture.sessionId, sourceId).nextState;
  }
  const current = state.conversations.find(
    (conversation) => conversation.sessionId === fixture.sessionId,
  );
  assert.equal(
    current.supersededSourceInstanceIds.length,
    LOCAL_BRIDGE_BOUNDS.maxSupersededSourceIds,
  );
  state = disconnect(state, fixture.sessionId, current.ownerSourceInstanceId).nextState;
  const historyFull = acceptLocalBridgeHandshake(
    state,
    hello(fixture.sessionId, `${"f"}${fixture.takeoverSourceHex.repeat(31)}`),
  );
  assertFailure(historyFull, fixture.expectedHistoryFullCode);

  let knownState = stateFrom({
    installationId: fixture.installationId,
    launchToken: fixture.launchToken,
  });
  for (let index = 0; index < fixture.knownRecordCountBeforeBusy; index += 1) {
    const sessionId = `known-${index}`;
    const sourceId = index.toString(16).padStart(32, "0");
    knownState = accept(knownState, sessionId, sourceId).nextState;
    knownState = evictIdleLocalBridge(
      knownState,
      idleCommand(knownState, sessionId, fixture.idleMinutes),
    ).nextState;
  }
  assert.equal(knownState.conversations.length, fixture.knownRecordCountBeforeBusy);
  const knownOverflow = acceptLocalBridgeHandshake(
    knownState,
    hello(fixture.knownRecordOverflowSession, `${"f"}${"0".repeat(31)}`),
  );
  assertFailure(knownOverflow, fixture.expectedKnownHistoryCode);
});

test("dormant reconnect and takeover reserve a slot before mutating ownership", () => {
  const fixture = readFixture("valid-dormant-slot-admission");
  let state = stateFrom({
    installationId: fixture.installationId,
    launchToken: fixture.launchToken,
  });

  state = accept(state, fixture.reconnect.sessionId, fixture.reconnect.sourceInstanceId).nextState;
  state = evictIdleLocalBridge(
    state,
    idleCommand(state, fixture.reconnect.sessionId, fixture.idleMinutes),
  ).nextState;
  state = accept(state, fixture.takeover.sessionId, fixture.takeover.oldSourceInstanceId).nextState;
  state = evictIdleLocalBridge(
    state,
    idleCommand(state, fixture.takeover.sessionId, fixture.idleMinutes),
  ).nextState;

  for (const [index, sessionId] of fixture.activeSlotSessions.entries()) {
    const sourceId = `${String(index + 1).padStart(2, "0")}${"4".repeat(30)}`;
    state = accept(state, sessionId, sourceId).nextState;
  }
  assert.equal(
    state.conversations.filter((conversation) => !conversation.dormant).length,
    fixture.expected.activeCountWhenFull,
  );

  const reconnectBefore = state.conversations.find(
    (conversation) => conversation.sessionId === fixture.reconnect.sessionId,
  );
  const reconnectRejected = acceptLocalBridgeHandshake(
    state,
    hello(fixture.reconnect.sessionId, fixture.reconnect.sourceInstanceId),
  );
  assertFailure(reconnectRejected, fixture.expected.busyCode);
  assert.deepEqual(
    state.conversations.find(
      (conversation) => conversation.sessionId === fixture.reconnect.sessionId,
    ),
    reconnectBefore,
  );

  const takeoverBefore = state.conversations.find(
    (conversation) => conversation.sessionId === fixture.takeover.sessionId,
  );
  const takeoverRejected = acceptLocalBridgeHandshake(
    state,
    hello(fixture.takeover.sessionId, fixture.takeover.newSourceInstanceId),
  );
  assertFailure(takeoverRejected, fixture.expected.busyCode);
  assert.deepEqual(
    state.conversations.find(
      (conversation) => conversation.sessionId === fixture.takeover.sessionId,
    ),
    takeoverBefore,
  );

  state = evictIdleLocalBridge(
    state,
    idleCommand(state, fixture.activeSlotSessions[0], fixture.idleMinutes),
  ).nextState;
  const reconnectAdmitted = accept(
    state,
    fixture.reconnect.sessionId,
    fixture.reconnect.sourceInstanceId,
  );
  assert.equal(reconnectAdmitted.result.code, fixture.expected.admissionCode);
  assert.equal(reconnectAdmitted.result.snapshotRequired, fixture.expected.snapshotRequired);
  assert.equal(
    reconnectAdmitted.nextState.conversations.find(
      (conversation) => conversation.sessionId === fixture.reconnect.sessionId,
    ).activityGeneration,
    1,
  );
  state = reconnectAdmitted.nextState;
  const reconnectConversation = state.conversations.find(
    (conversation) => conversation.sessionId === fixture.reconnect.sessionId,
  );
  assert.equal(reconnectConversation.dormant, false);
  assert.equal(reconnectConversation.connected, true);

  state = evictIdleLocalBridge(
    state,
    idleCommand(state, fixture.activeSlotSessions[1], fixture.idleMinutes),
  ).nextState;
  const takeoverAdmitted = accept(
    state,
    fixture.takeover.sessionId,
    fixture.takeover.newSourceInstanceId,
  );
  assert.equal(takeoverAdmitted.result.code, fixture.expected.admissionCode);
  assert.equal(takeoverAdmitted.result.snapshotRequired, fixture.expected.snapshotRequired);
  const takeoverConversation = takeoverAdmitted.nextState.conversations.find(
    (conversation) => conversation.sessionId === fixture.takeover.sessionId,
  );
  assert.equal(takeoverConversation.dormant, false);
  assert.equal(takeoverConversation.connected, true);
  assert.equal(takeoverConversation.activityGeneration, 0);
  assert.equal(takeoverConversation.ownerSourceInstanceId, fixture.takeover.newSourceInstanceId);
  assert.deepEqual(takeoverConversation.supersededSourceInstanceIds, [
    fixture.takeover.oldSourceInstanceId,
  ]);
});

test("idle eviction tokens reject stale activity and exact-token eviction is safe", () => {
  const fixture = readFixture("valid-idle-activity-generation");
  let state = stateFrom({
    installationId: fixture.installationId,
    launchToken: fixture.launchToken,
  });
  state = accept(state, fixture.sessionId, fixture.initialSourceInstanceId).nextState;
  assert.equal(state.conversations[0].activityGeneration, 0);
  const oldActivityTimer = idleCommand(state, fixture.sessionId, fixture.idleMinutes);
  const firstSnapshot = snapshotEnvelope(fixture.sessionId, {
    eventId: "g1-e1",
    revision: 1,
    cursor: "g1-c1",
    snapshotId: "g1-s1",
    status: "idle",
  });
  state = publish(
    state,
    fixture.sessionId,
    fixture.initialSourceInstanceId,
    firstSnapshot,
  ).nextState;
  assert.equal(state.conversations[0].activityGeneration, 1);
  const deduplicated = applyLocalBridgeData(
    state,
    dataCommand(fixture.sessionId, fixture.initialSourceInstanceId, firstSnapshot),
  );
  assert.equal(deduplicated.ok, true);
  assert.equal(deduplicated.result.code, "deduplicated");
  assert.equal(deduplicated.nextState.conversations[0].activityGeneration, 2);
  state = deduplicated.nextState;
  const event = statusEventEnvelope(fixture.sessionId, {
    eventId: "g1-e2",
    revision: 2,
    baseRevision: 1,
    cursor: "g1-c2",
    status: "active",
  });
  const acceptedEvent = publish(state, fixture.sessionId, fixture.initialSourceInstanceId, event);
  assert.equal(acceptedEvent.nextState.conversations[0].activityGeneration, 3);
  const duplicateEvent = applyLocalBridgeData(
    acceptedEvent.nextState,
    dataCommand(fixture.sessionId, fixture.initialSourceInstanceId, event),
  );
  assert.equal(duplicateEvent.ok, true);
  assert.equal(duplicateEvent.result.code, "duplicate");
  assert.equal(duplicateEvent.nextState.conversations[0].activityGeneration, 4);
  state = duplicateEvent.nextState;
  const beforeStaleActivity = state;
  const staleActivity = evictIdleLocalBridge(state, oldActivityTimer);
  assertFailure(staleActivity, fixture.expected.staleActivityCode);
  assert.deepEqual(state, beforeStaleActivity);

  const exactTimer = idleCommand(state, fixture.sessionId, fixture.idleMinutes);
  const evicted = evictIdleLocalBridge(state, exactTimer);
  assert.equal(evicted.ok, true);
  assert.equal(evicted.result.code, fixture.expected.evictionCode);
  assertSafeWireResult(evicted, fixture.initialSourceInstanceId);
  state = evicted.nextState;
  const reconnect = accept(state, fixture.sessionId, fixture.initialSourceInstanceId);
  assert.equal(reconnect.result.code, fixture.expected.reconnectCode);
  assert.equal(reconnect.result.snapshotRequired, fixture.expected.snapshotRequired);
  state = reconnect.nextState;

  const disconnected = disconnect(state, fixture.sessionId, fixture.initialSourceInstanceId);
  assert.equal(disconnected.nextState.conversations[0].activityGeneration, 6);
  state = disconnected.nextState;
  const oldOwnerTimer = idleCommand(state, fixture.sessionId, fixture.idleMinutes);
  state = accept(state, fixture.sessionId, fixture.replacementSourceInstanceId).nextState;
  const beforeOldOwnerTimer = state;
  const oldOwnerEviction = evictIdleLocalBridge(state, oldOwnerTimer);
  assertFailure(oldOwnerEviction, fixture.expected.staleOwnerCode);
  assert.deepEqual(state, beforeOldOwnerTimer);

  const replacementTimer = idleCommand(state, fixture.sessionId, fixture.idleMinutes);
  const staleEpoch = evictIdleLocalBridge(state, {
    ...replacementTimer,
    sourceEpoch: replacementTimer.sourceEpoch - 1,
  });
  assertFailure(staleEpoch, fixture.expected.staleActivityCode);
  const replacementEviction = evictIdleLocalBridge(state, replacementTimer);
  assert.equal(replacementEviction.ok, true);
  assert.equal(replacementEviction.result.code, fixture.expected.evictionCode);
  state = replacementEviction.nextState;
  const replacementReconnect = accept(
    state,
    fixture.sessionId,
    fixture.replacementSourceInstanceId,
  );
  assert.equal(replacementReconnect.result.snapshotRequired, fixture.expected.snapshotRequired);
  const gap = applyLocalBridgeData(
    replacementReconnect.nextState,
    dataCommand(
      fixture.sessionId,
      fixture.replacementSourceInstanceId,
      statusEventEnvelope(fixture.sessionId, {
        eventId: "g1-e2",
        revision: 1,
        baseRevision: 0,
        cursor: "g1-c2",
        status: "active",
      }),
    ),
  );
  assertFailure(gap, "session-mirror-revision-gap");
});

test("exact-byte snapshot dedup is only an optimization", () => {
  const fixture = readFixture("valid-identical-snapshot-dedup");
  let state = stateFrom({
    installationId: fixture.installationId,
    launchToken: fixture.launchToken,
  });
  state = accept(state, fixture.sessionId, fixture.sourceInstanceId).nextState;
  const envelope = snapshotEnvelope(fixture.sessionId, fixture.snapshot);
  const first = publish(state, fixture.sessionId, fixture.sourceInstanceId, envelope);
  state = first.nextState;
  assert.equal(first.result.code, fixture.expected.outcomes[0]);
  assert.equal(first.result.bridgeRevision, fixture.expected.bridgeRevisions[0]);
  const firstConversation = first.nextState.conversations[0];
  assert.equal(typeof firstConversation.lastSnapshotSha256, "string");
  assert.equal(firstConversation.lastSnapshotSha256.length, 64);
  const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope));
  assert.equal(
    firstConversation.lastSnapshotSha256,
    createHash("sha256").update(envelopeBytes).digest("hex"),
  );
  assert.equal(firstConversation.lastSnapshotByteLength, envelopeBytes.byteLength);
  assert.equal(Object.hasOwn(firstConversation, "lastSnapshotBytesBase64"), false);

  const exact = applyLocalBridgeData(
    state,
    dataCommandWithRaw(fixture.sessionId, fixture.sourceInstanceId, JSON.stringify(envelope)),
  );
  assert.equal(exact.ok, true);
  assert.equal(exact.result.code, fixture.expected.outcomes[1]);
  assert.equal(exact.result.bridgeRevision, fixture.expected.bridgeRevisions[1]);
  state = exact.nextState;

  const reordered = reverseObjectKeys(envelope);
  const semanticDuplicate = applyLocalBridgeData(
    state,
    dataCommandWithRaw(fixture.sessionId, fixture.sourceInstanceId, JSON.stringify(reordered)),
  );
  assert.equal(semanticDuplicate.ok, true);
  assert.equal(semanticDuplicate.result.code, fixture.expected.outcomes[2]);
  assert.equal(semanticDuplicate.result.bridgeRevision, fixture.expected.bridgeRevisions[2]);
  assert.notEqual(exact.result.code, semanticDuplicate.result.code);

  const newIdentity = snapshotEnvelope(fixture.sessionId, {
    ...fixture.snapshot,
    eventId: "g1-e2",
    cursor: "g1-c2",
  });
  const acceptedNewIdentity = publish(
    semanticDuplicate.nextState,
    fixture.sessionId,
    fixture.sourceInstanceId,
    newIdentity,
  );
  assert.equal(acceptedNewIdentity.result.code, "accepted");
  assert.equal(acceptedNewIdentity.result.bridgeRevision, 2);
});

test("a bridge restart resets memory and rotates the token", () => {
  const fixture = readFixture("valid-bridge-restart");
  let oldState = stateFrom({ launchToken: fixture.oldLaunchToken });
  oldState = accept(oldState, fixture.sessionId, fixture.sourceInstanceId).nextState;
  const oldPublication = publish(
    oldState,
    fixture.sessionId,
    fixture.sourceInstanceId,
    snapshotEnvelope(fixture.sessionId, {
      eventId: "g1-e1",
      revision: 1,
      cursor: "g1-c1",
      snapshotId: "g1-s1",
      status: "idle",
    }),
  );
  assert.equal(oldPublication.result.bridgeRevision, 1);

  const restarted = stateFrom({ launchToken: fixture.newLaunchToken });
  assert.equal(restarted.bridgeRevision, fixture.expected.newBridgeRevision);
  assert.equal(restarted.conversations.length, 0);
  assertFailure(
    acceptLocalBridgeHandshake(
      restarted,
      hello(fixture.sessionId, fixture.sourceInstanceId, {
        launchToken: fixture.oldLaunchToken,
      }),
    ),
    fixture.expected.oldTokenCode,
  );
  const fresh = acceptLocalBridgeHandshake(
    restarted,
    hello(fixture.sessionId, fixture.sourceInstanceId, {
      launchToken: fixture.newLaunchToken,
    }),
  );
  assert.equal(fresh.ok, true);
  assert.equal(fresh.result.snapshotRequired, true);
});

test("a new epoch requires an authoritative snapshot before incremental data", () => {
  let state = stateFrom();
  state = accept(state, "conversation-first-snapshot", SOURCE_A).nextState;
  const event = statusEventEnvelope("conversation-first-snapshot", {
    eventId: "g1-e1",
    revision: 1,
    baseRevision: 0,
    cursor: "g1-c1",
    status: "active",
  });
  assertFailure(
    applyLocalBridgeData(state, dataCommand("conversation-first-snapshot", SOURCE_A, event)),
    "session-mirror-revision-gap",
  );
  assert.equal(state.bridgeRevision, 0);
});

test("v1 retained boundaries survive apply, disconnect, eviction, and teardown", () => {
  const sessionId = "conversation-v1-boundary-closure";
  const identity = "😀".repeat(SESSION_MIRROR_BOUNDS.maxIdentityCharacters);
  const cursor = "🧭".repeat(SESSION_MIRROR_BOUNDS.maxCursorCharacters);
  let state = stateFrom();
  state = accept(state, sessionId, SOURCE_A).nextState;

  const snapshot = snapshotEnvelope(sessionId, {
    eventId: identity,
    revision: 0,
    cursor,
    snapshotId: identity,
    status: "idle",
  });
  const rawSnapshot = JSON.stringify(snapshot).replace('"revision":0', '"revision":-0');
  const appliedSnapshot = applyLocalBridgeData(
    state,
    dataCommandWithRaw(sessionId, SOURCE_A, rawSnapshot),
  );
  assert.equal(appliedSnapshot.ok, true);
  assert.equal(appliedSnapshot.result.code, "accepted");
  state = appliedSnapshot.nextState;

  let conversation = state.conversations[0];
  assert.equal(conversation.sessionMirrorState.cursor, cursor);
  assert.equal(conversation.sessionMirrorState.snapshotId, identity);
  assert.equal(conversation.sessionMirrorState.seenMessages[0].eventId, identity);
  assert.equal(Object.is(conversation.sessionMirrorState.revision, -0), true);
  assert.equal(Object.is(conversation.lastSnapshotRevision, -0), true);

  const disconnected = disconnect(state, sessionId, SOURCE_A);
  assert.equal(disconnected.ok, true);
  assert.equal(
    Object.is(disconnected.nextState.conversations[0].sessionMirrorState.revision, -0),
    true,
  );
  state = disconnected.nextState;

  const reconnected = accept(state, sessionId, SOURCE_A);
  assert.equal(reconnected.ok, true);
  assert.equal(
    Object.is(reconnected.nextState.conversations[0].sessionMirrorState.revision, -0),
    true,
  );
  state = reconnected.nextState;

  const event = statusEventEnvelope(sessionId, {
    eventId: "🧩".repeat(SESSION_MIRROR_BOUNDS.maxIdentityCharacters),
    revision: 1,
    baseRevision: 0,
    cursor,
    status: "active",
  });
  const appliedEvent = publish(state, sessionId, SOURCE_A, event);
  assert.equal(appliedEvent.result.code, "accepted");
  state = appliedEvent.nextState;
  conversation = state.conversations[0];
  assert.equal(conversation.sessionMirrorState.seenMessages.length, 2);
  assert.equal(conversation.sessionMirrorState.cursor, cursor);

  const disconnectedAgain = disconnect(state, sessionId, SOURCE_A);
  assert.equal(disconnectedAgain.ok, true);
  state = disconnectedAgain.nextState;
  const evicted = evictIdleLocalBridge(
    state,
    idleCommand(state, sessionId, LOCAL_BRIDGE_BOUNDS.idleEvictionMinutes),
  );
  assert.equal(evicted.ok, true);
  assert.equal(evicted.result.code, "evicted");
  state = evicted.nextState;

  const closed = teardownLocalBridge(state);
  assert.equal(closed.ok, true);
  assert.deepEqual(closed.result, { kind: "result", code: "closed" });
});

test("v1 retained over-bounds and bridge-owned negative zero fail closed", () => {
  const sessionId = "conversation-v1-negative-controls";
  const overIdentity = "😀".repeat(SESSION_MIRROR_BOUNDS.maxIdentityCharacters + 1);
  const overCursor = "🧭".repeat(SESSION_MIRROR_BOUNDS.maxCursorCharacters + 1);
  const cases = [
    snapshotEnvelope(sessionId, {
      eventId: overIdentity,
      revision: 0,
      cursor: "cursor",
      snapshotId: "snapshot",
      status: "idle",
    }),
    snapshotEnvelope(sessionId, {
      eventId: "event",
      revision: 0,
      cursor: "cursor",
      snapshotId: overIdentity,
      status: "idle",
    }),
    snapshotEnvelope(sessionId, {
      eventId: "event",
      revision: 0,
      cursor: overCursor,
      snapshotId: "snapshot",
      status: "idle",
    }),
  ];
  for (const envelope of cases) {
    let state = stateFrom();
    state = accept(state, sessionId, SOURCE_A).nextState;
    assertFailure(
      applyLocalBridgeData(state, dataCommand(sessionId, SOURCE_A, envelope)),
      "session-mirror-bounds",
    );
  }

  let state = stateFrom();
  state = accept(state, sessionId, SOURCE_A).nextState;
  const applied = publish(
    state,
    sessionId,
    SOURCE_A,
    snapshotEnvelope(sessionId, {
      eventId: "event",
      revision: 0,
      cursor: "cursor",
      snapshotId: "snapshot",
      status: "idle",
    }),
  );
  state = applied.nextState;
  const conversation = state.conversations[0];
  const invalidRetainedStates = [
    {
      ...state,
      conversations: [
        {
          ...conversation,
          sessionMirrorState: {
            ...conversation.sessionMirrorState,
            cursor: overCursor,
          },
        },
      ],
    },
    {
      ...state,
      conversations: [
        {
          ...conversation,
          sessionMirrorState: {
            ...conversation.sessionMirrorState,
            snapshotId: overIdentity,
          },
        },
      ],
    },
    {
      ...state,
      conversations: [
        {
          ...conversation,
          sessionMirrorState: {
            ...conversation.sessionMirrorState,
            seenMessages: [
              {
                ...conversation.sessionMirrorState.seenMessages[0],
                eventId: overIdentity,
              },
            ],
          },
        },
      ],
    },
  ];
  for (const invalidState of invalidRetainedStates) {
    assertFailure(teardownLocalBridge(invalidState), "invalid-input");
  }
  assertFailure(
    disconnectLocalBridge(
      { ...state, bridgeRevision: -0 },
      {
        sessionId,
        sourceInstanceId: SOURCE_A,
      },
    ),
    "invalid-input",
  );
  assertFailure(
    disconnectLocalBridge(
      {
        ...state,
        conversations: state.conversations.map((conversation) => ({
          ...conversation,
          activityGeneration: -0,
        })),
      },
      { sessionId, sourceInstanceId: SOURCE_A },
    ),
    "invalid-input",
  );
});

test("large valid v1 state survives another transition and teardown normalization", () => {
  const fixture = readFixture("valid-large-state-normalization");
  let state = stateFrom({
    installationId: fixture.installationId,
    launchToken: fixture.launchToken,
  });
  state = accept(state, fixture.sessionId, fixture.sourceInstanceId).nextState;
  state = publish(
    state,
    fixture.sessionId,
    fixture.sourceInstanceId,
    largeSnapshotEnvelope(fixture.sessionId, {
      eventId: "large-snapshot",
      revision: 1,
      cursor: "large-snapshot-cursor",
      snapshotId: "large-snapshot-id",
      status: fixture.idleStatus,
      entryCount: fixture.entryCount,
      textBytes: fixture.textBytes,
    }),
  ).nextState;
  for (let index = 1; index <= fixture.eventCount; index += 1) {
    const publication = publish(
      state,
      fixture.sessionId,
      fixture.sourceInstanceId,
      largeEventEnvelope(fixture.sessionId, {
        eventId: `large-e${index}`,
        revision: index + 1,
        baseRevision: index,
        cursor: `large-c${index}`,
        status: fixture.idleStatus,
        paddingBytes: fixture.paddingBytes,
      }),
    );
    state = publication.nextState;
  }
  const conversation = state.conversations.find((item) => item.sessionId === fixture.sessionId);
  const canonicalBytes = conversation.sessionMirrorState.seenMessages.reduce(
    (total, message) => total + Buffer.byteLength(message.canonical, "utf8"),
    0,
  );
  assert.equal(conversation.sessionMirrorState.seenMessages.length, fixture.eventCount + 1);
  assert.ok(canonicalBytes > fixture.expectedMinimumCanonicalBytes);
  assert.ok(canonicalBytes < LOCAL_BRIDGE_BOUNDS.maxNormalizationBytes);

  const transitioned = disconnect(state, fixture.sessionId, fixture.sourceInstanceId);
  assert.equal(transitioned.result.code, fixture.expected.transitionCode);
  const closed = teardownLocalBridge(transitioned.nextState);
  assert.equal(closed.ok, true);
  assert.equal(closed.result.code, fixture.expected.teardownCode);
  assert.deepEqual(closed.result, { kind: "result", code: "closed" });
});

test("teardown closes and drops all state idempotently", () => {
  const fixture = readFixture("valid-teardown");
  let state = stateFrom();
  state = accept(state, "conversation-teardown", SOURCE_C).nextState;
  const first = teardownLocalBridge(state);
  assert.equal(first.ok, true);
  assert.equal(first.result.code, fixture.expected.firstCode);
  assert.deepEqual(first.result, { kind: "result", code: "closed" });
  assertRoundTripResult(first);
  assert.equal(first.nextState.status, "closed");
  assert.equal(first.nextState.conversations.length, fixture.expected.conversationsAfterTeardown);

  const second = teardownLocalBridge(first.nextState);
  assert.equal(second.ok, true);
  assert.equal(second.result.code, fixture.expected.secondCode);
  assert.deepEqual(second.result, { kind: "result", code: "closed" });
  assertRoundTripResult(second);
  assert.equal(second.nextState.status, "closed");
  assert.equal(second.nextState.conversations.length, 0);
  assertFailure(
    acceptLocalBridgeHandshake(first.nextState, hello("after-close", SOURCE_A)),
    "closed",
  );
  assertFailure(
    applyLocalBridgeData(
      first.nextState,
      dataCommand(
        "conversation-teardown",
        SOURCE_C,
        snapshotEnvelope("conversation-teardown", {
          eventId: "g1-e1",
          revision: 1,
          cursor: "g1-c1",
          snapshotId: "g1-s1",
          status: "idle",
        }),
      ),
    ),
    fixture.expected.postTeardownOperation,
  );
});

test("hostile and malformed values never escape as throws or source-bearing diagnostics", () => {
  const fixture = readFixture("invalid-hostile-boundaries");
  const cycle = hello("hostile-cycle", SOURCE_A);
  cycle.extra = cycle;
  const accessor = hello("hostile-accessor", SOURCE_A);
  Object.defineProperty(accessor, "extra", {
    enumerable: true,
    get() {
      throw new Error("source-content must not be read");
    },
  });
  const prototypeValue = Object.create({ inherited: true });
  Object.assign(prototypeValue, hello("hostile-prototype", SOURCE_A));
  const hole = hello("hostile-hole", SOURCE_A, {
    capabilities: ["snapshot-replace", undefined],
  });
  const primitive = hello("hostile-primitive", SOURCE_A, {
    capabilities: ["snapshot-replace", 1n],
  });
  const hostileInputs = {
    cycle,
    accessor,
    prototype: prototypeValue,
    "array-hole": hole,
    "non-json-primitive": primitive,
  };
  for (const caseName of fixture.cases) {
    assert.ok(Object.hasOwn(hostileInputs, caseName));
    assert.doesNotThrow(() => {
      const result = validateLocalBridgeHandshake(hostileInputs[caseName]);
      assertFailure(result, fixture.expectedCode);
    });
  }
  const invalidState = createLocalBridgeState({
    installationId: INSTALLATION_ID,
    launchToken: "bad",
  });
  assertFailure(invalidState, "invalid-input");

  const state = stateFrom();
  const connected = accept(state, "conversation-safe-result", SOURCE_A).nextState;
  const sourceValue = "synthetic-source-value";
  const envelope = snapshotEnvelope("conversation-safe-result", {
    eventId: "g1-e1",
    revision: 1,
    cursor: "g1-c1",
    snapshotId: "g1-s1",
    status: "idle",
  });
  envelope.message.snapshot.tree.entries = [
    {
      id: "synthetic-entry",
      parentId: null,
      kind: "custom.synthetic",
      payload: { value: sourceValue },
    },
  ];
  envelope.message.snapshot.tree.rootIds = ["synthetic-entry"];
  const applied = applyLocalBridgeData(
    connected,
    dataCommand("conversation-safe-result", SOURCE_A, envelope),
  );
  assert.equal(applied.ok, true);
  assertSafeWireResult(applied, sourceValue);
  const wire = encodeLocalBridgeResultFrame(applied.result);
  assert.equal(wire.ok, true);
  const parsed = parseLocalBridgeResultFrame(wire.frame);
  assert.equal(parsed.ok, true);
  assert.equal(JSON.stringify(parsed.result).includes(sourceValue), false);
});

test("direct control normalization rejects oversized depth, containers, collections, and bytes", () => {
  const oversizedCapabilities = Array.from(
    { length: LOCAL_BRIDGE_BOUNDS.maxDirectNormalizationCollection + 1 },
    () => undefined,
  );
  assertFailure(
    validateLocalBridgeHandshake(
      hello("direct-oversized-array", SOURCE_A, { capabilities: oversizedCapabilities }),
    ),
    "malformed-frame",
  );

  const oversizedRendezvous = Object.fromEntries(
    Array.from({ length: LOCAL_BRIDGE_BOUNDS.maxDirectNormalizationCollection + 1 }, (_, index) => [
      `field-${index}`,
      null,
    ]),
  );
  assertFailure(validateLocalBridgeRendezvous(oversizedRendezvous), "malformed-rendezvous");

  const oversizedResultValue = Object.fromEntries(
    Array.from({ length: LOCAL_BRIDGE_BOUNDS.maxDirectNormalizationCollection + 1 }, (_, index) => [
      `field-${index}`,
      null,
    ]),
  );
  assertFailure(
    validateLocalBridgeResult({
      kind: "result",
      code: "accepted",
      bridgeRevision: oversizedResultValue,
      sourceEpoch: 1,
    }),
    "malformed-frame",
  );

  let nested = null;
  for (let index = 0; index <= LOCAL_BRIDGE_BOUNDS.maxDirectNormalizationDepth; index += 1) {
    nested = { next: nested };
  }
  assertFailure(
    validateLocalBridgeHandshake(
      hello("direct-oversized-depth", SOURCE_A, { installationId: nested }),
    ),
    "malformed-frame",
  );

  const broad = (levels) =>
    levels === 0 ? null : { left: broad(levels - 1), right: broad(levels - 1) };
  assertFailure(
    validateLocalBridgeHandshake(
      hello("direct-oversized-containers", SOURCE_A, { installationId: broad(8) }),
    ),
    "malformed-frame",
  );

  assertFailure(
    validateLocalBridgeHandshake(
      hello("direct-oversized-bytes", SOURCE_A, {
        installationId: "x".repeat(LOCAL_BRIDGE_BOUNDS.maxDirectNormalizationBytes + 1),
      }),
    ),
    "malformed-frame",
  );
});

test("result frames require positive epochs and accept documented numeric bounds", () => {
  const candidates = [
    { kind: "result", code: "accepted", bridgeRevision: 0, sourceEpoch: 1 },
    {
      kind: "result",
      code: "accepted",
      bridgeRevision: LOCAL_BRIDGE_BOUNDS.maxBridgeRevision,
      sourceEpoch: LOCAL_BRIDGE_BOUNDS.maxSourceEpoch,
    },
  ];
  for (const candidate of candidates) {
    const validated = validateLocalBridgeResult(candidate);
    assert.equal(validated.ok, true);
    const encoded = encodeLocalBridgeResultFrame(candidate);
    assert.equal(encoded.ok, true);
    const parsed = parseLocalBridgeResultFrame(encoded.frame);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.result, candidate);
  }

  const zeroEpoch = { ...candidates[0], sourceEpoch: 0 };
  assertFailure(validateLocalBridgeResult(zeroEpoch), "malformed-frame");
  assertFailure(encodeLocalBridgeResultFrame(zeroEpoch), "malformed-frame");
  assertFailure(parseLocalBridgeResultFrame(frameFor(zeroEpoch)), "malformed-frame");

  const negativeZeroRevision = { ...candidates[0], bridgeRevision: -0 };
  const negativeZeroEpoch = { ...candidates[0], sourceEpoch: -0 };
  for (const candidate of [negativeZeroRevision, negativeZeroEpoch]) {
    assertFailure(validateLocalBridgeResult(candidate), "malformed-frame");
    assertFailure(encodeLocalBridgeResultFrame(candidate), "malformed-frame");
  }
  const literalNegativeZeroRevision = encodeLengthPrefixedFrame(
    new TextEncoder().encode(
      '{"kind":"result","code":"accepted","bridgeRevision":-0,"sourceEpoch":1}',
    ),
  );
  assert.equal(literalNegativeZeroRevision.ok, true);
  assertFailure(parseLocalBridgeResultFrame(literalNegativeZeroRevision.frame), "malformed-frame");
  const literalNegativeZeroEpoch = encodeLengthPrefixedFrame(
    new TextEncoder().encode(
      '{"kind":"result","code":"accepted","bridgeRevision":0,"sourceEpoch":-0}',
    ),
  );
  assert.equal(literalNegativeZeroEpoch.ok, true);
  assertFailure(parseLocalBridgeResultFrame(literalNegativeZeroEpoch.frame), "malformed-frame");

  assertFailure(
    validateLocalBridgeResult({
      ...candidates[0],
      sourceEpoch: LOCAL_BRIDGE_BOUNDS.maxSourceEpoch + 1,
    }),
    "malformed-frame",
  );
  assertFailure(
    validateLocalBridgeResult({
      ...candidates[0],
      bridgeRevision: LOCAL_BRIDGE_BOUNDS.maxBridgeRevision + 1,
    }),
    "malformed-frame",
  );
});

test("result frames strictly validate and round-trip every lifecycle result", () => {
  for (const code of LOCAL_BRIDGE_RESULT_CODES) {
    const candidate = {
      kind: "result",
      code,
      ...(code === "closed" ? {} : { bridgeRevision: 7, sourceEpoch: 3 }),
      ...(code === "ready" ? { snapshotRequired: true } : {}),
    };
    const validated = validateLocalBridgeResult(candidate);
    assert.equal(validated.ok, true, code);
    const encoded = encodeLocalBridgeResultFrame(candidate);
    assert.equal(encoded.ok, true, code);
    const parsed = parseLocalBridgeResultFrame(encoded.frame);
    assert.equal(parsed.ok, true, code);
    assert.deepEqual(parsed.result, validated.result, code);
    assert.deepEqual(parsed.result, candidate, code);
  }
  assertFailure(
    validateLocalBridgeResult({ kind: "result", code: "arbitrary-error" }),
    "malformed-frame",
  );
  assertFailure(validateLocalBridgeResult({ kind: "result", code: "accepted" }), "malformed-frame");
  assertFailure(
    validateLocalBridgeResult({
      kind: "result",
      code: "ready",
      bridgeRevision: 1,
      sourceEpoch: 1,
    }),
    "malformed-frame",
  );
  assertFailure(
    validateLocalBridgeResult({
      kind: "result",
      code: "accepted",
      bridgeRevision: 1,
      sourceEpoch: 1,
      snapshotRequired: false,
    }),
    "malformed-frame",
  );
  assertFailure(
    validateLocalBridgeResult({ kind: "result", code: "closed", sourceEpoch: 1 }),
    "malformed-frame",
  );
  assertFailure(
    validateLocalBridgeResult({ kind: "result", code: "accepted", extra: "not-allowed" }),
    "malformed-frame",
  );
});

test("frozen session-mirror/v1 normative hashes remain unchanged", () => {
  const files = manifest.frozenDependencies[0].normativeFiles;
  for (const file of files) {
    const digest = createHash("sha256")
      .update(readFileSync(join(repoRoot, file.path)))
      .digest("hex");
    assert.equal(digest, file.sha256, file.path);
  }
});

test("repository-only protocol contracts are excluded from the package dry run", () => {
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
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const repoRoot = resolve(import.meta.dirname, "..");
const profileDir = join(repoRoot, "protocol", "session-mirror", "v1");
const manifest = JSON.parse(readFileSync(join(profileDir, "manifest.json"), "utf8"));
const jiti = createJiti(import.meta.url);
const {
  SESSION_MIRROR_BOUNDS,
  applySessionMirrorEnvelope,
  createSessionMirrorState,
  parseSessionMirrorJson,
  validateSessionMirrorEnvelope,
} = await jiti.import("../protocol/session-mirror/v1/conformance.ts");

function fixture(item) {
  return JSON.parse(readFileSync(join(profileDir, item.path), "utf8"));
}

function fixtureById(id) {
  const item = manifest.fixtures.find((candidate) => candidate.id === id);
  assert.ok(item, `missing fixture ${id}`);
  return fixture(item);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertFailure(result, category, code) {
  assert.equal(result.ok, false);
  assert.equal(result.error.category, category);
  if (code) assert.equal(result.error.code, code);
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

function emptySnapshotEnvelope() {
  return fixtureById("valid-empty-session");
}

function customEntry(id, parentId, payload = {}) {
  return { id, parentId, kind: `custom.${id}`, payload };
}

function objectChain(length) {
  const root = {};
  let cursor = root;
  for (let index = 1; index < length; index += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  return root;
}

function containerCount(value) {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return 1 + value.reduce((sum, child) => sum + containerCount(child), 0);
  return 1 + Object.values(value).reduce((sum, child) => sum + containerCount(child), 0);
}

test("conformance validates every manifest fixture and applies declared sequences", () => {
  const byId = new Map(manifest.fixtures.map((item) => [item.id, item]));

  for (const item of manifest.fixtures) {
    const raw = readFileSync(join(profileDir, item.path), "utf8");
    const parsedResult = parseSessionMirrorJson(raw);
    if (item.applyAfter) {
      assert.equal(parsedResult.ok, true, `${item.id} must structurally validate before apply`);
      const prerequisite = byId.get(item.applyAfter);
      assert.ok(prerequisite);
      const first = applySessionMirrorEnvelope(createSessionMirrorState(), fixture(prerequisite));
      assert.equal(first.ok, true, `${item.id} prerequisite must apply`);
      const applied = applySessionMirrorEnvelope(first.nextState, raw);
      assertFailure(applied, item.expectedFailureCategory);
      continue;
    }

    if (item.valid) {
      assert.equal(parsedResult.ok, true, `${item.id} must parse and validate`);
      assert.equal(parsedResult.envelope.sessionId, fixture(item).sessionId);
    } else {
      assertFailure(parsedResult, item.expectedFailureCategory);
    }
  }
});

test("raw malformed JSON and hostile values fail without throwing", () => {
  assertFailure(parseSessionMirrorJson("{"), "malformed-envelope", "invalid-json");
  assertFailure(parseSessionMirrorJson("[]"), "malformed-envelope", "invalid-shape");

  const cyclic = emptySnapshotEnvelope();
  cyclic.metadata = cyclic;
  assert.doesNotThrow(() => {
    const result = validateSessionMirrorEnvelope(cyclic);
    assertFailure(result, "malformed-envelope");
  });

  const accessor = emptySnapshotEnvelope();
  Object.defineProperty(accessor, "hostile", {
    enumerable: true,
    get() {
      throw new Error("must not invoke hostile getter");
    },
  });
  assert.doesNotThrow(() => {
    const result = validateSessionMirrorEnvelope(accessor);
    assertFailure(result, "malformed-envelope");
  });

  assertFailure(validateSessionMirrorEnvelope(new Date()), "malformed-envelope");
});

test("deep parsed and raw values fail safely without escaping the boundary", () => {
  const parsedDeep = emptySnapshotEnvelope();
  let parsedCursor = (parsedDeep.metadata = {});
  for (let index = 0; index < 2_000; index += 1) {
    parsedCursor.next = {};
    parsedCursor = parsedCursor.next;
  }
  assert.doesNotThrow(() => validateSessionMirrorEnvelope(parsedDeep));

  const rawDeep = emptySnapshotEnvelope();
  let rawCursor = (rawDeep.metadata = {});
  for (let index = 0; index < 2_000; index += 1) {
    rawCursor.next = {};
    rawCursor = rawCursor.next;
  }
  const raw = JSON.stringify(rawDeep);
  assert.doesNotThrow(() => parseSessionMirrorJson(raw));
});

test("JSON __proto__ fields are preserved without prototype pollution", () => {
  const input = emptySnapshotEnvelope();
  Object.defineProperty(input, "__proto__", {
    configurable: true,
    enumerable: true,
    value: { marker: "synthetic-proto-field" },
    writable: true,
  });
  const result = validateSessionMirrorEnvelope(input);
  assert.equal(result.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(result.envelope, "__proto__"), true);
  assert.deepEqual(result.envelope["__proto__"], input["__proto__"]);
  assert.equal({}.polluted, undefined);
});

test("documented envelope, identity, payload, text, tree-count, and tree-depth bounds are enforced", () => {
  const oversizedRaw = JSON.stringify({
    ...emptySnapshotEnvelope(),
    metadata: "x".repeat(SESSION_MIRROR_BOUNDS.maxEnvelopeBytes),
  });
  assertFailure(parseSessionMirrorJson(oversizedRaw), "bounds-exceeded", "envelope-bounds");

  const oversizedSessionId = emptySnapshotEnvelope();
  oversizedSessionId.sessionId = "x".repeat(SESSION_MIRROR_BOUNDS.maxIdentityCharacters + 1);
  assertFailure(
    validateSessionMirrorEnvelope(oversizedSessionId),
    "bounds-exceeded",
    "identity-bounds",
  );

  const oversizedEventId = emptySnapshotEnvelope();
  oversizedEventId.message.eventId = "x".repeat(SESSION_MIRROR_BOUNDS.maxIdentityCharacters + 1);
  assertFailure(
    validateSessionMirrorEnvelope(oversizedEventId),
    "bounds-exceeded",
    "identity-bounds",
  );

  const oversizedSnapshotId = emptySnapshotEnvelope();
  oversizedSnapshotId.message.snapshot.snapshotId = "x".repeat(
    SESSION_MIRROR_BOUNDS.maxIdentityCharacters + 1,
  );
  assertFailure(
    validateSessionMirrorEnvelope(oversizedSnapshotId),
    "bounds-exceeded",
    "identity-bounds",
  );

  const oversizedCursor = emptySnapshotEnvelope();
  oversizedCursor.message.cursor = "x".repeat(SESSION_MIRROR_BOUNDS.maxCursorCharacters + 1);
  assertFailure(
    validateSessionMirrorEnvelope(oversizedCursor),
    "bounds-exceeded",
    "identity-bounds",
  );

  const oversizedPayload = emptySnapshotEnvelope();
  oversizedPayload.message.snapshot.tree.entries = [
    customEntry("entry-payload", null, {
      blob: "x".repeat(SESSION_MIRROR_BOUNDS.maxEntryPayloadBytes),
    }),
  ];
  oversizedPayload.message.snapshot.tree.rootIds = ["entry-payload"];
  oversizedPayload.message.snapshot.tree.activeLeafId = "entry-payload";
  assertFailure(
    validateSessionMirrorEnvelope(oversizedPayload),
    "bounds-exceeded",
    "payload-bounds",
  );

  const oversizedText = emptySnapshotEnvelope();
  oversizedText.message.snapshot.tree.entries = [
    {
      id: "entry-text",
      parentId: null,
      kind: "assistant-turn",
      status: "completed",
      payload: {
        content: {
          format: "text",
          text: "x".repeat(SESSION_MIRROR_BOUNDS.maxTextBytes + 1),
        },
      },
    },
  ];
  oversizedText.message.snapshot.tree.rootIds = ["entry-text"];
  oversizedText.message.snapshot.tree.activeLeafId = "entry-text";
  assertFailure(validateSessionMirrorEnvelope(oversizedText), "bounds-exceeded", "text-bounds");

  const oversizedTreeId = "x".repeat(SESSION_MIRROR_BOUNDS.maxIdentityCharacters + 1);
  const oversizedTreeIdentity = emptySnapshotEnvelope();
  oversizedTreeIdentity.message.snapshot.tree.entries = [customEntry(oversizedTreeId, null)];
  oversizedTreeIdentity.message.snapshot.tree.rootIds = [oversizedTreeId];
  oversizedTreeIdentity.message.snapshot.tree.activeLeafId = oversizedTreeId;
  assertFailure(
    validateSessionMirrorEnvelope(oversizedTreeIdentity),
    "bounds-exceeded",
    "identity-bounds",
  );

  const tooManyEntries = emptySnapshotEnvelope();
  tooManyEntries.message.snapshot.tree.entries = [
    customEntry("entry-root", null),
    ...Array.from({ length: SESSION_MIRROR_BOUNDS.maxTreeEntries }, (_, index) =>
      customEntry(`entry-${index}`, "entry-root"),
    ),
  ];
  tooManyEntries.message.snapshot.tree.rootIds = ["entry-root"];
  tooManyEntries.message.snapshot.tree.activeLeafId = "entry-0";
  assertFailure(validateSessionMirrorEnvelope(tooManyEntries), "bounds-exceeded", "tree-bounds");

  const tooDeep = emptySnapshotEnvelope();
  tooDeep.message.snapshot.tree.entries = Array.from(
    { length: SESSION_MIRROR_BOUNDS.maxTreeDepth + 1 },
    (_, index) =>
      customEntry(`entry-depth-${index}`, index === 0 ? null : `entry-depth-${index - 1}`),
  );
  tooDeep.message.snapshot.tree.rootIds = ["entry-depth-0"];
  tooDeep.message.snapshot.tree.activeLeafId = `entry-depth-${SESSION_MIRROR_BOUNDS.maxTreeDepth}`;
  assertFailure(validateSessionMirrorEnvelope(tooDeep), "bounds-exceeded", "tree-bounds");
});

test("authoritative identity and cursor scans cover every v1 location", () => {
  assert.equal(SESSION_MIRROR_BOUNDS.maxIdentityCharacters, 128);
  const singleNodeSnapshot = (id) => {
    const input = emptySnapshotEnvelope();
    input.message.snapshot.tree.entries = [customEntry(id, null)];
    input.message.snapshot.tree.rootIds = [id];
    input.message.snapshot.tree.activeLeafId = id;
    return input;
  };
  const leafSnapshot = (id) => {
    const input = emptySnapshotEnvelope();
    input.message.snapshot.tree.entries = [
      customEntry("entry-root", null),
      customEntry(id, "entry-root"),
    ];
    input.message.snapshot.tree.rootIds = ["entry-root"];
    input.message.snapshot.tree.activeLeafId = id;
    return input;
  };
  const entryIdSnapshot = (id) => {
    const input = emptySnapshotEnvelope();
    input.message.snapshot.tree.entries = [
      customEntry("entry-root", null),
      customEntry(id, "entry-root"),
      customEntry("entry-leaf", "entry-root"),
    ];
    input.message.snapshot.tree.rootIds = ["entry-root"];
    input.message.snapshot.tree.activeLeafId = "entry-leaf";
    return input;
  };
  const parentIdSnapshot = (id) => {
    const input = emptySnapshotEnvelope();
    input.message.snapshot.tree.entries = [
      customEntry("entry-root", null),
      customEntry(id, "entry-root"),
      customEntry("entry-child", id),
      customEntry("entry-leaf", "entry-root"),
    ];
    input.message.snapshot.tree.rootIds = ["entry-root"];
    input.message.snapshot.tree.activeLeafId = "entry-leaf";
    return input;
  };
  const cases = [
    {
      name: "event compaction firstKeptEntryId",
      limit: SESSION_MIRROR_BOUNDS.maxIdentityCharacters,
      build: (value) => {
        const input = fixtureById("valid-compaction-event");
        input.message.event.entry.payload.firstKeptEntryId = value;
        return input;
      },
    },
    {
      name: "snapshot snapshotId",
      limit: SESSION_MIRROR_BOUNDS.maxIdentityCharacters,
      build: (value) => {
        const input = emptySnapshotEnvelope();
        input.message.snapshot.snapshotId = value;
        return input;
      },
    },
    {
      name: "replacement snapshotId",
      limit: SESSION_MIRROR_BOUNDS.maxIdentityCharacters,
      build: (value) => {
        const input = fixtureById("valid-snapshot-replacement");
        input.message.replaces.snapshotId = value;
        return input;
      },
    },
    {
      name: "replacement cursor",
      limit: SESSION_MIRROR_BOUNDS.maxCursorCharacters,
      build: (value) => {
        const input = fixtureById("valid-snapshot-replacement");
        input.message.replaces.cursor = value;
        return input;
      },
    },
    {
      name: "tree rootIds member",
      limit: SESSION_MIRROR_BOUNDS.maxIdentityCharacters,
      build: (value) => singleNodeSnapshot(value),
    },
    {
      name: "tree activeLeafId",
      limit: SESSION_MIRROR_BOUNDS.maxIdentityCharacters,
      build: (value) => leafSnapshot(value),
    },
    {
      name: "tree entry id",
      limit: SESSION_MIRROR_BOUNDS.maxIdentityCharacters,
      build: (value) => entryIdSnapshot(value),
    },
    {
      name: "tree entry parentId",
      limit: SESSION_MIRROR_BOUNDS.maxIdentityCharacters,
      build: (value) => parentIdSnapshot(value),
    },
    {
      name: "active-leaf previous ID",
      limit: SESSION_MIRROR_BOUNDS.maxIdentityCharacters,
      build: (value) => {
        const input = fixtureById("valid-active-leaf-change");
        input.message.event.previousActiveLeafId = value;
        return input;
      },
    },
    {
      name: "active-leaf ID",
      limit: SESSION_MIRROR_BOUNDS.maxIdentityCharacters,
      build: (value) => {
        const input = fixtureById("valid-active-leaf-change");
        input.message.event.activeLeafId = value;
        return input;
      },
    },
  ];

  for (const { name, limit, build } of cases) {
    const exact = build("x".repeat(limit));
    assert.equal(validateSessionMirrorEnvelope(exact).ok, true, `${name} accepts its exact bound`);
    assertFailure(
      validateSessionMirrorEnvelope(build("x".repeat(limit + 1))),
      "bounds-exceeded",
      "identity-bounds",
    );
  }
});

test("tree invariants reject malformed roots, parents, cycles, and active references", () => {
  const cases = [];

  const duplicate = emptySnapshotEnvelope();
  duplicate.message.snapshot.tree.entries = [
    customEntry("entry-duplicate", null),
    customEntry("entry-duplicate", null),
  ];
  duplicate.message.snapshot.tree.rootIds = ["entry-duplicate"];
  duplicate.message.snapshot.tree.activeLeafId = "entry-duplicate";
  cases.push(duplicate);

  const missingParent = emptySnapshotEnvelope();
  missingParent.message.snapshot.tree.entries = [customEntry("entry-child", "missing-parent")];
  missingParent.message.snapshot.tree.rootIds = ["entry-child"];
  missingParent.message.snapshot.tree.activeLeafId = "entry-child";
  cases.push(missingParent);

  const cycle = emptySnapshotEnvelope();
  cycle.message.snapshot.tree.entries = [
    customEntry("entry-a", "entry-b"),
    customEntry("entry-b", "entry-a"),
  ];
  cycle.message.snapshot.tree.rootIds = ["entry-a"];
  cycle.message.snapshot.tree.activeLeafId = "entry-a";
  cases.push(cycle);

  const activeBranch = emptySnapshotEnvelope();
  activeBranch.message.snapshot.tree.entries = [
    customEntry("entry-root", null),
    customEntry("entry-child", "entry-root"),
  ];
  activeBranch.message.snapshot.tree.rootIds = ["entry-root"];
  activeBranch.message.snapshot.tree.activeLeafId = "entry-root";
  assert.equal(validateSessionMirrorEnvelope(activeBranch).ok, true);

  const activeNull = emptySnapshotEnvelope();
  activeNull.message.snapshot.tree.entries = [customEntry("entry-active-null", null)];
  activeNull.message.snapshot.tree.rootIds = ["entry-active-null"];
  activeNull.message.snapshot.tree.activeLeafId = null;
  assert.equal(validateSessionMirrorEnvelope(activeNull).ok, true);

  const forest = emptySnapshotEnvelope();
  forest.message.snapshot.tree.entries = [
    customEntry("entry-forest-a", null),
    customEntry("entry-forest-a-child", "entry-forest-a"),
    customEntry("entry-forest-b", null),
  ];
  forest.message.snapshot.tree.rootIds = ["entry-forest-a", "entry-forest-b"];
  forest.message.snapshot.tree.activeLeafId = null;
  assert.equal(validateSessionMirrorEnvelope(forest).ok, true);

  const emptyRoot = emptySnapshotEnvelope();
  emptyRoot.message.snapshot.tree.rootIds = ["entry-missing"];
  cases.push(emptyRoot);

  const missingRootId = emptySnapshotEnvelope();
  missingRootId.message.snapshot.tree.entries = [
    customEntry("entry-root-a", null),
    customEntry("entry-root-b", null),
  ];
  missingRootId.message.snapshot.tree.rootIds = ["entry-root-a"];
  missingRootId.message.snapshot.tree.activeLeafId = null;
  cases.push(missingRootId);

  const nonRootId = emptySnapshotEnvelope();
  nonRootId.message.snapshot.tree.entries = [
    customEntry("entry-root", null),
    customEntry("entry-child", "entry-root"),
  ];
  nonRootId.message.snapshot.tree.rootIds = ["entry-child"];
  nonRootId.message.snapshot.tree.activeLeafId = null;
  cases.push(nonRootId);

  const missingActive = emptySnapshotEnvelope();
  missingActive.message.snapshot.tree.entries = [customEntry("entry-root", null)];
  missingActive.message.snapshot.tree.rootIds = ["entry-root"];
  missingActive.message.snapshot.tree.activeLeafId = "entry-missing";
  cases.push(missingActive);

  for (const value of cases) {
    assertFailure(validateSessionMirrorEnvelope(value), "malformed-envelope");
  }
});

test("documented failure categories follow the profile precedence order", () => {
  const malformedAndOversized = emptySnapshotEnvelope();
  malformedAndOversized.message.revision = "not-a-revision";
  malformedAndOversized.message.cursor = "x".repeat(SESSION_MIRROR_BOUNDS.maxCursorCharacters + 1);
  assertFailure(validateSessionMirrorEnvelope(malformedAndOversized), "malformed-envelope");

  const boundsAndProtocol = emptySnapshotEnvelope();
  boundsAndProtocol.protocol.major = 2;
  boundsAndProtocol.message.cursor = "x".repeat(SESSION_MIRROR_BOUNDS.maxCursorCharacters + 1);
  assertFailure(validateSessionMirrorEnvelope(boundsAndProtocol), "incompatible-protocol");

  const protocolAndCapability = emptySnapshotEnvelope();
  protocolAndCapability.protocol.major = 2;
  protocolAndCapability.capabilities = protocolAndCapability.capabilities.filter(
    (capability) => capability !== "cursor-recovery",
  );
  assertFailure(validateSessionMirrorEnvelope(protocolAndCapability), "incompatible-protocol");

  const capabilityAndStreaming = emptySnapshotEnvelope();
  capabilityAndStreaming.capabilities = [
    ...capabilityAndStreaming.capabilities.filter((capability) => capability !== "cursor-recovery"),
    "assistant-streaming",
  ];
  assertFailure(validateSessionMirrorEnvelope(capabilityAndStreaming), "incompatible-capability");

  const streamingAndUnknown = emptySnapshotEnvelope();
  streamingAndUnknown.message.kind = "future-update";
  streamingAndUnknown.message.operation = "append";
  streamingAndUnknown.message.event = { type: "assistant.delta", delta: "synthetic-delta" };
  assertFailure(validateSessionMirrorEnvelope(streamingAndUnknown), "forbidden-streaming");
});

test("unknown and forbidden discriminants do not decode malformed bodies", () => {
  const forbiddenEvent = emptySnapshotEnvelope();
  forbiddenEvent.message.kind = "event";
  delete forbiddenEvent.message.snapshot;
  forbiddenEvent.message.operation = "append";
  forbiddenEvent.message.baseRevision = 0;
  forbiddenEvent.message.revision = 1;
  forbiddenEvent.message.event = {
    type: "assistant.delta",
    entry: { kind: "assistant-turn", payload: "malformed-entry-payload" },
  };
  assertFailure(validateSessionMirrorEnvelope(forbiddenEvent), "forbidden-streaming");

  const unknownEvent = clone(forbiddenEvent);
  unknownEvent.message.event.type = "synthetic.future";
  assertFailure(validateSessionMirrorEnvelope(unknownEvent), "incompatible-message-kind");

  const unknownMessageEvent = emptySnapshotEnvelope();
  unknownMessageEvent.message.kind = "future-message";
  unknownMessageEvent.message.operation = "append";
  delete unknownMessageEvent.message.snapshot;
  unknownMessageEvent.message.event = {
    type: "synthetic.future",
    entry: { kind: "assistant-turn", payload: "malformed-entry-payload" },
  };
  const unknownMessageEventResult = validateSessionMirrorEnvelope(unknownMessageEvent);
  assertFailure(unknownMessageEventResult, "incompatible-message-kind");

  const unknownMessageSnapshot = emptySnapshotEnvelope();
  unknownMessageSnapshot.message.kind = "future-message";
  unknownMessageSnapshot.message.operation = "replace";
  unknownMessageSnapshot.message.snapshot = { tree: "malformed-snapshot-body" };
  const unknownMessageSnapshotResult = validateSessionMirrorEnvelope(unknownMessageSnapshot);
  assertFailure(unknownMessageSnapshotResult, "incompatible-message-kind");
  assert.equal(
    unknownMessageSnapshotResult.error.code,
    unknownMessageEventResult.error.code,
    "unknown event and snapshot bodies use the same failure policy",
  );

  const unknownEventMarker = emptySnapshotEnvelope();
  unknownEventMarker.message.kind = "future-message";
  unknownEventMarker.message.operation = "append";
  delete unknownEventMarker.message.snapshot;
  unknownEventMarker.message.event = {
    type: "synthetic.future",
    entry: {
      kind: "assistant-turn",
      payload: {
        content: { format: "text", text: "synthetic", partial: true },
      },
    },
  };
  assertFailure(validateSessionMirrorEnvelope(unknownEventMarker), "forbidden-streaming");

  const unknownSnapshotMarker = emptySnapshotEnvelope();
  unknownSnapshotMarker.message.kind = "future-message";
  unknownSnapshotMarker.message.operation = "replace";
  unknownSnapshotMarker.message.snapshot = {
    tree: {
      entries: [
        {
          kind: "assistant-turn",
          payload: {
            content: { format: "text", text: "synthetic", partial: true },
          },
        },
      ],
    },
  };
  assertFailure(validateSessionMirrorEnvelope(unknownSnapshotMarker), "forbidden-streaming");
});

test("shape-divergent future protocols fail before v1 body decoding", () => {
  const future = fixtureById("invalid-future-protocol-shape");
  const result = validateSessionMirrorEnvelope(future);
  assertFailure(result, "incompatible-protocol", "protocol-incompatible");
});

test("incompatible protocols only use the aggregate cap and v1 scans recognized bounds", () => {
  const foreign = emptySnapshotEnvelope();
  foreign.protocol.family = "future-session-mirror";
  foreign.protocol.major = 2;
  foreign.futureBlob = { text: "x".repeat(40 * 1024) };
  assertFailure(
    validateSessionMirrorEnvelope(foreign),
    "incompatible-protocol",
    "protocol-incompatible",
  );

  const openEnvelope = emptySnapshotEnvelope();
  openEnvelope.metadata = {
    text: "x".repeat(40 * 1024),
    payload: { text: "x".repeat(40 * 1024) },
    cursor: "x".repeat(SESSION_MIRROR_BOUNDS.maxCursorCharacters + 1),
  };
  assert.equal(validateSessionMirrorEnvelope(openEnvelope).ok, true);

  const oversizedKnownEntry = {
    id: "known-entry-bound",
    parentId: null,
    kind: "assistant-turn",
    status: "completed",
    payload: {
      content: {
        format: "text",
        text: "x".repeat(40 * 1024),
      },
    },
  };
  const unknownMessage = emptySnapshotEnvelope();
  unknownMessage.message.kind = "future-update";
  unknownMessage.message.operation = "append";
  unknownMessage.message.event = { type: "turn.completed", entry: oversizedKnownEntry };
  assertFailure(validateSessionMirrorEnvelope(unknownMessage), "bounds-exceeded", "text-bounds");

  const forbiddenEvent = emptySnapshotEnvelope();
  forbiddenEvent.message.kind = "event";
  delete forbiddenEvent.message.snapshot;
  forbiddenEvent.message.operation = "append";
  forbiddenEvent.message.baseRevision = 0;
  forbiddenEvent.message.revision = 1;
  forbiddenEvent.message.event = { type: "assistant.delta", entry: oversizedKnownEntry };
  assertFailure(validateSessionMirrorEnvelope(forbiddenEvent), "bounds-exceeded", "text-bounds");

  const customPayload = emptySnapshotEnvelope();
  customPayload.message.snapshot.tree.entries = [
    customEntry("opaque-bound", null, { text: "x".repeat(SESSION_MIRROR_BOUNDS.maxTextBytes + 1) }),
  ];
  customPayload.message.snapshot.tree.rootIds = ["opaque-bound"];
  customPayload.message.snapshot.tree.activeLeafId = "opaque-bound";
  assert.equal(validateSessionMirrorEnvelope(customPayload).ok, true);
});

test("normalization depth and container boundaries are explicit and fail closed", () => {
  assert.equal(typeof SESSION_MIRROR_BOUNDS.maxNormalizationDepth, "number");
  assert.equal(typeof SESSION_MIRROR_BOUNDS.maxNormalizationContainers, "number");

  const rawAtLimitBase = emptySnapshotEnvelope();
  rawAtLimitBase.metadata = "";
  const rawAtLimitPrefix = JSON.stringify(rawAtLimitBase);
  const rawAtLimitLength = Buffer.byteLength(rawAtLimitPrefix, "utf8");
  const rawPadding = SESSION_MIRROR_BOUNDS.maxEnvelopeBytes - rawAtLimitLength;
  const rawAtLimit = emptySnapshotEnvelope();
  rawAtLimit.metadata = "x".repeat(rawPadding);
  assert.equal(
    Buffer.byteLength(JSON.stringify(rawAtLimit), "utf8"),
    SESSION_MIRROR_BOUNDS.maxEnvelopeBytes,
  );
  assert.equal(parseSessionMirrorJson(JSON.stringify(rawAtLimit)).ok, true);
  const rawOverLimit = emptySnapshotEnvelope();
  rawOverLimit.metadata = "x".repeat(rawPadding + 1);
  assert.doesNotThrow(() => {
    assertFailure(
      parseSessionMirrorJson(JSON.stringify(rawOverLimit)),
      "bounds-exceeded",
      "envelope-bounds",
    );
  });

  const exactDepth = emptySnapshotEnvelope();
  exactDepth.metadata = objectChain(SESSION_MIRROR_BOUNDS.maxNormalizationDepth);
  assert.equal(validateSessionMirrorEnvelope(exactDepth).ok, true);

  const overDepth = emptySnapshotEnvelope();
  overDepth.metadata = objectChain(SESSION_MIRROR_BOUNDS.maxNormalizationDepth + 1);
  assert.doesNotThrow(() => {
    assertFailure(validateSessionMirrorEnvelope(overDepth), "bounds-exceeded", "structure-bounds");
  });

  const exactContainers = emptySnapshotEnvelope();
  const available =
    SESSION_MIRROR_BOUNDS.maxNormalizationContainers - containerCount(exactContainers) - 1;
  exactContainers.metadata = Array.from({ length: available }, () => ({}));
  assert.equal(containerCount(exactContainers), SESSION_MIRROR_BOUNDS.maxNormalizationContainers);
  assert.equal(validateSessionMirrorEnvelope(exactContainers).ok, true);

  const overContainers = emptySnapshotEnvelope();
  overContainers.metadata = Array.from({ length: available + 1 }, () => ({}));
  assert.doesNotThrow(() => {
    assertFailure(
      validateSessionMirrorEnvelope(overContainers),
      "bounds-exceeded",
      "structure-bounds",
    );
  });
});

test("malformed tree and compaction structure outranks deferred entry semantics", () => {
  const duplicateIncomplete = emptySnapshotEnvelope();
  duplicateIncomplete.message.snapshot.tree.entries = [
    {
      id: "duplicate-incomplete",
      parentId: null,
      kind: "assistant-turn",
      status: "partial",
      payload: { content: { format: "text", text: "synthetic" } },
    },
    customEntry("duplicate-incomplete", null),
  ];
  duplicateIncomplete.message.snapshot.tree.rootIds = ["duplicate-incomplete"];
  duplicateIncomplete.message.snapshot.tree.activeLeafId = "duplicate-incomplete";
  assertFailure(validateSessionMirrorEnvelope(duplicateIncomplete), "malformed-envelope");

  const missingRootIncomplete = emptySnapshotEnvelope();
  missingRootIncomplete.message.snapshot.tree.entries = [
    {
      id: "incomplete-root-candidate",
      parentId: null,
      kind: "assistant-turn",
      status: "partial",
      payload: { content: { format: "text", text: "synthetic" } },
    },
  ];
  missingRootIncomplete.message.snapshot.tree.rootIds = ["missing-root"];
  missingRootIncomplete.message.snapshot.tree.activeLeafId = "incomplete-root-candidate";
  assertFailure(validateSessionMirrorEnvelope(missingRootIncomplete), "malformed-envelope");

  const incompleteCompaction = fixtureById("valid-compaction-event");
  incompleteCompaction.message.event.entry.status = "partial";
  delete incompleteCompaction.message.event.entry.payload.firstKeptEntryId;
  assertFailure(validateSessionMirrorEnvelope(incompleteCompaction), "malformed-envelope");
});

test("source placeholders are closed, bounded categories", () => {
  const placeholder = fixtureById("valid-source-placeholders");
  const result = validateSessionMirrorEnvelope(placeholder);
  assert.equal(result.ok, true);
  const entries = result.envelope.message.snapshot.tree.entries;
  assert.deepEqual(
    entries.map((entry) => entry.payload.sourceType),
    ["tool", "provider", "image", "custom", "unsupported"],
  );
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).sort(), ["id", "kind", "parentId", "payload", "status"]);
    assert.deepEqual(Object.keys(entry.payload), ["sourceType"]);
  }

  const unsafeEntryField = fixtureById("valid-source-placeholders");
  unsafeEntryField.message.snapshot.tree.entries[0].metadata = "synthetic-leak";
  assertFailure(validateSessionMirrorEnvelope(unsafeEntryField), "malformed-envelope");

  const unsafePayloadField = fixtureById("valid-source-placeholders");
  unsafePayloadField.message.snapshot.tree.entries[1].payload.metadata = "synthetic-leak";
  assertFailure(validateSessionMirrorEnvelope(unsafePayloadField), "malformed-envelope");

  const unsafeCategory = fixtureById("valid-source-placeholders");
  unsafeCategory.message.snapshot.tree.entries[2].payload.sourceType = "secret";
  assertFailure(validateSessionMirrorEnvelope(unsafeCategory), "malformed-envelope");

  const legacyKind = fixtureById("valid-source-placeholders");
  legacyKind.message.snapshot.tree.entries[3].kind = "custom.source-placeholder";
  assert.equal(validateSessionMirrorEnvelope(legacyKind).ok, true);
});

test("compaction uses inline summary and first-kept semantics", () => {
  const snapshot = fixtureById("valid-compaction-summary");
  const snapshotResult = validateSessionMirrorEnvelope(snapshot);
  assert.equal(snapshotResult.ok, true);
  const compaction = snapshotResult.envelope.message.snapshot.tree.entries.find(
    (entry) => entry.kind === "compaction",
  );
  assert.ok(compaction);
  assert.equal(compaction.payload.firstKeptEntryId, "entry-f2");
  assert.equal(
    snapshotResult.envelope.message.snapshot.tree.entries.some((entry) => entry.kind === "summary"),
    false,
  );

  const event = fixtureById("valid-compaction-event");
  const eventResult = validateSessionMirrorEnvelope(event);
  assert.equal(eventResult.ok, true);
  assert.equal("compactedEntryIds" in eventResult.envelope.message.event, false);
  assert.equal("summaryEntryId" in eventResult.envelope.message.event.entry.payload, false);
  assert.equal("compactedEntryIds" in eventResult.envelope.message.event.entry.payload, false);

  const missingFirstKept = fixtureById("valid-compaction-summary");
  const marker = missingFirstKept.message.snapshot.tree.entries.find(
    (entry) => entry.kind === "compaction",
  );
  delete marker.payload.firstKeptEntryId;
  assertFailure(validateSessionMirrorEnvelope(missingFirstKept), "malformed-envelope");

  const missingReferencedEntry = fixtureById("valid-compaction-summary");
  const missingReferenceMarker = missingReferencedEntry.message.snapshot.tree.entries.find(
    (entry) => entry.kind === "compaction",
  );
  missingReferenceMarker.payload.firstKeptEntryId = "missing-first-kept-entry";
  assertFailure(validateSessionMirrorEnvelope(missingReferencedEntry), "malformed-envelope");

  const legacyPayload = fixtureById("valid-compaction-event");
  legacyPayload.message.event.entry.payload.summaryEntryId = "entry-r2";
  assertFailure(validateSessionMirrorEnvelope(legacyPayload), "malformed-envelope");

  const legacyEvent = fixtureById("valid-compaction-event");
  legacyEvent.message.event.compactedEntryIds = ["entry-r1"];
  assertFailure(validateSessionMirrorEnvelope(legacyEvent), "malformed-envelope");

  const emptySummary = fixtureById("valid-compaction-event");
  emptySummary.message.event.entry.payload.summary = "";
  assert.equal(validateSessionMirrorEnvelope(emptySummary).ok, true);

  const oversizedSummary = fixtureById("valid-compaction-event");
  oversizedSummary.message.event.entry.payload.summary = "x".repeat(
    SESSION_MIRROR_BOUNDS.maxTextBytes + 1,
  );
  assertFailure(validateSessionMirrorEnvelope(oversizedSummary), "bounds-exceeded", "text-bounds");
});

test("active-leaf changes accept null in either direction", () => {
  const fromNull = fixtureById("valid-active-leaf-change");
  assert.equal(fromNull.message.event.previousActiveLeafId, null);
  assert.notEqual(fromNull.message.event.activeLeafId, null);
  assert.equal(validateSessionMirrorEnvelope(fromNull).ok, true);

  const toNull = fixtureById("valid-active-leaf-cleared");
  assert.notEqual(toNull.message.event.previousActiveLeafId, null);
  assert.equal(toNull.message.event.activeLeafId, null);
  assert.equal(validateSessionMirrorEnvelope(toNull).ok, true);

  const malformed = fixtureById("valid-active-leaf-change");
  malformed.message.event.activeLeafId = 42;
  assertFailure(validateSessionMirrorEnvelope(malformed), "malformed-envelope");
});

test("unknown content diagnostics never echo arbitrary input keys", () => {
  const secretKey = "sensitive-prompt-fragment";
  const assistant = fixtureById("valid-assistant-turn-completed");
  assistant.message.event.entry.payload.content[secretKey] = "synthetic-secret";
  const result = validateSessionMirrorEnvelope(assistant);
  assertFailure(result, "malformed-envelope");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secretKey));
  assert.equal(result.error.path, "$.message.event.entry.payload.content.*");
});

test("unknown protocol, source, envelope, message, entry, and custom fields survive validation", () => {
  const input = fixtureById("valid-custom-entry");
  input.protocol.experimental = { marker: "synthetic-protocol-extension" };
  input.source.experimental = { marker: "synthetic-source-extension" };
  input.message.experimental = { marker: "synthetic-message-extension" };
  const result = validateSessionMirrorEnvelope(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.envelope.protocol.experimental, input.protocol.experimental);
  assert.deepEqual(result.envelope.source.experimental, input.source.experimental);
  assert.deepEqual(result.envelope.metadata, input.metadata);
  assert.deepEqual(result.envelope.message.experimental, input.message.experimental);
  assert.deepEqual(
    result.envelope.message.snapshot.tree.entries[0].unknownMetadata,
    input.message.snapshot.tree.entries[0].unknownMetadata,
  );
  assert.deepEqual(
    result.envelope.message.snapshot.tree.entries[1].payload,
    input.message.snapshot.tree.entries[1].payload,
  );
  assert.notEqual(result.envelope, input);
  assert.notEqual(result.envelope.message.snapshot.tree, input.message.snapshot.tree);
});

test("user and summary content fields remain open while assistant final content stays closed", () => {
  const user = emptySnapshotEnvelope();
  user.message.snapshot.tree.entries = [
    {
      id: "user-open",
      parentId: null,
      kind: "user-turn",
      status: "completed",
      payload: {
        content: {
          format: "text",
          text: "synthetic user",
          annotation: { marker: "preserve-user-content" },
        },
      },
    },
  ];
  user.message.snapshot.tree.rootIds = ["user-open"];
  user.message.snapshot.tree.activeLeafId = "user-open";
  const userResult = validateSessionMirrorEnvelope(user);
  assert.equal(userResult.ok, true);
  assert.deepEqual(
    userResult.envelope.message.snapshot.tree.entries[0].payload.content.annotation,
    user.message.snapshot.tree.entries[0].payload.content.annotation,
  );

  const summary = fixtureById("valid-summary-update");
  summary.message.event.entry.payload.content.annotation = { marker: "preserve-summary-content" };
  summary.message.event.entry.payload.metadata = { marker: "preserve-summary-payload" };
  const summaryResult = validateSessionMirrorEnvelope(summary);
  assert.equal(summaryResult.ok, true);
  assert.deepEqual(
    summaryResult.envelope.message.event.entry.payload.content.annotation,
    summary.message.event.entry.payload.content.annotation,
  );
  assert.deepEqual(
    summaryResult.envelope.message.event.entry.payload.metadata,
    summary.message.event.entry.payload.metadata,
  );

  const assistant = fixtureById("valid-assistant-turn-completed");
  assistant.message.event.entry.payload.content.annotation = { marker: "closed-assistant-content" };
  assertFailure(validateSessionMirrorEnvelope(assistant), "malformed-envelope");
});

test("custom entry status is preserved as uninterpreted data", () => {
  const input = fixtureById("valid-custom-entry");
  input.message.snapshot.tree.entries[1].status = {
    phase: "synthetic-custom-status",
    nested: { retained: true },
  };
  const result = validateSessionMirrorEnvelope(input);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.envelope.message.snapshot.tree.entries[1].status,
    input.message.snapshot.tree.entries[1].status,
  );
});

test("streaming markers are scoped to assistant payloads, not entry metadata", () => {
  const payloadMarker = fixtureById("valid-assistant-turn-completed");
  payloadMarker.message.event.entry.payload.metadata = { delta: "synthetic-delta" };
  assertFailure(validateSessionMirrorEnvelope(payloadMarker), "forbidden-streaming");

  const entryMetadata = fixtureById("valid-assistant-turn-completed");
  entryMetadata.message.event.entry.unknownMetadata = { delta: "synthetic-benign-metadata" };
  const result = validateSessionMirrorEnvelope(entryMetadata);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.envelope.message.event.entry.unknownMetadata,
    entryMetadata.message.event.entry.unknownMetadata,
  );
});

test("exact redelivery is idempotent, key order is semantic, and duplicate conflict precedes gaps", () => {
  const baseline = fixtureById("valid-status-update");
  const first = applySessionMirrorEnvelope(createSessionMirrorState(), baseline);
  assert.equal(first.ok, true);
  assert.equal(first.disposition, "applied");

  const reordered = reverseObjectKeys(clone(baseline));
  const duplicate = applySessionMirrorEnvelope(first.nextState, reordered);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.disposition, "duplicate");
  assert.notStrictEqual(duplicate.nextState, first.nextState);
  assert.deepEqual(duplicate.nextState, first.nextState);

  const metadataChanged = clone(baseline);
  metadataChanged.source.runtimeVersion = "synthetic-redelivery-runtime-change";
  metadataChanged.source.sessionSchemaVersion = "synthetic-redelivery-schema-change";
  metadataChanged.capabilities.push("forwarded-redelivery-metadata");
  metadataChanged.forwardedMetadata = { marker: "synthetic-redelivery-envelope-change" };
  metadataChanged.message.forwardedMetadata = { marker: "synthetic-redelivery-message-change" };
  const metadataDuplicate = applySessionMirrorEnvelope(first.nextState, metadataChanged);
  assert.equal(metadataDuplicate.ok, true);
  assert.equal(metadataDuplicate.disposition, "duplicate");
  assert.notStrictEqual(metadataDuplicate.nextState, first.nextState);
  assert.deepEqual(metadataDuplicate.nextState, first.nextState);

  const conflictingGap = clone(baseline);
  conflictingGap.message.revision = 3;
  conflictingGap.message.baseRevision = 2;
  conflictingGap.message.event.status = "active";
  const conflict = applySessionMirrorEnvelope(first.nextState, conflictingGap);
  assertFailure(conflict, "conflicting-duplicate", "duplicate-conflict");
});

test("mutable caller state is cloned, stripped, and frozen before duplicate return", () => {
  const baseline = fixtureById("valid-status-update");
  const first = applySessionMirrorEnvelope(createSessionMirrorState(), baseline);
  assert.equal(first.ok, true);
  const mutableState = {
    ...first.nextState,
    internalStateField: "synthetic-internal",
    seenMessages: first.nextState.seenMessages.map((item) => ({
      ...item,
      internalMessageField: "synthetic-internal",
    })),
  };
  const duplicate = applySessionMirrorEnvelope(mutableState, baseline);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.disposition, "duplicate");
  assert.notStrictEqual(duplicate.nextState, mutableState);
  assert.equal("internalStateField" in duplicate.nextState, false);
  assert.equal("internalMessageField" in duplicate.nextState.seenMessages[0], false);
  assert.equal(Object.isFrozen(duplicate.nextState), true);
  assert.equal(Object.isFrozen(duplicate.nextState.seenMessages), true);
  assert.equal(Object.isFrozen(duplicate.nextState.seenMessages[0]), true);

  const oversizedCanonicalState = {
    ...mutableState,
    seenMessages: [
      {
        ...mutableState.seenMessages[0],
        canonical: "x".repeat(SESSION_MIRROR_BOUNDS.maxEnvelopeBytes + 1),
      },
    ],
  };
  assertFailure(
    applySessionMirrorEnvelope(oversizedCanonicalState, baseline),
    "malformed-envelope",
    "state-invalid",
  );
});

test("state invariants reject fabricated positions and never invoke known-field accessors", () => {
  const baseline = fixtureById("valid-status-update");
  const initial = createSessionMirrorState();
  const invalidUnboundStates = [
    { ...initial, revision: 99 },
    { ...initial, snapshotId: "synthetic-prior-snapshot" },
    { ...initial, cursor: "synthetic-prior-cursor" },
  ];
  for (const state of invalidUnboundStates) {
    assertFailure(
      applySessionMirrorEnvelope(state, baseline),
      "malformed-envelope",
      "state-invalid",
    );
  }

  const first = applySessionMirrorEnvelope(initial, baseline);
  assert.equal(first.ok, true);
  assertFailure(
    applySessionMirrorEnvelope({ ...first.nextState, seenMessages: [] }, baseline),
    "malformed-envelope",
    "state-invalid",
  );
  assertFailure(
    applySessionMirrorEnvelope({ ...first.nextState, cursor: null }, baseline),
    "malformed-envelope",
    "state-invalid",
  );

  const initialValues = {
    sessionId: null,
    revision: 0,
    cursor: null,
    snapshotId: null,
    seenMessages: [],
  };
  const initialFieldValues = new Map(Object.entries(initialValues));
  for (const [field, value] of initialFieldValues) {
    let reads = 0;
    const state = { ...initialValues };
    Object.defineProperty(state, field, {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return value;
      },
    });
    assertFailure(
      applySessionMirrorEnvelope(state, baseline),
      "malformed-envelope",
      "state-invalid",
    );
    assert.equal(reads, 0, `${field} accessor must not run`);
  }

  const seenMessage = first.nextState.seenMessages[0];
  const itemValues = {
    sessionId: seenMessage.sessionId,
    eventId: seenMessage.eventId,
    canonical: seenMessage.canonical,
  };
  for (const [field, value] of Object.entries(itemValues)) {
    let reads = 0;
    const item = { ...itemValues };
    Object.defineProperty(item, field, {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return value;
      },
    });
    const state = { ...first.nextState, seenMessages: [item] };
    assertFailure(
      applySessionMirrorEnvelope(state, baseline),
      "malformed-envelope",
      "state-invalid",
    );
    assert.equal(reads, 0, `seenMessages[0].${field} accessor must not run`);
  }
});

test("unseen stale and ahead event positions are revision gaps", () => {
  const baseline = fixtureById("valid-status-update");
  const first = applySessionMirrorEnvelope(createSessionMirrorState(), baseline);
  assert.equal(first.ok, true);

  for (const revision of [1, 3]) {
    const candidate = clone(baseline);
    candidate.message.eventId = `synthetic-gap-${revision}`;
    candidate.message.revision = revision;
    candidate.message.baseRevision = revision - 1;
    const result = applySessionMirrorEnvelope(first.nextState, candidate);
    assertFailure(result, "revision-gap", "revision-gap");
  }
});

test("apply does not mutate input or prior state and snapshots replace state position", () => {
  const baseline = fixtureById("valid-empty-session");
  const originalInput = clone(baseline);
  const initialState = createSessionMirrorState();
  const first = applySessionMirrorEnvelope(initialState, baseline);
  assert.equal(first.ok, true);
  assert.equal(Object.isFrozen(initialState), true);
  assert.equal(Object.isFrozen(first.nextState), true);
  assert.equal("state" in first, false);
  assert.deepEqual(baseline, originalInput);
  assert.deepEqual(initialState, createSessionMirrorState());
  assert.equal(first.nextState.sessionId, baseline.sessionId);
  assert.equal(first.nextState.revision, 0);
  assert.equal(first.nextState.cursor, baseline.message.cursor);
  assert.equal(first.nextState.snapshotId, baseline.message.snapshot.snapshotId);

  const replacement = clone(baseline);
  replacement.message.eventId = "synthetic-replacement-event";
  replacement.message.revision = 7;
  replacement.message.cursor = "synthetic-cursor-replacement";
  replacement.message.snapshot.snapshotId = "synthetic-snapshot-replacement";
  const replaced = applySessionMirrorEnvelope(first.nextState, replacement);
  assert.equal(replaced.ok, true);
  assert.equal(replaced.disposition, "applied");
  assert.equal(replaced.nextState.revision, 7);
  assert.equal(replaced.nextState.cursor, "synthetic-cursor-replacement");
  assert.equal(replaced.nextState.snapshotId, "synthetic-snapshot-replacement");

  const otherSession = clone(baseline);
  otherSession.message.eventId = "synthetic-other-session-event";
  otherSession.sessionId = "synthetic-other-session";
  const mismatch = applySessionMirrorEnvelope(replaced.nextState, otherSession);
  assertFailure(mismatch, "malformed-envelope", "session-mismatch");
});

test("seen-message retention is finite, preserves duplicates, and requires a snapshot to reset", () => {
  const snapshot = emptySnapshotEnvelope();
  const first = applySessionMirrorEnvelope(createSessionMirrorState(), snapshot);
  assert.equal(first.ok, true);
  let state = first.nextState;
  const baseline = fixtureById("valid-status-update");
  let firstAppliedEvent;

  for (let revision = 1; revision < SESSION_MIRROR_BOUNDS.maxSeenMessages; revision += 1) {
    const event = clone(baseline);
    event.sessionId = snapshot.sessionId;
    event.message.eventId = `retention-event-${revision}`;
    event.message.revision = revision;
    event.message.baseRevision = revision - 1;
    event.message.cursor = `retention-cursor-${revision}`;
    const applied = applySessionMirrorEnvelope(state, event);
    assert.equal(applied.ok, true);
    if (revision === 1) firstAppliedEvent = event;
    state = applied.nextState;
  }
  assert.equal(state.seenMessages.length, SESSION_MIRROR_BOUNDS.maxSeenMessages);

  const oldDuplicate = applySessionMirrorEnvelope(state, firstAppliedEvent);
  assert.equal(oldDuplicate.ok, true);
  assert.equal(oldDuplicate.disposition, "duplicate");
  assert.notStrictEqual(oldDuplicate.nextState, state);
  assert.deepEqual(oldDuplicate.nextState, state);

  const beyondBound = clone(baseline);
  beyondBound.sessionId = snapshot.sessionId;
  beyondBound.message.eventId = "retention-event-beyond-bound";
  beyondBound.message.revision = SESSION_MIRROR_BOUNDS.maxSeenMessages;
  beyondBound.message.baseRevision = SESSION_MIRROR_BOUNDS.maxSeenMessages - 1;
  beyondBound.message.cursor = "retention-cursor-beyond-bound";
  const rejected = applySessionMirrorEnvelope(state, beyondBound);
  assertFailure(rejected, "bounds-exceeded", "snapshot-required");

  const reset = clone(snapshot);
  reset.message.eventId = "retention-reset-snapshot";
  reset.message.revision = 100;
  reset.message.cursor = "retention-reset-cursor";
  const resetResult = applySessionMirrorEnvelope(state, reset);
  assert.equal(resetResult.ok, true);
  assert.equal(resetResult.nextState.seenMessages.length, 1);

  const afterReset = clone(baseline);
  afterReset.sessionId = snapshot.sessionId;
  afterReset.message.eventId = "retention-after-reset";
  afterReset.message.revision = 101;
  afterReset.message.baseRevision = 100;
  afterReset.message.cursor = "retention-after-reset-cursor";
  const appliedAfterReset = applySessionMirrorEnvelope(resetResult.nextState, afterReset);
  assert.equal(appliedAfterReset.ok, true);
  assert.equal(appliedAfterReset.disposition, "applied");
});

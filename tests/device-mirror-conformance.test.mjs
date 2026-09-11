import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const repoRoot = resolve(import.meta.dirname, "..");
const profileDir = join(repoRoot, "protocol", "device-mirror", "v0");
const fixtureDir = join(profileDir, "fixtures");
const sessionFixtureDir = join(repoRoot, "protocol", "session-mirror", "v1", "fixtures");
const manifest = JSON.parse(readFileSync(join(profileDir, "manifest.json"), "utf8"));
const jiti = createJiti(import.meta.url);
const mirror = await jiti.import("../protocol/device-mirror/v0/conformance.ts");
const sessionMirror = await jiti.import("../protocol/session-mirror/v1/conformance.ts");
const { SESSION_MIRROR_BOUNDS, validateSessionMirrorEnvelope } = sessionMirror;
const {
  DEVICE_MIRROR_BOUNDS,
  DEVICE_MIRROR_CAPABILITIES,
  DEVICE_MIRROR_CLOSE_REASONS,
  DEVICE_MIRROR_DROP_REASONS,
  DEVICE_MIRROR_ERROR_CODES,
  DEVICE_MIRROR_LISTING_FRESHNESS,
  DEVICE_MIRROR_LISTING_STATUSES,
  DEVICE_MIRROR_PROTOCOL,
  DEVICE_MIRROR_TRANSPORT,
  DEVICE_MIRROR_WIRE_ERROR_CODES,
  acceptDeviceMirrorHello,
  backgroundDeviceMirrorClient,
  decodeDeviceMirrorLengthPrefixedFrame,
  disconnectDeviceMirrorClient,
  disconnectDeviceMirrorProducer,
  encodeDeviceMirrorFrame,
  encodeDeviceMirrorLengthPrefixedFrame,
  evictDeviceMirrorSnapshot,
  markDeviceMirrorAcceptedEvent,
  parseDeviceMirrorFrame,
  replaceDeviceMirrorSnapshot,
  requestDeviceMirrorList,
  stopDeviceMirrorListener,
  subscribeDeviceMirrorHandle,
  takeoverDeviceMirrorProducer,
  validateDeviceMirrorAddress,
  validateDeviceMirrorFrame,
  validateDeviceMirrorListenerAddress,
  createDeviceMirrorState,
} = mirror;

const SESSION_CAPABILITIES = [
  "session-tree",
  "completed-turns-only",
  "snapshot",
  "cursor-recovery",
  "custom-entries",
  "coarse-status",
];

function readFixture(id) {
  return JSON.parse(readFileSync(join(fixtureDir, `${id}.json`), "utf8"));
}

function readSessionFixture(id) {
  return JSON.parse(readFileSync(join(sessionFixtureDir, `${id}.json`), "utf8"));
}

function assertFailure(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
  assert.deepEqual(Object.keys(result.error), ["code"]);
}

function assertCanonicalPositiveZero(value) {
  assert.equal(Object.is(value, -0), false);
  assert.equal(Object.is(value, 0), true);
}

function snapshotEnvelope(marker = "synthetic-a") {
  const entryId = `fixture-entry-${marker}`;
  return {
    protocol: { family: "session-mirror", major: 1, minor: 0 },
    source: {
      runtimeVersion: "fixture-runtime-0.1.0",
      sessionSchemaVersion: "fixture-session-schema-0.1",
    },
    sessionId: "synthetic-device-session",
    capabilities: [...SESSION_CAPABILITIES],
    message: {
      kind: "snapshot",
      eventId: `fixture-event-${marker}`,
      revision: 0,
      cursor: `fixture-cursor-${marker}`,
      operation: "replace",
      snapshot: {
        snapshotId: `fixture-snapshot-${marker}`,
        status: "idle",
        tree: {
          rootIds: [entryId],
          activeLeafId: entryId,
          entries: [
            {
              id: entryId,
              parentId: null,
              kind: "fixture-marker",
              payload: { marker },
            },
          ],
        },
      },
    },
  };
}

function snapshotInput(handle, revision, marker = `synthetic-${revision}`) {
  return {
    handle,
    status: "active",
    freshness: "fresh",
    revision,
    snapshot: snapshotEnvelope(marker),
  };
}

function fixtureSnapshotInput(fixture, revision, marker) {
  return {
    ...snapshotInput(fixture.handle, revision, marker),
    status: fixture.status,
    freshness: fixture.freshness,
  };
}

function maximalSnapshotEnvelope() {
  const envelope = snapshotEnvelope("maximal-1024");
  const entries = Array.from({ length: 1024 }, (_, index) => ({
    id: `max-entry-${index}`,
    parentId: null,
    kind: "fixture.maximal-entry",
    payload: { marker: `max-entry-${index}` },
  }));
  return {
    ...envelope,
    message: {
      ...envelope.message,
      snapshot: {
        ...envelope.message.snapshot,
        tree: {
          rootIds: entries.map((entry) => entry.id),
          activeLeafId: null,
          entries,
        },
      },
    },
  };
}

function nearMaximalByteSnapshotEnvelope() {
  const envelope = snapshotEnvelope("near-maximal-bytes");
  const entries = Array.from({ length: 4 }, (_, index) => ({
    id: `near-byte-entry-${index}`,
    parentId: null,
    kind: "fixture.near-maximal-entry",
    payload: { blob: "x".repeat(65_250) },
  }));
  return {
    ...envelope,
    message: {
      ...envelope.message,
      snapshot: {
        ...envelope.message.snapshot,
        tree: {
          rootIds: entries.map((entry) => entry.id),
          activeLeafId: null,
          entries,
        },
      },
    },
  };
}

function snapshotEnvelopeAtMaxCanonicalBytes() {
  const envelope = snapshotEnvelope("canonical-wrapper-boundary");
  const baselineBytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  const paddingSuffixBytes = Buffer.byteLength(',"padding":""', "utf8");
  const paddingCharacters =
    SESSION_MIRROR_BOUNDS.maxEnvelopeBytes - baselineBytes - paddingSuffixBytes;
  assert.ok(paddingCharacters >= 0);
  envelope.padding = "x".repeat(paddingCharacters);
  assert.equal(
    Buffer.byteLength(JSON.stringify(envelope), "utf8"),
    SESSION_MIRROR_BOUNDS.maxEnvelopeBytes,
  );
  return envelope;
}

function hello(overrides = {}) {
  return {
    kind: "hello",
    protocol: { ...DEVICE_MIRROR_PROTOCOL },
    capabilities: [...DEVICE_MIRROR_CAPABILITIES],
    ...overrides,
  };
}

function listRequest(requestId = "list-request") {
  return { kind: "list", requestId };
}

function subscribeRequest(handle, requestId = "subscribe-request") {
  return { kind: "subscribe", requestId, handle };
}

function frameBytes(value, direction) {
  const encoded = encodeDeviceMirrorFrame(value, direction);
  assert.equal(encoded.ok, true);
  return encoded.frame;
}

function connectedState() {
  const accepted = acceptDeviceMirrorHello(createDeviceMirrorState(), hello());
  assert.equal(accepted.ok, true);
  return accepted.nextState;
}

function stateWithSnapshot(handle = "launch-handle-a", revision = 1, marker = "synthetic-a") {
  const state = connectedState();
  const replaced = replaceDeviceMirrorSnapshot(state, snapshotInput(handle, revision, marker));
  assert.equal(replaced.ok, true);
  return replaced.nextState;
}

test("manifest inventories the separately versioned profile and synthetic corpus", () => {
  assert.deepStrictEqual(manifest.profile, { family: "device-mirror", major: 0, minor: 0 });
  assert.equal(manifest.manifestVersion, 1);
  assert.deepStrictEqual(manifest.transport, DEVICE_MIRROR_TRANSPORT);
  assert.deepStrictEqual(manifest.bounds, DEVICE_MIRROR_BOUNDS);
  assert.deepStrictEqual(manifest.requiredCapabilities, [...DEVICE_MIRROR_CAPABILITIES]);
  assert.deepStrictEqual(manifest.listingStatuses, [...DEVICE_MIRROR_LISTING_STATUSES]);
  assert.deepStrictEqual(manifest.listingFreshness, [...DEVICE_MIRROR_LISTING_FRESHNESS]);
  assert.deepStrictEqual(manifest.dropReasons, [...DEVICE_MIRROR_DROP_REASONS]);
  assert.deepStrictEqual(manifest.closeReasons, [...DEVICE_MIRROR_CLOSE_REASONS]);
  assert.deepStrictEqual(manifest.wireErrorCodes, [...DEVICE_MIRROR_WIRE_ERROR_CODES]);
  for (const code of DEVICE_MIRROR_WIRE_ERROR_CODES) {
    assert.equal(DEVICE_MIRROR_ERROR_CODES.includes(code), true);
  }

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
      for (const code of expectedCodes) {
        assert.equal(DEVICE_MIRROR_ERROR_CODES.includes(code), true);
      }
    }
    assert.doesNotThrow(() => readFixture(fixture.id));
  }
  const actualPaths = readdirSync(fixtureDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => `fixtures/${name}`)
    .sort();
  assert.deepEqual([...manifestPaths].sort(), actualPaths);
});

test("literal CGNAT address policy and exact active-utun listener binding are enforced", () => {
  const fixture = readFixture("valid-address-binding");
  assert.deepEqual(validateDeviceMirrorAddress(fixture.clientAddress), {
    ok: true,
    address: fixture.clientAddress,
  });
  assert.ok(fixture.interfaces.length > 8);
  assert.equal(fixture.interfaces[9].kind, "utun");
  assert.deepEqual(
    validateDeviceMirrorListenerAddress(fixture.listenerAddress, fixture.interfaces),
    { ok: true, address: fixture.listenerAddress },
  );
  assertFailure(
    validateDeviceMirrorListenerAddress(fixture.listenerAddress, [fixture.differentActiveUtun]),
    "interface-required",
  );

  for (const invalid of [
    "hostname.example",
    "100.64.0.999",
    "100.64.0.7/32",
    " 100.64.0.7",
    "100.64.0.7 ",
    "::1",
  ]) {
    assertFailure(validateDeviceMirrorAddress(invalid), "invalid-address");
  }
  assertFailure(
    validateDeviceMirrorListenerAddress(fixture.listenerAddress, [
      { kind: "utun", active: false, addresses: [fixture.listenerAddress] },
    ]),
    "interface-required",
  );
  assertFailure(
    validateDeviceMirrorListenerAddress(fixture.listenerAddress, [
      { kind: "other", active: true, addresses: [fixture.listenerAddress] },
    ]),
    "interface-required",
  );
  assertFailure(
    validateDeviceMirrorListenerAddress(fixture.listenerAddress, []),
    "interface-required",
  );
  assertFailure(
    validateDeviceMirrorListenerAddress(
      fixture.listenerAddress,
      Array.from({ length: DEVICE_MIRROR_BOUNDS.maxInterfaceRecords + 1 }, () => ({
        kind: "other",
        active: true,
        addresses: [],
      })),
    ),
    "interface-required",
  );
  assertFailure(
    validateDeviceMirrorListenerAddress(fixture.listenerAddress, [
      {
        kind: "utun",
        active: true,
        addresses: Array.from(
          { length: DEVICE_MIRROR_BOUNDS.maxInterfaceAddresses + 1 },
          () => fixture.listenerAddress,
        ),
      },
    ]),
    "interface-required",
  );

  const boundedAddresses = Array.from(
    { length: DEVICE_MIRROR_BOUNDS.maxInterfaceAddresses },
    (_, index) => (index === 0 ? fixture.listenerAddress : "192.0.2.1"),
  );
  assert.deepEqual(
    validateDeviceMirrorListenerAddress(fixture.listenerAddress, [
      { kind: "utun", active: true, addresses: boundedAddresses },
    ]),
    { ok: true, address: fixture.listenerAddress },
  );

  const validInterface = {
    kind: "utun",
    active: true,
    addresses: [fixture.listenerAddress],
  };
  const oversizedInterface = {
    kind: "other",
    active: false,
    addresses: Array.from(
      { length: DEVICE_MIRROR_BOUNDS.maxInterfaceAddresses + 1 },
      () => "192.0.2.1",
    ),
  };
  for (const interfaces of [
    [validInterface, oversizedInterface],
    [oversizedInterface, validInterface],
  ]) {
    assertFailure(
      validateDeviceMirrorListenerAddress(fixture.listenerAddress, interfaces),
      "interface-required",
    );
  }

  let addressDescriptorReads = 0;
  const boundedDescriptorAddresses = [fixture.listenerAddress];
  const oversizedDescriptorAddresses = Array.from(
    { length: DEVICE_MIRROR_BOUNDS.maxInterfaceAddresses + 1 },
    () => "192.0.2.1",
  );
  const changingRecord = new Proxy(
    {
      kind: "other",
      active: false,
      addresses: boundedDescriptorAddresses,
      extra: "synthetic-extra",
    },
    {
      getOwnPropertyDescriptor(target, property) {
        if (property === "addresses") {
          addressDescriptorReads += 1;
          return {
            configurable: true,
            enumerable: true,
            value:
              addressDescriptorReads === 1
                ? boundedDescriptorAddresses
                : oversizedDescriptorAddresses,
            writable: true,
          };
        }
        return Object.getOwnPropertyDescriptor(target, property);
      },
    },
  );
  assertFailure(
    validateDeviceMirrorListenerAddress(fixture.listenerAddress, [changingRecord, validInterface]),
    "interface-required",
  );
  assert.equal(addressDescriptorReads, 2);

  let oversizedChildReached = false;
  const oversizedAddressTarget = [];
  Object.defineProperty(oversizedAddressTarget, "length", {
    value: DEVICE_MIRROR_BOUNDS.maxInterfaceAddresses + 1,
  });
  const oversizedAddressCollection = new Proxy(oversizedAddressTarget, {
    get(target, property) {
      if (property !== "length") {
        oversizedChildReached = true;
        throw new Error("synthetic child access");
      }
      return target[property];
    },
    getOwnPropertyDescriptor(target, property) {
      if (property !== "length") {
        oversizedChildReached = true;
        throw new Error("synthetic child descriptor access");
      }
      return Object.getOwnPropertyDescriptor(target, property);
    },
    ownKeys() {
      oversizedChildReached = true;
      throw new Error("synthetic child traversal");
    },
  });
  assertFailure(
    validateDeviceMirrorListenerAddress(fixture.listenerAddress, [
      { kind: "utun", active: true, addresses: oversizedAddressCollection },
    ]),
    "interface-required",
  );
  assert.equal(oversizedChildReached, false);
});

test("closed frame shapes, negotiated versions, capabilities, and direction are enforced", () => {
  const validHello = validateDeviceMirrorFrame(hello(), "client-to-listener");
  assert.equal(validHello.ok, true);
  assert.deepEqual(validHello.frame.capabilities, DEVICE_MIRROR_CAPABILITIES);

  const ready = validateDeviceMirrorFrame(
    {
      kind: "ready",
      protocol: { ...DEVICE_MIRROR_PROTOCOL },
      capabilities: [...DEVICE_MIRROR_CAPABILITIES],
    },
    "listener-to-client",
  );
  assert.equal(ready.ok, true);

  const listing = validateDeviceMirrorFrame(
    {
      kind: "list",
      requestId: "list-request",
      conversations: readFixture("valid-opaque-listing").conversations,
    },
    "listener-to-client",
  );
  assert.equal(listing.ok, true);
  assert.deepEqual(Object.keys(listing.frame.conversations[0]).sort(), [
    "freshness",
    "handle",
    "status",
  ]);

  const directionFixture = readFixture("invalid-direction");
  assertFailure(
    validateDeviceMirrorFrame(
      { kind: directionFixture.clientToListenerKind },
      "client-to-listener",
    ),
    directionFixture.expectedCode,
  );
  assertFailure(
    validateDeviceMirrorFrame(
      { kind: directionFixture.listenerToClientKind },
      "listener-to-client",
    ),
    directionFixture.expectedCode,
  );
  assertFailure(
    validateDeviceMirrorFrame(
      { kind: "list", requestId: "synthetic-request" },
      "listener-to-client",
    ),
    "wrong-direction",
  );
  assertFailure(
    validateDeviceMirrorFrame(
      { kind: "list", requestId: "synthetic-request", conversations: [] },
      "client-to-listener",
    ),
    "wrong-direction",
  );
  assertFailure(
    validateDeviceMirrorFrame({ kind: "future-message" }, "client-to-listener"),
    "unsupported-message",
  );
  assertFailure(
    validateDeviceMirrorFrame({ ...hello(), unexpected: "synthetic" }, "client-to-listener"),
    "malformed-frame",
  );

  for (const [index, capability] of [
    undefined,
    ["subscribe", "list", "snapshot-replace"],
    ["list", "subscribe", "snapshot-replace", "list"],
  ].entries()) {
    const candidate = hello({ capabilities: capability });
    assertFailure(
      validateDeviceMirrorFrame(candidate, "client-to-listener"),
      index === 2
        ? "incompatible-capability"
        : index === 1
          ? "incompatible-capability"
          : "malformed-frame",
    );
  }
});

test("family, major, and future minor versions are rejected before channel use", () => {
  const fixture = readFixture("invalid-version");
  assertFailure(
    validateDeviceMirrorFrame(hello({ protocol: fixture.unsupportedFamily }), "client-to-listener"),
    fixture.expectedCode,
  );
  assertFailure(
    validateDeviceMirrorFrame(hello({ protocol: fixture.unsupportedMajor }), "client-to-listener"),
    fixture.expectedCode,
  );
  assertFailure(
    validateDeviceMirrorFrame(hello({ protocol: fixture.unsupportedMinor }), "client-to-listener"),
    fixture.expectedCode,
  );
  assertFailure(
    validateDeviceMirrorFrame(
      hello({ protocol: { family: DEVICE_MIRROR_PROTOCOL.family, major: "0", minor: 0 } }),
      "client-to-listener",
    ),
    "malformed-frame",
  );
});

test("u32-BE framing is exact and bounded for control and snapshot frames", () => {
  assert.equal(
    DEVICE_MIRROR_BOUNDS.maxFrameBodyBytes,
    DEVICE_MIRROR_BOUNDS.maxSessionMirrorEnvelopeBytes +
      DEVICE_MIRROR_BOUNDS.maxSnapshotFrameWrapperBytes,
  );
  assert.equal(DEVICE_MIRROR_BOUNDS.maxSessionMirrorEnvelopeBytes, 256 * 1024);
  assert.equal(DEVICE_MIRROR_BOUNDS.maxSnapshotFrameWrapperBytes, 839);
  assert.equal(DEVICE_MIRROR_BOUNDS.maxControlFrameBytes, 16 * 1024);

  const encoded = frameBytes(hello(), "client-to-listener");
  assert.deepEqual(Array.from(encoded.slice(0, 4)), [0, 0, 0, encoded.byteLength - 4]);
  const decoded = decodeDeviceMirrorLengthPrefixedFrame(encoded);
  assert.equal(decoded.ok, true);
  assert.deepEqual(
    parseDeviceMirrorFrame(encoded, "client-to-listener"),
    validateDeviceMirrorFrame(hello(), "client-to-listener"),
  );

  const malformedFixture = readFixture("invalid-frames");
  for (const code of [
    "frame-too-large",
    "malformed-frame",
    "invalid-utf8",
    "invalid-json",
    "control-frame-too-large",
  ]) {
    assert.equal(malformedFixture.expectedCodes.includes(code), true);
  }
  assertFailure(
    decodeDeviceMirrorLengthPrefixedFrame(
      new Uint8Array([0, 0, 0, malformedFixture.truncatedBodyLength, 1]),
    ),
    "malformed-frame",
  );
  const trailing = new Uint8Array([0, 0, 0, malformedFixture.trailingBodyLength, 1, 2, 3]);
  assertFailure(decodeDeviceMirrorLengthPrefixedFrame(trailing), "malformed-frame");
  const oversized = new Uint8Array(4);
  oversized[0] = (DEVICE_MIRROR_BOUNDS.maxFrameBodyBytes + 1) >>> 24;
  oversized[1] = (DEVICE_MIRROR_BOUNDS.maxFrameBodyBytes + 1) >>> 16;
  oversized[2] = (DEVICE_MIRROR_BOUNDS.maxFrameBodyBytes + 1) >>> 8;
  oversized[3] = DEVICE_MIRROR_BOUNDS.maxFrameBodyBytes + 1;
  assertFailure(decodeDeviceMirrorLengthPrefixedFrame(oversized), "frame-too-large");

  const invalidUtf8 = encodeDeviceMirrorLengthPrefixedFrame(new Uint8Array([0xc3, 0x28]));
  assert.equal(invalidUtf8.ok, true);
  assertFailure(parseDeviceMirrorFrame(invalidUtf8.frame, "client-to-listener"), "invalid-utf8");
  const invalidJson = encodeDeviceMirrorLengthPrefixedFrame(new TextEncoder().encode("{"));
  assert.equal(invalidJson.ok, true);
  assertFailure(parseDeviceMirrorFrame(invalidJson.frame, "client-to-listener"), "invalid-json");

  const oversizedControlBody = new TextEncoder().encode(
    JSON.stringify({ ...hello(), extra: "x".repeat(DEVICE_MIRROR_BOUNDS.maxControlFrameBytes) }),
  );
  const oversizedControl = encodeDeviceMirrorLengthPrefixedFrame(oversizedControlBody);
  assert.equal(oversizedControl.ok, true);
  assertFailure(
    parseDeviceMirrorFrame(oversizedControl.frame, "client-to-listener"),
    "control-frame-too-large",
  );
});

test("raw wire bounds measure bytes as sent instead of canonical reserialization", () => {
  const canonical = frameBytes(hello(), "client-to-listener");
  const canonicalDecoded = decodeDeviceMirrorLengthPrefixedFrame(canonical);
  assert.equal(canonicalDecoded.ok, true);
  assert.equal(canonicalDecoded.body.byteLength < DEVICE_MIRROR_BOUNDS.maxControlFrameBytes, true);
  assert.equal(parseDeviceMirrorFrame(canonical, "client-to-listener").ok, true);

  const padding = DEVICE_MIRROR_BOUNDS.maxControlFrameBytes - canonicalDecoded.body.byteLength + 1;
  const rawBody = new Uint8Array(canonicalDecoded.body.byteLength + padding);
  rawBody.set(canonicalDecoded.body);
  rawBody.set(new TextEncoder().encode(" ".repeat(padding)), canonicalDecoded.body.byteLength);
  assert.equal(rawBody.byteLength, DEVICE_MIRROR_BOUNDS.maxControlFrameBytes + 1);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(rawBody)), hello());

  const rawFrame = encodeDeviceMirrorLengthPrefixedFrame(rawBody);
  assert.equal(rawFrame.ok, true);
  assertFailure(
    parseDeviceMirrorFrame(rawFrame.frame, "client-to-listener"),
    "control-frame-too-large",
  );
});

test("canonical JSON handle bytes honor code-point bounds and the snapshot wrapper allowance", () => {
  const snapshot = snapshotEnvelopeAtMaxCanonicalBytes();
  const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  assert.equal(snapshotBytes, DEVICE_MIRROR_BOUNDS.maxSessionMirrorEnvelopeBytes);
  const escapedHandleBytes = 2 + DEVICE_MIRROR_BOUNDS.maxHandleCharacters * 6;
  const cases = [
    {
      name: "control",
      handle: "\u0000".repeat(DEVICE_MIRROR_BOUNDS.maxHandleCharacters),
      expectedHandleBytes: escapedHandleBytes,
      accepted: true,
    },
    {
      name: "lone-surrogate",
      handle: "\ud800".repeat(DEVICE_MIRROR_BOUNDS.maxHandleCharacters),
      expectedHandleBytes: escapedHandleBytes,
      accepted: false,
    },
    {
      name: "astral",
      handle: "\u{1f600}".repeat(DEVICE_MIRROR_BOUNDS.maxHandleCharacters),
      expectedHandleBytes: 2 + DEVICE_MIRROR_BOUNDS.maxHandleCharacters * 4,
      accepted: true,
    },
  ];

  for (const { name, handle, expectedHandleBytes, accepted } of cases) {
    assert.equal([...handle].length, DEVICE_MIRROR_BOUNDS.maxHandleCharacters, name);
    const canonicalHandle = JSON.stringify(handle);
    assert.equal(Buffer.byteLength(canonicalHandle, "utf8"), expectedHandleBytes, name);
    if (name === "lone-surrogate") {
      assert.equal(
        canonicalHandle,
        `"${"\\ud800".repeat(DEVICE_MIRROR_BOUNDS.maxHandleCharacters)}"`,
        name,
      );
    }

    const input = {
      kind: "snapshot",
      handle,
      revision: DEVICE_MIRROR_BOUNDS.maxRevision,
      snapshot,
    };
    const canonicalFrameBytes = Buffer.byteLength(JSON.stringify(input), "utf8");
    const wrapperBytes = canonicalFrameBytes - snapshotBytes;
    const expectedWrapperBytes =
      DEVICE_MIRROR_BOUNDS.maxSnapshotFrameWrapperBytes - escapedHandleBytes + expectedHandleBytes;
    assert.equal(wrapperBytes, expectedWrapperBytes, name);
    const expectedBodyBytes =
      DEVICE_MIRROR_BOUNDS.maxFrameBodyBytes - escapedHandleBytes + expectedHandleBytes;

    if (!accepted) {
      const rawBody = new TextEncoder().encode(JSON.stringify(input));
      assert.equal(rawBody.byteLength, expectedBodyBytes, name);
      const rawFrame = encodeDeviceMirrorLengthPrefixedFrame(rawBody);
      assert.equal(rawFrame.ok, true, name);
      assertFailure(
        parseDeviceMirrorFrame(rawFrame.frame, "listener-to-client"),
        "malformed-frame",
      );
      assertFailure(validateDeviceMirrorFrame(input, "listener-to-client"), "malformed-frame");
      assertFailure(encodeDeviceMirrorFrame(input, "listener-to-client"), "malformed-frame");
      continue;
    }

    const encoded = encodeDeviceMirrorFrame(input, "listener-to-client");
    assert.equal(encoded.ok, true, name);
    const decoded = decodeDeviceMirrorLengthPrefixedFrame(encoded.frame);
    assert.equal(decoded.ok, true, name);
    const bodyText = new TextDecoder().decode(decoded.body);
    const parsed = JSON.parse(bodyText);
    assert.equal(bodyText, JSON.stringify(parsed), name);
    assert.equal(parsed.handle, handle, name);
    assert.equal(Buffer.byteLength(JSON.stringify(parsed.snapshot), "utf8"), snapshotBytes, name);
    assert.equal(decoded.body.byteLength, expectedBodyBytes, name);
    assert.equal(decoded.body.byteLength <= DEVICE_MIRROR_BOUNDS.maxFrameBodyBytes, true, name);
  }
});

test("129-code-point handles are rejected at the outer DeviceMirror boundary", () => {
  const handle = "\u{1f600}".repeat(DEVICE_MIRROR_BOUNDS.maxHandleCharacters + 1);
  assert.equal([...handle].length, DEVICE_MIRROR_BOUNDS.maxHandleCharacters + 1);
  const input = {
    kind: "snapshot",
    handle,
    revision: 1,
    snapshot: snapshotEnvelope("over-limit-handle"),
  };
  assertFailure(validateDeviceMirrorFrame(input, "listener-to-client"), "malformed-frame");
  assertFailure(encodeDeviceMirrorFrame(input, "listener-to-client"), "malformed-frame");
});

test("unpaired outer DeviceMirror surrogates fail closed", () => {
  for (const handle of ["\ud800", "\udfff", "prefix\ud800", "\udfff-suffix"]) {
    const input = {
      kind: "dropped",
      handle,
      reason: "eviction",
    };
    assertFailure(validateDeviceMirrorFrame(input, "listener-to-client"), "malformed-frame");
    assertFailure(encodeDeviceMirrorFrame(input, "listener-to-client"), "malformed-frame");
  }
});

test("request IDs reject unpaired surrogates and accept astral scalars", () => {
  const astralRequestId = "\u{1f600}".repeat(DEVICE_MIRROR_BOUNDS.maxRequestIdCharacters);
  const valid = validateDeviceMirrorFrame(
    { kind: "list", requestId: astralRequestId },
    "client-to-listener",
  );
  assert.equal(valid.ok, true);
  assert.equal(valid.frame.requestId, astralRequestId);

  const invalid = { kind: "list", requestId: "\ud800" };
  assertFailure(validateDeviceMirrorFrame(invalid, "client-to-listener"), "malformed-frame");
  assertFailure(encodeDeviceMirrorFrame(invalid, "client-to-listener"), "malformed-frame");
});

test("revision negative zero is canonicalized at validation and state boundaries", () => {
  const frame = {
    kind: "snapshot",
    handle: "negative-zero-frame",
    revision: -0,
    snapshot: snapshotEnvelope("negative-zero-frame"),
  };
  const validated = validateDeviceMirrorFrame(frame, "listener-to-client");
  assert.equal(validated.ok, true);
  assertCanonicalPositiveZero(validated.frame.revision);

  const inclusiveZero = validateDeviceMirrorFrame(
    { ...frame, handle: "inclusive-zero", revision: 0 },
    "listener-to-client",
  );
  assert.equal(inclusiveZero.ok, true);
  assertCanonicalPositiveZero(inclusiveZero.frame.revision);

  const maximalRevision = validateDeviceMirrorFrame(
    { ...frame, handle: "maximal-revision", revision: DEVICE_MIRROR_BOUNDS.maxRevision },
    "listener-to-client",
  );
  assert.equal(maximalRevision.ok, true);
  assert.equal(maximalRevision.frame.revision, DEVICE_MIRROR_BOUNDS.maxRevision);
  assert.equal(Object.is(maximalRevision.frame.revision, -0), false);

  const candidate = replaceDeviceMirrorSnapshot(
    connectedState(),
    snapshotInput("negative-zero-state", -0, "negative-zero-state"),
  );
  assert.equal(candidate.ok, true);
  assertCanonicalPositiveZero(candidate.nextState.handles[0].revision);

  const rawState = {
    status: "open",
    deviceConnected: true,
    subscribedHandle: null,
    handles: [
      {
        handle: "raw-state-negative-zero",
        status: "active",
        freshness: "fresh",
        revision: -0,
        snapshot: snapshotEnvelope("raw-state-negative-zero"),
      },
    ],
  };
  assert.equal(Object.is(rawState.handles[0].revision, -0), true);
  const subscribed = subscribeDeviceMirrorHandle(
    rawState,
    subscribeRequest("raw-state-negative-zero"),
  );
  assert.equal(subscribed.ok, true);
  assertCanonicalPositiveZero(subscribed.nextState.handles[0].revision);
  assert.equal(subscribed.frames.length, 1);
  assertCanonicalPositiveZero(subscribed.frames[0].revision);
});

test("device frame encoding emits canonical revision zero on the wire", () => {
  const encoded = encodeDeviceMirrorFrame(
    {
      kind: "snapshot",
      handle: "negative-zero-wire",
      revision: -0,
      snapshot: snapshotEnvelope("negative-zero-wire"),
    },
    "listener-to-client",
  );
  assert.equal(encoded.ok, true);
  const decoded = decodeDeviceMirrorLengthPrefixedFrame(encoded.frame);
  assert.equal(decoded.ok, true);
  const encodedBody = new TextDecoder().decode(decoded.body);
  // Endpoint wire/serializer evidence only; normalization is asserted separately.
  assert.equal(encodedBody.includes('"revision":-0'), false);
  assertCanonicalPositiveZero(JSON.parse(encodedBody).revision);
});

test("literal framed JSON negative-zero revisions parse and round-trip canonically", () => {
  const literalBody = `{"kind":"snapshot","handle":"literal-negative-zero","revision":-0,"snapshot":${JSON.stringify(snapshotEnvelope("literal-negative-zero"))}}`;
  assert.equal(Object.is(JSON.parse(literalBody).revision, -0), true);
  const literalFramed = encodeDeviceMirrorLengthPrefixedFrame(
    new TextEncoder().encode(literalBody),
  );
  assert.equal(literalFramed.ok, true);
  const parsed = parseDeviceMirrorFrame(literalFramed.frame, "listener-to-client");
  assert.equal(parsed.ok, true);
  assertCanonicalPositiveZero(parsed.frame.revision);

  const roundTrip = encodeDeviceMirrorFrame(parsed.frame, "listener-to-client");
  assert.equal(roundTrip.ok, true);
  const roundTripDecoded = decodeDeviceMirrorLengthPrefixedFrame(roundTrip.frame);
  assert.equal(roundTripDecoded.ok, true);
  const roundTripBody = new TextDecoder().decode(roundTripDecoded.body);
  // Endpoint wire/serializer evidence only; normalization is asserted above.
  assert.equal(roundTripBody.includes('"revision":-0'), false);
  assertCanonicalPositiveZero(JSON.parse(roundTripBody).revision);
  const reparsed = parseDeviceMirrorFrame(roundTrip.frame, "listener-to-client");
  assert.equal(reparsed.ok, true);
  assertCanonicalPositiveZero(reparsed.frame.revision);
});

test("maximal legal v1 snapshots pass frame validation and replacement", () => {
  const snapshot = maximalSnapshotEnvelope();
  const frame = {
    kind: "snapshot",
    handle: "maximal-1024-handle",
    revision: 1,
    snapshot,
  };
  const validated = validateDeviceMirrorFrame(frame, "listener-to-client");
  assert.equal(validated.ok, true);
  assert.equal(validated.frame.snapshot.message.snapshot.tree.entries.length, 1024);

  const replaced = replaceDeviceMirrorSnapshot(connectedState(), {
    handle: frame.handle,
    status: "active",
    freshness: "fresh",
    revision: frame.revision,
    snapshot,
  });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.nextState.handles.length, 1);
  assert.equal(replaced.nextState.handles[0].snapshot.message.snapshot.tree.entries.length, 1024);
});

test("near-maximal v1 snapshots survive replacement, subscription, encoding, and validation", () => {
  const snapshot = nearMaximalByteSnapshotEnvelope();
  const envelopeBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  assert.ok(envelopeBytes > SESSION_MIRROR_BOUNDS.maxEnvelopeBytes - 1024);
  const v1Validated = validateSessionMirrorEnvelope(snapshot);
  assert.equal(v1Validated.ok, true);

  const handle = "h".repeat(DEVICE_MIRROR_BOUNDS.maxHandleCharacters);
  const state = connectedState();
  const replaced = replaceDeviceMirrorSnapshot(state, {
    handle,
    status: "active",
    freshness: "fresh",
    revision: DEVICE_MIRROR_BOUNDS.maxRevision,
    snapshot,
  });
  assert.equal(replaced.ok, true);

  const subscribed = subscribeDeviceMirrorHandle(
    replaced.nextState,
    subscribeRequest(handle, "near-maximal-subscription"),
  );
  assert.equal(subscribed.ok, true);
  assert.equal(subscribed.frames.length, 1);
  const snapshotFrame = subscribed.frames[0];
  const validated = validateDeviceMirrorFrame(snapshotFrame, "listener-to-client");
  assert.equal(validated.ok, true);
  const encoded = encodeDeviceMirrorFrame(snapshotFrame, "listener-to-client");
  assert.equal(encoded.ok, true);
  assert.ok(encoded.frame.byteLength - 4 > DEVICE_MIRROR_BOUNDS.maxSessionMirrorEnvelopeBytes);
  assert.ok(encoded.frame.byteLength - 4 <= DEVICE_MIRROR_BOUNDS.maxFrameBodyBytes);
  const parsed = parseDeviceMirrorFrame(encoded.frame, "listener-to-client");
  assert.equal(parsed.ok, true);
});

test("every frozen v1 failure category maps to a closed device error", () => {
  const mappings = [
    ["invalid-malformed-envelope", "snapshot-invalid"],
    ["invalid-bounds-exceeded", "snapshot-bounds"],
    ["invalid-incompatible-protocol", "snapshot-incompatible"],
    ["invalid-incompatible-capability", "snapshot-incompatible"],
    ["invalid-forbidden-streaming-capability", "snapshot-forbidden"],
    ["invalid-forbidden-assistant-content", "snapshot-forbidden"],
    ["invalid-incompatible-message", "snapshot-incompatible"],
    ["invalid-incomplete-assistant-turn", "snapshot-incomplete"],
    ["invalid-conflicting-duplicate", "snapshot-invalid"],
    ["invalid-revision-gap", "snapshot-invalid"],
  ];
  for (const [fixtureId, expectedCode] of mappings) {
    assertFailure(
      validateDeviceMirrorFrame(
        {
          kind: "snapshot",
          handle: `mapping-${fixtureId}`,
          revision: 1,
          snapshot: readSessionFixture(fixtureId),
        },
        "listener-to-client",
      ),
      expectedCode,
    );
  }
});

test("opaque listings expose only coarse status and freshness", () => {
  const fixture = readFixture("valid-opaque-listing");
  const result = validateDeviceMirrorFrame(
    { kind: "list", requestId: fixture.requestId, conversations: fixture.conversations },
    "listener-to-client",
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.frame.conversations.map((item) => Object.keys(item).sort()),
    [
      ["freshness", "handle", "status"],
      ["freshness", "handle", "status"],
    ],
  );
  assert.equal("sessionId" in result.frame.conversations[0], false);
  assert.equal("source" in result.frame.conversations[0], false);
  assertFailure(
    validateDeviceMirrorFrame(
      {
        kind: "list",
        requestId: fixture.requestId,
        conversations: [{ ...fixture.conversations[0], title: "synthetic-title" }],
      },
      "listener-to-client",
    ),
    "malformed-frame",
  );
});

test("validated snapshots replace whole state, coalesce newer revisions, and reject stale data", () => {
  const fixture = readFixture("valid-snapshot-replacement");
  const [firstRevision, replacementRevision, staleRevision] = fixture.revisions;
  let state = connectedState();
  const first = replaceDeviceMirrorSnapshot(
    state,
    fixtureSnapshotInput(fixture, firstRevision, "synthetic-one"),
  );
  assert.equal(first.ok, true);
  assert.equal(first.result.code, fixture.expected.first);
  assert.equal(first.nextState.handles.length, 1);
  assert.equal(
    first.nextState.handles[0].snapshot.message.snapshot.tree.entries[0].payload.marker,
    "synthetic-one",
  );
  state = first.nextState;

  const subscribed = subscribeDeviceMirrorHandle(state, subscribeRequest(fixture.handle));
  assert.equal(subscribed.ok, true);
  assert.equal(subscribed.frames.length, 1);
  assert.equal(subscribed.frames[0].kind, "snapshot");

  const replacement = replaceDeviceMirrorSnapshot(
    subscribed.nextState,
    fixtureSnapshotInput(fixture, replacementRevision, "synthetic-two"),
  );
  assert.equal(replacement.ok, true);
  assert.equal(replacement.result.code, fixture.expected.replacement);
  assert.equal(
    replacement.nextState.handles[0].snapshot.message.snapshot.tree.entries[0].payload.marker,
    "synthetic-two",
  );
  assert.equal(replacement.frames.length, 1);
  assert.equal(replacement.frames[0].kind, "snapshot");
  assert.equal(
    replacement.frames[0].snapshot.message.snapshot.tree.entries[0].payload.marker,
    "synthetic-two",
  );
  assert.equal(
    state.handles[0].snapshot.message.snapshot.tree.entries[0].payload.marker,
    "synthetic-one",
  );

  const stale = replaceDeviceMirrorSnapshot(
    replacement.nextState,
    fixtureSnapshotInput(fixture, staleRevision, "synthetic-stale"),
  );
  assertFailure(stale, fixture.expected.stale);
  assert.equal(replacement.nextState.handles[0].revision, replacementRevision);

  const eventEnvelope = snapshotEnvelope("synthetic-event-kind");
  eventEnvelope.message = {
    kind: "event",
    eventId: "synthetic-event",
    revision: 1,
    baseRevision: 0,
    cursor: "synthetic-cursor",
    operation: "append",
    event: { type: "status.changed", status: "active" },
  };
  assertFailure(
    replaceDeviceMirrorSnapshot(replacement.nextState, {
      ...fixtureSnapshotInput(fixture, replacementRevision + 1, "synthetic-event-kind"),
      snapshot: eventEnvelope,
    }),
    "snapshot-invalid",
  );
});

test("state transitions enforce connection, listing, subscription, and capacity bounds", () => {
  let state = connectedState();
  assertFailure(acceptDeviceMirrorHello(state, hello()), "connection-busy");
  const listed = requestDeviceMirrorList(state, listRequest());
  assert.equal(listed.ok, true);
  assert.equal(listed.frames[0].kind, "list");
  assert.deepEqual(listed.frames[0].conversations, []);
  assertFailure(
    requestDeviceMirrorList(createDeviceMirrorState(), listRequest()),
    "device-disconnected",
  );
  assertFailure(
    subscribeDeviceMirrorHandle(state, subscribeRequest("missing-handle")),
    "unknown-handle",
  );
  const disconnectedSubscription = {
    ...stateWithSnapshot("disconnected-handle"),
    deviceConnected: false,
    subscribedHandle: "disconnected-handle",
  };
  assertFailure(requestDeviceMirrorList(disconnectedSubscription, listRequest()), "state-invalid");

  for (let index = 0; index < DEVICE_MIRROR_BOUNDS.maxListingEntries; index += 1) {
    const replaced = replaceDeviceMirrorSnapshot(
      state,
      snapshotInput(`capacity-handle-${index}`, index + 1),
    );
    assert.equal(replaced.ok, true);
    state = replaced.nextState;
  }
  assert.equal(state.handles.length, DEVICE_MIRROR_BOUNDS.maxListingEntries);
  assertFailure(
    replaceDeviceMirrorSnapshot(state, snapshotInput("capacity-overflow", 1)),
    "capacity-exhausted",
  );
});

test("producer, takeover, event, eviction, disconnect, background, and stop drops are immediate", () => {
  const fixture = readFixture("valid-drop-lifecycle");
  assert.equal(fixture.dropIsImmediate, true);
  assert.equal(fixture.dropIsIdempotent, true);
  const [
    producerDisconnectReason,
    takeoverReason,
    acceptedEventReason,
    evictionReason,
    listenerStopReason,
    deviceDisconnectReason,
    backgroundingReason,
  ] = fixture.reasons;
  assert.deepEqual(
    [listenerStopReason, deviceDisconnectReason, backgroundingReason],
    ["listener-stop", "device-disconnect", "backgrounding"],
  );
  const dropFunctions = [
    [producerDisconnectReason, disconnectDeviceMirrorProducer],
    [takeoverReason, takeoverDeviceMirrorProducer],
    [acceptedEventReason, markDeviceMirrorAcceptedEvent],
    [evictionReason, evictDeviceMirrorSnapshot],
  ];
  for (const [reason, dropFunction] of dropFunctions) {
    let state = stateWithSnapshot(fixture.handle);
    const subscribed = subscribeDeviceMirrorHandle(state, subscribeRequest(fixture.handle));
    assert.equal(subscribed.ok, true);
    state = subscribed.nextState;
    const dropped = dropFunction(state, fixture.handle);
    assert.equal(dropped.ok, true);
    assert.equal(dropped.result.code, "dropped");
    assert.equal(dropped.nextState.handles.length, 0);
    const relisted = requestDeviceMirrorList(dropped.nextState, listRequest());
    assert.equal(relisted.ok, true);
    assert.deepEqual(relisted.frames[0].conversations, []);
    assert.deepEqual(dropped.frames, [{ kind: "dropped", handle: fixture.handle, reason }]);
    const repeated = dropFunction(dropped.nextState, fixture.handle);
    assert.equal(repeated.ok, true);
    assert.equal(repeated.nextState.handles.length, 0);
    assert.deepEqual(repeated.frames, []);
  }

  const disconnected = disconnectDeviceMirrorClient(stateWithSnapshot(fixture.handle));
  assert.equal(disconnected.ok, true);
  assert.equal(disconnected.result.code, "disconnected");
  assert.equal(disconnected.nextState.handles.length, 0);
  assert.equal(disconnected.nextState.deviceConnected, false);

  const backgrounded = backgroundDeviceMirrorClient(stateWithSnapshot(fixture.handle));
  assert.equal(backgrounded.ok, true);
  assert.equal(backgrounded.result.code, "backgrounded");
  assert.equal(backgrounded.nextState.handles.length, 0);
  assert.equal(backgrounded.nextState.deviceConnected, false);

  const stopped = stopDeviceMirrorListener(stateWithSnapshot(fixture.handle));
  assert.equal(stopped.ok, true);
  assert.equal(stopped.result.code, "closed");
  assert.equal(stopped.nextState.status, "stopped");
  assert.equal(stopped.nextState.handles.length, 0);
  assert.deepEqual(stopped.frames, [{ kind: "close", reason: listenerStopReason }]);
  const repeatedStop = stopDeviceMirrorListener(stopped.nextState);
  assert.equal(repeatedStop.ok, true);
  assert.equal(repeatedStop.result.code, "closed");
  assert.deepEqual(repeatedStop.frames, []);
  assertFailure(requestDeviceMirrorList(stopped.nextState, listRequest()), "listener-stopped");
});

test("hostile values fail closed without invoking accessors or echoing values", () => {
  const fixture = readFixture("invalid-hostile-boundaries");
  const cycle = hello();
  cycle.extra = cycle;
  const accessor = hello();
  Object.defineProperty(accessor, "extra", {
    enumerable: true,
    get() {
      throw new Error("synthetic hostile getter");
    },
  });
  const prototype = Object.create({ inherited: "synthetic" });
  Object.assign(prototype, hello());
  const sparseCapabilities = ["list", "subscribe", "snapshot-replace"];
  delete sparseCapabilities[1];
  const hole = hello({ capabilities: sparseCapabilities });
  const cases = { cycle, accessor, prototype, "array-hole": hole };
  for (const name of fixture.cases) {
    assert.doesNotThrow(() => {
      const result = validateDeviceMirrorFrame(cases[name], "client-to-listener");
      assertFailure(result, fixture.expectedCode);
      assert.equal(JSON.stringify(result).includes("synthetic hostile"), false);
    });
  }

  const hostileHandle = "synthetic-sensitive-handle";
  const state = createDeviceMirrorState();
  const malformedState = {
    ...state,
    handles: [{ handle: hostileHandle, snapshot: cycle }],
  };
  const malformedResult = replaceDeviceMirrorSnapshot(
    malformedState,
    snapshotInput("valid-handle", 1),
  );
  assertFailure(malformedResult, "state-invalid");
  assert.equal(JSON.stringify(malformedResult).includes(hostileHandle), false);
});

test("npm pack dry-run excludes repository-only mirror contracts and this conformance test", () => {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const packResult = JSON.parse(result.stdout);
  const packedPaths = new Set(
    packResult.flatMap((entry) => entry.files ?? []).map((entry) => entry.path),
  );

  assert.equal(
    packedPaths.has("extensions/the-last-harness.js"),
    true,
    "npm pack must include its packaged runtime sentinel",
  );
  for (const directory of ["protocol/device-mirror/", "protocol/session-mirror/"]) {
    assert.equal(
      [...packedPaths].some((path) => path.startsWith(directory)),
      false,
      `npm pack must exclude ${directory}`,
    );
  }
  assert.equal(packedPaths.has("tests/device-mirror-conformance.test.mjs"), false);
});

test("frozen session-mirror/v1 dependency hashes remain unchanged", () => {
  const dependency = manifest.frozenDependencies.find((item) => item.name === "session-mirror-v1");
  assert.ok(dependency);
  assert.equal(manifest.frozenDependencies.length, 1);
  for (const file of dependency.normativeFiles) {
    const digest = createHash("sha256")
      .update(readFileSync(join(repoRoot, file.path)))
      .digest("hex");
    assert.equal(digest, file.sha256, file.path);
  }
  assert.equal(
    manifest.frozenDependencies.some((item) => item.name === "local-bridge-v0"),
    false,
  );
});

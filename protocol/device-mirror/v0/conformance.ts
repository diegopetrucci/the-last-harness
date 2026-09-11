import {
  SESSION_MIRROR_BOUNDS,
  validateSessionMirrorEnvelope,
  type SessionMirrorEnvelope,
} from "../../session-mirror/v1/conformance.ts";

const DEVICE_MIRROR_FAMILY = "device-mirror";
const DEVICE_MIRROR_MAJOR = 0;
const DEVICE_MIRROR_MINOR = 0;
const REQUIRED_CAPABILITIES = ["list", "subscribe", "snapshot-replace"] as const;
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CGNAT_NETWORK = 0x64400000;
const CGNAT_NETWORK_END = 0x647fffff;
const FRAME_HEADER_BYTES = 4;
const MAX_CONTROL_FRAME_BYTES = 16 * 1024;
const MAX_HANDLES = 8;
const MAX_INTERFACE_RECORDS = 256;
const MAX_INTERFACE_ADDRESSES = 64;
const MAX_REQUEST_ID_CHARACTERS = 64;
const MAX_HANDLE_CHARACTERS = 128;
const MAX_CAPABILITIES = 16;
const MAX_REVISION = Number.MAX_SAFE_INTEGER - 1;
const MAX_JSON_STRING_DELIMITER_BYTES = 2;
// A JSON string character can use six bytes when encoded as a \uXXXX escape.
const MAX_JSON_STRING_ESCAPED_BYTES_PER_CHARACTER = 6;
const MAX_HANDLE_JSON_BYTES =
  MAX_JSON_STRING_DELIMITER_BYTES +
  MAX_HANDLE_CHARACTERS * MAX_JSON_STRING_ESCAPED_BYTES_PER_CHARACTER;
const MAX_REVISION_JSON_BYTES = Buffer.byteLength(String(MAX_REVISION), "utf8");
const SNAPSHOT_FRAME_PREFIX_BYTES = Buffer.byteLength(
  `{"kind":${JSON.stringify("snapshot")},"handle":`,
  "utf8",
);
const SNAPSHOT_FRAME_REVISION_PREFIX_BYTES = Buffer.byteLength(`,"revision":`, "utf8");
const SNAPSHOT_FRAME_SNAPSHOT_PREFIX_BYTES = Buffer.byteLength(`,"snapshot":`, "utf8");
const SNAPSHOT_FRAME_SUFFIX_BYTES = Buffer.byteLength("}", "utf8");
const MAX_SNAPSHOT_FRAME_WRAPPER_BYTES =
  SNAPSHOT_FRAME_PREFIX_BYTES +
  MAX_HANDLE_JSON_BYTES +
  SNAPSHOT_FRAME_REVISION_PREFIX_BYTES +
  MAX_REVISION_JSON_BYTES +
  SNAPSHOT_FRAME_SNAPSHOT_PREFIX_BYTES +
  SNAPSHOT_FRAME_SUFFIX_BYTES;
const MAX_FRAME_BODY_BYTES =
  SESSION_MIRROR_BOUNDS.maxEnvelopeBytes + MAX_SNAPSHOT_FRAME_WRAPPER_BYTES;
const DEVICE_FRAME_NORMALIZATION_OVERHEAD_DEPTH = 16;
const DEVICE_FRAME_NORMALIZATION_OVERHEAD_CONTAINERS = 2_048;
const DEVICE_FRAME_NORMALIZATION_OVERHEAD_BYTES = MAX_FRAME_BODY_BYTES;
const MAX_NORMALIZATION_DEPTH =
  SESSION_MIRROR_BOUNDS.maxNormalizationDepth + DEVICE_FRAME_NORMALIZATION_OVERHEAD_DEPTH;
const MAX_NORMALIZATION_CONTAINERS =
  SESSION_MIRROR_BOUNDS.maxNormalizationContainers + DEVICE_FRAME_NORMALIZATION_OVERHEAD_CONTAINERS;
const MAX_NORMALIZATION_BYTES =
  SESSION_MIRROR_BOUNDS.maxNormalizationBytes + DEVICE_FRAME_NORMALIZATION_OVERHEAD_BYTES;
const MAX_STATE_NORMALIZATION_CONTAINERS =
  MAX_HANDLES * SESSION_MIRROR_BOUNDS.maxNormalizationContainers +
  DEVICE_FRAME_NORMALIZATION_OVERHEAD_CONTAINERS;
const MAX_STATE_NORMALIZATION_BYTES =
  MAX_HANDLES * SESSION_MIRROR_BOUNDS.maxNormalizationBytes +
  DEVICE_FRAME_NORMALIZATION_OVERHEAD_BYTES;
const LISTING_STATUSES = ["idle", "active", "waiting", "error", "unknown"] as const;
const LISTING_FRESHNESS = ["fresh", "stale", "unknown"] as const;
const DROP_REASONS = [
  "producer-disconnect",
  "takeover",
  "accepted-event",
  "eviction",
  "listener-stop",
  "device-disconnect",
  "backgrounding",
] as const;
const CLOSE_REASONS = [
  "listener-stop",
  "device-disconnect",
  "backgrounding",
  "transport-failure",
] as const;
const WIRE_ERROR_CODES = [
  "incompatible-protocol",
  "incompatible-capability",
  "malformed-frame",
  "frame-too-large",
  "control-frame-too-large",
  "snapshot-invalid",
  "snapshot-bounds",
  "snapshot-incompatible",
  "snapshot-forbidden",
  "snapshot-incomplete",
  "unknown-handle",
  "listener-stopped",
  "connection-busy",
  "device-disconnected",
] as const;

export const DEVICE_MIRROR_PROTOCOL = Object.freeze({
  family: DEVICE_MIRROR_FAMILY,
  major: DEVICE_MIRROR_MAJOR,
  minor: DEVICE_MIRROR_MINOR,
});

export const DEVICE_MIRROR_CAPABILITIES = Object.freeze([...REQUIRED_CAPABILITIES]);

export const DEVICE_MIRROR_BOUNDS = Object.freeze({
  maxSessionMirrorEnvelopeBytes: SESSION_MIRROR_BOUNDS.maxEnvelopeBytes,
  maxSnapshotFrameWrapperBytes: MAX_SNAPSHOT_FRAME_WRAPPER_BYTES,
  maxFrameBodyBytes: MAX_FRAME_BODY_BYTES,
  maxControlFrameBytes: MAX_CONTROL_FRAME_BYTES,
  maxListingEntries: MAX_HANDLES,
  maxInterfaceRecords: MAX_INTERFACE_RECORDS,
  maxInterfaceAddresses: MAX_INTERFACE_ADDRESSES,
  maxHandleCharacters: MAX_HANDLE_CHARACTERS,
  maxRequestIdCharacters: MAX_REQUEST_ID_CHARACTERS,
  maxCapabilities: MAX_CAPABILITIES,
  maxRevision: MAX_REVISION,
  maxNormalizationDepth: MAX_NORMALIZATION_DEPTH,
  maxNormalizationContainers: MAX_NORMALIZATION_CONTAINERS,
  maxNormalizationBytes: MAX_NORMALIZATION_BYTES,
  maxStateNormalizationContainers: MAX_STATE_NORMALIZATION_CONTAINERS,
  maxStateNormalizationBytes: MAX_STATE_NORMALIZATION_BYTES,
});

export const DEVICE_MIRROR_LISTING_STATUSES = Object.freeze([...LISTING_STATUSES]);
export const DEVICE_MIRROR_LISTING_FRESHNESS = Object.freeze([...LISTING_FRESHNESS]);
export const DEVICE_MIRROR_DROP_REASONS = Object.freeze([...DROP_REASONS]);
export const DEVICE_MIRROR_CLOSE_REASONS = Object.freeze([...CLOSE_REASONS]);
export const DEVICE_MIRROR_WIRE_ERROR_CODES = Object.freeze([...WIRE_ERROR_CODES]);

export const DEVICE_MIRROR_TRANSPORT = Object.freeze({
  framework: "Network.framework",
  security: "TLS-PSK",
  customCryptography: false,
  plaintextFallback: false,
});

export const DEVICE_MIRROR_ERROR_CODES = Object.freeze([
  "invalid-input",
  "invalid-address",
  "interface-required",
  "malformed-frame",
  "invalid-utf8",
  "invalid-json",
  "frame-too-large",
  "control-frame-too-large",
  "incompatible-protocol",
  "incompatible-capability",
  "wrong-direction",
  "unsupported-message",
  "snapshot-invalid",
  "snapshot-bounds",
  "snapshot-incompatible",
  "snapshot-forbidden",
  "snapshot-incomplete",
  "unknown-handle",
  "stale-snapshot",
  "capacity-exhausted",
  "listener-stopped",
  "connection-busy",
  "device-disconnected",
  "state-invalid",
  "closed",
] as const);

export type DeviceMirrorErrorCode = (typeof DEVICE_MIRROR_ERROR_CODES)[number];
export type DeviceMirrorWireErrorCode = (typeof DEVICE_MIRROR_WIRE_ERROR_CODES)[number];
export type DeviceMirrorListingStatus = (typeof LISTING_STATUSES)[number];
export type DeviceMirrorListingFreshness = (typeof LISTING_FRESHNESS)[number];
export type DeviceMirrorDropReason = (typeof DROP_REASONS)[number];
export type DeviceMirrorCloseReason = (typeof CLOSE_REASONS)[number];
export type DeviceMirrorFrameDirection = "client-to-listener" | "listener-to-client";

export type DeviceMirrorJsonPrimitive = string | number | boolean | null;
export type DeviceMirrorJsonValue =
  | DeviceMirrorJsonPrimitive
  | DeviceMirrorJsonObject
  | readonly DeviceMirrorJsonValue[];

export interface DeviceMirrorJsonObject {
  readonly [key: string]: DeviceMirrorJsonValue;
}

export interface DeviceMirrorProtocolVersion extends DeviceMirrorJsonObject {
  readonly family: typeof DEVICE_MIRROR_FAMILY;
  readonly major: typeof DEVICE_MIRROR_MAJOR;
  readonly minor: typeof DEVICE_MIRROR_MINOR;
}

export interface DeviceMirrorHelloFrame extends DeviceMirrorJsonObject {
  readonly kind: "hello";
  readonly protocol: DeviceMirrorProtocolVersion;
  readonly capabilities: readonly string[];
}

export interface DeviceMirrorListRequestFrame extends DeviceMirrorJsonObject {
  readonly kind: "list";
  readonly requestId: string;
}

export interface DeviceMirrorSubscribeRequestFrame extends DeviceMirrorJsonObject {
  readonly kind: "subscribe";
  readonly requestId: string;
  readonly handle: string;
}

export interface DeviceMirrorReadyFrame extends DeviceMirrorJsonObject {
  readonly kind: "ready";
  readonly protocol: DeviceMirrorProtocolVersion;
  readonly capabilities: readonly string[];
}

export interface DeviceMirrorListing extends DeviceMirrorJsonObject {
  readonly handle: string;
  readonly status: DeviceMirrorListingStatus;
  readonly freshness: DeviceMirrorListingFreshness;
}

export interface DeviceMirrorListFrame extends DeviceMirrorJsonObject {
  readonly kind: "list";
  readonly requestId: string;
  readonly conversations: readonly DeviceMirrorListing[];
}

export interface DeviceMirrorSnapshotFrame extends DeviceMirrorJsonObject {
  readonly kind: "snapshot";
  readonly handle: string;
  readonly revision: number;
  readonly snapshot: SessionMirrorEnvelope;
}

export interface DeviceMirrorDroppedFrame extends DeviceMirrorJsonObject {
  readonly kind: "dropped";
  readonly handle: string;
  readonly reason: DeviceMirrorDropReason;
}

export interface DeviceMirrorCloseFrame extends DeviceMirrorJsonObject {
  readonly kind: "close";
  readonly reason: DeviceMirrorCloseReason;
}

export interface DeviceMirrorErrorFrame extends DeviceMirrorJsonObject {
  readonly kind: "error";
  readonly code: DeviceMirrorWireErrorCode;
}

export type DeviceMirrorClientFrame =
  | DeviceMirrorHelloFrame
  | DeviceMirrorListRequestFrame
  | DeviceMirrorSubscribeRequestFrame;

export type DeviceMirrorListenerFrame =
  | DeviceMirrorReadyFrame
  | DeviceMirrorListFrame
  | DeviceMirrorSnapshotFrame
  | DeviceMirrorDroppedFrame
  | DeviceMirrorCloseFrame
  | DeviceMirrorErrorFrame;

export type DeviceMirrorFrame = DeviceMirrorClientFrame | DeviceMirrorListenerFrame;

export interface DeviceMirrorFailure {
  readonly ok: false;
  readonly error: Readonly<{ readonly code: DeviceMirrorErrorCode }>;
}

export interface DeviceMirrorFrameSuccess<T extends DeviceMirrorFrame = DeviceMirrorFrame> {
  readonly ok: true;
  readonly frame: T;
}

export type DeviceMirrorFrameValidation = DeviceMirrorFrameSuccess | DeviceMirrorFailure;

export interface DeviceMirrorFrameBytesSuccess {
  readonly ok: true;
  readonly body: Uint8Array;
}

export type DeviceMirrorFrameBytesResult = DeviceMirrorFrameBytesSuccess | DeviceMirrorFailure;

export interface DeviceMirrorEncodedFrameSuccess {
  readonly ok: true;
  readonly frame: Uint8Array;
}

export type DeviceMirrorEncodedFrameResult = DeviceMirrorEncodedFrameSuccess | DeviceMirrorFailure;

export interface DeviceMirrorAddressSuccess {
  readonly ok: true;
  readonly address: string;
}

export type DeviceMirrorAddressResult = DeviceMirrorAddressSuccess | DeviceMirrorFailure;

export interface DeviceMirrorStateHandle {
  readonly handle: string;
  readonly status: DeviceMirrorListingStatus;
  readonly freshness: DeviceMirrorListingFreshness;
  readonly revision: number;
  readonly snapshot: SessionMirrorEnvelope;
}

export interface DeviceMirrorState {
  readonly status: "open" | "stopped";
  readonly deviceConnected: boolean;
  readonly subscribedHandle: string | null;
  readonly handles: readonly DeviceMirrorStateHandle[];
}

export type DeviceMirrorOutcomeCode =
  | "ready"
  | "accepted"
  | "coalesced"
  | "listed"
  | "subscribed"
  | "dropped"
  | "disconnected"
  | "backgrounded"
  | "closed";

export interface DeviceMirrorTransitionResult {
  readonly code: DeviceMirrorOutcomeCode;
}

export interface DeviceMirrorTransitionSuccess {
  readonly ok: true;
  readonly nextState: DeviceMirrorState;
  readonly result: DeviceMirrorTransitionResult;
  readonly frames: readonly DeviceMirrorListenerFrame[];
}

export type DeviceMirrorTransition = DeviceMirrorTransitionSuccess | DeviceMirrorFailure;

interface NormalizationState {
  containers: number;
  bytes: number;
  maxBytes: number;
  maxContainers: number;
}

type NormalizationResult =
  | { readonly ok: true; readonly value: DeviceMirrorJsonValue }
  | { readonly ok: false };

interface SnapshotCandidate {
  readonly handle: string;
  readonly status: DeviceMirrorListingStatus;
  readonly freshness: DeviceMirrorListingFreshness;
  readonly revision: number;
  readonly snapshot: SessionMirrorEnvelope;
}

interface DropCandidate {
  readonly handle: string;
  readonly reason: DeviceMirrorDropReason;
}

function failure(code: DeviceMirrorErrorCode): DeviceMirrorFailure {
  return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isJsonObject(value: DeviceMirrorJsonValue | undefined): value is DeviceMirrorJsonObject {
  return (
    value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
  );
}

function hasField(value: DeviceMirrorJsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function field(value: DeviceMirrorJsonObject, key: string): DeviceMirrorJsonValue | undefined {
  return hasField(value, key) ? value[key] : undefined;
}

function hasOnlyKeys(value: DeviceMirrorJsonObject, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return (
    Object.keys(value).every((key) => allowed.has(key)) && keys.every((key) => hasField(value, key))
  );
}

function accountBytes(state: NormalizationState, amount: number): boolean {
  if (!Number.isSafeInteger(amount) || amount < 0) return false;
  if (state.bytes > state.maxBytes - amount) return false;
  state.bytes += amount;
  return true;
}

function accountContainer(state: NormalizationState): boolean {
  if (state.containers >= state.maxContainers) return false;
  state.containers += 1;
  return true;
}

function primitiveBytes(value: DeviceMirrorJsonPrimitive): number | undefined {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? undefined : Buffer.byteLength(serialized, "utf8");
}

function normalizeJsonValue(
  input: unknown,
  state: NormalizationState,
  active: WeakSet<object>,
  depth: number,
): NormalizationResult {
  if (depth > MAX_NORMALIZATION_DEPTH) return { ok: false };
  if (input === null || typeof input === "string" || typeof input === "boolean") {
    const bytes = primitiveBytes(input);
    return bytes !== undefined && accountBytes(state, bytes)
      ? { ok: true, value: input }
      : { ok: false };
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return { ok: false };
    const bytes = primitiveBytes(input);
    return bytes !== undefined && accountBytes(state, bytes)
      ? { ok: true, value: input }
      : { ok: false };
  }
  if (!isObject(input) || active.has(input)) return { ok: false };
  if (!accountContainer(state)) return { ok: false };
  active.add(input);
  try {
    if (Array.isArray(input)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
      if (
        !lengthDescriptor ||
        !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value > state.maxContainers
      ) {
        return { ok: false };
      }
      const length = lengthDescriptor.value;
      const names = Object.getOwnPropertyNames(input);
      if (names.length > state.maxContainers || Object.getOwnPropertySymbols(input).length > 0) {
        return { ok: false };
      }
      for (const name of names) {
        if (name !== "length" && (!/^(?:0|[1-9][0-9]*)$/.test(name) || Number(name) >= length)) {
          return { ok: false };
        }
      }
      if (!accountBytes(state, 2 + Math.max(0, length - 1))) return { ok: false };
      const output: DeviceMirrorJsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          return { ok: false };
        }
        const child = normalizeJsonValue(descriptor.value, state, active, depth + 1);
        if (!child.ok) return child;
        output.push(child.value);
      }
      return { ok: true, value: output };
    }

    const prototype = Object.getPrototypeOf(input);
    if (prototype !== null && prototype !== Object.prototype) return { ok: false };
    if (Object.getOwnPropertySymbols(input).length > 0) return { ok: false };
    const names = Object.getOwnPropertyNames(input);
    if (names.length > state.maxContainers) return { ok: false };
    if (!accountBytes(state, 2 + Math.max(0, names.length - 1))) return { ok: false };
    const output: Record<string, DeviceMirrorJsonValue> = Object.create(null) as Record<
      string,
      DeviceMirrorJsonValue
    >;
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(input, name);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return { ok: false };
      if (!accountBytes(state, Buffer.byteLength(name, "utf8") + 1)) return { ok: false };
      const child = normalizeJsonValue(descriptor.value, state, active, depth + 1);
      if (!child.ok) return child;
      Object.defineProperty(output, name, {
        configurable: true,
        enumerable: true,
        value: child.value,
        writable: true,
      });
    }
    return { ok: true, value: output };
  } catch {
    return { ok: false };
  } finally {
    active.delete(input);
  }
}

function normalizeJson(
  input: unknown,
  maxBytes = MAX_NORMALIZATION_BYTES,
  maxContainers = MAX_NORMALIZATION_CONTAINERS,
): DeviceMirrorJsonValue | undefined {
  const result = normalizeJsonValue(
    input,
    { containers: 0, bytes: 0, maxBytes, maxContainers },
    new WeakSet<object>(),
    0,
  );
  return result.ok ? result.value : undefined;
}

function normalizeObject(
  input: unknown,
  maxBytes = MAX_NORMALIZATION_BYTES,
  maxContainers = MAX_NORMALIZATION_CONTAINERS,
): DeviceMirrorJsonObject | undefined {
  const value = normalizeJson(input, maxBytes, maxContainers);
  return isJsonObject(value) ? value : undefined;
}

function characterLength(value: string): number {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}

// DeviceMirror outer strings must be well-formed Unicode scalar sequences for
// parity with Swift String; nested frozen v1 values are validated separately.
function isWellFormedUnicode(value: string): boolean {
  return value.isWellFormed();
}

function normalizedString(
  value: DeviceMirrorJsonValue | undefined,
  maximum: number,
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !isWellFormedUnicode(value) ||
    characterLength(value) > maximum
  ) {
    return undefined;
  }
  if (Buffer.byteLength(value, "utf8") > maximum * 4) return undefined;
  return value;
}

function normalizedRevision(value: DeviceMirrorJsonValue | undefined): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_REVISION
  ) {
    return undefined;
  }
  return value === 0 ? 0 : value;
}

function isOneOf<T extends readonly string[]>(values: T, value: string): value is T[number] {
  return values.includes(value);
}

function validateProtocol(
  input: DeviceMirrorJsonValue | undefined,
): { readonly ok: true; readonly protocol: DeviceMirrorProtocolVersion } | DeviceMirrorFailure {
  const object = isJsonObject(input) ? input : undefined;
  if (!object || !hasOnlyKeys(object, ["family", "major", "minor"])) {
    return failure("malformed-frame");
  }
  const family = field(object, "family");
  const major = field(object, "major");
  const minor = field(object, "minor");
  if (
    typeof family !== "string" ||
    typeof major !== "number" ||
    typeof minor !== "number" ||
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    major < 0 ||
    minor < 0
  ) {
    return failure("malformed-frame");
  }
  if (
    family !== DEVICE_MIRROR_FAMILY ||
    major !== DEVICE_MIRROR_MAJOR ||
    minor > DEVICE_MIRROR_MINOR
  ) {
    return failure("incompatible-protocol");
  }
  return {
    ok: true,
    protocol: Object.freeze({
      family: DEVICE_MIRROR_FAMILY,
      major: DEVICE_MIRROR_MAJOR,
      minor: DEVICE_MIRROR_MINOR,
    }),
  };
}

function validateCapabilities(
  input: DeviceMirrorJsonValue | undefined,
): { readonly ok: true; readonly capabilities: readonly string[] } | DeviceMirrorFailure {
  if (!Array.isArray(input)) return failure("malformed-frame");
  if (input.length > MAX_CAPABILITIES) return failure("frame-too-large");
  const capabilities: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const value = normalizedString(item, 64);
    if (!value || !KEBAB_CASE.test(value)) return failure("malformed-frame");
    if (seen.has(value)) return failure("incompatible-capability");
    seen.add(value);
    capabilities.push(value);
  }
  if (!REQUIRED_CAPABILITIES.every((name, index) => capabilities[index] === name)) {
    return failure("incompatible-capability");
  }
  return { ok: true, capabilities: Object.freeze(capabilities) };
}

function validateHandle(value: DeviceMirrorJsonValue | undefined): string | undefined {
  return normalizedString(value, MAX_HANDLE_CHARACTERS);
}

function validateRequestId(value: DeviceMirrorJsonValue | undefined): string | undefined {
  return normalizedString(value, MAX_REQUEST_ID_CHARACTERS);
}

function validateStatus(
  value: DeviceMirrorJsonValue | undefined,
): DeviceMirrorListingStatus | undefined {
  return typeof value === "string" && isOneOf(LISTING_STATUSES, value) ? value : undefined;
}

function validateFreshness(
  value: DeviceMirrorJsonValue | undefined,
): DeviceMirrorListingFreshness | undefined {
  return typeof value === "string" && isOneOf(LISTING_FRESHNESS, value) ? value : undefined;
}

function validateDropReason(
  value: DeviceMirrorJsonValue | undefined,
): DeviceMirrorDropReason | undefined {
  return typeof value === "string" && isOneOf(DROP_REASONS, value) ? value : undefined;
}

function validateCloseReason(
  value: DeviceMirrorJsonValue | undefined,
): DeviceMirrorCloseReason | undefined {
  return typeof value === "string" && isOneOf(CLOSE_REASONS, value) ? value : undefined;
}

function validateSessionSnapshot(
  input: DeviceMirrorJsonValue | undefined,
): { readonly ok: true; readonly snapshot: SessionMirrorEnvelope } | DeviceMirrorFailure {
  if (!isJsonObject(input)) return failure("snapshot-invalid");
  const result = validateSessionMirrorEnvelope(input);
  if (!result.ok) {
    switch (result.error.category) {
      case "bounds-exceeded":
        return failure("snapshot-bounds");
      case "incompatible-protocol":
      case "incompatible-capability":
      case "incompatible-message-kind":
        return failure("snapshot-incompatible");
      case "forbidden-streaming":
        return failure("snapshot-forbidden");
      case "incomplete-turn":
        return failure("snapshot-incomplete");
      case "conflicting-duplicate":
      case "revision-gap":
      case "malformed-envelope":
        return failure("snapshot-invalid");
    }
  }
  if (
    result.envelope.message.kind !== "snapshot" ||
    result.envelope.message.operation !== "replace"
  ) {
    return failure("snapshot-invalid");
  }
  return { ok: true, snapshot: result.envelope };
}

function validateListing(
  input: DeviceMirrorJsonValue | undefined,
): { readonly ok: true; readonly listing: DeviceMirrorListing } | DeviceMirrorFailure {
  const object = isJsonObject(input) ? input : undefined;
  if (!object || !hasOnlyKeys(object, ["handle", "status", "freshness"])) {
    return failure("malformed-frame");
  }
  const handle = validateHandle(field(object, "handle"));
  const status = validateStatus(field(object, "status"));
  const freshness = validateFreshness(field(object, "freshness"));
  if (!handle || !status || !freshness) return failure("malformed-frame");
  return {
    ok: true,
    listing: Object.freeze({ handle, status, freshness }),
  };
}

function validateClientFrame(object: DeviceMirrorJsonObject): DeviceMirrorFrameValidation {
  const kind = field(object, "kind");
  if (typeof kind !== "string") return failure("malformed-frame");
  if (
    kind === "ready" ||
    kind === "snapshot" ||
    kind === "dropped" ||
    kind === "close" ||
    kind === "error"
  ) {
    return failure("wrong-direction");
  }
  if (kind === "hello") {
    if (!hasOnlyKeys(object, ["kind", "protocol", "capabilities"]))
      return failure("malformed-frame");
    const protocol = validateProtocol(field(object, "protocol"));
    if (!protocol.ok) return protocol;
    const capabilities = validateCapabilities(field(object, "capabilities"));
    if (!capabilities.ok) return capabilities;
    return {
      ok: true,
      frame: Object.freeze({
        kind: "hello",
        protocol: protocol.protocol,
        capabilities: capabilities.capabilities,
      }),
    };
  }
  if (kind === "list") {
    if (hasField(object, "conversations")) return failure("wrong-direction");
    if (!hasOnlyKeys(object, ["kind", "requestId"])) return failure("malformed-frame");
    const requestId = validateRequestId(field(object, "requestId"));
    return requestId
      ? { ok: true, frame: Object.freeze({ kind: "list", requestId }) }
      : failure("malformed-frame");
  }
  if (kind === "subscribe") {
    if (!hasOnlyKeys(object, ["kind", "requestId", "handle"])) return failure("malformed-frame");
    const requestId = validateRequestId(field(object, "requestId"));
    const handle = validateHandle(field(object, "handle"));
    return requestId && handle
      ? { ok: true, frame: Object.freeze({ kind: "subscribe", requestId, handle }) }
      : failure("malformed-frame");
  }
  return failure("unsupported-message");
}

function validateListenerFrame(object: DeviceMirrorJsonObject): DeviceMirrorFrameValidation {
  const kind = field(object, "kind");
  if (typeof kind !== "string") return failure("malformed-frame");
  if (kind === "hello" || kind === "subscribe") return failure("wrong-direction");
  if (kind === "ready") {
    if (!hasOnlyKeys(object, ["kind", "protocol", "capabilities"]))
      return failure("malformed-frame");
    const protocol = validateProtocol(field(object, "protocol"));
    if (!protocol.ok) return protocol;
    const capabilities = validateCapabilities(field(object, "capabilities"));
    if (!capabilities.ok) return capabilities;
    return {
      ok: true,
      frame: Object.freeze({
        kind: "ready",
        protocol: protocol.protocol,
        capabilities: capabilities.capabilities,
      }),
    };
  }
  if (kind === "list") {
    if (!hasField(object, "conversations") && hasField(object, "requestId")) {
      return failure("wrong-direction");
    }
    if (!hasOnlyKeys(object, ["kind", "requestId", "conversations"]))
      return failure("malformed-frame");
    const requestId = validateRequestId(field(object, "requestId"));
    const conversationsValue = field(object, "conversations");
    if (!requestId || !Array.isArray(conversationsValue)) return failure("malformed-frame");
    if (conversationsValue.length > MAX_HANDLES) return failure("frame-too-large");
    const conversations: DeviceMirrorListing[] = [];
    const handles = new Set<string>();
    for (const item of conversationsValue) {
      const listing = validateListing(item);
      if (!listing.ok) return listing;
      if (handles.has(listing.listing.handle)) return failure("malformed-frame");
      handles.add(listing.listing.handle);
      conversations.push(listing.listing);
    }
    return {
      ok: true,
      frame: Object.freeze({
        kind: "list",
        requestId,
        conversations: Object.freeze(conversations),
      }),
    };
  }
  if (kind === "snapshot") {
    if (!hasOnlyKeys(object, ["kind", "handle", "revision", "snapshot"]))
      return failure("malformed-frame");
    const handle = validateHandle(field(object, "handle"));
    const revision = normalizedRevision(field(object, "revision"));
    if (!handle || revision === undefined) return failure("malformed-frame");
    const snapshot = validateSessionSnapshot(field(object, "snapshot"));
    if (!snapshot.ok) return snapshot;
    return {
      ok: true,
      frame: Object.freeze({ kind: "snapshot", handle, revision, snapshot: snapshot.snapshot }),
    };
  }
  if (kind === "dropped") {
    if (!hasOnlyKeys(object, ["kind", "handle", "reason"])) return failure("malformed-frame");
    const handle = validateHandle(field(object, "handle"));
    const reason = validateDropReason(field(object, "reason"));
    return handle && reason
      ? { ok: true, frame: Object.freeze({ kind: "dropped", handle, reason }) }
      : failure("malformed-frame");
  }
  if (kind === "close") {
    if (!hasOnlyKeys(object, ["kind", "reason"])) return failure("malformed-frame");
    const reason = validateCloseReason(field(object, "reason"));
    return reason
      ? { ok: true, frame: Object.freeze({ kind: "close", reason }) }
      : failure("malformed-frame");
  }
  if (kind === "error") {
    if (!hasOnlyKeys(object, ["kind", "code"])) return failure("malformed-frame");
    const code = field(object, "code");
    if (typeof code !== "string" || !isOneOf(WIRE_ERROR_CODES, code))
      return failure("malformed-frame");
    return { ok: true, frame: Object.freeze({ kind: "error", code }) };
  }
  return failure("unsupported-message");
}

export function validateDeviceMirrorFrame(
  input: unknown,
  direction: DeviceMirrorFrameDirection,
): DeviceMirrorFrameValidation {
  try {
    const object = normalizeObject(input);
    if (!object) return failure("malformed-frame");
    const serialized = JSON.stringify(object);
    if (serialized === undefined) return failure("malformed-frame");
    const bodyBytes = Buffer.byteLength(serialized, "utf8");
    if (bodyBytes > MAX_FRAME_BODY_BYTES) return failure("frame-too-large");
    if (bodyBytes > MAX_CONTROL_FRAME_BYTES && field(object, "kind") !== "snapshot") {
      return failure("control-frame-too-large");
    }
    return direction === "client-to-listener"
      ? validateClientFrame(object)
      : validateListenerFrame(object);
  } catch {
    return failure("malformed-frame");
  }
}

function frameBodyLimit(kind: string): number {
  return kind === "snapshot" ? MAX_FRAME_BODY_BYTES : MAX_CONTROL_FRAME_BYTES;
}

function decodeUtf8(input: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    return undefined;
  }
}

function copyBytes(input: unknown): Uint8Array | undefined {
  try {
    if (!(input instanceof Uint8Array)) return undefined;
    return Uint8Array.prototype.slice.call(input) as Uint8Array;
  } catch {
    return undefined;
  }
}

export function decodeDeviceMirrorLengthPrefixedFrame(
  input: unknown,
): DeviceMirrorFrameBytesResult {
  try {
    const bytes = copyBytes(input);
    if (!bytes || bytes.byteLength < FRAME_HEADER_BYTES) return failure("malformed-frame");
    const declaredLength = bytes[0] * 0x1000000 + bytes[1] * 0x10000 + bytes[2] * 0x100 + bytes[3];
    if (declaredLength > MAX_FRAME_BODY_BYTES) return failure("frame-too-large");
    if (bytes.byteLength !== declaredLength + FRAME_HEADER_BYTES) return failure("malformed-frame");
    return { ok: true, body: bytes.slice(FRAME_HEADER_BYTES) };
  } catch {
    return failure("malformed-frame");
  }
}

export const decodeLengthPrefixedFrame = decodeDeviceMirrorLengthPrefixedFrame;

export function encodeDeviceMirrorLengthPrefixedFrame(
  input: unknown,
): DeviceMirrorEncodedFrameResult {
  try {
    const body = copyBytes(input);
    if (!body) return failure("invalid-input");
    if (body.byteLength > MAX_FRAME_BODY_BYTES) return failure("frame-too-large");
    const frame = new Uint8Array(body.byteLength + FRAME_HEADER_BYTES);
    frame[0] = (body.byteLength >>> 24) & 0xff;
    frame[1] = (body.byteLength >>> 16) & 0xff;
    frame[2] = (body.byteLength >>> 8) & 0xff;
    frame[3] = body.byteLength & 0xff;
    frame.set(body, FRAME_HEADER_BYTES);
    return { ok: true, frame };
  } catch {
    return failure("invalid-input");
  }
}

export const encodeLengthPrefixedFrame = encodeDeviceMirrorLengthPrefixedFrame;

function serializedBytes(value: DeviceMirrorJsonValue): Uint8Array | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : new TextEncoder().encode(serialized);
  } catch {
    return undefined;
  }
}

export function encodeDeviceMirrorFrame(
  input: unknown,
  direction: DeviceMirrorFrameDirection,
): DeviceMirrorEncodedFrameResult {
  try {
    const validated = validateDeviceMirrorFrame(input, direction);
    if (!validated.ok) return validated;
    const bytes = serializedBytes(validated.frame);
    if (!bytes) return failure("malformed-frame");
    const limit = frameBodyLimit(validated.frame.kind);
    if (bytes.byteLength > limit) {
      return failure(
        limit === MAX_CONTROL_FRAME_BYTES ? "control-frame-too-large" : "frame-too-large",
      );
    }
    return encodeDeviceMirrorLengthPrefixedFrame(bytes);
  } catch {
    return failure("malformed-frame");
  }
}

export function parseDeviceMirrorJson(
  input: unknown,
  direction: DeviceMirrorFrameDirection,
): DeviceMirrorFrameValidation {
  if (typeof input !== "string") return failure("invalid-input");
  if (Buffer.byteLength(input, "utf8") > MAX_FRAME_BODY_BYTES) return failure("frame-too-large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return failure("invalid-json");
  }
  if (Buffer.byteLength(input, "utf8") > MAX_CONTROL_FRAME_BYTES) {
    const object = normalizeObject(parsed);
    if (!object || field(object, "kind") !== "snapshot") {
      return failure("control-frame-too-large");
    }
  }
  return validateDeviceMirrorFrame(parsed, direction);
}

export function parseDeviceMirrorFrame(
  input: unknown,
  direction: DeviceMirrorFrameDirection,
): DeviceMirrorFrameValidation {
  try {
    const decoded = decodeDeviceMirrorLengthPrefixedFrame(input);
    if (!decoded.ok) return decoded;
    const raw = decodeUtf8(decoded.body);
    if (raw === undefined) return failure("invalid-utf8");
    return parseDeviceMirrorJson(raw, direction);
  } catch {
    return failure("malformed-frame");
  }
}

function ipv4Number(input: unknown): number | undefined {
  if (typeof input !== "string" || input.length < 7 || input.length > 15) return undefined;
  const pieces = input.split(".");
  if (pieces.length !== 4) return undefined;
  const values: number[] = [];
  for (const piece of pieces) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(piece)) return undefined;
    const value = Number(piece);
    if (!Number.isSafeInteger(value) || value > 255) return undefined;
    values.push(value);
  }
  return values[0] * 0x1000000 + values[1] * 0x10000 + values[2] * 0x100 + values[3];
}

function isCgnatAddress(input: unknown): input is string {
  const value = ipv4Number(input);
  return value !== undefined && value >= CGNAT_NETWORK && value <= CGNAT_NETWORK_END;
}

export function validateDeviceMirrorAddress(input: unknown): DeviceMirrorAddressResult {
  try {
    return isCgnatAddress(input) ? { ok: true, address: input } : failure("invalid-address");
  } catch {
    return failure("invalid-address");
  }
}

export const validateDeviceMirrorClientAddress = validateDeviceMirrorAddress;

function preflightDeviceMirrorInterfaceRecord(input: unknown): boolean {
  if (!isObject(input) || Array.isArray(input)) return true;
  const addressesDescriptor = Object.getOwnPropertyDescriptor(input, "addresses");
  if (!addressesDescriptor) return true;
  if (!("value" in addressesDescriptor)) return false;
  const addresses = addressesDescriptor.value;
  if (!isObject(addresses) || !Array.isArray(addresses)) return true;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(addresses, "length");
  return (
    !!lengthDescriptor &&
    "value" in lengthDescriptor &&
    Number.isSafeInteger(lengthDescriptor.value) &&
    lengthDescriptor.value >= 0 &&
    lengthDescriptor.value <= MAX_INTERFACE_ADDRESSES
  );
}

function preflightDeviceMirrorInterfaceTable(input: unknown): boolean {
  try {
    if (!isObject(input) || !Array.isArray(input)) return false;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
    if (
      !lengthDescriptor ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > MAX_INTERFACE_RECORDS
    ) {
      return false;
    }
    const length = lengthDescriptor.value;
    const names = Object.getOwnPropertyNames(input);
    if (
      names.length > MAX_INTERFACE_RECORDS + 1 ||
      Object.getOwnPropertySymbols(input).length > 0
    ) {
      return false;
    }
    for (const name of names) {
      if (name !== "length" && (!/^(?:0|[1-9][0-9]*)$/.test(name) || Number(name) >= length)) {
        return false;
      }
    }
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
      if (!preflightDeviceMirrorInterfaceRecord(descriptor.value)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function activeUtunContainsAddress(input: unknown, address: string): boolean {
  if (!preflightDeviceMirrorInterfaceTable(input)) return false;
  const normalized = normalizeJson(input);
  if (!Array.isArray(normalized) || normalized.length > MAX_INTERFACE_RECORDS) return false;

  for (const item of normalized) {
    const object = isJsonObject(item) ? item : undefined;
    if (!object) continue;
    const addresses = field(object, "addresses");
    if (Array.isArray(addresses) && addresses.length > MAX_INTERFACE_ADDRESSES) return false;
  }

  for (const item of normalized) {
    const object = isJsonObject(item) ? item : undefined;
    if (!object || !hasOnlyKeys(object, ["kind", "active", "addresses"])) continue;
    if (field(object, "kind") !== "utun" || field(object, "active") !== true) continue;
    const addresses = field(object, "addresses");
    if (!Array.isArray(addresses)) continue;
    if (addresses.some((candidate) => candidate === address && isCgnatAddress(candidate)))
      return true;
  }
  return false;
}

export function validateDeviceMirrorListenerAddress(
  addressInput: unknown,
  interfacesInput: unknown,
): DeviceMirrorAddressResult {
  const address = validateDeviceMirrorAddress(addressInput);
  if (!address.ok) return address;
  return activeUtunContainsAddress(interfacesInput, address.address)
    ? address
    : failure("interface-required");
}

export const validateDeviceMirrorListenerBind = validateDeviceMirrorListenerAddress;
export const validateDeviceMirrorExactBind = validateDeviceMirrorListenerAddress;

function validateSnapshotCandidate(input: unknown): SnapshotCandidate | DeviceMirrorFailure {
  const object = normalizeObject(input);
  if (!object || !hasOnlyKeys(object, ["handle", "status", "freshness", "revision", "snapshot"])) {
    return failure("invalid-input");
  }
  const handle = validateHandle(field(object, "handle"));
  const status = validateStatus(field(object, "status"));
  const freshness = validateFreshness(field(object, "freshness"));
  const revision = normalizedRevision(field(object, "revision"));
  if (!handle || !status || !freshness || revision === undefined) return failure("invalid-input");
  const snapshot = validateSessionSnapshot(field(object, "snapshot"));
  if (!snapshot.ok) return snapshot;
  return { handle, status, freshness, revision, snapshot: snapshot.snapshot };
}

function validateDropCandidate(input: unknown): DropCandidate | DeviceMirrorFailure {
  const object = normalizeObject(input);
  if (!object || !hasOnlyKeys(object, ["handle", "reason"])) return failure("invalid-input");
  const handle = validateHandle(field(object, "handle"));
  const reason = validateDropReason(field(object, "reason"));
  return handle && reason ? { handle, reason } : failure("invalid-input");
}

function freezeStateHandle(value: SnapshotCandidate): DeviceMirrorStateHandle {
  return Object.freeze({
    handle: value.handle,
    status: value.status,
    freshness: value.freshness,
    revision: value.revision,
    snapshot: value.snapshot,
  });
}

function freezeState(
  status: "open" | "stopped",
  deviceConnected: boolean,
  subscribedHandle: string | null,
  handles: readonly DeviceMirrorStateHandle[],
): DeviceMirrorState {
  return Object.freeze({
    status,
    deviceConnected,
    subscribedHandle,
    handles: Object.freeze(handles.slice()),
  });
}

export function createDeviceMirrorState(): DeviceMirrorState {
  return freezeState("open", false, null, []);
}

function normalizeStateHandle(
  input: DeviceMirrorJsonValue | undefined,
): { readonly ok: true; readonly handle: DeviceMirrorStateHandle } | { readonly ok: false } {
  const object = isJsonObject(input) ? input : undefined;
  if (!object || !hasOnlyKeys(object, ["handle", "status", "freshness", "revision", "snapshot"])) {
    return { ok: false };
  }
  const handle = validateHandle(field(object, "handle"));
  const status = validateStatus(field(object, "status"));
  const freshness = validateFreshness(field(object, "freshness"));
  const revision = normalizedRevision(field(object, "revision"));
  if (!handle || !status || !freshness || revision === undefined) return { ok: false };
  const snapshot = validateSessionSnapshot(field(object, "snapshot"));
  return snapshot.ok
    ? {
        ok: true,
        handle: freezeStateHandle({
          handle,
          status,
          freshness,
          revision,
          snapshot: snapshot.snapshot,
        }),
      }
    : { ok: false };
}

function normalizeState(input: unknown): DeviceMirrorState | undefined {
  const object = normalizeObject(
    input,
    MAX_STATE_NORMALIZATION_BYTES,
    MAX_STATE_NORMALIZATION_CONTAINERS,
  );
  if (
    !object ||
    !hasOnlyKeys(object, ["status", "deviceConnected", "subscribedHandle", "handles"])
  ) {
    return undefined;
  }
  const status = field(object, "status");
  const deviceConnected = field(object, "deviceConnected");
  const subscribedValue = field(object, "subscribedHandle");
  const handlesValue = field(object, "handles");
  if (
    (status !== "open" && status !== "stopped") ||
    typeof deviceConnected !== "boolean" ||
    !(subscribedValue === null || typeof subscribedValue === "string") ||
    !Array.isArray(handlesValue) ||
    handlesValue.length > MAX_HANDLES
  ) {
    return undefined;
  }
  const handles: DeviceMirrorStateHandle[] = [];
  const seen = new Set<string>();
  for (const item of handlesValue) {
    const decoded = normalizeStateHandle(item);
    if (!decoded.ok || seen.has(decoded.handle.handle)) return undefined;
    seen.add(decoded.handle.handle);
    handles.push(decoded.handle);
  }
  if (subscribedValue !== null && !seen.has(subscribedValue)) return undefined;
  if (!deviceConnected && subscribedValue !== null) return undefined;
  if (
    status === "stopped" &&
    (deviceConnected || subscribedValue !== null || handles.length !== 0)
  ) {
    return undefined;
  }
  return freezeState(status, deviceConnected, subscribedValue, handles);
}

function normalizedStateOrFailure(input: unknown): DeviceMirrorState | DeviceMirrorFailure {
  const state = normalizeState(input);
  return state ?? failure("state-invalid");
}

function transition(
  state: DeviceMirrorState,
  resultCode: DeviceMirrorOutcomeCode,
  frames: readonly DeviceMirrorListenerFrame[] = [],
): DeviceMirrorTransitionSuccess {
  return Object.freeze({
    ok: true,
    nextState: state,
    result: Object.freeze({ code: resultCode }),
    frames: Object.freeze(frames.slice()),
  });
}

function listingForState(state: DeviceMirrorState): readonly DeviceMirrorListing[] {
  return Object.freeze(
    state.handles.map((item) =>
      Object.freeze({ handle: item.handle, status: item.status, freshness: item.freshness }),
    ),
  );
}

function snapshotFrameForState(item: DeviceMirrorStateHandle): DeviceMirrorSnapshotFrame {
  return Object.freeze({
    kind: "snapshot",
    handle: item.handle,
    revision: item.revision,
    snapshot: item.snapshot,
  });
}

function connectedStateOrFailure(
  state: DeviceMirrorState,
): DeviceMirrorState | DeviceMirrorFailure {
  if (state.status === "stopped") return failure("listener-stopped");
  if (!state.deviceConnected) return failure("device-disconnected");
  return state;
}

export function acceptDeviceMirrorHello(
  stateInput: unknown,
  helloInput: unknown,
): DeviceMirrorTransition {
  const state = normalizedStateOrFailure(stateInput);
  if ("ok" in state) return state;
  if (state.status === "stopped") return failure("listener-stopped");
  const hello = validateDeviceMirrorFrame(helloInput, "client-to-listener");
  if (!hello.ok) return hello;
  if (hello.frame.kind !== "hello") return failure("malformed-frame");
  if (state.deviceConnected) return failure("connection-busy");
  const nextState = freezeState("open", true, null, state.handles);
  const ready: DeviceMirrorReadyFrame = Object.freeze({
    kind: "ready",
    protocol: DEVICE_MIRROR_PROTOCOL,
    capabilities: DEVICE_MIRROR_CAPABILITIES,
  });
  return transition(nextState, "ready", [ready]);
}

export function requestDeviceMirrorList(
  stateInput: unknown,
  requestInput: unknown,
): DeviceMirrorTransition {
  const state = normalizedStateOrFailure(stateInput);
  if ("ok" in state) return state;
  const connected = connectedStateOrFailure(state);
  if ("ok" in connected) return connected;
  const request = validateDeviceMirrorFrame(requestInput, "client-to-listener");
  if (!request.ok) return request;
  if (request.frame.kind !== "list") return failure("malformed-frame");
  const frame: DeviceMirrorListFrame = Object.freeze({
    kind: "list",
    requestId: request.frame.requestId,
    conversations: listingForState(state),
  });
  return transition(state, "listed", [frame]);
}

export function subscribeDeviceMirrorHandle(
  stateInput: unknown,
  requestInput: unknown,
): DeviceMirrorTransition {
  const state = normalizedStateOrFailure(stateInput);
  if ("ok" in state) return state;
  const connected = connectedStateOrFailure(state);
  if ("ok" in connected) return connected;
  const request = validateDeviceMirrorFrame(requestInput, "client-to-listener");
  if (!request.ok) return request;
  if (request.frame.kind !== "subscribe") return failure("malformed-frame");
  const item = state.handles.find((candidate) => candidate.handle === request.frame.handle);
  if (!item) return failure("unknown-handle");
  const nextState = freezeState("open", true, item.handle, state.handles);
  return transition(nextState, "subscribed", [snapshotFrameForState(item)]);
}

export function replaceDeviceMirrorSnapshot(
  stateInput: unknown,
  snapshotInput: unknown,
): DeviceMirrorTransition {
  const state = normalizedStateOrFailure(stateInput);
  if ("ok" in state) return state;
  if (state.status === "stopped") return failure("listener-stopped");
  const candidate = validateSnapshotCandidate(snapshotInput);
  if ("ok" in candidate) return candidate;
  const index = state.handles.findIndex((item) => item.handle === candidate.handle);
  const previous = index < 0 ? undefined : state.handles[index];
  if (previous && candidate.revision <= previous.revision) return failure("stale-snapshot");
  if (!previous && state.handles.length >= MAX_HANDLES) return failure("capacity-exhausted");
  const nextItem = freezeStateHandle(candidate);
  const handles = previous
    ? state.handles.map((item) => (item.handle === candidate.handle ? nextItem : item))
    : [...state.handles, nextItem];
  const nextState = freezeState("open", state.deviceConnected, state.subscribedHandle, handles);
  const frames =
    state.deviceConnected && state.subscribedHandle === candidate.handle
      ? [snapshotFrameForState(nextItem)]
      : [];
  return transition(nextState, previous ? "coalesced" : "accepted", frames);
}

function dropWithReason(stateInput: unknown, dropInput: unknown): DeviceMirrorTransition {
  const state = normalizedStateOrFailure(stateInput);
  if ("ok" in state) return state;
  if (state.status === "stopped") return failure("listener-stopped");
  const candidate = validateDropCandidate(dropInput);
  if ("ok" in candidate) return candidate;
  const item = state.handles.find((handle) => handle.handle === candidate.handle);
  if (!item) return transition(state, "dropped");
  const nextState = freezeState(
    "open",
    state.deviceConnected,
    state.subscribedHandle === candidate.handle ? null : state.subscribedHandle,
    state.handles.filter((handle) => handle.handle !== candidate.handle),
  );
  const frames =
    state.deviceConnected && state.subscribedHandle === candidate.handle
      ? [Object.freeze({ kind: "dropped", handle: candidate.handle, reason: candidate.reason })]
      : [];
  return transition(nextState, "dropped", frames);
}

export function dropDeviceMirrorSnapshot(
  stateInput: unknown,
  dropInput: unknown,
): DeviceMirrorTransition {
  return dropWithReason(stateInput, dropInput);
}

export const dropDeviceMirrorHandle = dropDeviceMirrorSnapshot;

function dropByFixedReason(
  stateInput: unknown,
  handleInput: unknown,
  reason: DeviceMirrorDropReason,
): DeviceMirrorTransition {
  return dropWithReason(stateInput, { handle: handleInput, reason });
}

export const disconnectDeviceMirrorProducer = (
  stateInput: unknown,
  handleInput: unknown,
): DeviceMirrorTransition => dropByFixedReason(stateInput, handleInput, "producer-disconnect");

export const takeoverDeviceMirrorProducer = (
  stateInput: unknown,
  handleInput: unknown,
): DeviceMirrorTransition => dropByFixedReason(stateInput, handleInput, "takeover");

export const markDeviceMirrorAcceptedEvent = (
  stateInput: unknown,
  handleInput: unknown,
): DeviceMirrorTransition => dropByFixedReason(stateInput, handleInput, "accepted-event");

export const evictDeviceMirrorSnapshot = (
  stateInput: unknown,
  handleInput: unknown,
): DeviceMirrorTransition => dropByFixedReason(stateInput, handleInput, "eviction");

export function disconnectDeviceMirrorClient(stateInput: unknown): DeviceMirrorTransition {
  const state = normalizedStateOrFailure(stateInput);
  if ("ok" in state) return state;
  if (state.status === "stopped") return transition(state, "closed");
  const nextState = freezeState("open", false, null, []);
  return transition(nextState, "disconnected");
}

export function backgroundDeviceMirrorClient(stateInput: unknown): DeviceMirrorTransition {
  const state = normalizedStateOrFailure(stateInput);
  if ("ok" in state) return state;
  if (state.status === "stopped") return transition(state, "closed");
  const nextState = freezeState("open", false, null, []);
  return transition(nextState, "backgrounded");
}

export function stopDeviceMirrorListener(stateInput: unknown): DeviceMirrorTransition {
  const state = normalizedStateOrFailure(stateInput);
  if ("ok" in state) return state;
  if (state.status === "stopped") return transition(state, "closed");
  const nextState = freezeState("stopped", false, null, []);
  const frames = state.deviceConnected
    ? [Object.freeze({ kind: "close", reason: "listener-stop" as const })]
    : [];
  return transition(nextState, "closed", frames);
}

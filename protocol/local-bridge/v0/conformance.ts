import { createHash } from "node:crypto";
import {
  applySessionMirrorEnvelope,
  createSessionMirrorState,
  parseSessionMirrorJson,
  SESSION_MIRROR_BOUNDS,
  type SessionMirrorEnvelope,
  type SessionMirrorFailureCategory,
  type SessionMirrorState,
} from "../../session-mirror/v1/conformance.ts";

const LOCAL_BRIDGE_FAMILY = "local-bridge";
const LOCAL_BRIDGE_MAJOR = 0;
const LOCAL_BRIDGE_MINOR = 0;
const HANDSHAKE_KIND = "hello";
const RESULT_KIND = "result";
const REQUIRED_CAPABILITIES = ["snapshot-replace", "cursor-recovery"] as const;
const TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const SOURCE_INSTANCE_PATTERN = /^[a-f0-9]{32}$/;
const SOCKET_NAME_PATTERN = /^mirror-[a-f0-9]{24}\.sock$/;
const SNAPSHOT_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_ACTIVE_CONVERSATIONS = 8;
const MAX_KNOWN_CONVERSATIONS = 64;
const MAX_SUPERSEDED_SOURCE_IDS = 64;
const MAX_ACTIVITY_GENERATION = Number.MAX_SAFE_INTEGER - 1;
const IDLE_EVICTION_MINUTES = 60;
const NORMALIZATION_PER_CONVERSATION_METADATA_SLACK_BYTES = 512 * 1024;
const NORMALIZATION_STATE_METADATA_SLACK_BYTES = 4 * 1024 * 1024;
const NORMALIZATION_MINIMUM_BYTES =
  MAX_ACTIVE_CONVERSATIONS *
    (SESSION_MIRROR_BOUNDS.maxSeenMessages * SESSION_MIRROR_BOUNDS.maxEnvelopeBytes +
      SESSION_MIRROR_BOUNDS.maxEnvelopeBytes +
      NORMALIZATION_PER_CONVERSATION_METADATA_SLACK_BYTES) +
  NORMALIZATION_STATE_METADATA_SLACK_BYTES;
const NORMALIZATION_BUDGET_BYTES = NORMALIZATION_MINIMUM_BYTES + 8 * 1024 * 1024;
const DIRECT_NORMALIZATION_MAX_DEPTH = 16;
const DIRECT_NORMALIZATION_MAX_CONTAINERS = 128;
const DIRECT_NORMALIZATION_MAX_COLLECTION = 64;
const DIRECT_NORMALIZATION_MAX_BYTES = 4 * 1024;
const NORMALIZATION_MAX_COLLECTION = 2_048;
const CONTROL_RESULT_CODE_VALUES = [
  "ready",
  "disconnected",
  "accepted",
  "duplicate",
  "deduplicated",
  "evicted",
  "closed",
] as const;
const CONTROL_RESULT_CODES = new Set<string>(CONTROL_RESULT_CODE_VALUES);
const LOCAL_BRIDGE_ERROR_CODE_VALUES = [
  "invalid-input",
  "malformed-rendezvous",
  "unsafe-rendezvous",
  "frame-too-large",
  "control-frame-too-large",
  "malformed-frame",
  "invalid-utf8",
  "invalid-json",
  "incompatible-protocol",
  "incompatible-capability",
  "installation-mismatch",
  "token-mismatch",
  "session-mismatch",
  "busy",
  "stale-source",
  "stale-activity",
  "not-owner",
  "handshake-required",
  "wrong-direction",
  "session-mirror-invalid",
  "session-mirror-bounds",
  "session-mirror-incompatible",
  "session-mirror-forbidden",
  "session-mirror-incomplete",
  "session-mirror-duplicate-conflict",
  "session-mirror-revision-gap",
  "revision-exhausted",
  "source-history-full",
  "closed",
] as const;

export const LOCAL_BRIDGE_PROTOCOL = Object.freeze({
  family: LOCAL_BRIDGE_FAMILY,
  major: LOCAL_BRIDGE_MAJOR,
  minor: LOCAL_BRIDGE_MINOR,
});

export const LOCAL_BRIDGE_NORMALIZATION_FORMULA = Object.freeze({
  maxActiveConversations: MAX_ACTIVE_CONVERSATIONS,
  maxKnownConversations: MAX_KNOWN_CONVERSATIONS,
  maxSeenMessagesPerConversation: SESSION_MIRROR_BOUNDS.maxSeenMessages,
  maxEnvelopeBytes: SESSION_MIRROR_BOUNDS.maxEnvelopeBytes,
  perConversationMetadataSlackBytes: NORMALIZATION_PER_CONVERSATION_METADATA_SLACK_BYTES,
  stateMetadataSlackBytes: NORMALIZATION_STATE_METADATA_SLACK_BYTES,
  minimumBytes: NORMALIZATION_MINIMUM_BYTES,
  budgetBytes: NORMALIZATION_BUDGET_BYTES,
});

export const LOCAL_BRIDGE_BOUNDS = Object.freeze({
  maxFrameBodyBytes: 256 * 1024,
  maxControlFrameBytes: 4 * 1024,
  maxRendezvousBytes: 4 * 1024,
  maxIdentityCharacters: 128,
  maxTokenCharacters: 32,
  maxSocketPathBytes: 103,
  maxSocketNameCharacters: 64,
  maxCapabilities: 16,
  maxActiveConversations: MAX_ACTIVE_CONVERSATIONS,
  maxKnownConversations: MAX_KNOWN_CONVERSATIONS,
  maxSupersededSourceIds: MAX_SUPERSEDED_SOURCE_IDS,
  maxActivityGeneration: MAX_ACTIVITY_GENERATION,
  idleEvictionMinutes: IDLE_EVICTION_MINUTES,
  maxSourceEpoch: Number.MAX_SAFE_INTEGER - 1,
  maxBridgeRevision: Number.MAX_SAFE_INTEGER - 1,
  maxDirectNormalizationDepth: DIRECT_NORMALIZATION_MAX_DEPTH,
  maxDirectNormalizationContainers: DIRECT_NORMALIZATION_MAX_CONTAINERS,
  maxDirectNormalizationCollection: DIRECT_NORMALIZATION_MAX_COLLECTION,
  maxDirectNormalizationBytes: DIRECT_NORMALIZATION_MAX_BYTES,
  maxNormalizationDepth: 128,
  maxNormalizationContainers: 2_048,
  maxNormalizationCollection: NORMALIZATION_MAX_COLLECTION,
  maxNormalizationBytes: NORMALIZATION_BUDGET_BYTES,
});

export const LOCAL_BRIDGE_CAPABILITIES = Object.freeze([...REQUIRED_CAPABILITIES]);

export const LOCAL_BRIDGE_ERROR_CODES = Object.freeze(LOCAL_BRIDGE_ERROR_CODE_VALUES);
export const LOCAL_BRIDGE_RUNTIME_ONLY_ERROR_CODES = Object.freeze([
  "handshake-required",
  "wrong-direction",
] as const);
export const LOCAL_BRIDGE_RESULT_CODES = Object.freeze(CONTROL_RESULT_CODE_VALUES);

export type LocalBridgeErrorCode = (typeof LOCAL_BRIDGE_ERROR_CODES)[number];
export type LocalBridgeResultCode = (typeof LOCAL_BRIDGE_RESULT_CODES)[number];
export type LocalBridgeWireCode = LocalBridgeErrorCode | LocalBridgeResultCode;

export type LocalBridgeJsonPrimitive = string | number | boolean | null;
export type LocalBridgeJsonValue =
  | LocalBridgeJsonPrimitive
  | LocalBridgeJsonObject
  | readonly LocalBridgeJsonValue[];

export interface LocalBridgeJsonObject {
  readonly [key: string]: LocalBridgeJsonValue;
}

export interface LocalBridgeProtocolVersion extends LocalBridgeJsonObject {
  readonly family: typeof LOCAL_BRIDGE_FAMILY;
  readonly major: typeof LOCAL_BRIDGE_MAJOR;
  readonly minor: number;
}

export interface LocalBridgeRendezvous extends LocalBridgeJsonObject {
  readonly protocol: LocalBridgeProtocolVersion;
  readonly installationId: string;
  readonly socketName: string;
  readonly launchToken: string;
}

export interface LocalBridgeHandshake extends LocalBridgeJsonObject {
  readonly kind: typeof HANDSHAKE_KIND;
  readonly protocol: LocalBridgeProtocolVersion;
  readonly installationId: string;
  readonly sessionId: string;
  readonly sourceInstanceId: string;
  readonly launchToken: string;
  readonly capabilities: readonly string[];
}

export interface LocalBridgeWireResult {
  readonly kind: typeof RESULT_KIND;
  readonly code: LocalBridgeWireCode;
  readonly bridgeRevision?: number;
  readonly sourceEpoch?: number;
  readonly snapshotRequired?: boolean;
}

export interface LocalBridgeFailure {
  readonly ok: false;
  readonly error: Readonly<{ readonly code: LocalBridgeErrorCode }>;
}

export interface LocalBridgeFrameSuccess {
  readonly ok: true;
  readonly body: Uint8Array;
}

export type LocalBridgeFrameResult = LocalBridgeFrameSuccess | LocalBridgeFailure;

export interface LocalBridgeEncodedFrameSuccess {
  readonly ok: true;
  readonly frame: Uint8Array;
}

export type LocalBridgeEncodedFrameResult = LocalBridgeEncodedFrameSuccess | LocalBridgeFailure;

export interface LocalBridgeRendezvousSuccess {
  readonly ok: true;
  readonly rendezvous: LocalBridgeRendezvous;
}

export type LocalBridgeRendezvousResult = LocalBridgeRendezvousSuccess | LocalBridgeFailure;

export interface LocalBridgeHandshakeSuccess {
  readonly ok: true;
  readonly handshake: LocalBridgeHandshake;
}

export type LocalBridgeHandshakeResult = LocalBridgeHandshakeSuccess | LocalBridgeFailure;

export interface LocalBridgeResultFrameSuccess {
  readonly ok: true;
  readonly result: LocalBridgeWireResult;
}

export type LocalBridgeResultFrameValidation = LocalBridgeResultFrameSuccess | LocalBridgeFailure;

export interface LocalBridgeDataSuccess {
  readonly ok: true;
  readonly envelope: SessionMirrorEnvelope;
  readonly rawJson: string;
  readonly rawBytes: Uint8Array;
}

export type LocalBridgeDataResult = LocalBridgeDataSuccess | LocalBridgeFailure;

export interface LocalBridgeDirectoryPathSuccess {
  readonly ok: true;
  readonly directory: string;
}

export type LocalBridgeDirectoryPathResult = LocalBridgeDirectoryPathSuccess | LocalBridgeFailure;

export interface LocalBridgeSocketPathSuccess {
  readonly ok: true;
  readonly socketPath: string;
}

export type LocalBridgeSocketPathResult = LocalBridgeSocketPathSuccess | LocalBridgeFailure;

export interface LocalBridgeConversationState {
  readonly installationId: string;
  readonly sessionId: string;
  readonly ownerSourceInstanceId: string;
  readonly sourceEpoch: number;
  readonly activityGeneration: number;
  readonly connected: boolean;
  readonly dormant: boolean;
  readonly sessionMirrorState: SessionMirrorState;
  readonly lastSnapshotSha256: string | null;
  readonly lastSnapshotByteLength: number | null;
  readonly lastSnapshotRevision: number | null;
  readonly supersededSourceInstanceIds: readonly string[];
}

export interface LocalBridgeState {
  readonly status: "open" | "closed";
  readonly installationId: string;
  readonly launchToken: string;
  readonly bridgeRevision: number;
  readonly conversations: readonly LocalBridgeConversationState[];
}

export interface LocalBridgeStateSuccess {
  readonly ok: true;
  readonly state: LocalBridgeState;
}

export type LocalBridgeStateResult = LocalBridgeStateSuccess | LocalBridgeFailure;

export interface LocalBridgeTransitionSuccess {
  readonly ok: true;
  readonly nextState: LocalBridgeState;
  readonly result: LocalBridgeWireResult;
}

export type LocalBridgeTransition = LocalBridgeTransitionSuccess | LocalBridgeFailure;

interface LocalBridgeNormalizationResult {
  readonly ok: true;
  readonly value: LocalBridgeJsonValue;
}

interface LocalBridgeNormalizationFailure {
  readonly ok: false;
}

interface LocalBridgeOwnRecord {
  readonly [key: string]: unknown;
}

type LocalBridgeNormalization = LocalBridgeNormalizationResult | LocalBridgeNormalizationFailure;

interface LocalBridgeNormalizationLimits {
  readonly maxDepth: number;
  readonly maxContainers: number;
  readonly maxCollection: number;
  readonly maxBytes: number;
}

const DIRECT_NORMALIZATION_LIMITS: LocalBridgeNormalizationLimits = Object.freeze({
  maxDepth: LOCAL_BRIDGE_BOUNDS.maxDirectNormalizationDepth,
  maxContainers: LOCAL_BRIDGE_BOUNDS.maxDirectNormalizationContainers,
  maxCollection: LOCAL_BRIDGE_BOUNDS.maxDirectNormalizationCollection,
  maxBytes: LOCAL_BRIDGE_BOUNDS.maxDirectNormalizationBytes,
});

const RETAINED_NORMALIZATION_LIMITS: LocalBridgeNormalizationLimits = Object.freeze({
  maxDepth: LOCAL_BRIDGE_BOUNDS.maxNormalizationDepth,
  maxContainers: LOCAL_BRIDGE_BOUNDS.maxNormalizationContainers,
  maxCollection: LOCAL_BRIDGE_BOUNDS.maxNormalizationCollection,
  maxBytes: LOCAL_BRIDGE_BOUNDS.maxNormalizationBytes,
});

function failure(code: LocalBridgeErrorCode): LocalBridgeFailure {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code }),
  });
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isJsonObject(value: LocalBridgeJsonValue): value is LocalBridgeJsonObject {
  return isObject(value) && !Array.isArray(value);
}

function freezeJson<T extends LocalBridgeJsonValue>(value: T): T {
  if (isObject(value)) {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function normalizeJson(
  input: unknown,
  limits: LocalBridgeNormalizationLimits,
): LocalBridgeNormalization {
  const seen = new WeakSet<object>();
  let containerCount = 0;
  let byteCount = 0;
  let failed = false;

  function account(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      failed = true;
      return;
    }
    if (byteCount > limits.maxBytes - bytes) failed = true;
    else byteCount += bytes;
  }

  function walk(value: unknown, depth: number): LocalBridgeJsonValue | undefined {
    if (failed || depth > limits.maxDepth) {
      failed = true;
      return undefined;
    }
    if (value === null) {
      account(4);
      return null;
    }
    if (typeof value === "string") {
      account(Buffer.byteLength(value, "utf8"));
      return value;
    }
    if (typeof value === "boolean") {
      account(5);
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        failed = true;
        return undefined;
      }
      account(16);
      return value;
    }
    if (!isObject(value)) {
      failed = true;
      return undefined;
    }

    if (seen.has(value)) {
      failed = true;
      return undefined;
    }
    seen.add(value);
    containerCount += 1;
    if (containerCount > limits.maxContainers) {
      failed = true;
      seen.delete(value);
      return undefined;
    }

    let output: LocalBridgeJsonValue | undefined;
    try {
      if (Array.isArray(value)) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
        if (
          !lengthDescriptor ||
          !Object.prototype.hasOwnProperty.call(lengthDescriptor, "value") ||
          !Number.isSafeInteger(lengthDescriptor.value) ||
          lengthDescriptor.value < 0
        ) {
          failed = true;
          return undefined;
        }
        const length = lengthDescriptor.value as number;
        if (length > limits.maxCollection) {
          failed = true;
          return undefined;
        }
        const names = Object.getOwnPropertyNames(value);
        if (names.length > limits.maxCollection + 1) {
          failed = true;
          return undefined;
        }
        for (const name of names) {
          if (name === "length") continue;
          if (!/^(?:0|[1-9][0-9]*)$/.test(name) || Number(name) >= length) {
            failed = true;
            return undefined;
          }
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
          failed = true;
          return undefined;
        }
        const array: LocalBridgeJsonValue[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (
            !descriptor ||
            !descriptor.enumerable ||
            !Object.prototype.hasOwnProperty.call(descriptor, "value")
          ) {
            failed = true;
            return undefined;
          }
          const child = walk(descriptor.value, depth + 1);
          if (child === undefined && failed) return undefined;
          array.push(child as LocalBridgeJsonValue);
        }
        output = array;
      } else {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== null && prototype !== Object.prototype) {
          failed = true;
          return undefined;
        }
        const names = Object.getOwnPropertyNames(value);
        if (names.length > limits.maxCollection || Object.getOwnPropertySymbols(value).length > 0) {
          failed = true;
          return undefined;
        }
        const record: Record<string, LocalBridgeJsonValue> = Object.create(null) as Record<
          string,
          LocalBridgeJsonValue
        >;
        for (const name of names) {
          const descriptor = Object.getOwnPropertyDescriptor(value, name);
          if (
            !descriptor ||
            !descriptor.enumerable ||
            !Object.prototype.hasOwnProperty.call(descriptor, "value")
          ) {
            failed = true;
            return undefined;
          }
          account(Buffer.byteLength(name, "utf8") + 2);
          const child = walk(descriptor.value, depth + 1);
          if (child === undefined && failed) return undefined;
          record[name] = child as LocalBridgeJsonValue;
        }
        output = record;
      }
    } catch {
      failed = true;
      return undefined;
    } finally {
      seen.delete(value);
    }
    return output;
  }

  let value: LocalBridgeJsonValue | undefined;
  try {
    value = walk(input, 0);
  } catch {
    failed = true;
  }
  if (failed || value === undefined) return { ok: false };
  return { ok: true, value: freezeJson(value) };
}

function normalizeObject(
  input: unknown,
  limits: LocalBridgeNormalizationLimits,
): LocalBridgeJsonObject | undefined {
  const normalized = normalizeJson(input, limits);
  return normalized.ok && isJsonObject(normalized.value) ? normalized.value : undefined;
}

function hasOnlyKeys(value: LocalBridgeJsonObject, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return (
    Object.keys(value).every((key) => allowed.has(key)) &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function hasOptionalOnlyKeys(
  value: LocalBridgeJsonObject,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    Object.keys(value).every((key) => allowed.has(key)) &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function field(value: LocalBridgeJsonObject, key: string): LocalBridgeJsonValue | undefined {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function boundedString(value: unknown, maxCharacters: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxCharacters)
    return undefined;
  if (Buffer.byteLength(value, "utf8") > maxCharacters * 4) return undefined;
  return value;
}

function characterLength(value: string): number {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}

function v1Identity(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    characterLength(value) <= SESSION_MIRROR_BOUNDS.maxIdentityCharacters
    ? value
    : undefined;
}

function v1Cursor(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    characterLength(value) <= SESSION_MIRROR_BOUNDS.maxCursorCharacters
    ? value
    : undefined;
}

function v1Revision(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function boundedUtf8String(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return Buffer.byteLength(value, "utf8") <= maxBytes ? value : undefined;
}

// LocalBridge outer identities must be well-formed Unicode scalar sequences;
// retained session-mirror/v1 values are validated separately.
function isWellFormedUnicode(value: string): boolean {
  return value.isWellFormed();
}

function identity(value: unknown): string | undefined {
  // Any accepted scalar sequence has at most two UTF-16 code units per code point.
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > LOCAL_BRIDGE_BOUNDS.maxIdentityCharacters * 2 ||
    !isWellFormedUnicode(value) ||
    characterLength(value) > LOCAL_BRIDGE_BOUNDS.maxIdentityCharacters
  ) {
    return undefined;
  }
  if (Buffer.byteLength(value, "utf8") > LOCAL_BRIDGE_BOUNDS.maxIdentityCharacters * 4) {
    return undefined;
  }
  return value;
}

function token(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length !== LOCAL_BRIDGE_BOUNDS.maxTokenCharacters) {
    return undefined;
  }
  return TOKEN_PATTERN.test(value) ? value : undefined;
}

function sourceInstanceId(value: unknown): string | undefined {
  if (typeof value !== "string" || !SOURCE_INSTANCE_PATTERN.test(value)) return undefined;
  return value;
}

function uint(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" &&
    !Object.is(value, -0) &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
    ? value
    : undefined;
}

function incrementActivityGeneration(value: number): number | undefined {
  return value < LOCAL_BRIDGE_BOUNDS.maxActivityGeneration ? value + 1 : undefined;
}

function protocol(
  value: unknown,
):
  | { readonly ok: true; readonly version: LocalBridgeProtocolVersion }
  | { readonly ok: false; readonly code: LocalBridgeErrorCode } {
  const object = normalizeObject(value, DIRECT_NORMALIZATION_LIMITS);
  if (!object || !hasOnlyKeys(object, ["family", "major", "minor"])) {
    return { ok: false, code: "invalid-input" };
  }
  const family = field(object, "family");
  const major = field(object, "major");
  const minor = field(object, "minor");
  if (typeof family !== "string" || typeof major !== "number" || typeof minor !== "number") {
    return { ok: false, code: "invalid-input" };
  }
  if (
    family !== LOCAL_BRIDGE_FAMILY ||
    major !== LOCAL_BRIDGE_MAJOR ||
    !Number.isSafeInteger(minor) ||
    minor < 0 ||
    minor > LOCAL_BRIDGE_MINOR
  ) {
    return { ok: false, code: "incompatible-protocol" };
  }
  return {
    ok: true,
    version: Object.freeze({
      family: LOCAL_BRIDGE_FAMILY,
      major: LOCAL_BRIDGE_MAJOR,
      minor,
    }),
  };
}

type LocalBridgeCapabilityListResult =
  | { readonly ok: true; readonly capabilities: readonly string[] }
  | { readonly ok: false; readonly code: "malformed-frame" | "incompatible-capability" };

function capabilityList(value: unknown): LocalBridgeCapabilityListResult {
  if (!Array.isArray(value) || value.length > LOCAL_BRIDGE_BOUNDS.maxCapabilities) {
    return { ok: false, code: "malformed-frame" };
  }
  const values: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const name = boundedString(item, 64);
    if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      return { ok: false, code: "malformed-frame" };
    }
    if (seen.has(name)) return { ok: false, code: "incompatible-capability" };
    seen.add(name);
    values.push(name);
  }
  if (!REQUIRED_CAPABILITIES.every((name, index) => values[index] === name)) {
    return { ok: false, code: "incompatible-capability" };
  }
  return { ok: true, capabilities: Object.freeze(values) };
}

function serializedByteLength(value: LocalBridgeJsonValue): number | undefined {
  try {
    const raw = JSON.stringify(value);
    return raw === undefined ? undefined : Buffer.byteLength(raw, "utf8");
  } catch {
    return undefined;
  }
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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

function parseJsonText(
  raw: unknown,
  maxBytes: number,
): { readonly ok: true; readonly value: LocalBridgeJsonObject } | LocalBridgeFailure {
  if (typeof raw !== "string") return failure("invalid-input");
  if (Buffer.byteLength(raw, "utf8") > maxBytes) return failure("control-frame-too-large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failure("invalid-json");
  }
  const object = normalizeObject(parsed, DIRECT_NORMALIZATION_LIMITS);
  return object ? { ok: true, value: object } : failure("invalid-input");
}

interface LocalBridgeControlBodySuccess {
  readonly ok: true;
  readonly value: LocalBridgeJsonObject;
}

type LocalBridgeControlBodyResult = LocalBridgeControlBodySuccess | LocalBridgeFailure;

function parseControlBody(body: Uint8Array): LocalBridgeControlBodyResult {
  if (body.byteLength > LOCAL_BRIDGE_BOUNDS.maxControlFrameBytes) {
    return failure("control-frame-too-large");
  }
  const raw = decodeUtf8(body);
  if (raw === undefined) return failure("invalid-utf8");
  const parsed = parseJsonText(raw, LOCAL_BRIDGE_BOUNDS.maxControlFrameBytes);
  return parsed.ok ? { ok: true, value: parsed.value } : parsed;
}

function checkSocketName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > LOCAL_BRIDGE_BOUNDS.maxSocketNameCharacters) {
    return undefined;
  }
  return SOCKET_NAME_PATTERN.test(value) ? value : undefined;
}

function validateProtocolEnvelope(
  input: unknown,
  invalidCode: LocalBridgeErrorCode,
): { readonly ok: true; readonly value: LocalBridgeProtocolVersion } | LocalBridgeFailure {
  const result = protocol(input);
  if (!result.ok) {
    return result.code === "invalid-input" ? failure(invalidCode) : failure(result.code);
  }
  return { ok: true, value: result.version };
}

function validateRendezvousObject(input: unknown): LocalBridgeRendezvousResult {
  const object = normalizeObject(input, DIRECT_NORMALIZATION_LIMITS);
  if (
    !object ||
    !hasOnlyKeys(object, ["protocol", "installationId", "socketName", "launchToken"])
  ) {
    return failure("malformed-rendezvous");
  }
  const byteLength = serializedByteLength(object);
  if (byteLength === undefined) return failure("malformed-rendezvous");
  if (byteLength > LOCAL_BRIDGE_BOUNDS.maxRendezvousBytes) return failure("unsafe-rendezvous");
  const parsedProtocol = validateProtocolEnvelope(
    field(object, "protocol"),
    "malformed-rendezvous",
  );
  if (!parsedProtocol.ok) return parsedProtocol;
  const installationId = identity(field(object, "installationId"));
  const socketName = checkSocketName(field(object, "socketName"));
  const launchToken = token(field(object, "launchToken"));
  if (!installationId || !socketName || !launchToken) return failure("malformed-rendezvous");
  return {
    ok: true,
    rendezvous: Object.freeze({
      protocol: parsedProtocol.value,
      installationId,
      socketName,
      launchToken,
    }),
  };
}

export function validateLocalBridgeRendezvous(input: unknown): LocalBridgeRendezvousResult {
  try {
    return validateRendezvousObject(input);
  } catch {
    return failure("malformed-rendezvous");
  }
}

export function parseLocalBridgeRendezvousJson(input: unknown): LocalBridgeRendezvousResult {
  try {
    if (typeof input === "string") {
      const parsed = parseJsonText(input, LOCAL_BRIDGE_BOUNDS.maxRendezvousBytes);
      if (!parsed.ok) {
        return parsed.error.code === "control-frame-too-large"
          ? failure("unsafe-rendezvous")
          : failure("malformed-rendezvous");
      }
      return validateRendezvousObject(parsed.value);
    }
    return validateRendezvousObject(input);
  } catch {
    return failure("malformed-rendezvous");
  }
}

function checkAbsoluteDirectoryPath(input: unknown): string | undefined {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    return undefined;
  }
  if (
    !input.startsWith("/") ||
    Buffer.byteLength(input, "utf8") > LOCAL_BRIDGE_BOUNDS.maxSocketPathBytes
  ) {
    return undefined;
  }
  const components = input.split("/").slice(1);
  if (components.some((component) => component === "" || component === "." || component === "..")) {
    return undefined;
  }
  return input;
}

export function validateLocalBridgeDirectoryPath(input: unknown): LocalBridgeDirectoryPathResult {
  try {
    const directory = checkAbsoluteDirectoryPath(input);
    return directory === undefined ? failure("unsafe-rendezvous") : { ok: true, directory };
  } catch {
    return failure("unsafe-rendezvous");
  }
}

function rendezvousValue(input: unknown): LocalBridgeRendezvous | undefined {
  const direct = validateRendezvousObject(input);
  if (direct.ok) return direct.rendezvous;
  const object = normalizeObject(input, DIRECT_NORMALIZATION_LIMITS);
  if (!object || !hasOnlyKeys(object, ["ok", "rendezvous"]) || field(object, "ok") !== true) {
    return undefined;
  }
  const result = validateRendezvousObject(field(object, "rendezvous"));
  return result.ok ? result.rendezvous : undefined;
}

export function validateLocalBridgeSocketPath(
  input: unknown,
  companionDirectoryInput: unknown,
  rendezvousInput: unknown,
): LocalBridgeSocketPathResult {
  try {
    const directory = checkAbsoluteDirectoryPath(companionDirectoryInput);
    const rendezvous = rendezvousValue(rendezvousInput);
    if (!directory || !rendezvous || typeof input !== "string") {
      return failure("unsafe-rendezvous");
    }
    const expectedPath = `${directory}/${rendezvous.socketName}`;
    if (
      input !== expectedPath ||
      Buffer.byteLength(expectedPath, "utf8") > LOCAL_BRIDGE_BOUNDS.maxSocketPathBytes
    ) {
      return failure("unsafe-rendezvous");
    }
    return { ok: true, socketPath: input };
  } catch {
    return failure("unsafe-rendezvous");
  }
}

function validateHandshakeObject(input: unknown): LocalBridgeHandshakeResult {
  const object = normalizeObject(input, DIRECT_NORMALIZATION_LIMITS);
  const keys = [
    "kind",
    "protocol",
    "installationId",
    "sessionId",
    "sourceInstanceId",
    "launchToken",
    "capabilities",
  ] as const;
  if (!object || !hasOnlyKeys(object, keys)) return failure("malformed-frame");
  if (field(object, "kind") !== HANDSHAKE_KIND) return failure("malformed-frame");
  const parsedProtocol = validateProtocolEnvelope(field(object, "protocol"), "malformed-frame");
  if (!parsedProtocol.ok) return parsedProtocol;
  const installationId = identity(field(object, "installationId"));
  const sessionId = identity(field(object, "sessionId"));
  const sourceId = sourceInstanceId(field(object, "sourceInstanceId"));
  const launchToken = token(field(object, "launchToken"));
  const capabilities = capabilityList(field(object, "capabilities"));
  if (!installationId || !sessionId || !sourceId || !launchToken) {
    return failure("malformed-frame");
  }
  if (!capabilities.ok) return failure(capabilities.code);
  return {
    ok: true,
    handshake: Object.freeze({
      kind: HANDSHAKE_KIND,
      protocol: parsedProtocol.value,
      installationId,
      sessionId,
      sourceInstanceId: sourceId,
      launchToken,
      capabilities: capabilities.capabilities,
    }),
  };
}

export function validateLocalBridgeHandshake(input: unknown): LocalBridgeHandshakeResult {
  try {
    return validateHandshakeObject(input);
  } catch {
    return failure("malformed-frame");
  }
}

export function decodeLengthPrefixedFrame(input: unknown): LocalBridgeFrameResult {
  try {
    const bytes = copyBytes(input);
    if (!bytes || bytes.byteLength < 4) return failure("malformed-frame");
    const declaredLength = bytes[0] * 0x1000000 + bytes[1] * 0x10000 + bytes[2] * 0x100 + bytes[3];
    if (declaredLength > LOCAL_BRIDGE_BOUNDS.maxFrameBodyBytes) return failure("frame-too-large");
    if (bytes.byteLength !== declaredLength + 4) return failure("malformed-frame");
    return { ok: true, body: bytes.slice(4) };
  } catch {
    return failure("malformed-frame");
  }
}

export function encodeLengthPrefixedFrame(input: unknown): LocalBridgeEncodedFrameResult {
  try {
    const body = copyBytes(input);
    if (!body) return failure("invalid-input");
    if (body.byteLength > LOCAL_BRIDGE_BOUNDS.maxFrameBodyBytes) return failure("frame-too-large");
    const frame = new Uint8Array(body.byteLength + 4);
    frame[0] = (body.byteLength >>> 24) & 0xff;
    frame[1] = (body.byteLength >>> 16) & 0xff;
    frame[2] = (body.byteLength >>> 8) & 0xff;
    frame[3] = body.byteLength & 0xff;
    frame.set(body, 4);
    return { ok: true, frame };
  } catch {
    return failure("invalid-input");
  }
}

export function parseLocalBridgeHandshakeFrame(input: unknown): LocalBridgeHandshakeResult {
  try {
    const decoded = decodeLengthPrefixedFrame(input);
    if (!decoded.ok) return decoded;
    const body = parseControlBody(decoded.body);
    if (!body.ok) return body;
    return validateHandshakeObject(body.value);
  } catch {
    return failure("malformed-frame");
  }
}

function isWireCode(value: string): value is LocalBridgeWireCode {
  return LOCAL_BRIDGE_ERROR_CODES.some((code) => code === value) || CONTROL_RESULT_CODES.has(value);
}

function freezeWireResult(
  code: LocalBridgeWireCode,
  bridgeRevision?: number,
  sourceEpoch?: number,
  snapshotRequired?: boolean,
): LocalBridgeWireResult {
  const result: {
    readonly kind: typeof RESULT_KIND;
    readonly code: LocalBridgeWireCode;
    readonly bridgeRevision?: number;
    readonly sourceEpoch?: number;
    readonly snapshotRequired?: boolean;
  } = {
    kind: RESULT_KIND,
    code,
    ...(bridgeRevision === undefined ? {} : { bridgeRevision }),
    ...(sourceEpoch === undefined ? {} : { sourceEpoch }),
    ...(snapshotRequired === undefined ? {} : { snapshotRequired }),
  };
  return Object.freeze(result);
}

function validateWireResultObject(input: unknown): LocalBridgeResultFrameValidation {
  const object = normalizeObject(input, DIRECT_NORMALIZATION_LIMITS);
  if (!object) return failure("malformed-frame");
  const required = ["kind", "code"] as const;
  const optional = ["bridgeRevision", "sourceEpoch", "snapshotRequired"] as const;
  if (!hasOptionalOnlyKeys(object, required, optional)) return failure("malformed-frame");
  if (field(object, "kind") !== RESULT_KIND) return failure("malformed-frame");
  const code = field(object, "code");
  if (typeof code !== "string" || !isWireCode(code)) return failure("malformed-frame");
  const bridgeRevisionValue = field(object, "bridgeRevision");
  const sourceEpochValue = field(object, "sourceEpoch");
  const snapshotRequiredValue = field(object, "snapshotRequired");
  if (!CONTROL_RESULT_CODES.has(code) || code === "closed") {
    if (
      bridgeRevisionValue !== undefined ||
      sourceEpochValue !== undefined ||
      snapshotRequiredValue !== undefined
    ) {
      return failure("malformed-frame");
    }
    return { ok: true, result: freezeWireResult(code) };
  }
  if (bridgeRevisionValue === undefined || sourceEpochValue === undefined) {
    return failure("malformed-frame");
  }
  if (code === "ready") {
    if (typeof snapshotRequiredValue !== "boolean") return failure("malformed-frame");
  } else if (snapshotRequiredValue !== undefined) {
    return failure("malformed-frame");
  }
  const bridgeRevision = uint(bridgeRevisionValue, LOCAL_BRIDGE_BOUNDS.maxBridgeRevision);
  const sourceEpoch = uint(sourceEpochValue, LOCAL_BRIDGE_BOUNDS.maxSourceEpoch);
  if (bridgeRevision === undefined || sourceEpoch === undefined || sourceEpoch < 1) {
    return failure("malformed-frame");
  }
  return {
    ok: true,
    result: freezeWireResult(
      code,
      bridgeRevision,
      sourceEpoch,
      code === "ready" ? snapshotRequiredValue : undefined,
    ),
  };
}

export function validateLocalBridgeResult(input: unknown): LocalBridgeResultFrameValidation {
  try {
    return validateWireResultObject(input);
  } catch {
    return failure("malformed-frame");
  }
}

export function parseLocalBridgeResultFrame(input: unknown): LocalBridgeResultFrameValidation {
  try {
    const decoded = decodeLengthPrefixedFrame(input);
    if (!decoded.ok) return decoded;
    const body = parseControlBody(decoded.body);
    if (!body.ok) return body;
    return validateWireResultObject(body.value);
  } catch {
    return failure("malformed-frame");
  }
}

export function encodeLocalBridgeResultFrame(input: unknown): LocalBridgeEncodedFrameResult {
  try {
    const validated = validateWireResultObject(input);
    if (!validated.ok) return validated;
    const serialized = JSON.stringify(validated.result);
    if (serialized === undefined) return failure("malformed-frame");
    const body = new TextEncoder().encode(serialized);
    if (body.byteLength > LOCAL_BRIDGE_BOUNDS.maxControlFrameBytes) {
      return failure("control-frame-too-large");
    }
    return encodeLengthPrefixedFrame(body);
  } catch {
    return failure("malformed-frame");
  }
}

export function parseLocalBridgeDataFrame(input: unknown): LocalBridgeDataResult {
  try {
    const decoded = decodeLengthPrefixedFrame(input);
    if (!decoded.ok) return decoded;
    const rawJson = decodeUtf8(decoded.body);
    if (rawJson === undefined) return failure("invalid-utf8");
    const parsed = parseSessionMirrorJson(rawJson);
    if (!parsed.ok) {
      return failure(mapSessionMirrorFailure(parsed.error.category));
    }
    return {
      ok: true,
      envelope: parsed.envelope,
      rawJson,
      rawBytes: decoded.body,
    };
  } catch {
    return failure("session-mirror-invalid");
  }
}

function mapSessionMirrorFailure(category: SessionMirrorFailureCategory): LocalBridgeErrorCode {
  switch (category) {
    case "bounds-exceeded":
      return "session-mirror-bounds";
    case "incompatible-protocol":
    case "incompatible-capability":
    case "incompatible-message-kind":
      return "session-mirror-incompatible";
    case "forbidden-streaming":
      return "session-mirror-forbidden";
    case "incomplete-turn":
      return "session-mirror-incomplete";
    case "conflicting-duplicate":
      return "session-mirror-duplicate-conflict";
    case "revision-gap":
      return "session-mirror-revision-gap";
    case "malformed-envelope":
      return "session-mirror-invalid";
  }
}

function readOwnRecord(input: unknown): LocalBridgeOwnRecord | undefined {
  if (!isObject(input) || Array.isArray(input)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== null && prototype !== Object.prototype) return undefined;
    if (Object.getOwnPropertySymbols(input).length > 0) return undefined;
    const names = Object.getOwnPropertyNames(input);
    if (names.length > LOCAL_BRIDGE_BOUNDS.maxDirectNormalizationCollection) return undefined;
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(input, name);
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value")
      ) {
        return undefined;
      }
      output[name] = descriptor.value;
    }
    return output;
  } catch {
    return undefined;
  }
}

function commandIdentity(input: unknown):
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly sourceInstanceId: string;
      readonly frame: Uint8Array;
    }
  | LocalBridgeFailure {
  const record = readOwnRecord(input);
  if (
    !record ||
    Object.keys(record).length !== 3 ||
    !Object.keys(record).every((key) => ["sessionId", "sourceInstanceId", "frame"].includes(key))
  ) {
    return failure("invalid-input");
  }
  const sessionId = identity(record.sessionId);
  const sourceId = sourceInstanceId(record.sourceInstanceId);
  const frame = copyBytes(record.frame);
  if (!sessionId || !sourceId || !frame) return failure("invalid-input");
  return { ok: true, sessionId, sourceInstanceId: sourceId, frame };
}

function commandOwner(
  input: unknown,
):
  | { readonly ok: true; readonly sessionId: string; readonly sourceInstanceId: string }
  | LocalBridgeFailure {
  const record = readOwnRecord(input);
  if (
    !record ||
    Object.keys(record).length !== 2 ||
    !Object.keys(record).every((key) => ["sessionId", "sourceInstanceId"].includes(key))
  ) {
    return failure("invalid-input");
  }
  const sessionId = identity(record.sessionId);
  const sourceId = sourceInstanceId(record.sourceInstanceId);
  if (!sessionId || !sourceId) return failure("invalid-input");
  return { ok: true, sessionId, sourceInstanceId: sourceId };
}

function snapshotDigest(value: unknown): string | undefined {
  return typeof value === "string" && SNAPSHOT_DIGEST_PATTERN.test(value) ? value : undefined;
}

function normalizeSessionMirrorState(input: unknown): SessionMirrorState | undefined {
  const object = normalizeObject(input, RETAINED_NORMALIZATION_LIMITS);
  if (
    !object ||
    !hasOnlyKeys(object, ["sessionId", "revision", "cursor", "snapshotId", "seenMessages"])
  ) {
    return undefined;
  }
  const sessionIdValue = field(object, "sessionId");
  const sessionId = sessionIdValue === null ? null : v1Identity(sessionIdValue);
  const revision = v1Revision(field(object, "revision"));
  const cursorValue = field(object, "cursor");
  const cursor = cursorValue === null ? null : v1Cursor(cursorValue);
  const snapshotIdValue = field(object, "snapshotId");
  const snapshotId = snapshotIdValue === null ? null : v1Identity(snapshotIdValue);
  const messagesValue = field(object, "seenMessages");
  if (
    (sessionIdValue !== null && sessionId === undefined) ||
    revision === undefined ||
    (cursorValue !== null && cursor === undefined) ||
    (snapshotIdValue !== null && snapshotId === undefined) ||
    !Array.isArray(messagesValue) ||
    messagesValue.length > SESSION_MIRROR_BOUNDS.maxSeenMessages
  ) {
    return undefined;
  }
  const seenMessages: {
    readonly sessionId: string;
    readonly eventId: string;
    readonly canonical: string;
  }[] = [];
  const keys = new Set<string>();
  for (const item of messagesValue) {
    const record = isJsonObject(item) ? item : undefined;
    if (!record || !hasOnlyKeys(record, ["sessionId", "eventId", "canonical"])) return undefined;
    const itemSessionId = v1Identity(field(record, "sessionId"));
    const eventId = v1Identity(field(record, "eventId"));
    const canonical = boundedUtf8String(
      field(record, "canonical"),
      SESSION_MIRROR_BOUNDS.maxEnvelopeBytes,
    );
    if (!itemSessionId || !eventId || !canonical) return undefined;
    if (sessionId !== null && itemSessionId !== sessionId) return undefined;
    const key = `${itemSessionId}\u0000${eventId}`;
    if (keys.has(key)) return undefined;
    keys.add(key);
    seenMessages.push(Object.freeze({ sessionId: itemSessionId, eventId, canonical }));
  }
  if (sessionId === null) {
    if (revision !== 0 || cursor !== null || snapshotId !== null || seenMessages.length !== 0)
      return undefined;
  } else if (cursor === null || seenMessages.length === 0) {
    return undefined;
  }
  return Object.freeze({
    sessionId: sessionId as string | null,
    revision,
    cursor: cursor as string | null,
    snapshotId: snapshotId as string | null,
    seenMessages: Object.freeze(seenMessages),
  });
}

function normalizeLocalBridgeState(input: unknown): LocalBridgeState | undefined {
  const object = normalizeObject(input, RETAINED_NORMALIZATION_LIMITS);
  if (
    !object ||
    !hasOnlyKeys(object, [
      "status",
      "installationId",
      "launchToken",
      "bridgeRevision",
      "conversations",
    ])
  ) {
    return undefined;
  }
  const status = field(object, "status");
  const installationId = identity(field(object, "installationId"));
  const launchToken = token(field(object, "launchToken"));
  const bridgeRevision = uint(
    field(object, "bridgeRevision"),
    LOCAL_BRIDGE_BOUNDS.maxBridgeRevision,
  );
  const conversationsValue = field(object, "conversations");
  if (
    (status !== "open" && status !== "closed") ||
    !installationId ||
    !launchToken ||
    bridgeRevision === undefined ||
    !Array.isArray(conversationsValue) ||
    conversationsValue.length > LOCAL_BRIDGE_BOUNDS.maxKnownConversations
  ) {
    return undefined;
  }
  if (status === "closed" && conversationsValue.length !== 0) return undefined;
  const conversations: LocalBridgeConversationState[] = [];
  let activeConversationCount = 0;
  const conversationKeys = new Set<string>();
  for (const item of conversationsValue) {
    const record = isJsonObject(item) ? item : undefined;
    if (
      !record ||
      !hasOnlyKeys(record, [
        "installationId",
        "sessionId",
        "ownerSourceInstanceId",
        "sourceEpoch",
        "activityGeneration",
        "connected",
        "dormant",
        "sessionMirrorState",
        "lastSnapshotSha256",
        "lastSnapshotByteLength",
        "lastSnapshotRevision",
        "supersededSourceInstanceIds",
      ])
    ) {
      return undefined;
    }
    const itemInstallationId = identity(field(record, "installationId"));
    const sessionId = identity(field(record, "sessionId"));
    const owner = sourceInstanceId(field(record, "ownerSourceInstanceId"));
    const sourceEpoch = uint(field(record, "sourceEpoch"), LOCAL_BRIDGE_BOUNDS.maxSourceEpoch);
    const activityGeneration = uint(
      field(record, "activityGeneration"),
      LOCAL_BRIDGE_BOUNDS.maxActivityGeneration,
    );
    const connected = field(record, "connected");
    const dormant = field(record, "dormant");
    const mirrorState = normalizeSessionMirrorState(field(record, "sessionMirrorState"));
    const lastSnapshotSha256Value = field(record, "lastSnapshotSha256");
    const lastSnapshotSha256 =
      lastSnapshotSha256Value === null ? null : snapshotDigest(lastSnapshotSha256Value);
    const lastSnapshotByteLengthValue = field(record, "lastSnapshotByteLength");
    const lastSnapshotByteLength =
      lastSnapshotByteLengthValue === null
        ? null
        : uint(lastSnapshotByteLengthValue, LOCAL_BRIDGE_BOUNDS.maxFrameBodyBytes);
    const lastSnapshotRevisionValue = field(record, "lastSnapshotRevision");
    const lastSnapshotRevision =
      lastSnapshotRevisionValue === null ? null : v1Revision(lastSnapshotRevisionValue);
    const supersededValue = field(record, "supersededSourceInstanceIds");
    if (
      !itemInstallationId ||
      itemInstallationId !== installationId ||
      !sessionId ||
      !owner ||
      sourceEpoch === undefined ||
      sourceEpoch < 1 ||
      activityGeneration === undefined ||
      typeof connected !== "boolean" ||
      typeof dormant !== "boolean" ||
      !mirrorState ||
      lastSnapshotSha256 === undefined ||
      lastSnapshotByteLength === undefined ||
      lastSnapshotRevision === undefined ||
      !Array.isArray(supersededValue)
    ) {
      return undefined;
    }
    if (mirrorState.sessionId !== null && mirrorState.sessionId !== sessionId) return undefined;
    if (dormant && connected) return undefined;
    if (lastSnapshotSha256 === null && lastSnapshotByteLength !== null) return undefined;
    if (lastSnapshotSha256 === null && lastSnapshotRevision !== null) return undefined;
    if (lastSnapshotSha256 !== null && lastSnapshotByteLength === null) return undefined;
    if (lastSnapshotSha256 !== null && lastSnapshotRevision === null) return undefined;
    if (mirrorState.sessionId === null && lastSnapshotSha256 !== null) return undefined;
    if (mirrorState.sessionId !== null && lastSnapshotSha256 === null) return undefined;
    if (lastSnapshotRevision !== null && lastSnapshotRevision > mirrorState.revision)
      return undefined;
    if (
      dormant &&
      (mirrorState.sessionId !== null ||
        lastSnapshotSha256 !== null ||
        lastSnapshotByteLength !== null ||
        lastSnapshotRevision !== null)
    ) {
      return undefined;
    }
    if (!dormant) activeConversationCount += 1;
    if (activeConversationCount > LOCAL_BRIDGE_BOUNDS.maxActiveConversations) return undefined;
    if (supersededValue.length > LOCAL_BRIDGE_BOUNDS.maxSupersededSourceIds) return undefined;
    const superseded: string[] = [];
    for (const source of supersededValue) {
      const sourceId = sourceInstanceId(source);
      if (!sourceId || sourceId === owner || superseded.includes(sourceId)) return undefined;
      superseded.push(sourceId);
    }
    const key = `${itemInstallationId}\u0000${sessionId}`;
    if (conversationKeys.has(key)) return undefined;
    conversationKeys.add(key);
    conversations.push(
      Object.freeze({
        installationId: itemInstallationId,
        sessionId,
        ownerSourceInstanceId: owner,
        sourceEpoch,
        activityGeneration,
        connected,
        dormant,
        sessionMirrorState: mirrorState,
        lastSnapshotSha256,
        lastSnapshotByteLength,
        lastSnapshotRevision,
        supersededSourceInstanceIds: Object.freeze(superseded),
      }),
    );
  }
  return Object.freeze({
    status,
    installationId,
    launchToken,
    bridgeRevision,
    conversations: Object.freeze(conversations),
  });
}

function freezeState(
  status: "open" | "closed",
  installationId: string,
  launchToken: string,
  bridgeRevision: number,
  conversations: readonly LocalBridgeConversationState[],
): LocalBridgeState {
  return Object.freeze({
    status,
    installationId,
    launchToken,
    bridgeRevision,
    conversations: Object.freeze(conversations.slice()),
  });
}

function validConfig(
  input: unknown,
): { readonly installationId: string; readonly launchToken: string } | undefined {
  const object = normalizeObject(input, DIRECT_NORMALIZATION_LIMITS);
  if (!object || !hasOnlyKeys(object, ["installationId", "launchToken"])) return undefined;
  const installationId = identity(field(object, "installationId"));
  const launchToken = token(field(object, "launchToken"));
  return installationId && launchToken ? { installationId, launchToken } : undefined;
}

export function createLocalBridgeState(input: unknown): LocalBridgeStateResult {
  try {
    const config = validConfig(input);
    if (!config) return failure("invalid-input");
    return {
      ok: true,
      state: freezeState("open", config.installationId, config.launchToken, 0, []),
    };
  } catch {
    return failure("invalid-input");
  }
}

function safeResult(
  code: LocalBridgeWireCode,
  bridgeRevision?: number,
  sourceEpoch?: number,
  snapshotRequired?: boolean,
): LocalBridgeWireResult {
  return freezeWireResult(code, bridgeRevision, sourceEpoch, snapshotRequired);
}

function stateTransition(
  nextState: LocalBridgeState,
  code: LocalBridgeWireCode,
  bridgeRevision?: number,
  sourceEpoch?: number,
  snapshotRequired?: boolean,
): LocalBridgeTransitionSuccess {
  return Object.freeze({
    ok: true,
    nextState,
    result: safeResult(code, bridgeRevision, sourceEpoch, snapshotRequired),
  });
}

function normalizedStateOrFailure(input: unknown): LocalBridgeState | LocalBridgeFailure {
  const state = normalizeLocalBridgeState(input);
  return state ?? failure("invalid-input");
}

function activeConversationCount(state: LocalBridgeState): number {
  return state.conversations.reduce(
    (count, conversation) => count + (conversation.dormant ? 0 : 1),
    0,
  );
}

function disconnectedConversation(
  state: LocalBridgeState,
  sessionId: string,
  sourceInstanceId: string,
): LocalBridgeConversationState | LocalBridgeFailure {
  const conversation = state.conversations.find((item) => item.sessionId === sessionId);
  if (!conversation) return failure("not-owner");
  if (conversation.supersededSourceInstanceIds.includes(sourceInstanceId)) {
    return failure("stale-source");
  }
  if (conversation.ownerSourceInstanceId !== sourceInstanceId) return failure("not-owner");
  return conversation;
}

export function acceptLocalBridgeHandshake(
  stateInput: unknown,
  input: unknown,
): LocalBridgeTransition {
  try {
    const state = normalizedStateOrFailure(stateInput);
    if ("error" in state) return state;
    if (state.status === "closed") return failure("closed");
    const handshake =
      copyBytes(input) !== undefined
        ? parseLocalBridgeHandshakeFrame(input)
        : validateLocalBridgeHandshake(input);
    if (!handshake.ok) return handshake;
    if (handshake.handshake.installationId !== state.installationId) {
      return failure("installation-mismatch");
    }
    if (handshake.handshake.launchToken !== state.launchToken) return failure("token-mismatch");
    const current = state.conversations.find(
      (item) => item.sessionId === handshake.handshake.sessionId,
    );
    if (!current) {
      if (state.conversations.length >= LOCAL_BRIDGE_BOUNDS.maxKnownConversations)
        return failure("busy");
      if (activeConversationCount(state) >= LOCAL_BRIDGE_BOUNDS.maxActiveConversations)
        return failure("busy");
      const conversation: LocalBridgeConversationState = Object.freeze({
        installationId: state.installationId,
        sessionId: handshake.handshake.sessionId,
        ownerSourceInstanceId: handshake.handshake.sourceInstanceId,
        sourceEpoch: 1,
        activityGeneration: 0,
        connected: true,
        dormant: false,
        sessionMirrorState: createSessionMirrorState(),
        lastSnapshotSha256: null,
        lastSnapshotByteLength: null,
        lastSnapshotRevision: null,
        supersededSourceInstanceIds: Object.freeze([]),
      });
      const nextState = freezeState(
        "open",
        state.installationId,
        state.launchToken,
        state.bridgeRevision,
        [...state.conversations, conversation],
      );
      return stateTransition(nextState, "ready", state.bridgeRevision, 1, true);
    }

    if (current.supersededSourceInstanceIds.includes(handshake.handshake.sourceInstanceId)) {
      return failure("stale-source");
    }
    if (current.ownerSourceInstanceId === handshake.handshake.sourceInstanceId) {
      if (current.connected) return failure("busy");
      if (
        current.dormant &&
        activeConversationCount(state) >= LOCAL_BRIDGE_BOUNDS.maxActiveConversations
      ) {
        return failure("busy");
      }
      const activityGeneration = incrementActivityGeneration(current.activityGeneration);
      if (activityGeneration === undefined) return failure("revision-exhausted");
      const reconnected = Object.freeze({
        ...current,
        activityGeneration,
        connected: true,
        dormant: false,
      });
      const nextState = freezeState(
        "open",
        state.installationId,
        state.launchToken,
        state.bridgeRevision,
        state.conversations.map((item) => (item === current ? reconnected : item)),
      );
      return stateTransition(
        nextState,
        "ready",
        state.bridgeRevision,
        current.sourceEpoch,
        current.sessionMirrorState.sessionId === null,
      );
    }
    if (current.connected) return failure("busy");
    if (
      current.dormant &&
      activeConversationCount(state) >= LOCAL_BRIDGE_BOUNDS.maxActiveConversations
    ) {
      return failure("busy");
    }
    if (current.supersededSourceInstanceIds.length >= LOCAL_BRIDGE_BOUNDS.maxSupersededSourceIds) {
      return failure("source-history-full");
    }
    if (current.sourceEpoch >= LOCAL_BRIDGE_BOUNDS.maxSourceEpoch) {
      return failure("revision-exhausted");
    }
    const superseded = Object.freeze([
      ...current.supersededSourceInstanceIds,
      current.ownerSourceInstanceId,
    ]);
    const takeover = Object.freeze({
      ...current,
      ownerSourceInstanceId: handshake.handshake.sourceInstanceId,
      sourceEpoch: current.sourceEpoch + 1,
      activityGeneration: 0,
      connected: true,
      dormant: false,
      sessionMirrorState: createSessionMirrorState(),
      lastSnapshotSha256: null,
      lastSnapshotByteLength: null,
      lastSnapshotRevision: null,
      supersededSourceInstanceIds: superseded,
    });
    const nextState = freezeState(
      "open",
      state.installationId,
      state.launchToken,
      state.bridgeRevision,
      state.conversations.map((item) => (item === current ? takeover : item)),
    );
    return stateTransition(nextState, "ready", state.bridgeRevision, takeover.sourceEpoch, true);
  } catch {
    return failure("invalid-input");
  }
}

export function disconnectLocalBridge(stateInput: unknown, input: unknown): LocalBridgeTransition {
  try {
    const state = normalizedStateOrFailure(stateInput);
    if ("error" in state) return state;
    if (state.status === "closed") return failure("closed");
    const command = commandOwner(input);
    if (!command.ok) return command;
    const conversation = disconnectedConversation(
      state,
      command.sessionId,
      command.sourceInstanceId,
    );
    if ("error" in conversation) return conversation;
    if (!conversation.connected) {
      return stateTransition(state, "disconnected", state.bridgeRevision, conversation.sourceEpoch);
    }
    const activityGeneration = incrementActivityGeneration(conversation.activityGeneration);
    if (activityGeneration === undefined) return failure("revision-exhausted");
    const disconnected = Object.freeze({ ...conversation, activityGeneration, connected: false });
    const nextState = freezeState(
      "open",
      state.installationId,
      state.launchToken,
      state.bridgeRevision,
      state.conversations.map((item) => (item === conversation ? disconnected : item)),
    );
    return stateTransition(
      nextState,
      "disconnected",
      state.bridgeRevision,
      conversation.sourceEpoch,
    );
  } catch {
    return failure("invalid-input");
  }
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function applyLocalBridgeData(stateInput: unknown, input: unknown): LocalBridgeTransition {
  try {
    const state = normalizedStateOrFailure(stateInput);
    if ("error" in state) return state;
    if (state.status === "closed") return failure("closed");
    const command = commandIdentity(input);
    if (!command.ok) return command;
    const conversation = disconnectedConversation(
      state,
      command.sessionId,
      command.sourceInstanceId,
    );
    if ("error" in conversation) return conversation;
    if (!conversation.connected) return failure("not-owner");
    const parsed = parseLocalBridgeDataFrame(command.frame);
    if (!parsed.ok) return parsed;
    if (parsed.envelope.sessionId !== command.sessionId) return failure("session-mismatch");
    if (
      conversation.sessionMirrorState.sessionId === null &&
      parsed.envelope.message.kind !== "snapshot"
    ) {
      return failure("session-mirror-revision-gap");
    }

    const digest = sha256Bytes(parsed.rawBytes);
    const byteLength = parsed.rawBytes.byteLength;
    if (
      parsed.envelope.message.kind === "snapshot" &&
      conversation.lastSnapshotSha256 === digest &&
      conversation.lastSnapshotByteLength === byteLength &&
      conversation.lastSnapshotRevision === conversation.sessionMirrorState.revision
    ) {
      const activityGeneration = incrementActivityGeneration(conversation.activityGeneration);
      if (activityGeneration === undefined) return failure("revision-exhausted");
      const updated = Object.freeze({ ...conversation, activityGeneration });
      const nextState = freezeState(
        "open",
        state.installationId,
        state.launchToken,
        state.bridgeRevision,
        state.conversations.map((item) => (item === conversation ? updated : item)),
      );
      return stateTransition(
        nextState,
        "deduplicated",
        state.bridgeRevision,
        conversation.sourceEpoch,
      );
    }
    const applied = applySessionMirrorEnvelope(conversation.sessionMirrorState, parsed.rawJson);
    if (!applied.ok) return failure(mapSessionMirrorFailure(applied.error.category));
    if (applied.disposition === "duplicate") {
      const activityGeneration = incrementActivityGeneration(conversation.activityGeneration);
      if (activityGeneration === undefined) return failure("revision-exhausted");
      const updated = Object.freeze({ ...conversation, activityGeneration });
      const nextState = freezeState(
        "open",
        state.installationId,
        state.launchToken,
        state.bridgeRevision,
        state.conversations.map((item) => (item === conversation ? updated : item)),
      );
      return stateTransition(
        nextState,
        "duplicate",
        state.bridgeRevision,
        conversation.sourceEpoch,
      );
    }
    if (state.bridgeRevision >= LOCAL_BRIDGE_BOUNDS.maxBridgeRevision) {
      return failure("revision-exhausted");
    }
    const nextBridgeRevision = state.bridgeRevision + 1;
    const activityGeneration = incrementActivityGeneration(conversation.activityGeneration);
    if (activityGeneration === undefined) return failure("revision-exhausted");
    const updated = Object.freeze({
      ...conversation,
      activityGeneration,
      dormant: false,
      sessionMirrorState: applied.nextState,
      lastSnapshotSha256:
        parsed.envelope.message.kind === "snapshot" ? digest : conversation.lastSnapshotSha256,
      lastSnapshotByteLength:
        parsed.envelope.message.kind === "snapshot"
          ? byteLength
          : conversation.lastSnapshotByteLength,
      lastSnapshotRevision:
        parsed.envelope.message.kind === "snapshot"
          ? applied.nextState.revision
          : conversation.lastSnapshotRevision,
    });
    const nextState = freezeState(
      "open",
      state.installationId,
      state.launchToken,
      nextBridgeRevision,
      state.conversations.map((item) => (item === conversation ? updated : item)),
    );
    return stateTransition(nextState, "accepted", nextBridgeRevision, conversation.sourceEpoch);
  } catch {
    return failure("session-mirror-invalid");
  }
}

function commandIdleEviction(input: unknown):
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly sourceInstanceId: string;
      readonly sourceEpoch: number;
      readonly activityGeneration: number;
      readonly elapsedMonotonicMinutes: number;
    }
  | LocalBridgeFailure {
  const record = readOwnRecord(input);
  const requiredKeys = [
    "sessionId",
    "sourceInstanceId",
    "sourceEpoch",
    "activityGeneration",
    "elapsedMonotonicMinutes",
  ];
  if (
    !record ||
    Object.keys(record).length !== requiredKeys.length ||
    !Object.keys(record).every((key) => requiredKeys.includes(key))
  ) {
    return failure("invalid-input");
  }
  const sessionId = identity(record.sessionId);
  const sourceId = sourceInstanceId(record.sourceInstanceId);
  const sourceEpoch = uint(record.sourceEpoch, LOCAL_BRIDGE_BOUNDS.maxSourceEpoch);
  const activityGeneration = uint(
    record.activityGeneration,
    LOCAL_BRIDGE_BOUNDS.maxActivityGeneration,
  );
  const elapsedMonotonicMinutes = uint(record.elapsedMonotonicMinutes, Number.MAX_SAFE_INTEGER);
  if (
    !sessionId ||
    !sourceId ||
    sourceEpoch === undefined ||
    sourceEpoch < 1 ||
    activityGeneration === undefined ||
    elapsedMonotonicMinutes === undefined ||
    elapsedMonotonicMinutes < LOCAL_BRIDGE_BOUNDS.idleEvictionMinutes
  ) {
    return failure("invalid-input");
  }
  return {
    ok: true,
    sessionId,
    sourceInstanceId: sourceId,
    sourceEpoch,
    activityGeneration,
    elapsedMonotonicMinutes,
  };
}

export function evictIdleLocalBridge(stateInput: unknown, input: unknown): LocalBridgeTransition {
  try {
    const state = normalizedStateOrFailure(stateInput);
    if ("error" in state) return state;
    if (state.status === "closed") return failure("closed");
    const command = commandIdleEviction(input);
    if (!command.ok) return command;
    const conversation = state.conversations.find((item) => item.sessionId === command.sessionId);
    if (!conversation) return failure("not-owner");
    if (conversation.supersededSourceInstanceIds.includes(command.sourceInstanceId)) {
      return failure("stale-source");
    }
    if (conversation.ownerSourceInstanceId !== command.sourceInstanceId) {
      return failure("not-owner");
    }
    if (
      conversation.sourceEpoch !== command.sourceEpoch ||
      conversation.activityGeneration !== command.activityGeneration
    ) {
      return failure("stale-activity");
    }
    if (conversation.dormant) {
      return stateTransition(state, "evicted", state.bridgeRevision, conversation.sourceEpoch);
    }
    const evicted = Object.freeze({
      ...conversation,
      connected: false,
      dormant: true,
      sessionMirrorState: createSessionMirrorState(),
      lastSnapshotSha256: null,
      lastSnapshotByteLength: null,
      lastSnapshotRevision: null,
    });
    const nextState = freezeState(
      "open",
      state.installationId,
      state.launchToken,
      state.bridgeRevision,
      state.conversations.map((item) => (item === conversation ? evicted : item)),
    );
    return stateTransition(nextState, "evicted", state.bridgeRevision, conversation.sourceEpoch);
  } catch {
    return failure("invalid-input");
  }
}

export function teardownLocalBridge(stateInput: unknown): LocalBridgeTransition {
  try {
    const state = normalizedStateOrFailure(stateInput);
    if ("error" in state) return state;
    if (state.status === "closed") {
      return stateTransition(state, "closed");
    }
    const closed = freezeState(
      "closed",
      state.installationId,
      state.launchToken,
      state.bridgeRevision,
      [],
    );
    return stateTransition(closed, "closed");
  } catch {
    return failure("invalid-input");
  }
}

export function localBridgeFailureCodes(): readonly LocalBridgeErrorCode[] {
  return LOCAL_BRIDGE_ERROR_CODES;
}

export function localBridgeResultCodes(): readonly LocalBridgeResultCode[] {
  return LOCAL_BRIDGE_RESULT_CODES;
}

export function localBridgeSerializedByteLength(input: unknown): number | undefined {
  try {
    const normalized = normalizeJson(input, RETAINED_NORMALIZATION_LIMITS);
    return normalized.ok ? serializedByteLength(normalized.value) : undefined;
  } catch {
    return undefined;
  }
}

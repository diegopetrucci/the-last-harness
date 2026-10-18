import { SESSION_MIRROR_BOUNDS } from "../../session-mirror/v1/conformance.ts";
import type {
  SessionMirrorEnvelope,
  SessionMirrorFailureCategory,
  SessionMirrorState,
} from "../../session-mirror/v1/conformance.ts";

export function mapSessionMirrorFailure(
  category: SessionMirrorFailureCategory,
): LocalBridgeErrorCode {
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

export const LOCAL_BRIDGE_FAMILY = "local-bridge";
export const LOCAL_BRIDGE_MAJOR = 0;
export const LOCAL_BRIDGE_DATA_MINOR = 0;
export const LOCAL_BRIDGE_REPLY_MINOR = 1;
export const LOCAL_BRIDGE_READ_ONLY_MINOR = LOCAL_BRIDGE_DATA_MINOR;
export const HANDSHAKE_KIND = "hello";
export const REPLY_HANDSHAKE_KIND = "reply-hello";
export const RESULT_KIND = "result";
export const REPLY_KIND = "reply";
export const RECEIPT_KIND = "receipt";
export const REPLY_CLOSE_KIND = "reply-close";
export const REQUIRED_CAPABILITIES = ["snapshot-replace", "cursor-recovery"] as const;
export const REPLY_TEXT_CAPABILITY = "reply-text" as const;
export const REPLY_RECEIPT_CODE_VALUES = [
  "accepted",
  "unconfirmed",
  "invalid",
  "unauthorized",
  "stale",
  "busy",
  "duplicate",
  "expired",
  "disconnected",
] as const;
export const REPLY_CLOSE_REASON_VALUES = [
  "producer-disconnect",
  "owner-replaced",
  "authorization-withdrawn",
  "listener-stop",
  "transport-failure",
] as const;
export const REPLY_DIRECTION_VALUES = ["bridge-to-producer", "producer-to-bridge"] as const;
export const REPLY_OUTCOME_VALUES = ["forwarded", "duplicate"] as const;
export const TOKEN_PATTERN = /^[a-f0-9]{32}$/;
export const SOURCE_INSTANCE_PATTERN = /^[a-f0-9]{32}$/;
export const SOCKET_NAME_PATTERN = /^mirror-[a-f0-9]{24}\.sock$/;
export const SNAPSHOT_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
export const REPLY_REQUEST_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
export const REPLY_TEXT_FORMAT_OR_SEPARATOR = /[\p{Cf}\p{Zl}\p{Zp}]/u;
export const MAX_ACTIVE_CONVERSATIONS = 8;
export const MAX_KNOWN_CONVERSATIONS = 64;
export const MAX_SUPERSEDED_SOURCE_IDS = 64;
export const MAX_ACTIVITY_GENERATION = Number.MAX_SAFE_INTEGER - 1;
export const MIN_REPLY_TTL_SECONDS = 1;
export const MAX_REPLY_TTL_SECONDS = 60;
export const MAX_REPLY_TEXT_BYTES = 2 * 1024;
export const MAX_REPLY_REQUEST_ID_CHARACTERS = 64;
export const MAX_REPLY_REQUEST_DIGESTS = 8;
export const IDLE_EVICTION_MINUTES = 60;
export const NORMALIZATION_PER_CONVERSATION_METADATA_SLACK_BYTES = 512 * 1024;
export const NORMALIZATION_STATE_METADATA_SLACK_BYTES = 4 * 1024 * 1024;
export const NORMALIZATION_MINIMUM_BYTES =
  MAX_ACTIVE_CONVERSATIONS *
    (SESSION_MIRROR_BOUNDS.maxSeenMessages * SESSION_MIRROR_BOUNDS.maxEnvelopeBytes +
      SESSION_MIRROR_BOUNDS.maxEnvelopeBytes +
      NORMALIZATION_PER_CONVERSATION_METADATA_SLACK_BYTES) +
  NORMALIZATION_STATE_METADATA_SLACK_BYTES;
export const NORMALIZATION_BUDGET_BYTES = NORMALIZATION_MINIMUM_BYTES + 8 * 1024 * 1024;
export const DIRECT_NORMALIZATION_MAX_DEPTH = 16;
export const DIRECT_NORMALIZATION_MAX_CONTAINERS = 128;
export const DIRECT_NORMALIZATION_MAX_COLLECTION = 64;
export const DIRECT_NORMALIZATION_MAX_BYTES = 4 * 1024;
export const NORMALIZATION_MAX_COLLECTION = 2_048;
export const CONTROL_RESULT_CODE_VALUES = [
  "ready",
  "disconnected",
  "accepted",
  "duplicate",
  "deduplicated",
  "evicted",
  "closed",
] as const;
export const CONTROL_RESULT_CODES = new Set<string>(CONTROL_RESULT_CODE_VALUES);
export const LOCAL_BRIDGE_ERROR_CODE_VALUES = [
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
  "reply-not-negotiated",
  "reply-channel-disconnected",
  "reply-not-pending",
  "closed",
] as const;

export const LOCAL_BRIDGE_PROTOCOL = Object.freeze({
  family: LOCAL_BRIDGE_FAMILY,
  major: LOCAL_BRIDGE_MAJOR,
  minor: LOCAL_BRIDGE_DATA_MINOR,
});

export const LOCAL_BRIDGE_READ_ONLY_PROTOCOL = Object.freeze({
  family: LOCAL_BRIDGE_FAMILY,
  major: LOCAL_BRIDGE_MAJOR,
  minor: LOCAL_BRIDGE_READ_ONLY_MINOR,
});

export const LOCAL_BRIDGE_REPLY_PROTOCOL = Object.freeze({
  family: LOCAL_BRIDGE_FAMILY,
  major: LOCAL_BRIDGE_MAJOR,
  minor: LOCAL_BRIDGE_REPLY_MINOR,
});

export const LOCAL_BRIDGE_REPLY_CAPABILITY = REPLY_TEXT_CAPABILITY;
export const LOCAL_BRIDGE_REPLY_RECEIPT_CODES = Object.freeze([...REPLY_RECEIPT_CODE_VALUES]);
export const LOCAL_BRIDGE_REPLY_CLOSE_REASONS = Object.freeze([...REPLY_CLOSE_REASON_VALUES]);
export const LOCAL_BRIDGE_REPLY_DIRECTIONS = Object.freeze([...REPLY_DIRECTION_VALUES]);
export const LOCAL_BRIDGE_REPLY_OUTCOME_CODES = Object.freeze([...REPLY_OUTCOME_VALUES]);

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
  maxReplyRequestIdCharacters: MAX_REPLY_REQUEST_ID_CHARACTERS,
  maxReplyRequestDigests: MAX_REPLY_REQUEST_DIGESTS,
  maxReplyTextBytes: MAX_REPLY_TEXT_BYTES,
  minReplyTtlSeconds: MIN_REPLY_TTL_SECONDS,
  maxReplyTtlSeconds: MAX_REPLY_TTL_SECONDS,
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
export const LOCAL_BRIDGE_RUNTIME_ONLY_ERROR_CODES = Object.freeze(["handshake-required"] as const);
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

export interface LocalBridgeReplyHandshake extends LocalBridgeJsonObject {
  readonly kind: typeof REPLY_HANDSHAKE_KIND;
  readonly protocol: LocalBridgeProtocolVersion;
  readonly installationId: string;
  readonly sessionId: string;
  readonly sourceInstanceId: string;
  readonly sourceEpoch: number;
  readonly generation: number;
  readonly launchToken: string;
  readonly capabilities: readonly [typeof REPLY_TEXT_CAPABILITY];
}

export type LocalBridgeReplyReceiptCode = (typeof REPLY_RECEIPT_CODE_VALUES)[number];
export type LocalBridgeReplyCloseReason = (typeof REPLY_CLOSE_REASON_VALUES)[number];
export type LocalBridgeReplyDirection = (typeof REPLY_DIRECTION_VALUES)[number];

export interface LocalBridgeReplyRequestFrame extends LocalBridgeJsonObject {
  readonly kind: typeof REPLY_KIND;
  readonly requestId: string;
  readonly generation: number;
  readonly branchId: string;
  readonly leafId: string;
  readonly sourceRevision: number;
  readonly ttlSeconds: number;
  readonly text: string;
}

export interface LocalBridgeReplyReceiptFrame extends LocalBridgeJsonObject {
  readonly kind: typeof RECEIPT_KIND;
  readonly code: LocalBridgeReplyReceiptCode;
}

export interface LocalBridgeReplyCloseFrame extends LocalBridgeJsonObject {
  readonly kind: typeof REPLY_CLOSE_KIND;
  readonly reason: LocalBridgeReplyCloseReason;
}

export type LocalBridgeReplyFrame =
  | LocalBridgeReplyRequestFrame
  | LocalBridgeReplyReceiptFrame
  | LocalBridgeReplyCloseFrame;

export interface LocalBridgeReplyFrameSuccess<
  T extends LocalBridgeReplyFrame = LocalBridgeReplyFrame,
> {
  readonly ok: true;
  readonly frame: T;
}

export type LocalBridgeReplyFrameValidation = LocalBridgeReplyFrameSuccess | LocalBridgeFailure;

export interface LocalBridgeReplyHandshakeSuccess {
  readonly ok: true;
  readonly handshake: LocalBridgeReplyHandshake;
}

export type LocalBridgeReplyHandshakeResult = LocalBridgeReplyHandshakeSuccess | LocalBridgeFailure;

export interface LocalBridgeReplyForwarded {
  readonly ok: true;
  readonly nextState: LocalBridgeState;
  readonly request: LocalBridgeReplyRequestFrame;
  readonly outcome: "forwarded";
}

export interface LocalBridgeReplyDuplicate {
  readonly ok: true;
  readonly nextState: LocalBridgeState;
  readonly outcome: "duplicate";
}

export type LocalBridgeReplyRouteSuccess = LocalBridgeReplyForwarded | LocalBridgeReplyDuplicate;
export type LocalBridgeReplyRoute = LocalBridgeReplyRouteSuccess | LocalBridgeFailure;

export interface LocalBridgeReplySettlementSuccess {
  readonly ok: true;
  readonly nextState: LocalBridgeState;
  readonly receipt: LocalBridgeReplyReceiptFrame;
}

export type LocalBridgeReplySettlement = LocalBridgeReplySettlementSuccess | LocalBridgeFailure;

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
  readonly negotiatedMinor: number;
  readonly replyTextNegotiated: boolean;
  readonly replyChannelConnected: boolean;
  readonly replyInFlight: boolean;
  readonly replyInFlightDigest: string | null;
  readonly replyRequestDigests: readonly string[];
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

export interface LocalBridgeNormalizationResult {
  readonly ok: true;
  readonly value: LocalBridgeJsonValue;
}

export interface LocalBridgeNormalizationFailure {
  readonly ok: false;
}

export interface LocalBridgeOwnRecord {
  readonly [key: string]: unknown;
}

export type LocalBridgeNormalization =
  | LocalBridgeNormalizationResult
  | LocalBridgeNormalizationFailure;

export interface LocalBridgeNormalizationLimits {
  readonly maxDepth: number;
  readonly maxContainers: number;
  readonly maxCollection: number;
  readonly maxBytes: number;
}

export const DIRECT_NORMALIZATION_LIMITS: LocalBridgeNormalizationLimits = Object.freeze({
  maxDepth: LOCAL_BRIDGE_BOUNDS.maxDirectNormalizationDepth,
  maxContainers: LOCAL_BRIDGE_BOUNDS.maxDirectNormalizationContainers,
  maxCollection: LOCAL_BRIDGE_BOUNDS.maxDirectNormalizationCollection,
  maxBytes: LOCAL_BRIDGE_BOUNDS.maxDirectNormalizationBytes,
});

export const RETAINED_NORMALIZATION_LIMITS: LocalBridgeNormalizationLimits = Object.freeze({
  maxDepth: LOCAL_BRIDGE_BOUNDS.maxNormalizationDepth,
  maxContainers: LOCAL_BRIDGE_BOUNDS.maxNormalizationContainers,
  maxCollection: LOCAL_BRIDGE_BOUNDS.maxNormalizationCollection,
  maxBytes: LOCAL_BRIDGE_BOUNDS.maxNormalizationBytes,
});

export function failure(code: LocalBridgeErrorCode): LocalBridgeFailure {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code }),
  });
}

export function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

export function isJsonObject(value: unknown): value is LocalBridgeJsonObject {
  return isObject(value) && !Array.isArray(value);
}

export function freezeJson<T extends LocalBridgeJsonValue>(value: T): T {
  if (isObject(value)) {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

export function normalizeJson(
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

export function normalizeObject(
  input: unknown,
  limits: LocalBridgeNormalizationLimits,
): LocalBridgeJsonObject | undefined {
  const normalized = normalizeJson(input, limits);
  return normalized.ok && isJsonObject(normalized.value) ? normalized.value : undefined;
}

export function hasOnlyKeys(value: LocalBridgeJsonObject, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return (
    Object.keys(value).every((key) => allowed.has(key)) &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

export function hasOptionalOnlyKeys(
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

export function field(value: LocalBridgeJsonObject, key: string): LocalBridgeJsonValue | undefined {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

export function boundedString(value: unknown, maxCharacters: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxCharacters)
    return undefined;
  if (Buffer.byteLength(value, "utf8") > maxCharacters * 4) return undefined;
  return value;
}

export function characterLength(value: string): number {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}

export function v1Identity(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    characterLength(value) <= SESSION_MIRROR_BOUNDS.maxIdentityCharacters
    ? value
    : undefined;
}

export function v1Cursor(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    characterLength(value) <= SESSION_MIRROR_BOUNDS.maxCursorCharacters
    ? value
    : undefined;
}

export function v1Revision(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function boundedUtf8String(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return Buffer.byteLength(value, "utf8") <= maxBytes ? value : undefined;
}

// LocalBridge outer identities must be well-formed Unicode scalar sequences;
// retained session-mirror/v1 values are validated separately.
export function isWellFormedUnicode(value: string): boolean {
  return value.isWellFormed();
}

export function identity(value: unknown): string | undefined {
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

export function token(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length !== LOCAL_BRIDGE_BOUNDS.maxTokenCharacters) {
    return undefined;
  }
  return TOKEN_PATTERN.test(value) ? value : undefined;
}

export function sourceInstanceId(value: unknown): string | undefined {
  if (typeof value !== "string" || !SOURCE_INSTANCE_PATTERN.test(value)) return undefined;
  return value;
}

export function uint(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" &&
    !Object.is(value, -0) &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
    ? value
    : undefined;
}

export function incrementActivityGeneration(value: number): number | undefined {
  return value < LOCAL_BRIDGE_BOUNDS.maxActivityGeneration ? value + 1 : undefined;
}

export function protocol(
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
    Object.is(minor, -0) ||
    minor < 0 ||
    minor > LOCAL_BRIDGE_REPLY_MINOR
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

export type LocalBridgeCapabilityListResult =
  | { readonly ok: true; readonly capabilities: readonly string[] }
  | { readonly ok: false; readonly code: "malformed-frame" | "incompatible-capability" };

export function capabilityList(
  value: unknown,
  negotiatedMinor: number,
): LocalBridgeCapabilityListResult {
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
  if (values.includes(REPLY_TEXT_CAPABILITY) && negotiatedMinor < LOCAL_BRIDGE_REPLY_MINOR) {
    return { ok: false, code: "incompatible-capability" };
  }
  return { ok: true, capabilities: Object.freeze(values) };
}

export function serializedByteLength(value: LocalBridgeJsonValue): number | undefined {
  try {
    const raw = JSON.stringify(value);
    return raw === undefined ? undefined : Buffer.byteLength(raw, "utf8");
  } catch {
    return undefined;
  }
}

export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function copyBytes(input: unknown): Uint8Array | undefined {
  try {
    if (!(input instanceof Uint8Array)) return undefined;
    return Uint8Array.prototype.slice.call(input) as Uint8Array;
  } catch {
    return undefined;
  }
}

export function parseJsonText(
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

export interface LocalBridgeControlBodySuccess {
  readonly ok: true;
  readonly value: LocalBridgeJsonObject;
}

export type LocalBridgeControlBodyResult = LocalBridgeControlBodySuccess | LocalBridgeFailure;

export function parseControlBody(body: Uint8Array): LocalBridgeControlBodyResult {
  if (body.byteLength > LOCAL_BRIDGE_BOUNDS.maxControlFrameBytes) {
    return failure("control-frame-too-large");
  }
  const raw = decodeUtf8(body);
  if (raw === undefined) return failure("invalid-utf8");
  const parsed = parseJsonText(raw, LOCAL_BRIDGE_BOUNDS.maxControlFrameBytes);
  return parsed.ok ? { ok: true, value: parsed.value } : parsed;
}

const REQUIRED_CAPABILITIES = [
  "session-tree",
  "completed-turns-only",
  "snapshot",
  "cursor-recovery",
  "custom-entries",
  "coarse-status",
] as const;

const REQUIRED_EVENT_TYPES = new Set([
  "turn.completed",
  "active-leaf.changed",
  "status.changed",
  "summary.updated",
  "session.compacted",
]);
const KNOWN_ENTRY_KINDS = new Set([
  "user-turn",
  "assistant-turn",
  "summary",
  "compaction",
  "source-placeholder",
]);
const SOURCE_PLACEHOLDER_TYPES = ["tool", "provider", "image", "custom", "unsupported"] as const;
const SOURCE_PLACEHOLDER_TYPE_SET = new Set<string>(SOURCE_PLACEHOLDER_TYPES);
const REMOVED_COMPACTION_FIELDS = new Set(["summaryEntryId", "compactedEntryIds"]);
const FORBIDDEN_STREAMING_CAPABILITIES = new Set([
  "assistant-streaming",
  "assistant-delta",
  "assistant-token",
]);
const FORBIDDEN_STREAMING_EVENT_TYPES = new Set([
  "assistant.delta",
  "assistant.token",
  "assistant.stream",
]);
const FORBIDDEN_STREAMING_KEYS = new Set(["delta", "token", "stream", "partial", "isPartial"]);
const COARSE_STATUSES = new Set(["idle", "active", "waiting", "error", "unknown"]);
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOP_LEVEL_MESSAGE_KEYS = new Set(["snapshot", "replacement", "event", "revision", "cursor"]);
const SEMANTIC_FAILURE_CATEGORIES = new Set([
  "forbidden-streaming",
  "incompatible-message-kind",
  "incomplete-turn",
]);

export const SESSION_MIRROR_BOUNDS = Object.freeze({
  maxEnvelopeBytes: 256 * 1024,
  maxTreeEntries: 1024,
  maxTreeDepth: 128,
  maxEntryPayloadBytes: 64 * 1024,
  maxTextBytes: 32 * 1024,
  maxIdentityCharacters: 128,
  maxCursorCharacters: 256,
  maxSeenMessages: 64,
  maxNormalizationDepth: 512,
  maxNormalizationContainers: 10_000,
  maxNormalizationBytes: 4 * 256 * 1024,
});

const NORMALIZATION_MAX_DEPTH = SESSION_MIRROR_BOUNDS.maxNormalizationDepth;
const NORMALIZATION_MAX_CONTAINERS = SESSION_MIRROR_BOUNDS.maxNormalizationContainers;
const NORMALIZATION_MAX_BYTES = SESSION_MIRROR_BOUNDS.maxNormalizationBytes;

export const SESSION_MIRROR_FAILURE_CATEGORIES = Object.freeze([
  "malformed-envelope",
  "bounds-exceeded",
  "incompatible-protocol",
  "incompatible-capability",
  "forbidden-streaming",
  "incompatible-message-kind",
  "incomplete-turn",
  "conflicting-duplicate",
  "revision-gap",
] as const);

export type SessionMirrorFailureCategory = (typeof SESSION_MIRROR_FAILURE_CATEGORIES)[number];

export type SessionMirrorDiagnosticCode =
  | "invalid-json"
  | "invalid-input"
  | "invalid-shape"
  | "invalid-value"
  | "envelope-bounds"
  | "structure-bounds"
  | "tree-bounds"
  | "payload-bounds"
  | "text-bounds"
  | "identity-bounds"
  | "protocol-incompatible"
  | "capability-incompatible"
  | "streaming-forbidden"
  | "message-kind-incompatible"
  | "turn-incomplete"
  | "duplicate-conflict"
  | "revision-gap"
  | "session-mismatch"
  | "state-invalid"
  | "snapshot-required";

export type SessionMirrorJsonPrimitive = string | number | boolean | null;
export type SessionMirrorJsonValue =
  | SessionMirrorJsonPrimitive
  | SessionMirrorJsonObject
  | readonly SessionMirrorJsonValue[];

export interface SessionMirrorJsonObject {
  readonly [key: string]: SessionMirrorJsonValue;
}

export interface SessionMirrorProtocolVersion extends SessionMirrorJsonObject {
  readonly family: string;
  readonly major: number;
  readonly minor: number;
}

export interface SessionMirrorSource extends SessionMirrorJsonObject {
  readonly runtimeVersion: string;
  readonly sessionSchemaVersion: string;
}

export interface SessionMirrorTextContent extends SessionMirrorJsonObject {
  readonly format: "text";
  readonly text: string;
}

export interface SessionMirrorTextPayload extends SessionMirrorJsonObject {
  readonly content: SessionMirrorTextContent;
}

export interface SessionMirrorCompactionPayload extends SessionMirrorJsonObject {
  readonly summary: string;
  readonly firstKeptEntryId: string;
}

export type SessionMirrorSourcePlaceholderType = (typeof SOURCE_PLACEHOLDER_TYPES)[number];

function isSourcePlaceholderType(value: string): value is SessionMirrorSourcePlaceholderType {
  return SOURCE_PLACEHOLDER_TYPE_SET.has(value);
}

export interface SessionMirrorSourcePlaceholderPayload extends SessionMirrorJsonObject {
  readonly sourceType: SessionMirrorSourcePlaceholderType;
}

export interface SessionMirrorSourcePlaceholderEntry extends SessionMirrorEntryFields {
  readonly kind: "source-placeholder";
  readonly status: "completed";
  readonly payload: SessionMirrorSourcePlaceholderPayload;
}

interface SessionMirrorEntryFields extends SessionMirrorJsonObject {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: string;
  readonly payload: SessionMirrorJsonObject;
}

export interface SessionMirrorUserTurnEntry extends SessionMirrorEntryFields {
  readonly kind: "user-turn";
  readonly status: "completed";
  readonly payload: SessionMirrorTextPayload;
}

export interface SessionMirrorAssistantTurnEntry extends SessionMirrorEntryFields {
  readonly kind: "assistant-turn";
  readonly status: "completed";
  readonly payload: SessionMirrorTextPayload;
}

export interface SessionMirrorSummaryEntry extends SessionMirrorEntryFields {
  readonly kind: "summary";
  readonly status: "completed";
  readonly payload: SessionMirrorTextPayload;
}

export interface SessionMirrorCompactionEntry extends SessionMirrorEntryFields {
  readonly kind: "compaction";
  readonly status: "completed";
  readonly payload: SessionMirrorCompactionPayload;
}

export type SessionMirrorKnownEntry =
  | SessionMirrorUserTurnEntry
  | SessionMirrorAssistantTurnEntry
  | SessionMirrorSummaryEntry
  | SessionMirrorCompactionEntry
  | SessionMirrorSourcePlaceholderEntry;

export type SessionMirrorCustomEntry = SessionMirrorEntryFields & {
  readonly kind: string;
  readonly status?: SessionMirrorJsonValue;
};

export type SessionMirrorEntry = SessionMirrorKnownEntry | SessionMirrorCustomEntry;

export interface SessionMirrorTree extends SessionMirrorJsonObject {
  readonly rootIds: readonly string[];
  readonly activeLeafId: string | null;
  readonly entries: readonly SessionMirrorEntry[];
}

export interface SessionMirrorSnapshot extends SessionMirrorJsonObject {
  readonly snapshotId: string;
  readonly status: SessionMirrorStatus;
  readonly tree: SessionMirrorTree;
}

export type SessionMirrorStatus = "idle" | "active" | "waiting" | "error" | "unknown";

function isCoarseStatus(value: string): value is SessionMirrorStatus {
  return COARSE_STATUSES.has(value);
}

export interface SessionMirrorReplacement extends SessionMirrorJsonObject {
  readonly snapshotId: string;
  readonly revision: number;
  readonly cursor: string;
}

interface SessionMirrorMessageFields extends SessionMirrorJsonObject {
  readonly eventId: string;
  readonly revision: number;
  readonly cursor: string;
}

export type SessionMirrorSnapshotMessage = SessionMirrorMessageFields & {
  readonly kind: "snapshot";
  readonly operation: "replace";
  readonly snapshot: SessionMirrorSnapshot;
  readonly replaces?: SessionMirrorReplacement;
};

export interface SessionMirrorTurnCompletedEvent extends SessionMirrorJsonObject {
  readonly type: "turn.completed";
  readonly entry: SessionMirrorUserTurnEntry | SessionMirrorAssistantTurnEntry;
}

export interface SessionMirrorActiveLeafChangedEvent extends SessionMirrorJsonObject {
  readonly type: "active-leaf.changed";
  readonly previousActiveLeafId: string | null;
  readonly activeLeafId: string | null;
}

export interface SessionMirrorStatusChangedEvent extends SessionMirrorJsonObject {
  readonly type: "status.changed";
  readonly status: SessionMirrorStatus;
}

export interface SessionMirrorSummaryUpdatedEvent extends SessionMirrorJsonObject {
  readonly type: "summary.updated";
  readonly entry: SessionMirrorSummaryEntry;
}

export interface SessionMirrorCompactedEvent extends SessionMirrorJsonObject {
  readonly type: "session.compacted";
  readonly entry: SessionMirrorCompactionEntry;
}

export type SessionMirrorEvent =
  | SessionMirrorTurnCompletedEvent
  | SessionMirrorActiveLeafChangedEvent
  | SessionMirrorStatusChangedEvent
  | SessionMirrorSummaryUpdatedEvent
  | SessionMirrorCompactedEvent;

export interface SessionMirrorEventMessage extends SessionMirrorMessageFields {
  readonly kind: "event";
  readonly operation: "append";
  readonly baseRevision: number;
  readonly event: SessionMirrorEvent;
}

export type SessionMirrorMessage = SessionMirrorSnapshotMessage | SessionMirrorEventMessage;

export interface SessionMirrorEnvelope extends SessionMirrorJsonObject {
  readonly protocol: SessionMirrorProtocolVersion;
  readonly source: SessionMirrorSource;
  readonly sessionId: string;
  readonly capabilities: readonly string[];
  readonly message: SessionMirrorMessage;
}

export interface SessionMirrorFailure {
  readonly category: SessionMirrorFailureCategory;
  readonly code: SessionMirrorDiagnosticCode;
  readonly path?: string;
}

export interface SessionMirrorValidationSuccess {
  readonly ok: true;
  readonly envelope: SessionMirrorEnvelope;
}

export interface SessionMirrorValidationFailure {
  readonly ok: false;
  readonly error: SessionMirrorFailure;
}

export type SessionMirrorValidationResult =
  | SessionMirrorValidationSuccess
  | SessionMirrorValidationFailure;

export interface SessionMirrorSeenMessage {
  readonly sessionId: string;
  readonly eventId: string;
  readonly canonical: string;
}

export interface SessionMirrorState {
  readonly sessionId: string | null;
  readonly revision: number;
  readonly cursor: string | null;
  readonly snapshotId: string | null;
  readonly seenMessages: readonly SessionMirrorSeenMessage[];
}

export type SessionMirrorApplyDisposition = "applied" | "duplicate";

export interface SessionMirrorApplySuccess {
  readonly ok: true;
  readonly envelope: SessionMirrorEnvelope;
  readonly nextState: SessionMirrorState;
  readonly disposition: SessionMirrorApplyDisposition;
}

export interface SessionMirrorApplyFailure {
  readonly ok: false;
  readonly error: SessionMirrorFailure;
}

export type SessionMirrorApplyResult = SessionMirrorApplySuccess | SessionMirrorApplyFailure;

type JsonRecord = Record<string, SessionMirrorJsonValue>;

type DecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SessionMirrorFailure };

type BoundCode =
  | "envelope-bounds"
  | "structure-bounds"
  | "tree-bounds"
  | "payload-bounds"
  | "text-bounds"
  | "identity-bounds";

interface BoundIssue {
  readonly code: BoundCode;
  readonly path: string;
}

interface DecodeContext {
  bounds?: BoundIssue;
  incompatibleCapability?: string;
  forbiddenStreaming?: string;
  incompatibleMessageKind?: string;
  incompleteTurn?: string;
}

interface NormalizationState {
  containers: number;
  normalizedBytes: number;
}

type NormalizationFailureReason = "invalid" | "budget";
type NormalizationResult =
  | { readonly ok: true; readonly value: SessionMirrorJsonValue }
  | { readonly ok: false; readonly reason: NormalizationFailureReason };

interface EntryCandidate {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: string;
  readonly payload: SessionMirrorJsonObject;
  readonly entry?: SessionMirrorEntry;
  readonly deferredError?: SessionMirrorFailure;
}

interface TreeNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly entry?: SessionMirrorEntry;
  readonly deferredError?: SessionMirrorFailure;
}

function failure(
  category: SessionMirrorFailureCategory,
  code: SessionMirrorDiagnosticCode,
  path?: string,
): SessionMirrorValidationFailure {
  const error: SessionMirrorFailure = path
    ? { category, code, path: boundedPath(path) }
    : { category, code };
  return { ok: false, error: Object.freeze(error) };
}

function decodeMalformed<T>(path: string): DecodeResult<T> {
  return { ok: false, error: { category: "malformed-envelope", code: "invalid-shape", path } };
}

function semanticFailure(
  category: "forbidden-streaming" | "incompatible-message-kind" | "incomplete-turn",
  code: "streaming-forbidden" | "message-kind-incompatible" | "turn-incomplete",
  path: string,
): SessionMirrorFailure {
  return { category, code, path };
}

function decodeSemantic<T>(
  category: "forbidden-streaming" | "incompatible-message-kind" | "incomplete-turn",
  code: "streaming-forbidden" | "message-kind-incompatible" | "turn-incomplete",
  path: string,
): DecodeResult<T> {
  return { ok: false, error: semanticFailure(category, code, path) };
}

function boundedPath(path: string): string {
  return path.length <= 128 ? path : path.slice(0, 125) + "...";
}

function malformed(path: string): SessionMirrorValidationFailure {
  return failure("malformed-envelope", "invalid-shape", path);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function addNormalizationBytes(state: NormalizationState, bytes: number): boolean {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return false;
  if (state.normalizedBytes > NORMALIZATION_MAX_BYTES - bytes) return false;
  state.normalizedBytes += bytes;
  return true;
}

function addNormalizationContainer(state: NormalizationState): boolean {
  if (state.containers >= NORMALIZATION_MAX_CONTAINERS) return false;
  state.containers += 1;
  return true;
}

function normalizedPrimitiveBytes(value: null | string | number | boolean): number | undefined {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? undefined : Buffer.byteLength(serialized, "utf8");
}

function normalizeJsonValue(
  value: unknown,
  state: NormalizationState,
  active: WeakSet<object>,
  depth: number,
): NormalizationResult {
  if (depth > NORMALIZATION_MAX_DEPTH) return { ok: false, reason: "budget" };
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    const bytes = normalizedPrimitiveBytes(value);
    return bytes !== undefined && addNormalizationBytes(state, bytes)
      ? { ok: true, value }
      : { ok: false, reason: "budget" };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { ok: false, reason: "invalid" };
    const bytes = normalizedPrimitiveBytes(value);
    return bytes !== undefined && addNormalizationBytes(state, bytes)
      ? { ok: true, value }
      : { ok: false, reason: "budget" };
  }
  if (typeof value !== "object" || active.has(value)) {
    return { ok: false, reason: "invalid" };
  }
  if (!addNormalizationContainer(state)) return { ok: false, reason: "budget" };
  active.add(value);

  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1) return { ok: false, reason: "invalid" };
      if (!addNormalizationBytes(state, 2 + Math.max(0, value.length - 1))) {
        return { ok: false, reason: "budget" };
      }
      const output: SessionMirrorJsonValue[] = [];
      for (const key of keys) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^\d+$/.test(key)) {
          return { ok: false, reason: "invalid" };
        }
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) {
          return { ok: false, reason: "invalid" };
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          return { ok: false, reason: "invalid" };
        }
        const child = normalizeJsonValue(descriptor.value, state, active, depth + 1);
        if (!child.ok) return child;
        output[index] = child.value;
      }
      return { ok: true, value: output };
    }

    if (!isPlainObject(value)) return { ok: false, reason: "invalid" };
    const keys = Reflect.ownKeys(value);
    if (!addNormalizationBytes(state, 2 + Math.max(0, keys.length - 1))) {
      return { ok: false, reason: "budget" };
    }
    const output: JsonRecord = {};
    for (const key of keys) {
      if (typeof key !== "string") return { ok: false, reason: "invalid" };
      const serializedKey = JSON.stringify(key);
      if (
        serializedKey === undefined ||
        !addNormalizationBytes(state, Buffer.byteLength(serializedKey, "utf8") + 1)
      ) {
        return { ok: false, reason: "budget" };
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        return { ok: false, reason: "invalid" };
      }
      const child = normalizeJsonValue(descriptor.value, state, active, depth + 1);
      if (!child.ok) return child;
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: child.value,
        writable: true,
      });
    }
    return { ok: true, value: output };
  } catch {
    return { ok: false, reason: "invalid" };
  } finally {
    active.delete(value);
  }
}

function normalizeInput(input: unknown): NormalizationResult {
  return normalizeJsonValue(input, { containers: 0, normalizedBytes: 0 }, new WeakSet<object>(), 0);
}

function isJsonObject(value: SessionMirrorJsonValue | undefined): value is SessionMirrorJsonObject {
  return (
    value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
  );
}

function isJsonArray(
  value: SessionMirrorJsonValue | undefined,
): value is readonly SessionMirrorJsonValue[] {
  return Array.isArray(value);
}

function hasField(record: SessionMirrorJsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function field(record: SessionMirrorJsonObject, key: string): SessionMirrorJsonValue | undefined {
  return hasField(record, key) ? record[key] : undefined;
}

function requiredObject(
  record: SessionMirrorJsonObject,
  key: string,
  path: string,
): DecodeResult<SessionMirrorJsonObject> {
  const value = field(record, key);
  return isJsonObject(value) ? { ok: true, value } : decodeMalformed(`${path}.${key}`);
}

function requiredArray(
  record: SessionMirrorJsonObject,
  key: string,
  path: string,
): DecodeResult<readonly SessionMirrorJsonValue[]> {
  const value = field(record, key);
  return isJsonArray(value) ? { ok: true, value } : decodeMalformed(`${path}.${key}`);
}

function requiredString(
  record: SessionMirrorJsonObject,
  key: string,
  path: string,
  allowEmpty = false,
): DecodeResult<string> {
  const value = field(record, key);
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    return decodeMalformed(`${path}.${key}`);
  }
  return { ok: true, value };
}

function requiredRevision(
  record: SessionMirrorJsonObject,
  key: string,
  path: string,
): DecodeResult<number> {
  const value = field(record, key);
  if (!isNonNegativeInteger(value)) return decodeMalformed(`${path}.${key}`);
  return { ok: true, value };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function markBound(context: DecodeContext, code: BoundCode, path: string): void {
  if (!context.bounds) context.bounds = { code, path };
}

function rememberSemantic(context: DecodeContext, error: SessionMirrorFailure): void {
  if (error.category === "forbidden-streaming") {
    context.forbiddenStreaming ??= error.path ?? "$";
  } else if (error.category === "incompatible-message-kind") {
    context.incompatibleMessageKind ??= error.path ?? "$";
  } else if (error.category === "incomplete-turn") {
    context.incompleteTurn ??= error.path ?? "$";
  }
}

function isSemanticFailure(error: SessionMirrorFailure): boolean {
  return SEMANTIC_FAILURE_CATEGORIES.has(error.category);
}

function contextualFailure(context: DecodeContext): SessionMirrorValidationFailure | undefined {
  if (context.bounds) {
    return failure("bounds-exceeded", context.bounds.code, context.bounds.path);
  }
  if (context.incompatibleCapability) {
    return failure(
      "incompatible-capability",
      "capability-incompatible",
      context.incompatibleCapability,
    );
  }
  if (context.forbiddenStreaming) {
    return failure("forbidden-streaming", "streaming-forbidden", context.forbiddenStreaming);
  }
  if (context.incompatibleMessageKind) {
    return failure(
      "incompatible-message-kind",
      "message-kind-incompatible",
      context.incompatibleMessageKind,
    );
  }
  if (context.incompleteTurn) {
    return failure("incomplete-turn", "turn-incomplete", context.incompleteTurn);
  }
  return undefined;
}

function characterLength(value: string): number {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}

function trackIdentityBound(context: DecodeContext, value: string, path: string): void {
  if (characterLength(value) > SESSION_MIRROR_BOUNDS.maxIdentityCharacters) {
    markBound(context, "identity-bounds", path);
  }
}

function trackCursorBound(context: DecodeContext, value: string, path: string): void {
  if (characterLength(value) > SESSION_MIRROR_BOUNDS.maxCursorCharacters) {
    markBound(context, "identity-bounds", path);
  }
}

function trackPayloadBound(
  context: DecodeContext,
  payload: SessionMirrorJsonObject,
  path: string,
): void {
  const serialized = JSON.stringify(payload);
  if (
    serialized !== undefined &&
    Buffer.byteLength(serialized, "utf8") > SESSION_MIRROR_BOUNDS.maxEntryPayloadBytes
  ) {
    markBound(context, "payload-bounds", path);
  }
}

function trackTextBound(context: DecodeContext, value: string, path: string): void {
  if (Buffer.byteLength(value, "utf8") > SESSION_MIRROR_BOUNDS.maxTextBytes) {
    markBound(context, "text-bounds", path);
  }
}

function isReservedStreamingMarker(key: string, value: SessionMirrorJsonValue): boolean {
  return FORBIDDEN_STREAMING_KEYS.has(key) || (key === "final" && value === false);
}

function containsForbiddenStreamingMarker(value: SessionMirrorJsonValue): boolean {
  if (Array.isArray(value)) return value.some((child) => containsForbiddenStreamingMarker(child));
  if (!isJsonObject(value)) return false;
  for (const key of Object.keys(value)) {
    const child = value[key];
    if (isReservedStreamingMarker(key, child) || containsForbiddenStreamingMarker(child))
      return true;
  }
  return false;
}

function scanAssistantPayloadSemanticSignals(
  entry: SessionMirrorJsonObject,
  path: string,
  context: DecodeContext,
): void {
  if (field(entry, "kind") !== "assistant-turn") return;
  const payload = field(entry, "payload");
  if (isJsonObject(payload) && containsForbiddenStreamingMarker(payload)) {
    context.forbiddenStreaming ??= path + ".payload.*";
  }
}

function scanEventSemanticSignals(
  event: SessionMirrorJsonObject,
  path: string,
  context: DecodeContext,
): void {
  const type = field(event, "type");
  if (typeof type === "string" && FORBIDDEN_STREAMING_EVENT_TYPES.has(type)) {
    context.forbiddenStreaming ??= path + ".type";
  }
  const entry = field(event, "entry");
  if (isJsonObject(entry)) scanAssistantPayloadSemanticSignals(entry, path + ".entry", context);
}

function scanSnapshotSemanticSignals(
  snapshot: SessionMirrorJsonObject,
  path: string,
  context: DecodeContext,
): void {
  const tree = field(snapshot, "tree");
  if (!isJsonObject(tree)) return;
  const entries = field(tree, "entries");
  if (!Array.isArray(entries)) return;
  for (const [index, value] of entries.entries()) {
    if (isJsonObject(value)) {
      scanAssistantPayloadSemanticSignals(value, `${path}.tree.entries[${index}]`, context);
    }
  }
}

function scanMessageSemanticSignals(
  message: SessionMirrorJsonObject,
  path: string,
  context: DecodeContext,
): void {
  const event = field(message, "event");
  if (isJsonObject(event)) scanEventSemanticSignals(event, path + ".event", context);
  const snapshot = field(message, "snapshot");
  if (isJsonObject(snapshot)) scanSnapshotSemanticSignals(snapshot, path + ".snapshot", context);
}

function copyOpenFields(
  record: SessionMirrorJsonObject,
  knownKeys: readonly string[],
): SessionMirrorJsonObject {
  const known = new Set(knownKeys);
  const output: JsonRecord = {};
  for (const key of Object.keys(record)) {
    if (known.has(key)) continue;
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      value: record[key],
      writable: true,
    });
  }
  return output;
}

function decodeProtocol(
  protocol: SessionMirrorJsonObject,
): DecodeResult<SessionMirrorProtocolVersion> {
  const family = requiredString(protocol, "family", "$.protocol");
  if (!family.ok) return family;
  const major = requiredRevision(protocol, "major", "$.protocol");
  if (!major.ok) return major;
  const minor = requiredRevision(protocol, "minor", "$.protocol");
  if (!minor.ok) return minor;
  return {
    ok: true,
    value: {
      ...copyOpenFields(protocol, ["family", "major", "minor"]),
      family: family.value,
      major: major.value,
      minor: minor.value,
    },
  };
}

function decodeSource(source: SessionMirrorJsonObject): DecodeResult<SessionMirrorSource> {
  const runtimeVersion = requiredString(source, "runtimeVersion", "$.source");
  if (!runtimeVersion.ok) return runtimeVersion;
  const sessionSchemaVersion = requiredString(source, "sessionSchemaVersion", "$.source");
  if (!sessionSchemaVersion.ok) return sessionSchemaVersion;
  return {
    ok: true,
    value: {
      ...copyOpenFields(source, ["runtimeVersion", "sessionSchemaVersion"]),
      runtimeVersion: runtimeVersion.value,
      sessionSchemaVersion: sessionSchemaVersion.value,
    },
  };
}

function decodeCapabilities(
  root: SessionMirrorJsonObject,
  context: DecodeContext,
): DecodeResult<readonly string[]> {
  const capabilities = requiredArray(root, "capabilities", "$");
  if (!capabilities.ok) return capabilities;
  const values: string[] = [];
  const seen = new Set<string>();
  for (const [index, value] of capabilities.value.entries()) {
    if (typeof value !== "string" || !KEBAB_CASE.test(value)) {
      return decodeMalformed(`$.capabilities[${index}]`);
    }
    if (seen.has(value)) return decodeMalformed(`$.capabilities[${index}]`);
    seen.add(value);
    values.push(value);
  }
  for (const [index, required] of REQUIRED_CAPABILITIES.entries()) {
    if (values[index] !== required) {
      context.incompatibleCapability ??= "$.capabilities";
      break;
    }
  }
  for (const capability of values) {
    if (FORBIDDEN_STREAMING_CAPABILITIES.has(capability)) {
      context.forbiddenStreaming ??= "$.capabilities";
    }
  }
  return { ok: true, value: values };
}

function decodeTextPayload(
  payload: SessionMirrorJsonObject,
  path: string,
  context: DecodeContext,
  closedContent: boolean,
): DecodeResult<SessionMirrorTextPayload> {
  if (closedContent && containsForbiddenStreamingMarker(payload)) {
    context.forbiddenStreaming ??= path;
  }

  const content = field(payload, "content");
  if (content === undefined) {
    return decodeSemantic("incomplete-turn", "turn-incomplete", path + ".content");
  }
  if (!isJsonObject(content)) return decodeMalformed(path + ".content");
  const format = field(content, "format");
  const text = field(content, "text");
  if (format === undefined || text === undefined) {
    if (format !== undefined && typeof format !== "string") {
      return decodeMalformed(path + ".content.format");
    }
    if (text !== undefined && typeof text !== "string") {
      return decodeMalformed(path + ".content.text");
    }
    return decodeSemantic("incomplete-turn", "turn-incomplete", path + ".content");
  }
  if (typeof format !== "string") return decodeMalformed(path + ".content.format");
  if (typeof text !== "string") return decodeMalformed(path + ".content.text");
  if (format !== "text") return decodeMalformed(path + ".content.format");

  for (const key of Object.keys(content)) {
    if (key === "format" || key === "text") continue;
    const child = content[key];
    if (closedContent) {
      if (isReservedStreamingMarker(key, child)) {
        context.forbiddenStreaming ??= path + ".content.*";
        continue;
      }
      return decodeMalformed(path + ".content.*");
    }
  }
  const builtContent: SessionMirrorTextContent = {
    ...copyOpenFields(content, ["format", "text"]),
    format: "text",
    text,
  };
  return {
    ok: true,
    value: {
      ...copyOpenFields(payload, ["content"]),
      content: builtContent,
    },
  };
}

function decodeCompactionPayload(
  payload: SessionMirrorJsonObject,
  path: string,
): DecodeResult<SessionMirrorCompactionPayload> {
  for (const key of REMOVED_COMPACTION_FIELDS) {
    if (hasField(payload, key)) return decodeMalformed(path + ".*");
  }
  const summary = requiredString(payload, "summary", path, true);
  if (!summary.ok) return summary;
  const firstKeptEntryId = requiredString(payload, "firstKeptEntryId", path);
  if (!firstKeptEntryId.ok) return firstKeptEntryId;
  return {
    ok: true,
    value: {
      ...copyOpenFields(payload, ["summary", "firstKeptEntryId"]),
      summary: summary.value,
      firstKeptEntryId: firstKeptEntryId.value,
    },
  };
}

function decodeSourcePlaceholderPayload(
  payload: SessionMirrorJsonObject,
  path: string,
): DecodeResult<SessionMirrorSourcePlaceholderPayload> {
  for (const key of Object.keys(payload)) {
    if (key !== "sourceType") return decodeMalformed(path + ".*");
  }
  const sourceType = requiredString(payload, "sourceType", path);
  if (!sourceType.ok) return sourceType;
  if (!isSourcePlaceholderType(sourceType.value)) {
    return decodeMalformed(path + ".sourceType");
  }
  return {
    ok: true,
    value: { sourceType: sourceType.value },
  };
}

function decodeEntry(
  raw: SessionMirrorJsonObject,
  path: string,
  context: DecodeContext,
  expectedKinds?: readonly string[],
): DecodeResult<EntryCandidate> {
  const id = requiredString(raw, "id", path);
  if (!id.ok) return id;

  const parentValue = field(raw, "parentId");
  if (!(parentValue === null || (typeof parentValue === "string" && parentValue.length > 0))) {
    return decodeMalformed(path + ".parentId");
  }
  const parentId = parentValue;

  const kind = requiredString(raw, "kind", path);
  if (!kind.ok) return kind;

  const payload = requiredObject(raw, "payload", path);
  if (!payload.ok) return payload;

  const base: EntryCandidate = {
    id: id.value,
    parentId,
    kind: kind.value,
    payload: payload.value,
  };
  let deferredError: SessionMirrorFailure | undefined;
  if (expectedKinds && !expectedKinds.includes(kind.value)) {
    deferredError = {
      category: "incompatible-message-kind",
      code: "message-kind-incompatible",
      path: path + ".kind",
    };
    rememberSemantic(context, deferredError);
  }

  if (!KNOWN_ENTRY_KINDS.has(kind.value)) {
    const customBase = {
      ...copyOpenFields(raw, ["id", "parentId", "kind", "payload"]),
      id: id.value,
      parentId,
      kind: kind.value,
      payload: payload.value,
    };
    if (hasField(raw, "status")) {
      const status = field(raw, "status");
      if (status === undefined) return decodeMalformed(path + ".status");
      const custom: SessionMirrorCustomEntry = { ...customBase, status };
      return {
        ok: true,
        value: { ...base, entry: custom, deferredError },
      };
    }
    return {
      ok: true,
      value: { ...base, entry: customBase, deferredError },
    };
  }

  if (kind.value === "source-placeholder") {
    for (const key of Object.keys(raw)) {
      if (!["id", "parentId", "kind", "status", "payload"].includes(key)) {
        return decodeMalformed(path + ".*");
      }
    }
    const status = field(raw, "status");
    if (status !== undefined && typeof status !== "string") {
      return decodeMalformed(path + ".status");
    }
    const decoded = decodeSourcePlaceholderPayload(payload.value, path + ".payload");
    if (!decoded.ok) return decoded;
    const candidateBase: EntryCandidate = {
      ...base,
      payload: decoded.value,
    };
    if (status !== "completed") {
      const error = semanticFailure("incomplete-turn", "turn-incomplete", path + ".status");
      rememberSemantic(context, error);
      return {
        ok: true,
        value: { ...candidateBase, deferredError: deferredError ?? error },
      };
    }
    const entry: SessionMirrorSourcePlaceholderEntry = {
      id: id.value,
      parentId,
      kind: "source-placeholder",
      status: "completed",
      payload: decoded.value,
    };
    return { ok: true, value: { ...candidateBase, entry, deferredError } };
  }

  const status = field(raw, "status");
  if (status !== undefined && typeof status !== "string") {
    return decodeMalformed(path + ".status");
  }
  const statusComplete = status === "completed";
  const openFields = copyOpenFields(raw, ["id", "parentId", "kind", "status", "payload"]);

  if (kind.value === "compaction") {
    const decoded = decodeCompactionPayload(payload.value, path + ".payload");
    if (!decoded.ok) return decoded;
    const candidateBase: EntryCandidate = {
      ...base,
      payload: decoded.value,
    };
    if (!statusComplete) {
      const error = semanticFailure("incomplete-turn", "turn-incomplete", path + ".status");
      rememberSemantic(context, error);
      return {
        ok: true,
        value: { ...candidateBase, deferredError: deferredError ?? error },
      };
    }
    const entry: SessionMirrorCompactionEntry = {
      ...openFields,
      id: id.value,
      parentId,
      kind: "compaction",
      status: "completed",
      payload: decoded.value,
    };
    return { ok: true, value: { ...candidateBase, entry, deferredError } };
  }

  const decoded = decodeTextPayload(
    payload.value,
    path + ".payload",
    context,
    kind.value === "assistant-turn",
  );
  if (!decoded.ok) {
    const error = decoded.error;
    if (!isSemanticFailure(error)) return decoded;
    rememberSemantic(context, error);
    return {
      ok: true,
      value: { ...base, deferredError: deferredError ?? error },
    };
  }
  const candidateBase: EntryCandidate = {
    ...base,
    payload: decoded.value,
  };
  if (!statusComplete) {
    const error = semanticFailure("incomplete-turn", "turn-incomplete", path + ".status");
    rememberSemantic(context, error);
    return {
      ok: true,
      value: { ...candidateBase, deferredError: deferredError ?? error },
    };
  }
  if (kind.value === "user-turn") {
    const entry: SessionMirrorUserTurnEntry = {
      ...openFields,
      id: id.value,
      parentId,
      kind: "user-turn",
      status: "completed",
      payload: decoded.value,
    };
    return { ok: true, value: { ...candidateBase, entry, deferredError } };
  }
  if (kind.value === "assistant-turn") {
    const entry: SessionMirrorAssistantTurnEntry = {
      ...openFields,
      id: id.value,
      parentId,
      kind: "assistant-turn",
      status: "completed",
      payload: decoded.value,
    };
    return { ok: true, value: { ...candidateBase, entry, deferredError } };
  }
  const entry: SessionMirrorSummaryEntry = {
    ...openFields,
    id: id.value,
    parentId,
    kind: "summary",
    status: "completed",
    payload: decoded.value,
  };
  return { ok: true, value: { ...candidateBase, entry, deferredError } };
}

function decodeTree(
  tree: SessionMirrorJsonObject,
  path: string,
  context: DecodeContext,
): DecodeResult<SessionMirrorTree> {
  if (hasField(tree, "rootId")) return decodeMalformed(path + ".*");
  const rootIdsValue = requiredArray(tree, "rootIds", path);
  if (!rootIdsValue.ok) return rootIdsValue;
  const rootIds: string[] = [];
  const seenRootIds = new Set<string>();
  for (const [index, value] of rootIdsValue.value.entries()) {
    if (typeof value !== "string" || value.length === 0) {
      return decodeMalformed(`${path}.rootIds[${index}]`);
    }
    if (seenRootIds.has(value)) return decodeMalformed(`${path}.rootIds[${index}]`);
    seenRootIds.add(value);
    rootIds.push(value);
  }

  const activeLeafId = field(tree, "activeLeafId");
  if (!(activeLeafId === null || (typeof activeLeafId === "string" && activeLeafId.length > 0))) {
    return decodeMalformed(path + ".activeLeafId");
  }
  const entries = requiredArray(tree, "entries", path);
  if (!entries.ok) return entries;

  const nodes: TreeNode[] = [];
  const nodesById = new Map<string, TreeNode>();
  for (const [index, value] of entries.value.entries()) {
    if (!isJsonObject(value)) return decodeMalformed(`${path}.entries[${index}]`);
    const decoded = decodeEntry(value, `${path}.entries[${index}]`, context);
    if (!decoded.ok) return decoded;
    const candidate = decoded.value;
    if (candidate.deferredError) rememberSemantic(context, candidate.deferredError);
    const node: TreeNode = {
      id: candidate.id,
      parentId: candidate.parentId,
      entry: candidate.entry,
      deferredError: candidate.deferredError,
    };
    if (nodesById.has(node.id)) return decodeMalformed(`${path}.entries[${index}].id`);
    nodes.push(node);
    nodesById.set(node.id, node);
  }

  const empty = entries.value.length === 0;
  if (empty) {
    if (rootIds.length !== 0 || activeLeafId !== null) return decodeMalformed(path);
    return {
      ok: true,
      value: {
        ...copyOpenFields(tree, ["rootIds", "activeLeafId", "entries"]),
        rootIds: [],
        activeLeafId: null,
        entries: [],
      },
    };
  }

  const roots = nodes.filter((node) => node.parentId === null);
  if (rootIds.length !== roots.length) return decodeMalformed(path + ".rootIds");
  const rootsById = new Set(roots.map((node) => node.id));
  for (const [index, rootId] of rootIds.entries()) {
    if (!rootsById.has(rootId)) return decodeMalformed(`${path}.rootIds[${index}]`);
  }
  if (activeLeafId !== null && !nodesById.has(activeLeafId)) {
    return decodeMalformed(path + ".activeLeafId");
  }

  const childrenById = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    if (!nodesById.has(node.parentId)) return decodeMalformed(path + ".entries");
    const children = childrenById.get(node.parentId) ?? [];
    children.push(node.id);
    childrenById.set(node.parentId, children);
  }

  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  function depthOf(id: string): number | undefined {
    const known = depths.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return undefined;
    const node = nodesById.get(id);
    if (!node) return undefined;
    visiting.add(id);
    const depth = node.parentId === null ? 1 : depthOf(node.parentId);
    visiting.delete(id);
    if (depth === undefined) return undefined;
    const nextDepth = depth + (node.parentId === null ? 0 : 1);
    depths.set(id, nextDepth);
    return nextDepth;
  }

  for (const node of nodes) {
    const depth = depthOf(node.id);
    if (depth === undefined) return decodeMalformed(path + ".entries");
  }

  for (const [index, node] of nodes.entries()) {
    if (node.entry && isCompactionEntry(node.entry)) {
      if (!nodesById.has(node.entry.payload.firstKeptEntryId)) {
        return decodeMalformed(`${path}.entries[${index}].payload.firstKeptEntryId`);
      }
    }
  }

  const deferred = nodes.find((node) => node.deferredError)?.deferredError;
  if (deferred) return { ok: false, error: deferred };
  const decodedEntries: SessionMirrorEntry[] = [];
  for (const node of nodes) {
    if (!node.entry) return decodeMalformed(path + ".entries");
    decodedEntries.push(node.entry);
  }

  return {
    ok: true,
    value: {
      ...copyOpenFields(tree, ["rootIds", "activeLeafId", "entries"]),
      rootIds,
      activeLeafId,
      entries: decodedEntries,
    },
  };
}

function decodeSnapshot(
  snapshot: SessionMirrorJsonObject,
  path: string,
  context: DecodeContext,
): DecodeResult<SessionMirrorSnapshot> {
  const snapshotId = requiredString(snapshot, "snapshotId", path);
  if (!snapshotId.ok) return snapshotId;
  const status = requiredString(snapshot, "status", path);
  if (!status.ok) return status;
  if (!isCoarseStatus(status.value)) return decodeMalformed(path + ".status");
  const tree = requiredObject(snapshot, "tree", path);
  if (!tree.ok) return tree;
  const decodedTree = decodeTree(tree.value, path + ".tree", context);
  if (!decodedTree.ok) return decodedTree;
  return {
    ok: true,
    value: {
      ...copyOpenFields(snapshot, ["snapshotId", "status", "tree"]),
      snapshotId: snapshotId.value,
      status: status.value,
      tree: decodedTree.value,
    },
  };
}

function decodeReplacement(
  replaces: SessionMirrorJsonObject,
  path: string,
): DecodeResult<SessionMirrorReplacement> {
  const snapshotId = requiredString(replaces, "snapshotId", path);
  if (!snapshotId.ok) return snapshotId;
  const revision = requiredRevision(replaces, "revision", path);
  if (!revision.ok) return revision;
  const cursor = requiredString(replaces, "cursor", path);
  if (!cursor.ok) return cursor;
  return {
    ok: true,
    value: {
      ...copyOpenFields(replaces, ["snapshotId", "revision", "cursor"]),
      snapshotId: snapshotId.value,
      revision: revision.value,
      cursor: cursor.value,
    },
  };
}

function isTurnEntry(
  entry: SessionMirrorEntry,
): entry is SessionMirrorUserTurnEntry | SessionMirrorAssistantTurnEntry {
  return entry.kind === "user-turn" || entry.kind === "assistant-turn";
}

function isSummaryEntry(entry: SessionMirrorEntry): entry is SessionMirrorSummaryEntry {
  return entry.kind === "summary" && entry.status === "completed";
}

function isCompactionEntry(entry: SessionMirrorEntry): entry is SessionMirrorCompactionEntry {
  return entry.kind === "compaction" && entry.status === "completed";
}

function decodeEvent(
  event: SessionMirrorJsonObject,
  path: string,
  context: DecodeContext,
): DecodeResult<SessionMirrorEvent> {
  const type = requiredString(event, "type", path);
  if (!type.ok) return type;
  if (FORBIDDEN_STREAMING_EVENT_TYPES.has(type.value)) {
    return decodeSemantic("forbidden-streaming", "streaming-forbidden", path + ".type");
  }
  if (!REQUIRED_EVENT_TYPES.has(type.value)) {
    return decodeSemantic("incompatible-message-kind", "message-kind-incompatible", path + ".type");
  }

  if (type.value === "turn.completed") {
    const entry = requiredObject(event, "entry", path);
    if (!entry.ok) return entry;
    const decodedEntry = decodeEntry(entry.value, path + ".entry", context, [
      "user-turn",
      "assistant-turn",
    ]);
    if (!decodedEntry.ok) return decodedEntry;
    const candidate = decodedEntry.value;
    const entryValue = candidate.entry;
    if (!entryValue || !isTurnEntry(entryValue)) {
      const error =
        candidate.deferredError ??
        semanticFailure(
          "incompatible-message-kind",
          "message-kind-incompatible",
          path + ".entry.kind",
        );
      rememberSemantic(context, error);
      return { ok: false, error };
    }
    if (candidate.deferredError) return { ok: false, error: candidate.deferredError };
    const built: SessionMirrorTurnCompletedEvent = {
      ...copyOpenFields(event, ["type", "entry"]),
      type: "turn.completed",
      entry: entryValue,
    };
    return { ok: true, value: built };
  }

  if (type.value === "active-leaf.changed") {
    const previousActiveLeafId = field(event, "previousActiveLeafId");
    if (
      !(
        previousActiveLeafId === null ||
        (typeof previousActiveLeafId === "string" && previousActiveLeafId.length > 0)
      )
    ) {
      return decodeMalformed(path + ".previousActiveLeafId");
    }
    const activeLeafId = field(event, "activeLeafId");
    if (!(activeLeafId === null || (typeof activeLeafId === "string" && activeLeafId.length > 0))) {
      return decodeMalformed(path + ".activeLeafId");
    }
    const built: SessionMirrorActiveLeafChangedEvent = {
      ...copyOpenFields(event, ["type", "previousActiveLeafId", "activeLeafId"]),
      type: "active-leaf.changed",
      previousActiveLeafId,
      activeLeafId,
    };
    return { ok: true, value: built };
  }

  if (type.value === "status.changed") {
    const status = requiredString(event, "status", path);
    if (!status.ok) return status;
    if (!isCoarseStatus(status.value)) return decodeMalformed(path + ".status");
    const built: SessionMirrorStatusChangedEvent = {
      ...copyOpenFields(event, ["type", "status"]),
      type: "status.changed",
      status: status.value,
    };
    return { ok: true, value: built };
  }

  if (type.value === "summary.updated") {
    const entry = requiredObject(event, "entry", path);
    if (!entry.ok) return entry;
    const decodedEntry = decodeEntry(entry.value, path + ".entry", context, ["summary"]);
    if (!decodedEntry.ok) return decodedEntry;
    const candidate = decodedEntry.value;
    const entryValue = candidate.entry;
    if (!entryValue || !isSummaryEntry(entryValue)) {
      const error =
        candidate.deferredError ??
        semanticFailure(
          "incompatible-message-kind",
          "message-kind-incompatible",
          path + ".entry.kind",
        );
      rememberSemantic(context, error);
      return { ok: false, error };
    }
    if (candidate.deferredError) return { ok: false, error: candidate.deferredError };
    const built: SessionMirrorSummaryUpdatedEvent = {
      ...copyOpenFields(event, ["type", "entry"]),
      type: "summary.updated",
      entry: entryValue,
    };
    return { ok: true, value: built };
  }

  if (hasField(event, "compactedEntryIds")) return decodeMalformed(path + ".*");
  const entry = requiredObject(event, "entry", path);
  if (!entry.ok) return entry;
  const decodedEntry = decodeEntry(entry.value, path + ".entry", context, ["compaction"]);
  if (!decodedEntry.ok) return decodedEntry;
  const candidate = decodedEntry.value;
  let builtEntry: SessionMirrorCompactionEntry | undefined;
  let deferredError = candidate.deferredError;
  if (candidate.entry && isCompactionEntry(candidate.entry)) {
    builtEntry = candidate.entry;
  } else if (candidate.kind !== "compaction") {
    const error = semanticFailure(
      "incompatible-message-kind",
      "message-kind-incompatible",
      path + ".entry.kind",
    );
    rememberSemantic(context, error);
    deferredError ??= error;
  }

  if (deferredError) return { ok: false, error: deferredError };
  if (!builtEntry) return decodeMalformed(path + ".entry");
  const built: SessionMirrorCompactedEvent = {
    ...copyOpenFields(event, ["type", "entry"]),
    type: "session.compacted",
    entry: builtEntry,
  };
  return { ok: true, value: built };
}

function decodeMessage(
  message: SessionMirrorJsonObject,
  context: DecodeContext,
): DecodeResult<SessionMirrorMessage> {
  const kind = requiredString(message, "kind", "$.message");
  if (!kind.ok) return kind;
  const eventId = requiredString(message, "eventId", "$.message");
  if (!eventId.ok) return eventId;
  const revision = requiredRevision(message, "revision", "$.message");
  if (!revision.ok) return revision;
  const cursor = requiredString(message, "cursor", "$.message");
  if (!cursor.ok) return cursor;
  const operation = requiredString(message, "operation", "$.message");
  if (!operation.ok) return operation;

  scanMessageSemanticSignals(message, "$.message", context);
  if (kind.value !== "snapshot" && kind.value !== "event") {
    return decodeSemantic(
      "incompatible-message-kind",
      "message-kind-incompatible",
      "$.message.kind",
    );
  }

  if (kind.value === "snapshot") {
    if (operation.value !== "replace") return decodeMalformed("$.message.operation");
    if (hasField(message, "event") || hasField(message, "baseRevision")) {
      return decodeMalformed("$.message");
    }
    const snapshot = requiredObject(message, "snapshot", "$.message");
    if (!snapshot.ok) return snapshot;
    const decodedSnapshot = decodeSnapshot(snapshot.value, "$.message.snapshot", context);
    if (!decodedSnapshot.ok) return decodedSnapshot;
    let replaces: SessionMirrorReplacement | undefined;
    if (hasField(message, "replaces")) {
      const replacement = requiredObject(message, "replaces", "$.message");
      if (!replacement.ok) return replacement;
      const decodedReplacement = decodeReplacement(replacement.value, "$.message.replaces");
      if (!decodedReplacement.ok) return decodedReplacement;
      replaces = decodedReplacement.value;
    }
    const base: SessionMirrorSnapshotMessage = {
      ...copyOpenFields(message, [
        "kind",
        "eventId",
        "revision",
        "cursor",
        "operation",
        "snapshot",
        "replaces",
      ]),
      kind: "snapshot",
      eventId: eventId.value,
      revision: revision.value,
      cursor: cursor.value,
      operation: "replace",
      snapshot: decodedSnapshot.value,
    };
    return replaces === undefined
      ? { ok: true, value: base }
      : { ok: true, value: { ...base, replaces } };
  }

  if (operation.value !== "append") return decodeMalformed("$.message.operation");
  if (hasField(message, "snapshot") || hasField(message, "replaces")) {
    return decodeMalformed("$.message");
  }
  const baseRevision = requiredRevision(message, "baseRevision", "$.message");
  if (!baseRevision.ok) return baseRevision;
  if (baseRevision.value !== revision.value - 1) {
    return decodeMalformed("$.message.baseRevision");
  }
  const event = requiredObject(message, "event", "$.message");
  if (!event.ok) return event;
  const decodedEvent = decodeEvent(event.value, "$.message.event", context);
  if (!decodedEvent.ok) return decodedEvent;
  const built: SessionMirrorEventMessage = {
    ...copyOpenFields(message, [
      "kind",
      "eventId",
      "revision",
      "baseRevision",
      "cursor",
      "operation",
      "event",
    ]),
    kind: "event",
    eventId: eventId.value,
    revision: revision.value,
    baseRevision: baseRevision.value,
    cursor: cursor.value,
    operation: "append",
    event: decodedEvent.value,
  };
  return { ok: true, value: built };
}

function aggregateBound(
  root: SessionMirrorJsonObject,
  serializedByteLength: number | undefined,
): BoundIssue | undefined {
  if (serializedByteLength !== undefined) {
    return serializedByteLength > SESSION_MIRROR_BOUNDS.maxEnvelopeBytes
      ? { code: "envelope-bounds", path: "$" }
      : undefined;
  }
  const serialized = JSON.stringify(root);
  return serialized !== undefined &&
    Buffer.byteLength(serialized, "utf8") > SESSION_MIRROR_BOUNDS.maxEnvelopeBytes
    ? { code: "envelope-bounds", path: "$" }
    : undefined;
}

function scanRecognizedEntryBounds(
  entry: SessionMirrorJsonObject,
  path: string,
  context: DecodeContext,
): void {
  const id = field(entry, "id");
  if (typeof id === "string") trackIdentityBound(context, id, path + ".id");
  const parentId = field(entry, "parentId");
  if (typeof parentId === "string") trackIdentityBound(context, parentId, path + ".parentId");

  const payload = field(entry, "payload");
  if (!isJsonObject(payload)) return;
  trackPayloadBound(context, payload, path + ".payload");

  const kind = field(entry, "kind");
  if (typeof kind !== "string") return;
  if (kind === "user-turn" || kind === "assistant-turn" || kind === "summary") {
    const content = field(payload, "content");
    const text = isJsonObject(content) ? field(content, "text") : undefined;
    if (typeof text === "string") {
      trackTextBound(context, text, path + ".payload.content.text");
    }
  }
  if (kind === "compaction") {
    const summary = field(payload, "summary");
    if (typeof summary === "string") trackTextBound(context, summary, path + ".payload.summary");
    const firstKeptEntryId = field(payload, "firstKeptEntryId");
    if (typeof firstKeptEntryId === "string") {
      trackIdentityBound(context, firstKeptEntryId, path + ".payload.firstKeptEntryId");
    }
  }
}

function scanRecognizedTreeBounds(
  tree: SessionMirrorJsonObject,
  path: string,
  context: DecodeContext,
): void {
  const rootIds = field(tree, "rootIds");
  if (Array.isArray(rootIds)) {
    for (const [index, value] of rootIds.entries()) {
      if (typeof value === "string")
        trackIdentityBound(context, value, path + `.rootIds[${index}]`);
    }
  }
  const activeLeafId = field(tree, "activeLeafId");
  if (typeof activeLeafId === "string") {
    trackIdentityBound(context, activeLeafId, path + ".activeLeafId");
  }
  const entries = field(tree, "entries");
  if (!Array.isArray(entries)) return;
  if (entries.length > SESSION_MIRROR_BOUNDS.maxTreeEntries) {
    markBound(context, "tree-bounds", path + ".entries");
  }

  const parents = new Map<string, string | null>();
  for (const [index, value] of entries.entries()) {
    if (!isJsonObject(value)) continue;
    const entryPath = `${path}.entries[${index}]`;
    scanRecognizedEntryBounds(value, entryPath, context);
    const id = field(value, "id");
    const parentId = field(value, "parentId");
    if (
      typeof id === "string" &&
      (parentId === null || typeof parentId === "string") &&
      !parents.has(id)
    ) {
      parents.set(id, parentId);
    }
  }

  for (const id of parents.keys()) {
    const seen = new Set<string>();
    let current: string | null = id;
    let depth = 0;
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      const parent = parents.get(current);
      if (parent === undefined) break;
      depth += 1;
      if (depth > SESSION_MIRROR_BOUNDS.maxTreeDepth) {
        markBound(context, "tree-bounds", path + ".entries");
        break;
      }
      current = parent;
    }
  }
}

function scanRecognizedSnapshotBounds(
  snapshot: SessionMirrorJsonObject,
  path: string,
  context: DecodeContext,
): void {
  const snapshotId = field(snapshot, "snapshotId");
  if (typeof snapshotId === "string") trackIdentityBound(context, snapshotId, path + ".snapshotId");
  const tree = field(snapshot, "tree");
  if (isJsonObject(tree)) scanRecognizedTreeBounds(tree, path + ".tree", context);
}

function scanRecognizedReplacementBounds(
  replacement: SessionMirrorJsonObject,
  path: string,
  context: DecodeContext,
): void {
  const snapshotId = field(replacement, "snapshotId");
  if (typeof snapshotId === "string") trackIdentityBound(context, snapshotId, path + ".snapshotId");
  const cursor = field(replacement, "cursor");
  if (typeof cursor === "string") trackCursorBound(context, cursor, path + ".cursor");
}

function scanRecognizedEventBounds(
  event: SessionMirrorJsonObject,
  path: string,
  context: DecodeContext,
): void {
  const entry = field(event, "entry");
  if (isJsonObject(entry)) scanRecognizedEntryBounds(entry, path + ".entry", context);
  const type = field(event, "type");
  if (type === "active-leaf.changed") {
    const previous = field(event, "previousActiveLeafId");
    if (typeof previous === "string") {
      trackIdentityBound(context, previous, path + ".previousActiveLeafId");
    }
    const activeLeafId = field(event, "activeLeafId");
    if (typeof activeLeafId === "string") {
      trackIdentityBound(context, activeLeafId, path + ".activeLeafId");
    }
  }
}

function scanRecognizedMessageBounds(
  message: SessionMirrorJsonObject,
  path: string,
  context: DecodeContext,
): void {
  const eventId = field(message, "eventId");
  if (typeof eventId === "string") trackIdentityBound(context, eventId, path + ".eventId");
  const cursor = field(message, "cursor");
  if (typeof cursor === "string") trackCursorBound(context, cursor, path + ".cursor");

  const kind = field(message, "kind");
  const snapshot = field(message, "snapshot");
  if (kind === "snapshot" && isJsonObject(snapshot)) {
    scanRecognizedSnapshotBounds(snapshot, path + ".snapshot", context);
    const replaces = field(message, "replaces");
    if (isJsonObject(replaces)) {
      scanRecognizedReplacementBounds(replaces, path + ".replaces", context);
    }
    return;
  }

  const event = field(message, "event");
  if (kind === "event" && isJsonObject(event)) {
    scanRecognizedEventBounds(event, path + ".event", context);
    return;
  }

  // Unknown v1 discriminants may still wrap a recognizable v1 body. Inspect
  // only those schema-shaped locations, never arbitrary open metadata.
  if (isJsonObject(event)) scanRecognizedEventBounds(event, path + ".event", context);
  if (isJsonObject(snapshot)) {
    scanRecognizedSnapshotBounds(snapshot, path + ".snapshot", context);
    const replaces = field(message, "replaces");
    if (isJsonObject(replaces)) {
      scanRecognizedReplacementBounds(replaces, path + ".replaces", context);
    }
  }
}

function scanV1Bounds(root: SessionMirrorJsonObject, context: DecodeContext): void {
  const sessionId = field(root, "sessionId");
  if (typeof sessionId === "string") trackIdentityBound(context, sessionId, "$.sessionId");
  const message = field(root, "message");
  if (isJsonObject(message)) scanRecognizedMessageBounds(message, "$.message", context);
}

function decodeEnvelope(
  root: SessionMirrorJsonObject,
  serializedByteLength: number | undefined,
): DecodeResult<SessionMirrorEnvelope> {
  const protocol = requiredObject(root, "protocol", "$");
  if (!protocol.ok) return protocol;
  const decodedProtocol = decodeProtocol(protocol.value);
  if (!decodedProtocol.ok) return decodedProtocol;
  const context: DecodeContext = {};
  if (decodedProtocol.value.family !== "session-mirror" || decodedProtocol.value.major !== 1) {
    const aggregate = aggregateBound(root, serializedByteLength);
    if (aggregate) {
      return {
        ok: false,
        error: { category: "bounds-exceeded", code: aggregate.code, path: aggregate.path },
      };
    }
    return {
      ok: false,
      error: {
        category: "incompatible-protocol",
        code: "protocol-incompatible",
        path: "$.protocol",
      },
    };
  }

  for (const key of TOP_LEVEL_MESSAGE_KEYS) {
    if (hasField(root, key)) return decodeMalformed("$." + key);
  }

  const source = requiredObject(root, "source", "$");
  if (!source.ok) return source;
  const decodedSource = decodeSource(source.value);
  if (!decodedSource.ok) return decodedSource;

  const sessionId = requiredString(root, "sessionId", "$");
  if (!sessionId.ok) return sessionId;

  const capabilities = decodeCapabilities(root, context);
  if (!capabilities.ok) return capabilities;

  const message = requiredObject(root, "message", "$");
  if (!message.ok) return message;
  const decodedMessage = decodeMessage(message.value, context);
  if (!decodedMessage.ok) {
    if (!isSemanticFailure(decodedMessage.error)) return decodedMessage;
    rememberSemantic(context, decodedMessage.error);
  }

  const boundAfterBody = aggregateBound(root, serializedByteLength);
  if (boundAfterBody) {
    return {
      ok: false,
      error: {
        category: "bounds-exceeded",
        code: boundAfterBody.code,
        path: boundAfterBody.path,
      },
    };
  }
  scanV1Bounds(root, context);
  if (context.bounds) {
    return failure("bounds-exceeded", context.bounds.code, context.bounds.path);
  }
  const deferred = contextualFailure(context);
  if (deferred) return deferred;
  if (!decodedMessage.ok) return decodedMessage;

  const envelope: SessionMirrorEnvelope = {
    ...copyOpenFields(root, ["protocol", "source", "sessionId", "capabilities", "message"]),
    protocol: decodedProtocol.value,
    source: decodedSource.value,
    sessionId: sessionId.value,
    capabilities: capabilities.value,
    message: decodedMessage.value,
  };
  return { ok: true, value: envelope };
}

function validateParsedEnvelope(
  input: unknown,
  serializedByteLength: number | undefined,
): SessionMirrorValidationResult {
  const normalized = normalizeInput(input);
  if (!normalized.ok) {
    return normalized.reason === "budget"
      ? failure("bounds-exceeded", "structure-bounds", "$")
      : failure("malformed-envelope", "invalid-input");
  }
  if (!isJsonObject(normalized.value)) return malformed("$");
  const decoded = decodeEnvelope(normalized.value, serializedByteLength);
  return decoded.ok
    ? { ok: true, envelope: decoded.value }
    : failure(decoded.error.category, decoded.error.code, decoded.error.path);
}

export function validateSessionMirrorEnvelope(input: unknown): SessionMirrorValidationResult {
  try {
    return validateParsedEnvelope(input, undefined);
  } catch {
    return failure("malformed-envelope", "invalid-input");
  }
}

export function parseSessionMirrorJson(raw: string): SessionMirrorValidationResult {
  if (typeof raw !== "string") return failure("malformed-envelope", "invalid-input");
  const byteLength = Buffer.byteLength(raw, "utf8");
  if (byteLength > SESSION_MIRROR_BOUNDS.maxEnvelopeBytes) {
    return failure("bounds-exceeded", "envelope-bounds", "$");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failure("malformed-envelope", "invalid-json");
  }
  try {
    return validateParsedEnvelope(parsed, byteLength);
  } catch {
    return failure("malformed-envelope", "invalid-input");
  }
}

function canonicalJson(value: SessionMirrorJsonValue): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((child) => canonicalJson(child)).join(",")}]`;
  if (!isJsonObject(value)) return "null";
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function normativeMessage(envelope: SessionMirrorEnvelope): SessionMirrorJsonObject {
  const message = envelope.message;
  if (message.kind === "snapshot") {
    const value: JsonRecord = {
      kind: message.kind,
      eventId: message.eventId,
      revision: message.revision,
      cursor: message.cursor,
      operation: message.operation,
      snapshot: message.snapshot,
    };
    if (message.replaces !== undefined) value.replaces = message.replaces;
    return value;
  }
  return {
    kind: message.kind,
    eventId: message.eventId,
    revision: message.revision,
    baseRevision: message.baseRevision,
    cursor: message.cursor,
    operation: message.operation,
    event: message.event,
  };
}

function duplicateCanonical(envelope: SessionMirrorEnvelope): string {
  return canonicalJson({ sessionId: envelope.sessionId, message: normativeMessage(envelope) });
}

function freezeState(
  sessionId: string | null,
  revision: number,
  cursor: string | null,
  snapshotId: string | null,
  seenMessages: readonly SessionMirrorSeenMessage[],
): SessionMirrorState {
  const frozenMessages = Object.freeze(
    seenMessages.map((message) => Object.freeze({ ...message })),
  );
  return Object.freeze({ sessionId, revision, cursor, snapshotId, seenMessages: frozenMessages });
}

export function createSessionMirrorState(): SessionMirrorState {
  return freezeState(null, 0, null, null, []);
}

function isBoundedIdentity(value: unknown, allowNull: true): value is string | null;
function isBoundedIdentity(value: unknown, allowNull?: false): value is string;
function isBoundedIdentity(value: unknown, allowNull = false): boolean {
  return (
    (allowNull && value === null) ||
    (typeof value === "string" &&
      value.length > 0 &&
      characterLength(value) <= SESSION_MIRROR_BOUNDS.maxIdentityCharacters)
  );
}

function isBoundedCursor(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value.length > 0 &&
      characterLength(value) <= SESSION_MIRROR_BOUNDS.maxCursorCharacters)
  );
}

function ownEnumerableDataField(
  record: Record<string, unknown>,
  key: string,
): { readonly value: unknown } | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (
    !descriptor ||
    !descriptor.enumerable ||
    !Object.prototype.hasOwnProperty.call(descriptor, "value")
  ) {
    return undefined;
  }
  return { value: descriptor.value };
}

function ownArrayLength(value: readonly unknown[]): number | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return undefined;
  return isNonNegativeInteger(descriptor.value) ? descriptor.value : undefined;
}

function normalizeState(value: unknown): SessionMirrorState | undefined {
  if (!isPlainObject(value)) return undefined;
  const sessionIdField = ownEnumerableDataField(value, "sessionId");
  const revisionField = ownEnumerableDataField(value, "revision");
  const cursorField = ownEnumerableDataField(value, "cursor");
  const snapshotIdField = ownEnumerableDataField(value, "snapshotId");
  const seenMessagesField = ownEnumerableDataField(value, "seenMessages");
  if (!sessionIdField || !revisionField || !cursorField || !snapshotIdField || !seenMessagesField) {
    return undefined;
  }
  const sessionId = sessionIdField.value;
  const revision = revisionField.value;
  const cursor = cursorField.value;
  const snapshotId = snapshotIdField.value;
  const seenMessages = seenMessagesField.value;
  if (!isBoundedIdentity(sessionId, true)) return undefined;
  if (!isNonNegativeInteger(revision)) return undefined;
  if (!isBoundedCursor(cursor)) return undefined;
  if (!isBoundedIdentity(snapshotId, true)) return undefined;
  if (!Array.isArray(seenMessages)) return undefined;
  const seenLength = ownArrayLength(seenMessages);
  if (seenLength === undefined || seenLength > SESSION_MIRROR_BOUNDS.maxSeenMessages) {
    return undefined;
  }
  if (sessionId === null) {
    if (revision !== 0 || cursor !== null || snapshotId !== null || seenLength !== 0) {
      return undefined;
    }
  } else if (cursor === null || seenLength === 0) {
    return undefined;
  }

  const seen = new Set<string>();
  const normalizedSeen: SessionMirrorSeenMessage[] = [];
  for (let index = 0; index < seenLength; index += 1) {
    const itemDescriptor = Object.getOwnPropertyDescriptor(seenMessages, String(index));
    if (
      !itemDescriptor ||
      !itemDescriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(itemDescriptor, "value")
    ) {
      return undefined;
    }
    const item = itemDescriptor.value;
    if (!isPlainObject(item)) return undefined;
    const itemSessionIdField = ownEnumerableDataField(item, "sessionId");
    const eventIdField = ownEnumerableDataField(item, "eventId");
    const canonicalField = ownEnumerableDataField(item, "canonical");
    if (!itemSessionIdField || !eventIdField || !canonicalField) return undefined;
    const itemSessionId = itemSessionIdField.value;
    const eventId = eventIdField.value;
    const canonical = canonicalField.value;
    if (!isBoundedIdentity(itemSessionId)) return undefined;
    if (typeof eventId !== "string" || eventId.length === 0) return undefined;
    if (characterLength(eventId) > SESSION_MIRROR_BOUNDS.maxIdentityCharacters) return undefined;
    if (typeof canonical !== "string" || canonical.length === 0) return undefined;
    if (Buffer.byteLength(canonical, "utf8") > SESSION_MIRROR_BOUNDS.maxEnvelopeBytes) {
      return undefined;
    }
    if (sessionId !== null && itemSessionId !== sessionId) return undefined;
    const key = itemSessionId + "\u0000" + eventId;
    if (seen.has(key)) return undefined;
    seen.add(key);
    normalizedSeen.push({ sessionId: itemSessionId, eventId, canonical });
  }
  return freezeState(sessionId, revision, cursor, snapshotId, normalizedSeen);
}

function stateFailure(
  code: "state-invalid" | "session-mismatch",
  path: string,
): SessionMirrorApplyFailure {
  return {
    ok: false,
    error: Object.freeze({ category: "malformed-envelope", code, path }),
  };
}

function stateRetentionFailure(): SessionMirrorApplyFailure {
  return {
    ok: false,
    error: Object.freeze({
      category: "bounds-exceeded",
      code: "snapshot-required",
      path: "state.seenMessages",
    }),
  };
}

export function applySessionMirrorEnvelope(
  state: unknown,
  input: unknown,
): SessionMirrorApplyResult {
  try {
    const validation =
      typeof input === "string"
        ? parseSessionMirrorJson(input)
        : validateSessionMirrorEnvelope(input);
    if (!validation.ok) return validation;
    const usableState = normalizeState(state);
    if (!usableState) return stateFailure("state-invalid", "state");

    const envelope = validation.envelope;
    if (usableState.sessionId !== null && usableState.sessionId !== envelope.sessionId) {
      return stateFailure("session-mismatch", "sessionId");
    }

    const canonical = duplicateCanonical(envelope);
    const eventId = envelope.message.eventId;
    const seen = usableState.seenMessages.find(
      (message) => message.sessionId === envelope.sessionId && message.eventId === eventId,
    );
    if (seen) {
      if (seen.canonical !== canonical) {
        return {
          ok: false,
          error: Object.freeze({
            category: "conflicting-duplicate",
            code: "duplicate-conflict",
            path: "message.eventId",
          }),
        };
      }
      return {
        ok: true,
        envelope,
        nextState: usableState,
        disposition: "duplicate",
      };
    }

    if (
      envelope.message.kind === "event" &&
      (envelope.message.baseRevision !== usableState.revision ||
        envelope.message.revision !== usableState.revision + 1)
    ) {
      return {
        ok: false,
        error: Object.freeze({
          category: "revision-gap",
          code: "revision-gap",
          path: "message.revision",
        }),
      };
    }

    if (
      envelope.message.kind === "event" &&
      usableState.seenMessages.length >= SESSION_MIRROR_BOUNDS.maxSeenMessages
    ) {
      return stateRetentionFailure();
    }

    const seenMessages =
      envelope.message.kind === "snapshot"
        ? [{ sessionId: envelope.sessionId, eventId, canonical }]
        : [...usableState.seenMessages, { sessionId: envelope.sessionId, eventId, canonical }];
    const nextState = freezeState(
      envelope.sessionId,
      envelope.message.revision,
      envelope.message.cursor,
      envelope.message.kind === "snapshot"
        ? envelope.message.snapshot.snapshotId
        : usableState.snapshotId,
      seenMessages,
    );
    return { ok: true, envelope, nextState, disposition: "applied" };
  } catch {
    return stateFailure("state-invalid", "state");
  }
}

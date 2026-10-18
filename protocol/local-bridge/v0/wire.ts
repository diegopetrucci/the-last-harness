import { parseSessionMirrorJson } from "../../session-mirror/v1/conformance.ts";
import * as shared from "./shared.ts";

function checkSocketName(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > shared.LOCAL_BRIDGE_BOUNDS.maxSocketNameCharacters
  ) {
    return undefined;
  }
  return shared.SOCKET_NAME_PATTERN.test(value) ? value : undefined;
}

function validateProtocolEnvelope(
  input: unknown,
  invalidCode: shared.LocalBridgeErrorCode,
):
  | { readonly ok: true; readonly value: shared.LocalBridgeProtocolVersion }
  | shared.LocalBridgeFailure {
  const result = shared.protocol(input);
  if (!result.ok) {
    return result.code === "invalid-input"
      ? shared.failure(invalidCode)
      : shared.failure(result.code);
  }
  return { ok: true, value: result.version };
}

function validateRendezvousObject(input: unknown): shared.LocalBridgeRendezvousResult {
  const object = shared.normalizeObject(input, shared.DIRECT_NORMALIZATION_LIMITS);
  if (
    !object ||
    !shared.hasOnlyKeys(object, ["protocol", "installationId", "socketName", "launchToken"])
  ) {
    return shared.failure("malformed-rendezvous");
  }
  const byteLength = shared.serializedByteLength(object);
  if (byteLength === undefined) return shared.failure("malformed-rendezvous");
  if (byteLength > shared.LOCAL_BRIDGE_BOUNDS.maxRendezvousBytes)
    return shared.failure("unsafe-rendezvous");
  const parsedProtocol = validateProtocolEnvelope(
    shared.field(object, "protocol"),
    "malformed-rendezvous",
  );
  if (!parsedProtocol.ok) return parsedProtocol;
  if (parsedProtocol.value.minor !== shared.LOCAL_BRIDGE_DATA_MINOR) {
    return shared.failure("incompatible-protocol");
  }
  const installationId = shared.identity(shared.field(object, "installationId"));
  const socketName = checkSocketName(shared.field(object, "socketName"));
  const launchToken = shared.token(shared.field(object, "launchToken"));
  if (!installationId || !socketName || !launchToken) return shared.failure("malformed-rendezvous");
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

export function validateLocalBridgeRendezvous(input: unknown): shared.LocalBridgeRendezvousResult {
  try {
    return validateRendezvousObject(input);
  } catch {
    return shared.failure("malformed-rendezvous");
  }
}

export function parseLocalBridgeRendezvousJson(input: unknown): shared.LocalBridgeRendezvousResult {
  try {
    if (typeof input === "string") {
      const parsed = shared.parseJsonText(input, shared.LOCAL_BRIDGE_BOUNDS.maxRendezvousBytes);
      if (!parsed.ok) {
        return parsed.error.code === "control-frame-too-large"
          ? shared.failure("unsafe-rendezvous")
          : shared.failure("malformed-rendezvous");
      }
      return validateRendezvousObject(parsed.value);
    }
    return validateRendezvousObject(input);
  } catch {
    return shared.failure("malformed-rendezvous");
  }
}

function checkAbsoluteDirectoryPath(input: unknown): string | undefined {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    return undefined;
  }
  if (
    !input.startsWith("/") ||
    Buffer.byteLength(input, "utf8") > shared.LOCAL_BRIDGE_BOUNDS.maxSocketPathBytes
  ) {
    return undefined;
  }
  const components = input.split("/").slice(1);
  if (components.some((component) => component === "" || component === "." || component === "..")) {
    return undefined;
  }
  return input;
}

export function validateLocalBridgeDirectoryPath(
  input: unknown,
): shared.LocalBridgeDirectoryPathResult {
  try {
    const directory = checkAbsoluteDirectoryPath(input);
    return directory === undefined ? shared.failure("unsafe-rendezvous") : { ok: true, directory };
  } catch {
    return shared.failure("unsafe-rendezvous");
  }
}

function rendezvousValue(input: unknown): shared.LocalBridgeRendezvous | undefined {
  const direct = validateRendezvousObject(input);
  if (direct.ok) return direct.rendezvous;
  const object = shared.normalizeObject(input, shared.DIRECT_NORMALIZATION_LIMITS);
  if (
    !object ||
    !shared.hasOnlyKeys(object, ["ok", "rendezvous"]) ||
    shared.field(object, "ok") !== true
  ) {
    return undefined;
  }
  const result = validateRendezvousObject(shared.field(object, "rendezvous"));
  return result.ok ? result.rendezvous : undefined;
}

export function validateLocalBridgeSocketPath(
  input: unknown,
  companionDirectoryInput: unknown,
  rendezvousInput: unknown,
): shared.LocalBridgeSocketPathResult {
  try {
    const directory = checkAbsoluteDirectoryPath(companionDirectoryInput);
    const rendezvous = rendezvousValue(rendezvousInput);
    if (!directory || !rendezvous || typeof input !== "string") {
      return shared.failure("unsafe-rendezvous");
    }
    const expectedPath = `${directory}/${rendezvous.socketName}`;
    if (
      input !== expectedPath ||
      Buffer.byteLength(expectedPath, "utf8") > shared.LOCAL_BRIDGE_BOUNDS.maxSocketPathBytes
    ) {
      return shared.failure("unsafe-rendezvous");
    }
    return { ok: true, socketPath: input };
  } catch {
    return shared.failure("unsafe-rendezvous");
  }
}

function validateHandshakeObject(input: unknown): shared.LocalBridgeHandshakeResult {
  const object = shared.normalizeObject(input, shared.DIRECT_NORMALIZATION_LIMITS);
  const keys = [
    "kind",
    "protocol",
    "installationId",
    "sessionId",
    "sourceInstanceId",
    "launchToken",
    "capabilities",
  ] as const;
  if (!object || !shared.hasOnlyKeys(object, keys)) return shared.failure("malformed-frame");
  if (shared.field(object, "kind") !== shared.HANDSHAKE_KIND)
    return shared.failure("malformed-frame");
  const parsedProtocol = validateProtocolEnvelope(
    shared.field(object, "protocol"),
    "malformed-frame",
  );
  if (!parsedProtocol.ok) return parsedProtocol;
  if (parsedProtocol.value.minor !== shared.LOCAL_BRIDGE_DATA_MINOR) {
    return shared.failure("incompatible-protocol");
  }
  const installationId = shared.identity(shared.field(object, "installationId"));
  const sessionId = shared.identity(shared.field(object, "sessionId"));
  const sourceId = shared.sourceInstanceId(shared.field(object, "sourceInstanceId"));
  const launchToken = shared.token(shared.field(object, "launchToken"));
  const capabilities = shared.capabilityList(
    shared.field(object, "capabilities"),
    parsedProtocol.value.minor,
  );
  if (!installationId || !sessionId || !sourceId || !launchToken) {
    return shared.failure("malformed-frame");
  }
  if (!capabilities.ok) return shared.failure(capabilities.code);
  return {
    ok: true,
    handshake: Object.freeze({
      kind: shared.HANDSHAKE_KIND,
      protocol: parsedProtocol.value,
      installationId,
      sessionId,
      sourceInstanceId: sourceId,
      launchToken,
      capabilities: capabilities.capabilities,
    }),
  };
}

export function validateLocalBridgeHandshake(input: unknown): shared.LocalBridgeHandshakeResult {
  try {
    return validateHandshakeObject(input);
  } catch {
    return shared.failure("malformed-frame");
  }
}

export function decodeLengthPrefixedFrame(input: unknown): shared.LocalBridgeFrameResult {
  try {
    const bytes = shared.copyBytes(input);
    if (!bytes || bytes.byteLength < 4) return shared.failure("malformed-frame");
    const declaredLength = bytes[0] * 0x1000000 + bytes[1] * 0x10000 + bytes[2] * 0x100 + bytes[3];
    if (declaredLength > shared.LOCAL_BRIDGE_BOUNDS.maxFrameBodyBytes)
      return shared.failure("frame-too-large");
    if (bytes.byteLength !== declaredLength + 4) return shared.failure("malformed-frame");
    return { ok: true, body: bytes.slice(4) };
  } catch {
    return shared.failure("malformed-frame");
  }
}

export function encodeLengthPrefixedFrame(input: unknown): shared.LocalBridgeEncodedFrameResult {
  try {
    const body = shared.copyBytes(input);
    if (!body) return shared.failure("invalid-input");
    if (body.byteLength > shared.LOCAL_BRIDGE_BOUNDS.maxFrameBodyBytes)
      return shared.failure("frame-too-large");
    const frame = new Uint8Array(body.byteLength + 4);
    frame[0] = (body.byteLength >>> 24) & 0xff;
    frame[1] = (body.byteLength >>> 16) & 0xff;
    frame[2] = (body.byteLength >>> 8) & 0xff;
    frame[3] = body.byteLength & 0xff;
    frame.set(body, 4);
    return { ok: true, frame };
  } catch {
    return shared.failure("invalid-input");
  }
}

export function parseLocalBridgeHandshakeFrame(input: unknown): shared.LocalBridgeHandshakeResult {
  try {
    const decoded = decodeLengthPrefixedFrame(input);
    if (!decoded.ok) return decoded;
    const body = shared.parseControlBody(decoded.body);
    if (!body.ok) return body;
    return validateHandshakeObject(body.value);
  } catch {
    return shared.failure("malformed-frame");
  }
}

function replyTargetId(value: unknown): string | undefined {
  return shared.identity(value);
}

function replyRequestId(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > shared.LOCAL_BRIDGE_BOUNDS.maxReplyRequestIdCharacters * 2 ||
    shared.characterLength(value) > shared.LOCAL_BRIDGE_BOUNDS.maxReplyRequestIdCharacters ||
    !shared.isWellFormedUnicode(value)
  ) {
    return undefined;
  }
  return Buffer.byteLength(value, "utf8") <=
    shared.LOCAL_BRIDGE_BOUNDS.maxReplyRequestIdCharacters * 4
    ? value
    : undefined;
}

function isSafeReplyText(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      ((codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) &&
        codePoint !== 0x09 &&
        codePoint !== 0x0a) ||
      shared.REPLY_TEXT_FORMAT_OR_SEPARATOR.test(character)
    ) {
      return false;
    }
  }
  return !value.trimStart().startsWith("/");
}

function replyText(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !shared.isWellFormedUnicode(value) ||
    !isSafeReplyText(value)
  ) {
    return undefined;
  }
  return Buffer.byteLength(value, "utf8") <= shared.LOCAL_BRIDGE_BOUNDS.maxReplyTextBytes
    ? value
    : undefined;
}

function validateReplyRequestObject(input: unknown): shared.LocalBridgeReplyFrameValidation {
  const object = shared.normalizeObject(input, shared.DIRECT_NORMALIZATION_LIMITS);
  if (
    !object ||
    !shared.hasOnlyKeys(object, [
      "kind",
      "requestId",
      "generation",
      "branchId",
      "leafId",
      "sourceRevision",
      "ttlSeconds",
      "text",
    ])
  ) {
    return shared.failure("malformed-frame");
  }
  if (shared.field(object, "kind") !== shared.REPLY_KIND) return shared.failure("malformed-frame");
  const requestId = replyRequestId(shared.field(object, "requestId"));
  const generation = shared.uint(
    shared.field(object, "generation"),
    shared.LOCAL_BRIDGE_BOUNDS.maxActivityGeneration,
  );
  const branchId = replyTargetId(shared.field(object, "branchId"));
  const leafId = replyTargetId(shared.field(object, "leafId"));
  const sourceRevision = shared.uint(
    shared.field(object, "sourceRevision"),
    shared.LOCAL_BRIDGE_BOUNDS.maxBridgeRevision,
  );
  const ttlSeconds = shared.uint(
    shared.field(object, "ttlSeconds"),
    shared.LOCAL_BRIDGE_BOUNDS.maxReplyTtlSeconds,
  );
  const text = replyText(shared.field(object, "text"));
  if (
    !requestId ||
    generation === undefined ||
    !branchId ||
    !leafId ||
    sourceRevision === undefined ||
    ttlSeconds === undefined ||
    ttlSeconds < shared.LOCAL_BRIDGE_BOUNDS.minReplyTtlSeconds ||
    !text
  ) {
    return shared.failure("malformed-frame");
  }
  return {
    ok: true,
    frame: Object.freeze({
      kind: shared.REPLY_KIND,
      requestId,
      generation,
      branchId,
      leafId,
      sourceRevision,
      ttlSeconds,
      text,
    }),
  };
}

function validateReplyReceiptObject(input: unknown): shared.LocalBridgeReplyFrameValidation {
  const object = shared.normalizeObject(input, shared.DIRECT_NORMALIZATION_LIMITS);
  if (!object || !shared.hasOnlyKeys(object, ["kind", "code"]))
    return shared.failure("malformed-frame");
  if (shared.field(object, "kind") !== shared.RECEIPT_KIND)
    return shared.failure("malformed-frame");
  const code = shared.field(object, "code");
  if (
    typeof code !== "string" ||
    !shared.REPLY_RECEIPT_CODE_VALUES.includes(code as shared.LocalBridgeReplyReceiptCode)
  ) {
    return shared.failure("malformed-frame");
  }
  return {
    ok: true,
    frame: Object.freeze({
      kind: shared.RECEIPT_KIND,
      code: code as shared.LocalBridgeReplyReceiptCode,
    }),
  };
}

function validateReplyCloseObject(input: unknown): shared.LocalBridgeReplyFrameValidation {
  const object = shared.normalizeObject(input, shared.DIRECT_NORMALIZATION_LIMITS);
  if (!object || !shared.hasOnlyKeys(object, ["kind", "reason"]))
    return shared.failure("malformed-frame");
  if (shared.field(object, "kind") !== shared.REPLY_CLOSE_KIND)
    return shared.failure("malformed-frame");
  const reason = shared.field(object, "reason");
  if (
    typeof reason !== "string" ||
    !shared.REPLY_CLOSE_REASON_VALUES.includes(reason as shared.LocalBridgeReplyCloseReason)
  ) {
    return shared.failure("malformed-frame");
  }
  return {
    ok: true,
    frame: Object.freeze({
      kind: shared.REPLY_CLOSE_KIND,
      reason: reason as shared.LocalBridgeReplyCloseReason,
    }),
  };
}

export function validateLocalBridgeReplyFrame(
  input: unknown,
  direction: unknown,
): shared.LocalBridgeReplyFrameValidation {
  try {
    if (!shared.REPLY_DIRECTION_VALUES.includes(direction as shared.LocalBridgeReplyDirection)) {
      return shared.failure("wrong-direction");
    }
    const object = shared.normalizeObject(input, shared.DIRECT_NORMALIZATION_LIMITS);
    if (!object || typeof shared.field(object, "kind") !== "string")
      return shared.failure("malformed-frame");
    const kind = shared.field(object, "kind");
    if (kind === shared.REPLY_KIND) {
      return direction === "bridge-to-producer"
        ? validateReplyRequestObject(object)
        : shared.failure("wrong-direction");
    }
    if (kind === shared.RECEIPT_KIND) {
      return direction === "producer-to-bridge"
        ? validateReplyReceiptObject(object)
        : shared.failure("wrong-direction");
    }
    if (kind === shared.REPLY_CLOSE_KIND) {
      return direction === "producer-to-bridge"
        ? validateReplyCloseObject(object)
        : shared.failure("wrong-direction");
    }
    return shared.failure("malformed-frame");
  } catch {
    return shared.failure("malformed-frame");
  }
}

export function parseLocalBridgeReplyFrame(
  input: unknown,
  direction: unknown,
): shared.LocalBridgeReplyFrameValidation {
  try {
    const decoded = decodeLengthPrefixedFrame(input);
    if (!decoded.ok) return decoded;
    const body = shared.parseControlBody(decoded.body);
    if (!body.ok) return body;
    return validateLocalBridgeReplyFrame(body.value, direction);
  } catch {
    return shared.failure("malformed-frame");
  }
}

export function encodeLocalBridgeReplyFrame(
  input: unknown,
  direction: unknown,
): shared.LocalBridgeEncodedFrameResult {
  try {
    const validated = validateLocalBridgeReplyFrame(input, direction);
    if (!validated.ok) return validated;
    const raw = Buffer.from(JSON.stringify(validated.frame), "utf8");
    if (raw.byteLength > shared.LOCAL_BRIDGE_BOUNDS.maxControlFrameBytes) {
      return shared.failure("control-frame-too-large");
    }
    return encodeLengthPrefixedFrame(raw);
  } catch {
    return shared.failure("malformed-frame");
  }
}

function validateReplyHandshakeObject(input: unknown): shared.LocalBridgeReplyHandshakeResult {
  const object = shared.normalizeObject(input, shared.DIRECT_NORMALIZATION_LIMITS);
  const keys = [
    "kind",
    "protocol",
    "installationId",
    "sessionId",
    "sourceInstanceId",
    "sourceEpoch",
    "generation",
    "launchToken",
    "capabilities",
  ] as const;
  if (!object || !shared.hasOnlyKeys(object, keys)) return shared.failure("malformed-frame");
  if (shared.field(object, "kind") !== shared.REPLY_HANDSHAKE_KIND)
    return shared.failure("malformed-frame");
  const parsedProtocol = validateProtocolEnvelope(
    shared.field(object, "protocol"),
    "malformed-frame",
  );
  if (!parsedProtocol.ok) return parsedProtocol;
  if (parsedProtocol.value.minor !== shared.LOCAL_BRIDGE_REPLY_MINOR) {
    return shared.failure("incompatible-protocol");
  }
  const installationId = shared.identity(shared.field(object, "installationId"));
  const sessionId = shared.identity(shared.field(object, "sessionId"));
  const sourceId = shared.sourceInstanceId(shared.field(object, "sourceInstanceId"));
  const sourceEpoch = shared.uint(
    shared.field(object, "sourceEpoch"),
    shared.LOCAL_BRIDGE_BOUNDS.maxSourceEpoch,
  );
  const generation = shared.uint(
    shared.field(object, "generation"),
    shared.LOCAL_BRIDGE_BOUNDS.maxActivityGeneration,
  );
  const launchToken = shared.token(shared.field(object, "launchToken"));
  const capabilities = shared.field(object, "capabilities");
  if (
    !installationId ||
    !sessionId ||
    !sourceId ||
    sourceEpoch === undefined ||
    sourceEpoch < 1 ||
    generation === undefined ||
    generation < 1 ||
    !launchToken ||
    !Array.isArray(capabilities) ||
    capabilities.length !== 1 ||
    capabilities[0] !== shared.REPLY_TEXT_CAPABILITY
  ) {
    return shared.failure("malformed-frame");
  }
  return {
    ok: true,
    handshake: Object.freeze({
      kind: shared.REPLY_HANDSHAKE_KIND,
      protocol: parsedProtocol.value,
      installationId,
      sessionId,
      sourceInstanceId: sourceId,
      sourceEpoch,
      generation,
      launchToken,
      capabilities: Object.freeze([shared.REPLY_TEXT_CAPABILITY] as const),
    }),
  };
}

export function validateLocalBridgeReplyHandshake(
  input: unknown,
): shared.LocalBridgeReplyHandshakeResult {
  try {
    return validateReplyHandshakeObject(input);
  } catch {
    return shared.failure("malformed-frame");
  }
}

export function parseLocalBridgeReplyHandshakeFrame(
  input: unknown,
): shared.LocalBridgeReplyHandshakeResult {
  try {
    const decoded = decodeLengthPrefixedFrame(input);
    if (!decoded.ok) return decoded;
    const body = shared.parseControlBody(decoded.body);
    if (!body.ok) return body;
    return validateReplyHandshakeObject(body.value);
  } catch {
    return shared.failure("malformed-frame");
  }
}

export function isLocalBridgeReplyExpired(ttlSeconds: unknown, elapsedSeconds: unknown): boolean {
  const ttl =
    typeof ttlSeconds === "number" &&
    !Object.is(ttlSeconds, -0) &&
    Number.isSafeInteger(ttlSeconds) &&
    ttlSeconds >= shared.LOCAL_BRIDGE_BOUNDS.minReplyTtlSeconds &&
    ttlSeconds <= shared.LOCAL_BRIDGE_BOUNDS.maxReplyTtlSeconds
      ? ttlSeconds
      : undefined;
  return (
    ttl !== undefined &&
    typeof elapsedSeconds === "number" &&
    Number.isFinite(elapsedSeconds) &&
    elapsedSeconds >= 0 &&
    elapsedSeconds >= ttl
  );
}

export function encodeLocalBridgeReplyHandshakeFrame(
  input: unknown,
): shared.LocalBridgeEncodedFrameResult {
  try {
    const validated = validateReplyHandshakeObject(input);
    if (!validated.ok) return validated;
    const raw = Buffer.from(JSON.stringify(validated.handshake), "utf8");
    if (raw.byteLength > shared.LOCAL_BRIDGE_BOUNDS.maxControlFrameBytes) {
      return shared.failure("control-frame-too-large");
    }
    return encodeLengthPrefixedFrame(raw);
  } catch {
    return shared.failure("malformed-frame");
  }
}

function isWireCode(value: string): value is shared.LocalBridgeWireCode {
  return (
    shared.LOCAL_BRIDGE_ERROR_CODES.some((code) => code === value) ||
    shared.CONTROL_RESULT_CODES.has(value)
  );
}

export function freezeWireResult(
  code: shared.LocalBridgeWireCode,
  bridgeRevision?: number,
  sourceEpoch?: number,
  snapshotRequired?: boolean,
): shared.LocalBridgeWireResult {
  const result: {
    readonly kind: typeof shared.RESULT_KIND;
    readonly code: shared.LocalBridgeWireCode;
    readonly bridgeRevision?: number;
    readonly sourceEpoch?: number;
    readonly snapshotRequired?: boolean;
  } = {
    kind: shared.RESULT_KIND,
    code,
    ...(bridgeRevision === undefined ? {} : { bridgeRevision }),
    ...(sourceEpoch === undefined ? {} : { sourceEpoch }),
    ...(snapshotRequired === undefined ? {} : { snapshotRequired }),
  };
  return Object.freeze(result);
}

function validateWireResultObject(input: unknown): shared.LocalBridgeResultFrameValidation {
  const object = shared.normalizeObject(input, shared.DIRECT_NORMALIZATION_LIMITS);
  if (!object) return shared.failure("malformed-frame");
  const required = ["kind", "code"] as const;
  const optional = ["bridgeRevision", "sourceEpoch", "snapshotRequired"] as const;
  if (!shared.hasOptionalOnlyKeys(object, required, optional))
    return shared.failure("malformed-frame");
  if (shared.field(object, "kind") !== shared.RESULT_KIND) return shared.failure("malformed-frame");
  const code = shared.field(object, "code");
  if (typeof code !== "string" || !isWireCode(code)) return shared.failure("malformed-frame");
  const bridgeRevisionValue = shared.field(object, "bridgeRevision");
  const sourceEpochValue = shared.field(object, "sourceEpoch");
  const snapshotRequiredValue = shared.field(object, "snapshotRequired");
  if (!shared.CONTROL_RESULT_CODES.has(code) || code === "closed") {
    if (
      bridgeRevisionValue !== undefined ||
      sourceEpochValue !== undefined ||
      snapshotRequiredValue !== undefined
    ) {
      return shared.failure("malformed-frame");
    }
    return { ok: true, result: freezeWireResult(code) };
  }
  if (bridgeRevisionValue === undefined || sourceEpochValue === undefined) {
    return shared.failure("malformed-frame");
  }
  if (code === "ready") {
    if (typeof snapshotRequiredValue !== "boolean") return shared.failure("malformed-frame");
  } else if (snapshotRequiredValue !== undefined) {
    return shared.failure("malformed-frame");
  }
  const bridgeRevision = shared.uint(
    bridgeRevisionValue,
    shared.LOCAL_BRIDGE_BOUNDS.maxBridgeRevision,
  );
  const sourceEpoch = shared.uint(sourceEpochValue, shared.LOCAL_BRIDGE_BOUNDS.maxSourceEpoch);
  if (bridgeRevision === undefined || sourceEpoch === undefined || sourceEpoch < 1) {
    return shared.failure("malformed-frame");
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

export function validateLocalBridgeResult(input: unknown): shared.LocalBridgeResultFrameValidation {
  try {
    return validateWireResultObject(input);
  } catch {
    return shared.failure("malformed-frame");
  }
}

export function parseLocalBridgeResultFrame(
  input: unknown,
): shared.LocalBridgeResultFrameValidation {
  try {
    const decoded = decodeLengthPrefixedFrame(input);
    if (!decoded.ok) return decoded;
    const body = shared.parseControlBody(decoded.body);
    if (!body.ok) return body;
    return validateWireResultObject(body.value);
  } catch {
    return shared.failure("malformed-frame");
  }
}

export function encodeLocalBridgeResultFrame(input: unknown): shared.LocalBridgeEncodedFrameResult {
  try {
    const validated = validateWireResultObject(input);
    if (!validated.ok) return validated;
    const serialized = JSON.stringify(validated.result);
    if (serialized === undefined) return shared.failure("malformed-frame");
    const body = new TextEncoder().encode(serialized);
    if (body.byteLength > shared.LOCAL_BRIDGE_BOUNDS.maxControlFrameBytes) {
      return shared.failure("control-frame-too-large");
    }
    return encodeLengthPrefixedFrame(body);
  } catch {
    return shared.failure("malformed-frame");
  }
}

export function parseLocalBridgeDataFrame(input: unknown): shared.LocalBridgeDataResult {
  try {
    const decoded = decodeLengthPrefixedFrame(input);
    if (!decoded.ok) return decoded;
    const rawJson = shared.decodeUtf8(decoded.body);
    if (rawJson === undefined) return shared.failure("invalid-utf8");
    const parsed = parseSessionMirrorJson(rawJson);
    if (!parsed.ok) {
      return shared.failure(shared.mapSessionMirrorFailure(parsed.error.category));
    }
    return {
      ok: true,
      envelope: parsed.envelope,
      rawJson,
      rawBytes: decoded.body,
    };
  } catch {
    return shared.failure("session-mirror-invalid");
  }
}

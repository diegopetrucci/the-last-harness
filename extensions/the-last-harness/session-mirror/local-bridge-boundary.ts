import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";

import { hasDuplicateJsonKeys } from "./json-boundary.js";

export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_CONTROL_BYTES = 4 * 1024;
export const MAX_PATH_BYTES = 103;
const MAX_RENDEZVOUS_BYTES = 4 * 1024;
const TOKEN_RE = /^[a-f0-9]{32}$/;
const SOURCE_RE = TOKEN_RE;
const SOCKET_RE = /^mirror-[a-f0-9]{24}\.sock$/;
const RESULT_CODES = new Set(
  "ready disconnected accepted duplicate deduplicated evicted closed invalid-input malformed-rendezvous unsafe-rendezvous frame-too-large control-frame-too-large malformed-frame invalid-utf8 invalid-json incompatible-protocol incompatible-capability installation-mismatch token-mismatch session-mismatch busy stale-source stale-activity not-owner handshake-required wrong-direction session-mirror-invalid session-mirror-bounds session-mirror-incompatible session-mirror-forbidden session-mirror-incomplete session-mirror-duplicate-conflict session-mirror-revision-gap revision-exhausted source-history-full".split(
    " ",
  ),
);
const SOURCE_INSTANCE_ID = randomBytes(16).toString("hex");
const MISSING = Symbol("missing");
const O_RDONLY_NOFOLLOW =
  typeof constants.O_NOFOLLOW === "number" ? constants.O_RDONLY | constants.O_NOFOLLOW : undefined;
const MAX_UINT = Number.MAX_SAFE_INTEGER - 1;

type BoundaryValue = object | string | number | boolean | bigint | symbol | null | undefined | void;
type OwnedValue = BoundaryValue | typeof MISSING;
type BoundaryFunction<Arguments extends readonly unknown[]> = (...args: Arguments) => BoundaryValue;
type Keys = readonly string[];
type FileMetadata = { mode: number; uid: number; dev?: number; ino?: number };
type ModeStat = FileMetadata | undefined;
type FileSystem = ReturnType<typeof fileSystem>;

export function option(value: unknown, key: string): OwnedValue {
  try {
    if (value === null || typeof value !== "object") return MISSING;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return MISSING;
    const found: BoundaryValue = descriptor.value;
    return found;
  } catch {
    return MISSING;
  }
}
function object(value: unknown): object | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || prototype === Object.prototype ? value : undefined;
  } catch {
    return undefined;
  }
}
function exact(value: unknown, required: Keys, optional: Keys = []): boolean {
  const owner = object(value);
  const allowed = new Set([...required, ...optional]);
  return (
    owner !== undefined &&
    Object.keys(owner).every((key) => allowed.has(key)) &&
    required.every((key) => Object.hasOwn(owner, key))
  );
}
function scalarCount(value: string): number | undefined {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return undefined;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return undefined;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return undefined;
    }
    count += 1;
  }
  return count;
}
export function validIdentity(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const count = scalarCount(value);
  return count !== undefined && count > 0 && count <= 128 && Buffer.byteLength(value, "utf8") <= 512
    ? value
    : undefined;
}
export function validPath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !value.startsWith("/") ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES
  )
    return undefined;
  return value
    .split("/")
    .slice(1)
    .every((part) => part !== "" && part !== "." && part !== "..")
    ? value
    : undefined;
}
function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function boundedRevision(value: unknown): number | typeof MISSING | undefined {
  if (value === MISSING) return MISSING;
  const result = integer(value);
  return result !== undefined && !Object.is(result, -0) && result <= MAX_UINT ? result : undefined;
}
function boundedSourceEpoch(value: unknown): number | typeof MISSING | undefined {
  if (value === MISSING) return MISSING;
  const result = boundedRevision(value);
  return typeof result === "number" && result > 0 ? result : undefined;
}
function metadata(value: unknown): FileMetadata | undefined {
  const mode = integer(option(value, "mode"));
  const uid = integer(option(value, "uid"));
  return mode === undefined || uid === undefined
    ? undefined
    : {
        mode,
        uid,
        dev: integer(option(value, "dev")),
        ino: integer(option(value, "ino")),
      };
}
function sameFile(first: FileMetadata, second: FileMetadata): boolean {
  return (
    first.dev !== undefined &&
    first.ino !== undefined &&
    first.dev === second.dev &&
    first.ino === second.ino
  );
}
function modeMatches(s: ModeStat, k: number, p: number, u: number): boolean {
  return s !== undefined && (s.mode & 0o170000) === k && s.uid === u && (s.mode & 0o7777) === p;
}
function currentUid(): number | undefined {
  try {
    const value: unknown = process.getuid?.();
    return integer(value);
  } catch {
    return undefined;
  }
}
function privateDirectory(directory: string, fs: FileSystem, expectedUid: number): boolean {
  if (directory === "/") return false;
  let current = "";
  for (const part of directory.slice(1).split("/")) {
    current += `/${part}`;
    let stat: FileMetadata | undefined;
    try {
      stat = metadata(fs.lstat(current));
    } catch {
      return false;
    }
    if (!stat || (stat.mode & 0o170000) !== 0o040000) return false;
    const stickyWorldWritable = (stat.mode & 0o7777) === 0o1777 && stat.uid === 0;
    if ((stat.mode & 0o022) !== 0 && !stickyWorldWritable) return false;
    if (current === directory) {
      if (stat.uid !== expectedUid || (stat.mode & 0o7777) !== 0o700) return false;
    } else if (stat.uid !== expectedUid && stat.uid !== 0) return false;
  }
  return true;
}
function decode(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
function parseRendezvous(text: string) {
  if (Buffer.byteLength(text, "utf8") > MAX_RENDEZVOUS_BYTES || hasDuplicateJsonKeys(text))
    return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const value = object(parsed);
  const protocol = object(option(value, "protocol"));
  const installationId = validIdentity(option(value, "installationId"));
  const socketName = option(value, "socketName");
  const launchToken = option(value, "launchToken");
  if (
    !value ||
    !protocol ||
    !exact(value, ["protocol", "installationId", "socketName", "launchToken"]) ||
    !exact(protocol, ["family", "major", "minor"]) ||
    option(protocol, "family") !== "local-bridge" ||
    option(protocol, "major") !== 0 ||
    option(protocol, "minor") !== 0
  )
    return undefined;
  return installationId &&
    typeof socketName === "string" &&
    SOCKET_RE.test(socketName) &&
    typeof launchToken === "string" &&
    TOKEN_RE.test(launchToken)
    ? { installationId, socketName, launchToken }
    : undefined;
}
function isFunction<A extends readonly unknown[]>(value: unknown): value is BoundaryFunction<A> {
  return typeof value === "function";
}
function select<A extends readonly unknown[]>(
  value: unknown,
  key: string,
  fallback: BoundaryFunction<A>,
): BoundaryFunction<A> {
  const candidate = option(value, key);
  return isFunction<A>(candidate) ? candidate : fallback;
}
function read(fd: number, buffer: Buffer, offset: number, length: number, position: null): number {
  return readSync(fd, buffer, offset, length, position);
}
function fileSystem(controls: unknown) {
  const source = object(option(controls, "fileSystem"));
  return {
    lstat: select(source, "lstat", lstatSync),
    open: select(source, "open", openSync),
    fstat: select(source, "fstat", fstatSync),
    read: select(source, "read", read),
    close: select(source, "close", closeSync),
  };
}
export function readRendezvous(directory: unknown, controls: unknown) {
  const safeDirectory = validPath(directory);
  if (safeDirectory === undefined) return undefined;
  const expectedUid = currentUid();
  if (expectedUid === undefined || O_RDONLY_NOFOLLOW === undefined) return undefined;
  const fs = fileSystem(controls);
  if (!privateDirectory(safeDirectory, fs, expectedUid)) return undefined;
  const path = `${safeDirectory}/rendezvous.json`;
  let fd: number | undefined;
  try {
    const stat = metadata(fs.lstat(path));
    if (!stat || !modeMatches(stat, 0o100000, 0o600, expectedUid)) return undefined;
    const opened = integer(fs.open(path, O_RDONLY_NOFOLLOW));
    if (opened === undefined) return undefined;
    fd = opened;
    const openedStat = metadata(fs.fstat(fd));
    if (
      !openedStat ||
      openedStat.mode !== stat.mode ||
      openedStat.uid !== stat.uid ||
      !sameFile(stat, openedStat)
    )
      return undefined;
    const bytes = Buffer.alloc(MAX_RENDEZVOUS_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = integer(fs.read(fd, bytes, length, bytes.length - length, null));
      if (count === undefined || count > bytes.length - length) return undefined;
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_RENDEZVOUS_BYTES) return undefined;
    const text = decode(bytes.subarray(0, length));
    return text === undefined ? undefined : parseRendezvous(text);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.close(fd);
      } catch {}
    }
  }
}
export function socketPath(directory: unknown, name: unknown): string | undefined {
  const safeDirectory = validPath(directory);
  if (safeDirectory === undefined || typeof name !== "string" || !SOCKET_RE.test(name))
    return undefined;
  const path = `${safeDirectory}/${name}`;
  return Buffer.byteLength(path, "utf8") <= MAX_PATH_BYTES ? path : undefined;
}
export function socketIsSafe(path: unknown, controls: unknown): boolean {
  const safePath = validPath(path);
  const expectedUid = currentUid();
  if (safePath === undefined || expectedUid === undefined) return false;
  try {
    const stat = metadata(fileSystem(controls).lstat(safePath));
    return modeMatches(stat, 0o140000, 0o600, expectedUid);
  } catch {
    return false;
  }
}
function boundedBytes(value: unknown, maximum: number): Buffer | undefined {
  try {
    if (!(value instanceof Uint8Array)) return undefined;
    const length = value.byteLength;
    return Number.isSafeInteger(length) && length >= 0 && length <= maximum
      ? Buffer.from(value)
      : undefined;
  } catch {
    return undefined;
  }
}
export function frame(body: unknown): Uint8Array | undefined {
  const bytes = boundedBytes(body, MAX_FRAME_BYTES);
  if (bytes === undefined) return undefined;
  try {
    const output = Buffer.allocUnsafe(bytes.length + 4);
    output.writeUInt32BE(bytes.length, 0);
    bytes.copy(output, 4);
    return output;
  } catch {
    return undefined;
  }
}
export interface LocalBridgePublicationIdentity {
  readonly sessionId: string;
  readonly sourceInstanceId: string;
  readonly sourceEpoch: number;
}

export interface LocalBridgePublicationReady {
  readonly bridgeRevision: number;
  readonly sourceEpoch: number;
  readonly snapshotRequired: boolean;
}

export interface LocalBridgeReadyResult extends LocalBridgePublicationReady {
  readonly code: "ready";
}

function parseResultValue(body: unknown): string | LocalBridgeReadyResult | undefined {
  const bytes = boundedBytes(body, MAX_CONTROL_BYTES);
  if (bytes === undefined) return undefined;
  const text = decode(bytes);
  if (text === undefined || hasDuplicateJsonKeys(text)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const value = object(parsed);
  const code = option(value, "code");
  if (
    !value ||
    !exact(value, ["kind", "code"], ["bridgeRevision", "sourceEpoch", "snapshotRequired"]) ||
    option(value, "kind") !== "result" ||
    typeof code !== "string" ||
    !RESULT_CODES.has(code)
  )
    return undefined;
  const revision = boundedRevision(option(value, "bridgeRevision"));
  const epoch = boundedSourceEpoch(option(value, "sourceEpoch"));
  const snapshotRequired = option(value, "snapshotRequired");
  if (
    ["ready", "disconnected", "accepted", "duplicate", "deduplicated", "evicted"].includes(code)
  ) {
    if (typeof revision !== "number" || typeof epoch !== "number") return undefined;
    if (code === "ready" ? typeof snapshotRequired !== "boolean" : snapshotRequired !== MISSING)
      return undefined;
    if (code === "ready") {
      return Object.freeze({
        code: "ready" as const,
        bridgeRevision: revision,
        sourceEpoch: epoch,
        snapshotRequired: snapshotRequired as boolean,
      });
    }
  } else if (revision !== MISSING || epoch !== MISSING || snapshotRequired !== MISSING) {
    return undefined;
  }
  return code;
}

export function parseResult(body: unknown): string | undefined {
  const result = parseResultValue(body);
  return typeof result === "string" ? result : result?.code;
}

export function parseReadyResult(body: unknown): LocalBridgeReadyResult | undefined {
  const result = parseResultValue(body);
  return result !== undefined && typeof result !== "string" && result.code === "ready"
    ? result
    : undefined;
}

export const MAX_REPLY_TEXT_BYTES = 2 * 1024;
export const MAX_REPLY_REQUEST_ID_CHARACTERS = 64;
export const MIN_REPLY_TTL_SECONDS = 1;
export const MAX_REPLY_TTL_SECONDS = 60;
export const REPLY_TEXT_CAPABILITY = "reply-text" as const;

export type LocalBridgeReplyReceiptCode =
  | "accepted"
  | "unconfirmed"
  | "invalid"
  | "unauthorized"
  | "stale"
  | "busy"
  | "duplicate"
  | "expired"
  | "disconnected";

export type LocalBridgeReplyCloseReason =
  | "producer-disconnect"
  | "owner-replaced"
  | "authorization-withdrawn"
  | "listener-stop"
  | "transport-failure";

export interface LocalBridgeReplyRequest {
  readonly kind: "reply";
  readonly requestId: string;
  readonly generation: number;
  readonly branchId: string;
  readonly leafId: string;
  readonly sourceRevision: number;
  readonly ttlSeconds: number;
  readonly text: string;
}

const REPLY_RECEIPT_CODES = new Set<LocalBridgeReplyReceiptCode>([
  "accepted",
  "unconfirmed",
  "invalid",
  "unauthorized",
  "stale",
  "busy",
  "duplicate",
  "expired",
  "disconnected",
]);
const REPLY_CLOSE_REASONS = new Set<LocalBridgeReplyCloseReason>([
  "producer-disconnect",
  "owner-replaced",
  "authorization-withdrawn",
  "listener-stop",
  "transport-failure",
]);
const REPLY_TEXT_FORMAT_OR_SEPARATOR = /[\p{Cf}\p{Zl}\p{Zp}]/u;

function replyRequestId(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_REPLY_REQUEST_ID_CHARACTERS * 2 ||
    scalarCount(value) === undefined ||
    (scalarCount(value) ?? 0) > MAX_REPLY_REQUEST_ID_CHARACTERS ||
    Buffer.byteLength(value, "utf8") > MAX_REPLY_REQUEST_ID_CHARACTERS * 4
  ) {
    return undefined;
  }
  return value;
}

function safeReplyText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || scalarCount(value) === undefined) {
    return undefined;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      ((codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) &&
        codePoint !== 0x09 &&
        codePoint !== 0x0a) ||
      REPLY_TEXT_FORMAT_OR_SEPARATOR.test(character)
    ) {
      return undefined;
    }
  }
  return value.trimStart().startsWith("/") ||
    Buffer.byteLength(value, "utf8") > MAX_REPLY_TEXT_BYTES
    ? undefined
    : value;
}

function replyInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    !Object.is(value, -0) &&
    value <= maximum
    ? value
    : undefined;
}

export function parseReplyRequest(value: unknown): LocalBridgeReplyRequest | undefined {
  try {
    const bytes = boundedBytes(value, MAX_CONTROL_BYTES);
    let parsed: unknown = value;
    if (bytes !== undefined) {
      const text = decode(bytes);
      if (text === undefined || hasDuplicateJsonKeys(text)) return undefined;
      parsed = JSON.parse(text) as unknown;
    }
    if (
      !object(parsed) ||
      !exact(parsed, [
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
      return undefined;
    }
    const kind = option(parsed, "kind");
    const requestId = replyRequestId(option(parsed, "requestId"));
    const generation = replyInteger(option(parsed, "generation"), Number.MAX_SAFE_INTEGER - 1);
    const branchId = validIdentity(option(parsed, "branchId"));
    const leafId = validIdentity(option(parsed, "leafId"));
    const sourceRevision = replyInteger(
      option(parsed, "sourceRevision"),
      Number.MAX_SAFE_INTEGER - 1,
    );
    const ttlSeconds = replyInteger(option(parsed, "ttlSeconds"), MAX_REPLY_TTL_SECONDS);
    const text = safeReplyText(option(parsed, "text"));
    return kind === "reply" &&
      requestId !== undefined &&
      generation !== undefined &&
      branchId !== undefined &&
      leafId !== undefined &&
      sourceRevision !== undefined &&
      ttlSeconds !== undefined &&
      ttlSeconds >= MIN_REPLY_TTL_SECONDS &&
      text !== undefined
      ? Object.freeze({
          kind: "reply" as const,
          requestId,
          generation,
          branchId,
          leafId,
          sourceRevision,
          ttlSeconds,
          text,
        })
      : undefined;
  } catch {
    return undefined;
  }
}

export function replyReceiptFrame(code: unknown): Uint8Array | undefined {
  if (typeof code !== "string" || !REPLY_RECEIPT_CODES.has(code as LocalBridgeReplyReceiptCode)) {
    return undefined;
  }
  return frame(json({ kind: "receipt", code }));
}

export function replyCloseFrame(reason: unknown): Uint8Array | undefined {
  if (
    typeof reason !== "string" ||
    !REPLY_CLOSE_REASONS.has(reason as LocalBridgeReplyCloseReason)
  ) {
    return undefined;
  }
  return frame(json({ kind: "reply-close", reason }));
}

export function json(value: unknown): Uint8Array | undefined {
  try {
    const serialized: unknown = JSON.stringify(value);
    if (typeof serialized !== "string") return undefined;
    const bytes = Buffer.from(serialized, "utf8");
    return bytes.byteLength <= MAX_FRAME_BYTES ? bytes : undefined;
  } catch {
    return undefined;
  }
}
export function sourceInstanceId(value: unknown): string | undefined {
  if (value === undefined || value === MISSING) return SOURCE_INSTANCE_ID;
  return typeof value === "string" && SOURCE_RE.test(value) ? value : undefined;
}

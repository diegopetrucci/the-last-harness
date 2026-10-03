import { createHash } from "node:crypto";

import {
  applySessionMirrorEnvelope,
  createSessionMirrorState,
  SESSION_MIRROR_BOUNDS,
  type SessionMirrorState,
} from "../../session-mirror/v1/conformance.ts";
import * as shared from "./shared.ts";
import * as wire from "./wire.ts";

function readOwnRecord(input: unknown): shared.LocalBridgeOwnRecord | undefined {
  if (!shared.isObject(input) || Array.isArray(input)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== null && prototype !== Object.prototype) return undefined;
    if (Object.getOwnPropertySymbols(input).length > 0) return undefined;
    const names = Object.getOwnPropertyNames(input);
    if (names.length > shared.LOCAL_BRIDGE_BOUNDS.maxDirectNormalizationCollection)
      return undefined;
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
  | shared.LocalBridgeFailure {
  const record = readOwnRecord(input);
  if (
    !record ||
    Object.keys(record).length !== 3 ||
    !Object.keys(record).every((key) => ["sessionId", "sourceInstanceId", "frame"].includes(key))
  ) {
    return shared.failure("invalid-input");
  }
  const sessionId = shared.identity(record.sessionId);
  const sourceId = shared.sourceInstanceId(record.sourceInstanceId);
  const frame = shared.copyBytes(record.frame);
  if (!sessionId || !sourceId || !frame) return shared.failure("invalid-input");
  return { ok: true, sessionId, sourceInstanceId: sourceId, frame };
}

function commandReplyFrame(input: unknown):
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly sourceInstanceId: string;
      readonly frame: Uint8Array | shared.LocalBridgeJsonObject;
    }
  | shared.LocalBridgeFailure {
  const record = readOwnRecord(input);
  if (
    !record ||
    Object.keys(record).length !== 3 ||
    !Object.keys(record).every((key) => ["sessionId", "sourceInstanceId", "frame"].includes(key))
  ) {
    return shared.failure("invalid-input");
  }
  const sessionId = shared.identity(record.sessionId);
  const sourceId = shared.sourceInstanceId(record.sourceInstanceId);
  if (!sessionId || !sourceId) return shared.failure("invalid-input");
  const frameBytes = shared.copyBytes(record.frame);
  if (frameBytes) return { ok: true, sessionId, sourceInstanceId: sourceId, frame: frameBytes };
  const frame = shared.normalizeObject(record.frame, shared.DIRECT_NORMALIZATION_LIMITS);
  if (!frame) return shared.failure("invalid-input");
  return { ok: true, sessionId, sourceInstanceId: sourceId, frame };
}

function commandOwner(
  input: unknown,
):
  | { readonly ok: true; readonly sessionId: string; readonly sourceInstanceId: string }
  | shared.LocalBridgeFailure {
  const record = readOwnRecord(input);
  if (
    !record ||
    Object.keys(record).length !== 2 ||
    !Object.keys(record).every((key) => ["sessionId", "sourceInstanceId"].includes(key))
  ) {
    return shared.failure("invalid-input");
  }
  const sessionId = shared.identity(record.sessionId);
  const sourceId = shared.sourceInstanceId(record.sourceInstanceId);
  if (!sessionId || !sourceId) return shared.failure("invalid-input");
  return { ok: true, sessionId, sourceInstanceId: sourceId };
}

function snapshotDigest(value: unknown): string | undefined {
  return typeof value === "string" && shared.SNAPSHOT_DIGEST_PATTERN.test(value)
    ? value
    : undefined;
}

function replyDigest(value: unknown): string | undefined {
  return typeof value === "string" && shared.REPLY_REQUEST_DIGEST_PATTERN.test(value)
    ? value
    : undefined;
}

function normalizeSessionMirrorState(input: unknown): SessionMirrorState | undefined {
  const object = shared.normalizeObject(input, shared.RETAINED_NORMALIZATION_LIMITS);
  if (
    !object ||
    !shared.hasOnlyKeys(object, ["sessionId", "revision", "cursor", "snapshotId", "seenMessages"])
  ) {
    return undefined;
  }
  const sessionIdValue = shared.field(object, "sessionId");
  const sessionId = sessionIdValue === null ? null : shared.v1Identity(sessionIdValue);
  const revision = shared.v1Revision(shared.field(object, "revision"));
  const cursorValue = shared.field(object, "cursor");
  const cursor = cursorValue === null ? null : shared.v1Cursor(cursorValue);
  const snapshotIdValue = shared.field(object, "snapshotId");
  const snapshotId = snapshotIdValue === null ? null : shared.v1Identity(snapshotIdValue);
  const messagesValue = shared.field(object, "seenMessages");
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
    const record = shared.isJsonObject(item) ? item : undefined;
    if (!record || !shared.hasOnlyKeys(record, ["sessionId", "eventId", "canonical"]))
      return undefined;
    const itemSessionId = shared.v1Identity(shared.field(record, "sessionId"));
    const eventId = shared.v1Identity(shared.field(record, "eventId"));
    const canonical = shared.boundedUtf8String(
      shared.field(record, "canonical"),
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

interface LocalBridgeConversationCandidate {
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
  readonly replyRequestDigests: readonly unknown[];
  readonly sessionMirrorState: SessionMirrorState;
  readonly lastSnapshotSha256: string | null;
  readonly lastSnapshotByteLength: number | null;
  readonly lastSnapshotRevision: number | null;
  readonly supersededSourceInstanceIds: readonly unknown[];
}

function parseLocalBridgeConversation(
  input: unknown,
  installationId: string,
): LocalBridgeConversationCandidate | undefined {
  const record = shared.isJsonObject(input) ? input : undefined;
  if (
    !record ||
    !shared.hasOptionalOnlyKeys(
      record,
      [
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
      ],
      [
        "negotiatedMinor",
        "replyTextNegotiated",
        "replyChannelConnected",
        "replyInFlight",
        "replyInFlightDigest",
        "replyRequestDigests",
      ],
    )
  ) {
    return undefined;
  }
  const itemInstallationId = shared.identity(shared.field(record, "installationId"));
  const sessionId = shared.identity(shared.field(record, "sessionId"));
  const owner = shared.sourceInstanceId(shared.field(record, "ownerSourceInstanceId"));
  const sourceEpoch = shared.uint(
    shared.field(record, "sourceEpoch"),
    shared.LOCAL_BRIDGE_BOUNDS.maxSourceEpoch,
  );
  const activityGeneration = shared.uint(
    shared.field(record, "activityGeneration"),
    shared.LOCAL_BRIDGE_BOUNDS.maxActivityGeneration,
  );
  const connected = shared.field(record, "connected");
  const dormant = shared.field(record, "dormant");
  const negotiatedMinorValue = shared.field(record, "negotiatedMinor");
  const negotiatedMinor =
    negotiatedMinorValue === undefined
      ? shared.LOCAL_BRIDGE_READ_ONLY_MINOR
      : shared.uint(negotiatedMinorValue, shared.LOCAL_BRIDGE_DATA_MINOR);
  const replyTextNegotiatedValue = shared.field(record, "replyTextNegotiated");
  const replyTextNegotiated =
    replyTextNegotiatedValue === undefined ? false : replyTextNegotiatedValue;
  const replyChannelConnectedValue = shared.field(record, "replyChannelConnected");
  const replyChannelConnected =
    replyChannelConnectedValue === undefined ? false : replyChannelConnectedValue;
  const replyInFlightValue = shared.field(record, "replyInFlight");
  const replyInFlight = replyInFlightValue === undefined ? false : replyInFlightValue;
  const replyInFlightDigestValue = shared.field(record, "replyInFlightDigest");
  const replyInFlightDigest =
    replyInFlightDigestValue === undefined || replyInFlightDigestValue === null
      ? null
      : replyDigest(replyInFlightDigestValue);
  const replyRequestDigestsValue = shared.field(record, "replyRequestDigests");
  const replyRequestDigests =
    replyRequestDigestsValue === undefined ? [] : replyRequestDigestsValue;
  const mirrorState = normalizeSessionMirrorState(shared.field(record, "sessionMirrorState"));
  const lastSnapshotSha256Value = shared.field(record, "lastSnapshotSha256");
  const lastSnapshotSha256 =
    lastSnapshotSha256Value === null ? null : snapshotDigest(lastSnapshotSha256Value);
  const lastSnapshotByteLengthValue = shared.field(record, "lastSnapshotByteLength");
  const lastSnapshotByteLength =
    lastSnapshotByteLengthValue === null
      ? null
      : shared.uint(lastSnapshotByteLengthValue, shared.LOCAL_BRIDGE_BOUNDS.maxFrameBodyBytes);
  const lastSnapshotRevisionValue = shared.field(record, "lastSnapshotRevision");
  const lastSnapshotRevision =
    lastSnapshotRevisionValue === null ? null : shared.v1Revision(lastSnapshotRevisionValue);
  const supersededValue = shared.field(record, "supersededSourceInstanceIds");
  if (
    !itemInstallationId ||
    itemInstallationId !== installationId ||
    !sessionId ||
    !owner ||
    sourceEpoch === undefined ||
    sourceEpoch < 1 ||
    activityGeneration === undefined ||
    negotiatedMinor === undefined ||
    typeof connected !== "boolean" ||
    typeof dormant !== "boolean" ||
    typeof replyTextNegotiated !== "boolean" ||
    typeof replyChannelConnected !== "boolean" ||
    typeof replyInFlight !== "boolean" ||
    !mirrorState ||
    (replyInFlightDigestValue !== undefined &&
      replyInFlightDigestValue !== null &&
      replyInFlightDigest === undefined) ||
    !Array.isArray(replyRequestDigests) ||
    replyRequestDigests.length > shared.LOCAL_BRIDGE_BOUNDS.maxReplyRequestDigests ||
    lastSnapshotSha256 === undefined ||
    lastSnapshotByteLength === undefined ||
    lastSnapshotRevision === undefined ||
    !Array.isArray(supersededValue)
  ) {
    return undefined;
  }
  if (mirrorState.sessionId !== null && mirrorState.sessionId !== sessionId) return undefined;
  return {
    installationId: itemInstallationId,
    sessionId,
    ownerSourceInstanceId: owner,
    sourceEpoch,
    activityGeneration,
    connected,
    dormant,
    negotiatedMinor,
    replyTextNegotiated,
    replyChannelConnected,
    replyInFlight,
    replyInFlightDigest: replyInFlightDigest ?? null,
    replyRequestDigests,
    sessionMirrorState: mirrorState,
    lastSnapshotSha256: lastSnapshotSha256 ?? null,
    lastSnapshotByteLength: lastSnapshotByteLength ?? null,
    lastSnapshotRevision: lastSnapshotRevision ?? null,
    supersededSourceInstanceIds: supersededValue,
  };
}

function normalizeReplyDigests(
  candidate: LocalBridgeConversationCandidate,
): readonly string[] | undefined {
  if (!candidate.replyTextNegotiated && candidate.replyChannelConnected) return undefined;
  if (!candidate.replyChannelConnected && candidate.replyInFlight) return undefined;
  if (candidate.replyInFlight !== (candidate.replyInFlightDigest !== null)) return undefined;
  const recentReplyDigests: string[] = [];
  for (const digest of candidate.replyRequestDigests) {
    const normalizedDigest = replyDigest(digest);
    if (!normalizedDigest || recentReplyDigests.includes(normalizedDigest)) return undefined;
    recentReplyDigests.push(normalizedDigest);
  }
  if (
    candidate.replyInFlightDigest !== null &&
    !recentReplyDigests.includes(candidate.replyInFlightDigest)
  ) {
    return undefined;
  }
  if (
    !candidate.connected &&
    (candidate.replyTextNegotiated || candidate.replyChannelConnected || candidate.replyInFlight)
  ) {
    return undefined;
  }
  if (
    !candidate.connected &&
    (candidate.replyInFlightDigest !== null || recentReplyDigests.length)
  ) {
    return undefined;
  }
  return recentReplyDigests;
}

function validSnapshotState(candidate: LocalBridgeConversationCandidate): boolean {
  if (candidate.dormant && candidate.connected) return false;
  if (candidate.lastSnapshotSha256 === null && candidate.lastSnapshotByteLength !== null) {
    return false;
  }
  if (candidate.lastSnapshotSha256 === null && candidate.lastSnapshotRevision !== null) {
    return false;
  }
  if (candidate.lastSnapshotSha256 !== null && candidate.lastSnapshotByteLength === null) {
    return false;
  }
  if (candidate.lastSnapshotSha256 !== null && candidate.lastSnapshotRevision === null) {
    return false;
  }
  if (candidate.sessionMirrorState.sessionId === null && candidate.lastSnapshotSha256 !== null) {
    return false;
  }
  if (candidate.sessionMirrorState.sessionId !== null && candidate.lastSnapshotSha256 === null) {
    return false;
  }
  if (
    candidate.lastSnapshotRevision !== null &&
    candidate.lastSnapshotRevision > candidate.sessionMirrorState.revision
  ) {
    return false;
  }
  return !(
    candidate.dormant &&
    (candidate.sessionMirrorState.sessionId !== null ||
      candidate.lastSnapshotSha256 !== null ||
      candidate.lastSnapshotByteLength !== null ||
      candidate.lastSnapshotRevision !== null)
  );
}

function normalizeSupersededSourceIds(
  candidate: LocalBridgeConversationCandidate,
): readonly string[] | undefined {
  if (
    candidate.supersededSourceInstanceIds.length > shared.LOCAL_BRIDGE_BOUNDS.maxSupersededSourceIds
  ) {
    return undefined;
  }
  const superseded: string[] = [];
  for (const source of candidate.supersededSourceInstanceIds) {
    const sourceId = shared.sourceInstanceId(source);
    if (
      !sourceId ||
      sourceId === candidate.ownerSourceInstanceId ||
      superseded.includes(sourceId)
    ) {
      return undefined;
    }
    superseded.push(sourceId);
  }
  return superseded;
}

function normalizeLocalBridgeConversation(
  input: unknown,
  installationId: string,
): shared.LocalBridgeConversationState | undefined {
  const candidate = parseLocalBridgeConversation(input, installationId);
  if (!candidate || !validSnapshotState(candidate)) return undefined;
  const replyRequestDigests = normalizeReplyDigests(candidate);
  if (!replyRequestDigests) return undefined;
  const supersededSourceInstanceIds = normalizeSupersededSourceIds(candidate);
  if (!supersededSourceInstanceIds) return undefined;
  return Object.freeze({
    ...candidate,
    replyRequestDigests: Object.freeze(replyRequestDigests),
    supersededSourceInstanceIds: Object.freeze(supersededSourceInstanceIds),
  });
}

function normalizeLocalBridgeState(input: unknown): shared.LocalBridgeState | undefined {
  const object = shared.normalizeObject(input, shared.RETAINED_NORMALIZATION_LIMITS);
  if (
    !object ||
    !shared.hasOnlyKeys(object, [
      "status",
      "installationId",
      "launchToken",
      "bridgeRevision",
      "conversations",
    ])
  ) {
    return undefined;
  }
  const status = shared.field(object, "status");
  const installationId = shared.identity(shared.field(object, "installationId"));
  const launchToken = shared.token(shared.field(object, "launchToken"));
  const bridgeRevision = shared.uint(
    shared.field(object, "bridgeRevision"),
    shared.LOCAL_BRIDGE_BOUNDS.maxBridgeRevision,
  );
  const conversationsValue = shared.field(object, "conversations");
  if (
    (status !== "open" && status !== "closed") ||
    !installationId ||
    !launchToken ||
    bridgeRevision === undefined ||
    !Array.isArray(conversationsValue) ||
    conversationsValue.length > shared.LOCAL_BRIDGE_BOUNDS.maxKnownConversations
  ) {
    return undefined;
  }
  if (status === "closed" && conversationsValue.length !== 0) return undefined;
  const conversations: shared.LocalBridgeConversationState[] = [];
  let activeConversationCount = 0;
  const conversationKeys = new Set<string>();
  for (const item of conversationsValue) {
    const conversation = normalizeLocalBridgeConversation(item, installationId);
    if (!conversation) return undefined;
    if (!conversation.dormant) activeConversationCount += 1;
    if (activeConversationCount > shared.LOCAL_BRIDGE_BOUNDS.maxActiveConversations) {
      return undefined;
    }
    const key = `${conversation.installationId}\u0000${conversation.sessionId}`;
    if (conversationKeys.has(key)) return undefined;
    conversationKeys.add(key);
    conversations.push(conversation);
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
  conversations: readonly shared.LocalBridgeConversationState[],
): shared.LocalBridgeState {
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
  const object = shared.normalizeObject(input, shared.DIRECT_NORMALIZATION_LIMITS);
  if (!object || !shared.hasOnlyKeys(object, ["installationId", "launchToken"])) return undefined;
  const installationId = shared.identity(shared.field(object, "installationId"));
  const launchToken = shared.token(shared.field(object, "launchToken"));
  return installationId && launchToken ? { installationId, launchToken } : undefined;
}

export function createLocalBridgeState(input: unknown): shared.LocalBridgeStateResult {
  try {
    const config = validConfig(input);
    if (!config) return shared.failure("invalid-input");
    return {
      ok: true,
      state: freezeState("open", config.installationId, config.launchToken, 0, []),
    };
  } catch {
    return shared.failure("invalid-input");
  }
}

function safeResult(
  code: shared.LocalBridgeWireCode,
  bridgeRevision?: number,
  sourceEpoch?: number,
  snapshotRequired?: boolean,
): shared.LocalBridgeWireResult {
  return wire.freezeWireResult(code, bridgeRevision, sourceEpoch, snapshotRequired);
}

function stateTransition(
  nextState: shared.LocalBridgeState,
  code: shared.LocalBridgeWireCode,
  bridgeRevision?: number,
  sourceEpoch?: number,
  snapshotRequired?: boolean,
): shared.LocalBridgeTransitionSuccess {
  return Object.freeze({
    ok: true,
    nextState,
    result: safeResult(code, bridgeRevision, sourceEpoch, snapshotRequired),
  });
}

function normalizedStateOrFailure(
  input: unknown,
): shared.LocalBridgeState | shared.LocalBridgeFailure {
  const state = normalizeLocalBridgeState(input);
  return state ?? shared.failure("invalid-input");
}

function activeConversationCount(state: shared.LocalBridgeState): number {
  return state.conversations.reduce(
    (count, conversation) => count + (conversation.dormant ? 0 : 1),
    0,
  );
}

function disconnectedConversation(
  state: shared.LocalBridgeState,
  sessionId: string,
  sourceInstanceId: string,
): shared.LocalBridgeConversationState | shared.LocalBridgeFailure {
  const conversation = state.conversations.find((item) => item.sessionId === sessionId);
  if (!conversation) return shared.failure("not-owner");
  if (conversation.supersededSourceInstanceIds.includes(sourceInstanceId)) {
    return shared.failure("stale-source");
  }
  if (conversation.ownerSourceInstanceId !== sourceInstanceId) return shared.failure("not-owner");
  return conversation;
}

export function acceptLocalBridgeHandshake(
  stateInput: unknown,
  input: unknown,
): shared.LocalBridgeTransition {
  try {
    const state = normalizedStateOrFailure(stateInput);
    if ("error" in state) return state;
    if (state.status === "closed") return shared.failure("closed");
    const handshake =
      shared.copyBytes(input) !== undefined
        ? wire.parseLocalBridgeHandshakeFrame(input)
        : wire.validateLocalBridgeHandshake(input);
    if (!handshake.ok) return handshake;
    if (handshake.handshake.installationId !== state.installationId) {
      return shared.failure("installation-mismatch");
    }
    if (handshake.handshake.launchToken !== state.launchToken)
      return shared.failure("token-mismatch");
    const current = state.conversations.find(
      (item) => item.sessionId === handshake.handshake.sessionId,
    );
    if (!current) {
      if (state.conversations.length >= shared.LOCAL_BRIDGE_BOUNDS.maxKnownConversations)
        return shared.failure("busy");
      if (activeConversationCount(state) >= shared.LOCAL_BRIDGE_BOUNDS.maxActiveConversations)
        return shared.failure("busy");
      const conversation: shared.LocalBridgeConversationState = Object.freeze({
        installationId: state.installationId,
        sessionId: handshake.handshake.sessionId,
        ownerSourceInstanceId: handshake.handshake.sourceInstanceId,
        sourceEpoch: 1,
        activityGeneration: 0,
        connected: true,
        dormant: false,
        negotiatedMinor: handshake.handshake.protocol.minor,
        replyTextNegotiated: false,
        replyChannelConnected: false,
        replyInFlight: false,
        replyInFlightDigest: null,
        replyRequestDigests: Object.freeze([]),
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
      return shared.failure("stale-source");
    }
    if (current.ownerSourceInstanceId === handshake.handshake.sourceInstanceId) {
      if (current.connected) return shared.failure("busy");
      if (
        current.dormant &&
        activeConversationCount(state) >= shared.LOCAL_BRIDGE_BOUNDS.maxActiveConversations
      ) {
        return shared.failure("busy");
      }
      const activityGeneration = shared.incrementActivityGeneration(current.activityGeneration);
      if (activityGeneration === undefined) return shared.failure("revision-exhausted");
      const reconnected = Object.freeze({
        ...current,
        activityGeneration,
        connected: true,
        dormant: false,
        negotiatedMinor: handshake.handshake.protocol.minor,
        replyTextNegotiated: false,
        replyChannelConnected: false,
        replyInFlight: false,
        replyInFlightDigest: null,
        replyRequestDigests: Object.freeze([]),
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
    if (current.connected) return shared.failure("busy");
    if (
      current.dormant &&
      activeConversationCount(state) >= shared.LOCAL_BRIDGE_BOUNDS.maxActiveConversations
    ) {
      return shared.failure("busy");
    }
    if (
      current.supersededSourceInstanceIds.length >=
      shared.LOCAL_BRIDGE_BOUNDS.maxSupersededSourceIds
    ) {
      return shared.failure("source-history-full");
    }
    if (current.sourceEpoch >= shared.LOCAL_BRIDGE_BOUNDS.maxSourceEpoch) {
      return shared.failure("revision-exhausted");
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
      negotiatedMinor: handshake.handshake.protocol.minor,
      replyTextNegotiated: false,
      replyChannelConnected: false,
      replyInFlight: false,
      replyInFlightDigest: null,
      replyRequestDigests: Object.freeze([]),
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
    return shared.failure("invalid-input");
  }
}

function parseReplyHandshakeInput(input: unknown): shared.LocalBridgeReplyHandshakeResult {
  return shared.copyBytes(input) !== undefined
    ? wire.parseLocalBridgeReplyHandshakeFrame(input)
    : wire.validateLocalBridgeReplyHandshake(input);
}

function parseReplyFrameInput(
  input: unknown,
  direction: shared.LocalBridgeReplyDirection,
): shared.LocalBridgeReplyFrameValidation {
  return shared.copyBytes(input) !== undefined
    ? wire.parseLocalBridgeReplyFrame(input, direction)
    : wire.validateLocalBridgeReplyFrame(input, direction);
}

function parseReplyReceiptInput(input: unknown): shared.LocalBridgeReplyFrameValidation {
  return parseReplyFrameInput(input, "producer-to-bridge");
}

function localReplyRequestDigest(requestId: string): string {
  return createHash("sha256").update(Buffer.from(requestId, "utf8")).digest("hex");
}

function rememberReplyDigest(recentDigests: readonly string[], digest: string): readonly string[] {
  const next = [...recentDigests, digest];
  if (next.length > shared.LOCAL_BRIDGE_BOUNDS.maxReplyRequestDigests) next.shift();
  return Object.freeze(next);
}

export function acceptLocalBridgeReplyHandshake(
  stateInput: unknown,
  input: unknown,
): shared.LocalBridgeTransition {
  try {
    const state = normalizedStateOrFailure(stateInput);
    if ("error" in state) return state;
    if (state.status === "closed") return shared.failure("closed");
    const parsed = parseReplyHandshakeInput(input);
    if (!parsed.ok) return parsed;
    const handshake = parsed.handshake;
    if (handshake.installationId !== state.installationId)
      return shared.failure("installation-mismatch");
    if (handshake.launchToken !== state.launchToken) return shared.failure("token-mismatch");
    const conversation = disconnectedConversation(
      state,
      handshake.sessionId,
      handshake.sourceInstanceId,
    );
    if ("error" in conversation) return conversation;
    if (!conversation.connected) return shared.failure("not-owner");
    if (conversation.negotiatedMinor !== shared.LOCAL_BRIDGE_DATA_MINOR) {
      return shared.failure("incompatible-protocol");
    }
    if (handshake.protocol.minor !== shared.LOCAL_BRIDGE_REPLY_MINOR) {
      return shared.failure("incompatible-protocol");
    }
    if (handshake.sourceEpoch !== conversation.sourceEpoch) return shared.failure("stale-source");
    if (conversation.replyChannelConnected) return shared.failure("busy");
    const connected = Object.freeze({
      ...conversation,
      replyTextNegotiated: true,
      replyChannelConnected: true,
      replyInFlight: false,
      replyInFlightDigest: null,
      replyRequestDigests: Object.freeze([]),
    });
    const nextState = freezeState(
      "open",
      state.installationId,
      state.launchToken,
      state.bridgeRevision,
      state.conversations.map((item) => (item === conversation ? connected : item)),
    );
    return stateTransition(
      nextState,
      "ready",
      state.bridgeRevision,
      conversation.sourceEpoch,
      conversation.sessionMirrorState.sessionId === null,
    );
  } catch {
    return shared.failure("invalid-input");
  }
}

export function routeLocalBridgeReply(
  stateInput: unknown,
  input: unknown,
): shared.LocalBridgeReplyRoute {
  try {
    const state = normalizedStateOrFailure(stateInput);
    if ("error" in state) return state;
    if (state.status === "closed") return shared.failure("closed");
    const command = commandReplyFrame(input);
    if (!command.ok) return command;
    const conversation = disconnectedConversation(
      state,
      command.sessionId,
      command.sourceInstanceId,
    );
    if ("error" in conversation) return conversation;
    if (!conversation.connected) return shared.failure("not-owner");
    if (!conversation.replyTextNegotiated) return shared.failure("reply-not-negotiated");
    if (!conversation.replyChannelConnected) return shared.failure("reply-channel-disconnected");
    const parsed = parseReplyFrameInput(command.frame, "bridge-to-producer");
    if (!parsed.ok) return parsed;
    if (parsed.frame.kind !== shared.REPLY_KIND) return shared.failure("wrong-direction");
    const requestDigest = localReplyRequestDigest(parsed.frame.requestId);
    if (conversation.replyRequestDigests.includes(requestDigest)) {
      return {
        ok: true,
        nextState: state,
        outcome: "duplicate",
      };
    }
    if (conversation.replyInFlight) return shared.failure("busy");
    const updated = Object.freeze({
      ...conversation,
      replyInFlight: true,
      replyInFlightDigest: requestDigest,
      replyRequestDigests: rememberReplyDigest(conversation.replyRequestDigests, requestDigest),
    });
    const nextState = freezeState(
      "open",
      state.installationId,
      state.launchToken,
      state.bridgeRevision,
      state.conversations.map((item) => (item === conversation ? updated : item)),
    );
    return {
      ok: true,
      nextState,
      request: parsed.frame,
      outcome: "forwarded",
    };
  } catch {
    return shared.failure("invalid-input");
  }
}

export function settleLocalBridgeReply(
  stateInput: unknown,
  input: unknown,
): shared.LocalBridgeReplySettlement {
  try {
    const state = normalizedStateOrFailure(stateInput);
    if ("error" in state) return state;
    if (state.status === "closed") return shared.failure("closed");
    const record = readOwnRecord(input);
    if (
      !record ||
      Object.keys(record).length !== 3 ||
      !Object.keys(record).every((key) =>
        ["sessionId", "sourceInstanceId", "receipt"].includes(key),
      )
    ) {
      return shared.failure("invalid-input");
    }
    const sessionId = shared.identity(record.sessionId);
    const sourceId = shared.sourceInstanceId(record.sourceInstanceId);
    if (!sessionId || !sourceId) return shared.failure("invalid-input");
    const conversation = disconnectedConversation(state, sessionId, sourceId);
    if ("error" in conversation) return conversation;
    if (!conversation.connected || !conversation.replyChannelConnected) {
      return shared.failure("reply-channel-disconnected");
    }
    if (!conversation.replyInFlight) return shared.failure("reply-not-pending");
    const parsed = parseReplyReceiptInput(record.receipt);
    if (!parsed.ok) return parsed;
    if (parsed.frame.kind !== shared.RECEIPT_KIND) return shared.failure("wrong-direction");
    const updated = Object.freeze({
      ...conversation,
      replyInFlight: false,
      replyInFlightDigest: null,
    });
    const nextState = freezeState(
      "open",
      state.installationId,
      state.launchToken,
      state.bridgeRevision,
      state.conversations.map((item) => (item === conversation ? updated : item)),
    );
    return { ok: true, nextState, receipt: parsed.frame };
  } catch {
    return shared.failure("invalid-input");
  }
}

export function closeLocalBridgeReplyChannel(
  stateInput: unknown,
  input: unknown,
): shared.LocalBridgeTransition {
  try {
    const state = normalizedStateOrFailure(stateInput);
    if ("error" in state) return state;
    if (state.status === "closed") return shared.failure("closed");
    const command = commandOwner(input);
    if (!command.ok) return command;
    const conversation = disconnectedConversation(
      state,
      command.sessionId,
      command.sourceInstanceId,
    );
    if ("error" in conversation) return conversation;
    if (!conversation.replyChannelConnected && !conversation.replyTextNegotiated) {
      return stateTransition(state, "disconnected", state.bridgeRevision, conversation.sourceEpoch);
    }
    const updated = Object.freeze({
      ...conversation,
      replyTextNegotiated: false,
      replyChannelConnected: false,
      replyInFlight: false,
      replyInFlightDigest: null,
      replyRequestDigests: Object.freeze([]),
    });
    const nextState = freezeState(
      "open",
      state.installationId,
      state.launchToken,
      state.bridgeRevision,
      state.conversations.map((item) => (item === conversation ? updated : item)),
    );
    return stateTransition(
      nextState,
      "disconnected",
      state.bridgeRevision,
      conversation.sourceEpoch,
    );
  } catch {
    return shared.failure("invalid-input");
  }
}

export function disconnectLocalBridge(
  stateInput: unknown,
  input: unknown,
): shared.LocalBridgeTransition {
  try {
    const state = normalizedStateOrFailure(stateInput);
    if ("error" in state) return state;
    if (state.status === "closed") return shared.failure("closed");
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
    const activityGeneration = shared.incrementActivityGeneration(conversation.activityGeneration);
    if (activityGeneration === undefined) return shared.failure("revision-exhausted");
    const disconnected = Object.freeze({
      ...conversation,
      activityGeneration,
      connected: false,
      negotiatedMinor: shared.LOCAL_BRIDGE_READ_ONLY_MINOR,
      replyTextNegotiated: false,
      replyChannelConnected: false,
      replyInFlight: false,
      replyInFlightDigest: null,
      replyRequestDigests: Object.freeze([]),
    });
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
    return shared.failure("invalid-input");
  }
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function applyLocalBridgeData(
  stateInput: unknown,
  input: unknown,
): shared.LocalBridgeTransition {
  try {
    const state = normalizedStateOrFailure(stateInput);
    if ("error" in state) return state;
    if (state.status === "closed") return shared.failure("closed");
    const command = commandIdentity(input);
    if (!command.ok) return command;
    const conversation = disconnectedConversation(
      state,
      command.sessionId,
      command.sourceInstanceId,
    );
    if ("error" in conversation) return conversation;
    if (!conversation.connected) return shared.failure("not-owner");
    const parsed = wire.parseLocalBridgeDataFrame(command.frame);
    if (!parsed.ok) return parsed;
    if (parsed.envelope.sessionId !== command.sessionId) return shared.failure("session-mismatch");
    if (
      conversation.sessionMirrorState.sessionId === null &&
      parsed.envelope.message.kind !== "snapshot"
    ) {
      return shared.failure("session-mirror-revision-gap");
    }

    const digest = sha256Bytes(parsed.rawBytes);
    const byteLength = parsed.rawBytes.byteLength;
    if (
      parsed.envelope.message.kind === "snapshot" &&
      conversation.lastSnapshotSha256 === digest &&
      conversation.lastSnapshotByteLength === byteLength &&
      conversation.lastSnapshotRevision === conversation.sessionMirrorState.revision
    ) {
      const activityGeneration = shared.incrementActivityGeneration(
        conversation.activityGeneration,
      );
      if (activityGeneration === undefined) return shared.failure("revision-exhausted");
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
    if (!applied.ok) return shared.failure(shared.mapSessionMirrorFailure(applied.error.category));
    if (applied.disposition === "duplicate") {
      const activityGeneration = shared.incrementActivityGeneration(
        conversation.activityGeneration,
      );
      if (activityGeneration === undefined) return shared.failure("revision-exhausted");
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
    if (state.bridgeRevision >= shared.LOCAL_BRIDGE_BOUNDS.maxBridgeRevision) {
      return shared.failure("revision-exhausted");
    }
    const nextBridgeRevision = state.bridgeRevision + 1;
    const activityGeneration = shared.incrementActivityGeneration(conversation.activityGeneration);
    if (activityGeneration === undefined) return shared.failure("revision-exhausted");
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
    return shared.failure("session-mirror-invalid");
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
  | shared.LocalBridgeFailure {
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
    return shared.failure("invalid-input");
  }
  const sessionId = shared.identity(record.sessionId);
  const sourceId = shared.sourceInstanceId(record.sourceInstanceId);
  const sourceEpoch = shared.uint(record.sourceEpoch, shared.LOCAL_BRIDGE_BOUNDS.maxSourceEpoch);
  const activityGeneration = shared.uint(
    record.activityGeneration,
    shared.LOCAL_BRIDGE_BOUNDS.maxActivityGeneration,
  );
  const elapsedMonotonicMinutes = shared.uint(
    record.elapsedMonotonicMinutes,
    Number.MAX_SAFE_INTEGER,
  );
  if (
    !sessionId ||
    !sourceId ||
    sourceEpoch === undefined ||
    sourceEpoch < 1 ||
    activityGeneration === undefined ||
    elapsedMonotonicMinutes === undefined ||
    elapsedMonotonicMinutes < shared.LOCAL_BRIDGE_BOUNDS.idleEvictionMinutes
  ) {
    return shared.failure("invalid-input");
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

export function evictIdleLocalBridge(
  stateInput: unknown,
  input: unknown,
): shared.LocalBridgeTransition {
  try {
    const state = normalizedStateOrFailure(stateInput);
    if ("error" in state) return state;
    if (state.status === "closed") return shared.failure("closed");
    const command = commandIdleEviction(input);
    if (!command.ok) return command;
    const conversation = state.conversations.find((item) => item.sessionId === command.sessionId);
    if (!conversation) return shared.failure("not-owner");
    if (conversation.supersededSourceInstanceIds.includes(command.sourceInstanceId)) {
      return shared.failure("stale-source");
    }
    if (conversation.ownerSourceInstanceId !== command.sourceInstanceId) {
      return shared.failure("not-owner");
    }
    if (
      conversation.sourceEpoch !== command.sourceEpoch ||
      conversation.activityGeneration !== command.activityGeneration
    ) {
      return shared.failure("stale-activity");
    }
    if (conversation.dormant) {
      return stateTransition(state, "evicted", state.bridgeRevision, conversation.sourceEpoch);
    }
    const evicted = Object.freeze({
      ...conversation,
      connected: false,
      dormant: true,
      negotiatedMinor: shared.LOCAL_BRIDGE_READ_ONLY_MINOR,
      replyTextNegotiated: false,
      replyChannelConnected: false,
      replyInFlight: false,
      replyInFlightDigest: null,
      replyRequestDigests: Object.freeze([]),
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
    return shared.failure("invalid-input");
  }
}

export function teardownLocalBridge(stateInput: unknown): shared.LocalBridgeTransition {
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
    return shared.failure("invalid-input");
  }
}

export function localBridgeFailureCodes(): readonly shared.LocalBridgeErrorCode[] {
  return shared.LOCAL_BRIDGE_ERROR_CODES;
}

export function localBridgeResultCodes(): readonly shared.LocalBridgeResultCode[] {
  return shared.LOCAL_BRIDGE_RESULT_CODES;
}

export function localBridgeSerializedByteLength(input: unknown): number | undefined {
  try {
    const normalized = shared.normalizeJson(input, shared.RETAINED_NORMALIZATION_LIMITS);
    return normalized.ok ? shared.serializedByteLength(normalized.value) : undefined;
  } catch {
    return undefined;
  }
}

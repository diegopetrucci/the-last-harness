import {
  createSessionMirrorReplyChannel,
  type SessionMirrorReplyChannel,
  type SessionMirrorReplyChannelOptions,
} from "./local-bridge-reply-channel.js";
import {
  parseReplyRequest,
  sourceInstanceId,
  validIdentity,
  type LocalBridgeReplyReceiptCode,
  type LocalBridgeReplyRequest,
} from "./local-bridge-boundary.js";
import type { option } from "./local-bridge-boundary.js";
import type { SessionMirrorObserverState } from "./observer.js";
import type { SessionMirrorObserverPublicationReady } from "./local-bridge-sink.js";
import type { SessionMirrorReadonlySessionManager } from "./session-adapter.js";

export const SESSION_MIRROR_REPLY_PRODUCER_MAX_REQUESTS = 64;
export const SESSION_MIRROR_REPLY_PRODUCER_MAX_CONFIRMATION_MS = 5_000;

export type SessionMirrorReplyProducerOutcome = LocalBridgeReplyReceiptCode;

export interface SessionMirrorReplyProducerState {
  readonly enabled: boolean;
  readonly sessionActive: boolean;
  readonly channel: "none" | "connecting" | "open";
  readonly inFlight: boolean;
  readonly busyLatch: boolean;
  readonly compactionLatched: boolean;
  readonly generation: number;
  readonly rememberedRequests: number;
  readonly accepted: number;
  readonly unconfirmed: number;
  readonly lastOutcome: SessionMirrorReplyProducerOutcome | undefined;
}

export interface SessionMirrorReplyProducerOptions {
  readonly enabled: boolean;
  readonly bridgeDirectory?: unknown;
  readonly getSessionManager: () => SessionMirrorReadonlySessionManager | undefined;
  readonly getObserverState: () => SessionMirrorObserverState;
  readonly sendUserMessage: (text: string) => PromiseLike<void> | void;
  /** Return true only when injection is safe at the instant it is called. */
  readonly isIdle?: () => boolean;
  readonly requestSnapshot: (allowActive?: boolean) => void;
  readonly createChannel?: (options: SessionMirrorReplyChannelOptions) => SessionMirrorReplyChannel;
  readonly now?: () => number;
  readonly scheduleConfirmation?: (task: () => void) => ReturnType<typeof setTimeout> | undefined;
  /** Schedule a lifecycle release after the upstream event handler returns. */
  readonly scheduleLifecycleCompletion?: (task: () => void) => void;
  readonly setTimeout?: (task: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  /** Receives only a fixed outcome code; source text and identifiers are never passed. */
  readonly notify?: (outcome: SessionMirrorReplyProducerOutcome) => void;
}

export interface SessionMirrorReplyProducer {
  readonly sessionStart: () => void;
  readonly sessionShutdown: () => void;
  readonly agentStart: () => void;
  readonly input: (event?: unknown) => void;
  readonly messageStart: (event?: unknown) => void;
  readonly messageEnd: (event?: unknown) => void;
  readonly turnEnd: () => void;
  readonly agentSettled: () => void;
  readonly sessionBeforeTree: () => void;
  readonly sessionTree: (event?: unknown, context?: unknown) => void;
  readonly sessionBeforeCompact: () => void;
  readonly sessionCompact: (event?: unknown, context?: unknown) => void;
  readonly sessionCompactFailed: (event?: unknown, context?: unknown) => void;
  readonly publicationReady: (info: unknown) => void;
  readonly handleReply: (input: unknown) => Promise<SessionMirrorReplyProducerOutcome>;
  readonly getState: () => SessionMirrorReplyProducerState;
}

type PendingReply = {
  readonly request: LocalBridgeReplyRequest;
  readonly token: number;
  readonly entryCount: number;
  readonly startedAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  confirmationTimer: ReturnType<typeof setTimeout> | undefined;
  confirmationScheduled: boolean;
  persistenceTimer: ReturnType<typeof setTimeout> | undefined;
  persistenceScheduled: boolean;
  messageEndObserved: boolean;
  injectionAttempted: boolean;
  settled: boolean;
  resolve: (outcome: SessionMirrorReplyProducerOutcome) => void;
};

type MessageRecord = {
  readonly role: unknown;
  readonly content: unknown;
};

type LifecycleOperation = {
  readonly kind: "tree" | "compaction";
  readonly serial: number;
  completed: boolean;
  completionEvidenceValid: boolean;
  willRetry: boolean;
  context: unknown;
  release?: (idleEvidence?: boolean) => void;
};

const MAX_COUNTER = 2_000_000_000;
const MAX_CONFIRMATION_DELAY_MS = SESSION_MIRROR_REPLY_PRODUCER_MAX_CONFIRMATION_MS;
const CHANNEL_STATES = ["connecting", "open"] as const;

function nextCounter(value: number): number {
  return value >= MAX_COUNTER ? 1 : value + 1;
}

function boundedCounter(value: number): number {
  return value >= MAX_COUNTER ? MAX_COUNTER : value + 1;
}

function safeNow(now: () => number): number {
  try {
    const value = now();
    return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
  } catch {
    return Date.now();
  }
}

function safeClear(
  clear: (timer: ReturnType<typeof setTimeout>) => void,
  timer: ReturnType<typeof setTimeout> | undefined,
): void {
  if (timer === undefined) return;
  try {
    clear(timer);
  } catch {}
}

function method<T>(value: unknown, name: string): ((this: unknown) => T) | undefined {
  if (value === null || typeof value !== "object") return undefined;
  try {
    let current: object | null = value;
    for (let depth = 0; current !== null && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor) {
        return Object.hasOwn(descriptor, "value") && typeof descriptor.value === "function"
          ? (descriptor.value as (this: unknown) => T)
          : undefined;
      }
      current = Object.getPrototypeOf(current);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function field(value: unknown, name: string): ReturnType<typeof option> {
  if (value === null || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function booleanField(value: unknown, name: string): boolean | undefined {
  const candidate = field(value, name);
  return typeof candidate === "boolean" ? candidate : undefined;
}

function weakSetKey(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function lifecycleIsIdle(context: unknown, fallback: (() => boolean) | undefined): boolean {
  if (context !== undefined) {
    const contextIsIdle = method<boolean>(context, "isIdle");
    if (contextIsIdle === undefined) return false;
    try {
      return contextIsIdle.call(context) === true;
    } catch {
      return false;
    }
  }
  try {
    return fallback?.() === true;
  } catch {
    return false;
  }
}

function messageRecord(value: unknown): MessageRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const role = field(value, "role");
  const content = field(value, "content");
  return role === undefined && content === undefined ? undefined : { role, content };
}

function plainText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  let result = "";
  for (const block of value) {
    if (block === null || typeof block !== "object" || Array.isArray(block)) return undefined;
    if (field(block, "type") !== "text") return undefined;
    const text = field(block, "text");
    if (typeof text !== "string") return undefined;
    result += text;
  }
  return result;
}

function managerEntries(
  manager: SessionMirrorReadonlySessionManager | undefined,
): readonly unknown[] | undefined {
  if (manager === undefined) return undefined;
  try {
    const getEntries = method<unknown>(manager, "getEntries");
    if (getEntries === undefined) return undefined;
    const entries = getEntries.call(manager);
    return Array.isArray(entries) ? entries : undefined;
  } catch {
    return undefined;
  }
}

function targetBranchId(
  manager: SessionMirrorReadonlySessionManager,
  expectedBranchId: string,
): { readonly leafId: string; readonly entryCount: number } | undefined {
  try {
    const getLeafId = method<unknown>(manager, "getLeafId");
    if (getLeafId === undefined) return undefined;
    const leafId = validIdentity(getLeafId.call(manager));
    if (leafId === undefined) return undefined;
    const entries = managerEntries(manager);
    if (entries === undefined) return undefined;
    const parents = new Map<string, string | null>();
    for (const entry of entries) {
      const id = validIdentity(field(entry, "id"));
      const parent = field(entry, "parentId");
      if (id === undefined || !(parent === null || validIdentity(parent) !== undefined)) {
        return undefined;
      }
      if (parents.has(id)) return undefined;
      parents.set(id, parent as string | null);
    }

    let current: string | null = leafId;
    const seen = new Set<string>();
    while (current !== null) {
      if (current === expectedBranchId) return { leafId, entryCount: entries.length };
      if (seen.has(current) || seen.size >= entries.length) return undefined;
      seen.add(current);
      const parent = parents.get(current);
      if (parent === undefined) return undefined;
      current = parent;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function publishedTarget(value: unknown): SessionMirrorObserverPublicationReady | undefined {
  const sessionId = validIdentity(field(value, "sessionId"));
  const sourceIdValue = field(value, "sourceInstanceId");
  const sourceInstance =
    typeof sourceIdValue === "string" ? sourceInstanceId(sourceIdValue) : undefined;
  const sourceEpoch = field(value, "sourceEpoch");
  const branchId = validIdentity(field(value, "branchId"));
  const leafId = validIdentity(field(value, "leafId"));
  const sourceRevision = field(value, "sourceRevision");
  if (
    sessionId === undefined ||
    sourceInstance === undefined ||
    typeof sourceEpoch !== "number" ||
    !Number.isSafeInteger(sourceEpoch) ||
    sourceEpoch <= 0 ||
    sourceEpoch > Number.MAX_SAFE_INTEGER - 1 ||
    branchId === undefined ||
    leafId === undefined ||
    typeof sourceRevision !== "number" ||
    !Number.isSafeInteger(sourceRevision) ||
    Object.is(sourceRevision, -0) ||
    sourceRevision <= 0 ||
    sourceRevision > Number.MAX_SAFE_INTEGER - 1
  ) {
    return undefined;
  }
  return Object.freeze({
    sessionId,
    sourceInstanceId: sourceInstance,
    sourceEpoch,
    branchId,
    leafId,
    sourceRevision,
  });
}

function hasPersistedUserMessage(
  manager: SessionMirrorReadonlySessionManager | undefined,
  pending: PendingReply,
): boolean {
  const entries = managerEntries(manager);
  if (entries === undefined || entries.length <= pending.entryCount) return false;
  for (let index = pending.entryCount; index < entries.length; index += 1) {
    const entry = entries[index];
    if (field(entry, "type") !== "message") continue;
    const message = messageRecord(field(entry, "message"));
    if (message?.role !== "user") continue;
    if (plainText(message.content) === pending.request.text) return true;
  }
  return false;
}

function eventText(event: unknown): string | undefined {
  const text = field(event, "text");
  return typeof text === "string" ? text : undefined;
}

function normalizeOutcome(value: unknown): SessionMirrorReplyProducerOutcome {
  return typeof value === "string" &&
    [
      "accepted",
      "unconfirmed",
      "invalid",
      "unauthorized",
      "stale",
      "busy",
      "duplicate",
      "expired",
      "disconnected",
    ].includes(value)
    ? (value as SessionMirrorReplyProducerOutcome)
    : "unconfirmed";
}

function channelState(
  channel: SessionMirrorReplyChannel | undefined,
): "none" | "connecting" | "open" {
  if (channel === undefined) return "none";
  try {
    const value = channel.getState();
    return CHANNEL_STATES.includes(value as (typeof CHANNEL_STATES)[number])
      ? (value as "connecting" | "open")
      : "none";
  } catch {
    return "none";
  }
}

export function createSessionMirrorReplyProducer(
  options: SessionMirrorReplyProducerOptions,
): SessionMirrorReplyProducer {
  const enabled = options.enabled === true;
  const now = options.now ?? (() => Date.now());
  const scheduleConfirmation =
    options.scheduleConfirmation ??
    ((task: () => void) => setTimeout(task, MAX_CONFIRMATION_DELAY_MS));
  const scheduleLifecycleCompletion =
    options.scheduleLifecycleCompletion ?? ((task: () => void) => void setTimeout(task, 0));
  const setTimer = options.setTimeout ?? ((task, delay) => setTimeout(task, delay));
  const clear =
    options.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const createChannel = options.createChannel ?? createSessionMirrorReplyChannel;
  let sessionActive = false;
  let generation = 0;
  let busyLatch = false;
  let agentActive = false;
  let compactionLatched = false;
  let lifecycleSerial = 0;
  let lifecycleOperation: LifecycleOperation | undefined;
  let completedCompactionEvents = new WeakSet<object>();
  let channel: SessionMirrorReplyChannel | undefined;
  let channelGeneration: number | undefined;
  let channelSerial = 0;
  let publishedSnapshot: SessionMirrorObserverPublicationReady | undefined;
  let pending: PendingReply | undefined;
  let awaitingInjectedInput: PendingReply | undefined;
  let rememberedRequests: string[] = [];
  let accepted = 0;
  let unconfirmed = 0;
  let lastOutcome: SessionMirrorReplyProducerOutcome | undefined;

  const notify = (outcome: SessionMirrorReplyProducerOutcome): void => {
    try {
      options.notify?.(outcome);
    } catch {}
  };

  const beginLifecycleOperation = (kind: LifecycleOperation["kind"]): void => {
    lifecycleSerial = nextCounter(lifecycleSerial);
    lifecycleOperation = {
      kind,
      serial: lifecycleSerial,
      completed: false,
      completionEvidenceValid: true,
      willRetry: false,
      context: undefined,
    };
  };

  const completeLifecycleOperation = (
    kind: LifecycleOperation["kind"],
    event: unknown,
    context: unknown,
  ): void => {
    const operation = lifecycleOperation;
    if (operation === undefined || operation.kind !== kind || operation.completed) return;
    if (kind === "compaction" && weakSetKey(event)) completedCompactionEvents.add(event);
    const willRetry = booleanField(event, "willRetry");
    operation.completed = true;
    operation.completionEvidenceValid =
      kind !== "compaction" || (event !== undefined && willRetry !== undefined);
    operation.willRetry = willRetry === true;
    operation.context = context;
    const operationSerial = operation.serial;
    const release = (idleEvidence = false): void => {
      if (
        !sessionActive ||
        lifecycleOperation !== operation ||
        lifecycleOperation.serial !== operationSerial ||
        !operation.completed
      )
        return;
      // An automatic compaction with a guaranteed retry is still active even
      // when a malformed or synthetic context reports idle.
      if (
        !operation.completionEvidenceValid ||
        operation.willRetry ||
        (!idleEvidence && !lifecycleIsIdle(operation.context, options.isIdle))
      )
        return;
      lifecycleOperation = undefined;
      if (operation.kind === "compaction") compactionLatched = false;
      if (!agentActive) busyLatch = false;
    };
    operation.release = release;
    const idle =
      operation.completionEvidenceValid &&
      !operation.willRetry &&
      lifecycleIsIdle(operation.context, options.isIdle);
    if (idle) {
      release(true);
      return;
    }
    if (!operation.completionEvidenceValid || operation.willRetry) return;
    try {
      scheduleLifecycleCompletion(() => release());
    } catch {}
  };

  const refreshCompletedLifecycleOperation = (): void => {
    const operation = lifecycleOperation;
    if (operation === undefined || !operation.completed || operation.release === undefined) return;
    operation.release();
  };

  const remember = (requestId: string): void => {
    rememberedRequests = [...rememberedRequests, requestId];
    if (rememberedRequests.length > SESSION_MIRROR_REPLY_PRODUCER_MAX_REQUESTS) {
      rememberedRequests = rememberedRequests.slice(-SESSION_MIRROR_REPLY_PRODUCER_MAX_REQUESTS);
    }
  };

  const settle = (candidate: PendingReply, outcome: SessionMirrorReplyProducerOutcome): void => {
    if (candidate.settled || pending !== candidate) return;
    candidate.settled = true;
    safeClear(clear, candidate.timer);
    safeClear(clear, candidate.confirmationTimer);
    safeClear(clear, candidate.persistenceTimer);
    candidate.timer = undefined;
    candidate.confirmationTimer = undefined;
    candidate.persistenceTimer = undefined;
    if (awaitingInjectedInput === candidate) awaitingInjectedInput = undefined;
    pending = undefined;
    const normalized = normalizeOutcome(outcome);
    lastOutcome = normalized;
    if (normalized === "accepted") accepted = boundedCounter(accepted);
    if (normalized === "unconfirmed") unconfirmed = boundedCounter(unconfirmed);
    if (normalized !== "accepted" && !agentActive && lifecycleOperation === undefined) {
      busyLatch = false;
    }
    if (normalized === "accepted" || normalized === "unconfirmed") notify(normalized);
    candidate.resolve(normalized);
  };

  const invalidatePending = (outcome: SessionMirrorReplyProducerOutcome): void => {
    const candidate = pending;
    if (candidate !== undefined) settle(candidate, outcome);
  };

  const acceptIfPersisted = (candidate: PendingReply): void => {
    if (candidate.settled || pending !== candidate || !sessionActive) return;
    if (candidate.token !== generation || compactionLatched || !candidate.messageEndObserved) {
      settle(candidate, "unconfirmed");
      return;
    }
    let manager: SessionMirrorReadonlySessionManager | undefined;
    try {
      manager = options.getSessionManager();
    } catch {
      settle(candidate, "unconfirmed");
      return;
    }
    if (!hasPersistedUserMessage(manager, candidate)) return;
    settle(candidate, "accepted");
    try {
      options.requestSnapshot(true);
    } catch {}
  };

  const armConfirmationDeadline = (candidate: PendingReply): void => {
    if (candidate.confirmationScheduled || candidate.settled || pending !== candidate) return;
    candidate.confirmationScheduled = true;
    try {
      const timer = scheduleConfirmation(() => {
        if (candidate.settled || pending !== candidate || !sessionActive) return;
        if (candidate.token !== generation || compactionLatched) {
          settle(candidate, "unconfirmed");
          return;
        }
        settle(candidate, "unconfirmed");
      });
      candidate.confirmationTimer = timer;
      if (candidate.settled) safeClear(clear, timer);
    } catch {
      settle(candidate, "unconfirmed");
    }
  };

  const schedulePersistedCheck = (candidate: PendingReply): void => {
    if (candidate.persistenceScheduled || candidate.settled || pending !== candidate) return;
    candidate.persistenceScheduled = true;
    const check = (): void => {
      candidate.persistenceScheduled = false;
      candidate.persistenceTimer = undefined;
      acceptIfPersisted(candidate);
    };
    try {
      const timer = setTimer(check, 0);
      if (timer === undefined) throw new Error("reply persistence timer unavailable");
      candidate.persistenceTimer = timer;
      if (candidate.settled) safeClear(clear, timer);
    } catch {
      try {
        const timer = setTimeout(check, 0);
        if (timer === undefined) throw new Error("reply persistence fallback unavailable");
        candidate.persistenceTimer = timer;
        if (candidate.settled) safeClear(clear, timer);
      } catch {
        settle(candidate, "unconfirmed");
      }
    }
  };

  const handleReply = async (input: unknown): Promise<SessionMirrorReplyProducerOutcome> => {
    const request = parseReplyRequest(input);
    if (request === undefined) return "invalid";
    if (!enabled || !sessionActive) return "unauthorized";
    if (rememberedRequests.includes(request.requestId)) return "duplicate";
    if (pending !== undefined) return "busy";
    if (busyLatch || compactionLatched) {
      refreshCompletedLifecycleOperation();
      if (busyLatch || compactionLatched) return "busy";
    }

    let observerState: SessionMirrorObserverState;
    try {
      observerState = options.getObserverState();
      if (observerState === null || typeof observerState !== "object") return "unauthorized";
    } catch {
      return "unauthorized";
    }

    try {
      if (
        observerState.enabled !== true ||
        observerState.attestation !== "attested" ||
        observerState.status !== "idle" ||
        observerState.settled !== true ||
        observerState.dirty !== false ||
        observerState.snapshotRequired !== false ||
        observerState.publicationPending !== false ||
        observerState.sinkInFlight !== false ||
        typeof observerState.successfulPublications !== "number" ||
        !Number.isSafeInteger(observerState.successfulPublications) ||
        observerState.successfulPublications < 1
      ) {
        return "stale";
      }
      if (
        !Number.isSafeInteger(generation) ||
        generation !== request.generation ||
        !Number.isSafeInteger(observerState.generation) ||
        observerState.generation !== generation ||
        !Number.isSafeInteger(observerState.revision) ||
        Object.is(observerState.revision, -0) ||
        observerState.revision !== request.sourceRevision
      ) {
        return "stale";
      }
    } catch {
      return "unauthorized";
    }

    let manager: SessionMirrorReadonlySessionManager | undefined;
    try {
      manager = options.getSessionManager();
    } catch {
      return "stale";
    }
    if (manager === undefined) return "stale";
    const publication = publishedSnapshot;
    if (publication === undefined) return "stale";
    const target = targetBranchId(manager, publication.branchId);
    if (
      observerState.revision !== publication.sourceRevision ||
      request.branchId !== publication.branchId ||
      request.leafId !== publication.leafId ||
      request.sourceRevision !== publication.sourceRevision ||
      target === undefined ||
      target.leafId !== publication.leafId
    ) {
      return "stale";
    }

    const startedAt = safeNow(now);
    const baseline = target.entryCount;
    const token = generation;
    remember(request.requestId);
    const result = await new Promise<SessionMirrorReplyProducerOutcome>((resolve) => {
      const candidate: PendingReply = {
        request,
        token,
        entryCount: baseline,
        startedAt,
        timer: undefined,
        confirmationTimer: undefined,
        confirmationScheduled: false,
        persistenceTimer: undefined,
        persistenceScheduled: false,
        messageEndObserved: false,
        injectionAttempted: false,
        settled: false,
        resolve,
      };
      pending = candidate;
      awaitingInjectedInput = candidate;
      busyLatch = true;
      const delay = Math.max(1, request.ttlSeconds * 1000);
      try {
        // TTL bounds admission only. After injection, the confirmation deadline
        // remains open so a persisted completion can still win the race.
        const timer = setTimer(() => {
          if (!candidate.injectionAttempted) settle(candidate, "expired");
        }, delay);
        if (timer === undefined) throw new Error("reply confirmation timer unavailable");
        candidate.timer = timer;
        if (candidate.settled) safeClear(clear, timer);
      } catch {
        if (!candidate.settled && pending === candidate) {
          try {
            const timer = setTimeout(() => {
              if (!candidate.injectionAttempted) settle(candidate, "expired");
            }, delay);
            if (timer === undefined) throw new Error("reply confirmation fallback unavailable");
            candidate.timer = timer;
            if (candidate.settled) safeClear(clear, timer);
          } catch {
            settle(candidate, "expired");
          }
        }
      }
      if (candidate.settled || pending !== candidate) return;
      let idle = false;
      try {
        idle = options.isIdle?.() === true;
      } catch {}
      if (!idle) {
        settle(candidate, "busy");
        return;
      }
      if (candidate.settled || pending !== candidate) return;
      if (safeNow(now) - candidate.startedAt >= request.ttlSeconds * 1000) {
        settle(candidate, "expired");
        return;
      }
      // Mark the boundary before the call: throws and rejections are unknown
      // send outcomes, never no-injection expiry.
      candidate.injectionAttempted = true;
      try {
        const sent = options.sendUserMessage(request.text);
        if (sent !== undefined && typeof sent.then === "function") {
          Promise.resolve(sent).catch(() => settle(candidate, "unconfirmed"));
        }
        armConfirmationDeadline(candidate);
      } catch {
        settle(candidate, "unconfirmed");
      }
    });
    return result;
  };

  const publicationReady = (input: unknown): void => {
    if (!enabled || !sessionActive) return;
    const target = publishedTarget(input);
    if (target === undefined) return;
    const previous = channel;
    const previousTarget = publishedSnapshot;
    const sameOwner =
      previous !== undefined &&
      previousTarget !== undefined &&
      channelGeneration === generation &&
      previousTarget.sessionId === target.sessionId &&
      previousTarget.sourceInstanceId === target.sourceInstanceId &&
      previousTarget.sourceEpoch === target.sourceEpoch;
    if (sameOwner && channelState(previous) !== "none") {
      publishedSnapshot = target;
      return;
    }
    if (previous !== undefined) {
      invalidatePending("disconnected");
      channel = undefined;
      channelGeneration = undefined;
      bestEffortClose(previous, "owner-replaced");
    }
    publishedSnapshot = target;
    const serial = nextCounter(channelSerial);
    channelSerial = serial;
    let next: SessionMirrorReplyChannel;
    try {
      next = createChannel({
        bridgeDirectory: options.bridgeDirectory,
        sessionId: target.sessionId,
        sourceInstanceId: target.sourceInstanceId,
        sourceEpoch: target.sourceEpoch,
        generation,
        onRequest: handleReply,
        onClosed: () => {
          if (channel !== next) return;
          channel = undefined;
          channelGeneration = undefined;
          publishedSnapshot = undefined;
          invalidatePending("disconnected");
        },
      });
    } catch {
      return;
    }
    channel = next;
    channelGeneration = generation;
    let opening: Promise<boolean>;
    try {
      opening = next.open();
    } catch {
      if (channel === next) {
        channel = undefined;
        channelGeneration = undefined;
        publishedSnapshot = undefined;
      }
      bestEffortClose(next, "owner-replaced");
      return;
    }
    void Promise.resolve(opening).then(
      (opened) => {
        if (channel !== next || serial !== channelSerial || opened !== true) {
          if (channel === next) {
            channel = undefined;
            channelGeneration = undefined;
            publishedSnapshot = undefined;
          }
          bestEffortClose(next, "owner-replaced");
        }
      },
      () => {
        if (channel === next) {
          channel = undefined;
          channelGeneration = undefined;
          publishedSnapshot = undefined;
        }
        bestEffortClose(next, "owner-replaced");
      },
    );
  };

  const sessionStart = (): void => {
    sessionActive = true;
    generation = nextCounter(generation);
    busyLatch = false;
    agentActive = false;
    compactionLatched = false;
    lifecycleOperation = undefined;
    completedCompactionEvents = new WeakSet<object>();
    rememberedRequests = [];
    invalidatePending("disconnected");
    publishedSnapshot = undefined;
    const previous = channel;
    channel = undefined;
    channelGeneration = undefined;
    if (previous !== undefined) bestEffortClose(previous, "owner-replaced");
  };

  const sessionShutdown = (): void => {
    sessionActive = false;
    generation = nextCounter(generation);
    busyLatch = false;
    agentActive = false;
    compactionLatched = false;
    lifecycleOperation = undefined;
    completedCompactionEvents = new WeakSet<object>();
    rememberedRequests = [];
    invalidatePending("disconnected");
    publishedSnapshot = undefined;
    const previous = channel;
    channel = undefined;
    channelGeneration = undefined;
    if (previous !== undefined) bestEffortClose(previous, "producer-disconnect");
  };

  const agentStart = (): void => {
    agentActive = true;
    busyLatch = true;
  };

  const input = (event?: unknown): void => {
    const candidate = pending;
    if (
      candidate !== undefined &&
      awaitingInjectedInput === candidate &&
      field(event, "source") === "extension" &&
      eventText(event) === candidate.request.text
    ) {
      awaitingInjectedInput = undefined;
      return;
    }
    invalidatePending("unconfirmed");
    agentActive = true;
    busyLatch = true;
  };

  const messageStart = (event?: unknown): void => {
    const message = messageRecord(field(event, "message"));
    if (message?.role === "user" || message?.role === "assistant") {
      agentActive = true;
      busyLatch = true;
    }
  };

  const messageEnd = (event?: unknown): void => {
    const candidate = pending;
    if (candidate === undefined || candidate.settled || compactionLatched) return;
    const message = messageRecord(field(event, "message"));
    if (message?.role !== "user" || plainText(message.content) !== candidate.request.text) return;
    candidate.messageEndObserved = true;
    schedulePersistedCheck(candidate);
  };

  const turnEnd = (): void => {
    agentActive = true;
    busyLatch = true;
  };

  const agentSettled = (): void => {
    agentActive = false;
    lifecycleOperation = undefined;
    busyLatch = false;
    compactionLatched = false;
  };

  const sessionBeforeTree = (): void => {
    beginLifecycleOperation("tree");
    invalidatePending("unconfirmed");
    busyLatch = true;
  };

  const sessionTree = (event?: unknown, context?: unknown): void => {
    busyLatch = true;
    completeLifecycleOperation("tree", event, context);
  };

  const sessionBeforeCompact = (): void => {
    beginLifecycleOperation("compaction");
    compactionLatched = true;
    invalidatePending("unconfirmed");
    busyLatch = true;
  };

  const sessionCompact = (event?: unknown, context?: unknown): void => {
    busyLatch = true;
    completeLifecycleOperation("compaction", event, context);
  };

  const sessionCompactFailed = (event?: unknown, context?: unknown): void => {
    if (
      lifecycleOperation === undefined &&
      weakSetKey(event) &&
      completedCompactionEvents.has(event)
    )
      return;
    busyLatch = true;
    if (lifecycleOperation === undefined) {
      beginLifecycleOperation("compaction");
      compactionLatched = true;
    }
    completeLifecycleOperation("compaction", event, context);
  };

  const getState = (): SessionMirrorReplyProducerState =>
    Object.freeze({
      enabled,
      sessionActive,
      channel: channelState(channel),
      inFlight: pending !== undefined,
      busyLatch,
      compactionLatched,
      generation,
      rememberedRequests: rememberedRequests.length,
      accepted,
      unconfirmed,
      lastOutcome,
    });

  return Object.freeze({
    sessionStart,
    sessionShutdown,
    agentStart,
    input,
    messageStart,
    messageEnd,
    turnEnd,
    agentSettled,
    sessionBeforeTree,
    sessionTree,
    sessionBeforeCompact,
    sessionCompact,
    sessionCompactFailed,
    publicationReady,
    handleReply,
    getState,
  });
}

function bestEffortClose(
  channel: SessionMirrorReplyChannel,
  reason: "producer-disconnect" | "owner-replaced",
): void {
  try {
    channel.close(reason);
  } catch {}
}

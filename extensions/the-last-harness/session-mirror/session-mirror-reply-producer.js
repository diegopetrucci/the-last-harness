import { createSessionMirrorReplyChannel, } from "./local-bridge-reply-channel.js";
import { parseReplyRequest, sourceInstanceId, validIdentity, } from "./local-bridge-boundary.js";
export const SESSION_MIRROR_REPLY_PRODUCER_MAX_REQUESTS = 64;
export const SESSION_MIRROR_REPLY_PRODUCER_MAX_CONFIRMATION_MS = 5_000;
const MAX_COUNTER = 2_000_000_000;
const MAX_CONFIRMATION_DELAY_MS = SESSION_MIRROR_REPLY_PRODUCER_MAX_CONFIRMATION_MS;
const CHANNEL_STATES = ["connecting", "open"];
function nextCounter(value) {
    return value >= MAX_COUNTER ? 1 : value + 1;
}
function boundedCounter(value) {
    return value >= MAX_COUNTER ? MAX_COUNTER : value + 1;
}
function safeNow(now) {
    try {
        const value = now();
        return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
    }
    catch {
        return Date.now();
    }
}
function safeClear(clear, timer) {
    if (timer === undefined)
        return;
    try {
        clear(timer);
    }
    catch { }
}
function method(value, name) {
    if (value === null || typeof value !== "object")
        return undefined;
    try {
        let current = value;
        for (let depth = 0; current !== null && depth < 8; depth += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(current, name);
            if (descriptor) {
                return Object.hasOwn(descriptor, "value") && typeof descriptor.value === "function"
                    ? descriptor.value
                    : undefined;
            }
            current = Object.getPrototypeOf(current);
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
function field(value, name) {
    if (value === null || typeof value !== "object")
        return undefined;
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
    }
    catch {
        return undefined;
    }
}
function messageRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const role = field(value, "role");
    const content = field(value, "content");
    return role === undefined && content === undefined ? undefined : { role, content };
}
function plainText(value) {
    if (typeof value === "string")
        return value;
    if (!Array.isArray(value) || value.length === 0)
        return undefined;
    let result = "";
    for (const block of value) {
        if (block === null || typeof block !== "object" || Array.isArray(block))
            return undefined;
        if (field(block, "type") !== "text")
            return undefined;
        const text = field(block, "text");
        if (typeof text !== "string")
            return undefined;
        result += text;
    }
    return result;
}
function managerEntries(manager) {
    if (manager === undefined)
        return undefined;
    try {
        const getEntries = method(manager, "getEntries");
        if (getEntries === undefined)
            return undefined;
        const entries = getEntries.call(manager);
        return Array.isArray(entries) ? entries : undefined;
    }
    catch {
        return undefined;
    }
}
function targetBranchId(manager, expectedBranchId) {
    try {
        const getLeafId = method(manager, "getLeafId");
        if (getLeafId === undefined)
            return undefined;
        const leafId = validIdentity(getLeafId.call(manager));
        if (leafId === undefined)
            return undefined;
        const entries = managerEntries(manager);
        if (entries === undefined)
            return undefined;
        const parents = new Map();
        for (const entry of entries) {
            const id = validIdentity(field(entry, "id"));
            const parent = field(entry, "parentId");
            if (id === undefined || !(parent === null || validIdentity(parent) !== undefined)) {
                return undefined;
            }
            if (parents.has(id))
                return undefined;
            parents.set(id, parent);
        }
        let current = leafId;
        const seen = new Set();
        while (current !== null) {
            if (current === expectedBranchId)
                return { leafId, entryCount: entries.length };
            if (seen.has(current) || seen.size >= entries.length)
                return undefined;
            seen.add(current);
            const parent = parents.get(current);
            if (parent === undefined)
                return undefined;
            current = parent;
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
function publishedTarget(value) {
    const sessionId = validIdentity(field(value, "sessionId"));
    const sourceIdValue = field(value, "sourceInstanceId");
    const sourceInstance = typeof sourceIdValue === "string" ? sourceInstanceId(sourceIdValue) : undefined;
    const sourceEpoch = field(value, "sourceEpoch");
    const branchId = validIdentity(field(value, "branchId"));
    const leafId = validIdentity(field(value, "leafId"));
    const sourceRevision = field(value, "sourceRevision");
    if (sessionId === undefined ||
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
        sourceRevision > Number.MAX_SAFE_INTEGER - 1) {
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
function hasPersistedUserMessage(manager, pending) {
    const entries = managerEntries(manager);
    if (entries === undefined || entries.length <= pending.entryCount)
        return false;
    for (let index = pending.entryCount; index < entries.length; index += 1) {
        const entry = entries[index];
        if (field(entry, "type") !== "message")
            continue;
        const message = messageRecord(field(entry, "message"));
        if (message?.role !== "user")
            continue;
        if (plainText(message.content) === pending.request.text)
            return true;
    }
    return false;
}
function eventText(event) {
    const text = field(event, "text");
    return typeof text === "string" ? text : undefined;
}
function normalizeOutcome(value) {
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
        ? value
        : "unconfirmed";
}
function channelState(channel) {
    if (channel === undefined)
        return "none";
    try {
        const value = channel.getState();
        return CHANNEL_STATES.includes(value)
            ? value
            : "none";
    }
    catch {
        return "none";
    }
}
export function createSessionMirrorReplyProducer(options) {
    const enabled = options.enabled === true;
    const now = options.now ?? (() => Date.now());
    const scheduleConfirmation = options.scheduleConfirmation ??
        ((task) => setTimeout(task, MAX_CONFIRMATION_DELAY_MS));
    const setTimer = options.setTimeout ?? ((task, delay) => setTimeout(task, delay));
    const clear = options.clearTimeout ?? ((timer) => clearTimeout(timer));
    const createChannel = options.createChannel ?? createSessionMirrorReplyChannel;
    let sessionActive = false;
    let generation = 0;
    let busyLatch = false;
    let compactionLatched = false;
    let channel;
    let channelSerial = 0;
    let publishedSnapshot;
    let pending;
    let awaitingInjectedInput;
    let rememberedRequests = [];
    let accepted = 0;
    let unconfirmed = 0;
    let lastOutcome;
    const notify = (outcome) => {
        try {
            options.notify?.(outcome);
        }
        catch { }
    };
    const remember = (requestId) => {
        rememberedRequests = [...rememberedRequests, requestId];
        if (rememberedRequests.length > SESSION_MIRROR_REPLY_PRODUCER_MAX_REQUESTS) {
            rememberedRequests = rememberedRequests.slice(-SESSION_MIRROR_REPLY_PRODUCER_MAX_REQUESTS);
        }
    };
    const settle = (candidate, outcome) => {
        if (candidate.settled || pending !== candidate)
            return;
        candidate.settled = true;
        safeClear(clear, candidate.timer);
        safeClear(clear, candidate.confirmationTimer);
        safeClear(clear, candidate.persistenceTimer);
        candidate.timer = undefined;
        candidate.confirmationTimer = undefined;
        candidate.persistenceTimer = undefined;
        if (awaitingInjectedInput === candidate)
            awaitingInjectedInput = undefined;
        pending = undefined;
        const normalized = normalizeOutcome(outcome);
        lastOutcome = normalized;
        if (normalized === "accepted")
            accepted = boundedCounter(accepted);
        if (normalized === "unconfirmed")
            unconfirmed = boundedCounter(unconfirmed);
        if (normalized !== "accepted")
            busyLatch = false;
        if (normalized === "accepted" || normalized === "unconfirmed")
            notify(normalized);
        candidate.resolve(normalized);
    };
    const invalidatePending = (outcome) => {
        const candidate = pending;
        if (candidate !== undefined)
            settle(candidate, outcome);
    };
    const acceptIfPersisted = (candidate) => {
        if (candidate.settled || pending !== candidate || !sessionActive)
            return;
        if (candidate.token !== generation || compactionLatched || !candidate.messageEndObserved) {
            settle(candidate, "unconfirmed");
            return;
        }
        if (safeNow(now) - candidate.startedAt >= candidate.request.ttlSeconds * 1000) {
            settle(candidate, "expired");
            return;
        }
        let manager;
        try {
            manager = options.getSessionManager();
        }
        catch {
            settle(candidate, "unconfirmed");
            return;
        }
        if (!hasPersistedUserMessage(manager, candidate))
            return;
        settle(candidate, "accepted");
        try {
            options.requestSnapshot(true);
        }
        catch { }
    };
    const armConfirmationDeadline = (candidate) => {
        if (candidate.confirmationScheduled || candidate.settled || pending !== candidate)
            return;
        candidate.confirmationScheduled = true;
        try {
            const timer = scheduleConfirmation(() => {
                if (candidate.settled || pending !== candidate || !sessionActive)
                    return;
                if (candidate.token !== generation || compactionLatched) {
                    settle(candidate, "unconfirmed");
                    return;
                }
                settle(candidate, "unconfirmed");
            });
            candidate.confirmationTimer = timer;
            if (candidate.settled)
                safeClear(clear, timer);
        }
        catch {
            settle(candidate, "unconfirmed");
        }
    };
    const schedulePersistedCheck = (candidate) => {
        if (candidate.persistenceScheduled || candidate.settled || pending !== candidate)
            return;
        candidate.persistenceScheduled = true;
        const check = () => {
            candidate.persistenceScheduled = false;
            candidate.persistenceTimer = undefined;
            acceptIfPersisted(candidate);
        };
        try {
            const timer = setTimer(check, 0);
            if (timer === undefined)
                throw new Error("reply persistence timer unavailable");
            candidate.persistenceTimer = timer;
            if (candidate.settled)
                safeClear(clear, timer);
        }
        catch {
            try {
                const timer = setTimeout(check, 0);
                if (timer === undefined)
                    throw new Error("reply persistence fallback unavailable");
                candidate.persistenceTimer = timer;
                if (candidate.settled)
                    safeClear(clear, timer);
            }
            catch {
                settle(candidate, "unconfirmed");
            }
        }
    };
    const handleReply = async (input) => {
        const request = parseReplyRequest(input);
        if (request === undefined)
            return "invalid";
        if (!enabled || !sessionActive)
            return "unauthorized";
        if (rememberedRequests.includes(request.requestId))
            return "duplicate";
        if (pending !== undefined || busyLatch || compactionLatched)
            return "busy";
        let observerState;
        try {
            observerState = options.getObserverState();
            if (observerState === null || typeof observerState !== "object")
                return "unauthorized";
        }
        catch {
            return "unauthorized";
        }
        try {
            if (observerState.enabled !== true ||
                observerState.attestation !== "attested" ||
                observerState.status !== "idle" ||
                observerState.settled !== true ||
                observerState.dirty !== false ||
                observerState.snapshotRequired !== false ||
                observerState.publicationPending !== false ||
                observerState.sinkInFlight !== false ||
                typeof observerState.successfulPublications !== "number" ||
                !Number.isSafeInteger(observerState.successfulPublications) ||
                observerState.successfulPublications < 1) {
                return "stale";
            }
            if (!Number.isSafeInteger(generation) ||
                generation !== request.generation ||
                !Number.isSafeInteger(observerState.generation) ||
                observerState.generation !== generation ||
                !Number.isSafeInteger(observerState.revision) ||
                Object.is(observerState.revision, -0) ||
                observerState.revision !== request.sourceRevision) {
                return "stale";
            }
        }
        catch {
            return "unauthorized";
        }
        let manager;
        try {
            manager = options.getSessionManager();
        }
        catch {
            return "stale";
        }
        if (manager === undefined)
            return "stale";
        const publication = publishedSnapshot;
        if (publication === undefined)
            return "stale";
        const target = targetBranchId(manager, publication.branchId);
        if (observerState.revision !== publication.sourceRevision ||
            request.branchId !== publication.branchId ||
            request.leafId !== publication.leafId ||
            request.sourceRevision !== publication.sourceRevision ||
            target === undefined ||
            target.leafId !== publication.leafId) {
            return "stale";
        }
        const startedAt = safeNow(now);
        const baseline = target.entryCount;
        const token = generation;
        remember(request.requestId);
        const result = await new Promise((resolve) => {
            const candidate = {
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
                settled: false,
                resolve,
            };
            pending = candidate;
            awaitingInjectedInput = candidate;
            busyLatch = true;
            const delay = Math.max(1, request.ttlSeconds * 1000);
            try {
                const timer = setTimer(() => settle(candidate, "expired"), delay);
                if (timer === undefined)
                    throw new Error("reply confirmation timer unavailable");
                candidate.timer = timer;
                if (candidate.settled)
                    safeClear(clear, timer);
            }
            catch {
                if (!candidate.settled && pending === candidate) {
                    try {
                        const timer = setTimeout(() => settle(candidate, "expired"), delay);
                        if (timer === undefined)
                            throw new Error("reply confirmation fallback unavailable");
                        candidate.timer = timer;
                        if (candidate.settled)
                            safeClear(clear, timer);
                    }
                    catch {
                        settle(candidate, "expired");
                    }
                }
            }
            if (candidate.settled || pending !== candidate)
                return;
            let idle = false;
            try {
                idle = options.isIdle?.() === true;
            }
            catch { }
            if (!idle) {
                settle(candidate, "busy");
                return;
            }
            try {
                const sent = options.sendUserMessage(request.text);
                if (sent !== undefined && typeof sent.then === "function") {
                    Promise.resolve(sent).catch(() => settle(candidate, "unconfirmed"));
                }
                armConfirmationDeadline(candidate);
            }
            catch {
                settle(candidate, "unconfirmed");
            }
        });
        return result;
    };
    const publicationReady = (input) => {
        if (!enabled || !sessionActive)
            return;
        const target = publishedTarget(input);
        if (target === undefined)
            return;
        const previous = channel;
        const previousTarget = publishedSnapshot;
        const sameTarget = previousTarget !== undefined &&
            previousTarget.sessionId === target.sessionId &&
            previousTarget.sourceInstanceId === target.sourceInstanceId &&
            previousTarget.sourceEpoch === target.sourceEpoch &&
            previousTarget.branchId === target.branchId &&
            previousTarget.leafId === target.leafId &&
            previousTarget.sourceRevision === target.sourceRevision;
        if (sameTarget && previous !== undefined && channelState(previous) !== "none")
            return;
        if (previous !== undefined) {
            invalidatePending("disconnected");
            bestEffortClose(previous, "owner-replaced");
            channel = undefined;
        }
        publishedSnapshot = target;
        const serial = nextCounter(channelSerial);
        channelSerial = serial;
        let next;
        try {
            next = createChannel({
                bridgeDirectory: options.bridgeDirectory,
                sessionId: target.sessionId,
                sourceInstanceId: target.sourceInstanceId,
                sourceEpoch: target.sourceEpoch,
                generation,
                onRequest: handleReply,
                onClosed: () => {
                    if (channel !== next)
                        return;
                    channel = undefined;
                    if (publishedSnapshot === target)
                        publishedSnapshot = undefined;
                    invalidatePending("disconnected");
                },
            });
        }
        catch {
            return;
        }
        channel = next;
        let opening;
        try {
            opening = next.open();
        }
        catch {
            if (channel === next) {
                channel = undefined;
                if (publishedSnapshot === target)
                    publishedSnapshot = undefined;
            }
            bestEffortClose(next, "owner-replaced");
            return;
        }
        void Promise.resolve(opening).then((opened) => {
            if (channel !== next || serial !== channelSerial || opened !== true) {
                if (channel === next) {
                    channel = undefined;
                    if (publishedSnapshot === target)
                        publishedSnapshot = undefined;
                }
                bestEffortClose(next, "owner-replaced");
            }
        }, () => {
            if (channel === next) {
                channel = undefined;
                if (publishedSnapshot === target)
                    publishedSnapshot = undefined;
            }
            bestEffortClose(next, "owner-replaced");
        });
    };
    const sessionStart = () => {
        sessionActive = true;
        generation = nextCounter(generation);
        busyLatch = false;
        compactionLatched = false;
        rememberedRequests = [];
        invalidatePending("disconnected");
        publishedSnapshot = undefined;
        const previous = channel;
        channel = undefined;
        if (previous !== undefined)
            bestEffortClose(previous, "owner-replaced");
    };
    const sessionShutdown = () => {
        sessionActive = false;
        generation = nextCounter(generation);
        busyLatch = false;
        compactionLatched = false;
        rememberedRequests = [];
        invalidatePending("disconnected");
        publishedSnapshot = undefined;
        const previous = channel;
        channel = undefined;
        if (previous !== undefined)
            bestEffortClose(previous, "producer-disconnect");
    };
    const agentStart = () => {
        busyLatch = true;
    };
    const input = (event) => {
        const candidate = pending;
        if (candidate !== undefined &&
            awaitingInjectedInput === candidate &&
            field(event, "source") === "extension" &&
            eventText(event) === candidate.request.text) {
            awaitingInjectedInput = undefined;
            return;
        }
        invalidatePending("unconfirmed");
        busyLatch = true;
    };
    const messageStart = (event) => {
        const message = messageRecord(field(event, "message"));
        if (message?.role === "user" || message?.role === "assistant")
            busyLatch = true;
    };
    const messageEnd = (event) => {
        const candidate = pending;
        if (candidate === undefined || candidate.settled || compactionLatched)
            return;
        const message = messageRecord(field(event, "message"));
        if (message?.role !== "user" || plainText(message.content) !== candidate.request.text)
            return;
        candidate.messageEndObserved = true;
        schedulePersistedCheck(candidate);
    };
    const turnEnd = () => {
        busyLatch = true;
    };
    const agentSettled = () => {
        busyLatch = false;
        compactionLatched = false;
    };
    const sessionBeforeTree = () => {
        invalidatePending("unconfirmed");
        busyLatch = true;
    };
    const sessionTree = () => {
        busyLatch = true;
    };
    const sessionBeforeCompact = () => {
        compactionLatched = true;
        invalidatePending("unconfirmed");
        busyLatch = true;
    };
    const sessionCompact = () => {
        compactionLatched = false;
        busyLatch = true;
    };
    const getState = () => Object.freeze({
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
        publicationReady,
        handleReply,
        getState,
    });
}
function bestEffortClose(channel, reason) {
    try {
        channel.close(reason);
    }
    catch { }
}
export default createSessionMirrorReplyProducer;

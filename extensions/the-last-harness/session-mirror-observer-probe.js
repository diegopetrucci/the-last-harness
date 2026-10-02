import { performance } from "node:perf_hooks";
import { createSessionMirrorObserverRuntime } from "./session-mirror/observer.js";
import { createSessionMirrorObserverSocketSink } from "./session-mirror/local-bridge-sink.js";
import { createSessionMirrorReplyProducer, } from "./session-mirror/session-mirror-reply-producer.js";
import {} from "./session-mirror/local-bridge-boundary.js";
import { projectRecentSessionMirrorSnapshot, } from "./session-mirror/session-adapter.js";
export const SESSION_MIRROR_OBSERVER_PROBE_BOUNDS = Object.freeze({
    maxEnvelopeBytes: 256 * 1024,
    maxTreeEntries: 1024,
    maxTreeRoots: 1024,
    maxTreeDepth: 128,
});
export const SESSION_MIRROR_OBSERVER_TIMING_BUCKETS = Object.freeze([
    "unknown",
    "fast",
    "moderate",
    "slow",
    "extended",
]);
const MAX_RUNTIME_FAILURES = 2_000_000_000;
const MAX_DEPTH_WALK = SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxTreeDepth + 1;
function initialMetrics() {
    return {
        envelopeCategory: "none",
        entryCount: 0,
        rootCount: 0,
        maxDepth: 0,
        envelopeBytes: 0,
        timing: {
            attestation: "unknown",
            projection: "unknown",
            sink: "unknown",
        },
        runtimeFailures: 0,
    };
}
function incrementCounter(value) {
    return value >= MAX_RUNTIME_FAILURES ? MAX_RUNTIME_FAILURES : value + 1;
}
function bucketDuration(duration) {
    if (duration === undefined || !Number.isFinite(duration) || duration < 0)
        return "unknown";
    if (duration <= 1)
        return "fast";
    if (duration <= 10)
        return "moderate";
    if (duration <= 100)
        return "slow";
    return "extended";
}
function readNow(now) {
    try {
        const value = now();
        return Number.isFinite(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
function setTiming(metrics, key, startedAt, now) {
    if (startedAt === undefined) {
        metrics.timing[key] = "unknown";
        return;
    }
    const endedAt = readNow(now);
    metrics.timing[key] =
        endedAt === undefined ? "unknown" : bucketDuration(Math.max(0, endedAt - startedAt));
}
function classifyEnvelope(entries) {
    if (entries.length === 0)
        return "empty";
    let placeholderCount = 0;
    let textCount = 0;
    for (const entry of entries) {
        if (entry.kind === "source-placeholder") {
            placeholderCount += 1;
        }
        else if (entry.kind === "user-turn" ||
            entry.kind === "assistant-turn" ||
            entry.kind === "summary" ||
            entry.kind === "compaction") {
            textCount += 1;
        }
    }
    if (placeholderCount === entries.length)
        return "placeholder";
    if (textCount === entries.length)
        return "text";
    return "mixed";
}
function measureDepth(entries) {
    const parents = new Map();
    for (const entry of entries) {
        if (typeof entry.id !== "string")
            return SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxTreeDepth;
        if (!(entry.parentId === null || typeof entry.parentId === "string")) {
            return SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxTreeDepth;
        }
        parents.set(entry.id, entry.parentId);
    }
    let maximum = 0;
    for (const entry of entries) {
        if (typeof entry.id !== "string")
            return SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxTreeDepth;
        const seen = new Set();
        let current = entry.id;
        let depth = 0;
        while (current !== null && depth < MAX_DEPTH_WALK) {
            if (seen.has(current))
                return SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxTreeDepth;
            seen.add(current);
            const parent = parents.get(current);
            if (parent === undefined)
                return SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxTreeDepth;
            depth += 1;
            current = parent;
        }
        if (current !== null)
            return SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxTreeDepth;
        maximum = Math.max(maximum, depth);
    }
    return Math.min(maximum, SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxTreeDepth);
}
function measureEnvelope(envelope) {
    const tree = envelope.message.snapshot.tree;
    const entries = tree.entries;
    const rootIds = tree.rootIds;
    if (!Array.isArray(entries) ||
        !Array.isArray(rootIds) ||
        entries.length > SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxTreeEntries ||
        rootIds.length > SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxTreeRoots) {
        throw new Error("session-mirror envelope bounds exceeded");
    }
    const entryCount = entries.length;
    const rootCount = rootIds.length;
    const maxDepth = measureDepth(entries);
    const serialized = JSON.stringify(envelope);
    const serializedBytes = Buffer.byteLength(serialized, "utf8");
    return {
        envelopeCategory: serializedBytes > SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxEnvelopeBytes
            ? "error"
            : classifyEnvelope(entries),
        entryCount,
        rootCount,
        maxDepth,
        envelopeBytes: Math.min(serializedBytes, SESSION_MIRROR_OBSERVER_PROBE_BOUNDS.maxEnvelopeBytes),
    };
}
function defaultAttestor(_input) {
    return { ok: false, reason: "unsafe-profile-metadata" };
}
function invokeLifecycle(action, metrics) {
    try {
        action();
    }
    catch {
        metrics.runtimeFailures = incrementCounter(metrics.runtimeFailures);
        metrics.envelopeCategory = "error";
    }
}
function shutdownSink(sink) {
    try {
        sink?.shutdown?.();
    }
    catch {
    }
}
export function createSessionMirrorObserverProbe(options = {}) {
    const now = options.now ?? (() => performance.now());
    const metrics = initialMetrics();
    const attest = options.attest ?? defaultAttestor;
    const project = options.project ?? projectRecentSessionMirrorSnapshot;
    const getSessionManager = options.getSessionManager ?? (() => options.sessionManager);
    let replyProducer;
    const notifyPublicationReady = (info) => {
        try {
            replyProducer?.publicationReady(info);
        }
        catch {
        }
    };
    const publicationSink = options.sink ??
        (options.bridgeDirectory === undefined
            ? undefined
            : createSessionMirrorObserverSocketSink({
                bridgeDirectory: options.bridgeDirectory,
                onReady: notifyPublicationReady,
            }));
    const measuredAttest = (input) => {
        const startedAt = readNow(now);
        try {
            return attest(input);
        }
        finally {
            setTiming(metrics, "attestation", startedAt, now);
        }
    };
    const measuredProject = (sessionManager, metadata) => {
        const startedAt = readNow(now);
        try {
            const result = project(sessionManager, metadata);
            if (!result || result.ok !== true)
                metrics.envelopeCategory = "error";
            return result;
        }
        catch {
            metrics.envelopeCategory = "error";
            throw new Error("session-mirror projection failed");
        }
        finally {
            setTiming(metrics, "projection", startedAt, now);
        }
    };
    const consumeEnvelope = (envelope) => {
        const startedAt = readNow(now);
        try {
            const measured = measureEnvelope(envelope);
            metrics.envelopeCategory = measured.envelopeCategory;
            metrics.entryCount = measured.entryCount;
            metrics.rootCount = measured.rootCount;
            metrics.maxDepth = measured.maxDepth;
            metrics.envelopeBytes = measured.envelopeBytes;
        }
        catch {
            metrics.envelopeCategory = "error";
            metrics.entryCount = 0;
            metrics.rootCount = 0;
            metrics.maxDepth = 0;
            metrics.envelopeBytes = 0;
            setTiming(metrics, "sink", startedAt, now);
            throw new Error("session-mirror envelope measurement failed");
        }
        if (!publicationSink) {
            setTiming(metrics, "sink", startedAt, now);
            return;
        }
        try {
            const publication = publicationSink(envelope);
            if (publication && typeof publication.then === "function") {
                return publication.then(() => setTiming(metrics, "sink", startedAt, now), () => {
                    setTiming(metrics, "sink", startedAt, now);
                    throw new Error("session-mirror publication failed");
                });
            }
            setTiming(metrics, "sink", startedAt, now);
        }
        catch {
            setTiming(metrics, "sink", startedAt, now);
            throw new Error("session-mirror publication failed");
        }
    };
    const runtimeOptions = {
        getSessionManager,
        sink: consumeEnvelope,
        attest: measuredAttest,
        project: measuredProject,
        scheduler: options.scheduler,
        runtimeVersion: options.runtimeVersion,
        sessionSchemaVersion: options.sessionSchemaVersion,
        queueCapacity: options.queueCapacity,
    };
    const runtime = createSessionMirrorObserverRuntime(runtimeOptions);
    if (options.sessionMirrorReplies === true && typeof options.sendUserMessage === "function") {
        replyProducer = createSessionMirrorReplyProducer({
            enabled: true,
            bridgeDirectory: options.bridgeDirectory,
            getSessionManager,
            getObserverState: runtime.getState,
            sendUserMessage: options.sendUserMessage,
            isIdle: options.isIdle,
            requestSnapshot: runtime.requestSnapshot,
            createChannel: options.replyChannelFactory,
            now: options.replyNow,
            scheduleConfirmation: options.replyScheduleConfirmation,
            setTimeout: options.replySetTimeout,
            clearTimeout: options.replyClearTimeout,
            notify: options.replyNotify,
        });
    }
    const getState = () => {
        let observer;
        try {
            observer = runtime.getState();
        }
        catch {
            metrics.runtimeFailures = incrementCounter(metrics.runtimeFailures);
            metrics.envelopeCategory = "error";
            observer = {
                generation: 0,
                enabled: false,
                attestation: "disabled",
                status: "unknown",
                settled: true,
                dirty: true,
                snapshotRequired: true,
                publicationPending: false,
                queueDepth: 0,
                queueCapacity: 0,
                sinkInFlight: false,
                revision: 0,
                successfulPublications: 0,
                failedPublications: 0,
                coalescedMarkers: 0,
                droppedMarkers: 0,
                diagnostics: {
                    queueOverflow: 0,
                    staleGeneration: 0,
                    schedulerFailure: 0,
                    sessionUnavailable: 0,
                    attestationFailure: 0,
                    attestationNotReady: 0,
                    projectionFailure: 0,
                    sinkThrow: 0,
                    sinkReject: 0,
                },
                lastDiagnostic: "projection-failure",
                lastAttestationFailure: "unsafe-profile-metadata",
                lastProjectionFailure: "unsafe-session-data",
            };
        }
        return Object.freeze({
            ...observer,
            envelopeCategory: metrics.envelopeCategory,
            entryCount: metrics.entryCount,
            rootCount: metrics.rootCount,
            maxDepth: metrics.maxDepth,
            envelopeBytes: metrics.envelopeBytes,
            timing: Object.freeze({ ...metrics.timing }),
            runtimeFailures: metrics.runtimeFailures,
            ...(replyProducer === undefined ? {} : { reply: replyProducer.getState() }),
        });
    };
    const invokeReply = (action) => {
        try {
            action();
        }
        catch {
            metrics.runtimeFailures = incrementCounter(metrics.runtimeFailures);
        }
    };
    const sessionStart = () => {
        metrics.envelopeCategory = "none";
        metrics.entryCount = 0;
        metrics.rootCount = 0;
        metrics.maxDepth = 0;
        metrics.envelopeBytes = 0;
        invokeReply(() => replyProducer?.sessionStart());
        invokeLifecycle(() => runtime.sessionStart(), metrics);
    };
    const agentStart = () => {
        invokeReply(() => replyProducer?.agentStart());
        invokeLifecycle(() => runtime.agentStart(), metrics);
    };
    const input = (event) => invokeReply(() => replyProducer?.input(event));
    const messageStart = (event) => invokeReply(() => replyProducer?.messageStart(event));
    const messageEnd = (event) => {
        invokeReply(() => replyProducer?.messageEnd(event));
        invokeLifecycle(() => runtime.messageEnd(), metrics);
    };
    const turnEnd = () => {
        invokeReply(() => replyProducer?.turnEnd());
        invokeLifecycle(() => runtime.turnEnd(), metrics);
    };
    const agentSettled = () => {
        invokeReply(() => replyProducer?.agentSettled());
        invokeLifecycle(() => runtime.agentSettled(), metrics);
    };
    const sessionBeforeTree = () => invokeReply(() => replyProducer?.sessionBeforeTree());
    const sessionTree = () => {
        invokeReply(() => replyProducer?.sessionTree());
        invokeLifecycle(() => runtime.sessionTree(), metrics);
    };
    const sessionBeforeCompact = () => invokeReply(() => replyProducer?.sessionBeforeCompact());
    const sessionCompact = () => {
        invokeReply(() => replyProducer?.sessionCompact());
        invokeLifecycle(() => runtime.sessionCompact(), metrics);
    };
    const publicationReady = (info) => invokeReply(() => replyProducer?.publicationReady(info));
    const sessionShutdown = () => {
        invokeReply(() => replyProducer?.sessionShutdown());
        shutdownSink(publicationSink);
        invokeLifecycle(() => runtime.sessionShutdown(), metrics);
        metrics.envelopeCategory = "none";
        metrics.entryCount = 0;
        metrics.rootCount = 0;
        metrics.maxDepth = 0;
        metrics.envelopeBytes = 0;
    };
    const requestSnapshot = () => invokeLifecycle(() => runtime.requestSnapshot(), metrics);
    return Object.freeze({
        sessionStart,
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
        sessionShutdown,
        publicationReady,
        requestSnapshot,
        getState,
    });
}
export default createSessionMirrorObserverProbe;

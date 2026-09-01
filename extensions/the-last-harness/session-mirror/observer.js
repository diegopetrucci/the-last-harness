import { projectSessionMirrorSnapshot, } from "./session-adapter.js";
export const SESSION_MIRROR_OBSERVER_DEFAULT_QUEUE_CAPACITY = 8;
export const SESSION_MIRROR_OBSERVER_MAX_QUEUE_CAPACITY = 32;
export const SESSION_MIRROR_OBSERVER_DIAGNOSTIC_CODES = Object.freeze([
    "queue-overflow",
    "stale-generation",
    "scheduler-failure",
    "session-unavailable",
    "attestation-failure",
    "attestation-not-ready",
    "projection-failure",
    "sink-throw",
    "sink-reject",
]);
const MAX_COUNTER = 2_000_000_000;
const MAX_METADATA_CHARACTERS = 256;
const DEFAULT_RUNTIME_VERSION = "tlh-session-mirror-runtime-v1";
const DEFAULT_SESSION_SCHEMA_VERSION = "pi-session-schema-v3";
function nextCounter(value) {
    return value >= MAX_COUNTER ? 1 : value + 1;
}
function boundedQueueCapacity(value) {
    if (!Number.isSafeInteger(value) || value === undefined || value < 1) {
        return SESSION_MIRROR_OBSERVER_DEFAULT_QUEUE_CAPACITY;
    }
    return Math.min(value, SESSION_MIRROR_OBSERVER_MAX_QUEUE_CAPACITY);
}
function boundedMetadata(value, fallback) {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_METADATA_CHARACTERS) {
        return fallback;
    }
    return value;
}
function emptyDiagnostics() {
    return {
        queueOverflow: 0,
        staleGeneration: 0,
        schedulerFailure: 0,
        sessionUnavailable: 0,
        attestationFailure: 0,
        attestationNotReady: 0,
        projectionFailure: 0,
        sinkThrow: 0,
        sinkReject: 0,
    };
}
function initialState(queueCapacity) {
    return {
        generation: 0,
        token: { serial: 0 },
        attestation: "shutdown",
        enabled: false,
        status: "unknown",
        settled: true,
        dirty: false,
        snapshotRequired: false,
        publicationPending: false,
        queue: [],
        queueCapacity,
        revision: 0,
        publicationSerial: 0,
        mutationSerial: 0,
        successfulPublications: 0,
        failedPublications: 0,
        coalescedMarkers: 0,
        droppedMarkers: 0,
        diagnostics: emptyDiagnostics(),
        lastDiagnostic: undefined,
        lastAttestationFailure: undefined,
        lastProjectionFailure: undefined,
    };
}
function freezeDiagnostics(counts) {
    return Object.freeze({
        queueOverflow: counts.queueOverflow,
        staleGeneration: counts.staleGeneration,
        schedulerFailure: counts.schedulerFailure,
        sessionUnavailable: counts.sessionUnavailable,
        attestationFailure: counts.attestationFailure,
        attestationNotReady: counts.attestationNotReady,
        projectionFailure: counts.projectionFailure,
        sinkThrow: counts.sinkThrow,
        sinkReject: counts.sinkReject,
    });
}
function incrementCounter(value) {
    return value >= MAX_COUNTER ? MAX_COUNTER : value + 1;
}
function normalizedAttestationFailure(reason) {
    switch (reason) {
        case "missing-profile-selection":
        case "missing-home":
        case "default-or-normal-profile":
        case "profile-mismatch":
        case "unsafe-profile-metadata":
        case "ephemeral-session":
        case "session-escape":
        case "unsafe-session-metadata":
            return { ok: false, reason };
        default:
            return { ok: false, reason: "unsafe-profile-metadata" };
    }
}
function normalizeAttestationResult(result) {
    try {
        if (result.ok === false)
            return normalizedAttestationFailure(result.reason);
        if (result.ok === true && result.phase === "session-file")
            return "session-file";
        if (result.ok === true && result.phase === "directory-only")
            return "directory-only";
    }
    catch {
    }
    return { ok: false, reason: "unsafe-profile-metadata" };
}
function normalizedProjectionReason(reason) {
    switch (reason) {
        case "invalid-metadata":
        case "session-unavailable":
        case "unsafe-session-data":
        case "bounds-exceeded":
            return reason;
        default:
            return "unsafe-session-data";
    }
}
function markerIndex(queue, kind) {
    return queue.findIndex((marker) => marker.kind === kind);
}
export function createSessionMirrorObserverRuntime(options = {}) {
    const queueCapacity = boundedQueueCapacity(options.queueCapacity);
    const scheduler = options.scheduler ?? ((task) => setImmediate(task));
    const sink = options.sink ?? (() => undefined);
    const attest = options.attest ?? (() => ({ ok: false, reason: "unsafe-profile-metadata" }));
    const project = options.project ?? projectSessionMirrorSnapshot;
    const runtimeVersion = boundedMetadata(options.runtimeVersion, DEFAULT_RUNTIME_VERSION);
    const sessionSchemaVersion = boundedMetadata(options.sessionSchemaVersion, DEFAULT_SESSION_SCHEMA_VERSION);
    const getSessionManager = options.getSessionManager ?? (() => options.sessionManager);
    const state = initialState(queueCapacity);
    let activeSink;
    let workerScheduled = false;
    let workerRunning = false;
    let workerAgain = false;
    let lifecycleDepth = 0;
    const currentToken = () => state.token;
    const isCurrent = (token) => token === state.token;
    const recordDiagnostic = (code) => {
        state.lastDiagnostic = code;
        const diagnostics = state.diagnostics;
        switch (code) {
            case "queue-overflow":
                diagnostics.queueOverflow = incrementCounter(diagnostics.queueOverflow);
                break;
            case "stale-generation":
                diagnostics.staleGeneration = incrementCounter(diagnostics.staleGeneration);
                break;
            case "scheduler-failure":
                diagnostics.schedulerFailure = incrementCounter(diagnostics.schedulerFailure);
                break;
            case "session-unavailable":
                diagnostics.sessionUnavailable = incrementCounter(diagnostics.sessionUnavailable);
                break;
            case "attestation-failure":
                diagnostics.attestationFailure = incrementCounter(diagnostics.attestationFailure);
                break;
            case "attestation-not-ready":
                diagnostics.attestationNotReady = incrementCounter(diagnostics.attestationNotReady);
                break;
            case "projection-failure":
                diagnostics.projectionFailure = incrementCounter(diagnostics.projectionFailure);
                break;
            case "sink-throw":
                diagnostics.sinkThrow = incrementCounter(diagnostics.sinkThrow);
                break;
            case "sink-reject":
                diagnostics.sinkReject = incrementCounter(diagnostics.sinkReject);
                break;
        }
    };
    const scheduleWorker = () => {
        if (workerRunning) {
            workerAgain = true;
            return;
        }
        if (workerScheduled || activeSink !== undefined || state.queue.length === 0)
            return;
        workerScheduled = true;
        try {
            scheduler(() => {
                if (lifecycleDepth > 0) {
                    queueMicrotask(() => {
                        workerScheduled = false;
                        runWorker();
                    });
                    return;
                }
                workerScheduled = false;
                runWorker();
            });
        }
        catch {
            workerScheduled = false;
            state.snapshotRequired = true;
            state.dirty = true;
            state.publicationPending = true;
            recordDiagnostic("scheduler-failure");
        }
    };
    const enqueue = (kind) => {
        if (markerIndex(state.queue, kind) >= 0) {
            state.coalescedMarkers = incrementCounter(state.coalescedMarkers);
            scheduleWorker();
            return;
        }
        if (markerIndex(state.queue, "snapshot-required") >= 0) {
            if (kind !== "snapshot-required") {
                state.coalescedMarkers = incrementCounter(state.coalescedMarkers);
            }
            scheduleWorker();
            return;
        }
        if (state.queue.length >= state.queueCapacity) {
            state.droppedMarkers = Math.min(MAX_COUNTER, state.droppedMarkers + state.queue.length);
            state.queue = [{ kind: "snapshot-required" }];
            state.snapshotRequired = true;
            state.dirty = true;
            state.publicationPending = true;
            recordDiagnostic("queue-overflow");
            scheduleWorker();
            return;
        }
        state.queue.push({ kind });
        scheduleWorker();
    };
    const markMutation = () => {
        state.mutationSerial = nextCounter(state.mutationSerial);
    };
    const markDirty = () => {
        state.dirty = true;
        state.publicationPending = true;
        markMutation();
        enqueue("dirty");
    };
    const markForceSnapshot = () => {
        state.snapshotRequired = true;
        state.dirty = true;
        state.publicationPending = true;
        markMutation();
        enqueue("snapshot-required");
    };
    const readSessionView = () => {
        let manager;
        try {
            manager = getSessionManager();
        }
        catch {
            return { ok: false };
        }
        if (manager === undefined || manager === null || typeof manager !== "object") {
            return { ok: false };
        }
        let sessionFile;
        try {
            sessionFile = manager.getSessionFile();
        }
        catch {
            return { ok: false };
        }
        if (sessionFile !== undefined && typeof sessionFile !== "string") {
            return { ok: false };
        }
        return { ok: true, value: { manager, sessionFile } };
    };
    const disableForAttestation = (token, failure) => {
        if (!isCurrent(token)) {
            recordDiagnostic("stale-generation");
            return;
        }
        state.enabled = false;
        state.attestation = "disabled";
        state.lastAttestationFailure = failure.reason;
        state.lastProjectionFailure = undefined;
        state.publicationPending = false;
        recordDiagnostic("attestation-failure");
    };
    const attestGeneration = (token) => {
        if (!isCurrent(token)) {
            recordDiagnostic("stale-generation");
            return false;
        }
        const view = readSessionView();
        if (!isCurrent(token)) {
            recordDiagnostic("stale-generation");
            return false;
        }
        if (!view.ok) {
            if (isCurrent(token)) {
                state.enabled = false;
                state.attestation = "disabled";
                state.publicationPending = false;
                recordDiagnostic("session-unavailable");
            }
            else {
                recordDiagnostic("stale-generation");
            }
            return false;
        }
        let result;
        try {
            result = attest({ sessionFile: view.value.sessionFile });
        }
        catch {
            if (isCurrent(token)) {
                state.enabled = false;
                state.attestation = "disabled";
                state.publicationPending = false;
                state.lastAttestationFailure = "unsafe-profile-metadata";
                recordDiagnostic("attestation-failure");
            }
            else {
                recordDiagnostic("stale-generation");
            }
            return false;
        }
        if (!isCurrent(token)) {
            recordDiagnostic("stale-generation");
            return false;
        }
        const outcome = normalizeAttestationResult(result);
        if (typeof outcome !== "string") {
            disableForAttestation(token, outcome);
            return false;
        }
        state.enabled = true;
        state.attestation = outcome === "session-file" ? "attested" : "directory-only";
        state.lastAttestationFailure = undefined;
        return true;
    };
    const createMetadata = () => {
        state.publicationSerial = nextCounter(state.publicationSerial);
        state.revision = nextCounter(state.revision);
        const serial = state.publicationSerial;
        const generation = state.generation;
        return {
            eventId: `g${generation}-e${serial}`,
            revision: state.revision,
            cursor: `g${generation}-c${serial}`,
            snapshotId: `g${generation}-s${serial}`,
            runtimeVersion,
            sessionSchemaVersion,
            status: state.status,
        };
    };
    const completeSink = (operation, succeeded) => {
        if (activeSink === operation)
            activeSink = undefined;
        if (!isCurrent(operation.token)) {
            recordDiagnostic("stale-generation");
            scheduleWorker();
            return;
        }
        if (!succeeded) {
            state.failedPublications = incrementCounter(state.failedPublications);
            state.snapshotRequired = true;
            state.dirty = true;
            state.publicationPending = true;
            scheduleWorker();
            return;
        }
        state.successfulPublications = incrementCounter(state.successfulPublications);
        if (state.mutationSerial === operation.mutationSerial) {
            state.snapshotRequired = false;
            state.dirty = false;
            state.publicationPending = false;
        }
        else {
            state.snapshotRequired = true;
            state.dirty = true;
            state.publicationPending = true;
        }
        scheduleWorker();
    };
    const beginSink = (token, envelope, mutationSerial) => {
        if (!isCurrent(token)) {
            recordDiagnostic("stale-generation");
            return;
        }
        if (activeSink !== undefined)
            return;
        const operation = { token, mutationSerial };
        activeSink = operation;
        let result;
        try {
            result = sink(envelope);
        }
        catch {
            if (activeSink === operation)
                activeSink = undefined;
            if (isCurrent(token)) {
                state.failedPublications = incrementCounter(state.failedPublications);
                state.snapshotRequired = true;
                state.dirty = true;
                state.publicationPending = true;
                recordDiagnostic("sink-throw");
            }
            else {
                recordDiagnostic("stale-generation");
            }
            scheduleWorker();
            return;
        }
        if (result === undefined) {
            completeSink(operation, true);
            return;
        }
        Promise.resolve(result).then(() => completeSink(operation, true), () => {
            if (activeSink === operation)
                activeSink = undefined;
            if (!isCurrent(token)) {
                recordDiagnostic("stale-generation");
                scheduleWorker();
                return;
            }
            state.failedPublications = incrementCounter(state.failedPublications);
            state.snapshotRequired = true;
            state.dirty = true;
            state.publicationPending = true;
            recordDiagnostic("sink-reject");
            scheduleWorker();
        });
    };
    const publishIfReady = (token) => {
        if (!isCurrent(token)) {
            recordDiagnostic("stale-generation");
            return;
        }
        if (!state.enabled || !state.settled || !state.publicationPending || activeSink !== undefined) {
            return;
        }
        const view = readSessionView();
        if (!isCurrent(token)) {
            recordDiagnostic("stale-generation");
            return;
        }
        if (!view.ok) {
            state.enabled = false;
            state.attestation = "disabled";
            state.publicationPending = false;
            recordDiagnostic("session-unavailable");
            return;
        }
        let attestation;
        try {
            attestation = attest({ sessionFile: view.value.sessionFile });
        }
        catch {
            if (isCurrent(token)) {
                state.enabled = false;
                state.attestation = "disabled";
                state.publicationPending = false;
                state.lastAttestationFailure = "unsafe-profile-metadata";
                recordDiagnostic("attestation-failure");
            }
            else {
                recordDiagnostic("stale-generation");
            }
            return;
        }
        if (!isCurrent(token)) {
            recordDiagnostic("stale-generation");
            return;
        }
        const attestationOutcome = normalizeAttestationResult(attestation);
        if (typeof attestationOutcome !== "string") {
            disableForAttestation(token, attestationOutcome);
            return;
        }
        if (attestationOutcome !== "session-file") {
            state.attestation = "directory-only";
            state.snapshotRequired = true;
            state.dirty = true;
            recordDiagnostic("attestation-not-ready");
            return;
        }
        state.enabled = true;
        state.attestation = "attested";
        const metadata = createMetadata();
        const projectionMutationSerial = state.mutationSerial;
        let projection;
        try {
            projection = project(view.value.manager, metadata);
        }
        catch {
            if (isCurrent(token)) {
                state.snapshotRequired = true;
                state.dirty = true;
                state.publicationPending = true;
                state.lastProjectionFailure = "unsafe-session-data";
                state.failedPublications = incrementCounter(state.failedPublications);
                recordDiagnostic("projection-failure");
            }
            else {
                recordDiagnostic("stale-generation");
            }
            return;
        }
        if (!isCurrent(token)) {
            recordDiagnostic("stale-generation");
            return;
        }
        try {
            if (!projection.ok) {
                state.snapshotRequired = true;
                state.dirty = true;
                state.publicationPending = true;
                state.lastProjectionFailure = normalizedProjectionReason(projection.reason);
                state.failedPublications = incrementCounter(state.failedPublications);
                recordDiagnostic("projection-failure");
                return;
            }
            state.lastProjectionFailure = undefined;
            beginSink(token, projection.envelope, projectionMutationSerial);
        }
        catch {
            if (isCurrent(token)) {
                state.snapshotRequired = true;
                state.dirty = true;
                state.publicationPending = true;
                state.lastProjectionFailure = "unsafe-session-data";
                state.failedPublications = incrementCounter(state.failedPublications);
                recordDiagnostic("projection-failure");
            }
            else {
                recordDiagnostic("stale-generation");
            }
        }
    };
    function runWorker() {
        if (workerRunning) {
            workerAgain = true;
            return;
        }
        if (activeSink !== undefined || state.queue.length === 0)
            return;
        workerRunning = true;
        workerAgain = false;
        const token = currentToken();
        let publicationRequested = false;
        try {
            while (isCurrent(token) && state.queue.length > 0) {
                const marker = state.queue.shift();
                if (!marker)
                    break;
                switch (marker.kind) {
                    case "session-start":
                        attestGeneration(token);
                        break;
                    case "agent-start":
                        state.status = "active";
                        state.settled = false;
                        break;
                    case "dirty":
                        state.dirty = true;
                        break;
                    case "agent-settled":
                        state.status = "idle";
                        state.settled = true;
                        publicationRequested = true;
                        break;
                    case "snapshot-required":
                        if (state.attestation === "pending")
                            attestGeneration(token);
                        publicationRequested = true;
                        break;
                }
            }
            if (isCurrent(token) && publicationRequested)
                publishIfReady(token);
        }
        catch {
            if (isCurrent(token)) {
                state.snapshotRequired = true;
                state.dirty = true;
                state.publicationPending = true;
                state.lastProjectionFailure = "unsafe-session-data";
                state.failedPublications = incrementCounter(state.failedPublications);
                recordDiagnostic("projection-failure");
            }
            else {
                recordDiagnostic("stale-generation");
            }
        }
        finally {
            workerRunning = false;
            if (workerAgain) {
                workerAgain = false;
                scheduleWorker();
            }
            else if (state.queue.length > 0 && activeSink === undefined) {
                scheduleWorker();
            }
        }
    }
    const sessionStart = () => {
        lifecycleDepth += 1;
        try {
            state.generation = nextCounter(state.generation);
            state.token = { serial: state.generation };
            state.attestation = "pending";
            state.enabled = false;
            state.status = "idle";
            state.settled = true;
            state.dirty = true;
            state.snapshotRequired = true;
            state.publicationPending = false;
            state.queue = [];
            state.revision = 0;
            state.publicationSerial = 0;
            state.mutationSerial = 0;
            state.lastDiagnostic = undefined;
            state.lastAttestationFailure = undefined;
            state.lastProjectionFailure = undefined;
            enqueue("session-start");
        }
        finally {
            lifecycleDepth -= 1;
        }
    };
    const agentStart = () => {
        lifecycleDepth += 1;
        try {
            state.status = "active";
            state.settled = false;
            markMutation();
            enqueue("agent-start");
        }
        finally {
            lifecycleDepth -= 1;
        }
    };
    const messageEnd = () => {
        lifecycleDepth += 1;
        try {
            markDirty();
        }
        finally {
            lifecycleDepth -= 1;
        }
    };
    const turnEnd = () => {
        lifecycleDepth += 1;
        try {
            markDirty();
        }
        finally {
            lifecycleDepth -= 1;
        }
    };
    const agentSettled = () => {
        lifecycleDepth += 1;
        try {
            state.status = "idle";
            state.settled = true;
            state.publicationPending = true;
            markMutation();
            enqueue("agent-settled");
        }
        finally {
            lifecycleDepth -= 1;
        }
    };
    const sessionTree = () => {
        lifecycleDepth += 1;
        try {
            markForceSnapshot();
        }
        finally {
            lifecycleDepth -= 1;
        }
    };
    const sessionCompact = () => {
        lifecycleDepth += 1;
        try {
            markForceSnapshot();
        }
        finally {
            lifecycleDepth -= 1;
        }
    };
    const requestSnapshot = () => {
        lifecycleDepth += 1;
        try {
            markForceSnapshot();
        }
        finally {
            lifecycleDepth -= 1;
        }
    };
    const sessionShutdown = () => {
        lifecycleDepth += 1;
        try {
            state.generation = nextCounter(state.generation);
            state.token = { serial: state.generation };
            state.attestation = "shutdown";
            state.enabled = false;
            state.status = "unknown";
            state.settled = true;
            state.dirty = false;
            state.snapshotRequired = false;
            state.publicationPending = false;
            state.queue = [];
            state.revision = 0;
            state.publicationSerial = 0;
            state.mutationSerial = 0;
            state.lastDiagnostic = undefined;
            state.lastAttestationFailure = undefined;
            state.lastProjectionFailure = undefined;
        }
        finally {
            lifecycleDepth -= 1;
        }
    };
    const getState = () => Object.freeze({
        generation: state.generation,
        enabled: state.enabled,
        attestation: state.attestation,
        status: state.status,
        settled: state.settled,
        dirty: state.dirty,
        snapshotRequired: state.snapshotRequired,
        publicationPending: state.publicationPending,
        queueDepth: state.queue.length,
        queueCapacity: state.queueCapacity,
        sinkInFlight: activeSink !== undefined,
        revision: state.revision,
        successfulPublications: state.successfulPublications,
        failedPublications: state.failedPublications,
        coalescedMarkers: state.coalescedMarkers,
        droppedMarkers: state.droppedMarkers,
        diagnostics: freezeDiagnostics(state.diagnostics),
        lastDiagnostic: state.lastDiagnostic,
        lastAttestationFailure: state.lastAttestationFailure,
        lastProjectionFailure: state.lastProjectionFailure,
    });
    return Object.freeze({
        sessionStart,
        agentStart,
        messageEnd,
        turnEnd,
        agentSettled,
        sessionTree,
        sessionCompact,
        sessionShutdown,
        requestSnapshot,
        getState,
    });
}
export const createSessionMirrorObserver = createSessionMirrorObserverRuntime;
export default createSessionMirrorObserverRuntime;

import { performance } from "node:perf_hooks";
import { getTlhExperimentalConfig, isTlhExperimentalFeatureEnabled, SESSION_MIRROR_OBSERVER_FEATURE, } from "./experimental.js";
import { attestSessionMirrorSession } from "./session-mirror/profile-attestation.js";
export const SESSION_MIRROR_OBSERVER_RUNTIME_VERSION = "tlh-session-mirror-runtime-v1";
export const SESSION_MIRROR_OBSERVER_SESSION_SCHEMA_VERSION = "pi-session-schema-v3";
export const SESSION_MIRROR_OBSERVER_COMMAND = "session-mirror-observer";
const DEFAULT_QUEUE_CAPACITY = 8;
const MAX_FACADE_GENERATION = 2_000_000_000;
const ZERO_TIMING = "unknown";
const SESSION_MIRROR_OBSERVER_ACTIVATION_SNAPSHOT_KEY = Symbol.for("the-last-harness.session-mirror-observer-activation-snapshot");
const SESSION_MIRROR_OBSERVER_GLOBAL = globalThis;
function closedActivationSnapshotValue(value) {
    try {
        if (value === null || typeof value !== "object" || Array.isArray(value))
            return undefined;
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
            return undefined;
        const keys = Reflect.ownKeys(value);
        if (keys.length !== 1 || keys[0] !== "sessionConfigured")
            return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(value, "sessionConfigured");
        if (!descriptor ||
            !Object.hasOwn(descriptor, "value") ||
            typeof descriptor.value !== "boolean") {
            return undefined;
        }
        return descriptor.value;
    }
    catch {
        return undefined;
    }
}
function allowedActivationSnapshotDescriptor(descriptor) {
    return (descriptor !== undefined &&
        Object.hasOwn(descriptor, "value") &&
        descriptor.writable === true &&
        descriptor.configurable === true);
}
function readActivationSnapshot() {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(SESSION_MIRROR_OBSERVER_GLOBAL, SESSION_MIRROR_OBSERVER_ACTIVATION_SNAPSHOT_KEY);
        if (!allowedActivationSnapshotDescriptor(descriptor))
            return undefined;
        return closedActivationSnapshotValue(descriptor.value);
    }
    catch {
        return undefined;
    }
}
function writeActivationSnapshot(sessionConfigured, isCurrent) {
    try {
        if (!isCurrent())
            return false;
        const existing = Object.getOwnPropertyDescriptor(SESSION_MIRROR_OBSERVER_GLOBAL, SESSION_MIRROR_OBSERVER_ACTIVATION_SNAPSHOT_KEY);
        if (!isCurrent())
            return false;
        if (existing) {
            if (!allowedActivationSnapshotDescriptor(existing))
                return false;
            const existingValue = existing.value;
            if (closedActivationSnapshotValue(existingValue) === undefined)
                return false;
            if (!isCurrent())
                return false;
            const reread = Object.getOwnPropertyDescriptor(SESSION_MIRROR_OBSERVER_GLOBAL, SESSION_MIRROR_OBSERVER_ACTIVATION_SNAPSHOT_KEY);
            if (!isCurrent())
                return false;
            if (!allowedActivationSnapshotDescriptor(reread) || reread.value !== existingValue) {
                return false;
            }
        }
        else if (!isCurrent()) {
            return false;
        }
        if (!isCurrent())
            return false;
        const snapshot = Object.freeze({ sessionConfigured });
        if (!isCurrent())
            return false;
        const defined = Reflect.defineProperty(SESSION_MIRROR_OBSERVER_GLOBAL, SESSION_MIRROR_OBSERVER_ACTIVATION_SNAPSHOT_KEY, {
            value: snapshot,
            writable: true,
            enumerable: existing?.enumerable ?? false,
            configurable: true,
        });
        if (!defined || !isCurrent())
            return false;
        const verification = Object.getOwnPropertyDescriptor(SESSION_MIRROR_OBSERVER_GLOBAL, SESSION_MIRROR_OBSERVER_ACTIVATION_SNAPSHOT_KEY);
        if (!isCurrent())
            return false;
        return (allowedActivationSnapshotDescriptor(verification) &&
            verification.value === snapshot &&
            closedActivationSnapshotValue(verification.value) === sessionConfigured);
    }
    catch {
        return false;
    }
}
function nextGeneration(value) {
    return value >= MAX_FACADE_GENERATION ? 1 : value + 1;
}
function safeNow(now) {
    try {
        const value = now();
        return Number.isFinite(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
function timingBucket(duration) {
    if (duration === undefined || !Number.isFinite(duration) || duration < 0)
        return ZERO_TIMING;
    if (duration <= 1)
        return "fast";
    if (duration <= 10)
        return "moderate";
    if (duration <= 100)
        return "slow";
    return "extended";
}
function measuredTiming(startedAt, now) {
    const finishedAt = safeNow(now);
    return startedAt === undefined || finishedAt === undefined
        ? ZERO_TIMING
        : timingBucket(Math.max(0, finishedAt - startedAt));
}
function initialState() {
    return {
        generation: 0,
        sessionConfigured: undefined,
        load: "not-loaded",
        attestation: "not-run",
        attestationReason: undefined,
        probe: undefined,
        loadTiming: ZERO_TIMING,
        attestationTiming: ZERO_TIMING,
    };
}
function configuredForCwd(cwd) {
    try {
        return isTlhExperimentalFeatureEnabled(getTlhExperimentalConfig(cwd), SESSION_MIRROR_OBSERVER_FEATURE);
    }
    catch {
        return false;
    }
}
function configuredForContext(ctx) {
    try {
        return configuredForCwd(ctx.cwd);
    }
    catch {
        return false;
    }
}
function safeSessionFile(sessionManager) {
    try {
        const sessionFile = sessionManager?.getSessionFile();
        return typeof sessionFile === "string" ? sessionFile : undefined;
    }
    catch {
        return undefined;
    }
}
function safeAttest(attest, sessionFile) {
    try {
        const result = attest({ sessionFile });
        if (result && result.ok === true) {
            const phase = result.phase;
            if (phase === "session-file" || phase === "directory-only") {
                return { ok: true, phase };
            }
        }
        if (result && result.ok === false) {
            const reason = result.reason;
            if (typeof reason === "string" &&
                [
                    "missing-profile-selection",
                    "missing-home",
                    "default-or-normal-profile",
                    "profile-mismatch",
                    "unsafe-profile-metadata",
                    "ephemeral-session",
                    "session-escape",
                    "unsafe-session-metadata",
                ].includes(reason)) {
                return { ok: false, reason };
            }
        }
    }
    catch {
    }
    return { ok: false, reason: "unsafe-profile-metadata" };
}
const OBSERVER_ATTESTATION_STATES = [
    "pending",
    "attested",
    "directory-only",
    "disabled",
    "shutdown",
];
const OBSERVER_STATUS_VALUES = ["idle", "active", "waiting", "error", "unknown"];
const OBSERVER_DIAGNOSTIC_CODES = [
    "queue-overflow",
    "stale-generation",
    "scheduler-failure",
    "session-unavailable",
    "attestation-failure",
    "attestation-not-ready",
    "projection-failure",
    "sink-throw",
    "sink-reject",
];
const ATTESTATION_REASONS = [
    "missing-profile-selection",
    "missing-home",
    "default-or-normal-profile",
    "profile-mismatch",
    "unsafe-profile-metadata",
    "ephemeral-session",
    "session-escape",
    "unsafe-session-metadata",
];
const PROJECTION_REASONS = [
    "invalid-metadata",
    "session-unavailable",
    "unsafe-session-data",
    "bounds-exceeded",
];
const PROBE_ENVELOPE_CATEGORIES = [
    "none",
    "empty",
    "text",
    "placeholder",
    "mixed",
    "error",
];
const TIMING_BUCKET_VALUES = ["unknown", "fast", "moderate", "slow", "extended"];
const MAX_OBSERVER_COUNTER = 2_000_000_000;
const MAX_OBSERVER_QUEUE_CAPACITY = 32;
function boundedCounter(value, maximum = MAX_OBSERVER_COUNTER) {
    return Number.isSafeInteger(value) && typeof value === "number" && value >= 0
        ? Math.min(value, maximum)
        : 0;
}
function boundedBoolean(value) {
    return value === true;
}
function enumValue(value, values, fallback) {
    return typeof value === "string" && values.includes(value) ? value : fallback;
}
function optionalEnumValue(value, values) {
    return typeof value === "string" && values.includes(value) ? value : undefined;
}
function boundedDiagnosticCounts(value) {
    const source = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
    const count = (key) => {
        try {
            return boundedCounter(source[key]);
        }
        catch {
            return 0;
        }
    };
    return Object.freeze({
        queueOverflow: count("queueOverflow"),
        staleGeneration: count("staleGeneration"),
        schedulerFailure: count("schedulerFailure"),
        sessionUnavailable: count("sessionUnavailable"),
        attestationFailure: count("attestationFailure"),
        attestationNotReady: count("attestationNotReady"),
        projectionFailure: count("projectionFailure"),
        sinkThrow: count("sinkThrow"),
        sinkReject: count("sinkReject"),
    });
}
function normalizeProbeState(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return undefined;
    try {
        const source = value;
        const queueCapacity = Math.min(Math.max(boundedCounter(source.queueCapacity, MAX_OBSERVER_QUEUE_CAPACITY), 1), MAX_OBSERVER_QUEUE_CAPACITY);
        const timing = source.timing;
        const timingRecord = timing !== null && typeof timing === "object" && !Array.isArray(timing)
            ? timing
            : {};
        return Object.freeze({
            generation: boundedCounter(source.generation),
            enabled: boundedBoolean(source.enabled),
            attestation: enumValue(source.attestation, OBSERVER_ATTESTATION_STATES, "disabled"),
            status: enumValue(source.status, OBSERVER_STATUS_VALUES, "unknown"),
            settled: boundedBoolean(source.settled),
            dirty: boundedBoolean(source.dirty),
            snapshotRequired: boundedBoolean(source.snapshotRequired),
            publicationPending: boundedBoolean(source.publicationPending),
            queueDepth: Math.min(boundedCounter(source.queueDepth, queueCapacity), queueCapacity),
            queueCapacity,
            sinkInFlight: boundedBoolean(source.sinkInFlight),
            revision: boundedCounter(source.revision),
            successfulPublications: boundedCounter(source.successfulPublications),
            failedPublications: boundedCounter(source.failedPublications),
            coalescedMarkers: boundedCounter(source.coalescedMarkers),
            droppedMarkers: boundedCounter(source.droppedMarkers),
            diagnostics: boundedDiagnosticCounts(source.diagnostics),
            lastDiagnostic: optionalEnumValue(source.lastDiagnostic, OBSERVER_DIAGNOSTIC_CODES),
            lastAttestationFailure: optionalEnumValue(source.lastAttestationFailure, ATTESTATION_REASONS),
            lastProjectionFailure: optionalEnumValue(source.lastProjectionFailure, PROJECTION_REASONS),
            envelopeCategory: enumValue(source.envelopeCategory, PROBE_ENVELOPE_CATEGORIES, "none"),
            entryCount: boundedCounter(source.entryCount, 1024),
            rootCount: boundedCounter(source.rootCount, 1024),
            maxDepth: boundedCounter(source.maxDepth, 128),
            envelopeBytes: boundedCounter(source.envelopeBytes, 256 * 1024),
            timing: Object.freeze({
                attestation: enumValue(timingRecord.attestation, TIMING_BUCKET_VALUES, "unknown"),
                projection: enumValue(timingRecord.projection, TIMING_BUCKET_VALUES, "unknown"),
                sink: enumValue(timingRecord.sink, TIMING_BUCKET_VALUES, "unknown"),
            }),
            runtimeFailures: boundedCounter(source.runtimeFailures),
        });
    }
    catch {
        return undefined;
    }
}
function safeProbeState(probe) {
    if (!probe)
        return undefined;
    try {
        return normalizeProbeState(probe.getState());
    }
    catch {
        return undefined;
    }
}
function safeNotify(ctx, message) {
    try {
        ctx.ui.notify(message, "info");
    }
    catch {
    }
}
function noProbeMetrics() {
    return {
        envelopeCategory: "none",
        entryCount: 0,
        rootCount: 0,
        maxDepth: 0,
        envelopeBytes: 0,
        timing: {
            attestation: ZERO_TIMING,
            projection: ZERO_TIMING,
            sink: ZERO_TIMING,
        },
        runtimeFailures: 0,
    };
}
function noProbeDiagnostics() {
    return Object.freeze({
        queueOverflow: 0,
        staleGeneration: 0,
        schedulerFailure: 0,
        sessionUnavailable: 0,
        attestationFailure: 0,
        attestationNotReady: 0,
        projectionFailure: 0,
        sinkThrow: 0,
        sinkReject: 0,
    });
}
function formatValue(value) {
    return value ? "enabled" : "disabled";
}
function pressure(value, limit) {
    if (value <= 0)
        return "none";
    if (value >= limit)
        return "full";
    const percentage = value / limit;
    if (percentage <= 0.25)
        return "low";
    if (percentage <= 0.5)
        return "medium";
    return "high";
}
function formatReason(reason) {
    return reason ? `(${reason})` : "";
}
function formatDiagnostics(diagnostics) {
    const values = Object.entries(diagnostics).filter(([, value]) => value > 0);
    return values.length === 0 ? "none" : values.map(([name, value]) => `${name}=${value}`).join(",");
}
export function formatSessionMirrorObserverStatus(status) {
    const entryPressure = pressure(status.entryCount, 1024);
    const rootPressure = pressure(status.rootCount, 1024);
    const depthPressure = pressure(status.maxDepth, 128);
    const bytePressure = pressure(status.envelopeBytes, 256 * 1024);
    return [
        `${SESSION_MIRROR_OBSERVER_COMMAND}:`,
        `configured=${formatValue(status.configured)}`,
        `session-configured=${status.sessionConfigured === undefined ? "none" : formatValue(status.sessionConfigured)}`,
        `active=${status.active}`,
        `next-session=${formatValue(status.nextSessionConfigured)}`,
        "changes=next-session-only",
        `load=${status.load}`,
        `attestation=${status.attestation}${formatReason(status.attestationReason)}`,
        `queue=${status.queueDepth}/${status.queueCapacity}`,
        `sink=${status.sinkInFlight ? "in-flight" : "idle"}`,
        `snapshot-required=${status.snapshotRequired ? "yes" : "no"}`,
        `envelope=${status.envelopeCategory}`,
        `entries=${status.entryCount}/1024(${entryPressure})`,
        `roots=${status.rootCount}/1024(${rootPressure})`,
        `depth=${status.maxDepth}/128(${depthPressure})`,
        `envelope-bytes=${status.envelopeBytes}/262144(${bytePressure})`,
        `timing=load:${status.timing.load},attestation:${status.timing.attestation},projection:${status.timing.projection},sink:${status.timing.sink}`,
        `diagnostics=${formatDiagnostics(status.diagnostics)}`,
    ].join(" ");
}
function observerActiveState(load, probeState) {
    if (probeState?.enabled)
        return "enabled";
    if (load === "loading" || probeState?.attestation === "pending")
        return "pending";
    return "disabled";
}
function safeShutdownProbe(probe) {
    if (!probe)
        return;
    try {
        probe.sessionShutdown();
    }
    catch {
    }
}
function continueSessionMirrorObserverActivation(input) {
    const { state, isCurrent, sessionManager, loadProbe, attest, now } = input;
    const current = () => isCurrent(state);
    if (!current())
        return Promise.resolve();
    state.load = "loading";
    const loadStartedAt = safeNow(now);
    if (!current())
        return Promise.resolve();
    let pendingModule;
    try {
        pendingModule = loadProbe();
    }
    catch {
        if (!current())
            return Promise.resolve();
        const loadTiming = measuredTiming(loadStartedAt, now);
        if (!current())
            return Promise.resolve();
        state.loadTiming = loadTiming;
        if (!current())
            return Promise.resolve();
        state.load = "failed";
        return Promise.resolve();
    }
    if (!current())
        return Promise.resolve();
    return Promise.resolve(pendingModule).then((module) => {
        if (!current())
            return;
        const loadTiming = measuredTiming(loadStartedAt, now);
        if (!current())
            return;
        state.loadTiming = loadTiming;
        if (!current())
            return;
        let probe;
        try {
            if (!current())
                return;
            probe = module.createSessionMirrorObserverProbe({
                getSessionManager: () => sessionManager,
                attest,
                runtimeVersion: SESSION_MIRROR_OBSERVER_RUNTIME_VERSION,
                sessionSchemaVersion: SESSION_MIRROR_OBSERVER_SESSION_SCHEMA_VERSION,
            });
        }
        catch {
            if (!current())
                return;
            state.load = "failed";
            return;
        }
        if (!current()) {
            safeShutdownProbe(probe);
            return;
        }
        state.probe = probe;
        state.load = "loaded";
        if (!current()) {
            if (state.probe === probe)
                state.probe = undefined;
            safeShutdownProbe(probe);
            return;
        }
        try {
            probe.sessionStart();
        }
        catch {
            if (!current()) {
                if (state.probe === probe)
                    state.probe = undefined;
                safeShutdownProbe(probe);
                return;
            }
            if (state.probe === probe)
                state.probe = undefined;
            state.load = "failed";
            safeShutdownProbe(probe);
            return;
        }
        if (!current()) {
            if (state.probe === probe)
                state.probe = undefined;
            safeShutdownProbe(probe);
        }
    }, () => {
        if (!current())
            return;
        const loadTiming = measuredTiming(loadStartedAt, now);
        if (!current())
            return;
        state.loadTiming = loadTiming;
        if (!current())
            return;
        state.load = "failed";
    });
}
export function createSessionMirrorObserverFacade(options = {}) {
    const now = options.now ?? (() => performance.now());
    const attest = options.attest ?? attestSessionMirrorSession;
    const loadProbe = createRetryableLazyImport(options.loadProbe ?? (() => import("./session-mirror-observer-probe.js")));
    let state = initialState();
    const isCurrent = (candidate) => state === candidate;
    const sessionStart = (ctx, reason = "startup") => {
        const previousState = state;
        const nextState = {
            ...initialState(),
            generation: nextGeneration(previousState.generation),
        };
        const previousProbe = previousState.probe;
        state = nextState;
        previousState.probe = undefined;
        safeShutdownProbe(previousProbe);
        if (!isCurrent(nextState))
            return Promise.resolve();
        let sessionManager;
        try {
            sessionManager = ctx?.sessionManager;
        }
        catch {
            sessionManager = undefined;
        }
        if (!isCurrent(nextState))
            return Promise.resolve();
        let cwd = "";
        try {
            cwd = ctx?.cwd ?? "";
        }
        catch {
        }
        if (!isCurrent(nextState))
            return Promise.resolve();
        const previousActivation = reason === "reload" ? readActivationSnapshot() : undefined;
        if (!isCurrent(nextState))
            return Promise.resolve();
        if (reason === "reload" && previousActivation === undefined) {
            nextState.sessionConfigured = false;
            return Promise.resolve();
        }
        const configured = previousActivation ?? configuredForCwd(cwd);
        if (!isCurrent(nextState))
            return Promise.resolve();
        if (reason !== "reload" || previousActivation === undefined) {
            const stored = writeActivationSnapshot(configured, () => isCurrent(nextState));
            if (!isCurrent(nextState))
                return Promise.resolve();
            if (!stored) {
                nextState.sessionConfigured = false;
                return Promise.resolve();
            }
        }
        if (!isCurrent(nextState))
            return Promise.resolve();
        nextState.sessionConfigured = configured;
        if (!configured)
            return Promise.resolve();
        if (!sessionManager) {
            nextState.attestation = "failed";
            nextState.attestationReason = "unsafe-session-metadata";
            return Promise.resolve();
        }
        nextState.attestation = "pending";
        const attestationStartedAt = safeNow(now);
        if (!isCurrent(nextState))
            return Promise.resolve();
        const sessionFile = safeSessionFile(sessionManager);
        if (!isCurrent(nextState))
            return Promise.resolve();
        const attestation = safeAttest(attest, sessionFile);
        if (!isCurrent(nextState))
            return Promise.resolve();
        const attestationTiming = measuredTiming(attestationStartedAt, now);
        if (!isCurrent(nextState))
            return Promise.resolve();
        nextState.attestationTiming = attestationTiming;
        if (!isCurrent(nextState))
            return Promise.resolve();
        if (!attestation.ok) {
            nextState.attestation = "failed";
            nextState.attestationReason = attestation.reason;
            return Promise.resolve();
        }
        nextState.attestation = attestation.phase === "session-file" ? "attested" : "directory-only";
        return continueSessionMirrorObserverActivation({
            state: nextState,
            isCurrent,
            sessionManager,
            loadProbe,
            attest,
            now,
        });
    };
    const sessionShutdown = () => {
        const previousState = state;
        const previousProbe = previousState.probe;
        const next = nextGeneration(previousState.generation);
        state = {
            ...initialState(),
            generation: next,
            load: "shutdown",
            attestation: "shutdown",
        };
        previousState.probe = undefined;
        safeShutdownProbe(previousProbe);
    };
    const forward = (method) => {
        const probe = state.probe;
        if (!probe)
            return;
        try {
            probe[method]();
        }
        catch {
        }
    };
    const requestSnapshot = () => {
        const probe = state.probe;
        if (!probe)
            return false;
        try {
            probe.requestSnapshot();
            return true;
        }
        catch {
            return false;
        }
    };
    const getStatus = (ctx) => {
        const probeState = safeProbeState(state.probe);
        const metrics = probeState ?? noProbeMetrics();
        const observerState = probeState;
        const configured = configuredForContext(ctx);
        const attestation = observerState ? observerState.attestation : state.attestation;
        const attestationState = attestation === "pending" ||
            attestation === "attested" ||
            attestation === "directory-only" ||
            attestation === "disabled" ||
            attestation === "shutdown"
            ? attestation
            : attestation === "failed"
                ? "failed"
                : "not-run";
        const diagnostics = observerState?.diagnostics ?? noProbeDiagnostics();
        const queueDepth = observerState?.queueDepth ?? 0;
        const queueCapacity = observerState?.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
        return Object.freeze({
            configured,
            sessionConfigured: state.sessionConfigured,
            nextSessionConfigured: configured,
            active: observerActiveState(state.load, observerState),
            load: state.load,
            attestation: attestationState,
            attestationReason: observerState?.lastAttestationFailure ?? state.attestationReason,
            queueDepth,
            queueCapacity,
            sinkInFlight: observerState?.sinkInFlight ?? false,
            snapshotRequired: observerState?.snapshotRequired ?? false,
            envelopeCategory: metrics.envelopeCategory,
            entryCount: metrics.entryCount,
            rootCount: metrics.rootCount,
            maxDepth: metrics.maxDepth,
            envelopeBytes: metrics.envelopeBytes,
            timing: Object.freeze({
                load: state.loadTiming,
                attestation: metrics.timing.attestation === ZERO_TIMING
                    ? state.attestationTiming
                    : metrics.timing.attestation,
                projection: metrics.timing.projection,
                sink: metrics.timing.sink,
            }),
            diagnostics,
            lastDiagnostic: observerState?.lastDiagnostic,
            lastProjectionFailure: observerState?.lastProjectionFailure,
            runtimeFailures: metrics.runtimeFailures,
        });
    };
    const handleStatus = async (args, ctx) => {
        const command = typeof args === "string" ? args.trim().toLowerCase() : "";
        if (command !== "" && command !== "status" && command !== "snapshot") {
            safeNotify(ctx, `Usage: /${SESSION_MIRROR_OBSERVER_COMMAND} [status|snapshot]`);
            return;
        }
        if (command === "snapshot") {
            const requested = requestSnapshot();
            safeNotify(ctx, requested
                ? `Session-mirror observer snapshot requested; work remains deferred and nonblocking. ${formatSessionMirrorObserverStatus(getStatus(ctx))}`
                : `Session-mirror observer is not active; no snapshot was started. Changes apply on the next session. ${formatSessionMirrorObserverStatus(getStatus(ctx))}`);
            return;
        }
        safeNotify(ctx, formatSessionMirrorObserverStatus(getStatus(ctx)));
    };
    return Object.freeze({
        sessionStart,
        sessionShutdown,
        agentStart: () => forward("agentStart"),
        messageEnd: () => forward("messageEnd"),
        turnEnd: () => forward("turnEnd"),
        agentSettled: () => forward("agentSettled"),
        sessionTree: () => forward("sessionTree"),
        sessionCompact: () => forward("sessionCompact"),
        requestSnapshot,
        getStatus,
        handleStatus,
    });
}
export function registerSessionMirrorObserverFacade(pi, options = {}) {
    const facade = createSessionMirrorObserverFacade(options);
    pi.registerCommand(SESSION_MIRROR_OBSERVER_COMMAND, {
        description: "Show aggregate session-mirror observer status or request a deferred snapshot",
        getArgumentCompletions: (prefix) => {
            const normalized = prefix.trim().toLowerCase();
            const values = ["status", "snapshot"]
                .filter((value) => value.startsWith(normalized))
                .map((value) => ({ value, label: value }));
            return values.length > 0 ? values : null;
        },
        handler: (args, ctx) => facade.handleStatus(args, ctx),
    });
    pi.on("session_start", (event, ctx) => facade.sessionStart(ctx, event.reason));
    pi.on("session_shutdown", () => facade.sessionShutdown());
    pi.on("agent_start", () => facade.agentStart());
    pi.on("message_end", () => facade.messageEnd());
    pi.on("turn_end", () => facade.turnEnd());
    pi.on("agent_settled", () => facade.agentSettled());
    pi.on("session_tree", () => facade.sessionTree());
    pi.on("session_compact", () => facade.sessionCompact());
    return facade;
}
function createRetryableLazyImport(loader) {
    let modulePromise;
    return () => {
        if (!modulePromise) {
            modulePromise = loader().catch((error) => {
                modulePromise = undefined;
                throw error;
            });
        }
        return modulePromise;
    };
}

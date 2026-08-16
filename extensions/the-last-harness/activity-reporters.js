import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
const HERDR_SOURCE = "herdr:tlh";
const HERDR_AGENT = "pi";
const CMUX_STATUS_KEY = "tlh";
const DEFAULT_IDLE_DEBOUNCE_MS = 250;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20000;
const MIN_HEARTBEAT_INTERVAL_MS = 1000;
const MAX_HEARTBEAT_INTERVAL_MS = 2_147_483_647;
const HERDR_SOCKET_ATTEMPT_TIMEOUTS_MS = [500, 1500];
function parseDurationEnv(env, name, fallback) {
    const raw = env[name];
    if (!raw)
        return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function parseHeartbeatIntervalEnv(env) {
    const raw = env.HERDR_TLH_HEARTBEAT_MS;
    if (raw === undefined || raw.trim().length === 0)
        return DEFAULT_HEARTBEAT_INTERVAL_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed))
        return DEFAULT_HEARTBEAT_INTERVAL_MS;
    if (parsed === 0)
        return undefined;
    return parsed >= MIN_HEARTBEAT_INTERVAL_MS && parsed <= MAX_HEARTBEAT_INTERVAL_MS
        ? parsed
        : DEFAULT_HEARTBEAT_INTERVAL_MS;
}
function createNoopReporter() {
    return {
        handleSessionStart() { },
        handleSnapshot() { },
        handleSessionShutdown() { },
        dispose() { },
    };
}
function createQueuedStateReporter(sendState, options = {}, onStateCommitted) {
    const timers = {
        setTimeout: options.timers?.setTimeout ?? setTimeout,
        clearTimeout: options.timers?.clearTimeout ?? clearTimeout,
    };
    const idleDebounceMs = options.idleDebounceMs ?? DEFAULT_IDLE_DEBOUNCE_MS;
    let idleTimer;
    let sendInFlight = false;
    let queuedState;
    let lastQueuedState;
    let disposed = false;
    const clearIdleTimer = () => {
        if (!idleTimer)
            return;
        timers.clearTimeout(idleTimer);
        idleTimer = undefined;
    };
    const queueState = (state) => {
        if (disposed || lastQueuedState === state)
            return;
        queuedState = state;
        lastQueuedState = state;
        onStateCommitted?.(state);
        if (!sendInFlight) {
            void drainQueue();
        }
    };
    const drainQueue = async () => {
        if (sendInFlight || disposed)
            return;
        sendInFlight = true;
        try {
            while (!disposed && queuedState) {
                const nextState = queuedState;
                queuedState = undefined;
                try {
                    await sendState(nextState);
                }
                catch {
                }
            }
        }
        finally {
            sendInFlight = false;
            if (!disposed && queuedState) {
                void drainQueue();
            }
        }
    };
    return {
        handleSnapshot(snapshot) {
            if (disposed)
                return;
            if (snapshot.inProgress) {
                clearIdleTimer();
                queueState("working");
                return;
            }
            clearIdleTimer();
            idleTimer = timers.setTimeout(() => {
                idleTimer = undefined;
                queueState("idle");
            }, idleDebounceMs);
            idleTimer.unref?.();
        },
        handleSessionShutdown() {
            clearIdleTimer();
        },
        dispose() {
            disposed = true;
            clearIdleTimer();
            queuedState = undefined;
        },
    };
}
function readSessionRef(ctx) {
    let agentSessionPath;
    let agentSessionId;
    try {
        const candidatePath = ctx.sessionManager.getSessionFile();
        agentSessionPath =
            typeof candidatePath === "string" && candidatePath.startsWith("/")
                ? candidatePath
                : undefined;
    }
    catch {
        agentSessionPath = undefined;
    }
    try {
        const candidateId = ctx.sessionManager.getSessionId();
        agentSessionId =
            typeof candidateId === "string" && candidateId.length > 0 ? candidateId : undefined;
    }
    catch {
        agentSessionId = undefined;
    }
    return { agentSessionId, agentSessionPath };
}
function withSessionRef(params, sessionRef) {
    if (sessionRef.agentSessionPath) {
        return { ...params, agent_session_path: sessionRef.agentSessionPath };
    }
    if (sessionRef.agentSessionId) {
        return { ...params, agent_session_id: sessionRef.agentSessionId };
    }
    return params;
}
function createHerdrSocketAttempt(socketPath, request, timeoutMs, options) {
    const timers = {
        setTimeout: options.timers?.setTimeout ?? setTimeout,
        clearTimeout: options.timers?.clearTimeout ?? clearTimeout,
    };
    const payload = `${JSON.stringify(request)}\n`;
    const createSocket = options.createSocket ?? ((path) => createConnection(path));
    return new Promise((resolve) => {
        let settled = false;
        let socket;
        let timeout;
        const finish = (delivered) => {
            if (settled)
                return;
            settled = true;
            if (timeout) {
                timers.clearTimeout(timeout);
                timeout = undefined;
            }
            socket?.removeListener?.("error", handleError);
            socket?.removeListener?.("connect", handleConnect);
            socket?.removeListener?.("data", handleData);
            socket?.removeListener?.("end", handleEnd);
            try {
                socket?.destroy();
            }
            catch {
            }
            resolve(delivered);
        };
        const handleError = () => finish(false);
        const handleConnect = () => {
            try {
                socket?.write(payload);
            }
            catch {
                finish(false);
            }
        };
        const handleData = () => finish(true);
        const handleEnd = () => finish(false);
        try {
            socket = createSocket(socketPath);
        }
        catch {
            finish(false);
            return;
        }
        socket.on("error", handleError);
        socket.on("connect", handleConnect);
        socket.on("data", handleData);
        socket.on("end", handleEnd);
        timeout = timers.setTimeout(() => finish(false), timeoutMs);
        timeout.unref?.();
    });
}
function defaultHerdrRequestSender(env, options = {}) {
    return async (request) => {
        const socketPath = env.HERDR_SOCKET_PATH;
        if (!socketPath)
            return;
        for (const timeoutMs of HERDR_SOCKET_ATTEMPT_TIMEOUTS_MS) {
            const delivered = await createHerdrSocketAttempt(socketPath, request, timeoutMs, options);
            if (delivered) {
                return;
            }
        }
    };
}
export function createHerdrActivityReporter(options = {}) {
    const env = options.env ?? process.env;
    const paneId = env.HERDR_PANE_ID;
    if (!paneId || !env.HERDR_SOCKET_PATH) {
        return createNoopReporter();
    }
    if (env.HERDR_ENV !== undefined && env.HERDR_ENV !== "1") {
        return createNoopReporter();
    }
    const agentDir = options.agentDir ?? env.PI_CODING_AGENT_DIR;
    if (agentDir && existsSync(join(agentDir, "extensions", "herdr-agent-state.ts"))) {
        return createNoopReporter();
    }
    const sendRequest = options.sendRequest ?? defaultHerdrRequestSender(env, options);
    const now = options.now ?? Date.now;
    let reportSeq = now() * 1000;
    let sessionRef = {};
    let rootSession = false;
    let disposed = false;
    const heartbeatIntervalMs = parseHeartbeatIntervalEnv(env);
    const heartbeatTimers = {
        setTimeout: options.timers?.setTimeout ?? setTimeout,
        clearTimeout: options.timers?.clearTimeout ?? clearTimeout,
    };
    let desiredState;
    let lastReportedState;
    let heartbeatTimer;
    let heartbeatStopped = false;
    let heartbeatStarted = false;
    let outboundChain = Promise.resolve();
    const nextReportSeq = () => {
        reportSeq += 1;
        return reportSeq;
    };
    const enqueueOutbound = (task) => {
        const delivery = outboundChain.then(task);
        outboundChain = delivery.catch(() => { });
        return delivery;
    };
    const sendStateCore = async (state) => {
        await sendRequest({
            id: `${HERDR_SOURCE}:${now()}:${Math.random().toString(36).slice(2)}`,
            method: "pane.report_agent",
            params: withSessionRef({
                pane_id: paneId,
                source: HERDR_SOURCE,
                agent: HERDR_AGENT,
                state,
                seq: nextReportSeq(),
            }, sessionRef),
        });
    };
    const stopHeartbeat = () => {
        heartbeatStopped = true;
        if (heartbeatTimer) {
            heartbeatTimers.clearTimeout(heartbeatTimer);
            heartbeatTimer = undefined;
        }
    };
    const scheduleHeartbeat = () => {
        if (heartbeatIntervalMs === undefined || heartbeatStopped || !rootSession || disposed)
            return;
        heartbeatTimer = heartbeatTimers.setTimeout(() => {
            heartbeatTimer = undefined;
            if (heartbeatStopped || !rootSession || disposed)
                return;
            const heartbeatDelivery = enqueueOutbound(async () => {
                if (heartbeatStopped || !rootSession || disposed)
                    return;
                const state = desiredState ?? lastReportedState;
                if (state === undefined)
                    return;
                await sendStateCore(state);
                lastReportedState = state;
            });
            void heartbeatDelivery
                .catch(() => undefined)
                .finally(() => {
                if (!heartbeatStopped && rootSession && !disposed)
                    scheduleHeartbeat();
            });
        }, heartbeatIntervalMs);
        heartbeatTimer.unref?.();
    };
    const sendState = () => {
        return enqueueOutbound(async () => {
            if (!rootSession || disposed)
                return;
            const state = desiredState;
            if (state === undefined)
                return;
            await sendStateCore(state);
            lastReportedState = state;
            if (!heartbeatStarted) {
                heartbeatStarted = true;
                scheduleHeartbeat();
            }
        });
    };
    const queuedReporter = createQueuedStateReporter(sendState, {
        idleDebounceMs: options.idleDebounceMs ??
            parseDurationEnv(env, "HERDR_TLH_IDLE_DEBOUNCE_MS", DEFAULT_IDLE_DEBOUNCE_MS),
        timers: options.timers,
    }, (state) => {
        desiredState = state;
    });
    return {
        handleSessionStart(ctx) {
            if (disposed || ctx.mode !== "tui") {
                rootSession = false;
                return;
            }
            rootSession = true;
            sessionRef = readSessionRef(ctx);
            if (!sessionRef.agentSessionId && !sessionRef.agentSessionPath)
                return;
            const startedSessionRef = sessionRef;
            void sendRequest({
                id: `${HERDR_SOURCE}:session:${now()}:${Math.random().toString(36).slice(2)}`,
                method: "pane.report_agent_session",
                params: withSessionRef({
                    pane_id: paneId,
                    source: HERDR_SOURCE,
                    agent: HERDR_AGENT,
                    seq: nextReportSeq(),
                }, startedSessionRef),
            }).catch(() => undefined);
        },
        handleSnapshot(snapshot) {
            if (!rootSession || disposed)
                return;
            queuedReporter.handleSnapshot(snapshot);
        },
        handleSessionShutdown() {
            if (!rootSession)
                return;
            rootSession = false;
            stopHeartbeat();
            queuedReporter.handleSessionShutdown();
        },
        dispose() {
            disposed = true;
            rootSession = false;
            stopHeartbeat();
            queuedReporter.dispose();
        },
    };
}
function defaultCommandRunner(command, args) {
    return new Promise((resolve) => {
        let settled = false;
        let child;
        const finish = () => {
            if (settled)
                return;
            settled = true;
            resolve();
        };
        try {
            child = spawn(command, [...args], {
                stdio: "ignore",
                windowsHide: true,
            });
        }
        catch {
            finish();
            return;
        }
        child.on("error", finish);
        child.on("close", finish);
    });
}
function cmuxStatusValue(_snapshot) {
    return "working";
}
function sanitizeCmuxStatusKeySegment(value) {
    const sanitized = value
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return sanitized.length > 0 ? sanitized : undefined;
}
function getCmuxStatusKey(env, ctx) {
    const surfaceSegment = typeof env.CMUX_SURFACE_ID === "string"
        ? sanitizeCmuxStatusKeySegment(env.CMUX_SURFACE_ID)
        : undefined;
    if (surfaceSegment) {
        return `${CMUX_STATUS_KEY}-${surfaceSegment}`;
    }
    try {
        const sessionId = ctx.sessionManager.getSessionId();
        const sessionSegment = typeof sessionId === "string" ? sanitizeCmuxStatusKeySegment(sessionId) : undefined;
        if (sessionSegment) {
            return `${CMUX_STATUS_KEY}-${sessionSegment}`;
        }
    }
    catch {
    }
    return CMUX_STATUS_KEY;
}
export function createCmuxActivityReporter(options = {}) {
    const env = options.env ?? process.env;
    if (!env.CMUX_WORKSPACE_ID) {
        return createNoopReporter();
    }
    const cmuxBin = options.cmuxBin ?? env.CMUX_PI_CMUX_BIN ?? env.CMUX_BUNDLED_CLI_PATH ?? env.CMUX_BIN ?? "cmux";
    const runner = options.runner ?? defaultCommandRunner;
    let rootSession = false;
    let lastValue;
    let statusKey = CMUX_STATUS_KEY;
    const sendState = async (state) => {
        if (state === "idle") {
            lastValue = undefined;
            await runner(cmuxBin, ["clear-status", statusKey]);
            return;
        }
        const value = lastValue ?? "working";
        await runner(cmuxBin, ["set-status", statusKey, value]);
    };
    const queuedReporter = createQueuedStateReporter(sendState, options);
    return {
        handleSessionStart(ctx) {
            rootSession = ctx.mode === "tui";
            if (!rootSession)
                return;
            statusKey = getCmuxStatusKey(env, ctx);
        },
        handleSnapshot(snapshot) {
            if (!rootSession)
                return;
            lastValue = snapshot.inProgress ? cmuxStatusValue(snapshot) : undefined;
            queuedReporter.handleSnapshot(snapshot);
        },
        handleSessionShutdown() {
            if (!rootSession)
                return;
            queuedReporter.handleSessionShutdown();
            void runner(cmuxBin, ["clear-status", statusKey]).catch(() => undefined);
        },
        dispose() {
            queuedReporter.dispose();
        },
    };
}
export function registerTlhActivityReporters(pi, tracker, options = {}) {
    const reporters = [
        createHerdrActivityReporter(options.herdr),
        createCmuxActivityReporter(options.cmux),
    ];
    const unsubscribe = tracker.subscribe((snapshot) => {
        for (const reporter of reporters) {
            reporter.handleSnapshot(snapshot);
        }
    });
    pi.on("session_start", (_event, ctx) => {
        for (const reporter of reporters) {
            reporter.handleSessionStart(ctx);
        }
        const snapshot = tracker.getSnapshot();
        for (const reporter of reporters) {
            reporter.handleSnapshot(snapshot);
        }
    });
    pi.on("session_shutdown", () => {
        unsubscribe();
        for (const reporter of reporters) {
            reporter.handleSessionShutdown();
            reporter.dispose();
        }
    });
}

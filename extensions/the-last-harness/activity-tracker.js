import * as fs from "node:fs";
import * as path from "node:path";
import { resolveTempRootDir } from "../shared/subagent-temp-root.js";
import { TLH_EFFECTIVE_ACTIVITY_EVENT } from "../shared/tlh-effective-activity.js";
import { isBundledSubagentRestoreProviderActive, resetBundledSubagentRestoreProvider, SUBAGENT_ASYNC_RESTORED_EVENT, } from "../shared/subagent-restore-contract.js";
export { TLH_EFFECTIVE_ACTIVITY_EVENT };
const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const SUBAGENT_CONTROL_EVENT = "subagent:control-event";
const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
const RETRY_GRACE_REASON = "primary:retry-grace";
const DEFAULT_RETRY_GRACE_MS = 1500;
const COMPLETED_ASYNC_TOMBSTONE_MS = 60_000;
const ASYNC_TERMINAL_STATES = new Set(["complete", "failed", "cancelled", "continued"]);
const LIVENESS_DRAIN_INTERVAL_MS = 5_000;
const QUEUED_GRACE_MS = 30_000;
function localCheckPidLiveness(pid) {
    try {
        process.kill(pid, 0);
        return "alive";
    }
    catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
            ? error.code
            : undefined;
        if (code === "ESRCH")
            return "dead";
        if (code === "EPERM")
            return "unknown";
        return "unknown";
    }
}
function resolveDefaultAsyncDir() {
    return path.join(resolveTempRootDir(), "async-subagent-runs");
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function readNonEmptyStringField(record, key) {
    const value = record[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
function toValidPid(value) {
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
function isAsyncControlContext(data, event) {
    const asyncDir = readNonEmptyStringField(data, "asyncDir") ?? readNonEmptyStringField(event, "asyncDir");
    if (asyncDir) {
        return true;
    }
    const mode = (readNonEmptyStringField(data, "mode") ?? readNonEmptyStringField(event, "mode"))?.toLowerCase();
    if (mode === "async" || mode === "background") {
        return true;
    }
    const source = (readNonEmptyStringField(data, "source") ?? readNonEmptyStringField(event, "source"))?.toLowerCase();
    return source === "async" || source === "background";
}
function looksLikeRetryableAgentEnd(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return false;
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!isRecord(message) || message.role !== "assistant") {
            continue;
        }
        return message.stopReason === "error" || typeof message.errorMessage === "string";
    }
    return false;
}
function readRestorableAsyncJob(asyncDir) {
    const statusPath = path.join(asyncDir, "status.json");
    const raw = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
    if (!isRecord(raw) ||
        (raw.state !== "running" && raw.state !== "queued") ||
        typeof raw.runId !== "string" ||
        raw.runId.length === 0 ||
        typeof raw.sessionId !== "string" ||
        raw.sessionId.length === 0) {
        return undefined;
    }
    const pid = toValidPid(raw.pid);
    return {
        runId: raw.runId,
        sessionId: raw.sessionId,
        ...(pid !== undefined ? { pid } : {}),
    };
}
export function createTlhEffectiveActivityTracker(options = {}) {
    const asyncDir = options.asyncDir ?? resolveDefaultAsyncDir();
    const now = options.now ?? Date.now;
    const setTimeoutImpl = options.setTimeout ?? setTimeout;
    const clearTimeoutImpl = options.clearTimeout ?? clearTimeout;
    const retryGraceMs = options.retryGraceMs ?? DEFAULT_RETRY_GRACE_MS;
    const completedAsyncTombstoneMs = options.completedAsyncTombstoneMs ?? COMPLETED_ASYNC_TOMBSTONE_MS;
    const checkPidLivenessImpl = options.checkPidLiveness ?? localCheckPidLiveness;
    const livenessIntervalMs = options.livenessIntervalMs ?? LIVENESS_DRAIN_INTERVAL_MS;
    const primaryReasons = new Map();
    const activeAsyncJobs = new Map();
    const recentlyCompletedAsyncJobs = new Map();
    const retryGraceTimers = new Map();
    const listeners = new Set();
    let disposed = false;
    let activeSessionId;
    let uiPromptDepth = 0;
    let lastSnapshotKey = "0::0::::";
    let livenessTimer;
    const stopLivenessTimer = () => {
        if (livenessTimer !== undefined) {
            clearTimeoutImpl(livenessTimer);
            livenessTimer = undefined;
        }
    };
    const scheduleLivenessCheck = () => {
        if (disposed || livenessTimer !== undefined || activeAsyncJobs.size === 0)
            return;
        const handle = setTimeoutImpl(() => {
            livenessTimer = undefined;
            if (!disposed) {
                notifyIfChanged();
                scheduleLivenessCheck();
            }
        }, livenessIntervalMs);
        if (handle !== null && typeof handle.unref === "function") {
            handle.unref();
        }
        livenessTimer = handle;
    };
    const cleanupCompletedAsyncJobTombstones = () => {
        const cutoff = now() - completedAsyncTombstoneMs;
        for (const [runId, completedAt] of recentlyCompletedAsyncJobs) {
            if (completedAt < cutoff) {
                recentlyCompletedAsyncJobs.delete(runId);
            }
        }
    };
    const addPrimaryReason = (reason) => {
        if (disposed)
            return;
        primaryReasons.set(reason, (primaryReasons.get(reason) ?? 0) + 1);
    };
    const removePrimaryReason = (reason) => {
        const current = primaryReasons.get(reason);
        if (!current)
            return;
        if (current <= 1) {
            primaryReasons.delete(reason);
            return;
        }
        primaryReasons.set(reason, current - 1);
    };
    const syncRetryGraceReason = () => {
        if (retryGraceTimers.size > 0) {
            primaryReasons.set(RETRY_GRACE_REASON, 1);
            return;
        }
        primaryReasons.delete(RETRY_GRACE_REASON);
    };
    const clearRetryGrace = () => {
        for (const timer of retryGraceTimers.values()) {
            clearTimeoutImpl(timer);
        }
        retryGraceTimers.clear();
        syncRetryGraceReason();
    };
    const scheduleRetryGrace = (reasonKey) => {
        if (disposed)
            return;
        const existing = retryGraceTimers.get(reasonKey);
        if (existing) {
            clearTimeoutImpl(existing);
        }
        retryGraceTimers.set(reasonKey, setTimeoutImpl(() => {
            retryGraceTimers.delete(reasonKey);
            syncRetryGraceReason();
            notifyIfChanged();
        }, retryGraceMs));
        syncRetryGraceReason();
    };
    const mergeAsyncJobRecord = (existing, incoming) => {
        const incomingAsyncDir = typeof incoming.asyncDir === "string" && incoming.asyncDir.length > 0
            ? incoming.asyncDir
            : undefined;
        const existingAsyncDir = typeof existing?.asyncDir === "string" && existing.asyncDir.length > 0
            ? existing.asyncDir
            : undefined;
        const asyncDir = incomingAsyncDir ?? existingAsyncDir;
        const pid = toValidPid(incoming.pid) ?? toValidPid(existing?.pid);
        const sessionId = incoming.sessionId ?? existing?.sessionId;
        return {
            source: incoming.source,
            ...(asyncDir ? { asyncDir } : {}),
            ...(pid !== undefined ? { pid } : {}),
            ...(sessionId ? { sessionId } : {}),
        };
    };
    const setAsyncJobActive = (runId, record) => {
        if (disposed)
            return;
        cleanupCompletedAsyncJobTombstones();
        if (!runId || recentlyCompletedAsyncJobs.has(runId)) {
            return;
        }
        activeAsyncJobs.set(runId, mergeAsyncJobRecord(activeAsyncJobs.get(runId), record));
        scheduleLivenessCheck();
    };
    const isRestoredSource = (source) => source === "rehydrated" || source === "restored";
    const replaceRestoredAsyncJobs = (jobs) => {
        cleanupCompletedAsyncJobTombstones();
        for (const [runId, record] of activeAsyncJobs) {
            if (isRestoredSource(record.source))
                activeAsyncJobs.delete(runId);
        }
        if (activeAsyncJobs.size === 0)
            stopLivenessTimer();
        for (const job of jobs) {
            if (!job.runId || !job.asyncDir)
                continue;
            const existing = activeAsyncJobs.get(job.runId);
            if (existing && !isRestoredSource(existing.source))
                continue;
            if (recentlyCompletedAsyncJobs.has(job.runId))
                continue;
            const pid = toValidPid(job.pid);
            activeAsyncJobs.set(job.runId, {
                source: job.source,
                asyncDir: job.asyncDir,
                ...(job.sessionId ? { sessionId: job.sessionId } : {}),
                ...(pid !== undefined ? { pid } : {}),
            });
        }
        scheduleLivenessCheck();
    };
    const drainDeadAsyncJobs = () => {
        if (activeAsyncJobs.size === 0)
            return;
        const toDelete = [];
        for (const [runId, record] of activeAsyncJobs) {
            if (!record.asyncDir) {
                toDelete.push(runId);
                continue;
            }
            let raw;
            try {
                raw = JSON.parse(fs.readFileSync(path.join(record.asyncDir, "status.json"), "utf-8"));
            }
            catch {
                if (record.pid !== undefined) {
                    const liveness = checkPidLivenessImpl(record.pid);
                    if (liveness !== "dead") {
                        continue;
                    }
                }
                toDelete.push(runId);
                continue;
            }
            if (!isRecord(raw)) {
                toDelete.push(runId);
                continue;
            }
            const state = readNonEmptyStringField(raw, "state");
            if (!state || ASYNC_TERMINAL_STATES.has(state)) {
                toDelete.push(runId);
                continue;
            }
            if (state === "queued") {
                const startedAt = raw["startedAt"];
                if (typeof startedAt === "number" &&
                    Number.isFinite(startedAt) &&
                    startedAt <= now() &&
                    now() - startedAt <= QUEUED_GRACE_MS) {
                    continue;
                }
                toDelete.push(runId);
                continue;
            }
            const pid = toValidPid(raw["pid"]);
            if (pid === undefined) {
                toDelete.push(runId);
                continue;
            }
            const liveness = checkPidLivenessImpl(pid);
            if (liveness === "dead") {
                toDelete.push(runId);
            }
        }
        for (const runId of toDelete) {
            activeAsyncJobs.delete(runId);
        }
    };
    const markAsyncJobComplete = (runId) => {
        if (disposed || !runId)
            return;
        activeAsyncJobs.delete(runId);
        recentlyCompletedAsyncJobs.set(runId, now());
        cleanupCompletedAsyncJobTombstones();
        if (activeAsyncJobs.size === 0) {
            stopLivenessTimer();
        }
    };
    const currentSessionId = (sessionManager) => {
        const sessionId = sessionManager?.getSessionFile?.() ?? sessionManager?.getSessionId?.();
        return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
    };
    const buildSnapshot = () => ({
        inProgress: primaryReasons.size > 0 || activeAsyncJobs.size > 0,
        waitingForUser: uiPromptDepth > 0,
        primaryReasons: [...primaryReasons.keys()].sort(),
        activeAsyncJobIds: [...activeAsyncJobs.keys()].sort(),
    });
    const snapshotKey = (snapshot) => [
        snapshot.inProgress ? "1" : "0",
        snapshot.waitingForUser ? "1" : "0",
        snapshot.primaryReasons.join(","),
        snapshot.activeAsyncJobIds.join(","),
    ].join("::");
    const notifyIfChanged = () => {
        drainDeadAsyncJobs();
        const snapshot = buildSnapshot();
        const nextKey = snapshotKey(snapshot);
        if (nextKey === lastSnapshotKey) {
            return;
        }
        lastSnapshotKey = nextKey;
        for (const listener of listeners) {
            try {
                listener(snapshot);
            }
            catch {
            }
        }
    };
    return {
        getSnapshot() {
            cleanupCompletedAsyncJobTombstones();
            drainDeadAsyncJobs();
            return buildSnapshot();
        },
        isInProgress() {
            return this.getSnapshot().inProgress;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        beginSession(ctx) {
            activeSessionId = currentSessionId(ctx.sessionManager);
        },
        rehydrateFromArtifacts(ctx) {
            if (disposed)
                return;
            activeSessionId = currentSessionId(ctx.sessionManager);
            const restoredJobs = [];
            const entries = (() => {
                try {
                    return fs.readdirSync(asyncDir, { withFileTypes: true });
                }
                catch (error) {
                    if (isRecord(error) && error.code === "ENOENT") {
                        return undefined;
                    }
                    return undefined;
                }
            })();
            if (entries && activeSessionId) {
                for (const entry of entries) {
                    if (!entry.isDirectory())
                        continue;
                    const candidateAsyncDir = path.join(asyncDir, entry.name);
                    try {
                        const status = readRestorableAsyncJob(candidateAsyncDir);
                        if (!status || status.sessionId !== activeSessionId)
                            continue;
                        restoredJobs.push({
                            runId: status.runId,
                            asyncDir: candidateAsyncDir,
                            sessionId: status.sessionId,
                            ...(status.pid !== undefined ? { pid: status.pid } : {}),
                            source: "rehydrated",
                        });
                    }
                    catch {
                    }
                }
            }
            replaceRestoredAsyncJobs(restoredJobs);
            notifyIfChanged();
        },
        dispose() {
            disposed = true;
            stopLivenessTimer();
            clearRetryGrace();
            primaryReasons.clear();
            activeAsyncJobs.clear();
            recentlyCompletedAsyncJobs.clear();
            activeSessionId = undefined;
            uiPromptDepth = 0;
            notifyIfChanged();
            listeners.clear();
        },
        handleBeforeAgentStart() {
            clearRetryGrace();
            addPrimaryReason("primary:pending-start");
            notifyIfChanged();
        },
        handleAgentStart() {
            clearRetryGrace();
            removePrimaryReason("primary:pending-start");
            addPrimaryReason("primary:agent-loop");
            notifyIfChanged();
        },
        handleAgentEnd(event) {
            removePrimaryReason("primary:agent-loop");
            removePrimaryReason("primary:pending-start");
            if (looksLikeRetryableAgentEnd(event.messages)) {
                scheduleRetryGrace("agent-end");
            }
            notifyIfChanged();
        },
        handleTurnStart() {
            clearRetryGrace();
            notifyIfChanged();
        },
        handleToolExecutionStart(event) {
            if (!event.toolCallId)
                return;
            addPrimaryReason(`primary:tool:${event.toolCallId}`);
            notifyIfChanged();
        },
        handleToolExecutionEnd(event) {
            if (!event.toolCallId)
                return;
            removePrimaryReason(`primary:tool:${event.toolCallId}`);
            notifyIfChanged();
        },
        handleSessionBeforeCompact(event) {
            clearRetryGrace();
            addPrimaryReason(`primary:compaction:${event.reason ?? "unknown"}`);
            notifyIfChanged();
        },
        handleSessionCompact(event) {
            removePrimaryReason(`primary:compaction:${event.reason ?? "unknown"}`);
            if (event.willRetry) {
                scheduleRetryGrace(`compaction:${event.reason ?? "unknown"}`);
            }
            notifyIfChanged();
        },
        handleSessionCompactFailed(event) {
            removePrimaryReason(`primary:compaction:${event?.reason ?? "unknown"}`);
            notifyIfChanged();
        },
        handleUIPromptStart() {
            if (disposed)
                return;
            uiPromptDepth += 1;
            notifyIfChanged();
        },
        handleUIPromptEnd() {
            if (uiPromptDepth === 0)
                return;
            uiPromptDepth -= 1;
            notifyIfChanged();
        },
        handleAsyncRestored(data) {
            if (disposed || !activeSessionId || !isRecord(data))
                return;
            const snapshot = data;
            if (snapshot.sessionId !== activeSessionId || !Array.isArray(snapshot.jobs))
                return;
            const restoredJobs = [];
            for (const candidate of snapshot.jobs) {
                if (!isRecord(candidate))
                    continue;
                const runId = readNonEmptyStringField(candidate, "runId");
                const asyncDir = readNonEmptyStringField(candidate, "asyncDir");
                const sessionId = readNonEmptyStringField(candidate, "sessionId");
                if (!runId || !asyncDir || sessionId !== activeSessionId)
                    continue;
                const pid = toValidPid(candidate.pid);
                restoredJobs.push({
                    runId,
                    asyncDir,
                    sessionId,
                    ...(pid !== undefined ? { pid } : {}),
                    source: "restored",
                });
            }
            replaceRestoredAsyncJobs(restoredJobs);
            notifyIfChanged();
        },
        handleAsyncStarted(data) {
            if (!isRecord(data) || typeof data.id !== "string" || data.id.length === 0) {
                return;
            }
            const record = { source: "started" };
            const asyncDir = readNonEmptyStringField(data, "asyncDir");
            if (asyncDir)
                record.asyncDir = asyncDir;
            const sessionId = readNonEmptyStringField(data, "sessionId");
            if (sessionId)
                record.sessionId = sessionId;
            const pid = toValidPid(data.pid);
            if (pid !== undefined)
                record.pid = pid;
            setAsyncJobActive(data.id, record);
            notifyIfChanged();
        },
        handleAsyncComplete(data) {
            if (!isRecord(data))
                return;
            const runId = typeof data.id === "string" && data.id.length > 0
                ? data.id
                : typeof data.runId === "string" && data.runId.length > 0
                    ? data.runId
                    : undefined;
            if (!runId)
                return;
            markAsyncJobComplete(runId);
            notifyIfChanged();
        },
        handleAsyncControl(data) {
            if (!isRecord(data) ||
                !isRecord(data.event) ||
                typeof data.event.runId !== "string" ||
                data.event.runId.length === 0) {
                return;
            }
            if (!isAsyncControlContext(data, data.event)) {
                return;
            }
            const record = { source: "control" };
            const asyncDir = readNonEmptyStringField(data, "asyncDir") ??
                readNonEmptyStringField(data.event, "asyncDir");
            if (asyncDir)
                record.asyncDir = asyncDir;
            const sessionId = readNonEmptyStringField(data, "sessionId") ??
                readNonEmptyStringField(data.event, "sessionId");
            if (sessionId)
                record.sessionId = sessionId;
            setAsyncJobActive(data.event.runId, record);
            notifyIfChanged();
        },
    };
}
export function registerTlhEffectiveActivityTracker(pi, options = {}) {
    resetBundledSubagentRestoreProvider();
    const tracker = createTlhEffectiveActivityTracker();
    const env = options.env ?? process.env;
    const unsubscribes = pi.events
        ? [
            pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (data) => tracker.handleAsyncStarted(data)),
            pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data) => tracker.handleAsyncComplete(data)),
            pi.events.on(SUBAGENT_CONTROL_EVENT, (data) => tracker.handleAsyncControl(data)),
            pi.events.on(SUBAGENT_ASYNC_RESTORED_EVENT, (data) => tracker.handleAsyncRestored(data)),
        ]
        : [];
    if (pi.events) {
        tracker.subscribe((snapshot) => {
            try {
                pi.events?.emit(TLH_EFFECTIVE_ACTIVITY_EVENT, {
                    inProgress: snapshot.inProgress,
                    waitingForUser: snapshot.waitingForUser,
                    activeAsyncJobIds: snapshot.activeAsyncJobIds,
                });
            }
            catch {
            }
        });
    }
    pi.on("session_start", (_event, ctx) => {
        tracker.beginSession(ctx);
        if (env[SUBAGENT_CHILD_ENV] === "1")
            return;
        if (pi.events && isBundledSubagentRestoreProviderActive())
            return;
        tracker.rehydrateFromArtifacts(ctx);
    });
    pi.on("before_agent_start", () => {
        tracker.handleBeforeAgentStart();
    });
    pi.on("agent_start", () => {
        tracker.handleAgentStart();
    });
    pi.on("agent_end", (event) => {
        tracker.handleAgentEnd(event);
    });
    pi.on("turn_start", () => {
        tracker.handleTurnStart();
    });
    pi.on("tool_execution_start", (event) => {
        tracker.handleToolExecutionStart(event);
    });
    pi.on("tool_execution_end", (event) => {
        tracker.handleToolExecutionEnd(event);
    });
    pi.on("session_before_compact", (event) => {
        tracker.handleSessionBeforeCompact(event);
    });
    pi.on("session_compact", (event) => {
        tracker.handleSessionCompact(event);
    });
    pi.on("session_compact_failed", (event) => {
        tracker.handleSessionCompactFailed(event);
    });
    pi.on("ui_prompt_start", (event) => {
        tracker.handleUIPromptStart(event);
    });
    pi.on("ui_prompt_end", (event) => {
        tracker.handleUIPromptEnd(event);
    });
    pi.on("session_shutdown", () => {
        for (const unsubscribe of unsubscribes) {
            try {
                unsubscribe();
            }
            catch {
            }
        }
        tracker.dispose();
    });
    return tracker;
}

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const SUBAGENT_CONTROL_EVENT = "subagent:control-event";
const RETRY_GRACE_REASON = "primary:retry-grace";
const DEFAULT_RETRY_GRACE_MS = 1500;
const COMPLETED_ASYNC_TOMBSTONE_MS = 60_000;
function sanitizeTempScopeSegment(value) {
    const sanitized = value
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return sanitized || "unknown";
}
function resolvePiSubagentsTempScopeId() {
    if (typeof process.getuid === "function") {
        return `uid-${process.getuid()}`;
    }
    for (const key of ["USERNAME", "USER", "LOGNAME"]) {
        const value = process.env[key];
        if (value)
            return `user-${sanitizeTempScopeSegment(value)}`;
    }
    try {
        const username = os.userInfo().username;
        if (username)
            return `user-${sanitizeTempScopeSegment(username)}`;
    }
    catch {
    }
    const homedir = process.env.USERPROFILE ?? process.env.HOME;
    if (homedir)
        return `home-${sanitizeTempScopeSegment(homedir)}`;
    try {
        const fallbackHomedir = os.homedir();
        if (fallbackHomedir)
            return `home-${sanitizeTempScopeSegment(fallbackHomedir)}`;
    }
    catch {
    }
    return "shared";
}
function resolveDefaultAsyncDir() {
    return path.join(os.tmpdir(), `pi-subagents-${resolvePiSubagentsTempScopeId()}`, "async-subagent-runs");
}
function normalizeComparablePath(target) {
    const resolved = path.resolve(target);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function readNonEmptyStringField(record, key) {
    const value = record[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
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
function readRunningAsyncJob(asyncDir) {
    const statusPath = path.join(asyncDir, "status.json");
    const raw = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
    if (!isRecord(raw) || raw.state !== "running" || typeof raw.runId !== "string" || raw.runId.length === 0) {
        return undefined;
    }
    return {
        runId: raw.runId,
        ...(typeof raw.sessionId === "string" && raw.sessionId.length > 0 ? { sessionId: raw.sessionId } : {}),
        ...(typeof raw.cwd === "string" && raw.cwd.length > 0 ? { cwd: raw.cwd } : {}),
    };
}
export function createTlhEffectiveActivityTracker(options = {}) {
    const asyncDir = options.asyncDir ?? resolveDefaultAsyncDir();
    const now = options.now ?? Date.now;
    const setTimeoutImpl = options.setTimeout ?? setTimeout;
    const clearTimeoutImpl = options.clearTimeout ?? clearTimeout;
    const retryGraceMs = options.retryGraceMs ?? DEFAULT_RETRY_GRACE_MS;
    const completedAsyncTombstoneMs = options.completedAsyncTombstoneMs ?? COMPLETED_ASYNC_TOMBSTONE_MS;
    const primaryReasons = new Map();
    const activeAsyncJobs = new Map();
    const recentlyCompletedAsyncJobs = new Map();
    const retryGraceTimers = new Map();
    const listeners = new Set();
    let disposed = false;
    let lastSnapshotKey = "0::::";
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
    const setAsyncJobActive = (runId, record) => {
        if (disposed)
            return;
        cleanupCompletedAsyncJobTombstones();
        if (!runId || recentlyCompletedAsyncJobs.has(runId)) {
            return;
        }
        const existing = activeAsyncJobs.get(runId);
        activeAsyncJobs.set(runId, existing ? { ...existing, ...record } : record);
    };
    const markAsyncJobComplete = (runId) => {
        if (disposed || !runId)
            return;
        activeAsyncJobs.delete(runId);
        recentlyCompletedAsyncJobs.set(runId, now());
        cleanupCompletedAsyncJobTombstones();
    };
    const currentSessionId = (sessionManager) => {
        const sessionId = sessionManager?.getSessionId?.();
        return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
    };
    const buildSnapshot = () => ({
        inProgress: primaryReasons.size > 0 || activeAsyncJobs.size > 0,
        primaryReasons: [...primaryReasons.keys()].sort(),
        activeAsyncJobIds: [...activeAsyncJobs.keys()].sort(),
    });
    const snapshotKey = (snapshot) => [snapshot.inProgress ? "1" : "0", snapshot.primaryReasons.join(","), snapshot.activeAsyncJobIds.join(",")].join("::");
    const notifyIfChanged = () => {
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
        rehydrateFromArtifacts(ctx) {
            if (disposed)
                return;
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
            if (!entries)
                return;
            const normalizedCwd = normalizeComparablePath(ctx.cwd);
            const sessionId = currentSessionId(ctx.sessionManager);
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const candidateAsyncDir = path.join(asyncDir, entry.name);
                try {
                    const status = readRunningAsyncJob(candidateAsyncDir);
                    if (!status)
                        continue;
                    if (sessionId && status.sessionId && sessionId !== status.sessionId)
                        continue;
                    if (status.cwd && normalizeComparablePath(status.cwd) !== normalizedCwd)
                        continue;
                    setAsyncJobActive(status.runId, { asyncDir: candidateAsyncDir, source: "rehydrated" });
                }
                catch {
                }
            }
            notifyIfChanged();
        },
        dispose() {
            disposed = true;
            clearRetryGrace();
            primaryReasons.clear();
            activeAsyncJobs.clear();
            recentlyCompletedAsyncJobs.clear();
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
        handleAsyncStarted(data) {
            if (!isRecord(data) || typeof data.id !== "string" || data.id.length === 0) {
                return;
            }
            setAsyncJobActive(data.id, {
                asyncDir: typeof data.asyncDir === "string" && data.asyncDir.length > 0 ? data.asyncDir : undefined,
                source: "started",
            });
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
            setAsyncJobActive(data.event.runId, {
                asyncDir: readNonEmptyStringField(data, "asyncDir") ?? readNonEmptyStringField(data.event, "asyncDir"),
                source: "control",
            });
            notifyIfChanged();
        },
    };
}
export function registerTlhEffectiveActivityTracker(pi) {
    const tracker = createTlhEffectiveActivityTracker();
    const unsubscribes = pi.events
        ? [
            pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (data) => tracker.handleAsyncStarted(data)),
            pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data) => tracker.handleAsyncComplete(data)),
            pi.events.on(SUBAGENT_CONTROL_EVENT, (data) => tracker.handleAsyncControl(data)),
        ]
        : [];
    pi.on("session_start", (_event, ctx) => {
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

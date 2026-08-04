import { listAsyncRuns } from "./async-status.js";
import { ASYNC_DIR, RESULTS_DIR, SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_CONTROL_EVENT, } from "../../shared/types.js";
import { formatDuration } from "../../shared/formatters.js";
const ACTIVE_STATES = ["queued", "running"];
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_POLL_INTERVAL_MS = 250;
const DEFAULT_POLL_INTERVAL_MS = 1000;
export const WAIT_TOOL_ENABLED_ENV = "PI_SUBAGENT_WAIT_TOOL_ENABLED";
const WAIT_TOOL_TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);
const WAIT_TOOL_FALSE_VALUES = new Set(["0", "false", "no", "off", "disabled"]);
function parseWaitToolEnabledEnv(value) {
    if (value === undefined)
        return undefined;
    const normalized = value.trim().toLowerCase();
    if (WAIT_TOOL_TRUE_VALUES.has(normalized))
        return true;
    if (WAIT_TOOL_FALSE_VALUES.has(normalized))
        return false;
    throw new Error(`${WAIT_TOOL_ENABLED_ENV} must be one of true/false, 1/0, yes/no, on/off, or enabled/disabled.`);
}
function configWaitToolEnabled(config) {
    if (config === undefined)
        return undefined;
    if (typeof config === "boolean")
        return config;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new Error("config.waitTool must be a boolean or an object with optional enabled boolean.");
    }
    const enabled = config.enabled;
    if (enabled === undefined)
        return undefined;
    if (typeof enabled !== "boolean")
        throw new Error("config.waitTool.enabled must be a boolean.");
    return enabled;
}
export function resolveWaitToolConfig(config, env = process.env) {
    return {
        enabled: parseWaitToolEnabledEnv(env[WAIT_TOOL_ENABLED_ENV]) ?? configWaitToolEnabled(config) ?? true,
    };
}
const WAKE_CHANNELS = [
    SUBAGENT_ASYNC_COMPLETE_EVENT,
    SUBAGENT_CONTROL_EVENT,
];
function defaultSleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
function waitForWake(ms, signal, deps) {
    const sleep = deps.sleep ?? defaultSleep;
    const events = deps.events;
    if (!events)
        return sleep(ms, signal);
    return new Promise((resolve) => {
        let settled = false;
        const unsubs = [];
        const wakeController = new AbortController();
        const done = () => {
            if (settled)
                return;
            settled = true;
            wakeController.abort();
            signal?.removeEventListener("abort", done);
            for (const u of unsubs) {
                try {
                    u();
                }
                catch { }
            }
            resolve();
        };
        if (signal?.aborted) {
            done();
            return;
        }
        signal?.addEventListener("abort", done, { once: true });
        for (const channel of WAKE_CHANNELS) {
            try {
                unsubs.push(events.on(channel, done));
            }
            catch { }
        }
        void sleep(ms, wakeController.signal).then(done);
    });
}
function matchesId(run, id) {
    return run.id === id || run.id.startsWith(id);
}
function needsAttention(run) {
    return run.activityState === "needs_attention";
}
function activeRunsForSession(params, deps) {
    const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
    const resultsDir = deps.resultsDir ?? RESULTS_DIR;
    const runs = listAsyncRuns(asyncDirRoot, {
        states: [...ACTIVE_STATES],
        sessionId: deps.state.currentSessionId ?? undefined,
        resultsDir,
        kill: deps.kill,
        now: deps.now,
    });
    return params.id ? runs.filter((run) => matchesId(run, params.id)) : runs;
}
function attentionRunsForSession(params, deps, initialIds) {
    return activeRunsForSession(params, deps).filter((run) => needsAttention(run) && initialIds.has(run.id));
}
function allRunsForSession(params, deps) {
    const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
    const resultsDir = deps.resultsDir ?? RESULTS_DIR;
    const runs = listAsyncRuns(asyncDirRoot, {
        sessionId: deps.state.currentSessionId ?? undefined,
        resultsDir,
        kill: deps.kill,
        now: deps.now,
    });
    return params.id ? runs.filter((run) => matchesId(run, params.id)) : runs;
}
function summarizeTerminalRuns(runs) {
    if (runs.length === 0)
        return "";
    const counts = { complete: 0, failed: 0, paused: 0 };
    for (const run of runs) {
        if (run.state in counts)
            counts[run.state] += 1;
    }
    const parts = [];
    if (counts.complete)
        parts.push(`${counts.complete} complete`);
    if (counts.failed)
        parts.push(`${counts.failed} failed`);
    if (counts.paused)
        parts.push(`${counts.paused} paused`);
    return parts.join(", ");
}
function result(text, isError = false) {
    return {
        content: [{ type: "text", text }],
        ...(isError ? { isError: true } : {}),
        details: { mode: "management", results: [] },
    };
}
export async function waitForSubagents(params, signal, deps) {
    if (deps.enabled === false) {
        return result("Wait tool is disabled by config.waitTool or PI_SUBAGENT_WAIT_TOOL_ENABLED; returning immediately without blocking background subagent runs. Active runs keep going, and you can inspect them with subagent({ action: \"status\" }) or wait for completion notifications.");
    }
    const now = deps.now ?? Date.now;
    const pollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const timeoutMs = params.timeoutMs !== undefined && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_TIMEOUT_MS;
    const startedAt = now();
    const waitForAll = params.id ? true : params.all === true;
    let active;
    try {
        active = activeRunsForSession(params, deps);
    }
    catch (error) {
        return result(error instanceof Error ? error.message : String(error), true);
    }
    if (active.length === 0) {
        const finished = params.id
            ? `No active run matched "${params.id}". Nothing to wait for.`
            : "No active async runs in this session. Nothing to wait for.";
        return result(finished);
    }
    if (params.id) {
        const exact = active.filter((run) => run.id === params.id);
        if (exact.length === 1)
            active = exact;
        else if (active.length > 1) {
            return result(`Ambiguous async run id prefix "${params.id}" matched ${active.length} active runs: ${active.map((run) => run.id).join(", ")}. Pass a longer id.`, true);
        }
    }
    const waitParams = params.id ? { ...params, id: active[0].id } : params;
    const initialIds = new Set(active.map((run) => run.id));
    const initialCount = initialIds.size;
    let pending = active.filter((run) => !needsAttention(run));
    const done = (active, attention) => {
        if (attention.length > 0)
            return true;
        if (waitForAll)
            return active.every((run) => !initialIds.has(run.id));
        const stillActiveInitial = active.filter((run) => initialIds.has(run.id));
        return stillActiveInitial.length < initialCount;
    };
    let attention = active.filter((run) => needsAttention(run));
    while (!done(pending, attention)) {
        if (signal?.aborted) {
            const stillActive = pending.map((run) => `${run.id} (${run.state})`).join(", ");
            return result(`Wait aborted after ${formatDuration(now() - startedAt)}. Still active: ${stillActive}.`, true);
        }
        if (now() - startedAt >= timeoutMs) {
            const stillActive = pending.map((run) => `${run.id} (${run.state})`).join(", ");
            return result(`Wait timed out after ${formatDuration(timeoutMs)} with ${pending.length} run(s) still active: ${stillActive}. `
                + `The runs are detached and keep going; call wait again or inspect with subagent({ action: "status" }).`, true);
        }
        await waitForWake(pollIntervalMs, signal, deps);
        try {
            active = activeRunsForSession(waitParams, deps);
            pending = active.filter((run) => !needsAttention(run));
            attention = attentionRunsForSession(waitParams, deps, initialIds);
        }
        catch (error) {
            return result(error instanceof Error ? error.message : String(error), true);
        }
    }
    let terminalSummary = "";
    let finishedCount = 0;
    try {
        const allNow = allRunsForSession(waitParams, deps);
        const terminal = allNow.filter((run) => !ACTIVE_STATES.includes(run.state) && initialIds.has(run.id));
        finishedCount = terminal.length;
        terminalSummary = summarizeTerminalRuns(terminal);
    }
    catch {
    }
    const attentionNote = attention.length > 0
        ? ` ${attention.length} run(s) need attention: ${attention.map((r) => r.id).join(", ")} — inspect with subagent({ action: "status" }) then nudge/resume/interrupt.`
        : "";
    const stillRunning = pending.filter((run) => initialIds.has(run.id)).length;
    const elapsed = formatDuration(now() - startedAt);
    const outcome = terminalSummary ? ` Outcome: ${terminalSummary}.` : "";
    if (waitForAll) {
        const scope = params.id ? `run "${params.id}"` : `${initialCount} async run(s)`;
        const status = attention.length > 0 ? "attention required" : "done";
        const notificationText = attention.length > 0
            ? "Relevant completion/control events have been observed; inspect status if the notification is not visible yet."
            : "Completion events have been observed; inspect status if the notification is not visible yet.";
        return result(`Waited ${elapsed} for ${scope}; ${status}.${outcome}${attentionNote} ${notificationText}`);
    }
    const remainder = stillRunning > 0
        ? ` ${stillRunning} run(s) still in flight — call wait again to catch the next one.`
        : attention.length > 0
            ? " No other runs are waitable until attention is handled."
            : " No runs remain in flight.";
    const progress = attention.length > 0 && finishedCount === 0
        ? `${attention.length} of ${initialCount} run(s) need attention`
        : `${finishedCount} of ${initialCount} run(s) finished`;
    const notificationText = finishedCount > 0
        ? " Completion events for the finished run(s) have been observed; inspect status if the notification is not visible yet."
        : " Relevant control events have been observed; inspect status if the notification is not visible yet.";
    return result(`Waited ${elapsed}; ${progress}.${outcome}${attentionNote}${remainder}${notificationText}`);
}

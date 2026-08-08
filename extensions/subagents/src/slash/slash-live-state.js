import { SLASH_RESULT_TYPE, } from "../shared/types.js";
const liveSnapshots = new Map();
const finalSnapshots = new Map();
let versionCounter = 1;
const EMPTY_MESSAGES = [];
const EMPTY_USAGE = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
};
function nextVersion() {
    return versionCounter++;
}
function cloneUsage() {
    return { ...EMPTY_USAGE };
}
function createPlaceholderResult(agent, task, status, index) {
    return {
        agent,
        task,
        exitCode: 0,
        messages: EMPTY_MESSAGES,
        usage: cloneUsage(),
        progress: {
            index,
            agent,
            status,
            task,
            recentTools: [],
            recentOutput: [],
            toolCount: 0,
            tokens: 0,
            durationMs: 0,
        },
    };
}
function buildParallelInitialResult(params) {
    const tasks = params.tasks ?? [];
    return {
        content: [{ type: "text", text: tasks.map((task) => `${task.agent}: ${task.task}`).join("\n\n") }],
        details: {
            mode: "parallel",
            ...(params.context ? { context: params.context } : {}),
            results: tasks.map((task, index) => createPlaceholderResult(task.agent, task.task, "running", index)),
            progress: tasks.map((task, index) => ({
                index,
                agent: task.agent,
                status: "running",
                task: task.task,
                recentTools: [],
                recentOutput: [],
                toolCount: 0,
                tokens: 0,
                durationMs: 0,
            })),
        },
    };
}
function buildSingleInitialResult(params) {
    const agent = params.agent ?? "subagent";
    const task = params.task ?? "";
    return {
        content: [{ type: "text", text: task }],
        details: {
            mode: "single",
            ...(params.context ? { context: params.context } : {}),
            results: [createPlaceholderResult(agent, task, "running", 0)],
            progress: [
                {
                    index: 0,
                    agent,
                    status: "running",
                    task,
                    recentTools: [],
                    recentOutput: [],
                    toolCount: 0,
                    tokens: 0,
                    durationMs: 0,
                },
            ],
        },
    };
}
export function buildSlashInitialResult(requestId, params) {
    const result = (params.tasks?.length ?? 0) > 0 ? buildParallelInitialResult(params) : buildSingleInitialResult(params);
    liveSnapshots.set(requestId, { result, version: nextVersion() });
    finalSnapshots.delete(requestId);
    return { requestId, result };
}
function cloneResultsWithProgress(results, progress) {
    return results.map((result, index) => {
        const nextProgress = progress?.find((entry) => entry.index === index) ?? progress?.[index] ?? result.progress;
        return nextProgress ? { ...result, progress: nextProgress } : result;
    });
}
export function applySlashUpdate(requestId, update) {
    const snapshot = liveSnapshots.get(requestId);
    if (!snapshot)
        return;
    const progress = update.progress;
    if (!progress || !snapshot.result.details)
        return;
    const nextDetails = {
        ...snapshot.result.details,
        progress,
        results: cloneResultsWithProgress(snapshot.result.details.results, progress),
    };
    liveSnapshots.set(requestId, {
        result: {
            ...snapshot.result,
            details: nextDetails,
        },
        version: nextVersion(),
    });
}
export function finalizeSlashResult(response) {
    const snapshot = {
        result: response.result,
        version: nextVersion(),
    };
    finalSnapshots.set(response.requestId, snapshot);
    liveSnapshots.delete(response.requestId);
    return {
        requestId: response.requestId,
        result: response.result,
    };
}
export function failSlashResult(requestId, params, message) {
    const initial = buildSlashInitialResult(requestId, params).result;
    const failedResults = initial.details.results.map((result) => ({
        ...result,
        exitCode: 1,
        error: message,
        progress: result.progress ? { ...result.progress, status: "failed" } : result.progress,
    }));
    const result = {
        content: [{ type: "text", text: message }],
        details: {
            ...initial.details,
            results: failedResults,
            progress: failedResults.map((entry) => entry.progress).filter(Boolean),
        },
    };
    const snapshot = { result, version: nextVersion() };
    finalSnapshots.set(requestId, snapshot);
    liveSnapshots.delete(requestId);
    return { requestId, result };
}
function isSlashMessageDetails(value) {
    if (!value || typeof value !== "object")
        return false;
    const v = value;
    if (typeof v.requestId !== "string" || !v.requestId)
        return false;
    if (!v.result || !Array.isArray(v.result.content))
        return false;
    return !!v.result.details && Array.isArray(v.result.details.results);
}
export function resolveSlashMessageDetails(value) {
    return isSlashMessageDetails(value) ? value : undefined;
}
export function getSlashRenderableSnapshot(details) {
    return (finalSnapshots.get(details.requestId) ??
        liveSnapshots.get(details.requestId) ?? { result: details.result, version: 0 });
}
export function restoreSlashFinalSnapshots(entries) {
    liveSnapshots.clear();
    finalSnapshots.clear();
    for (const entry of entries) {
        const e = entry;
        if (e?.type !== "custom_message" || e.customType !== SLASH_RESULT_TYPE)
            continue;
        const details = resolveSlashMessageDetails(e.details);
        if (!details)
            continue;
        finalSnapshots.set(details.requestId, { result: details.result, version: nextVersion() });
    }
}
export function clearSlashSnapshots() {
    liveSnapshots.clear();
    finalSnapshots.clear();
}

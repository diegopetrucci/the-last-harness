import * as fs from "node:fs";
import * as path from "node:path";
import { buildCompletionKey, getGlobalSeenMap, markSeenWithTtl } from "./completion-dedupe.js";
import { createCompletionBatcher, resolveCompletionBatchConfig, } from "./completion-batcher.js";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../shared/types.js";
import { isProtectedPausedLifecycle } from "../shared/lifecycle-privacy.js";
import { BACKGROUND_COMPLETION_NUDGE_TEXT } from "../shared/nudge-texts.js";
export const MAX_COMPLETION_MESSAGE_CHARS = 8_000;
const MAX_DISPLAYED_CHILDREN = 8;
const MAX_SUMMARY_CHARS = 1_200;
const MAX_REFERENCE_CHARS = 500;
const MAX_NESTED_ENTRIES = 8;
const MAX_NESTED_DEPTH = 2;
const MAX_LABEL_CHARS = 160;
const MAX_ASYNC_ID_CHARS = 200;
const MAX_SESSION_PATH_CHARS = 4_096;
function truncateWithMarker(value, maxChars, marker) {
    if (value.length <= maxChars)
        return value;
    if (marker.length >= maxChars)
        return marker.slice(0, maxChars);
    return `${value.slice(0, maxChars - marker.length)}${marker}`;
}
function boundedSummary(value) {
    return truncateWithMarker(value, MAX_SUMMARY_CHARS, "… [summary truncated]");
}
export function boundedReference(value) {
    return truncateWithMarker(value, MAX_REFERENCE_CHARS, "… [reference truncated]");
}
function boundedLabel(value) {
    return truncateWithMarker(value, MAX_LABEL_CHARS, "… [label truncated]");
}
function formatSessionLine(details) {
    if (!details.sessionValue)
        return undefined;
    const value = boundedReference(details.sessionValue);
    return details.sessionLabel ? `${details.sessionLabel}: ${value}` : value;
}
function hasUnsafeIdentifierCharacters(value) {
    return [...value].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029;
    });
}
function normalizeAsyncIdentifier(value) {
    if (typeof value !== "string")
        return undefined;
    if (value.trim() === "" || value.length > MAX_ASYNC_ID_CHARS || hasUnsafeIdentifierCharacters(value))
        return undefined;
    if (path.isAbsolute(value) || /[\\/]/.test(value) || value.includes(".."))
        return undefined;
    return value;
}
function formatAsyncIdLine(details) {
    const asyncId = normalizeAsyncIdentifier(details.asyncId);
    return asyncId ? `Async id: ${asyncId}` : undefined;
}
function formatResumeLine(details) {
    const asyncId = normalizeAsyncIdentifier(details.asyncId);
    const target = details.resumeTarget;
    if (!asyncId || !target || !hasExistingSessionFile(target.sessionPath))
        return undefined;
    if (target.index !== undefined) {
        if (typeof target.childCount !== "number" ||
            !Number.isInteger(target.childCount) ||
            !isValidChildIndex(target.index, target.childCount))
            return undefined;
    }
    const idLiteral = JSON.stringify(asyncId);
    return target.index === undefined
        ? `Revive: subagent({ action: "resume", id: ${idLiteral}, message: "..." })`
        : `Revive child: subagent({ action: "resume", id: ${idLiteral}, index: ${target.index}, message: "..." })`;
}
function formatPausedSupervisorActionLines(details) {
    const asyncId = normalizeAsyncIdentifier(details.asyncId);
    const target = details.resumeTarget;
    if (!details.awaitingSupervisor || !asyncId || !target || !hasExistingSessionFile(target.sessionPath))
        return [];
    const idLiteral = JSON.stringify(asyncId);
    if (target.index === undefined) {
        return [
            "No child process is running.",
            `Resume unchanged: subagent({ action: "resume", id: ${idLiteral} })`,
            `Resume with guidance: subagent({ action: "resume", id: ${idLiteral}, message: "Supervisor replied: ..." })`,
            `Cancel: subagent({ action: "interrupt", id: ${idLiteral} })`,
        ];
    }
    if (typeof target.childCount !== "number" ||
        !Number.isInteger(target.childCount) ||
        !isValidChildIndex(target.index, target.childCount))
        return [];
    return [
        "No child process is running.",
        `Resume unchanged: subagent({ action: "resume", id: ${idLiteral}, index: ${target.index} })`,
        `Resume with guidance: subagent({ action: "resume", id: ${idLiteral}, index: ${target.index}, message: "Supervisor replied: ..." })`,
        `Cancel: subagent({ action: "interrupt", id: ${idLiteral}, index: ${target.index} })`,
    ];
}
function normalizeSessionPath(value) {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_SESSION_PATH_CHARS ? value : undefined;
}
function hasExistingSessionFile(value) {
    const sessionPath = normalizeSessionPath(value);
    return sessionPath !== undefined && fs.existsSync(sessionPath);
}
function resolveAsyncIdentifier(result) {
    return normalizeAsyncIdentifier(result.id) ?? normalizeAsyncIdentifier(result.runId);
}
function isValidChildIndex(value, childCount) {
    return (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value < childCount);
}
function resolveResumeTarget(result, asyncId) {
    if (!asyncId)
        return undefined;
    const children = Array.isArray(result.results) ? result.results : [];
    if (children.length <= 1) {
        const sessionPath = normalizeSessionPath(children[0]?.sessionPath ?? result.sessionFile);
        return sessionPath && fs.existsSync(sessionPath) ? { sessionPath } : undefined;
    }
    const statusPriority = ["failed", "paused", "completed", "detached"];
    const resumableChild = statusPriority
        .map((status) => children.find((child) => resolveChildStatus(child) === status &&
        isValidChildIndex(child.index, children.length) &&
        hasExistingSessionFile(child.sessionPath)))
        .find((child) => child !== undefined);
    const sessionPath = normalizeSessionPath(resumableChild?.sessionPath);
    if (!resumableChild || sessionPath === undefined || !isValidChildIndex(resumableChild.index, children.length))
        return undefined;
    return { sessionPath, index: resumableChild.index, childCount: children.length };
}
function resolveChildStatus(child) {
    return child.status ?? (child.success === false ? "failed" : "completed");
}
function resolveOuterStatus(result) {
    const summary = typeof result.summary === "string" ? result.summary : "";
    const paused = result.state === "paused" ||
        (result.state !== "failed" &&
            !result.success &&
            (result.exitCode === 0 || summary.startsWith("Paused after interrupt.")));
    if (paused)
        return "paused";
    if (!result.success || result.state === "failed" || (typeof result.exitCode === "number" && result.exitCode !== 0))
        return "failed";
    return "completed";
}
function countChildStatuses(children) {
    if (children.length <= 1)
        return undefined;
    const counts = new Map();
    for (const child of children) {
        const key = resolveChildStatus(child);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const ordered = ["completed", "failed", "paused", "detached"];
    const parts = ordered
        .map((status) => (counts.get(status) ? `${counts.get(status)} ${status}` : undefined))
        .filter((part) => Boolean(part));
    return parts.length ? parts.join(", ") : undefined;
}
function formatNestedChildren(children, indent = "   ", budget = { remaining: MAX_NESTED_ENTRIES, omissionMarkers: new Set() }) {
    if (!children?.length)
        return [];
    const lines = ["Nested subagents:"];
    const markOmitted = (currentIndent, marker) => {
        if (budget.omissionMarkers.has(marker))
            return;
        budget.omissionMarkers.add(marker);
        lines.push(`${currentIndent}${marker}`);
    };
    const append = (runs, currentIndent, depth) => {
        if (!runs?.length)
            return;
        if (depth >= MAX_NESTED_DEPTH) {
            markOmitted(currentIndent, "… [nested depth limit reached]");
            return;
        }
        for (const child of runs) {
            if (budget.remaining <= 0) {
                markOmitted(currentIndent, "… [additional nested entries omitted]");
                return;
            }
            budget.remaining--;
            const label = boundedLabel(child.agent ?? child.id ?? "nested");
            const state = child.state ? boundedLabel(child.state) : undefined;
            lines.push(`${currentIndent}↳ ${label}${state ? ` — ${state}` : ""}`);
            append(child.children, `${currentIndent}  `, depth + 1);
        }
    };
    append(children, indent, 0);
    return lines;
}
function formatChildReferences(child, privacySafe = false) {
    if (privacySafe)
        return [];
    return [
        child.artifactPath ? `Output artifact: ${boundedReference(child.artifactPath)}` : undefined,
        child.sessionPath ? `Session: ${boundedReference(child.sessionPath)}` : undefined,
    ].filter((line) => Boolean(line));
}
function formatProtectedLifecyclePreview(result) {
    const children = Array.isArray(result.results) ? result.results : [];
    if (children.length <= 1)
        return "Paused awaiting supervisor.";
    const lines = [];
    const counts = countChildStatuses(children);
    if (counts)
        lines.push(`Children: ${counts}`, "");
    const displayedChildren = ["failed", "paused", "completed", "detached"]
        .flatMap((status) => children
        .map((child, index) => ({ child, index, status: resolveChildStatus(child) }))
        .filter((entry) => entry.status === status))
        .slice(0, MAX_DISPLAYED_CHILDREN);
    if (children.length > displayedChildren.length)
        lines.push(`… [${children.length - displayedChildren.length} child results omitted]`, "");
    for (const { child, index, status } of displayedChildren) {
        lines.push(`${index + 1}/${children.length}. ${boundedLabel(child.agent)} — ${status}`);
        lines.push(...formatNestedChildren(child.children, "   "));
        lines.push("");
    }
    return lines.join("\n").trimEnd() || "Paused awaiting supervisor.";
}
function formatResultPreview(result) {
    const privacySafe = isProtectedPausedLifecycle({
        state: result.state,
        pause: result.pause,
    });
    if (privacySafe)
        return formatProtectedLifecyclePreview(result);
    const children = Array.isArray(result.results) ? result.results : [];
    const nestedBudget = { remaining: MAX_NESTED_ENTRIES, omissionMarkers: new Set() };
    if (children.length === 0)
        return boundedSummary(typeof result.summary === "string" ? result.summary : "");
    const outerFailureSummary = resolveOuterStatus(result) === "failed" && !children.some((child) => resolveChildStatus(child) === "failed")
        ? boundedSummary(typeof result.summary === "string" ? result.summary : "")
        : "";
    if (children.length === 1) {
        const child = children[0];
        const childSummary = boundedSummary(child.summary ?? child.output ?? (outerFailureSummary ? "" : (result.summary ?? "")));
        const lines = outerFailureSummary ? [outerFailureSummary, "", childSummary || "(no output)"] : [childSummary];
        lines.push(...formatChildReferences(child, privacySafe));
        lines.push(...formatNestedChildren(child.children, "   ", nestedBudget));
        return lines.join("\n").trim();
    }
    const lines = [];
    if (outerFailureSummary)
        lines.push(outerFailureSummary, "");
    const counts = countChildStatuses(children);
    if (counts)
        lines.push(`Children: ${counts}`, "");
    const displayedChildren = ["failed", "paused", "completed", "detached"]
        .flatMap((status) => children
        .map((child, index) => ({ child, index, status: resolveChildStatus(child) }))
        .filter((entry) => entry.status === status))
        .slice(0, MAX_DISPLAYED_CHILDREN);
    if (children.length > displayedChildren.length) {
        lines.push(`… [${children.length - displayedChildren.length} child results omitted]`, "");
    }
    for (const { child, index, status } of displayedChildren) {
        lines.push(`${index + 1}/${children.length}. ${boundedLabel(child.agent)} — ${status}`);
        lines.push(boundedSummary((child.summary ?? child.output ?? "").trim()) || "(no output)");
        lines.push(...formatChildReferences(child, privacySafe));
        lines.push(...formatNestedChildren(child.children, "   ", nestedBudget));
        lines.push("");
    }
    return lines.join("\n").trimEnd();
}
export function formatSingleCompletion(details) {
    const asyncIdLine = formatAsyncIdLine(details);
    const resumeLine = formatResumeLine(details);
    const pausedSupervisorActionLines = formatPausedSupervisorActionLines(details);
    const sessionLine = formatSessionLine(details);
    return [
        `Background task ${details.status}: **${details.agent}**${details.taskInfo ?? ""}`,
        "",
        asyncIdLine,
        ...(pausedSupervisorActionLines.length > 0 ? pausedSupervisorActionLines : [resumeLine]),
        asyncIdLine || pausedSupervisorActionLines.length > 0 || resumeLine ? "" : undefined,
        details.resultPreview.trim() ? details.resultPreview : "(no output)",
        sessionLine ? "" : undefined,
        sessionLine,
    ]
        .filter((line) => line !== undefined)
        .join("\n");
}
export function formatGroupedCompletion(details) {
    const header = `Background tasks completed (${details.length}): ${details.map((d) => `**${d.agent}**${d.taskInfo ?? ""}`).join(", ")}`;
    const blocks = [header, ""];
    for (let index = 0; index < details.length; index++) {
        const detail = details[index];
        if (!detail)
            continue;
        const asyncIdLine = formatAsyncIdLine(detail);
        const resumeLine = formatResumeLine(detail);
        const pausedSupervisorActionLines = formatPausedSupervisorActionLines(detail);
        const sessionLine = formatSessionLine(detail);
        blocks.push(`${index + 1}. ${detail.agent}${detail.taskInfo ?? ""}`);
        if (asyncIdLine)
            blocks.push(asyncIdLine);
        if (pausedSupervisorActionLines.length > 0)
            blocks.push(...pausedSupervisorActionLines);
        else if (resumeLine)
            blocks.push(resumeLine);
        blocks.push(detail.resultPreview.trim() ? detail.resultPreview : "(no output)");
        if (sessionLine)
            blocks.push(sessionLine);
        blocks.push("");
    }
    return blocks.join("\n").trimEnd();
}
const NUDGE_TEXT = BACKGROUND_COMPLETION_NUDGE_TEXT;
function sendCompletion(pi, details, options = { triggerTurn: true }) {
    if (details.length === 0)
        return;
    const formatted = details.length === 1 ? formatSingleCompletion(details[0]) : formatGroupedCompletion(details);
    const content = truncateWithMarker(formatted, MAX_COMPLETION_MESSAGE_CHARS, "\n… [completion message truncated]");
    const structuredDetails = details.length === 1
        ? {
            ...details[0],
            resultPreview: boundedSummary(details[0].resultPreview),
            ...(details[0].sessionValue ? { sessionValue: boundedReference(details[0].sessionValue) } : {}),
            ...(details[0].awaitingSupervisor && details[0].resumeTarget
                ? {
                    resumeTarget: {
                        ...(details[0].resumeTarget.index !== undefined ? { index: details[0].resumeTarget.index } : {}),
                        ...(details[0].resumeTarget.childCount !== undefined
                            ? { childCount: details[0].resumeTarget.childCount }
                            : {}),
                    },
                }
                : {}),
        }
        : undefined;
    pi.sendMessage({
        customType: "subagent-notify",
        content,
        display: true,
        ...(structuredDetails ? { details: structuredDetails } : {}),
    });
    if (options.triggerTurn && (options.isIdle?.() ?? true)) {
        pi.sendUserMessage(NUDGE_TEXT, { deliverAs: "followUp" });
    }
}
function completionBatchKey(result) {
    const sessionId = typeof result.sessionId === "string" ? result.sessionId.trim() : "";
    if (sessionId)
        return `session:${sessionId}`;
    const cwd = typeof result.cwd === "string" ? result.cwd.trim() : "";
    return cwd ? `cwd:${cwd}` : "unknown";
}
function resolveCompletionStatus(result) {
    const children = Array.isArray(result.results) ? result.results : [];
    if (children.length > 0) {
        const statuses = children.map(resolveChildStatus);
        if (statuses.includes("failed"))
            return "failed";
        const outerStatus = resolveOuterStatus(result);
        if (outerStatus === "failed")
            return "failed";
        if (statuses.includes("paused") || outerStatus === "paused")
            return "paused";
        if (statuses.includes("completed"))
            return "completed";
        return "failed";
    }
    return resolveOuterStatus(result);
}
export function buildCompletionDetails(result) {
    const agent = boundedLabel(result.agent ?? "unknown");
    const status = resolveCompletionStatus(result);
    const taskInfo = result.taskIndex !== undefined && result.totalTasks !== undefined
        ? ` (${result.taskIndex + 1}/${result.totalTasks})`
        : undefined;
    const hasNormalizedChildResults = Array.isArray(result.results) && result.results.length > 0;
    const privacySafe = isProtectedPausedLifecycle({
        state: result.state,
        pause: result.pause,
    });
    const session = privacySafe
        ? undefined
        : result.shareUrl
            ? { label: "Session", value: result.shareUrl }
            : result.shareError
                ? { label: "Session share error", value: result.shareError }
                : !hasNormalizedChildResults && result.sessionFile
                    ? { label: "Session file", value: result.sessionFile }
                    : undefined;
    const asyncId = resolveAsyncIdentifier(result);
    const resumeTarget = resolveResumeTarget(result, asyncId);
    return {
        agent,
        status,
        ...(taskInfo ? { taskInfo } : {}),
        resultPreview: formatResultPreview(result),
        ...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
        ...(asyncId ? { asyncId } : {}),
        ...(resumeTarget ? { resumeTarget } : {}),
        ...(session ? { sessionLabel: session.label, sessionValue: session.value } : {}),
        ...(result.state === "paused" && result.pause?.kind === "awaiting_supervisor"
            ? { awaitingSupervisor: true }
            : {}),
    };
}
export default function registerSubagentNotify(pi, state, options = {}) {
    const unsubscribeStoreKey = "__pi_subagents_notify_unsubscribe__";
    const batcherStoreKey = "__pi_subagents_notify_batcher__";
    const globalStore = globalThis;
    const previousUnsubscribe = globalStore[unsubscribeStoreKey];
    if (typeof previousUnsubscribe === "function") {
        try {
            previousUnsubscribe();
        }
        catch {
        }
    }
    const previousBatcher = globalStore[batcherStoreKey];
    if (previousBatcher && typeof previousBatcher.dispose === "function") {
        try {
            previousBatcher.dispose();
        }
        catch {
        }
    }
    let sessionContext = null;
    const isIdle = () => sessionContext?.isIdle() ?? true;
    pi.on("session_start", (_event, ctx) => {
        sessionContext = ctx;
    });
    let suppressFlushNudge = false;
    const seen = getGlobalSeenMap("__pi_subagents_notify_seen__");
    const ttlMs = 10 * 60 * 1000;
    const nowFn = options.now ?? Date.now;
    const batchConfig = resolveCompletionBatchConfig(options.batchConfig);
    const batchers = new Map();
    let shuttingDownSessionId = null;
    globalStore[batcherStoreKey] = {
        dispose() {
            for (const entry of batchers.values())
                entry.batcher.dispose();
            batchers.clear();
        },
    };
    const handleComplete = (data) => {
        const result = data;
        if (typeof result.sessionId !== "string" || result.sessionId !== state.currentSessionId)
            return;
        const now = nowFn();
        const key = buildCompletionKey(result, "notify");
        if (markSeenWithTtl(seen, key, now, ttlMs))
            return;
        const details = buildCompletionDetails(result);
        const batchKey = completionBatchKey(result);
        let batcherEntry = batchers.get(batchKey);
        if (!batcherEntry) {
            const ownerSessionId = result.sessionId;
            const batcher = createCompletionBatcher({
                config: batchConfig,
                emit: (items) => {
                    const lifecycleFlush = shuttingDownSessionId === ownerSessionId;
                    if (state.currentSessionId !== ownerSessionId && !lifecycleFlush) {
                        batchers.delete(batchKey);
                        return;
                    }
                    sendCompletion(pi, items, { triggerTurn: !lifecycleFlush && !suppressFlushNudge, isIdle });
                },
                ...(options.timers ? { timers: options.timers } : {}),
                now: nowFn,
            });
            batcherEntry = { ownerSessionId, batcher };
            batchers.set(batchKey, batcherEntry);
        }
        if (details.status !== "completed") {
            suppressFlushNudge = true;
            try {
                batcherEntry.batcher.flush();
            }
            finally {
                suppressFlushNudge = false;
            }
            sendCompletion(pi, [details], { triggerTurn: true, isIdle });
            return;
        }
        batcherEntry.batcher.push(details);
    };
    pi.on("session_shutdown", () => {
        const ownerSessionId = state.currentSessionId;
        if (typeof ownerSessionId !== "string" || ownerSessionId.length === 0) {
            for (const entry of batchers.values())
                entry.batcher.dispose();
            batchers.clear();
            return;
        }
        shuttingDownSessionId = ownerSessionId;
        try {
            for (const [key, entry] of batchers) {
                if (entry.ownerSessionId !== ownerSessionId) {
                    entry.batcher.dispose();
                    batchers.delete(key);
                    continue;
                }
                entry.batcher.flush();
            }
        }
        finally {
            shuttingDownSessionId = null;
            for (const entry of batchers.values())
                entry.batcher.dispose();
            batchers.clear();
        }
    });
    globalStore[unsubscribeStoreKey] = pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete);
}

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, SUBAGENT_RESULT_INTERCOM_EVENT, } from "../shared/types.js";
export function resolveSubagentResultStatus(input) {
    if (input.detached)
        return "detached";
    if (input.interrupted || input.state === "paused")
        return "paused";
    if (typeof input.success === "boolean")
        return input.success ? "completed" : "failed";
    if (input.state === "complete")
        return "completed";
    if (input.state === "failed")
        return "failed";
    if (typeof input.exitCode === "number")
        return input.exitCode === 0 ? "completed" : "failed";
    return "failed";
}
function countStatuses(children) {
    const counts = {
        completed: 0,
        failed: 0,
        paused: 0,
        detached: 0,
    };
    for (const child of children) {
        counts[child.status] += 1;
    }
    return counts;
}
function formatStatusCounts(counts) {
    const parts = [
        counts.completed ? `${counts.completed} completed` : undefined,
        counts.failed ? `${counts.failed} failed` : undefined,
        counts.paused ? `${counts.paused} paused` : undefined,
        counts.detached ? `${counts.detached} detached` : undefined,
    ].filter((part) => Boolean(part));
    return parts.length ? parts.join(", ") : "0 results";
}
function resolveGroupedStatus(children) {
    const counts = countStatuses(children);
    if (counts.failed > 0)
        return "failed";
    if (counts.paused > 0)
        return "paused";
    if (counts.completed > 0)
        return "completed";
    if (counts.detached > 0)
        return "detached";
    return "failed";
}
function compactNestedRun(run, depth = 0) {
    return {
        id: run.id,
        parentRunId: run.parentRunId,
        ...(run.parentStepIndex !== undefined ? { parentStepIndex: run.parentStepIndex } : {}),
        ...(run.parentAgent ? { parentAgent: run.parentAgent } : {}),
        depth: run.depth,
        path: run.path.slice(0, 4).map((part) => ({
            runId: part.runId,
            ...(part.stepIndex !== undefined ? { stepIndex: part.stepIndex } : {}),
            ...(part.agent ? { agent: part.agent } : {}),
        })),
        ...(run.asyncDir ? { asyncDir: run.asyncDir } : {}),
        ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        ...(run.sessionFile ? { sessionFile: run.sessionFile } : {}),
        ...(run.intercomTarget ? { intercomTarget: run.intercomTarget } : {}),
        ...(run.ownerIntercomTarget ? { ownerIntercomTarget: run.ownerIntercomTarget } : {}),
        ...(run.leafIntercomTarget ? { leafIntercomTarget: run.leafIntercomTarget } : {}),
        ...(run.ownerState ? { ownerState: run.ownerState } : {}),
        ...(run.mode ? { mode: run.mode } : {}),
        state: run.state,
        ...(run.agent ? { agent: run.agent } : {}),
        ...(run.agents?.length ? { agents: run.agents.slice(0, 12) } : {}),
        ...(run.currentStep !== undefined ? { currentStep: run.currentStep } : {}),
        ...(run.chainStepCount !== undefined ? { chainStepCount: run.chainStepCount } : {}),
        ...(run.parallelGroups?.length ? { parallelGroups: run.parallelGroups.slice(0, 8) } : {}),
        ...(run.activityState ? { activityState: run.activityState } : {}),
        ...(run.lastActivityAt !== undefined ? { lastActivityAt: run.lastActivityAt } : {}),
        ...(run.currentTool ? { currentTool: run.currentTool } : {}),
        ...(run.currentToolStartedAt !== undefined ? { currentToolStartedAt: run.currentToolStartedAt } : {}),
        ...(run.currentPath ? { currentPath: run.currentPath } : {}),
        ...(run.turnCount !== undefined ? { turnCount: run.turnCount } : {}),
        ...(run.toolCount !== undefined ? { toolCount: run.toolCount } : {}),
        ...(run.totalTokens ? { totalTokens: run.totalTokens } : {}),
        ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
        ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
        ...(run.lastUpdate !== undefined ? { lastUpdate: run.lastUpdate } : {}),
        ...(run.error ? { error: run.error } : {}),
        ...(run.steps?.length
            ? {
                steps: run.steps.slice(0, 12).map((step) => ({
                    agent: step.agent,
                    status: step.status,
                    ...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
                    ...(step.activityState ? { activityState: step.activityState } : {}),
                    ...(step.lastActivityAt !== undefined ? { lastActivityAt: step.lastActivityAt } : {}),
                    ...(step.currentTool ? { currentTool: step.currentTool } : {}),
                    ...(step.currentToolStartedAt !== undefined ? { currentToolStartedAt: step.currentToolStartedAt } : {}),
                    ...(step.currentPath ? { currentPath: step.currentPath } : {}),
                    ...(step.turnCount !== undefined ? { turnCount: step.turnCount } : {}),
                    ...(step.toolCount !== undefined ? { toolCount: step.toolCount } : {}),
                    ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
                    ...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}),
                    ...(step.error ? { error: step.error } : {}),
                    ...(depth < 2 && step.children?.length
                        ? { children: step.children.slice(0, 8).map((child) => compactNestedRun(child, depth + 1)) }
                        : {}),
                })),
            }
            : {}),
        ...(depth < 2 && run.children?.length
            ? { children: run.children.slice(0, 8).map((child) => compactNestedRun(child, depth + 1)) }
            : {}),
    };
}
export function compactNestedResultChildren(children) {
    if (!children?.length)
        return undefined;
    return children.slice(0, 16).map((child) => compactNestedRun(child));
}
export function attachNestedChildrenToResultChildren(runId, children, nestedChildren) {
    const compact = compactNestedResultChildren(nestedChildren);
    if (!compact?.length)
        return children.map((child) => ({ ...child, children: compactNestedResultChildren(child.children) }));
    return children.map((child, index) => {
        const childIndex = child.index ?? index;
        const alreadyAttachedIds = new Set(child.children?.map((nested) => nested.id) ?? []);
        const attached = compact.filter((nested) => nested.parentRunId === runId && nested.parentStepIndex === childIndex && !alreadyAttachedIds.has(nested.id));
        const fallbackAttached = children.length === 1
            ? compact.filter((nested) => nested.parentRunId === runId &&
                nested.parentStepIndex === undefined &&
                !alreadyAttachedIds.has(nested.id))
            : [];
        const merged = compactNestedResultChildren([...(child.children ?? []), ...attached, ...fallbackAttached]);
        return merged?.length ? { ...child, children: merged } : { ...child, children: undefined };
    });
}
function formatNestedResultLines(children) {
    if (!children?.length)
        return [];
    const lines = ["Nested subagents:"];
    let remaining = 10;
    const append = (runs, indent) => {
        for (const run of runs ?? []) {
            if (remaining <= 0) {
                lines.push(`${indent}↳ +more nested runs; inspect status for full tree`);
                return;
            }
            remaining--;
            const label = run.agent ?? run.agents?.join("+") ?? run.id;
            lines.push(`${indent}↳ ${label} — ${run.state} [${run.id}]`);
            if (run.sessionFile)
                lines.push(`${indent}  Session: ${run.sessionFile}`);
            append(run.children, `${indent}  `);
            for (const step of run.steps ?? [])
                append(step.children, `${indent}    `);
        }
    };
    append(children, "");
    return lines;
}
const MAX_NATIVE_FOREGROUND_CHARS = 8_000;
const MAX_NATIVE_FOREGROUND_CHILDREN = 8;
const MAX_NATIVE_FOREGROUND_SUMMARY_CHARS = 1_200;
const MAX_NATIVE_FOREGROUND_LABEL_CHARS = 160;
const MAX_NATIVE_FOREGROUND_REFERENCE_CHARS = 500;
const MAX_NATIVE_FOREGROUND_ERROR_CHARS = 1_200;
const MAX_NATIVE_FOREGROUND_NESTED_ENTRIES = 8;
const MAX_NATIVE_FOREGROUND_NESTED_DEPTH = 2;
const NATIVE_FOREGROUND_TOTAL_TRUNCATION_MARKER = `… [foreground result truncated at ${MAX_NATIVE_FOREGROUND_CHARS.toString()} chars; inspect retained details, artifacts, or sessions for full output]`;
function truncateWithMarker(value, maxChars, marker) {
    if (value.length <= maxChars)
        return value;
    if (marker.length >= maxChars)
        return marker.slice(0, maxChars);
    return `${value.slice(0, maxChars - marker.length)}${marker}`;
}
function boundedNativeForegroundLabel(value) {
    return truncateWithMarker(value, MAX_NATIVE_FOREGROUND_LABEL_CHARS, "… [label truncated]");
}
function boundedNativeForegroundReference(value) {
    return truncateWithMarker(value, MAX_NATIVE_FOREGROUND_REFERENCE_CHARS, "… [reference truncated]");
}
function boundedNativeForegroundError(value) {
    return truncateWithMarker(value, MAX_NATIVE_FOREGROUND_ERROR_CHARS, "… [error truncated; inspect retained details for full text]");
}
function summarizeNativeForegroundOutput(child) {
    const marker = child.artifactPath || child.sessionPath
        ? "… [summary truncated; see references below for full output]"
        : "… [summary truncated; inspect retained details for full output]";
    return truncateWithMarker(child.summary.trim() || "(no output)", MAX_NATIVE_FOREGROUND_SUMMARY_CHARS, marker);
}
function prioritizedNativeForegroundChildren(children) {
    const statusPriority = new Map([
        ["failed", 0],
        ["paused", 1],
        ["completed", 2],
        ["detached", 3],
    ]);
    return children
        .map((child, index) => ({ child, originalIndex: child.index ?? index, inputOrder: index }))
        .sort((a, b) => {
        const priorityDelta = (b.child.nativeForegroundPriority ?? 0) - (a.child.nativeForegroundPriority ?? 0);
        if (priorityDelta !== 0)
            return priorityDelta;
        const statusDelta = (statusPriority.get(a.child.status) ?? 99) - (statusPriority.get(b.child.status) ?? 99);
        if (statusDelta !== 0)
            return statusDelta;
        return a.inputOrder - b.inputOrder;
    })
        .slice(0, MAX_NATIVE_FOREGROUND_CHILDREN)
        .map(({ child, originalIndex }) => ({ child, originalIndex }));
}
function formatNativeForegroundNestedLines(children) {
    if (!children?.length)
        return [];
    const lines = ["Nested subagents:"];
    let remaining = MAX_NATIVE_FOREGROUND_NESTED_ENTRIES;
    const append = (runs, indent, depth) => {
        if (!runs?.length)
            return;
        if (depth >= MAX_NATIVE_FOREGROUND_NESTED_DEPTH) {
            lines.push(`${indent}… [nested depth limit reached; inspect retained details for full tree]`);
            return;
        }
        for (const run of runs) {
            if (remaining <= 0) {
                lines.push(`${indent}… [additional nested entries omitted; inspect retained details for full tree]`);
                return;
            }
            remaining--;
            const label = boundedNativeForegroundLabel(run.agent ?? run.agents?.join("+") ?? run.id);
            const state = boundedNativeForegroundLabel(run.state);
            const runId = boundedNativeForegroundReference(run.id);
            lines.push(`${indent}↳ ${label} — ${state} [${runId}]`);
            if (run.sessionFile)
                lines.push(`${indent}  Session: ${boundedNativeForegroundReference(run.sessionFile)}`);
            append(run.children, `${indent}  `, depth + 1);
            for (const step of run.steps ?? [])
                append(step.children, `${indent}    `, depth + 1);
        }
    };
    append(children, "", 0);
    return lines;
}
function compactNativeForegroundSuffixText(value, maxChars) {
    const trimmed = value.trim();
    if (!trimmed || maxChars <= 0)
        return "";
    if (trimmed.length <= maxChars)
        return trimmed;
    const lines = trimmed
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0);
    const heading = boundedNativeForegroundLabel(lines[0] ?? "Additional details:");
    const fullPatchesLine = lines.find((line) => line.startsWith("Full patches:"));
    const boundedPatchesLine = fullPatchesLine
        ? `Full patches: ${boundedNativeForegroundReference(fullPatchesLine.slice("Full patches:".length).trim())}`
        : undefined;
    const marker = "… [suffix truncated; inspect retained details, artifacts, or sessions for full appended output]";
    const protectedLines = [
        heading,
        marker,
        ...(boundedPatchesLine && boundedPatchesLine !== heading ? [boundedPatchesLine] : []),
    ];
    const compact = protectedLines.join("\n");
    if (compact.length <= maxChars)
        return compact;
    if (!boundedPatchesLine)
        return truncateWithMarker(compact, maxChars, marker);
    const protectedTail = `${marker}\n${boundedPatchesLine}`;
    if (protectedTail.length <= maxChars)
        return protectedTail;
    return truncateWithMarker(boundedPatchesLine, maxChars, "… [reference truncated]");
}
function combineNativeForegroundBodyAndSuffix(body, suffixText) {
    const boundedBody = truncateWithMarker(body, MAX_NATIVE_FOREGROUND_CHARS, NATIVE_FOREGROUND_TOTAL_TRUNCATION_MARKER);
    const trimmedSuffix = suffixText?.trim();
    if (!trimmedSuffix)
        return boundedBody;
    if (boundedBody.length + 2 + trimmedSuffix.length <= MAX_NATIVE_FOREGROUND_CHARS)
        return `${boundedBody}\n\n${trimmedSuffix}`;
    const minimalSuffix = compactNativeForegroundSuffixText(trimmedSuffix, Math.max(0, Math.min(1_200, MAX_NATIVE_FOREGROUND_CHARS - 2)));
    if (!minimalSuffix)
        return boundedBody;
    const bodyBudget = Math.max(0, MAX_NATIVE_FOREGROUND_CHARS - 2 - minimalSuffix.length);
    const reboundedBody = truncateWithMarker(body, bodyBudget, NATIVE_FOREGROUND_TOTAL_TRUNCATION_MARKER);
    return `${reboundedBody}\n\n${minimalSuffix}`;
}
function formatForegroundNativeSubagentText(input) {
    const counts = countStatuses(input.children);
    const lines = [
        "subagent results",
        "",
        `Run: ${boundedNativeForegroundReference(input.runId)}`,
        `Mode: ${boundedNativeForegroundLabel(input.mode)}`,
        `Status: ${boundedNativeForegroundLabel(input.status)}`,
        `Children: ${formatStatusCounts(counts)}`,
    ];
    if (input.mode === "chain" && typeof input.chainSteps === "number")
        lines.push(`Chain steps: ${input.chainSteps}`);
    if (input.errorSummary)
        lines.push("", "Error:", boundedNativeForegroundError(input.errorSummary));
    const displayedChildren = prioritizedNativeForegroundChildren(input.children);
    if (input.children.length > displayedChildren.length) {
        lines.push("", `… [${input.children.length - displayedChildren.length} child results omitted; highest-priority results shown first, inspect retained details for the full set]`);
    }
    for (const { child, originalIndex } of displayedChildren) {
        const displayIndex = child.displayIndex ?? originalIndex + 1;
        const displayTotal = child.displayTotal ?? input.children.length;
        lines.push("");
        lines.push(`${displayIndex}/${displayTotal}. ${boundedNativeForegroundLabel(child.agent)} — ${boundedNativeForegroundLabel(child.status)}`);
        lines.push("Summary:");
        lines.push(summarizeNativeForegroundOutput(child));
        if (child.artifactPath)
            lines.push(`Output artifact: ${boundedNativeForegroundReference(child.artifactPath)}`);
        if (child.sessionPath)
            lines.push(`Session: ${boundedNativeForegroundReference(child.sessionPath)}`);
        lines.push(...formatNativeForegroundNestedLines(child.children));
    }
    return combineNativeForegroundBodyAndSuffix(lines.join("\n"), input.suffixText);
}
function asyncResumeGuidance(input) {
    if (input.source !== "async" || !input.asyncId)
        return undefined;
    const resumable = input.children.filter((child) => typeof child.sessionPath === "string" && fs.existsSync(child.sessionPath));
    if (input.children.length === 1 && resumable.length === 1) {
        return `Revive: subagent({ action: "resume", id: "${input.asyncId}", message: "..." })`;
    }
    if (resumable.length > 0) {
        const firstIndex = resumable[0]?.index ?? input.children.indexOf(resumable[0]);
        return `Revive child: subagent({ action: "resume", id: "${input.asyncId}", index: ${firstIndex}, message: "..." })`;
    }
    return "Resume: unavailable; no child session file was persisted.";
}
function formatGroupedSubagentResultMessage(input) {
    const counts = countStatuses(input.children);
    const lines = [
        "subagent results",
        "",
        `Run: ${input.runId}`,
        `Mode: ${input.mode}`,
        `Status: ${input.status}`,
        `Children: ${formatStatusCounts(counts)}`,
    ];
    if (input.mode === "chain" && typeof input.chainSteps === "number") {
        lines.push(`Chain steps: ${input.chainSteps}`);
    }
    if (input.errorSummary) {
        lines.push("", "Error:", input.errorSummary);
    }
    if (input.asyncId)
        lines.push(`Async id: ${input.asyncId}`);
    if (input.asyncDir)
        lines.push(`Async dir: ${input.asyncDir}`);
    const resumeGuidance = asyncResumeGuidance(input);
    if (resumeGuidance)
        lines.push(resumeGuidance);
    if (input.includeIntercomTargets && input.children.some((child) => child.intercomTarget)) {
        lines.push("");
        lines.push(input.source === "async"
            ? "Previous intercom targets below identify child sessions used while they were running. Inspect artifacts or session logs if resume is unavailable."
            : "Intercom targets below identify child sessions used while they were running; completed child sessions may no longer be reachable. Inspect artifacts or session logs for follow-up.");
    }
    for (let index = 0; index < input.children.length; index++) {
        const child = input.children[index];
        lines.push("");
        lines.push(`${index + 1}. ${child.agent} — ${child.status}`);
        if (input.includeIntercomTargets && child.intercomTarget)
            lines.push(`${input.source === "async" ? "Previous intercom target" : "Run intercom target"}: ${child.intercomTarget}`);
        if (child.artifactPath)
            lines.push(`Output artifact: ${child.artifactPath}`);
        if (child.sessionPath)
            lines.push(`Session: ${child.sessionPath}`);
        lines.push(...formatNestedResultLines(child.children));
        lines.push("Summary:");
        lines.push(child.summary);
    }
    return lines.join("\n");
}
export function buildSubagentResultIntercomPayload(input) {
    const children = input.children.map((child) => ({
        ...child,
        summary: child.summary.trim() || "(no output)",
        children: compactNestedResultChildren(child.children),
    }));
    const status = resolveGroupedStatus(children);
    const summary = formatStatusCounts(countStatuses(children));
    const firstChild = children[0];
    const payload = {
        to: input.to,
        runId: input.runId,
        mode: input.mode,
        status,
        summary,
        source: input.source,
        children,
        ...(input.asyncId ? { asyncId: input.asyncId } : {}),
        ...(input.asyncDir ? { asyncDir: input.asyncDir } : {}),
        ...(typeof input.chainSteps === "number" ? { chainSteps: input.chainSteps } : {}),
        ...(firstChild?.agent ? { agent: firstChild.agent } : {}),
        ...(firstChild?.index !== undefined ? { index: firstChild.index } : {}),
        ...(firstChild?.artifactPath ? { artifactPath: firstChild.artifactPath } : {}),
        ...(firstChild?.sessionPath ? { sessionPath: firstChild.sessionPath } : {}),
        message: "",
    };
    payload.message = formatGroupedSubagentResultMessage({ ...payload, includeIntercomTargets: true });
    return payload;
}
export function formatForegroundNativeSubagentResult(input) {
    const children = input.children.map((child) => ({
        ...child,
        summary: child.summary.trim() || "(no output)",
    }));
    const status = input.statusOverride ?? resolveGroupedStatus(children);
    const summary = formatStatusCounts(countStatuses(children));
    return {
        status,
        summary,
        text: formatForegroundNativeSubagentText({
            runId: input.runId,
            mode: input.mode,
            status,
            children,
            ...(typeof input.chainSteps === "number" ? { chainSteps: input.chainSteps } : {}),
            ...(input.errorSummary ? { errorSummary: input.errorSummary } : {}),
            ...(input.suffixText ? { suffixText: input.suffixText } : {}),
        }),
    };
}
export async function deliverSubagentResultIntercomEvent(events, payload, timeoutMs = 500) {
    return deliverSubagentIntercomMessageEvent(events, payload.to, payload.message, timeoutMs, payload);
}
export async function deliverSubagentIntercomMessageEvent(events, to, message, timeoutMs = 500, extra = {}) {
    if (typeof events.on !== "function" || typeof events.emit !== "function")
        return false;
    const requestId = typeof extra.requestId === "string" ? extra.requestId : randomUUID();
    return new Promise((resolve) => {
        const cleanupState = {};
        let settled = false;
        const finish = (delivered) => {
            if (settled)
                return;
            settled = true;
            if (cleanupState.timer)
                clearTimeout(cleanupState.timer);
            cleanupState.unsubscribe?.();
            resolve(delivered);
        };
        const unsubscribe = events.on(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, (data) => {
            if (!data || typeof data !== "object")
                return;
            const delivery = data;
            if (delivery.requestId !== requestId)
                return;
            finish(delivery.delivered === true);
        });
        cleanupState.unsubscribe = unsubscribe;
        const timer = setTimeout(() => finish(false), timeoutMs);
        cleanupState.timer = timer;
        try {
            events.emit(SUBAGENT_RESULT_INTERCOM_EVENT, { ...extra, to, message, requestId });
        }
        catch {
            finish(false);
        }
    });
}
function stripSingleResultOutputs(result) {
    return {
        ...result,
        messages: undefined,
        finalOutput: undefined,
        truncation: undefined,
    };
}
export function stripDetailsOutputsForIntercomReceipt(details) {
    return {
        ...details,
        results: details.results.map(stripSingleResultOutputs),
    };
}
export function formatSubagentResultReceipt(input) {
    const counts = countStatuses(input.payload.children);
    const modeLabel = input.mode === "single"
        ? "single subagent result"
        : input.mode === "parallel"
            ? "parallel subagent results"
            : "chain subagent results";
    const lines = [
        `Delivered ${modeLabel} via intercom.`,
        `Run: ${input.runId}`,
        `Children: ${formatStatusCounts(counts)}`,
    ];
    const artifacts = input.payload.children.filter((child) => typeof child.artifactPath === "string");
    if (artifacts.length > 0) {
        lines.push("Artifacts:");
        for (const child of artifacts) {
            lines.push(`- ${child.agent} [${child.status}]: ${child.artifactPath}`);
        }
    }
    const intercomTargets = input.payload.children.filter((child) => typeof child.intercomTarget === "string");
    if (intercomTargets.length > 0) {
        lines.push("Run intercom targets (may be inactive after completion):");
        for (const child of intercomTargets) {
            lines.push(`- ${child.agent} [${child.status}]: ${child.intercomTarget}`);
        }
    }
    const sessions = input.payload.children.filter((child) => typeof child.sessionPath === "string");
    if (sessions.length > 0) {
        lines.push("Sessions:");
        for (const child of sessions) {
            lines.push(`- ${child.agent} [${child.status}]: ${child.sessionPath}`);
        }
    }
    lines.push("Full grouped output was sent over intercom.");
    return lines.join("\n");
}

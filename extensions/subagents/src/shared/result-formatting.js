import { normalizeSubagentRunMode, } from "./types.js";
import { truncateWithMarker } from "./string-utils.js";
import { safeTerminalDocumentLeaf, safeTerminalText } from "./display-text.js";
export function resolveSubagentResultStatus(input) {
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
    return "failed";
}
const MAX_NATIVE_FOREGROUND_CHARS = 8_000;
const MAX_NATIVE_FOREGROUND_CHILDREN = 8;
const MAX_NATIVE_FOREGROUND_SUMMARY_CHARS = 1_200;
const MAX_NATIVE_FOREGROUND_LABEL_CHARS = 160;
const MAX_NATIVE_FOREGROUND_REFERENCE_CHARS = 500;
const MAX_NATIVE_FOREGROUND_ERROR_CHARS = 1_200;
function boundedNativeForegroundLabel(value) {
    return truncateWithMarker(safeTerminalText(value), MAX_NATIVE_FOREGROUND_LABEL_CHARS, "… [label truncated]");
}
function boundedNativeForegroundReference(value) {
    return truncateWithMarker(safeTerminalText(value), MAX_NATIVE_FOREGROUND_REFERENCE_CHARS, "… [reference truncated]");
}
function boundedNativeForegroundError(value) {
    return truncateWithMarker(safeTerminalText(value), MAX_NATIVE_FOREGROUND_ERROR_CHARS, "… [error truncated; full text is unavailable]");
}
function boundedNativeForegroundSummary(child, maxChars) {
    const raw = safeTerminalDocumentLeaf(child.summary).trim() || "(no output)";
    if (raw.length <= maxChars)
        return raw;
    const marker = child.artifactPath || child.sessionPath
        ? "… [summary truncated; see references below for full output]"
        : "… [summary truncated; full output is unavailable]";
    if (maxChars < marker.length)
        return "";
    return truncateWithMarker(raw, maxChars, marker);
}
function prioritizedNativeForegroundChildren(children) {
    const statusPriority = new Map([
        ["failed", 0],
        ["paused", 1],
        ["completed", 2],
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
function joinedLineCost(lines) {
    return lines.reduce((total, line) => total + line.length + 1, 0);
}
function resolveNativeForegroundPerChildSummaryBudget(count, fixedCost, ceiling) {
    const effectiveCount = Math.max(count, 1);
    const available = Math.max(ceiling - fixedCost, 0);
    return Math.min(MAX_NATIVE_FOREGROUND_SUMMARY_CHARS, Math.floor(available / effectiveCount));
}
function formatForegroundNativeSubagentText(input) {
    const counts = countStatuses(input.children);
    const outerLines = [
        "subagent results",
        "",
        `Run: ${boundedNativeForegroundReference(input.runId)}`,
        `Mode: ${boundedNativeForegroundLabel(input.mode)}`,
        `Status: ${boundedNativeForegroundLabel(input.status)}`,
        `Children: ${formatStatusCounts(counts)}`,
    ];
    if (input.errorSummary) {
        outerLines.push("", "Error:", boundedNativeForegroundError(input.errorSummary));
    }
    const displayedChildren = prioritizedNativeForegroundChildren(input.children);
    const priorityOmittedCount = input.children.length - displayedChildren.length;
    const priorityOmissionLine = priorityOmittedCount > 0
        ? `… [${priorityOmittedCount} child results omitted; highest-priority results shown first; full set is unavailable]`
        : null;
    const childFixedData = displayedChildren.map(({ child, originalIndex }) => {
        const displayIndex = child.displayIndex ?? originalIndex + 1;
        const displayTotal = child.displayTotal ?? input.children.length;
        const labelLine = `${displayIndex}/${displayTotal}. ${boundedNativeForegroundLabel(child.agent)} — ${boundedNativeForegroundLabel(child.status)}`;
        const refLines = [];
        if (child.artifactPath)
            refLines.push(`Output artifact: ${boundedNativeForegroundReference(child.artifactPath)}`);
        if (child.sessionPath)
            refLines.push(`Session: ${boundedNativeForegroundReference(child.sessionPath)}`);
        const fixedCost = joinedLineCost(["", labelLine, "Summary:", ...refLines]);
        return { child, originalIndex, labelLine, refLines, fixedCost };
    });
    const outerCost = joinedLineCost(outerLines) +
        (priorityOmissionLine ? joinedLineCost(["", priorityOmissionLine]) : 0);
    let effectiveCount = displayedChildren.length;
    while (effectiveCount > 0) {
        const partialFixedCost = childFixedData
            .slice(0, effectiveCount)
            .reduce((s, c) => s + c.fixedCost, 0);
        const budgetOmittedHere = displayedChildren.length - effectiveCount;
        const budgetOmissionCostHere = budgetOmittedHere > 0
            ? joinedLineCost([
                "",
                `… [${budgetOmittedHere} additional child results omitted; their output is not reachable from this envelope]`,
            ])
            : 0;
        if (outerCost + partialFixedCost + budgetOmissionCostHere <= MAX_NATIVE_FOREGROUND_CHARS)
            break;
        effectiveCount--;
    }
    const effectiveChildData = childFixedData.slice(0, effectiveCount);
    const budgetOmittedCount = displayedChildren.length - effectiveCount;
    const budgetOmissionLine = budgetOmittedCount > 0
        ? effectiveCount === 0
            ? `… [${budgetOmittedCount} child results omitted due to display size limit; full output is unavailable]`
            : `… [${budgetOmittedCount} additional child results omitted; their output is not reachable from this envelope]`
        : null;
    const totalFixedCost = outerCost +
        (budgetOmissionLine ? joinedLineCost(["", budgetOmissionLine]) : 0) +
        effectiveChildData.reduce((s, c) => s + c.fixedCost, 0);
    const perChildSummaryBudget = resolveNativeForegroundPerChildSummaryBudget(effectiveCount, totalFixedCost + effectiveCount, MAX_NATIVE_FOREGROUND_CHARS);
    const lines = [...outerLines];
    if (priorityOmissionLine)
        lines.push("", priorityOmissionLine);
    if (budgetOmissionLine)
        lines.push("", budgetOmissionLine);
    for (const { child, labelLine, refLines } of effectiveChildData) {
        lines.push("", labelLine);
        const summaryText = boundedNativeForegroundSummary(child, perChildSummaryBudget);
        if (summaryText)
            lines.push("Summary:", summaryText);
        lines.push(...refLines);
    }
    return lines.join("\n");
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
            mode: normalizeSubagentRunMode(input.mode),
            status,
            children,
            ...(input.errorSummary ? { errorSummary: input.errorSummary } : {}),
        }),
    };
}

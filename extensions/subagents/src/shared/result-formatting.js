import { normalizeSubagentRunMode, } from "./types.js";
import { truncateWithMarker } from "./string-utils.js";
import { safeTerminalDocumentLeaf, safeTerminalText } from "./display-text.js";
import { getSingleResultOutput } from "./utils.js";
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
        ...(run.ownerState ? { ownerState: run.ownerState } : {}),
        ...(run.mode ? { mode: run.mode } : {}),
        state: run.state,
        ...(run.agent ? { agent: run.agent } : {}),
        ...(run.agents?.length ? { agents: run.agents.slice(0, 12) } : {}),
        ...(run.currentStep !== undefined ? { currentStep: run.currentStep } : {}),
        ...(run.activityState ? { activityState: run.activityState } : {}),
        ...(run.lastActivityAt !== undefined ? { lastActivityAt: run.lastActivityAt } : {}),
        ...(run.currentTool ? { currentTool: run.currentTool } : {}),
        ...(run.currentToolStartedAt !== undefined
            ? { currentToolStartedAt: run.currentToolStartedAt }
            : {}),
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
                    ...(step.currentToolStartedAt !== undefined
                        ? { currentToolStartedAt: step.currentToolStartedAt }
                        : {}),
                    ...(step.currentPath ? { currentPath: step.currentPath } : {}),
                    ...(step.turnCount !== undefined ? { turnCount: step.turnCount } : {}),
                    ...(step.toolCount !== undefined ? { toolCount: step.toolCount } : {}),
                    ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
                    ...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}),
                    ...(step.error ? { error: step.error } : {}),
                    ...(depth < 2 && step.children?.length
                        ? {
                            children: step.children
                                .slice(0, 8)
                                .map((child) => compactNestedRun(child, depth + 1)),
                        }
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
        return children.map((child) => ({
            ...child,
            children: compactNestedResultChildren(child.children),
        }));
    return children.map((child, index) => {
        const childIndex = child.index ?? index;
        const alreadyAttachedIds = new Set(child.children?.map((nested) => nested.id) ?? []);
        const attached = compact.filter((nested) => nested.parentRunId === runId &&
            nested.parentStepIndex === childIndex &&
            !alreadyAttachedIds.has(nested.id));
        const fallbackAttached = children.length === 1
            ? compact.filter((nested) => nested.parentRunId === runId &&
                nested.parentStepIndex === undefined &&
                !alreadyAttachedIds.has(nested.id))
            : [];
        const merged = compactNestedResultChildren([
            ...(child.children ?? []),
            ...attached,
            ...fallbackAttached,
        ]);
        return merged?.length ? { ...child, children: merged } : { ...child, children: undefined };
    });
}
const MAX_NATIVE_AWAITED_CHARS = 8_000;
const MAX_NATIVE_AWAITED_CHILDREN = 8;
const MAX_NATIVE_AWAITED_SUMMARY_CHARS = 1_200;
const MAX_NATIVE_AWAITED_LABEL_CHARS = 160;
const MAX_NATIVE_AWAITED_REFERENCE_CHARS = 500;
const MAX_NATIVE_AWAITED_ERROR_CHARS = 1_200;
const MAX_NATIVE_AWAITED_NESTED_ENTRIES = 8;
const MAX_NATIVE_AWAITED_NESTED_DEPTH = 2;
function boundedNativeAwaitedLabel(value) {
    return truncateWithMarker(safeTerminalText(value), MAX_NATIVE_AWAITED_LABEL_CHARS, "… [label truncated]");
}
function boundedNativeAwaitedReference(value) {
    return truncateWithMarker(safeTerminalText(value), MAX_NATIVE_AWAITED_REFERENCE_CHARS, "… [reference truncated]");
}
function boundedNativeAwaitedError(value) {
    return truncateWithMarker(safeTerminalText(value), MAX_NATIVE_AWAITED_ERROR_CHARS, "… [error truncated; full text is unavailable]");
}
function compactTerminalFacts(result) {
    const attempts = result?.facts.attempts;
    if (!attempts?.length)
        return undefined;
    return `Facts: ${attempts
        .slice(0, 64)
        .map((attempt) => {
        const exit = attempt.exit.signal
            ? `signal=${safeTerminalText(attempt.exit.signal)}`
            : `exit=${attempt.exit.code === null ? "?" : attempt.exit.code}`;
        const tokens = attempt.providerTokens.status === "available"
            ? `tokens=${attempt.providerTokens.usage.total}`
            : "tokens=?";
        return `#${attempt.attempt} ${exit}, duration=${Math.round(attempt.durationMs)}ms, ${tokens}, tools=${attempt.requestedToolCalls.edit}/${attempt.requestedToolCalls.write}/${attempt.requestedToolCalls.bash}, workspace=${attempt.workspace.attribution}`;
    })
        .join("; ")}`;
}
function boundedNativeAwaitedSummary(child, maxChars) {
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
function prioritizedNativeAwaitedChildren(children) {
    const statusPriority = new Map([
        ["failed", 0],
        ["paused", 1],
        ["completed", 2],
    ]);
    return children
        .map((child, index) => ({ child, originalIndex: child.index ?? index, inputOrder: index }))
        .sort((a, b) => {
        const priorityDelta = (b.child.nativeAwaitedPriority ?? 0) - (a.child.nativeAwaitedPriority ?? 0);
        if (priorityDelta !== 0)
            return priorityDelta;
        const statusDelta = (statusPriority.get(a.child.status) ?? 99) - (statusPriority.get(b.child.status) ?? 99);
        if (statusDelta !== 0)
            return statusDelta;
        return a.inputOrder - b.inputOrder;
    })
        .slice(0, MAX_NATIVE_AWAITED_CHILDREN)
        .map(({ child, originalIndex }) => ({ child, originalIndex }));
}
function joinedLineCost(lines) {
    return lines.reduce((total, line) => total + line.length + 1, 0);
}
function resolveNativeAwaitedPerChildSummaryBudget(count, fixedCost, ceiling) {
    const effectiveCount = Math.max(count, 1);
    const available = Math.max(ceiling - fixedCost, 0);
    return Math.min(MAX_NATIVE_AWAITED_SUMMARY_CHARS, Math.floor(available / effectiveCount));
}
function formatNativeAwaitedNestedLines(children) {
    if (!children?.length)
        return [];
    const lines = ["Nested subagents:"];
    let remaining = MAX_NATIVE_AWAITED_NESTED_ENTRIES;
    const append = (runs, indent, depth) => {
        if (!runs?.length)
            return;
        if (depth >= MAX_NATIVE_AWAITED_NESTED_DEPTH) {
            lines.push(`${indent}… [nested depth limit reached; full tree is unavailable]`);
            return;
        }
        for (const run of runs) {
            if (remaining <= 0) {
                lines.push(`${indent}… [additional nested entries omitted; full tree is unavailable]`);
                return;
            }
            remaining--;
            const label = boundedNativeAwaitedLabel(run.agent ?? run.agents?.join("+") ?? run.id);
            const state = boundedNativeAwaitedLabel(run.state);
            const runId = boundedNativeAwaitedReference(run.id);
            lines.push(`${indent}↳ ${label} — ${state} [${runId}]`);
            if (run.sessionFile)
                lines.push(`${indent}  Session: ${boundedNativeAwaitedReference(run.sessionFile)}`);
            append(run.children, `${indent}  `, depth + 1);
            for (const step of run.steps ?? [])
                append(step.children, `${indent}    `, depth + 1);
        }
    };
    append(children, "", 0);
    return lines.length > 1 ? lines : [];
}
function formatAwaitedNativeSubagentText(input) {
    const counts = countStatuses(input.children);
    const outerLines = [
        "subagent results",
        "",
        `Run: ${boundedNativeAwaitedReference(input.runId)}`,
        `Mode: ${boundedNativeAwaitedLabel(input.mode)}`,
        `Status: ${boundedNativeAwaitedLabel(input.status)}`,
        `Children: ${formatStatusCounts(counts)}`,
    ];
    if (input.errorSummary) {
        outerLines.push("", "Error:", boundedNativeAwaitedError(input.errorSummary));
    }
    const displayedChildren = prioritizedNativeAwaitedChildren(input.children);
    const priorityOmittedCount = input.children.length - displayedChildren.length;
    const priorityOmissionLine = priorityOmittedCount > 0
        ? `… [${priorityOmittedCount} child results omitted; highest-priority results shown first; full set is unavailable]`
        : null;
    const childFixedData = displayedChildren.map(({ child, originalIndex }) => {
        const displayIndex = child.displayIndex ?? originalIndex + 1;
        const displayTotal = child.displayTotal ?? input.children.length;
        const labelLine = `${displayIndex}/${displayTotal}. ${boundedNativeAwaitedLabel(child.agent)} — ${boundedNativeAwaitedLabel(child.status)}`;
        const refLines = [];
        if (child.artifactPath)
            refLines.push(`Output artifact: ${boundedNativeAwaitedReference(child.artifactPath)}`);
        const factsLine = compactTerminalFacts(child.terminalResult);
        if (factsLine)
            refLines.push(factsLine);
        if (child.sessionPath)
            refLines.push(`Session: ${boundedNativeAwaitedReference(child.sessionPath)}`);
        const nestedLines = formatNativeAwaitedNestedLines(child.children);
        const fixedCost = joinedLineCost(["", labelLine, "Summary:", ...refLines, ...nestedLines]);
        return { child, originalIndex, labelLine, refLines, nestedLines, fixedCost };
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
        if (outerCost + partialFixedCost + budgetOmissionCostHere <= MAX_NATIVE_AWAITED_CHARS)
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
    const perChildSummaryBudget = resolveNativeAwaitedPerChildSummaryBudget(effectiveCount, totalFixedCost + effectiveCount, MAX_NATIVE_AWAITED_CHARS);
    const lines = [...outerLines];
    if (priorityOmissionLine)
        lines.push("", priorityOmissionLine);
    if (budgetOmissionLine)
        lines.push("", budgetOmissionLine);
    for (const { child, labelLine, refLines, nestedLines } of effectiveChildData) {
        lines.push("", labelLine);
        const summaryText = boundedNativeAwaitedSummary(child, perChildSummaryBudget);
        if (summaryText)
            lines.push("Summary:", summaryText);
        lines.push(...refLines, ...nestedLines);
    }
    return lines.join("\n");
}
export function formatAwaitedNativeSubagentResult(input) {
    const children = input.children.map((child) => ({
        ...child,
        summary: child.summary.trim() || "(no output)",
    }));
    const status = input.statusOverride ?? resolveGroupedStatus(children);
    const summary = formatStatusCounts(countStatuses(children));
    return {
        status,
        summary,
        text: formatAwaitedNativeSubagentText({
            runId: input.runId,
            mode: normalizeSubagentRunMode(input.mode),
            status,
            children,
            ...(input.errorSummary ? { errorSummary: input.errorSummary } : {}),
        }),
    };
}
const MAX_NATIVE_AWAITED_SAVE_ERROR_CHARS = 600;
function boundedNativeAwaitedSaveError(error) {
    const marker = "… [save error truncated; full diagnostic is unavailable]";
    if (error.length <= MAX_NATIVE_AWAITED_SAVE_ERROR_CHARS)
        return error;
    return `${error.slice(0, MAX_NATIVE_AWAITED_SAVE_ERROR_CHARS - marker.length)}${marker}`;
}
function splitFinalizeSingleOutputSaveErrorBlock(displayOutput, saveError) {
    const saveErrorSuffix = `\n${saveError}`;
    if (!displayOutput.endsWith(saveErrorSuffix))
        return { output: displayOutput };
    const prefix = "\n\nOutput file error: ";
    const withoutSaveError = displayOutput.slice(0, -saveErrorSuffix.length);
    const blockStart = withoutSaveError.lastIndexOf(prefix);
    if (blockStart === -1)
        return { output: displayOutput };
    const pathLine = withoutSaveError.slice(blockStart + prefix.length);
    if (pathLine.includes("\n"))
        return { output: displayOutput };
    return {
        output: displayOutput.slice(0, blockStart),
        header: `Output file error: ${pathLine}`,
    };
}
export function resultSummaryForNativeAwaited(result, displayOutput) {
    const hasSavedOutputReference = result.exitCode === 0 && Boolean(result.savedOutputPath && result.outputReference);
    const rawOutput = hasSavedOutputReference && result.outputMode === "file-only"
        ? getSingleResultOutput(result)
        : (displayOutput ?? result.truncation?.text) || getSingleResultOutput(result);
    const singleSaveError = result.outputSaveError
        ? splitFinalizeSingleOutputSaveErrorBlock(rawOutput, result.outputSaveError)
        : undefined;
    const output = singleSaveError?.output ?? rawOutput;
    const lines = [];
    if (result.outputSaveError) {
        lines.push(`${singleSaveError?.header ?? "Output file error:"}\n${boundedNativeAwaitedSaveError(result.outputSaveError)}`);
    }
    if (result.modelFallbackNotice)
        lines.push(`Notice: ${result.modelFallbackNotice}`);
    if (result.exitCode !== 0 && result.error) {
        const error = result.error.trim();
        const selected = output.trim();
        const summary = selected === error || selected.startsWith(`${error}\n`)
            ? selected
            : selected
                ? `${result.error}\n\nOutput:\n${output}`
                : result.error;
        lines.push(summary);
    }
    else {
        lines.push(output || result.error || "(no output)");
    }
    return lines.join("\n\n");
}
export function buildAwaitedNativeResult(input) {
    const visibleResults = input.details.results.map((result, index) => ({ result, index }));
    if (visibleResults.length === 0)
        return null;
    const children = visibleResults.map(({ result, index }, visibleIndex) => ({
        agent: result.agent,
        status: resolveSubagentResultStatus({
            exitCode: result.exitCode,
            interrupted: result.interrupted,
        }),
        summary: resultSummaryForNativeAwaited(result, input.displayOutputs?.[index]),
        index,
        displayIndex: visibleIndex + 1,
        displayTotal: visibleResults.length,
        artifactPath: result.artifactPaths?.outputPath,
        sessionPath: result.sessionFile,
        ...(result.terminalResult ? { terminalResult: result.terminalResult } : {}),
    }));
    const grouped = formatAwaitedNativeSubagentResult({
        runId: input.runId,
        mode: input.mode,
        children: attachNestedChildrenToResultChildren(input.runId, children, input.nestedChildren),
        ...(input.statusOverride ? { statusOverride: input.statusOverride } : {}),
        ...(input.errorSummary ? { errorSummary: input.errorSummary } : {}),
    });
    return {
        text: grouped.text,
        details: input.details,
    };
}

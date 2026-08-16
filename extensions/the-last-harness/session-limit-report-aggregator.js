import { basename, relative } from "node:path";
import { addUsage, createUsageTotals, normalizeUsage } from "./tokens-analyzer.js";
export function aggregateSessionUsage(window, sessionsRoot, parsedFiles, scanCaveats = []) {
    const caveats = [...scanCaveats];
    const providerTotalsMap = new Map();
    const grandTotals = createUsageTotals();
    const rows = [];
    for (const file of parsedFiles) {
        const row = aggregateFile(window, sessionsRoot, file, caveats);
        rows.push(row);
        for (const pt of row.providerTotals) {
            const existing = providerTotalsMap.get(pt.provider);
            if (existing) {
                addUsage(existing.usage, pt.usage);
            }
            else {
                providerTotalsMap.set(pt.provider, {
                    provider: pt.provider,
                    modelId: pt.modelId,
                    usage: { ...pt.usage },
                });
            }
        }
        addUsage(grandTotals, row.windowTotals);
    }
    rows.sort((a, b) => b.windowTotals.totalTokens - a.windowTotals.totalTokens);
    const perProviderTotals = [...providerTotalsMap.values()].sort((a, b) => b.usage.totalTokens - a.usage.totalTokens);
    return { rows, perProviderTotals, grandTotals, caveats };
}
function aggregateFile(window, sessionsRoot, file, caveats) {
    const { filePath, entries, malformedLineCount } = file;
    const fileKind = classifyFileKind(filePath, sessionsRoot);
    let sessionId;
    let sessionHeaderName;
    let sessionInfoName;
    let sessionCwd;
    let currentProvider = "unknown";
    let currentModelId;
    const providerUsageMap = new Map();
    const windowTotals = createUsageTotals();
    const coverage = { assistantMessages: 0, withUsage: 0, withoutUsage: 0 };
    for (const entry of entries) {
        if (entry.type === "session") {
            if (sessionId === undefined && typeof entry.id === "string") {
                sessionId = entry.id;
            }
            if (sessionHeaderName === undefined && typeof entry.name === "string") {
                sessionHeaderName = entry.name;
            }
            if (sessionCwd === undefined && typeof entry.cwd === "string" && entry.cwd.length > 0) {
                sessionCwd = entry.cwd;
            }
            continue;
        }
        if (entry.type === "session_info") {
            if (typeof entry.name === "string" && entry.name.length > 0) {
                sessionInfoName = entry.name;
            }
            if (sessionCwd === undefined && typeof entry.cwd === "string" && entry.cwd.length > 0) {
                sessionCwd = entry.cwd;
            }
            continue;
        }
        if (entry.type === "model_change") {
            if (typeof entry.provider === "string" && entry.provider.length > 0) {
                currentProvider = entry.provider;
            }
            currentModelId = typeof entry.modelId === "string" ? entry.modelId : undefined;
            continue;
        }
        if (entry.type !== "message") {
            continue;
        }
        const message = entry.message;
        if (!isRecord(message) || message.role !== "assistant") {
            continue;
        }
        const entryTs = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
        if (!Number.isFinite(entryTs) || entryTs < window.startMs || entryTs > window.endMs) {
            continue;
        }
        coverage.assistantMessages += 1;
        const usage = normalizeUsage(message.usage);
        if (usage) {
            coverage.withUsage += 1;
            const msgProvider = typeof message.provider === "string" && message.provider.length > 0
                ? message.provider
                : undefined;
            const msgModel = typeof message.model === "string" && message.model.length > 0
                ? message.model
                : undefined;
            const turnProvider = msgProvider ?? currentProvider;
            const turnModelId = msgModel ?? currentModelId;
            const existing = providerUsageMap.get(turnProvider);
            if (existing) {
                addUsage(existing.usage, usage, { turns: 1, assistantMessages: 1 });
                existing.modelId = turnModelId;
            }
            else {
                const providerTotals = createUsageTotals();
                addUsage(providerTotals, usage, { turns: 1, assistantMessages: 1 });
                providerUsageMap.set(turnProvider, {
                    provider: turnProvider,
                    modelId: turnModelId,
                    usage: providerTotals,
                });
            }
            addUsage(windowTotals, usage, { turns: 1, assistantMessages: 1 });
        }
        else {
            coverage.withoutUsage += 1;
            windowTotals.turns += 1;
            windowTotals.assistantMessages += 1;
        }
    }
    if (coverage.withoutUsage > 0) {
        caveats.push(`${basename(filePath)}: ${coverage.withoutUsage} of ${coverage.assistantMessages} in-window assistant message(s) had no usage data`);
    }
    if (malformedLineCount > 0) {
        caveats.push(`${basename(filePath)}: ${malformedLineCount} malformed line(s) skipped`);
    }
    const providerTotals = [...providerUsageMap.values()].sort((a, b) => b.usage.totalTokens - a.usage.totalTokens);
    const projectLabel = sessionCwd
        ? basename(sessionCwd)
        : deriveProjectLabel(filePath, sessionsRoot);
    const sessionName = sessionInfoName ?? sessionHeaderName;
    return {
        filePath,
        fileKind,
        projectLabel,
        sessionId,
        sessionName,
        providerTotals,
        windowTotals,
        coverage,
        malformedLineCount,
    };
}
function classifyFileKind(filePath, sessionsRoot) {
    const rel = relative(sessionsRoot, filePath);
    const parts = rel.split("/").filter((p) => p.length > 0);
    return parts.length <= 2 ? "primary" : "subagent-child";
}
function deriveProjectLabel(filePath, sessionsRoot) {
    const rel = relative(sessionsRoot, filePath);
    const parts = rel.split("/").filter((p) => p.length > 0);
    const projDir = parts[0] ?? "";
    return decodeProjectDirName(projDir);
}
export function decodeProjectDirName(dirName) {
    if (dirName.startsWith("--") && dirName.endsWith("--") && dirName.length > 4) {
        const inner = dirName.slice(2, -2);
        const segments = inner.split("-").filter((s) => s.length > 0);
        const lastSegment = segments[segments.length - 1];
        return lastSegment ?? dirName;
    }
    return dirName;
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

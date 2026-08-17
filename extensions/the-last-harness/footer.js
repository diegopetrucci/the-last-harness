import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { keyText, } from "@earendil-works/pi-coding-agent";
import { DUMB_ZONE_LABEL, DUMB_ZONE_THRESHOLD_TOKENS } from "./constants.js";
import { DEFAULT_PRIMARY_AGENT } from "../the-last-harness-primary-agent.mjs";
import { formatCompactTokenCount, formatHomePath, sanitizeStatusText } from "./common.js";
import { formatTlhInstallNoticeTrackLabel } from "./install-state.js";
import { TK_WORKFLOW_STATUS_KEY } from "./ticket-workflow-ui-constants.js";
import { composeTlhFooterFirstLine } from "./footer-first-line.js";
import { getTlhSubscriptionUsageFooterState, } from "./footer-subscription-usage.js";
import { getMcpToolKind, hasPersistedDirectMcpResultDetails } from "./mcp-tools.js";
export { formatTlhSubscriptionUsageFooterSegment } from "./footer-subscription-usage.js";
const CHARS_PER_TOKEN = 4;
const ESTIMATED_IMAGE_CHARS = 4800;
const MCP_STATUS_PREFIX = /^MCP:\s/i;
function formatCost(cost) {
    return cost < 0.001 ? "<$0.001" : `$${cost.toFixed(3)}`;
}
function getCurrentThinkingLevel(pi) {
    try {
        return pi.getThinkingLevel();
    }
    catch {
        return "off";
    }
}
function collectUsageTotals(ctx) {
    const totals = { cost: 0 };
    for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type !== "message" || entry.message.role !== "assistant") {
            continue;
        }
        const usage = entry.message.usage;
        if (!usage) {
            continue;
        }
        totals.cost += Number(usage.cost?.total) || 0;
    }
    return totals;
}
function safeJsonLength(value) {
    if (value == null) {
        return 0;
    }
    try {
        return JSON.stringify(value).length;
    }
    catch {
        return 0;
    }
}
function resultContentChars(content) {
    if (!Array.isArray(content)) {
        return 0;
    }
    let total = 0;
    for (const item of content) {
        if (!item || typeof item !== "object" || !("type" in item)) {
            continue;
        }
        if (item.type === "text" && "text" in item && typeof item.text === "string") {
            total += item.text.length;
        }
        else if (item.type === "image") {
            total += ESTIMATED_IMAGE_CHARS;
        }
    }
    return total;
}
function estimateTokensFromChars(charCount) {
    return charCount > 0 ? Math.ceil(charCount / CHARS_PER_TOKEN) : 0;
}
function estimateMcpDefinitionTokens(toolInfo) {
    return estimateTokensFromChars(safeJsonLength({
        name: toolInfo.name,
        description: toolInfo.description,
        parameters: toolInfo.parameters,
        promptGuidelines: toolInfo.promptGuidelines,
    }));
}
function buildMcpContextEstimateCacheKey(activeToolNames, ctx, contextTokens) {
    const leafId = ctx.sessionManager.getLeafId?.() ?? "";
    return `${leafId}::${contextTokens}::${activeToolNames.join("|")}`;
}
function getMcpContextEstimateSuffix(pi, ctx, contextUsage, cache) {
    const contextTokens = contextUsage?.tokens;
    if (typeof contextTokens !== "number" || !Number.isFinite(contextTokens) || contextTokens <= 0) {
        return { key: "no-context", suffix: undefined };
    }
    const activeToolNames = pi.getActiveTools();
    const cacheKey = buildMcpContextEstimateCacheKey(activeToolNames, ctx, contextTokens);
    if (cache?.key === cacheKey) {
        return cache;
    }
    const allTools = pi.getAllTools();
    const toolCatalogByName = new Map(allTools.map((toolInfo) => [toolInfo.name, toolInfo]));
    const knownDirectMcpToolNames = new Set();
    const activeMcpTools = activeToolNames
        .map((toolName) => toolCatalogByName.get(toolName))
        .filter((toolInfo) => Boolean(toolInfo?.name))
        .filter((toolInfo) => {
        const kind = getMcpToolKind(toolInfo.name, toolInfo);
        if (kind === "direct") {
            knownDirectMcpToolNames.add(toolInfo.name);
        }
        return kind !== undefined;
    });
    const pendingToolCallsById = new Map();
    let mcpTokens = activeMcpTools.reduce((sum, toolInfo) => sum + estimateMcpDefinitionTokens(toolInfo), 0);
    for (const entry of ctx.sessionManager.buildContextEntries()) {
        if (entry.type !== "message") {
            continue;
        }
        const message = entry.message;
        if (message.role === "assistant" && Array.isArray(message.content)) {
            for (const block of message.content) {
                if (block?.type !== "toolCall" || typeof block.name !== "string") {
                    continue;
                }
                const catalogKind = getMcpToolKind(block.name, toolCatalogByName.get(block.name));
                if (catalogKind === "direct") {
                    knownDirectMcpToolNames.add(block.name);
                }
                const kind = catalogKind ?? (knownDirectMcpToolNames.has(block.name) ? "direct" : undefined);
                const argumentTokens = estimateTokensFromChars(safeJsonLength(block.arguments));
                if (kind) {
                    mcpTokens += argumentTokens;
                    continue;
                }
                if (typeof block.id === "string") {
                    pendingToolCallsById.set(block.id, { toolName: block.name, tokens: argumentTokens });
                }
            }
            continue;
        }
        if (message.role === "toolResult" && typeof message.toolName === "string") {
            const pendingCall = typeof message.toolCallId === "string"
                ? pendingToolCallsById.get(message.toolCallId)
                : undefined;
            const hasPairedDirectResultProvenance = message.toolName !== "mcp" &&
                pendingCall?.toolName === message.toolName &&
                hasPersistedDirectMcpResultDetails(message.toolName, message.details);
            const kind = getMcpToolKind(message.toolName, toolCatalogByName.get(message.toolName)) ??
                (knownDirectMcpToolNames.has(message.toolName) || hasPairedDirectResultProvenance
                    ? "direct"
                    : undefined);
            if (!kind) {
                continue;
            }
            if (kind === "direct") {
                knownDirectMcpToolNames.add(message.toolName);
                if (pendingCall?.toolName === message.toolName && typeof message.toolCallId === "string") {
                    mcpTokens += pendingCall.tokens;
                    pendingToolCallsById.delete(message.toolCallId);
                }
            }
            mcpTokens += estimateTokensFromChars(resultContentChars(message.content));
        }
    }
    const rawPercent = (mcpTokens / contextTokens) * 100;
    const percent = Number.isFinite(rawPercent) ? Math.min(100, Math.max(0, rawPercent)) : 0;
    return {
        key: cacheKey,
        suffix: ` • (${percent.toFixed(1)}% of context)`,
    };
}
function appendMcpContextEstimate(statusText, suffix) {
    if (!suffix || !MCP_STATUS_PREFIX.test(statusText) || statusText.includes("% of context)")) {
        return statusText;
    }
    return `${statusText}${suffix}`;
}
export function formatReauthWarningLine(providers, width, theme) {
    if (providers.length === 0)
        return undefined;
    const fullText = `\u26a0 reauth: ${providers.join(", ")}`;
    const fullStyled = theme.fg("warning", fullText);
    if (visibleWidth(fullStyled) <= width)
        return fullStyled;
    const shortLabels = providers.map((p) => p.split("-").at(-1) ?? p);
    const shortText = `\u26a0 reauth: ${shortLabels.join(", ")}`;
    const shortStyled = theme.fg("warning", shortText);
    if (visibleWidth(shortStyled) <= width)
        return shortStyled;
    const countText = `\u26a0 reauth \u00d7${providers.length}`;
    const countStyled = theme.fg("warning", countText);
    return truncateToWidth(countStyled, width, theme.fg("warning", "..."));
}
export function createTlhFooter(pi, ctx, theme, getPrimaryName, footerData, usageOptions = {}, gitCache, installNotice, providerAuthHealth) {
    let mcpContextEstimateCache;
    return {
        render(width) {
            const model = ctx.model;
            const totals = collectUsageTotals(ctx);
            const contextUsage = ctx.getContextUsage();
            const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
            const contextPercentValue = contextUsage?.percent ?? 0;
            const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
            const pwd = composeTlhFooterFirstLine({
                cwd: formatHomePath(ctx.sessionManager.getCwd()),
                sessionName: ctx.sessionManager.getSessionName(),
                status: gitCache?.getStatusSnapshot(),
                pullRequest: gitCache?.getPullRequestSnapshot(),
                fallbackBranch: footerData?.getGitBranch?.(),
            });
            const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
            const modelOrNoModel = model?.id ?? "no-model";
            const modelPart = modelOrNoModel;
            const primaryName = getPrimaryName();
            const dimSep = theme.fg("dim", " • ");
            const nameSegment = primaryName === DEFAULT_PRIMARY_AGENT
                ? theme.fg("dim", primaryName)
                : theme.fg("accent", primaryName);
            let agentLine2Str = theme.fg("dim", "agent: ") + nameSegment + dimSep + theme.fg("dim", modelPart);
            if (model?.reasoning) {
                const thinkingLevel = getCurrentThinkingLevel(pi);
                agentLine2Str +=
                    dimSep + theme.fg("dim", thinkingLevel === "off" ? "thinking off" : thinkingLevel);
            }
            const contextPercentDisplay = contextPercent === "?"
                ? `?/${formatCompactTokenCount(contextWindow)}`
                : `${contextPercent}%/${formatCompactTokenCount(contextWindow)}`;
            let contextPercentStr;
            if (contextPercentValue > 90) {
                contextPercentStr = theme.fg("error", contextPercentDisplay);
            }
            else if (contextPercentValue > 70) {
                contextPercentStr = theme.fg("warning", contextPercentDisplay);
            }
            else {
                contextPercentStr = theme.fg("dim", contextPercentDisplay);
            }
            agentLine2Str += dimSep + contextPercentStr;
            if ((contextUsage?.tokens ?? 0) > DUMB_ZONE_THRESHOLD_TOKENS) {
                agentLine2Str += dimSep + theme.fg("error", DUMB_ZONE_LABEL);
            }
            const agentLine2 = truncateToWidth(agentLine2Str, width, theme.fg("dim", "..."));
            const subscriptionUsageState = getTlhSubscriptionUsageFooterState(ctx, model, usageOptions);
            const costStr = totals.cost > 0 && !subscriptionUsageState.suppressCost
                ? formatCost(totals.cost)
                : undefined;
            const line3Parts = [];
            if (costStr)
                line3Parts.push(costStr);
            if (subscriptionUsageState.segment)
                line3Parts.push(subscriptionUsageState.segment);
            const line3 = line3Parts.length > 0 ? line3Parts.join(" · ") : undefined;
            const lines = [pwdLine, agentLine2];
            if (providerAuthHealth) {
                const reauthProviders = providerAuthHealth.getReauthProviders();
                const warningLine = formatReauthWarningLine(reauthProviders, width, theme);
                if (warningLine !== undefined)
                    lines.push(warningLine);
            }
            const extensionStatuses = footerData?.getExtensionStatuses?.();
            const hasMcpStatus = extensionStatuses
                ? Array.from(extensionStatuses.values()).some((status) => MCP_STATUS_PREFIX.test(sanitizeStatusText(status)))
                : false;
            if (hasMcpStatus) {
                mcpContextEstimateCache = getMcpContextEstimateSuffix(pi, ctx, contextUsage, mcpContextEstimateCache);
            }
            const tkWorkflowStatus = extensionStatuses?.get(TK_WORKFLOW_STATUS_KEY);
            if (tkWorkflowStatus) {
                const tkWorkflowLines = tkWorkflowStatus
                    .split(/\r?\n/)
                    .map((line) => sanitizeStatusText(line))
                    .filter(Boolean);
                for (const line of tkWorkflowLines) {
                    lines.push(truncateToWidth(theme.fg("dim", line), width, theme.fg("dim", "...")));
                }
            }
            if (line3 !== undefined) {
                lines.push(truncateToWidth(theme.fg("dim", line3), width, theme.fg("dim", "...")));
            }
            const editorText = ctx.ui.getEditorText();
            if (editorText.length > 0 && !ctx.isIdle()) {
                const steerKey = keyText("tui.input.submit") || "enter";
                const queueKey = keyText("app.message.followUp") || "alt+enter";
                const steeringHint = `${theme.fg("dim", steerKey)}${theme.fg("muted", " steer")}`;
                const queueHint = `${theme.fg("dim", queueKey)}${theme.fg("muted", " queue follow-up")}`;
                lines.push(truncateToWidth(`${steeringHint}${theme.fg("muted", " · ")}${queueHint}`, width, theme.fg("dim", "...")));
            }
            if (extensionStatuses && extensionStatuses.size > 0) {
                const visibleStatuses = Array.from(extensionStatuses.entries())
                    .filter(([key]) => key !== TK_WORKFLOW_STATUS_KEY)
                    .sort(([a], [b]) => a.localeCompare(b));
                const statusLine = visibleStatuses
                    .map(([, text]) => appendMcpContextEstimate(sanitizeStatusText(text), mcpContextEstimateCache?.suffix))
                    .filter(Boolean)
                    .join(" ");
                if (statusLine) {
                    lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
                }
            }
            if (installNotice) {
                const label = formatTlhInstallNoticeTrackLabel(installNotice);
                const warningStr = `${theme.fg("dim", "TLH ")}${theme.fg("warning", label)}`;
                lines.push(truncateToWidth(warningStr, width, theme.fg("dim", "...")));
            }
            return lines;
        },
        invalidate() { },
        dispose() {
            gitCache?.dispose();
        },
    };
}

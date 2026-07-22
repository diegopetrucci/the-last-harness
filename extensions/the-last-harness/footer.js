import { truncateToWidth } from "@earendil-works/pi-tui";
import { keyText, } from "@earendil-works/pi-coding-agent";
import { DUMB_ZONE_LABEL, DUMB_ZONE_THRESHOLD_TOKENS } from "./constants.js";
import { DEFAULT_PRIMARY_AGENT } from "../the-last-harness-primary-agent.mjs";
import { formatCompactTokenCount, formatHomePath, sanitizeStatusText } from "./common.js";
import { formatTlhInstallNoticeTrackLabel } from "./install-state.js";
import { TK_WORKFLOW_STATUS_KEY } from "./ticket-workflow-ui-constants.js";
import { composeTlhFooterFirstLine } from "./footer-first-line.js";
import { getTlhSubscriptionUsageFooterState, } from "./footer-subscription-usage.js";
export { formatTlhSubscriptionUsageFooterSegment } from "./footer-subscription-usage.js";
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
export function createTlhFooter(pi, ctx, theme, getPrimaryName, footerData, usageOptions = {}, gitCache, installNotice) {
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
                agentLine2Str += dimSep + theme.fg("dim", thinkingLevel === "off" ? "thinking off" : thinkingLevel);
            }
            const contextPercentDisplay = contextPercent === "?" ? `?/${formatCompactTokenCount(contextWindow)}` : `${contextPercent}%/${formatCompactTokenCount(contextWindow)}`;
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
            const costStr = totals.cost > 0 && !subscriptionUsageState.suppressCost ? formatCost(totals.cost) : undefined;
            const line3Parts = [];
            if (costStr)
                line3Parts.push(costStr);
            if (subscriptionUsageState.segment)
                line3Parts.push(subscriptionUsageState.segment);
            const line3 = line3Parts.length > 0 ? line3Parts.join(" · ") : undefined;
            const lines = [pwdLine, agentLine2];
            const extensionStatuses = footerData?.getExtensionStatuses?.();
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
                    .map(([, text]) => sanitizeStatusText(text))
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

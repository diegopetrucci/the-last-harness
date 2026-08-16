import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { TLH_HEADER_TOGGLE_SHORTCUT_LABEL, TLH_NAME } from "./constants.js";
import { formatTlhInstallNoticeTrackLabel } from "./install-state.js";
function formatLaunchContextPercent(tokens, contextWindow) {
    if (!Number.isFinite(tokens) ||
        tokens <= 0 ||
        !Number.isFinite(contextWindow) ||
        contextWindow <= 0) {
        return "0%";
    }
    const percent = (tokens / contextWindow) * 100;
    if (percent < 1) {
        return "<1%";
    }
    return `~${Math.round(percent)}%`;
}
export function formatTlhLaunchContextAllocation(allocation) {
    const { contextWindow, estimatedTokens } = allocation;
    const segments = [
        `Context at launch: TLH ${formatLaunchContextPercent(estimatedTokens.tlh, contextWindow)}`,
        `AGENTS/CLAUDE.md ${formatLaunchContextPercent(estimatedTokens.agentsClaude, contextWindow)}`,
        `Skills ${formatLaunchContextPercent(estimatedTokens.skills, contextWindow)}`,
    ];
    if (estimatedTokens.mcp > 0) {
        segments.push(`MCP ${formatLaunchContextPercent(estimatedTokens.mcp, contextWindow)}`);
    }
    segments.push(`Tools ${formatLaunchContextPercent(estimatedTokens.tools, contextWindow)}`, `Other ${formatLaunchContextPercent(estimatedTokens.other, contextWindow)}`);
    return segments.join(" • ");
}
export function createTlhHeader(theme, resources, headerUpdate, installNotice, options = {}) {
    let expanded = false;
    let startupResources = resources;
    let launchContextAllocation = options.launchContextAllocation;
    const color = {
        heading: (text) => theme.fg("mdHeading", text),
        dim: (text) => theme.fg("dim", text),
        muted: (text) => theme.fg("muted", text),
        accent: (text) => theme.fg("accent", text),
        warning: (text) => theme.fg("warning", text),
    };
    const logo = headerUpdate
        ? `${theme.bold(color.accent(TLH_NAME))}${color.dim(` v${headerUpdate.version}`)} ${color.accent(headerUpdate.releasesUrl)}`
        : theme.bold(color.accent(TLH_NAME));
    const section = (name, items, width) => {
        if (items.length === 0) {
            return [];
        }
        const heading = truncateToWidth(color.heading(`[${name}]`), width, color.dim("..."));
        const prefix = "  ";
        const wrappedLines = [];
        let currentLine = prefix;
        for (const item of items) {
            const isFirstOnLine = currentLine === prefix;
            const candidate = isFirstOnLine ? prefix + item : currentLine + ", " + item;
            if (isFirstOnLine || visibleWidth(candidate) <= width - 2) {
                currentLine = candidate;
            }
            else {
                if (visibleWidth(currentLine + ", ") > width) {
                    wrappedLines.push(color.dim(currentLine));
                }
                else {
                    wrappedLines.push(color.dim(currentLine + ", "));
                }
                currentLine = prefix + item;
            }
        }
        wrappedLines.push(color.dim(currentLine));
        return [heading, ...wrappedLines];
    };
    const installWarningLine = (width) => {
        if (!installNotice) {
            return [];
        }
        const label = formatTlhInstallNoticeTrackLabel(installNotice);
        const warningLine = `${color.warning("Warning")}${color.dim(`: running TLH from ${label} track`)}`;
        return [truncateToWidth(warningLine, width, color.dim("..."))];
    };
    const contextLine = (items, width) => {
        if (items.length === 0) {
            return [];
        }
        return [truncateToWidth(color.dim(`Context: ${items.join(", ")}`), width, color.dim("..."))];
    };
    const startupTipLine = (width) => {
        if (!options.startupTip) {
            return [];
        }
        if (width <= 0) {
            return [""];
        }
        const label = "Tip";
        const separator = ": ";
        const prefixWidth = visibleWidth(`${label}${separator}`);
        const fullTip = `${color.muted(label)}${color.dim(`${separator}${options.startupTip}`)}`;
        if (width <= prefixWidth) {
            return wrapTextWithAnsi(fullTip, width);
        }
        const bodyWidth = width - prefixWidth;
        const continuationIndent = " ".repeat(prefixWidth);
        return wrapTextWithAnsi(options.startupTip, bodyWidth).map((line, index) => index === 0
            ? `${color.muted(label)}${color.dim(`${separator}${line}`)}`
            : color.dim(`${continuationIndent}${line}`));
    };
    const launchContextLines = (width) => {
        if (!launchContextAllocation) {
            return [];
        }
        if (width <= 0) {
            return [""];
        }
        return wrapTextWithAnsi(formatTlhLaunchContextAllocation(launchContextAllocation), width).map((line) => color.dim(line));
    };
    const collapsedContextHintLines = (width) => {
        const hint = `Press ${TLH_HEADER_TOGGLE_SHORTCUT_LABEL} to show loaded context files, skills, prompts, and extensions`;
        return wrapTextWithAnsi(hint, width).map((line) => color.dim(line));
    };
    const headerDetails = (width) => [
        ...installWarningLine(width),
        ...launchContextLines(width),
        ...contextLine(startupResources.context, width),
    ];
    const renderCollapsed = (width) => {
        const lines = [
            logo,
            "",
            ...installWarningLine(width),
            ...launchContextLines(width),
            ...collapsedContextHintLines(width),
            ...startupTipLine(width),
        ];
        return lines;
    };
    const renderExpanded = (width) => {
        const lines = [logo];
        const details = headerDetails(width);
        if (details.length > 0) {
            lines.push("", ...details);
        }
        const resourceSections = [
            section("Skills", startupResources.skills, width),
            section("Prompts", startupResources.prompts, width),
            section("Extensions", startupResources.extensions, width),
            section("Themes", startupResources.themes, width),
        ].filter((resourceSection) => resourceSection.length > 0);
        for (const resourceSection of resourceSections) {
            lines.push("", ...resourceSection);
        }
        const startupTip = startupTipLine(width);
        if (startupTip.length > 0) {
            lines.push("", ...startupTip);
        }
        return lines;
    };
    return {
        render(width) {
            return expanded ? renderExpanded(width) : renderCollapsed(width);
        },
        setExpanded(nextExpanded) {
            expanded = nextExpanded;
        },
        setResources(nextResources) {
            startupResources = nextResources;
        },
        setLaunchContextAllocation(nextAllocation) {
            launchContextAllocation = nextAllocation;
        },
        toggleExpanded() {
            expanded = !expanded;
            options.requestRender?.();
        },
        invalidate() { },
    };
}

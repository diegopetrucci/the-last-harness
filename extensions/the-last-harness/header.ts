import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { TLH_NAME } from "./constants.js";
import type { StartupResources, TlhHeaderUpdate, TlhLaunchContextAllocation } from "./types.js";

function formatLaunchContextPercent(tokens: number, contextWindow: number): string {
  if (
    !Number.isFinite(tokens) ||
    tokens <= 0 ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return "0%";
  }
  const percent = (tokens / contextWindow) * 100;
  if (percent < 1) {
    return "<1%";
  }
  return `~${Math.round(percent)}%`;
}

export function formatTlhLaunchContextAllocation(allocation: TlhLaunchContextAllocation): string {
  const { contextWindow, estimatedTokens } = allocation;
  const segments = [
    `Context at launch: TLH ${formatLaunchContextPercent(estimatedTokens.tlh, contextWindow)}`,
    `AGENTS/CLAUDE.md ${formatLaunchContextPercent(estimatedTokens.agentsClaude, contextWindow)}`,
    `Skills ${formatLaunchContextPercent(estimatedTokens.skills, contextWindow)}`,
  ];
  if (estimatedTokens.mcp > 0) {
    segments.push(`MCP ${formatLaunchContextPercent(estimatedTokens.mcp, contextWindow)}`);
  }
  segments.push(
    `Tools ${formatLaunchContextPercent(estimatedTokens.tools, contextWindow)}`,
    `Other ${formatLaunchContextPercent(estimatedTokens.other, contextWindow)}`,
  );
  return segments.join(" • ") + " (run /context to see a breakdown)";
}

export function createTlhHeader(
  theme: Theme,
  resources: StartupResources,
  headerUpdate: TlhHeaderUpdate | undefined,
  options: {
    requestRender?: () => void;
    startupTip?: string;
    launchContextAllocation?: TlhLaunchContextAllocation;
  } = {},
) {
  let expanded = false;
  let startupResources = resources;
  let launchContextAllocation = options.launchContextAllocation;
  const color = {
    heading: (text: string) => theme.fg("mdHeading", text),
    dim: (text: string) => theme.fg("dim", text),
    muted: (text: string) => theme.fg("muted", text),
    accent: (text: string) => theme.fg("accent", text),
  };

  const logo = headerUpdate
    ? `${theme.bold(color.accent(TLH_NAME))}${color.dim(` v${headerUpdate.version}`)} ${color.accent(headerUpdate.releasesUrl)}`
    : theme.bold(color.accent(TLH_NAME));

  const section = (name: string, items: string[], width: number): string[] => {
    if (items.length === 0) {
      return [];
    }
    const heading = truncateToWidth(color.heading(`[${name}]`), width, color.dim("..."));

    // Wrap items across multiple lines, splitting on ", " boundaries (never mid-item).
    const prefix = "  ";
    const wrappedLines: string[] = [];
    let currentLine = prefix;

    for (const item of items) {
      const isFirstOnLine = currentLine === prefix;
      const candidate = isFirstOnLine ? prefix + item : currentLine + ", " + item;

      if (isFirstOnLine || visibleWidth(candidate) <= width - 2) {
        currentLine = candidate;
      } else {
        // Non-final line: append ", " separator if it fits, otherwise push bare.
        // The isFirstOnLine force-accept can leave currentLine near or at `width`,
        // so appending ", " would overflow the terminal width.
        if (visibleWidth(currentLine + ", ") > width) {
          wrappedLines.push(color.dim(currentLine));
        } else {
          wrappedLines.push(color.dim(currentLine + ", "));
        }
        currentLine = prefix + item;
      }
    }
    // Final line: no trailing ", ".
    wrappedLines.push(color.dim(currentLine));

    return [heading, ...wrappedLines];
  };

  const contextLine = (items: string[], width: number): string[] => {
    if (items.length === 0) {
      return [];
    }
    return [truncateToWidth(color.dim(`Context: ${items.join(", ")}`), width, color.dim("..."))];
  };

  const startupTipLine = (width: number): string[] => {
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
    return wrapTextWithAnsi(options.startupTip, bodyWidth).map((line, index) =>
      index === 0
        ? `${color.muted(label)}${color.dim(`${separator}${line}`)}`
        : color.dim(`${continuationIndent}${line}`),
    );
  };

  const launchContextLines = (width: number): string[] => {
    if (!launchContextAllocation) {
      return [];
    }
    if (width <= 0) {
      return [""];
    }
    return wrapTextWithAnsi(formatTlhLaunchContextAllocation(launchContextAllocation), width).map(
      (line) => color.dim(line),
    );
  };

  const headerDetails = (width: number): string[] => [
    ...launchContextLines(width),
    ...contextLine(startupResources.context, width),
  ];

  const renderCollapsed = (width: number) => {
    const lines = [logo];
    const details = [...launchContextLines(width)];
    if (details.length > 0) {
      lines.push("", ...details);
    }
    const startupTip = startupTipLine(width);
    if (startupTip.length > 0) {
      lines.push("", ...startupTip);
    }
    return lines;
  };

  const renderExpanded = (width: number) => {
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
      section("Project guidance", startupResources.projectGuidance ?? [], width),
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
    render(width: number): string[] {
      return expanded ? renderExpanded(width) : renderCollapsed(width);
    },
    setExpanded(nextExpanded: boolean) {
      expanded = nextExpanded;
    },
    setResources(nextResources: StartupResources) {
      startupResources = nextResources;
    },
    setLaunchContextAllocation(nextAllocation: TlhLaunchContextAllocation | undefined) {
      launchContextAllocation = nextAllocation;
    },
    toggleExpanded() {
      expanded = !expanded;
      options.requestRender?.();
    },
    invalidate() {},
  };
}

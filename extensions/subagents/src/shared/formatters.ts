/**
 * Formatting utilities for display output
 */

import type { Usage } from "./types.ts";
import { splitKnownThinkingSuffix, THINKING_LEVELS } from "./model-info.ts";

/**
 * Format token count with k suffix for large numbers
 */
export function formatTokens(n: number): string {
  return n < 1000
    ? String(n)
    : n < 10000
      ? `${(n / 1000).toFixed(1)}k`
      : `${Math.round(n / 1000)}k`;
}

export function formatModelThinking(model?: string, thinking?: string): string {
  const parsed = model ? splitKnownThinkingSuffix(model) : undefined;
  let displayModel = parsed?.baseModel ?? model;
  const explicitThinking = THINKING_LEVELS.find((level) => level === thinking?.trim());
  const displayThinking = parsed?.thinkingSuffix
    ? parsed.thinkingSuffix.slice(1)
    : explicitThinking;
  if (displayModel) {
    const slashIdx = displayModel.lastIndexOf("/");
    if (slashIdx !== -1) displayModel = displayModel.slice(slashIdx + 1);
  }
  return [displayModel, displayThinking ? `thinking ${displayThinking}` : undefined]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Format usage statistics into a compact string
 */
export function formatUsage(u: Usage, model?: string): string {
  const parts: string[] = [];
  if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
  if (u.input) parts.push(`in:${formatTokens(u.input)}`);
  if (u.output) parts.push(`out:${formatTokens(u.output)}`);
  if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
  if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
  if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

/**
 * Format duration in human-readable form
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

/**
 * Format a tool call for display.
 *
 * Keep argument values complete here. Renderers own width fitting and must
 * wrap these strings instead of losing command, path, or payload text.
 */
export function formatToolCall(
  name: string,
  args: Record<string, unknown>,
  _expanded = false,
): string {
  switch (name) {
    case "bash": {
      const command = typeof args.command === "string" ? args.command : "";
      return `$ ${command}`;
    }
    case "read":
    case "write":
    case "edit": {
      const target =
        typeof args.path === "string"
          ? args.path
          : typeof args.file_path === "string"
            ? args.file_path
            : "";
      return `${name} ${shortenPath(target)}`;
    }
    default: {
      const serialized = JSON.stringify(args);
      return `${name} ${serialized ?? ""}`;
    }
  }
}

/**
 * Shorten a path by replacing home directory with ~
 */
export function shortenPath(p: string): string {
  const home = process.env.HOME;
  if (home && p.startsWith(home)) {
    return `~${p.slice(home.length)}`;
  }
  return p;
}

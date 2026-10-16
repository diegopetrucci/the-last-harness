/**
 * Shared MCP tool identity module.
 *
 * The /mcp/i check applies only to scheme-prefixed package identifiers (`npm:`
 * or `git:`). Pi sets sourceInfo.source to an absolute filesystem path for
 * locally-loaded packages, and a bare path such as
 * "/work/mcp-experiments/tools" carries no reliable MCP evidence.
 */

import type { ToolInfo } from "@earendil-works/pi-coding-agent";

/**
 * Returns true when a tool-result `details` payload carries the server/tool
 * fields that the Pi MCP adapter persists for direct MCP tool results, and the
 * names match the expected `toolName` naming conventions.
 *
 * This is used as a heuristic to recover MCP provenance for direct tool calls
 * that were not in the live catalog at scan time.
 */
export function hasPersistedDirectMcpResultDetails(toolName: string, details: unknown): boolean {
  if (!details || typeof details !== "object") {
    return false;
  }
  const candidate = details as { server?: unknown; tool?: unknown };
  if (
    typeof candidate.server !== "string" ||
    candidate.server.length === 0 ||
    typeof candidate.tool !== "string" ||
    candidate.tool.length === 0
  ) {
    return false;
  }
  const serverPrefix = candidate.server.replaceAll("-", "_");
  const shortPrefix = candidate.server.replace(/-?mcp$/i, "").replaceAll("-", "_") || "mcp";
  return new Set([
    candidate.tool,
    `${serverPrefix}_${candidate.tool}`,
    `${shortPrefix}_${candidate.tool}`,
  ]).has(toolName);
}

/**
 * Classifies a tool as an MCP proxy, a direct MCP tool, or non-MCP.
 *
 * Returns "proxy" when the tool name is "mcp", "direct" when sourceInfo.source
 * matches /^(npm|git):/ and /mcp/i, and undefined otherwise.
 */
export function getMcpToolKind(
  toolName: string,
  toolInfo?: Pick<ToolInfo, "sourceInfo">,
): "proxy" | "direct" | undefined {
  if (toolName === "mcp") {
    return "proxy";
  }
  const source = toolInfo?.sourceInfo?.source;
  if (typeof source === "string" && /^(npm|git):/.test(source) && /mcp/i.test(source)) {
    return "direct";
  }
  return undefined;
}

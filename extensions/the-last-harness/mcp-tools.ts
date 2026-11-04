/**
 * Shared native MCP / codemode tool identity module.
 *
 * Pi 1.5.0 ships MCP and codemode as built-in extensions (dist/extensions/index.js), so their
 * tools carry `sourceInfo.path` of `builtin:mcp` / `builtin:codemode` (dist/core/source-info.js,
 * BUILTIN_PATH_PREFIX). MCP server tools are named `mcp__<server>__<tool>`
 * (dist/extensions/mcp/tools.js) and the resource tools `list_mcp_resources`,
 * `list_mcp_resource_templates`, and `read_mcp_resource` register from the same extension
 * (dist/core/mcp-servers.js). The codemode tool is named `codemode`.
 *
 * Codemode scripts call other tools through `ctx.executeTool()`. Those nested calls carry
 * `parentToolCallId`, never appear as transcript tool calls or results, and are recorded only as
 * `nestedCalls` on the codemode tool result message (docs/extensions.md "Calling Other Tools").
 */

import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export const MCP_SERVERS_SECTION_NAME = "mcp_servers";

const MCP_BUILTIN_PATH = "builtin:mcp";
const CODEMODE_BUILTIN_PATH = "builtin:codemode";
const CODEMODE_TOOL_NAME = "codemode";
const MCP_TOOL_NAME_PREFIX = "mcp__";

export type McpToolKind = "mcp" | "codemode";

/**
 * Classifies a tool as a native MCP tool (`mcp__*` or `builtin:mcp` source), the native codemode
 * tool, or non-MCP (undefined).
 *
 * Without a catalog entry the tool name alone decides. With one, a tool named `codemode` is only
 * the native tool when it comes from `builtin:codemode`, so a replacement extension is not
 * counted as the built-in.
 */
export function getMcpToolKind(
  toolName: string,
  toolInfo?: Pick<ToolInfo, "sourceInfo">,
): McpToolKind | undefined {
  const path = toolInfo?.sourceInfo?.path;
  if (toolName.startsWith(MCP_TOOL_NAME_PREFIX) || path === MCP_BUILTIN_PATH) {
    return "mcp";
  }
  if (path === CODEMODE_BUILTIN_PATH) {
    return "codemode";
  }
  if (toolName === CODEMODE_TOOL_NAME && typeof path !== "string") {
    return "codemode";
  }
  return undefined;
}

export type NestedToolCallRecord = { id?: string; name: string };

/**
 * Reads the bounded nested-call record Pi attaches to a tool result message (`nestedCalls`).
 * Malformed entries are skipped.
 */
export function readNestedToolCalls(message: unknown): NestedToolCallRecord[] {
  const nested = (message as { nestedCalls?: unknown } | null | undefined)?.nestedCalls;
  const calls = Array.isArray(nested)
    ? nested
    : Array.isArray((nested as { calls?: unknown } | null | undefined)?.calls)
      ? (nested as { calls: unknown[] }).calls
      : [];
  const records: NestedToolCallRecord[] = [];
  for (const call of calls) {
    const candidate = call as { id?: unknown; name?: unknown } | null;
    if (candidate && typeof candidate.name === "string") {
      records.push({
        name: candidate.name,
        ...(typeof candidate.id === "string" ? { id: candidate.id } : {}),
      });
    }
  }
  return records;
}

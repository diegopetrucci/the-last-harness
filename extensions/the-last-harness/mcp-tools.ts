/**
 * Shared MCP tool identity module.
 *
 * All MCP classification logic lives here. Consumers (footer, tokens-analyzer,
 * launch-context, …) import from this module instead of duplicating the rules.
 *
 * ## Union rule
 * A tool is classified as an MCP tool when ANY of the following is true:
 *   1. The tool name is exactly "mcp" → kind "proxy"
 *   2. The adapter source string is in the KNOWN_PI_MCP_ADAPTER_SOURCES allowlist → kind "direct"
 *   3. The adapter source string matches /mcp/i (non-allowlisted adapters whose
 *      own package name indicates MCP) → kind "direct"
 *
 * Note: only the *source* field is checked against the regex; the tool path is
 * deliberately excluded to avoid false positives from coincidental path segments.
 */

import type { ToolInfo } from "@earendil-works/pi-coding-agent";

/**
 * Canonical list of known Pi MCP adapter sources.
 * Used as the primary allowlist for direct-MCP tool detection.
 */
export const KNOWN_PI_MCP_ADAPTER_SOURCES = [
	"npm:pi-mcp-adapter",
	"npm:@diegopetrucci/pi-mcp-adapter",
	"git:github.com/diegopetrucci/pi-mcp-adapter",
] as const;

/**
 * Returns true when `source` is a known Pi MCP adapter source string,
 * including versioned variants such as "npm:pi-mcp-adapter@2.10.1".
 */
export function hasKnownPiMcpAdapterSource(source: unknown): source is string {
	return (
		typeof source === "string" &&
		KNOWN_PI_MCP_ADAPTER_SOURCES.some((knownSource) => source === knownSource || source.startsWith(`${knownSource}@`))
	);
}

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
	return new Set([candidate.tool, `${serverPrefix}_${candidate.tool}`, `${shortPrefix}_${candidate.tool}`]).has(
		toolName,
	);
}

/**
 * Classifies a tool as MCP proxy, MCP direct, or non-MCP using the union rule.
 *
 * Returns:
 *  - "proxy"   when the tool name is "mcp" (the Pi MCP proxy tool)
 *  - "direct"  when the source is in the allowlist OR the source matches /mcp/i
 *  - undefined when the tool is not MCP
 */
export function getMcpToolKind(
	toolName: string,
	toolInfo?: Pick<ToolInfo, "sourceInfo">,
): "proxy" | "direct" | undefined {
	if (toolName === "mcp") {
		return "proxy";
	}
	const source = toolInfo?.sourceInfo?.source;
	if (hasKnownPiMcpAdapterSource(source)) {
		return "direct";
	}
	if (typeof source === "string" && /mcp/i.test(source)) {
		return "direct";
	}
	return undefined;
}

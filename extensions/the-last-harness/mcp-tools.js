// Generated from extensions/the-last-harness/mcp-tools.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
export const MCP_SERVERS_SECTION_NAME = "mcp_servers";
const MCP_BUILTIN_PATH = "builtin:mcp";
const CODEMODE_BUILTIN_PATH = "builtin:codemode";
const CODEMODE_TOOL_NAME = "codemode";
const MCP_TOOL_NAME_PREFIX = "mcp__";
export function getMcpToolKind(toolName, toolInfo) {
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
export function readNestedToolCalls(message) {
    const nested = message?.nestedCalls;
    const calls = Array.isArray(nested)
        ? nested
        : Array.isArray(nested?.calls)
            ? nested.calls
            : [];
    const records = [];
    for (const call of calls) {
        const candidate = call;
        if (candidate && typeof candidate.name === "string") {
            records.push({
                name: candidate.name,
                ...(typeof candidate.id === "string" ? { id: candidate.id } : {}),
            });
        }
    }
    return records;
}

export const KNOWN_PI_MCP_ADAPTER_SOURCES = [
    "npm:pi-mcp-adapter",
    "npm:@diegopetrucci/pi-mcp-adapter",
    "git:github.com/diegopetrucci/pi-mcp-adapter",
];
export function hasKnownPiMcpAdapterSource(source) {
    return (typeof source === "string" &&
        KNOWN_PI_MCP_ADAPTER_SOURCES.some((knownSource) => source === knownSource || source.startsWith(`${knownSource}@`)));
}
export function hasPersistedDirectMcpResultDetails(toolName, details) {
    if (!details || typeof details !== "object") {
        return false;
    }
    const candidate = details;
    if (typeof candidate.server !== "string" ||
        candidate.server.length === 0 ||
        typeof candidate.tool !== "string" ||
        candidate.tool.length === 0) {
        return false;
    }
    const serverPrefix = candidate.server.replaceAll("-", "_");
    const shortPrefix = candidate.server.replace(/-?mcp$/i, "").replaceAll("-", "_") || "mcp";
    return new Set([candidate.tool, `${serverPrefix}_${candidate.tool}`, `${shortPrefix}_${candidate.tool}`]).has(toolName);
}
export function getMcpToolKind(toolName, toolInfo) {
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

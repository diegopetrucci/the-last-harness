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
    return new Set([
        candidate.tool,
        `${serverPrefix}_${candidate.tool}`,
        `${shortPrefix}_${candidate.tool}`,
    ]).has(toolName);
}
export function getMcpToolKind(toolName, toolInfo) {
    if (toolName === "mcp") {
        return "proxy";
    }
    const source = toolInfo?.sourceInfo?.source;
    if (typeof source === "string" && /^(npm|git):/.test(source) && /mcp/i.test(source)) {
        return "direct";
    }
    return undefined;
}

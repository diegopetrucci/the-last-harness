import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getProjectConfigDir } from "../../shared/utils.js";
const CACHE_VERSION = 1;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "mcp"]);
const GENERIC_GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".config", "mcp", "mcp.json");
const IMPORT_PATHS = {
    cursor: [path.join(os.homedir(), ".cursor", "mcp.json")],
    "claude-code": [
        path.join(os.homedir(), ".claude", "mcp.json"),
        path.join(os.homedir(), ".claude.json"),
        path.join(os.homedir(), ".claude", "claude_desktop_config.json"),
    ],
    "claude-desktop": [path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")],
    codex: [path.join(os.homedir(), ".codex", "config.json")],
    windsurf: [path.join(os.homedir(), ".windsurf", "mcp.json")],
    vscode: [".vscode/mcp.json"],
};
export function resolveMcpDirectToolNames(mcpDirectTools, cwd = process.cwd()) {
    if (!mcpDirectTools?.length)
        return [];
    try {
        const config = loadMcpConfig(cwd);
        const cache = loadMetadataCache();
        if (!cache)
            return [];
        return resolveDirectToolNames(config, cache, getToolPrefix(config.settings?.toolPrefix), mcpDirectTools);
    }
    catch {
        return [];
    }
}
function loadMetadataCache() {
    const cachePath = path.join(getAgentDir(), "mcp-cache.json");
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    }
    catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object")
        return null;
    const raw = parsed;
    if (raw.version !== CACHE_VERSION || !raw.servers || typeof raw.servers !== "object" || Array.isArray(raw.servers)) {
        return null;
    }
    return raw;
}
function loadMcpConfig(cwd) {
    let config = { mcpServers: {} };
    for (const sourcePath of getConfigPaths(cwd)) {
        const loaded = readConfig(sourcePath);
        if (!loaded)
            continue;
        config = mergeConfigs(config, expandImports(loaded, cwd));
    }
    return config;
}
function getConfigPaths(cwd) {
    const piGlobalPath = path.join(getAgentDir(), "mcp.json");
    const projectPath = path.resolve(cwd, ".mcp.json");
    const projectPiPath = path.resolve(getProjectConfigDir(cwd), "mcp.json");
    const sources = [];
    if (GENERIC_GLOBAL_CONFIG_PATH !== piGlobalPath)
        sources.push(GENERIC_GLOBAL_CONFIG_PATH);
    sources.push(piGlobalPath);
    if (projectPath !== piGlobalPath)
        sources.push(projectPath);
    if (projectPiPath !== piGlobalPath && projectPiPath !== projectPath)
        sources.push(projectPiPath);
    return sources;
}
function readConfig(configPath) {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    }
    catch {
        return null;
    }
    return validateConfig(parsed);
}
function validateConfig(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return { mcpServers: {} };
    const obj = raw;
    const servers = obj.mcpServers ?? obj["mcp-servers"] ?? {};
    return {
        mcpServers: servers && typeof servers === "object" && !Array.isArray(servers) ? servers : {},
        imports: Array.isArray(obj.imports) ? obj.imports.filter((value) => isImportKind(value)) : undefined,
        settings: obj.settings && typeof obj.settings === "object" && !Array.isArray(obj.settings)
            ? obj.settings
            : undefined,
    };
}
function mergeConfigs(base, next) {
    const imports = [...(base.imports ?? []), ...(next.imports ?? [])];
    return {
        mcpServers: { ...base.mcpServers, ...next.mcpServers },
        imports: imports.length ? [...new Set(imports)] : undefined,
        settings: next.settings ? { ...base.settings, ...next.settings } : base.settings,
    };
}
function expandImports(config, cwd) {
    if (!config.imports?.length)
        return config;
    const importedServers = {};
    for (const importKind of config.imports) {
        const importPath = resolveImportPath(importKind, cwd);
        if (!importPath)
            continue;
        let imported;
        try {
            imported = JSON.parse(fs.readFileSync(importPath, "utf-8"));
        }
        catch {
            continue;
        }
        for (const [name, definition] of Object.entries(extractServers(imported, importKind))) {
            if (!importedServers[name])
                importedServers[name] = definition;
        }
    }
    return {
        imports: config.imports,
        settings: config.settings,
        mcpServers: { ...importedServers, ...config.mcpServers },
    };
}
function resolveImportPath(importKind, cwd) {
    for (const candidate of IMPORT_PATHS[importKind]) {
        const fullPath = candidate.startsWith(".") ? path.resolve(cwd, candidate) : candidate;
        if (fs.existsSync(fullPath))
            return fullPath;
    }
    return null;
}
function extractServers(config, kind) {
    if (!config || typeof config !== "object" || Array.isArray(config))
        return {};
    const obj = config;
    const servers = kind === "cursor" || kind === "windsurf" || kind === "vscode"
        ? obj.mcpServers ?? obj["mcp-servers"]
        : obj.mcpServers;
    return servers && typeof servers === "object" && !Array.isArray(servers) ? servers : {};
}
function resolveDirectToolNames(config, cache, prefix, envOverride) {
    const names = [];
    const seenNames = new Set();
    const { servers: selectedServers, tools: selectedTools } = parseSelections(envOverride);
    for (const [serverName, definition] of Object.entries(config.mcpServers)) {
        const serverCache = cache.servers[serverName];
        if (!isServerCacheValid(serverCache, definition))
            continue;
        const toolFilter = selectedServers.has(serverName)
            ? true
            : selectedTools.get(serverName);
        if (!toolFilter)
            continue;
        for (const tool of Array.isArray(serverCache.tools) ? serverCache.tools : []) {
            if (typeof tool?.name !== "string" || !tool.name)
                continue;
            if (toolFilter !== true && !toolFilter.has(tool.name))
                continue;
            if (isToolExcluded(tool.name, serverName, prefix, definition.excludeTools))
                continue;
            const prefixedName = formatToolName(tool.name, serverName, prefix);
            if (BUILTIN_TOOL_NAMES.has(prefixedName) || seenNames.has(prefixedName))
                continue;
            seenNames.add(prefixedName);
            names.push(prefixedName);
        }
        if (definition.exposeResources === false)
            continue;
        for (const resource of Array.isArray(serverCache.resources) ? serverCache.resources : []) {
            if (typeof resource?.name !== "string" || !resource.name || typeof resource.uri !== "string" || !resource.uri)
                continue;
            const baseName = `get_${resourceNameToToolName(resource.name)}`;
            if (toolFilter !== true && !toolFilter.has(baseName))
                continue;
            if (isToolExcluded(baseName, serverName, prefix, definition.excludeTools))
                continue;
            const prefixedName = formatToolName(baseName, serverName, prefix);
            if (BUILTIN_TOOL_NAMES.has(prefixedName) || seenNames.has(prefixedName))
                continue;
            seenNames.add(prefixedName);
            names.push(prefixedName);
        }
    }
    return names;
}
function parseSelections(selections) {
    const servers = new Set();
    const tools = new Map();
    for (let item of selections) {
        item = item.replace(/\/+$/, "");
        if (item.includes("/")) {
            const [server, tool] = item.split("/", 2);
            if (server && tool) {
                if (!tools.has(server))
                    tools.set(server, new Set());
                tools.get(server).add(tool);
            }
            else if (server) {
                servers.add(server);
            }
        }
        else if (item) {
            servers.add(item);
        }
    }
    return { servers, tools };
}
function isServerCacheValid(entry, definition) {
    if (!entry || entry.configHash !== computeMcpServerHash(definition))
        return false;
    if (!entry.cachedAt || typeof entry.cachedAt !== "number")
        return false;
    return Date.now() - entry.cachedAt <= CACHE_MAX_AGE_MS;
}
export function computeMcpServerHash(definition) {
    const identity = {
        command: definition.command,
        args: definition.args,
        env: interpolateEnvRecord(definition.env),
        cwd: resolveConfigPath(definition.cwd),
        url: definition.url,
        headers: interpolateEnvRecord(definition.headers),
        auth: definition.auth,
        bearerToken: resolveBearerToken(definition),
        bearerTokenEnv: definition.bearerTokenEnv,
        exposeResources: definition.exposeResources,
        excludeTools: definition.excludeTools,
    };
    return createHash("sha256").update(stableStringify(identity)).digest("hex");
}
function getToolPrefix(value) {
    return value === "none" || value === "short" || value === "server" ? value : "server";
}
function isImportKind(value) {
    return typeof value === "string" && Object.hasOwn(IMPORT_PATHS, value);
}
function getServerPrefix(serverName, mode) {
    if (mode === "none")
        return "";
    if (mode === "short") {
        const short = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
        return short || "mcp";
    }
    return serverName.replace(/-/g, "_");
}
function formatToolName(toolName, serverName, prefix) {
    const serverPrefix = getServerPrefix(serverName, prefix);
    return serverPrefix ? `${serverPrefix}_${toolName}` : toolName;
}
function isToolExcluded(toolName, serverName, prefix, excludeTools) {
    if (!Array.isArray(excludeTools) || excludeTools.length === 0)
        return false;
    const candidates = new Set([
        normalizeToolName(toolName),
        normalizeToolName(formatToolName(toolName, serverName, prefix)),
        normalizeToolName(formatToolName(toolName, serverName, "server")),
        normalizeToolName(formatToolName(toolName, serverName, "short")),
    ]);
    return excludeTools.some((excluded) => typeof excluded === "string" && candidates.has(normalizeToolName(excluded)));
}
function normalizeToolName(value) {
    return value.replace(/-/g, "_");
}
function resourceNameToToolName(name) {
    let result = name
        .replace(/[^a-zA-Z0-9]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+/, "")
        .replace(/_+$/, "")
        .toLowerCase();
    if (!result || /^\d/.test(result))
        result = `resource${result ? `_${result}` : ""}`;
    return result;
}
function interpolateEnvRecord(values) {
    if (!values || typeof values !== "object" || Array.isArray(values))
        return undefined;
    const resolved = {};
    for (const [key, value] of Object.entries(values)) {
        if (typeof value === "string")
            resolved[key] = interpolateEnvVars(value);
    }
    return resolved;
}
function interpolateEnvVars(value) {
    return value
        .replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "")
        .replace(/\$env:(\w+)/g, (_, name) => process.env[name] ?? "");
}
function resolveConfigPath(value) {
    if (typeof value !== "string")
        return undefined;
    const resolved = interpolateEnvVars(value);
    if (resolved === "~")
        return os.homedir();
    if (resolved.startsWith("~/") || resolved.startsWith("~\\"))
        return path.join(os.homedir(), resolved.slice(2));
    return resolved;
}
function resolveBearerToken(definition) {
    if (typeof definition.bearerToken === "string")
        return interpolateEnvVars(definition.bearerToken);
    return typeof definition.bearerTokenEnv === "string" ? process.env[definition.bearerTokenEnv] : undefined;
}
function stableStringify(value) {
    if (value === null || value === undefined || typeof value !== "object") {
        const serialized = JSON.stringify(value);
        return serialized === undefined ? "undefined" : serialized;
    }
    if (Array.isArray(value))
        return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
    const obj = value;
    return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}

import * as os from "node:os";
import * as path from "node:path";
export function normalizeSubagentRunMode(value) {
    return value === "parallel" ? "parallel" : "single";
}
export const SUBAGENT_LIFECYCLE_ARTIFACT_VERSION = 1;
export const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const SUBAGENT_CONTROL_EVENT = "subagent:control-event";
export const DEFAULT_MAX_OUTPUT = {
    bytes: 200 * 1024,
    lines: 5000,
};
export const DEFAULT_ARTIFACT_CONFIG = {
    enabled: true,
    includeInput: true,
    includeOutput: true,
    includeJsonl: false,
    includeTranscript: true,
    includeMetadata: true,
    cleanupDays: 7,
};
function sanitizeTempScopeSegment(value) {
    const sanitized = value
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return sanitized || "unknown";
}
function resolveTempScopeId(options) {
    const env = options?.env ?? process.env;
    const getuid = options && Object.hasOwn(options, "getuid") ? options.getuid : process.getuid?.bind(process);
    if (typeof getuid === "function") {
        return `uid-${getuid()}`;
    }
    for (const key of ["USERNAME", "USER", "LOGNAME"]) {
        const value = env[key];
        if (value)
            return `user-${sanitizeTempScopeSegment(value)}`;
    }
    const userInfo = options && Object.hasOwn(options, "userInfo") ? options.userInfo : os.userInfo;
    try {
        const username = userInfo?.().username;
        if (username)
            return `user-${sanitizeTempScopeSegment(username)}`;
    }
    catch {
    }
    const homedir = env.USERPROFILE ?? env.HOME;
    if (homedir)
        return `home-${sanitizeTempScopeSegment(homedir)}`;
    const resolveHomedir = options && Object.hasOwn(options, "homedir") ? options.homedir : os.homedir;
    try {
        const fallbackHomedir = resolveHomedir?.();
        if (fallbackHomedir)
            return `home-${sanitizeTempScopeSegment(fallbackHomedir)}`;
    }
    catch {
    }
    return "shared";
}
const MAX_PARALLEL = 8;
const MAX_CONCURRENCY = 4;
export function resolveTempRootDir(options) {
    const env = options?.env ?? process.env;
    const override = env.PI_SUBAGENTS_TEMP_ROOT?.trim();
    if (override) {
        return override;
    }
    return path.join(os.tmpdir(), `pi-subagents-${resolveTempScopeId(options)}`);
}
export const TEMP_ROOT_DIR = resolveTempRootDir();
export const RESULTS_DIR = path.join(TEMP_ROOT_DIR, "async-subagent-results");
export const ASYNC_DIR = path.join(TEMP_ROOT_DIR, "async-subagent-runs");
export const TEMP_ARTIFACTS_DIR = path.join(TEMP_ROOT_DIR, "artifacts");
export const WIDGET_KEY = "subagent-async";
export const SLASH_TEXT_RESULT_TYPE = "subagent-slash-text-result";
export const POLL_INTERVAL_MS = 250;
export const MAX_WIDGET_JOBS = 4;
export const DEFAULT_SUBAGENT_MAX_DEPTH = 2;
export const SUBAGENT_ACTIONS = [
    "list",
    "get",
    "status",
    "interrupt",
    "resume",
    "steer",
    "doctor",
];
function normalizeTopLevelParallelValue(value) {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1)
        return undefined;
    return parsed;
}
export function resolveTopLevelParallelMaxTasks(value) {
    return normalizeTopLevelParallelValue(value) ?? MAX_PARALLEL;
}
export function resolveTopLevelParallelConcurrency(configValue) {
    return normalizeTopLevelParallelValue(configValue) ?? MAX_CONCURRENCY;
}
export function getAsyncConfigPath(suffix) {
    return path.join(TEMP_ROOT_DIR, `async-cfg-${suffix}.json`);
}
function normalizeNonNegativeInteger(value) {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isInteger(parsed) || parsed < 0)
        return undefined;
    return parsed;
}
export function normalizeMaxSubagentDepth(value) {
    return normalizeNonNegativeInteger(value);
}
export function resolveCurrentMaxSubagentDepth(configMaxDepth) {
    return (normalizeMaxSubagentDepth(process.env.PI_SUBAGENT_MAX_DEPTH) ??
        normalizeMaxSubagentDepth(configMaxDepth) ??
        DEFAULT_SUBAGENT_MAX_DEPTH);
}
export function resolveChildMaxSubagentDepth(parentMaxDepth, agentMaxDepth) {
    const normalizedParent = normalizeMaxSubagentDepth(parentMaxDepth) ?? DEFAULT_SUBAGENT_MAX_DEPTH;
    const normalizedAgent = normalizeMaxSubagentDepth(agentMaxDepth);
    return normalizedAgent === undefined
        ? normalizedParent
        : Math.min(normalizedParent, normalizedAgent);
}
export function checkSubagentDepth(configMaxDepth) {
    const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
    const maxDepth = resolveCurrentMaxSubagentDepth(configMaxDepth);
    const blocked = Number.isFinite(depth) && depth >= maxDepth;
    return { blocked, depth, maxDepth };
}
export function getSubagentDepthEnv(maxDepth) {
    const parentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
    const nextDepth = Number.isFinite(parentDepth) ? parentDepth + 1 : 1;
    return {
        PI_SUBAGENT_DEPTH: String(nextDepth),
        PI_SUBAGENT_MAX_DEPTH: String(normalizeMaxSubagentDepth(maxDepth) ?? resolveCurrentMaxSubagentDepth()),
    };
}
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes}B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
export function truncateOutput(output, config, artifactPath) {
    const lines = output.split("\n");
    const bytes = Buffer.byteLength(output, "utf-8");
    if (bytes <= config.bytes && lines.length <= config.lines) {
        return { text: output, truncated: false };
    }
    let truncatedLines = lines;
    if (lines.length > config.lines) {
        truncatedLines = lines.slice(0, config.lines);
    }
    let result = truncatedLines.join("\n");
    if (Buffer.byteLength(result, "utf-8") > config.bytes) {
        let low = 0;
        let high = result.length;
        while (low < high) {
            const mid = Math.floor((low + high + 1) / 2);
            if (Buffer.byteLength(result.slice(0, mid), "utf-8") <= config.bytes) {
                low = mid;
            }
            else {
                high = mid - 1;
            }
        }
        result = result.slice(0, low);
    }
    const keptLines = result.split("\n").length;
    const marker = `[TRUNCATED: showing first ${keptLines} of ${lines.length} lines, ${formatBytes(Buffer.byteLength(result))} of ${formatBytes(bytes)}${artifactPath ? ` - full output at ${artifactPath}` : ""}]\n`;
    return {
        text: marker + result,
        truncated: true,
        originalBytes: bytes,
        originalLines: lines.length,
        artifactPath,
    };
}

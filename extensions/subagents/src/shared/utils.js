import * as fs from "node:fs";
import * as path from "node:path";
import { getConfigDirName, getProjectConfigDir, PI_CODING_AGENT_PACKAGE_ROOT_ENV, resolveConfigDirName, } from "./config-dir.js";
import { getPiAgentDir } from "./profile.js";
import { waitSync } from "./atomic-json.js";
import { MAX_ATTRIBUTION_STATUS_BYTES } from "./terminal-result.js";
import { AsyncStatusReadError, formatUnreadableStatus, parsePersistedAsyncStatus, } from "../runs/background/async-status-boundary.js";
import { normalizeAsyncLifecycleStatus } from "../runs/shared/lifecycle-state.js";
export { AsyncStatusReadError, formatUnreadableStatus };
export { getConfigDirName, getProjectConfigDir, PI_CODING_AGENT_PACKAGE_ROOT_ENV, resolveConfigDirName, };
export function getAgentDir() {
    return getPiAgentDir();
}
const statusCache = new Map();
const statusFailureCache = new Map();
const MAX_STATUS_CACHE_ENTRIES = 50;
const MAX_STATUS_FAILURE_CACHE_ENTRIES = 256;
export const MAX_ASYNC_STATUS_BYTES = MAX_ATTRIBUTION_STATUS_BYTES;
export const MAX_STATUS_CACHE_BYTES = 50 * 1024 * 1024;
export const ASYNC_STATUS_RETRY_DELAY_MS = 10;
let statusCacheBytes = 0;
const STATUS_READ_CHUNK_BYTES = 64 * 1024;
const optionalOpenConstants = fs.constants;
const STATUS_NONBLOCK_FLAG = optionalOpenConstants.O_NONBLOCK ?? 0;
const STATUS_NOFOLLOW_FLAG = optionalOpenConstants.O_NOFOLLOW ?? 0;
const STATUS_OPEN_FLAGS = fs.constants.O_RDONLY | STATUS_NONBLOCK_FLAG | STATUS_NOFOLLOW_FLAG;
export function invalidateStatusCache(asyncDirOrStatusPath) {
    const statusPath = path.basename(asyncDirOrStatusPath) === "status.json"
        ? path.resolve(asyncDirOrStatusPath)
        : path.join(path.resolve(asyncDirOrStatusPath), "status.json");
    deleteStatusCacheEntry(statusPath);
    statusFailureCache.delete(statusPath);
}
export function normalizeComparableCwd(cwd) {
    const resolved = path.resolve(cwd);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
export function resolveChildCwd(baseCwd, childCwd) {
    if (!childCwd)
        return baseCwd;
    return path.isAbsolute(childCwd) ? childCwd : path.resolve(baseCwd, childCwd);
}
function isNotFoundError(error) {
    return (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT");
}
function isKnownUnsafeOpenError(error) {
    if (typeof error !== "object" || error === null || !("code" in error))
        return false;
    const code = error.code;
    return code === "ELOOP" || code === "EISDIR" || code === "ENXIO";
}
function isNonRegularStatusPath(statusPath) {
    try {
        return !fs.lstatSync(statusPath).isFile();
    }
    catch {
        return false;
    }
}
class StatusFileTooLargeError extends Error {
}
function readBoundedStatusContent(fd) {
    const chunks = [];
    let bytesRead = 0;
    while (bytesRead <= MAX_ASYNC_STATUS_BYTES) {
        const bytesRemaining = MAX_ASYNC_STATUS_BYTES + 1 - bytesRead;
        const buffer = Buffer.allocUnsafe(Math.min(STATUS_READ_CHUNK_BYTES, bytesRemaining));
        const chunkSize = fs.readSync(fd, buffer, 0, buffer.byteLength, null);
        if (chunkSize === 0)
            break;
        chunks.push(buffer.subarray(0, chunkSize));
        bytesRead += chunkSize;
    }
    if (bytesRead > MAX_ASYNC_STATUS_BYTES) {
        throw new StatusFileTooLargeError(`status file exceeds ${MAX_ASYNC_STATUS_BYTES} bytes`);
    }
    return Buffer.concat(chunks, bytesRead).toString("utf-8");
}
function statusMetadata(stat) {
    return {
        mtime: stat.mtimeMs,
        ctime: stat.ctimeMs,
        size: stat.size,
        ino: stat.ino,
    };
}
function sameStatusMetadata(left, right) {
    return (left.mtime === right.mtime &&
        left.ctime === right.ctime &&
        left.size === right.size &&
        left.ino === right.ino);
}
function deleteStatusCacheEntry(statusPath) {
    const cached = statusCache.get(statusPath);
    if (!cached)
        return;
    statusCache.delete(statusPath);
    statusCacheBytes -= cached.size;
}
function cacheStatus(statusPath, metadata, status) {
    deleteStatusCacheEntry(statusPath);
    if (metadata.size > MAX_STATUS_CACHE_BYTES)
        return;
    statusCache.set(statusPath, { ...metadata, status });
    statusCacheBytes += metadata.size;
    while (statusCache.size > MAX_STATUS_CACHE_ENTRIES || statusCacheBytes > MAX_STATUS_CACHE_BYTES) {
        const firstKey = statusCache.keys().next().value;
        if (firstKey === undefined)
            break;
        deleteStatusCacheEntry(firstKey);
    }
}
function statusReadError(input) {
    return new AsyncStatusReadError(input);
}
function statusReadFailure(asyncDir, statusPath, failure, message, cause) {
    return statusReadError({ asyncDir, statusPath, failure, message, cause });
}
function isCacheableStatusFailure(error) {
    return (error.failure === "invalid" || error.failure === "oversize" || error.failure === "non_regular");
}
function checkStatusCache(statusPath, metadata, useCache) {
    if (!useCache)
        return undefined;
    const cachedFailure = statusFailureCache.get(statusPath);
    if (cachedFailure) {
        if (sameStatusMetadata(cachedFailure, metadata))
            throw cachedFailure.error;
        statusFailureCache.delete(statusPath);
        deleteStatusCacheEntry(statusPath);
    }
    const cached = statusCache.get(statusPath);
    if (cached && sameStatusMetadata(cached, metadata))
        return cached.status;
    return undefined;
}
function parseAndCacheStatus(content, asyncDir, statusPath, metadata, useCache) {
    if (Buffer.byteLength(content, "utf-8") > MAX_ASYNC_STATUS_BYTES) {
        return statusReadFailure(asyncDir, statusPath, "oversize", `Failed to read async status file '${statusPath}': status exceeds the ${MAX_ASYNC_STATUS_BYTES}-byte limit.`);
    }
    try {
        const parsed = JSON.parse(content);
        const narrowed = parsePersistedAsyncStatus(parsed, asyncDir, statusPath);
        const status = normalizeAsyncLifecycleStatus(narrowed);
        if (useCache) {
            statusFailureCache.delete(statusPath);
            cacheStatus(statusPath, metadata, status);
        }
        return status;
    }
    catch (error) {
        if (error instanceof AsyncStatusReadError)
            return error;
        return statusReadFailure(asyncDir, statusPath, "invalid", `Failed to parse async status file '${statusPath}': status JSON could not be parsed.`);
    }
}
export function readStatus(asyncDir, options = {}) {
    const statusPath = path.resolve(asyncDir, "status.json");
    const hasPathSeams = options.statSync !== undefined || options.readFileSync !== undefined;
    const statSync = options.statSync ?? fs.statSync;
    const readFileSync = options.readFileSync ?? ((filePath, encoding) => fs.readFileSync(filePath, encoding));
    const sleep = options.sleep ?? waitSync;
    const requestedRetryDelayMs = options.retryDelayMs;
    const retryDelayMs = requestedRetryDelayMs !== undefined && Number.isFinite(requestedRetryDelayMs)
        ? Math.min(ASYNC_STATUS_RETRY_DELAY_MS, Math.max(0, Math.floor(requestedRetryDelayMs)))
        : ASYNC_STATUS_RETRY_DELAY_MS;
    const useCache = options.cache !== false;
    let lastFailure;
    let lastMetadata;
    const clearMissing = () => {
        if (useCache) {
            deleteStatusCacheEntry(statusPath);
            statusFailureCache.delete(statusPath);
        }
        return null;
    };
    for (let attempt = 0; attempt < 2; attempt++) {
        lastFailure = undefined;
        if (!hasPathSeams) {
            let fd;
            try {
                try {
                    fd = fs.openSync(statusPath, STATUS_OPEN_FLAGS);
                }
                catch (openError) {
                    if (isNotFoundError(openError))
                        return clearMissing();
                    lastFailure = statusReadFailure(asyncDir, statusPath, isKnownUnsafeOpenError(openError) || isNonRegularStatusPath(statusPath)
                        ? "non_regular"
                        : "unreadable", `Failed to read async status file '${statusPath}': status${isKnownUnsafeOpenError(openError) || isNonRegularStatusPath(statusPath)
                        ? " path is not a regular file"
                        : " metadata could not be read."}`, openError);
                }
                if (!lastFailure && fd !== undefined) {
                    let fdStat;
                    try {
                        fdStat = fs.fstatSync(fd);
                    }
                    catch (statError) {
                        lastFailure = statusReadFailure(asyncDir, statusPath, "unreadable", `Failed to read async status file '${statusPath}': status metadata could not be read.`, statError);
                    }
                    if (!lastFailure && fdStat !== undefined) {
                        if (!fdStat.isFile()) {
                            lastFailure = statusReadFailure(asyncDir, statusPath, "non_regular", `Failed to read async status file '${statusPath}': status path is not a regular file`);
                        }
                        else if (!Number.isFinite(fdStat.size) ||
                            fdStat.size < 0 ||
                            fdStat.size > MAX_ASYNC_STATUS_BYTES) {
                            lastFailure = statusReadFailure(asyncDir, statusPath, "oversize", `Failed to read async status file '${statusPath}': status exceeds the ${MAX_ASYNC_STATUS_BYTES}-byte limit.`);
                        }
                        else {
                            const metadata = statusMetadata(fdStat);
                            lastMetadata = metadata;
                            const cached = checkStatusCache(statusPath, metadata, useCache);
                            if (cached !== undefined)
                                return cached;
                            let content;
                            try {
                                content = readBoundedStatusContent(fd);
                            }
                            catch (readError) {
                                lastFailure = statusReadFailure(asyncDir, statusPath, readError instanceof StatusFileTooLargeError ? "oversize" : "unreadable", `Failed to read async status file '${statusPath}': status${readError instanceof StatusFileTooLargeError
                                    ? ` exceeds the ${MAX_ASYNC_STATUS_BYTES}-byte limit.`
                                    : " content could not be read."}`, readError);
                            }
                            if (!lastFailure && content !== undefined) {
                                const result = parseAndCacheStatus(content, asyncDir, statusPath, metadata, useCache);
                                if (result instanceof AsyncStatusReadError)
                                    lastFailure = result;
                                else
                                    return result;
                            }
                        }
                    }
                }
            }
            finally {
                if (fd !== undefined)
                    fs.closeSync(fd);
            }
        }
        else {
            if (attempt === 0) {
                let hardLstatError = false;
                try {
                    const lstat = fs.lstatSync(statusPath);
                    if (!lstat.isFile()) {
                        const isNonRegular = lstat.isFIFO() || lstat.isSymbolicLink();
                        lastFailure = statusReadFailure(asyncDir, statusPath, isNonRegular ? "non_regular" : "unreadable", `Failed to read async status file '${statusPath}': status path is not a regular file`);
                        if (!isNonRegular)
                            hardLstatError = true;
                    }
                }
                catch (error) {
                    if (isNotFoundError(error))
                        return clearMissing();
                    lastFailure = statusReadFailure(asyncDir, statusPath, "unreadable", `Failed to read async status file '${statusPath}': status metadata could not be read.`, error);
                    hardLstatError = true;
                }
                if (hardLstatError)
                    break;
            }
            if (!lastFailure) {
                let metadata;
                let stat;
                try {
                    stat = statSync(statusPath);
                    metadata = statusMetadata(stat);
                    lastMetadata = metadata;
                }
                catch (error) {
                    if (isNotFoundError(error))
                        return clearMissing();
                    lastFailure = statusReadFailure(asyncDir, statusPath, "unreadable", `Failed to read async status file '${statusPath}': status metadata could not be read.`, error);
                }
                if (!lastFailure && metadata) {
                    const cached = checkStatusCache(statusPath, metadata, useCache);
                    if (cached !== undefined)
                        return cached;
                    if (!Number.isFinite(stat.size) ||
                        stat.size < 0 ||
                        stat.size > MAX_ASYNC_STATUS_BYTES) {
                        lastFailure = statusReadFailure(asyncDir, statusPath, "oversize", `Failed to read async status file '${statusPath}': status exceeds the ${MAX_ASYNC_STATUS_BYTES}-byte limit.`);
                    }
                    else {
                        let content;
                        try {
                            const raw = readFileSync(statusPath, "utf-8");
                            content = typeof raw === "string" ? raw : raw.toString("utf-8");
                        }
                        catch (error) {
                            if (isNotFoundError(error))
                                return clearMissing();
                            lastFailure = statusReadFailure(asyncDir, statusPath, "unreadable", `Failed to read async status file '${statusPath}': status content could not be read.`, error);
                        }
                        if (!lastFailure && content !== undefined) {
                            const result = parseAndCacheStatus(content, asyncDir, statusPath, metadata, useCache);
                            if (result instanceof AsyncStatusReadError)
                                lastFailure = result;
                            else
                                return result;
                        }
                    }
                }
            }
        }
        if (attempt === 0) {
            try {
                sleep(retryDelayMs);
            }
            catch (error) {
                lastFailure = statusReadFailure(asyncDir, statusPath, "unreadable", "status retry delay could not be completed.", error);
                break;
            }
        }
    }
    const failure = lastFailure ??
        statusReadFailure(asyncDir, statusPath, "unreadable", "status could not be read safely.");
    if (useCache) {
        deleteStatusCacheEntry(statusPath);
        statusFailureCache.delete(statusPath);
        if (lastMetadata && isCacheableStatusFailure(failure)) {
            statusFailureCache.set(statusPath, { ...lastMetadata, error: failure });
            if (statusFailureCache.size > MAX_STATUS_FAILURE_CACHE_ENTRIES) {
                const firstKey = statusFailureCache.keys().next().value;
                if (firstKey)
                    statusFailureCache.delete(firstKey);
            }
        }
    }
    throw failure;
}
export function readRawAttributionStatus(statusPath) {
    let fd;
    try {
        try {
            fd = fs.openSync(statusPath, STATUS_OPEN_FLAGS);
        }
        catch (error) {
            if (isNotFoundError(error))
                return null;
            return undefined;
        }
        let stat;
        try {
            stat = fs.fstatSync(fd);
        }
        catch {
            return undefined;
        }
        if (!stat.isFile())
            return undefined;
        if (stat.size > MAX_ASYNC_STATUS_BYTES)
            return undefined;
        let content;
        try {
            content = readBoundedStatusContent(fd);
        }
        catch {
            return undefined;
        }
        try {
            const parsed = JSON.parse(content);
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
                return undefined;
            return parsed;
        }
        catch {
            return undefined;
        }
    }
    finally {
        if (fd !== undefined)
            fs.closeSync(fd);
    }
}
export function findLatestSessionFile(sessionDir) {
    if (!fs.existsSync(sessionDir))
        return null;
    const files = fs
        .readdirSync(sessionDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => {
        const filePath = path.join(sessionDir, f);
        return {
            path: filePath,
            mtime: fs.statSync(filePath).mtimeMs,
        };
    })
        .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? files[0].path : null;
}
export function getFinalOutput(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role !== "assistant")
            continue;
        const hasAssistantError = ("errorMessage" in msg &&
            typeof msg.errorMessage === "string" &&
            msg.errorMessage.length > 0) ||
            ("stopReason" in msg && msg.stopReason === "error");
        if (hasAssistantError)
            continue;
        for (let j = msg.content.length - 1; j >= 0; j--) {
            const part = msg.content[j];
            if (part.type === "text" && part.text.trim().length > 0)
                return part.text;
        }
    }
    return "";
}
export function getSingleResultOutput(result) {
    return result.finalOutput ?? getFinalOutput(result.messages ?? []);
}
export function formatErrorWithOutput(error, output) {
    const normalizedOutput = typeof output === "string" ? output : "";
    if (error) {
        return normalizedOutput.trim().length > 0 ? `${error}\n\nOutput:\n${normalizedOutput}` : error;
    }
    return normalizedOutput || "(no output)";
}
export function synthesizeChildExitDiagnostic(input) {
    const signal = typeof input.signal === "string" && input.signal.trim().length > 0 ? input.signal : undefined;
    if (signal)
        return `Child process exited after receiving ${signal}.`;
    const exitCode = input.exitCode;
    if (typeof exitCode !== "number" || !Number.isFinite(exitCode) || exitCode === 0)
        return undefined;
    if (exitCode === 143)
        return "Child process exited with code 143 (conventionally SIGTERM).";
    return `Child process exited with code ${exitCode}.`;
}
export function getDisplayItems(messages) {
    if (!messages || messages.length === 0)
        return [];
    const items = [];
    for (const msg of messages) {
        if (msg.role === "assistant") {
            for (const part of msg.content) {
                if (part.type === "text")
                    items.push({ type: "text", text: part.text });
                else if (part.type === "toolCall")
                    items.push({ type: "tool", name: part.name, args: part.arguments });
            }
        }
    }
    return items;
}
export function sumResultsUsage(results) {
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
    for (const result of results) {
        usage.input += result.usage.input;
        usage.output += result.usage.output;
        usage.cacheRead += result.usage.cacheRead;
        usage.cacheWrite += result.usage.cacheWrite;
        usage.cost += result.usage.cost;
        usage.turns += result.usage.turns;
    }
    return usage;
}
function addNestedCost(total, children) {
    for (const child of children ?? []) {
        if (child.totalCost) {
            total.inputTokens += child.totalCost.inputTokens;
            total.outputTokens += child.totalCost.outputTokens;
            total.costUsd += child.totalCost.costUsd;
            continue;
        }
        addNestedCost(total, child.children);
        for (const step of child.steps ?? [])
            addNestedCost(total, step.children);
    }
}
export function sumResultsCost(results) {
    const total = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    for (const result of results) {
        total.inputTokens += result.usage.input;
        total.outputTokens += result.usage.output;
        total.costUsd += result.usage.cost;
        addNestedCost(total, result.children);
    }
    return total;
}
export function detectSubagentError(messages) {
    let lastAssistantTextIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "assistant") {
            const hasText = Array.isArray(msg.content) &&
                msg.content.some((c) => c.type === "text" &&
                    "text" in c &&
                    typeof c.text === "string" &&
                    c.text.trim().length > 0);
            if (hasText) {
                lastAssistantTextIndex = i;
                break;
            }
        }
    }
    const scanStart = lastAssistantTextIndex >= 0 ? lastAssistantTextIndex + 1 : 0;
    for (let i = messages.length - 1; i >= scanStart; i--) {
        const msg = messages[i];
        if (msg.role !== "toolResult")
            continue;
        const toolName = "toolName" in msg && typeof msg.toolName === "string" ? msg.toolName : undefined;
        const isError = "isError" in msg && msg.isError === true;
        if (isError) {
            const text = msg.content.find((c) => c.type === "text");
            const details = text && "text" in text ? text.text : undefined;
            const exitMatch = details?.match(/exit(?:ed)?\s*(?:with\s*)?(?:code|status)?\s*[:\s]?\s*(\d+)/i);
            return {
                hasError: true,
                exitCode: exitMatch ? parseInt(exitMatch[1], 10) : 1,
                errorType: toolName || "tool",
                details: details?.slice(0, 200),
            };
        }
        if (toolName !== "bash")
            continue;
        const text = msg.content.find((c) => c.type === "text");
        if (!text || !("text" in text))
            continue;
        const output = text.text;
        const exitMatch = output.match(/exit(?:ed)?\s*(?:with\s*)?(?:code|status)?\s*[:\s]?\s*(\d+)/i);
        if (exitMatch) {
            const code = parseInt(exitMatch[1], 10);
            if (code !== 0) {
                return { hasError: true, exitCode: code, errorType: "bash", details: output.slice(0, 200) };
            }
        }
        const fatalPatterns = [
            /command not found/i,
            /permission denied/i,
            /no such file or directory/i,
            /segmentation fault/i,
            /killed|terminated/i,
            /out of memory/i,
            /connection refused/i,
            /timeout/i,
        ];
        for (const pattern of fatalPatterns) {
            if (pattern.test(output)) {
                return { hasError: true, exitCode: 1, errorType: "bash", details: output.slice(0, 200) };
            }
        }
    }
    return { hasError: false };
}
export function extractToolArgsPreview(args) {
    const stringifyPreviewValue = (value) => {
        if (typeof value === "string" && value.trim().length > 0)
            return value;
        if (typeof value === "number" || typeof value === "boolean")
            return String(value);
        return undefined;
    };
    const previewArray = (value) => {
        if (!Array.isArray(value) || value.length === 0)
            return undefined;
        const first = stringifyPreviewValue(value[0]);
        if (!first)
            return undefined;
        const suffix = value.length > 1 ? ` (+${value.length - 1} more)` : "";
        return `${first}${suffix}`;
    };
    if (args.tool && typeof args.tool === "string") {
        const server = args.server && typeof args.server === "string" ? `${args.server}/` : "";
        const toolArgs = args.args && typeof args.args === "string" ? ` ${args.args}` : "";
        return `${server}${args.tool}${toolArgs}`;
    }
    const queriesPreview = previewArray(args.queries);
    if (queriesPreview)
        return queriesPreview;
    if (typeof args.query === "string" && args.query.trim().length > 0)
        return args.query;
    if (typeof args.workflow === "string" && args.workflow.trim().length > 0)
        return `workflow=${args.workflow}`;
    if (typeof args.url === "string" && args.url.trim().length > 0)
        return args.url;
    const urlsPreview = previewArray(args.urls);
    if (urlsPreview)
        return urlsPreview;
    if (typeof args.prompt === "string" && args.prompt.trim().length > 0)
        return args.prompt;
    const previewKeys = [
        "command",
        "path",
        "file_path",
        "pattern",
        "query",
        "url",
        "task",
        "describe",
        "search",
    ];
    for (const key of previewKeys) {
        if (args[key] && typeof args[key] === "string")
            return args[key];
    }
    for (const [key, value] of Object.entries(args)) {
        const arrayPreview = previewArray(value);
        if (arrayPreview)
            return `${key}=${arrayPreview}`;
        if (typeof value === "string" && value.length > 0)
            return `${key}=${value}`;
    }
    return "";
}
export function extractTextFromContent(content) {
    if (!content)
        return "";
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    const texts = [];
    for (const part of content) {
        if (part && typeof part === "object") {
            if ("type" in part && part.type === "text" && "text" in part) {
                texts.push(String(part.text));
            }
            else if ("type" in part && part.type === "tool_result" && "content" in part) {
                const inner = extractTextFromContent(part.content);
                if (inner)
                    texts.push(inner);
            }
            else if ("text" in part) {
                texts.push(String(part.text));
            }
        }
    }
    return texts.join("\n");
}
export { mapConcurrent } from "../runs/shared/parallel-utils.js";

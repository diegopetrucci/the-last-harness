import * as path from "node:path";
import {} from "typebox";
import { Compile } from "typebox/compile";
import { resolveAsyncRunLocation } from "../runs/background/async-resume.js";
import { deliverTimeoutRequest } from "../runs/background/control-channel.js";
import { reconcileAsyncRun } from "../runs/background/stale-run-reconciler.js";
import { ASYNC_DIR, RESULTS_DIR } from "../shared/types.js";
import { readStatus } from "../shared/utils.js";
import { SubagentParams } from "./schemas.js";
export const SUBAGENT_RPC_PROTOCOL_VERSION = 1;
export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";
export const SUBAGENT_RPC_METHODS = ["ping", "status", "spawn", "interrupt", "stop"];
class SubagentRpcError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "SubagentRpcError";
        this.code = code;
    }
}
const subagentParamsSchema = SubagentParams;
const compileSchema = Compile;
const subagentParamsValidator = compileSchema(subagentParamsSchema);
export function subagentRpcReplyEvent(requestId) {
    return `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`;
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function assertRequestId(value) {
    if (typeof value !== "string" || value.trim().length === 0 || /[\r\n]/.test(value)) {
        throw new SubagentRpcError("invalid_request", "RPC requestId must be a non-empty string without newlines.");
    }
    return value;
}
function assertRecordParams(params, method) {
    if (params === undefined)
        return {};
    if (!isRecord(params))
        throw new SubagentRpcError("invalid_params", `RPC ${method} params must be an object.`);
    return params;
}
function assertSubagentParams(params, label) {
    if (subagentParamsValidator.Check(params))
        return;
    const messages = [...subagentParamsValidator.Errors(params)]
        .slice(0, 4)
        .map((error) => error.message);
    throw new SubagentRpcError("invalid_params", `${label}: ${messages.join("; ") || "invalid subagent parameters"}`);
}
function textFromToolResult(result) {
    return result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}
function dataFromToolResult(result) {
    return {
        text: textFromToolResult(result),
        ...(result.details ? { details: result.details } : {}),
        ...(result.isError ? { isError: true } : {}),
    };
}
function failIfToolError(result) {
    if (!result.isError)
        return;
    throw new SubagentRpcError("execution_failed", textFromToolResult(result) || "Subagent RPC execution failed.");
}
function normalizeTargetParams(params, method) {
    const input = assertRecordParams(params, method);
    const output = {};
    if (input.id !== undefined)
        output.id = input.id;
    else if (input.runId !== undefined)
        output.id = input.runId;
    if (input.index !== undefined)
        output.index = input.index;
    return output;
}
function sessionData(ctx) {
    if (!ctx)
        return {};
    return {
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId() ?? undefined,
        sessionFile: ctx.sessionManager.getSessionFile() ?? null,
    };
}
function pingData(ctx) {
    return {
        version: SUBAGENT_RPC_PROTOCOL_VERSION,
        methods: [...SUBAGENT_RPC_METHODS],
        capabilities: {
            status: true,
            asyncSpawn: true,
            interrupt: true,
            stop: true,
        },
        events: {
            ready: SUBAGENT_RPC_READY_EVENT,
            request: SUBAGENT_RPC_REQUEST_EVENT,
            replyPrefix: SUBAGENT_RPC_REPLY_EVENT_PREFIX,
        },
        session: sessionData(ctx),
    };
}
async function executeChecked(options, ctx, requestId, method, params) {
    assertSubagentParams(params, `RPC ${method} params`);
    const controller = new AbortController();
    const result = await options.execute(`rpc-${method}-${requestId}`, params, controller.signal, undefined, ctx);
    failIfToolError(result);
    return dataFromToolResult(result);
}
function spawnParams(params) {
    const input = assertRecordParams(params, "spawn");
    if (input.action !== undefined) {
        throw new SubagentRpcError("invalid_params", "RPC spawn does not accept management/control actions. Use status or interrupt RPC methods instead.");
    }
    if (input.chain !== undefined) {
        throw new SubagentRpcError("invalid_params", "Saved chains are deliberately unsupported in The Last Harness; omit chain.");
    }
    if (input.chainName !== undefined) {
        throw new SubagentRpcError("invalid_params", "Saved chains are deliberately unsupported in The Last Harness; omit chainName.");
    }
    if (input.chainDir !== undefined) {
        throw new SubagentRpcError("invalid_params", "Saved chains are deliberately unsupported in The Last Harness; omit chainDir.");
    }
    if (input.async === false) {
        throw new SubagentRpcError("invalid_params", "RPC spawn only supports detached async launches; omit async or set async: true.");
    }
    if (input.clarify !== undefined) {
        throw new SubagentRpcError("invalid_params", "The Last Harness does not support the chain clarify UI; omit clarify.");
    }
    return { ...input, async: true };
}
function stopAsyncRun(params, options, ctx) {
    const target = normalizeTargetParams(params, "stop");
    assertSubagentParams({ action: "status", ...target }, "RPC stop target params");
    const asyncDirRoot = options.asyncDirRoot ?? ASYNC_DIR;
    const resultsDir = options.resultsDir ?? RESULTS_DIR;
    let location;
    try {
        location = resolveAsyncRunLocation(target, asyncDirRoot, resultsDir);
    }
    catch (error) {
        throw new SubagentRpcError("invalid_params", error instanceof Error ? error.message : String(error));
    }
    if (!location.asyncDir) {
        throw new SubagentRpcError("not_found", "Async run not found or already completed; stop requires a live async run directory.");
    }
    const currentSessionId = ctx.sessionManager.getSessionId();
    const initialStatus = readStatus(location.asyncDir);
    const initialRunId = initialStatus?.runId ?? location.resolvedId ?? path.basename(location.asyncDir);
    if (!initialStatus)
        throw new SubagentRpcError("not_found", `Status file not found for async run '${initialRunId}'.`);
    if (!currentSessionId || initialStatus.sessionId !== currentSessionId) {
        throw new SubagentRpcError("not_found", `Async run '${initialRunId}' was not found in the active session.`);
    }
    let status;
    try {
        status = reconcileAsyncRun(location.asyncDir, { resultsDir, kill: options.kill, now: options.now }).status;
    }
    catch (error) {
        throw new SubagentRpcError("execution_failed", error instanceof Error ? error.message : String(error));
    }
    const runId = status?.runId ?? initialRunId;
    if (!status)
        throw new SubagentRpcError("not_found", `Status file not found for async run '${runId}'.`);
    if (status.sessionId !== currentSessionId) {
        throw new SubagentRpcError("not_found", `Async run '${runId}' was not found in the active session.`);
    }
    if (status.state !== "running") {
        throw new SubagentRpcError("invalid_state", `Async run ${runId} is ${status.state}; stop only supports running async runs.`);
    }
    try {
        deliverTimeoutRequest({
            asyncDir: location.asyncDir,
            pid: status.pid,
            kill: options.kill,
            now: options.now,
            source: "rpc-stop",
        });
    }
    catch (error) {
        throw new SubagentRpcError("execution_failed", error instanceof Error ? error.message : String(error));
    }
    return {
        runId,
        asyncDir: location.asyncDir,
        previousState: status.state,
        state: "stopping",
        message: `Stop requested for async run ${runId}.`,
    };
}
async function handleRequest(request, options) {
    const ctx = options.getContext();
    if (request.method === "ping")
        return pingData(ctx);
    if (!ctx)
        throw new SubagentRpcError("no_active_session", "No active extension context for subagent RPC.");
    if (request.method === "spawn") {
        return executeChecked(options, ctx, request.requestId, request.method, spawnParams(request.params));
    }
    if (request.method === "status") {
        return executeChecked(options, ctx, request.requestId, request.method, { action: "status", ...normalizeTargetParams(request.params, "status") });
    }
    if (request.method === "interrupt") {
        return executeChecked(options, ctx, request.requestId, request.method, { action: "interrupt", ...normalizeTargetParams(request.params, "interrupt") });
    }
    if (request.method === "stop") {
        return stopAsyncRun(request.params, options, ctx);
    }
    throw new SubagentRpcError("unsupported_method", `Unsupported subagent RPC method: ${String(request.method)}`);
}
function parseRequest(raw) {
    if (!isRecord(raw))
        throw new SubagentRpcError("invalid_request", "Subagent RPC request must be an object.");
    const requestId = assertRequestId(raw.requestId);
    if (raw.version !== SUBAGENT_RPC_PROTOCOL_VERSION) {
        throw new SubagentRpcError("unsupported_version", `Unsupported subagent RPC version: ${String(raw.version)}.`);
    }
    if (typeof raw.method !== "string" || !SUBAGENT_RPC_METHODS.includes(raw.method)) {
        throw new SubagentRpcError("unsupported_method", `Unsupported subagent RPC method: ${String(raw.method)}.`);
    }
    return {
        version: SUBAGENT_RPC_PROTOCOL_VERSION,
        requestId,
        method: raw.method,
        ...(raw.params !== undefined ? { params: raw.params } : {}),
        ...(isRecord(raw.source) ? { source: raw.source } : {}),
    };
}
function safeReplyRequestId(raw) {
    if (!isRecord(raw))
        return "unknown";
    const requestId = raw.requestId;
    return typeof requestId === "string" && requestId.trim().length > 0 && !/[\r\n]/.test(requestId)
        ? requestId
        : "unknown";
}
function errorReply(raw, error) {
    const requestId = safeReplyRequestId(raw);
    const method = isRecord(raw) && typeof raw.method === "string" && SUBAGENT_RPC_METHODS.includes(raw.method)
        ? raw.method
        : undefined;
    const rpcError = error instanceof SubagentRpcError
        ? error
        : new SubagentRpcError("execution_failed", error instanceof Error ? error.message : String(error));
    return {
        version: SUBAGENT_RPC_PROTOCOL_VERSION,
        requestId,
        ...(method ? { method } : {}),
        success: false,
        error: {
            code: rpcError.code,
            message: rpcError.message,
        },
    };
}
export function registerSubagentRpcBridge(options) {
    const unsubscribe = options.events.on(SUBAGENT_RPC_REQUEST_EVENT, async (raw) => {
        let request;
        try {
            request = parseRequest(raw);
            const data = await handleRequest(request, options);
            options.events.emit(subagentRpcReplyEvent(request.requestId), {
                version: SUBAGENT_RPC_PROTOCOL_VERSION,
                requestId: request.requestId,
                method: request.method,
                success: true,
                data,
            });
        }
        catch (error) {
            const reply = errorReply(request ?? raw, error);
            options.events.emit(subagentRpcReplyEvent(reply.requestId), reply);
        }
    });
    return {
        emitReady: (ctx) => {
            options.events.emit(SUBAGENT_RPC_READY_EVENT, pingData(ctx ?? options.getContext()));
        },
        dispose: () => {
            if (typeof unsubscribe === "function")
                unsubscribe();
        },
    };
}

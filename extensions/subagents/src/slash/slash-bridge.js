import { SLASH_SUBAGENT_CANCEL_EVENT, SLASH_SUBAGENT_REQUEST_EVENT, SLASH_SUBAGENT_RESPONSE_EVENT, SLASH_SUBAGENT_STARTED_EVENT, SLASH_SUBAGENT_UPDATE_EVENT, } from "../shared/types.js";
const INVALID_SLASH_REQUEST_TEXT = "Unsupported slash subagent request.";
function resolveAllowedSlashSubagentParams(value) {
    try {
        if (!value || typeof value !== "object" || Array.isArray(value))
            return undefined;
        if (Object.getPrototypeOf(value) !== Object.prototype)
            return undefined;
        const keys = Reflect.ownKeys(value);
        if (keys.length === 1 && keys[0] === "action") {
            const action = Object.getOwnPropertyDescriptor(value, "action");
            return action?.enumerable && "value" in action && action.value === "doctor"
                ? { action: "doctor" }
                : undefined;
        }
        if (keys.length !== 2 || !keys.includes("action") || !keys.includes("view"))
            return undefined;
        const action = Object.getOwnPropertyDescriptor(value, "action");
        const view = Object.getOwnPropertyDescriptor(value, "view");
        return action?.enumerable &&
            "value" in action &&
            action.value === "status" &&
            view?.enumerable &&
            "value" in view &&
            view.value === "fleet"
            ? { action: "status", view: "fleet" }
            : undefined;
    }
    catch {
        return undefined;
    }
}
function invalidSlashSubagentResponse(requestId) {
    return {
        requestId,
        result: {
            content: [{ type: "text", text: INVALID_SLASH_REQUEST_TEXT }],
            details: { mode: "single", results: [] },
        },
        isError: true,
        errorText: INVALID_SLASH_REQUEST_TEXT,
    };
}
export function registerSlashSubagentBridge(options) {
    const controllers = new Map();
    const pendingCancels = new Set();
    const subscriptions = [];
    const subscribe = (event, handler) => {
        const unsubscribe = options.events.on(event, handler);
        if (typeof unsubscribe === "function")
            subscriptions.push(unsubscribe);
    };
    const rejectRequest = (requestId) => {
        pendingCancels.delete(requestId);
        options.events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, invalidSlashSubagentResponse(requestId));
    };
    subscribe(SLASH_SUBAGENT_CANCEL_EVENT, (data) => {
        if (!data || typeof data !== "object")
            return;
        const requestId = data.requestId;
        if (typeof requestId !== "string")
            return;
        const controller = controllers.get(requestId);
        if (controller) {
            controller.abort();
            return;
        }
        pendingCancels.add(requestId);
    });
    subscribe(SLASH_SUBAGENT_REQUEST_EVENT, async (data) => {
        if (!data || typeof data !== "object")
            return;
        let requestId;
        try {
            requestId = data.requestId;
        }
        catch {
            return;
        }
        if (typeof requestId !== "string" || requestId.length === 0)
            return;
        if (Array.isArray(data)) {
            rejectRequest(requestId);
            return;
        }
        let params;
        try {
            params = data.params;
        }
        catch {
            rejectRequest(requestId);
            return;
        }
        const allowedParams = resolveAllowedSlashSubagentParams(params);
        if (!allowedParams) {
            rejectRequest(requestId);
            return;
        }
        const request = data;
        let requesterContext;
        try {
            requesterContext = request.ctx;
        }
        catch {
            rejectRequest(requestId);
            return;
        }
        const ctx = requesterContext ?? options.getContext();
        if (!ctx) {
            pendingCancels.delete(requestId);
            const response = {
                requestId,
                result: {
                    content: [
                        { type: "text", text: "No active extension context for slash subagent execution." },
                    ],
                    details: { mode: "single", results: [] },
                },
                isError: true,
                errorText: "No active extension context.",
            };
            options.events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, response);
            return;
        }
        const controller = new AbortController();
        controllers.set(requestId, controller);
        if (pendingCancels.delete(requestId)) {
            controller.abort();
            const response = {
                requestId,
                result: {
                    content: [{ type: "text", text: "Cancelled." }],
                    details: { mode: "single", results: [] },
                },
                isError: true,
                errorText: "Cancelled before start.",
            };
            options.events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, response);
            controllers.delete(requestId);
            return;
        }
        options.events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
        try {
            const result = await options.execute(requestId, allowedParams, controller.signal, (update) => {
                const progress = update.details?.progress;
                const first = progress?.[0];
                const payload = {
                    requestId,
                    progress,
                    currentTool: first?.currentTool,
                    toolCount: first?.toolCount,
                };
                options.events.emit(SLASH_SUBAGENT_UPDATE_EVENT, payload);
            }, ctx);
            const response = {
                requestId,
                result,
                isError: result.isError === true,
                errorText: result.isError
                    ? result.content.find((c) => c.type === "text")?.text
                    : undefined,
            };
            options.events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, response);
        }
        catch (error) {
            const response = {
                requestId,
                result: {
                    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
                    details: { mode: "single", results: [] },
                },
                isError: true,
                errorText: error instanceof Error ? error.message : String(error),
            };
            options.events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, response);
        }
        finally {
            controllers.delete(requestId);
        }
    });
    return {
        cancelAll: () => {
            for (const controller of controllers.values()) {
                controller.abort();
            }
            controllers.clear();
            pendingCancels.clear();
        },
        dispose: () => {
            for (const unsubscribe of subscriptions)
                unsubscribe();
            subscriptions.length = 0;
            pendingCancels.clear();
        },
    };
}

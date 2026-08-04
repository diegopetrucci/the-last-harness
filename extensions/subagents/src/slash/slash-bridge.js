import { SLASH_SUBAGENT_CANCEL_EVENT, SLASH_SUBAGENT_REQUEST_EVENT, SLASH_SUBAGENT_RESPONSE_EVENT, SLASH_SUBAGENT_STARTED_EVENT, SLASH_SUBAGENT_UPDATE_EVENT, } from "../shared/types.js";
export function registerSlashSubagentBridge(options) {
    const controllers = new Map();
    const pendingCancels = new Set();
    const subscriptions = [];
    const subscribe = (event, handler) => {
        const unsubscribe = options.events.on(event, handler);
        if (typeof unsubscribe === "function")
            subscriptions.push(unsubscribe);
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
        const request = data;
        if (typeof request.requestId !== "string" || !request.params)
            return;
        const { requestId, params } = request;
        const ctx = request.ctx ?? options.getContext();
        if (!ctx) {
            const response = {
                requestId,
                result: {
                    content: [{ type: "text", text: "No active extension context for slash subagent execution." }],
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
            const result = await options.execute(requestId, params, controller.signal, (update) => {
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

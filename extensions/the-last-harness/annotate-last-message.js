import { openQuietGlimpse } from "../shared/quiet-glimpse.js";
import { composeAnnotateLastMessagePrompt, hasAnnotateLastMessageFeedback } from "./annotate-last-message/prompt.js";
import { findLastAssistantMessage } from "./annotate-last-message/session.js";
import { buildAnnotateLastMessageHtml } from "./annotate-last-message/ui.js";
function isSubmitPayload(value) {
    return typeof value === "object" && value != null && "type" in value && value.type === "submit";
}
function isCancelPayload(value) {
    return typeof value === "object" && value != null && "type" in value && value.type === "cancel";
}
function appendPrompt(ctx, prompt) {
    const prefix = ctx.ui.getEditorText().trim().length > 0 ? "\n\n" : "";
    ctx.ui.pasteToEditor(`${prefix}${prompt}`);
}
export const ANNOTATE_LAST_MESSAGE_COMMAND_DESCRIPTION = "Open a native annotation window for the latest assistant message";
export function buildAnnotateLastMessageCommand() {
    let activeWindow = null;
    const suppressedWindows = new WeakSet();
    function closeActiveWindow(options = {}) {
        if (activeWindow == null)
            return;
        const windowToClose = activeWindow;
        activeWindow = null;
        if (options.suppressResults) {
            suppressedWindows.add(windowToClose);
        }
        try {
            windowToClose.close();
        }
        catch {
        }
    }
    async function openAnnotationWindow(ctx) {
        if (!ctx.hasUI) {
            ctx.ui.notify("annotate-last-message requires interactive mode.", "error");
            return;
        }
        if (activeWindow != null) {
            ctx.ui.notify("A last-message annotation window is already open.", "warning");
            return;
        }
        const messageResult = findLastAssistantMessage(ctx.sessionManager.getBranch());
        if (messageResult.ok === false) {
            ctx.ui.notify(messageResult.message, "error");
            return;
        }
        const messageData = messageResult.data;
        try {
            const html = buildAnnotateLastMessageHtml(messageData);
            const window = await openQuietGlimpse(html, {
                width: 1440,
                height: 980,
                title: "TLH annotate last message",
            });
            activeWindow = window;
            const terminalMessagePromise = new Promise((resolve, reject) => {
                let settled = false;
                let closeTimer = null;
                const cleanup = () => {
                    if (closeTimer != null) {
                        clearTimeout(closeTimer);
                        closeTimer = null;
                    }
                    window.removeListener("message", onMessage);
                    window.removeListener("closed", onClosed);
                    window.removeListener("error", onError);
                    if (activeWindow === window) {
                        activeWindow = null;
                    }
                };
                const settle = (value) => {
                    if (settled)
                        return;
                    settled = true;
                    cleanup();
                    resolve(value);
                };
                const onMessage = (data) => {
                    if (isSubmitPayload(data) || isCancelPayload(data)) {
                        settle(data);
                    }
                };
                const onClosed = () => {
                    if (settled || closeTimer != null)
                        return;
                    closeTimer = setTimeout(() => {
                        closeTimer = null;
                        settle(null);
                    }, 250);
                };
                const onError = (error) => {
                    if (settled)
                        return;
                    settled = true;
                    cleanup();
                    reject(error);
                };
                window.on("message", onMessage);
                window.on("closed", onClosed);
                window.on("error", onError);
            });
            void (async (windowMessageSource, sourceData) => {
                try {
                    const result = await terminalMessagePromise;
                    if (suppressedWindows.has(windowMessageSource))
                        return;
                    if (result == null)
                        return;
                    if (result.type === "cancel") {
                        ctx.ui.notify("Annotation cancelled.", "info");
                        return;
                    }
                    if (!hasAnnotateLastMessageFeedback(result)) {
                        ctx.ui.notify("No annotation feedback submitted.", "info");
                        return;
                    }
                    const prompt = composeAnnotateLastMessagePrompt(sourceData, result);
                    appendPrompt(ctx, prompt);
                    ctx.ui.notify("Appended annotation feedback to the editor.", "info");
                }
                catch (error) {
                    if (suppressedWindows.has(windowMessageSource))
                        return;
                    const message = error instanceof Error ? error.message : String(error);
                    ctx.ui.notify(`Annotation failed: ${message}`, "error");
                }
            })(window, messageData);
            ctx.ui.notify("Opened native annotation window.", "info");
        }
        catch (error) {
            closeActiveWindow({ suppressResults: true });
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`Annotation failed: ${message}`, "error");
        }
    }
    return {
        handler: async (_args, ctx) => {
            await openAnnotationWindow(ctx);
        },
        handleSessionShutdown: () => {
            closeActiveWindow({ suppressResults: true });
        },
    };
}
export function registerAnnotateLastMessageCommand(pi) {
    const command = buildAnnotateLastMessageCommand();
    pi.registerCommand("annotate-last-message", {
        description: ANNOTATE_LAST_MESSAGE_COMMAND_DESCRIPTION,
        handler: command.handler,
    });
    pi.on("session_shutdown", async () => {
        command.handleSessionShutdown();
    });
}

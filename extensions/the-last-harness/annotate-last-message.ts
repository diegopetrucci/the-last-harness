import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { openQuietGlimpse, type QuietGlimpseWindow } from "../shared/quiet-glimpse.js";
import {
  composeAnnotateLastMessagePrompt,
  hasAnnotateLastMessageFeedback,
} from "./annotate-last-message/prompt.js";
import { findLastAssistantMessage } from "./annotate-last-message/session.js";
import type { ThemeGetters } from "./annotate-last-message/theme.js";
import type {
  AnnotateLastMessageCancelPayload,
  AnnotateLastMessageInlineComment,
  AnnotateLastMessageSectionComment,
  AnnotateLastMessageSubmitPayload,
  AnnotateLastMessageWindowMessage,
  LastAssistantMessageData,
} from "./annotate-last-message/types.js";
import { buildAnnotateLastMessageHtml } from "./annotate-last-message/ui.js";

function isInlineComment(value: unknown): value is AnnotateLastMessageInlineComment {
  return (
    typeof value === "object" &&
    value != null &&
    "line" in value &&
    typeof value.line === "number" &&
    Number.isInteger(value.line) &&
    value.line > 0 &&
    "body" in value &&
    typeof value.body === "string"
  );
}

function isSectionComment(value: unknown): value is AnnotateLastMessageSectionComment {
  return (
    typeof value === "object" &&
    value != null &&
    "sectionId" in value &&
    typeof value.sectionId === "string" &&
    "body" in value &&
    typeof value.body === "string"
  );
}

function isSubmitPayload(value: unknown): value is AnnotateLastMessageSubmitPayload {
  return (
    typeof value === "object" &&
    value != null &&
    "type" in value &&
    value.type === "submit" &&
    "overallComment" in value &&
    typeof value.overallComment === "string" &&
    "inlineComments" in value &&
    Array.isArray(value.inlineComments) &&
    value.inlineComments.every(isInlineComment) &&
    "sectionComments" in value &&
    Array.isArray(value.sectionComments) &&
    value.sectionComments.every(isSectionComment)
  );
}

function isCancelPayload(value: unknown): value is AnnotateLastMessageCancelPayload {
  return typeof value === "object" && value != null && "type" in value && value.type === "cancel";
}

export const ANNOTATE_LAST_MESSAGE_COMMAND_DESCRIPTION =
  "Open a native annotation window for the latest assistant message";

type AnnotateLastMessageCommand = {
  handler: (_args: string, ctx: ExtensionCommandContext) => Promise<void>;
  handleSessionShutdown: () => void;
};

type AnnotateLastMessageDependencies = {
  sendUserMessage: (message: string, options: { deliverAs: "followUp" }) => void;
  openAnnotationWindow?: typeof openQuietGlimpse;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  getTheme?: ThemeGetters;
};

export function buildAnnotateLastMessageCommand(
  dependencies: AnnotateLastMessageDependencies,
): AnnotateLastMessageCommand {
  const openAnnotationWindow = dependencies.openAnnotationWindow ?? openQuietGlimpse;
  const setTimer = dependencies.setTimeoutFn ?? setTimeout;
  const clearTimer = dependencies.clearTimeoutFn ?? clearTimeout;
  const sendUserMessage = dependencies.sendUserMessage;

  let activeWindow: QuietGlimpseWindow | null = null;
  let lifecycleGeneration = 0;
  let openingGeneration: number | null = null;
  const suppressedWindows = new WeakSet<QuietGlimpseWindow>();

  function closeActiveWindow(options: { suppressResults?: boolean } = {}): void {
    if (activeWindow == null) return;
    const windowToClose = activeWindow;
    activeWindow = null;
    if (options.suppressResults) {
      suppressedWindows.add(windowToClose);
    }
    try {
      windowToClose.close();
    } catch {
      // Ignore races when the native window is already closing.
    }
  }

  async function openWindowForContext(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("annotate-last-message requires interactive mode.", "error");
      return;
    }
    if (activeWindow != null || openingGeneration != null) {
      ctx.ui.notify("A last-message annotation window is already open.", "warning");
      return;
    }

    const messageResult = findLastAssistantMessage(ctx.sessionManager.getBranch());
    if (messageResult.ok === false) {
      ctx.ui.notify(messageResult.message, "error");
      return;
    }

    const messageData = messageResult.data;
    const generation = lifecycleGeneration;
    openingGeneration = generation;

    try {
      const html = buildAnnotateLastMessageHtml(messageData, dependencies.getTheme);
      const window = await openAnnotationWindow(html, {
        width: 1440,
        height: 980,
        title: "TLH annotate last message",
      });
      if (generation !== lifecycleGeneration) {
        suppressedWindows.add(window);
        try {
          window.close();
        } catch {
          // Ignore races when the native window is already closing.
        }
        return;
      }
      activeWindow = window;
      openingGeneration = null;

      const terminalMessagePromise = new Promise<AnnotateLastMessageWindowMessage | null>(
        (resolve, reject) => {
          let settled = false;
          let closeTimer: ReturnType<typeof setTimer> | null = null;

          const cleanup = (): void => {
            if (closeTimer != null) {
              clearTimer(closeTimer);
              closeTimer = null;
            }
            window.removeListener("message", onMessage);
            window.removeListener("closed", onClosed);
            window.removeListener("error", onError);
            if (activeWindow === window) {
              activeWindow = null;
            }
          };

          const settle = (value: AnnotateLastMessageWindowMessage | null): void => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
          };

          const onMessage = (data: unknown): void => {
            if (isSubmitPayload(data) || isCancelPayload(data)) {
              settle(data);
            }
          };

          const onClosed = (): void => {
            if (settled || closeTimer != null) return;
            closeTimer = setTimer(() => {
              closeTimer = null;
              settle(null);
            }, 250);
          };

          const onError = (error: unknown): void => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
          };

          window.on("message", onMessage);
          window.on("closed", onClosed);
          window.on("error", onError);
        },
      );

      void (async (
        windowMessageSource: QuietGlimpseWindow,
        sourceData: LastAssistantMessageData,
        windowLifecycleGeneration: number,
      ) => {
        try {
          const result = await terminalMessagePromise;
          if (suppressedWindows.has(windowMessageSource)) return;
          if (windowLifecycleGeneration !== lifecycleGeneration) return;
          if (result == null) return;
          if (result.type === "cancel") {
            ctx.ui.notify("Annotation cancelled.", "info");
            return;
          }
          if (!hasAnnotateLastMessageFeedback(result)) {
            ctx.ui.notify("No annotation feedback submitted.", "info");
            return;
          }

          const prompt = composeAnnotateLastMessagePrompt(sourceData, result);
          sendUserMessage(prompt, { deliverAs: "followUp" });
          ctx.ui.notify("Annotation feedback sent to the agent.", "info");
        } catch (error) {
          if (suppressedWindows.has(windowMessageSource)) return;
          if (windowLifecycleGeneration !== lifecycleGeneration) return;
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Annotation failed: ${message}`, "error");
        }
      })(window, messageData, generation);

      ctx.ui.notify("Opened native annotation window.", "info");
    } catch (error) {
      if (generation !== lifecycleGeneration) {
        return;
      }
      closeActiveWindow({ suppressResults: true });
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Annotation failed: ${message}`, "error");
    } finally {
      if (openingGeneration === generation) {
        openingGeneration = null;
      }
    }
  }

  return {
    handler: async (_args, ctx) => {
      await openWindowForContext(ctx);
    },
    handleSessionShutdown: () => {
      lifecycleGeneration += 1;
      openingGeneration = null;
      closeActiveWindow({ suppressResults: true });
    },
  };
}

export function registerAnnotateLastMessageCommand(pi: ExtensionAPI): void {
  const command = buildAnnotateLastMessageCommand({
    sendUserMessage: (message, options) => pi.sendUserMessage(message, options),
  });
  pi.registerCommand("annotate-last-message", {
    description: ANNOTATE_LAST_MESSAGE_COMMAND_DESCRIPTION,
    handler: command.handler,
  });

  pi.on("session_shutdown", async () => {
    command.handleSessionShutdown();
  });
}

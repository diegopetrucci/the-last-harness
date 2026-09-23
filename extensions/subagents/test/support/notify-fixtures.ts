import { EventEmitter } from "node:events";
import registerSubagentNotify from "../../src/runs/background/notify.ts";

export const NUDGE_TEXT = "[tlh] Background subagent completed — see notification above.";

export function createPi(currentSessionId = "session-1") {
  const events = new EventEmitter();
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const sentUserMessages: Array<{ content: unknown; options: unknown }> = [];
  const lifecycleHandlers = new Map<string, (...args: unknown[]) => void>();
  const pi = {
    events,
    on(event: string, handler: (...args: unknown[]) => void) {
      lifecycleHandlers.set(event, handler);
    },
    sendMessage(message: unknown, options?: unknown) {
      sentMessages.push({ message, options });
    },
    sendUserMessage(content: unknown, options?: unknown) {
      sentUserMessages.push({ content, options });
    },
  };

  registerSubagentNotify(pi as never, { currentSessionId });
  return { events, sentMessages, sentUserMessages, lifecycleHandlers };
}

export function completionResult(overrides: Record<string, unknown> = {}) {
  return {
    id: `notify-${Math.random().toString(36).slice(2)}`,
    agent: "worker",
    success: true,
    summary: "Done",
    exitCode: 0,
    timestamp: 123,
    sessionId: "session-a",
    ...overrides,
  };
}

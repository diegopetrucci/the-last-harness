import { EventEmitter } from "node:events";
import registerSubagentNotify from "../../src/runs/background/notify.ts";

export function createPi(currentSessionId = "session-1") {
  const events = new EventEmitter();
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  // Messages sent with { triggerTurn: true } — the native wake of an idle parent.
  const wakes: Array<{ message: unknown; options: unknown }> = [];
  const lifecycleHandlers = new Map<string, (...args: unknown[]) => void>();
  const pi = {
    events,
    on(event: string, handler: (...args: unknown[]) => void) {
      lifecycleHandlers.set(event, handler);
    },
    sendMessage(message: unknown, options?: unknown) {
      sentMessages.push({ message, options });
      if ((options as { triggerTurn?: boolean } | undefined)?.triggerTurn) {
        wakes.push({ message, options });
      }
    },
    sendUserMessage() {
      throw new Error("notify must not send a synthetic user message (#470)");
    },
  };

  registerSubagentNotify(pi as never, { currentSessionId });
  return { events, sentMessages, wakes, lifecycleHandlers };
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

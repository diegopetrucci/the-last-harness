import { EventEmitter } from "node:events";
import type { SubagentTerminalResult } from "../../src/shared/types.ts";
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

export function terminalResult(): SubagentTerminalResult {
  return {
    state: "completed",
    facts: {
      attempts: [
        {
          attempt: 1,
          exit: { code: 0, signal: null },
          durationMs: 12,
          providerTokens: { status: "unavailable" },
          requestedToolCalls: { edit: 1, write: 0, bash: 2 },
          workspace: {
            baseline: { status: "unavailable", reason: "not_git_repository" },
            post: { status: "unavailable", reason: "not_git_repository" },
            attribution: "unknown",
          },
        },
      ],
    },
  };
}

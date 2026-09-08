import { EventEmitter } from "node:events";
import registerSubagentNotify, {
  type RegisterSubagentNotifyOptions,
} from "../../src/runs/background/notify.ts";

export const NUDGE_TEXT = "[tlh] Background subagent completed — see notification above.";

export function createPi(
  currentSessionId = "session-1",
  registerOptions: RegisterSubagentNotifyOptions = {},
) {
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

  // Formatting-focused tests run with batching disabled so single completions
  // emit synchronously. Batching behavior is covered by the dedicated suite below.
  registerSubagentNotify(
    pi as never,
    { currentSessionId },
    { batchConfig: { enabled: false }, ...registerOptions },
  );

  return { events, sentMessages, sentUserMessages, lifecycleHandlers };
}

export function createBatchingPi(
  clock: ReturnType<typeof createFakeClock>,
  currentSessionId = "session-a",
) {
  const events = new EventEmitter();
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const sentUserMessages: Array<{ content: unknown; options: unknown }> = [];
  const lifecycleHandlers = new Map<string, (...args: unknown[]) => void>();
  const state = { currentSessionId };
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
  registerSubagentNotify(pi as never, state, {
    batchConfig: {
      enabled: true,
      debounceMs: 150,
      maxWaitMs: 1000,
      stragglerDebounceMs: 75,
      stragglerMaxWaitMs: 400,
      stragglerWindowMs: 2000,
    },
    timers: clock.api,
    now: clock.now,
  });
  return { events, sentMessages, sentUserMessages, state, lifecycleHandlers };
}

interface FakeJob {
  id: number;
  fireAt: number;
  handler: () => void;
}

export function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const jobs = new Map<number, FakeJob>();
  const api = {
    setTimeout(handler: () => void, delayMs: number): number {
      const id = nextId++;
      jobs.set(id, { id, fireAt: now + delayMs, handler });
      return id;
    },
    clearTimeout(handle: number): void {
      if (typeof handle === "number") jobs.delete(handle);
    },
  };
  return {
    api,
    now: () => now,
    advance(ms: number): void {
      now += ms;
      const due = [...jobs.values()]
        .filter((job) => job.fireAt <= now)
        .sort((a, b) => a.fireAt - b.fireAt);
      for (const job of due) {
        if (!jobs.has(job.id)) continue;
        jobs.delete(job.id);
        job.handler();
      }
    },
  };
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

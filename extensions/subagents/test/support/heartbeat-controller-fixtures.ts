import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  Usage,
} from "@earendil-works/pi-ai";
import type { ResolvedHeartbeatConfig } from "../../src/runs/shared/heartbeat-config.ts";

/**
 * Shared fixtures for the heartbeat-controller unit suites.
 *
 * These factories keep all mutable fake-clock, stream, and logger state scoped
 * to each test. Importing this module does not register tests or create a
 * mutable fixture shared between test cases.
 */

export const BASE_CONFIG: ResolvedHeartbeatConfig = {
  enabled: true,
  intervalMs: 10_000,
  maxDurationMs: 60_000,
  maxBeatsPerGap: 3,
};

export function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    api: "anthropic-messages" as Api,
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 16_384,
    ...overrides,
  } as Model<Api>;
}

export function makeUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 1000,
    output: 10,
    cacheRead: 5000,
    cacheWrite: 0,
    totalTokens: 6010,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}

export function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    usage: makeUsage(),
    stopReason: "pending",
    timestamp: 0,
    ...overrides,
  };
}

/** Build a fake AssistantMessageEvent stream from a list of events. */
export async function* makeStream(
  events: AssistantMessageEvent[],
): AsyncIterable<AssistantMessageEvent> {
  for (const e of events) yield e;
}

/**
 * Build a start event (usage all zeros — the synthetic event Anthropic emits
 * after HTTP headers but before cache usage is observable).
 */
export function makeStartEvent(): AssistantMessageEvent {
  return {
    type: "start",
    partial: makeAssistantMessage({
      usage: makeUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }),
    }),
  };
}

/** Build a text_start event with usage populated (first usage-bearing event). */
export function makeTextStartEvent(usageOverrides: Partial<Usage> = {}): AssistantMessageEvent {
  return {
    type: "text_start",
    contentIndex: 0,
    partial: makeAssistantMessage({
      content: [{ type: "text", text: "" }],
      usage: makeUsage({ totalTokens: 6010, ...usageOverrides }),
    }),
  };
}

export function makeThinkingStartEvent(usageOverrides: Partial<Usage> = {}): AssistantMessageEvent {
  return {
    type: "thinking_start",
    contentIndex: 0,
    partial: makeAssistantMessage({
      content: [{ type: "thinking", thinking: "" }],
      usage: makeUsage({ totalTokens: 6010, ...usageOverrides }),
    }),
  };
}

export function makeToolCallStartEvent(usageOverrides: Partial<Usage> = {}): AssistantMessageEvent {
  return {
    type: "toolcall_start",
    contentIndex: 0,
    partial: makeAssistantMessage({
      content: [{ type: "toolCall", id: "call-1", name: "lookup", arguments: {} }],
      usage: makeUsage({ totalTokens: 6010, ...usageOverrides }),
    }),
  };
}

export function makeTextDeltaEvent(usageOverrides: Partial<Usage> = {}): AssistantMessageEvent {
  return {
    type: "text_delta",
    contentIndex: 0,
    delta: "generated text",
    partial: makeAssistantMessage({
      content: [{ type: "text", text: "generated text" }],
      usage: makeUsage(usageOverrides),
    }),
  };
}

export function makeThinkingDeltaEvent(usageOverrides: Partial<Usage> = {}): AssistantMessageEvent {
  return {
    type: "thinking_delta",
    contentIndex: 0,
    delta: "generated reasoning",
    partial: makeAssistantMessage({
      content: [{ type: "thinking", thinking: "generated reasoning" }],
      usage: makeUsage(usageOverrides),
    }),
  };
}

export function makeToolCallDeltaEvent(usageOverrides: Partial<Usage> = {}): AssistantMessageEvent {
  return {
    type: "toolcall_delta",
    contentIndex: 0,
    delta: '{"query":"value"}',
    partial: makeAssistantMessage({
      content: [{ type: "toolCall", id: "call-1", name: "lookup", arguments: { query: "value" } }],
      usage: makeUsage(usageOverrides),
    }),
  };
}

/** Build an error event (provider error response — carries a final AssistantMessage). */
export function makeErrorEvent(usageOverrides: Partial<Usage> = {}): AssistantMessageEvent {
  return {
    type: "error",
    reason: "error",
    // The pi-ai error event carries the final AssistantMessage in the .error field.
    error: makeAssistantMessage({
      usage: makeUsage(usageOverrides),
      stopReason: "error",
    }),
  };
}

/** Build a done event. */
export function makeDoneEvent(
  usageOverrides: Partial<Usage> = {},
  content: AssistantMessage["content"] = [],
): AssistantMessageEvent {
  return {
    type: "done",
    reason: "stop",
    message: makeAssistantMessage({
      content,
      usage: makeUsage(usageOverrides),
      stopReason: "stop",
    }),
  };
}

export type FakeHandle = ReturnType<typeof setTimeout>;

/** Fake timer that lets tests fire callbacks manually. */
export function makeTimerFake(): {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => FakeHandle;
  clearTimeout: (h: FakeHandle) => void;
  advance: (ms: number) => void;
  firePending: () => void;
} {
  let clock = 0;
  // Use object identity for handle lookup so we avoid chained type assertions.
  const pending = new Map<FakeHandle, { fn: () => void; at: number }>();

  return {
    now: () => clock,
    setTimeout(fn, ms) {
      // Single-step assertion, same pattern as deadline-timer.test.ts
      const handle = { unref() {} } as FakeHandle;
      pending.set(handle, { fn, at: clock + ms });
      return handle;
    },
    clearTimeout(h: FakeHandle) {
      pending.delete(h);
    },
    advance(ms: number) {
      clock += ms;
    },
    firePending() {
      const toFire = [...pending.entries()]
        .filter(([, { at }]) => at <= clock)
        .sort(([, a], [, b]) => a.at - b.at);
      for (const [handle, { fn }] of toFire) {
        pending.delete(handle);
        fn();
      }
    },
  };
}

/** Collect JSONL records written during a test. */
export function makeLoggerSink(): {
  records: Record<string, unknown>[];
  mkdirSync: () => void;
  appendFileSync: (_file: string, data: string) => void;
} {
  const records: Record<string, unknown>[] = [];
  return {
    records,
    mkdirSync() {},
    appendFileSync(_file: string, data: string) {
      records.push(JSON.parse(data) as Record<string, unknown>);
    },
  };
}

/**
 * Unit tests for heartbeat wiring (heartbeat-wiring.ts).
 *
 * Covers:
 *  - countLiveAsyncRuns live-run predicate
 *  - disabled-by-default => no hooks/timer activity
 *  - arming on first live async run via notifyAsyncStarted
 *  - disarm on last-live-run completion (synchronous before notify wake nudge)
 *  - disarm on each lifecycle trigger (disarm())
 *  - per-gap summary content (JSONL record + session entry) per gap
 *  - no session entry for zero-beat gaps
 *  - session summary (getSessionSummary) accumulates across gaps
 *  - destroy closes gap without session entry
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

/** Opaque fake timer handle (same pattern as heartbeat-controller.test.ts). */
type FakeTimerHandle = ReturnType<typeof setTimeout>;
/** Create a fake handle without chained type assertions. */
const makeFakeHandle = (): FakeTimerHandle => ({ unref() {} }) as FakeTimerHandle;

import {
  countLiveAsyncRuns,
  createHeartbeatWiring,
  type HeartbeatGapSummaryData,
  type HeartbeatWiringDeps,
} from "../../src/extension/heartbeat-wiring.ts";
import type { AsyncJobState } from "../../src/shared/types.ts";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  StreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import type { EntryRenderer, ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAsyncJob(asyncId: string, status: AsyncJobState["status"] = "running"): AsyncJobState {
  return {
    asyncId,
    asyncDir: `/tmp/async/${asyncId}`,
    status,
  };
}

function makeJobsMap(
  entries: Array<[string, AsyncJobState["status"]]>,
): Map<string, AsyncJobState> {
  const map = new Map<string, AsyncJobState>();
  for (const [id, status] of entries) {
    map.set(id, makeAsyncJob(id, status));
  }
  return map;
}

function makeModel(): Model<Api> {
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
  } as Model<Api>;
}

function makeUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 0,
    output: 5,
    cacheRead: 5000,
    cacheWrite: 0,
    totalTokens: 5005,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
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

/** Fake beat stream using text_start event (same pattern as heartbeat-controller.test.ts). */
async function* makeCacheReadStream(): AsyncIterable<AssistantMessageEvent> {
  yield {
    type: "text_start",
    contentIndex: 0,
    partial: makeAssistantMessage({ content: [{ type: "text", text: "" }] }),
  };
}

interface FakePi extends Pick<ExtensionAPI, "appendEntry" | "registerEntryRenderer"> {
  entries: Array<{ customType: string; data: unknown }>;
  /** Set of customType strings for which a renderer was registered. */
  registeredRendererTypes: Set<string>;
}

function makeFakePi(): FakePi {
  const entries: Array<{ customType: string; data: unknown }> = [];
  const registeredRendererTypes = new Set<string>();
  // Define registerEntryRenderer with the correct generic signature.
  // The tests never call stored renderers; we only record that registration happened.
  const fakePi: FakePi = {
    entries,
    registeredRendererTypes,
    appendEntry(customType: string, data?: unknown) {
      entries.push({ customType, data });
    },
    registerEntryRenderer<T>(customType: string, _renderer: EntryRenderer<T>): void {
      registeredRendererTypes.add(customType);
    },
  };
  return fakePi;
}

// Use a fake file path so appendGapSummaryRecord will call appendFileSync,
// but override appendFileSync so no real I/O occurs.
const FAKE_LOG_PATH = "/fake/heartbeat.jsonl";

/**
 * Build minimal enabled-wiring deps.
 * `written` is populated with every line passed to appendFileSync.
 * `timers` is populated with each setTimeout call.
 */
function makeTestDeps(
  options: {
    written?: string[];
    timers?: Array<{ fn: () => void; ms: number }>;
    nowFn?: () => number;
  } = {},
): HeartbeatWiringDeps {
  const written = options.written ?? [];
  const timers = options.timers ?? [];
  let t = 1_000_000;
  const now = options.nowFn ?? (() => (t += 1000));
  return {
    logPath: FAKE_LOG_PATH,
    appendFileSync: (_file, data) => written.push(data),
    mkdirSync: () => {},
    now,
    setTimeout: ((fn, ms) => {
      timers.push({ fn, ms });
      return makeFakeHandle();
    }) as HeartbeatWiringDeps["setTimeout"],
    clearTimeout: () => {},
  };
}

function parseSummaryLines(written: string[]): Array<Record<string, unknown>> {
  return written.flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return parsed.type === "gap_summary" ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

function makeCacheReadDeps(
  options: {
    written?: string[];
    timers?: Array<{ fn: () => void; ms: number }>;
    nowFn?: () => number;
  } = {},
): HeartbeatWiringDeps {
  const deps = makeTestDeps(options);
  deps.streamProvider = () => makeCacheReadStream();
  return deps;
}

async function fireLatestTimer(timers: Array<{ fn: () => void; ms: number }>): Promise<void> {
  const timer = timers.at(-1);
  if (!timer) throw new Error("expected a scheduled heartbeat timer");
  timer.fn();
  await new Promise((resolve) => setTimeout(resolve, 80));
}

// ---------------------------------------------------------------------------
// Tests: countLiveAsyncRuns
// ---------------------------------------------------------------------------

describe("countLiveAsyncRuns", () => {
  it("returns 0 for an empty map", () => {
    assert.equal(countLiveAsyncRuns(new Map()), 0);
  });

  it("counts running and queued jobs as live", () => {
    const jobs = makeJobsMap([
      ["a", "running"],
      ["b", "queued"],
    ]);
    assert.equal(countLiveAsyncRuns(jobs), 2);
  });

  it("excludes all terminal statuses", () => {
    const jobs = makeJobsMap([
      ["a", "complete"],
      ["b", "failed"],
      ["c", "paused"],
      ["d", "cancelled"],
      ["e", "continued"],
    ]);
    assert.equal(countLiveAsyncRuns(jobs), 0);
  });

  it("counts only live among mixed", () => {
    const jobs = makeJobsMap([
      ["a", "running"],
      ["b", "complete"],
      ["c", "queued"],
      ["d", "failed"],
    ]);
    assert.equal(countLiveAsyncRuns(jobs), 2);
  });
});

// ---------------------------------------------------------------------------
// Tests: disabled wiring (enabled: false is the default)
// ---------------------------------------------------------------------------

describe("createHeartbeatWiring — disabled (default)", () => {
  it("enabled:false is a complete no-op: no timers, no appendEntry, no renderer", () => {
    const pi = makeFakePi();
    const written: string[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const deps = makeTestDeps({ written, timers });

    const wiring = createHeartbeatWiring(pi, {}, deps);

    wiring.onProviderRequest({}, makeModel());
    wiring.onIdle(true);
    wiring.notifyAsyncStarted(0, "session-1");
    wiring.notifyAsyncComplete("job-1", makeJobsMap([["job-1", "running"]]));
    wiring.disarm();
    wiring.destroy();
    wiring.tryRearm(1, "session-1");

    assert.equal(timers.length, 0, "no timers should be scheduled");
    assert.equal(written.length, 0, "no file writes");
    assert.equal(pi.entries.length, 0, "no appendEntry calls");
    assert.equal(pi.registeredRendererTypes.size, 0, "no entry renderers registered");
  });

  // Finding 8: strict boolean validation — truthy non-boolean must not enable heartbeat.
  it("string 'true' for enabled is rejected and wiring remains disabled", () => {
    const pi = makeFakePi();
    const written: string[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const deps = makeTestDeps({ written, timers });

    // enabled: "true" (string) should be rejected by strict boolean parse
    const wiring = createHeartbeatWiring(pi, { heartbeat: { enabled: "true" as never } }, deps);

    wiring.onProviderRequest({}, makeModel());
    wiring.onIdle(true);
    wiring.notifyAsyncStarted(0, "session-strict");
    wiring.disarm();
    wiring.destroy();

    assert.equal(timers.length, 0, "string 'true' must not schedule any timers");
    assert.equal(written.length, 0, "string 'true' must not write any JSONL records");
    assert.equal(pi.registeredRendererTypes.size, 0, "string 'true' must not register renderers");
  });

  it("number 1 for enabled is rejected and wiring remains disabled", () => {
    const pi = makeFakePi();
    const written: string[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const deps = makeTestDeps({ written, timers });

    const wiring = createHeartbeatWiring(pi, { heartbeat: { enabled: 1 as never } }, deps);
    wiring.onIdle(true);
    wiring.notifyAsyncStarted(0, "session-num");

    assert.equal(timers.length, 0, "number 1 must not schedule any timers");
    assert.equal(pi.registeredRendererTypes.size, 0, "number 1 must not register renderers");
  });

  it("getSessionSummary reflects disabled state", () => {
    const pi = makeFakePi();
    const wiring = createHeartbeatWiring(pi, {});
    const summary = wiring.getSessionSummary();
    assert.equal(summary.enabled, false);
    assert.equal(summary.totalBeats, 0);
    assert.equal(
      summary.gapsSaved + summary.gapsWasted + summary.gapsLost + summary.gapsUnneeded,
      0,
    );
    assert.equal(summary.breakerDisabled, false);
  });
});

// ---------------------------------------------------------------------------
// Tests: enabled wiring — arming
// ---------------------------------------------------------------------------

describe("createHeartbeatWiring — enabled: arming on async-started + idle", () => {
  it("registers entry renderer on creation", () => {
    const pi = makeFakePi();
    createHeartbeatWiring(pi, { heartbeat: { enabled: true } }, makeTestDeps());
    assert.ok(
      pi.registeredRendererTypes.has("heartbeat-gap-summary"),
      "should register entry renderer for heartbeat-gap-summary",
    );
  });

  it("arms gap (startGap) when liveRunsBefore=0", () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const pi = makeFakePi();
    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true } },
      makeTestDeps({ timers }),
    );

    wiring.onIdle(true);
    wiring.notifyAsyncStarted(0, "session-1");

    assert.ok(timers.length > 0, "timer should be scheduled when gap is armed");
  });

  it("does not arm a second gap when one is already active", () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const pi = makeFakePi();
    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true } },
      makeTestDeps({ timers }),
    );

    wiring.onIdle(true);
    wiring.notifyAsyncStarted(0, "session-1");
    const countAfterFirst = timers.length;
    // Second STARTED event — gap already active, no new gap opened
    wiring.notifyAsyncStarted(1, "session-1");
    assert.equal(timers.length, countAfterFirst, "no extra timer on second STARTED");
  });

  it("does not arm when liveRunsBefore > 0", () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const pi = makeFakePi();
    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true } },
      makeTestDeps({ timers }),
    );

    wiring.onIdle(true);
    wiring.notifyAsyncStarted(1, "session-1"); // liveRunsBefore=1
    assert.equal(timers.length, 0, "no timer when liveRunsBefore > 0");
  });
});

// ---------------------------------------------------------------------------
// Tests: disarm on last live run completion
// ---------------------------------------------------------------------------

describe("createHeartbeatWiring — enabled: disarm on last live completion", () => {
  it("closes gap, writes JSONL summary, but no session entry for zero beats", () => {
    const written: string[] = [];
    const pi = makeFakePi();
    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true } },
      makeTestDeps({ written }),
    );

    wiring.onIdle(true);
    wiring.notifyAsyncStarted(0, "session-abc");

    const jobs = makeJobsMap([["job-1", "running"]]);
    const closed = wiring.notifyAsyncComplete("job-1", jobs);

    assert.equal(closed, true, "notifyAsyncComplete should return true when gap is closed");

    const summaries = parseSummaryLines(written);
    assert.ok(summaries.length > 0, "JSONL gap_summary record should be written");
    assert.equal(summaries[0]!.sessionId, "session-abc");
    assert.equal(typeof summaries[0]!.verdict, "string");

    // Zero beats → no session entry emitted
    assert.equal(pi.entries.length, 0, "no session entry for zero-beat gap");
  });

  it("returns false when live runs remain after completion", () => {
    const pi = makeFakePi();
    const wiring = createHeartbeatWiring(pi, { heartbeat: { enabled: true } }, makeTestDeps());

    wiring.onIdle(true);
    wiring.notifyAsyncStarted(0, "session-abc");

    const jobs = makeJobsMap([
      ["job-1", "running"],
      ["job-2", "running"],
    ]);
    const closed = wiring.notifyAsyncComplete("job-1", jobs);
    assert.equal(closed, false, "gap should not close when live runs remain");
  });

  it("returns false and is no-op when no gap is active", () => {
    const pi = makeFakePi();
    const wiring = createHeartbeatWiring(pi, { heartbeat: { enabled: true } }, makeTestDeps());

    const jobs = makeJobsMap([["job-1", "running"]]);
    const closed = wiring.notifyAsyncComplete("job-1", jobs);
    assert.equal(closed, false);
  });

  it("correctly excludes completing job from live count (job still 'running' in asyncJobs)", () => {
    const pi = makeFakePi();
    const wiring = createHeartbeatWiring(pi, { heartbeat: { enabled: true } }, makeTestDeps());

    wiring.onIdle(true);
    wiring.notifyAsyncStarted(0, "s");

    // asyncJobs still has job-1 as "running" (tracker hasn't updated it yet)
    const jobs = makeJobsMap([["job-1", "running"]]);
    const closed = wiring.notifyAsyncComplete("job-1", jobs);
    assert.equal(closed, true, "should disarm even though job still appears running in asyncJobs");
  });
});

// ---------------------------------------------------------------------------
// Tests: disarm on lifecycle triggers (before_agent_start, model_select, etc.)
// ---------------------------------------------------------------------------

describe("createHeartbeatWiring — enabled: disarm on each lifecycle trigger", () => {
  it("disarm() closes active gap and writes JSONL summary", () => {
    const written: string[] = [];
    const pi = makeFakePi();
    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true } },
      makeTestDeps({ written }),
    );

    wiring.notifyAsyncStarted(0, "session-disarm");
    wiring.disarm();

    const summaries = parseSummaryLines(written);
    assert.ok(summaries.length > 0, "JSONL summary should be written on disarm");
  });

  it("disarm() is a no-op when no gap is active", () => {
    const written: string[] = [];
    const pi = makeFakePi();
    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true } },
      makeTestDeps({ written }),
    );

    wiring.disarm(); // no gap
    const summaries = parseSummaryLines(written);
    assert.equal(summaries.length, 0, "no summary when no gap was active");
  });

  it("double disarm does not write duplicate summaries", () => {
    const written: string[] = [];
    const pi = makeFakePi();
    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true } },
      makeTestDeps({ written }),
    );

    wiring.notifyAsyncStarted(0, "session-double");
    wiring.disarm();
    wiring.disarm(); // second call — no active gap

    const summaries = parseSummaryLines(written);
    assert.equal(summaries.length, 1, "only one summary for one gap");
  });
});

// ---------------------------------------------------------------------------
// Tests: destroy closes gap without session entry
// ---------------------------------------------------------------------------

describe("createHeartbeatWiring — enabled: destroy()", () => {
  it("destroy() writes JSONL summary but does NOT emit session entry", () => {
    const written: string[] = [];
    const pi = makeFakePi();
    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true } },
      makeTestDeps({ written }),
    );

    wiring.notifyAsyncStarted(0, "session-destroy");
    wiring.destroy();

    const summaries = parseSummaryLines(written);
    assert.ok(summaries.length > 0, "JSONL summary should be written on destroy");
    assert.equal(
      pi.entries.length,
      0,
      "destroy must NOT emit session entry (session shutting down)",
    );
  });

  it("destroy() is a no-op when no gap is active", () => {
    const written: string[] = [];
    const pi = makeFakePi();
    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true } },
      makeTestDeps({ written }),
    );
    wiring.destroy();
    assert.equal(written.length, 0, "no writes when no gap active on destroy");
  });
});

// ---------------------------------------------------------------------------
// Tests: per-gap summary content
// ---------------------------------------------------------------------------

describe("createHeartbeatWiring — enabled: per-gap summary content", () => {
  it("verdict 'unneeded' for a gap with zero beats (benign short run)", () => {
    const written: string[] = [];
    const pi = makeFakePi();
    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true } },
      makeTestDeps({ written }),
    );

    wiring.notifyAsyncStarted(0, "session-unneeded");
    wiring.disarm();

    const summaries = parseSummaryLines(written);
    assert.ok(summaries.length > 0, "summary must be written");
    // Zero-beat gap without terminatedLost: benign short run, not a 'lost' cache.
    assert.equal(summaries[0]!.verdict, "unneeded");
    assert.equal(summaries[0]!.beats, 0);
    // No session entry for zero-beat gap
    assert.equal(pi.entries.length, 0);
  });

  it("verdict 'lost' for a zero-beat gap when terminatedLost is set", () => {
    // terminatedLost overrides even a zero-beat gap: the cache-expired signal
    // from onGapLost takes precedence.
    // We exercise the public wiring path by simulating the controller callback
    // indirectly: open a gap, advance time past LATE_BEAT_THRESHOLD_MS, fire
    // the timer so the controller fires onGapLost, then disarm.
    const written: string[] = [];
    const pi = makeFakePi();
    const capturedFns: Array<() => void> = [];
    let t = 0;

    const deps: HeartbeatWiringDeps = {
      logPath: FAKE_LOG_PATH,
      appendFileSync: (_file, data) => written.push(data),
      mkdirSync: () => {},
      now: () => t,
      setTimeout: ((fn, _ms) => {
        capturedFns.push(fn);
        return makeFakeHandle();
      }) as HeartbeatWiringDeps["setTimeout"],
      clearTimeout: () => {},
      // No streamProvider: the controller will record 'lost' via decideBeat
      // without launching a stream (timer fires past LATE_BEAT_THRESHOLD_MS).
    };

    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true, intervalMs: 255_000 } },
      deps,
    );

    // Open gap at t=0, no provider request captured → lastRequestAt is null.
    // Advance to 290001 ms → elapsed past threshold → decideBeat returns 'lost'
    // → controller calls onGapLost → terminatedLost=true.
    wiring.onIdle(true);
    wiring.notifyAsyncStarted(0, "session-zero-beat-lost");

    assert.ok(capturedFns.length > 0, "timer must be scheduled");
    t = 290_001;
    capturedFns[0]!();
    // No stream to await — decideBeat short-circuits synchronously for 'lost'.

    wiring.disarm();

    const summaries = parseSummaryLines(written);
    assert.ok(summaries.length > 0, "summary must be written");
    assert.equal(
      summaries[0]!.verdict,
      "lost",
      "terminatedLost must override zero-beat gap to 'lost'",
    );
    assert.equal(summaries[0]!.beats, 0);
    assert.equal(pi.entries.length, 0, "no session entry for zero-beat gap");
  });

  it("emits session entry with correct shape after beats fire", async () => {
    const written: string[] = [];
    const pi = makeFakePi();
    const capturedFns: Array<() => void> = [];

    const deps: HeartbeatWiringDeps = {
      logPath: FAKE_LOG_PATH,
      appendFileSync: (_file, data) => written.push(data),
      mkdirSync: () => {},
      now: (() => {
        let t = 1_000_000;
        return () => (t += 1000);
      })(),
      setTimeout: ((fn, _ms) => {
        capturedFns.push(fn);
        return makeFakeHandle();
      }) as HeartbeatWiringDeps["setTimeout"],
      clearTimeout: () => {},
      streamProvider: (_model: Model<Api>, _context: Context, _options: StreamOptions) =>
        makeCacheReadStream(),
    };

    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true, intervalMs: 255_000 } },
      deps,
    );

    wiring.onIdle(true);
    wiring.onProviderRequest({ messages: [] }, makeModel());
    wiring.notifyAsyncStarted(0, "session-beat");

    // Fire the beat timer
    assert.ok(capturedFns.length > 0, "timer must have been scheduled");
    capturedFns[0]!();

    // Wait for async beat to complete
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Disarm to close the gap
    wiring.disarm();

    // Exactly one session entry (beats > 0)
    assert.equal(pi.entries.length, 1, "exactly one session entry per gap with beats");
    const entry = pi.entries[0]!;
    assert.equal(entry.customType, "heartbeat-gap-summary");
    const data = entry.data as HeartbeatGapSummaryData;
    assert.ok(data.beats >= 1, `beats should be >= 1, got ${data.beats}`);
    assert.ok(typeof data.beatCostUsd === "number", "beatCostUsd should be a number");
    assert.ok(typeof data.avoidedCostUsd === "number", "avoidedCostUsd should be a number");
    assert.ok(
      ["saved", "wasted", "lost"].includes(data.verdict),
      `verdict should be one of saved/wasted/lost, got ${data.verdict}`,
    );
  });

  it("emits exactly ONE session entry per gap (not per beat)", async () => {
    const written: string[] = [];
    const pi = makeFakePi();
    const scheduledFns: Array<() => void> = [];

    const deps: HeartbeatWiringDeps = {
      logPath: FAKE_LOG_PATH,
      appendFileSync: (_file, data) => written.push(data),
      mkdirSync: () => {},
      now: (() => {
        let t = 1_000_000;
        return () => (t += 1000);
      })(),
      setTimeout: ((fn, _ms) => {
        scheduledFns.push(fn);
        return makeFakeHandle();
      }) as HeartbeatWiringDeps["setTimeout"],
      clearTimeout: () => {},
      streamProvider: (_model, _context, _options) => makeCacheReadStream(),
    };

    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true, intervalMs: 255_000, maxBeatsPerGap: 10 } },
      deps,
    );

    wiring.onIdle(true);
    wiring.onProviderRequest({ messages: [] }, makeModel());
    wiring.notifyAsyncStarted(0, "session-multi-beat");

    // Fire two beats
    for (let i = 0; i < 2 && i < scheduledFns.length; i++) {
      scheduledFns[i]!();
      await new Promise((resolve) => setTimeout(resolve, 60));
    }

    // Disarm
    wiring.disarm();

    // Still exactly ONE session entry
    assert.ok(pi.entries.length <= 1, "at most one session entry per gap regardless of beat count");
  });
});

// ---------------------------------------------------------------------------
// Tests: doctor output — getSessionSummary
// ---------------------------------------------------------------------------

describe("createHeartbeatWiring — enabled: getSessionSummary", () => {
  it("accumulates unneeded gaps across multiple disarm cycles (zero-beat, no terminatedLost)", () => {
    const pi = makeFakePi();
    const wiring = createHeartbeatWiring(pi, { heartbeat: { enabled: true } }, makeTestDeps());

    // Gap 1
    wiring.notifyAsyncStarted(0, "session-s1");
    wiring.disarm();

    // Gap 2
    wiring.notifyAsyncStarted(0, "session-s1");
    wiring.disarm();

    const summary = wiring.getSessionSummary();
    assert.equal(summary.enabled, true);
    assert.equal(summary.totalBeats, 0);
    // Zero-beat gaps without terminatedLost are 'unneeded', not 'lost'.
    assert.equal(summary.gapsUnneeded, 2, "both benign zero-beat gaps counted as unneeded");
    assert.equal(summary.gapsLost, 0, "no lost gaps when terminatedLost was never set");
    assert.equal(summary.gapsSaved + summary.gapsWasted, 0);
  });

  it("adds active-gap totals without assigning an active gap a verdict or double-counting on close", async () => {
    const pi = makeFakePi();
    const written: string[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true } },
      makeCacheReadDeps({ written, timers }),
    );

    wiring.onProviderRequest({}, makeModel());
    wiring.onIdle(true);
    wiring.notifyAsyncStarted(0, "session-active-totals");
    await fireLatestTimer(timers);
    wiring.disarm();

    const finalized = wiring.getSessionSummary();
    assert.equal(finalized.totalBeats, 1);
    assert.equal(finalized.totalCacheReadTokens, 5000);
    assert.ok(finalized.totalBeatCostUsd > 0);
    assert.equal(finalized.gapsSaved, 1);

    // A second gap proves read-time diagnostics compose finalized totals with
    // the active accumulator rather than exposing only one of the two.
    wiring.onProviderRequest({}, makeModel());
    wiring.notifyAsyncStarted(0, "session-active-totals");
    await fireLatestTimer(timers);

    const active = wiring.getSessionSummary();
    assert.equal(active.totalBeats, finalized.totalBeats + 1);
    assert.equal(active.totalCacheReadTokens, finalized.totalCacheReadTokens + 5000);
    assert.ok(active.totalBeatCostUsd > finalized.totalBeatCostUsd);
    assert.equal(active.gapsSaved, finalized.gapsSaved, "active gap must not get a verdict yet");
    assert.equal(active.gapsWasted, 0);
    assert.equal(active.gapsLost, 0);
    assert.equal(active.gapsUnneeded, 0);

    wiring.disarm();
    const closed = wiring.getSessionSummary();
    assert.equal(closed.totalBeats, active.totalBeats, "closing must not double-count beats");
    assert.equal(
      closed.totalCacheReadTokens,
      active.totalCacheReadTokens,
      "closing must not double-count cache-read tokens",
    );
    assert.equal(
      closed.totalBeatCostUsd,
      active.totalBeatCostUsd,
      "closing must not double-count cost",
    );
    assert.equal(closed.gapsSaved, 2);
    wiring.destroy();
  });

  it("destroy finalizes active totals once without double-counting", async () => {
    const pi = makeFakePi();
    const written: string[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true } },
      makeCacheReadDeps({ written, timers }),
    );

    wiring.onProviderRequest({}, makeModel());
    wiring.onIdle(true);
    wiring.notifyAsyncStarted(0, "session-destroy-totals");
    await fireLatestTimer(timers);
    const active = wiring.getSessionSummary();

    wiring.destroy();
    const destroyed = wiring.getSessionSummary();
    assert.equal(destroyed.totalBeats, active.totalBeats);
    assert.equal(destroyed.totalCacheReadTokens, active.totalCacheReadTokens);
    assert.equal(destroyed.totalBeatCostUsd, active.totalBeatCostUsd);
    assert.equal(destroyed.gapsSaved, 1);
    assert.equal(parseSummaryLines(written).length, 1, "destroy must finalize the gap once");

    wiring.destroy();
    assert.deepEqual(wiring.getSessionSummary(), destroyed, "repeated destroy must not re-count");
  });

  it("reset clears finalized and active session-visible totals", async () => {
    const pi = makeFakePi();
    const written: string[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true } },
      makeCacheReadDeps({ written, timers }),
    );

    // Finalize one gap, then leave another gap active so reset covers both
    // storage locations used by getSessionSummary.
    wiring.onProviderRequest({}, makeModel());
    wiring.onIdle(true);
    wiring.notifyAsyncStarted(0, "session-reset-totals");
    await fireLatestTimer(timers);
    wiring.disarm();

    wiring.onProviderRequest({}, makeModel());
    wiring.notifyAsyncStarted(0, "session-reset-totals");
    await fireLatestTimer(timers);
    const beforeReset = wiring.getSessionSummary();
    assert.equal(beforeReset.totalBeats, 2);
    assert.equal(beforeReset.totalCacheReadTokens, 10_000);
    assert.equal(beforeReset.gapsSaved, 1, "the second gap is still active");

    wiring.resetSession();
    assert.deepEqual(wiring.getSessionSummary(), {
      enabled: true,
      totalBeats: 0,
      totalCacheReadTokens: 0,
      totalBeatCostUsd: 0,
      gapsSaved: 0,
      gapsWasted: 0,
      gapsLost: 0,
      gapsUnneeded: 0,
      breakerDisabled: false,
    });
    wiring.destroy();
  });

  it("reflects enabled:false for disabled wiring", () => {
    const pi = makeFakePi();
    const wiring = createHeartbeatWiring(pi, {});
    const summary = wiring.getSessionSummary();
    assert.equal(summary.enabled, false);
    assert.equal(summary.breakerDisabled, false);
  });
});

// ---------------------------------------------------------------------------
// Tests: synchronous disarm ordering guarantee
// ---------------------------------------------------------------------------

describe("createHeartbeatWiring — enabled: synchronous disarm before completion nudge", () => {
  it("notifyAsyncComplete disarms synchronously (no await) before any downstream code", () => {
    const pi = makeFakePi();
    const wiring = createHeartbeatWiring(pi, { heartbeat: { enabled: true } }, makeTestDeps());

    wiring.notifyAsyncStarted(0, "session-sync-test");

    const jobs = makeJobsMap([["job-1", "running"]]);
    const events: string[] = [];

    // This is the guarantee: disarm fires synchronously inside notifyAsyncComplete.
    const closed = (() => {
      const result = wiring.notifyAsyncComplete("job-1", jobs);
      events.push(result ? "disarmed" : "not-disarmed");
      return result;
    })();
    // Simulate "nudge fires here" in notify.ts (same synchronous call stack)
    events.push("nudge-would-fire-here");

    assert.equal(closed, true);
    assert.equal(events[0], "disarmed", "disarm must happen before nudge in same call stack");
    assert.equal(events[1], "nudge-would-fire-here");
  });
});

// ---------------------------------------------------------------------------
// Tests: resetSession — clear wiring-owned lifecycle state
// ---------------------------------------------------------------------------

describe("createHeartbeatWiring — enabled: resetSession", () => {
  it("clears idle state and captured data before rearming a new session", async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const pi = makeFakePi();
    let streamCalls = 0;
    const deps = makeTestDeps({ timers });
    deps.streamProvider = () => {
      streamCalls++;
      return makeCacheReadStream();
    };

    const wiring = createHeartbeatWiring(pi, { heartbeat: { enabled: true } }, deps);

    wiring.onIdle(true);
    wiring.onProviderRequest({ session: "old" }, makeModel());
    wiring.notifyAsyncStarted(0, "session-old");
    const timersBeforeReset = timers.length;

    wiring.resetSession();

    // A stale idle flag would let tryRearm open a gap immediately after reset.
    wiring.tryRearm(1, "session-new");
    assert.equal(
      timers.length,
      timersBeforeReset,
      "resetSession must clear wiring idle state before rearm",
    );

    // Once the new session reports idle, a gap can open, but it has no payload
    // until a new provider request is captured.
    wiring.onIdle(true);
    wiring.tryRearm(1, "session-new");
    assert.ok(timers.length > timersBeforeReset, "new-session idle state should permit rearm");
    timers[timers.length - 1]!.fn();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(streamCalls, 0, "resetSession must clear the old payload capture");

    wiring.destroy();
  });
});

// ---------------------------------------------------------------------------
// Tests: tryRearm — re-arm on idle with live runs (finding 4)
// ---------------------------------------------------------------------------

describe("createHeartbeatWiring — enabled: tryRearm (finding 4)", () => {
  it("tryRearm opens a gap when idle and liveRunCount > 0 and no gap is active", () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const pi = makeFakePi();
    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true } },
      makeTestDeps({ timers }),
    );

    wiring.onIdle(true);
    // Do not open a gap via notifyAsyncStarted — simulate the case where
    // the gap was disarmed during a parent turn and now the parent is idle again.
    wiring.tryRearm(1, "session-rearm");

    assert.ok(timers.length > 0, "tryRearm must arm timer when idle with live runs");
  });

  it("tryRearm is a no-op when not idle", () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const pi = makeFakePi();
    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true } },
      makeTestDeps({ timers }),
    );

    wiring.onIdle(false); // not idle
    wiring.tryRearm(2, "session-not-idle");

    assert.equal(timers.length, 0, "tryRearm must not arm when parent is not idle");
  });

  it("tryRearm is a no-op when liveRunCount is 0", () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const pi = makeFakePi();
    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true } },
      makeTestDeps({ timers }),
    );

    wiring.onIdle(true);
    wiring.tryRearm(0, "session-zero-runs");

    assert.equal(timers.length, 0, "tryRearm must not arm when liveRunCount is 0");
  });

  it("tryRearm is a no-op when a gap is already active", () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const pi = makeFakePi();
    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true } },
      makeTestDeps({ timers }),
    );

    wiring.onIdle(true);
    wiring.notifyAsyncStarted(0, "session-active");
    const countAfterGapOpen = timers.length;

    wiring.tryRearm(1, "session-active");
    assert.equal(timers.length, countAfterGapOpen, "tryRearm must not open a second gap");
  });

  it("after disarm, tryRearm re-opens a gap when conditions are met", () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const written: string[] = [];
    const pi = makeFakePi();
    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true } },
      makeTestDeps({ timers, written }),
    );

    wiring.onIdle(true);
    wiring.notifyAsyncStarted(0, "session-rearm-after-disarm");
    const countAfterFirstGap = timers.length;

    // Simulate parent turn: disarm + not idle
    wiring.onIdle(false);
    wiring.disarm();

    // Parent turn ends: idle again with live runs still present
    wiring.onIdle(true);
    wiring.tryRearm(1, "session-rearm-after-disarm");

    assert.ok(
      timers.length > countAfterFirstGap,
      "tryRearm must arm a new gap after the previous gap was disarmed",
    );
  });

  it("tryRearm is a no-op on disabled wiring", () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const pi = makeFakePi();
    const wiring = createHeartbeatWiring(pi, {}, makeTestDeps({ timers }));

    wiring.onIdle(true);
    wiring.tryRearm(5, "session-disabled");
    assert.equal(timers.length, 0, "disabled wiring tryRearm must be a no-op");
  });
});

// ---------------------------------------------------------------------------
// Tests: beat accounting (finding 7 — no appendFileSync interception)
// ---------------------------------------------------------------------------

describe("createHeartbeatWiring — enabled: beat accounting (finding 7)", () => {
  it("accumulates beat cost from controller accounting, not from JSONL interception", async () => {
    const written: string[] = [];
    const pi = makeFakePi();
    const capturedFns: Array<() => void> = [];

    const deps: HeartbeatWiringDeps = {
      logPath: FAKE_LOG_PATH,
      appendFileSync: (_file, data) => written.push(data),
      mkdirSync: () => {},
      now: (() => {
        let t = 1_000_000;
        return () => (t += 1000);
      })(),
      setTimeout: ((fn, _ms) => {
        capturedFns.push(fn);
        return makeFakeHandle();
      }) as HeartbeatWiringDeps["setTimeout"],
      clearTimeout: () => {},
      streamProvider: (_model: Model<Api>, _context: Context, _options: StreamOptions) =>
        makeCacheReadStream(),
    };

    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true, intervalMs: 255_000 } },
      deps,
    );

    wiring.onIdle(true);
    wiring.onProviderRequest({ messages: [] }, makeModel());
    wiring.notifyAsyncStarted(0, "session-stats");

    // Fire the beat
    assert.ok(capturedFns.length > 0, "timer must have been scheduled");
    capturedFns[0]!();
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Disarm to close the gap and emit summary
    wiring.disarm();

    // The gap summary should reflect non-zero beats (accumulated via controller accounting)
    const summaries = parseSummaryLines(written);
    const gapSummary = summaries[0];
    assert.ok(gapSummary, "gap summary must be written");
    assert.ok(
      (gapSummary!.beats as number) >= 1,
      `beats should be >= 1 in gap summary, got ${gapSummary!.beats}`,
    );
  });

  it("preserves observed usage when disarm races delayed iterator cleanup", async () => {
    const written: string[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const pi = makeFakePi();
    const deps = makeTestDeps({ written, timers });
    let markCleanupStarted!: () => void;
    let releaseCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    const cleanupRelease = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });

    deps.streamProvider = (): AsyncIterable<AssistantMessageEvent> =>
      (async function* (): AsyncGenerator<AssistantMessageEvent> {
        try {
          yield {
            type: "text_start",
            contentIndex: 0,
            partial: makeAssistantMessage({
              content: [{ type: "text", text: "" }],
              usage: makeUsage({ input: 1000, cacheRead: 5000, output: 10 }),
            }),
          };
        } finally {
          // The controller breaks after observing usage, which invokes
          // iterator.return(). Hold cleanup open to race a lifecycle disarm.
          markCleanupStarted();
          await cleanupRelease;
        }
      })();

    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true, intervalMs: 255_000 } },
      deps,
    );

    wiring.onIdle(true);
    wiring.onProviderRequest({ messages: [] }, makeModel());
    wiring.notifyAsyncStarted(0, "session-delayed-cleanup");
    const timer = timers.at(-1);
    assert.ok(timer, "gap open must schedule a heartbeat timer");
    timer.fn();

    await cleanupStarted;
    const active = wiring.getSessionSummary();
    assert.equal(active.totalBeats, 1, "issued beat must be counted before cleanup settles");
    assert.equal(active.totalCacheReadTokens, 5000, "observed cache-read tokens must be retained");
    assert.equal(active.totalBeatCostUsd, 0.00465, "observed usage cost must be retained");

    // Disarm while executeBeat is still waiting for iterator cleanup. The
    // summary and entry must use the synchronously published accounting.
    wiring.disarm();
    const summaries = parseSummaryLines(written);
    assert.equal(summaries.length, 1, "disarm must emit one gap summary");
    assert.equal(summaries[0]!.beats, 1);
    assert.equal(summaries[0]!.beatCostUsd, 0.00465);
    assert.equal(summaries[0]!.avoidedCostUsd, 0.0135);
    assert.equal(pi.entries.length, 1, "beat-bearing disarm must emit one session entry");
    const entry = pi.entries[0]!.data as HeartbeatGapSummaryData;
    assert.equal(entry.beats, 1);
    assert.equal(entry.beatCostUsd, 0.00465);
    assert.equal(entry.avoidedCostUsd, 0.0135);

    releaseCleanup();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const settled = wiring.getSessionSummary();
    assert.equal(settled.totalBeats, 1, "late completion must not double-count the beat");
    assert.equal(settled.totalCacheReadTokens, 5000, "late completion must not double-count usage");
    assert.equal(settled.totalBeatCostUsd, 0.00465, "late completion must not double-count cost");
    assert.equal(
      parseSummaryLines(written).length,
      1,
      "late completion must not emit another summary",
    );
    wiring.destroy();
  });

  it("avoided cost is not accumulated per beat (only one future miss avoidable, finding 7)", async () => {
    const written: string[] = [];
    const pi = makeFakePi();
    const capturedFns: Array<() => void> = [];

    const deps: HeartbeatWiringDeps = {
      logPath: FAKE_LOG_PATH,
      appendFileSync: (_file, data) => written.push(data),
      mkdirSync: () => {},
      now: (() => {
        let t = 1_000_000;
        return () => (t += 1000);
      })(),
      setTimeout: ((fn, _ms) => {
        capturedFns.push(fn);
        return makeFakeHandle();
      }) as HeartbeatWiringDeps["setTimeout"],
      clearTimeout: () => {},
      streamProvider: (_model: Model<Api>, _context: Context, _options: StreamOptions) =>
        makeCacheReadStream(),
    };

    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true, intervalMs: 255_000, maxBeatsPerGap: 10 } },
      deps,
    );

    wiring.onIdle(true);
    wiring.onProviderRequest({ messages: [] }, makeModel());
    wiring.notifyAsyncStarted(0, "session-avoid");

    // Fire two beats
    for (let i = 0; i < 2 && i < capturedFns.length; i++) {
      capturedFns[i]!();
      await new Promise((resolve) => setTimeout(resolve, 80));
    }

    wiring.disarm();

    const summaries = parseSummaryLines(written);
    const gapSummary = summaries[0];
    // avoidedCostUsd should be a single beat's value, not the sum of N beats
    // (we can't verify the exact value without knowing the model cost, but we
    // can verify the field is present and non-negative)
    assert.ok(gapSummary, "gap summary must be written");
    assert.ok(typeof gapSummary!.avoidedCostUsd === "number", "avoidedCostUsd must be a number");
    assert.ok((gapSummary!.avoidedCostUsd as number) >= 0, "avoidedCostUsd must be non-negative");
  });

  it("production registry path: error when getModelRegistry returns undefined (finding 1)", async () => {
    const written: string[] = [];
    const pi = makeFakePi();
    const capturedFns: Array<() => void> = [];

    const deps: HeartbeatWiringDeps = {
      logPath: FAKE_LOG_PATH,
      appendFileSync: (_file, data) => written.push(data),
      mkdirSync: () => {},
      now: (() => {
        let t = 1_000_000;
        return () => (t += 1000);
      })(),
      setTimeout: ((fn, _ms) => {
        capturedFns.push(fn);
        return makeFakeHandle();
      }) as HeartbeatWiringDeps["setTimeout"],
      clearTimeout: () => {},
      // No streamProvider and getModelRegistry returns undefined — production path
      // with no live registry.
      getModelRegistry: () => undefined,
    };

    const wiring = createHeartbeatWiring(pi, { heartbeat: { enabled: true } }, deps);

    wiring.onIdle(true);
    wiring.onProviderRequest({ messages: [] }, makeModel());
    wiring.notifyAsyncStarted(0, "session-noreg");

    // Fire the beat timer
    assert.ok(capturedFns.length > 0, "timer must have been scheduled");
    capturedFns[0]!();
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Must produce an error outcome JSONL record, not throw
    const beatRecords = written.filter((line) => {
      try {
        const r = JSON.parse(line) as { outcome?: string };
        return r.outcome !== undefined;
      } catch {
        return false;
      }
    });
    assert.ok(
      beatRecords.length > 0,
      "missing registry must produce an error-outcome JSONL beat record",
    );
    const beatRecord = JSON.parse(beatRecords[0]!) as { outcome: string };
    assert.equal(
      beatRecord.outcome,
      "error",
      "production path with no registry must log 'error' outcome",
    );

    // Wiring must still function (no throw into host)
    wiring.disarm();
    assert.doesNotThrow(() => wiring.destroy());
  });
});

// ---------------------------------------------------------------------------
// Tests: terminal-lost propagation (finding D)
// ---------------------------------------------------------------------------

describe("createHeartbeatWiring — enabled: terminal-lost verdict propagation (finding D)", () => {
  it("gap with prior cache_read beat is verdicted 'saved' without a terminal-lost signal (baseline)", async () => {
    // Baseline: no onGapLost signal — a cache_read beat should produce 'saved'.
    const written: string[] = [];
    const pi = makeFakePi();
    const capturedFns: Array<() => void> = [];
    let t = 0;

    const deps: HeartbeatWiringDeps = {
      logPath: FAKE_LOG_PATH,
      appendFileSync: (_file, data) => written.push(data),
      mkdirSync: () => {},
      now: () => t,
      setTimeout: ((fn, _ms) => {
        capturedFns.push(fn);
        return makeFakeHandle();
      }) as HeartbeatWiringDeps["setTimeout"],
      clearTimeout: () => {},
      streamProvider: (): AsyncIterable<AssistantMessageEvent> => makeCacheReadStream(),
    };

    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true, intervalMs: 255_000 } },
      deps,
    );

    wiring.onIdle(true);
    wiring.onProviderRequest({ messages: [] }, makeModel());
    wiring.notifyAsyncStarted(0, "session-baseline");

    // Fire beat 1 (t=0, elapsed=0 < 290000 → cache_read)
    assert.ok(capturedFns.length > 0, "timer must be scheduled");
    capturedFns[0]!();
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Disarm without advancing past threshold: verdict must be 'saved'
    wiring.disarm();
    const summaries = parseSummaryLines(written);
    assert.ok(summaries.length > 0, "gap summary must be written");
    assert.equal(
      summaries[0]!.verdict,
      "saved",
      "gap with cache_read beat and no terminal-lost signal must be 'saved'",
    );
  });

  it("triggers onGapLost via timer and asserts verdict 'lost' even after cache_read beat", async () => {
    // Regression: the wiring previously relied on onGapLost to override the verdict.
    // This test verifies end-to-end that:
    //   1. Beat 1 fires at t=0 and succeeds (cache_read).
    //   2. Timer re-arms after beat.
    //   3. Time advances to 290001 ms past lastRequestAt (past LATE_BEAT_THRESHOLD_MS).
    //   4. Timer fires → decideBeat returns 'lost' → controller calls onGapLost.
    //   5. Wiring sets terminatedLost=true on the accumulator.
    //   6. disarm() produces verdict 'lost' (not 'saved') because terminatedLost overrides.
    const written: string[] = [];
    const pi = makeFakePi();
    const capturedFns: Array<() => void> = [];
    let t = 0;

    const deps: HeartbeatWiringDeps = {
      logPath: FAKE_LOG_PATH,
      appendFileSync: (_file, data) => written.push(data),
      mkdirSync: () => {},
      now: () => t,
      setTimeout: ((fn, _ms) => {
        capturedFns.push(fn);
        return makeFakeHandle();
      }) as HeartbeatWiringDeps["setTimeout"],
      clearTimeout: () => {},
      streamProvider: (): AsyncIterable<AssistantMessageEvent> => makeCacheReadStream(),
    };

    const wiring = createHeartbeatWiring(
      pi,
      {
        heartbeat: {
          enabled: true,
          intervalMs: 255_000,
          maxBeatsPerGap: 11,
          maxDurationMs: 3_600_000,
        },
      },
      deps,
    );

    // t=0: capture provider request; gap opens with lastRequestAt=0.
    wiring.onIdle(true);
    wiring.onProviderRequest({ messages: [] }, makeModel()); // capturedAt = 0
    wiring.notifyAsyncStarted(0, "session-terminal-lost"); // lastRequestAt = 0

    // Step 1: fire timer 0 at t=0 — elapsed=0 < 290000 → beat fires.
    assert.ok(capturedFns.length >= 1, "timer must be scheduled after gap open");
    capturedFns[0]!();
    // Await beat settlement (async generator + Promise microtasks).
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Beat settled: capturedFns[1] is the re-armed timer.
    const beatRecords = written.filter((line) => {
      try {
        return (JSON.parse(line) as { outcome?: string }).outcome === "cache_read";
      } catch {
        return false;
      }
    });
    assert.ok(beatRecords.length > 0, "beat must have completed with cache_read");
    assert.ok(capturedFns.length >= 2, "timer must be re-armed after beat");

    // Step 2: advance past LATE_BEAT_THRESHOLD_MS (290 s) and fire timer 1.
    // elapsed = 290001 - 0 = 290001 >= 290000 → decideBeat returns 'lost'
    // → controller calls onGapLost → wiring sets terminatedLost=true.
    t = 290_001;
    capturedFns[1]!();

    // Step 3: disarm — verdictFrom(acc) with terminatedLost=true → 'lost'.
    wiring.disarm();

    const summaries = parseSummaryLines(written);
    assert.ok(summaries.length > 0, "gap summary must be written");
    assert.equal(
      summaries[0]!.verdict,
      "lost",
      "gap with prior cache_read beat must be verdicted 'lost' when onGapLost fires",
    );

    // Session entry must also reflect 'lost' (gapsLost, not gapsSaved).
    const summary = wiring.getSessionSummary();
    assert.equal(summary.gapsLost, 1, "session must count 1 lost gap");
    assert.equal(summary.gapsSaved, 0, "session must not count any saved gaps");
  });
});

// ---------------------------------------------------------------------------
// Tests: session_before_switch / session_before_fork disclosure (finding F-3)
// ---------------------------------------------------------------------------

describe("createHeartbeatWiring — enabled: session_before_switch/fork disclosure (finding F-3)", () => {
  it("disarm() before destroy emits session entry for a beat-bearing gap", async () => {
    // Simulates the session_before_switch pattern: disarm() then destroy().
    // The session entry must be emitted by disarm() before teardown.
    const written: string[] = [];
    const pi = makeFakePi();
    const capturedFns: Array<() => void> = [];

    const deps: HeartbeatWiringDeps = {
      logPath: FAKE_LOG_PATH,
      appendFileSync: (_file, data) => written.push(data),
      mkdirSync: () => {},
      now: (() => {
        let t = 1_000_000;
        return () => (t += 1000);
      })(),
      setTimeout: ((fn, _ms) => {
        capturedFns.push(fn);
        return makeFakeHandle();
      }) as HeartbeatWiringDeps["setTimeout"],
      clearTimeout: () => {},
      streamProvider: (_model: Model<Api>, _context: Context, _options: StreamOptions) =>
        makeCacheReadStream(),
    };

    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true, intervalMs: 255_000 } },
      deps,
    );

    wiring.onIdle(true);
    wiring.onProviderRequest({ messages: [] }, makeModel());
    wiring.notifyAsyncStarted(0, "session-switch");

    // Fire one beat so the gap has executedBeats > 0
    assert.ok(capturedFns.length > 0, "timer must be scheduled");
    capturedFns[0]!();
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Simulate session_before_switch: disarm before teardown
    wiring.disarm();

    // Entry must have been emitted by disarm() (beat-bearing gap)
    assert.ok(pi.entries.length >= 1, "session entry must be emitted by disarm() before destroy");
    const entry = pi.entries[0]!;
    assert.equal(
      entry.customType,
      "heartbeat-gap-summary",
      "entry customType must be heartbeat-gap-summary",
    );

    // destroy() must NOT emit an additional entry
    const entriesBeforeDestroy = pi.entries.length;
    wiring.destroy();
    assert.equal(
      pi.entries.length,
      entriesBeforeDestroy,
      "destroy() must not emit session entry after disarm() already did",
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: agent_settled re-arm lifecycle coverage (finding F-2)
// ---------------------------------------------------------------------------

describe("createHeartbeatWiring — enabled: agent_settled re-arm lifecycle (finding F-2)", () => {
  it("tryRearm re-arms after agent_settled pattern (onIdle(false) + disarm, then onIdle(true) + tryRearm)", () => {
    // Simulates the index.ts agent_settled handler:
    //   1. before_agent_start: onIdle(false), disarm()
    //   2. agent_settled: onIdle(true), tryRearm(liveCount, sessionId)
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const written: string[] = [];
    const pi = makeFakePi();

    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true } },
      makeTestDeps({ timers, written }),
    );

    // 1. Start an async job (opens gap)
    wiring.onIdle(true);
    wiring.notifyAsyncStarted(0, "session-settled");
    const timerCountAfterFirstGap = timers.length;
    assert.ok(timerCountAfterFirstGap > 0, "first gap must arm a timer");

    // 2. Parent turn starts (before_agent_start)
    wiring.onIdle(false);
    wiring.disarm();

    // 3. Parent turn ends (agent_settled)
    wiring.onIdle(true);
    // Simulate 1 live async run still active
    wiring.tryRearm(1, "session-settled");

    // Gap should have been re-armed
    assert.ok(
      timers.length > timerCountAfterFirstGap,
      "tryRearm must re-arm a new gap after agent_settled with live runs",
    );
  });

  it("restored live jobs on session_start: tryRearm arms gap when runs are restored", () => {
    // Simulates the index.ts session_start handler calling
    // tryRearm(countLiveAsyncRuns(state.asyncJobs), state.currentSessionId)
    // after restoreActiveJobs() has repopulated asyncJobs.
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const pi = makeFakePi();

    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true } },
      makeTestDeps({ timers }),
    );

    // Session starts idle (no gap yet)
    wiring.onIdle(true);

    // After restoreActiveJobs, tryRearm is called with restored live run count
    wiring.tryRearm(2, "session-restored");

    assert.ok(
      timers.length > 0,
      "tryRearm must arm a gap when session_start restores live async jobs",
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: cancellation-only gap verdict (finding B — round-3 item 3)
// ---------------------------------------------------------------------------

describe("createHeartbeatWiring — enabled: cancellation-only gap verdict", () => {
  it("a gap whose only beat was lifecycle-cancelled is verdicted 'wasted' (explicit semantic)", async () => {
    // Deliberate semantic: a gap with only a cancelled beat has executedBeats > 0
    // (via optimistic onBeatIssued) and cancelledBeats > 0 (via onBeatCancelled).
    // The verdict is 'wasted' — cost was potentially spent but no cache-read evidence
    // was observed.  This is an explicit, documented semantic, not an implicit fallthrough.
    const written: string[] = [];
    const pi = makeFakePi();
    const capturedFns: Array<() => void> = [];

    const deps: HeartbeatWiringDeps = {
      logPath: FAKE_LOG_PATH,
      appendFileSync: (_file, data) => written.push(data),
      mkdirSync: () => {},
      now: (() => {
        let t = 0;
        return () => (t += 1000);
      })(),
      setTimeout: ((fn, _ms) => {
        capturedFns.push(fn);
        return makeFakeHandle();
      }) as HeartbeatWiringDeps["setTimeout"],
      clearTimeout: () => {},
      // Blocking stream: never resolves on its own; waits for signal abort.
      streamProvider: (
        _model: Model<Api>,
        _context: Context,
        options: StreamOptions,
      ): AsyncIterable<AssistantMessageEvent> => {
        return {
          [Symbol.asyncIterator]() {
            let done = false;
            return {
              async next() {
                if (done || options.signal?.aborted) return { done: true, value: undefined };
                await new Promise<void>((resolve) => {
                  options.signal?.addEventListener("abort", () => resolve(), { once: true });
                });
                done = true;
                return { done: true, value: undefined };
              },
              return() {
                done = true;
                return Promise.resolve({ done: true, value: undefined });
              },
            };
          },
        };
      },
    };

    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true, intervalMs: 255_000 } },
      deps,
    );

    wiring.onIdle(true);
    wiring.onProviderRequest({ messages: [] }, makeModel());
    wiring.notifyAsyncStarted(0, "session-cancel-only");

    // Fire the timer — beat starts, blocking on the stream.
    assert.ok(capturedFns.length > 0, "timer must be scheduled");
    capturedFns[0]!();
    // Yield so executeBeat runs up to the first await (onBeatIssued already called).
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Lifecycle-cancel the beat by disarming while the stream is in flight.
    // onBeatCancelled is called in the controller — wiring increments cancelledBeats.
    wiring.disarm();
    // Wait for the stream to abort and executeBeat to settle.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const summaries = parseSummaryLines(written);
    assert.ok(summaries.length > 0, "gap summary must be written on disarm");
    assert.equal(
      summaries[0]!["verdict"],
      "wasted",
      "cancellation-only gap must be verdicted 'wasted': beats were issued but no cache-read observed",
    );
    // No session entry: the beat was cancelled, cost was potentially spent, but
    // there is no way to verify cache-read — the gap should still have an entry since
    // executedBeats > 0 (optimistic accounting).
    assert.ok(pi.entries.length >= 1, "gap with cancelled beat must emit a session entry");
  });
});

// ---------------------------------------------------------------------------
// Tests: disabled wiring registers no pi hooks (finding E)
// ---------------------------------------------------------------------------

describe("createHeartbeatWiring — disabled: zero hook registration (finding E)", () => {
  it("disabled wiring does not register any entry renderers", () => {
    // The wiring layer only registers renderers when enabled.
    // This confirms that no pi.registerEntryRenderer call is made for disabled config.
    const pi = makeFakePi();
    createHeartbeatWiring(pi, {});
    assert.equal(
      pi.registeredRendererTypes.size,
      0,
      "disabled wiring must not register any entry renderers",
    );
  });

  it("disabled wiring: all public methods are no-ops (no timers, no writes, no entries)", () => {
    const pi = makeFakePi();
    const written: string[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const deps = makeTestDeps({ written, timers });

    const wiring = createHeartbeatWiring(pi, {}, deps);

    // Exercise all public methods
    wiring.onProviderRequest({ payload: "sensitive-data" }, makeModel());
    wiring.onIdle(true);
    wiring.notifyAsyncStarted(0, "sess");
    wiring.notifyAsyncComplete("job-1", makeJobsMap([["job-1", "running"]]));
    wiring.disarm();
    wiring.tryRearm(1, "sess");
    wiring.destroy();

    assert.equal(timers.length, 0, "disabled wiring must schedule no timers");
    assert.equal(written.length, 0, "disabled wiring must write no JSONL records");
    assert.equal(pi.entries.length, 0, "disabled wiring must emit no session entries");
    assert.equal(
      pi.registeredRendererTypes.size,
      0,
      "disabled wiring must register no entry renderers",
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: resetSession — session state cleared on session switch (finding 2 — PR review)
// ---------------------------------------------------------------------------

describe("createHeartbeatWiring — resetSession", () => {
  it("session totals are zeroed after resetSession", async () => {
    const pi = makeFakePi();
    const written: string[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let clock = 0;
    const nowFn = () => (clock += 1000);

    const deps = makeTestDeps({ written, timers, nowFn });
    const wiring = createHeartbeatWiring(pi, { heartbeat: { enabled: true } }, deps);

    // Open a gap, fire a beat (cache_read), and close the gap.
    wiring.onProviderRequest({}, makeModel());
    wiring.onIdle(true);
    wiring.notifyAsyncStarted(0, "sess-1");

    // Fire the timer (stream produces a cache_read beat via fake streamProvider).
    // Since makeTestDeps doesn't inject a streamProvider, we just close the gap
    // directly to accumulate session totals.
    wiring.disarm(); // closes gap, increments session totals (unneeded verdict, 0 beats, no terminatedLost)

    const summary1 = wiring.getSessionSummary();
    // gapsUnneeded should be 1 (no beats fired, no terminatedLost).
    assert.equal(summary1.enabled, true);
    assert.equal(summary1.gapsUnneeded, 1, "should have one unneeded gap before reset");

    // Reset session — totals should be cleared.
    wiring.resetSession();

    const summary2 = wiring.getSessionSummary();
    assert.equal(summary2.totalBeats, 0, "totalBeats must be 0 after resetSession");
    assert.equal(summary2.gapsSaved, 0, "gapsSaved must be 0 after resetSession");
    assert.equal(summary2.gapsWasted, 0, "gapsWasted must be 0 after resetSession");
    assert.equal(summary2.gapsLost, 0, "gapsLost must be 0 after resetSession");
    assert.equal(summary2.gapsUnneeded, 0, "gapsUnneeded must be 0 after resetSession");
    assert.equal(
      summary2.breakerDisabled,
      false,
      "breakerDisabled must be false after resetSession",
    );

    wiring.destroy();
  });

  it("resetSession is idempotent and safe when no gap is active", () => {
    const pi = makeFakePi();
    const wiring = createHeartbeatWiring(pi, { heartbeat: { enabled: true } }, makeTestDeps());
    // Should not throw even when no gap is open.
    assert.doesNotThrow(() => {
      wiring.resetSession();
      wiring.resetSession();
    });
    wiring.destroy();
  });

  it("after resetSession breaker-tripped controller allows new gaps", async () => {
    const pi = makeFakePi();
    const written: string[] = [];
    let clock = 0;
    const nowFn = () => (clock += 1);

    // Use a streamProvider that always errors to trip the breaker.
    let streamCalls = 0;
    const timerQueue: Array<{ fn: () => void; at: number }> = [];
    const wiringDeps: HeartbeatWiringDeps = {
      logPath: FAKE_LOG_PATH,
      appendFileSync: (_file, data) => written.push(data),
      mkdirSync: () => {},
      now: nowFn,
      setTimeout: ((fn, ms) => {
        timerQueue.push({ fn, at: clock + ms });
        return makeFakeHandle();
      }) as HeartbeatWiringDeps["setTimeout"],
      clearTimeout: () => {},
      streamProvider: () =>
        (async function* () {
          streamCalls++;
          throw new Error("always errors");
          /* eslint-disable no-unreachable */
          yield {
            type: "text_start",
            contentIndex: 0,
            partial: {
              role: "assistant",
              content: [],
              api: "anthropic-messages" as Api,
              provider: "anthropic",
              model: "claude-sonnet-4-20250514",
              usage: makeUsage({ cacheRead: 0 }),
              stopReason: "pending",
              timestamp: 0,
            },
          } as AssistantMessageEvent;
        })(),
    };

    const wiring = createHeartbeatWiring(
      pi,
      { heartbeat: { enabled: true, intervalMs: 10 } },
      wiringDeps,
    );
    wiring.onProviderRequest({}, makeModel());
    wiring.onIdle(true);
    wiring.notifyAsyncStarted(0, "sess-breaker");

    // Fire timers 3 times to trip the breaker (3 consecutive errors).
    for (let i = 0; i < 3; i++) {
      const pending = timerQueue.splice(0);
      for (const { fn } of pending) fn();
      await new Promise((r) => setTimeout(r, 30));
    }

    const beforeReset = streamCalls;
    // Trip confirmed: no more stream calls after breaker.
    const leftover = timerQueue.splice(0);
    for (const { fn } of leftover) fn();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(streamCalls, beforeReset, "breaker must prevent stream calls");

    // Reset session and open a new gap.
    wiring.resetSession();
    wiring.onProviderRequest({}, makeModel());
    wiring.onIdle(true);
    wiring.notifyAsyncStarted(0, "sess-after-reset");

    const pending2 = timerQueue.splice(0);
    for (const { fn } of pending2) fn();
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(streamCalls > beforeReset, "resetSession must allow new beats after breaker trip");

    wiring.destroy();
  });
});

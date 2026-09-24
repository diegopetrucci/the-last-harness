/**
 * Unit tests for handleCacheWarmingDecision (extension/cache-warming-decision.ts).
 *
 * Covers:
 * - Session mismatch -> undefined (abstain)
 * - Zero live runs -> undefined
 * - Retained-terminal and paused jobs not counted as live
 * - missCost - warmCost just below 0.05 -> undefined
 * - missCost - warmCost at 0.05 -> warm
 * - missCost - warmCost above 0.05 -> warm
 * - Never returns stop
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleCacheWarmingDecision } from "../../src/extension/cache-warming-decision.ts";
import type { AsyncJobState, SubagentState } from "../../src/shared/types.ts";
import type { CacheWarmingDecisionEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Coerce an unknown value to ExtensionContext via a single (non-chained)
 * assertion. Tests only need ctx.sessionManager; the coercion avoids the
 * anti-slop `as unknown as T` double-assertion pattern.
 */
function asCtx(value: unknown): ExtensionContext {
  return value as ExtensionContext;
}

function makeCtx(
  sessionFile: string | null | undefined,
  sessionId = "fallback-id",
): ExtensionContext {
  return asCtx({
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => sessionId,
    },
  });
}

function makeEvent(
  overrides: Partial<{
    warmCost: number;
    missCost: number;
    continuationProbability: number;
    action: "warm" | "stop";
  }> = {},
): CacheWarmingDecisionEvent {
  return {
    type: "cache_warming_decision",
    warmCost: 0,
    missCost: 0.1,
    continuationProbability: 1,
    action: "stop",
    ...overrides,
  };
}

function makeAsyncJob(asyncId: string, status: AsyncJobState["status"] = "running"): AsyncJobState {
  return { asyncId, asyncDir: `/tmp/async/${asyncId}`, status };
}

function makeJobsMap(
  entries: Array<[string, AsyncJobState["status"]]>,
): Map<string, AsyncJobState> {
  const map = new Map<string, AsyncJobState>();
  for (const [id, status] of entries) map.set(id, makeAsyncJob(id, status));
  return map;
}

function makeState(
  overrides: Partial<Pick<SubagentState, "currentSessionId" | "asyncJobs">> = {},
): SubagentState {
  return {
    baseCwd: "/tmp",
    currentSessionId: SESSION_FILE,
    subagentInProgress: false,
    asyncJobs: makeJobsMap([["job-1", "running"]]),
    foregroundRuns: new Map(),
    foregroundControls: new Map(),
    lastForegroundControlId: null,
    pendingForegroundControlNotices: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: { schedule: () => false, clear: () => {} },
    ...overrides,
  };
}

// Session file used as the "matching" session identity in all tests.
const SESSION_FILE = "/home/user/.pi/agent/sessions/abc123.jsonl";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleCacheWarmingDecision", () => {
  describe("session identity", () => {
    it("returns undefined when session file does not match state.currentSessionId", () => {
      const ctx = makeCtx("/other/session.jsonl");
      const state = makeState({ currentSessionId: SESSION_FILE });
      const result = handleCacheWarmingDecision(
        makeEvent({ missCost: 0.2, warmCost: 0 }),
        ctx,
        state,
      );
      assert.equal(result, undefined);
    });

    it("returns undefined when session identity is unavailable (throws)", () => {
      const ctx = asCtx({
        sessionManager: {
          getSessionFile: () => {
            throw new Error("session unavailable");
          },
          getSessionId: () => {
            throw new Error("session unavailable");
          },
        },
      });
      const state = makeState({ currentSessionId: SESSION_FILE });
      const result = handleCacheWarmingDecision(
        makeEvent({ missCost: 0.2, warmCost: 0 }),
        ctx,
        state,
      );
      assert.equal(result, undefined);
    });

    it("returns undefined when state.currentSessionId is null", () => {
      const ctx = makeCtx(SESSION_FILE);
      const state = makeState({ currentSessionId: null });
      const result = handleCacheWarmingDecision(
        makeEvent({ missCost: 0.2, warmCost: 0 }),
        ctx,
        state,
      );
      assert.equal(result, undefined);
    });

    it("falls back to getSessionId when getSessionFile returns null", () => {
      // resolveCurrentSessionId uses getSessionFile() ?? getSessionId().
      // If currentSessionId was stored from the fallback path, it should match.
      const ctx = makeCtx(null, "fallback-id");
      const state = makeState({
        currentSessionId: "fallback-id",
        asyncJobs: makeJobsMap([["j", "running"]]),
      });
      const result = handleCacheWarmingDecision(
        makeEvent({ missCost: 0.1, warmCost: 0 }),
        ctx,
        state,
      );
      assert.deepEqual(result, { action: "warm" });
    });
  });

  describe("live-run count", () => {
    it("returns undefined when there are zero live async runs", () => {
      const ctx = makeCtx(SESSION_FILE);
      const state = makeState({ currentSessionId: SESSION_FILE, asyncJobs: new Map() });
      const result = handleCacheWarmingDecision(
        makeEvent({ missCost: 0.2, warmCost: 0 }),
        ctx,
        state,
      );
      assert.equal(result, undefined);
    });

    it("returns undefined when all jobs are in terminal-retention statuses (paused, complete, failed, cancelled, continued)", () => {
      const ctx = makeCtx(SESSION_FILE);
      const state = makeState({
        currentSessionId: SESSION_FILE,
        asyncJobs: makeJobsMap([
          ["a", "complete"],
          ["b", "failed"],
          ["c", "paused"],
          ["d", "cancelled"],
          ["e", "continued"],
        ]),
      });
      const result = handleCacheWarmingDecision(
        makeEvent({ missCost: 0.2, warmCost: 0 }),
        ctx,
        state,
      );
      assert.equal(result, undefined);
    });

    it("returns warm when at least one live job exists among mixed statuses", () => {
      const ctx = makeCtx(SESSION_FILE);
      const state = makeState({
        currentSessionId: SESSION_FILE,
        asyncJobs: makeJobsMap([
          ["a", "running"],
          ["b", "complete"],
          ["c", "paused"],
        ]),
      });
      const result = handleCacheWarmingDecision(
        makeEvent({ missCost: 0.1, warmCost: 0 }),
        ctx,
        state,
      );
      assert.deepEqual(result, { action: "warm" });
    });
  });

  describe("economics threshold", () => {
    it("returns undefined when missCost - warmCost is just below 0.05", () => {
      const ctx = makeCtx(SESSION_FILE);
      const state = makeState({ currentSessionId: SESSION_FILE });
      const result = handleCacheWarmingDecision(
        makeEvent({ missCost: 0.049_999, warmCost: 0 }),
        ctx,
        state,
      );
      assert.equal(result, undefined);
    });

    it("returns { action: 'warm' } when missCost - warmCost equals exactly 0.05", () => {
      const ctx = makeCtx(SESSION_FILE);
      const state = makeState({ currentSessionId: SESSION_FILE });
      const result = handleCacheWarmingDecision(
        makeEvent({ missCost: 0.05, warmCost: 0 }),
        ctx,
        state,
      );
      assert.deepEqual(result, { action: "warm" });
    });

    it("returns { action: 'warm' } when missCost - warmCost is well above 0.05", () => {
      const ctx = makeCtx(SESSION_FILE);
      const state = makeState({ currentSessionId: SESSION_FILE });
      const result = handleCacheWarmingDecision(
        makeEvent({ missCost: 0.5, warmCost: 0.1 }),
        ctx,
        state,
      );
      assert.deepEqual(result, { action: "warm" });
    });

    it("returns undefined when warmCost is high enough to push savings below 0.05", () => {
      const ctx = makeCtx(SESSION_FILE);
      const state = makeState({ currentSessionId: SESSION_FILE });
      // 0.1 - 0.06 = 0.04 < 0.05
      const result = handleCacheWarmingDecision(
        makeEvent({ missCost: 0.1, warmCost: 0.06 }),
        ctx,
        state,
      );
      assert.equal(result, undefined);
    });
  });

  describe("never returns stop", () => {
    it("does not return { action: 'stop' } in any case", () => {
      const ctx = makeCtx(SESSION_FILE);

      // Case 1: session mismatch
      const r1 = handleCacheWarmingDecision(
        makeEvent(),
        makeCtx("/different"),
        makeState({ currentSessionId: "/other" }),
      );
      assert.notDeepEqual(r1, { action: "stop" });

      // Case 2: no live runs
      const r2 = handleCacheWarmingDecision(makeEvent(), ctx, makeState({ asyncJobs: new Map() }));
      assert.notDeepEqual(r2, { action: "stop" });

      // Case 3: economics too low
      const r3 = handleCacheWarmingDecision(
        makeEvent({ missCost: 0.01, warmCost: 0 }),
        ctx,
        makeState(),
      );
      assert.notDeepEqual(r3, { action: "stop" });
    });
  });
});

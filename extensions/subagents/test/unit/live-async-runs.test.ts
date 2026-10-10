/**
 * Unit tests for countLiveAsyncRuns (runs/background/live-async-runs.ts).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countLiveAsyncRuns } from "../../src/runs/background/live-async-runs.ts";
import type { AsyncJobState } from "../../src/shared/types.ts";

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

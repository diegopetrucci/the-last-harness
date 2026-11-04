import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TOP_LEVEL_PARALLEL_TASKS,
  resolveTopLevelParallelConcurrency,
  resolveTopLevelParallelMaxTasks,
} from "../../src/shared/types.ts";

describe("top-level parallel config helpers", () => {
  it("keeps configured values through the supported maximum and bounds larger values", () => {
    assert.equal(MAX_TOP_LEVEL_PARALLEL_TASKS, 8);
    for (let value = 1; value <= MAX_TOP_LEVEL_PARALLEL_TASKS; value++) {
      assert.equal(resolveTopLevelParallelMaxTasks(value), value);
    }
    assert.equal(
      resolveTopLevelParallelMaxTasks(MAX_TOP_LEVEL_PARALLEL_TASKS + 1),
      MAX_TOP_LEVEL_PARALLEL_TASKS,
    );
  });

  it("falls back to the supported maximum for invalid values", () => {
    assert.equal(resolveTopLevelParallelMaxTasks(undefined), MAX_TOP_LEVEL_PARALLEL_TASKS);
    assert.equal(resolveTopLevelParallelMaxTasks(0), MAX_TOP_LEVEL_PARALLEL_TASKS);
    assert.equal(resolveTopLevelParallelMaxTasks("oops"), MAX_TOP_LEVEL_PARALLEL_TASKS);
  });

  it("resolves concurrency from config or the default", () => {
    assert.equal(resolveTopLevelParallelConcurrency(6), 6);
    assert.equal(resolveTopLevelParallelConcurrency(0), 4);
    assert.equal(resolveTopLevelParallelConcurrency(undefined), 4);
  });
});

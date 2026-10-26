import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dispatchAwaitedRunCompletion,
  disposeAwaitedRuns,
  isAwaitedRun,
  isAwaitedRunOwner,
  registerAwaitedRun,
  unregisterAwaitedRun,
} from "../../src/runs/background/awaited-run-registry.ts";

describe("awaited-run registry", () => {
  it("propagates whether the live owner consumed a completion", () => {
    const runId = "registry-boolean";
    registerAwaitedRun(runId, () => false, 0);
    try {
      assert.equal(isAwaitedRun(runId), true);
      assert.equal(dispatchAwaitedRunCompletion(runId, {}), false);

      registerAwaitedRun(runId, () => true, 0);
      assert.equal(dispatchAwaitedRunCompletion(runId, { generation: 0 }), true);
    } finally {
      unregisterAwaitedRun(runId);
    }
    assert.equal(isAwaitedRun(runId), false);
    assert.equal(dispatchAwaitedRunCompletion(runId, {}), false);
  });

  it("keeps completion suppression generation-aware while retaining existence lookup", () => {
    const runId = "registry-generation";
    registerAwaitedRun(runId, () => true, 7);
    try {
      assert.equal(isAwaitedRun(runId), true);
      assert.equal(dispatchAwaitedRunCompletion(runId, { generation: 6 }), false);
      assert.equal(dispatchAwaitedRunCompletion(runId, { generation: 7 }), true);

      registerAwaitedRun(runId, () => true, 8);
      unregisterAwaitedRun(runId, 7);
      assert.equal(dispatchAwaitedRunCompletion(runId, { generation: 7 }), false);
      assert.equal(dispatchAwaitedRunCompletion(runId, { generation: 8 }), true);
    } finally {
      unregisterAwaitedRun(runId, 8);
    }
  });

  it("keeps superseded registration tokens isolated during cleanup", () => {
    const runId = "registry-token-ownership";
    let superseded = 0;
    const firstToken = registerAwaitedRun(
      runId,
      () => false,
      0,
      undefined,
      undefined,
      () => {
        superseded += 1;
      },
    );
    const replacementToken = registerAwaitedRun(runId, () => true, 0);
    try {
      assert.equal(superseded, 1);
      assert.equal(isAwaitedRunOwner(runId, firstToken), false);
      assert.equal(isAwaitedRunOwner(runId, replacementToken), true);
      assert.equal(dispatchAwaitedRunCompletion(runId, { generation: 0 }), true);

      unregisterAwaitedRun(runId, 0, firstToken);
      assert.equal(isAwaitedRunOwner(runId, replacementToken), true);
      unregisterAwaitedRun(runId, 0, replacementToken);
      assert.equal(isAwaitedRun(runId), false);
    } finally {
      unregisterAwaitedRun(runId, 0, firstToken);
      unregisterAwaitedRun(runId, 0, replacementToken);
    }
  });

  it("disposes active owners without treating late sinks as owners", () => {
    const activeId = "registry-disposer-active";
    const lateId = "registry-disposer-late";
    let activeDisposals = 0;
    let lateDisposals = 0;
    registerAwaitedRun(activeId, undefined, 0, () => activeDisposals++);
    registerAwaitedRun(lateId, () => true, 0);
    try {
      disposeAwaitedRuns();
      assert.equal(activeDisposals, 1);
      assert.equal(lateDisposals, 0);
      assert.equal(isAwaitedRun(activeId), true);
      assert.equal(isAwaitedRun(lateId), true);
    } finally {
      unregisterAwaitedRun(activeId, 0);
      unregisterAwaitedRun(lateId, 0);
    }
  });
});

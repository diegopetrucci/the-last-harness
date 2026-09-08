import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  isLifecycleTransitionContentionError,
  LifecycleGenerationConflictError,
  transitionLifecycleStatus,
  withLifecycleStatusLock,
  writeNormalizedLifecycleStatus,
} from "../../src/runs/shared/lifecycle-state.ts";

function tempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("lifecycle transition contention classification", () => {
  it("classifies the real generation conflict and lock exhaustion errors nominally", () => {
    const root = tempRoot("pi-lifecycle-contention-classes-");
    try {
      const asyncDir = path.join(root, "run");
      writeNormalizedLifecycleStatus(asyncDir, {
        runId: "run",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
        lifecycle: { generation: 2 },
      });

      let generationError: unknown;
      try {
        transitionLifecycleStatus({
          asyncDir,
          expectedGeneration: 1,
          mutate: (status) => status,
        });
      } catch (error) {
        generationError = error;
      }
      assert.ok(generationError instanceof LifecycleGenerationConflictError);
      assert.equal(isLifecycleTransitionContentionError(generationError), true);
      assert.match((generationError as Error).message, /expected generation 1, found 2/);

      let lockError: unknown;
      withLifecycleStatusLock(asyncDir, () => {
        try {
          transitionLifecycleStatus({
            asyncDir,
            expectedGeneration: 2,
            mutate: (status) => status,
            lockOptions: { retryDelaysMs: [] },
          });
        } catch (error) {
          lockError = error;
        }
      });
      assert.equal(isLifecycleTransitionContentionError(lockError), true);
      assert.equal((lockError as Error).name, "LifecycleLockExhaustedError");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not classify unrelated errors by name or misleading messages", () => {
    assert.equal(
      isLifecycleTransitionContentionError(
        new Error("Lifecycle transition rejected: expected generation 1, found 2"),
      ),
      false,
    );
    const misleadingName = new Error("unrelated I/O failure");
    misleadingName.name = "LifecycleGenerationConflictError";
    assert.equal(isLifecycleTransitionContentionError(misleadingName), false);
    assert.equal(
      isLifecycleTransitionContentionError({ name: "LifecycleLockExhaustedError" }),
      false,
    );
    assert.equal(isLifecycleTransitionContentionError(undefined), false);
  });
});

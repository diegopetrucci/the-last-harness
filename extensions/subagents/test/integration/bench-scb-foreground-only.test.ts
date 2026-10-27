/** bench/scb: detached dispatch and durable resume are rejected (fail closed). */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { ASYNC_DIR } from "../../src/shared/types.ts";
import { BENCH_SCB_ALLOW_DETACHED_ENV } from "../../src/shared/bench-scb-foreground.ts";
import {
  createMockPi,
  createTempDir,
  makeMinimalCtx,
  removeTempDir,
  type MockPi,
} from "../support/helpers.ts";
import { makeNativeResultLifecycleExecutor } from "../support/native-result-lifecycle-fixtures.ts";

describe("bench/scb foreground-only enforcement", () => {
  let tempDir: string;
  let mockPi: MockPi;
  let savedEnv: string | undefined;

  before(() => {
    mockPi = createMockPi();
    mockPi.install();
  });
  after(() => mockPi.uninstall());
  beforeEach(() => {
    tempDir = createTempDir("pi-subagent-bench-scb-");
    mockPi.reset();
    // The test loader opts legacy tests back into detached work; undo it here.
    savedEnv = process.env[BENCH_SCB_ALLOW_DETACHED_ENV];
    delete process.env[BENCH_SCB_ALLOW_DETACHED_ENV];
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[BENCH_SCB_ALLOW_DETACHED_ENV];
    else process.env[BENCH_SCB_ALLOW_DETACHED_ENV] = savedEnv;
    removeTempDir(tempDir);
  });

  it("rejects async:true dispatch without spawning", async () => {
    const { executor } = makeNativeResultLifecycleExecutor(tempDir, {});
    const result = await executor.execute(
      "async-reject",
      { agent: "worker", task: "do it", async: true },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /async:true is disabled/);
    assert.match(result.content[0]?.text ?? "", /awaited/);
    assert.equal(mockPi.callCount(), 0);
  });

  it("rejects durable resume of a completed run without spawning", async () => {
    const runId = `bench-scb-resume-${Date.now()}`;
    const asyncDir = path.join(ASYNC_DIR, runId);
    const sessionFile = path.join(tempDir, "child-session.jsonl");
    try {
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify({
          runId,
          mode: "single",
          state: "complete",
          sessionId: "session-123",
          startedAt: 100,
          lastUpdate: 200,
          cwd: tempDir,
          sessionFile,
          steps: [{ agent: "worker", status: "complete" }],
        }),
        "utf-8",
      );
      const { executor } = makeNativeResultLifecycleExecutor(tempDir, {});
      const result = await executor.execute(
        "resume-reject",
        { action: "resume", id: runId, message: "What changed?" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(result.isError, true);
      assert.match(result.content[0]?.text ?? "", /Resuming .* is disabled/);
      assert.match(result.content[0]?.text ?? "", /fresh awaited subagent run/);
      assert.equal(result.details?.asyncId, undefined);
      assert.equal(mockPi.callCount(), 0);
    } finally {
      fs.rmSync(asyncDir, { recursive: true, force: true });
    }
  });
});

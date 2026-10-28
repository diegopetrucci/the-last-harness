/**
 * A detached cohort pause is one supervisor request: resuming the requester starts
 * exactly one continuation and never turns cohort siblings into independent resumes.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { ASYNC_DIR, RESULTS_DIR } from "../../src/shared/types.ts";
import { releaseWorkspaceReservationsForRun } from "../../src/runs/shared/workspace-reservation.ts";
import type { MockPi } from "../support/helpers.ts";
import {
  createMockPi,
  createTempDir,
  makeAgent,
  makeMinimalCtx,
  removeTempDir,
} from "../support/helpers.ts";
import {
  makeNativeResultLifecycleExecutor,
  readAsyncStatusJson,
  waitForRevivedAsyncResult,
} from "../support/native-result-lifecycle-fixtures.ts";

function textOf(result: { content: unknown[] }): string {
  return (result.content[0] as { text?: string } | undefined)?.text ?? "";
}

const REQUESTER = 1;
const SIBLING = 2;

describe("detached cohort pause resumes once", () => {
  let tempDir: string;
  let mockPi: MockPi;
  const cleanup: string[] = [];

  before(() => {
    mockPi = createMockPi();
    mockPi.install();
  });
  after(() => mockPi.uninstall());
  beforeEach(() => {
    tempDir = createTempDir("pi-subagent-cohort-resume-");
    mockPi.reset();
  });
  afterEach(() => {
    for (const id of cleanup.splice(0)) {
      releaseWorkspaceReservationsForRun(id);
      fs.rmSync(path.join(ASYNC_DIR, id), { recursive: true, force: true });
      fs.rmSync(path.join(RESULTS_DIR, `${id}.json`), { force: true });
    }
    removeTempDir(tempDir);
  });

  /** Seed the durable shape a detached parallel cohort leaves behind after one child asked. */
  function seedPausedCohort(): string {
    const runId = `cohort-resume-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    cleanup.push(runId);
    const asyncDir = path.join(ASYNC_DIR, runId);
    fs.mkdirSync(asyncDir, { recursive: true });
    const step = (name: string, status: string, pause?: { kind: string }) => {
      const sessionFile = path.join(tempDir, `${runId}-${name}.jsonl`);
      fs.writeFileSync(sessionFile, "", "utf-8");
      const cwd = path.join(tempDir, name);
      fs.mkdirSync(cwd, { recursive: true });
      return { agent: "worker", status, sessionFile, cwd, ...(pause ? { pause } : {}) };
    };
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        runId,
        mode: "parallel",
        state: "paused",
        sessionId: "session-123",
        startedAt: 100,
        lastUpdate: 200,
        cwd: tempDir,
        pause: { kind: "awaiting_supervisor" },
        steps: [
          step("done", "complete"),
          step("asked", "paused", { kind: "awaiting_supervisor" }),
          step("sibling", "paused", { kind: "cohort_pause" }),
        ],
      }),
      "utf-8",
    );
    return runId;
  }

  const resume = (executor: { execute: Function }, runId: string, index: number) =>
    executor.execute(
      "resume",
      { action: "resume", id: runId, index, message: "Continue." },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    ) as Promise<{ isError?: boolean; content: Array<{ text?: string }>; details?: any }>;

  it("starts one continuation for the requester and leaves cohort siblings paused", async () => {
    const runId = seedPausedCohort();
    const { executor } = makeNativeResultLifecycleExecutor(tempDir, {
      agents: [makeAgent("worker")],
    });
    mockPi.onCall({ output: "continued" });

    const revived = await resume(executor, runId, REQUESTER);
    assert.equal(revived.isError, undefined, textOf(revived));
    const revivedId = await waitForRevivedAsyncResult(revived as never);
    cleanup.push(revivedId);

    assert.equal(mockPi.callCount(), 1, "exactly one child launched for the cohort pause");
    const status = readAsyncStatusJson<{
      steps?: Array<{ status?: string; pause?: { kind?: string } }>;
    }>(runId);
    assert.equal(status.steps?.[SIBLING]?.status, "paused");
    assert.equal(status.steps?.[SIBLING]?.pause?.kind, "cohort_pause");
    assert.equal(mockPi.callCount(), 1, "the sibling never auto-resumes");

    const again = await resume(executor, runId, REQUESTER);
    assert.equal(again.isError, true);
    assert.match(textOf(again), /already (?:launched|claimed)|already continued/i);
    assert.equal(mockPi.callCount(), 1);
  });

  it("lets only one of two racing resumes claim the requester", async () => {
    const runId = seedPausedCohort();
    const first = makeNativeResultLifecycleExecutor(tempDir, { agents: [makeAgent("worker")] });
    const second = makeNativeResultLifecycleExecutor(tempDir, { agents: [makeAgent("worker")] });
    mockPi.onCall({ output: "continued" });

    const [a, b] = await Promise.all([
      resume(first.executor, runId, REQUESTER),
      resume(second.executor, runId, REQUESTER),
    ]);
    const winners = [a, b].filter((result) => result.isError !== true);
    assert.equal(winners.length, 1, `${textOf(a)} | ${textOf(b)}`);
    const loser = [a, b].find((result) => result.isError === true);
    assert.match(loser ? textOf(loser) : "", /already|claimed|launched|reserv/i);
    cleanup.push(await waitForRevivedAsyncResult(winners[0] as never));
    assert.equal(mockPi.callCount(), 1);
  });
});

/**
 * Resume admission through the session ownership record (#829, #830 item 03).
 * Every child is the mock Pi; the process-backed cases launch real runners.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { readSessionRecord, sessionRecordPath } from "../../src/runs/shared/session-record.ts";
import { ASYNC_DIR, RESULTS_DIR } from "../../src/shared/types.ts";
import { waitForAsyncResultFile } from "../support/async-execution-helpers.ts";
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
  startedMockPiPids,
  type ExecutorResult,
} from "../support/native-result-lifecycle-fixtures.ts";
import {
  seedSessionRecord,
  seedUnreleasedLease,
  type SeedSessionRecordOptions,
} from "../support/session-record-fixture.ts";

const CEILING_MS = 3000;

describe("resume admission through the session record", () => {
  let tempDir: string;
  let mockPi: MockPi;
  const createdIds: string[] = [];

  before(() => {
    mockPi = createMockPi();
    mockPi.install();
  });
  after(() => mockPi.uninstall());
  beforeEach(() => {
    tempDir = createTempDir("pi-subagent-resume-admission-");
    mockPi.reset();
  });
  afterEach(() => {
    for (const id of createdIds.splice(0)) {
      fs.rmSync(path.join(ASYNC_DIR, id), { recursive: true, force: true });
      fs.rmSync(path.join(RESULTS_DIR, `${id}.json`), { force: true });
    }
    removeTempDir(tempDir);
  });

  const uniqueId = (label: string): string => {
    const id = `adm-${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    createdIds.push(id);
    return id;
  };

  function makeExecutor() {
    return makeNativeResultLifecycleExecutor(tempDir, {
      agents: [makeAgent("worker", { maxExecutionTimeMs: CEILING_MS })],
    }).executor;
  }

  const resume = (executor: ReturnType<typeof makeExecutor>, id: string): Promise<ExecutorResult> =>
    executor.execute(
      `resume-${id}`,
      { action: "resume", id, message: "Continue the work." },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );

  /** A finished run's lifecycle status plus the session it left behind. */
  function writeRun(
    label: string,
    options: {
      state?: "complete" | "failed" | "paused";
      record?: SeedSessionRecordOptions | "none";
      statusRuntimeMs?: number;
      sessionFile?: string;
      resultOnly?: boolean;
    } = {},
  ): { id: string; sessionFile: string } {
    const id = uniqueId(label);
    const sessionFile = options.sessionFile ?? path.join(tempDir, `${label}.jsonl`);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, "", "utf-8");
    if (options.record !== "none" && !fs.existsSync(`${sessionFile}.owner.json`)) {
      seedSessionRecord(sessionFile, options.record);
    }
    const state = options.state ?? "complete";
    const pause = state === "paused" ? { kind: "awaiting_supervisor" } : undefined;
    const step = {
      agent: "worker",
      status: state,
      ...(pause ? { pause } : {}),
      sessionFile,
      activeRuntimeMs: options.statusRuntimeMs ?? 400,
      timeoutOwner: "role",
    };
    if (!options.resultOnly) {
      const asyncDir = path.join(ASYNC_DIR, id);
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify({
          runId: id,
          mode: "single",
          state,
          startedAt: 1,
          endedAt: 2,
          lastUpdate: 2,
          cwd: tempDir,
          sessionId: "session-123",
          sessionFile,
          ...(pause ? { pause } : {}),
          steps: [step],
        }),
        "utf-8",
      );
    }
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RESULTS_DIR, `${id}.json`),
      JSON.stringify({
        id,
        agent: "worker",
        mode: "single",
        success: state === "complete",
        state: state === "paused" ? "paused" : state,
        sessionId: "session-123",
        summary: "earlier output",
        results: [
          {
            agent: "worker",
            output: "earlier output",
            success: state === "complete",
            sessionFile,
            activeRuntimeMs: step.activeRuntimeMs,
            timeoutOwner: "role",
          },
        ],
      }),
      "utf-8",
    );
    return { id, sessionFile };
  }

  const okRecord = (sessionFile: string) => {
    const read = readSessionRecord(sessionFile);
    assert.equal(read.status, "ok");
    return (read as Extract<typeof read, { status: "ok" }>).record;
  };

  const readResult = (id: string) =>
    JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${id}.json`), "utf-8")) as {
      success?: boolean;
      results?: Array<{ error?: string; timedOut?: boolean; activeRuntimeMs?: number }>;
    };

  function assertRefused(result: ExecutorResult, pattern: RegExp, launches = 0): void {
    assert.equal(result.isError, true, result.content[0]?.text ?? "");
    const text = result.content[0]?.text ?? "";
    assert.match(text, pattern);
    assert.doesNotMatch(text, /subagent\(\{ action: "(status|resume)"/, "no resume hints");
    assert.equal(result.details?.asyncId, undefined);
    assert.equal(mockPi.callCount(), launches, "refusal must not launch a child");
  }

  for (const state of ["complete", "failed"] as const) {
    it(`admits exactly one child for concurrent resumes of one ${state} run`, async () => {
      const { id, sessionFile } = writeRun(`concurrent-${state}`, { state });
      mockPi.onCall({ output: "first", delay: 300 });
      mockPi.onCall({ output: "second", delay: 300 });
      const executor = makeExecutor();
      const replies = await Promise.all([resume(executor, id), resume(executor, id)]);
      const admitted = replies.filter((reply) => !reply.isError);
      for (const reply of replies.filter((candidate) => candidate.isError)) {
        assert.match(reply.content[0]?.text ?? "", /held by a live owner/);
      }
      const runIds = admitted.map((reply) => reply.details?.asyncId as string);
      createdIds.push(...runIds);
      assert.ok(runIds.length >= 1);
      // The loser (if both passed admission) is refused by its own runner.
      const results = await Promise.all(
        replies.filter((r) => !r.isError).map((r) => waitForAsyncResultFile(r.details!.asyncId!)),
      );
      assert.equal(results.length, admitted.length);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(mockPi.callCount(), 1, "only one child may ever run");
      const winners = runIds.filter((runId) => readResult(runId).success);
      assert.equal(winners.length, 1);
      for (const runId of runIds.filter((candidate) => !winners.includes(candidate))) {
        assert.match(
          readResult(runId).results?.[0]?.error ?? "",
          /Refusing to launch child: The session is held by a live owner/,
        );
      }
      const record = okRecord(sessionFile);
      assert.equal(record.lease, undefined);
      assert.equal(record.cleanFinal?.generation, record.generation);
    });
  }

  it("charges the cumulative runtime on a sequential resume through the original id", async () => {
    // The status says 400ms, the shared record says 2800ms: only 200ms remain.
    const { id, sessionFile } = writeRun("cumulative", { record: { activeRuntimeMs: 2800 } });
    mockPi.onCall({ output: "too slow", delay: 5000 });
    const reply = await resume(makeExecutor(), id);
    assert.equal(reply.isError, undefined, reply.content[0]?.text ?? "");
    const runId = reply.details!.asyncId!;
    createdIds.push(runId);
    await waitForAsyncResultFile(runId);
    const child = readResult(runId).results?.[0];
    assert.equal(child?.timedOut, true, "the runner must enforce the shared cumulative runtime");
    assert.ok((child?.activeRuntimeMs ?? 0) >= 2800);
    const record = okRecord(sessionFile);
    assert.ok(record.activeRuntimeMs >= 2800);
    assert.equal(record.retired, true);
  });

  it("refuses the ancestor of a role-timed-out continuation and retires the session", async () => {
    const { id: sourceId, sessionFile } = writeRun("poison", { statusRuntimeMs: 2800 });
    mockPi.onCall({ output: "exceeds remainder", delay: 5000 });
    const executor = makeExecutor();
    const first = await resume(executor, sourceId);
    assert.equal(first.isError, undefined, first.content[0]?.text ?? "");
    const continuationId = first.details!.asyncId!;
    createdIds.push(continuationId);
    await waitForAsyncResultFile(continuationId);
    assert.equal(readResult(continuationId).results?.[0]?.timedOut, true);
    assert.equal(okRecord(sessionFile).retired, true);
    const launches = mockPi.callCount();

    assertRefused(await resume(executor, continuationId), /retired/, launches);
    const viaAncestor = await resume(executor, sourceId);
    assert.equal(viaAncestor.isError, true);
    assert.match(viaAncestor.content[0]?.text ?? "", /retired/);
    assert.match(viaAncestor.content[0]?.text ?? "", /fresh dispatch/);
    assert.equal(mockPi.callCount(), launches);
  });

  it("blocks the 80% context gate through an ancestor id", async () => {
    const { id } = writeRun("context", {
      record: {
        contextUsage: { contextTokens: 95_000, contextWindow: 100_000, contextPercent: 95 },
      },
    });
    // The ancestor's own status carries no context evidence at all.
    assertRefused(await resume(makeExecutor(), id), /Durable resume blocked/);
  });

  it("keeps a retired run refused after its lifecycle dir is cleaned up (#830 item 03)", async () => {
    const { id, sessionFile } = writeRun("result-only", {
      record: { retireReason: "role-timeout" },
      resultOnly: true,
    });
    assert.equal(fs.existsSync(path.join(ASYNC_DIR, id)), false);
    assertRefused(await resume(makeExecutor(), id), /retired \(role-timeout\)/);
    assert.equal(okRecord(sessionFile).retired, true);
  });

  it("refuses an abandoned attempt once its owners are gone", async () => {
    const sessionFile = path.join(tempDir, "abandoned.jsonl");
    const deadPid = spawnSync(process.execPath, ["-e", "0"]).pid!;
    fs.writeFileSync(sessionFile, "", "utf-8");
    seedUnreleasedLease(sessionFile, deadPid);
    const { id } = writeRun("abandoned", { sessionFile });
    assertRefused(await resume(makeExecutor(), id), /did not finish cleanly[\s\S]*fresh dispatch/);
  });

  it("refuses a session whose attempt is still held by a live owner", async () => {
    const sessionFile = path.join(tempDir, "held.jsonl");
    fs.writeFileSync(sessionFile, "", "utf-8");
    seedUnreleasedLease(sessionFile, process.pid);
    const { id } = writeRun("held", { sessionFile });
    const result = await resume(makeExecutor(), id);
    assertRefused(result, /held by a live owner[\s\S]*Wait[\s\S]*interrupt/);
    assert.doesNotMatch(result.content[0]?.text ?? "", /fresh dispatch/);
  });

  it("refuses a run without a record with fresh-dispatch guidance", async () => {
    const { id, sessionFile } = writeRun("legacy", { record: "none" });
    assertRefused(await resume(makeExecutor(), id), /no ownership record[\s\S]*fresh dispatch/);
    assert.equal(readSessionRecord(sessionFile).status, "missing", "no record is invented");
  });

  it("gives distinct errors for corrupt and unreadable records", async () => {
    const corrupt = writeRun("corrupt");
    fs.writeFileSync(sessionRecordPath(corrupt.sessionFile), "{not json", "utf-8");
    assertRefused(await resume(makeExecutor(), corrupt.id), /record is corrupt/);

    const unreadable = writeRun("unreadable");
    const sidecar = sessionRecordPath(unreadable.sessionFile);
    fs.rmSync(sidecar, { force: true });
    fs.mkdirSync(sidecar);
    assertRefused(await resume(makeExecutor(), unreadable.id), /record cannot be read/);

    const wrongSchema = writeRun("wrong-schema");
    fs.writeFileSync(
      sessionRecordPath(wrongSchema.sessionFile),
      JSON.stringify({ schemaVersion: 99 }),
      "utf-8",
    );
    assertRefused(await resume(makeExecutor(), wrongSchema.id), /unsupported schema/);
  });

  it("still resumes cleanly finished and failed runs", async () => {
    const executor = makeExecutor();
    for (const state of ["complete", "failed"] as const) {
      const { id, sessionFile } = writeRun(`ok-${state}`, { state });
      mockPi.onCall({ output: `resumed ${state}` });
      const reply = await resume(executor, id);
      assert.equal(reply.isError, undefined, reply.content[0]?.text ?? "");
      const runId = reply.details!.asyncId!;
      createdIds.push(runId);
      await waitForAsyncResultFile(runId);
      assert.equal(readResult(runId).success, true);
      const record = okRecord(sessionFile);
      assert.equal(record.lease, undefined);
      assert.equal(record.cleanFinal?.generation, record.generation);
    }
  });

  it("leaves a paused run claimable when its session is refused, then resumes once it is clean", async () => {
    const sessionFile = path.join(tempDir, "paused.jsonl");
    fs.writeFileSync(sessionFile, "", "utf-8");
    seedUnreleasedLease(sessionFile, process.pid);
    const { id } = writeRun("paused", { state: "paused", sessionFile });
    const statusPath = path.join(ASYNC_DIR, id, "status.json");
    const before = fs.readFileSync(statusPath, "utf-8");
    const executor = makeExecutor();

    assertRefused(await resume(executor, id), /held by a live owner/);
    assert.equal(fs.readFileSync(statusPath, "utf-8"), before, "no claim was written");

    // The earlier owner finishes cleanly; the same paused run is claimable again.
    fs.rmSync(sessionRecordPath(sessionFile), { force: true });
    seedSessionRecord(sessionFile);
    mockPi.onCall({ output: "continued" });
    const reply = await resume(executor, id);
    assert.equal(reply.isError, undefined, reply.content[0]?.text ?? "");
    const runId = reply.details!.asyncId!;
    createdIds.push(runId);
    await waitForAsyncResultFile(runId);
    assert.equal(readResult(runId).success, true);
    assert.equal(mockPi.callCount(), 1);
    // A second resume of the same paused run is the existing one-claim rule.
    const again = await resume(executor, id);
    assert.equal(again.isError, true);
  });

  it("accepts a live follow-up without taking a new lease", async () => {
    const sessionFile = path.join(tempDir, "live.jsonl");
    fs.writeFileSync(sessionFile, "", "utf-8");
    seedUnreleasedLease(sessionFile, process.pid);
    const before = okRecord(sessionFile);
    const id = uniqueId("live");
    const asyncDir = path.join(ASYNC_DIR, id);
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.writeFileSync(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        runId: id,
        mode: "single",
        state: "running",
        pid: process.pid,
        sessionId: "session-123",
        startedAt: 100,
        lastUpdate: Date.now(),
        sessionFile,
        steps: [{ agent: "worker", status: "running", sessionFile }],
      }),
      "utf-8",
    );
    const { acknowledgeResumeRequests } = await import("../support/live-resume-ack.ts");
    const stop = acknowledgeResumeRequests(asyncDir);
    try {
      const reply = await resume(makeExecutor(), id);
      assert.equal(reply.isError, undefined, reply.content[0]?.text ?? "");
      assert.match(reply.content[0]?.text ?? "", /Resume follow-up accepted for live async run/);
    } finally {
      stop();
    }
    assert.deepEqual(okRecord(sessionFile), before, "the live owner's lease is untouched");
    assert.equal(startedMockPiPids(mockPi).length, 0);
    assert.equal(mockPi.callCount(), 0);
  });
});

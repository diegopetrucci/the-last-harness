/**
 * Dispatcher admission is only a snapshot: a runner that takes the lease after
 * an earlier runner finished must rebase onto the record and re-apply the gates.
 */
import { DISABLED_COMPACT_ARTIFACT_CONFIG as artifactConfig } from "../support/artifact-config-fixtures.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { runSingleStep } from "../../src/runs/background/single-step-execution.ts";
import { readSessionRecord, type SessionRecord } from "../../src/runs/shared/session-record.ts";
import { startedMockPiPids } from "../support/async-execution-helpers.ts";
import {
  createMockPi,
  createTempDir,
  makeRunnerStep,
  removeTempDir,
  type MockPi,
} from "../support/helpers.ts";
import { seedSessionRecord } from "../support/session-record-fixture.ts";

const BUDGET_MS = 3000;

const okRecord = (sessionFile: string): SessionRecord => {
  const read = readSessionRecord(sessionFile);
  assert.equal(read.status, "ok");
  return (read as Extract<typeof read, { status: "ok" }>).record;
};

describe("runner re-applies the gates against the record it leased", () => {
  let mockPi: MockPi;
  let roots: string[];

  before(() => {
    mockPi = createMockPi();
    mockPi.install();
  });
  after(() => mockPi.uninstall());
  beforeEach(() => {
    mockPi.reset();
    roots = [];
  });
  afterEach(() => {
    for (const root of roots.splice(0)) removeTempDir(root);
  });

  function setup(label: string) {
    const root = createTempDir(`tlh-snapshot-${label}-`);
    roots.push(root);
    return { root, sessionFile: path.join(root, "sessions", "child.jsonl") };
  }

  const run = (
    root: string,
    sessionFile: string,
    id: string,
    activeRuntimeMs: number,
    extraCtx: { deadlineAt?: number } = {},
  ) =>
    runSingleStep(
      makeRunnerStep("worker", "Continue.", {
        sessionFile,
        timeoutMs: BUDGET_MS,
        timeoutOwner: "role",
        activeRuntimeMs,
      }),
      {
        cwd: root,
        sessionEnabled: true,
        sessionDir: path.dirname(sessionFile),
        artifactConfig,
        id,
        flatIndex: 0,
        flatStepCount: 1,
        outputFile: path.join(root, `${id}.log`),
        startedAt: Date.now(),
        ...extraCtx,
      },
      () => undefined,
    );

  it("starts from the record's runtime when an earlier runner finished first", async () => {
    const { root, sessionFile } = setup("rebase");
    mockPi.onCall({ output: "A", delay: 300 });
    mockPi.onCall({ output: "B", delay: 100 });
    // Barrier: B is dispatched with the same stale snapshot as A (0ms consumed),
    // but only starts once A has released its lease.
    const first = await run(root, sessionFile, "runner-a", 0);
    assert.equal(first.exitCode, 0, first.error ?? "");
    const afterA = okRecord(sessionFile);
    assert.equal(afterA.lease, undefined);
    assert.ok(afterA.activeRuntimeMs >= 250, `A charged ${afterA.activeRuntimeMs}ms`);

    const second = await run(root, sessionFile, "runner-b", 0);
    assert.equal(second.exitCode, 0, second.error ?? "");
    const afterB = okRecord(sessionFile);
    assert.ok(
      (second.activeRuntimeMs ?? 0) >= afterA.activeRuntimeMs + 80,
      `B reported ${second.activeRuntimeMs}ms on top of ${afterA.activeRuntimeMs}ms`,
    );
    assert.equal(
      afterB.activeRuntimeMs,
      second.activeRuntimeMs,
      "no runtime is lost to a stale base",
    );
    assert.equal(afterB.lease, undefined);
    assert.equal(afterB.cleanFinal?.generation, afterB.generation);
    assert.equal(startedMockPiPids(mockPi).length, 2);
  });

  it("enforces the remaining budget from the rebased runtime", async () => {
    const { root, sessionFile } = setup("deadline");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    seedSessionRecord(sessionFile, { activeRuntimeMs: BUDGET_MS - 300 });
    // The child would finish in 1000ms: inside the stale 2600ms allowance but
    // past the rebased 300ms one, so only the rebased deadline times it out.
    mockPi.onCall({ output: "too slow", delay: 1000 });
    const result = await run(root, sessionFile, "runner-deadline", 400);
    assert.equal(result.timedOut, true, "the 300ms left after rebasing must apply, not 2600ms");
    assert.ok((result.activeRuntimeMs ?? 0) >= BUDGET_MS - 300 + 250);
    const record = okRecord(sessionFile);
    assert.equal(record.retired, true);
    assert.equal(record.activeRuntimeMs, result.activeRuntimeMs);
  });

  it("enforces the rebased role allowance under a looser deadline registered before the lease", async () => {
    const { root, sessionFile } = setup("deadline-preregistered");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    seedSessionRecord(sessionFile, { activeRuntimeMs: BUDGET_MS - 300 });
    mockPi.onCall({ output: "too slow", delay: 1000 });
    // The run-level deadline exists before the lease is taken and is far looser
    // than the role allowance left after rebasing.
    const result = await run(root, sessionFile, "runner-preregistered", 400, {
      deadlineAt: Date.now() + 60_000,
    });
    assert.equal(result.timedOut, true);
    assert.match(result.error ?? "", /timed out after 3000ms/);
    assert.equal(okRecord(sessionFile).retired, true);
  });

  it("refuses without spawning when the record shows the budget exhausted", async () => {
    const { root, sessionFile } = setup("exhausted");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    seedSessionRecord(sessionFile, { activeRuntimeMs: BUDGET_MS });
    const result = await run(root, sessionFile, "runner-exhausted", 400);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.error ?? "", /Refusing to launch child: Agent 'worker' has exhausted/);
    assert.equal(startedMockPiPids(mockPi).length, 0, "Pi must not be spawned");
    const record = okRecord(sessionFile);
    assert.equal(record.retired, true);
    assert.equal(record.lease, undefined, "the lease is released");
    assert.equal(record.cleanFinal?.generation, record.generation);
  });

  it("refuses without spawning when the record is at or above 80% context", async () => {
    const { root, sessionFile } = setup("context");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    seedSessionRecord(sessionFile, {
      activeRuntimeMs: 100,
      contextUsage: { contextTokens: 95_000, contextWindow: 100_000, contextPercent: 95 },
    });
    const result = await run(root, sessionFile, "runner-context", 0);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.error ?? "", /Refusing to launch child: Durable resume blocked/);
    assert.equal(startedMockPiPids(mockPi).length, 0, "Pi must not be spawned");
    const record = okRecord(sessionFile);
    assert.equal(record.retired, false, "context pressure does not retire the session");
    assert.equal(record.lease, undefined);
    assert.equal(record.cleanFinal?.generation, record.generation);
  });
});

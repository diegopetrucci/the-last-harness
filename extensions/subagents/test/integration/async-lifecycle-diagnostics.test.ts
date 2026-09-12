/**
 * Production-runner regressions for supervisor lifecycle CAS diagnostics.
 *
 * The child runner is faulted in a subprocess before it imports lifecycle code;
 * no production fault-injection hooks are involved.
 */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMockPi,
  createTempDir,
  events,
  makeAgent,
  removeTempDir,
} from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import {
  ASYNC_DIR,
  type AsyncResultPayload,
  type AsyncStatusPayload,
  executeAsyncParallel,
  executeAsyncSingle,
  startedMockPiPids,
  waitForAsyncResultFile,
  waitForAsyncStatusPredicate,
  waitForMarker,
  waitForMockPiCall,
  waitForPidsToExit,
} from "../support/async-execution-helpers.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";

const LIFECYCLE_FAULT_PRELOAD = pathToFileURL(
  path.resolve("extensions/subagents/test/support/lifecycle-fault-preload.mjs"),
).href;
const LIFECYCLE_FAULT_ENV_KEYS = [
  "NODE_OPTIONS",
  "TLH_TEST_LIFECYCLE_FAULT_DIR",
  "TLH_TEST_LIFECYCLE_FAULT_GENERATION",
  "TLH_TEST_LIFECYCLE_FAULT_MARKER",
  "TLH_TEST_LIFECYCLE_FAULT_CAUSE",
  "TLH_TEST_LIFECYCLE_FAULT_CAUSE_BYTES",
  "TLH_TEST_LIFECYCLE_DIAGNOSTIC_WRITE_FAILURE",
] as const;

type LifecycleFaultPhase = "running->pausing" | "pausing->paused";
type LifecycleOutcome = "failed" | "paused";

type FaultCase = {
  phase: LifecycleFaultPhase;
  generation: number;
  outcome: LifecycleOutcome;
  writtenState: "pausing" | "paused";
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonl(filePath: string): JsonRecord[] {
  return fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isRecord);
}

function lifecycleDiagnostics(asyncDir: string): JsonRecord[] {
  return readJsonl(path.join(asyncDir, "events.jsonl")).filter(
    (entry) => entry.type === "subagent.run.lifecycle_transition_failed",
  );
}

function killPids(pids: readonly (number | undefined)[]): void {
  for (const pid of pids) {
    if (typeof pid !== "number" || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may already have exited or the platform may not expose SIGKILL.
    }
  }
}

function setFaultEnvironment(options: {
  asyncDir: string;
  generation: number;
  markerPath: string;
  causeMarker: string;
  causeBytes?: number;
  diagnosticWriteFailure?: boolean;
}): Map<string, string | undefined> {
  const previous = new Map<string, string | undefined>();
  for (const key of LIFECYCLE_FAULT_ENV_KEYS) previous.set(key, process.env[key]);
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import=${LIFECYCLE_FAULT_PRELOAD}`]
    .filter(Boolean)
    .join(" ");
  process.env.TLH_TEST_LIFECYCLE_FAULT_DIR = options.asyncDir;
  process.env.TLH_TEST_LIFECYCLE_FAULT_GENERATION = String(options.generation);
  process.env.TLH_TEST_LIFECYCLE_FAULT_MARKER = options.markerPath;
  process.env.TLH_TEST_LIFECYCLE_FAULT_CAUSE = options.causeMarker;
  process.env.TLH_TEST_LIFECYCLE_FAULT_CAUSE_BYTES = String(options.causeBytes ?? 0);
  if (options.diagnosticWriteFailure) {
    process.env.TLH_TEST_LIFECYCLE_DIAGNOSTIC_WRITE_FAILURE = "1";
  } else {
    delete process.env.TLH_TEST_LIFECYCLE_DIAGNOSTIC_WRITE_FAILURE;
  }
  return previous;
}

function restoreFaultEnvironment(previous: Map<string, string | undefined>): void {
  for (const key of LIFECYCLE_FAULT_ENV_KEYS) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

let nextRun = 0;

async function runLifecycleFaultCase(
  tempDir: string,
  mockPi: MockPi,
  faultCase: FaultCase,
  options: { diagnosticWriteFailure?: boolean; causeBytes?: number } = {},
): Promise<{ payload: AsyncResultPayload; status: AsyncStatusPayload; diagnostics: JsonRecord[] }> {
  const id = `async-lifecycle-diagnostic-${faultCase.phase.replaceAll("->", "-")}-${nextRun++}`;
  const asyncDir = path.join(ASYNC_DIR, id);
  const markerPath = path.join(tempDir, `${id}-fault.json`);
  const childGate = path.join(tempDir, `${id}-child-ready`);
  const causeMarker = `TLH-LIFECYCLE-CAUSE-${id}`;
  const previousEnvironment = setFaultEnvironment({
    asyncDir,
    generation: faultCase.generation,
    markerPath,
    causeMarker,
    causeBytes: options.causeBytes,
    diagnosticWriteFailure: options.diagnosticWriteFailure,
  });
  let runnerPid: number | undefined;
  let childPids: number[] = [];
  try {
    const callIndex = mockPi.callCount();
    mockPi.onCall({
      steps: [
        {
          jsonl: [
            events.toolStart("contact_supervisor", {
              reason: "need_decision",
              message: "Need a supervisor decision",
            }),
          ],
        },
      ],
      ignoreSigint: true,
      ignoreSigterm: true,
      keepAliveAfterFinalMessageMs: 30_000,
      waitForMarker: childGate,
    });
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Ask for a supervisor decision and stop there.",
      agentConfig: makeAgent("worker"),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      artifactConfig: {
        mode: "compact",
        enabled: true,
        includeInput: false,
        includeOutput: true,
        includeJsonl: false,
        includeTranscript: false,
        includeMetadata: true,
        cleanupDays: 7,
      },
      shareEnabled: false,
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
    });

    const runningStatus = await waitForAsyncStatusPredicate(
      asyncDir,
      (status) => status.state === "running" && typeof status.pid === "number",
      `${faultCase.phase} runner startup`,
    );
    runnerPid = runningStatus.pid;
    await waitForMockPiCall(mockPi, callIndex);
    childPids = startedMockPiPids(mockPi);
    fs.writeFileSync(childGate, "", "utf-8");

    const resultPath = await waitForAsyncResultFile(id, scaleTestTimeout(30_000));
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    const status = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.equal(payload.state, faultCase.outcome);
    assert.equal(status.state, faultCase.outcome);
    const fault = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as JsonRecord;
    assert.equal(fault.generation, faultCase.generation);
    assert.equal(fault.state, faultCase.writtenState);
    assert.equal(path.dirname(path.resolve(String(fault.filePath))), asyncDir);
    assert.match(path.basename(String(fault.filePath)), /^\.status\.json\..+\.tmp$/);

    const diagnostics = lifecycleDiagnostics(asyncDir);
    if (options.diagnosticWriteFailure) {
      assert.equal(diagnostics.length, 0, "diagnostic append failure must not add an event");
    } else {
      assert.equal(diagnostics.length, 1);
      const diagnostic = diagnostics[0]!;
      assert.equal(diagnostic.runId, id);
      assert.equal(diagnostic.phase, faultCase.phase);
      assert.match(String(diagnostic.cause), new RegExp(causeMarker));
      assert.match(String(diagnostic.cause), /code=ENOSPC/);
      assert.ok(
        Buffer.byteLength(String(diagnostic.cause), "utf8") <= 4 * 1024,
        "transition cause detail must remain bounded",
      );
    }

    await waitForPidsToExit(
      [runnerPid, ...childPids],
      `${faultCase.phase} lifecycle fault processes`,
      scaleTestTimeout(15_000),
    );
    return { payload, status, diagnostics };
  } finally {
    // Keep cleanup unconditional even when a production-path assertion or wait fails.
    if (runnerPid === undefined) {
      try {
        const status = JSON.parse(
          fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
        ) as AsyncStatusPayload;
        runnerPid = status.pid;
      } catch {
        // The runner may have failed before creating its status file.
      }
    }
    childPids = [...new Set([...childPids, ...startedMockPiPids(mockPi)])];
    const knownPids = [runnerPid, ...childPids];
    killPids(knownPids);
    try {
      await waitForPidsToExit(
        knownPids,
        `${faultCase.phase} lifecycle fault cleanup`,
        scaleTestTimeout(5_000),
      );
    } catch {
      // Do not mask the original test failure with best-effort process cleanup.
    }
    restoreFaultEnvironment(previousEnvironment);
  }
}

async function runParallelLifecycleFaultCase(
  tempDir: string,
  mockPi: MockPi,
): Promise<{ payload: AsyncResultPayload; status: AsyncStatusPayload; diagnostics: JsonRecord[] }> {
  const id = `async-lifecycle-diagnostic-parallel-${nextRun++}`;
  const asyncDir = path.join(ASYNC_DIR, id);
  const markerPath = path.join(tempDir, `${id}-fault.json`);
  const settledSiblingMarker = path.join(tempDir, `${id}-settled-sibling`);
  const pauseRequestMarker = path.join(tempDir, `${id}-pause-request`);
  const cohortReadyMarker = path.join(tempDir, `${id}-cohort-ready`);
  const releasePauseMarker = path.join(tempDir, `${id}-release-pause`);
  const causeMarker = `TLH-LIFECYCLE-CAUSE-${id}`;
  const previousEnvironment = setFaultEnvironment({
    asyncDir,
    generation: 1,
    markerPath,
    causeMarker,
  });
  let runnerPid: number | undefined;
  let childPids: number[] = [];
  const existingChildPids = new Set(startedMockPiPids(mockPi));
  try {
    mockPi.onCall({
      matchArgIncludes: "settled sibling",
      output: "settled sibling output",
      writeMarkerAfter: settledSiblingMarker,
    });
    mockPi.onCall({
      matchArgIncludes: "request supervisor",
      waitForMarker: settledSiblingMarker,
      writeMarker: pauseRequestMarker,
      steps: [
        {
          waitForMarker: releasePauseMarker,
          jsonl: [
            events.toolStart("contact_supervisor", {
              reason: "need_decision",
              message: "Need a supervisor decision",
            }),
          ],
        },
      ],
      ignoreSigint: true,
      ignoreSigterm: true,
      keepAliveAfterFinalMessageMs: 30_000,
    });
    mockPi.onCall({
      matchArgIncludes: "cohort child",
      waitForMarker: pauseRequestMarker,
      steps: [
        {
          writeMarker: cohortReadyMarker,
          waitForMarker: releasePauseMarker,
        },
      ],
      ignoreSigint: true,
      ignoreSigterm: true,
      keepAliveAfterFinalMessageMs: 30_000,
    });
    const started = executeAsyncParallel!(id, {
      tasks: [
        { agent: "settled", task: "settled sibling" },
        { agent: "requester", task: "request supervisor" },
        { agent: "cohort", task: "cohort child" },
      ],
      concurrency: 3,
      agents: [makeAgent("settled"), makeAgent("requester"), makeAgent("cohort")],
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
    });
    assert.equal(started.isError, undefined);

    const runningStatus = await waitForAsyncStatusPredicate(
      asyncDir,
      (status) => status.state === "running" && typeof status.pid === "number",
      "parallel lifecycle fault runner startup",
    );
    runnerPid = runningStatus.pid;
    await waitForMarker(cohortReadyMarker);
    await waitForAsyncStatusPredicate(
      asyncDir,
      (status) => status.steps?.[0]?.status === "complete",
      "parallel lifecycle fault settled sibling completion",
    );
    fs.writeFileSync(releasePauseMarker, "", "utf-8");
    childPids = startedMockPiPids(mockPi).filter((pid) => !existingChildPids.has(pid));

    const resultPath = await waitForAsyncResultFile(id, scaleTestTimeout(30_000));
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    const status = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.equal(payload.state, "failed");
    assert.equal(status.state, "failed");
    const fault = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as JsonRecord;
    assert.equal(fault.generation, 1);
    assert.equal(fault.state, "pausing");
    assert.equal(path.dirname(path.resolve(String(fault.filePath))), asyncDir);
    assert.match(path.basename(String(fault.filePath)), /^\.status\.json\..+\.tmp$/);

    const diagnostics = lifecycleDiagnostics(asyncDir);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.phase, "running->pausing");
    assert.match(String(diagnostics[0]?.cause), new RegExp(causeMarker));
    await waitForPidsToExit(
      [runnerPid, ...childPids],
      `parallel lifecycle fault processes ${id}`,
      scaleTestTimeout(15_000),
    );
    return { payload, status, diagnostics };
  } finally {
    if (runnerPid === undefined) {
      try {
        const status = JSON.parse(
          fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
        ) as AsyncStatusPayload;
        runnerPid = status.pid;
      } catch {
        // The runner may have failed before creating its status file.
      }
    }
    childPids = [
      ...new Set([
        ...childPids,
        ...startedMockPiPids(mockPi).filter((pid) => !existingChildPids.has(pid)),
      ]),
    ];
    const knownPids = [runnerPid, ...childPids];
    killPids(knownPids);
    try {
      await waitForPidsToExit(
        knownPids,
        `parallel lifecycle fault cleanup ${id}`,
        scaleTestTimeout(5_000),
      );
    } catch {
      // Do not mask the original test failure with best-effort process cleanup.
    }
    restoreFaultEnvironment(previousEnvironment);
  }
}

describe("async supervisor lifecycle transition diagnostics", () => {
  let tempDir: string;
  let mockPi: MockPi;

  before(() => {
    mockPi = createMockPi();
    mockPi.install();
  });

  after(() => {
    mockPi.uninstall();
  });

  beforeEach(() => {
    tempDir = createTempDir();
    mockPi.reset();
  });

  afterEach(() => {
    // The child helper owns the run-specific cleanup; this removes the test cwd
    // after every case without touching the isolated profile or normal Pi config.
    removeTempDir(tempDir);
  });

  it(
    "records the original pre-checkpoint CAS cause and preserves failed teardown",
    {
      skip:
        process.platform === "win32"
          ? "cross-process supervisor pause delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const result = await runLifecycleFaultCase(
        tempDir,
        mockPi,
        {
          phase: "running->pausing",
          generation: 1,
          outcome: "failed",
          writtenState: "pausing",
        },
        { causeBytes: 12_000 },
      );
      assert.equal(result.payload.state, "failed");
      assert.equal(result.status.state, "failed");
      assert.equal(result.payload.pause, undefined);
      assert.equal(result.status.pause, undefined);
      assert.equal(result.status.steps?.[0]?.processCleanup?.terminated, true);
      const [normalized] = result.payload.results;
      assert.equal(normalized?.agent, "worker");
      assert.equal(
        normalized?.output,
        "Async supervisor lifecycle update failed. The run was stopped safely and marked failed.",
      );
      assert.equal(
        normalized?.error,
        "Async supervisor lifecycle update failed. The run was stopped safely and marked failed.",
      );
      assert.equal(normalized?.success, false);
      assert.equal(normalized?.exitCode, 1);
      assert.equal(normalized?.interrupted, undefined);
      assert.equal(normalized?.pause, undefined);
      assert.equal(normalized?.terminationReason, "paused");
    },
  );

  it(
    "retains post-checkpoint diagnostics in compact mode and preserves safe pause",
    {
      skip:
        process.platform === "win32"
          ? "cross-process supervisor pause delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const result = await runLifecycleFaultCase(tempDir, mockPi, {
        phase: "pausing->paused",
        generation: 2,
        outcome: "paused",
        writtenState: "paused",
      });
      assert.equal(result.payload.state, "paused");
      assert.equal(result.status.state, "paused");
      assert.equal(result.payload.pause?.kind, "awaiting_supervisor");
      assert.equal(result.status.pause?.kind, "awaiting_supervisor");
      assert.equal(result.status.steps?.[0]?.processCleanup?.terminated, true);
      assert.equal(result.diagnostics[0]?.phase, "pausing->paused");
    },
  );

  it(
    "normalizes only paused children after a failed parallel supervisor finalization",
    {
      skip:
        process.platform === "win32"
          ? "cross-process supervisor pause delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const result = await runParallelLifecycleFaultCase(tempDir, mockPi);
      const lifecycleError =
        "Async supervisor lifecycle update failed. The run was stopped safely and marked failed.";
      assert.deepEqual(
        result.status.steps?.map((step) => step.status),
        ["complete", "failed", "failed"],
      );
      assert.equal(result.payload.results.length, 3);
      const settled = result.payload.results.find((child) => child.agent === "settled");
      assert.ok(settled);
      assert.equal(settled.output, "settled sibling output");
      assert.equal(settled.success, true);
      assert.equal(settled.exitCode, 0);
      assert.equal(settled.interrupted, undefined);
      assert.equal(settled.pause, undefined);
      for (const agent of ["requester", "cohort"]) {
        const child = result.payload.results.find((candidate) => candidate.agent === agent);
        assert.ok(child);
        assert.equal(child.output, lifecycleError);
        assert.equal(child.error, lifecycleError);
        assert.equal(child.success, false);
        assert.equal(child.exitCode, 1);
        assert.equal(child.interrupted, undefined);
        assert.equal(child.pause, undefined);
        assert.equal(child.terminationReason, "paused");
      }
    },
  );

  it(
    "keeps both lifecycle outcomes when diagnostic storage fails",
    {
      skip:
        process.platform === "win32"
          ? "cross-process supervisor pause delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const preCheckpoint = await runLifecycleFaultCase(
        tempDir,
        mockPi,
        {
          phase: "running->pausing",
          generation: 1,
          outcome: "failed",
          writtenState: "pausing",
        },
        { diagnosticWriteFailure: true },
      );
      const postCheckpoint = await runLifecycleFaultCase(
        tempDir,
        mockPi,
        {
          phase: "pausing->paused",
          generation: 2,
          outcome: "paused",
          writtenState: "paused",
        },
        { diagnosticWriteFailure: true },
      );
      assert.equal(preCheckpoint.payload.state, "failed");
      assert.equal(preCheckpoint.status.state, "failed");
      assert.equal(postCheckpoint.payload.state, "paused");
      assert.equal(postCheckpoint.status.state, "paused");
      assert.equal(postCheckpoint.payload.pause?.kind, "awaiting_supervisor");
      assert.equal(preCheckpoint.status.steps?.[0]?.processCleanup?.terminated, true);
      assert.equal(postCheckpoint.status.steps?.[0]?.processCleanup?.terminated, true);
    },
  );
});

/** Integration coverage for async child-process protocol and diagnostic hardening. */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ASYNC_DIR,
  executeAsyncSingle,
  requestAsyncInterrupt,
  startedMockPiPids,
  waitForAsyncResultFile,
  waitForAsyncState,
  waitForAsyncStatusPredicate,
  waitForMockPiCall,
  waitForPidsToExit,
} from "../support/async-execution-helpers.ts";
import {
  createMockPi,
  createTempDir,
  events,
  makeAgent,
  removeTempDir,
} from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";
import {
  MAX_CHILD_ERROR_BYTES,
  MAX_CHILD_PENDING_LINE_BYTES,
  MAX_CHILD_RAW_STDOUT_BYTES,
  MAX_CHILD_STDERR_BYTES,
} from "../../src/runs/shared/child-protocol.ts";
import { resolveArtifactConfig } from "../../src/shared/artifacts.ts";
import type { AsyncResultArtifact, AsyncStatus } from "../../src/shared/types.ts";

function readAsyncEventTypes(asyncDir: string): string[] {
  const eventPath = path.join(asyncDir, "events.jsonl");
  const text = fs.readFileSync(eventPath, "utf8").trim();
  assert.ok(text.length > 0, "async event log should contain lifecycle records");
  return text.split("\n").map((line, index) => {
    const record: unknown = JSON.parse(line);
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`async event ${index} should be a JSON object`);
    }
    const type = (record as Record<string, unknown>).type;
    if (typeof type !== "string") throw new Error(`async event ${index} should have a type`);
    return type;
  });
}

function compactArtifactConfig() {
  return resolveArtifactConfig({ mode: "compact" });
}

async function killMockChildren(mockPi: MockPi): Promise<void> {
  const pids = startedMockPiPids(mockPi);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The runner may already have reaped the fixture.
    }
  }
  await waitForPidsToExit(pids, "mock child cleanup", scaleTestTimeout(5_000)).catch(() => {
    // Cleanup is best effort after assertions have determined the result.
  });
}

function asyncSingleParams(
  tempDir: string,
  overrides: Record<string, unknown> = {},
): Parameters<typeof executeAsyncSingle>[1] {
  return {
    agent: "worker",
    task: "Exercise async child process handling.",
    agentConfig: makeAgent("worker"),
    ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
    artifactConfig: compactArtifactConfig(),
    shareEnabled: false,
    maxSubagentDepth: 2,
    ...overrides,
  };
}

describe("async child process protocol hardening", () => {
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
    tempDir = createTempDir("child-process-hardening-");
    mockPi.reset();
  });

  afterEach(async () => {
    await killMockChildren(mockPi);
    removeTempDir(tempDir);
  });

  it("uses a bounded raw stdout prefix with a visible truncation marker", async () => {
    const id = `async-raw-stdout-prefix-${Date.now().toString(36)}`;
    const prefixStart = "RAW_STDOUT_PREFIX_BEGIN_";
    const suffix = "_RAW_STDOUT_PREFIX_END";
    mockPi.onCall({
      rawStdout: `${prefixStart}${"x".repeat(MAX_CHILD_RAW_STDOUT_BYTES)}${suffix}`,
    });

    const start = executeAsyncSingle(
      id,
      asyncSingleParams(tempDir, {
        task: "Capture the startup diagnostic.",
        agentConfig: makeAgent("worker"),
      }),
    );
    assert.equal(start.isError, undefined);

    const resultPath = await waitForAsyncResultFile(id, scaleTestTimeout(10_000));
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as AsyncResultArtifact;
    const child = result.results[0];
    assert.equal(result.success, true);
    assert.equal(child?.success, true);
    assert.ok(child?.output.startsWith(prefixStart));
    assert.match(child?.output ?? "", /stdout truncated: showing the bounded prefix/);
    assert.doesNotMatch(child?.output ?? "", new RegExp(suffix));
    assert.ok(Buffer.byteLength(child?.output ?? "", "utf8") <= MAX_CHILD_RAW_STDOUT_BYTES + 128);
  });

  it(
    "terminates async stdout protocol overflow with SIGTERM then bounded SIGKILL escalation",
    { skip: process.platform === "win32" ? "POSIX signal escalation fixture" : undefined },
    async () => {
      const id = `async-protocol-overflow-${Date.now().toString(36)}`;
      const oversizedLine = `ASYNC_PROTOCOL_BEGIN_${"x".repeat(MAX_CHILD_PENDING_LINE_BYTES)}_ASYNC_PROTOCOL_END`;
      mockPi.onCall({
        steps: [
          {
            jsonl: [events.toolStart("read", { path: "fixture.txt" }), "ordinary child stdout"],
            stderr: "ordinary child stderr\n",
          },
          {
            stderr: `ASYNC_STDERR_BEGIN_${"x".repeat(MAX_CHILD_STDERR_BYTES)}_ASYNC_STDERR_END\n`,
          },
          { jsonl: [oversizedLine] },
        ],
        keepAliveAfterFinalMessageMs: 60_000,
        ignoreSigterm: true,
      });

      const start = executeAsyncSingle(
        id,
        asyncSingleParams(tempDir, {
          task: "Trigger protocol overflow.",
          agentConfig: makeAgent("worker", { fallbackModels: ["mock/fallback"] }),
        }),
      );
      assert.equal(start.isError, undefined);
      await waitForMockPiCall(mockPi, 0, scaleTestTimeout(5_000));

      const resultPath = await waitForAsyncResultFile(id, scaleTestTimeout(10_000));
      const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as AsyncResultArtifact;
      const child = result.results[0];
      assert.equal(result.success, false);
      assert.equal(result.state, "failed");
      assert.match(child?.error ?? "", /protocol_output_limit/);
      assert.match(child?.output ?? "", /protocol_output_limit/);
      assert.equal(child?.success, false);
      assert.equal(child?.exitSignal, "SIGKILL");
      assert.equal(child?.protocolOutputLimit?.code, "protocol_output_limit");

      const pid = startedMockPiPids(mockPi)[0];
      assert.ok(pid);
      const signals = fs.readFileSync(path.join(mockPi.dir, `signals-${pid}.jsonl`), "utf8");
      assert.match(signals, /"signal":"SIGTERM"/);
      const eventTypes = readAsyncEventTypes(path.join(ASYNC_DIR, id));
      for (const type of [
        "subagent.child.stderr.truncated",
        "subagent.child.stderr.overflow",
        "subagent.child.protocol_output_limit",
      ]) {
        assert.ok(
          eventTypes.includes(type),
          `compact events should retain bounded diagnostic notice ${type}`,
        );
      }
      for (const type of [
        "subagent.child.stderr",
        "subagent.child.stdout",
        "tool_execution_start",
      ]) {
        assert.equal(eventTypes.includes(type), false, `compact events should suppress ${type}`);
      }
      assert.equal(mockPi.callCount(), 1);
    },
  );

  it("bounds async stderr tails and reports overflow in the result and event log", async () => {
    const id = `async-stderr-overflow-${Date.now().toString(36)}`;
    const beginning = "ASYNC_STDERR_BEGIN_";
    const ending = "_ASYNC_STDERR_END";
    mockPi.onCall({
      stderr: `${beginning}${"x".repeat(MAX_CHILD_STDERR_BYTES)}${ending}`,
      exitCode: 1,
    });

    const start = executeAsyncSingle(
      id,
      asyncSingleParams(tempDir, {
        task: "Capture stderr.",
      }),
    );
    assert.equal(start.isError, undefined);

    const resultPath = await waitForAsyncResultFile(id, scaleTestTimeout(10_000));
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as AsyncResultArtifact;
    const child = result.results[0];
    const status = JSON.parse(
      fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf8"),
    ) as AsyncStatus;
    assert.equal(result.success, false);
    assert.equal(child?.stderrTruncated, true);
    assert.equal(status.steps?.[0]?.stderrTruncated, true);
    assert.ok(Buffer.byteLength(status.steps?.[0]?.stderr ?? "", "utf8") <= MAX_CHILD_ERROR_BYTES);
    assert.match(child?.stderr ?? "", /stderr truncated/);
    assert.match(child?.error ?? "", /stderr truncated/);
    assert.match(child?.error ?? "", new RegExp(ending));
    assert.doesNotMatch(child?.error ?? "", new RegExp(beginning));
    const eventText = fs.readFileSync(path.join(ASYNC_DIR, id, "events.jsonl"), "utf8");
    assert.match(eventText, /subagent\.child\.stderr\.truncated/);
    assert.match(eventText, /subagent\.child\.stderr\.overflow/);
  });

  it("preserves the async startup interrupt trampoline when an interrupt arrives immediately", async () => {
    const id = `async-startup-interrupt-${Date.now().toString(36)}`;
    mockPi.onCall({ waitForMarker: path.join(tempDir, "never-created.marker") });

    const start = executeAsyncSingle(
      id,
      asyncSingleParams(tempDir, {
        task: "Wait for an interrupt.",
      }),
    );
    assert.equal(start.isError, undefined);
    requestAsyncInterrupt(path.join(ASYNC_DIR, id), { source: "startup-interrupt-test" });

    const resultPath = await waitForAsyncResultFile(id, scaleTestTimeout(10_000));
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as AsyncResultArtifact;
    assert.equal(result.state, "paused");
    assert.equal(result.success, false);
  });

  it(
    "preserves timeout precedence when async stdout overflow arrives later",
    { skip: process.platform === "win32" ? "POSIX signal escalation fixture" : undefined },
    async () => {
      const id = `async-timeout-before-overflow-${Date.now().toString(36)}`;
      const releaseMarker = path.join(tempDir, "async-timeout-release");
      const oversizedLine = `ASYNC_TIMEOUT_WON_FIRST_${"x".repeat(MAX_CHILD_PENDING_LINE_BYTES)}`;
      mockPi.onCall({
        waitForMarker: releaseMarker,
        rawStdout: oversizedLine,
        keepAliveAfterFinalMessageMs: 10_000,
        ignoreSigint: true,
        ignoreSigterm: true,
      });

      const start = executeAsyncSingle(
        id,
        asyncSingleParams(tempDir, {
          task: "Timeout before overflow.",
          // Leave enough startup headroom for a loaded runner process while
          // still timing out well before the released overflow line.
          timeoutMs: scaleTestTimeout(1_500),
        }),
      );
      assert.equal(start.isError, undefined);
      await waitForMockPiCall(mockPi, 0, scaleTestTimeout(10_000));
      const asyncDir = path.join(ASYNC_DIR, id);
      await waitForAsyncStatusPredicate(
        asyncDir,
        (status) => status.timedOut === true,
        "async timeout before protocol overflow",
        scaleTestTimeout(10_000),
      );
      fs.writeFileSync(releaseMarker, "", "utf8");

      const resultPath = await waitForAsyncResultFile(id, scaleTestTimeout(10_000));
      const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as AsyncResultArtifact;
      const child = result.results[0];
      assert.equal(result.success, false);
      assert.equal(result.timedOut, true);
      assert.equal(child?.timedOut, true);
      assert.equal(child?.terminationReason, "timed_out");
      assert.equal(child?.protocolOutputLimit, undefined);
    },
  );

  it(
    "preserves interrupt precedence when async stdout overflow arrives later",
    { skip: process.platform === "win32" ? "POSIX signal escalation fixture" : undefined },
    async () => {
      const id = `async-interrupt-before-overflow-${Date.now().toString(36)}`;
      const releaseMarker = path.join(tempDir, "async-interrupt-release");
      const oversizedLine = `ASYNC_INTERRUPT_WON_FIRST_${"x".repeat(MAX_CHILD_PENDING_LINE_BYTES)}`;
      mockPi.onCall({
        waitForMarker: releaseMarker,
        rawStdout: oversizedLine,
        keepAliveAfterFinalMessageMs: 10_000,
        ignoreSigint: true,
        ignoreSigterm: true,
      });

      const start = executeAsyncSingle(
        id,
        asyncSingleParams(tempDir, {
          task: "Interrupt before overflow.",
        }),
      );
      assert.equal(start.isError, undefined);
      await waitForMockPiCall(mockPi, 0, scaleTestTimeout(5_000));
      const asyncDir = path.join(ASYNC_DIR, id);
      requestAsyncInterrupt(asyncDir, { source: "interrupt-precedence-test" });
      await waitForAsyncState(asyncDir, "paused", scaleTestTimeout(10_000));
      fs.writeFileSync(releaseMarker, "", "utf8");

      const resultPath = await waitForAsyncResultFile(id, scaleTestTimeout(10_000));
      const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as AsyncResultArtifact;
      const child = result.results[0];
      assert.equal(result.state, "paused");
      assert.equal(result.success, false);
      assert.equal(child?.terminationReason, "paused");
      assert.equal(child?.protocolOutputLimit, undefined);
    },
  );
});

/**
 * Child process protocol hardening tests on the background/async path.
 *
 * Provenance (tlhf-60wy): the foreground runSync variants of these tests were
 * removed with the engine. Shared invariants (malformed-envelope and transcript
 * retention, raw stderr archive, overflow and timeout precedence) are exercised
 * here against real background children; pure validator behavior lives in
 * unit/child-protocol.test.ts.
 */

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
import type { AsyncResultArtifact } from "../../src/shared/types.ts";

function readTranscriptText(transcriptPath: string, recordType: string): string {
  return fs
    .readFileSync(transcriptPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const record: unknown = JSON.parse(line);
      if (!record || typeof record !== "object" || Array.isArray(record)) return "";
      const typed = record as { recordType?: unknown; text?: unknown };
      return typed.recordType === recordType && typeof typed.text === "string" ? typed.text : "";
    })
    .join("");
}

function readAsyncEventTypes(asyncDir: string): string[] {
  const eventsPath = path.join(asyncDir, "events.jsonl");
  if (!fs.existsSync(eventsPath)) return [];
  return fs
    .readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
      const { type } = parsed as { type?: unknown };
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

describe("real child process protocol hardening — background path", () => {
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
    const id = `background-raw-stdout-prefix-${Date.now().toString(36)}`;
    const prefixStart = "RAW_STDOUT_PREFIX_BEGIN_";
    const suffix = "_RAW_STDOUT_PREFIX_END";
    mockPi.onCall({
      rawStdout: `${prefixStart}${"x".repeat(MAX_CHILD_RAW_STDOUT_BYTES)}${suffix}`,
    });
    const start = executeAsyncSingle(id, {
      agent: "worker",
      task: "Capture the startup diagnostic",
      agentConfig: makeAgent("worker", { completionGuard: false }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      maxSubagentDepth: 2,
    });
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
    "preserves async timeout precedence when stdout overflow arrives later",
    { skip: process.platform === "win32" ? "POSIX signal escalation fixture" : undefined },
    async () => {
      const id = `background-timeout-before-overflow-${Date.now().toString(36)}`;
      const oversizedLine = `ASYNC_TIMEOUT_WON_FIRST_${"x".repeat(MAX_CHILD_PENDING_LINE_BYTES)}`;
      const releaseMarker = path.join(tempDir, "async-timeout-release");
      mockPi.onCall({
        waitForMarker: releaseMarker,
        rawStdout: oversizedLine,
        keepAliveAfterFinalMessageMs: 10_000,
        ignoreSigterm: true,
      });
      const start = executeAsyncSingle(id, {
        agent: "worker",
        task: "Wait for timeout before emitting overflow",
        agentConfig: makeAgent("worker", {
          maxExecutionTimeMs: scaleTestTimeout(1_000),
        }),
        ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
        artifactConfig: compactArtifactConfig(),
        maxSubagentDepth: 2,
      });
      assert.equal(start.isError, undefined);
      await waitForMockPiCall(mockPi, 0);
      const asyncDir = path.join(ASYNC_DIR, id);
      const timedOutStatus = await waitForAsyncStatusPredicate(
        asyncDir,
        (status) => status.timedOut === true && status.steps?.[0]?.timedOut === true,
        "async step timeout",
      );
      assert.equal(timedOutStatus.steps?.[0]?.terminationReason, "timed_out");
      fs.writeFileSync(releaseMarker, "", "utf-8");

      const resultPath = await waitForAsyncResultFile(id, scaleTestTimeout(10_000));
      const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as AsyncResultArtifact;
      const child = result.results[0];
      assert.equal(result.success, false);
      assert.equal(result.timedOut, true);
      assert.equal(child?.timedOut, true);
      assert.equal(child?.terminationReason, "timed_out");
      assert.equal(child?.protocolOutputLimit, undefined);
      assert.doesNotMatch(child?.error ?? "", /protocol_output_limit/);
    },
  );

  it(
    "terminates background stdout protocol overflow deterministically",
    { skip: process.platform === "win32" ? "POSIX signal escalation fixture" : undefined },
    async () => {
      const id = `background-protocol-overflow-${Date.now().toString(36)}`;
      const oversizedLine = `BG_PROTOCOL_BEGIN_${"x".repeat(MAX_CHILD_PENDING_LINE_BYTES)}_BG_PROTOCOL_END`;
      mockPi.onCall({
        steps: [
          {
            jsonl: [events.toolStart("read", { path: "fixture.txt" }), "ordinary child stdout"],
            stderr: "ordinary child stderr\n",
          },
          {
            stderr: `BG_STDERR_BEGIN_${"x".repeat(MAX_CHILD_STDERR_BYTES)}_BG_STDERR_END\n`,
          },
          { jsonl: [oversizedLine] },
        ],
        keepAliveAfterFinalMessageMs: 60_000,
        ignoreSigterm: true,
      });
      const start = executeAsyncSingle(id, {
        agent: "worker",
        task: "Trigger overflow",
        agentConfig: makeAgent("worker", { fallbackModels: ["mock/fallback"] }),
        ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
        artifactConfig: compactArtifactConfig(),
        maxSubagentDepth: 2,
      });
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
    const id = `background-stderr-overflow-${Date.now().toString(36)}`;
    const beginning = "BG_STDERR_BEGIN_";
    const ending = "_BG_STDERR_END";
    mockPi.onCall({
      stderr: `${beginning}${"x".repeat(MAX_CHILD_STDERR_BYTES)}${ending}`,
      exitCode: 1,
    });
    const start = executeAsyncSingle(id, {
      agent: "worker",
      task: "Capture stderr",
      agentConfig: makeAgent("worker"),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      maxSubagentDepth: 2,
    });
    assert.equal(start.isError, undefined);
    const resultPath = await waitForAsyncResultFile(id, scaleTestTimeout(10_000));
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as AsyncResultArtifact;
    const child = result.results[0];
    const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf8")) as {
      steps?: Array<{ stderr?: string; stderrTruncated?: boolean }>;
    };
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

  it("retains malformed known envelopes and unknown events in the transcript without changing state", async () => {
    const id = `background-malformed-protocol-${Date.now().toString(36)}`;
    const artifactsDir = path.join(tempDir, "artifacts");
    const malformedEvent = {
      type: "message_end",
      message: { role: "assistant", content: "not an array" },
    };
    const unknownEvent = { type: "unknown_future_event", message: { injected: true } };
    mockPi.onCall({
      jsonl: [malformedEvent, unknownEvent, events.assistantMessage("valid after malformed lines")],
    });
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Read the result",
      agentConfig: makeAgent("worker", { completionGuard: false }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      artifactsDir,
      artifactConfig: {
        enabled: true,
        includeInput: false,
        includeOutput: false,
        includeJsonl: true,
        includeTranscript: true,
        includeMetadata: false,
        cleanupDays: 7,
      },
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
    });
    const resultPath = await waitForAsyncResultFile(id, scaleTestTimeout(10_000));
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as AsyncResultArtifact;
    const child = result.results[0];
    assert.equal(result.success, true);
    assert.equal(child?.output, "valid after malformed lines");
    assert.ok(child?.transcriptPath, "expected transcript artifact");
    assert.equal(
      readTranscriptText(child.transcriptPath, "stdout"),
      `${JSON.stringify(malformedEvent)}${JSON.stringify(unknownEvent)}`,
    );
  });

  it("retains unknown protocol envelopes in the transcript when JSONL is disabled", async () => {
    const id = `background-transcript-only-${Date.now().toString(36)}`;
    const artifactsDir = path.join(tempDir, "transcript-only");
    const unknownEvent = { type: "future_transcript_event", nested: { retained: true } };
    mockPi.onCall({
      jsonl: [unknownEvent, events.assistantMessage("valid transcript-only output")],
    });
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Read the result",
      agentConfig: makeAgent("worker", { completionGuard: false }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      artifactsDir,
      artifactConfig: {
        enabled: true,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeTranscript: true,
        includeMetadata: false,
        cleanupDays: 7,
      },
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
    });
    const resultPath = await waitForAsyncResultFile(id, scaleTestTimeout(10_000));
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as AsyncResultArtifact;
    const child = result.results[0];
    assert.equal(result.success, true);
    assert.equal(child?.output, "valid transcript-only output");
    assert.ok(child?.transcriptPath, "expected transcript artifact");
    assert.ok(
      readTranscriptText(child.transcriptPath, "stdout").startsWith(JSON.stringify(unknownEvent)),
    );
    assert.deepEqual(
      fs
        .readdirSync(artifactsDir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => path.join(artifactsDir, name))
        .filter((file) => file !== child.transcriptPath),
      [],
    );
  });

  it("archives the full raw stderr in the transcript despite bounded surfaced tails", async () => {
    const id = `background-stderr-archive-${Date.now().toString(36)}`;
    const artifactsDir = path.join(tempDir, "stderr-artifacts");
    const beginning = Buffer.from("FG_STDERR_BEGIN_", "utf8");
    const filler = Buffer.alloc(MAX_CHILD_STDERR_BYTES, 0x78);
    const splitCharacter = Buffer.from("😀", "utf8");
    const ending = Buffer.from("_FG_STDERR_END\n", "utf8");
    const first = Buffer.concat([beginning, filler, splitCharacter.subarray(0, 2)]);
    const second = Buffer.concat([splitCharacter.subarray(2), ending]);
    mockPi.onCall({ stderrByteChunks: [Array.from(first), Array.from(second)], exitCode: 1 });
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Capture stderr",
      agentConfig: makeAgent("worker"),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      artifactsDir,
      artifactConfig: {
        enabled: true,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeTranscript: true,
        includeMetadata: false,
        cleanupDays: 7,
      },
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
    });
    const resultPath = await waitForAsyncResultFile(id, scaleTestTimeout(10_000));
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as AsyncResultArtifact;
    const child = result.results[0];
    assert.equal(result.success, false);
    assert.equal(child?.exitCode, 1);
    assert.equal(child?.stderrTruncated, true);
    assert.match(child?.error ?? "", /stderr truncated/i);
    assert.match(child?.error ?? "", /_FG_STDERR_END/);
    assert.doesNotMatch(child?.error ?? "", /FG_STDERR_BEGIN_/);
    assert.ok(child?.transcriptPath, "expected transcript artifact");
    assert.equal(
      readTranscriptText(child.transcriptPath, "stderr"),
      Buffer.concat([first, second]).toString("utf8"),
    );
  });

  it("treats stderr output with exit 0 as a success, not an error", async () => {
    const id = `background-stderr-warning-${Date.now().toString(36)}`;
    mockPi.onCall({
      output: "Done despite warning",
      stderr: "Warning: deprecated API",
      exitCode: 0,
    });
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do something",
      agentConfig: makeAgent("worker", { completionGuard: false }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      artifactConfig: compactArtifactConfig(),
      maxSubagentDepth: 2,
    });
    const resultPath = await waitForAsyncResultFile(id, scaleTestTimeout(10_000));
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as AsyncResultArtifact;
    const child = result.results[0];
    assert.equal(result.success, true);
    assert.equal(child?.success, true);
    assert.equal(child?.exitCode, 0);
    assert.equal(child?.output, "Done despite warning");
    assert.equal(child?.error, undefined);
  });

  it("preserves the original exit code and stderr error for an ordinary non-zero exit", async () => {
    const id = `background-stderr-exit2-${Date.now().toString(36)}`;
    mockPi.onCall({ stderr: "Error: something went wrong", exitCode: 2 });
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do something",
      agentConfig: makeAgent("worker", { completionGuard: false }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      artifactConfig: compactArtifactConfig(),
      maxSubagentDepth: 2,
    });
    const resultPath = await waitForAsyncResultFile(id, scaleTestTimeout(10_000));
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as AsyncResultArtifact;
    const child = result.results[0];
    assert.equal(result.success, false);
    assert.equal(child?.success, false);
    assert.equal(child?.exitCode, 2);
    assert.match(child?.error ?? "", /something went wrong/);
  });

  it("preserves the async startup interrupt trampoline when an interrupt arrives immediately", async () => {
    const id = `background-startup-interrupt-${Date.now().toString(36)}`;
    mockPi.onCall({ waitForMarker: path.join(tempDir, "never-created.marker") });
    const start = executeAsyncSingle(id, {
      agent: "worker",
      task: "Wait for an interrupt",
      agentConfig: makeAgent("worker"),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      maxSubagentDepth: 2,
    });
    assert.equal(start.isError, undefined);
    requestAsyncInterrupt(path.join(ASYNC_DIR, id), { source: "startup-interrupt-test" });

    const resultPath = await waitForAsyncResultFile(id, scaleTestTimeout(10_000));
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as AsyncResultArtifact;
    assert.equal(result.state, "paused");
    assert.equal(result.success, false);
  });
});

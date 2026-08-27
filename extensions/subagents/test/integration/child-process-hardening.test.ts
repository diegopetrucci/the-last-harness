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
  waitForMockPiCall,
  waitForPidsToExit,
} from "../support/async-execution-helpers.ts";
import {
  createMockPi,
  createTempDir,
  events,
  makeAgent,
  removeTempDir,
  tryImport,
} from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";
import {
  MAX_CHILD_ERROR_BYTES,
  MAX_CHILD_PENDING_LINE_BYTES,
  MAX_CHILD_RAW_STDOUT_BYTES,
  MAX_CHILD_STDERR_BYTES,
} from "../../src/runs/shared/child-protocol.ts";
import type { AsyncResultArtifact } from "../../src/shared/types.ts";

interface ForegroundExecutionModule {
  runSync(
    runtimeCwd: string,
    agents: ReturnType<typeof makeAgent>[],
    agentName: string,
    task: string,
    options: Record<string, unknown>,
  ): Promise<{
    exitCode: number;
    exitSignal?: NodeJS.Signals;
    error?: string;
    finalOutput?: string;
    stderr?: string;
    stderrTruncated?: boolean;
    protocolOutputLimit?: { code?: string; stream?: string };
    terminationReason?: string;
    timedOut?: boolean;
    interrupted?: boolean;
    progress: { status: string };
    transcriptPath?: string;
  }>;
}

const execution = await tryImport<ForegroundExecutionModule>("./src/runs/foreground/execution.ts");
const available = typeof execution?.runSync === "function";

function readTranscriptText(transcriptPath: string, recordType?: string): string {
  return fs
    .readFileSync(transcriptPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const record: unknown = JSON.parse(line);
      if (!record || typeof record !== "object" || Array.isArray(record)) return "";
      const typed = record as { recordType?: unknown; text?: unknown };
      if (recordType !== undefined && typed.recordType !== recordType) return "";
      return typeof typed.text === "string" ? typed.text : "";
    })
    .join("");
}

async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

describe(
  "real child process protocol hardening",
  { skip: !available ? "pi packages not available" : undefined },
  () => {
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

    it("accepts a normal validated protocol event", async () => {
      mockPi.onCall({ jsonl: [events.assistantMessage("normal child output")] });
      const result = await within(
        execution!.runSync(tempDir, [makeAgent("worker")], "worker", "Read the result", {
          runId: "foreground-normal-protocol",
        }),
        10_000,
        "foreground normal protocol run",
      );

      assert.equal(result.exitCode, 0);
      assert.equal(result.finalOutput, "normal child output");
      assert.equal(result.protocolOutputLimit, undefined);
    });

    it("retains malformed and unknown protocol lines without changing state", async () => {
      const artifactsDir = path.join(tempDir, "artifacts");
      const malformedEvent = {
        type: "message_end",
        message: { role: "assistant", content: "not an array" },
      };
      const unknownEvent = { type: "unknown_future_event", message: { injected: true } };
      mockPi.onCall({
        jsonl: [
          malformedEvent,
          unknownEvent,
          events.assistantMessage("valid after malformed lines"),
        ],
      });
      const result = await within(
        execution!.runSync(tempDir, [makeAgent("worker")], "worker", "Read the result", {
          runId: "foreground-malformed-protocol",
          artifactsDir,
          artifactConfig: {
            enabled: true,
            includeInput: false,
            includeOutput: false,
            includeJsonl: true,
            includeTranscript: true,
            includeMetadata: false,
          },
        }),
        10_000,
        "foreground malformed protocol run",
      );

      assert.equal(result.exitCode, 0);
      assert.equal(result.finalOutput, "valid after malformed lines");
      assert.equal(result.progress.status, "completed");
      assert.ok(result.transcriptPath);
      const transcript = readTranscriptText(result.transcriptPath, "stdout");
      assert.equal(transcript, `${JSON.stringify(malformedEvent)}${JSON.stringify(unknownEvent)}`);
      const jsonl = fs.readFileSync(
        path.join(artifactsDir, "foreground-malformed-protocol_worker.jsonl"),
        "utf8",
      );
      assert.match(jsonl, /not an array/);
      assert.match(jsonl, /unknown_future_event/);
    });

    it("retains unknown protocol envelopes when JSONL is disabled", async () => {
      const artifactsDir = path.join(tempDir, "transcript-only");
      const unknownEvent = {
        type: "future_transcript_event",
        nested: { retained: true },
      };
      mockPi.onCall({
        jsonl: [unknownEvent, events.assistantMessage("valid transcript-only output")],
      });

      const result = await within(
        execution!.runSync(tempDir, [makeAgent("worker")], "worker", "Read the result", {
          runId: "foreground-transcript-only",
          artifactsDir,
          artifactConfig: {
            enabled: true,
            includeInput: false,
            includeOutput: false,
            includeJsonl: false,
            includeTranscript: true,
            includeMetadata: false,
          },
        }),
        10_000,
        "foreground transcript-only run",
      );

      assert.equal(result.exitCode, 0);
      assert.equal(result.finalOutput, "valid transcript-only output");
      assert.ok(result.transcriptPath);
      assert.equal(
        readTranscriptText(result.transcriptPath, "stdout"),
        JSON.stringify(unknownEvent),
      );
      assert.equal(
        fs.existsSync(path.join(artifactsDir, "foreground-transcript-only_worker.jsonl")),
        false,
      );
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
        shareEnabled: false,
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
      "terminates foreground stdout protocol overflow with SIGTERM then bounded SIGKILL escalation",
      { skip: process.platform === "win32" ? "POSIX signal escalation fixture" : undefined },
      async () => {
        const oversizedLine = `FG_PROTOCOL_BEGIN_${"x".repeat(MAX_CHILD_PENDING_LINE_BYTES)}_FG_PROTOCOL_END`;
        mockPi.onCall({
          rawStdout: oversizedLine,
          keepAliveAfterFinalMessageMs: 60_000,
          ignoreSigterm: true,
        });
        const result = await within(
          execution!.runSync(
            tempDir,
            [makeAgent("worker", { fallbackModels: ["mock/fallback"] })],
            "worker",
            "Trigger overflow",
            {
              runId: "foreground-protocol-overflow",
            },
          ),
          10_000,
          "foreground protocol overflow run",
        );

        assert.equal(result.exitCode, 1);
        assert.equal(result.exitSignal, "SIGKILL");
        assert.equal(result.progress.status, "failed");
        assert.match(result.error ?? "", /protocol_output_limit/);
        assert.match(result.finalOutput ?? "", /protocol_output_limit/);
        const pid = startedMockPiPids(mockPi)[0];
        assert.ok(pid);
        const signals = fs.readFileSync(path.join(mockPi.dir, `signals-${pid}.jsonl`), "utf8");
        assert.match(signals, /"signal":"SIGTERM"/);
        assert.equal(mockPi.callCount(), 1);
      },
    );

    it(
      "preserves timeout precedence when stdout overflow arrives later",
      { skip: process.platform === "win32" ? "POSIX signal escalation fixture" : undefined },
      async () => {
        const oversizedLine = `TIMEOUT_WON_FIRST_${"x".repeat(MAX_CHILD_PENDING_LINE_BYTES)}`;
        mockPi.onCall({
          delay: 100,
          rawStdout: oversizedLine,
          keepAliveAfterFinalMessageMs: 10_000,
          ignoreSigint: true,
          ignoreSigterm: true,
        });
        const result = await within(
          execution!.runSync(tempDir, [makeAgent("worker")], "worker", "Timeout first", {
            runId: "foreground-timeout-before-overflow",
            timeoutMs: 50,
          }),
          10_000,
          "foreground timeout precedence run",
        );

        assert.equal(result.exitCode, 1);
        assert.equal(result.timedOut, true);
        assert.equal(result.terminationReason, "timed_out");
        assert.equal(result.protocolOutputLimit, undefined);
        assert.match(result.error ?? "", /timed out/i);
      },
    );

    it(
      "terminates background stdout protocol overflow deterministically",
      { skip: process.platform === "win32" ? "POSIX signal escalation fixture" : undefined },
      async () => {
        const id = `background-protocol-overflow-${Date.now().toString(36)}`;
        const oversizedLine = `BG_PROTOCOL_BEGIN_${"x".repeat(MAX_CHILD_PENDING_LINE_BYTES)}_BG_PROTOCOL_END`;
        mockPi.onCall({
          rawStdout: oversizedLine,
          keepAliveAfterFinalMessageMs: 60_000,
          ignoreSigterm: true,
        });
        const start = executeAsyncSingle(id, {
          agent: "worker",
          task: "Trigger overflow",
          agentConfig: makeAgent("worker", { fallbackModels: ["mock/fallback"] }),
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
        assert.equal(mockPi.callCount(), 1);
      },
    );

    it("bounds stderr tails, reports overflow, and keeps raw transcript bytes", async () => {
      const beginning = Buffer.from("FG_STDERR_BEGIN_", "utf8");
      const filler = Buffer.alloc(MAX_CHILD_STDERR_BYTES, 0x78);
      const splitCharacter = Buffer.from("😀", "utf8");
      const ending = Buffer.from("_FG_STDERR_END\n", "utf8");
      const first = Buffer.concat([beginning, filler, splitCharacter.subarray(0, 2)]);
      const second = Buffer.concat([splitCharacter.subarray(2), ending]);
      const artifactsDir = path.join(tempDir, "stderr-artifacts");
      mockPi.onCall({ stderrByteChunks: [Array.from(first), Array.from(second)], exitCode: 1 });

      const result = await within(
        execution!.runSync(tempDir, [makeAgent("worker")], "worker", "Capture stderr", {
          runId: "foreground-stderr-overflow",
          artifactsDir,
          artifactConfig: {
            enabled: true,
            includeInput: false,
            includeOutput: false,
            includeJsonl: false,
            includeTranscript: true,
            includeMetadata: false,
          },
        }),
        10_000,
        "foreground stderr overflow run",
      );

      assert.equal(result.exitCode, 1);
      assert.equal(result.stderrTruncated, true);
      assert.match(result.error ?? "", /stderr truncated/i);
      assert.match(result.error ?? "", /_FG_STDERR_END/);
      assert.doesNotMatch(result.error ?? "", /FG_STDERR_BEGIN_/);
      assert.ok(result.transcriptPath);
      const transcript = readTranscriptText(result.transcriptPath, "stderr");
      assert.equal(transcript, Buffer.concat([first, second]).toString("utf8"));
    });

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
        shareEnabled: false,
        maxSubagentDepth: 2,
      });
      assert.equal(start.isError, undefined);
      const resultPath = await waitForAsyncResultFile(id, scaleTestTimeout(10_000));
      const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as AsyncResultArtifact;
      const child = result.results[0];
      const status = JSON.parse(
        fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf8"),
      ) as { steps?: Array<{ stderr?: string; stderrTruncated?: boolean }> };
      assert.equal(result.success, false);
      assert.equal(child?.stderrTruncated, true);
      assert.equal(status.steps?.[0]?.stderrTruncated, true);
      assert.ok(
        Buffer.byteLength(status.steps?.[0]?.stderr ?? "", "utf8") <= MAX_CHILD_ERROR_BYTES,
      );
      assert.match(child?.stderr ?? "", /stderr truncated/);
      assert.match(child?.error ?? "", /stderr truncated/);
      assert.match(child?.error ?? "", new RegExp(ending));
      assert.doesNotMatch(child?.error ?? "", new RegExp(beginning));
      const eventText = fs.readFileSync(path.join(ASYNC_DIR, id, "events.jsonl"), "utf8");
      assert.match(eventText, /subagent\.child\.stderr\.truncated/);
      assert.match(eventText, /subagent\.child\.stderr\.overflow/);
    });

    it(
      "preserves interrupt precedence when stdout overflow arrives later",
      { skip: process.platform === "win32" ? "POSIX signal escalation fixture" : undefined },
      async () => {
        const interrupt = new AbortController();
        const oversizedLine = `INTERRUPT_WON_FIRST_${"x".repeat(MAX_CHILD_PENDING_LINE_BYTES)}`;
        mockPi.onCall({
          delay: 100,
          rawStdout: oversizedLine,
          keepAliveAfterFinalMessageMs: 10_000,
          ignoreSigint: true,
          ignoreSigterm: true,
        });
        const resultPromise = execution!.runSync(
          tempDir,
          [makeAgent("worker")],
          "worker",
          "Interrupt first",
          { runId: "foreground-interrupt-before-overflow", interruptSignal: interrupt.signal },
        );
        setTimeout(() => interrupt.abort(), 50);
        const result = await within(resultPromise, 10_000, "foreground interrupt precedence run");

        assert.equal(result.interrupted, true);
        assert.equal(result.terminationReason, "interrupted");
        assert.equal(result.protocolOutputLimit, undefined);
      },
    );

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
        shareEnabled: false,
        maxSubagentDepth: 2,
      });
      assert.equal(start.isError, undefined);
      requestAsyncInterrupt(path.join(ASYNC_DIR, id), { source: "startup-interrupt-test" });

      const resultPath = await waitForAsyncResultFile(id, scaleTestTimeout(10_000));
      const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as AsyncResultArtifact;
      assert.equal(result.state, "paused");
      assert.equal(result.success, false);
    });
  },
);

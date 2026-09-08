import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createTempDir, removeTempDir } from "../support/helpers.ts";
import {
  available,
  createEventRecorder,
  createState,
  trackerMod,
  type AsyncJobTrackerModule,
  waitForCondition,
} from "../support/async-job-tracker-fixtures.ts";

describe(
  "async job tracker",
  { skip: !available ? "pi packages not available" : undefined },
  () => {
    it("keeps incomplete async control event lines for the next poll", async () => {
      const asyncRoot = createTempDir("pi-async-job-tracker-");
      try {
        const runDir = path.join(asyncRoot, "run-partial");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId: "run-partial",
            mode: "single",
            state: "running",
            startedAt: Date.now() - 1000,
            lastUpdate: Date.now(),
            steps: [{ agent: "worker", status: "running" }],
          }),
          "utf-8",
        );
        const eventPath = path.join(runDir, "events.jsonl");
        const partialRecord = JSON.stringify({
          type: "subagent.control",
          channels: ["event"],
          event: {
            type: "needs_attention",
            to: "needs_attention",
            ts: 123,
            runId: "run-partial",
            agent: "worker",
            message: "worker needs attention",
          },
        });
        fs.writeFileSync(eventPath, partialRecord, "utf-8");

        const state = createState();
        const recorder = createEventRecorder();
        const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          pollIntervalMs: 10,
        });
        tracker.handleStarted({ id: "run-partial", asyncDir: runDir, agent: "worker" });

        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(recorder.events.length, 0);

        fs.appendFileSync(eventPath, "\n", "utf-8");
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(
          recorder.events.some((event) => event.channel === "subagent:control-event"),
          true,
        );
      } finally {
        removeTempDir(asyncRoot);
      }
    });

    it("scans async control events in bounded chunks", async () => {
      const asyncRoot = createTempDir("pi-async-job-tracker-");
      const originalAlloc = Buffer.alloc;
      const allocationSizes: number[] = [];
      try {
        const runDir = path.join(asyncRoot, "run-chunked-control");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId: "run-chunked-control",
            mode: "single",
            state: "running",
            startedAt: Date.now() - 1000,
            lastUpdate: Date.now(),
            steps: [{ agent: "worker", status: "running" }],
          }),
          "utf-8",
        );
        const largeDiagnostic = JSON.stringify({
          type: "message_update",
          message: { role: "assistant", content: [{ type: "text", text: "x".repeat(200_000) }] },
        });
        const controlEvent = JSON.stringify({
          type: "subagent.control",
          channels: ["event"],
          event: {
            type: "needs_attention",
            to: "needs_attention",
            ts: 123,
            runId: "run-chunked-control",
            agent: "worker",
            message: "worker needs attention",
          },
        });
        fs.writeFileSync(
          path.join(runDir, "events.jsonl"),
          `${largeDiagnostic}\n${controlEvent}\n`,
          "utf-8",
        );

        Buffer.alloc = ((
          size: number,
          fill?: string | Buffer | number,
          encoding?: BufferEncoding,
        ) => {
          allocationSizes.push(size);
          return originalAlloc(size, fill as never, encoding);
        }) as typeof Buffer.alloc;

        const state = createState();
        const recorder = createEventRecorder();
        const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          pollIntervalMs: 10,
        });
        tracker.handleStarted({ id: "run-chunked-control", asyncDir: runDir, agent: "worker" });

        await waitForCondition(
          () => recorder.events.some((event) => event.channel === "subagent:control-event"),
          "chunked control event",
        );
        assert.ok(allocationSizes.length > 0, "expected the tracker to allocate read buffers");
        assert.equal(Math.max(...allocationSizes) <= 64 * 1024, true);
      } finally {
        Buffer.alloc = originalAlloc;
        removeTempDir(asyncRoot);
      }
    });

    it("keeps oversized control records in discard mode across polling windows", async () => {
      const asyncRoot = createTempDir("pi-async-job-tracker-");
      const originalError = console.error;
      const warnings: string[] = [];
      console.error = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
      try {
        const runDir = path.join(asyncRoot, "run-oversized-control");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId: "run-oversized-control",
            mode: "single",
            state: "running",
            startedAt: Date.now() - 1000,
            lastUpdate: Date.now(),
            steps: [{ agent: "worker", status: "running" }],
          }),
          "utf-8",
        );
        const control = (message: string) =>
          JSON.stringify({
            type: "subagent.control",
            channels: ["event"],
            event: {
              type: "needs_attention",
              to: "needs_attention",
              ts: Date.now(),
              runId: "run-oversized-control",
              agent: "worker",
              message,
            },
          });
        const oversized = JSON.stringify({ type: "agent_end", output: "x".repeat(2_300_000) });
        const eventPath = path.join(runDir, "events.jsonl");
        fs.writeFileSync(
          eventPath,
          `${oversized}\n${control("first")}\n${control("second")}\n`,
          "utf-8",
        );
        assert.ok(
          Buffer.byteLength(oversized) > 2 * 1024 * 1024,
          "fixture must cross one scan window",
        );

        const state = createState();
        const recorder = createEventRecorder();
        const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          pollIntervalMs: 10,
        });
        tracker.handleStarted({ id: "run-oversized-control", asyncDir: runDir, agent: "worker" });

        await waitForCondition(
          () =>
            recorder.events.filter((event) => event.channel === "subagent:control-event").length ===
            2,
          "controls after oversized event",
        );
        assert.equal(
          warnings.filter((warning) => warning.includes("malformed async control event")).length,
          0,
        );
        assert.equal(
          recorder.events.filter((event) => event.channel === "subagent:control-event").length,
          2,
        );
      } finally {
        console.error = originalError;
        removeTempDir(asyncRoot);
      }
    });

    it("restores an oversized skip across tracker recreation and delivers appended controls once", async () => {
      const asyncRoot = createTempDir("pi-async-job-tracker-recreate-");
      const originalError = console.error;
      const warnings: string[] = [];
      console.error = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
      let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
      try {
        const runDir = path.join(asyncRoot, "run-recreated-control");
        const eventPath = path.join(runDir, "events.jsonl");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId: "run-recreated-control",
            mode: "single",
            state: "running",
            sessionId: "session-current",
            startedAt: Date.now() - 1000,
            lastUpdate: Date.now(),
            steps: [{ agent: "worker", status: "running" }],
          }),
          "utf-8",
        );
        fs.writeFileSync(eventPath, "x".repeat(2 * 1024 * 1024), "utf-8");

        const state = createState();
        state.currentSessionId = "session-current";
        const recorder = createEventRecorder();
        const firstTracker = trackerMod!.createAsyncJobTracker(
          recorder.pi,
          state as never,
          asyncRoot,
          {
            pollIntervalMs: 10,
          },
        );
        firstTracker.handleStarted({
          id: "run-recreated-control",
          asyncDir: runDir,
          sessionId: "session-current",
          agent: "worker",
        });
        await waitForCondition(
          () =>
            state.asyncJobs.get("run-recreated-control")?.controlEventSkippingOversizedLine ===
            true,
          "mid-record oversized discard state",
        );
        const cursorBeforeRestart =
          state.asyncJobs.get("run-recreated-control")?.controlEventCursor;
        assert.equal(cursorBeforeRestart, fs.statSync(eventPath).size);
        assert.ok(
          cursorBeforeRestart > 1024 * 1024,
          "cursor must be in oversized-line discard mode",
        );

        firstTracker.resetJobs();
        await waitForCondition(() => state.poller === null, "first tracker poller to stop");
        tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          pollIntervalMs: 10,
        });
        tracker.restoreActiveJobs();
        const restoredJob = state.asyncJobs.get("run-recreated-control");
        assert.ok(restoredJob);
        assert.equal(restoredJob.controlEventCursor, fs.statSync(eventPath).size);
        assert.equal(restoredJob.controlEventSkippingOversizedLine, true);

        const control = (message: string) =>
          JSON.stringify({
            type: "subagent.control",
            channels: ["event"],
            event: {
              type: "needs_attention",
              to: "needs_attention",
              ts: Date.now(),
              runId: "run-recreated-control",
              agent: "worker",
              message,
            },
          });
        fs.appendFileSync(
          eventPath,
          `remainder\n${control("first")}\n${control("second")}\n`,
          "utf-8",
        );

        await waitForCondition(
          () =>
            recorder.events.filter((event) => event.channel === "subagent:control-event").length ===
            2,
          "controls after restored oversized record",
        );
        assert.equal(
          warnings.filter((warning) => warning.includes("malformed async control event")).length,
          0,
        );
        assert.equal(
          state.asyncJobs.get("run-recreated-control")?.controlEventSkippingOversizedLine,
          false,
        );
        assert.equal(
          state.asyncJobs.get("run-recreated-control")?.controlEventCursor,
          fs.statSync(eventPath).size,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(
          recorder.events.filter((event) => event.channel === "subagent:control-event").length,
          2,
        );
      } finally {
        console.error = originalError;
        tracker?.resetJobs();
        removeTempDir(asyncRoot);
      }
    });

    it("resets skip state when a disappeared log is replaced at the same path and size", async () => {
      const asyncRoot = createTempDir("pi-async-job-tracker-replacement-");
      const originalError = console.error;
      const warnings: string[] = [];
      console.error = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
      let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
      try {
        const runDir = path.join(asyncRoot, "run-replaced-control");
        const eventPath = path.join(runDir, "events.jsonl");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId: "run-replaced-control",
            mode: "single",
            state: "running",
            sessionId: "session-current",
            startedAt: Date.now() - 1000,
            lastUpdate: Date.now(),
            steps: [{ agent: "worker", status: "running" }],
          }),
          "utf-8",
        );
        const originalContents = "x".repeat(2_200_000);
        fs.writeFileSync(eventPath, originalContents, "utf-8");
        const originalIdentity = (() => {
          const stat = fs.statSync(eventPath);
          return `${stat.dev}:${stat.ino}`;
        })();

        const state = createState();
        state.currentSessionId = "session-current";
        const recorder = createEventRecorder();
        tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          pollIntervalMs: 10,
        });
        tracker.handleStarted({
          id: "run-replaced-control",
          asyncDir: runDir,
          sessionId: "session-current",
          agent: "worker",
        });
        await waitForCondition(
          () =>
            state.asyncJobs.get("run-replaced-control")?.controlEventSkippingOversizedLine === true,
          "oversized discard state before replacement",
        );

        // Create the replacement file BEFORE unlinking the original so that both
        // files are live at the same time. POSIX guarantees distinct inodes when
        // two names exist simultaneously. Unlink-then-create lets ext4 hand the
        // freed inode straight back to the new file; APFS never reuses inodes,
        // which is why macOS shards pass while ubuntu fails. This ordering is
        // load-bearing and must not be simplified back to unlink-then-create.
        const control = JSON.stringify({
          type: "subagent.control",
          channels: ["event"],
          event: {
            type: "needs_attention",
            to: "needs_attention",
            ts: 123,
            runId: "run-replaced-control",
            agent: "worker",
            message: "new file control",
          },
        });
        const prefix = `${control}\n`;
        const replacementPath = path.join(runDir, "events.replacement");
        fs.writeFileSync(
          replacementPath,
          `${prefix}${"\n".repeat(originalContents.length - Buffer.byteLength(prefix))}`,
          "utf-8",
        );
        assert.equal(fs.statSync(replacementPath).size, originalContents.length);
        fs.unlinkSync(eventPath);
        await new Promise((resolve) => setTimeout(resolve, 30));
        fs.renameSync(replacementPath, eventPath);
        const replacementStat = fs.statSync(eventPath);
        const replacementIdentity = `${replacementStat.dev}:${replacementStat.ino}`;
        assert.notEqual(
          replacementIdentity,
          originalIdentity,
          "replacement fixture must change dev/ino identity",
        );
        assert.equal(replacementStat.size, originalContents.length);

        await waitForCondition(
          () =>
            recorder.events.filter((event) => event.channel === "subagent:control-event").length ===
            1,
          "control from replacement log",
        );
        await waitForCondition(
          () =>
            state.asyncJobs.get("run-replaced-control")?.controlEventCursor ===
            replacementStat.size,
          "replacement log scan completion",
        );
        const job = state.asyncJobs.get("run-replaced-control");
        assert.equal(job?.controlEventFileIdentity, replacementIdentity);
        assert.equal(job?.controlEventSkippingOversizedLine, false);
        assert.equal(
          warnings.filter((warning) => warning.includes("malformed async control event")).length,
          0,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(
          recorder.events.filter((event) => event.channel === "subagent:control-event").length,
          1,
        );
      } finally {
        console.error = originalError;
        tracker?.resetJobs();
        removeTempDir(asyncRoot);
      }
    });

    it("warns for malformed complete control records while delivering later records", async () => {
      const asyncRoot = createTempDir("pi-async-job-tracker-");
      const originalError = console.error;
      const warnings: string[] = [];
      console.error = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
      try {
        const runDir = path.join(asyncRoot, "run-malformed-control");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId: "run-malformed-control",
            mode: "single",
            state: "running",
            startedAt: Date.now() - 1000,
            lastUpdate: Date.now(),
            steps: [{ agent: "worker", status: "running" }],
          }),
          "utf-8",
        );
        const valid = JSON.stringify({
          type: "subagent.control",
          channels: ["event"],
          event: {
            type: "needs_attention",
            to: "needs_attention",
            ts: 123,
            runId: "run-malformed-control",
            agent: "worker",
            message: "valid",
          },
        });
        fs.writeFileSync(path.join(runDir, "events.jsonl"), `{not-json}\n${valid}\n`, "utf-8");
        const state = createState();
        const recorder = createEventRecorder();
        const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          pollIntervalMs: 10,
        });
        tracker.handleStarted({ id: "run-malformed-control", asyncDir: runDir, agent: "worker" });
        await waitForCondition(
          () => recorder.events.some((event) => event.channel === "subagent:control-event"),
          "valid control after malformed record",
        );
        assert.equal(
          warnings.filter((warning) => warning.includes("malformed async control event")).length,
          1,
        );
      } finally {
        console.error = originalError;
        removeTempDir(asyncRoot);
      }
    });

    it("resets oversized discard state after event-log truncation", async () => {
      const asyncRoot = createTempDir("pi-async-job-tracker-");
      let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
      try {
        const runDir = path.join(asyncRoot, "run-truncated-control");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId: "run-truncated-control",
            mode: "single",
            state: "running",
            sessionId: "session-current",
            startedAt: Date.now() - 1000,
            lastUpdate: Date.now(),
            steps: [{ agent: "worker", status: "running" }],
          }),
          "utf-8",
        );
        const eventPath = path.join(runDir, "events.jsonl");
        fs.writeFileSync(eventPath, "x".repeat(2_200_000), "utf-8");
        const state = createState();
        state.currentSessionId = "session-current";
        const recorder = createEventRecorder();
        tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          pollIntervalMs: 10,
        });
        tracker.restoreActiveJobs();
        const restoredJob = state.asyncJobs.get("run-truncated-control");
        assert.ok(restoredJob);
        assert.equal(restoredJob.controlEventCursor, fs.statSync(eventPath).size);
        assert.equal(restoredJob.controlEventSkippingOversizedLine, true);
        const valid = JSON.stringify({
          type: "subagent.control",
          channels: ["event"],
          event: {
            type: "needs_attention",
            to: "needs_attention",
            ts: 123,
            runId: "run-truncated-control",
            agent: "worker",
            message: "after truncation",
          },
        });
        fs.writeFileSync(eventPath, `${valid}\n`, "utf-8");
        await waitForCondition(
          () => recorder.events.some((event) => event.channel === "subagent:control-event"),
          "control after truncation",
        );
        assert.equal(
          recorder.events.filter((event) => event.channel === "subagent:control-event").length,
          1,
        );
        assert.equal(
          state.asyncJobs.get("run-truncated-control")?.controlEventCursor,
          fs.statSync(eventPath).size,
        );
        assert.equal(
          state.asyncJobs.get("run-truncated-control")?.controlEventSkippingOversizedLine,
          false,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(
          recorder.events.filter((event) => event.channel === "subagent:control-event").length,
          1,
        );
      } finally {
        tracker?.resetJobs();
        removeTempDir(asyncRoot);
      }
    });

    it("does not tail-skip control events for newly tracked large logs", async () => {
      const asyncRoot = createTempDir("pi-async-job-tracker-");
      try {
        const runDir = path.join(asyncRoot, "run-new-large-control");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId: "run-new-large-control",
            mode: "single",
            state: "running",
            startedAt: Date.now() - 1000,
            lastUpdate: Date.now(),
            steps: [{ agent: "worker", status: "running" }],
          }),
          "utf-8",
        );
        const controlEvent = JSON.stringify({
          type: "subagent.control",
          channels: ["event"],
          event: {
            type: "needs_attention",
            to: "needs_attention",
            ts: 123,
            runId: "run-new-large-control",
            agent: "worker",
            message: "worker needs attention",
          },
        });
        const diagnosticLine =
          JSON.stringify({
            type: "message_update",
            message: { role: "assistant", content: [{ type: "text", text: "x".repeat(4000) }] },
          }) + "\n";
        const eventsPath = path.join(runDir, "events.jsonl");
        fs.writeFileSync(eventsPath, controlEvent + "\n" + diagnosticLine.repeat(900), "utf-8");
        assert.ok(
          fs.statSync(eventsPath).size > 2 * 1024 * 1024,
          "test fixture should exceed the legacy scan window",
        );

        const state = createState();
        const recorder = createEventRecorder();
        const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          pollIntervalMs: 10,
        });
        tracker.handleStarted({ id: "run-new-large-control", asyncDir: runDir, agent: "worker" });

        await waitForCondition(
          () => recorder.events.some((event) => event.channel === "subagent:control-event"),
          "new large log control event",
        );
      } finally {
        removeTempDir(asyncRoot);
      }
    });

    it("starts large legacy control-event scans from a bounded tail window", async () => {
      const asyncRoot = createTempDir("pi-async-job-tracker-");
      const originalAlloc = Buffer.alloc;
      const originalError = console.error;
      const allocationSizes: number[] = [];
      console.error = () => {};
      try {
        const runDir = path.join(asyncRoot, "run-large-legacy-control");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId: "run-large-legacy-control",
            mode: "single",
            state: "running",
            startedAt: Date.now() - 1000,
            lastUpdate: Date.now(),
            steps: [{ agent: "worker", status: "running" }],
          }),
          "utf-8",
        );
        const diagnosticLine =
          JSON.stringify({
            type: "message_update",
            message: { role: "assistant", content: [{ type: "text", text: "x".repeat(4000) }] },
          }) + "\n";
        const controlEvent = JSON.stringify({
          type: "subagent.control",
          channels: ["event"],
          event: {
            type: "needs_attention",
            to: "needs_attention",
            ts: 123,
            runId: "run-large-legacy-control",
            agent: "worker",
            message: "worker needs attention",
          },
        });
        const eventsPath = path.join(runDir, "events.jsonl");
        fs.writeFileSync(eventsPath, diagnosticLine.repeat(900) + controlEvent + "\n", "utf-8");
        const eventLogBytes = fs.statSync(eventsPath).size;
        assert.ok(eventLogBytes > 2 * 1024 * 1024, "test fixture should exceed the scan window");

        Buffer.alloc = ((
          size: number,
          fill?: string | Buffer | number,
          encoding?: BufferEncoding,
        ) => {
          allocationSizes.push(size);
          return originalAlloc(size, fill as never, encoding);
        }) as typeof Buffer.alloc;

        const state = createState();
        state.asyncJobs.set("run-large-legacy-control", {
          asyncId: "run-large-legacy-control",
          asyncDir: runDir,
          status: "running",
          agents: ["worker"],
          startedAt: Date.now() - 1000,
          updatedAt: Date.now(),
        });
        const recorder = createEventRecorder();
        const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          pollIntervalMs: 10,
        });
        tracker.ensurePoller();

        await waitForCondition(
          () => recorder.events.some((event) => event.channel === "subagent:control-event"),
          "tail-window control event",
        );
        assert.ok(allocationSizes.length > 0, "expected the tracker to allocate read buffers");
        assert.equal(Math.max(...allocationSizes) <= 64 * 1024, true);
        const totalAllocated = allocationSizes.reduce((sum, size) => sum + size, 0);
        assert.ok(totalAllocated < eventLogBytes, "scan should not read the full legacy event log");
        assert.ok(
          totalAllocated <= 2 * 1024 * 1024 + 64 * 1024,
          "scan should stay within the bounded tail window",
        );
      } finally {
        Buffer.alloc = originalAlloc;
        console.error = originalError;
        removeTempDir(asyncRoot);
      }
    });

    it("clears transient current tool fields when status clears them", async () => {
      const asyncRoot = createTempDir("pi-async-job-tracker-");
      try {
        const runDir = path.join(asyncRoot, "run-clear-tool");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId: "run-clear-tool",
            mode: "single",
            state: "running",
            startedAt: Date.now() - 1000,
            lastUpdate: Date.now(),
            currentTool: "edit",
            currentToolStartedAt: Date.now() - 100,
            currentPath: "src/runs/background/subagent-runner.ts",
            steps: [{ agent: "worker", status: "running" }],
          }),
          "utf-8",
        );

        const state = createState();
        const recorder = createEventRecorder();
        const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          pollIntervalMs: 10,
        });
        tracker.handleStarted({ id: "run-clear-tool", asyncDir: runDir, agent: "worker" });

        await new Promise((resolve) => setTimeout(resolve, 30));
        let job = state.asyncJobs.get("run-clear-tool");
        assert.equal(job?.currentTool, "edit");
        assert.equal(job?.currentPath, "src/runs/background/subagent-runner.ts");

        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId: "run-clear-tool",
            mode: "single",
            state: "running",
            startedAt: Date.now() - 1000,
            lastUpdate: Date.now(),
            steps: [{ agent: "worker", status: "running" }],
          }),
          "utf-8",
        );

        await new Promise((resolve) => setTimeout(resolve, 30));
        job = state.asyncJobs.get("run-clear-tool");
        assert.equal(job?.currentTool, undefined);
        assert.equal(job?.currentToolStartedAt, undefined);
        assert.equal(job?.currentPath, undefined);
      } finally {
        removeTempDir(asyncRoot);
      }
    });

    it("ignores removed async control notification channels", async () => {
      const asyncRoot = createTempDir("pi-async-job-tracker-");
      try {
        const runDir = path.join(asyncRoot, "run-channels");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId: "run-channels",
            mode: "single",
            state: "running",
            startedAt: Date.now() - 1000,
            lastUpdate: Date.now(),
            steps: [{ agent: "worker", status: "running" }],
          }),
          "utf-8",
        );
        fs.writeFileSync(
          path.join(runDir, "events.jsonl"),
          `${JSON.stringify({
            type: "subagent.control",
            channels: ["intercom"],
            event: {
              type: "needs_attention",
              to: "needs_attention",
              ts: 123,
              runId: "run-channels",
              agent: "worker",
              message: "worker needs attention",
            },
            intercom: {
              to: "main",
              message: "SUBAGENT NEEDS ATTENTION: worker in run run-channels.",
            },
          })}\n`,
          "utf-8",
        );

        const state = createState();
        const recorder = createEventRecorder();
        const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          pollIntervalMs: 10,
        });
        tracker.handleStarted({ id: "run-channels", asyncDir: runDir, agent: "worker" });

        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(
          recorder.events.some((event) => event.channel === "subagent:control-event"),
          false,
        );
      } finally {
        removeTempDir(asyncRoot);
      }
    });

    it("delivers active-long-running records through the native event channel", async () => {
      const asyncRoot = createTempDir("pi-async-job-tracker-");
      try {
        const runDir = path.join(asyncRoot, "run-active-native");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId: "run-active-native",
            mode: "single",
            state: "running",
            startedAt: Date.now() - 1000,
            lastUpdate: Date.now(),
            steps: [{ agent: "worker", status: "running" }],
          }),
          "utf-8",
        );
        fs.writeFileSync(
          path.join(runDir, "events.jsonl"),
          `${JSON.stringify({
            type: "subagent.control",
            channels: ["event"],
            event: {
              type: "active_long_running",
              to: "active_long_running",
              ts: 123,
              runId: "run-active-native",
              agent: "worker",
              message: "worker is still active but long-running",
            },
          })}\n`,
          "utf-8",
        );

        const state = createState();
        const recorder = createEventRecorder();
        const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          pollIntervalMs: 10,
        });
        tracker.handleStarted({ id: "run-active-native", asyncDir: runDir, agent: "worker" });

        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(
          recorder.events.some((event) => event.channel === "subagent:control-event"),
          true,
        );
      } finally {
        removeTempDir(asyncRoot);
      }
    });

    it("delivers async control events from events.jsonl to the parent event bus", async () => {
      const asyncRoot = createTempDir("pi-async-job-tracker-");
      try {
        const runDir = path.join(asyncRoot, "run-3");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId: "run-3",
            mode: "single",
            state: "running",
            startedAt: Date.now() - 1000,
            lastUpdate: Date.now(),
            steps: [{ agent: "worker", status: "running" }],
          }),
          "utf-8",
        );
        fs.writeFileSync(
          path.join(runDir, "events.jsonl"),
          `${JSON.stringify({
            type: "subagent.control",
            channels: ["event"],
            event: {
              type: "needs_attention",
              to: "needs_attention",
              ts: 123,
              runId: "run-3",
              agent: "worker",
              message: "worker needs attention",
            },
          })}\n`,
          "utf-8",
        );

        const state = createState();
        const recorder = createEventRecorder();
        const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          pollIntervalMs: 10,
        });
        tracker.handleStarted({ id: "run-3", asyncDir: runDir, agent: "worker" });

        await new Promise((resolve) => setTimeout(resolve, 40));

        const controlEvent = recorder.events.find(
          (event) => event.channel === "subagent:control-event",
        );
        assert.ok(controlEvent);
        assert.match(
          (controlEvent.data as { noticeText?: string }).noticeText ?? "",
          /Nudge: subagent\(\{ action: "resume", id: "run-3"/,
        );
      } finally {
        removeTempDir(asyncRoot);
      }
    });
  },
);

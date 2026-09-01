import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createTempDir, removeTempDir, tryImport } from "../support/helpers.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";
import type { AsyncStatusQuarantineOptions } from "../../src/runs/background/async-status-quarantine.ts";

interface AsyncJobTrackerModule {
  createAsyncJobTracker(
    pi: { events: { emit(channel: string, data: unknown): void } },
    state: Record<string, unknown>,
    asyncDirRoot: string,
    options?: {
      completionRetentionMs?: number;
      pollIntervalMs?: number;
      resultsDir?: string;
      kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
      now?: () => number;
      fs?: Pick<typeof fs, "statSync" | "openSync" | "readSync" | "closeSync">;
      /** Typed from production AsyncStatusQuarantineOptions. */
      quarantine?: AsyncStatusQuarantineOptions;
    },
  ): {
    ensurePoller(): void;
    resetJobs(ctx?: unknown): void;
    restoreActiveJobs(ctx?: unknown): void;
    handleStarted(data: unknown): void;
    handleComplete(data: unknown): void;
  };
}

const trackerMod = await tryImport<AsyncJobTrackerModule>(
  "./src/runs/background/async-job-tracker.ts",
);
const available = !!trackerMod;

function createState() {
  return {
    baseCwd: "/repo",
    currentSessionId: null as string | null,
    asyncJobs: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: {
      schedule: () => false,
      clear: () => {},
    },
  };
}

function createEventRecorder() {
  const events: Array<{ channel: string; data: unknown }> = [];
  return {
    pi: {
      events: {
        emit: (channel: string, data: unknown) => {
          events.push({ channel, data });
        },
      },
    },
    events,
  };
}

function pidGone(): never {
  const error = new Error("missing") as NodeJS.ErrnoException;
  error.code = "ESRCH";
  throw error;
}

async function waitForCondition(
  condition: () => boolean,
  description: string,
  timeoutMs = scaleTestTimeout(1000),
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createUiContext() {
  const widgets: unknown[] = [];
  let renderRequests = 0;
  const ctx = {
    hasUI: true,
    ui: {
      theme: {
        fg: (_theme: string, text: string) => text,
      },
      setWidget: (_key: string, value: unknown) => {
        widgets.push(value);
      },
      requestRender: () => {
        renderRequests += 1;
      },
    },
  };
  return {
    ctx,
    get widgets() {
      return widgets;
    },
    get renderRequests() {
      return renderRequests;
    },
  };
}

describe(
  "async job tracker",
  { skip: !available ? "pi packages not available" : undefined },
  () => {
    it("removes completed jobs after retention and requests a rerender", async () => {
      const asyncRoot = createTempDir("pi-async-job-tracker-");
      try {
        const state = createState();
        const ui = createUiContext();
        const recorder = createEventRecorder();
        const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          completionRetentionMs: 5,
        });
        tracker.resetJobs(ui.ctx as never);
        tracker.handleStarted({
          id: "run-1",
          asyncDir: path.join(asyncRoot, "run-1"),
          agent: "worker",
        });
        tracker.handleComplete({ id: "run-1", success: true });

        assert.equal(state.asyncJobs.size, 1);
        await new Promise((resolve) => setTimeout(resolve, 40));

        assert.equal(state.asyncJobs.size, 0);
        assert.ok(ui.widgets.length > 0, "expected widget cleanup to replace the widget");
        assert.equal(ui.widgets.at(-1), undefined);
      } finally {
        removeTempDir(asyncRoot);
      }
    });

    it("honors continued and cancelled completion-event states before polling", async () => {
      for (const terminalState of ["continued", "cancelled"] as const) {
        const asyncRoot = createTempDir(`pi-async-job-event-${terminalState}-`);
        let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
        try {
          const state = createState();
          tracker = trackerMod!.createAsyncJobTracker(
            createEventRecorder().pi,
            state as never,
            asyncRoot,
            { completionRetentionMs: 50 },
          );
          tracker.handleStarted({
            id: `run-${terminalState}`,
            asyncDir: path.join(asyncRoot, `run-${terminalState}`),
            agent: "worker",
          });
          tracker.handleComplete({
            id: `run-${terminalState}`,
            success: false,
            state: terminalState,
          });

          assert.equal(state.asyncJobs.get(`run-${terminalState}`)?.status, terminalState);
          assert.equal(state.cleanupTimers.has(`run-${terminalState}`), true);
        } finally {
          tracker?.resetJobs();
          removeTempDir(asyncRoot);
        }
      }
    });

    it("restores continued steps in the completion projection", async () => {
      const asyncRoot = createTempDir("pi-async-job-restore-continued-");
      let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
      try {
        const runDir = path.join(asyncRoot, "run-restore-continued");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId: "run-restore-continued",
            mode: "chain",
            state: "running",
            sessionId: "session-restore-continued",
            startedAt: 1000,
            lastUpdate: 2000,
            chainStepCount: 3,
            steps: [
              { agent: "worker", status: "continued" },
              { agent: "reviewer", status: "running" },
              { agent: "tail", status: "pending" },
            ],
          }),
          "utf-8",
        );

        const state = createState();
        state.currentSessionId = "session-restore-continued";
        tracker = trackerMod!.createAsyncJobTracker(
          createEventRecorder().pi,
          state as never,
          asyncRoot,
          { pollIntervalMs: 10 },
        );
        tracker.restoreActiveJobs();

        const job = state.asyncJobs.get("run-restore-continued");
        assert.ok(job);
        assert.equal(job.completedSteps, 1);
        assert.equal(job.runningSteps, 1);

        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId: "run-restore-continued",
            mode: "chain",
            state: "continued",
            sessionId: "session-restore-continued",
            startedAt: 1000,
            lastUpdate: 3000,
            chainStepCount: 3,
            steps: [
              { agent: "worker", status: "continued" },
              { agent: "reviewer", status: "running" },
              { agent: "tail", status: "pending" },
            ],
          }),
          "utf-8",
        );
        await waitForCondition(
          () => state.asyncJobs.get("run-restore-continued")?.status === "continued",
          "continued poll projection",
        );
        assert.equal(state.asyncJobs.get("run-restore-continued")?.completedSteps, 1);
      } finally {
        tracker?.resetJobs();
        removeTempDir(asyncRoot);
      }
    });

    it("restores active async runs into the widget after reset", async () => {
      const asyncRoot = createTempDir("pi-async-job-restore-");
      try {
        const runDir = path.join(asyncRoot, "run-restored");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId: "run-restored",
            mode: "chain",
            state: "running",
            sessionId: "session-restored",
            startedAt: 1000,
            lastUpdate: 2000,
            currentStep: 1,
            chainStepCount: 3,
            tkTicket: { id: "psr-raw4", title: "Show active tk title" },
            parallelGroups: [{ start: 1, count: 2, stepIndex: 1 }],
            steps: [
              { agent: "scout", status: "complete" },
              { agent: "reviewer", status: "running", currentTool: "read" },
              { agent: "worker", status: "running" },
              { agent: "writer", status: "pending" },
            ],
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
              runId: "run-restored",
              agent: "reviewer",
              message: "old notice",
            },
          })}\n`,
          "utf-8",
        );

        const state = createState();
        state.currentSessionId = "session-restored";
        const ui = createUiContext();
        const recorder = createEventRecorder();
        const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          pollIntervalMs: 10,
        });
        tracker.resetJobs(ui.ctx as never);
        tracker.restoreActiveJobs(ui.ctx as never);

        const job = state.asyncJobs.get("run-restored");
        assert.ok(job);
        assert.equal(job.status, "running");
        assert.equal(job.sessionId, "session-restored");
        assert.deepEqual(job.tkTicket, { id: "psr-raw4", title: "Show active tk title" });
        assert.deepEqual(job.agents, ["reviewer", "worker"]);
        assert.deepEqual(
          job.steps?.map((step: { index?: number }) => step.index),
          [1, 2],
        );
        assert.equal(job.stepsTotal, 2);
        assert.equal(job.runningSteps, 2);
        assert.equal(job.completedSteps, 0);
        assert.equal(job.activeParallelGroup, true);
        assert.ok(state.poller, "expected restored active jobs to start polling");
        assert.ok(ui.widgets.length >= 2, "expected reset and restore to replace the widget");
        assert.equal(
          typeof ui.widgets.at(-1),
          "function",
          "expected restored jobs to render the widget",
        );

        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(
          recorder.events.length,
          0,
          "historical control events should not be replayed during restore",
        );
      } finally {
        removeTempDir(asyncRoot);
      }
    });

    it("continues restoring jobs when a persisted control-event tail probe fails", async () => {
      for (const failure of [
        { operation: "stat", code: "EACCES" },
        { operation: "open", code: "EISDIR" },
        { operation: "read", code: "EMFILE" },
      ] as const) {
        const asyncRoot = createTempDir(`pi-async-job-restore-events-${failure.operation}-`);
        const warnings: string[] = [];
        const originalWarn = console.warn;
        console.warn = (message?: unknown) => warnings.push(String(message ?? ""));
        let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
        try {
          const failingDir = path.join(asyncRoot, `run-failing-${failure.operation}`);
          const healthyDir = path.join(asyncRoot, "run-healthy");
          fs.mkdirSync(failingDir, { recursive: true });
          fs.mkdirSync(healthyDir, { recursive: true });
          const writeStatus = (runDir: string, runId: string) =>
            fs.writeFileSync(
              path.join(runDir, "status.json"),
              JSON.stringify({
                runId,
                mode: "single",
                state: "running",
                sessionId: "session-owner",
                startedAt: 1000,
                steps: [{ agent: "worker", status: "running" }],
              }),
              "utf-8",
            );
          writeStatus(failingDir, `run-failing-${failure.operation}`);
          writeStatus(healthyDir, "run-healthy");
          const eventsPath = path.join(failingDir, "events.jsonl");
          if (failure.operation !== "stat")
            fs.writeFileSync(eventsPath, "x".repeat(1_100_000), "utf-8");

          const fail = (): never => {
            const error = new Error(failure.code) as NodeJS.ErrnoException;
            error.code = failure.code;
            throw error;
          };
          const injectedFs = {
            statSync: ((filePath: fs.PathLike) => {
              if (failure.operation === "stat" && filePath === eventsPath) return fail();
              return fs.statSync(filePath);
            }) as typeof fs.statSync,
            openSync: ((filePath: fs.PathLike, flags: string | number) => {
              if (failure.operation === "open" && filePath === eventsPath) return fail();
              return fs.openSync(filePath, flags);
            }) as typeof fs.openSync,
            readSync: ((
              fd: number,
              buffer: NodeJS.ArrayBufferView,
              offset: number,
              length: number,
              position?: number | null,
            ) => {
              if (failure.operation === "read") return fail();
              return fs.readSync(fd, buffer, offset, length, position ?? null);
            }) as typeof fs.readSync,
            closeSync: fs.closeSync,
          };

          const state = createState();
          state.currentSessionId = "session-owner";
          tracker = trackerMod!.createAsyncJobTracker(
            createEventRecorder().pi,
            state as never,
            asyncRoot,
            {
              pollIntervalMs: 100,
              fs: injectedFs,
            },
          );
          assert.doesNotThrow(() => tracker!.restoreActiveJobs());
          assert.deepEqual(
            [...state.asyncJobs.keys()],
            [`run-failing-${failure.operation}`, "run-healthy"],
          );
          assert.equal(state.asyncJobs.get(`run-failing-${failure.operation}`)?.status, "running");
          assert.equal(state.asyncJobs.get("run-healthy")?.status, "running");
          assert.equal(warnings.length, 1, `${failure.operation} probe failure should warn once`);

          tracker.resetJobs();
          await waitForCondition(
            () => state.poller === null,
            `${failure.operation} restore poller to stop`,
          );
          tracker.restoreActiveJobs();
          assert.equal(
            warnings.length,
            1,
            `${failure.operation} probe warning should be deduplicated`,
          );
        } finally {
          console.warn = originalWarn;
          tracker?.resetJobs();
          removeTempDir(asyncRoot);
        }
      }
    });

    it("sanitizes restored tk ticket metadata from persisted status", () => {
      const asyncRoot = createTempDir("pi-async-job-restore-ticket-");
      try {
        const runDir = path.join(asyncRoot, "run-restored-ticket");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId: "run-restored-ticket",
            mode: "single",
            state: "running",
            sessionId: "session-restored",
            startedAt: 1000,
            steps: [{ agent: "worker", status: "running" }],
            tkTicket: { id: "psr-raw4", title: "Restored\u009b title\u001b[31m now\u001b[0m" },
          }),
          "utf-8",
        );

        const state = createState();
        state.currentSessionId = "session-restored";
        const tracker = trackerMod!.createAsyncJobTracker(
          createEventRecorder().pi,
          state as never,
          asyncRoot,
        );
        tracker.restoreActiveJobs();

        assert.deepEqual(state.asyncJobs.get("run-restored-ticket")?.tkTicket, {
          id: "psr-raw4",
          title: "Restored title now",
        });
      } finally {
        removeTempDir(asyncRoot);
      }
    });

    it("restores only active async runs for the current session", () => {
      const asyncRoot = createTempDir("pi-async-job-restore-scope-");
      try {
        const ownerDir = path.join(asyncRoot, "run-owner");
        const otherDir = path.join(asyncRoot, "run-other");
        fs.mkdirSync(ownerDir, { recursive: true });
        fs.mkdirSync(otherDir, { recursive: true });
        fs.writeFileSync(
          path.join(ownerDir, "status.json"),
          JSON.stringify({
            runId: "run-owner",
            mode: "single",
            state: "running",
            sessionId: "session-owner",
            startedAt: 1000,
            steps: [{ agent: "worker", status: "running" }],
          }),
          "utf-8",
        );
        fs.writeFileSync(
          path.join(otherDir, "status.json"),
          JSON.stringify({
            runId: "run-other",
            mode: "single",
            state: "running",
            sessionId: "session-other",
            startedAt: 1000,
            steps: [{ agent: "worker", status: "running" }],
          }),
          "utf-8",
        );

        const state = createState();
        state.currentSessionId = "session-owner";
        const tracker = trackerMod!.createAsyncJobTracker(
          createEventRecorder().pi,
          state as never,
          asyncRoot,
          {
            pollIntervalMs: 10,
          },
        );
        tracker.restoreActiveJobs();

        assert.deepEqual([...state.asyncJobs.keys()], ["run-owner"]);
        tracker.resetJobs();
      } finally {
        removeTempDir(asyncRoot);
      }
    });

    it("ignores started and complete events without the current session id", async () => {
      const asyncRoot = createTempDir("pi-async-job-event-scope-");
      try {
        const state = createState();
        state.currentSessionId = "session-owner";
        const tracker = trackerMod!.createAsyncJobTracker(
          createEventRecorder().pi,
          state as never,
          asyncRoot,
          {
            completionRetentionMs: 5,
            pollIntervalMs: 10,
          },
        );

        tracker.handleStarted({
          id: "run-sessionless",
          asyncDir: path.join(asyncRoot, "run-sessionless"),
          agent: "worker",
        });
        tracker.handleStarted({
          id: "run-other",
          asyncDir: path.join(asyncRoot, "run-other"),
          agent: "worker",
          sessionId: "session-other",
        });
        tracker.handleStarted({
          id: "run-owner",
          asyncDir: path.join(asyncRoot, "run-owner"),
          agent: "worker",
          sessionId: "session-owner",
        });

        assert.deepEqual([...state.asyncJobs.keys()], ["run-owner"]);

        tracker.handleComplete({ id: "run-owner", success: true });
        tracker.handleComplete({ id: "run-owner", success: true, sessionId: "session-other" });
        assert.equal(state.asyncJobs.get("run-owner")?.status, "queued");

        tracker.handleComplete({ id: "run-owner", success: true, sessionId: "session-owner" });
        await waitForCondition(
          () => !state.asyncJobs.has("run-owner"),
          "owned job cleanup after matching completion",
          scaleTestTimeout(1000),
        );
      } finally {
        removeTempDir(asyncRoot);
      }
    });

    it("restores matching active runs, quarantines startup corruption before session filtering, and keeps polling valid jobs", async () => {
      const root = createTempDir("pi-async-job-restore-bad-status-");
      const asyncRoot = path.join(root, "async-subagent-runs");
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (message?: unknown) => {
        warnings.push(String(message ?? ""));
      };
      try {
        const ownerDir = path.join(asyncRoot, "run-owner");
        const otherDir = path.join(asyncRoot, "run-other");
        const badJsonDir = path.join(asyncRoot, "run-bad-json");
        const badSessionDir = path.join(asyncRoot, "run-bad-session");
        fs.mkdirSync(ownerDir, { recursive: true });
        fs.mkdirSync(otherDir, { recursive: true });
        fs.mkdirSync(badJsonDir, { recursive: true });
        fs.mkdirSync(badSessionDir, { recursive: true });
        fs.writeFileSync(
          path.join(ownerDir, "status.json"),
          JSON.stringify({
            runId: "run-owner",
            mode: "single",
            state: "running",
            sessionId: "session-owner",
            startedAt: 1000,
            lastUpdate: 1000,
            steps: [{ agent: "worker", status: "running" }],
          }),
          "utf-8",
        );
        fs.writeFileSync(
          path.join(otherDir, "status.json"),
          JSON.stringify({
            runId: "run-other",
            mode: "single",
            state: "running",
            sessionId: "session-other",
            startedAt: 1000,
            steps: [{ agent: "worker", status: "running" }],
          }),
          "utf-8",
        );
        fs.writeFileSync(path.join(badJsonDir, "status.json"), "{bad json", "utf-8");
        fs.writeFileSync(path.join(badJsonDir, "events.jsonl"), '{"type":"event"}\n', "utf-8");
        fs.writeFileSync(path.join(badJsonDir, "output.log"), "private output\n", "utf-8");
        fs.writeFileSync(path.join(badJsonDir, "session.jsonl"), '{"private":true}\n', "utf-8");
        fs.writeFileSync(path.join(badJsonDir, "extra.txt"), "extra artifact\n", "utf-8");
        fs.writeFileSync(
          path.join(badSessionDir, "status.json"),
          JSON.stringify({
            runId: "run-bad-session",
            mode: "single",
            state: "running",
            sessionId: { value: "session-owner" },
            startedAt: 1000,
            steps: [{ agent: "worker", status: "running" }],
          }),
          "utf-8",
        );

        const state = createState();
        state.currentSessionId = "session-owner";
        const ui = createUiContext();
        const recorder = createEventRecorder();
        const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          pollIntervalMs: 10,
          quarantine: { createUniqueSuffix: () => "fixed-suffix" },
        });
        tracker.resetJobs(ui.ctx as never);
        assert.doesNotThrow(() => tracker.restoreActiveJobs(ui.ctx as never));
        assert.deepEqual([...state.asyncJobs.keys()], ["run-owner"]);
        assert.equal(state.asyncJobs.get("run-owner")?.status, "running");
        assert.ok(state.poller, "expected restored matching jobs to start polling");
        assert.ok(ui.widgets.length >= 2, "expected reset and restore to replace the widget");
        assert.equal(fs.existsSync(badJsonDir), false);
        assert.equal(fs.existsSync(badSessionDir), false);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0] ?? "", /restored 1 valid active job/);
        assert.match(warnings[0] ?? "", /quarantined 1 malformed JSON, 1 invalid persisted status/);
        assert.doesNotMatch(
          warnings[0] ?? "",
          /status\.json|run-bad|private|bad json|session-owner|\//,
        );
        const quarantineRoot = path.join(root, "quarantined-async-subagent-runs");
        assert.equal(
          fs.readFileSync(
            path.join(quarantineRoot, "run-bad-json.fixed-suffix", "status.json"),
            "utf-8",
          ),
          "{bad json",
        );
        assert.equal(
          fs.readFileSync(
            path.join(quarantineRoot, "run-bad-json.fixed-suffix", "events.jsonl"),
            "utf-8",
          ),
          '{"type":"event"}\n',
        );
        assert.equal(
          fs.readFileSync(
            path.join(quarantineRoot, "run-bad-json.fixed-suffix", "output.log"),
            "utf-8",
          ),
          "private output\n",
        );
        assert.equal(
          fs.readFileSync(
            path.join(quarantineRoot, "run-bad-json.fixed-suffix", "session.jsonl"),
            "utf-8",
          ),
          '{"private":true}\n',
        );
        assert.equal(
          fs.readFileSync(
            path.join(quarantineRoot, "run-bad-json.fixed-suffix", "extra.txt"),
            "utf-8",
          ),
          "extra artifact\n",
        );
        assert.equal(
          JSON.parse(
            fs.readFileSync(
              path.join(quarantineRoot, "run-bad-session.fixed-suffix", "status.json"),
              "utf-8",
            ),
          ).runId,
          "run-bad-session",
        );

        fs.writeFileSync(
          path.join(ownerDir, "status.json"),
          JSON.stringify({
            runId: "run-owner",
            mode: "single",
            state: "complete",
            sessionId: "session-owner",
            startedAt: 1000,
            lastUpdate: 2000,
            steps: [{ agent: "worker", status: "complete" }],
          }),
          "utf-8",
        );
        await waitForCondition(
          () => state.asyncJobs.get("run-owner")?.status === "complete",
          "restored job poll update",
        );
      } finally {
        console.warn = originalWarn;
        removeTempDir(root);
      }
    });

    it("warns once for unchanged quarantine failures and counts distinct dirs separately", () => {
      const root = createTempDir("pi-async-job-restore-quarantine-warning-");
      const asyncRoot = path.join(root, "async-subagent-runs");
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (message?: unknown) => {
        warnings.push(String(message ?? ""));
      };
      try {
        const ownerDir = path.join(asyncRoot, "run-owner");
        const badDirA = path.join(asyncRoot, "run-bad-a");
        const badDirB = path.join(asyncRoot, "run-bad-b");
        fs.mkdirSync(ownerDir, { recursive: true });
        fs.mkdirSync(badDirA, { recursive: true });
        fs.mkdirSync(badDirB, { recursive: true });
        fs.writeFileSync(
          path.join(ownerDir, "status.json"),
          JSON.stringify({
            runId: "run-owner",
            mode: "single",
            state: "running",
            sessionId: "session-owner",
            startedAt: 1000,
            steps: [{ agent: "worker", status: "running" }],
          }),
          "utf-8",
        );
        fs.writeFileSync(path.join(badDirA, "status.json"), "{bad json", "utf-8");
        fs.writeFileSync(path.join(badDirB, "status.json"), "{bad json", "utf-8");

        const state = createState();
        state.currentSessionId = "session-owner";
        const tracker = trackerMod!.createAsyncJobTracker(
          createEventRecorder().pi,
          state as never,
          asyncRoot,
          {
            pollIntervalMs: 10,
            quarantine: {
              createUniqueSuffix: () => "rename-failure",
              fs: {
                statSync: fs.statSync,
                readFileSync(filePath: string, encoding: BufferEncoding) {
                  return fs.readFileSync(filePath, encoding);
                },
                mkdirSync: fs.mkdirSync,
                renameSync() {
                  const error = new Error("blocked") as NodeJS.ErrnoException;
                  error.code = "EACCES";
                  throw error;
                },
              },
            },
          },
        );

        tracker.restoreActiveJobs();
        assert.deepEqual([...state.asyncJobs.keys()], ["run-owner"]);
        assert.equal(fs.existsSync(badDirA), true);
        assert.equal(fs.existsSync(badDirB), true);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0] ?? "", /restored 1 valid active job/);
        assert.match(warnings[0] ?? "", /left 2 malformed JSON in place/);
        assert.doesNotMatch(
          warnings[0] ?? "",
          /status\.json|run-bad|SyntaxError|private|bad json|stack|\//,
        );

        tracker.resetJobs();
        tracker.restoreActiveJobs();
        assert.equal(warnings.length, 1, "unchanged failed fingerprints should not warn again");
      } finally {
        console.warn = originalWarn;
        removeTempDir(root);
      }
    });

    it("warns once for unchanged deferred quarantine outcomes", () => {
      const root = createTempDir("pi-async-job-restore-quarantine-deferred-");
      const asyncRoot = path.join(root, "async-subagent-runs");
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (message?: unknown) => {
        warnings.push(String(message ?? ""));
      };
      try {
        const ownerDir = path.join(asyncRoot, "run-owner");
        const changedDir = path.join(asyncRoot, "run-bad-changed");
        const unstableDir = path.join(asyncRoot, "run-bad-unstable");
        fs.mkdirSync(ownerDir, { recursive: true });
        fs.mkdirSync(changedDir, { recursive: true });
        fs.mkdirSync(unstableDir, { recursive: true });
        fs.writeFileSync(
          path.join(ownerDir, "status.json"),
          JSON.stringify({
            runId: "run-owner",
            mode: "single",
            state: "running",
            sessionId: "session-owner",
            startedAt: 1000,
            steps: [{ agent: "worker", status: "running" }],
          }),
          "utf-8",
        );
        fs.writeFileSync(path.join(changedDir, "status.json"), "{bad json", "utf-8");
        fs.writeFileSync(path.join(unstableDir, "status.json"), "{bad json", "utf-8");

        const stableChangedStat = fs.statSync(path.join(changedDir, "status.json"));
        const unstableBefore = fs.statSync(path.join(unstableDir, "status.json"));
        const unstableAfter = {
          ...unstableBefore,
          mtimeMs: unstableBefore.mtimeMs + 1,
        } as fs.Stats;
        let unstableStatCalls = 0;
        const state = createState();
        state.currentSessionId = "session-owner";
        const tracker = trackerMod!.createAsyncJobTracker(
          createEventRecorder().pi,
          state as never,
          asyncRoot,
          {
            pollIntervalMs: 10,
            quarantine: {
              createUniqueSuffix: () => "deferred",
              fs: {
                statSync(filePath: string) {
                  if (filePath === path.join(changedDir, "status.json")) return stableChangedStat;
                  if (filePath === path.join(unstableDir, "status.json"))
                    return (
                      ++unstableStatCalls % 2 === 1 ? unstableBefore : unstableAfter
                    ) as fs.Stats;
                  return fs.statSync(filePath);
                },
                readFileSync(filePath: string, encoding: BufferEncoding) {
                  if (filePath === path.join(changedDir, "status.json")) return "{bad jzon";
                  return fs.readFileSync(filePath, encoding);
                },
                mkdirSync: fs.mkdirSync,
                renameSync: fs.renameSync,
              },
            },
          },
        );

        tracker.restoreActiveJobs();
        assert.deepEqual([...state.asyncJobs.keys()], ["run-owner"]);
        assert.equal(fs.existsSync(changedDir), true);
        assert.equal(fs.existsSync(unstableDir), true);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0] ?? "", /restored 1 valid active job/);
        assert.match(warnings[0] ?? "", /deferred 2 malformed JSON/);
        assert.doesNotMatch(warnings[0] ?? "", /status\.json|run-bad|bad json|\//);

        tracker.resetJobs();
        tracker.restoreActiveJobs();
        assert.equal(warnings.length, 1, "unchanged deferred fingerprints should not warn again");
      } finally {
        console.warn = originalWarn;
        removeTempDir(root);
      }
    });

    it("uses flattened async-start agents for initial parallel group widget state", () => {
      const asyncRoot = createTempDir("pi-async-job-tracker-");
      try {
        const state = createState();
        const recorder = createEventRecorder();
        const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot);

        tracker.handleStarted({
          id: "run-parallel-start",
          asyncDir: path.join(asyncRoot, "run-parallel-start"),
          agent: "scout",
          agents: ["scout", "reviewer", "worker", "writer"],
          chain: ["[scout+reviewer+worker]", "writer"],
          chainStepCount: 2,
          parallelGroups: [{ start: 0, count: 3, stepIndex: 0 }],
        });

        const job = state.asyncJobs.get("run-parallel-start");
        assert.deepEqual(job?.agents, ["scout", "reviewer", "worker"]);
        assert.equal(job?.chainStepCount, 2);
        assert.deepEqual(job?.parallelGroups, [{ start: 0, count: 3, stepIndex: 0 }]);
        assert.equal(job?.stepsTotal, 3);
        assert.equal(job?.activeParallelGroup, true);
      } finally {
        removeTempDir(asyncRoot);
      }
    });

    it("normalizes tk ticket metadata from async-start events", () => {
      const asyncRoot = createTempDir("pi-async-job-tracker-");
      try {
        const state = createState();
        const recorder = createEventRecorder();
        const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot);

        tracker.handleStarted({
          id: "run-ticketed-start",
          asyncDir: path.join(asyncRoot, "run-ticketed-start"),
          agent: "worker",
          tkTicket: { id: "psr-raw4", title: "Show\u009b active\u001b[31m tk\u001b[0m title" },
        });

        assert.deepEqual(state.asyncJobs.get("run-ticketed-start")?.tkTicket, {
          id: "psr-raw4",
          title: "Show active tk title",
        });
      } finally {
        removeTempDir(asyncRoot);
      }
    });

    it("adds flat step indexes to polled active parallel group steps", async () => {
      const asyncRoot = createTempDir("pi-async-job-tracker-");
      try {
        const runDir = path.join(asyncRoot, "run-chain");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId: "run-chain",
            mode: "chain",
            state: "running",
            startedAt: Date.now() - 1000,
            lastUpdate: Date.now(),
            currentStep: 1,
            chainStepCount: 3,
            parallelGroups: [{ start: 1, count: 2, stepIndex: 1 }],
            steps: [
              { agent: "scout", status: "complete" },
              {
                agent: "reviewer",
                status: "running",
                currentTool: "read",
                currentToolArgs: "src/tui/render.ts",
                recentTools: [{ tool: "grep", args: "async widget", endMs: Date.now() - 100 }],
                recentOutput: ["reviewer line"],
              },
              { agent: "auditor", status: "running" },
              { agent: "writer", status: "pending" },
            ],
          }),
          "utf-8",
        );

        const state = createState();
        const ui = createUiContext();
        const recorder = createEventRecorder();
        const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          pollIntervalMs: 10,
        });
        tracker.resetJobs(ui.ctx as never);
        tracker.handleStarted({
          id: "run-chain",
          asyncDir: runDir,
          mode: "chain",
          agents: ["scout", "reviewer", "auditor", "writer"],
        });

        await new Promise((resolve) => setTimeout(resolve, 50));

        const job = state.asyncJobs.get("run-chain");
        assert.deepEqual(
          job?.steps?.map((step: { index?: number }) => step.index),
          [1, 2],
        );
        assert.deepEqual(job?.agents, ["reviewer", "auditor"]);
        assert.equal(job?.steps?.[0]?.currentTool, "read");
        assert.equal(job?.steps?.[0]?.currentToolArgs, "src/tui/render.ts");
        assert.deepEqual(
          job?.steps?.[0]?.recentTools?.map((tool: { tool: string; args: string }) => ({
            tool: tool.tool,
            args: tool.args,
          })),
          [{ tool: "grep", args: "async widget" }],
        );
        assert.deepEqual(job?.steps?.[0]?.recentOutput, ["reviewer line"]);
      } finally {
        removeTempDir(asyncRoot);
      }
    });

    it("rerenders changed polled status but not unchanged bookkeeping", async () => {
      const asyncRoot = createTempDir("pi-async-job-tracker-");
      try {
        const runDir = path.join(asyncRoot, "run-unchanged");
        fs.mkdirSync(runDir, { recursive: true });
        const writeStatus = (lastUpdate: number, toolCount?: number) =>
          fs.writeFileSync(
            path.join(runDir, "status.json"),
            JSON.stringify({
              runId: "run-unchanged",
              mode: "single",
              state: "running",
              startedAt: 1000,
              lastUpdate,
              ...(toolCount !== undefined ? { toolCount } : {}),
              steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
            }),
            "utf-8",
          );
        writeStatus(2000);

        const state = createState();
        const ui = createUiContext();
        const recorder = createEventRecorder();
        const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          pollIntervalMs: 10,
        });
        tracker.resetJobs(ui.ctx as never);
        tracker.handleStarted({ id: "run-unchanged", asyncDir: runDir, agent: "worker" });

        const widgetUpdatesAfterStart = ui.widgets.length;
        await new Promise((resolve) => setTimeout(resolve, 35));
        assert.ok(
          ui.widgets.length > widgetUpdatesAfterStart,
          "first status load should replace the widget",
        );

        const widgetUpdatesAfterStatusLoaded = ui.widgets.length;
        fs.writeFileSync(
          path.join(runDir, "events.jsonl"),
          `${JSON.stringify({
            type: "subagent.control",
            channels: ["event"],
            event: {
              type: "needs_attention",
              to: "needs_attention",
              ts: 123,
              runId: "run-unchanged",
              agent: "worker",
              message: "worker needs attention",
            },
          })}\n`,
          "utf-8",
        );
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.equal(
          recorder.events.some((event) => event.channel === "subagent:control-event"),
          true,
        );
        assert.equal(
          ui.widgets.length,
          widgetUpdatesAfterStatusLoaded,
          "unchanged status and control cursors should not replace the widget",
        );

        writeStatus(3000, 1);
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.ok(
          ui.widgets.length > widgetUpdatesAfterStatusLoaded,
          "changed non-terminal status should replace the widget",
        );
      } finally {
        removeTempDir(asyncRoot);
      }
    });

    it("schedules cleanup when polling observes a completed status without a completion event", async () => {
      const asyncRoot = createTempDir("pi-async-job-tracker-");
      try {
        const runDir = path.join(asyncRoot, "run-2");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId: "run-2",
            mode: "single",
            state: "complete",
            startedAt: Date.now() - 1000,
            lastUpdate: Date.now(),
            steps: [{ agent: "worker", status: "complete" }],
          }),
          "utf-8",
        );

        const state = createState();
        const ui = createUiContext();
        const recorder = createEventRecorder();
        const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          completionRetentionMs: 5,
          pollIntervalMs: 10,
        });
        tracker.resetJobs(ui.ctx as never);
        tracker.handleStarted({ id: "run-2", asyncDir: runDir, agent: "worker" });

        await new Promise((resolve) => setTimeout(resolve, 80));

        assert.equal(state.asyncJobs.size, 0);
        assert.ok(ui.widgets.length > 0, "expected polling cleanup to replace the widget");
        assert.equal(ui.widgets.at(-1), undefined);
      } finally {
        removeTempDir(asyncRoot);
      }
    });

    it("retains continued and cancelled terminal jobs only for the standard completion window", async () => {
      for (const terminalState of ["continued", "cancelled"] as const) {
        const asyncRoot = createTempDir(`pi-async-job-${terminalState}-retention-`);
        try {
          const runDir = path.join(asyncRoot, `run-${terminalState}`);
          fs.mkdirSync(runDir, { recursive: true });
          fs.writeFileSync(
            path.join(runDir, "status.json"),
            JSON.stringify({
              runId: `run-${terminalState}`,
              mode: "single",
              state: terminalState,
              startedAt: Date.now() - 1000,
              lastUpdate: Date.now(),
              steps: [{ agent: "worker", status: terminalState }],
            }),
            "utf-8",
          );

          const state = createState();
          const ui = createUiContext();
          const tracker = trackerMod!.createAsyncJobTracker(
            createEventRecorder().pi,
            state as never,
            asyncRoot,
            { completionRetentionMs: 5, pollIntervalMs: 10 },
          );
          tracker.resetJobs(ui.ctx as never);
          tracker.handleStarted({
            id: `run-${terminalState}`,
            asyncDir: runDir,
            agent: "worker",
          });

          await waitForCondition(
            () => !state.asyncJobs.has(`run-${terminalState}`),
            `${terminalState} job cleanup after retention`,
          );
          assert.equal(ui.widgets.at(-1), undefined);
        } finally {
          removeTempDir(asyncRoot);
        }
      }
    });

    it("keeps retained terminal jobs while nested descendants are live", async () => {
      for (const terminalState of ["continued", "cancelled"] as const) {
        const asyncRoot = createTempDir(`pi-async-job-${terminalState}-nested-retention-`);
        let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
        try {
          const runDir = path.join(asyncRoot, `run-${terminalState}`);
          fs.mkdirSync(runDir, { recursive: true });
          fs.writeFileSync(
            path.join(runDir, "status.json"),
            JSON.stringify({
              runId: `run-${terminalState}`,
              mode: "single",
              state: terminalState,
              startedAt: Date.now() - 1000,
              lastUpdate: Date.now(),
              steps: [{ agent: "worker", status: terminalState }],
            }),
            "utf-8",
          );

          const state = createState();
          tracker = trackerMod!.createAsyncJobTracker(
            createEventRecorder().pi,
            state as never,
            asyncRoot,
            { completionRetentionMs: 5, pollIntervalMs: 10 },
          );
          tracker.handleStarted({
            id: `run-${terminalState}`,
            asyncDir: runDir,
            agent: "worker",
          });
          const job = state.asyncJobs.get(`run-${terminalState}`);
          assert.ok(job);
          job.nestedChildren = [
            {
              id: `nested-${terminalState}`,
              parentRunId: `run-${terminalState}`,
              depth: 1,
              path: [{ runId: `run-${terminalState}` }],
              state: "running",
              agent: "nested-worker",
            },
          ];

          await new Promise((resolve) => setTimeout(resolve, 50));
          assert.equal(state.asyncJobs.has(`run-${terminalState}`), true);
          assert.equal(state.cleanupTimers.has(`run-${terminalState}`), false);

          job.nestedChildren![0]!.state = "complete";
          await waitForCondition(
            () => !state.asyncJobs.has(`run-${terminalState}`),
            `${terminalState} cleanup after nested descendant completion`,
          );
        } finally {
          tracker?.resetJobs();
          removeTempDir(asyncRoot);
        }
      }
    });

    it("re-arms terminal cleanup after a missing status outlives a live nested descendant", async () => {
      const asyncRoot = createTempDir("pi-async-job-missing-status-retention-");
      const asyncId = "run-missing-status-retention";
      let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
      try {
        const state = createState();
        tracker = trackerMod!.createAsyncJobTracker(
          createEventRecorder().pi,
          state as never,
          asyncRoot,
          { completionRetentionMs: scaleTestTimeout(100), pollIntervalMs: 10 },
        );
        tracker.handleStarted({
          id: asyncId,
          asyncDir: path.join(asyncRoot, asyncId),
          agent: "worker",
        });
        tracker.handleComplete({ id: asyncId, success: true });

        const job = state.asyncJobs.get(asyncId);
        assert.ok(job);
        assert.equal(job.status, "complete");
        assert.equal(state.cleanupTimers.has(asyncId), true);
        job.nestedChildren = [
          {
            id: "nested-live",
            parentRunId: asyncId,
            depth: 1,
            path: [{ runId: asyncId }],
            state: "running",
            agent: "nested-worker",
          },
        ];

        await waitForCondition(
          () => !state.cleanupTimers.has(asyncId),
          "missing-status live nested descendant cleanup cancellation",
        );
        assert.equal(state.asyncJobs.has(asyncId), true);
        assert.equal(state.asyncJobs.get(asyncId)?.status, "complete");

        job.nestedChildren[0]!.state = "complete";
        await waitForCondition(
          () => state.cleanupTimers.has(asyncId),
          "missing-status terminal nested descendant cleanup re-arm",
        );
        assert.equal(state.asyncJobs.has(asyncId), true);
        assert.equal(state.asyncJobs.get(asyncId)?.status, "complete");
        await waitForCondition(
          () => !state.asyncJobs.has(asyncId),
          "missing-status terminal cleanup after nested descendant completion",
        );
      } finally {
        tracker?.resetJobs();
        removeTempDir(asyncRoot);
      }
    });

    it("repairs stale running jobs during polling", async () => {
      const asyncRoot = createTempDir("pi-async-job-stale-");
      try {
        const resultsDir = path.join(asyncRoot, "results");
        const runDir = path.join(asyncRoot, "run-stale");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId: "run-stale",
            mode: "single",
            state: "running",
            pid: 12345,
            startedAt: Date.now() - 1000,
            lastUpdate: Date.now() - 1000,
            steps: [{ agent: "worker", status: "running", startedAt: Date.now() - 1000 }],
          }),
          "utf-8",
        );

        const state = createState();
        const ui = createUiContext();
        const recorder = createEventRecorder();
        const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          completionRetentionMs: 5,
          pollIntervalMs: 10,
          resultsDir,
          kill: pidGone,
          now: () => Date.now(),
        });
        tracker.resetJobs(ui.ctx as never);
        tracker.handleStarted({ id: "run-stale", asyncDir: runDir, agent: "worker" });

        await waitForCondition(() => state.asyncJobs.size === 0, "stale async job cleanup");

        assert.equal(state.asyncJobs.size, 0);
        assert.equal(
          JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf-8")).state,
          "failed",
        );
        assert.equal(
          JSON.parse(fs.readFileSync(path.join(resultsDir, "run-stale.json"), "utf-8")).success,
          false,
        );
        assert.ok(ui.widgets.length > 0, "expected stale repair cleanup to replace the widget");
      } finally {
        removeTempDir(asyncRoot);
      }
    });

    it("repairs started jobs whose runner dies before writing status", async () => {
      const asyncRoot = createTempDir("pi-async-job-no-status-");
      try {
        const resultsDir = path.join(asyncRoot, "results");
        const runDir = path.join(asyncRoot, "run-no-status");
        const state = createState();
        const ui = createUiContext();
        const recorder = createEventRecorder();
        const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          completionRetentionMs: 5,
          pollIntervalMs: 10,
          resultsDir,
          kill: pidGone,
          now: () => Date.now() + 2000,
        });
        tracker.resetJobs(ui.ctx as never);
        tracker.handleStarted({
          id: "run-no-status",
          asyncDir: runDir,
          pid: 12345,
          sessionId: "session-current",
          mode: "parallel",
          agents: ["scout", "reviewer", "worker"],
          chainStepCount: 1,
          parallelGroups: [{ start: 0, count: 3, stepIndex: 0 }],
        });

        await new Promise((resolve) => setTimeout(resolve, 80));

        assert.equal(state.asyncJobs.size, 0);
        const status = JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf-8"));
        const result = JSON.parse(
          fs.readFileSync(path.join(resultsDir, "run-no-status.json"), "utf-8"),
        );
        assert.equal(status.state, "failed");
        assert.equal(status.sessionId, "session-current");
        assert.equal(status.mode, "parallel");
        assert.equal(status.currentStep, 0);
        assert.equal(status.chainStepCount, 1);
        assert.deepEqual(status.parallelGroups, [{ start: 0, count: 3, stepIndex: 0 }]);
        assert.deepEqual(
          status.steps.map((step: { agent: string; status: string }) => [step.agent, step.status]),
          [
            ["scout", "failed"],
            ["reviewer", "failed"],
            ["worker", "failed"],
          ],
        );
        assert.equal(result.success, false);
        assert.equal(result.sessionId, "session-current");
        assert.ok(
          ui.widgets.length > 0,
          "expected startup-crash repair cleanup to replace the widget",
        );
      } finally {
        removeTempDir(asyncRoot);
      }
    });

    it("cleans up jobs when status polling hits a terminal read error", async () => {
      const asyncRoot = createTempDir("pi-async-job-bad-status-");
      try {
        const runDir = path.join(asyncRoot, "run-bad-status");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(path.join(runDir, "status.json"), "{", "utf-8");
        const state = createState();
        const ui = createUiContext();
        const recorder = createEventRecorder();
        const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          completionRetentionMs: 5,
          pollIntervalMs: 10,
        });
        tracker.resetJobs(ui.ctx as never);
        tracker.handleStarted({ id: "run-bad-status", asyncDir: runDir, agent: "worker" });

        await new Promise((resolve) => setTimeout(resolve, 80));

        assert.equal(state.asyncJobs.size, 0);
        assert.ok(ui.widgets.length > 0, "expected malformed status cleanup to replace the widget");
      } finally {
        removeTempDir(asyncRoot);
      }
    });

    it("does not clean up a status-read failure while nested descendants are live", async () => {
      const asyncRoot = createTempDir("pi-async-job-bad-status-nested-");
      let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
      const originalError = console.error;
      console.error = () => {};
      try {
        const runDir = path.join(asyncRoot, "run-bad-status-nested");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(path.join(runDir, "status.json"), "{", "utf-8");
        const state = createState();
        const recorder = createEventRecorder();
        tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          completionRetentionMs: 5,
          pollIntervalMs: 10,
        });
        tracker.handleStarted({ id: "run-bad-status-nested", asyncDir: runDir, agent: "worker" });
        const job = state.asyncJobs.get("run-bad-status-nested");
        assert.ok(job);
        job.nestedChildren = [
          {
            id: "nested-live",
            parentRunId: "run-bad-status-nested",
            depth: 1,
            path: [{ runId: "run-bad-status-nested" }],
            state: "running",
            agent: "nested-worker",
          },
        ];

        await new Promise((resolve) => setTimeout(resolve, 80));

        assert.equal(state.asyncJobs.has("run-bad-status-nested"), true);
        assert.equal(state.asyncJobs.get("run-bad-status-nested")?.status, "failed");
        assert.equal(state.cleanupTimers.has("run-bad-status-nested"), false);
      } finally {
        console.error = originalError;
        tracker?.resetJobs();
        removeTempDir(asyncRoot);
      }
    });

    it("cleans up status-read failures when nested refresh also fails without live descendants", async () => {
      const asyncRoot = createTempDir("pi-async-job-bad-status-nested-refresh-");
      let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
      const originalError = console.error;
      const errors: string[] = [];
      console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
      try {
        const runDir = path.join(asyncRoot, "run-bad-status-nested-refresh");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(path.join(runDir, "status.json"), "{", "utf-8");
        const state = createState();
        const ui = createUiContext();
        const recorder = createEventRecorder();
        tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          completionRetentionMs: 5,
          pollIntervalMs: 10,
        });
        tracker.resetJobs(ui.ctx as never);
        tracker.handleStarted({
          id: "run-bad-status-nested-refresh",
          asyncDir: runDir,
          agent: "worker",
          nestedRoute: {
            rootRunId: "run-bad-status-nested-refresh",
            eventSink: path.join(asyncRoot, "not-contained-events"),
            controlInbox: path.join(asyncRoot, "not-contained-controls"),
            capabilityToken: "bad-token",
          },
        });

        await waitForCondition(
          () => !state.asyncJobs.has("run-bad-status-nested-refresh"),
          "combined nested refresh and status-read cleanup",
        );

        assert.equal(state.cleanupTimers.has("run-bad-status-nested-refresh"), false);
        assert.equal(
          errors.some((message) => message.includes("Failed to refresh nested async descendants")),
          true,
        );
        assert.equal(
          errors.some((message) => message.includes("Failed to read async status")),
          true,
        );
        assert.ok(ui.widgets.length > 0, "expected combined failure cleanup to replace the widget");
      } finally {
        console.error = originalError;
        tracker?.resetJobs();
        removeTempDir(asyncRoot);
      }
    });

    it("keeps root jobs running when nested refresh fails during polling", async () => {
      const asyncRoot = createTempDir("pi-async-job-nested-refresh-um");
      let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
      const originalError = console.error;
      console.error = () => {};
      try {
        const runDir = path.join(asyncRoot, "run-nested-refresh");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId: "run-nested-refresh",
            mode: "single",
            state: "running",
            startedAt: Date.now() - 1000,
            lastUpdate: Date.now(),
            steps: [{ agent: "worker", status: "running" }],
          }),
          "utf-8",
        );

        const state = createState();
        const recorder = createEventRecorder();
        tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          completionRetentionMs: 5,
          pollIntervalMs: 10,
        });
        tracker.handleStarted({
          id: "run-nested-refresh",
          asyncDir: runDir,
          agent: "worker",
          nestedRoute: {
            rootRunId: "run-nested-refresh",
            eventSink: path.join(asyncRoot, "not-contained-events"),
            controlInbox: path.join(asyncRoot, "not-contained-controls"),
            capabilityToken: "bad-token",
          },
        });

        await new Promise((resolve) => setTimeout(resolve, 50));

        assert.equal(state.asyncJobs.get("run-nested-refresh")?.status, "running");
        assert.equal(state.cleanupTimers.has("run-nested-refresh"), false);
      } finally {
        console.error = originalError;
        tracker?.resetJobs();
        removeTempDir(asyncRoot);
      }
    });

    it("preserves an already-armed terminal cleanup timer through persistent nested refresh failure", async () => {
      const asyncRoot = createTempDir("pi-async-job-nested-refresh-um");
      let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
      const originalError = console.error;
      const errors: string[] = [];
      console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
      try {
        const runDir = path.join(asyncRoot, "run-nested-refresh");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId: "run-nested-refresh",
            mode: "single",
            state: "complete",
            startedAt: Date.now() - 1000,
            lastUpdate: Date.now(),
            steps: [{ agent: "worker", status: "complete" }],
          }),
          "utf-8",
        );

        const state = createState();
        const recorder = createEventRecorder();
        tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          completionRetentionMs: scaleTestTimeout(500),
          pollIntervalMs: 10,
        });
        tracker.handleStarted({
          id: "run-nested-refresh",
          asyncDir: runDir,
          agent: "worker",
        });
        tracker.handleComplete({ id: "run-nested-refresh", success: true });
        const job = state.asyncJobs.get("run-nested-refresh");
        assert.ok(job);
        job.nestedRoute = {
          rootRunId: "run-nested-refresh",
          eventSink: path.join(asyncRoot, "not-contained-events"),
          controlInbox: path.join(asyncRoot, "not-contained-controls"),
          capabilityToken: "bad-token",
        };

        await new Promise((resolve) => setTimeout(resolve, scaleTestTimeout(150)));

        assert.ok(
          errors.some((message) => message.includes("Failed to refresh nested async descendants")),
          "expected persistent nested refresh failure diagnostic",
        );
        assert.equal(state.asyncJobs.get("run-nested-refresh")?.status, "complete");
        assert.equal(state.asyncJobs.has("run-nested-refresh"), true);
        assert.equal(state.cleanupTimers.has("run-nested-refresh"), true);

        await waitForCondition(
          () => !state.asyncJobs.has("run-nested-refresh"),
          "terminal cleanup after persistent nested refresh failure",
          scaleTestTimeout(2_000),
        );
        assert.equal(state.cleanupTimers.has("run-nested-refresh"), false);
      } finally {
        console.error = originalError;
        tracker?.resetJobs();
        removeTempDir(asyncRoot);
      }
    });

    it("cancels cleanup timers when polling observes a non-terminal status", async () => {
      const asyncRoot = createTempDir("pi-async-job-cleanup-cancel-");
      let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
      try {
        const runDir = path.join(asyncRoot, "run-recovered");
        fs.mkdirSync(runDir, { recursive: true });
        const state = createState();
        const recorder = createEventRecorder();
        tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          completionRetentionMs: 1_000,
          pollIntervalMs: 10,
        });
        tracker.handleStarted({ id: "run-recovered", asyncDir: runDir, agent: "worker" });
        tracker.handleComplete({ id: "run-recovered", success: true });
        assert.equal(state.cleanupTimers.has("run-recovered"), true);

        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId: "run-recovered",
            mode: "single",
            state: "running",
            startedAt: Date.now() - 1000,
            lastUpdate: Date.now(),
            steps: [{ agent: "worker", status: "running" }],
          }),
          "utf-8",
        );

        const deadline = Date.now() + 200;
        while (Date.now() < deadline && state.cleanupTimers.has("run-recovered")) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        assert.equal(state.cleanupTimers.has("run-recovered"), false);
        assert.equal(state.asyncJobs.get("run-recovered")?.status, "running");
      } finally {
        tracker?.resetJobs();
        removeTempDir(asyncRoot);
      }
    });

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

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { writeAsyncArtifactJson as writeJson } from "../support/async-artifact-fixtures.ts";
import {
  consumeChildMessageRequests,
  steerRequestsDir,
  writeChildMessageAcceptance,
} from "../../src/runs/background/control-channel.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { ASYNC_DIR, RESULTS_DIR, type SubagentState } from "../../src/shared/types.ts";
function createState(): SubagentState {
  return {
    baseCwd: "",
    currentSessionId: null,
    asyncJobs: new Map(),
    foregroundRuns: new Map(),
    foregroundControls: new Map(),
    lastForegroundControlId: null,
    pendingForegroundControlNotices: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: { schedule: () => false, clear: () => {} },
  };
}

function createRunningAsync(
  state: SubagentState,
  runId: string,
  options: { track?: boolean } = {},
): string {
  const asyncDir = path.join(ASYNC_DIR, runId);
  const sessionFile = path.join(asyncDir, "worker.jsonl");
  fs.mkdirSync(asyncDir, { recursive: true });
  fs.writeFileSync(sessionFile, "", "utf-8");
  writeJson(path.join(asyncDir, "status.json"), {
    runId,
    mode: "single",
    state: "running",
    pid: 12345,
    sessionId: "session",
    cwd: os.tmpdir(),
    startedAt: 100,
    lastUpdate: Date.now(),
    sessionFile,
    steps: [{ agent: "worker", status: "running", startedAt: 100, sessionFile }],
  });
  if (options.track !== false) {
    state.asyncJobs.set(runId, {
      asyncId: runId,
      asyncDir,
      status: "running",
      pid: 12345,
      agents: ["worker"],
      updatedAt: 100,
    });
  }
  return asyncDir;
}

type InterruptLifecycleState =
  | "paused"
  | "continued"
  | "cancelled"
  | "running"
  | "failed"
  | "complete";

function writeInterruptStatus(
  runId: string,
  state: InterruptLifecycleState,
  projectMarker = false,
): string {
  const asyncDir = path.join(ASYNC_DIR, runId);
  const sessionFile = path.join(asyncDir, "worker.jsonl");
  const now = Date.now();
  const pause = { kind: "awaiting_supervisor" as const };
  const cancel = { summary: "Cancelled by test.", cancelledAt: now };
  fs.mkdirSync(asyncDir, { recursive: true });
  fs.writeFileSync(sessionFile, "", "utf-8");
  writeJson(path.join(asyncDir, "status.json"), {
    runId,
    mode: "single",
    state,
    sessionId: "session",
    cwd: os.tmpdir(),
    startedAt: 100,
    lastUpdate: now,
    ...(state === "running" ? { pid: 12345 } : {}),
    ...(state === "paused" ? { pause } : {}),
    ...(state === "cancelled" ? { cancel } : {}),
    ...(projectMarker ? { projectAgents: [] } : {}),
    steps: [
      {
        agent: "worker",
        status: state,
        startedAt: 100,
        sessionFile,
        ...(state === "paused" ? { pause } : {}),
        ...(state === "cancelled" ? { cancel } : {}),
      },
    ],
  });
  return asyncDir;
}

function createMissingStatusDirectory(runId: string): string {
  const asyncDir = path.join(ASYNC_DIR, runId);
  fs.mkdirSync(asyncDir, { recursive: true });
  return asyncDir;
}

function rememberCompletedForeground(state: SubagentState, runId: string): void {
  state.foregroundRuns!.set(runId, {
    runId,
    mode: "single",
    cwd: os.tmpdir(),
    updatedAt: 100,
    children: [{ agent: "worker", index: 0, status: "completed" }],
  });
}

function cleanup(runId: string, asyncDir: string): void {
  fs.rmSync(asyncDir, { recursive: true, force: true });
  fs.rmSync(path.join(RESULTS_DIR, `${runId}.json`), { force: true });
}

function executorWithKill(
  state: SubagentState,
  kill: (pid: number, signal?: NodeJS.Signals | 0) => boolean,
  discoverAgents: () => { agents: any[] } = () => ({ agents: [] }),
) {
  return createSubagentExecutor({
    pi: {
      events: {
        emit() {},
        on() {
          return () => {};
        },
      },
      getSessionName() {
        return "parent";
      },
    } as any,
    state,
    config: { maxSubagentDepth: 2, control: {} } as any,
    tempArtifactsDir: os.tmpdir(),
    getSubagentSessionRoot: (parentSessionFile) =>
      parentSessionFile
        ? path.join(path.dirname(parentSessionFile), path.basename(parentSessionFile, ".jsonl"))
        : os.tmpdir(),
    expandTilde: (value) => value,
    discoverAgents,
    kill,
  });
}

function ctx() {
  return {
    cwd: os.tmpdir(),
    hasUI: false,
    sessionManager: {
      getSessionId() {
        return "session";
      },
      getSessionFile() {
        return null;
      },
    },
    modelRegistry: {
      getAvailable() {
        return [];
      },
    },
  } as any;
}

function text(result: Awaited<ReturnType<ReturnType<typeof executorWithKill>["execute"]>>): string {
  return result.content[0]?.type === "text" ? result.content[0].text : "";
}

describe("async interrupt action", () => {
  it("queues steering for a running async child", async () => {
    const state = createState();
    const runId = `steer-disk-${Date.now().toString(36)}`;
    const asyncDir = createRunningAsync(state, runId, { track: false });
    try {
      const result = await executorWithKill(state, () => true).execute(
        "steer",
        { action: "steer", id: runId, message: "Focus on tests." },
        new AbortController().signal,
        undefined,
        ctx(),
      );

      assert.equal(result.isError, undefined);
      assert.match(text(result), new RegExp(`Steering queued for async run ${runId}`));
      const requests = consumeChildMessageRequests(asyncDir);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.type, "steer");
      assert.equal(requests[0]?.message, "Focus on tests.");
      assert.equal(requests[0]?.source, "steer-action");
      assert.equal(requests[0]?.targetIndex, undefined);
    } finally {
      cleanup(runId, asyncDir);
    }
  });

  it("queues steering for a running async child by directory", async () => {
    const state = createState();
    const runId = `steer-dir-${Date.now().toString(36)}`;
    const asyncDir = createRunningAsync(state, runId, { track: false });
    try {
      const result = await executorWithKill(state, () => true).execute(
        "steer",
        { action: "steer", dir: asyncDir, message: "Focus on validation." },
        new AbortController().signal,
        undefined,
        ctx(),
      );

      assert.equal(result.isError, undefined);
      assert.match(text(result), new RegExp(`Steering queued for async run ${runId}`));
      const requests = consumeChildMessageRequests(asyncDir);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.type, "steer");
      assert.equal(requests[0]?.message, "Focus on validation.");
    } finally {
      cleanup(runId, asyncDir);
    }
  });

  it("queues steering for a pending indexed async child", async () => {
    const state = createState();
    const runId = `steer-pending-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, runId);
    writeJson(path.join(asyncDir, "status.json"), {
      runId,
      mode: "parallel",
      state: "running",
      pid: 12345,
      sessionId: "session",
      cwd: os.tmpdir(),
      startedAt: 100,
      lastUpdate: Date.now(),
      steps: [
        { agent: "done", status: "complete", startedAt: 100 },
        { agent: "later", status: "pending" },
      ],
    });
    try {
      const result = await executorWithKill(state, () => true).execute(
        "steer",
        { action: "steer", id: runId, index: 1, message: "Use the new API." },
        new AbortController().signal,
        undefined,
        ctx(),
      );

      assert.equal(result.isError, undefined);
      const requests = consumeChildMessageRequests(asyncDir);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.type, "steer");
      assert.equal(requests[0]?.message, "Use the new API.");
      assert.equal(requests[0]?.targetIndex, 1);
    } finally {
      cleanup(runId, asyncDir);
    }
  });

  it("queues indexed live resume natively without interrupt", async () => {
    const state = createState();
    const runId = `resume-native-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, runId);
    const sessions = [path.join(asyncDir, "first.jsonl"), path.join(asyncDir, "second.jsonl")];
    fs.mkdirSync(asyncDir, { recursive: true });
    for (const sessionFile of sessions) fs.writeFileSync(sessionFile, "", "utf-8");
    writeJson(path.join(asyncDir, "status.json"), {
      runId,
      mode: "parallel",
      state: "running",
      pid: 12345,
      sessionId: "session",
      cwd: os.tmpdir(),
      startedAt: 100,
      lastUpdate: Date.now(),
      steps: [
        { agent: "first", status: "running", startedAt: 100, sessionFile: sessions[0] },
        { agent: "second", status: "running", startedAt: 100, sessionFile: sessions[1] },
      ],
    });
    const kills: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
    try {
      const result = await executorWithKill(state, (pid, signal) => {
        kills.push({ pid, signal });
        const requestDir = steerRequestsDir(asyncDir);
        const requestFile = fs.existsSync(requestDir) ? fs.readdirSync(requestDir)[0] : undefined;
        if (requestFile) {
          const request = JSON.parse(fs.readFileSync(path.join(requestDir, requestFile), "utf-8"));
          writeChildMessageAcceptance(asyncDir, {
            requestId: request.id,
            type: "resume",
            status: "accepted",
            ts: Date.now(),
            acceptedIndexes: [1],
          });
        }
        return true;
      }).execute(
        "resume",
        { action: "resume", id: runId, index: 1, message: "Continue with the focused fix." },
        new AbortController().signal,
        undefined,
        ctx(),
      );

      assert.equal(result.isError, undefined);
      assert.match(
        text(result),
        new RegExp(`Resume follow-up accepted for live async run ${runId} child 1`),
      );
      const requestFiles = fs.readdirSync(steerRequestsDir(asyncDir));
      assert.equal(requestFiles.length, 1);
      assert.equal(
        path.dirname(path.join(steerRequestsDir(asyncDir), requestFiles[0]!)),
        steerRequestsDir(asyncDir),
      );
      const requests = consumeChildMessageRequests(asyncDir);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.type, "resume");
      assert.equal(requests[0]?.targetIndex, 1);
      assert.equal(requests[0]?.message, "Continue with the focused fix.");
      assert.ok(kills.length >= 1);
      assert.equal(
        kills.every(({ signal }) => signal === 0),
        true,
      );
      assert.equal(fs.existsSync(path.join(asyncDir, "control", "interrupt.json")), false);
    } finally {
      cleanup(runId, asyncDir);
    }
  });

  it("returns runner rejection instead of optimistic resume success", async () => {
    const state = createState();
    const runId = `resume-rejected-${Date.now().toString(36)}`;
    const asyncDir = createRunningAsync(state, runId);
    try {
      const result = await executorWithKill(state, () => {
        const requestDir = steerRequestsDir(asyncDir);
        const requestFile = fs.existsSync(requestDir) ? fs.readdirSync(requestDir)[0] : undefined;
        if (requestFile) {
          const request = JSON.parse(fs.readFileSync(path.join(requestDir, requestFile), "utf-8"));
          writeChildMessageAcceptance(asyncDir, {
            requestId: request.id,
            type: "resume",
            status: "rejected",
            ts: Date.now(),
            acceptedIndexes: [],
            rejected: [{ index: 0, reason: "child is complete" }],
            reason: "child is complete",
          });
        }
        return true;
      }).execute(
        "resume",
        { action: "resume", id: runId, message: "Continue." },
        new AbortController().signal,
        undefined,
        ctx(),
      );
      assert.equal(result.isError, true);
      assert.match(text(result), /was not accepted: child is complete/);
      assert.equal(
        fs.existsSync(steerRequestsDir(asyncDir)) &&
          fs.readdirSync(steerRequestsDir(asyncDir)).length > 0,
        false,
      );
    } finally {
      cleanup(runId, asyncDir);
    }
  });

  it("returns a clear error when the runner disappears before acceptance", async () => {
    const state = createState();
    const runId = `resume-ack-gone-${Date.now().toString(36)}`;
    const asyncDir = createRunningAsync(state, runId);
    let livenessChecks = 0;
    try {
      const result = await executorWithKill(state, () => {
        livenessChecks++;
        if (livenessChecks >= 3) {
          const error = new Error("gone") as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        }
        return true;
      }).execute(
        "resume",
        { action: "resume", id: runId, message: "Continue." },
        new AbortController().signal,
        undefined,
        ctx(),
      );
      assert.equal(result.isError, true);
      assert.match(text(result), /runner disappeared before accepting it/);
      assert.equal(
        fs.existsSync(steerRequestsDir(asyncDir)) &&
          fs.readdirSync(steerRequestsDir(asyncDir)).length > 0,
        false,
      );
    } finally {
      cleanup(runId, asyncDir);
    }
  });

  it("rejects omitted-index live resume when multiple children are running", async () => {
    const state = createState();
    const runId = `resume-ambiguous-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, runId);
    fs.mkdirSync(asyncDir, { recursive: true });
    writeJson(path.join(asyncDir, "status.json"), {
      runId,
      mode: "parallel",
      state: "running",
      pid: 12345,
      sessionId: "session",
      cwd: os.tmpdir(),
      startedAt: 100,
      lastUpdate: Date.now(),
      steps: [
        { agent: "first", status: "running", startedAt: 100 },
        { agent: "second", status: "running", startedAt: 100 },
      ],
    });
    try {
      const result = await executorWithKill(state, () => true).execute(
        "resume",
        { action: "resume", id: runId, message: "Continue." },
        new AbortController().signal,
        undefined,
        ctx(),
      );
      assert.equal(result.isError, true);
      assert.match(text(result), /has 2 running children\. Provide index to choose one/);
      assert.equal(fs.existsSync(steerRequestsDir(asyncDir)), false);
    } finally {
      cleanup(runId, asyncDir);
    }
  });

  it("rejects live resume and steer when session ownership is missing", async () => {
    const state = createState();
    const runId = `control-owner-missing-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, runId);
    const sessionFile = path.join(asyncDir, "worker.jsonl");
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    writeJson(path.join(asyncDir, "status.json"), {
      runId,
      mode: "single",
      state: "running",
      pid: 12345,
      cwd: os.tmpdir(),
      startedAt: 100,
      lastUpdate: Date.now(),
      sessionFile,
      steps: [{ agent: "worker", status: "running", startedAt: 100, sessionFile }],
    });
    try {
      for (const action of ["resume", "steer"] as const) {
        const result = await executorWithKill(state, () => true).execute(
          action,
          { action, id: runId, message: "Continue." },
          new AbortController().signal,
          undefined,
          ctx(),
        );
        assert.equal(result.isError, true);
        assert.match(text(result), /owned by another session/);
      }
      assert.equal(fs.existsSync(steerRequestsDir(asyncDir)), false);
    } finally {
      cleanup(runId, asyncDir);
    }
  });

  it("rejects live resume after the runner has gone stale", async () => {
    const state = createState();
    const runId = `resume-gone-${Date.now().toString(36)}`;
    const asyncDir = createRunningAsync(state, runId, { track: false });
    try {
      const result = await executorWithKill(state, () => {
        const error = new Error("gone") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }).execute(
        "resume",
        { action: "resume", id: runId, message: "Continue." },
        new AbortController().signal,
        undefined,
        ctx(),
      );
      assert.equal(result.isError, true);
      assert.match(text(result), /was running when resume began.*No durable revival was started/);
      assert.doesNotMatch(text(result), /accepted for live async run/);
      const steerResult = await executorWithKill(state, () => true).execute(
        "steer",
        { action: "steer", id: runId, message: "Continue." },
        new AbortController().signal,
        undefined,
        ctx(),
      );
      assert.equal(steerResult.isError, true);
      assert.match(text(steerResult), /is not running or queued and cannot be steered/);
      assert.equal(fs.existsSync(steerRequestsDir(asyncDir)), false);
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")).state,
        "failed",
      );
    } finally {
      cleanup(runId, asyncDir);
    }
  });

  it("rejects live resume and steer for an artifact owned by another session", async () => {
    const state = createState();
    const runId = `control-foreign-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, runId);
    const sessionFile = path.join(asyncDir, "worker.jsonl");
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    writeJson(path.join(asyncDir, "status.json"), {
      runId,
      mode: "single",
      state: "running",
      pid: 12345,
      sessionId: "other-session",
      cwd: os.tmpdir(),
      startedAt: 100,
      lastUpdate: Date.now(),
      sessionFile,
      steps: [{ agent: "worker", status: "running", startedAt: 100, sessionFile }],
    });
    try {
      for (const action of ["resume", "steer"] as const) {
        const result = await executorWithKill(state, () => true).execute(
          action,
          { action, id: runId, message: "Focus on the current diff." },
          new AbortController().signal,
          undefined,
          ctx(),
        );
        assert.equal(result.isError, true);
        assert.match(
          text(result),
          new RegExp(
            `owned by another session and cannot be ${action === "resume" ? "resumed" : "steered"}`,
          ),
        );
      }
      assert.equal(fs.existsSync(steerRequestsDir(asyncDir)), false);
    } finally {
      cleanup(runId, asyncDir);
    }
  });

  it("keeps persisted interrupt cancellation semantics across foreground and async routes", async () => {
    const states = [
      "paused",
      "continued",
      "cancelled",
      "running",
      "failed",
      "complete",
      "missing",
    ] as const;
    let caseNumber = 0;
    for (const route of ["foreground", "async"] as const) {
      for (const persistedState of states) {
        const state = createState();
        const runId = `interrupt-${route}-${persistedState}-${Date.now().toString(36)}-${caseNumber++}`;
        if (route === "foreground") rememberCompletedForeground(state, runId);
        const asyncDir =
          persistedState === "missing"
            ? createMissingStatusDirectory(runId)
            : writeInterruptStatus(runId, persistedState);
        const kills: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
        try {
          const result = await executorWithKill(state, (pid, signal) => {
            kills.push({ pid, signal });
            return true;
          }).execute(
            "interrupt",
            { action: "interrupt", id: runId },
            new AbortController().signal,
            undefined,
            ctx(),
          );

          if (persistedState === "paused" || persistedState === "cancelled") {
            assert.equal(result.isError, undefined, `${route}/${persistedState}`);
            assert.match(
              text(result),
              persistedState === "paused" ? /Cancelled paused foreground run/ : /already cancelled/,
            );
          } else if (persistedState === "continued") {
            assert.equal(result.isError, true, `${route}/${persistedState}`);
            assert.match(text(result), /already continued/);
          } else if (route === "async" && persistedState === "running") {
            assert.equal(result.isError, undefined);
            assert.match(text(result), new RegExp(`Interrupt requested for async run ${runId}`));
            assert.deepEqual(kills, [
              { pid: 12345, signal: 0 },
              { pid: 12345, signal: process.platform === "win32" ? "SIGBREAK" : "SIGUSR2" },
            ]);
          } else {
            assert.equal(result.isError, true, `${route}/${persistedState}`);
            assert.match(
              text(result),
              route === "foreground"
                ? /No interrupt-capable run found in this session/
                : /No running async run with an interrupt-capable pid/,
            );
            assert.deepEqual(kills, []);
          }
          assert.equal(
            fs.existsSync(path.join(asyncDir, "control", "interrupt.json")),
            route === "async" && persistedState === "running",
          );
        } finally {
          cleanup(runId, asyncDir);
        }
      }
    }
  });

  it("rejects an unauthorized project interrupt before cancellation or interrupt request", async () => {
    const state = createState();
    const runId = `interrupt-project-marker-${Date.now().toString(36)}`;
    const asyncDir = writeInterruptStatus(runId, "paused", true);
    const kills: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
    try {
      const result = await executorWithKill(state, (pid, signal) => {
        kills.push({ pid, signal });
        return true;
      }).execute(
        "interrupt",
        { action: "interrupt", id: runId },
        new AbortController().signal,
        undefined,
        ctx(),
      );

      assert.equal(result.isError, true);
      assert.match(
        text(result),
        /persisted run carries a project-agent marker, but its process-private reference is unavailable/,
      );
      assert.deepEqual(kills, []);
      assert.equal(fs.existsSync(path.join(asyncDir, "control", "interrupt.json")), false);
      const persisted = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
      assert.equal(persisted.state, "paused");
      assert.equal(persisted.cancel, undefined);
    } finally {
      cleanup(runId, asyncDir);
    }
  });

  it("interrupts a running async run resolved from disk after in-memory tracking is gone", async () => {
    const state = createState();
    const runId = `interrupt-disk-${Date.now().toString(36)}`;
    const asyncDir = createRunningAsync(state, runId, { track: false });
    try {
      const kills: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
      const result = await executorWithKill(state, (pid, signal) => {
        kills.push({ pid, signal });
        return true;
      }).execute(
        "interrupt",
        { action: "interrupt", id: runId },
        new AbortController().signal,
        undefined,
        ctx(),
      );

      assert.equal(result.isError, undefined);
      assert.match(text(result), new RegExp(`Interrupt requested for async run ${runId}`));
      assert.equal(fs.existsSync(path.join(asyncDir, "control", "interrupt.json")), true);
      assert.deepEqual(kills, [
        { pid: 12345, signal: 0 },
        { pid: 12345, signal: process.platform === "win32" ? "SIGBREAK" : "SIGUSR2" },
      ]);
    } finally {
      cleanup(runId, asyncDir);
    }
  });

  it("reports success and writes the portable request when the signal is unavailable", async () => {
    const state = createState();
    const runId = `interrupt-enosys-${Date.now().toString(36)}`;
    const asyncDir = createRunningAsync(state, runId);
    try {
      const result = await executorWithKill(state, (_pid, signal) => {
        if (signal === 0) return true;
        const error = new Error("kill ENOSYS") as NodeJS.ErrnoException;
        error.code = "ENOSYS";
        throw error;
      }).execute(
        "interrupt",
        { action: "interrupt", id: runId },
        new AbortController().signal,
        undefined,
        ctx(),
      );

      assert.equal(result.isError, undefined);
      assert.match(text(result), new RegExp(`Interrupt requested for async run ${runId}`));
      assert.equal(fs.existsSync(path.join(asyncDir, "control", "interrupt.json")), true);
    } finally {
      cleanup(runId, asyncDir);
    }
  });

  it("does not report success for stale running status with a dead pid", async () => {
    const state = createState();
    const runId = `interrupt-esrch-${Date.now().toString(36)}`;
    const asyncDir = createRunningAsync(state, runId);
    try {
      const result = await executorWithKill(state, () => {
        const error = new Error("missing process") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }).execute(
        "interrupt",
        { action: "interrupt", id: runId },
        new AbortController().signal,
        undefined,
        ctx(),
      );

      assert.equal(result.isError, true);
      assert.match(text(result), /No running async run with an interrupt-capable pid/);
      assert.equal(fs.existsSync(path.join(asyncDir, "control", "interrupt.json")), false);
      const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
      assert.equal(status.state, "failed");
    } finally {
      cleanup(runId, asyncDir);
    }
  });
});

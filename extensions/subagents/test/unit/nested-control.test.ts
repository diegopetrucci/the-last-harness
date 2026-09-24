import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  buildResumeModelResolution,
  createSubagentExecutor,
} from "../../src/extension/subagent-executor.ts";
import {
  createNestedRoute,
  projectNestedEvents,
  writeNestedEvent,
} from "../../src/runs/shared/nested-events.ts";
import {
  SUBAGENT_CHILD_ENV,
  SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
  SUBAGENT_PARENT_CHILD_INDEX_ENV,
  SUBAGENT_PARENT_CONTROL_INBOX_ENV,
  SUBAGENT_PARENT_EVENT_SINK_ENV,
  SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
  SUBAGENT_PARENT_RUN_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";
import { consumeChildMessageRequests } from "../../src/runs/background/control-channel.ts";
import { RESULTS_DIR, TEMP_ROOT_DIR, type SubagentState } from "../../src/shared/types.ts";

const routeRoots: string[] = [];
const savedEnv = {
  [SUBAGENT_CHILD_ENV]: process.env[SUBAGENT_CHILD_ENV],
  [SUBAGENT_PARENT_EVENT_SINK_ENV]: process.env[SUBAGENT_PARENT_EVENT_SINK_ENV],
  [SUBAGENT_PARENT_CONTROL_INBOX_ENV]: process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV],
  [SUBAGENT_PARENT_ROOT_RUN_ID_ENV]: process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV],
  [SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]: process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV],
  [SUBAGENT_PARENT_RUN_ID_ENV]: process.env[SUBAGENT_PARENT_RUN_ID_ENV],
  [SUBAGENT_PARENT_CHILD_INDEX_ENV]: process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV],
};

afterEach(() => {
  for (const root of routeRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function createState(): SubagentState {
  return {
    baseCwd: "",
    currentSessionId: null,
    asyncJobs: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: { schedule: () => false, clear: () => {} },
  };
}

function createExecutor(
  state = createState(),
  agents: Array<Record<string, unknown>> = [],
  events: any = {
    emit() {},
    on() {
      return () => {};
    },
  },
  options: {
    discoverAgents?: (...args: any[]) => {
      agents: any[];
      modelScope?: any;
    };
    executeAsyncSingle?: (...args: any[]) => any;
  } = {},
) {
  return createSubagentExecutor({
    pi: {
      events,
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
    discoverAgents: options.discoverAgents ?? (() => ({ agents: agents as any })),
    executeAsyncSingle: options.executeAsyncSingle,
  });
}

function ctx(root: string, sessionFile: string | null = null) {
  return {
    cwd: root,
    hasUI: false,
    sessionManager: {
      getSessionId() {
        return "session";
      },
      getSessionFile() {
        return sessionFile;
      },
    },
    modelRegistry: {
      getAvailable() {
        return [];
      },
    },
  } as any;
}

function createNestedRun(
  id = "nested-live",
  state: "running" | "complete" | "failed" | "paused" = "running",
  extras: Record<string, unknown> = {},
) {
  const route = createNestedRoute("root-control");
  routeRoots.push(path.dirname(route.eventSink));
  writeNestedEvent(route, {
    type: state === "running" ? "subagent.nested.updated" : "subagent.nested.completed",
    ts: 100,
    parentRunId: "root-control",
    parentStepIndex: 0,
    child: {
      id,
      parentRunId: "root-control",
      parentStepIndex: 0,
      depth: 1,
      path: [{ runId: "root-control", stepIndex: 0 }],
      state,
      agent: "worker",
      ownerState: state === "running" ? "live" : "gone",
      ...extras,
    },
  });
  return route;
}

function stateWithNestedRoute(route: ReturnType<typeof createNestedRoute>): SubagentState {
  const state = createState();
  state.asyncJobs.set(route.rootRunId, {
    asyncId: route.rootRunId,
    asyncDir: path.join(TEMP_ROOT_DIR, "nested-subagent-runs", route.rootRunId),
    status: "running",
    mode: "single",
    nestedRoute: route,
  });
  return state;
}

function setNestedRouteEnv(
  route: ReturnType<typeof createNestedRoute>,
  parentRunId = route.rootRunId,
) {
  process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = route.eventSink;
  process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = route.controlInbox;
  process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = route.rootRunId;
  process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = route.capabilityToken;
  process.env[SUBAGENT_PARENT_RUN_ID_ENV] = parentRunId;
  process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "0";
}

function text(result: Awaited<ReturnType<ReturnType<typeof createExecutor>["execute"]>>): string {
  return result.content[0]?.type === "text" ? result.content[0].text : "";
}

const DISPOSABLE_CHILD_READY_TIMEOUT_MS = 2_000;
const DISPOSABLE_CHILD_SHUTDOWN_TIMEOUT_MS = 2_000;

function waitForDisposableChildReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(readinessTimeout);
      child.stdout?.off("data", onReady);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onReady = () => finish();
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(
        new Error(
          `disposable interrupt target exited before ready (code=${code}, signal=${signal})`,
        ),
      );
    const onClose = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(
        new Error(
          `disposable interrupt target closed before ready (code=${code}, signal=${signal})`,
        ),
      );
    const readinessTimeout = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Cleanup is retried by stopDisposableChild in the test finally block.
      }
      finish(
        new Error(
          `disposable interrupt target did not become ready within ${DISPOSABLE_CHILD_READY_TIMEOUT_MS}ms`,
        ),
      );
    }, DISPOSABLE_CHILD_READY_TIMEOUT_MS);
    child.stdout?.once("data", onReady);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

async function stopDisposableChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKillTimeout);
      child.off("close", onClose);
      resolve();
    };
    const onClose = () => finish();
    const forceKillTimeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may have exited between the timeout and the force-kill attempt.
      }
      finish();
    }, DISPOSABLE_CHILD_SHUTDOWN_TIMEOUT_MS);
    child.once("close", onClose);
    try {
      if (!child.kill("SIGTERM")) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The child may have exited between the two kill attempts.
        }
        finish();
      }
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may have exited before cleanup began.
      }
      finish();
    }
  });
}

describe("nested run control behavior", () => {
  it("preserves fallback history when restoring a nested child selection", () => {
    const original = { provider: "openai", model: "gpt-5" };
    const effective = { provider: "anthropic", model: "claude-sonnet-4", thinking: "high" };
    const resolution = buildResumeModelResolution(
      {
        kind: "revive",
        source: "nested",
        modelIdentity: effective,
        modelResolution: {
          kind: "fallback",
          original,
          resumed: effective,
          reason: "primary quota; fallback selected",
        },
      } as any,
      undefined,
    );
    assert.equal(resolution?.kind, "fallback");
    assert.deepEqual(resolution?.original, original);
    assert.deepEqual(resolution?.resumed, effective);
    assert.match(resolution?.reason ?? "", /primary quota; fallback selected/);
    assert.match(resolution?.reason ?? "", /Restored persisted child selection/);
  });

  it("labels fallback-history explicit overrides against the persisted effective identity", () => {
    const original = { provider: "openai", model: "gpt-5" };
    const effective = { provider: "anthropic", model: "claude-sonnet-4", thinking: "high" };
    const resolution = buildResumeModelResolution(
      {
        kind: "revive",
        source: "nested",
        modelIdentity: effective,
        modelResolution: {
          kind: "fallback",
          original,
          resumed: effective,
          reason: "primary quota; fallback selected",
        },
      } as any,
      "openai/gpt-5-mini",
    );
    assert.equal(resolution?.kind, "override");
    assert.deepEqual(resolution?.original, effective);
    assert.match(resolution?.reason ?? "", /primary quota; fallback selected/);
    assert.match(
      resolution?.reason ?? "",
      /explicitly overrode persisted selection anthropic\/claude-sonnet-4:high/,
    );
  });

  it("interrupts a live nested async run through the direct control fallback", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-control-"));
    const runId = "nested-live";
    const nestedAsyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "root-control", runId);
    const child = spawn(
      process.execPath,
      [
        "-e",
        [
          "const signal = process.platform === 'win32' ? 'SIGBREAK' : 'SIGUSR2';",
          "process.on(signal, () => {});",
          "process.stdout.write('ready\\n');",
          "setInterval(() => {}, 1000);",
        ].join(" "),
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      await waitForDisposableChildReady(child);
      const childPid = child.pid;
      if (!childPid) throw new Error("expected disposable interrupt target pid");
      fs.mkdirSync(nestedAsyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(nestedAsyncDir, "status.json"),
        JSON.stringify({
          runId,
          mode: "single",
          state: "running",
          pid: childPid,
          cwd: root,
          startedAt: 100,
          lastUpdate: Date.now(),
          steps: [{ agent: "worker", status: "running", startedAt: 100 }],
        }),
        "utf-8",
      );
      const route = createNestedRun(runId, "running", { asyncDir: nestedAsyncDir });
      const executor = createExecutor(stateWithNestedRoute(route));

      const result = await executor.execute(
        "interrupt",
        { action: "interrupt", id: runId },
        new AbortController().signal,
        undefined,
        ctx(root),
      );

      assert.equal(result.isError, undefined, text(result));
      assert.match(text(result), /Interrupt requested for nested async run/);
      assert.equal(fs.readdirSync(route.controlInbox).length, 0);
      assert.equal(fs.existsSync(path.join(nestedAsyncDir, "control", "interrupt.json")), true);
    } finally {
      await stopDisposableChild(child);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(nestedAsyncDir, { recursive: true, force: true });
    }
  });

  it("fails closed when a nested run has no live async interrupt target", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-no-async-"));
    try {
      const route = createNestedRun("nested-no-async");
      const executor = createExecutor(stateWithNestedRoute(route));

      const result = await executor.execute(
        "interrupt",
        { action: "interrupt", id: "nested-no-async" },
        new AbortController().signal,
        undefined,
        ctx(root),
      );

      assert.equal(result.isError, true);
      assert.match(text(result), /no live async target/);
      assert.equal(fs.readdirSync(route.controlInbox).length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes steer to an explicit nested id through the steer-request path", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-steer-"));
    const runId = "nested-live-steer";
    const nestedAsyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "root-control", runId);
    const nestedResultFile = path.join(RESULTS_DIR, "nested", "root-control", `${runId}.json`);
    try {
      fs.rmSync(nestedResultFile, { force: true });
      fs.mkdirSync(nestedAsyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(nestedAsyncDir, "status.json"),
        JSON.stringify(
          {
            runId,
            mode: "single",
            state: "running",
            pid: process.pid,
            cwd: root,
            startedAt: 100,
            lastUpdate: Date.now(),
            steps: [{ agent: "worker", status: "running", startedAt: 100 }],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const route = createNestedRun(runId, "running", { asyncDir: nestedAsyncDir });
      const executor = createExecutor(stateWithNestedRoute(route));

      const result = await executor.execute(
        "steer",
        { action: "steer", id: runId, message: "adjust focus" },
        new AbortController().signal,
        undefined,
        ctx(root),
      );
      assert.equal(result.isError, undefined, `unexpected error: ${text(result)}`);
      assert.match(text(result), /Steering queued/);

      const requests = consumeChildMessageRequests(nestedAsyncDir);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.type, "steer");
      assert.equal(requests[0]?.message, "adjust focus");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(nestedAsyncDir, { recursive: true, force: true });
      fs.rmSync(nestedResultFile, { force: true });
    }
  });

  it("does not let bare interrupt target hidden nested descendants", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-bare-interrupt-"));
    try {
      createNestedRun("nested-only");
      const result = await createExecutor().execute(
        "interrupt",
        { action: "interrupt" },
        new AbortController().signal,
        undefined,
        ctx(root),
      );
      assert.equal(result.isError, true);
      assert.match(text(result), /No interrupt-capable run found/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects live nested resume without a supported live async target", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-live-resume-"));
    try {
      const route = createNestedRun("nested-live-resume", "running");
      const executor = createExecutor(stateWithNestedRoute(route));

      const result = await executor.execute(
        "resume",
        { action: "resume", id: "nested-live-resume", index: 1 },
        new AbortController().signal,
        undefined,
        ctx(root),
      );

      assert.equal(result.isError, true);
      assert.match(text(result), /no supported live nested resume path is available/);
      assert.match(text(result), /with a follow-up message/);
      assert.equal(fs.readdirSync(route.controlInbox).length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates terminal nested resume session files before revive", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-terminal-resume-"));
    try {
      const route = createNestedRun("nested-terminal-resume", "complete", {
        sessionFile: path.join(root, "missing-session.jsonl"),
      });

      const result = await createExecutor(stateWithNestedRoute(route), [
        { name: "worker", description: "Worker", prompt: "Do work" },
      ]).execute(
        "resume",
        { action: "resume", id: "nested-terminal-resume", message: "continue" },
        new AbortController().signal,
        undefined,
        ctx(root),
      );

      assert.equal(result.isError, true);
      assert.match(text(result), /session file does not exist/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not trust forged cwd metadata for ordinary nested revival", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-forged-cwd-"));
    const forgedCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-forged-cwd-target-"));
    const runId = "nested-forged-cwd";
    const nestedAsyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "root-control", runId);
    try {
      const parentSessionFile = path.join(root, "parent.jsonl");
      const sessionFile = path.join(root, "parent", runId, "run-0", "session.jsonl");
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(parentSessionFile, "");
      fs.writeFileSync(sessionFile, "");
      fs.mkdirSync(nestedAsyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(nestedAsyncDir, "status.json"),
        JSON.stringify({
          runId,
          mode: "single",
          state: "complete",
          startedAt: 100,
          cwd: forgedCwd,
          steps: [
            {
              agent: "worker",
              status: "complete",
              cwd: forgedCwd,
              sessionFile,
            },
          ],
        }),
        "utf-8",
      );
      const route = createNestedRun(runId, "complete", {
        asyncDir: nestedAsyncDir,
        sessionFile,
        cwd: forgedCwd,
      });
      let discoveredCwd: string | undefined;
      let startedCwd: string | undefined;
      const result = await createExecutor(stateWithNestedRoute(route), [], undefined, {
        discoverAgents: (cwd) => {
          discoveredCwd = cwd;
          return { agents: [{ name: "worker", description: "Worker", prompt: "Do work" }] };
        },
        executeAsyncSingle: (_id, params) => {
          startedCwd = params.cwd;
          return {
            content: [{ type: "text", text: "revived ordinary nested run" }],
            details: { asyncId: _id, results: [] },
          };
        },
      }).execute(
        "resume-forged-cwd",
        { action: "resume", id: runId, message: "Continue ordinary nested work." },
        new AbortController().signal,
        undefined,
        ctx(root, parentSessionFile),
      );

      const trustedCwd = fs.realpathSync(path.dirname(nestedAsyncDir));
      assert.equal(result.isError, undefined, text(result));
      assert.equal(discoveredCwd, trustedCwd);
      assert.equal(startedCwd, trustedCwd);
      assert.notEqual(discoveredCwd, forgedCwd);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(forgedCwd, { recursive: true, force: true });
      fs.rmSync(nestedAsyncDir, { recursive: true, force: true });
    }
  });

  it("resets terminal successful nested resume runtime before continuation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-terminal-runtime-"));
    const runId = "nested-terminal-runtime";
    const nestedAsyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "root-control", runId);
    try {
      const parentSessionFile = path.join(root, "parent.jsonl");
      const sessionFile = path.join(root, "parent", runId, "run-0", "session.jsonl");
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(parentSessionFile, "");
      fs.writeFileSync(sessionFile, "");
      fs.mkdirSync(nestedAsyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(nestedAsyncDir, "status.json"),
        JSON.stringify({
          runId,
          mode: "single",
          state: "complete",
          startedAt: 100,
          steps: [{ agent: "worker", status: "complete", sessionFile }],
        }),
        "utf-8",
      );
      const route = createNestedRun(runId, "complete", { asyncDir: nestedAsyncDir, sessionFile });

      const result = await createExecutor(stateWithNestedRoute(route), [
        { name: "worker", description: "Worker", prompt: "Do work", maxExecutionTimeMs: 100 },
      ]).execute(
        "resume",
        { action: "resume", id: runId, message: "continue" },
        new AbortController().signal,
        undefined,
        ctx(root, parentSessionFile),
      );

      assert.equal(result.isError, undefined, text(result));
      assert.equal(result.details?.timeoutMs, 100);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(nestedAsyncDir, { recursive: true, force: true });
    }
  });

  it("blocks unsafe nested durable resume without spawning or mutating durable bytes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-context-gate-"));
    const runId = "nested-context-gate";
    const nestedAsyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "root-control", runId);
    try {
      const parentSessionFile = path.join(root, "parent.jsonl");
      const sessionFile = path.join(root, "parent", runId, "run-0", "session.jsonl");
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(parentSessionFile, "");
      fs.writeFileSync(sessionFile, '{"type":"session","id":"nested-context-gate"}\n');
      fs.mkdirSync(nestedAsyncDir, { recursive: true });
      const statusPath = path.join(nestedAsyncDir, "status.json");
      fs.writeFileSync(
        statusPath,
        JSON.stringify({
          runId,
          mode: "single",
          state: "complete",
          startedAt: 100,
          steps: [
            {
              agent: "worker",
              status: "complete",
              sessionFile,
              contextUsage: { contextTokens: 800, contextWindow: 1000, peakTokens: 800 },
            },
          ],
        }),
        "utf-8",
      );
      const beforeStatus = fs.readFileSync(statusPath);
      const beforeSession = fs.readFileSync(sessionFile);
      const route = createNestedRun(runId, "complete", { asyncDir: nestedAsyncDir, sessionFile });

      const result = await createExecutor(stateWithNestedRoute(route), [
        { name: "worker", description: "Worker", prompt: "Do work" },
      ]).execute(
        "nested-context-gate-resume",
        { action: "resume", id: runId, message: "Continue." },
        new AbortController().signal,
        undefined,
        ctx(root, parentSessionFile),
      );

      assert.equal(result.isError, true);
      assert.match(text(result), /used tokens 800/);
      assert.match(text(result), /80\.00%/);
      assert.match(text(result), /fresh narrowly scoped child/);
      assert.deepEqual(fs.readFileSync(statusPath), beforeStatus);
      assert.deepEqual(fs.readFileSync(sessionFile), beforeSession);
      const afterStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as any;
      assert.equal(afterStatus.lifecycle, undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(nestedAsyncDir, { recursive: true, force: true });
    }
  });

  it("omits malformed nested resume model metadata without blocking recovery", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-model-boundary-"));
    const runId = "nested-model-boundary";
    const nestedAsyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "root-control", runId);
    try {
      const parentSessionFile = path.join(root, "parent.jsonl");
      const sessionFile = path.join(root, "parent", runId, "run-0", "session.jsonl");
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(parentSessionFile, "");
      fs.writeFileSync(sessionFile, "");
      fs.mkdirSync(nestedAsyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(nestedAsyncDir, "status.json"),
        JSON.stringify({
          runId,
          mode: "single",
          state: "complete",
          startedAt: 100,
          steps: [
            {
              agent: "worker",
              status: "complete",
              sessionFile,
              model: "legacy/model",
              modelIdentity: { provider: "", model: "discarded" },
              modelResolution: {
                kind: "fallback",
                original: { provider: "openai", model: "gpt-5" },
                resumed: { provider: "", model: "discarded" },
                reason: "discarded",
              },
              contextUsage: { contextTokens: "discarded" },
            },
          ],
        }),
        "utf-8",
      );
      const route = createNestedRun(runId, "complete", { asyncDir: nestedAsyncDir, sessionFile });
      const result = await createExecutor(stateWithNestedRoute(route), [
        { name: "worker", description: "Worker", prompt: "Do work" },
      ]).execute(
        "resume",
        { action: "resume", id: runId, message: "continue" },
        new AbortController().signal,
        undefined,
        ctx(root, parentSessionFile),
      );
      assert.equal(result.isError, undefined, text(result));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(nestedAsyncDir, { recursive: true, force: true });
    }
  });

  it("rejects terminal nested resume session files outside trusted roots", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-terminal-untrusted-"));
    try {
      const parentSessionFile = path.join(root, "parent.jsonl");
      const attackerSessionFile = path.join(root, "outside", "session.jsonl");
      fs.mkdirSync(path.dirname(attackerSessionFile), { recursive: true });
      fs.writeFileSync(parentSessionFile, "");
      fs.writeFileSync(attackerSessionFile, "");
      const route = createNestedRun("nested-untrusted-resume", "complete", {
        sessionFile: attackerSessionFile,
      });

      const result = await createExecutor(stateWithNestedRoute(route), [
        { name: "worker", description: "Worker", prompt: "Do work" },
      ]).execute(
        "resume",
        { action: "resume", id: "nested-untrusted-resume", message: "continue" },
        new AbortController().signal,
        undefined,
        ctx(root, parentSessionFile),
      );

      assert.equal(result.isError, true);
      assert.match(text(result), /outside trusted nested session roots/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects terminal nested resume session files from sibling run directories", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-terminal-sibling-"));
    try {
      const parentSessionFile = path.join(root, "parent.jsonl");
      const siblingSessionFile = path.join(root, "parent", "other-run", "run-0", "session.jsonl");
      fs.mkdirSync(path.dirname(siblingSessionFile), { recursive: true });
      fs.writeFileSync(parentSessionFile, "");
      fs.writeFileSync(siblingSessionFile, "");
      const route = createNestedRun("nested-sibling-resume", "complete", {
        sessionFile: siblingSessionFile,
      });

      const result = await createExecutor(stateWithNestedRoute(route), [
        { name: "worker", description: "Worker", prompt: "Do work" },
      ]).execute(
        "resume",
        { action: "resume", id: "nested-sibling-resume", message: "continue" },
        new AbortController().signal,
        undefined,
        ctx(root, parentSessionFile),
      );

      assert.equal(result.isError, true);
      assert.match(text(result), /not under that nested run's session directory/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not emit a synthetic nested lifecycle when awaited execution throws before runner start", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-awaited-throw-"));
    try {
      const route = createNestedRoute("root-parent");
      routeRoots.push(path.dirname(route.eventSink));
      setNestedRouteEnv(route, "root-parent");
      const throwingCtx = {
        ...ctx(root),
        modelRegistry: {
          getAvailable() {
            throw new Error("model registry exploded");
          },
        },
      };

      const result = await createExecutor(createState(), [
        { name: "worker", description: "Worker", prompt: "Do work" },
      ]).execute(
        "run",
        { agent: "worker", task: "go" },
        new AbortController().signal,
        undefined,
        throwingCtx,
      );

      assert.equal(result.isError, true);
      assert.match(text(result), /model registry exploded/);
      const registry = projectNestedEvents(route);
      assert.equal(registry.children.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

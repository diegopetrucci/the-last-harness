import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { MAX_GROUPED_ENTRIES } from "../../src/runs/background/notify.ts";
import {
  createProjectAgentRunCapture,
  getProjectAgentSnapshotProvenance,
  lookupProjectAgentRunReference,
  registerProjectAgentSnapshot,
  releaseProjectAgentRunReference,
  revokeProjectAgentSnapshot,
  resolveProjectAgentSnapshot,
  retainProjectAgentRunReference,
  retainProjectAgentSnapshotReference,
  releaseProjectAgentSnapshotReference,
} from "../../src/agents/project-agent-snapshot.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, type SubagentState } from "../../src/shared/types.ts";
import { getCompletionDelivery } from "../../src/runs/background/completion-dedupe.ts";

/**
 * In tests that do not register notify.ts, acknowledgeDelivery is never called
 * by a real handler, so result files would not be unlinked.  Call it immediately
 * from the test pi's emit so that file-lifecycle assertions still hold.
 */
function ackOnComplete(data: unknown): void {
  getCompletionDelivery(data)?.acknowledgeDelivery();
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

function createState(): SubagentState {
  return {
    baseCwd: "/repo",
    currentSessionId: null,
    asyncJobs: new Map(),
    foregroundControls: new Map(),
    lastForegroundControlId: null,
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

describe("result watcher", () => {
  it("keeps a project generation while a continued child still has a paused sibling", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-project-")),
    );
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-project-results-"));
    const asyncDir = path.join(root, "async-run");
    const runId = `project-watcher-${Date.now().toString(36)}`;
    const agent = {
      name: "embedded.worker",
      packageName: "embedded",
      description: "Project worker",
      systemPrompt: "Project worker prompt",
      systemPromptMode: "replace" as const,
      inheritProjectContext: false,
      inheritSkills: false,
      source: "project" as const,
      filePath: path.join(root, ".tlh", "agents", "worker.md"),
    };
    const capability = registerProjectAgentSnapshot({
      projectRoot: root,
      sessionId: "watcher-session",
      generationId: "watcher-generation",
      entries: [{ agent, digest: "watcher-digest", frontmatterFields: [] }],
    });
    const capture = createProjectAgentRunCapture(
      resolveProjectAgentSnapshot(capability, getProjectAgentSnapshotProvenance(capability)),
      agent,
    );
    retainProjectAgentRunReference(capability, runId, [capture]);
    fs.mkdirSync(asyncDir, { recursive: true });
    const siblingSession = path.join(asyncDir, "sibling.jsonl");
    fs.writeFileSync(siblingSession, "", "utf8");
    writeJson(path.join(asyncDir, "status.json"), {
      runId,
      mode: "parallel",
      state: "paused",
      sessionId: "watcher-session",
      cwd: root,
      steps: [
        { agent: capture.provenance.agent, status: "continued", projectAgent: capture },
        { agent: "ordinary", status: "paused", sessionFile: siblingSession },
      ],
    });
    const emitted: unknown[] = [];
    const watcher = createResultWatcher(
      {
        events: {
          on: () => () => {},
          emit: (_event, data) => {
            emitted.push(data);
            // Simulate delivery so project-reference management runs in the ack path.
            ackOnComplete(data);
          },
        },
      },
      Object.assign(createState(), { currentSessionId: "watcher-session" }),
      resultsDir,
      60_000,
    );
    const resultPath = path.join(resultsDir, `${runId}.json`);
    fs.writeFileSync(
      resultPath,
      JSON.stringify({
        id: runId,
        runId,
        state: "continued",
        success: false,
        summary: "continued child",
        asyncDir,
        sessionId: "watcher-session",
        results: [{ agent: capture.provenance.agent, output: "continued", success: false }],
      }),
      "utf8",
    );
    try {
      watcher.primeExistingResults();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(emitted.length, 1);
      assert.equal(lookupProjectAgentRunReference(runId).status, "found");

      writeJson(path.join(asyncDir, "status.json"), {
        runId,
        mode: "parallel",
        state: "continued",
        sessionId: "watcher-session",
        cwd: root,
        steps: [
          { agent: capture.provenance.agent, status: "continued", projectAgent: capture },
          { agent: "ordinary", status: "continued", sessionFile: siblingSession },
        ],
      });
      const finalResultPath = path.join(resultsDir, "final.json");
      fs.writeFileSync(
        finalResultPath,
        JSON.stringify({
          id: `${runId}-final`,
          runId,
          state: "continued",
          success: false,
          summary: "all children continued",
          asyncDir,
          sessionId: "watcher-session",
          results: [{ agent: capture.provenance.agent, output: "continued", success: false }],
        }),
        "utf8",
      );
      watcher.primeExistingResults();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(lookupProjectAgentRunReference(runId).status, "missing");
    } finally {
      watcher.stopResultWatcher();
      releaseProjectAgentRunReference(runId);
      try {
        revokeProjectAgentSnapshot(capability);
      } catch {
        // Releasing the run may already collect the unreferenced generation.
      }
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("retains continued/cancelled results for terminal project siblings with usable sessions", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-terminal-sibling-")),
    );
    const resultsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-result-watcher-terminal-results-"),
    );
    const firstAgent = {
      name: "embedded.worker",
      packageName: "embedded",
      description: "Selected project worker",
      systemPrompt: "Selected project prompt",
      systemPromptMode: "replace" as const,
      inheritProjectContext: false,
      inheritSkills: false,
      source: "project" as const,
      filePath: path.join(root, ".tlh", "agents", "worker.md"),
    };
    const siblingAgent = {
      ...firstAgent,
      name: "embedded.reviewer",
      description: "Terminal project reviewer",
      systemPrompt: "Terminal reviewer prompt",
      filePath: path.join(root, ".tlh", "agents", "reviewer.md"),
    };
    const capability = registerProjectAgentSnapshot({
      projectRoot: root,
      sessionId: "watcher-terminal-session",
      generationId: "watcher-terminal-generation",
      entries: [
        { agent: firstAgent, digest: "watcher-worker-digest", frontmatterFields: [] },
        { agent: siblingAgent, digest: "watcher-reviewer-digest", frontmatterFields: [] },
      ],
    });
    const manifest = resolveProjectAgentSnapshot(
      capability,
      getProjectAgentSnapshotProvenance(capability),
    );
    const captures = [
      createProjectAgentRunCapture(manifest, firstAgent),
      createProjectAgentRunCapture(manifest, siblingAgent),
    ];
    retainProjectAgentSnapshotReference(capability, "watcher-terminal-sibling-owner");
    const state = Object.assign(createState(), {
      currentSessionId: "watcher-terminal-session",
    });
    const emitted: unknown[] = [];
    const watcher = createResultWatcher(
      {
        events: {
          on: () => () => {},
          emit: (_event, data) => {
            emitted.push(data);
            // Simulate delivery so project-reference management runs in the ack path.
            ackOnComplete(data);
          },
        },
      },
      state,
      resultsDir,
      60_000,
      { projectAgentTerminalRetentionMs: 100 },
    );
    const runIds: string[] = [];
    try {
      for (const terminalState of ["continued", "cancelled"] as const) {
        for (const siblingState of ["complete", "failed"] as const) {
          const runId = `watcher-terminal-sibling-${terminalState}-${siblingState}-${Date.now().toString(36)}`;
          runIds.push(runId);
          const asyncDir = path.join(root, runId);
          const selectedSession = path.join(asyncDir, "worker.jsonl");
          const siblingSession = path.join(asyncDir, "reviewer.jsonl");
          fs.mkdirSync(asyncDir, { recursive: true });
          fs.writeFileSync(selectedSession, "", "utf8");
          fs.writeFileSync(siblingSession, "", "utf8");
          writeJson(path.join(asyncDir, "status.json"), {
            runId,
            mode: "parallel",
            state: terminalState,
            sessionId: "watcher-terminal-session",
            cwd: root,
            startedAt: Date.now(),
            lastUpdate: Date.now(),
            steps: [
              {
                agent: captures[0].provenance.agent,
                status: terminalState,
                sessionFile: selectedSession,
                projectAgent: captures[0],
              },
              {
                agent: captures[1].provenance.agent,
                status: siblingState,
                sessionFile: siblingSession,
                projectAgent: captures[1],
              },
            ],
          });
          retainProjectAgentRunReference(capability, runId, captures);
          fs.writeFileSync(
            path.join(resultsDir, `${runId}.json`),
            JSON.stringify({
              id: runId,
              runId,
              state: terminalState,
              success: false,
              summary: `${terminalState} selected child`,
              asyncDir,
              sessionId: "watcher-terminal-session",
              cwd: root,
              results: [
                {
                  agent: captures[0].provenance.agent,
                  output: `${terminalState} selected child`,
                  success: false,
                },
              ],
            }),
            "utf8",
          );
          watcher.primeExistingResults();
          for (let attempt = 0; attempt < 30; attempt++) {
            if (emitted.length >= runIds.length) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.equal(emitted.length, runIds.length);
          await new Promise((resolve) => setTimeout(resolve, 25));
          assert.equal(lookupProjectAgentRunReference(runId).status, "found");
          await new Promise((resolve) => setTimeout(resolve, 110));
          assert.equal(lookupProjectAgentRunReference(runId).status, "missing");
        }
      }
    } finally {
      watcher.stopResultWatcher();
      for (const runId of runIds) releaseProjectAgentRunReference(runId);
      releaseProjectAgentSnapshotReference("watcher-terminal-sibling-owner");
      try {
        revokeProjectAgentSnapshot(capability);
      } catch {
        // Releasing the owner may already collect the unreferenced generation.
      }
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("processes deferred session-scoped results after session identity is restored", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-session-"));
    try {
      const emitted: Array<{ event: string; data: unknown }> = [];
      const pi = {
        events: {
          on: () => () => {},
          emit(event: string, data: unknown) {
            emitted.push({ event, data });
            if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) ackOnComplete(data);
          },
        },
      };
      const state = createState();
      const resultPath = path.join(resultsDir, "session-run.json");
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          id: "session-run",
          sessionId: "session-current",
          success: true,
          summary: "done",
        }),
        "utf-8",
      );

      const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
      try {
        watcher.primeExistingResults();
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(emitted.length, 0);
        assert.equal(fs.existsSync(resultPath), true);

        state.currentSessionId = "session-current";
        watcher.primeExistingResults();
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        watcher.stopResultWatcher();
      }

      assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);
      assert.equal(fs.existsSync(resultPath), false);
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("ignores result files with neither sessionId nor cwd (issue #45 defense in depth)", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-foreign-"));
    try {
      const emitted: Array<{ event: string; data: unknown }> = [];
      const pi = {
        events: {
          on: () => () => {},
          emit(event: string, data: unknown) {
            emitted.push({ event, data });
          },
        },
      };
      const state = createState();
      const resultPath = path.join(resultsDir, "foreign-run.json");
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          id: "foreign-run",
          success: true,
          summary: "done",
        }),
        "utf-8",
      );

      const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
      try {
        watcher.primeExistingResults();
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        watcher.stopResultWatcher();
      }

      assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 0);
      assert.equal(
        fs.existsSync(resultPath),
        true,
        "foreign result file without sessionId or cwd should not be unlinked",
      );
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("delivers result files only to the exact owning session when another watcher shares the same repo", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-scope-"));
    const createPi = () => {
      const emitted: Array<{ event: string; data: unknown }> = [];
      const listeners = new Map<string, Set<(payload: unknown) => void>>();
      const pi = {
        events: {
          on(event: string, handler: (payload: unknown) => void) {
            const eventListeners = listeners.get(event) ?? new Set();
            eventListeners.add(handler);
            listeners.set(event, eventListeners);
            return () => eventListeners.delete(handler);
          },
          emit(event: string, data: unknown) {
            emitted.push({ event, data });
            for (const handler of listeners.get(event) ?? []) handler(data);
            if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) ackOnComplete(data);
          },
        },
      };
      return { pi, emitted };
    };
    try {
      const owner = createPi();
      const other = createPi();
      const ownerState = createState();
      ownerState.currentSessionId = "session-owner";
      const otherState = createState();
      otherState.currentSessionId = "session-other";
      const ownerWatcher = createResultWatcher(owner.pi, ownerState, resultsDir, 60_000);
      const otherWatcher = createResultWatcher(other.pi, otherState, resultsDir, 60_000);
      const ownerResultPath = path.join(resultsDir, "owner-run.json");
      const sessionlessResultPath = path.join(resultsDir, "sessionless-run.json");
      try {
        fs.writeFileSync(
          ownerResultPath,
          JSON.stringify({
            id: "owner-run",
            agent: "worker",
            mode: "single",
            success: true,
            state: "complete",
            summary: "owner output",
            results: [{ agent: "worker", output: "owner output", success: true }],
            sessionId: "session-owner",
            cwd: "/repo",
          }),
          "utf-8",
        );
        fs.writeFileSync(
          sessionlessResultPath,
          JSON.stringify({
            id: "sessionless-run",
            agent: "worker",
            mode: "single",
            success: true,
            state: "complete",
            summary: "sessionless output",
            results: [{ agent: "worker", output: "sessionless output", success: true }],
            cwd: "/repo",
          }),
          "utf-8",
        );

        otherWatcher.primeExistingResults();
        await new Promise((resolve) => setTimeout(resolve, 100));
        ownerWatcher.primeExistingResults();
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        ownerWatcher.stopResultWatcher();
        otherWatcher.stopResultWatcher();
      }

      const ownerCompletions = owner.emitted.filter(
        (entry) => entry.event === "subagent:async-complete",
      );
      assert.equal(ownerCompletions.length, 1);
      assert.equal((ownerCompletions[0]?.data as { id?: string } | undefined)?.id, "owner-run");
      assert.equal(
        other.emitted.some((entry) => entry.event === "subagent:async-complete"),
        false,
      );
      assert.equal(fs.existsSync(ownerResultPath), false);
      assert.equal(fs.existsSync(sessionlessResultPath), true);
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("logs malformed result files instead of swallowing them silently", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
    try {
      fs.writeFileSync(path.join(resultsDir, "bad.json"), "{bad-json", "utf-8");
      const emitted: unknown[] = [];
      const pi = {
        events: {
          on: () => () => {},
          emit(_event: string, data: unknown) {
            emitted.push(data);
          },
        },
      };
      const state = createState();
      const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
      const originalError = console.error;
      const logged: unknown[][] = [];
      console.error = (...args: unknown[]) => {
        logged.push(args);
      };
      try {
        watcher.primeExistingResults();
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        console.error = originalError;
        watcher.stopResultWatcher();
      }

      assert.equal(emitted.length, 0);
      assert.ok(
        logged.some((entry) =>
          /Failed to process subagent result file/.test(String(entry[0] ?? "")),
        ),
        "expected watcher error to be logged",
      );
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("normalizes the native fs.watch path before watching result files", () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
    try {
      const nativeResultsDir = path.join(
        path.dirname(resultsDir),
        `${path.basename(resultsDir)}-native`,
      );
      const pi = {
        events: {
          on: () => () => {},
          emit() {},
        },
      };
      const state = createState();
      let watchedDir: fs.PathLike | undefined;
      const fakeWatcher = fs.watch(resultsDir);
      const realpathSync = ((target: fs.PathLike, options?: unknown) =>
        fs.realpathSync(target, options as BufferEncoding)) as typeof fs.realpathSync;
      realpathSync.native = ((target: fs.PathLike) =>
        target === resultsDir
          ? nativeResultsDir
          : fs.realpathSync.native(target)) as typeof fs.realpathSync.native;
      const watcher = createResultWatcher(pi, state, resultsDir, 60_000, {
        fs: {
          ...fs,
          realpathSync,
          watch(dir) {
            watchedDir = dir;
            return fakeWatcher;
          },
        },
      });
      try {
        watcher.startResultWatcher();
      } finally {
        watcher.stopResultWatcher();
      }

      assert.equal(watchedDir, nativeResultsDir);
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("falls back to polling when fs.watch throws EMFILE and preserves normalized async completion delivery", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
    try {
      const emitted: Array<{ event: string; data: unknown }> = [];
      const listeners = new Map<string, Set<(payload: unknown) => void>>();
      const pi = {
        events: {
          on(event: string, handler: (payload: unknown) => void) {
            const eventListeners = listeners.get(event) ?? new Set();
            eventListeners.add(handler);
            listeners.set(event, eventListeners);
            return () => eventListeners.delete(handler);
          },
          emit(event: string, data: unknown) {
            emitted.push({ event, data });
            for (const handler of listeners.get(event) ?? []) handler(data);
            if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) ackOnComplete(data);
          },
        },
      };
      const state = createState();
      state.currentSessionId = "session-1";
      let poll: (() => void) | undefined;
      const emfile = new Error("too many open files") as NodeJS.ErrnoException;
      emfile.code = "EMFILE";
      const watcher = createResultWatcher(pi, state, resultsDir, 60_000, {
        fs: {
          ...fs,
          watch: () => {
            throw emfile;
          },
        },
        timers: {
          setTimeout,
          clearTimeout() {},
          setInterval: ((handler: () => void) => {
            poll = handler;
            return { unref() {} } as NodeJS.Timeout;
          }) as typeof setInterval,
          clearInterval() {
            poll = undefined;
          },
        },
      });
      const originalError = console.error;
      const childSessionPath = path.join(resultsDir, "a-session.jsonl");
      console.error = () => {};
      try {
        watcher.startResultWatcher();
        assert.equal(state.watcher, null);
        assert.notEqual(state.watcherRestartTimer, null);

        fs.writeFileSync(childSessionPath, "", "utf-8");
        fs.writeFileSync(
          path.join(resultsDir, "async-fallback.json"),
          JSON.stringify({
            id: "async-fallback",
            runId: "run-fallback",
            agent: "parallel:a+b",
            mode: "parallel",
            success: true,
            state: "complete",
            summary: "Combined summary",
            results: [
              {
                agent: "a",
                output: "Result from a",
                success: true,
                sessionFile: childSessionPath,
              },
              {
                agent: "b",
                output: "Result from b",
                success: false,
                error: "B failed",
              },
            ],
            sessionId: "session-1",
          }),
          "utf-8",
        );
        poll?.();
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        console.error = originalError;
        watcher.stopResultWatcher();
      }
      assert.equal(
        emitted.some((entry) => entry.event === "subagent:async-complete"),
        true,
      );
      assert.equal(fs.existsSync(path.join(resultsDir, "async-fallback.json")), false);
      const completion = emitted.find((entry) => entry.event === "subagent:async-complete")
        ?.data as
        | {
            runId?: string;
            mode?: string;
            results?: Array<{ status?: string; summary?: string; sessionPath?: string }>;
          }
        | undefined;
      assert.equal(completion?.runId, "run-fallback");
      assert.equal(completion?.mode, "parallel");
      assert.equal(completion?.results?.[0]?.sessionPath, childSessionPath);
      assert.equal(completion?.results?.[1]?.status, "failed");
      assert.equal(completion?.results?.[1]?.summary, "B failed\n\nOutput:\nResult from b");
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("falls back to polling when an active fs.watch emits ENOSPC", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
    try {
      const emitted: Array<{ event: string; data: unknown }> = [];
      const pi = {
        events: {
          on: () => () => {},
          emit(event: string, data: unknown) {
            emitted.push({ event, data });
            if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) ackOnComplete(data);
          },
        },
      };
      const state = createState();
      state.currentSessionId = "session-1";
      let poll: (() => void) | undefined;
      let emitWatcherError: ((error: NodeJS.ErrnoException) => void) | undefined;
      const fakeWatcher = {
        on(event: string, handler: (error: NodeJS.ErrnoException) => void) {
          if (event === "error") emitWatcherError = handler;
          return fakeWatcher;
        },
        close() {},
        unref() {},
      } as fs.FSWatcher;
      const watcher = createResultWatcher(pi, state, resultsDir, 60_000, {
        fs: {
          ...fs,
          watch: () => fakeWatcher,
        },
        timers: {
          setTimeout,
          clearTimeout() {},
          setInterval: ((handler: () => void) => {
            poll = handler;
            return { unref() {} } as NodeJS.Timeout;
          }) as typeof setInterval,
          clearInterval() {
            poll = undefined;
          },
        },
      });
      const originalError = console.error;
      console.error = () => {};
      try {
        watcher.startResultWatcher();
        assert.equal(state.watcher, fakeWatcher);
        const enospc = new Error("inotify limit reached") as NodeJS.ErrnoException;
        enospc.code = "ENOSPC";
        emitWatcherError?.(enospc);
        assert.equal(state.watcher, null);
        assert.notEqual(state.watcherRestartTimer, null);

        fs.writeFileSync(
          path.join(resultsDir, "done.json"),
          JSON.stringify({ sessionId: "session-1", summary: "done" }),
          "utf-8",
        );
        poll?.();
        await new Promise((resolve) => setTimeout(resolve, 75));
      } finally {
        console.error = originalError;
        watcher.stopResultWatcher();
      }

      assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);
      assert.equal(fs.existsSync(path.join(resultsDir, "done.json")), false);
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("emits one async completion event with safe child session references", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
    try {
      const emitted: Array<{ event: string; data: unknown }> = [];
      const listeners = new Map<string, Set<(payload: unknown) => void>>();
      const pi = {
        events: {
          on(event: string, handler: (payload: unknown) => void) {
            const eventListeners = listeners.get(event) ?? new Set();
            eventListeners.add(handler);
            listeners.set(event, eventListeners);
            return () => eventListeners.delete(handler);
          },
          emit(event: string, data: unknown) {
            emitted.push({ event, data });
            for (const handler of listeners.get(event) ?? []) handler(data);
          },
        },
      };
      const state = createState();
      state.currentSessionId = "session-1";
      const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
      const firstSession = path.join(resultsDir, "a-session.jsonl");
      const missingSession = path.join(resultsDir, "b-session.jsonl");
      try {
        fs.writeFileSync(firstSession, "", "utf-8");
        fs.writeFileSync(
          path.join(resultsDir, "async-1.json"),
          JSON.stringify({
            id: "async-1",
            runId: "run-123",
            agent: "parallel:a+b",
            mode: "parallel",
            success: true,
            state: "complete",
            summary: "Combined summary",
            results: [
              {
                agent: "a",
                output: "Result from a",
                success: true,
                sessionFile: firstSession,
                artifactPaths: { outputPath: "/tmp/a-output.md" },
              },
              {
                agent: "b",
                output: "Result from b",
                success: false,
                sessionFile: missingSession,
                artifactPaths: { outputPath: "/tmp/b-output.md" },
              },
            ],
            sessionId: "session-1",
            sessionFile: "/tmp/session.jsonl",
            asyncDir: "/tmp/async-1",
          }),
          "utf-8",
        );
        watcher.primeExistingResults();
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        watcher.stopResultWatcher();
      }
      const completion = emitted.find((entry) => entry.event === "subagent:async-complete")
        ?.data as { mode?: string; results?: Array<{ sessionPath?: string }> } | undefined;
      assert.equal(completion?.mode, "parallel");
      assert.equal(completion?.results?.[0]?.sessionPath, firstSession);
      assert.equal(completion?.results?.[1]?.sessionPath, undefined);
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("does not advertise indexed revive from only a top-level async session file", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
    try {
      const emitted: Array<{ event: string; data: unknown }> = [];
      const listeners = new Map<string, Set<(payload: unknown) => void>>();
      const pi = {
        events: {
          emit: (event: string, data: unknown) => {
            emitted.push({ event, data });
            for (const listener of listeners.get(event) ?? []) listener(data);
            return true;
          },
          on: (event: string, listener: (payload: unknown) => void) => {
            const set = listeners.get(event) ?? new Set();
            set.add(listener);
            listeners.set(event, set);
            return () => set.delete(listener);
          },
        },
      };
      const state = createState();
      state.currentSessionId = "session-1";
      const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
      try {
        fs.writeFileSync(
          path.join(resultsDir, "async-top-session.json"),
          JSON.stringify({
            id: "async-top-session",
            mode: "parallel",
            success: false,
            state: "failed",
            results: [
              { agent: "a", output: "A", success: true },
              { agent: "b", output: "B", success: false },
            ],
            sessionId: "session-1",
            sessionFile: "/tmp/top-session.jsonl",
          }),
          "utf-8",
        );
        watcher.primeExistingResults();
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        watcher.stopResultWatcher();
      }

      const completion = emitted.find((entry) => entry.event === "subagent:async-complete")
        ?.data as { results?: Array<{ sessionPath?: string }> } | undefined;
      assert.ok(completion);
      assert.equal(
        completion?.results?.every((child) => child.sessionPath === undefined),
        true,
      );
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("marks grouped async results as paused when the result file is paused", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
    try {
      const emitted: Array<{ event: string; data: unknown }> = [];
      const listeners = new Map<string, Set<(payload: unknown) => void>>();
      const pi = {
        events: {
          on(event: string, handler: (payload: unknown) => void) {
            const eventListeners = listeners.get(event) ?? new Set();
            eventListeners.add(handler);
            listeners.set(event, eventListeners);
            return () => eventListeners.delete(handler);
          },
          emit(event: string, data: unknown) {
            emitted.push({ event, data });
            for (const handler of listeners.get(event) ?? []) handler(data);
          },
        },
      };
      const state = createState();
      state.currentSessionId = "session-1";
      const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
      try {
        fs.writeFileSync(
          path.join(resultsDir, "async-paused.json"),
          JSON.stringify({
            id: "async-paused",
            runId: "run-paused",
            agent: "a+b",
            mode: "parallel",
            success: false,
            state: "paused",
            summary: "Paused after interrupt. Waiting for explicit next action.",
            results: [
              {
                agent: "a",
                output: "Result from a",
                success: true,
                exitCode: 0,
              },
              {
                agent: "b",
                output: "Paused after interrupt",
                success: false,
                exitCode: 0,
                interrupted: true,
              },
            ],
            sessionId: "session-1",
          }),
          "utf-8",
        );
        watcher.primeExistingResults();
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        watcher.stopResultWatcher();
      }
      const completion = emitted.find((entry) => entry.event === "subagent:async-complete")
        ?.data as
        | { mode?: string; state?: string; results?: Array<{ status?: string; index?: number }> }
        | undefined;
      assert.equal(completion?.mode, "parallel");
      assert.equal(completion?.state, "paused");
      assert.deepEqual(
        completion?.results?.map((child) => ({ status: child.status, index: child.index })),
        [
          { status: "completed", index: 0 },
          { status: "paused", index: 1 },
        ],
      );
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("emits a native async completion for a completed result file", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
    try {
      const emitted: Array<{ event: string; data: unknown }> = [];
      const pi = {
        events: {
          on(_event: string, _handler: (payload: unknown) => void) {
            return () => {};
          },
          emit(event: string, data: unknown) {
            emitted.push({ event, data });
          },
        },
      };
      const state = createState();
      state.currentSessionId = "session-1";
      const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
      try {
        fs.writeFileSync(
          path.join(resultsDir, "async-2.json"),
          JSON.stringify({
            id: "async-2",
            runId: "run-456",
            agent: "worker",
            success: true,
            state: "complete",
            summary: "Worker summary",
            results: [{ agent: "worker", output: "Worker summary" }],
            sessionId: "session-1",
          }),
          "utf-8",
        );
        watcher.primeExistingResults();
        const deadline = Date.now() + 1000;
        while (true) {
          const sawCompletion = emitted.some((entry) => entry.event === "subagent:async-complete");
          if (sawCompletion || Date.now() > deadline) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        watcher.stopResultWatcher();
      }

      const completion = emitted.find((entry) => entry.event === "subagent:async-complete")
        ?.data as { results?: Array<{ status?: string }> } | undefined;
      assert.equal(completion?.results?.[0]?.status, "completed");
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("release-after-ack: project reference is released only after delivery is confirmed", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-release-ack-")),
    );
    const resultsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-result-watcher-release-ack-results-"),
    );
    const agent = {
      name: "embedded.release-worker",
      packageName: "embedded",
      description: "Release worker",
      systemPrompt: "Release worker prompt",
      systemPromptMode: "replace" as const,
      inheritProjectContext: false,
      inheritSkills: false,
      source: "project" as const,
      filePath: path.join(root, ".tlh", "agents", "release-worker.md"),
    };
    const capability = registerProjectAgentSnapshot({
      projectRoot: root,
      sessionId: "watcher-release-session",
      generationId: "watcher-release-generation",
      entries: [{ agent, digest: "release-digest", frontmatterFields: [] }],
    });
    const capture = createProjectAgentRunCapture(
      resolveProjectAgentSnapshot(capability, getProjectAgentSnapshotProvenance(capability)),
      agent,
    );
    const runId = `release-ack-${Date.now().toString(36)}`;
    retainProjectAgentRunReference(capability, runId, [capture]);
    const asyncDir = path.join(root, runId);
    fs.mkdirSync(asyncDir, { recursive: true });
    writeJson(path.join(asyncDir, "status.json"), {
      runId,
      mode: "single",
      state: "complete",
      sessionId: "watcher-release-session",
      cwd: root,
      startedAt: Date.now(),
      lastUpdate: Date.now(),
      steps: [
        {
          agent: capture.provenance.agent,
          status: "complete",
          projectAgent: capture,
        },
      ],
    });
    const emitted: unknown[] = [];
    let capturedAck: (() => void) | undefined;
    const watcher = createResultWatcher(
      {
        events: {
          on: () => () => {},
          emit: (_event, data) => {
            emitted.push(data);
            const deliveryMeta = getCompletionDelivery(data);
            if (deliveryMeta) capturedAck = () => deliveryMeta.acknowledgeDelivery();
          },
        },
      },
      Object.assign(createState(), { currentSessionId: "watcher-release-session" }),
      resultsDir,
      60_000,
      { projectAgentTerminalRetentionMs: 80 },
    );
    writeJson(path.join(resultsDir, `${runId}.json`), {
      id: runId,
      runId,
      state: "complete",
      success: true,
      summary: "release worker done",
      asyncDir,
      sessionId: "watcher-release-session",
      results: [{ agent: capture.provenance.agent, output: "done", success: true }],
    });
    try {
      watcher.primeExistingResults();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(emitted.length, 1, "result emitted");
      // Reference must still be held before ack fires.
      assert.equal(
        lookupProjectAgentRunReference(runId).status,
        "found",
        "reference held before ack",
      );

      // Now fire ack: scheduleProjectReferenceRelease is called with 80 ms.
      capturedAck?.();
      // Immediately after ack: reference still 'found' (timer not yet fired).
      assert.equal(
        lookupProjectAgentRunReference(runId).status,
        "found",
        "reference held right after ack (timer pending)",
      );

      // After 80 ms retention window: reference released.
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(
        lookupProjectAgentRunReference(runId).status,
        "missing",
        "reference released after retention window",
      );
    } finally {
      watcher.stopResultWatcher();
      releaseProjectAgentRunReference(runId);
      try {
        revokeProjectAgentSnapshot(capability);
      } catch {
        // Already released.
      }
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("sweepStaleResultFiles removes undelivered files older than TERMINAL_ASYNC_DIR_MAX_AGE_MS and releases project reference", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-sweep-stale-")),
    );
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-sweep-results-"));
    const agent = {
      name: "embedded.sweep-worker",
      packageName: "embedded",
      description: "Sweep worker",
      systemPrompt: "Sweep prompt",
      systemPromptMode: "replace" as const,
      inheritProjectContext: false,
      inheritSkills: false,
      source: "project" as const,
      filePath: path.join(root, ".tlh", "agents", "sweep-worker.md"),
    };
    const capability = registerProjectAgentSnapshot({
      projectRoot: root,
      sessionId: "sweep-session",
      generationId: "sweep-generation",
      entries: [{ agent, digest: "sweep-digest", frontmatterFields: [] }],
    });
    const capture = createProjectAgentRunCapture(
      resolveProjectAgentSnapshot(capability, getProjectAgentSnapshotProvenance(capability)),
      agent,
    );
    const runId = `sweep-stale-${Date.now().toString(36)}`;
    retainProjectAgentRunReference(capability, runId, [capture]);
    const asyncDir = path.join(root, runId);
    fs.mkdirSync(asyncDir, { recursive: true });
    writeJson(path.join(asyncDir, "status.json"), {
      runId,
      mode: "single",
      state: "complete",
      sessionId: "sweep-session",
      cwd: root,
      startedAt: Date.now(),
      lastUpdate: Date.now(),
      steps: [{ agent: capture.provenance.agent, status: "complete", projectAgent: capture }],
    });
    const outputArtifactPath = path.join(asyncDir, "output.txt");
    fs.writeFileSync(outputArtifactPath, "sweep done", "utf-8");
    const resultPath = path.join(resultsDir, `${runId}.json`);
    writeJson(resultPath, {
      id: runId,
      runId,
      state: "complete",
      success: true,
      summary: "sweep done",
      asyncDir,
      sessionId: "sweep-session",
      results: [
        {
          agent: capture.provenance.agent,
          output: "sweep done",
          success: true,
          artifactPaths: { outputPath: outputArtifactPath },
        },
      ],
    });
    // Use a DIFFERENT currentSessionId so the current-session guard does not
    // protect this file.  The test verifies that stale files from OTHER sessions
    // are swept; the guard only protects the active session's own results.
    const state = Object.assign(createState(), { currentSessionId: "other-active-session" });
    const watcher = createResultWatcher(
      { events: { on: () => () => {}, emit: () => {} } },
      state,
      resultsDir,
      60_000,
      { projectAgentTerminalRetentionMs: 50 },
    );
    try {
      const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;
      const staleDate = new Date(Date.now() - EIGHT_DAYS_MS);
      fs.utimesSync(resultPath, staleDate, staleDate);

      const freshResultPath = path.join(resultsDir, `${runId}-fresh.json`);
      writeJson(freshResultPath, {
        id: `${runId}-fresh`,
        state: "complete",
        success: true,
        summary: "fresh",
        sessionId: "sweep-session",
      });
      watcher.sweepStaleResultFiles();
      assert.equal(fs.existsSync(freshResultPath), true, "non-expired file must be kept");
      assert.equal(
        fs.existsSync(resultPath),
        false,
        "expired undelivered file from a past session must be removed",
      );

      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(
        lookupProjectAgentRunReference(runId).status,
        "missing",
        "project reference must be released after sweep",
      );
    } finally {
      watcher.stopResultWatcher();
      releaseProjectAgentRunReference(runId);
      try {
        revokeProjectAgentSnapshot(capability);
      } catch {
        // may already be released
      }
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("sweepStaleResultFiles does not remove result files within the retention window", () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-sweep-fresh-"));
    try {
      const resultPath = path.join(resultsDir, "fresh.json");
      writeJson(resultPath, {
        id: "fresh-run",
        state: "complete",
        success: true,
        summary: "fresh",
        sessionId: "sweep-fresh-session",
      });
      const state = Object.assign(createState(), { currentSessionId: "sweep-fresh-session" });
      const watcher = createResultWatcher(
        { events: { on: () => () => {}, emit: () => {} } },
        state,
        resultsDir,
        60_000,
      );
      try {
        watcher.sweepStaleResultFiles(Date.now());
        assert.equal(fs.existsSync(resultPath), true, "fresh file must survive the sweep");
      } finally {
        watcher.stopResultWatcher();
      }
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("sweepStaleResultFiles keeps stale file when status.json exists but child has no readable source", () => {
    // G: status.json alone is not enough; file must be kept.
    const resultsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-result-watcher-sweep-status-only-"),
    );
    const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rw-sweep-asyncdir-"));
    try {
      const runId = `status-only-run-${Date.now().toString(36)}`;
      const resultPath = path.join(resultsDir, `${runId}.json`);
      writeJson(path.join(asyncDir, "status.json"), { state: "complete", steps: [] });
      writeJson(resultPath, {
        id: runId,
        state: "complete",
        success: true,
        summary: "no readable child backup",
        sessionId: "sweep-status-session",
        asyncDir,
        results: [{ agent: "worker", output: "done", success: true }],
      });
      const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;
      const staleDate = new Date(Date.now() - EIGHT_DAYS_MS);
      fs.utimesSync(resultPath, staleDate, staleDate);

      const state = Object.assign(createState(), { currentSessionId: "sweep-status-session" });
      const watcher = createResultWatcher(
        { events: { on: () => () => {}, emit: () => {} } },
        state,
        resultsDir,
        60_000,
      );
      try {
        watcher.sweepStaleResultFiles();
        // G: status.json alone is not enough \ file must be kept.
        assert.equal(
          fs.existsSync(resultPath),
          true,
          "stale file must be kept when status.json exists but child has no readable source",
        );
      } finally {
        watcher.stopResultWatcher();
      }
    } finally {
      fs.rmSync(asyncDir, { recursive: true, force: true });
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("sweepStaleResultFiles keeps stale multi-child file when one child has no readable source", () => {
    const resultsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-result-watcher-sweep-multi-child-"),
    );
    const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rw-sweep-multi-child-asyncdir-"));
    try {
      const runId = `multi-child-run-${Date.now().toString(36)}`;
      const resultPath = path.join(resultsDir, `${runId}.json`);
      const child0OutputPath = path.join(asyncDir, "child0-output.txt");
      fs.writeFileSync(child0OutputPath, "child 0 done", "utf-8");
      writeJson(resultPath, {
        id: runId,
        state: "complete",
        success: true,
        summary: "multi done",
        sessionId: "sweep-multi-child-session",
        asyncDir,
        results: [
          {
            agent: "worker-0",
            output: "child 0",
            success: true,
            artifactPaths: { outputPath: child0OutputPath },
          },
          { agent: "worker-1", output: "child 1", success: true },
        ],
      });
      const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;
      const staleDate = new Date(Date.now() - EIGHT_DAYS_MS);
      fs.utimesSync(resultPath, staleDate, staleDate);

      const state = Object.assign(createState(), { currentSessionId: "sweep-multi-child-session" });
      const watcher = createResultWatcher(
        { events: { on: () => () => {}, emit: () => {} } },
        state,
        resultsDir,
        60_000,
      );
      try {
        watcher.sweepStaleResultFiles();
        assert.equal(
          fs.existsSync(resultPath),
          true,
          "stale multi-child file must be kept when one child has no readable source",
        );
      } finally {
        watcher.stopResultWatcher();
      }
    } finally {
      fs.rmSync(asyncDir, { recursive: true, force: true });
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("sweepStaleResultFiles removes stale multi-child file when all children have readable sources", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-sweep-multi-ok-")),
    );
    const resultsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-result-watcher-sweep-multi-ok-results-"),
    );
    const asyncDir = path.join(root, "multi-ok-asyncdir");
    fs.mkdirSync(asyncDir, { recursive: true });
    try {
      const runId = `multi-ok-run-${Date.now().toString(36)}`;
      const resultPath = path.join(resultsDir, `${runId}.json`);
      const child0OutputPath = path.join(asyncDir, "child0-output.txt");
      const child1SessionFile = path.join(asyncDir, "child1-session.jsonl");
      fs.writeFileSync(child0OutputPath, "child 0 done", "utf-8");
      fs.writeFileSync(
        child1SessionFile,
        JSON.stringify({ role: "assistant", content: "done" }),
        "utf-8",
      );
      writeJson(resultPath, {
        id: runId,
        state: "complete",
        success: true,
        summary: "multi ok",
        sessionId: "sweep-multi-ok-session",
        asyncDir,
        results: [
          {
            agent: "worker-0",
            output: "child 0",
            success: true,
            artifactPaths: { outputPath: child0OutputPath },
          },
          { agent: "worker-1", output: "child 1", success: true, sessionFile: child1SessionFile },
        ],
      });
      const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;
      const staleDate = new Date(Date.now() - EIGHT_DAYS_MS);
      fs.utimesSync(resultPath, staleDate, staleDate);

      // Use a different currentSessionId so the current-session guard does not
      // protect this file \ this test verifies sweeping of past-session files.
      const state = Object.assign(createState(), {
        currentSessionId: "other-active-session-multi",
      });
      const watcher = createResultWatcher(
        { events: { on: () => () => {}, emit: () => {} } },
        state,
        resultsDir,
        60_000,
        { projectAgentTerminalRetentionMs: 50 },
      );
      try {
        watcher.sweepStaleResultFiles();
        assert.equal(
          fs.existsSync(resultPath),
          false,
          "stale multi-child file from a past session must be removed when all children have readable sources",
        );
      } finally {
        watcher.stopResultWatcher();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("sweepStaleResultFiles skips files with a pending in-flight ack", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-sweep-pending-"));
    const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rw-sweep-asyncdir-"));
    try {
      const runId = `pending-ack-run-${Date.now().toString(36)}`;
      const resultPath = path.join(resultsDir, `${runId}.json`);
      writeJson(path.join(asyncDir, "status.json"), { state: "complete", steps: [] });
      writeJson(resultPath, {
        id: runId,
        state: "complete",
        success: true,
        summary: "pending",
        sessionId: "sweep-pending-session",
        asyncDir,
        results: [],
      });
      const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;
      const staleDate = new Date(Date.now() - EIGHT_DAYS_MS);
      fs.utimesSync(resultPath, staleDate, staleDate);

      const emitted: unknown[] = [];
      const watcher = createResultWatcher(
        {
          events: {
            on: () => () => {},
            emit: (_event, data) => {
              emitted.push(data);
              // Do NOT call ack \ leave it in-flight
            },
          },
        },
        Object.assign(createState(), { currentSessionId: "sweep-pending-session" }),
        resultsDir,
        60_000,
      );
      try {
        watcher.primeExistingResults();
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        assert.equal(emitted.length, 1, "event emitted");
        // File is stale but ack is in-flight \ sweep must skip it.
        watcher.sweepStaleResultFiles();
        assert.equal(
          fs.existsSync(resultPath),
          true,
          "stale file with pending ack must not be swept",
        );
      } finally {
        watcher.stopResultWatcher();
      }
    } finally {
      fs.rmSync(asyncDir, { recursive: true, force: true });
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("C: stale-sweep replacement-between-check-and-unlink: re-read verifies eventId before unlink", () => {
    // Tests that sweepStaleResultFiles re-reads the eventId before unlinking,
    // preventing destruction of a newly-written file with a different eventId.
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-sweep-replace-"));
    try {
      const runId = `replace-test-${Date.now().toString(36)}`;
      const resultPath = path.join(resultsDir, `${runId}.json`);
      const originalEventId = "original-event-id-abc";
      const replacedEventId = "replaced-event-id-xyz";

      writeJson(resultPath, {
        id: runId,
        state: "complete",
        success: true,
        summary: "original",
        sessionId: "sweep-replace-session",
        eventId: originalEventId,
        results: [],
      });
      const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;
      const staleDate = new Date(Date.now() - EIGHT_DAYS_MS);
      fs.utimesSync(resultPath, staleDate, staleDate);

      // Build an fsProxy that, when readFileSync is called the SECOND time
      // (the re-read for safe-unlink verification), replaces the file content
      // with a new eventId \ simulating a concurrent write.
      let readCount = 0;
      const fsProxy = {
        existsSync: fs.existsSync.bind(fs),
        readFileSync(filePath: fs.PathOrFileDescriptor, encoding: unknown) {
          const result = fs.readFileSync(filePath as fs.PathLike, encoding as BufferEncoding);
          readCount++;
          if (readCount === 2 && String(filePath) === resultPath) {
            // Atomically replace the file with a new eventId.
            fs.writeFileSync(
              resultPath,
              JSON.stringify({
                id: runId,
                state: "complete",
                success: true,
                summary: "replaced",
                sessionId: "sweep-replace-session",
                eventId: replacedEventId,
                results: [],
              }),
              "utf-8",
            );
            return fs.readFileSync(filePath as fs.PathLike, encoding as BufferEncoding);
          }
          return result;
        },
        statSync: fs.statSync.bind(fs),
        unlinkSync: fs.unlinkSync.bind(fs),
        readdirSync: fs.readdirSync.bind(fs),
        mkdirSync: fs.mkdirSync.bind(fs),
        realpathSync: fs.realpathSync.bind(fs),
        watch: fs.watch.bind(fs),
      };

      const state = Object.assign(createState(), { currentSessionId: "sweep-replace-session" });
      // Mark the originalEventId as seen so sweep would normally unlink it.
      state.completionSeen.set(originalEventId, Date.now());

      const watcher = createResultWatcher(
        { events: { on: () => () => {}, emit: () => {} } },
        state,
        resultsDir,
        60_000,
        { fs: fsProxy as typeof fs },
      );
      try {
        watcher.sweepStaleResultFiles();
        // The replaced file (different eventId) must NOT be unlinked.
        // The sweep re-reads and finds originalEventId !== replacedEventId, so it skips.
        assert.equal(
          fs.existsSync(resultPath),
          true,
          "replaced file must survive sweep when eventId changed between check and unlink",
        );
      } finally {
        watcher.stopResultWatcher();
      }
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("C: undelivered stale-sweep: replacement between backup-check and unlink is not deleted", () => {
    // Fix 3: The undelivered stale-unlink branch must re-read and compare
    // eventId immediately before unlinking (just like the already-delivered branch).
    // When a concurrent write replaces the file during the backup checks, the
    // sweep must leave the new file intact.
    const resultsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-result-watcher-sweep-undelivered-replace-"),
    );
    try {
      const runId = `undelivered-replace-${Date.now().toString(36)}`;
      const resultPath = path.join(resultsDir, `${runId}.json`);
      const originalEventId = "undelivered-orig-id";
      const replacedEventId = "undelivered-replaced-id";

      // Write a session file that the sweep will call canRead() on.
      const sessionFile = path.join(resultsDir, `${runId}-session.txt`);
      fs.writeFileSync(sessionFile, "session transcript", "utf-8");

      writeJson(resultPath, {
        id: runId,
        state: "complete",
        success: true,
        summary: "original undelivered",
        sessionId: "sweep-undelivered-replace-session",
        eventId: originalEventId,
        sessionFile,
        results: [],
      });
      const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;
      const staleDate = new Date(Date.now() - EIGHT_DAYS_MS);
      fs.utimesSync(resultPath, staleDate, staleDate);

      // Build an fsProxy that replaces the file content when the re-read
      // for safe-unlink verification runs (after the backup check).
      let readCount = 0;
      const fsProxy = {
        existsSync: fs.existsSync.bind(fs),
        readFileSync(filePath: fs.PathOrFileDescriptor, encoding: unknown) {
          const result = fs.readFileSync(filePath as fs.PathLike, encoding as BufferEncoding);
          readCount++;
          // The re-read for safe-unlink is the call to resultPath after the
          // backup-check reads.  We trigger on the 3rd read of resultPath
          // (1st: main parse, 2nd: sessionFile canRead, 3rd: re-read before unlink).
          if (String(filePath) === resultPath && readCount === 3) {
            fs.writeFileSync(
              resultPath,
              JSON.stringify({
                id: runId,
                state: "complete",
                success: true,
                summary: "replaced undelivered",
                sessionId: "sweep-undelivered-replace-session",
                eventId: replacedEventId,
                sessionFile,
                results: [],
              }),
              "utf-8",
            );
            return fs.readFileSync(filePath as fs.PathLike, encoding as BufferEncoding);
          }
          return result;
        },
        statSync: fs.statSync.bind(fs),
        unlinkSync: fs.unlinkSync.bind(fs),
        readdirSync: fs.readdirSync.bind(fs),
        mkdirSync: fs.mkdirSync.bind(fs),
        realpathSync: fs.realpathSync.bind(fs),
        watch: fs.watch.bind(fs),
      };

      // Do NOT mark the eventId as seen \ this is the undelivered branch.
      const state = Object.assign(createState(), {
        currentSessionId: "other-session",
      });

      const watcher = createResultWatcher(
        { events: { on: () => () => {}, emit: () => {} } },
        state,
        resultsDir,
        60_000,
        { fs: fsProxy as typeof fs },
      );
      try {
        watcher.sweepStaleResultFiles();
        // The file was replaced with a new eventId during the backup check.
        // Fix 3: the re-read detects the mismatch and skips the unlink.
        assert.equal(
          fs.existsSync(resultPath),
          true,
          "replaced undelivered file must survive sweep when eventId changed before unlink",
        );
      } finally {
        watcher.stopResultWatcher();
      }
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("Fix 2: orphan-timer retry is suppressed after stopResultWatcher()", async () => {
    // P2 fix: after stopResultWatcher(), orphan timers must not reschedule
    // files via the coalescer.  Without the fix three or more emissions occur.
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-orphan-stop-"));
    const emitCount: string[] = [];
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const pi = {
      events: {
        on(event: string, handler: (payload: unknown) => void) {
          const handlers = listeners.get(event) ?? new Set<(payload: unknown) => void>();
          handlers.add(handler);
          listeners.set(event, handlers);
          return () => handlers.delete(handler);
        },
        emit(event: string, data: unknown) {
          if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) {
            emitCount.push("emit");
            // Immediately ackOnComplete so the watcher releases the file.
            ackOnComplete(data);
          }
          for (const h of listeners.get(event) ?? []) h(data);
        },
      },
      on(_e: string, _h: (...args: unknown[]) => void) {},
      sendMessage(_m: unknown) {
        throw new Error("simulated send failure — ack never called");
      },
      sendUserMessage(_c: unknown) {},
    };
    try {
      const sessionId = `stop-orphan-${Date.now()}`;
      const state = Object.assign(createState(), { currentSessionId: sessionId });
      // Short TTL (60 ms) so orphan timer fires before the test deadline.
      const watcher = createResultWatcher(pi, state, resultsDir, 60);
      const resultPath = path.join(resultsDir, "stop-orphan.json");
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          id: "stop-orphan-run",
          agent: "worker",
          success: true,
          state: "complete",
          summary: "orphan stop test",
          sessionId,
          results: [],
        }),
        "utf-8",
      );
      // Prime and let the coalescer fire: emits once (send throws \ ack never called).
      watcher.primeExistingResults();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const emitsBeforeStop = emitCount.length;
      assert.ok(emitsBeforeStop >= 1, "at least one emit before stop");

      // Stop the watcher: orphan timers scheduled above must not reschedule.
      watcher.stopResultWatcher();

      // Wait well past the orphan TTL (60 ms): if the fix is absent the coalescer
      // would reschedule → emit again → new orphan timer → emit again.
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(
        emitCount.length,
        emitsBeforeStop,
        `no additional emissions after stop (got ${emitCount.length - emitsBeforeStop} extra)`,
      );
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("Fix 1: sweep-before-prime with aged owner-session result — delivered exactly once with model-visible content", async () => {
    // Regression test: the production session-start ordering is
    // sweepStaleResultFiles() then primeExistingResults().  An eight-day-old
    // result file owned by the CURRENT session must survive the sweep and be
    // delivered exactly once (with model-visible content).
    const resultsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-result-watcher-owner-session-sweep-"),
    );
    const sessionId = `owner-session-sweep-${Date.now()}`;
    const agentMarker = `OWNSESS${Date.now()}END`;
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const sentContents: string[] = [];
    const pi = {
      events: {
        on(event: string, handler: (payload: unknown) => void) {
          const handlers = listeners.get(event) ?? new Set<(payload: unknown) => void>();
          handlers.add(handler);
          listeners.set(event, handlers);
          return () => handlers.delete(handler);
        },
        emit(event: string, data: unknown) {
          for (const h of listeners.get(event) ?? []) h(data);
        },
      },
      on(_e: string, _h: (...args: unknown[]) => void) {},
      sendMessage(m: { content?: string }) {
        sentContents.push(m.content ?? "");
      },
      sendUserMessage(_c: unknown) {},
    };
    try {
      // Import registerSubagentNotify dynamically to avoid circular-dep issues.
      const { default: registerSubagentNotify } =
        await import("../../src/runs/background/notify.ts");
      const state = Object.assign(createState(), { currentSessionId: sessionId });
      registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });
      const watcher = createResultWatcher(pi, state, resultsDir, 60_000);

      const resultPath = path.join(resultsDir, "owner-session-stale.json");
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          id: "owner-session-stale-run",
          agent: agentMarker,
          success: true,
          state: "complete",
          summary: `${agentMarker} summary`,
          sessionId,
          results: [],
        }),
        "utf-8",
      );
      // Age the file past the 7-day retention window.
      const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;
      const staleDate = new Date(Date.now() - EIGHT_DAYS_MS);
      fs.utimesSync(resultPath, staleDate, staleDate);

      // Run production ordering: sweep then prime.
      watcher.sweepStaleResultFiles();
      // Guard: file must NOT be deleted by sweep (current-session owner).
      assert.equal(fs.existsSync(resultPath), true, "owner-session stale file must survive sweep");

      watcher.primeExistingResults();
      // Wait for coalescer + notify to deliver.
      await new Promise<void>((resolve) => {
        const deadline = Date.now() + 2000;
        const interval = setInterval(() => {
          if (sentContents.length >= 1 || Date.now() >= deadline) {
            clearInterval(interval);
            resolve();
          }
        }, 10);
      });
      try {
        watcher.stopResultWatcher();
      } catch {
        // ignore
      }

      assert.equal(sentContents.length, 1, "aged owner-session result must be delivered once");
      assert.ok(
        sentContents[0]!.includes(agentMarker),
        `delivered content must include agent marker; content: ${sentContents[0]!.slice(0, 200)}`,
      );
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("3a: watcher-backed first-chunk failure recovery with 9 distinct content markers (production retry path)", async () => {
    // All 9 items' orphan timers fire after TTL, reschedule via the coalescer,
    // and all 9 are delivered exactly once with model-visible content.
    const sessionId = `session-3a-${Date.now()}`;
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rw-3a-first-"));
    const totalItems = MAX_GROUPED_ENTRIES + 1; // 9: chunk-0 has 8, chunk-1 has 1
    const markers = Array.from({ length: totalItems }, (_, i) => `ZQX3A${i}ZQXEND`);

    for (let i = 0; i < totalItems; i++) {
      fs.writeFileSync(
        path.join(resultsDir, `result-3a-${i}.json`),
        JSON.stringify({
          id: `3a-run-${i}`,
          agent: markers[i]!,
          success: true,
          state: "complete",
          summary: `${markers[i]!} summary`,
          results: [],
          sessionId,
        }),
        "utf-8",
      );
    }

    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    let sendCount = 0;
    const sentContents: string[] = [];
    const pi = {
      events: {
        on(event: string, handler: (payload: unknown) => void) {
          const handlers = listeners.get(event) ?? new Set<(payload: unknown) => void>();
          handlers.add(handler);
          listeners.set(event, handlers);
          return () => handlers.delete(handler);
        },
        emit(event: string, data: unknown) {
          for (const handler of listeners.get(event) ?? []) handler(data);
        },
      },
      on(_event: string, _handler: (...args: unknown[]) => void) {},
      sendMessage(message: { content?: string }) {
        sendCount++;
        if (sendCount === 1) throw new Error("simulated chunk-0 send failure");
        sentContents.push(message.content ?? "");
      },
      sendUserMessage(_content: string, _options?: { deliverAs?: string }) {},
    };

    try {
      const { default: registerSubagentNotify } =
        await import("../../src/runs/background/notify.ts");
      const state = Object.assign(createState(), { currentSessionId: sessionId });
      registerSubagentNotify(pi as never, state, {
        batchConfig: { enabled: true, debounceMs: 50, maxWaitMs: 500 },
      });
      // TTL 80 ms: orphan timers fire quickly and reschedule all 9 files.
      const watcher = createResultWatcher(pi, state, resultsDir, 80);
      watcher.primeExistingResults();

      // Wait for: initial flush throws + orphan timers (80 ms) + retry succeeds.
      const deadline = Date.now() + 5000;
      await new Promise<void>((resolve, reject) => {
        const interval = setInterval(() => {
          if (sentContents.length >= 2) {
            clearInterval(interval);
            resolve();
          } else if (Date.now() >= deadline) {
            clearInterval(interval);
            reject(
              new Error(
                `Timed out waiting for 2 retry chunks; got ${sentContents.length}: ${JSON.stringify(sentContents.map((c) => c.slice(0, 80)))}`,
              ),
            );
          }
        }, 10);
      });
      try {
        watcher.stopResultWatcher();
      } catch {
        // ignore
      }

      assert.equal(sentContents.length, 2, "retry must produce 2 chunks (9 items = 8 + 1)");
      for (const marker of markers) {
        const chunksContaining = sentContents.filter((c) => c.includes(marker));
        assert.equal(
          chunksContaining.length,
          1,
          `marker ${marker} must appear in exactly one chunk (got ${chunksContaining.length})`,
        );
      }
      for (let i = 0; i < MAX_GROUPED_ENTRIES; i++) {
        assert.ok(
          sentContents[0]!.includes(markers[i]!),
          `marker ${markers[i]!} must be in the first retry chunk`,
        );
      }
      assert.ok(
        sentContents[1]!.includes(markers[MAX_GROUPED_ENTRIES]!),
        `marker ${markers[MAX_GROUPED_ENTRIES]!} must be in the second retry chunk`,
      );
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });
});

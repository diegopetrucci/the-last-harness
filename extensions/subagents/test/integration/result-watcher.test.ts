import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
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
import type { SubagentState } from "../../src/shared/types.ts";

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
          emit: (_event, data) => emitted.push(data),
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
          emit: (_event, data) => emitted.push(data),
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

  it("enriches async completion payloads with nested registry children before deletion", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-nested-"));
    const route = createNestedRoute("async-nested-root");
    try {
      writeNestedEvent(route, {
        type: "subagent.nested.completed",
        ts: Date.now(),
        parentRunId: "async-nested-root",
        parentStepIndex: 0,
        child: {
          id: "nested-child",
          parentRunId: "async-nested-root",
          parentStepIndex: 0,
          depth: 1,
          path: [{ runId: "async-nested-root", stepIndex: 0 }],
          state: "complete",
          agent: "nested-reviewer",
          sessionFile: path.join(resultsDir, "nested-child.jsonl"),
        },
      });
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
      const resultPath = path.join(resultsDir, "async-nested-root.json");
      try {
        fs.writeFileSync(
          resultPath,
          JSON.stringify({
            id: "async-nested-root",
            runId: "async-nested-root",
            agent: "owner",
            mode: "single",
            success: true,
            state: "complete",
            summary: "owner done",
            results: [{ agent: "owner", output: "owner done", success: true }],
            sessionId: "session-1",
          }),
          "utf-8",
        );
        watcher.primeExistingResults();
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        watcher.stopResultWatcher();
      }

      assert.equal(fs.existsSync(resultPath), false);
      const completion = emitted.find((entry) => entry.event === "subagent:async-complete")
        ?.data as
        | {
            nestedChildren?: Array<{ id?: string }>;
            results?: Array<{
              children?: Array<{ id?: string; controlInbox?: string; capabilityToken?: string }>;
            }>;
          }
        | undefined;
      assert.equal(completion?.nestedChildren?.[0]?.id, "nested-child");
      assert.equal(completion?.results?.[0]?.children?.[0]?.id, "nested-child");
      assert.equal(completion?.results?.[0]?.children?.[0]?.controlInbox, undefined);
      assert.equal(completion?.results?.[0]?.children?.[0]?.capabilityToken, undefined);
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
      fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
    }
  });

  it("filters malformed explicit nested children in result files before compacting", async () => {
    const resultsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-result-watcher-nested-malformed-"),
    );
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
      const resultPath = path.join(resultsDir, "async-explicit-nested.json");
      const originalError = console.error;
      const logged: unknown[][] = [];
      console.error = (...args: unknown[]) => {
        logged.push(args);
      };
      try {
        fs.writeFileSync(
          resultPath,
          JSON.stringify({
            id: "async-explicit-nested",
            runId: "async-explicit-nested",
            agent: "owner",
            mode: "single",
            success: true,
            state: "complete",
            summary: "owner done",
            results: [
              {
                agent: "owner",
                output: "owner done",
                success: true,
                children: [
                  {
                    id: "child-explicit-good",
                    parentRunId: "async-explicit-nested",
                    depth: 1,
                    path: [{ runId: "async-explicit-nested" }],
                    state: "complete",
                    agent: "child-good",
                  },
                  { id: "child-explicit-bad", path: "not-an-array" },
                ],
              },
            ],
            nestedChildren: [
              {
                id: "top-explicit-good",
                parentRunId: "async-explicit-nested",
                parentStepIndex: 0,
                depth: 1,
                path: [{ runId: "async-explicit-nested", stepIndex: 0 }],
                state: "complete",
                agent: "top-good",
              },
              { id: "top-explicit-bad", path: "not-an-array" },
            ],
            sessionId: "session-1",
          }),
          "utf-8",
        );
        watcher.primeExistingResults();
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        console.error = originalError;
        watcher.stopResultWatcher();
      }

      assert.equal(fs.existsSync(resultPath), false);
      assert.ok(
        logged.some(
          (entry) =>
            String(entry[0] ?? "").includes(resultPath) &&
            /invalid nested child record/.test(String(entry[0] ?? "")),
        ),
      );
      const completion = emitted.find((entry) => entry.event === "subagent:async-complete")
        ?.data as
        | {
            results?: Array<{ children?: Array<{ id?: string }> }>;
            nestedChildren?: Array<{ id?: string }>;
          }
        | undefined;
      assert.deepEqual(
        completion?.nestedChildren?.map((child) => child.id),
        ["top-explicit-good"],
      );
      assert.deepEqual(
        completion?.results?.[0]?.children?.map((child) => child.id)?.sort(),
        ["child-explicit-good", "top-explicit-good"].sort(),
      );
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("retries and delivers result files after nested registry enrichment recovers", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-nested-retry-"));
    const route = createNestedRoute("async-nested-retry");
    try {
      const registryPath = path.join(path.dirname(route.eventSink), "registry.json");
      fs.writeFileSync(registryPath, "{", "utf-8");
      writeNestedEvent(route, {
        type: "subagent.nested.completed",
        ts: 100,
        parentRunId: "async-nested-retry",
        parentStepIndex: 0,
        child: {
          id: "nested-retry-child",
          parentRunId: "async-nested-retry",
          parentStepIndex: 0,
          depth: 1,
          path: [{ runId: "async-nested-retry", stepIndex: 0 }],
          state: "complete",
          agent: "child",
        },
      });
      const emitted: Array<{ event: string; data: unknown }> = [];
      const listeners = new Map<string, Set<(payload: unknown) => void>>();
      const pi = {
        events: {
          on(event: string, listener: (payload: unknown) => void) {
            const set = listeners.get(event) ?? new Set();
            set.add(listener);
            listeners.set(event, set);
            return () => set.delete(listener);
          },
          emit(event: string, data: unknown) {
            emitted.push({ event, data });
            for (const listener of listeners.get(event) ?? []) listener(data);
          },
        },
      };
      const state = createState();
      state.currentSessionId = "session-1";
      const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
      const resultPath = path.join(resultsDir, "async-nested-retry.json");
      const originalError = console.error;
      const logged: unknown[][] = [];
      console.error = (...args: unknown[]) => {
        logged.push(args);
      };
      try {
        fs.writeFileSync(
          resultPath,
          JSON.stringify({
            id: "async-nested-retry",
            runId: "async-nested-retry",
            agent: "owner",
            success: true,
            state: "complete",
            summary: "owner done",
            sessionId: "session-1",
          }),
          "utf-8",
        );
        watcher.primeExistingResults();
        await new Promise((resolve) => setTimeout(resolve, 100));

        assert.equal(fs.existsSync(resultPath), true);
        assert.equal(emitted.length, 0);
        assert.ok(
          logged.some((entry) => /will retry later/.test(String(entry[0] ?? ""))),
          "expected nested enrichment retry warning to be logged",
        );

        fs.rmSync(registryPath, { force: true });
        watcher.primeExistingResults();
        await new Promise((resolve) => setTimeout(resolve, 650));
      } finally {
        console.error = originalError;
        watcher.stopResultWatcher();
      }

      assert.equal(fs.existsSync(resultPath), false);
      const completion = emitted.find((entry) => entry.event === "subagent:async-complete")
        ?.data as
        | {
            nestedChildren?: Array<{ id?: string }>;
            results?: Array<{ children?: Array<{ id?: string }> }>;
          }
        | undefined;
      assert.deepEqual(
        completion?.nestedChildren?.map((child) => child.id),
        ["nested-retry-child"],
      );
      assert.equal(completion?.results, undefined);
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
      fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
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
            agent: "chain:a->b",
            mode: "chain",
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
      assert.equal(completion?.mode, "chain");
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
});

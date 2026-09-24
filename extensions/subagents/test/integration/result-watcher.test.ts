import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { RESULT_ARTIFACT_CLAIM_CLEANUP_MAX_ATTEMPTS } from "../../src/runs/background/result-artifact-consumer.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function createState(): SubagentState {
  return {
    baseCwd: "/repo",
    currentSessionId: null,
    asyncJobs: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: {
      schedule: () => false,
      clear: () => {},
    },
  };
}

describe("result watcher", () => {
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

      const watcher = createResultWatcher(pi, state, resultsDir);
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

      const watcher = createResultWatcher(pi, state, resultsDir);
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
      const ownerWatcher = createResultWatcher(owner.pi, ownerState, resultsDir);
      const otherWatcher = createResultWatcher(other.pi, otherState, resultsDir);
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

  it("atomically claims one artifact when two watchers race for the same result", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-result-watcher-claim-"));
    const createPi = () => {
      const emitted: unknown[] = [];
      return {
        emitted,
        pi: {
          events: {
            on: () => () => {},
            emit: (_event: string, data: unknown) => emitted.push(data),
          },
        },
      };
    };
    const first = createPi();
    const second = createPi();
    const firstState = createState();
    firstState.currentSessionId = "session-owner";
    const secondState = createState();
    secondState.currentSessionId = "session-owner";
    const firstWatcher = createResultWatcher(first.pi, firstState, resultsDir);
    const secondWatcher = createResultWatcher(second.pi, secondState, resultsDir);
    const resultPath = path.join(resultsDir, "raced.json");
    try {
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          id: "raced-run",
          agent: "worker",
          success: true,
          state: "complete",
          summary: "one delivery",
          sessionId: "session-owner",
        }),
        "utf8",
      );
      firstWatcher.primeExistingResults();
      secondWatcher.primeExistingResults();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(first.emitted.length + second.emitted.length, 1);
      assert.equal(fs.existsSync(resultPath), false);
    } finally {
      firstWatcher.stopResultWatcher();
      secondWatcher.stopResultWatcher();
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("removes orphan claim markers on startup without reading result bodies", () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-orphan-claim-"));
    const orphanClaimPath = path.join(resultsDir, "orphan.json.claim");
    const pairedResultPath = path.join(resultsDir, "paired.json");
    const pairedClaimPath = `${pairedResultPath}.claim`;
    fs.writeFileSync(orphanClaimPath, "opaque claim marker", "utf8");
    fs.writeFileSync(
      pairedResultPath,
      JSON.stringify({ id: "paired", sessionId: "other-session", summary: "not ours" }),
      "utf8",
    );
    fs.writeFileSync(pairedClaimPath, "opaque claim marker", "utf8");
    const pi = {
      events: {
        on: () => () => {},
        emit() {},
      },
    };
    const state = createState();
    const fsProxy = {
      ...fs,
      readFileSync: (() => {
        throw new Error("orphan-claim cleanup must not read result bodies");
      }) as typeof fs.readFileSync,
    };
    const watcher = createResultWatcher(pi, state, resultsDir, { fs: fsProxy });
    try {
      watcher.startResultWatcher();
      assert.equal(fs.existsSync(orphanClaimPath), false);
      assert.equal(fs.existsSync(pairedClaimPath), true);
      fs.writeFileSync(orphanClaimPath, "opaque claim marker", "utf8");
      watcher.primeExistingResults();
      assert.equal(fs.existsSync(orphanClaimPath), false);
    } finally {
      watcher.stopResultWatcher();
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("bounds permanent delivered-artifact unlink retries with backoff and one diagnostic", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-unlink-bound-"));
    const resultPath = path.join(resultsDir, "permanent-unlink.json");
    const pending: Array<{ callback: () => void; delay: number }> = [];
    const setTimeoutSpy = ((callback: () => void, delay = 0) => {
      const handle = { unref() {} } as ReturnType<typeof setTimeout>;
      pending.push({ callback, delay });
      return handle;
    }) as typeof setTimeout;
    const clearTimeoutSpy = ((_handle: ReturnType<typeof setTimeout>) => {}) as typeof clearTimeout;
    const setIntervalSpy = ((callback: () => void, delay = 0) => {
      const handle = { unref() {} } as ReturnType<typeof setInterval>;
      pending.push({ callback, delay });
      return handle;
    }) as typeof setInterval;
    const clearIntervalSpy = ((
      _handle: ReturnType<typeof setInterval>,
    ) => {}) as typeof clearInterval;
    let unlinkAttempts = 0;
    const fsProxy = {
      ...fs,
      unlinkSync(filePath: fs.PathLike) {
        if (String(filePath) === resultPath) {
          unlinkAttempts += 1;
          const error = new Error("permanent unlink failure") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return fs.unlinkSync(filePath);
      },
    };
    const pi = {
      events: {
        on: () => () => {},
        emit() {},
      },
    };
    const state = createState();
    state.currentSessionId = "session-1";
    const watcher = createResultWatcher(pi, state, resultsDir, {
      fs: fsProxy,
      timers: {
        setTimeout: setTimeoutSpy,
        clearTimeout: clearTimeoutSpy,
        setInterval: setIntervalSpy,
        clearInterval: clearIntervalSpy,
      },
    });
    const originalError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          id: "permanent-unlink",
          agent: "worker",
          success: true,
          state: "complete",
          summary: "delivered before cleanup failed",
          sessionId: "session-1",
        }),
        "utf8",
      );
      watcher.primeExistingResults();
      await new Promise((resolve) => setTimeout(resolve, 100));
      let callbackIndex = 0;
      while (callbackIndex < pending.length) pending[callbackIndex++]!.callback();
      assert.equal(unlinkAttempts, RESULT_ARTIFACT_CLAIM_CLEANUP_MAX_ATTEMPTS);
      assert.deepEqual(
        pending.map((entry) => entry.delay),
        [250, 500, 1_000, 2_000],
        "cleanup retries should use bounded backoff after the immediate unlink attempt",
      );
      assert.equal(logged.length, 1, "permanent cleanup failure should emit one diagnostic");
      assert.equal(fs.existsSync(resultPath), true);
      assert.equal(fs.existsSync(`${resultPath}.claim`), true);
    } finally {
      console.error = originalError;
      watcher.stopResultWatcher();
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("bounds persistent result-read retries without repeated diagnostics or claim churn", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-read-bound-"));
    const resultPath = path.join(resultsDir, "persistent-read.json");
    const pending: Array<{ callback: () => void; delay: number }> = [];
    const setTimeoutSpy = ((callback: () => void, delay = 0) => {
      const handle = { unref() {} } as ReturnType<typeof setTimeout>;
      pending.push({ callback, delay });
      return handle;
    }) as typeof setTimeout;
    const clearTimeoutSpy = ((_handle: ReturnType<typeof setTimeout>) => {}) as typeof clearTimeout;
    const setIntervalSpy = ((_callback: () => void, _delay = 0) => {
      const handle = { unref() {} } as ReturnType<typeof setInterval>;
      return handle;
    }) as typeof setInterval;
    const clearIntervalSpy = ((
      _handle: ReturnType<typeof setInterval>,
    ) => {}) as typeof clearInterval;
    let readAttempts = 0;
    let claimAttempts = 0;
    let claimReleases = 0;
    const fsProxy = {
      ...fs,
      openSync(filePath: fs.PathLike, flags: string | number, mode?: string | number | null) {
        if (String(filePath) === `${resultPath}.claim`) claimAttempts += 1;
        return fs.openSync(filePath, flags, mode);
      },
      readFileSync: (() => {
        readAttempts += 1;
        const error = new Error("persistent result read failure") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }) as typeof fs.readFileSync,
      unlinkSync(filePath: fs.PathLike) {
        if (String(filePath) === `${resultPath}.claim`) claimReleases += 1;
        return fs.unlinkSync(filePath);
      },
    };
    const pi = {
      events: {
        on: () => () => {},
        emit() {},
      },
    };
    const state = createState();
    state.currentSessionId = "session-1";
    const watcher = createResultWatcher(pi, state, resultsDir, {
      fs: fsProxy,
      timers: {
        setTimeout: setTimeoutSpy,
        clearTimeout: clearTimeoutSpy,
        setInterval: setIntervalSpy,
        clearInterval: clearIntervalSpy,
      },
    });
    const originalError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      fs.writeFileSync(
        resultPath,
        JSON.stringify({
          id: "persistent-read",
          agent: "worker",
          success: true,
          state: "complete",
          summary: "unreadable result",
          sessionId: "session-1",
        }),
        "utf8",
      );
      watcher.primeExistingResults();
      await new Promise((resolve) => setTimeout(resolve, 100));
      let callbackIndex = 0;
      while (callbackIndex < pending.length) {
        pending[callbackIndex++]!.callback();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(readAttempts, RESULT_ARTIFACT_CLAIM_CLEANUP_MAX_ATTEMPTS + 1);
      assert.deepEqual(
        pending.map((entry) => entry.delay),
        [100, 250, 500, 1_000, 2_000],
        "result retries should use the bounded backoff sequence",
      );
      const retryDiagnostics = logged.filter((args) => String(args[0] ?? "").includes(resultPath));
      assert.equal(
        retryDiagnostics.length,
        1,
        "persistent result failures should emit one diagnostic",
      );
      assert.equal(fs.existsSync(resultPath), true);
      assert.equal(fs.existsSync(`${resultPath}.claim`), false);
      assert.equal(claimAttempts, readAttempts);
      assert.equal(claimReleases, readAttempts);

      watcher.primeExistingResults();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(readAttempts, RESULT_ARTIFACT_CLAIM_CLEANUP_MAX_ATTEMPTS + 1);
      assert.equal(claimAttempts, readAttempts);
      assert.equal(claimReleases, readAttempts);
      assert.equal(logged.filter((args) => String(args[0] ?? "").includes(resultPath)).length, 1);
    } finally {
      console.error = originalError;
      watcher.stopResultWatcher();
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it("clears pending result and claim cleanup timers when stopped", async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-stop-timers-"));
    const retryResultPath = path.join(resultsDir, "retry.json");
    const cleanupResultPath = path.join(resultsDir, "cleanup.json");
    const pending: Array<{ callback: () => void; handle: ReturnType<typeof setTimeout> }> = [];
    const cleared = new Set<ReturnType<typeof setTimeout>>();
    const setTimeoutSpy = ((callback: () => void) => {
      const handle = { unref() {} } as ReturnType<typeof setTimeout>;
      pending.push({ callback, handle });
      return handle;
    }) as typeof setTimeout;
    const clearTimeoutSpy = ((handle: ReturnType<typeof setTimeout>) => {
      cleared.add(handle);
    }) as typeof clearTimeout;
    const setIntervalSpy = ((callback: () => void) => {
      const handle = { unref() {} } as ReturnType<typeof setInterval>;
      pending.push({ callback, handle });
      return handle;
    }) as typeof setInterval;
    const clearIntervalSpy = ((
      _handle: ReturnType<typeof setInterval>,
    ) => {}) as typeof clearInterval;
    let claimFailures = 1;
    const fsProxy = {
      ...fs,
      openSync(filePath: fs.PathLike, flags: string | number, mode?: string | number | null) {
        if (String(filePath) === `${retryResultPath}.claim` && claimFailures > 0) {
          claimFailures -= 1;
          const error = new Error("simulated claim failure") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return fs.openSync(filePath, flags, mode);
      },
      unlinkSync(filePath: fs.PathLike) {
        if (String(filePath) === cleanupResultPath) {
          const error = new Error("simulated permanent cleanup failure") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return fs.unlinkSync(filePath);
      },
    };
    const pi = {
      events: {
        on: () => () => {},
        emit() {},
      },
    };
    const state = createState();
    state.currentSessionId = "session-1";
    const watcher = createResultWatcher(pi, state, resultsDir, {
      fs: fsProxy,
      timers: {
        setTimeout: setTimeoutSpy,
        clearTimeout: clearTimeoutSpy,
        setInterval: setIntervalSpy,
        clearInterval: clearIntervalSpy,
      },
    });
    const originalCoalescer = state.resultFileCoalescer;
    let coalescerScheduleCount = 0;
    state.resultFileCoalescer = {
      schedule(file, delayMs) {
        coalescerScheduleCount += 1;
        return originalCoalescer.schedule(file, delayMs);
      },
      clear() {
        originalCoalescer.clear();
      },
    };
    try {
      fs.writeFileSync(
        retryResultPath,
        JSON.stringify({ id: "retry", summary: "retry", sessionId: "session-1" }),
        "utf8",
      );
      watcher.primeExistingResults();
      await new Promise((resolve) => setTimeout(resolve, 100));
      fs.writeFileSync(
        cleanupResultPath,
        JSON.stringify({
          id: "cleanup",
          agent: "worker",
          success: true,
          state: "complete",
          summary: "cleanup",
          sessionId: "session-1",
        }),
        "utf8",
      );
      watcher.primeExistingResults();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(pending.length >= 2, "expected result retry and claim cleanup timers");
      const scheduleCountBeforeStop = pending.length;
      const coalescerScheduleCountBeforeStop = coalescerScheduleCount;
      watcher.stopResultWatcher();
      assert.equal(cleared.size, scheduleCountBeforeStop);
      for (const entry of pending) entry.callback();
      assert.equal(pending.length, scheduleCountBeforeStop);
      assert.equal(coalescerScheduleCount, coalescerScheduleCountBeforeStop);
    } finally {
      watcher.stopResultWatcher();
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
      const watcher = createResultWatcher(pi, state, resultsDir);
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
      const watcher = createResultWatcher(pi, state, resultsDir, {
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
      const watcher = createResultWatcher(pi, state, resultsDir, {
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
      const watcher = createResultWatcher(pi, state, resultsDir, {
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
      const watcher = createResultWatcher(pi, state, resultsDir);
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
      const watcher = createResultWatcher(pi, state, resultsDir);
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
      const watcher = createResultWatcher(pi, state, resultsDir);
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
      const watcher = createResultWatcher(pi, state, resultsDir);
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
        assert.equal(
          logged.length,
          0,
          "transient retry failures should not spam diagnostics before exhaustion",
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
      const watcher = createResultWatcher(pi, state, resultsDir);
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
      const watcher = createResultWatcher(pi, state, resultsDir);
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
      const watcher = createResultWatcher(pi, state, resultsDir);
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

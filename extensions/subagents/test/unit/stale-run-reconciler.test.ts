import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { resolveAsyncResumeTarget } from "../../src/runs/background/async-resume.ts";
import {
  checkPidLiveness,
  reconcileAsyncRun,
} from "../../src/runs/background/stale-run-reconciler.ts";
import { writeNormalizedLifecycleStatus } from "../../src/runs/shared/lifecycle-state.ts";
import { readStatus } from "../../src/shared/utils.ts";

const STALE_LIVE_PID_MS = 24 * 60 * 60 * 1000;

function tempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeStatus(asyncDir: string, status: Record<string, unknown>): void {
  fs.mkdirSync(asyncDir, { recursive: true });
  fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status, null, 2), "utf-8");
}

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe("async stale-run reconciliation", () => {
  it("classifies pid liveness without treating EPERM as dead", () => {
    assert.equal(
      checkPidLiveness(123, () => true),
      "alive",
    );
    assert.equal(
      checkPidLiveness(123, () => {
        throw errno("ESRCH");
      }),
      "dead",
    );
    assert.equal(
      checkPidLiveness(123, () => {
        throw errno("EPERM");
      }),
      "unknown",
    );
    assert.equal(
      checkPidLiveness(123, () => {
        throw new Error("boom");
      }),
      "unknown",
    );
  });

  it("bypasses the status cache during reconciliation", () => {
    const root = tempRoot("pi-stale-run-cache-bypass-");
    try {
      const asyncDir = path.join(root, "run-cache-bypass");
      const resultsDir = path.join(root, "results");
      const statusPath = path.join(asyncDir, "status.json");
      const stale = {
        runId: "run-cache-bypass",
        mode: "single",
        state: "running",
        pid: 12345,
        startedAt: 1000,
        lastUpdate: 1000,
        steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
      };
      const fresh = {
        ...stale,
        state: "complete",
        pid: undefined,
        endedAt: 2000,
        lastUpdate: 2000,
        steps: [{ agent: "worker", status: "complete", startedAt: 1000 }],
      };
      writeStatus(asyncDir, stale);
      const before = fs.readFileSync(statusPath);
      const metadata = fs.statSync(statusPath);
      let body = JSON.stringify(stale);
      const statusRead = {
        statSync: () => metadata,
        readFileSync: () => body,
        sleep: () => {},
      };
      assert.equal(readStatus(asyncDir, statusRead)?.state, "running");
      body = JSON.stringify(fresh);

      const result = reconcileAsyncRun(asyncDir, {
        resultsDir,
        statusRead,
        now: () => 3000,
      });
      assert.equal(result.repaired, false);
      assert.equal(result.status?.state, "complete");
      assert.equal(fs.existsSync(path.join(resultsDir, "run-cache-bypass.json")), false);
      assert.deepEqual(fs.readFileSync(statusPath), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks a running async run failed when the runner pid is dead and no result exists", () => {
    const root = tempRoot("pi-stale-run-");
    try {
      const asyncDir = path.join(root, "run-dead");
      const resultsDir = path.join(root, "results");
      writeStatus(asyncDir, {
        runId: "run-dead",
        sessionId: "session-current",
        mode: "single",
        state: "running",
        pid: 12345,
        startedAt: 1000,
        lastUpdate: 1000,
        currentStep: 0,
        steps: [{ agent: "scout", status: "running", startedAt: 1000 }],
      });

      const result = reconcileAsyncRun(asyncDir, {
        resultsDir,
        kill: () => {
          throw errno("ESRCH");
        },
        now: () => 2000,
      });

      assert.equal(result.repaired, true);
      assert.equal(result.status?.state, "failed");
      assert.match(result.message ?? "", /process 12345 exited before writing a result/);
      const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
      assert.equal(status.state, "failed");
      assert.equal(status.sessionId, "session-current");
      assert.equal(status.steps?.[0]?.status, "failed");
      assert.match(status.steps?.[0]?.error, /process 12345 exited before writing a result/);
      const resultJson = JSON.parse(
        fs.readFileSync(path.join(resultsDir, "run-dead.json"), "utf-8"),
      );
      assert.equal(resultJson.success, false);
      assert.equal(resultJson.sessionId, "session-current");
      assert.equal(resultJson.state, "failed");
      assert.equal(resultJson.exitCode, 1);
      assert.match(resultJson.summary, /process 12345 exited before writing a result/);
      assert.match(
        fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8"),
        /subagent\.run\.repaired_stale/,
      );
      fs.rmSync(asyncDir, { recursive: true, force: true });
      const resultOnlyTarget = resolveAsyncResumeTarget(
        { id: "run-dead" },
        { asyncDirRoot: root, resultsDir },
        { requireSessionFile: false },
      );
      assert.equal(resultOnlyTarget.kind, "revive");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains a live PID before the 24-hour stale-record cutoff", () => {
    const root = tempRoot("pi-stale-live-pid-fresh-");
    try {
      const asyncDir = path.join(root, "run-live-fresh");
      const resultsDir = path.join(root, "results");
      writeStatus(asyncDir, {
        runId: "run-live-fresh",
        mode: "single",
        state: "running",
        pid: 12345,
        startedAt: 1000,
        lastUpdate: 2001,
        steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
      });
      const before = fs.readFileSync(path.join(asyncDir, "status.json"));

      const result = reconcileAsyncRun(asyncDir, {
        resultsDir,
        kill: () => true,
        now: () => STALE_LIVE_PID_MS + 2000,
      });

      assert.equal(result.repaired, false);
      assert.equal(result.status?.state, "running");
      assert.equal(result.status?.pid, 12345);
      assert.equal(fs.existsSync(path.join(resultsDir, "run-live-fresh.json")), false);
      assert.deepEqual(fs.readFileSync(path.join(asyncDir, "status.json")), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains a live PID at the exact injected stale-record cutoff", () => {
    const root = tempRoot("pi-stale-live-pid-exact-");
    try {
      const asyncDir = path.join(root, "run-live-exact");
      const resultsDir = path.join(root, "results");
      writeStatus(asyncDir, {
        runId: "run-live-exact",
        mode: "single",
        state: "running",
        pid: 12345,
        startedAt: 1000,
        lastUpdate: 1000,
        steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
      });
      const before = fs.readFileSync(path.join(asyncDir, "status.json"));

      const result = reconcileAsyncRun(asyncDir, {
        resultsDir,
        kill: () => true,
        now: () => 2000,
        staleAlivePidMs: 1000,
      });

      assert.equal(result.repaired, false);
      assert.equal(result.status?.state, "running");
      assert.equal(result.status?.pid, 12345);
      assert.equal(fs.existsSync(path.join(resultsDir, "run-live-exact.json")), false);
      assert.deepEqual(fs.readFileSync(path.join(asyncDir, "status.json")), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails a live PID after the stale-record cutoff and clears ownership", () => {
    const root = tempRoot("pi-stale-live-pid-old-");
    try {
      const asyncDir = path.join(root, "run-live-old");
      const resultsDir = path.join(root, "results");
      writeStatus(asyncDir, {
        runId: "run-live-old",
        mode: "single",
        state: "running",
        pid: 12345,
        startedAt: 1000,
        lastUpdate: 1000,
        steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
      });

      const result = reconcileAsyncRun(asyncDir, {
        resultsDir,
        kill: () => true,
        now: () => STALE_LIVE_PID_MS + 1001,
      });

      assert.equal(result.repaired, true);
      assert.equal(result.status?.state, "failed");
      assert.equal(result.status?.pid, undefined);
      assert.match(result.message ?? "", /live PID, but status has not updated/);
      assert.match(result.message ?? "", /PID ownership cannot be verified/);
      const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
      assert.equal(status.pid, undefined);
      assert.equal(status.state, "failed");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not fail a stale snapshot when the running record refreshes before commit", () => {
    const root = tempRoot("pi-stale-live-pid-race-");
    try {
      const asyncDir = path.join(root, "run-live-race");
      const resultsDir = path.join(root, "results");
      writeStatus(asyncDir, {
        runId: "run-live-race",
        mode: "single",
        state: "running",
        pid: 12345,
        startedAt: 1000,
        lastUpdate: 1000,
        steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
      });
      const refreshedAt = STALE_LIVE_PID_MS + 1500;
      let refreshed = false;

      const result = reconcileAsyncRun(asyncDir, {
        resultsDir,
        kill: () => {
          if (!refreshed) {
            refreshed = true;
            const current = readStatus(asyncDir);
            assert.ok(current);
            writeNormalizedLifecycleStatus(asyncDir, {
              ...current,
              lastUpdate: refreshedAt,
            });
          }
          return true;
        },
        now: () => STALE_LIVE_PID_MS + 2000,
      });

      assert.equal(result.repaired, false);
      assert.equal(result.status?.state, "running");
      assert.equal(result.status?.pid, 12345);
      assert.equal(result.status?.lastUpdate, refreshedAt);
      assert.equal(fs.existsSync(path.join(resultsDir, "run-live-race.json")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains an unknown PID before the stale-record cutoff", () => {
    const root = tempRoot("pi-stale-unknown-pid-fresh-");
    try {
      const asyncDir = path.join(root, "run-unknown-fresh");
      const resultsDir = path.join(root, "results");
      writeStatus(asyncDir, {
        runId: "run-unknown-fresh",
        mode: "single",
        state: "running",
        pid: 12345,
        startedAt: 1000,
        lastUpdate: 2001,
        steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
      });
      const before = fs.readFileSync(path.join(asyncDir, "status.json"));

      const result = reconcileAsyncRun(asyncDir, {
        resultsDir,
        kill: () => {
          throw errno("EPERM");
        },
        now: () => STALE_LIVE_PID_MS + 2000,
      });

      assert.equal(result.repaired, false);
      assert.equal(result.status?.state, "running");
      assert.equal(result.status?.pid, 12345);
      assert.equal(fs.existsSync(path.join(resultsDir, "run-unknown-fresh.json")), false);
      assert.deepEqual(fs.readFileSync(path.join(asyncDir, "status.json")), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails an old unknown PID using startedAt when lastUpdate is absent", () => {
    const root = tempRoot("pi-stale-unknown-pid-old-");
    try {
      const asyncDir = path.join(root, "run-unknown-old");
      const resultsDir = path.join(root, "results");
      writeStatus(asyncDir, {
        runId: "run-unknown-old",
        mode: "single",
        state: "running",
        pid: 12345,
        startedAt: 1000,
        steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
      });

      const result = reconcileAsyncRun(asyncDir, {
        resultsDir,
        kill: () => {
          throw errno("EPERM");
        },
        now: () => STALE_LIVE_PID_MS + 1001,
      });

      assert.equal(result.repaired, true);
      assert.equal(result.status?.state, "failed");
      assert.equal(result.status?.pid, undefined);
      assert.match(result.message ?? "", /PID ownership cannot be verified/);
      const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
      assert.equal(status.pid, undefined);
      assert.equal(status.state, "failed");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps old live pausing ownership lifecycle-protected", () => {
    const root = tempRoot("pi-stale-pausing-live-pid-");
    try {
      const asyncDir = path.join(root, "run-pausing");
      const resultsDir = path.join(root, "results");
      writeStatus(asyncDir, {
        runId: "run-pausing",
        mode: "single",
        state: "pausing",
        pid: 12345,
        startedAt: 1000,
        lastUpdate: 1000,
        pause: { kind: "awaiting_supervisor", ownerPid: 12345 },
        steps: [{ agent: "worker", status: "pausing" }],
      });
      const before = fs.readFileSync(path.join(asyncDir, "status.json"));

      const result = reconcileAsyncRun(asyncDir, {
        resultsDir,
        kill: () => true,
        now: () => STALE_LIVE_PID_MS + 1001,
      });

      assert.equal(result.repaired, false);
      assert.equal(result.status?.state, "pausing");
      assert.equal(result.status?.pid, 12345);
      assert.equal(fs.existsSync(path.join(resultsDir, "run-pausing.json")), false);
      assert.deepEqual(fs.readFileSync(path.join(asyncDir, "status.json")), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails pending parallel steps while leaving terminal siblings unchanged", () => {
    const root = tempRoot("pi-stale-pending-step-");
    try {
      const asyncDir = path.join(root, "run-pending");
      writeStatus(asyncDir, {
        runId: "run-pending",
        mode: "parallel",
        state: "running",
        pid: 12345,
        startedAt: 1000,
        steps: [
          { agent: "queued", status: "pending" },
          { agent: "done", status: "complete", endedAt: 1500, error: "finished" },
        ],
      });
      const result = reconcileAsyncRun(asyncDir, {
        kill: () => {
          throw errno("ESRCH");
        },
        now: () => 2000,
      });
      assert.equal(result.repaired, true);
      assert.equal(result.status?.steps?.[0]?.status, "failed");
      assert.equal(result.status?.steps?.[0]?.terminationReason, "process_exit");
      assert.equal(result.status?.steps?.[0]?.error, result.message);
      assert.equal(result.status?.steps?.[1]?.status, "complete");
      assert.equal(result.status?.steps?.[1]?.error, "finished");
      assert.equal(result.status?.steps?.[1]?.endedAt, 1500);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves unreadable stale status untouched", () => {
    const root = tempRoot("pi-stale-unreadable-");
    try {
      const asyncDir = path.join(root, "run-unreadable");
      fs.mkdirSync(asyncDir, { recursive: true });
      const statusPath = path.join(asyncDir, "status.json");
      fs.writeFileSync(statusPath, "{not-json", "utf8");
      const before = fs.readFileSync(statusPath);
      assert.throws(() =>
        reconcileAsyncRun(asyncDir, {
          kill: () => {
            throw errno("ESRCH");
          },
        }),
      );
      assert.deepEqual(fs.readFileSync(statusPath), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves health metadata while failing the active stale step", () => {
    const root = tempRoot("pi-stale-health-repair-");
    try {
      const asyncDir = path.join(root, "run-stale-health");
      const resultsDir = path.join(root, "results");
      writeStatus(asyncDir, {
        runId: "run-stale-health",
        mode: "parallel",
        state: "running",
        pid: 12345,
        startedAt: 1000,
        lastUpdate: 1000,
        currentStep: 1,
        steps: [
          {
            agent: "finished",
            status: "complete",
            startedAt: 1000,
            activityState: "needs_attention",
          },
          {
            agent: "worker",
            status: "running",
            startedAt: 1000,
            activityState: "needs_attention",
            idleEpisodeId: "attempt-a~idle~1",
            compaction: { reason: "overflow" },
          },
        ],
      });

      const repaired = reconcileAsyncRun(asyncDir, {
        resultsDir,
        kill: () => {
          throw errno("ESRCH");
        },
        now: () => 2000,
      });
      assert.equal(repaired.repaired, true);
      assert.equal(repaired.status?.state, "failed");
      assert.equal(repaired.status?.steps?.[0]?.status, "complete");
      assert.equal(repaired.status?.steps?.[0]?.activityState, "needs_attention");
      assert.equal(repaired.status?.steps?.[1]?.status, "failed");
      assert.equal(repaired.status?.steps?.[1]?.activityState, "needs_attention");
      assert.equal(repaired.status?.steps?.[1]?.idleEpisodeId, "attempt-a~idle~1");
      assert.deepEqual(repaired.status?.steps?.[1]?.compaction, { reason: "overflow" });

      const result = JSON.parse(
        fs.readFileSync(path.join(resultsDir, "run-stale-health.json"), "utf-8"),
      );
      assert.equal(result.results[0].success, true);
      assert.equal(result.results[1].success, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves existing result bytes and finished sibling health during stale merge", () => {
    const root = tempRoot("pi-stale-health-result-");
    try {
      const asyncDir = path.join(root, "run-stale-health-result");
      const resultsDir = path.join(root, "results");
      fs.mkdirSync(resultsDir, { recursive: true });
      writeStatus(asyncDir, {
        runId: "run-stale-health-result",
        mode: "parallel",
        state: "running",
        pid: 12345,
        startedAt: 1000,
        lastUpdate: 1000,
        currentStep: 1,
        steps: [
          {
            agent: "finished",
            status: "complete",
            startedAt: 1000,
            activityState: "needs_attention",
          },
          {
            agent: "worker",
            status: "running",
            startedAt: 1000,
            activityState: "needs_attention",
            idleEpisodeId: "attempt-a~idle~1",
            compaction: { reason: "threshold" },
          },
        ],
      });
      const resultPath = path.join(resultsDir, "run-stale-health-result.json");
      const resultContent = `${JSON.stringify(
        {
          id: "run-stale-health-result",
          agent: "finished",
          mode: "parallel",
          success: false,
          state: "failed",
          summary: "one child failed",
          results: [
            {
              agent: "finished",
              success: true,
              output: "done",
              activityState: "active_long_running",
            },
            {
              agent: "worker",
              success: false,
              output: "",
              activityState: "needs_attention",
              idleEpisodeId: "attempt-a~idle~1",
              compaction: { reason: "manual" },
            },
          ],
          exitCode: 1,
          timestamp: 1500,
          durationMs: 500,
          asyncDir,
        },
        null,
        2,
      )}\n`;
      fs.writeFileSync(resultPath, resultContent, "utf-8");

      const repaired = reconcileAsyncRun(asyncDir, {
        resultsDir,
        now: () => 2000,
      });

      assert.equal(repaired.repaired, true);
      assert.equal(repaired.status?.state, "failed");
      assert.equal(repaired.status?.steps?.[0]?.status, "complete");
      assert.equal(repaired.status?.steps?.[0]?.activityState, "needs_attention");
      assert.equal(repaired.status?.steps?.[1]?.status, "failed");
      assert.equal(repaired.status?.steps?.[1]?.activityState, "needs_attention");
      assert.deepEqual(repaired.status?.steps?.[1]?.compaction, { reason: "threshold" });
      assert.equal(fs.readFileSync(resultPath, "utf-8"), resultContent);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("sanitizes status model metadata before result merge and failed repair", () => {
    const root = tempRoot("pi-stale-status-boundary-");
    try {
      const resultsDir = path.join(root, "results");
      fs.mkdirSync(resultsDir, { recursive: true });
      const fallbackDir = path.join(root, "run-status-fallback");
      writeStatus(fallbackDir, {
        runId: "run-status-fallback",
        mode: "single",
        state: "running",
        startedAt: 1000,
        lastUpdate: 1000,
        steps: [
          {
            agent: "worker",
            status: "running",
            modelIdentity: { provider: "", model: "gpt-5", thinking: "turbo" },
            modelResolution: { kind: "invalid", reason: "bad status metadata" },
          },
        ],
      });
      fs.writeFileSync(
        path.join(resultsDir, "run-status-fallback.json"),
        JSON.stringify({
          id: "run-status-fallback",
          success: false,
          state: "failed",
          results: [
            {
              agent: "worker",
              success: false,
              modelIdentity: { provider: "anthropic", model: "claude-sonnet-4", thinking: "high" },
              modelResolution: {
                kind: "restored",
                original: { provider: "anthropic", model: "claude-sonnet-4", thinking: "high" },
                resumed: { provider: "anthropic", model: "claude-sonnet-4", thinking: "high" },
                reason: "valid result metadata",
              },
            },
          ],
        }),
        "utf-8",
      );

      const merged = reconcileAsyncRun(fallbackDir, { resultsDir, now: () => 2000 });
      assert.deepEqual(merged.status?.steps?.[0]?.modelIdentity, {
        provider: "",
        model: "gpt-5",
        thinking: "turbo",
      });
      assert.deepEqual(merged.status?.steps?.[0]?.modelResolution, {
        kind: "invalid",
        reason: "bad status metadata",
      });

      const repairDir = path.join(root, "run-status-no-fallback");
      writeStatus(repairDir, {
        runId: "run-status-no-fallback",
        mode: "single",
        state: "running",
        pid: 12345,
        startedAt: 1000,
        lastUpdate: 1000,
        steps: [
          {
            agent: "worker",
            status: "running",
            thinking: "turbo",
            modelIdentity: { provider: "openai", model: "gpt-5", thinking: "turbo" },
            modelResolution: {
              kind: "fallback",
              original: { provider: "openai", model: "gpt-5", thinking: "" },
              resumed: { provider: "anthropic", model: "claude-sonnet-4", thinking: "max" },
              reason: "sanitized status metadata",
            },
          },
        ],
      });
      const repaired = reconcileAsyncRun(repairDir, {
        resultsDir,
        kill: () => {
          throw errno("ESRCH");
        },
        now: () => 2000,
      });
      assert.deepEqual(repaired.status?.steps?.[0]?.modelIdentity, {
        provider: "openai",
        model: "gpt-5",
        thinking: "turbo",
      });
      assert.deepEqual(repaired.status?.steps?.[0]?.modelResolution, {
        kind: "fallback",
        original: { provider: "openai", model: "gpt-5", thinking: "" },
        resumed: { provider: "anthropic", model: "claude-sonnet-4", thinking: "max" },
        reason: "sanitized status metadata",
      });
      const repairedArtifact = JSON.parse(
        fs.readFileSync(path.join(resultsDir, "run-status-no-fallback.json"), "utf-8"),
      );
      assert.deepEqual(repairedArtifact.results[0].modelIdentity, {
        provider: "openai",
        model: "gpt-5",
        thinking: "turbo",
      });
      assert.deepEqual(
        repairedArtifact.results[0].modelResolution,
        repaired.status?.steps?.[0]?.modelResolution,
      );
      assert.equal(repairedArtifact.results[0].thinking, undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps stale repair successful when the event log cannot be appended", () => {
    const root = tempRoot("pi-stale-event-log-collision-");
    try {
      const asyncDir = path.join(root, "run-dead-events-dir");
      const resultsDir = path.join(root, "results");
      writeStatus(asyncDir, {
        runId: "run-dead-events-dir",
        mode: "single",
        state: "running",
        pid: 12345,
        startedAt: 1000,
        lastUpdate: 1000,
        currentStep: 0,
        steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
      });
      fs.mkdirSync(path.join(asyncDir, "events.jsonl"));

      const result = reconcileAsyncRun(asyncDir, {
        resultsDir,
        kill: () => {
          throw errno("ESRCH");
        },
        now: () => 2000,
      });

      assert.equal(result.repaired, true);
      assert.equal(result.status?.state, "failed");
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")).state,
        "failed",
      );
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(resultsDir, "run-dead-events-dir.json"), "utf-8"))
          .success,
        false,
      );
      assert.equal(fs.statSync(path.join(asyncDir, "events.jsonl")).isDirectory(), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("repairs stale status with per-child result outcomes", () => {
    const root = tempRoot("pi-stale-mixed-result-");
    try {
      const asyncDir = path.join(root, "run-mixed");
      const resultsDir = path.join(root, "results");
      fs.mkdirSync(resultsDir, { recursive: true });
      writeStatus(asyncDir, {
        runId: "run-mixed",
        mode: "parallel",
        state: "running",
        pid: 12345,
        startedAt: 1000,
        lastUpdate: 1000,
        steps: [
          { agent: "scout", status: "running", startedAt: 1000 },
          { agent: "worker", status: "running", startedAt: 1100 },
        ],
      });
      const scoutSession = path.join(root, "scout.jsonl");
      const workerSession = path.join(root, "worker.jsonl");
      fs.writeFileSync(
        path.join(resultsDir, "run-mixed.json"),
        JSON.stringify(
          {
            id: "run-mixed",
            success: false,
            state: "failed",
            results: [
              {
                agent: "scout",
                success: true,
                sessionFile: scoutSession,
                model: "fast",
                terminationReason: "completed",
              },
              {
                agent: "worker",
                success: false,
                error: "boom",
                sessionFile: workerSession,
                model: "careful",
                modelIdentity: { provider: "", model: "careful" },
                modelResolution: {
                  kind: "fallback",
                  reason: "",
                  original: { provider: "openai", model: "gpt-5" },
                  resumed: { provider: "", model: "careful" },
                },
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = reconcileAsyncRun(asyncDir, {
        resultsDir,
        kill: () => {
          throw errno("ESRCH");
        },
        now: () => 2000,
      });

      assert.equal(result.repaired, true);
      assert.equal(result.status?.state, "failed");
      // Stale repair has one rule: a dead owned runner fails every unfinished
      // step. A pre-existing result artifact is evidence, not a status source.
      assert.equal(result.status?.steps?.[0]?.status, "failed");
      assert.equal(result.status?.steps?.[0]?.exitCode, 1);
      assert.equal(result.status?.steps?.[0]?.model, undefined);
      assert.equal(result.status?.steps?.[0]?.sessionFile, undefined);
      assert.equal(result.status?.steps?.[0]?.terminationReason, "process_exit");
      assert.equal(result.status?.steps?.[1]?.status, "failed");
      assert.equal(result.status?.steps?.[1]?.exitCode, 1);
      assert.match(result.status?.steps?.[1]?.error ?? "", /exited before writing a result/);
      assert.equal(result.status?.steps?.[1]?.model, undefined);
      assert.equal(result.status?.steps?.[1]?.sessionFile, undefined);
      assert.equal(result.status?.steps?.[1]?.terminationReason, "process_exit");
      assert.equal(
        fs.readFileSync(path.join(resultsDir, "run-mixed.json"), "utf8").includes('"careful"'),
        true,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("sanitizes invalid thinking in repaired model diagnostics", () => {
    const root = tempRoot("pi-stale-thinking-boundary-");
    try {
      const asyncDir = path.join(root, "run-thinking-boundary");
      const resultsDir = path.join(root, "results");
      fs.mkdirSync(resultsDir, { recursive: true });
      writeStatus(asyncDir, {
        runId: "run-thinking-boundary",
        mode: "parallel",
        state: "running",
        pid: 12345,
        startedAt: 1000,
        lastUpdate: 1000,
        currentStep: 0,
        steps: [
          { agent: "worker", status: "running", startedAt: 1000 },
          { agent: "reviewer", status: "running", startedAt: 1000 },
        ],
      });
      fs.writeFileSync(
        path.join(resultsDir, "run-thinking-boundary.json"),
        JSON.stringify({
          id: "run-thinking-boundary",
          success: false,
          state: "failed",
          results: [
            {
              agent: "worker",
              success: false,
              modelIdentity: { provider: "openai", model: "gpt-5", thinking: "turbo" },
              modelResolution: {
                kind: "fallback",
                original: { provider: "openai", model: "gpt-5", thinking: "" },
                resumed: { provider: "anthropic", model: "claude-sonnet-4", thinking: "xhigh" },
                reason: "provider fallback",
              },
            },
            {
              agent: "reviewer",
              success: false,
              modelIdentity: { provider: "anthropic", model: "claude-sonnet-4", thinking: "max" },
              modelResolution: {
                kind: "restored",
                original: { provider: "anthropic", model: "claude-sonnet-4", thinking: "xhigh" },
                resumed: { provider: "anthropic", model: "claude-sonnet-4", thinking: "max" },
                reason: "restored selection",
              },
            },
          ],
        }),
        "utf-8",
      );

      const result = reconcileAsyncRun(asyncDir, {
        resultsDir,
        kill: () => {
          throw errno("ESRCH");
        },
        now: () => 2000,
      });

      assert.equal(result.repaired, true);
      assert.equal(result.status?.state, "failed");
      assert.equal(result.status?.steps?.[0]?.modelIdentity, undefined);
      assert.equal(result.status?.steps?.[0]?.modelResolution, undefined);
      assert.equal(result.status?.steps?.[1]?.modelIdentity, undefined);
      assert.equal(result.status?.steps?.[1]?.modelResolution, undefined);
      // Existing result bytes are retained as historical evidence rather than
      // copied into the repaired lifecycle document.
      assert.equal(fs.existsSync(path.join(resultsDir, "run-thinking-boundary.json")), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails a dead active status without overwriting an existing result", () => {
    const root = tempRoot("pi-stale-existing-result-");
    try {
      const asyncDir = path.join(root, "run-result");
      const resultsDir = path.join(root, "results");
      fs.mkdirSync(resultsDir, { recursive: true });
      writeStatus(asyncDir, {
        runId: "run-result",
        mode: "single",
        state: "running",
        pid: 12345,
        startedAt: 1000,
        lastUpdate: 1000,
        steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
      });
      const resultPath = path.join(resultsDir, "run-result.json");
      fs.writeFileSync(
        resultPath,
        JSON.stringify(
          { id: "run-result", success: true, state: "complete", summary: "already done" },
          null,
          2,
        ),
        "utf-8",
      );

      const result = reconcileAsyncRun(asyncDir, {
        resultsDir,
        kill: () => {
          throw errno("ESRCH");
        },
        now: () => 2000,
      });

      assert.equal(result.repaired, true);
      assert.equal(result.status?.state, "failed");
      assert.equal(JSON.parse(fs.readFileSync(resultPath, "utf-8")).summary, "already done");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { openAttemptSessionLease } from "../../src/runs/background/attempt-session-lease.ts";
import { runPiStreaming } from "../../src/runs/background/pi-streaming.ts";
import { runSingleStep } from "../../src/runs/background/single-step-execution.ts";
import {
  acquireSessionLease,
  readSessionRecord,
  type SessionRecord,
} from "../../src/runs/shared/session-record.ts";
import type { ResolvedArtifactConfig } from "../../src/shared/types.ts";
import { startedMockPiPids, waitForMockPiCall } from "../support/async-execution-helpers.ts";
import {
  createMockPi,
  createTempDir,
  makeRunnerStep,
  removeTempDir,
  type MockPi,
} from "../support/helpers.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";

const SIGNAL_HELPER = path.resolve(import.meta.dirname, "../support/live-lease-signal-runner.ts");
const HELPER = path.resolve(import.meta.dirname, "../support/live-lease-runner.ts");

const artifactConfig: ResolvedArtifactConfig = {
  mode: "compact",
  enabled: false,
  includeInput: false,
  includeOutput: false,
  includeJsonl: false,
  includeTranscript: false,
  includeMetadata: false,
  includeChildEventProjections: false,
  cleanupDays: 7,
};

/** A caller-supplied binary override would defeat the helper's fail-closed guard. */
function envWithoutPiBinary(): NodeJS.ProcessEnv {
  const { PI_SUBAGENT_PI_BINARY: _binary, ...env } = process.env;
  return env;
}

function groupAlive(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitFor(label: string, predicate: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + scaleTestTimeout(ms);
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function okRecord(sessionFile: string): SessionRecord {
  const read = readSessionRecord(sessionFile);
  assert.equal(read.status, "ok");
  return (read as Extract<typeof read, { status: "ok" }>).record;
}

describe("session lease on every launch", () => {
  let mockPi: MockPi;
  let tempDirs: string[];

  before(() => {
    mockPi = createMockPi();
    mockPi.install();
  });
  after(() => mockPi.uninstall());
  beforeEach(() => {
    mockPi.reset();
    tempDirs = [];
  });
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) removeTempDir(dir);
  });

  function stepContext(root: string, id: string, extra: Record<string, unknown> = {}) {
    return {
      cwd: root,
      sessionEnabled: true,
      sessionDir: path.join(root, "sessions"),
      artifactConfig,
      id,
      flatIndex: 0,
      flatStepCount: 1,
      outputFile: path.join(root, "output.log"),
      startedAt: Date.now(),
      ...extra,
    };
  }

  it("holds the lease with the child group while it runs, then finishes cleanly", async () => {
    mockPi.onCall({
      output: "ok",
      delay: 100,
    });
    const root = createTempDir("tlh-lease-clean-");
    tempDirs.push(root);
    let sessionFile: string | undefined;
    let duringRun: SessionRecord | undefined;
    const checkpoints: number[] = [];
    let hook: ((progress: { activeRuntimeMs?: number }) => void) | undefined;

    const result = await runSingleStep(
      makeRunnerStep("worker", "Do it."),
      stepContext(root, "lease-clean", {
        onAttemptSessionFile: (file: string) => (sessionFile = file),
        registerLeaseCheckpoint: (next: typeof hook) => {
          hook = next;
        },
        onChildEvent: () => {
          if (duringRun || !sessionFile) return;
          duringRun = okRecord(sessionFile);
          hook?.({ activeRuntimeMs: 7_000 });
          checkpoints.push(okRecord(sessionFile).activeRuntimeMs);
        },
      }),
      () => undefined,
    );

    assert.equal(result.exitCode, 0, result.error ?? "");
    assert.ok(sessionFile);
    assert.equal(duringRun?.lease?.runnerPid, process.pid);
    assert.deepEqual(duringRun?.lease?.processGroups, [startedMockPiPids(mockPi)[0]]);
    assert.deepEqual(checkpoints, [7_000]);
    assert.equal(hook, undefined, "checkpoint hook is cleared when the attempt settles");
    const final = okRecord(sessionFile);
    assert.equal(final.lease, undefined);
    assert.equal(final.retired, false);
    assert.equal(final.latestRunId, "lease-clean");
    assert.equal(final.cleanFinal?.generation, final.generation);
    assert.ok(final.activeRuntimeMs >= 7_000, "runtime merges by max");
    assert.equal(acquireSessionLease(sessionFile, { runnerPid: process.pid }).status, "acquired");
  });

  it("releases after a failed attempt", async () => {
    mockPi.onCall({ exitCode: 3, stderr: "boom" });
    const root = createTempDir("tlh-lease-failed-");
    tempDirs.push(root);
    let sessionFile: string | undefined;
    const result = await runSingleStep(
      makeRunnerStep("worker", "Fail."),
      stepContext(root, "lease-failed", { onAttemptSessionFile: (f: string) => (sessionFile = f) }),
      () => undefined,
    );
    assert.notEqual(result.exitCode, 0);
    const final = okRecord(sessionFile!);
    assert.equal(final.lease, undefined);
    assert.equal(final.retired, false);
    assert.equal(final.cleanFinal?.generation, final.generation);
  });

  it("retires the record before release on role timeout", async () => {
    mockPi.onCall({ delay: 5_000 });
    const root = createTempDir("tlh-lease-timeout-");
    tempDirs.push(root);
    let sessionFile: string | undefined;
    const result = await runSingleStep(
      makeRunnerStep("slow", "Wait.", { timeoutMs: 300, timeoutOwner: "role" }),
      stepContext(root, "lease-timeout", {
        onAttemptSessionFile: (f: string) => (sessionFile = f),
      }),
      () => undefined,
    );
    assert.equal(result.timedOut, true);
    const final = okRecord(sessionFile!);
    assert.equal(final.retired, true);
    assert.equal(final.retiredReason, "role-timeout");
    assert.equal(final.lease, undefined);
    assert.equal(final.cleanFinal?.generation, final.generation);
    assert.equal(acquireSessionLease(sessionFile!, { runnerPid: process.pid }).status, "retired");
  });

  it("refuses to launch a second writer on a held session", async () => {
    const root = createTempDir("tlh-lease-held-");
    tempDirs.push(root);
    const sessionFile = path.join(root, "sessions", "held.jsonl");
    const holder = openAttemptSessionLease(sessionFile, "other-run");
    assert.ok(holder.ok);
    const result = await runSingleStep(
      makeRunnerStep("worker", "Resume.", { sessionFile }),
      stepContext(root, "lease-held"),
      () => undefined,
    );
    assert.notEqual(result.exitCode, 0);
    assert.match(
      result.error ?? "",
      /Refusing to launch child: The session is held by a live owner/,
    );
    assert.equal(startedMockPiPids(mockPi).length, 0, "Pi must not be spawned");
    assert.ok(okRecord(sessionFile).lease, "the original holder keeps its lease");
  });

  it("refuses an existing session file that has no record", async () => {
    const root = createTempDir("tlh-lease-no-record-");
    tempDirs.push(root);
    const sessionFile = path.join(root, "sessions", "legacy.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{}\n");
    const result = await runSingleStep(
      makeRunnerStep("worker", "Resume.", { sessionFile }),
      stepContext(root, "no-record"),
      () => undefined,
    );
    assert.notEqual(result.exitCode, 0);
    assert.match(result.error ?? "", /no ownership record/);
    assert.equal(startedMockPiPids(mockPi).length, 0, "Pi must not be spawned");
    assert.equal(readSessionRecord(sessionFile).status, "missing", "no record is invented");
  });

  it("refuses a dangling final-component symlink and never gives two leases", () => {
    const root = createTempDir("tlh-lease-symlink-");
    tempDirs.push(root);
    const target = path.join(root, "target.jsonl");
    const alias = path.join(root, "alias.jsonl");
    fs.symlinkSync(target, alias);
    const viaTarget = openAttemptSessionLease(target, "run-a");
    assert.equal(viaTarget.ok, true);
    const viaAlias = openAttemptSessionLease(alias, "run-b");
    assert.equal(viaAlias.ok, false);
    assert.equal(fs.existsSync(`${alias}.owner.json`), false, "no alias record is created");
  });

  it("creates the record for a not-yet-written file and reuses it once Pi wrote it", async () => {
    mockPi.onCall({ output: "ok" });
    mockPi.onCall({ output: "ok" });
    const root = createTempDir("tlh-lease-resume-");
    tempDirs.push(root);
    const sessionFile = path.join(root, "sessions", "preassigned.jsonl");
    for (const id of ["first", "second"]) {
      const result = await runSingleStep(
        makeRunnerStep("worker", "Go.", { sessionFile }),
        stepContext(root, id),
        () => undefined,
      );
      assert.equal(result.exitCode, 0, result.error ?? "");
      fs.writeFileSync(sessionFile, "{}\n"); // Pi creates the file lazily
    }
    const final = okRecord(sessionFile);
    assert.equal(final.generation, 2);
    assert.equal(final.latestRunId, "second");
    assert.equal(final.lease, undefined);
  });

  it("leaves the lease held when the final write fails", async () => {
    const root = createTempDir("tlh-lease-final-fail-");
    tempDirs.push(root);
    const sessionFile = path.join(root, "sessions", "final.jsonl");
    const opened = openAttemptSessionLease(sessionFile, "run");
    assert.ok(opened.ok);
    const dir = path.dirname(sessionFile);
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    fs.chmodSync(dir, 0o500);
    let finished;
    try {
      finished = opened.lease.finish({ activeRuntimeMs: 1 });
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    assert.equal(finished.released, false);
    assert.equal(acquireSessionLease(sessionFile, { runnerPid: process.pid }).status, "held");
  });

  it("does not release while a recorded child group is still running", () => {
    const root = createTempDir("tlh-lease-group-alive-");
    tempDirs.push(root);
    const sessionFile = path.join(root, "sessions", "group.jsonl");
    const opened = openAttemptSessionLease(sessionFile, "run", { kill: () => true });
    assert.ok(opened.ok);
    opened.lease.recordProcessGroup(4_000_000);
    const finished = opened.lease.finish({ activeRuntimeMs: 1 });
    assert.equal(finished.released, false);
    assert.match(finished.reason ?? "", /child process group is still running/);
    assert.ok(okRecord(sessionFile).lease);
    assert.equal(okRecord(sessionFile).cleanFinal, undefined);
  });

  it(
    "kills the child and fails the attempt when recording its group fails",
    { timeout: scaleTestTimeout(30_000) },
    async () => {
      const root = createTempDir("tlh-lease-record-fail-");
      tempDirs.push(root);
      let groupId: number | undefined;
      const previous = process.env.PI_SUBAGENT_PI_BINARY;
      process.env.PI_SUBAGENT_PI_BINARY = process.execPath;
      try {
        const result = await runPiStreaming(
          ["-e", "setTimeout(() => {}, 30000)"],
          root,
          path.join(root, "out.log"),
          () => undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          {
            restored: false,
            onChildSpawned: (id) => {
              groupId = id;
              throw new Error("record write failed");
            },
          },
        );
        assert.match(
          result.error ?? "",
          /Failed to record child process group: record write failed/,
        );
        assert.ok(groupId);
        await waitFor("child group gone", () => !groupAlive(groupId!));
      } finally {
        if (previous === undefined) delete process.env.PI_SUBAGENT_PI_BINARY;
        else process.env.PI_SUBAGENT_PI_BINARY = previous;
        if (groupId) {
          try {
            process.kill(-groupId, "SIGKILL");
          } catch {
            void 0;
          }
        }
      }
    },
  );

  it(
    "reports held while a SIGKILLed runner's child group lives, abandoned after it exits",
    { timeout: scaleTestTimeout(30_000) },
    async () => {
      if (process.platform === "win32") return;
      const root = createTempDir("tlh-lease-fault-");
      tempDirs.push(root);
      const sessionFile = path.join(root, "sessions", "fault.jsonl");
      const pidFile = path.join(root, "child.pid");
      const { PI_SUBAGENT_PI_BINARY: _binary, ...env } = process.env;
      const runner = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          "--no-warnings",
          HELPER,
          sessionFile,
          pidFile,
          path.join(root, "out.log"),
        ],
        { env, stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      runner.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      let childPid: number | undefined;
      try {
        await waitFor("child group recorded in the lease", () => {
          if (runner.exitCode !== null) assert.fail(`helper exited early: ${stderr}`);
          if (!fs.existsSync(pidFile)) return false;
          childPid = Number(fs.readFileSync(pidFile, "utf-8"));
          const read = readSessionRecord(sessionFile);
          return (
            read.status === "ok" && read.record.lease?.processGroups.includes(childPid) === true
          );
        });
        const exited = new Promise((resolve) => runner.once("exit", resolve));
        runner.kill("SIGKILL");
        await exited;

        const held = acquireSessionLease(sessionFile, { runnerPid: process.pid });
        assert.equal(held.status, "held");
        assert.ok(groupAlive(childPid!));

        process.kill(-childPid!, "SIGKILL");
        await waitFor("child group gone", () => !groupAlive(childPid!));
        const abandoned = acquireSessionLease(sessionFile, { runnerPid: process.pid });
        assert.equal(abandoned.status, "abandoned");
      } finally {
        if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL");
        if (childPid) {
          try {
            process.kill(-childPid, "SIGKILL");
          } catch {
            void 0;
          }
        }
      }
    },
  );
  describe("runner signalled while a child runs", () => {
    it("signal helper fails closed without the mock Pi environment", () => {
      const root = createTempDir("tlh-lease-guard-");
      tempDirs.push(root);
      const sessionDir = path.join(root, "sessions");
      const base = { ...process.env };
      delete base.MOCK_PI_QUEUE_DIR;
      delete base.TLH_TEST_PI_ARGV1;
      delete base.PI_SUBAGENT_PI_BINARY;
      const envs: NodeJS.ProcessEnv[] = [
        base,
        { ...base, MOCK_PI_QUEUE_DIR: mockPi.dir },
        { ...base, TLH_TEST_PI_ARGV1: process.argv[1]! },
        { ...base, MOCK_PI_QUEUE_DIR: mockPi.dir, TLH_TEST_PI_ARGV1: process.execPath },
        {
          ...base,
          MOCK_PI_QUEUE_DIR: mockPi.dir,
          TLH_TEST_PI_ARGV1: process.argv[1]!,
          PI_SUBAGENT_PI_BINARY: process.execPath,
        },
      ];
      for (const env of envs) {
        const run = spawnSync(
          process.execPath,
          [
            "--experimental-strip-types",
            "--no-warnings",
            SIGNAL_HELPER,
            sessionDir,
            path.join(root, "out.log"),
          ],
          { env, encoding: "utf-8", timeout: scaleTestTimeout(15_000) },
        );
        assert.equal(run.status, 2, run.stderr);
        assert.match(run.stderr, /not a mock Pi environment/);
      }
      assert.equal(fs.existsSync(sessionDir), false, "no session or lease was created");
      assert.equal(startedMockPiPids(mockPi).length, 0, "no child was spawned");
    });

    async function startSignalRunner(root: string) {
      const sessionDir = path.join(root, "sessions");
      const runner = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          "--no-warnings",
          SIGNAL_HELPER,
          sessionDir,
          path.join(root, "out.log"),
        ],
        {
          env: { ...envWithoutPiBinary(), TLH_TEST_PI_ARGV1: process.argv[1] },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let stderr = "";
      runner.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      let sessionFile: string | undefined;
      await waitFor("child group recorded in the lease", () => {
        if (runner.exitCode !== null) assert.fail(`helper exited early: ${stderr}`);
        const file = fs.existsSync(sessionDir)
          ? fs.readdirSync(sessionDir).find((n) => n.endsWith(".owner.json"))
          : undefined;
        if (!file) return false;
        sessionFile = path.join(sessionDir, file.replace(/\.owner\.json$/, ""));
        const read = readSessionRecord(sessionFile);
        return read.status === "ok" && (read.record.lease?.processGroups.length ?? 0) > 0;
      });
      // The mock installs its signal handlers before publishing its call record.
      await waitForMockPiCall(mockPi, 0);
      const exited = new Promise<void>((resolve) => runner.once("exit", () => resolve()));
      return { runner, sessionFile: sessionFile!, exited };
    }

    function killAll(runner: { kill(s: NodeJS.Signals): boolean; exitCode: number | null }) {
      if (runner.exitCode === null) runner.kill("SIGKILL");
      for (const pid of startedMockPiPids(mockPi)) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          void 0;
        }
      }
    }

    it(
      "finishes and releases the lease on a single SIGTERM",
      { timeout: scaleTestTimeout(30_000) },
      async () => {
        if (process.platform === "win32") return;
        mockPi.onCall({ delay: 60_000 });
        const root = createTempDir("tlh-lease-sigterm-");
        tempDirs.push(root);
        const { runner, sessionFile, exited } = await startSignalRunner(root);
        try {
          const startedAt = Date.now();
          await new Promise((resolve) => setTimeout(resolve, 300));
          runner.kill("SIGTERM");
          await exited;
          const elapsed = Date.now() - startedAt;
          const final = okRecord(sessionFile);
          assert.equal(final.lease, undefined);
          assert.equal(final.cleanFinal?.generation, final.generation);
          assert.ok(final.activeRuntimeMs >= 250, `runtime ${final.activeRuntimeMs}`);
          assert.ok(final.activeRuntimeMs <= elapsed + 5_000);
          assert.equal(
            acquireSessionLease(sessionFile, { runnerPid: process.pid }).status,
            "acquired",
          );
        } finally {
          killAll(runner);
        }
      },
    );

    it(
      "writes the latest context usage on SIGTERM before any runtime checkpoint",
      { timeout: scaleTestTimeout(30_000) },
      async () => {
        if (process.platform === "win32") return;
        mockPi.onCall({
          steps: [
            {
              jsonl: [
                {
                  type: "message_end",
                  message: {
                    role: "assistant",
                    content: [{ type: "toolCall", id: "t", name: "x", arguments: {} }],
                    stopReason: "toolUse",
                    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 4321 },
                  },
                },
              ],
            },
            { delay: 60_000 },
          ],
        });
        const root = createTempDir("tlh-lease-sigterm-ctx-");
        tempDirs.push(root);
        const { runner, sessionFile, exited } = await startSignalRunner(root);
        try {
          // Let the child event arrive; the first interval checkpoint is far later.
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          assert.equal(okRecord(sessionFile).contextUsage, undefined);
          runner.kill("SIGTERM");
          await exited;
          const final = okRecord(sessionFile);
          assert.equal(final.lease, undefined);
          assert.equal(final.contextUsage?.usage.contextTokens, 4321);
        } finally {
          killAll(runner);
        }
      },
    );

    it(
      "leaves the lease held, then abandoned, when a second signal escalates",
      { timeout: scaleTestTimeout(30_000) },
      async () => {
        if (process.platform === "win32") return;
        mockPi.onCall({
          delay: 60_000,
          ignoreSigint: true,
          ignoreSigterm: true,
        });
        const root = createTempDir("tlh-lease-sigterm2-");
        tempDirs.push(root);
        const { runner, sessionFile, exited } = await startSignalRunner(root);
        try {
          runner.kill("SIGTERM");
          await new Promise((resolve) => setTimeout(resolve, 100));
          runner.kill("SIGTERM");
          await exited;
          const record = okRecord(sessionFile);
          assert.ok(record.lease, "escalation leaves the lease held");
          assert.equal(record.cleanFinal, undefined);
          const pid = startedMockPiPids(mockPi)[0]!;
          await waitFor("child group gone", () => !groupAlive(pid));
          assert.equal(
            acquireSessionLease(sessionFile, { runnerPid: process.pid }).status,
            "abandoned",
          );
        } finally {
          killAll(runner);
        }
      },
    );
  });
});

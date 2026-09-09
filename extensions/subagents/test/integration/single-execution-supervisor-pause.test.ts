/**
 * Integration tests for foreground interruption and supervisor pause behavior.
 *
 * These tests use the local createMockPi() helper to exercise the pause and
 * interruption paths in runSync without a real LLM.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import {
  createMockPi,
  createTempDir,
  createEventBus,
  removeTempDir,
  makeAgentConfigs,
  makeAgent,
  makeMinimalCtx,
  events,
  tryImport,
} from "../support/helpers.ts";

interface RunSyncResult {
  exitCode: number;
  error?: string;
  finalOutput?: string;
  interrupted?: boolean;
  timedOut?: boolean;
  terminationReason?: string;
  progress: {
    status: string;
    activityState?: string;
    error?: string;
  };
  pause?: {
    kind?: string;
    ownerPid?: number;
    pausedAt?: number;
    request?: {
      tool?: string;
      reason?: string;
      summary?: string;
    };
  };
  artifactPaths?: {
    outputPath: string;
    metadataPath: string;
  };
  acceptance?: {
    status?: string;
    runtimeChecks?: Array<{ id?: string; status?: string }>;
    verifyRuns?: Array<{ status?: string }>;
  };
  processCleanup?: {
    terminated?: boolean;
    signals?: string[];
    processGroupId?: number;
  };
}

interface ExecutionModule {
  runSync(
    runtimeCwd: string,
    agents: ReturnType<typeof makeAgentConfigs>,
    agentName: string,
    task: string,
    options: Record<string, unknown>,
  ): Promise<RunSyncResult>;
}

interface ExecutorToolResult {
  content: Array<{ text?: string }>;
  isError?: boolean;
}

interface ExecutorModule {
  createSubagentExecutor?: (...args: unknown[]) => {
    execute: (...args: unknown[]) => Promise<ExecutorToolResult>;
  };
}

type ExecuteAsyncSingleOverride = (
  id: string,
  params: Record<string, unknown>,
) => ExecutorToolResult;

const execution = await tryImport<ExecutionModule>("./src/runs/foreground/execution.ts");
const utils = await tryImport<unknown>("./src/shared/utils.ts");
const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const available = !!(execution && utils);

const runSync = execution?.runSync;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellQuote(value: string): string {
  if (process.platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function waitForMarker(markerPath: string, timeoutMs = 10_000): Promise<void> {
  if (fs.existsSync(markerPath)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watcher: fs.FSWatcher | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      watcher?.close();
    };
    const complete = () => {
      if (!fs.existsSync(markerPath)) return;
      cleanup();
      resolve();
    };
    watcher = fs.watch(path.dirname(markerPath), complete);
    watcher.on("error", (error) => {
      cleanup();
      reject(error);
    });
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for marker: ${markerPath}`));
    }, timeoutMs);
    complete();
  });
}

async function waitForPidExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for verifier pid ${pid} to exit`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe(
  "single sync execution",
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
      tempDir = createTempDir();
      mockPi.reset();
    });

    afterEach(() => {
      removeTempDir(tempDir);
    });

    function makeExecutor(
      agents = [makeAgent("echo")],
      config: Record<string, unknown> = {},
      state = {
        baseCwd: tempDir,
        currentSessionId: null,
        asyncJobs: new Map(),
        foregroundRuns: new Map(),
        foregroundControls: new Map(),
        lastForegroundControlId: null,
      },
      runSyncOverride: ExecutionModule["runSync"] | undefined = runSync,
      executeAsyncSingleOverride: ExecuteAsyncSingleOverride | undefined = undefined,
    ) {
      return createSubagentExecutor!({
        pi: { events: createEventBus(), getSessionName: () => undefined },
        state,
        config,
        tempArtifactsDir: tempDir,
        getSubagentSessionRoot: () => tempDir,
        expandTilde: (value: string) => value,
        discoverAgents: () => ({ agents }),
        runSync: runSyncOverride,
        executeAsyncSingle: executeAsyncSingleOverride,
      });
    }

    it("interrupts acceptance verification and returns a paused foreground result", async () => {
      const report = [
        "done",
        "```acceptance-report",
        JSON.stringify({
          criteriaSatisfied: [
            { id: "criterion-1", status: "satisfied", evidence: "integration test evidence" },
          ],
          changedFiles: ["src/a.ts"],
          testsAddedOrUpdated: ["test/a.test.ts"],
          commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
          validationOutput: ["validation passed"],
          residualRisks: [],
          noStagedFiles: true,
          notes: "complete",
        }),
        "```",
      ].join("\n");
      mockPi.onCall({ jsonl: [events.assistantMessage(report)] });
      const agents = makeAgentConfigs(["slow"]);
      const controller = new AbortController();
      const verificationStartedMarker = path.join(tempDir, "acceptance-verification-started");
      const verificationPidMarker = path.join(tempDir, "acceptance-verification-pid");
      const verificationCleanupMarker = path.join(tempDir, "acceptance-verification-cleaned");
      const verificationScriptPath = path.join(tempDir, "acceptance-verification-child.cjs");
      fs.writeFileSync(
        verificationScriptPath,
        [
          "const fs = require('node:fs');",
          "const pidPath = process.env.VERIFICATION_PID;",
          "const startedPath = process.env.VERIFICATION_STARTED;",
          "const cleanupPath = process.env.VERIFICATION_CLEANED;",
          "let cleanupMarked = false;",
          "const markCleanup = () => {",
          "  if (cleanupMarked) return;",
          "  cleanupMarked = true;",
          "  fs.writeFileSync(cleanupPath, String(process.pid));",
          "};",
          "process.once('SIGTERM', () => { markCleanup(); process.exit(0); });",
          "process.once('exit', markCleanup);",
          "fs.writeFileSync(pidPath, String(process.pid));",
          "fs.writeFileSync(startedPath, 'started');",
          "setTimeout(() => process.exit(0), 5000);",
        ].join("\n"),
        "utf-8",
      );
      const verificationCommand = [
        ...(process.platform === "win32" ? [] : ["exec"]),
        shellQuote(process.execPath),
        shellQuote(verificationScriptPath),
      ].join(" ");
      const acceptanceArtifactsDir = path.join(tempDir, "artifacts-acceptance-interrupt");
      let verificationPid: number | undefined;
      const reapVerification = async (): Promise<void> => {
        if (verificationPid === undefined) return;
        try {
          process.kill(verificationPid, "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        await waitForPidExit(verificationPid);
      };
      const resultPromise = runSync(tempDir, agents, "slow", "Slow task", {
        runId: "acceptance-interrupt-metadata",
        artifactsDir: acceptanceArtifactsDir,
        artifactConfig: { enabled: true, includeOutput: true, includeMetadata: true },
        interruptSignal: controller.signal,
        acceptance: {
          level: "verified",
          verify: [
            {
              id: "slow",
              command: verificationCommand,
              env: {
                VERIFICATION_STARTED: verificationStartedMarker,
                VERIFICATION_PID: verificationPidMarker,
                VERIFICATION_CLEANED: verificationCleanupMarker,
              },
              timeoutMs: 10_000,
            },
          ],
        },
      });
      const resultSettlement = resultPromise.then(
        (result) => ({ status: "fulfilled" as const, result }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );

      try {
        await waitForMarker(verificationStartedMarker);
        await waitForMarker(verificationPidMarker);
        verificationPid = Number(fs.readFileSync(verificationPidMarker, "utf-8"));
        assert.ok(Number.isInteger(verificationPid) && verificationPid > 0);
        controller.abort();
        const settledResult = await resultSettlement;
        if (settledResult.status === "rejected") throw settledResult.error;
        const result = settledResult.result;

        await reapVerification();
        await waitForMarker(verificationCleanupMarker);
        assert.equal(fs.readFileSync(verificationCleanupMarker, "utf-8"), String(verificationPid));
        assert.throws(
          () => process.kill(verificationPid!, 0),
          (error: unknown) => {
            return (error as NodeJS.ErrnoException).code === "ESRCH";
          },
        );
        assert.equal(result.exitCode, 0);
        assert.equal(result.interrupted, true);
        assert.equal(result.error, undefined);
        assert.equal(result.progress.status, "completed");
        assert.equal(result.progress.error, undefined);
        assert.equal(result.progress.activityState, undefined);
        assert.equal(result.acceptance?.status, "skipped");
        assert.equal(result.acceptance?.runtimeChecks?.[0]?.id, "paused");
        assert.equal(result.acceptance?.verifyRuns?.[0]?.status, undefined);
        assert.equal(result.finalOutput, "Interrupted. Waiting for explicit next action.");
        assert.ok(result.artifactPaths?.outputPath);
        const artifactText = fs.readFileSync(result.artifactPaths.outputPath, "utf-8");
        assert.equal(
          artifactText,
          [
            "done",
            "",
            "---",
            "Validation evidence (from acceptance report):",
            "",
            "  [passed] npm test — passed",
            "---",
          ].join("\n"),
        );
        assert.ok(result.artifactPaths?.metadataPath);
        const metadata = JSON.parse(
          fs.readFileSync(result.artifactPaths.metadataPath, "utf-8"),
        ) as {
          exitCode?: number;
          error?: string;
          terminationReason?: string;
        };
        // Acceptance interruption happens after the initial child finalization; the
        // metadata must agree with the final returned result, not the pre-acceptance snapshot.
        assert.equal(metadata.exitCode, result.exitCode);
        assert.equal(metadata.error, result.error);
        assert.equal(metadata.terminationReason, result.terminationReason);
        assert.equal(result.terminationReason, "interrupted");
      } finally {
        controller.abort();
        await resultSettlement;
        await reapVerification().catch(() => undefined);
      }
    });

    it("soft-interrupts the current turn and returns a paused result", async () => {
      mockPi.onCall({ delay: 10000 });
      const agents = makeAgentConfigs(["slow"]);
      const controller = new AbortController();
      const controlEvents: Array<{ type?: string; to?: string }> = [];

      const start = Date.now();
      setTimeout(() => controller.abort(), 200);

      const result = await runSync(tempDir, agents, "slow", "Slow task", {
        runId: "interrupt-run",
        interruptSignal: controller.signal,
        acceptance: { level: "checked", criteria: ["Finish the slow task"] },
        onControlEvent: (event: { type?: string; to?: string }) => {
          controlEvents.push(event);
        },
      });
      const elapsed = Date.now() - start;

      assert.ok(elapsed < 5000, `should interrupt early, took ${elapsed}ms`);
      assert.equal(result.exitCode, 0);
      assert.equal(result.interrupted, true);
      assert.equal(result.progress.activityState, undefined);
      assert.equal(result.acceptance?.status, "skipped");
      assert.equal(result.acceptance?.runtimeChecks?.[0]?.id, "paused");
      assert.equal(result.acceptance?.runtimeChecks?.[0]?.status, "not-applicable");
      assert.deepEqual(controlEvents, []);
      assert.match(result.finalOutput ?? "", /Interrupted/);
    });

    it(
      "returns paused foreground single guidance with resume and redispatch commands",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        mockPi.onCall({ delay: 10000 });
        const state = {
          baseCwd: tempDir,
          currentSessionId: null,
          asyncJobs: new Map(),
          foregroundRuns: new Map(),
          foregroundControls: new Map(),
          lastForegroundControlId: null,
        };
        const executor = makeExecutor([makeAgent("slow")], {}, state);
        const runPromise = executor.execute(
          "single-pause-run",
          { agent: "slow", task: "Slow task" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        const readyDeadline = Date.now() + 5000;
        while (Date.now() < readyDeadline) {
          if (
            mockPi.callCount() === 1 &&
            typeof (
              [...state.foregroundControls.values()][0] as { interrupt?: unknown } | undefined
            )?.interrupt === "function"
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(mockPi.callCount(), 1);

        const interruptResult = await executor.execute(
          "single-pause-interrupt",
          { action: "interrupt" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        assert.match(
          interruptResult.content[0]?.text ?? "",
          /Interrupt requested for foreground run/,
        );

        const result = await runPromise;
        const text = result.content[0]?.text ?? "";
        assert.equal(result.isError, undefined);
        assert.match(text, /^Foreground run [a-z0-9-]+ paused after interrupt \(slow\)\./);
        assert.match(
          text,
          /Pause succeeded; this foreground run is paused and waiting for your explicit next action, not a dispatch error\./,
        );
        assert.match(
          text,
          /Resume: subagent\(\{ action: "resume", id: "[a-z0-9-]+", message: "\.\.\." \}\)/,
        );
        assert.match(text, /Replace\/re-dispatch: subagent\(\{ agent: "slow", task: "\.\.\." \}\)/);
      },
    );

    it("preserves manual interrupt semantics when a timeout is also configured", async () => {
      mockPi.onCall({ delay: 10000 });
      const agents = makeAgentConfigs(["slow"]);
      const controller = new AbortController();

      setTimeout(() => controller.abort(), 100);
      const result = await runSync(tempDir, agents, "slow", "Slow task", {
        interruptSignal: controller.signal,
        timeoutMs: 500,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.interrupted, true);
      assert.equal(result.timedOut, undefined);
      assert.equal(result.error, undefined);
      assert.match(result.finalOutput ?? "", /Interrupted/);
    });

    for (const testCase of [
      {
        name: "contact_supervisor need_decision",
        toolName: "contact_supervisor",
        args: { reason: "need_decision", message: "Need a decision" },
      },
      {
        name: "contact_supervisor interview_request",
        toolName: "contact_supervisor",
        args: { reason: "interview_request", message: "Need input", interview: { questions: [] } },
      },
    ]) {
      it(`pauses foreground children on blocking ${testCase.name}`, async () => {
        mockPi.onCall({
          steps: [
            { jsonl: [events.toolStart(testCase.toolName, testCase.args)] },
            { delay: 1000, jsonl: [events.assistantMessage("received pong")] },
          ],
        });
        const agents = makeAgentConfigs(["echo"]);

        const result = await runSync(tempDir, agents, "echo", "Task", {
          runId: `${testCase.toolName}-blocking-detach`,
          pauseBlockingSupervisor: true,
        });

        assert.equal(result.exitCode, 0);
        assert.equal(result.interrupted, true);
        assert.equal(result.pause?.kind, "awaiting_supervisor");
        assert.equal(result.pause?.ownerPid, undefined);
        if (testCase.args.reason === "interview_request") {
          assert.deepEqual(result.pause?.request, {
            tool: "contact_supervisor",
            reason: "interview_request",
            summary: "Need input",
          });
          assert.equal(JSON.stringify(result.pause?.request).includes("questions"), false);
        } else {
          assert.deepEqual(result.pause?.request, {
            tool: "contact_supervisor",
            reason: "need_decision",
            summary: "Need a decision",
          });
        }
        assert.match(
          result.finalOutput ?? "",
          /Resume unchanged: subagent\(\{ action: "resume", id: "/,
        );
        assert.match(result.finalOutput ?? "", /No child process is running\./);
        assert.match(result.finalOutput ?? "", /Cancel: subagent\(\{ action: "interrupt", id: /);
      });
    }

    it(
      "reaps stubborn child and grandchild through the full owned-group escalation before publishing paused",
      {
        skip: process.platform === "win32" ? "POSIX process groups are unavailable" : undefined,
      },
      async () => {
        mockPi.onCall({
          ignoreSigint: true,
          ignoreSigterm: true,
          spawnStubbornDescendants: true,
          steps: [
            {
              delay: 250,
              jsonl: [
                events.toolStart("contact_supervisor", {
                  reason: "need_decision",
                  message: "Need a decision",
                }),
              ],
            },
            { delay: 10_000, jsonl: [events.assistantMessage("should not complete")] },
          ],
        });
        const agents = makeAgentConfigs(["echo"]);
        const result = await runSync(tempDir, agents, "echo", "Task", {
          runId: "stubborn-owned-group-pause",
          pauseBlockingSupervisor: true,
        });

        assert.equal(result.pause?.kind, "awaiting_supervisor");
        assert.equal(result.processCleanup?.terminated, true);
        assert.deepEqual(result.processCleanup?.signals, ["SIGINT", "SIGTERM", "SIGKILL"]);
        const parentPid = result.processCleanup?.processGroupId;
        assert.ok(parentPid, "expected owned process group id from this spawn");
        const signalLog = fs.readFileSync(
          path.join(mockPi.dir, `signals-${parentPid}.jsonl`),
          "utf-8",
        );
        assert.match(signalLog, /SIGINT/);
        assert.match(signalLog, /SIGTERM/);
        const descendants = JSON.parse(
          fs.readFileSync(path.join(mockPi.dir, `descendants-${parentPid}.json`), "utf-8"),
        ) as { childPid: number; grandchildPid: number };
        for (const pid of [parentPid, descendants.childPid, descendants.grandchildPid]) {
          assert.throws(() => process.kill(pid, 0), /ESRCH/);
        }
      },
    );

    it("persists supervisor pause transitions before signaling and clears owned pid after close", async () => {
      mockPi.onCall({
        steps: [
          {
            jsonl: [
              events.toolStart("contact_supervisor", {
                reason: "need_decision",
                message: "Need a decision",
              }),
            ],
          },
          { delay: 1000, jsonl: [events.assistantMessage("received pong")] },
        ],
      });
      const agents = makeAgentConfigs(["echo"]);
      const transitions: Array<{
        stage: "pausing" | "paused";
        ownerPid?: number;
        result: RunSyncResult;
      }> = [];

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "pause-ordering",
        pauseBlockingSupervisor: true,
        onSupervisorPauseTransition: (transition: unknown) => {
          transitions.push(
            transition as { stage: "pausing" | "paused"; ownerPid?: number; result: RunSyncResult },
          );
        },
      });

      assert.equal(result.exitCode, 0);
      assert.deepEqual(
        transitions.map((entry) => entry.stage),
        ["pausing", "paused"],
      );
      assert.equal(typeof transitions[0]?.ownerPid, "number");
      assert.ok((transitions[0]?.ownerPid ?? 0) > 0);
      assert.equal(transitions[0]?.result.pause?.ownerPid, transitions[0]?.ownerPid);
      assert.equal(transitions[1]?.result.pause?.ownerPid, undefined);
      assert.equal(typeof transitions[1]?.result.pause?.pausedAt, "number");
      assert.equal(result.pause?.ownerPid, undefined);
    });

    it("fails explicitly when pre-signal supervisor pause persistence fails", async () => {
      mockPi.onCall({
        steps: [
          {
            jsonl: [
              events.toolStart("contact_supervisor", {
                reason: "need_decision",
                message: "Need a decision",
              }),
            ],
          },
          { delay: 1000, jsonl: [events.assistantMessage("received pong")] },
        ],
      });
      const agents = makeAgentConfigs(["echo"]);

      const secret = "/private/root/pause-persist-secret";
      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "pause-persist-fails",
        pauseBlockingSupervisor: true,
        onSupervisorPauseTransition: ({ stage }: { stage: string }) => {
          if (stage === "pausing") throw new Error(`pause persistence failed at ${secret}`);
        },
      });

      assert.equal(result.exitCode, 1);
      assert.equal(result.pause, undefined);
      assert.equal(result.interrupted, false);
      assert.match(result.error ?? "", /Foreground supervisor lifecycle update failed/);
      assert.match(result.finalOutput ?? "", /Foreground supervisor lifecycle update failed/);
      assert.doesNotMatch(result.finalOutput ?? "", new RegExp(escapeRegExp(secret)));
      assert.equal(result.progress.status, "failed");
    });

    it("fails explicitly when post-reap supervisor pause finalization fails", async () => {
      mockPi.onCall({
        steps: [
          {
            jsonl: [
              events.toolStart("contact_supervisor", {
                reason: "need_decision",
                message: "Need a decision",
              }),
            ],
          },
          { delay: 1000, jsonl: [events.assistantMessage("received pong")] },
        ],
      });
      const agents = makeAgentConfigs(["echo"]);
      const secret = "/private/root/pause-finalize-secret";
      const runPromise = runSync(tempDir, agents, "echo", "Task", {
        runId: "pause-finalize-fails",
        pauseBlockingSupervisor: true,
        onSupervisorPauseTransition: ({ stage }: { stage: string }) => {
          if (stage === "paused") throw new Error(`pause finalization failed at ${secret}`);
        },
      });

      const callDeadline = Date.now() + 5_000;
      let childPid: number | undefined;
      while (Date.now() < callDeadline && childPid === undefined) {
        const callFiles = fs
          .readdirSync(mockPi.dir)
          .filter((name) => name.startsWith("call-") && name.endsWith(".json"))
          .sort();
        const match = callFiles.at(-1)?.match(/^call-\d+-(\d+)-/);
        if (match) childPid = Number(match[1]);
        if (childPid === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const result = await runPromise;

      assert.ok(childPid, "expected mock child pid");
      assert.throws(() => process.kill(childPid!, 0), /ESRCH/);
      assert.equal(result.exitCode, 1);
      assert.equal(result.pause, undefined);
      assert.equal(result.interrupted, false);
      assert.match(result.error ?? "", /Foreground supervisor lifecycle update failed/);
      assert.match(result.finalOutput ?? "", /Foreground supervisor lifecycle update failed/);
      assert.doesNotMatch(result.finalOutput ?? "", new RegExp(escapeRegExp(secret)));
      assert.doesNotMatch(result.finalOutput ?? "", /Resume unchanged|awaiting supervisor/);
      assert.equal(result.progress.status, "failed");
    });

    for (const testCase of [
      {
        name: "contact_supervisor progress_update",
        toolName: "contact_supervisor",
        args: { reason: "progress_update", message: "FYI" },
      },
    ]) {
      it(`does not proactively detach foreground children on non-blocking ${testCase.name}`, async () => {
        mockPi.onCall({
          steps: [
            { jsonl: [events.toolStart(testCase.toolName, testCase.args)] },
            { jsonl: [events.toolEnd(testCase.toolName)] },
            { jsonl: [events.assistantMessage("done")] },
          ],
        });
        const agents = makeAgentConfigs(["echo"]);

        const result = await runSync(tempDir, agents, "echo", "Task", {
          runId: `${testCase.toolName}-nonblocking`,
        });

        assert.equal(result.exitCode, 0);
        assert.equal(result.finalOutput, "done");
        assert.equal(result.progress?.status, "completed");
      });
    }
  },
);

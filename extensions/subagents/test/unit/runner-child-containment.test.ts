import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { runSingleStep } from "../../src/runs/background/single-step-execution.ts";
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

const HELPER = path.resolve(import.meta.dirname, "../support/live-child-crash-runner.ts");

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

function groupAlive(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Bounded wait until no process remains in the process group. */
async function waitForGroupGone(groupId: number, label: string): Promise<void> {
  const deadline = Date.now() + scaleTestTimeout(10_000);
  while (groupAlive(groupId)) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label} (group ${groupId})`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("runner containment of live child process groups", () => {
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

  it(
    "fails the run and kills the child group when a child-event status write throws ENOSPC",
    { timeout: scaleTestTimeout(30_000) },
    async () => {
      mockPi.onCall({
        jsonl: [{ type: "tool_execution_start", toolName: "read", args: { path: "a.txt" } }],
        ignoreSigint: true,
        ignoreSigterm: true,
        keepAliveAfterFinalMessageMs: 60_000,
      });
      const root = createTempDir("tlh-child-event-enospc-");
      tempDirs.push(root);
      let writes = 0;

      const pending = runSingleStep(
        makeRunnerStep("worker", "Emit a tool event."),
        {
          cwd: root,
          sessionEnabled: false,
          artifactConfig,
          id: "child-event-enospc",
          flatIndex: 0,
          flatStepCount: 1,
          outputFile: path.join(root, "output.log"),
          startedAt: Date.now(),
          onChildEvent: () => {
            writes += 1;
            throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
              code: "ENOSPC",
            });
          },
        },
        () => undefined,
      );
      let result: Awaited<typeof pending> | undefined;
      try {
        await waitForMockPiCall(mockPi, 0);
        result = await pending;
      } finally {
        // Fixture cleanup on every path, including a failed assertion above.
        for (const pid of startedMockPiPids(mockPi)) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            void 0;
          }
        }
      }

      assert.equal(writes, 1, "later events must not retry the failing write");
      assert.notEqual(result.exitCode, 0);
      assert.match(result.error ?? "", /Failed to persist child event: ENOSPC/);
      const childPid = startedMockPiPids(mockPi)[0]!;
      await waitForGroupGone(childPid, "child process group");
    },
  );

  it(
    "kills live owned child groups when the runner dies from an uncaught error",
    { timeout: scaleTestTimeout(30_000) },
    async () => {
      const root = createTempDir("tlh-uncaught-runner-");
      tempDirs.push(root);
      const pidFile = path.join(root, "child.pid");
      const { PI_SUBAGENT_PI_BINARY: _binary, ...env } = process.env;
      const runner = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          "--no-warnings",
          HELPER,
          pidFile,
          path.join(root, "out.log"),
        ],
        { env, stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      runner.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const exited = new Promise<number | null>((resolve) => runner.once("exit", resolve));
      let childPid: number | undefined;
      try {
        const code = await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error("runner did not exit")),
              scaleTestTimeout(15_000),
            );
            timer.unref();
          }),
        ]);
        assert.notEqual(code, 0);
        assert.match(stderr, /simulated uncaught runner failure/);
        childPid = Number(fs.readFileSync(pidFile, "utf-8"));
        assert.ok(childPid > 0);
        await waitForGroupGone(childPid, "orphaned child process group");
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
});

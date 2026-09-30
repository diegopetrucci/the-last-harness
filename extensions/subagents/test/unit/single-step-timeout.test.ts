import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import * as path from "node:path";
import { runSingleStep } from "../../src/runs/background/single-step-execution.ts";
import type { ResolvedArtifactConfig } from "../../src/shared/types.ts";
import {
  createMockPi,
  createTempDir,
  makeRunnerStep,
  removeTempDir,
  type MockPi,
} from "../support/helpers.ts";

const terminalArtifactConfig: ResolvedArtifactConfig = {
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

describe("single-step timeout persistence hardening", () => {
  let mockPi: MockPi;
  let tempDirs: string[];

  before(() => {
    mockPi = createMockPi();
    mockPi.install();
  });

  after(() => {
    mockPi.uninstall();
  });

  beforeEach(() => {
    mockPi.reset();
    tempDirs = [];
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) removeTempDir(dir);
  });

  it(
    "still aborts and terminates the child when timeout recording throws",
    { timeout: 5_000 },
    async () => {
      mockPi.onCall({ delay: 2_000 });
      const root = createTempDir("tlh-timeout-persistence-failure-");
      tempDirs.push(root);
      const timeoutMs = 250;
      let timeoutRecordCalls = 0;
      const startedAt = Date.now();

      const result = await runSingleStep(
        makeRunnerStep("slow", "Wait for the timeout.", {
          timeoutMs,
          timeoutOwner: "role",
        }),
        {
          cwd: root,
          sessionEnabled: false,
          artifactConfig: terminalArtifactConfig,
          id: "timeout-persistence-failure",
          flatIndex: 0,
          flatStepCount: 1,
          outputFile: path.join(root, "output.log"),
          startedAt,
          onTimeout: () => {
            timeoutRecordCalls += 1;
            throw new Error("status persistence failed");
          },
        },
        () => undefined,
      );

      assert.equal(timeoutRecordCalls, 1);
      assert.equal(result.timedOut, true);
      assert.equal(result.terminationReason, "timed_out");
      assert.equal(result.error, `Subagent timed out after ${timeoutMs}ms.`);
      assert.ok(
        Date.now() - startedAt < 1_500,
        "timeout cleanup should terminate the delayed child instead of waiting for it",
      );
    },
  );
});

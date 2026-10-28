import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildAsyncRunnerPlan } from "../../src/runs/background/async-execution.ts";
import { buildAwaitedProgressUpdate } from "../../src/runs/background/awaited-progress.ts";
import {
  normalizeFailedSupervisorPauseResults,
  type StepResult,
} from "../../src/runs/background/cancellation-projection.ts";
import { reconcileAsyncRun } from "../../src/runs/background/stale-run-reconciler.ts";
import { createBackgroundRunStatusOwner } from "../../src/runs/background/run-status-owner.ts";
import { DEFAULT_ARTIFACT_CONFIG, type AsyncStatus } from "../../src/shared/types.ts";
import { makeAsyncCtx } from "../support/helpers.ts";

const agent = {
  name: "worker",
  description: "test agent",
  systemPromptMode: "replace" as const,
  inheritProjectContext: false,
  inheritSkills: false,
  systemPrompt: "You are a test agent.",
  source: "project" as const,
  filePath: "worker.md",
};

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

describe("prompt variant persistence carrier", () => {
  it("copies the selected variant through the background plan and status step", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-prompt-variant-background-"));
    try {
      const built = buildAsyncRunnerPlan("run-variant", {
        tasks: [{ agent: "worker", task: "validate", promptVariant: "ticket-free" }],
        agents: [agent],
        artifactConfig: DEFAULT_ARTIFACT_CONFIG,
        ctx: makeAsyncCtx(root, { currentSessionId: "session-variant" }),
        maxSubagentDepth: 2,
      });
      assert.ok("plan" in built);
      if ("error" in built) return;
      assert.equal(built.plan.tasks[0]?.promptVariant, "ticket-free");

      const owner = createBackgroundRunStatusOwner({
        id: "run-variant",
        asyncDir: path.join(root, "runs", "run-variant"),
        cwd: root,
        plan: built.plan,
        overallStartTime: 100,
        artifactConfig: DEFAULT_ARTIFACT_CONFIG,
        appendEvent() {},
      });
      assert.equal(owner.statusPayload.steps[0]?.promptVariant, "ticket-free");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects the selected variant into awaited progress results", () => {
    const plan = {
      kind: "single" as const,
      task: {
        agent: "worker",
        task: "validate",
        promptVariant: "ticket-free" as const,
        inheritProjectContext: false,
        inheritSkills: false,
      },
    };
    const status: AsyncStatus = {
      runId: "run-awaited-variant",
      mode: "single",
      state: "running",
      startedAt: 100,
      steps: [{ agent: "worker", status: "running", promptVariant: "ticket-free" }],
    };
    const update = buildAwaitedProgressUpdate(
      {
        id: "run-awaited-variant",
        asyncDir: "/tmp/run-awaited-variant",
        mode: "single",
        plan,
      },
      status,
      () => 150,
    );
    assert.equal(update.details.results[0]?.promptVariant, "ticket-free");
  });

  it("copies the variant through stale-run repair result evidence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-prompt-variant-stale-"));
    try {
      const asyncDir = path.join(root, "runs", "run-stale-variant");
      const resultsDir = path.join(root, "results");
      writeJson(path.join(asyncDir, "status.json"), {
        runId: "run-stale-variant",
        mode: "single",
        state: "running",
        pid: 12345,
        startedAt: 100,
        lastUpdate: 100,
        steps: [{ agent: "worker", status: "running", promptVariant: "ticket-free" }],
      });

      const repaired = reconcileAsyncRun(asyncDir, {
        resultsDir,
        kill: () => {
          throw Object.assign(new Error("no such process"), { code: "ESRCH" });
        },
        now: () => 200,
      });
      assert.equal(repaired.repaired, true);
      assert.ok(repaired.resultPath);
      const result = JSON.parse(fs.readFileSync(repaired.resultPath, "utf8")) as {
        results?: Array<{ promptVariant?: string }>;
      };
      assert.equal(result.results?.[0]?.promptVariant, "ticket-free");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("copies the variant into synthetic supervisor-failure cancellation results", () => {
    const results: StepResult[] = [];
    normalizeFailedSupervisorPauseResults(
      results,
      [{ agent: "worker", status: "paused", promptVariant: "ticket-free" }],
      0,
      "worker",
    );
    assert.equal(results[0]?.promptVariant, "ticket-free");
  });
});

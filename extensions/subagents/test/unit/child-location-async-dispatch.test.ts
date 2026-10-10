/**
 * Unit tests for child-location fields that the async plan-build suite does not cover:
 * AsyncJobStep assignability, JSON round-trip of the plan snapshot, and
 * BUG-02 per-step cwd persistence and revival through the real producer chain.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildAsyncRunnerPlan } from "../../src/runs/background/async-execution.ts";
import { createBackgroundRunStatusOwner } from "../../src/runs/background/run-status-owner.ts";
import { resolveAsyncResumeTarget } from "../../src/runs/background/async-resume.ts";
import type { RunnerSubagentStep } from "../../src/runs/shared/parallel-utils.ts";
import type { AsyncJobStep } from "../../src/shared/types.ts";
import type { ChildLocationSnapshot } from "../../src/shared/child-location.ts";
import { DEFAULT_ARTIFACT_CONFIG } from "../../src/shared/types.ts";
import { makeAsyncCtx } from "../support/helpers.ts";

const parentCwd = os.tmpdir();
const childCwd = path.join(os.tmpdir(), "tlh-unit-test-child-loc-dispatch");
const ctx = makeAsyncCtx(parentCwd, { currentSessionId: "session-cld-1" });

const agentDef = {
  name: "worker",
  description: "test agent",
  systemPromptMode: "replace" as const,
  inheritProjectContext: false,
  inheritSkills: false,
  systemPrompt: "You are a test agent.",
  source: "project" as const,
  filePath: "worker.md",
};

describe("child-location snapshot in async dispatch plan", () => {
  it("childLocation on RunnerSubagentStep is assignable to AsyncJobStep.childLocation (type contract)", () => {
    // This test is a compile-time / runtime structural check:
    // a ChildLocationSnapshot from RunnerSubagentStep must be assignable to the
    // same field on AsyncJobStep, confirming the two types are compatible.
    const snapshot: ChildLocationSnapshot = {
      childCwd: childCwd,
      displayPath: "some-dir",
      branch: "feature",
    };
    // Construct a minimal AsyncJobStep and verify the field is accepted.
    const jobStep: AsyncJobStep = {
      agent: "worker",
      status: "pending",
      childLocation: snapshot,
    };
    assert.deepEqual(jobStep.childLocation, snapshot);
  });

  it("childLocation snapshot is not mutated between plan build and consumption", () => {
    const result = buildAsyncRunnerPlan("run-cld-3", {
      tasks: [{ agent: "worker", task: "run in child dir", cwd: childCwd }],
      agents: [agentDef],
      artifactConfig: DEFAULT_ARTIFACT_CONFIG,
      ctx,
      maxSubagentDepth: 2,
    });

    assert.ok("plan" in result, "expected a successful plan");
    if ("error" in result) return;
    const step = result.plan.tasks[0] as RunnerSubagentStep;
    assert.ok(step.childLocation !== undefined);
    // Serialise and round-trip to confirm the snapshot survives JSON persistence
    // (the runner config is written to disk as JSON before the child reads it).
    const roundTripped: RunnerSubagentStep = JSON.parse(JSON.stringify(step));
    assert.deepEqual(roundTripped.childLocation, step.childLocation);
  });
});

// ---------------------------------------------------------------------------
// BUG-02: per-step cwd written by the real producer chain
// buildAsyncRunnerPlan + createBackgroundRunStatusOwner must write step.cwd;
// resolveAsyncResumeTarget must return the per-step cwd, not the run cwd.
// ---------------------------------------------------------------------------

describe("async per-step cwd from real producer chain (BUG-02)", () => {
  const agentDef2 = {
    name: "worker",
    description: "test agent",
    systemPromptMode: "replace" as const,
    inheritProjectContext: false,
    inheritSkills: false,
    systemPrompt: "You are a test agent.",
    source: "project" as const,
    filePath: "worker.md",
  };

  it("step.cwd equals resolved task cwd when task cwd differs from both run cwd and session cwd", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-bug02-async-prod-"));
    try {
      const sessionCwd = path.join(root, "session");
      const runCwd = path.join(root, "run");
      const taskCwd = path.join(root, "task");
      fs.mkdirSync(sessionCwd);
      fs.mkdirSync(runCwd);
      fs.mkdirSync(taskCwd);
      const sessionFile = path.join(root, "child.jsonl");
      fs.writeFileSync(sessionFile, "");

      const ctx2 = makeAsyncCtx(sessionCwd, { currentSessionId: "session-bug02-a" });
      const built = buildAsyncRunnerPlan("run-bug02-a", {
        tasks: [{ agent: "worker", task: "do work", cwd: taskCwd }],
        agents: [agentDef2],
        artifactConfig: DEFAULT_ARTIFACT_CONFIG,
        ctx: ctx2,
        cwd: runCwd,
        maxSubagentDepth: 2,
        sessionFilesByFlatIndex: [sessionFile],
      });
      assert.ok("plan" in built, `plan build must succeed; got: ${JSON.stringify(built)}`);
      if ("error" in built) return;

      const asyncDir = path.join(root, "runs", "run-bug02-a");
      const owner = createBackgroundRunStatusOwner({
        id: "run-bug02-a",
        asyncDir,
        cwd: built.runnerCwd,
        plan: built.plan,
        overallStartTime: Date.now(),
        artifactConfig: DEFAULT_ARTIFACT_CONFIG,
        appendEvent() {},
      });

      // Verify step.cwd is the resolved task cwd
      const statusPayload = owner.statusPayload;
      assert.equal(
        statusPayload.steps[0]?.cwd,
        taskCwd,
        "status step.cwd must be the resolved task cwd",
      );

      // Write status to disk and resolve the revival target
      statusPayload.state = "complete";
      statusPayload.steps[0]!.status = "complete";
      statusPayload.steps[0]!.sessionFile = sessionFile;
      delete (statusPayload as Record<string, unknown>).pid;
      fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(statusPayload));

      const target = resolveAsyncResumeTarget(
        { id: "run-bug02-a", index: 0 },
        { asyncDirRoot: path.join(root, "runs"), resultsDir: path.join(root, "results") },
        { readOnly: true },
      );

      assert.equal(target.cwd, taskCwd, "revival target cwd must be the task cwd, not the run cwd");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("step.cwd equals session cwd when task cwd matches session cwd (childLocation absent)", () => {
    // This is the tricky case: task cwd == session cwd != run cwd.
    // childLocation is absent (because child cwd == ctx.cwd), so without
    // explicit step.cwd the revival would fall back to the run cwd.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-bug02-async-sesscwd-"));
    try {
      const sessionCwd = path.join(root, "session");
      const runCwd = path.join(root, "run");
      // taskCwd == sessionCwd is the tricky case
      fs.mkdirSync(sessionCwd);
      fs.mkdirSync(runCwd);
      const sessionFile = path.join(root, "child.jsonl");
      fs.writeFileSync(sessionFile, "");

      const ctx3 = makeAsyncCtx(sessionCwd, { currentSessionId: "session-bug02-b" });
      const built = buildAsyncRunnerPlan("run-bug02-b", {
        tasks: [{ agent: "worker", task: "do work", cwd: sessionCwd }],
        agents: [agentDef2],
        artifactConfig: DEFAULT_ARTIFACT_CONFIG,
        ctx: ctx3,
        cwd: runCwd,
        maxSubagentDepth: 2,
        sessionFilesByFlatIndex: [sessionFile],
      });
      assert.ok("plan" in built, `plan build must succeed; got: ${JSON.stringify(built)}`);
      if ("error" in built) return;

      // childLocation must be absent since task cwd == session cwd
      const step = built.plan.tasks[0];
      assert.equal(
        step?.childLocation,
        undefined,
        "childLocation must be absent when task cwd matches session cwd",
      );

      const asyncDir = path.join(root, "runs", "run-bug02-b");
      const owner = createBackgroundRunStatusOwner({
        id: "run-bug02-b",
        asyncDir,
        cwd: built.runnerCwd,
        plan: built.plan,
        overallStartTime: Date.now(),
        artifactConfig: DEFAULT_ARTIFACT_CONFIG,
        appendEvent() {},
      });

      // step.cwd must be the session cwd (= task cwd), not the run cwd
      const statusPayload = owner.statusPayload;
      assert.equal(
        statusPayload.steps[0]?.cwd,
        sessionCwd,
        "status step.cwd must be the session cwd (= resolved task cwd), not the run cwd",
      );
      assert.notEqual(
        statusPayload.steps[0]?.cwd,
        built.runnerCwd,
        "step cwd must differ from run cwd to confirm the bug-02 fix",
      );

      // Write status to disk and resolve the revival target
      statusPayload.state = "complete";
      statusPayload.steps[0]!.status = "complete";
      statusPayload.steps[0]!.sessionFile = sessionFile;
      delete (statusPayload as Record<string, unknown>).pid;
      fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(statusPayload));

      const target = resolveAsyncResumeTarget(
        { id: "run-bug02-b", index: 0 },
        { asyncDirRoot: path.join(root, "runs"), resultsDir: path.join(root, "results") },
        { readOnly: true },
      );

      assert.equal(
        target.cwd,
        sessionCwd,
        "revival target cwd must be the task cwd (= session cwd), not the run cwd",
      );
      assert.notEqual(
        target.cwd,
        built.runnerCwd,
        "revival cwd must not be the run cwd (BUG-02 regression)",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

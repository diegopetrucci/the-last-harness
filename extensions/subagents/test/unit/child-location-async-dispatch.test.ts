/**
 * Unit tests for child-location fields that the async plan-build suite does not cover:
 * AsyncJobStep assignability, and JSON round-trip of the plan snapshot.
 */

import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildAsyncRunnerPlan } from "../../src/runs/background/async-execution.ts";
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

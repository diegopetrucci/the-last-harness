/**
 * Unit tests verifying that the child-location snapshot flows correctly through
 * the async dispatch plumbing.
 *
 * Coverage:
 * - RunnerSubagentStep carries the snapshot from the parent's plan-build call.
 * - AsyncStatus step shape accepts childLocation (type-level check via
 *   assignability assertions).
 * - The snapshot is relayed verbatim: no recomputation, no mutation.
 *
 * Actual subprocess / runner execution is tested in the integration suite.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { buildAsyncRunnerPlan } from "../../src/runs/background/async-execution.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import type { RunnerSubagentStep } from "../../src/runs/shared/parallel-utils.ts";
import type { AsyncJobStep } from "../../src/shared/types.ts";
import type { ChildLocationSnapshot } from "../../src/shared/child-location.ts";
import { DEFAULT_ARTIFACT_CONFIG } from "../../src/shared/types.ts";
import { makeAgent, makeAsyncCtx, makeMinimalCtx, makeSubagentState } from "../support/helpers.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Use a dedicated temp dir as parentCwd so that session-root dirs created by
// createSubagentExecutor (sessionRoot = path.join(parentCwd, runId)) are
// scoped under it and cleaned up in the module-level after() hook.
// Previously parentCwd was os.tmpdir(), which caused runId dirs to appear as
// direct children of the guard's isolated TMPDIR root and leak.
const _parentCwdTmp = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-cld-parent-"));
const parentCwd = _parentCwdTmp;
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

// ---------------------------------------------------------------------------
// Module-level cleanup
// ---------------------------------------------------------------------------

// Clean up the dedicated parentCwd temp dir (and any runId subdirs the
// executor created under it) after all tests in this module complete.
after(() => {
  try {
    fs.rmSync(_parentCwdTmp, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("child-location snapshot in async dispatch plan", () => {
  it("RunnerSubagentStep carries childLocation when step cwd differs from parent cwd", () => {
    const result = buildAsyncRunnerPlan("run-cld-1", {
      tasks: [{ agent: "worker", task: "run in child dir", cwd: childCwd }],
      agents: [agentDef],
      artifactConfig: DEFAULT_ARTIFACT_CONFIG,
      ctx,
      maxSubagentDepth: 2,
    });

    assert.ok("plan" in result, "expected a successful plan");
    if ("error" in result) return;
    const step = result.plan.tasks[0] as RunnerSubagentStep;
    // The parent-computed snapshot must be present and point to the child cwd.
    assert.ok(step.childLocation !== undefined, "childLocation must be set");
    assert.equal(step.childLocation.childCwd, childCwd);
    // displayPath must be set (could be absolute or relative, both are valid).
    assert.ok(
      typeof step.childLocation.displayPath === "string" &&
        step.childLocation.displayPath.length > 0,
      "displayPath must be a non-empty string",
    );
  });

  it("RunnerSubagentStep omits childLocation when step cwd matches parent cwd", () => {
    const result = buildAsyncRunnerPlan("run-cld-2", {
      tasks: [{ agent: "worker", task: "run in parent dir" }],
      agents: [agentDef],
      artifactConfig: DEFAULT_ARTIFACT_CONFIG,
      ctx,
      maxSubagentDepth: 2,
    });

    assert.ok("plan" in result, "expected a successful plan");
    if ("error" in result) return;
    const step = result.plan.tasks[0] as RunnerSubagentStep;
    assert.equal(step.childLocation, undefined, "childLocation must be absent for same-cwd step");
  });

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
// Single-dispatch childLocation — seam-based (non-spawning).
//
// The executor seam intercepts the call to executeAsyncSingle and captures the
// params without writing config files or spawning a runner.  Asserting on
// params.cwd verifies the dispatch plumbing routes the child cwd correctly.
// The childLocation computed from ctx.cwd + cwd is tested via the parallel
// path (buildAsyncRunnerPlan, above) and in the integration suite.
// ---------------------------------------------------------------------------

describe("childLocation in async single dispatch — executor seam", () => {
  const singleChildCwd = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-cld-single-dispatch-"));

  after(() => {
    fs.rmSync(singleChildCwd, { recursive: true, force: true });
  });

  function makeDispatchExecutor(
    captured: Array<{ runId: string; params: Record<string, unknown> }>,
  ) {
    return createSubagentExecutor({
      pi: {
        events: {
          emit() {},
          on() {
            return () => {};
          },
        },
        getSessionName() {
          return "parent";
        },
      } as any,
      state: makeSubagentState({ baseCwd: parentCwd }),
      config: { maxSubagentDepth: 2, control: {} } as any,
      tempArtifactsDir: parentCwd,
      getSubagentSessionRoot: () => parentCwd,
      expandTilde: (v: string) => v,
      discoverAgents: () => ({ agents: [makeAgent("worker")] }),
      executeAsyncSingle: ((runId: string, params: Record<string, unknown>) => {
        captured.push({ runId, params });
        return {
          content: [{ type: "text", text: "seam-ok" }],
          details: { asyncId: runId, results: [] },
        };
      }) as any,
    });
  }

  it("single dispatch routes child cwd to launcher when task cwd differs from parent cwd", async () => {
    const captured: Array<{ runId: string; params: Record<string, unknown> }> = [];
    const executor = makeDispatchExecutor(captured);

    const result = await executor.execute(
      "id",
      { agent: "worker", task: "run in child dir", cwd: singleChildCwd },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(parentCwd),
    );

    assert.ok(
      !result.isError,
      `dispatch must not be rejected: ${result.content.map((c: { type: string; text?: string }) => c.text ?? "").join("")}`,
    );
    assert.equal(captured.length, 1, "executeAsyncSingle seam must be called once");
    assert.equal(
      (captured[0]!.params as { cwd?: string }).cwd,
      singleChildCwd,
      "single dispatch with differing cwd must route child cwd to launcher",
    );
  });

  it("single dispatch routes parent cwd to launcher when task cwd matches parent cwd", async () => {
    const captured: Array<{ runId: string; params: Record<string, unknown> }> = [];
    const executor = makeDispatchExecutor(captured);

    const result = await executor.execute(
      "id",
      { agent: "worker", task: "run in parent dir" },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(parentCwd),
    );

    assert.ok(
      !result.isError,
      `dispatch must not be rejected: ${result.content.map((c: { type: string; text?: string }) => c.text ?? "").join("")}`,
    );
    assert.equal(captured.length, 1, "executeAsyncSingle seam must be called once");
    assert.equal(
      (captured[0]!.params as { cwd?: string }).cwd,
      parentCwd,
      "single dispatch without explicit cwd must route parent cwd to launcher",
    );
  });
});

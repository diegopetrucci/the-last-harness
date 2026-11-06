/**
 * Async-path integration tests for single/parallel execution dispatch behavior.
 *
 * Provenance (tlhf-60wy): ported from single-execution-basic.test.ts, which drove both runSync and
 * executor.execute(). Tests here go through the background path; shared
 * invariants that were runSync-driven were ported to background or shared-helper
 * tests (e.g. async-execution-health, async-execution-models-output-model-fallback-context, async-only-dispatch-characterization). Only assertions on the removed foreground result/callback
 * shapes were dropped.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { MockPi } from "../support/helpers.ts";
import {
  createMockPi,
  createTempDir,
  createEventBus,
  removeTempDir,
  makeAgent,
  makeMinimalCtx,
} from "../support/helpers.ts";
import { available, createSubagentExecutor } from "../support/single-execution-fixtures.ts";
import {
  SUBAGENT_CHILD_AGENT_ENV,
  SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV,
} from "../../src/runs/shared/pi-args.ts";
import { readAsyncPayload } from "../support/async-execution-helpers.ts";

describe(
  "async single/parallel dispatch — basic",
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
    ) {
      return createSubagentExecutor!({
        pi: { events: createEventBus(), getSessionName: () => undefined },
        state,
        config,
        tempArtifactsDir: tempDir,
        getSubagentSessionRoot: () => tempDir,
        expandTilde: (value: string) => value,
        discoverAgents: () => ({ agents }),
      });
    }

    it("propagates each packaged child identity through an async parallel launch", async () => {
      // After async-only: parallel dispatch returns a launch receipt; wait for the
      // background payload to read per-agent child identity env vars.
      mockPi.onCall({
        echoEnv: [SUBAGENT_CHILD_AGENT_ENV, SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV],
      });
      mockPi.onCall({
        echoEnv: [SUBAGENT_CHILD_AGENT_ENV, SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV],
      });
      const executor = makeExecutor([makeAgent("developer"), makeAgent("code-reviewer")]);
      const result = await executor.execute(
        "parallel-packaged-identities",
        {
          async: true,
          tasks: [
            { agent: "developer", task: "Echo the developer identity." },
            { agent: "code-reviewer", task: "Echo the code-reviewer identity." },
          ],
        },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );

      assert.equal(result.isError, undefined);
      const asyncId = result.details?.asyncId;
      assert.ok(asyncId, "expected asyncId for background parallel launch");
      const payload = await readAsyncPayload(asyncId);
      assert.equal(payload.success, true);
      assert.deepEqual(
        payload.results.map((child) => JSON.parse(child.output ?? "{}")),
        [
          {
            [SUBAGENT_CHILD_AGENT_ENV]: "developer",
            [SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV]: "0",
          },
          {
            [SUBAGENT_CHILD_AGENT_ENV]: "code-reviewer",
            [SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV]: "0",
          },
        ],
      );
    });

    it("allows intentional parallel tasks inside one subagent execution call", async () => {
      // After async-only: parallel dispatch returns a receipt; wait for the background
      // result to verify total cost across two parallel agents.
      mockPi.onCall({ output: "first parallel result" });
      mockPi.onCall({ output: "second parallel result" });
      const executor = makeExecutor([makeAgent("echo"), makeAgent("second")]);

      const result = await executor.execute(
        "parallel",
        {
          async: true,
          tasks: [
            { agent: "echo", task: "First task" },
            { agent: "second", task: "Second task" },
          ],
        },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );

      assert.equal(result.isError, undefined);
      const asyncId = result.details?.asyncId;
      assert.ok(asyncId, "expected asyncId for background parallel dispatch");
      const payload = await readAsyncPayload(asyncId);
      assert.equal(payload.success, true);
      assert.equal(payload.results.length, 2);
      assert.deepEqual(payload.totalCost, {
        inputTokens: 200,
        outputTokens: 100,
        costUsd: 0.002,
      });
    });

    it(
      "reports total cost for async single runs",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        // After async-only: cost is in the background payload, not the receipt.
        mockPi.onCall({ output: "single result" });
        const executor = makeExecutor([makeAgent("echo")]);

        const result = await executor.execute(
          "single-cost",
          { agent: "echo", task: "Single task", async: true },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, undefined);
        const asyncId = result.details?.asyncId;
        assert.ok(asyncId, "expected asyncId for background single dispatch");
        const payload = await readAsyncPayload(asyncId);
        assert.equal(payload.success, true);
        assert.deepEqual(payload.results[0]?.totalCost, {
          inputTokens: 100,
          outputTokens: 50,
          costUsd: 0.001,
        });
      },
    );

    it("does not fail advisory oracle runs that finish without edits", async () => {
      // After async-only: dispatch returns a receipt; wait for the background result to
      // verify that oracle runs (completionGuard:false) complete without error.
      mockPi.onCall({ output: "Oracle review:\n- finding one\n- finding two" });
      const executor = makeExecutor([makeAgent("oracle")]);

      const result = await executor.execute(
        "failed-single-output",
        { agent: "oracle", task: "Implement the approved file changes", async: true },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );

      assert.equal(result.isError, undefined);
      const asyncId = result.details?.asyncId;
      assert.ok(asyncId, "expected asyncId for background oracle dispatch");
      const payload = await readAsyncPayload(asyncId);
      assert.equal(payload.success, true);
      assert.equal(payload.results[0]?.exitCode, 0);
    });
  },
);

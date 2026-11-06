/**
 * Async-path integration tests for model selection and fallback dispatch behavior.
 *
 * Provenance (tlhf-60wy): ported from single-execution-model-fallback.test.ts, which drove both runSync and
 * executor.execute(). Tests here go through the background path; shared
 * invariants that were runSync-driven were ported to background or shared-helper
 * tests (mostly async-execution-models-output-model-fallback-context). Only assertions on the removed foreground result/callback
 * shapes were dropped.
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
  makeAgent,
  makeMinimalCtx,
  makeModel,
} from "../support/helpers.ts";
import {
  available,
  createSubagentExecutor,
  type MockPiCallRecord,
} from "../support/single-execution-fixtures.ts";
import { readAsyncPayload } from "../support/async-execution-helpers.ts";

describe(
  "async single dispatch — model selection and fallback",
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

    function readCall(): {
      args: string[];
      systemPrompts: NonNullable<MockPiCallRecord["systemPrompts"]>;
    } {
      const callFile = fs
        .readdirSync(mockPi.dir)
        .filter((name) => name.startsWith("call-") && name.endsWith(".json"))
        .sort()
        .at(-1);
      assert.ok(callFile, "expected a recorded mock pi call");
      const payload = JSON.parse(
        fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8"),
      ) as MockPiCallRecord;
      assert.ok(Array.isArray(payload.args), "expected recorded args");
      return { args: payload.args, systemPrompts: payload.systemPrompts ?? [] };
    }

    function readCallArgs(): string[] {
      return readCall().args;
    }

    async function waitForMockPiCall(index: number, timeoutMs = 10_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const callFiles = fs
          .readdirSync(mockPi.dir)
          .filter((name) => name.startsWith("call-") && name.endsWith(".json"));
        if (callFiles.length > index) return;
        if (Date.now() > deadline)
          assert.fail(`Timed out waiting for mock pi call at index ${index}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

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

    it(
      "async single runs inherit the parent session model when no model is set",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        mockPi.onCall({ output: "Done" });
        const executor = makeExecutor([makeAgent("echo")]);

        const result = await executor.execute(
          "single-parent-model",
          { agent: "echo", task: "Task" },
          new AbortController().signal,
          undefined,
          {
            ...makeMinimalCtx(tempDir),
            model: { provider: "deepseek", id: "deepseek-v4-flash" },
          },
        );

        assert.equal(result.isError, undefined);
        // After async-only: wait for background mock pi call before reading args
        await waitForMockPiCall(0);
        const args = readCallArgs();
        assert.equal(args[args.indexOf("--model") + 1], "deepseek/deepseek-v4-flash");
        // Wait for the background runner to complete so its temp dirs are cleaned
        // before afterEach removes tempDir.  Without this, the detached runner
        // recreates tempDir after cleanup, leaking it into the guard's TMPDIR scan.
        const asyncId = result.details?.asyncId;
        assert.ok(asyncId, "expected asyncId from background dispatch");
        await readAsyncPayload(asyncId);
      },
    );

    it(
      "async single explicit model overrides remain authoritative over the parent session model",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        mockPi.onCall({ output: "Done" });
        const executor = makeExecutor([makeAgent("echo")]);

        const result = await executor.execute(
          "single-explicit-model-override",
          { agent: "echo", task: "Task", model: "openai/gpt-5-mini" },
          new AbortController().signal,
          undefined,
          {
            ...makeMinimalCtx(tempDir),
            model: { provider: "deepseek", id: "deepseek-v4-flash" },
          },
        );

        assert.equal(result.isError, undefined);
        // After async-only: wait for background mock pi call before reading args
        await waitForMockPiCall(0);
        const args = readCallArgs();
        assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-5-mini");
        // Wait for the background runner to complete so its temp dirs are cleaned
        // before afterEach removes tempDir.  Without this, the detached runner
        // recreates tempDir after cleanup, leaking it into the guard's TMPDIR scan.
        const asyncId = result.details?.asyncId;
        assert.ok(asyncId, "expected asyncId from background dispatch");
        await readAsyncPayload(asyncId);
      },
    );

    it("keeps fallback attempts when optional registry snapshot APIs are missing or uncertain", async () => {
      const primary = makeModel("primary", { provider: "openai" });
      const backup = makeModel("backup", { provider: "anthropic" });
      const primaryId = `${primary.provider}/${primary.id}`;
      const backupId = `${backup.provider}/${backup.id}`;
      for (const variant of ["missing-catalog", "catalog-throws", "availability-error"] as const) {
        mockPi.reset();
        mockPi.onCall({
          jsonl: [
            {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "temporary provider failure" }],
                model: primary.id,
                errorMessage: "rate limit exceeded",
                usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
              },
            },
          ],
          exitCode: 1,
        });
        mockPi.onCall({ output: "Recovered on the preserved fallback" });

        const ctx = makeMinimalCtx(tempDir);
        ctx.modelRegistry.getAvailable = () => [primary];
        if (variant === "missing-catalog") {
          Object.defineProperty(ctx.modelRegistry, "getAll", {
            configurable: true,
            value: undefined,
          });
        } else if (variant === "catalog-throws") {
          Object.defineProperty(ctx.modelRegistry, "getAll", {
            configurable: true,
            value: () => {
              throw new Error("catalog unavailable");
            },
          });
        } else {
          Object.defineProperty(ctx.modelRegistry, "getError", {
            configurable: true,
            value: () => "availability snapshot is stale",
          });
        }

        const result = await makeExecutor([
          makeAgent("echo", {
            model: primaryId,
            fallbackModels: [backupId],
          }),
        ]).execute(
          `optional-registry-${variant}`,
          { agent: "echo", task: "Task" },
          new AbortController().signal,
          undefined,
          ctx,
        );

        assert.equal(result.isError, undefined);
        // After async-only: results[0] not in receipt; wait for async result
        const asyncId13 = result.details?.asyncId;
        assert.ok(asyncId13, "expected asyncId in receipt");
        const asyncPayload13 = await readAsyncPayload(asyncId13);
        assert.deepEqual(asyncPayload13.results[0]?.attemptedModels, [primaryId, backupId]);
      }
    });

    it(
      "tries agent fallback models and only shows notices after a retry",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        mockPi.onCall({
          jsonl: [
            {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "quota hit" }],
                model: "openai/gpt-5-mini",
                errorMessage: "429 quota exceeded",
                usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
              },
            },
          ],
          exitCode: 0,
        });
        mockPi.onCall({ output: "Recovered on the agent fallback" });
        const executor = makeExecutor([
          makeAgent("echo", {
            model: "openai/gpt-5-mini",
            fallbackModels: ["google/gemini-2.5-pro"],
          }),
        ]);
        const ctx = makeMinimalCtx(tempDir);
        const primary = makeModel("gpt-5-mini", { provider: "openai" });
        const agentFallback = makeModel("gemini-2.5-pro", { provider: "google" });
        ctx.modelRegistry.getAvailable = () => [primary, agentFallback];
        ctx.modelRegistry.getAll = () => [primary, agentFallback];

        const result = await executor.execute(
          "single-agent-fallback-order",
          {
            agent: "echo",
            task: "Task",
            modelFallbackNotice: "Quota fallback engaged",
          },
          new AbortController().signal,
          undefined,
          ctx,
        );

        assert.equal(result.isError, undefined);
        // After async-only: content is the background receipt, not the foreground card.
        // The fallback notice and attemptedModels are in the async result.
        assert.match(result.content[0]?.text ?? "", /Background run started/);
        const asyncId16 = result.details?.asyncId;
        assert.ok(asyncId16, "expected asyncId in receipt");
        const asyncPayload16 = await readAsyncPayload(asyncId16);
        assert.deepEqual(asyncPayload16.results[0]?.attemptedModels, [
          "openai/gpt-5-mini",
          "google/gemini-2.5-pro",
        ]);
        assert.match(
          asyncPayload16.results[0]?.modelFallbackNotice ?? "",
          /Quota fallback engaged/,
        );
      },
    );

    it(
      "suppresses fallback notices when the primary attempt succeeds",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        mockPi.onCall({ output: "Primary succeeded" });
        const executor = makeExecutor([
          makeAgent("echo", {
            model: "openai/gpt-5-mini",
            fallbackModels: ["anthropic/claude-sonnet-4"],
          }),
        ]);

        const result = await executor.execute(
          "single-fallback-notice-no-retry",
          { agent: "echo", task: "Task", modelFallbackNotice: "Should stay hidden" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, undefined);
        assert.doesNotMatch(result.content[0]?.text ?? "", /Should stay hidden/);
        const asyncId = result.details?.asyncId;
        assert.ok(asyncId, "expected asyncId from background dispatch");
        // Real execution: the successful primary's persisted result must carry no notice.
        const payload = await readAsyncPayload(asyncId);
        assert.equal(payload.success, true);
        assert.equal(payload.results[0]?.output, "Primary succeeded");
        assert.equal(payload.results[0]?.modelFallbackNotice, undefined);
        assert.doesNotMatch(JSON.stringify(payload), /Should stay hidden/);
        assert.equal(mockPi.callCount(), 1);
      },
    );
  },
);

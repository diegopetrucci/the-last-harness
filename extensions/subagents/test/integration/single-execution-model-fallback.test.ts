/** Model selection, fallback, and provider recovery coverage. */

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
  makeModel,
  events,
} from "../support/helpers.ts";
import {
  available,
  runSync,
  createSubagentExecutor,
  type MockPiCallRecord,
  type ExecutionModule,
  type ExecuteAsyncSingleOverride,
} from "../support/single-execution-fixtures.ts";
import { getThinkingLevelDropNote } from "../../src/runs/shared/pi-args.ts";
import { getFinalOutput } from "../support/single-execution-fixtures.ts";

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
    it("uses agent model config", async () => {
      mockPi.onCall({ output: "Done" });
      const agents = [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })];

      const result = await runSync(tempDir, agents, "echo", "Task", {});

      assert.equal(result.exitCode, 0);
      // result.model is set from agent config via applyThinkingSuffix, then
      // overwritten by the first message_end event only if result.model is unset.
      // Since agent has model config, it stays as the configured value.
      assert.equal(result.model, "anthropic/claude-sonnet-4");
    });

    it("model override from options takes precedence", async () => {
      mockPi.onCall({ output: "Done" });
      const agents = [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })];

      const result = await runSync(tempDir, agents, "echo", "Task", {
        modelOverride: "openai/gpt-4o",
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.model, "openai/gpt-4o");
    });

    it(
      "foreground single runs inherit the parent session model when no model is set",
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
        const args = readCallArgs();
        assert.equal(args[args.indexOf("--model") + 1], "deepseek/deepseek-v4-flash");
      },
    );

    it(
      "foreground single explicit model overrides remain authoritative over the parent session model",
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
        const args = readCallArgs();
        assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-5-mini");
      },
    );

    it("prefers the parent session provider for ambiguous bare model ids", async () => {
      mockPi.onCall({ output: "Done" });
      const agents = [makeAgent("echo", { model: "gpt-5-mini" })];

      const result = await runSync(tempDir, agents, "echo", "Task", {
        availableModels: [
          { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
          { provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
        ],
        preferredModelProvider: "github-copilot",
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.model, "github-copilot/gpt-5-mini");
      assert.deepEqual(result.attemptedModels, ["github-copilot/gpt-5-mini"]);
    });

    it("surfaces a dropped thinking level in foreground progress without changing the model arg", async () => {
      mockPi.onCall({ output: "Done" });
      const agents = [makeAgent("echo", { model: "openai/gpt-5", thinking: "max" })];
      const availableModels = [
        {
          provider: "openai",
          id: "gpt-5",
          fullId: "openai/gpt-5",
          reasoning: true,
          thinkingLevelMap: { max: null },
        },
      ];

      const result = await runSync(tempDir, agents, "echo", "Task", {
        availableModels,
        runId: "foreground-thinking-drop",
      });
      const note = getThinkingLevelDropNote("openai/gpt-5", "max", false, { availableModels });
      assert.equal(result.exitCode, 0);
      assert.equal(result.model, "openai/gpt-5");
      const args = readCallArgs();
      assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-5");
      assert.ok(note);
      assert.equal(result.progress.recentOutput.filter((line) => line === note).length, 1);
    });

    it("preserves a max thinking suffix for resolved foreground models without capability metadata", async () => {
      mockPi.onCall({ output: "Done" });
      const model = "anthropic/claude-sonnet-4-5";
      const agents = [makeAgent("echo", { model, thinking: "max" })];
      const availableModels = [
        {
          provider: "anthropic",
          id: "claude-sonnet-4-5",
          fullId: model,
          reasoning: true,
        },
      ];

      const result = await runSync(tempDir, agents, "echo", "Task", {
        availableModels,
        runId: "foreground-thinking-metadata-missing",
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.model, `${model}:max`);
      const args = readCallArgs();
      assert.equal(args[args.indexOf("--model") + 1], `${model}:max`);
      assert.equal(getThinkingLevelDropNote(model, "max", false, { availableModels }), undefined);
    });

    it("tracks usage from message events", async () => {
      mockPi.onCall({ output: "Done" });
      const agents = makeAgentConfigs(["echo"]);

      const result = await runSync(tempDir, agents, "echo", "Task", {});

      assert.equal(result.usage.turns, 1);
      assert.equal(result.usage.input, 100); // from mock
      assert.equal(result.usage.output, 50); // from mock
    });

    it("retries with fallback models on retryable provider failures", async () => {
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "temporary provider failure" }],
              model: "openai/gpt-5-mini",
              errorMessage: "rate limit exceeded",
              usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
            },
          },
        ],
        exitCode: 1,
      });
      mockPi.onCall({ output: "Recovered on fallback" });
      const agents = [
        makeAgent("echo", {
          model: "openai/gpt-5-mini",
          fallbackModels: ["anthropic/claude-sonnet-4"],
        }),
      ];

      const sessionFile = path.join(tempDir, "fallback-preallocated.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "fallback-sync",
        sessionFile,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.model, "anthropic/claude-sonnet-4");
      assert.deepEqual(result.attemptedModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
      assert.equal(result.modelAttempts?.length, 2);
      assert.equal(result.modelAttempts?.[0]?.success, false);
      assert.equal(result.modelAttempts?.[1]?.success, true);
      assert.equal(result.contextUsage?.restoredTokens, undefined);
      assert.equal(result.terminationReason, "completed");
      assert.equal(result.usage.turns, 2);
      assert.equal(mockPi.callCount(), 2);
    });

    it("reports conservative registry filtering in the foreground result", async () => {
      mockPi.onCall({ output: "Primary completed" });
      const primary = {
        provider: "openai",
        id: "gpt-5-mini",
        fullId: "openai/gpt-5-mini",
      };
      const backup = {
        provider: "anthropic",
        id: "claude-sonnet-4",
        fullId: "anthropic/claude-sonnet-4",
      };
      const result = await runSync(
        tempDir,
        [
          makeAgent("echo", {
            model: primary.fullId,
            fallbackModels: [backup.fullId],
          }),
        ],
        "echo",
        "Task",
        {
          runId: "foreground-registry-filter-notice",
          availableModels: [primary],
          modelRegistry: { allModels: [primary, backup] },
        },
      );

      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.attemptedModels, [primary.fullId]);
      assert.match(result.modelFallbackNotice ?? "", /Skipped.*unavailable fallback model/);
      assert.match(result.modelFallbackNotice ?? "", /provider credentials|fallbackModels/);
      assert.ok((result.modelFallbackNotice ?? "").length <= 240);
      assert.equal(mockPi.callCount(), 1);
    });

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
        assert.deepEqual(result.details?.results?.[0]?.attemptedModels, [primaryId, backupId]);
        assert.equal(mockPi.callCount(), 2);
      }
    });

    it("keeps the fallback resolution's original identity free of thinking the first attempt dropped", async () => {
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "temporary provider failure" }],
              model: "openai/gpt-5-mini",
              errorMessage: "rate limit exceeded",
              usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
            },
          },
        ],
        exitCode: 1,
      });
      mockPi.onCall({ output: "Recovered on fallback" });
      const availableModels = [
        {
          provider: "openai",
          id: "gpt-5-mini",
          fullId: "openai/gpt-5-mini",
          reasoning: true,
          thinkingLevelMap: { high: null },
        },
        {
          provider: "anthropic",
          id: "claude-sonnet-4",
          fullId: "anthropic/claude-sonnet-4",
          reasoning: true,
        },
      ];
      const agents = [
        makeAgent("echo", {
          model: "openai/gpt-5-mini",
          thinking: "high",
          fallbackModels: ["anthropic/claude-sonnet-4"],
        }),
      ];

      const result = await runSync(tempDir, agents, "echo", "Task", {
        availableModels,
        runId: "fallback-thinking-dropped-original",
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.model, "anthropic/claude-sonnet-4:high");
      assert.equal(result.modelResolution?.kind, "fallback");
      // Regression: the first attempt actually dropped "high" as unsupported, so
      // the fallback resolution must not restore it on the original identity.
      assert.deepEqual(result.modelResolution?.original, {
        provider: "openai",
        model: "gpt-5-mini",
      });
      assert.deepEqual(result.modelResolution?.resumed, {
        provider: "anthropic",
        model: "claude-sonnet-4",
        thinking: "high",
      });
      assert.match(
        result.modelResolution?.reason ?? "",
        /Runtime fallback selected 'anthropic\/claude-sonnet-4:high' after 'openai\/gpt-5-mini' failed/,
      );
    });

    it("lets runtime fallback supersede restored model resolution while preserving history", async () => {
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "temporary provider failure" }],
              model: "openai/gpt-5-mini",
              errorMessage: "rate limit exceeded",
              usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
            },
          },
        ],
        exitCode: 1,
      });
      mockPi.onCall({ output: "Recovered on fallback" });
      const original = { provider: "openai", model: "gpt-5-mini", thinking: "high" };
      const result = await runSync(
        tempDir,
        [
          makeAgent("echo", {
            model: "openai/gpt-5-mini",
            fallbackModels: ["anthropic/claude-sonnet-4"],
          }),
        ],
        "echo",
        "Continue",
        {
          availableModels: [
            { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini", reasoning: true },
            {
              provider: "anthropic",
              id: "claude-sonnet-4",
              fullId: "anthropic/claude-sonnet-4",
              reasoning: true,
            },
          ],
          modelResolution: {
            kind: "restored",
            original,
            resumed: original,
            reason:
              "Restored persisted child selection openai/gpt-5-mini:high instead of the current parent model.",
          },
          runId: "restored-fallback-resolution",
        },
      );

      assert.equal(result.modelResolution?.kind, "fallback");
      assert.deepEqual(result.modelResolution?.original, original);
      assert.deepEqual(result.modelResolution?.resumed, {
        provider: "anthropic",
        model: "claude-sonnet-4",
      });
      assert.match(result.modelResolution?.reason ?? "", /Restored persisted child selection/);
      assert.match(result.modelResolution?.reason ?? "", /Runtime fallback selected/);
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
        assert.match(
          result.content[0]?.text ?? "",
          /Summary:\nNotice: Quota fallback engaged(?: Skipped.*)?\n\nRecovered on the agent fallback/,
        );
        assert.deepEqual(result.details?.results?.[0]?.attemptedModels, [
          "openai/gpt-5-mini",
          "google/gemini-2.5-pro",
        ]);
        assert.match(
          result.details?.results?.[0]?.modelFallbackNotice ?? "",
          /Quota fallback engaged/,
        );
        assert.equal(mockPi.callCount(), 2);
      },
    );

    it(
      "suppresses fallback notices when the primary attempt succeeds",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        mockPi.onCall({ output: "Done without retry" });
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
        assert.doesNotMatch(result.content[0]?.text ?? "", /Notice: Should stay hidden/);
        assert.equal(result.details?.results?.[0]?.modelFallbackNotice, undefined);
      },
    );

    it("retries with fallback models when provider errors exit zero", async () => {
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "weekly quota hit" }],
              model: "openai/gpt-5-mini",
              errorMessage: "429 you have reached your weekly usage limit / quota exceeded",
              usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
            },
          },
        ],
        exitCode: 0,
      });
      mockPi.onCall({ output: "Recovered on fallback" });
      const agents = [
        makeAgent("echo", {
          model: "openai/gpt-5-mini",
          fallbackModels: ["anthropic/claude-sonnet-4"],
        }),
      ];

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "fallback-zero-exit-provider-error",
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.model, "anthropic/claude-sonnet-4");
      assert.deepEqual(
        result.modelAttempts?.map((attempt) => attempt.success),
        [false, true],
      );
    });

    it("retries with fallback models when a zero-exit attempt has empty output", async () => {
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "" }],
              model: "openai/gpt-5-mini",
              stopReason: "error",
              usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
            },
          },
        ],
        exitCode: 0,
      });
      mockPi.onCall({ output: "Recovered from empty output" });
      const agents = [
        makeAgent("echo", {
          model: "openai/gpt-5-mini",
          fallbackModels: ["anthropic/claude-sonnet-4"],
        }),
      ];

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "fallback-zero-exit-empty-output",
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.model, "anthropic/claude-sonnet-4");
      assert.equal(result.finalOutput, "Recovered from empty output");
      assert.match(result.modelAttempts?.[0]?.error ?? "", /no output/i);
      assert.deepEqual(
        result.modelAttempts?.map((attempt) => attempt.success),
        [false, true],
      );
      assert.equal(mockPi.callCount(), 2);
    });

    it("does not combine failed high-pressure fallback diagnostics with a successful empty attempt", async () => {
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [
                { type: "toolCall", id: "failed-call", name: "edit", arguments: { path: "a.ts" } },
              ],
              model: "openai/gpt-5-mini",
              stopReason: "toolUse",
              usage: {
                totalTokens: 990,
                input: 900,
                output: 90,
                cacheRead: 0,
                cacheWrite: 0,
                cost: { total: 0 },
              },
            },
          },
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "provider failure" }],
              model: "openai/gpt-5-mini",
              stopReason: "error",
              errorMessage: "429 quota exceeded",
            },
          },
        ],
        exitCode: 0,
      });
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "successful-call",
                  name: "edit",
                  arguments: { path: "b.ts" },
                },
              ],
              model: "anthropic/claude-sonnet-4",
              stopReason: "toolUse",
            },
          },
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "" }],
              model: "anthropic/claude-sonnet-4",
              stopReason: "stop",
            },
          },
        ],
      });
      const result = await runSync(
        tempDir,
        [
          makeAgent("echo", {
            model: "openai/gpt-5-mini",
            fallbackModels: ["anthropic/claude-sonnet-4"],
            completionGuard: false,
          }),
        ],
        "echo",
        "Task",
        {
          runId: "fallback-context-pressure-scope",
          availableModels: [
            {
              provider: "openai",
              id: "gpt-5-mini",
              fullId: "openai/gpt-5-mini",
              contextWindow: 1000,
            },
          ],
        },
      );

      assert.equal(result.exitCode, 0);
      assert.equal(result.terminationReason, "completed");
      assert.equal(result.error, undefined);
      assert.equal(result.contextUsage?.contextPercent, 99);
      assert.deepEqual(
        result.modelAttempts?.map((attempt) => attempt.success),
        [false, true],
      );
    });

    it("fails zero-exit provider errors when no fallback succeeds", async () => {
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "weekly quota hit" }],
              model: "openai/gpt-5-mini",
              errorMessage: "429 quota exceeded",
              usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
            },
          },
        ],
        exitCode: 0,
      });
      const agents = [makeAgent("echo", { model: "openai/gpt-5-mini" })];

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "zero-exit-provider-error-no-fallback",
      });

      assert.equal(result.exitCode, 1);
      assert.match(result.error ?? "", /429 quota exceeded/);
      assert.deepEqual(
        result.modelAttempts?.map((attempt) => attempt.success),
        [false],
      );
    });

    it("treats recovered child tool errors as successful foreground runs", async () => {
      mockPi.onCall({
        jsonl: [
          events.toolResult("read", "EISDIR: illegal operation on a directory", true),
          events.assistantMessage("Done"),
        ],
      });
      const agents = makeAgentConfigs(["echo"]);

      const result = await runSync(tempDir, agents, "echo", "Inspect files", {
        runId: "recovered-tool-error",
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.error, undefined);
      assert.equal(result.finalOutput, "Done");
      assert.equal(getFinalOutput(result.messages), "Done");
      assert.equal(result.progress.status, "completed");
    });

    it("treats recovered assistant provider errors as successful foreground runs", async () => {
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "temporary provider failure" }],
              model: "openai/gpt-5-mini",
              stopReason: "error",
              errorMessage: "provider transport failed",
              usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
            },
          },
          events.assistantMessage("Recovered"),
        ],
      });
      const agents = makeAgentConfigs(["echo"]);

      const result = await runSync(tempDir, agents, "echo", "Recover from provider error", {
        runId: "recovered-provider-error",
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.error, undefined);
      assert.equal(result.finalOutput, "Recovered");
      assert.equal(getFinalOutput(result.messages), "Recovered");
      assert.equal(result.progress.status, "completed");
    });

    it("keeps provider errors failed when followed only by empty assistant output", async () => {
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "temporary provider failure" }],
              model: "openai/gpt-5-mini",
              stopReason: "error",
              errorMessage: "provider transport failed",
              usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
            },
          },
          events.assistantMessage(""),
        ],
      });
      const agents = makeAgentConfigs(["echo"]);

      const result = await runSync(tempDir, agents, "echo", "Recover from provider error", {
        runId: "provider-error-empty-stop",
      });

      assert.equal(result.exitCode, 1);
      assert.match(result.error ?? "", /provider transport failed/);
      assert.equal(result.finalOutput, "");
      assert.equal(result.progress.status, "failed");
    });

    it("fails when all fallback model attempts report provider errors", async () => {
      for (const model of ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]) {
        mockPi.onCall({
          jsonl: [
            {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: `${model} quota hit` }],
                model,
                errorMessage: "429 quota exceeded",
                usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
              },
            },
          ],
          exitCode: 0,
        });
      }
      const agents = [
        makeAgent("echo", {
          model: "openai/gpt-5-mini",
          fallbackModels: ["anthropic/claude-sonnet-4"],
        }),
      ];

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "zero-exit-provider-error-all-fallbacks-fail",
      });

      assert.equal(result.exitCode, 1);
      assert.deepEqual(
        result.modelAttempts?.map((attempt) => attempt.success),
        [false, false],
      );
      assert.match(result.error ?? "", /429 quota exceeded/);
    });

    it("baselines output files per fallback attempt", async () => {
      const outputPath = path.join(tempDir, "fallback-output.md");
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "primary failed" }],
              model: "openai/gpt-5-mini",
              errorMessage: "429 quota exceeded",
              usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
            },
          },
        ],
        exitCode: 0,
        delay: 100,
      });
      mockPi.onCall({ output: "fallback assistant output" });
      const agents = [
        makeAgent("echo", {
          model: "openai/gpt-5-mini",
          fallbackModels: ["anthropic/claude-sonnet-4"],
        }),
      ];

      const runPromise = runSync(tempDir, agents, "echo", "Task", {
        runId: "fallback-output-per-attempt",
        outputPath,
      });
      setTimeout(() => {
        fs.writeFileSync(outputPath, "stale partial output from failed primary", "utf-8");
      }, 20);

      const result = await runPromise;

      assert.equal(result.exitCode, 0);
      assert.equal(fs.readFileSync(outputPath, "utf-8"), "fallback assistant output");
    });

    it("does not retry on ordinary task/tool failures", async () => {
      mockPi.onCall({
        jsonl: [events.toolResult("bash", "process exited with code 127")],
        exitCode: 0,
      });
      const agents = [
        makeAgent("echo", {
          model: "openai/gpt-5-mini",
          fallbackModels: ["anthropic/claude-sonnet-4"],
        }),
      ];

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "no-fallback-task-failure",
      });

      assert.equal(result.exitCode, 127);
      assert.equal(result.modelAttempts?.length, 1);
      assert.equal(mockPi.callCount(), 1);
    });
  },
);

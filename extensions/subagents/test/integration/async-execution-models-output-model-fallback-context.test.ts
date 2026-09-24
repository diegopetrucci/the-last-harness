/** Integration tests for async execution – model restoration, fallback, and context diagnostics. */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createMockPi,
  createTempDir,
  events,
  makeAgent,
  removeTempDir,
} from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import { scaleTestTimeout, unscaledMs } from "../support/scale-timeout.ts";

import {
  ASYNC_DIR,
  type AsyncResultPayload,
  type AsyncStatusPayload,
  RESULTS_DIR,
  executeAsyncSingle,
  readMockPiArgs,
  requestAsyncInterrupt,
  waitForAsyncResultFile,
  waitForAsyncStatusPredicate,
  waitForMarker,
} from "../support/async-execution-helpers.ts";

function highContextEmptyTerminalJsonl() {
  const usage = {
    totalTokens: 990,
    input: 900,
    output: 90,
    cacheRead: 0,
    cacheWrite: 0,
  };
  return [
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-context-boundary", name: "edit", arguments: {} }],
        stopReason: "toolUse",
        usage,
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "  " }],
        stopReason: "stop",
        usage,
      },
    },
  ];
}

describe("async execution model restoration and fallback", () => {
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

  it("background runs record fallback attempts and final model", async () => {
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "primary failed" }],
            model: "openai/gpt-5-mini",
            errorMessage: "rate limit exceeded",
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
          },
        },
      ],
      exitCode: 1,
    });
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Recovered asynchronously" }],
            provider: "mock",
            model: "test-model",
            stopReason: "stop",
            usage: { input: 1900, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        },
      ],
    });
    const id = `async-fallback-${Date.now().toString(36)}`;
    const sessionRoot = path.join(tempDir, "sessions");
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    const run = executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", {
        model: "openai/gpt-5-mini:high",
        fallbackModels: ["anthropic/claude-sonnet-4:low"],
      }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      availableModels: [
        { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini", contextWindow: 1000 },
        {
          provider: "anthropic",
          id: "claude-sonnet-4",
          fullId: "anthropic/claude-sonnet-4",
          contextWindow: 2000,
        },
      ],
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      sessionRoot,
      maxSubagentDepth: 2,
    });

    assert.equal(run.details.asyncId, id);

    const started = Date.now();
    while (!fs.existsSync(resultPath)) {
      if (Date.now() - started > scaleTestTimeout(15_000)) {
        assert.fail(`Timed out waiting for async result file: ${resultPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
    assert.equal(payload.lifecycleArtifactVersion, 1);
    assert.equal(payload.success, true);
    assert.equal(payload.results[0].model, "anthropic/claude-sonnet-4:low");
    assert.deepEqual(payload.results[0].modelIdentity, {
      provider: "anthropic",
      model: "claude-sonnet-4",
      thinking: "low",
    });
    assert.equal(payload.results[0].contextUsage?.contextWindow, 2000);
    assert.deepEqual(payload.results[0].attemptedModels, [
      "openai/gpt-5-mini:high",
      "anthropic/claude-sonnet-4:low",
    ]);
    assert.equal(payload.results[0].modelAttempts.length, 2);
    assert.deepEqual(payload.results[0].totalCost, {
      inputTokens: 1910,
      outputTokens: 5,
      costUsd: 0.01,
    });
    assert.deepEqual(payload.totalCost, { inputTokens: 1910, outputTokens: 5, costUsd: 0.01 });
    const statusPayload = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.equal(statusPayload.lifecycleArtifactVersion, 1);
    assert.equal(statusPayload.steps?.[0]?.model, "anthropic/claude-sonnet-4:low");
    assert.equal(statusPayload.steps?.[0]?.thinking, "low");
    assert.ok(statusPayload.totalTokens!.total > 0);
    assert.ok(statusPayload.steps?.[0]?.tokens!.total > 0);
    assert.deepEqual(statusPayload.steps?.[0]?.totalCost, {
      inputTokens: 1910,
      outputTokens: 5,
      costUsd: 0.01,
    });
    assert.deepEqual(statusPayload.totalCost, {
      inputTokens: 1910,
      outputTokens: 5,
      costUsd: 0.01,
    });
    const events = fs
      .readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      events.find((event) => event.type === "subagent.run.started")?.lifecycleArtifactVersion,
      1,
    );
    const completed = events.find((event) => event.type === "subagent.run.completed");
    assert.equal(completed?.lifecycleArtifactVersion, 1);
    assert.deepEqual(completed?.totalCost, { inputTokens: 1910, outputTokens: 5, costUsd: 0.01 });
    assert.match(
      fs.readFileSync(path.join(asyncDir, "output-0.log"), "utf-8"),
      /Recovered asynchronously/,
    );
    assert.equal(mockPi.callCount(), 2);
  });

  it("surfaces ordered fallback exhaustion after retryable failures", async () => {
    for (const model of ["openai/primary", "anthropic/backup-a", "google/backup-b"]) {
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: `${model} failed` }],
              model,
              errorMessage: "provider error 503: Service Unavailable",
              usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          },
        ],
        exitCode: 1,
      });
    }
    const id = `async-fallback-exhaustion-${Date.now().toString(36)}`;
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", {
        model: "openai/primary",
        fallbackModels: ["anthropic/backup-a", "google/backup-b"],
      }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-exhaustion" },
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      maxSubagentDepth: 2,
    });

    const payload = JSON.parse(
      fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
    ) as AsyncResultPayload;
    assert.equal(payload.success, false);
    assert.equal(payload.results[0]?.model, "google/backup-b");
    assert.deepEqual(payload.results[0]?.attemptedModels, [
      "openai/primary",
      "anthropic/backup-a",
      "google/backup-b",
    ]);
    assert.equal(payload.results[0]?.modelAttempts?.length, 3);
    assert.equal(mockPi.callCount(), 3);
  });

  it("persists cached-token-heavy context diagnostics and termination reason", async () => {
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done" }],
            model: "mock/test-model",
            stopReason: "stop",
            usage: { input: 10, output: 5, cacheRead: 985, cacheWrite: 0, cost: { total: 0 } },
          },
        },
      ],
    });
    const id = `async-context-${Date.now().toString(36)}`;
    const restoredSessionFile = path.join(tempDir, "restored-context.jsonl");
    fs.writeFileSync(
      restoredSessionFile,
      '{"type":"session","version":1,"id":"restored-context","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n',
      "utf-8",
    );
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", { model: "mock/test-model" }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      availableModels: [
        { provider: "mock", id: "test-model", fullId: "mock/test-model", contextWindow: 2000 },
      ],
      sessionFile: restoredSessionFile,
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
    });
    const payload = JSON.parse(
      fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
    ) as AsyncResultPayload;
    assert.deepEqual(payload.results[0]?.contextUsage, {
      restoredTokens: 1000,
      contextTokens: 1000,
      peakTokens: 1000,
      contextWindow: 2000,
      contextPercent: 50,
    });
    assert.equal(payload.results[0]?.terminationReason, "completed");
    const status = JSON.parse(
      fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.deepEqual(status.steps?.[0]?.contextUsage, payload.results[0]?.contextUsage);
    assert.equal(status.steps?.[0]?.terminationReason, "completed");
  });

  it(
    "does not let context exhaustion replace a timed-out terminal result",
    {
      skip:
        process.platform === "win32"
          ? "timeout signal delivery intermittent on Windows CI"
          : undefined,
    },
    async () => {
      mockPi.onCall({
        jsonl: highContextEmptyTerminalJsonl(),
        keepAliveAfterFinalMessageMs: scaleTestTimeout(5_000),
      });
      const id = `async-context-timeout-boundary-${Date.now().toString(36)}`;
      const asyncDir = path.join(ASYNC_DIR, id);
      executeAsyncSingle(id, {
        agent: "worker",
        task: "Finish the edit before the deadline.",
        agentConfig: makeAgent("worker", {
          model: "mock/test-model",
          maxExecutionTimeMs: unscaledMs(750),
        }),
        ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
        availableModels: [
          { provider: "mock", id: "test-model", fullId: "mock/test-model", contextWindow: 1000 },
        ],
        artifactConfig: {
          enabled: false,
          includeInput: false,
          includeOutput: false,
          includeJsonl: false,
          includeMetadata: false,
          cleanupDays: 7,
        },
        shareEnabled: false,
        sessionRoot: path.join(tempDir, "sessions"),
        maxSubagentDepth: 2,
      });

      const resultPath = await waitForAsyncResultFile(id);
      const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
      const status = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      const child = payload.results[0];
      assert.equal(payload.state, "failed");
      assert.equal(child?.timedOut, true);
      assert.equal(child?.terminationReason, "timed_out");
      assert.equal(child?.contextUsage?.contextPercent, 99);
      assert.doesNotMatch(
        child?.error ?? "",
        /unfinished tool interaction under high context pressure/,
      );
      assert.equal(status.steps?.[0]?.timedOut, true);
      assert.equal(status.steps?.[0]?.terminationReason, "timed_out");
    },
  );

  it(
    "does not let context exhaustion replace an interrupted paused terminal result",
    {
      skip:
        process.platform === "win32"
          ? "cross-process interrupt delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      const readyMarker = path.join(tempDir, "context-pause-boundary-ready");
      mockPi.onCall({
        jsonl: highContextEmptyTerminalJsonl(),
        writeMarkerAfter: readyMarker,
        keepAliveAfterFinalMessageMs: scaleTestTimeout(5_000),
      });
      const id = `async-context-pause-boundary-${Date.now().toString(36)}`;
      const asyncDir = path.join(ASYNC_DIR, id);
      executeAsyncSingle(id, {
        agent: "worker",
        task: "Pause after the unfinished edit.",
        agentConfig: makeAgent("worker", {
          model: "mock/test-model",
        }),
        ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
        availableModels: [
          { provider: "mock", id: "test-model", fullId: "mock/test-model", contextWindow: 1000 },
        ],
        artifactConfig: {
          enabled: false,
          includeInput: false,
          includeOutput: false,
          includeJsonl: false,
          includeMetadata: false,
          cleanupDays: 7,
        },
        shareEnabled: false,
        sessionRoot: path.join(tempDir, "sessions"),
        maxSubagentDepth: 2,
      });

      await waitForAsyncStatusPredicate(
        asyncDir,
        (status) => status.steps?.[0]?.status === "running",
        "running context-boundary child",
      );
      await waitForMarker(readyMarker);
      requestAsyncInterrupt(asyncDir, { source: "context-boundary-test" });

      const resultPath = await waitForAsyncResultFile(id);
      const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
      const status = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      const child = payload.results[0];
      assert.equal(payload.state, "paused");
      assert.equal(child?.terminationReason, "paused");
      assert.equal(child?.contextUsage?.contextPercent, 99);
      assert.doesNotMatch(
        child?.error ?? "",
        /unfinished tool interaction under high context pressure/,
      );
      assert.equal(status.steps?.[0]?.status, "paused");
      assert.equal(status.steps?.[0]?.terminationReason, "paused");
    },
  );

  it("fresh async runs do not mark a preallocated session path as restored", async () => {
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Fresh" }],
            model: "mock/test-model",
            stopReason: "stop",
            usage: { input: 10, output: 5, cacheRead: 985, cacheWrite: 0, cost: { total: 0 } },
          },
        },
      ],
    });
    const id = `async-context-fresh-${Date.now().toString(36)}`;
    const sessionFile = path.join(tempDir, "fresh-preallocated.jsonl");
    fs.writeFileSync(sessionFile, "", "utf-8");
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do fresh work",
      agentConfig: makeAgent("worker", { model: "mock/test-model" }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      availableModels: [
        { provider: "mock", id: "test-model", fullId: "mock/test-model", contextWindow: 2000 },
      ],
      sessionFile,
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
    });
    const payload = JSON.parse(
      fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
    ) as AsyncResultPayload;
    assert.equal(payload.results[0]?.contextUsage?.restoredTokens, undefined);
    assert.equal(payload.results[0]?.terminationReason, "completed");
  });

  it("background durable resumes let explicit model overrides beat the restored identity and label them overrides", async () => {
    mockPi.onCall({ output: "Resumed with explicit override" });
    const id = `async-resume-override-${Date.now().toString(36)}`;
    const availableModels = [
      { provider: "openai", id: "gpt-5", fullId: "openai/gpt-5" },
      { provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
    ];
    const restored = { provider: "anthropic", model: "claude-sonnet-4", thinking: "high" } as const;
    const run = executeAsyncSingle(id, {
      agent: "worker",
      task: "Continue the paused work",
      agentConfig: makeAgent("worker"),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      availableModels,
      modelOverride: "openai/gpt-5",
      restoredModelIdentity: restored,
      modelResolution: {
        kind: "override",
        original: restored,
        reason:
          "Caller explicitly overrode persisted selection anthropic/claude-sonnet-4:high with 'openai/gpt-5'.",
      },
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
    });

    assert.equal(run.details.asyncId, id);
    const payload = JSON.parse(
      fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
    ) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.equal(payload.results[0]?.model, "openai/gpt-5");
    assert.equal(payload.results[0]?.modelResolution?.kind, "override");
    assert.deepEqual(payload.results[0]?.modelResolution?.original, restored);
    assert.deepEqual(payload.results[0]?.modelResolution?.resumed, {
      provider: "openai",
      model: "gpt-5",
    });
    assert.match(
      payload.results[0]?.modelResolution?.reason ?? "",
      /explicitly overrode persisted selection/,
    );
    const args = readMockPiArgs(mockPi, 0);
    assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-5");
  });

  it("background durable resumes keep unavailable restored models visible through runtime fallback", async () => {
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "restored model failed" }],
            model: "anthropic/claude-sonnet-4",
            errorMessage: "rate limit exceeded",
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
          },
        },
      ],
      exitCode: 1,
    });
    mockPi.onCall({ output: "Recovered on fallback model" });
    const id = `async-resume-unavailable-${Date.now().toString(36)}`;
    const availableModels = [{ provider: "openai", id: "gpt-5", fullId: "openai/gpt-5" }];
    const restored = { provider: "anthropic", model: "claude-sonnet-4", thinking: "high" } as const;
    const run = executeAsyncSingle(id, {
      agent: "worker",
      task: "Continue the paused work",
      agentConfig: makeAgent("worker", { fallbackModels: ["openai/gpt-5"] }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      availableModels,
      restoredModelIdentity: restored,
      modelResolution: {
        kind: "restored",
        original: restored,
        resumed: restored,
        reason:
          "Restored persisted child selection anthropic/claude-sonnet-4:high instead of the current parent model.",
      },
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
    });

    assert.equal(run.details.asyncId, id);
    const payload = JSON.parse(
      fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
    ) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.equal(payload.results[0]?.model, "openai/gpt-5:high");
    assert.deepEqual(payload.results[0]?.attemptedModels, [
      "anthropic/claude-sonnet-4:high",
      "openai/gpt-5:high",
    ]);
    assert.equal(payload.results[0]?.modelResolution?.kind, "fallback");
    assert.deepEqual(payload.results[0]?.modelResolution?.original, restored);
    assert.deepEqual(payload.results[0]?.modelResolution?.resumed, {
      provider: "openai",
      model: "gpt-5",
      thinking: "high",
    });
    const reason = payload.results[0]?.modelResolution?.reason ?? "";
    assert.match(
      reason,
      /Runtime fallback selected 'openai\/gpt-5:high' after 'anthropic\/claude-sonnet-4:high' failed/,
    );
    assert.equal(mockPi.callCount(), 2);
  });

  it("background runtime fallback persists the full transition in status during the crash window", async () => {
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "restored model failed" }],
            model: "anthropic/claude-sonnet-4",
            errorMessage: "rate limit exceeded",
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
          },
        },
      ],
      exitCode: 1,
    });
    mockPi.onCall({ output: "Recovered on fallback model", delay: scaleTestTimeout(3_000) });
    const id = `async-fallback-crash-window-${Date.now().toString(36)}`;
    const availableModels = [{ provider: "openai", id: "gpt-5", fullId: "openai/gpt-5" }];
    const restored = { provider: "anthropic", model: "claude-sonnet-4", thinking: "high" } as const;
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Continue the paused work",
      agentConfig: makeAgent("worker", { fallbackModels: ["openai/gpt-5"] }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      availableModels,
      restoredModelIdentity: restored,
      modelResolution: {
        kind: "restored",
        original: restored,
        resumed: restored,
        reason:
          "Restored persisted child selection anthropic/claude-sonnet-4:high instead of the current parent model.",
      },
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
    });

    // Simulated crash window: the second (fallback) attempt is running but the
    // terminal result has not been persisted yet. The last status write must
    // already carry the original identity, fallback reason, attempted models,
    // and completed attempt history so a durable resume after a crash cannot
    // mistake the fallback for the original selection.
    const crashWindowStatus = await waitForAsyncStatusPredicate(
      path.join(ASYNC_DIR, id),
      (status) =>
        status.steps?.[0]?.modelResolution?.kind === "fallback" &&
        status.steps?.[0]?.modelAttempts?.length === 1,
      "fallback transition persisted before the terminal result",
    );
    assert.ok(
      !fs.existsSync(path.join(RESULTS_DIR, `${id}.json`)),
      "expected the crash-window snapshot before the terminal result was persisted",
    );
    const step = crashWindowStatus.steps?.[0];
    assert.equal(step?.model, "openai/gpt-5:high");
    assert.deepEqual(step?.modelIdentity, { provider: "openai", model: "gpt-5", thinking: "high" });
    assert.deepEqual(step?.modelResolution?.original, restored);
    assert.deepEqual(step?.modelResolution?.resumed, {
      provider: "openai",
      model: "gpt-5",
      thinking: "high",
    });
    assert.match(
      step?.modelResolution?.reason ?? "",
      /Runtime fallback selected 'openai\/gpt-5:high' after 'anthropic\/claude-sonnet-4:high' failed/,
    );
    assert.deepEqual(step?.attemptedModels, [
      "anthropic/claude-sonnet-4:high",
      "openai/gpt-5:high",
    ]);
    assert.equal(step?.modelAttempts?.[0]?.success, false);

    // The run then completes normally with the terminal resolution intact.
    const payload = JSON.parse(
      fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
    ) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.equal(payload.results[0]?.modelResolution?.kind, "fallback");
    assert.deepEqual(payload.results[0]?.modelResolution?.original, restored);
  });

  it("background durable resumes surface model-scope violations for restored selections without silent switches", async () => {
    mockPi.onCall({ output: "Resumed outside the configured scope" });
    const id = `async-resume-scope-${Date.now().toString(36)}`;
    const availableModels = [
      { provider: "openai", id: "gpt-5", fullId: "openai/gpt-5" },
      { provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
    ];
    const restored = { provider: "anthropic", model: "claude-sonnet-4", thinking: "high" } as const;
    const run = executeAsyncSingle(id, {
      agent: "worker",
      task: "Continue the paused work",
      agentConfig: makeAgent("worker"),
      ctx: {
        pi: { events: { emit() {} } },
        cwd: tempDir,
        currentSessionId: "session-1",
        modelScope: { enforce: true, allow: ["openai/*"] },
      },
      availableModels,
      restoredModelIdentity: restored,
      modelResolution: {
        kind: "restored",
        original: restored,
        resumed: restored,
        reason:
          "Restored persisted child selection anthropic/claude-sonnet-4:high instead of the current parent model.",
      },
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
    });

    assert.equal(run.details.asyncId, id);
    const payload = JSON.parse(
      fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
    ) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.equal(payload.results[0]?.model, "anthropic/claude-sonnet-4:high");
    assert.equal(payload.results[0]?.modelResolution?.kind, "restored");
    assert.deepEqual(payload.results[0]?.modelResolution?.resumed, restored);
    const reason = payload.results[0]?.modelResolution?.reason ?? "";
    assert.match(reason, /Restored persisted child selection/);
    assert.match(reason, /outside the configured subagent model scope/);
    const statusPayload = JSON.parse(
      fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.equal(statusPayload.steps?.[0]?.modelResolution?.kind, "restored");
    assert.deepEqual(statusPayload.steps?.[0]?.modelIdentity, restored);
    assert.equal(statusPayload.steps?.[0]?.thinking, "high");
  });

  it("background runs forward max thinking suffixes without capability gating", async () => {
    mockPi.onCall({ output: "Done asynchronously" });
    const id = `async-thinking-metadata-missing-${Date.now().toString(36)}`;
    const model = "anthropic/claude-sonnet-4-5";
    const availableModels = [
      {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        fullId: model,
        reasoning: true,
      },
    ];
    const run = executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", { model, thinking: "max" }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      availableModels,
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
    });

    assert.equal(run.details.asyncId, id);
    const payload = JSON.parse(
      fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
    ) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.equal(payload.results[0]?.model, `${model}:max`);
    const args = readMockPiArgs(mockPi, 0);
    assert.equal(args[args.indexOf("--model") + 1], `${model}:max`);
  });

  it("deduplicates fallback candidates after effective thinking suffix application", async () => {
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "primary failed" }],
            model: "openai/primary",
            errorMessage: "HTTP 503 Service Unavailable",
            usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        },
      ],
      exitCode: 1,
    });
    mockPi.onCall({ output: "Recovered on the distinct fallback" });
    const id = `async-fallback-effective-dedupe-${Date.now().toString(36)}`;
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", {
        model: "openai/primary",
        fallbackModels: ["openai/primary:high", "anthropic/backup"],
        thinking: "high",
      }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dedupe" },
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
    });

    const payload = JSON.parse(
      fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
    ) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.deepEqual(payload.results[0]?.attemptedModels, [
      "openai/primary:high",
      "anthropic/backup:high",
    ]);
    const firstArgs = readMockPiArgs(mockPi, 0);
    const secondArgs = readMockPiArgs(mockPi, 1);
    assert.equal(firstArgs[firstArgs.indexOf("--model") + 1], "openai/primary:high");
    assert.equal(secondArgs[secondArgs.indexOf("--model") + 1], "anthropic/backup:high");
    assert.equal(mockPi.callCount(), 2);
  });

  it("background runs try agent fallback models and only persist notices after a retry", async () => {
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
    });
    mockPi.onCall({ output: "Recovered asynchronously on agent fallback" });
    const id = `async-dispatch-fallback-${Date.now().toString(36)}`;
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", {
        model: "openai/gpt-5-mini",
        fallbackModels: ["google/gemini-2.5-pro"],
      }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      modelFallbackNotice: "Agent fallback engaged",
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
    });

    const started = Date.now();
    while (!fs.existsSync(resultPath)) {
      if (Date.now() - started > scaleTestTimeout(15_000)) {
        assert.fail(`Timed out waiting for async result file: ${resultPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.deepEqual(payload.results[0].attemptedModels, [
      "openai/gpt-5-mini",
      "google/gemini-2.5-pro",
    ]);
    assert.equal(payload.results[0].modelFallbackNotice, "Agent fallback engaged");
    assert.match(payload.results[0].output ?? "", /^\[fallback\]/);
    assert.match(payload.results[0].output ?? "", /Notice: Agent fallback engaged/);
    assert.equal(mockPi.callCount(), 2);
  });

  it("background single applies agent thinking to primary and fallback suffixes", async () => {
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "primary failed" }],
            model: "openai/gpt-5-mini",
            errorMessage: "rate limit exceeded",
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
          },
        },
      ],
      exitCode: 1,
    });
    mockPi.onCall({ output: "Recovered asynchronously" });
    const id = `async-fallback-thinking-off-${Date.now().toString(36)}`;
    const run = executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", {
        model: "openai/gpt-5-mini",
        fallbackModels: ["anthropic/claude-sonnet-4"],
        thinking: "off",
      }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      availableModels: [
        { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
        { provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
      ],
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
    });

    assert.equal(run.details.asyncId, id);
    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    const firstArgs = readMockPiArgs(mockPi, 0);
    const secondArgs = readMockPiArgs(mockPi, 1);
    assert.equal(payload.success, true);
    assert.equal(payload.results[0].model, "anthropic/claude-sonnet-4:off");
    assert.deepEqual(payload.results[0].attemptedModels, [
      "openai/gpt-5-mini:off",
      "anthropic/claude-sonnet-4:off",
    ]);
    assert.equal(firstArgs[firstArgs.indexOf("--model") + 1], "openai/gpt-5-mini:off");
    assert.equal(secondArgs[secondArgs.indexOf("--model") + 1], "anthropic/claude-sonnet-4:off");
  });

  it("background runs stop without fallback after a zero-exit attempt has empty output", async () => {
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
    const id = `async-empty-output-nontransient-${Date.now().toString(36)}`;
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", {
        model: "openai/gpt-5-mini",
        fallbackModels: ["anthropic/claude-sonnet-4"],
      }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      maxSubagentDepth: 2,
    });

    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    assert.equal(payload.success, false);
    assert.equal(payload.results[0]?.model, "openai/gpt-5-mini");
    assert.match(payload.results[0]?.modelAttempts?.[0]?.error ?? "", /no output/i);
    assert.deepEqual(
      payload.results[0]?.modelAttempts?.map((attempt) => attempt.success),
      [false],
    );
    assert.equal(mockPi.callCount(), 1);
  });

  it("persists pressure across status, terminal result, and metadata projections", async () => {
    mockPi.onCall({
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Pressure projection complete" }],
            model: "mock/test-model",
            stopReason: "stop",
            usage: {
              totalTokens: 950,
              input: 900,
              output: 50,
              cacheRead: 0,
              cacheWrite: 0,
              cost: { total: 0 },
            },
          },
        },
      ],
    });
    const id = `async-context-pressure-projection-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const artifactsDir = path.join(tempDir, "pressure-artifacts");
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Persist context pressure evidence",
      agentConfig: makeAgent("worker", { model: "mock/test-model" }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      availableModels: [
        { provider: "mock", id: "test-model", fullId: "mock/test-model", contextWindow: 1000 },
      ],
      artifactsDir,
      artifactConfig: {
        mode: "debug",
        enabled: true,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeTranscript: false,
        includeMetadata: true,
        includeChildEventProjections: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      maxSubagentDepth: 2,
    });

    const resultPath = await waitForAsyncResultFile(id);
    const resultPayload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    const result = resultPayload.results[0];
    assert.ok(result);
    assert.equal(resultPayload.success, true);
    assert.deepEqual(result.contextPressureCrossedThresholds, ["warning", "critical"]);
    assert.equal(result.contextPressure?.severity, "critical");
    assert.equal(result.contextPressure?.crossedThreshold, "critical");

    const statusPayload = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    const statusStep = statusPayload.steps?.[0];
    assert.ok(statusStep);
    assert.deepEqual(statusStep.contextPressureCrossedThresholds, ["warning", "critical"]);
    assert.equal(statusStep.contextPressure?.severity, "critical");
    assert.deepEqual(statusStep.tokens, { input: 900, output: 50, total: 950 });
    assert.deepEqual(statusPayload.totalTokens, { input: 900, output: 50, total: 950 });

    const metadataPath = result.artifactPaths?.metadataPath;
    assert.ok(metadataPath);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as {
      contextPressure?: {
        severity?: string;
        crossedThreshold?: string;
        contextTokens?: number;
        contextWindow?: number;
        contextPercent?: number;
        remainingTokens?: number;
        warnedAt?: number;
      };
      contextPressureCrossedThresholds?: string[];
    };
    assert.deepEqual(metadata.contextPressureCrossedThresholds, ["warning", "critical"]);
    assert.equal(metadata.contextPressure?.severity, "critical");
    assert.equal(metadata.contextPressure?.crossedThreshold, "critical");
    assert.equal(metadata.contextPressure?.contextTokens, 950);
    assert.equal(metadata.contextPressure?.contextWindow, 1000);
    assert.equal(metadata.contextPressure?.contextPercent, 95);
    assert.equal(metadata.contextPressure?.remainingTokens, 50);
    assert.equal(typeof metadata.contextPressure?.warnedAt, "number");
  });

  it("background fallback does not combine failed pressure diagnostics with a later empty attempt", async () => {
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
    const id = `async-fallback-context-pressure-${Date.now().toString(36)}`;
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", {
        model: "openai/gpt-5-mini",
        fallbackModels: ["anthropic/claude-sonnet-4"],
      }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      availableModels: [
        { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini", contextWindow: 1000 },
        {
          provider: "anthropic",
          id: "claude-sonnet-4",
          fullId: "anthropic/claude-sonnet-4",
          contextWindow: 1000,
        },
      ],
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      maxSubagentDepth: 2,
    });

    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    assert.equal(payload.success, false);
    assert.equal(payload.state, "failed");
    assert.equal(payload.exitCode, 1);
    assert.equal(payload.results[0]?.success, false);
    assert.equal(payload.results[0]?.exitCode, 1);
    assert.equal(payload.results[0]?.finalOutput, "");
    assert.notEqual(payload.results[0]?.terminationReason, "context_exhausted");
    assert.match(payload.results[0]?.error ?? "", /no output/i);
    assert.doesNotMatch(
      payload.results[0]?.error ?? "",
      /unfinished tool interaction under high context pressure/,
    );
    assert.equal(payload.results[0]?.contextUsage?.contextPercent, 99);
    assert.deepEqual(
      payload.results[0]?.modelAttempts?.map((attempt) => attempt.success),
      [false, false],
    );
  });

  it("background runs fail zero-exit provider errors when no fallback succeeds", async () => {
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
    const id = `async-zero-exit-provider-error-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      maxSubagentDepth: 2,
    });

    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    assert.equal(payload.success, false);
    assert.match(payload.results[0]?.error ?? "", /429 quota exceeded/);
    const statusPayload = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.equal(statusPayload.state, "failed");
    assert.match(statusPayload.steps?.[0]?.error ?? "", /429 quota exceeded/);
  });

  it("background runs treat recovered child errors as successful", async () => {
    mockPi.onCall({
      jsonl: [
        events.toolResult("read", "EISDIR: illegal operation on a directory", true),
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
        events.assistantMessage("Recovered asynchronously"),
      ],
    });
    const id = `async-recovered-child-error-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      maxSubagentDepth: 2,
    });

    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    assert.equal(payload.success, true);
    // Top-level lifecycle artifacts retain the historical `complete` spelling;
    // per-child terminalResult evidence uses the A1a `completed` label.
    assert.equal(payload.state, "complete");
    assert.equal(payload.exitCode, 0);
    assert.equal(payload.results[0]?.success, true);
    assert.equal(payload.results[0]?.error, undefined);
    assert.equal(payload.results[0]?.output, "Recovered asynchronously");
    const statusPayload = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.equal(statusPayload.state, "complete");
    assert.equal(statusPayload.steps?.[0]?.status, "complete");
    assert.equal(statusPayload.steps?.[0]?.exitCode, 0);
  });

  it("background runs keep provider errors failed when followed only by empty assistant output", async () => {
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
    const id = `async-provider-error-empty-stop-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      maxSubagentDepth: 2,
    });

    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    assert.equal(payload.success, false);
    assert.equal(payload.state, "failed");
    assert.equal(payload.exitCode, 1);
    assert.equal(payload.results[0]?.success, false);
    assert.match(payload.results[0]?.error ?? "", /provider transport failed/);
    assert.equal(payload.results[0]?.output, "");
    const statusPayload = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.equal(statusPayload.state, "failed");
    assert.equal(statusPayload.steps?.[0]?.status, "failed");
    assert.equal(statusPayload.steps?.[0]?.exitCode, 1);
  });
});

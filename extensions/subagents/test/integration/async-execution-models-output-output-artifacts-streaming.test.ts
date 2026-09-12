/** Integration tests for async execution – output, metadata, skills, and event streaming. */

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
import { scaleTestTimeout } from "../support/scale-timeout.ts";

import {
  ASYNC_DIR,
  type AsyncResultPayload,
  type AsyncStatusPayload,
  RESULTS_DIR,
  escapeRegExp,
  executeAsyncParallel,
  executeAsyncSingle,
  readLastMockPiArgs,
  readMockPiArgs,
  requestAsyncInterrupt,
  waitForAsyncControlCondition,
  waitForAsyncResultFile,
  waitForMockPiCall,
  writePackageSkill,
} from "../support/async-execution-helpers.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRecord(text: string, source: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error(`Expected JSON object in ${source}`);
  return parsed;
}

function readJsonRecord(filePath: string): Record<string, unknown> {
  return parseJsonRecord(fs.readFileSync(filePath, "utf-8"), filePath);
}

function readJsonRecords(value: unknown, source: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || !value.every(isRecord))
    throw new Error(`Expected JSON object array in ${source}`);
  return value;
}

function requiredString(value: unknown, source: string): string {
  if (typeof value !== "string") throw new Error(`Expected string in ${source}`);
  return value;
}

describe("async execution output and event streaming", () => {
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

  it("background summaries preserve ordered outcomes and cross-publication cost totals", async () => {
    const assistantEvent = (
      text: string,
      usage?: Record<string, unknown>,
      errorMessage?: string,
    ) => ({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        model: "mock/test-model",
        stopReason: errorMessage ? "error" : "stop",
        ...(errorMessage ? { errorMessage } : {}),
        ...(usage ? { usage } : {}),
      },
    });
    mockPi.onCall({
      matchArgIncludes: "ordered first task",
      jsonl: [assistantEvent("first output")],
    });
    mockPi.onCall({
      matchArgIncludes: "ordered second task",
      jsonl: [
        assistantEvent("second partial output", {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { total: 0 },
        }),
      ],
      stderr: "second failure",
      exitCode: 1,
    });
    mockPi.onCall({
      matchArgIncludes: "ordered third task",
      jsonl: [
        assistantEvent("third output", {
          input: 7,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { total: 0.004 },
        }),
      ],
    });

    const id = `async-summary-aggregation-${Date.now().toString(36)}`;
    executeAsyncParallel(id, {
      tasks: [
        { agent: "first", task: "ordered first task" },
        { agent: "second", task: "ordered second task" },
        { agent: "third", task: "ordered third task" },
      ],
      concurrency: 1,
      agents: [
        makeAgent("first", { completionGuard: false }),
        makeAgent("second", { completionGuard: false }),
        makeAgent("third", { completionGuard: false }),
      ],
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
    const payload = readJsonRecord(resultPath);
    const payloadResults = readJsonRecords(payload.results, "summary result payload");
    const asyncDir = path.join(ASYNC_DIR, id);
    assert.equal(payload.success, false);
    assert.equal(payload.summary, "second failure");
    const runLog = fs.readFileSync(path.join(asyncDir, `subagent-log-${id}.md`), "utf-8");
    assert.match(
      runLog,
      /## Summary\nfirst:\nfirst output\n\nsecond:\nsecond failure\n\nOutput:\nsecond partial output\n\nthird:\nthird output/,
    );
    assert.deepEqual(
      payloadResults.map((result) => result.agent),
      ["first", "second", "third"],
    );
    assert.equal(payloadResults[0]?.totalCost, undefined, "missing usage stays cost-less");
    assert.equal(payloadResults[1]?.totalCost, undefined, "zero usage stays cost-less");
    assert.deepEqual(payloadResults[2]?.totalCost, {
      inputTokens: 7,
      outputTokens: 0,
      costUsd: 0.004,
    });
    const totalCost = { inputTokens: 7, outputTokens: 0, costUsd: 0.004 };
    assert.deepEqual(payload.totalCost, totalCost);

    const status = readJsonRecord(path.join(asyncDir, "status.json"));
    assert.deepEqual(status.totalCost, totalCost);
    const completedEvent = fs
      .readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line, index) => parseJsonRecord(line, `events.jsonl line ${index + 1}`))
      .find((event) => event.type === "subagent.run.completed");
    assert.deepEqual(completedEvent?.totalCost, totalCost);
  });

  it("background summaries preserve empty aggregation after a prequeued interrupt", async () => {
    const id = `async-summary-prequeued-interrupt-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    fs.mkdirSync(asyncDir, { recursive: true });
    const interruptPath = requestAsyncInterrupt(asyncDir, {
      source: "async-summary-empty-test",
      reason: "before-runner-start",
    });
    assert.ok(fs.existsSync(interruptPath));

    const start = executeAsyncSingle(id, {
      agent: "worker",
      task: "This task must not start",
      agentConfig: makeAgent("worker", { completionGuard: false }),
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
    assert.equal(start.isError, undefined);

    const payload = readJsonRecord(await waitForAsyncResultFile(id));
    assert.equal(payload.state, "paused");
    assert.equal(payload.summary, "Paused after interrupt. Waiting for explicit next action.");
    assert.equal(payload.truncated, false);
    assert.equal(Object.hasOwn(payload, "totalCost"), false);
    assert.equal(readJsonRecords(payload.results, "prequeued interrupt results").length, 0);
    assert.equal(mockPi.callCount(), 0, "prequeued interrupt must skip child execution");

    const runLog = fs.readFileSync(path.join(asyncDir, `subagent-log-${id}.md`), "utf-8");
    assert.match(runLog, /## Summary\n\(no output\)/);
    const completedEvent = fs
      .readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line, index) => parseJsonRecord(line, `events.jsonl line ${index + 1}`))
      .find((event) => event.type === "subagent.run.completed");
    assert.equal(completedEvent?.totalCost, undefined);
  });

  it("background file-only runs write full output but return only a file reference", async () => {
    mockPi.onCall({ output: "async full output\nwith details" });
    const id = `async-file-only-${Date.now().toString(36)}`;
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    const outputPath = path.join(tempDir, "async-file-only.md");
    const run = executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker"),
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
      sessionRoot: path.join(tempDir, "sessions"),
      output: outputPath,
      outputMode: "file-only",
      maxSubagentDepth: 2,
    });

    assert.equal(run.details.asyncId, id);
    const deadline = Date.now() + scaleTestTimeout(10_000);
    while (!fs.existsSync(resultPath)) {
      if (Date.now() > deadline)
        assert.fail(`Timed out waiting for async result file: ${resultPath}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.match(payload.summary ?? "", /Output saved to:/);
    assert.match(payload.summary ?? "", /2 lines/);
    assert.doesNotMatch(payload.summary ?? "", /async full output/);
    assert.match(payload.results[0]?.output ?? "", /Output saved to:/);
    assert.doesNotMatch(payload.results[0]?.output ?? "", /async full output/);
    assert.equal(fs.readFileSync(outputPath, "utf-8"), "async full output\nwith details");
  });

  it("background summaries distinguish absent and empty maxOutput defaults", async () => {
    const oversizedOutput = "x".repeat(205_000);
    mockPi.onCall({
      matchArgIncludes: "absent max-output",
      output: oversizedOutput,
    });
    mockPi.onCall({
      matchArgIncludes: "empty max-output",
      output: oversizedOutput,
    });
    const artifactConfig = {
      enabled: false,
      includeInput: false,
      includeOutput: false,
      includeJsonl: false,
      includeMetadata: false,
      cleanupDays: 7,
    } as const;
    const run = (id: string, task: string, maxOutput?: Record<string, number>) =>
      executeAsyncSingle(id, {
        agent: "worker",
        task,
        agentConfig: makeAgent("worker", { completionGuard: false }),
        ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
        artifactConfig,
        shareEnabled: false,
        maxOutput,
        maxSubagentDepth: 2,
      });

    const absentId = `async-summary-max-output-absent-${Date.now().toString(36)}`;
    run(absentId, "absent max-output");
    const absentPayload = readJsonRecord(await waitForAsyncResultFile(absentId));
    const absentSummary = requiredString(absentPayload.summary, "absent max-output summary");
    assert.equal(absentPayload.truncated, false);
    assert.ok(absentSummary.includes(oversizedOutput));

    const emptyId = `async-summary-max-output-empty-${Date.now().toString(36)}`;
    run(emptyId, "empty max-output", {});
    const emptyPayload = readJsonRecord(await waitForAsyncResultFile(emptyId));
    const emptySummary = requiredString(emptyPayload.summary, "empty max-output summary");
    assert.equal(emptyPayload.truncated, true);
    assert.match(emptySummary, /\[TRUNCATED: showing first 2 of 2 lines/);
    assert.equal(emptySummary.includes(oversizedOutput), false);
  });

  it("background summaries honor byte/line limits and last-result artifact markers", async () => {
    mockPi.onCall({
      matchArgIncludes: "line-limited summary",
      output: "line one\nline two\nline three",
    });
    const lineId = `async-summary-line-limit-${Date.now().toString(36)}`;
    executeAsyncSingle(lineId, {
      agent: "worker",
      task: "line-limited summary",
      agentConfig: makeAgent("worker", { completionGuard: false }),
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
      maxOutput: { lines: 2, bytes: 1024 },
      maxSubagentDepth: 2,
    });
    const linePayload = readJsonRecord(await waitForAsyncResultFile(lineId));
    const lineSummary = requiredString(linePayload.summary, "line-limited summary");
    assert.equal(linePayload.truncated, true);
    assert.match(lineSummary, /\[TRUNCATED: showing first 2 of 4 lines/);
    assert.match(lineSummary, /line one/);
    assert.doesNotMatch(lineSummary, /line two/);

    const byteOutput = "😀".repeat(30);
    mockPi.onCall({
      matchArgIncludes: "byte-limited first",
      output: `${byteOutput}\nfirst tail`,
    });
    mockPi.onCall({
      matchArgIncludes: "byte-limited second",
      output: `${byteOutput}\nsecond tail`,
    });
    const parallelId = `async-summary-byte-limit-${Date.now().toString(36)}`;
    const artifactsDir = path.join(tempDir, `${parallelId}-artifacts`);
    executeAsyncParallel(parallelId, {
      tasks: [
        { agent: "first", task: "byte-limited first" },
        { agent: "second", task: "byte-limited second" },
      ],
      concurrency: 1,
      agents: [
        makeAgent("first", { completionGuard: false }),
        makeAgent("second", { completionGuard: false }),
      ],
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      maxOutput: { lines: 5000, bytes: 40 },
      artifactsDir,
      artifactConfig: {
        mode: "compact",
        enabled: true,
        includeInput: false,
        includeOutput: true,
        includeJsonl: false,
        includeMetadata: false,
        includeTranscript: false,
        includeChildEventProjections: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      maxSubagentDepth: 2,
    });
    const bytePayload = readJsonRecord(await waitForAsyncResultFile(parallelId));
    const byteResults = readJsonRecords(bytePayload.results, "byte-limited result payload");
    const byteSummary = requiredString(bytePayload.summary, "byte-limited summary");
    const firstArtifactPaths = byteResults[0]?.artifactPaths;
    const lastArtifactPaths = byteResults[1]?.artifactPaths;
    if (!isRecord(firstArtifactPaths) || !isRecord(lastArtifactPaths))
      throw new Error("expected output artifact paths");
    const firstArtifactPath = requiredString(
      firstArtifactPaths.outputPath,
      "first output artifact path",
    );
    const lastArtifactPath = requiredString(
      lastArtifactPaths.outputPath,
      "last output artifact path",
    );
    assert.equal(bytePayload.truncated, true);
    assert.ok(fs.existsSync(firstArtifactPath));
    assert.ok(fs.existsSync(lastArtifactPath));
    assert.match(byteSummary, new RegExp(`full output at ${escapeRegExp(lastArtifactPath)}`));
    assert.doesNotMatch(byteSummary, new RegExp(escapeRegExp(firstArtifactPath)));
    const markerEnd = byteSummary.indexOf("]\n");
    assert.ok(markerEnd >= 0, "expected a truncation marker");
    const keptBody = byteSummary.slice(markerEnd + 2);
    assert.ok(Buffer.byteLength(keptBody, "utf-8") <= 40);
  });

  it("background single runs route relative outputs to outputBaseDir", async () => {
    mockPi.onCall({ output: "async configured report" });
    const id = `async-configured-output-base-${Date.now().toString(36)}`;
    const outputBaseDir = path.join(tempDir, "async-configured-outputs");
    const run = executeAsyncSingle(id, {
      agent: "researcher",
      task: "Write report",
      agentConfig: makeAgent("researcher", { output: "context.md" }),
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
      sessionRoot: path.join(tempDir, "sessions"),
      output: "context.md",
      outputBaseDir,
      maxSubagentDepth: 2,
    });

    assert.equal(run.details.asyncId, id);
    const outputPath = path.join(outputBaseDir, "context.md");
    const call = await waitForMockPiCall(mockPi, 0);
    const taskArg = call.args.at(-1) ?? "";
    assert.match(
      taskArg,
      new RegExp(`Write your findings to exactly this path: ${escapeRegExp(outputPath)}`),
    );
    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.equal(fs.readFileSync(outputPath, "utf-8"), "async configured report");
    assert.equal(fs.existsSync(path.join(tempDir, "context.md")), false);
  });

  it("background single runs make output overrides authoritative in the child system prompt", async () => {
    mockPi.onCall({ output: "async override report" });
    const id = `async-output-override-system-prompt-${Date.now().toString(36)}`;
    const outputPath = path.join(tempDir, "async-custom-report.md");
    const run = executeAsyncSingle(id, {
      agent: "researcher",
      task: "Write report",
      agentConfig: makeAgent("researcher", {
        output: "default-report.md",
        systemPrompt:
          "Output format (`default-report.md`):\n\nWrite the full report to default-report.md.",
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
      sessionRoot: path.join(tempDir, "sessions"),
      output: outputPath,
      maxSubagentDepth: 2,
    });

    assert.equal(run.details.asyncId, id);
    const call = await waitForMockPiCall(mockPi, 0);
    const taskArg = call.args.at(-1) ?? "";
    const systemPrompt = call.systemPrompts[0]?.text ?? "";
    assert.match(
      taskArg,
      new RegExp(`Write your findings to exactly this path: ${escapeRegExp(outputPath)}`),
    );
    assert.match(systemPrompt, /Output format \(`default-report\.md`\):/);
    assert.match(systemPrompt, /Runtime output path override:/);
    assert.match(
      systemPrompt,
      new RegExp(`Write your findings to exactly this path: ${escapeRegExp(outputPath)}`),
    );
    assert.match(
      systemPrompt,
      /Ignore any other output filename or output path mentioned elsewhere/,
    );
    await waitForAsyncResultFile(id);
  });

  it("background single runs treat string false as disabled output", async () => {
    mockPi.onCall({ output: "async inline report" });
    const id = `async-string-false-output-${Date.now().toString(36)}`;
    const run = executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", { output: "default-report.md" }),
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
      sessionRoot: path.join(tempDir, "sessions"),
      output: "false",
      maxSubagentDepth: 2,
    });

    assert.equal(run.details.asyncId, id);
    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.equal(payload.results[0]?.output, "async inline report");
    assert.doesNotMatch(payload.summary ?? "", /Output saved to:/);
    assert.equal(fs.existsSync(path.join(tempDir, "false")), false);
    assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
    assert.doesNotMatch(
      readLastMockPiArgs(mockPi).at(-1) ?? "",
      /Write your findings to(?: exactly this path)?:/,
    );
  });

  it("background runs detect hidden tool failures even when the child exits 0", async () => {
    mockPi.onCall({
      jsonl: [events.toolResult("bash", "connection refused")],
    });

    const id = `async-hidden-failure-${Date.now().toString(36)}`;
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    const sessionRoot = path.join(tempDir, "sessions");

    executeAsyncSingle(id, {
      agent: "worker",
      task: "Deploy app",
      agentConfig: makeAgent("worker"),
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
      sessionRoot,
      maxSubagentDepth: 2,
    });

    const deadline = Date.now() + scaleTestTimeout(10_000);
    while (!fs.existsSync(resultPath)) {
      if (Date.now() > deadline) {
        assert.fail(`Timed out waiting for async result file: ${resultPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
    assert.equal(payload.success, false);
    assert.equal(payload.exitCode, 1);
    assert.equal(payload.results[0].success, false);
  });

  it("background implementation runs fail when no mutation attempt occurred", async () => {
    mockPi.onCall({ output: "I’ll do that now and report back after implementing." });

    const id = `async-no-mutation-${Date.now().toString(36)}`;
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    const sessionRoot = path.join(tempDir, "sessions");

    executeAsyncSingle(id, {
      agent: "worker",
      task: "Implement the approved fixes",
      agentConfig: makeAgent("worker"),
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
      sessionRoot,
      maxSubagentDepth: 2,
    });

    const deadline = Date.now() + scaleTestTimeout(10_000);
    while (!fs.existsSync(resultPath)) {
      if (Date.now() > deadline) {
        assert.fail(`Timed out waiting for async result file: ${resultPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
    assert.equal(payload.success, false);
    assert.equal(payload.exitCode, 1);
    assert.equal(payload.results[0].success, false);
    assert.match(String(payload.results[0].error ?? ""), /completed without making edits/);
    assert.match(
      String(payload.results[0].modelAttempts?.[0]?.error ?? ""),
      /completed without making edits/,
    );

    const eventsPath = path.join(ASYNC_DIR, id, "events.jsonl");
    const eventsText = fs.readFileSync(eventsPath, "utf-8");
    assert.match(eventsText, /"reason":"completion_guard"/);
    assert.match(eventsText, /Subagent failed: worker/);
    assert.doesNotMatch(eventsText, /Status:/);
    assert.doesNotMatch(eventsText, /Interrupt:/);
  });

  it("background bash-enabled non-implementation agents can opt out of the completion guard", async () => {
    mockPi.onCall({ output: "cold start test after patch" });

    const id = `async-completion-guard-optout-${Date.now().toString(36)}`;
    const sessionRoot = path.join(tempDir, "sessions");

    executeAsyncSingle(id, {
      agent: "test-runner",
      task: "Run cold start test after patch",
      agentConfig: makeAgent("test-runner", {
        tools: ["read", "grep", "bash", "ls"],
        completionGuard: false,
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
      sessionRoot,
      maxSubagentDepth: 2,
    });

    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
    assert.equal(payload.success, true);
    assert.equal(payload.exitCode, 0);
    assert.equal(payload.results[0].success, true);
    assert.equal(payload.results[0].output, "cold start test after patch");

    const eventsPath = path.join(ASYNC_DIR, id, "events.jsonl");
    const eventsText = fs.readFileSync(eventsPath, "utf-8");
    assert.doesNotMatch(eventsText, /"reason":"completion_guard"/);
  });

  it("background runs prefer the parent session provider for ambiguous bare model ids", async () => {
    mockPi.onCall({ output: "Done asynchronously" });

    const id = `async-provider-${Date.now().toString(36)}`;
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    const sessionRoot = path.join(tempDir, "sessions");

    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker", { model: "gpt-5-mini" }),
      ctx: {
        pi: { events: { emit() {} } },
        cwd: tempDir,
        currentSessionId: "session-1",
        currentModelProvider: "github-copilot",
      },
      availableModels: [
        { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
        { provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
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

    const deadline = Date.now() + scaleTestTimeout(10_000);
    while (!fs.existsSync(resultPath)) {
      if (Date.now() > deadline) {
        assert.fail(`Timed out waiting for async result file: ${resultPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
    assert.equal(payload.success, true);
    assert.equal(payload.results[0].model, "github-copilot/gpt-5-mini");
    assert.deepEqual(payload.results[0].attemptedModels, ["github-copilot/gpt-5-mini"]);
  });

  it("background single runs inherit the parent session model when no model is set", async () => {
    mockPi.onCall({ output: "Done asynchronously" });

    const id = `async-single-parent-model-${Date.now().toString(36)}`;
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker"),
      ctx: {
        pi: { events: { emit() {} } },
        cwd: tempDir,
        currentSessionId: "session-1",
        currentModelProvider: "deepseek",
        currentModel: { provider: "deepseek", id: "deepseek-v4-flash" },
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

    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.equal(payload.results[0].model, "deepseek/deepseek-v4-flash");
    assert.deepEqual(payload.results[0].attemptedModels, ["deepseek/deepseek-v4-flash"]);
    const args = readMockPiArgs(mockPi, 0);
    assert.equal(args[args.indexOf("--model") + 1], "deepseek/deepseek-v4-flash");
  });

  it("background parallel runs inherit the parent session model when no task or agent model is set", async () => {
    mockPi.onCall({ output: "Done asynchronously" });

    const id = `async-parallel-parent-model-${Date.now().toString(36)}`;
    executeAsyncParallel(id, {
      tasks: [{ agent: "worker", task: "Do work" }],
      agents: [makeAgent("worker")],
      ctx: {
        pi: { events: { emit() {} } },
        cwd: tempDir,
        currentSessionId: "session-1",
        currentModelProvider: "deepseek",
        currentModel: { provider: "deepseek", id: "deepseek-v4-flash" },
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

    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.equal(payload.results[0].model, "deepseek/deepseek-v4-flash");
    assert.deepEqual(payload.results[0].attemptedModels, ["deepseek/deepseek-v4-flash"]);
    const args = readMockPiArgs(mockPi, 0);
    assert.equal(args[args.indexOf("--model") + 1], "deepseek/deepseek-v4-flash");
  });

  it("background single runs propagate tk ticket metadata from the effective task cwd", async () => {
    mockPi.onCall({ output: "Done asynchronously" });
    const ticketRoot = createTempDir("pi-subagent-async-ticket-cwd-");
    const taskCwd = path.join(ticketRoot, "child", "nested");
    const id = `async-ticket-single-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const originalTicketsDir = process.env.TICKETS_DIR;

    try {
      delete process.env.TICKETS_DIR;
      fs.mkdirSync(path.join(ticketRoot, ".tickets"), { recursive: true });
      fs.mkdirSync(taskCwd, { recursive: true });
      fs.writeFileSync(
        path.join(ticketRoot, ".tickets", "psr-raw4.md"),
        "---\nid: psr-raw4\n---\n# Show active tk title\n",
        "utf-8",
      );
      executeAsyncSingle(id, {
        agent: "worker",
        task: "Run `tk show psr-raw4` first.",
        agentConfig: makeAgent("worker"),
        ctx: {
          pi: {
            events: {
              emit(channel: string, payload: unknown) {
                emitted.push({ channel, payload });
              },
            },
          },
          cwd: tempDir,
          currentSessionId: "session-1",
        },
        cwd: taskCwd,
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

      await waitForAsyncResultFile(id);
      const status = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      assert.deepEqual(status.tkTicket, { id: "psr-raw4", title: "Show active tk title" });
      assert.deepEqual(
        (
          emitted.find((entry) => entry.channel === "subagent:async-started")?.payload as
            | { tkTicket?: unknown }
            | undefined
        )?.tkTicket,
        { id: "psr-raw4", title: "Show active tk title" },
      );
    } finally {
      if (originalTicketsDir === undefined) delete process.env.TICKETS_DIR;
      else process.env.TICKETS_DIR = originalTicketsDir;
      removeTempDir(ticketRoot);
    }
  });

  it("background continuation launches preserve inherited tk ticket metadata when the follow-up omits tk show", async () => {
    mockPi.onCall({ output: "Done asynchronously" });
    const id = `async-ticket-continuation-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Continue from the paused work.",
      inheritedTkTicket: { id: "psr-raw4", title: "Show active tk title" },
      agentConfig: makeAgent("worker"),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      cwd: tempDir,
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

    await waitForAsyncResultFile(id);
    const status = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.deepEqual(status.tkTicket, { id: "psr-raw4", title: "Show active tk title" });
  });

  it("background parallel launches propagate step-cwd tk tickets and fail open for ambiguous matches", async () => {
    mockPi.onCall({ output: "parallel one done" });
    mockPi.onCall({ output: "parallel two done" });
    const ticketRoot = createTempDir("pi-subagent-async-parallel-ticket-");
    const ticketCwd = path.join(ticketRoot, "tasks", "alpha");
    const id = `async-ticket-parallel-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const originalTicketsDir = process.env.TICKETS_DIR;

    try {
      delete process.env.TICKETS_DIR;
      fs.mkdirSync(path.join(ticketRoot, ".tickets"), { recursive: true });
      fs.mkdirSync(ticketCwd, { recursive: true });
      fs.writeFileSync(
        path.join(ticketRoot, ".tickets", "psr-raw4.md"),
        "---\nid: psr-raw4\n---\n# Show active tk title\n",
        "utf-8",
      );
      executeAsyncParallel(id, {
        tasks: [
          { agent: "worker", task: "Run `tk show psr-raw4` first.", cwd: ticketCwd },
          { agent: "reviewer", task: "Do the review" },
        ],
        agents: [makeAgent("worker"), makeAgent("reviewer")],
        ctx: {
          pi: {
            events: {
              emit(channel: string, payload: unknown) {
                emitted.push({ channel, payload });
              },
            },
          },
          cwd: tempDir,
          currentSessionId: "session-1",
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

      await waitForAsyncResultFile(id);
      const status = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      assert.deepEqual(status.tkTicket, { id: "psr-raw4", title: "Show active tk title" });
      assert.deepEqual(
        (
          emitted.find((entry) => entry.channel === "subagent:async-started")?.payload as
            | { tkTicket?: unknown }
            | undefined
        )?.tkTicket,
        { id: "psr-raw4", title: "Show active tk title" },
      );

      mockPi.onCall({ output: "ambiguous one done" });
      mockPi.onCall({ output: "ambiguous two done" });
      const ambiguousId = `async-ticket-parallel-ambiguous-${Date.now().toString(36)}`;
      executeAsyncParallel(ambiguousId, {
        tasks: [
          { agent: "worker", task: "Run `tk show psr-raw4` first.", cwd: ticketCwd },
          { agent: "reviewer", task: "Run `tk show psr-other` first.", cwd: ticketCwd },
        ],
        agents: [makeAgent("worker"), makeAgent("reviewer")],
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
        sessionRoot: path.join(tempDir, "sessions"),
        maxSubagentDepth: 2,
      });
      await waitForAsyncResultFile(ambiguousId);
      const ambiguousStatus = JSON.parse(
        fs.readFileSync(path.join(ASYNC_DIR, ambiguousId, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      assert.equal(ambiguousStatus.tkTicket, undefined);
    } finally {
      if (originalTicketsDir === undefined) delete process.env.TICKETS_DIR;
      else process.env.TICKETS_DIR = originalTicketsDir;
      removeTempDir(ticketRoot);
    }
  });

  it("background runs resolve skills from the effective task cwd", async () => {
    mockPi.onCall({ output: "Done asynchronously" });
    const taskCwd = createTempDir("pi-subagent-async-task-cwd-");
    const id = `async-skill-cwd-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    const statusPath = path.join(asyncDir, "status.json");

    try {
      writePackageSkill(taskCwd, "async-task-cwd-skill");
      executeAsyncSingle(id, {
        agent: "worker",
        task: "Do work",
        agentConfig: makeAgent("worker", { skills: ["async-task-cwd-skill"] }),
        ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
        cwd: taskCwd,
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

      const deadline = Date.now() + scaleTestTimeout(10_000);
      while (!fs.existsSync(resultPath)) {
        if (Date.now() > deadline) {
          assert.fail(`Timed out waiting for async result file: ${resultPath}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
      const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
      assert.equal(payload.success, true);
      assert.deepEqual(status.steps?.[0]?.skills, ["async-task-cwd-skill"]);
    } finally {
      removeTempDir(taskCwd);
    }
  });

  it("background single runs report unavailable pi-subagents skill requests", () => {
    const id = `async-pi-subagents-skill-${Date.now().toString(36)}`;
    const result = executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker"),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      cwd: tempDir,
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
      skills: ["pi-subagents"],
      maxSubagentDepth: 2,
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /Skills not found: pi-subagents/);
  });

  it("background parallel runs resolve relative task cwd values against the shared cwd", async () => {
    mockPi.onCall({ output: "Done asynchronously" });
    const taskCwd = createTempDir("pi-subagent-async-task-cwd-");
    const id = `async-task-cwd-parallel-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    const statusPath = path.join(asyncDir, "status.json");

    try {
      writePackageSkill(path.join(taskCwd, "packages", "app"), "async-task-cwd-skill");
      executeAsyncParallel(id, {
        tasks: [{ agent: "worker", task: "Do work", cwd: "packages/app" }],
        agents: [makeAgent("worker", { skills: ["async-task-cwd-skill"] })],
        ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
        cwd: taskCwd,
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

      const deadline = Date.now() + scaleTestTimeout(10_000);
      while (!fs.existsSync(resultPath)) {
        if (Date.now() > deadline) {
          assert.fail(`Timed out waiting for async result file: ${resultPath}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
      const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
      assert.equal(payload.success, true);
      assert.equal(payload.sessionId, "session-1");
      assert.equal(status.sessionId, "session-1");
      assert.deepEqual(status.steps?.[0]?.skills, ["async-task-cwd-skill"]);
    } finally {
      removeTempDir(taskCwd);
    }
  });

  it("keeps top-level current tool/path aligned with still-running parallel children", async () => {
    mockPi.onCall({
      steps: [
        { jsonl: [events.toolStart("read", { path: "README.md" })] },
        {
          delay: 900,
          jsonl: [
            events.toolEnd("read"),
            events.toolResult("read", "done"),
            events.assistantMessage("reader done"),
          ],
        },
      ],
    });
    mockPi.onCall({
      steps: [
        { delay: 100, jsonl: [events.toolStart("edit", { path: "docs.md" })] },
        { delay: 100, jsonl: [events.toolEnd("edit"), events.toolResult("edit", "ok")] },
        { delay: 700, jsonl: [events.assistantMessage("editor done")] },
      ],
    });

    const id = `async-parallel-tool-sync-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);

    executeAsyncParallel(id, {
      tasks: [
        { agent: "reader", task: "Read" },
        { agent: "editor", task: "Edit" },
      ],
      agents: [makeAgent("reader"), makeAgent("editor")],
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
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
    });

    const statusPath = path.join(asyncDir, "status.json");
    const doneDeadline = Date.now() + scaleTestTimeout(10_000);
    let sawRunningTool = false;
    let invariantViolated = false;
    while (!fs.existsSync(resultPath) && Date.now() < doneDeadline) {
      if (fs.existsSync(statusPath)) {
        const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
        const runningTools = (status.steps ?? [])
          .filter((step) => step.status === "running" && typeof step.currentTool === "string")
          .map((step) => step.currentTool as string);
        if (runningTools.length > 0) {
          sawRunningTool = true;
          if (!status.currentTool || !runningTools.includes(status.currentTool)) {
            invariantViolated = true;
            break;
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!fs.existsSync(resultPath)) {
      assert.fail(`Timed out waiting for async result file: ${resultPath}`);
    }
    assert.equal(
      sawRunningTool,
      true,
      "expected at least one polling interval with a running step tool",
    );
    assert.equal(invariantViolated, false, "top-level currentTool drifted from running step tools");
  });

  it("background runs do not emit idle attention while a tool call is still running", async () => {
    mockPi.onCall({
      steps: [
        { jsonl: [events.toolStart("bash", { command: "echo still running" })] },
        { delay: 1_300, jsonl: [events.toolEnd("bash")] },
        { jsonl: [events.assistantMessage("Done after the tool finished.")] },
      ],
    });

    const id = `async-tool-inflight-idle-guard-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    executeAsyncSingle(id, {
      agent: "scout",
      task: "Investigate behavior",
      agentConfig: makeAgent("scout"),
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
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
      controlConfig: {
        enabled: true,
        needsAttentionAfterMs: 200,
        failedToolAttemptsBeforeAttention: 3,
        notifyOn: ["needs_attention"],
        notifyChannels: ["event", "async"],
      },
    });

    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    const eventText = fs.existsSync(path.join(asyncDir, "events.jsonl"))
      ? fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8")
      : "";
    const status = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.doesNotMatch(eventText, /"reason":"idle"/);
    assert.equal(status.activityState, undefined);
    assert.equal(status.steps?.[0]?.activityState, undefined);
    assert.equal(payload.state, "complete");
    assert.equal(payload.success, true);
  });

  it("background runs still emit idle attention after a tool finishes and the child goes silent", async () => {
    mockPi.onCall({
      steps: [
        { jsonl: [events.toolStart("bash", { command: "echo done" })] },
        { delay: 1_300, jsonl: [events.toolEnd("bash")] },
        { delay: 1_300, jsonl: [events.assistantMessage("Done after an idle gap.")] },
      ],
    });

    const id = `async-post-tool-idle-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    executeAsyncSingle(id, {
      agent: "scout",
      task: "Investigate behavior",
      agentConfig: makeAgent("scout"),
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
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
      controlConfig: {
        enabled: true,
        needsAttentionAfterMs: 200,
        failedToolAttemptsBeforeAttention: 3,
        notifyOn: ["needs_attention"],
        notifyChannels: ["event", "async"],
      },
    });

    const observed = await waitForAsyncControlCondition(asyncDir, (status, eventText) => {
      return (
        eventText.includes('"reason":"idle"') &&
        status.activityState === "needs_attention" &&
        status.steps?.[0]?.activityState === "needs_attention"
      );
    });
    assert.match(observed.eventText, /"type":"needs_attention"/);
    assert.match(observed.eventText, /"reason":"idle"/);

    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    assert.equal(payload.state, "complete");
    assert.equal(payload.success, true);
  });

  it("background runs escalate repeated mutating tool failures", async () => {
    mockPi.onCall({
      steps: [
        {
          jsonl: [
            events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }),
            events.toolEnd("edit"),
            events.toolResult("edit", "No exact match found for subagent-runner.ts", true),
          ],
        },
        {
          jsonl: [
            events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }),
            events.toolEnd("edit"),
            events.toolResult("edit", "No exact match found for subagent-runner.ts", true),
          ],
        },
        {
          jsonl: [
            events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }),
            events.toolEnd("edit"),
            events.toolResult("edit", "No exact match found for subagent-runner.ts", true),
          ],
        },
        { delay: 2_000, jsonl: [events.assistantMessage("I need another attempt.")] },
      ],
    });

    const id = `async-tool-failures-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const eventsPath = path.join(asyncDir, "events.jsonl");
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);

    executeAsyncSingle(id, {
      agent: "worker",
      task: "Implement the approved fixes",
      agentConfig: makeAgent("worker"),
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
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
      controlConfig: {
        enabled: true,
        needsAttentionAfterMs: 999_999,
        failedToolAttemptsBeforeAttention: 3,
        notifyOn: ["needs_attention"],
        notifyChannels: ["event", "async"],
      },
    });

    const statusPath = path.join(asyncDir, "status.json");
    const deadline = Date.now() + scaleTestTimeout(10_000);
    let eventText = "";
    let statusDuringEvent: AsyncStatusPayload | undefined;
    while (Date.now() < deadline) {
      if (fs.existsSync(eventsPath)) {
        eventText = fs.readFileSync(eventsPath, "utf-8");
      }
      if (eventText.includes('"reason":"tool_failures"') && fs.existsSync(statusPath)) {
        const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
        if (
          status.activityState === "needs_attention" &&
          status.steps?.[0]?.activityState === "needs_attention"
        ) {
          statusDuringEvent = status;
          break;
        }
      }
      if (eventText.includes('"reason":"tool_failures"') && fs.existsSync(resultPath)) {
        assert.fail("run completed before status.json exposed needs_attention");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.match(eventText, /"type":"needs_attention"/);
    assert.match(eventText, /"reason":"tool_failures"/);
    assert.match(eventText, /subagent-runner\.ts/);
    assert.ok(
      statusDuringEvent,
      "expected status.json to expose needs_attention while the run is still active",
    );
    assert.equal(statusDuringEvent.activityState, "needs_attention");
    assert.equal(statusDuringEvent.steps?.[0]?.activityState, "needs_attention");

    const doneDeadline = Date.now() + scaleTestTimeout(10_000);
    while (!fs.existsSync(resultPath)) {
      if (Date.now() > doneDeadline)
        assert.fail(`Timed out waiting for async result file: ${resultPath}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });

  it("background event logs drop noisy message updates and cap child diagnostics", async () => {
    const previousMaxBytes = process.env.PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES;
    process.env.PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES = "900";
    try {
      mockPi.onCall({
        steps: [
          {
            jsonl: [
              {
                type: "message_update",
                assistantMessageEvent: {
                  type: "thinking_delta",
                  delta: "NOISY_PARTIAL_DELTA",
                  partial: {
                    role: "assistant",
                    content: [{ type: "text", text: "NOISY_PARTIAL_SNAPSHOT".repeat(200) }],
                  },
                },
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "NOISY_PARTIAL_MESSAGE".repeat(200) }],
                },
              },
              events.toolStart("bash", { command: `echo ${"BIG_COMMAND_PAYLOAD".repeat(200)}` }),
              events.assistantMessage("Done after noisy stream"),
            ],
          },
        ],
      });

      const id = `async-noisy-events-${Date.now().toString(36)}`;
      const asyncDir = path.join(ASYNC_DIR, id);
      const sessionRoot = path.join(tempDir, "sessions");

      executeAsyncSingle(id, {
        agent: "worker",
        task: "Stream noisy diagnostics",
        agentConfig: makeAgent("worker"),
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
        sessionRoot,
        maxSubagentDepth: 2,
      });

      const resultPath = await waitForAsyncResultFile(id);
      const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
      assert.equal(payload.success, true);
      assert.equal(payload.results[0]?.output, "Done after noisy stream");

      const eventsText = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
      assert.doesNotMatch(eventsText, /"type":"message_update"/);
      assert.doesNotMatch(eventsText, /NOISY_PARTIAL_/);
      assert.doesNotMatch(eventsText, /BIG_COMMAND_PAYLOAD/);
      assert.match(eventsText, /"type":"subagent\.events\.truncated"/);
      assert.match(eventsText, /"droppedEventType":"tool_execution_start"/);
    } finally {
      if (previousMaxBytes === undefined) delete process.env.PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES;
      else process.env.PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES = previousMaxBytes;
    }
  });

  it("background runs stream child events and live output while active", async () => {
    mockPi.onCall({
      steps: [
        { delay: 200, jsonl: [events.toolStart("bash", { command: "ls" })] },
        {
          delay: 600,
          jsonl: [events.toolEnd("bash"), events.toolResult("bash", "file-a\nfile-b")],
        },
        {
          delay: 600,
          jsonl: [events.assistantMessage("Done streaming")],
          stderr: "warning: mock stderr\n",
        },
      ],
    });

    const id = `async-stream-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const eventsPath = path.join(asyncDir, "events.jsonl");
    const outputPath = path.join(asyncDir, "output-0.log");
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    const sessionRoot = path.join(tempDir, "sessions");

    executeAsyncSingle(id, {
      agent: "worker",
      task: "Stream detailed progress",
      agentConfig: makeAgent("worker"),
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
      sessionRoot,
      maxSubagentDepth: 2,
    });

    const liveDeadline = Date.now() + scaleTestTimeout(10_000);
    let sawChildEvent = false;
    let sawLiveOutput = false;
    while (Date.now() < liveDeadline && (!sawChildEvent || !sawLiveOutput)) {
      if (fs.existsSync(eventsPath)) {
        const content = fs.readFileSync(eventsPath, "utf-8");
        sawChildEvent =
          content.includes('"type":"tool_execution_start"') &&
          content.includes('"subagentSource":"child"');
      }
      if (fs.existsSync(outputPath)) {
        const content = fs.readFileSync(outputPath, "utf-8");
        sawLiveOutput =
          content.includes("bash: ls") ||
          content.includes("file-a") ||
          content.includes("warning: mock stderr");
      }
      if (sawChildEvent && sawLiveOutput) break;
      assert.equal(
        fs.existsSync(resultPath),
        false,
        "run finished before live observability was written",
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.equal(
      sawChildEvent,
      true,
      "expected child JSON events to be streamed into events.jsonl",
    );
    assert.equal(sawLiveOutput, true, "expected output-0.log to receive live child output");

    const doneDeadline = Date.now() + scaleTestTimeout(10_000);
    while (!fs.existsSync(resultPath)) {
      if (Date.now() > doneDeadline) {
        assert.fail(`Timed out waiting for async result file: ${resultPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
    assert.equal(payload.success, true);
    assert.equal(payload.results[0].output, "Done streaming");

    const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
    assert.deepEqual(
      status.steps?.[0]?.recentTools?.map((tool: { tool: string; args: string }) => ({
        tool: tool.tool,
        args: tool.args,
      })),
      [{ tool: "bash", args: "ls" }],
    );
    assert.deepEqual(status.steps?.[0]?.recentOutput, ["file-a", "file-b", "Done streaming"]);
  });

  it("keeps non-object child JSON in background output and preserves unknown object events", async () => {
    const unknownEvent = {
      type: "future_event",
      extraField: { nested: true },
      anotherField: ["preserve", 7],
    };
    mockPi.onCall({
      jsonl: [null, [1, "two"], JSON.stringify("primitive"), 42, unknownEvent],
    });

    const id = `async-json-guards-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const artifactsDir = path.join(tempDir, "json-guard-artifacts");
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Handle child JSON protocol lines",
      agentConfig: makeAgent("worker"),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      artifactsDir,
      artifactConfig: {
        enabled: true,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeTranscript: true,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
    });

    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.equal(payload.results[0]?.output, ["null", '[1,"two"]', '"primitive"', "42"].join("\n"));

    const eventRecords = fs
      .readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const rawLines = eventRecords
      .filter((event) => event.type === "subagent.child.stdout")
      .map((event) => event.line);
    assert.deepEqual(rawLines, ["null", '[1,"two"]', '"primitive"', "42"]);
    const transcriptPath = payload.results[0]?.transcriptPath;
    assert.ok(transcriptPath, "expected transcript artifact");
    const transcriptRecords = fs
      .readFileSync(transcriptPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { recordType?: string; text?: string });
    assert.deepEqual(
      transcriptRecords
        .filter((record) => record.recordType === "stdout")
        .map((record) => record.text),
      [...rawLines, JSON.stringify(unknownEvent)],
    );
    const preservedEvent = eventRecords.find((event) => event.type === unknownEvent.type);
    assert.deepEqual(preservedEvent?.extraField, unknownEvent.extraField);
    assert.deepEqual(preservedEvent?.anotherField, unknownEvent.anotherField);
  });
});

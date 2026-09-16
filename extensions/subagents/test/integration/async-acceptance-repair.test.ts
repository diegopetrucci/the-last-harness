import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import {
  createEventBus,
  createMockPi,
  createTempDir,
  makeAgent,
  makeMinimalCtx,
  removeTempDir,
} from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import { executeAsyncSingle } from "../../src/runs/background/async-execution.ts";
import {
  ASYNC_DIR,
  type AsyncResultPayload,
  type AsyncStatusPayload,
  readMockPiArgs,
  requestAsyncInterrupt,
  waitForAsyncResultFile,
  waitForAsyncStatusPredicate,
  waitForMockPiCall,
  createSubagentExecutor,
} from "../support/async-execution-helpers.ts";

type AsyncSingleInput = Parameters<typeof executeAsyncSingle>[1];

const mockExtensionApi = Object.assign(Object.create(null), {
  events: {
    emit() {},
    on() {
      return () => {};
    },
  },
}) as ExtensionAPI;

function checkedAcceptanceReport(criterionId: string): string {
  return [
    "corrected report",
    "```acceptance-report",
    JSON.stringify({
      criteriaSatisfied: [{ id: criterionId, status: "satisfied", evidence: "existing result" }],
      changedFiles: ["src/changed.ts"],
      testsAddedOrUpdated: ["test/changed.test.ts"],
      commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
      residualRisks: [],
      noStagedFiles: true,
    }),
    "```",
  ].join("\n");
}

function asyncParams(
  tempDir: string,
  sessionRoot: string,
  artifactsDir: string,
  overrides: Partial<AsyncSingleInput> = {},
): AsyncSingleInput {
  return {
    agent: "worker",
    task: "async report repair task",
    agentConfig: makeAgent("worker", {
      completionGuard: false,
      model: "mock/initial-model",
      thinking: "high",
    }),
    acceptance: {
      level: "checked",
      criteria: [{ id: "async-repair-scope", must: "The requested async change is complete" }],
    },
    ctx: { pi: mockExtensionApi, cwd: tempDir, currentSessionId: "session-1" },
    artifactsDir,
    artifactConfig: {
      mode: "compact",
      enabled: true,
      includeInput: true,
      includeOutput: true,
      includeJsonl: true,
      includeMetadata: true,
      includeTranscript: false,
      includeChildEventProjections: true,
      cleanupDays: 7,
    },
    shareEnabled: false,
    sessionRoot,
    maxSubagentDepth: 2,
    ...overrides,
  };
}

describe("async acceptance-report repair", () => {
  let tempDir: string;
  let mockPi: MockPi;
  let previousSessionDirFile: string | undefined;

  before(() => {
    mockPi = createMockPi();
    mockPi.install();
  });
  after(() => mockPi.uninstall());
  beforeEach(() => {
    tempDir = createTempDir();
    mockPi.reset();
    previousSessionDirFile = process.env.MOCK_PI_SESSION_DIR_FILE;
    process.env.MOCK_PI_SESSION_DIR_FILE = "1";
  });
  afterEach(() => {
    if (previousSessionDirFile === undefined) delete process.env.MOCK_PI_SESSION_DIR_FILE;
    else process.env.MOCK_PI_SESSION_DIR_FILE = previousSessionDirFile;
    removeTempDir(tempDir);
  });

  it("repairs once in the same session and preserves output and artifacts", async () => {
    const criterionId = "async-repair-scope";
    const id = `async-report-repair-${Date.now().toString(36)}`;
    const sessionRoot = path.join(tempDir, "sessions");
    const artifactsDir = path.join(tempDir, "artifacts");
    const malformedOutput = [
      "Original async implementation output.",
      "```acceptance-report",
      '{"criteriaSatisfied": [}',
      "```",
    ].join("\n");
    mockPi.onCall({ matchArgIncludes: "async report repair task", output: malformedOutput });
    mockPi.onCall({
      matchArgIncludes: "TLH Acceptance Report Repair",
      output: checkedAcceptanceReport(criterionId),
    });

    const previousSessionDirFile = process.env.MOCK_PI_SESSION_DIR_FILE;
    process.env.MOCK_PI_SESSION_DIR_FILE = "1";
    try {
      const start = executeAsyncSingle(id, asyncParams(tempDir, sessionRoot, artifactsDir));
      assert.equal(start.isError, undefined);

      const payload = JSON.parse(
        fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
      ) as AsyncResultPayload;
      const item = payload.results[0];
      assert.ok(item);
      assert.equal(payload.success, true);
      assert.equal(item.success, true);
      assert.equal(item.acceptance?.status, "checked");
      assert.equal(item.acceptance?.reportRepairAttempted, true);
      assert.equal(item.reportRepairAttempted, true);
      assert.match(item.output, /Original async implementation output/);
      assert.ok(item.output.includes('{"criteriaSatisfied": [}'));
      assert.equal(mockPi.callCount(), 2);

      const status = JSON.parse(
        fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
      ) as {
        activeRuntimeMs?: number;
        steps?: Array<{
          reportRepairAttempted?: boolean;
          totalCost?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
        }>;
      };
      assert.equal(status.steps?.[0]?.reportRepairAttempted, true);
      assert.ok((status.activeRuntimeMs ?? 0) > 0);
      assert.ok((status.steps?.[0]?.totalCost?.inputTokens ?? 0) >= 200);
      assert.ok((item.totalCost?.inputTokens ?? 0) >= 200);
      const childEvents = fs
        .readFileSync(path.join(ASYNC_DIR, id, "events.jsonl"), "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { subagentSource?: string; type?: string })
        .filter((event) => event.subagentSource === "child");
      assert.ok(
        childEvents.length >= 2,
        "both implementation and repair events should be projected",
      );

      const firstArgs = readMockPiArgs(mockPi, 0);
      const repairArgs = readMockPiArgs(mockPi, 1);
      assert.equal(firstArgs[firstArgs.indexOf("--model") + 1], "mock/initial-model:high");
      assert.equal(repairArgs[repairArgs.indexOf("--model") + 1], "mock/initial-model:high");
      const sessionDir = firstArgs[firstArgs.indexOf("--session-dir") + 1];
      const sessionFile = item.sessionFile;
      assert.equal(typeof sessionDir, "string");
      assert.equal(typeof sessionFile, "string");
      assert.ok(sessionFile?.startsWith(sessionDir ?? ""));
      assert.equal(repairArgs[repairArgs.indexOf("--session") + 1], sessionFile);
      assert.match(repairArgs.at(-1) ?? "", /TLH Acceptance Report Repair/);
      assert.ok(repairArgs.includes("--no-tools"));
      assert.ok(repairArgs.includes("--no-extensions"));
      assert.ok(repairArgs.includes("--no-skills"));

      assert.ok(item.artifactPaths, JSON.stringify(payload));
      const artifactOutput = fs.readFileSync(item.artifactPaths.outputPath, "utf-8");
      assert.match(artifactOutput, /Original async implementation output/);
      assert.ok(artifactOutput.includes('{"criteriaSatisfied": [}'));
      const metadata = JSON.parse(fs.readFileSync(item.artifactPaths.metadataPath, "utf-8")) as {
        reportRepairAttempted?: boolean;
      };
      assert.equal(metadata.reportRepairAttempted, true);
    } finally {
      if (previousSessionDirFile === undefined) delete process.env.MOCK_PI_SESSION_DIR_FILE;
      else process.env.MOCK_PI_SESSION_DIR_FILE = previousSessionDirFile;
    }
  });

  it("includes report-repair usage in async token diagnostics without a session directory ledger", async () => {
    const criterionId = "async-repair-token-scope";
    const id = `async-report-repair-tokens-${Date.now().toString(36)}`;
    const sessionRoot = path.join(tempDir, "sessions");
    const sessionFile = path.join(tempDir, "explicit-session", `${id}.jsonl`);
    const artifactsDir = path.join(tempDir, "artifacts");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    mockPi.onCall({
      matchArgIncludes: "async report repair task",
      output:
        "Original async implementation output without a report.\n```acceptance-report\n{bad\n```",
    });
    mockPi.onCall({
      matchArgIncludes: "TLH Acceptance Report Repair",
      output: checkedAcceptanceReport(criterionId),
    });

    executeAsyncSingle(
      id,
      asyncParams(tempDir, sessionRoot, artifactsDir, {
        sessionRoot: undefined,
        sessionFile,
      }),
    );

    const payload = JSON.parse(
      fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
    ) as AsyncResultPayload;
    const expectedTokens = { input: 200, output: 100, total: 300 };
    assert.deepEqual(payload.totalTokens, expectedTokens);
    const status = JSON.parse(
      fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.deepEqual(status.steps?.[0]?.tokens, expectedTokens);
    assert.deepEqual(status.totalTokens, expectedTokens);
    assert.deepEqual(payload.results[0]?.totalCost, {
      inputTokens: 200,
      outputTokens: 100,
      costUsd: 0.002,
    });
  });

  it("preserves the original malformed-report rejection when no session is tracked", async () => {
    const id = `async-report-repair-no-session-${Date.now().toString(36)}`;
    const sessionRoot = path.join(tempDir, "sessions");
    const artifactsDir = path.join(tempDir, "artifacts");
    mockPi.onCall({
      matchArgIncludes: "async report repair task",
      output: "Original output\n```acceptance-report\n{bad\n```",
    });

    executeAsyncSingle(
      id,
      asyncParams(tempDir, sessionRoot, artifactsDir, { sessionRoot: undefined }),
    );
    const payload = JSON.parse(
      fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
    ) as AsyncResultPayload;
    const item = payload.results[0];
    assert.equal(mockPi.callCount(), 1, "no correction child should launch without a session");
    assert.equal(item?.reportRepairAttempted, undefined);
    assert.equal(item?.acceptance?.reportRepairAttempted, undefined);
    assert.equal(item?.acceptance?.reportRepairError, undefined);
    assert.match(item?.error ?? "", /Acceptance rejected: Failed to parse acceptance-report/);
    assert.doesNotMatch(item?.error ?? "", /acceptance unverified/i);
  });

  it("bounds a slow correction by the parent timeout and keeps the original result", async () => {
    const id = `async-report-repair-timeout-${Date.now().toString(36)}`;
    const sessionRoot = path.join(tempDir, "sessions");
    const artifactsDir = path.join(tempDir, "artifacts");
    mockPi.onCall({
      matchArgIncludes: "async report repair task",
      output: "Original output without a report\n```acceptance-report\n{bad\n```",
    });
    mockPi.onCall({ matchArgIncludes: "TLH Acceptance Report Repair", delay: 3_000 });

    const startedAt = Date.now();
    executeAsyncSingle(id, asyncParams(tempDir, sessionRoot, artifactsDir, { timeoutMs: 1_000 }));
    const payload = JSON.parse(
      fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
    ) as AsyncResultPayload;
    assert.ok(Date.now() - startedAt < 5_000, "report repair should honor the parent deadline");
    assert.equal(mockPi.callCount(), 2);
    const timeoutItem = payload.results[0];
    assert.equal(timeoutItem?.reportRepairAttempted, true);
    assert.equal(timeoutItem?.acceptance, undefined);
    assert.match(
      fs.readFileSync(timeoutItem?.artifactPaths?.outputPath ?? "", "utf-8"),
      /Original output without a report/,
    );
  });

  it("preserves implementation output when the one correction fails", async () => {
    const id = `async-report-repair-failure-${Date.now().toString(36)}`;
    const sessionRoot = path.join(tempDir, "sessions");
    const artifactsDir = path.join(tempDir, "artifacts");
    mockPi.onCall({
      matchArgIncludes: "async report repair task",
      output: "Original output after implementation\n```acceptance-report\n{bad\n```",
    });
    mockPi.onCall({
      matchArgIncludes: "TLH Acceptance Report Repair",
      stderr: "correction process failed",
      exitCode: 1,
    });

    executeAsyncSingle(id, asyncParams(tempDir, sessionRoot, artifactsDir));
    const payload = JSON.parse(
      fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
    ) as AsyncResultPayload;
    const item = payload.results[0];
    assert.equal(mockPi.callCount(), 2);
    assert.equal(payload.success, false);
    assert.equal(item?.success, false);
    assert.equal(item?.reportRepairAttempted, true);
    assert.equal(item?.acceptance?.status, "rejected");
    assert.match(item?.acceptance?.reportRepairError ?? "", /repair failed/i);
    assert.match(item?.error ?? "", /Implementation complete but acceptance unverified/);
    assert.match(item?.output ?? "", /Original output after implementation/);
  });

  it("revives lifecycle state without attempting a second correction", async () => {
    const id = `async-report-repair-revive-${Date.now().toString(36)}`;
    const sessionRoot = path.join(tempDir, "sessions");
    const artifactsDir = path.join(tempDir, "artifacts");
    const agentConfig = makeAgent("worker", {
      completionGuard: false,
      model: "mock/initial-model",
      thinking: "high",
    });
    mockPi.onCall({
      matchArgIncludes: "async report repair task",
      output: "Original output before revival\n```acceptance-report\n{bad\n```",
    });
    mockPi.onCall({
      matchArgIncludes: "TLH Acceptance Report Repair",
      delay: 10_000,
    });

    executeAsyncSingle(id, asyncParams(tempDir, sessionRoot, artifactsDir, { agentConfig }));
    await waitForMockPiCall(mockPi, 1);
    const asyncDir = path.join(ASYNC_DIR, id);
    await waitForAsyncStatusPredicate(
      asyncDir,
      (status) => status.steps?.[0]?.reportRepairAttempted === true,
      "report repair marker before revival",
    );
    requestAsyncInterrupt(asyncDir, {
      source: "async-report-repair-revival-test",
      reason: "interrupt correction before revival",
    });
    const pausedPayload = JSON.parse(
      fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
    ) as AsyncResultPayload;
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")).steps?.[0]
        ?.reportRepairAttempted,
      true,
    );
    assert.equal(pausedPayload.results[0]?.reportRepairAttempted, true);
    assert.equal(
      JSON.parse(
        fs.readFileSync(pausedPayload.results[0]?.artifactPaths?.metadataPath ?? "", "utf-8"),
      ).reportRepairAttempted,
      true,
    );
    assert.equal(mockPi.callCount(), 2);

    const malformedResumeOutput =
      "Resumed output without a report\n```acceptance-report\n{still-bad\n```";
    mockPi.onCall({ output: malformedResumeOutput });
    const executor = createSubagentExecutor({
      pi: { events: createEventBus(), getSessionName: () => undefined },
      state: {
        baseCwd: tempDir,
        currentSessionId: null,
        asyncJobs: new Map(),
        foregroundControls: new Map(),
        lastForegroundControlId: null,
      },
      config: {},
      tempArtifactsDir: tempDir,
      getSubagentSessionRoot: () => sessionRoot,
      expandTilde: (value: string) => value,
      discoverAgents: () => ({ agents: [agentConfig] }),
    });
    const resumed = await executor.execute(
      "async-report-repair-revival-call",
      { action: "resume", id, message: "Continue after the interrupted correction." },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );
    assert.equal(resumed.isError, undefined);
    const resumedId = resumed.details?.asyncId;
    assert.ok(resumedId, "expected resumed async id");
    const resumedPayload = JSON.parse(
      fs.readFileSync(await waitForAsyncResultFile(resumedId), "utf-8"),
    ) as AsyncResultPayload;
    assert.equal(mockPi.callCount(), 3, "revival must not spend a second repair call");
    assert.equal(resumedPayload.results[0]?.reportRepairAttempted, true);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, resumedId, "status.json"), "utf-8"))
        .steps?.[0]?.reportRepairAttempted,
      true,
    );
    assert.equal(
      JSON.parse(
        fs.readFileSync(resumedPayload.results[0]?.artifactPaths?.metadataPath ?? "", "utf-8"),
      ).reportRepairAttempted,
      true,
    );
    assert.equal(resumedPayload.results[0]?.acceptance?.status, "rejected");
    assert.match(resumedPayload.results[0]?.output ?? "", /Resumed output without a report/);
    assert.match(
      fs.readFileSync(resumedPayload.results[0]?.artifactPaths?.outputPath ?? "", "utf-8"),
      /Resumed output without a report/,
    );
  });

  it("records one interrupted correction and does not retry it", async () => {
    const id = `async-report-repair-interrupt-${Date.now().toString(36)}`;
    const sessionRoot = path.join(tempDir, "sessions");
    const artifactsDir = path.join(tempDir, "artifacts");
    mockPi.onCall({
      matchArgIncludes: "async report repair task",
      output: "Original output before interruption\n```acceptance-report\n{bad\n```",
    });
    mockPi.onCall({
      matchArgIncludes: "TLH Acceptance Report Repair",
      delay: 10_000,
    });

    executeAsyncSingle(id, asyncParams(tempDir, sessionRoot, artifactsDir));
    await waitForMockPiCall(mockPi, 1);
    await waitForAsyncStatusPredicate(
      path.join(ASYNC_DIR, id),
      (status) => status.steps?.[0]?.reportRepairAttempted === true,
      "report repair marker",
    );
    requestAsyncInterrupt(path.join(ASYNC_DIR, id), {
      source: "async-report-repair-test",
      reason: "interrupt correction",
    });

    const payload = JSON.parse(
      fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
    ) as AsyncResultPayload;
    const interruptedItem = payload.results[0];
    assert.equal(mockPi.callCount(), 2);
    assert.equal(interruptedItem?.reportRepairAttempted, true);
    assert.equal(interruptedItem?.acceptance?.status, "skipped");
    assert.equal(interruptedItem?.acceptance?.reportRepairAttempted, true);
    assert.match(
      fs.readFileSync(interruptedItem?.artifactPaths?.outputPath ?? "", "utf-8"),
      /Original output before interruption/,
    );
  });
});

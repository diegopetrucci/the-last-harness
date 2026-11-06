import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import {
  ASYNC_DIR,
  executeAsyncParallel,
  waitForAsyncResultFile,
} from "../support/async-execution-helpers.ts";
import {
  createMockPi,
  createTempDir,
  makeAgent,
  removeTempDir,
  type MockPi,
  makeMinimalCtx,
  makeSubagentState,
} from "../support/helpers.ts";
import { DEFAULT_ARTIFACT_CONFIG, type ResolvedControlConfig } from "../../src/shared/types.ts";
import type {
  SubagentRunTelemetry,
  SubagentTelemetryProvenance,
} from "../../src/shared/telemetry.ts";
import { buildCompletionDetails } from "../../src/runs/background/notify.ts";
import { createSubagentExecutor } from "../support/single-execution-fixtures.ts";

const controls: ResolvedControlConfig = {
  enabled: true,
  needsAttentionAfterMs: 2_000,
  failedToolAttemptsBeforeAttention: 3,
  notifyOn: ["needs_attention"],
  notifyChannels: ["event", "async"],
};

const provenance: SubagentTelemetryProvenance = {
  tlhVersion: "test-tlh",
  piVersion: "test-pi",
  installGeneration: "test-generation",
  loadedAt: 123,
};

describe("subagent telemetry persistence", () => {
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

  it("persists one normalized envelope through async status, result, and completion details", async () => {
    mockPi.onCall({ output: "first done" });
    mockPi.onCall({ output: "second done" });
    const id = `telemetry-${Date.now().toString(36)}`;
    const started = executeAsyncParallel(id, {
      tasks: [
        { agent: "one", task: "first task" },
        { agent: "two", task: "second task" },
      ],
      concurrency: 2,
      agents: [makeAgent("one"), makeAgent("two")],
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "telemetry-session" },
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      maxSubagentDepth: 2,
      controlConfig: controls,
      telemetryProvenance: provenance,
    });

    assert.equal(started.isError, undefined);
    const resultPath = await waitForAsyncResultFile(id);
    const statusPath = path.join(ASYNC_DIR, id, "status.json");
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as {
      telemetry?: Record<string, unknown>;
      results: Array<{ agent: string }>;
    };
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8")) as {
      telemetry?: Record<string, unknown>;
    };

    assert.ok(result.telemetry);
    assert.deepEqual(result.telemetry, status.telemetry);
    assert.deepEqual(result.telemetry.provenance, provenance);
    assert.deepEqual(
      (result.telemetry.steps as Array<{ index: number; agent: string }>).map((step) => [
        step.index,
        step.agent,
      ]),
      [
        [0, "one"],
        [1, "two"],
      ],
    );
    assert.deepEqual(result.telemetry.run, {
      id,
      execution: "async",
      mode: "parallel",
    });

    const serializedTelemetry = JSON.stringify(result.telemetry);
    assert.doesNotMatch(serializedTelemetry, /"(?:task|prompt|output|cwd|path|args|settings)"\s*:/);

    const completion = buildCompletionDetails({
      id,
      agent: "one",
      state: "complete",
      success: true,
      summary: "complete",
      timestamp: Date.now(),
      results: result.results,
      telemetry: result.telemetry,
    });
    assert.deepEqual(completion.telemetry, result.telemetry);
  });

  it("persists the same provenance envelope through the async executor", async () => {
    // After async-only: execution is "async" not "foreground". Receipt contains telemetry.
    // Artifact metadata (child.artifactPaths.metadataPath) is read from async result.
    mockPi.onCall({ output: "foreground one done" });
    mockPi.onCall({ output: "foreground two done" });
    assert.ok(createSubagentExecutor, "executor fixture is available");
    const state = makeSubagentState({ baseCwd: tempDir });
    const agents = [makeAgent("foreground-one"), makeAgent("foreground-two")];
    const executor = createSubagentExecutor({
      pi: { events: { emit() {} } },
      state,
      config: { maxSubagentDepth: 2 },
      artifactConfig: DEFAULT_ARTIFACT_CONFIG,
      tempArtifactsDir: tempDir,
      getSubagentSessionRoot: () => tempDir,
      expandTilde: (value: string) => value,
      discoverAgents: () => ({ agents }),
      telemetryProvenance: provenance,
    });
    const ctx = makeMinimalCtx(tempDir);
    ctx.sessionManager.getSessionFile = () => path.join(tempDir, "async-parent.jsonl");
    const result = await executor.execute(
      "async-telemetry",
      {
        tasks: [
          { agent: "foreground-one", task: "Run the first async telemetry fixture." },
          { agent: "foreground-two", task: "Run the second async telemetry fixture." },
        ],
      },
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.equal(result.isError, undefined, result.content[0]?.text ?? "");
    const details = result.details as
      | (NonNullable<typeof result.details> & { telemetry?: SubagentRunTelemetry })
      | undefined;
    assert.ok(details);
    const telemetry = details.telemetry;
    assert.ok(telemetry);
    assert.deepEqual(telemetry.provenance, provenance);
    // After async-only: execution is "async" not "foreground"
    assert.deepEqual(telemetry.run, {
      id: telemetry.run.id,
      execution: "async",
      mode: "parallel",
    });

    // Wait for async completion and verify per-child artifact paths exist.
    // After async-only: single-step-execution metadata does not include a telemetry
    // envelope (that was foreground-only behavior); the run-level telemetry is in
    // the top-level async result file, which is already verified above via details.telemetry.
    const asyncId = details.asyncId;
    assert.ok(asyncId, "expected asyncId in receipt");
    const resultPath = await waitForAsyncResultFile(asyncId);
    const asyncResult = JSON.parse(fs.readFileSync(resultPath, "utf8")) as {
      results?: Array<{
        agent?: string;
        artifactPaths?: { metadataPath?: string };
      }>;
    };
    const asyncResults = asyncResult.results ?? [];
    assert.equal(asyncResults.length, 2);

    for (const [expectedIndex, child] of asyncResults.entries()) {
      assert.ok(
        child.artifactPaths?.metadataPath,
        `expected artifact paths for async child ${expectedIndex}`,
      );
      // After async-only: per-child metadata files do not carry a telemetry field
      // (foreground-only; async single-step-execution does not write telemetry to metadata).
      // Verify the metadata file is readable and contains the expected agent field.
      const metadata = JSON.parse(fs.readFileSync(child.artifactPaths!.metadataPath!, "utf8")) as {
        agent?: string;
        runId?: string;
      };
      assert.equal(
        metadata.agent,
        child.agent,
        `expected agent in metadata for child ${expectedIndex}`,
      );
    }
  });
});

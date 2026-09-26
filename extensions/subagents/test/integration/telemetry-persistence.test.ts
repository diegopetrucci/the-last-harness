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
import { createSubagentExecutor, runSync } from "../support/single-execution-fixtures.ts";

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
      shareEnabled: false,
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

  it("persists the same provenance envelope through the real foreground executor", async () => {
    mockPi.onCall({ output: "foreground one done" });
    mockPi.onCall({ output: "foreground two done" });
    assert.ok(createSubagentExecutor, "foreground executor fixture is available");
    assert.ok(runSync, "foreground execution fixture is available");
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
      runSync,
      telemetryProvenance: provenance,
    });
    const ctx = makeMinimalCtx(tempDir);
    ctx.sessionManager.getSessionFile = () => path.join(tempDir, "foreground-parent.jsonl");
    const result = await executor.execute(
      "foreground-telemetry",
      {
        tasks: [
          { agent: "foreground-one", task: "Run the first foreground telemetry fixture." },
          { agent: "foreground-two", task: "Run the second foreground telemetry fixture." },
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
    assert.deepEqual(telemetry.run, {
      id: telemetry.run.id,
      execution: "foreground",
      mode: "parallel",
    });
    assert.deepEqual(
      telemetry.steps.map((step) => [step.index, step.agent]),
      [
        [0, "foreground-one"],
        [1, "foreground-two"],
      ],
    );
    const results = details.results;
    assert.ok(results);
    assert.equal(results.length, 2);

    for (const [expectedIndex, child] of results.entries()) {
      assert.ok(
        child.artifactPaths,
        `expected artifact paths for foreground child ${expectedIndex}`,
      );
      const metadata = JSON.parse(fs.readFileSync(child.artifactPaths.metadataPath, "utf8")) as {
        telemetry?: {
          run?: { id?: string; execution?: string; mode?: string };
          steps?: Array<{ index?: number; agent?: string }>;
          provenance?: Record<string, unknown>;
        };
      };
      assert.ok(metadata.telemetry, `expected metadata telemetry for child ${expectedIndex}`);
      assert.deepEqual(metadata.telemetry.provenance, provenance);
      assert.deepEqual(metadata.telemetry.run, telemetry.run);
      assert.deepEqual(
        metadata.telemetry.steps?.map((step) => [step.index, step.agent]),
        [[expectedIndex, child.agent]],
      );
      const serializedMetadata = JSON.stringify(metadata.telemetry);
      assert.doesNotMatch(
        serializedMetadata,
        /"(?:task|prompt|output|cwd|path|args|settings)"\s*:/,
      );
      assert.doesNotMatch(serializedMetadata, /foreground (?:one|two) telemetry fixture/);
    }
  });
});

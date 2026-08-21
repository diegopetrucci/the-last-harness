/**
 * Integration coverage for ps-il5m: acceptance-report digest must survive onto
 * the artifact file on the BACKGROUND/async execution path (runSingleStep in
 * subagent-runner.ts), which is the motivating path for this whole PR.
 *
 * The async path is distinct from the foreground path in two ways:
 *   - rawOutput derives from finalResult.finalOutput (the raw RunPiStreamingResult,
 *     unstripped), NOT from getFinalOutput(messages).
 *   - The byte-exact-archive exception gates on resolvedOutput.savedPath rather
 *     than result.savedOutputPath.
 *
 * These tests pin that invariant so a future change to finalResult's feed
 * cannot silently drop the digest on the very path that motivated the fix.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import {
  createMockPi,
  createTempDir,
  removeTempDir,
  makeAgent,
  events,
  tryImport,
} from "../support/helpers.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";

interface ArtifactPaths {
  inputPath: string;
  outputPath: string;
  metadataPath: string;
}

interface AsyncSingleResultPayload {
  success: boolean;
  state?: string;
  exitCode?: number;
  results: Array<{
    agent?: string;
    output?: string;
    success?: boolean;
    exitCode?: number;
    artifactPaths?: ArtifactPaths;
  }>;
}

interface AsyncExecutionModule {
  isAsyncAvailable(): boolean;
  executeAsyncSingle(
    id: string,
    params: Record<string, unknown>,
  ): {
    content: Array<{ text?: string }>;
    isError?: boolean;
    details: { asyncId?: string };
  };
}

interface TypesModule {
  RESULTS_DIR: string;
  ASYNC_DIR: string;
}

const asyncMod = await tryImport<AsyncExecutionModule>("./src/runs/background/async-execution.ts");
const typesMod = await tryImport<TypesModule>("./src/shared/types.ts");

const executeAsyncSingle = asyncMod.executeAsyncSingle;
const RESULTS_DIR = typesMod.RESULTS_DIR;
const ASYNC_DIR = typesMod.ASYNC_DIR;
assert.equal(asyncMod.isAsyncAvailable(), true, "required async runner module is unavailable");

// Mirrors the default report the mock pi harness appends whenever the child
// prompt carries an acceptance contract.
const MOCK_COMMAND_EVIDENCE = /\[passed\] mock validation/;

async function waitForAsyncResultFile(
  id: string,
  timeoutMs = scaleTestTimeout(15_000),
): Promise<string> {
  const resultPath = path.join(RESULTS_DIR!, `${id}.json`);
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(resultPath)) {
    if (Date.now() > deadline)
      assert.fail(`Timed out waiting for async result file: ${resultPath}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return resultPath;
}

async function readAsyncPayload(id: string): Promise<AsyncSingleResultPayload> {
  const resultPath = await waitForAsyncResultFile(id);
  return JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncSingleResultPayload;
}

describe("async artifact digest surfacing (ps-il5m)", () => {
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

  function artifactOptions(runId: string) {
    return {
      artifactsDir: path.join(tempDir, `artifacts-${runId}`),
      artifactConfig: {
        enabled: true,
        includeInput: true,
        includeOutput: true,
        includeJsonl: false,
        includeMetadata: true,
        cleanupDays: 7,
      },
    };
  }

  // A read-only agent config still receives an acceptance contract (checked level),
  // so the mock emits a report without the completion guard tripping.
  function checkedParams(id: string) {
    return {
      agentConfig: makeAgent("reviewer", { tools: ["read", "grep"] }),
      ctx: {
        pi: { events: { emit() {} } },
        cwd: tempDir,
        currentSessionId: "session-async-digest",
      },
      shareEnabled: false,
      maxSubagentDepth: 2,
      acceptance: "checked",
      ...artifactOptions(id),
    };
  }

  it("surfaces validation evidence in the artifact for a completed async run", async () => {
    // The motivating case: the async path uses rawOutput = finalResult.finalOutput
    // (unstripped), so parseAcceptanceReport finds the block and the digest is live.
    mockPi.onCall({ jsonl: [events.assistantMessage("Async implementation complete.")] });
    const id = `async-digest-inline-${Date.now().toString(36)}`;

    const launch = executeAsyncSingle!(id, {
      agent: "reviewer",
      task: "Review-only. Do not edit.",
      ...checkedParams(id),
    });
    assert.equal(launch.isError, undefined, "async launch must not be an immediate error");

    const payload = await readAsyncPayload(id);
    assert.equal(payload.success, true);
    assert.ok(payload.results[0]?.artifactPaths, "expected artifactPaths in async result");
    const artifact = fs.readFileSync(payload.results[0]!.artifactPaths!.outputPath, "utf-8");

    // Prose is preserved verbatim at the head, and evidence now survives.
    assert.ok(
      artifact.startsWith("Async implementation complete."),
      "prose must lead the artifact",
    );
    assert.match(artifact, /Validation evidence/);
    assert.match(artifact, MOCK_COMMAND_EVIDENCE);
    // The raw block itself must be stripped; only the compact digest remains.
    assert.doesNotMatch(artifact, /```acceptance-report/);
  });

  it("keeps the semantic output free of the digest on the async path", async () => {
    // results[0].output is outputForSummary which starts from stripAcceptanceReport;
    // the digest must not be appended there — it belongs only in the artifact.
    mockPi.onCall({ jsonl: [events.assistantMessage("Async implementation complete.")] });
    const id = `async-digest-output-clean-${Date.now().toString(36)}`;

    const launch = executeAsyncSingle!(id, {
      agent: "reviewer",
      task: "Review-only. Do not edit.",
      ...checkedParams(id),
    });
    assert.equal(launch.isError, undefined, "async launch must not be an immediate error");

    const payload = await readAsyncPayload(id);
    assert.equal(payload.success, true);
    // The semantic output must be the stripped assistant text with nothing appended.
    assert.equal(payload.results[0]?.output, "Async implementation complete.");
    assert.doesNotMatch(payload.results[0]?.output ?? "", /Validation evidence/);
  });

  it("leaves the artifact byte-exact when the async run saved a user-requested output file", async () => {
    // With an `output:` path, resolvedOutput.savedPath is set so the
    // byte-exact-archive exception applies and no commentary is appended.
    const outputPath = path.join(tempDir, "deliverable.md");
    mockPi.onCall({ jsonl: [events.assistantMessage("async deliverable body")] });
    const id = `async-digest-output-file-${Date.now().toString(36)}`;

    const launch = executeAsyncSingle!(id, {
      agent: "reviewer",
      task: "Review-only. Do not edit.",
      ...checkedParams(id),
      output: outputPath,
    });
    assert.equal(launch.isError, undefined, "async launch must not be an immediate error");

    const payload = await readAsyncPayload(id);
    assert.equal(payload.success, true);
    assert.ok(payload.results[0]?.artifactPaths, "expected artifactPaths in async result");

    // The persisted output file must be byte-exact (no digest appended).
    assert.equal(fs.readFileSync(outputPath, "utf-8"), "async deliverable body");
    // The artifact is also a verbatim copy when a user-requested output file was saved.
    assert.equal(
      fs.readFileSync(payload.results[0]!.artifactPaths!.outputPath, "utf-8"),
      "async deliverable body",
    );
  });

  it("does not add a digest when the async run produced no acceptance report", async () => {
    // Acceptance disabled → no ## Acceptance Contract in the prompt → mock emits
    // no block → parseAcceptanceReport returns null → artifact stays bare.
    mockPi.onCall({ jsonl: [events.assistantMessage("async findings only")] });
    const id = `async-digest-absent-${Date.now().toString(36)}`;

    const launch = executeAsyncSingle!(id, {
      agent: "reviewer",
      task: "Summarize findings",
      agentConfig: makeAgent("reviewer"),
      ctx: {
        pi: { events: { emit() {} } },
        cwd: tempDir,
        currentSessionId: "session-async-digest",
      },
      shareEnabled: false,
      maxSubagentDepth: 2,
      acceptance: { level: "none", reason: "exercising the no-report async path" },
      ...artifactOptions(id),
    });
    assert.equal(launch.isError, undefined, "async launch must not be an immediate error");

    const payload = await readAsyncPayload(id);
    assert.equal(payload.success, true);
    assert.equal(payload.results[0]?.output, "async findings only");
    assert.ok(payload.results[0]?.artifactPaths, "expected artifactPaths in async result");
    const artifact = fs.readFileSync(payload.results[0]!.artifactPaths!.outputPath, "utf-8");
    assert.equal(artifact, "async findings only");
    assert.doesNotMatch(artifact, /Validation evidence/);
  });

  it("preserves raw output in artifact when acceptance-report block is present but invalid (async path)", async () => {
    // Fixture: criteriaSatisfied[].status is not a valid enum value.
    // Do NOT use commandsRun[].result — that field was made permissive in tlhm-uaw2.
    const invalidJson = JSON.stringify({
      criteriaSatisfied: [{ id: "c1", status: "INVALID_STATUS", evidence: "e" }],
      changedFiles: ["src/file.ts"],
      commandsRun: [{ command: "npm test", result: "passed", summary: "ok" }],
      validationOutput: [],
      residualRisks: [],
      noStagedFiles: true,
    });
    // Embed the invalid block directly so the mock does not replace it with a valid one.
    const textWithInvalidReport = `Async work done.\n\`\`\`acceptance-report\n${invalidJson}\n\`\`\``;
    mockPi.onCall({ jsonl: [events.assistantMessage(textWithInvalidReport)] });
    const id = `async-digest-invalid-${Date.now().toString(36)}`;

    const launch = executeAsyncSingle!(id, {
      agent: "reviewer",
      task: "Review-only. Do not edit.",
      ...checkedParams(id),
    });
    assert.equal(launch.isError, undefined, "async launch must not be an immediate error");

    const payload = await readAsyncPayload(id);
    // The run exits with a non-zero code because the explicit "checked" acceptance
    // gate rejects an invalid report. What matters is that the artifact is NOT
    // nearly empty — the raw block must survive so evidence is preserved.
    assert.equal(payload.results[0]?.exitCode, 1, "acceptance gate must reject the run");
    assert.ok(payload.results[0]?.artifactPaths, "expected artifactPaths in async result");
    const artifact = fs.readFileSync(payload.results[0]!.artifactPaths!.outputPath, "utf-8");

    // The raw acceptance-report block must survive in the artifact because
    // stripping is gated on parse success (shared-predicate fix).
    assert.ok(artifact.trim().length > 3, "artifact must not be nearly empty");
    assert.match(artifact, /acceptance-report/, "raw block must survive in artifact");
    // No digest — only valid reports get a digest.
    assert.doesNotMatch(artifact, /Validation evidence/);
  });

  it(
    "preserves raw output in artifact via the non-destruction floor when output is nearly-empty after stripping (async writer, tlhm-huto)",
    { timeout: scaleTestTimeout(20_000) },
    async () => {
      // DESIGN (see tlhm-huto):
      // To reach the floor at subagent-runner.ts, all three conditions must hold:
      //   1. Valid acceptance report — stripping is authorized.
      //   2. Prose is a bare horizontal rule — after strip, output becomes "---" (nearly-empty).
      //   3. Configured output path — resolvedOutput.savedPath is set, suppressing
      //      digest appending so the digest cannot mask the nearly-empty artifact.
      // Without the floor the artifact would be written as "---", silently
      // destroying evidence. The floor writes rawOutput instead.
      //
      // REMOVAL PROOF: delete the floor expression in subagent-runner.ts:
      //   const safeArtifactOutput = rawOutput.trim().length > 0 && isNearlyEmpty(artifactOutput)
      //     ? rawOutput : artifactOutput;
      // This test then fails because the artifact becomes "---" and
      // does not match /```acceptance-report/.
      const outputPath = path.join(tempDir, "async-floor-output.md");
      // Mock emits "---". withAcceptanceReport auto-appends the valid fence.
      // Full rawOutput: "---\n```acceptance-report\n{...}\n```".
      mockPi.onCall({ jsonl: [events.assistantMessage("---")] });
      const id = `async-floor-${Date.now().toString(36)}`;

      const launch = executeAsyncSingle!(id, {
        agent: "reviewer",
        task: "Review-only. Do not edit.",
        ...checkedParams(id),
        output: outputPath,
      });
      assert.equal(launch.isError, undefined, "async launch must not be an immediate error");

      const payload = await readAsyncPayload(id);
      assert.equal(payload.success, true);
      assert.ok(payload.results[0]?.artifactPaths, "expected artifactPaths in async result");
      const artifact = fs.readFileSync(payload.results[0]!.artifactPaths!.outputPath, "utf-8");

      // The floor preserved rawOutput. Without the floor, artifact = "---".
      assert.match(
        artifact,
        /```acceptance-report/,
        "floor must write raw output (fence preserved), not the stripped ---",
      );
      // The user-requested output file receives the stripped content.
      assert.equal(fs.readFileSync(outputPath, "utf-8"), "---");
    },
  );

  it(
    "preserves invalid acceptance-report block in the progress tail (invalid progress-tail path, tlhm-huto)",
    { timeout: scaleTestTimeout(20_000) },
    async () => {
      // Exercises the analyzeAcceptanceOutput(progressContent).strippedOutput call at
      // subagent-runner.ts (the appendRecentStepOutput site).
      //
      // For INVALID reports, analyzeAcceptanceOutput returns strippedOutput ===
      // progressContent (unchanged), so the block survives in recentOutput.
      // A naive strip (e.g., removing the fence regardless of validity) would
      // clear the block from the tail, losing evidence.
      //
      // REMOVAL PROOF: replace the call-site expression with naive fence removal
      // (e.g., a regex that strips the block unconditionally). The recentOutput
      // in the status file would then NOT contain "acceptance-report", and this
      // test’s assert.ok below would fail.
      //
      // Fixture: criteriaSatisfied[].status is not a valid enum value.
      const invalidJson = JSON.stringify({
        criteriaSatisfied: [{ id: "c1", status: "INVALID_STATUS", evidence: "e" }],
        changedFiles: ["src/file.ts"],
        commandsRun: [{ command: "npm test", result: "passed", summary: "ok" }],
        validationOutput: [],
        residualRisks: [],
        noStagedFiles: true,
      });
      // Embed the invalid block directly. withAcceptanceReport will not append
      // another fence because the text already contains one.
      const textWithInvalidReport = `Work in progress.\n\`\`\`acceptance-report\n${invalidJson}\n\`\`\``;
      mockPi.onCall({ jsonl: [events.assistantMessage(textWithInvalidReport)] });
      const id = `async-invalid-tail-${Date.now().toString(36)}`;

      const launch = executeAsyncSingle!(id, {
        agent: "reviewer",
        task: "Summarize findings",
        agentConfig: makeAgent("reviewer"),
        ctx: {
          pi: { events: { emit() {} } },
          cwd: tempDir,
          currentSessionId: "session-async-tail",
        },
        shareEnabled: false,
        maxSubagentDepth: 2,
        acceptance: { level: "none", reason: "exercising the invalid-tail path" },
        ...artifactOptions(id),
      });
      assert.equal(launch.isError, undefined, "async launch must not be an immediate error");

      // Wait for the run to complete before reading the status file.
      await readAsyncPayload(id);

      // Read the status file to observe recentOutput.
      const statusPath = path.join(ASYNC_DIR!, id, "status.json");
      assert.ok(fs.existsSync(statusPath), `status file must exist at ${statusPath}`);
      const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as {
        steps?: Array<{ recentOutput?: string[] }>;
      };
      const recentOutput = status.steps?.[0]?.recentOutput ?? [];

      // analyzeAcceptanceOutput preserves invalid block content in the tail.
      // Without the protection, the block would be stripped and this fails.
      assert.ok(
        recentOutput.some((line) => line.includes("acceptance-report")),
        `invalid acceptance-report block must be preserved in tail; got: ${JSON.stringify(recentOutput)}`,
      );
    },
  );
});

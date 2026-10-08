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
} from "../support/helpers.ts";
import { executeAsyncSingle, readAsyncPayload } from "../support/async-execution-helpers.ts";

const MOCK_COMMAND_EVIDENCE = /\[passed\] mock validation/;

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
      maxSubagentDepth: 2,
      acceptance: "checked",
      ...artifactOptions(id),
    };
  }

  it("surfaces validation evidence in the artifact for a completed async run", async () => {
    // The motivating case: the async path uses rawOutput = finalResult.finalOutput
    // (unstripped), so parseAndStripAcceptanceReport finds the block and the digest is live.
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
    // no block → parseAndStripAcceptanceReport returns no report → artifact stays bare.
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
});

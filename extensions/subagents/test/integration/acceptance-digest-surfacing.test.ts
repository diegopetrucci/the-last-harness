/**
 * Integration coverage for ps-9pj7: acceptance-report evidence must survive
 * stripAcceptanceReport on the supervisor-facing surface.
 *
 * The digest is appended to the artifact file only. result.finalOutput is a
 * semantic value (it feeds user-requested `output:` file contents and
 * chain/parallel output references), so it must stay byte-exact.
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
  makeAgentConfigs,
  events,
  tryImport,
} from "../support/helpers.ts";

interface ArtifactPaths {
  inputPath: string;
  outputPath: string;
  metadataPath: string;
}

interface SingleResultLike {
  exitCode?: number;
  finalOutput?: string;
  artifactPaths?: ArtifactPaths;
}

interface ExecutionModule {
  runSync?: (
    cwd: string,
    agents: unknown[],
    agent: string,
    task: string,
    options: Record<string, unknown>,
  ) => Promise<SingleResultLike>;
}

const execution = await tryImport<ExecutionModule>("./src/runs/foreground/execution.ts");
const runSync = execution?.runSync;
const available = !!runSync;

// Mirrors the default report the mock pi harness appends whenever the child
// prompt carries an acceptance contract.
const MOCK_COMMAND_EVIDENCE = /\[passed\] mock validation/;

describe(
  "acceptance-report digest surfacing",
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

    function artifactOptions(runId: string) {
      return {
        runId,
        artifactsDir: path.join(tempDir, `artifacts-${runId}`),
        artifactConfig: {
          enabled: true,
          includeInput: true,
          includeOutput: true,
          includeMetadata: true,
        },
      };
    }

    // A read-only agent still receives an acceptance contract (attested level), so the
    // mock emits a report without the completion guard tripping on a missing edit.
    const readOnlyAgents = () => [makeAgent("reviewer", { tools: ["read", "grep"] })];
    const readOnlyTask = "Review-only. Do not edit.";

    it("surfaces validation evidence in the artifact for a one-sentence report", async () => {
      // The exact observed failure shape: substantive work, but the only prose is a
      // single short sentence sharing a text part with the acceptance-report block.
      // Stripping the block used to leave ~50 bytes with no evidence at all.
      mockPi.onCall({ jsonl: [events.assistantMessage("Implementation complete.")] });

      const result = await runSync!(
        tempDir,
        readOnlyAgents(),
        "reviewer",
        readOnlyTask,
        artifactOptions("digest-inline"),
      );

      assert.equal(result.exitCode, 0);
      assert.ok(result.artifactPaths, "expected artifact paths");
      const artifact = fs.readFileSync(result.artifactPaths.outputPath, "utf-8");

      // The prose is preserved verbatim at the head, and the evidence now survives.
      assert.ok(artifact.startsWith("Implementation complete."), "prose must lead the artifact");
      assert.match(artifact, /Validation evidence/);
      assert.match(artifact, MOCK_COMMAND_EVIDENCE);
      // The raw block itself is still stripped; only the compact digest remains.
      assert.doesNotMatch(artifact, /```acceptance-report/);
    });

    it("keeps result.finalOutput free of the digest so the output contract is intact", async () => {
      mockPi.onCall({ jsonl: [events.assistantMessage("Implementation complete.")] });

      const result = await runSync!(
        tempDir,
        readOnlyAgents(),
        "reviewer",
        readOnlyTask,
        artifactOptions("digest-final-output"),
      );

      // finalOutput feeds `output:` files and chain/parallel output references.
      // It must be exactly the stripped assistant text, with nothing appended.
      assert.equal(result.finalOutput, "Implementation complete.");
    });

    it("leaves the artifact byte-exact when the run saved a user-requested output file", async () => {
      // With an `output:` path the artifact is a verbatim archive of the agent's
      // deliverable, so no commentary may be appended to it.
      const outputPath = path.join(tempDir, "report.md");
      mockPi.onCall({ jsonl: [events.assistantMessage("saved deliverable body")] });

      const result = await runSync!(tempDir, readOnlyAgents(), "reviewer", readOnlyTask, {
        ...artifactOptions("digest-output-file"),
        outputPath,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(fs.readFileSync(outputPath, "utf-8"), "saved deliverable body");
      assert.ok(result.artifactPaths, "expected artifact paths");
      assert.equal(
        fs.readFileSync(result.artifactPaths.outputPath, "utf-8"),
        "saved deliverable body",
      );
    });

    it("does not add a digest when the run produced no acceptance report", async () => {
      // Acceptance disabled means no contract in the prompt, so the mock emits no
      // block and there is nothing to digest.
      mockPi.onCall({ jsonl: [events.assistantMessage("findings only")] });
      const agents = makeAgentConfigs(["reviewer"]);

      const result = await runSync!(tempDir, agents, "reviewer", "Summarize findings", {
        ...artifactOptions("digest-absent"),
        acceptance: { level: "none", reason: "exercising the no-report path" },
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.finalOutput, "findings only");
      assert.ok(result.artifactPaths, "expected artifact paths");
      const artifact = fs.readFileSync(result.artifactPaths.outputPath, "utf-8");
      assert.equal(artifact, "findings only");
      assert.doesNotMatch(artifact, /Validation evidence/);
    });

    it("does not inject the digest into the progress step tail", async () => {
      // stripAcceptanceReport is also used for progress/step tails, and it must stay
      // remove-only so tails do not bloat with digest text.
      mockPi.onCall({ jsonl: [events.assistantMessage("Implementation complete.")] });

      const result = (await runSync!(
        tempDir,
        readOnlyAgents(),
        "reviewer",
        readOnlyTask,
        artifactOptions("digest-step-tail"),
      )) as SingleResultLike & { progress?: { recentOutput?: string[] } };

      const recent = (result.progress?.recentOutput ?? []).join("\n");
      assert.doesNotMatch(recent, /Validation evidence/);
    });
  },
);

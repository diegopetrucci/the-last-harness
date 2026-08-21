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
import { scaleTestTimeout } from "../support/scale-timeout.ts";

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

    it("preserves raw output in artifact when acceptance-report block is present but invalid", async () => {
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
      const textWithInvalidReport = `Foreground work done.\n\`\`\`acceptance-report\n${invalidJson}\n\`\`\``;
      mockPi.onCall({ jsonl: [events.assistantMessage(textWithInvalidReport)] });

      const result = await runSync!(
        tempDir,
        readOnlyAgents(),
        "reviewer",
        readOnlyTask,
        artifactOptions("digest-invalid-report"),
      );

      assert.ok(result.artifactPaths, "expected artifact paths");
      const artifact = fs.readFileSync(result.artifactPaths.outputPath, "utf-8");

      // The raw acceptance-report block must survive in the artifact because
      // stripping is gated on parse success (shared-predicate fix).
      assert.ok(artifact.trim().length > 3, "artifact must not be nearly empty");
      assert.match(artifact, /acceptance-report/, "raw block must survive in artifact");
      // No digest — only valid reports get a digest.
      assert.doesNotMatch(artifact, /Validation evidence/);
    });

    it(
      "preserves raw output in artifact via the non-destruction floor when output is nearly-empty after stripping (foreground writer, tlhm-huto)",
      { timeout: scaleTestTimeout(20_000) },
      async () => {
        // DESIGN (see tlhm-huto):
        // To reach the floor at execution.ts, all three conditions must hold:
        //   1. Valid acceptance report — stripping is authorized.
        //   2. Prose is a bare horizontal rule — after strip, output becomes "---" (nearly-empty).
        //   3. Configured outputPath — savedOutputPath is set, suppressing digest
        //      appending so the digest cannot mask the nearly-empty artifact.
        // Without the floor the artifact would be written as "---", silently
        // destroying evidence. The floor writes the raw output instead.
        //
        // REMOVAL PROOF: delete the floor expression in execution.ts:
        //   const safeArtifactOutput = ... ? acceptanceOutput : artifactOutput;
        // This test then fails because the artifact becomes "---" and
        // does not match /```acceptance-report/.
        const outputPath = path.join(tempDir, "floor-foreground-output.md");
        // Mock emits "---". withAcceptanceReport auto-appends the valid fence
        // because the task carries an acceptance contract and the text has no
        // fence yet. Full raw output: "---\n```acceptance-report\n{...}\n```".
        mockPi.onCall({ jsonl: [events.assistantMessage("---")] });

        const result = await runSync!(tempDir, readOnlyAgents(), "reviewer", readOnlyTask, {
          ...artifactOptions("floor-foreground"),
          outputPath,
        });

        assert.equal(result.exitCode, 0);
        assert.ok(result.artifactPaths, "expected artifact paths");
        const artifact = fs.readFileSync(result.artifactPaths.outputPath, "utf-8");

        // The floor preserved the raw output. Without the floor, artifact = "---".
        assert.match(
          artifact,
          /```acceptance-report/,
          "floor must write raw output (fence preserved), not the stripped ---",
        );
        // The user-requested output file receives the stripped content; only the
        // artifact benefits from the raw-output fallback.
        assert.equal(fs.readFileSync(outputPath, "utf-8"), "---");
      },
    );
  },
);

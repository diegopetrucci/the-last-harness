import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { MockPi } from "../support/helpers.ts";
import {
  createMockPi,
  createTempDir,
  removeTempDir,
  makeAgent,
  events,
  tryImport,
} from "../support/helpers.ts";
import { resolveArtifactConfig } from "../../src/shared/artifacts.ts";
import type { ResolvedArtifactConfig, SingleResult } from "../../src/shared/types.ts";

interface ExecutionModule {
  runSync?: (
    cwd: string,
    agents: unknown[],
    agent: string,
    task: string,
    options: {
      runId: string;
      artifactsDir: string;
      artifactConfig: ResolvedArtifactConfig;
      sessionFile: string;
      pauseBlockingSupervisor?: boolean;
      interruptSignal?: AbortSignal;
    },
  ) => Promise<SingleResult>;
}

const execution = await tryImport<ExecutionModule>("./src/runs/foreground/execution.ts");
const runSync = execution?.runSync;
const available = !!runSync;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function productionTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...productionTypeScriptFiles(filePath));
    } else if (entry.isFile() && filePath.endsWith(".ts")) {
      files.push(filePath);
    }
  }
  return files;
}

describe("artifact resolver production wiring", () => {
  it("passes the trusted parent profile through launch and detached boundaries", () => {
    const extensionSource = fs.readFileSync(
      path.join(projectRoot, "src", "extension", "index.ts"),
      "utf8",
    );
    const executorSource = fs.readFileSync(
      path.join(projectRoot, "src", "runs", "foreground", "subagent-executor.ts"),
      "utf8",
    );
    const runnerSource = fs.readFileSync(
      path.join(projectRoot, "src", "runs", "background", "subagent-runner.ts"),
      "utf8",
    );

    assert.match(extensionSource, /resolveArtifactConfig\(config\.artifacts\)/);
    assert.match(extensionSource, /artifactConfig,/);
    assert.match(executorSource, /artifactConfig: input\.artifactConfig/);
    assert.match(
      runnerSource,
      /resolveArtifactConfig\(config\.artifactConfig, \{ legacy: true \}\)/,
    );
    for (const source of [extensionSource, executorSource, runnerSource]) {
      assert.doesNotMatch(source, /DEFAULT_ARTIFACT_CONFIG/);
    }

    const sourceRoot = path.join(projectRoot, "src");
    const centralizedDefaultReferences = new Set([
      path.join(sourceRoot, "shared", "artifacts.ts"),
      path.join(sourceRoot, "shared", "types.ts"),
    ]);
    const productionFiles = productionTypeScriptFiles(sourceRoot);
    assert.ok(productionFiles.length > 0, "expected production TypeScript files");
    for (const filePath of productionFiles) {
      if (centralizedDefaultReferences.has(filePath)) continue;
      const source = fs.readFileSync(filePath, "utf8");
      assert.doesNotMatch(
        source,
        /\bDEFAULT_ARTIFACT_CONFIG\b/,
        `production artifact policy bypass in ${path.relative(projectRoot, filePath)}`,
      );
    }
  });
});

describe(
  "foreground artifact profiles",
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
      tempDir = createTempDir("pi-artifact-mode-");
      mockPi.reset();
    });

    afterEach(() => {
      removeTempDir(tempDir);
    });

    function options(mode: "compact" | "debug", runId: string) {
      return {
        runId,
        artifactsDir: path.join(tempDir, "artifacts"),
        artifactConfig: resolveArtifactConfig({ mode }),
        sessionFile: path.join(tempDir, `${runId}.jsonl`),
      };
    }

    it("keeps compact runs inspectable without input/transcript artifacts", async () => {
      mockPi.onCall({ jsonl: [events.assistantMessage("compact result")] });
      const result = await runSync!(
        tempDir,
        [makeAgent("worker", { tools: ["read"] })],
        "worker",
        "Inspect the workspace.",
        options("compact", "compact-run"),
      );

      assert.equal(result.exitCode, 0);
      assert.ok(result.artifactPaths);
      assert.equal(result.transcriptPath, undefined);
      assert.equal(fs.existsSync(result.artifactPaths.inputPath), false);
      assert.equal(fs.existsSync(result.artifactPaths.transcriptPath), false);
      assert.equal(fs.existsSync(result.artifactPaths.jsonlPath), false);
      assert.equal(fs.existsSync(result.artifactPaths.outputPath), true);
      assert.equal(fs.existsSync(result.artifactPaths.metadataPath), true);
      assert.equal(fs.existsSync(path.join(tempDir, "compact-run.jsonl")), true);
      const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf8")) as {
        transcriptPath?: unknown;
      };
      assert.equal(metadata.transcriptPath, undefined);
    });

    it("restores debug input/transcript artifacts without raw child JSONL", async () => {
      mockPi.onCall({ jsonl: [events.assistantMessage("debug result")] });
      const result = await runSync!(
        tempDir,
        [makeAgent("worker", { tools: ["read"] })],
        "worker",
        "Inspect the workspace.",
        options("debug", "debug-run"),
      );

      assert.equal(result.exitCode, 0);
      assert.ok(result.artifactPaths);
      assert.equal(result.transcriptPath, result.artifactPaths.transcriptPath);
      assert.equal(fs.existsSync(result.artifactPaths.inputPath), true);
      assert.equal(fs.existsSync(result.artifactPaths.transcriptPath), true);
      assert.equal(fs.existsSync(result.artifactPaths.jsonlPath), false);
    });

    it("keeps compact artifacts across a paused session continuation", async () => {
      const sessionFile = path.join(tempDir, "continuation-session.jsonl");
      const controller = new AbortController();
      mockPi.onCall({ delay: 10_000 });
      setTimeout(() => controller.abort(), 200);
      const paused = await runSync!(
        tempDir,
        [makeAgent("worker", { tools: ["read"] })],
        "worker",
        "Pause and continue this task.",
        {
          ...options("compact", "compact-paused"),
          sessionFile,
          pauseBlockingSupervisor: true,
          interruptSignal: controller.signal,
        },
      );

      assert.equal(paused.exitCode, 0);
      assert.equal(paused.interrupted, true);
      assert.equal(paused.transcriptPath, undefined);
      assert.ok(fs.existsSync(sessionFile), "paused run should persist its child session");
      assert.ok(paused.artifactPaths);
      assert.equal(fs.existsSync(paused.artifactPaths.inputPath), false);
      assert.equal(fs.existsSync(paused.artifactPaths.transcriptPath), false);

      mockPi.onCall({ jsonl: [events.assistantMessage("continued result")] });
      const continued = await runSync!(
        tempDir,
        [makeAgent("worker", { tools: ["read"] })],
        "worker",
        "Continue this task.",
        { ...options("compact", "compact-continued"), sessionFile },
      );

      assert.equal(continued.exitCode, 0);
      assert.equal(continued.transcriptPath, undefined);
      assert.equal(
        continued.artifactPaths && fs.existsSync(continued.artifactPaths.inputPath),
        false,
      );
      assert.equal(
        continued.artifactPaths && fs.existsSync(continued.artifactPaths.transcriptPath),
        false,
      );
      assert.equal(fs.existsSync(sessionFile), true);
    });
  },
);

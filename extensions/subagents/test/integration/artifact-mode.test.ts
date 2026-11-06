/**
 * Artifact configuration checks: production wiring plus compact/debug artifact
 * profiles exercised on real background children.
 *
 * Provenance (tlhf-60wy): the former runSync artifact-profile tests were ported
 * to the background path (executeAsyncSingle); the compact-profile persisted
 * runner boundary is also covered in async-execution-runner-launch-config-validation.test.ts.
 */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASYNC_DIR,
  executeAsyncSingle,
  requestAsyncInterrupt,
  waitForAsyncResultFile,
  waitForMockPiCall,
} from "../support/async-execution-helpers.ts";
import {
  createMockPi,
  createTempDir,
  events,
  makeAgent,
  removeTempDir,
} from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";
import { resolveArtifactConfig } from "../../src/shared/artifacts.ts";
import type { AsyncResultArtifact } from "../../src/shared/types.ts";

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

describe("background artifact profiles", () => {
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

  function launch(
    mode: "compact" | "debug",
    runId: string,
    task: string,
    extra: { sessionFile: string },
  ) {
    return executeAsyncSingle(runId, {
      agent: "worker",
      task,
      agentConfig: makeAgent("worker", { tools: ["read"], completionGuard: false }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      artifactsDir: path.join(tempDir, "artifacts"),
      artifactConfig: resolveArtifactConfig({ mode }),
      sessionFile: extra.sessionFile,
      maxSubagentDepth: 2,
    });
  }

  async function readResult(runId: string): Promise<AsyncResultArtifact> {
    const resultPath = await waitForAsyncResultFile(runId, scaleTestTimeout(10_000));
    return JSON.parse(fs.readFileSync(resultPath, "utf8")) as AsyncResultArtifact;
  }

  it("restores debug input/transcript artifacts without raw child JSONL", async () => {
    const runId = `debug-run-${Date.now().toString(36)}`;
    const sessionFile = path.join(tempDir, `${runId}.jsonl`);
    mockPi.onCall({ jsonl: [events.assistantMessage("debug result")] });
    const start = launch("debug", runId, "Inspect the workspace.", { sessionFile });
    assert.equal(start.isError, undefined);

    const result = await readResult(runId);
    const child = result.results[0];
    assert.equal(result.success, true);
    const artifactPaths = child?.artifactPaths;
    assert.ok(artifactPaths, "debug runs should retain artifact paths");
    assert.equal(child?.transcriptPath, artifactPaths.transcriptPath);
    assert.equal(fs.existsSync(artifactPaths.inputPath), true);
    assert.equal(fs.existsSync(artifactPaths.transcriptPath), true);
    assert.equal(fs.existsSync(artifactPaths.jsonlPath), false);
    assert.equal(fs.existsSync(artifactPaths.outputPath), true);
    const metadata = JSON.parse(fs.readFileSync(artifactPaths.metadataPath, "utf8")) as {
      task?: unknown;
    };
    assert.match(String(metadata.task), /^Inspect the workspace\./);
  });

  it("keeps compact artifacts across a paused session continuation", async () => {
    const pausedId = `compact-paused-${Date.now().toString(36)}`;
    const sessionFile = path.join(tempDir, "continuation-session.jsonl");
    mockPi.onCall({ waitForMarker: path.join(tempDir, "never-created.marker") });
    const start = launch("compact", pausedId, "Pause and continue this task.", { sessionFile });
    assert.equal(start.isError, undefined);
    await waitForMockPiCall(mockPi, 0);
    requestAsyncInterrupt(path.join(ASYNC_DIR, pausedId), { source: "artifact-mode-test" });

    const paused = await readResult(pausedId);
    assert.equal(paused.state, "paused");
    const pausedChild = paused.results[0];
    assert.equal(pausedChild?.transcriptPath, undefined);
    assert.equal(pausedChild?.sessionFile, sessionFile);
    const pausedPaths = pausedChild?.artifactPaths;
    assert.ok(pausedPaths, "paused compact run should retain artifact paths");
    assert.equal(fs.existsSync(pausedPaths.inputPath), false);
    assert.equal(fs.existsSync(pausedPaths.transcriptPath), false);
    assert.equal(fs.existsSync(pausedPaths.jsonlPath), false);

    const continuedId = `compact-continued-${Date.now().toString(36)}`;
    mockPi.onCall({ jsonl: [events.assistantMessage("continued result")] });
    const continuedStart = launch("compact", continuedId, "Continue this task.", { sessionFile });
    assert.equal(continuedStart.isError, undefined);
    const continued = await readResult(continuedId);
    const continuedChild = continued.results[0];
    assert.equal(continued.success, true);
    assert.equal(continuedChild?.transcriptPath, undefined);
    assert.equal(continuedChild?.sessionFile, sessionFile);
    const continuedPaths = continuedChild?.artifactPaths;
    assert.ok(continuedPaths, "continued compact run should retain artifact paths");
    assert.equal(fs.existsSync(continuedPaths.inputPath), false);
    assert.equal(fs.existsSync(continuedPaths.transcriptPath), false);
    assert.equal(fs.existsSync(continuedPaths.outputPath), true);
  });
});

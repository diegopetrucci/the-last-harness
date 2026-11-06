/**
 * Async-path integration tests for acceptance and artifact dispatch validation.
 *
 * Provenance (tlhf-60wy): ported from single-execution-acceptance-artifacts.test.ts, which drove both runSync and
 * executor.execute(). Tests here go through the background path; shared
 * invariants that were runSync-driven were ported to background or shared-helper
 * tests (e.g. async-execution-models-output-output-artifacts-streaming, async-digest-surfacing, child-process-hardening). Only assertions on the removed foreground result/callback
 * shapes were dropped.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import {
  createMockPi,
  createTempDir,
  createEventBus,
  removeTempDir,
  makeAgent,
  makeMinimalCtx,
} from "../support/helpers.ts";
import { available, createSubagentExecutor } from "../support/single-execution-fixtures.ts";
import {
  ASYNC_DIR,
  type AsyncStatusPayload,
  executeAsyncSingle,
  readAsyncPayload,
} from "../support/async-execution-helpers.ts";

describe(
  "async single dispatch — acceptance and artifact validation",
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

    function makeExecutor(agents = [makeAgent("echo")]) {
      return createSubagentExecutor!({
        pi: { events: createEventBus(), getSessionName: () => undefined },
        state: {
          baseCwd: tempDir,
          currentSessionId: null,
          asyncJobs: new Map(),
          foregroundRuns: new Map(),
          foregroundControls: new Map(),
          lastForegroundControlId: null,
        },
        config: {},
        tempArtifactsDir: tempDir,
        getSubagentSessionRoot: () => tempDir,
        expandTilde: (value: string) => value,
        discoverAgents: () => ({ agents }),
      });
    }

    it(
      "rejects retired explicit acceptance before foreground launch",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const outputPath = path.join(tempDir, "acceptance-rejected-inline.md");
        const executor = makeExecutor([makeAgent("echo", { completionGuard: false })]);

        const result = await executor.execute(
          "acceptance-rejected-inline",
          {
            agent: "echo",
            task: "Write the report",
            output: outputPath,
            artifacts: true,
            acceptance: { level: "checked", criteria: ["The report is accepted"] },
          },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        const display = result.content.map((item) => item.text ?? "").join("\n");

        assert.equal(result.isError, true);
        assert.match(display, /acceptance is no longer supported/i);
        assert.equal(mockPi.callCount(), 0);
        assert.equal(
          fs.existsSync(outputPath),
          false,
          "rejected call must not create its output file",
        );
      },
    );

    it(
      "rejects retired explicit acceptance before file-only launch",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const outputPath = path.join(tempDir, "acceptance-rejected-file-only.md");
        const executor = makeExecutor([makeAgent("echo", { completionGuard: false })]);

        const result = await executor.execute(
          "acceptance-rejected-file-only",
          {
            agent: "echo",
            task: "Write the report",
            output: outputPath,
            outputMode: "file-only",
            artifacts: true,
            acceptance: { level: "checked", criteria: ["The report is accepted"] },
          },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        const display = result.content.map((item) => item.text ?? "").join("\n");

        assert.equal(result.isError, true);
        assert.match(display, /acceptance is no longer supported/i);
        assert.equal(mockPi.callCount(), 0);
        assert.equal(
          fs.existsSync(outputPath),
          false,
          "rejected call must not create its output file",
        );
      },
    );

    it("preserves process failure while settling a persisted acceptance rejection", async () => {
      mockPi.onCall({ exitCode: 1, stderr: "Something went wrong" });
      const id = `async-process-failure-acceptance-${Date.now().toString(36)}`;

      executeAsyncSingle(id, {
        agent: "fail",
        task: "Task",
        agentConfig: makeAgent("fail"),
        ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
        artifactsDir: path.join(tempDir, "process-failure-acceptance-artifacts"),
        artifactConfig: {
          enabled: true,
          includeInput: false,
          includeOutput: true,
          includeJsonl: false,
          includeMetadata: true,
          cleanupDays: 7,
        },
        maxSubagentDepth: 2,
        acceptance: { level: "checked", criteria: ["The task is complete"] },
      });

      const payload = await readAsyncPayload(id);
      const status = JSON.parse(
        fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
      ) as AsyncStatusPayload;
      const result = payload.results[0]!;

      assert.equal(payload.success, false);
      assert.equal(result.exitCode, 1);
      assert.equal(result.error, "Something went wrong");
      assert.equal(result.acceptance?.explicit, true);
      assert.equal(result.acceptance?.status, "rejected");
      assert.equal(status.steps?.[0]?.status, "failed");
      assert.equal(status.steps?.[0]?.acceptance?.status, "rejected");
      assert.ok(result.artifactPaths, "expected process-failure artifacts");
      assert.equal(fs.readFileSync(result.artifactPaths.outputPath, "utf-8"), result.error);
      const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf-8")) as {
        exitCode?: number;
        error?: string;
      };
      assert.equal(metadata.exitCode, result.exitCode);
      assert.equal(metadata.error, result.error);
    });
  },
);

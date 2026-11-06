/** Native result grouping coverage. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { MockPi } from "../support/helpers.ts";
import {
  createMockPi,
  createTempDir,
  makeAgent,
  makeMinimalCtx,
  removeTempDir,
} from "../support/helpers.ts";
import {
  available,
  expectUnsupportedChainRequest as expectUnsupportedChainRequestFor,
  makeNativeResultLifecycleExecutor,
  type NativeExecutor,
  type NativeExecutorOptions,
} from "../support/native-result-lifecycle-fixtures.ts";
import { readAsyncPayload } from "../support/async-execution-helpers.ts";

const nativeResultGroupingAvailable = available;

describe(
  "native result grouping",
  { skip: !nativeResultGroupingAvailable ? "executor not importable" : undefined },
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
      tempDir = createTempDir("pi-subagent-native-result-");
      mockPi.reset();
    });

    afterEach(() => {
      removeTempDir(tempDir);
    });

    function makeExecutor(options: NativeExecutorOptions = {}) {
      return makeNativeResultLifecycleExecutor(tempDir, options);
    }

    async function expectUnsupportedChainRequest(
      executor: NativeExecutor,
      requestId: string,
      request: Record<string, unknown>,
    ) {
      return expectUnsupportedChainRequestFor(executor, requestId, request, tempDir, mockPi);
    }

    it("single dispatch returns background receipt for one agent", async () => {
      // After async-only: foreground native grouped result card ("subagent results",
      // "Mode: single", "Status: completed", "Children:", inline finalOutput) is gone.
      // Removed foreground-only assertions (no async equivalent):
      //   - /^subagent results/m, /Mode: single/, /Status: completed/, /Children: 1 completed/
      //   - /1\/1\. worker — completed/, /Summary:\n.../
      //   - result.details.results[0].finalOutput
      mockPi.onCall({ output: "Full child output from worker" });
      const { executor } = makeExecutor();

      const result = await executor.execute(
        "single-native",
        { agent: "worker", task: "Summarize feature status" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(result.isError, undefined);
      assert.match(result.content[0]?.text ?? "", /Background run started/);
      assert.equal(result.details?.mode, "single");
      assert.ok(result.details?.asyncId, "expected asyncId from background dispatch");
      const payload = await readAsyncPayload(result.details.asyncId);
      assert.equal(payload.success, true);
      assert.equal(payload.results[0]?.output, "Full child output from worker");
    });

    it("public artifacts:false disables child artifacts but keeps file-only output and sessions", async () => {
      // After async-only: assert on async result payload. Removed foreground-only
      // assertions (no async equivalent):
      //   - child.outputMode (not in AsyncResultArtifactResultItem)
      //   - child.savedOutputPath (not in AsyncResultArtifactResultItem)
      // Surviving assertions:
      //   - result.isError === undefined, artifact paths absent, artifacts dir absent,
      //     output file content, session file path shape, session file exists
      const outputPath = path.join(tempDir, "artifacts-disabled-report.md");
      const parentSessionFile = path.join(tempDir, "parent", "session.jsonl");
      const childArtifactsDir = path.join(path.dirname(parentSessionFile), "subagent-artifacts");
      const ctx = makeMinimalCtx(tempDir);
      ctx.sessionManager.getSessionFile = () => parentSessionFile;
      mockPi.onCall({ output: "saved output with artifacts disabled" });
      const { executor } = makeExecutor();

      const result = await executor.execute(
        "single-artifacts-disabled",
        {
          agent: "worker",
          task: "Write the report",
          artifacts: false,
          output: outputPath,
          outputMode: "file-only",
        },
        new AbortController().signal,
        undefined,
        ctx,
      );

      assert.equal(result.isError, undefined);
      const asyncId = result.details?.asyncId;
      assert.ok(asyncId, "expected asyncId from background dispatch");
      const payload = await readAsyncPayload(asyncId);
      const child = payload.results[0];
      assert.equal(child?.artifactPaths, undefined, "artifacts disabled: no artifactPaths");
      assert.equal(fs.existsSync(childArtifactsDir), false, "artifacts dir absent when disabled");
      assert.equal(
        fs.readFileSync(outputPath, "utf8"),
        "saved output with artifacts disabled",
        "file-only output was written",
      );
      assert.ok(child?.sessionFile, "expected canonical child session path");
      assert.equal(path.basename(child.sessionFile), "session.jsonl");
      assert.equal(path.basename(path.dirname(child.sessionFile)), "run-0");
      assert.ok(
        fs.existsSync(child.sessionFile),
        "expected persisted canonical child session file",
      );
    });

    it("failed single dispatch returns background receipt; async result shows failure", async () => {
      // After async-only: foreground failure card (/Mode: single/, /Status: failed/,
      // /Children: 1 failed/, /worker — failed/, truncation) is foreground-specific.
      // Removed foreground-only assertions (no async equivalent):
      //   - /Mode: single/, /Status: failed/, /Children: 1 failed/, /1\/1\. worker/
      //   - truncation context, result.details.results[0].outputMode/savedOutputPath/finalOutput
      // Failure is visible in async result file (payload.success === false).
      mockPi.onCall({
        output: "single visible partial\nsingle hidden partial\nsingle final hidden",
        stderr: "single terminal failure",
        exitCode: 1,
      });
      const { executor } = makeExecutor();

      const result = await executor.execute(
        "single-failed",
        {
          agent: "worker",
          task: "Summarize failure",
          output: path.join(tempDir, "failed-file-only.md"),
          outputMode: "file-only",
        },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      // Receipt is always returned; failure arrives asynchronously.
      assert.equal(result.isError, undefined);
      assert.match(result.content[0]?.text ?? "", /Background run started/);
      const asyncId = result.details?.asyncId;
      assert.ok(asyncId);
      const payload = await readAsyncPayload(asyncId);
      assert.equal(payload.success, false);
      assert.equal(payload.results[0]?.exitCode, 1);
    });

    it("file-only output-save dispatch returns background receipt", async () => {
      // After async-only: foreground output-save-failure format (/Status: completed/,
      // truncation, /Output file error:/, outputSaveError, savedOutputPath, finalOutput)
      // is foreground-specific. Removed foreground-only assertions (no async equivalent):
      //   - /Status: completed/, /\[TRUNCATED:/, /save visible line/
      //   - /Output file error:/, outputSaveError, savedOutputPath, finalOutput
      const blockedParent = path.join(tempDir, "not-a-directory");
      fs.writeFileSync(blockedParent, "blocking file", "utf-8");
      const requestedOutput = path.join(blockedParent, "report.md");
      mockPi.onCall({ output: "save visible line\nsave hidden line\nsave final hidden" });
      const { executor } = makeExecutor();

      const result = await executor.execute(
        "single-file-save-failed",
        {
          agent: "worker",
          task: "Write report",
          output: requestedOutput,
          outputMode: "file-only",
        },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      // The executor returns a receipt; the save failure surfaces in the async result.
      assert.equal(result.isError, undefined);
      assert.match(result.content[0]?.text ?? "", /Background run started/);
      // Item 5 (tlhf-5veu review): file-only output-save failure diagnostics must reach the
      // eventual background result, not just the receipt.  The async runner appends
      // "Output file error:" to the result output when the save fails.
      const singleAsyncId = result.details?.asyncId;
      assert.ok(singleAsyncId, "expected asyncId in receipt");
      const singlePayload = await readAsyncPayload(singleAsyncId);
      assert.match(
        singlePayload.results[0]?.output ?? "",
        /Output file error:/,
        "file-only save failure must surface as 'Output file error:' in the async result output",
      );
    });

    it("parallel file-only dispatch returns background receipt", async () => {
      // After async-only: foreground parallel-save-error format (/Status: completed/,
      // truncation, /Output file error:/, saveError, maxOutput bounds) is foreground-specific.
      // Removed foreground-only assertions (no async equivalent):
      //   - /Status: completed/, /\[TRUNCATED:/, /parallel visible line/
      //   - /Output file error:/, saveError field, finalOutput, text.length <= 8_000
      // Save-error diagnostics now verified in the async result.
      const blockedParent = path.join(tempDir, "parallel-not-a-directory");
      fs.writeFileSync(blockedParent, "blocking file", "utf-8");
      const requestedOutput = path.join(blockedParent, "report.md");
      mockPi.onCall({
        output: "parallel visible line\nparallel hidden line\nparallel final hidden",
      });
      const { executor } = makeExecutor();

      const result = await executor.execute(
        "parallel-file-save-failed",
        {
          tasks: [
            {
              agent: "worker",
              task: "Write parallel report",
              output: requestedOutput,
              outputMode: "file-only",
            },
          ],
        },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(result.isError, undefined);
      assert.match(result.content[0]?.text ?? "", /Background run started/);
      // Parallel save-failure diagnostics must also reach the async result.
      const parallelAsyncId = result.details?.asyncId;
      assert.ok(parallelAsyncId, "expected asyncId in parallel receipt");
      const parallelPayload = await readAsyncPayload(parallelAsyncId);
      assert.match(
        parallelPayload.results[0]?.output ?? "",
        /Output file error:/,
        "parallel file-only save failure must surface as 'Output file error:' in the async result output",
      );
    });

    it("chain native requests fail closed before file-save work starts", async () => {
      const blockedParent = path.join(tempDir, "chain-not-a-directory");
      fs.writeFileSync(blockedParent, "blocking file", "utf-8");
      const requestedOutput = path.join(blockedParent, "report.md");
      const { executor } = makeExecutor();

      await expectUnsupportedChainRequest(executor, "chain-file-save-failed", {
        chain: [
          {
            agent: "worker",
            task: "Write chain report",
            output: requestedOutput,
            outputMode: "file-only",
          },
        ],
      });
      assert.equal(fs.existsSync(requestedOutput), false);
    });

    it("chain multi-step requests fail closed before save diagnostics or child launches", async () => {
      const blockedParent = path.join(tempDir, "oversized-diagnostic-blocker");
      fs.writeFileSync(blockedParent, "blocking file", "utf-8");
      const requestedOutput = path.join(
        blockedParent,
        ...Array.from({ length: 70 }, (_, index) => `segment-${index.toString().padStart(2, "0")}`),
        "report.md",
      );
      const { executor } = makeExecutor();

      await expectUnsupportedChainRequest(executor, "chain-earlier-save-error", {
        chain: [
          {
            agent: "worker",
            task: "first report",
            output: requestedOutput,
            outputMode: "file-only",
          },
          { agent: "worker", task: "finish chain" },
        ],
      });
      assert.equal(fs.existsSync(requestedOutput), false);
    });

    it("parallel dispatch returns background receipt for multiple agents", async () => {
      // After async-only: foreground parallel result card (/Mode: parallel/,
      // /Children: 2 completed/, /1\/2\. a — completed/, inline /Summary:/, details.results[])
      // is foreground-specific. Removed foreground-only assertions (no async equivalent):
      //   - /Mode: parallel/, /Children: 2 completed/, /1\/2\. a — completed/
      //   - /Summary:\nParallel child output/, result.details.results[].finalOutput
      //   - text.length <= 8_000 (foreground card-size bound)
      const fullOutput = `Parallel child output ${"P".repeat(12_000)}`;
      mockPi.onCall({ output: fullOutput });
      mockPi.onCall({ output: fullOutput });
      const { executor } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b")] });

      const result = await executor.execute(
        "parallel-native",
        {
          tasks: [
            { agent: "a", task: "task-a" },
            { agent: "b", task: "task-b" },
          ],
        },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(result.isError, undefined);
      assert.match(result.content[0]?.text ?? "", /Background run started/);
      assert.equal(result.details?.mode, "parallel");
      const asyncId = result.details?.asyncId;
      assert.ok(asyncId);
      const payload = await readAsyncPayload(asyncId);
      assert.equal(payload.results.length, 2);
      assert.equal(payload.success, true);
    });

    it("chain grouping requests fail closed before native summaries are built", async () => {
      const { executor } = makeExecutor({
        agents: [makeAgent("a"), makeAgent("b"), makeAgent("c")],
      });

      await expectUnsupportedChainRequest(executor, "chain-native", {
        chain: [
          { agent: "a", task: "step-a" },
          {
            parallel: [
              { agent: "b", task: "step-b" },
              { agent: "c", task: "step-c" },
            ],
          },
        ],
      });
    });

    it("chain fallback requests fail closed before retries or notices are produced", async () => {
      const { executor } = makeExecutor({
        agents: [makeAgent("a", { model: "openai/gpt-5-mini" })],
      });

      await expectUnsupportedChainRequest(executor, "chain-fallback-notice", {
        chain: [
          {
            agent: "a",
            task: "step-a",
            fallbackModels: ["anthropic/claude-sonnet-4"],
            modelFallbackNotice: "Quota fallback engaged",
          },
        ],
      });
    });

    it("failed chain foreground requests fail closed before any child can fail", async () => {
      const { executor } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b")] });

      await expectUnsupportedChainRequest(executor, "chain-failed", {
        chain: [
          { agent: "a", task: "first failing step" },
          { agent: "b", task: "must not run" },
        ],
      });
    });

    it("paused chain flows fail closed before grouped receipts are possible", async () => {
      const { executor } = makeExecutor({
        agents: [makeAgent("a"), makeAgent("b")],
      });

      await expectUnsupportedChainRequest(executor, "chain-native-unsupported", {
        chain: [
          { agent: "a", task: "ask supervisor" },
          { agent: "b", task: "must not run" },
        ],
      });
    });

    it("mixed parallel dispatch returns background receipt; async result shows failure", async () => {
      // After async-only: foreground mixed-outcome card (/Status: failed/,
      // /Children: 1 completed, 1 failed/, /1\/2\. a — completed/, /2\/2\. b — failed/)
      // is foreground-specific. Removed foreground-only assertions (no async equivalent):
      //   - /Status: failed/, /Children: 1 completed, 1 failed/
      //   - /1\/2\. a — completed/, /2\/2\. b — failed/, inline error content
      // Mixed outcome is visible in async result (payload.success === false,
      // one result success, one failure).
      mockPi.onCall({ matchArgIncludes: "task-a", output: "Parallel child success", exitCode: 0 });
      mockPi.onCall({
        matchArgIncludes: "task-b",
        output: "Parallel child failure",
        stderr: "Parallel child failure",
        exitCode: 1,
      });
      const { executor } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b")] });

      const result = await executor.execute(
        "parallel-mixed-native",
        {
          tasks: [
            { agent: "a", task: "task-a" },
            { agent: "b", task: "task-b" },
          ],
        },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );

      assert.equal(result.isError, undefined);
      assert.match(result.content[0]?.text ?? "", /Background run started/);
      const asyncId = result.details?.asyncId;
      assert.ok(asyncId);
      const payload = await readAsyncPayload(asyncId);
      assert.equal(payload.success, false, "parallel run fails when any child fails");
      const successes = payload.results.filter((r) => r.success).length;
      const failures = payload.results.filter((r) => !r.success).length;
      assert.equal(successes, 1);
      assert.equal(failures, 1);
    });
  },
);

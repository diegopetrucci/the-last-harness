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

    it("single foreground runs return one native grouped result", async () => {
      mockPi.onCall({ output: "Full child output from worker" });
      const { executor } = makeExecutor();

      const result = await executor.execute(
        "single-native",
        { agent: "worker", task: "Summarize feature status" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.match(result.content[0]?.text ?? "", /^subagent results/m);
      assert.match(result.content[0]?.text ?? "", /Mode: single/);
      assert.match(result.content[0]?.text ?? "", /Status: completed/);
      assert.match(result.content[0]?.text ?? "", /Children: 1 completed/);
      assert.match(result.content[0]?.text ?? "", /1\/1\. worker — completed/);
      assert.match(result.content[0]?.text ?? "", /Summary:\nFull child output from worker/);
      assert.equal(
        (result.content[0]?.text ?? "").match(/Full child output from worker/g)?.length ?? 0,
        1,
      );
      assert.equal(result.details?.results?.[0]?.finalOutput, "Full child output from worker");
    });

    it("public artifacts:false disables child artifacts but keeps file-only output and sessions", async () => {
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

      const child = result.details?.results?.[0];
      assert.equal(result.isError, undefined);
      assert.equal(child?.artifactPaths, undefined);
      assert.equal(fs.existsSync(childArtifactsDir), false);
      assert.equal(child?.outputMode, "file-only");
      assert.equal(child?.savedOutputPath, outputPath);
      assert.equal(fs.readFileSync(outputPath, "utf8"), "saved output with artifacts disabled");
      assert.ok(child?.sessionFile, "expected canonical child session path");
      assert.equal(path.basename(child.sessionFile), "session.jsonl");
      assert.equal(path.basename(path.dirname(child.sessionFile)), "run-0");
      assert.ok(
        fs.existsSync(child.sessionFile),
        "expected persisted canonical child session file",
      );
    });

    it("native single runs always use the grouped result", async () => {
      mockPi.onCall({ output: "Legacy foreground output" });
      const { executor } = makeExecutor();

      const result = await executor.execute(
        "single-native-default",
        { agent: "worker", task: "Summarize feature" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.match(result.content[0]?.text ?? "", /Mode: single/);
      assert.match(result.content[0]?.text ?? "", /Summary:\nLegacy foreground output/);
    });

    it("native foreground results return without external delivery", async () => {
      mockPi.onCall({ output: "Unacknowledged foreground output" });
      const { executor } = makeExecutor();

      const result = await executor.execute(
        "single-no-ack",
        { agent: "worker", task: "Summarize feature" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.match(result.content[0]?.text ?? "", /Summary:\nUnacknowledged foreground output/);
    });

    it("native foreground results are independent of external extension files", async () => {
      mockPi.onCall({ output: "No external extension foreground output" });
      const { executor } = makeExecutor();

      const result = await executor.execute(
        "single-no-package",
        { agent: "worker", task: "Summarize feature" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.match(
        result.content[0]?.text ?? "",
        /Summary:\nNo external extension foreground output/,
      );
    });

    it("native foreground summaries honor maxOutput truncation without discarding full structured output", async () => {
      const fullOutput = `first visible line\n${"second hidden line".repeat(700)}\nthird hidden line`;
      mockPi.onCall({ output: fullOutput });
      const { executor } = makeExecutor();

      const result = await executor.execute(
        "single-truncated",
        { agent: "worker", task: "Summarize lines", maxOutput: { lines: 1, bytes: 100 } },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );

      const text = result.content[0]?.text ?? "";
      assert.match(text, /\[TRUNCATED: showing first 1 of 3 lines/);
      assert.match(text, /first visible line/);
      assert.doesNotMatch(text, /second hidden line/);
      assert.equal(result.details?.results?.[0]?.finalOutput, fullOutput);
      assert.equal(result.details?.results?.[0]?.truncation?.truncated, true);
      assert.ok(text.length <= 8_000);
    });

    it("native foreground summaries preserve file-only references even when maxOutput is smaller", async () => {
      mockPi.onCall({ output: "full saved native output\nwith hidden details" });
      const { executor } = makeExecutor();

      const result = await executor.execute(
        "single-file-only",
        {
          agent: "worker",
          task: "Write report",
          output: "native-file-only.md",
          outputMode: "file-only",
          maxOutput: { lines: 1, bytes: 10 },
        },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );

      const text = result.content[0]?.text ?? "";
      assert.match(text, /Summary:\nOutput saved to:/);
      assert.match(text, /native-file-only\.md/);
      assert.doesNotMatch(text, /full saved native output/);
      assert.doesNotMatch(text, /\[TRUNCATED:/);
      assert.match(result.details?.results?.[0]?.finalOutput ?? "", /^Output saved to:/);
      assert.equal(result.details?.results?.[0]?.outputMode, "file-only");
    });

    it("failed file-only foreground runs return truncated native error context without leaking full output", async () => {
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
          output: "failed-file-only.md",
          outputMode: "file-only",
          maxOutput: { lines: 1, bytes: 100 },
        },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );

      const text = result.content[0]?.text ?? "";
      assert.equal(result.isError, true);
      assert.match(text, /Mode: single/);
      assert.match(text, /Status: failed/);
      assert.match(text, /Children: 1 failed/);
      assert.match(text, /1\/1\. worker — failed/);
      assert.match(text, /single terminal failure/);
      assert.match(text, /Output:\n\[TRUNCATED: showing first 1 of 3 lines/);
      assert.match(text, /single visible partial/);
      assert.doesNotMatch(text, /single hidden partial/);
      assert.equal(result.details?.results?.[0]?.outputMode, "file-only");
      assert.equal(result.details?.results?.[0]?.savedOutputPath, undefined);
      assert.equal(
        result.details?.results?.[0]?.finalOutput,
        "single visible partial\nsingle hidden partial\nsingle final hidden",
      );
    });

    it("file-only output-save failures return truncated output plus an actionable save error", async () => {
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
          maxOutput: { lines: 1, bytes: 100 },
        },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );

      const text = result.content[0]?.text ?? "";
      assert.equal(result.isError, undefined);
      assert.match(text, /Status: completed/);
      assert.match(text, /\[TRUNCATED: showing first 1 of 3 lines/);
      assert.match(text, /save visible line/);
      assert.doesNotMatch(text, /save hidden line/);
      assert.match(text, /Output file error:/);
      assert.equal(text.match(/Output file error:/g)?.length ?? 0, 1);
      assert.match(text, new RegExp(requestedOutput.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.ok(text.indexOf("Output file error:") < text.indexOf("[TRUNCATED:"));
      assert.ok(text.length <= 8_000);
      assert.match(text, /(?:EEXIST|ENOTDIR|not a directory|file already exists)/i);
      assert.equal(result.details?.results?.[0]?.savedOutputPath, undefined);
      assert.ok(result.details?.results?.[0]?.outputSaveError);
      assert.equal(
        result.details?.results?.[0]?.finalOutput,
        "save visible line\nsave hidden line\nsave final hidden",
      );
    });

    it("parallel native summaries retain save errors without leaking output beyond maxOutput", async () => {
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
          maxOutput: { lines: 1, bytes: 100 },
        },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );

      const text = result.content[0]?.text ?? "";
      assert.equal(result.isError, undefined);
      assert.match(text, /Status: completed/);
      assert.match(text, /\[TRUNCATED: showing first 1 of 3 lines/);
      assert.match(text, /parallel visible line/);
      assert.doesNotMatch(text, /parallel hidden line/);
      assert.match(text, /Output file error:/);
      const saveError = result.details?.results?.[0]?.outputSaveError;
      assert.ok(saveError);
      assert.match(saveError, new RegExp(blockedParent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(text, new RegExp(saveError.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.ok(text.indexOf("Output file error:") < text.indexOf("[TRUNCATED:"));
      assert.equal(
        result.details?.results?.[0]?.finalOutput,
        "parallel visible line\nparallel hidden line\nparallel final hidden",
      );
      assert.ok(text.length <= 8_000);
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
        maxOutput: { lines: 1, bytes: 100 },
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
        maxOutput: { lines: 1, bytes: 100 },
      });
      assert.equal(fs.existsSync(requestedOutput), false);
    });

    it("paused foreground runs stay actionable", async () => {
      mockPi.onCall({ delay: 10_000 });
      const { executor, state } = makeExecutor({ agents: [makeAgent("slow")] });

      const runPromise = executor.execute(
        "single-pause",
        { agent: "slow", task: "Wait for interrupt" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );

      const readyDeadline = Date.now() + 5_000;
      while (Date.now() < readyDeadline) {
        if (
          mockPi.callCount() === 1 &&
          typeof ([...state.foregroundControls.values()][0] as { interrupt?: unknown } | undefined)
            ?.interrupt === "function"
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(mockPi.callCount(), 1);

      const interruptResult = await executor.execute(
        "single-pause-interrupt",
        { action: "interrupt" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.match(
        interruptResult.content[0]?.text ?? "",
        /Interrupt requested for foreground run/,
      );

      const result = await runPromise;
      assert.match(
        result.content[0]?.text ?? "",
        /^Foreground run [a-z0-9-]+ paused after interrupt \(slow\)\./,
      );
      assert.match(
        result.content[0]?.text ?? "",
        /Pause succeeded; this foreground run is paused and waiting for your explicit next action/,
      );
      assert.match(
        result.content[0]?.text ?? "",
        /Resume: subagent\(\{ action: "resume", id: "[a-z0-9-]+", message: "\.\.\." \}\)/,
      );
    });

    it("top-level parallel runs bound oversized grouped native output while retaining full details", async () => {
      const fullOutput = `Parallel child output ${"P".repeat(12_000)}`;
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
      assert.match(result.content[0]?.text ?? "", /Mode: parallel/);
      assert.match(result.content[0]?.text ?? "", /Children: 2 completed/);
      assert.match(result.content[0]?.text ?? "", /1\/2\. a — completed/);
      assert.match(result.content[0]?.text ?? "", /2\/2\. b — completed/);
      assert.match(result.content[0]?.text ?? "", /Summary:\nParallel child output/);
      assert.equal(
        result.details?.results?.every((entry) => entry.finalOutput === fullOutput),
        true,
      );
      assert.ok((result.content[0]?.text ?? "").length <= 8_000);
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

    it("mixed foreground outcomes produce failed native grouped status and counts", async () => {
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
      assert.match(result.content[0]?.text ?? "", /Status: failed/);
      assert.match(result.content[0]?.text ?? "", /Children: 1 completed, 1 failed/);
      assert.match(result.content[0]?.text ?? "", /1\/2\. a — completed/);
      assert.match(result.content[0]?.text ?? "", /2\/2\. b — failed/);
      assert.match(result.content[0]?.text ?? "", /Parallel child failure/);
    });
  },
);

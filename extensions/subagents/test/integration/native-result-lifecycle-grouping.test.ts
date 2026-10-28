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
import { readAsyncPayload } from "../support/async-execution-helpers.ts";
import {
  expectUnsupportedChainRequest as expectUnsupportedChainRequestFor,
  makeNativeResultLifecycleExecutor,
  type NativeExecutor,
  type NativeExecutorOptions,
} from "../support/native-result-lifecycle-fixtures.ts";

/** Launches are detached: wait for the run's terminal result artifact. */
async function settled(result: { details?: { asyncId?: string } }) {
  const asyncId = result.details?.asyncId;
  assert.ok(asyncId, "expected a detached run id");
  return readAsyncPayload(asyncId);
}

/** Distinct per-task workspace: same-workspace writers are rejected by the reservation policy. */
function taskDir(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("detached result artifacts", () => {
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

  it("single detached runs persist one terminal artifact and expose output through the result action", async () => {
    mockPi.onCall({ output: "Full child output from worker" });
    const { executor } = makeExecutor();

    const launched = await executor.execute(
      "single-native",
      { agent: "worker", task: "Summarize feature status" },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );
    assert.equal(launched.isError, undefined);
    assert.doesNotMatch(launched.content[0]?.text ?? "", /Full child output from worker/);
    const runId = launched.details?.asyncId;
    assert.ok(runId, "expected a detached run id");
    const payload = await readAsyncPayload(runId);
    assert.equal(payload.mode, "single");
    assert.equal(payload.success, true);
    assert.equal(payload.results[0]?.finalOutput, "Full child output from worker");

    const fetched = await executor.execute(
      "single-native-result",
      { action: "result", id: runId },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );
    assert.equal(fetched.isError, undefined);
    assert.equal(
      (fetched.content[0]?.text ?? "").match(/Full child output from worker/g)?.length ?? 0,
      1,
    );
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

    assert.equal(result.isError, undefined);
    const child = (await settled(result)).results[0];
    assert.equal(child?.artifactPaths, undefined);
    assert.equal(fs.existsSync(childArtifactsDir), false);
    assert.equal(child?.outputMode, "file-only");
    assert.equal(child?.savedOutputPath, outputPath);
    assert.equal(fs.readFileSync(outputPath, "utf8"), "saved output with artifacts disabled");
    assert.ok(child?.sessionFile, "expected canonical child session path");
    assert.equal(path.basename(child.sessionFile), "session.jsonl");
    assert.equal(path.basename(path.dirname(child.sessionFile)), "run-0");
    assert.ok(fs.existsSync(child.sessionFile), "expected persisted canonical child session file");
  });

  it("detached runs keep the full structured output regardless of maxOutput", async () => {
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

    assert.equal((await settled(result)).results[0]?.finalOutput, fullOutput);
  });

  it("detached file-only runs keep a saved-output reference even when maxOutput is smaller", async () => {
    mockPi.onCall({ output: "full saved native output\nwith hidden details" });
    const { executor } = makeExecutor();

    const result = await executor.execute(
      "single-file-only",
      {
        agent: "worker",
        task: "Write report",
        output: path.join(tempDir, "native-file-only.md"),
        outputMode: "file-only",
        maxOutput: { lines: 1, bytes: 10 },
      },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );

    const child = (await settled(result)).results[0];
    assert.match(child?.output ?? "", /^Output saved to:/);
    assert.match(child?.output ?? "", /native-file-only\.md/);
    assert.doesNotMatch(child?.output ?? "", /full saved native output/);
    assert.equal(child?.outputMode, "file-only");
    assert.equal(
      fs.readFileSync(path.join(tempDir, "native-file-only.md"), "utf8"),
      "full saved native output\nwith hidden details",
    );
  });

  it("failed detached file-only runs keep error context and the full output", async () => {
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
        maxOutput: { lines: 1, bytes: 100 },
      },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );

    const payload = await settled(result);
    assert.equal(payload.success, false);
    const child = payload.results[0];
    assert.equal(child?.success, false);
    assert.match(`${child?.error ?? ""}${child?.stderr ?? ""}`, /single terminal failure/);
    assert.equal(child?.outputMode, "file-only");
    assert.equal(child?.savedOutputPath, undefined);
    assert.equal(
      child?.finalOutput,
      "single visible partial\nsingle hidden partial\nsingle final hidden",
    );
  });

  it("detached file-only output-save failures surface an actionable save error", async () => {
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

    assert.equal(result.isError, undefined);
    const child = (await settled(result)).results[0];
    assert.equal(child?.success, true);
    assert.match(child?.outputSaveError ?? "", /not-a-directory/);
    assert.match(
      child?.outputSaveError ?? "",
      /(?:EEXIST|ENOTDIR|not a directory|file already exists)/i,
    );
    assert.equal(child?.savedOutputPath, undefined);
    assert.equal(child?.finalOutput, "save visible line\nsave hidden line\nsave final hidden");
  });

  it("detached parallel runs retain per-child save errors", async () => {
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

    assert.equal(result.isError, undefined);
    const child = (await settled(result)).results[0];
    assert.ok(child?.outputSaveError);
    assert.match(
      child.outputSaveError,
      new RegExp(blockedParent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.equal(
      child.finalOutput,
      "parallel visible line\nparallel hidden line\nparallel final hidden",
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

  it("top-level parallel launches stay bounded while retaining full child output", async () => {
    const fullOutput = `Parallel child output ${"P".repeat(12_000)}`;
    mockPi.onCall({ output: fullOutput });
    const { executor } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b")] });

    const result = await executor.execute(
      "parallel-native",
      {
        tasks: [
          { agent: "a", task: "task-a", cwd: taskDir(tempDir, "a") },
          { agent: "b", task: "task-b", cwd: taskDir(tempDir, "b") },
        ],
      },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );
    const payload = await settled(result);
    assert.equal(payload.mode, "parallel");
    assert.equal(payload.results.length, 2);
    assert.deepEqual(
      payload.results.map((entry) => entry.agent),
      ["a", "b"],
    );
    assert.equal(
      payload.results.every((entry) => entry.finalOutput === fullOutput),
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

  it("failed chain requests fail closed before any child can fail", async () => {
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

  it("mixed detached outcomes produce a failed run with per-child results", async () => {
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
          { agent: "a", task: "task-a", cwd: taskDir(tempDir, "a") },
          { agent: "b", task: "task-b", cwd: taskDir(tempDir, "b") },
        ],
      },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );

    assert.equal(result.isError, undefined);
    const payload = await settled(result);
    assert.equal(payload.success, false);
    assert.equal(payload.results[0]?.success, true);
    assert.equal(payload.results[1]?.success, false);
    assert.match(
      `${payload.results[1]?.error ?? ""}${payload.results[1]?.stderr ?? ""}${payload.results[1]?.output ?? ""}`,
      /Parallel child failure/,
    );
  });
});

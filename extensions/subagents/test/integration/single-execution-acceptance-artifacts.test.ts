/** Acceptance, artifact, output-file, skill, and tool-policy coverage. */

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
  makeAgentConfigs,
  makeAgent,
  makeMinimalCtx,
  events,
} from "../support/helpers.ts";
import {
  available,
  runSync,
  getFinalOutput,
  createSubagentExecutor,
  type MockPiCallRecord,
  type ExecutionModule,
  type ExecuteAsyncSingleOverride,
} from "../support/single-execution-fixtures.ts";
import { INVALID_LAZY_SKILL_TOOL_POLICY_ERROR } from "../../src/runs/shared/pi-args.ts";
import {
  escapeRegExp,
  explicitAcceptanceRejectionOutput,
  inferredAcceptanceRejectionOutput,
  writePackageSkill,
  type ProgressSummary,
  type ArtifactPaths,
} from "../support/single-execution-fixtures.ts";

describe(
  "single sync execution",
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

    function readCall(): {
      args: string[];
      systemPrompts: NonNullable<MockPiCallRecord["systemPrompts"]>;
    } {
      const callFile = fs
        .readdirSync(mockPi.dir)
        .filter((name) => name.startsWith("call-") && name.endsWith(".json"))
        .sort()
        .at(-1);
      assert.ok(callFile, "expected a recorded mock pi call");
      const payload = JSON.parse(
        fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8"),
      ) as MockPiCallRecord;
      assert.ok(Array.isArray(payload.args), "expected recorded args");
      return { args: payload.args, systemPrompts: payload.systemPrompts ?? [] };
    }

    function readCallArgs(): string[] {
      return readCall().args;
    }

    function makeExecutor(
      agents = [makeAgent("echo")],
      config: Record<string, unknown> = {},
      state = {
        baseCwd: tempDir,
        currentSessionId: null,
        asyncJobs: new Map(),
        foregroundRuns: new Map(),
        foregroundControls: new Map(),
        lastForegroundControlId: null,
      },
      runSyncOverride: ExecutionModule["runSync"] | undefined = runSync,
      executeAsyncSingleOverride: ExecuteAsyncSingleOverride | undefined = undefined,
    ) {
      return createSubagentExecutor!({
        pi: { events: createEventBus(), getSessionName: () => undefined },
        state,
        config,
        tempArtifactsDir: tempDir,
        getSubagentSessionRoot: () => tempDir,
        expandTilde: (value: string) => value,
        discoverAgents: () => ({ agents }),
        runSync: runSyncOverride,
        executeAsyncSingle: executeAsyncSingleOverride,
      });
    }
    it("tracks progress during execution", async () => {
      mockPi.onCall({ output: "Done" });
      const agents = makeAgentConfigs(["echo"]);

      const result = await runSync(tempDir, agents, "echo", "Task", { index: 3 });

      assert.ok(result.progress, "should have progress");
      assert.equal(result.progress.agent, "echo");
      assert.equal(result.progress.index, 3);
      assert.equal(result.progress.status, "completed");
      assert.ok(result.progress.durationMs > 0, "should track duration");
    });

    it("tracks live activity updates and exposes artifact paths while running", async () => {
      const updates: Array<{
        details?: {
          results?: Array<{ artifactPaths?: ArtifactPaths }>;
          progress?: ProgressSummary[];
        };
      }> = [];
      mockPi.onCall({
        steps: [
          { jsonl: [events.toolStart("read", { path: "package.json" })], delay: 20 },
          {
            jsonl: [events.toolEnd("read"), events.toolResult("read", '{"name":"pkg"}')],
            delay: 20,
          },
          { jsonl: [events.assistantMessage("Done")] },
        ],
      });
      const agents = makeAgentConfigs(["echo"]);
      const artifactsDir = path.join(tempDir, "artifacts");

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "live-progress",
        artifactsDir,
        artifactConfig: {
          enabled: true,
          includeInput: true,
          includeOutput: true,
          includeMetadata: true,
        },
        onUpdate: (update: {
          details?: {
            results?: Array<{ artifactPaths?: ArtifactPaths }>;
            progress?: ProgressSummary[];
          };
        }) => {
          updates.push(update);
        },
      });

      assert.ok(updates.length > 0, "expected at least one live progress update");
      assert.equal(
        updates.some(
          (update) =>
            update.details?.results?.[0]?.artifactPaths?.outputPath.endsWith("_output.md") === true,
        ),
        true,
      );
      const runningToolUpdate = updates.find(
        (update) => update.details?.progress?.[0]?.currentTool === "read",
      );
      assert.ok(runningToolUpdate, "expected a live progress update for the running tool");
      assert.equal(runningToolUpdate?.details?.progress?.[0]?.currentTool, "read");
      assert.equal(
        typeof runningToolUpdate?.details?.progress?.[0]?.currentToolStartedAt,
        "number",
      );
      assert.equal(typeof result.progress.lastActivityAt, "number");
      assert.equal(result.progress.currentToolStartedAt, undefined);
    });

    it("sets progress.status to failed on non-zero exit", async () => {
      mockPi.onCall({ exitCode: 1 });
      const agents = makeAgentConfigs(["fail"]);

      const result = await runSync(tempDir, agents, "fail", "Task", {});

      assert.equal(result.progress.status, "failed");
    });

    it("preserves process failure while settling explicit acceptance rejection", async () => {
      mockPi.onCall({ exitCode: 1, stderr: "Something went wrong" });
      const artifactsDir = path.join(tempDir, "process-failure-acceptance-artifacts");

      const result = await runSync(tempDir, makeAgentConfigs(["fail"]), "fail", "Task", {
        runId: "process-failure-acceptance",
        artifactsDir,
        artifactConfig: { enabled: true, includeOutput: true, includeMetadata: true },
        acceptance: { level: "checked", criteria: ["The task is complete"] },
      });

      assert.equal(result.exitCode, 1);
      assert.equal(result.error, "Something went wrong");
      assert.equal(result.acceptance?.explicit, true);
      assert.equal(result.acceptance?.status, "rejected");
      assert.equal(result.progress.status, "failed");
      assert.ok(result.artifactPaths, "expected process-failure artifacts");
      assert.equal(fs.readFileSync(result.artifactPaths.outputPath, "utf-8"), result.error);
      const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf-8")) as {
        exitCode?: number;
        error?: string;
      };
      assert.equal(metadata.exitCode, result.exitCode);
      assert.equal(metadata.error, result.error);
    });

    it("handles multi-turn conversation from JSONL", async () => {
      mockPi.onCall({
        jsonl: [
          events.toolStart("bash", { command: "ls" }),
          events.toolEnd("bash"),
          events.toolResult("bash", "file1.txt\nfile2.txt"),
          events.assistantMessage("Found 2 files: file1.txt and file2.txt"),
        ],
      });
      const agents = makeAgentConfigs(["scout"]);

      const result = await runSync(tempDir, agents, "scout", "List files", {});

      assert.equal(result.exitCode, 0);
      const output = getFinalOutput(result.messages);
      assert.ok(output.includes("file1.txt"), "should capture assistant text");
      assert.equal(result.progress.toolCount, 1, "should count tool calls");
    });

    it("routes non-object child JSON to the raw transcript and preserves unknown events", async () => {
      const unknownEvent = {
        type: "future_event",
        extraField: { nested: true },
        anotherField: ["preserve", 7],
      };
      mockPi.onCall({
        jsonl: [
          null,
          [1, "two"],
          JSON.stringify("primitive"),
          42,
          unknownEvent,
          events.assistantMessage("Done"),
        ],
      });
      const artifactsDir = path.join(tempDir, "json-guard-artifacts");
      const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
        runId: "foreground-json-guards",
        artifactsDir,
        artifactConfig: {
          enabled: true,
          includeInput: false,
          includeOutput: false,
          includeJsonl: true,
          includeTranscript: true,
          includeMetadata: false,
        },
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.finalOutput, "Done");
      assert.ok(result.artifactPaths?.jsonlPath, "expected JSONL artifact");
      assert.ok(result.transcriptPath, "expected transcript artifact");
      const jsonlRecords = fs
        .readFileSync(result.artifactPaths!.jsonlPath, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown);
      assert.equal(jsonlRecords.length, 6, "expected 6 JSONL records");
      assert.deepEqual(jsonlRecords[0], null);
      assert.deepEqual(jsonlRecords[1], [1, "two"]);
      assert.deepEqual(jsonlRecords[2], "primitive");
      assert.deepEqual(jsonlRecords[3], 42);
      assert.deepEqual(jsonlRecords[4], unknownEvent);
      // Record 5 is the assistant message_end event. The default acceptance level is "auto",
      // so formatAcceptancePrompt emits a "## Acceptance Contract" section; the mock's
      // taskRequestsAcceptance detects it and withAcceptanceReport appends an acceptance
      // report to the assistant text. Assert structure and key fields, not exact text.
      const r5 = jsonlRecords[5] as {
        type?: string;
        message?: {
          role?: string;
          model?: string;
          stopReason?: string;
          content?: Array<{ type?: string; text?: string }>;
        };
      };
      assert.equal(r5.type, "message_end", "record 5 is message_end");
      assert.equal(r5.message?.role, "assistant", "record 5 message role is assistant");
      assert.equal(
        r5.message?.model,
        "mock/test-model",
        "record 5 message model is mock/test-model",
      );
      assert.equal(r5.message?.stopReason, "stop", "record 5 message stopReason is stop");
      assert.ok(
        r5.message?.content?.[0]?.text?.startsWith("Done"),
        "record 5 text starts with 'Done'",
      );

      const transcriptRecords = fs
        .readFileSync(result.transcriptPath!, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { recordType?: string; text?: string });
      assert.deepEqual(
        transcriptRecords
          .filter((record) => record.recordType === "stdout")
          .map((record) => record.text),
        ["null", '[1,"two"]', '"primitive"', "42", JSON.stringify(unknownEvent)],
      );
    });

    it("resolves skills from the effective task cwd", async () => {
      const taskCwd = createTempDir("pi-subagent-task-cwd-");
      try {
        writePackageSkill(taskCwd, "task-cwd-skill");
        mockPi.onCall({ output: "Done" });
        const agents = [makeAgent("echo", { skills: ["task-cwd-skill"] })];

        const result = await runSync(tempDir, agents, "echo", "Task", { cwd: taskCwd });

        assert.equal(result.exitCode, 0);
        assert.deepEqual(result.skills, ["task-cwd-skill"]);
        assert.equal(result.skillsWarning, undefined);
      } finally {
        removeTempDir(taskCwd);
      }
    });

    it("falls back to the runtime cwd when the task cwd lacks a skill", async () => {
      const taskCwd = path.join(tempDir, "nested");
      fs.mkdirSync(taskCwd, { recursive: true });
      writePackageSkill(tempDir, "runtime-fallback-skill");
      mockPi.onCall({ output: "Done" });
      const agents = [makeAgent("echo", { skills: ["runtime-fallback-skill"] })];

      const result = await runSync(tempDir, agents, "echo", "Task", { cwd: taskCwd });

      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.skills, ["runtime-fallback-skill"]);
      assert.equal(result.skillsWarning, undefined);
    });

    it("fails foreground runs on explicit unavailable pi-subagents skill requests without spawning", async () => {
      const agents = [makeAgent("worker")];

      const result = await runSync(tempDir, agents, "worker", "Task", { skills: ["pi-subagents"] });

      assert.equal(result.exitCode, 1);
      assert.equal(result.error, "Skills not found: pi-subagents");
      assert.equal(mockPi.callCount(), 0);
    });

    it("fails foreground runs when an agent default requests pi-subagents skill", async () => {
      const agents = [makeAgent("worker", { skills: ["pi-subagents"] })];

      const result = await runSync(tempDir, agents, "worker", "Task", {});

      assert.equal(result.exitCode, 1);
      assert.equal(result.error, "Skills not found: pi-subagents");
      assert.equal(mockPi.callCount(), 0);
    });

    it("writes artifacts when configured", async () => {
      mockPi.onCall({ output: "Result text" });
      const agents = makeAgentConfigs(["echo"]);
      const artifactsDir = path.join(tempDir, "artifacts");

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "test-run",
        artifactsDir,
        artifactConfig: {
          enabled: true,
          includeInput: true,
          includeOutput: true,
          includeMetadata: true,
        },
      });

      assert.equal(result.exitCode, 0);
      assert.ok(result.artifactPaths, "should have artifact paths");
      assert.ok(result.transcriptPath, "should expose transcript path on the result");
      assert.equal(result.transcriptPath, result.artifactPaths.transcriptPath);
      assert.ok(fs.existsSync(result.transcriptPath), "transcript should be written");
      const transcript = fs
        .readFileSync(result.transcriptPath, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { recordType?: string; source?: string; text?: string });
      assert.equal(transcript[0]?.recordType, "message");
      assert.equal(transcript[0]?.source, "foreground");
      assert.match(transcript.at(-1)?.text ?? "", /^Result text/);
      assert.equal(result.transcriptError, undefined);
      assert.ok(fs.existsSync(artifactsDir), "artifacts dir should exist");
    });

    it("does not surface transcript paths when transcript artifacts are disabled", async () => {
      mockPi.onCall({ output: "Result text" });
      const agents = makeAgentConfigs(["echo"]);
      const artifactsDir = path.join(tempDir, "artifacts-disabled-transcript");

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "test-run-no-transcript",
        artifactsDir,
        artifactConfig: {
          enabled: true,
          includeInput: true,
          includeOutput: true,
          includeTranscript: false,
          includeMetadata: true,
        },
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.transcriptPath, undefined);
      assert.equal(result.transcriptError, undefined);
      assert.ok(result.artifactPaths?.metadataPath, "should have metadata path");
      const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf-8")) as {
        transcriptPath?: string;
        transcriptError?: string;
      };
      assert.equal(metadata.transcriptPath, undefined);
      assert.equal(metadata.transcriptError, undefined);
      assert.equal(fs.existsSync(result.artifactPaths.transcriptPath!), false);
    });

    it("preserves agent-written output files instead of overwriting them with the final receipt", async () => {
      const outputPath = path.join(tempDir, "report.md");
      const artifactsDir = path.join(tempDir, "artifacts");
      mockPi.onCall({ output: `Wrote to ${outputPath}`, delay: 100 });
      const agents = makeAgentConfigs(["echo"]);

      const runPromise = runSync(tempDir, agents, "echo", "Task", {
        runId: "output-file-preserved",
        outputPath,
        artifactsDir,
        artifactConfig: {
          enabled: true,
          includeInput: true,
          includeOutput: true,
          includeMetadata: true,
        },
      });

      setTimeout(() => {
        fs.writeFileSync(outputPath, "real file content", "utf-8");
      }, 20);

      const result = await runPromise;
      assert.equal(result.exitCode, 0);
      assert.equal(result.finalOutput, "real file content");
      assert.equal(fs.readFileSync(outputPath, "utf-8"), "real file content");
      assert.ok(result.artifactPaths, "should have artifact paths");
      assert.equal(fs.readFileSync(result.artifactPaths.outputPath, "utf-8"), "real file content");
    });

    it("falls back to persisting assistant output when the target file was not changed", async () => {
      const outputPath = path.join(tempDir, "report.md");
      fs.writeFileSync(outputPath, "stale content", "utf-8");
      mockPi.onCall({ output: "fresh assistant output" });
      const agents = makeAgentConfigs(["echo"]);

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "output-file-fallback",
        outputPath,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.finalOutput, "fresh assistant output");
      assert.equal(fs.readFileSync(outputPath, "utf-8"), "fresh assistant output");
    });

    it(
      "routes foreground single relative outputs to the parent session artifact directory by default",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        mockPi.onCall({ output: "default report" });
        const executor = makeExecutor([makeAgent("researcher", { output: "context.md" })]);
        const parentSessionFile = path.join(tempDir, "parent-session", "session.jsonl");
        const ctx = {
          ...makeMinimalCtx(tempDir),
          sessionManager: {
            getSessionId: () => "session-123",
            getSessionFile: () => parentSessionFile,
          },
        };

        const result = await executor.execute(
          "single-default-output-base",
          { agent: "researcher", task: "Write report" },
          new AbortController().signal,
          undefined,
          ctx,
        );

        const outputRoot = path.join(tempDir, "parent-session", "subagent-artifacts", "outputs");
        const taskArg = readCallArgs().at(-1) ?? "";
        assert.equal(result.isError, undefined);
        assert.match(
          taskArg,
          new RegExp(
            `Write your findings to exactly this path: ${escapeRegExp(outputRoot)}.*context\\.md`,
          ),
        );
        const outputPath = taskArg.match(/Write your findings to exactly this path: (\S+)/)?.[1];
        assert.ok(outputPath, "expected output path in child task");
        assert.equal(fs.readFileSync(outputPath, "utf-8"), "default report");
        assert.equal(fs.existsSync(path.join(tempDir, ".pi-subagents", "artifacts")), false);
        assert.equal(fs.existsSync(path.join(tempDir, "context.md")), false);
      },
    );

    it(
      "makes task-level output overrides authoritative in the child system prompt",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        mockPi.onCall({ output: "override report" });
        const overridePath = path.join(tempDir, "custom-report.md");
        const executor = makeExecutor([
          makeAgent("researcher", {
            output: "default-report.md",
            systemPrompt:
              "Output format (`default-report.md`):\n\nWrite the full report to default-report.md.",
          }),
        ]);

        const result = await executor.execute(
          "single-output-override-system-prompt",
          { agent: "researcher", task: "Write report", output: overridePath },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        const call = readCall();
        const taskArg = call.args.at(-1) ?? "";
        const systemPrompt = call.systemPrompts[0]?.text ?? "";
        assert.equal(result.isError, undefined);
        assert.match(
          taskArg,
          new RegExp(`Write your findings to exactly this path: ${escapeRegExp(overridePath)}`),
        );
        assert.match(systemPrompt, /Output format \(`default-report\.md`\):/);
        assert.match(systemPrompt, /Runtime output path override:/);
        assert.match(
          systemPrompt,
          new RegExp(`Write your findings to exactly this path: ${escapeRegExp(overridePath)}`),
        );
        assert.match(
          systemPrompt,
          /Ignore any other output filename or output path mentioned elsewhere/,
        );
      },
    );

    it(
      "treats string false as disabled output in foreground single runs",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        mockPi.onCall({ output: "inline report" });
        const executor = makeExecutor([makeAgent("echo", { output: "default-report.md" })]);

        const result = await executor.execute(
          "single-string-false-output",
          { agent: "echo", task: "Write report", output: "false" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, undefined);
        assert.match(result.content[0]?.text ?? "", /inline report/);
        assert.doesNotMatch(result.content[0]?.text ?? "", /Output saved to:/);
        assert.equal(fs.existsSync(path.join(tempDir, "false")), false);
        assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
        assert.doesNotMatch(
          readCallArgs().at(-1) ?? "",
          /Write your findings to(?: exactly this path)?:/,
        );
      },
    );

    it("rejects file-only mode without an output path before spawning", async () => {
      const agents = makeAgentConfigs(["echo"]);

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "output-file-only-missing-path",
        outputMode: "file-only",
      });

      assert.equal(result.exitCode, 1);
      assert.match(result.error ?? "", /outputMode: "file-only"/);
      assert.equal(mockPi.callCount(), 0);
    });

    it("returns only a saved-output reference in file-only mode", async () => {
      const outputPath = path.join(tempDir, "file-only-report.md");
      const artifactsDir = path.join(tempDir, "file-only-artifacts");
      mockPi.onCall({ output: "full saved output\nwith details" });
      const agents = makeAgentConfigs(["echo"]);

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "output-file-only",
        outputPath,
        outputMode: "file-only",
        artifactsDir,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.outputMode, "file-only");
      assert.equal(result.savedOutputPath, outputPath);
      assert.equal(result.outputReference?.path, outputPath);
      assert.match(result.finalOutput ?? "", /^Output saved to:/);
      assert.match(result.finalOutput ?? "", /2 lines/);
      assert.doesNotMatch(result.finalOutput ?? "", /full saved output/);
      assert.equal(fs.readFileSync(outputPath, "utf-8"), "full saved output\nwith details");
      assert.ok(result.artifactPaths, "should have artifact paths");
      assert.equal(
        fs.readFileSync(result.artifactPaths.outputPath, "utf-8"),
        "full saved output\nwith details",
      );
    });

    it(
      "foreground acceptance rejection preserves an inline saved-output reference",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const outputPath = path.join(tempDir, "acceptance-rejected-inline.md");
        const savedContent = "saved deliverable from an otherwise successful run";
        mockPi.onCall({ output: explicitAcceptanceRejectionOutput(savedContent) });
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
        const child = result.details?.results?.[0];
        const display = result.content.map((item) => item.text ?? "").join("\n");

        assert.equal(result.isError, true);
        assert.equal(child?.exitCode, 1);
        assert.equal(child?.acceptance?.explicit, true);
        assert.equal(child?.acceptance?.status, "rejected");
        assert.equal(child?.savedOutputPath, outputPath);
        const savedBytes = fs.readFileSync(outputPath);
        assert.equal(savedBytes.toString("utf-8"), savedContent);
        const artifactOutputPath = child?.artifactPaths?.outputPath;
        assert.ok(artifactOutputPath, "expected the supervisor-facing output artifact");
        assert.deepEqual(fs.readFileSync(artifactOutputPath), savedBytes);
        assert.match(child?.error ?? "", /Acceptance rejected/);
        assert.equal((display.match(/Output saved to:/g) ?? []).length, 1);
      },
    );

    it(
      "foreground file-only acceptance rejection preserves only the saved-output reference",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const outputPath = path.join(tempDir, "acceptance-rejected-file-only.md");
        const savedContent = "saved file-only deliverable";
        mockPi.onCall({ output: explicitAcceptanceRejectionOutput(savedContent) });
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
        const child = result.details?.results?.[0];
        const display = result.content.map((item) => item.text ?? "").join("\n");

        assert.equal(result.isError, true);
        assert.equal(child?.exitCode, 1);
        assert.equal(child?.acceptance?.explicit, true);
        assert.equal(child?.acceptance?.status, "rejected");
        assert.equal(child?.savedOutputPath, outputPath);
        const savedBytes = fs.readFileSync(outputPath);
        assert.equal(savedBytes.toString("utf-8"), savedContent);
        const artifactOutputPath = child?.artifactPaths?.outputPath;
        assert.ok(artifactOutputPath, "expected the supervisor-facing output artifact");
        assert.deepEqual(fs.readFileSync(artifactOutputPath), savedBytes);
        assert.match(child?.error ?? "", /Acceptance rejected/);
        assert.equal((display.match(/Output saved to:/g) ?? []).length, 1);
        assert.doesNotMatch(display, new RegExp(escapeRegExp(savedContent)));
      },
    );

    it(
      "foreground inferred acceptance rejection preserves an inline saved-output reference",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const outputPath = path.join(tempDir, "inferred-acceptance-rejected.md");
        const savedContent = "saved deliverable without a report";
        mockPi.onCall({ output: inferredAcceptanceRejectionOutput(savedContent) });
        const executor = makeExecutor([makeAgent("worker", { completionGuard: false })]);

        const result = await executor.execute(
          "inferred-acceptance-rejected",
          {
            agent: "worker",
            task: "Implement the approved change",
            output: outputPath,
            artifacts: true,
          },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        const child = result.details?.results?.[0];
        const display = result.content.map((item) => item.text ?? "").join("\n");

        assert.equal(result.isError, undefined);
        assert.equal(child?.exitCode, 0);
        assert.equal(child?.acceptance?.explicit, false);
        assert.equal(child?.acceptance?.status, "rejected");
        assert.equal(child?.savedOutputPath, outputPath);
        assert.equal(fs.readFileSync(outputPath, "utf-8"), savedContent);
        assert.equal((display.match(/Output saved to:/g) ?? []).length, 1);
      },
    );

    it("passes maxSubagentDepth through to child execution env", async () => {
      mockPi.onCall({ echoEnv: ["PI_SUBAGENT_DEPTH", "PI_SUBAGENT_MAX_DEPTH"] });
      const agents = makeAgentConfigs(["echo"]);
      const prevDepth = process.env.PI_SUBAGENT_DEPTH;
      const prevMaxDepth = process.env.PI_SUBAGENT_MAX_DEPTH;
      delete process.env.PI_SUBAGENT_DEPTH;
      delete process.env.PI_SUBAGENT_MAX_DEPTH;

      try {
        const result = await runSync(tempDir, agents, "echo", "Task", {
          runId: "depth-env",
          maxSubagentDepth: 1,
        });

        assert.equal(result.exitCode, 0);
        assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
          PI_SUBAGENT_DEPTH: "1",
          PI_SUBAGENT_MAX_DEPTH: "1",
        });
      } finally {
        if (prevDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
        else process.env.PI_SUBAGENT_DEPTH = prevDepth;
        if (prevMaxDepth === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH;
        else process.env.PI_SUBAGENT_MAX_DEPTH = prevMaxDepth;
      }
    });

    it("filters inherited HERDR credentials in the actual foreground child spawn", async () => {
      mockPi.onCall({
        echoEnv: [
          "HERDR_PANE_ID",
          "HERDR_SOCKET_PATH",
          "HERDR_ENV",
          "PI_SUBAGENT_DEPTH",
          "PI_SUBAGENT_MAX_DEPTH",
        ],
      });
      const envKeys = [
        "HERDR_PANE_ID",
        "HERDR_SOCKET_PATH",
        "HERDR_ENV",
        "PI_SUBAGENT_DEPTH",
        "PI_SUBAGENT_MAX_DEPTH",
      ];
      const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
      process.env.HERDR_PANE_ID = "parent-pane-credential";
      process.env.HERDR_SOCKET_PATH = "/tmp/parent-herdr.sock";
      process.env.HERDR_ENV = "1";
      delete process.env.PI_SUBAGENT_DEPTH;
      delete process.env.PI_SUBAGENT_MAX_DEPTH;

      try {
        const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
          runId: "foreground-herdr-env",
          maxSubagentDepth: 1,
        });

        assert.equal(result.exitCode, 0);
        assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
          HERDR_PANE_ID: null,
          HERDR_SOCKET_PATH: null,
          HERDR_ENV: null,
          PI_SUBAGENT_DEPTH: "1",
          PI_SUBAGENT_MAX_DEPTH: "1",
        });
      } finally {
        for (const [key, value] of previousEnv) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });

    it("passes prompt inheritance env flags through to child execution", async () => {
      mockPi.onCall({
        echoEnv: ["PI_SUBAGENT_INHERIT_PROJECT_CONTEXT", "PI_SUBAGENT_INHERIT_SKILLS"],
      });
      const agents = [
        makeAgent("echo", {
          systemPromptMode: "replace",
          inheritProjectContext: false,
          inheritSkills: false,
        }),
      ];

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "prompt-inheritance-env",
      });

      assert.equal(result.exitCode, 0);
      assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
        PI_SUBAGENT_INHERIT_PROJECT_CONTEXT: "0",
        PI_SUBAGENT_INHERIT_SKILLS: "0",
      });
    });

    it("passes native supervisor metadata through to child execution", async () => {
      mockPi.onCall({
        echoEnv: [
          "PI_SUBAGENT_ORCHESTRATOR_SESSION_ID",
          "PI_SUBAGENT_RUN_ID",
          "PI_SUBAGENT_CHILD_AGENT",
          "PI_SUBAGENT_CHILD_INDEX",
        ],
      });
      const agents = makeAgentConfigs(["echo"]);

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "78f659a3",
        index: 2,
        parentSessionId: "session-parent",
      });

      assert.equal(result.exitCode, 0);
      assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
        PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: "session-parent",
        PI_SUBAGENT_RUN_ID: "78f659a3",
        PI_SUBAGENT_CHILD_AGENT: "echo",
        PI_SUBAGENT_CHILD_INDEX: "2",
      });
    });

    it(
      "passes custom tool extensions through even when explicit extensions are allowlisted",
      {
        skip:
          process.platform === "win32"
            ? "extension path resolution intermittent on Windows CI"
            : undefined,
      },
      async () => {
        mockPi.onCall({ output: "Done" });
        const agents = [
          makeAgent("echo", {
            tools: ["read", "./custom-tool.ts"],
            extensions: ["./allowed-ext.ts"],
          }),
        ];

        const result = await runSync(tempDir, agents, "echo", "Task", {
          runId: "tool-extension-allowlist",
        });

        assert.equal(result.exitCode, 0);
        const args = readCallArgs();
        const extensionArgs = args.filter((_arg, index) => args[index - 1] === "--extension");
        assert.ok(
          extensionArgs.some((arg) =>
            arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts")),
          ),
        );
        assert.ok(extensionArgs.some((arg) => arg.replace(/\\/g, "/").endsWith("custom-tool.ts")));
        assert.ok(extensionArgs.some((arg) => arg.replace(/\\/g, "/").endsWith("allowed-ext.ts")));
      },
    );

    it(
      "passes subagent-only extensions through to child execution",
      {
        skip:
          process.platform === "win32"
            ? "extension path resolution intermittent on Windows CI"
            : undefined,
      },
      async () => {
        mockPi.onCall({ output: "Done" });
        const agents = [
          makeAgent("echo", {
            tools: ["read"],
            subagentOnlyExtensions: ["./child-only-tool.ts"],
          }),
        ];

        const result = await runSync(tempDir, agents, "echo", "Task", {
          runId: "subagent-only-extension",
        });

        assert.equal(result.exitCode, 0);
        const args = readCallArgs();
        const extensionArgs = args.filter((_arg, index) => args[index - 1] === "--extension");
        assert.ok(
          extensionArgs.some((arg) =>
            arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts")),
          ),
        );
        assert.ok(
          extensionArgs.some((arg) => arg.replace(/\\/g, "/").endsWith("child-only-tool.ts")),
        );
      },
    );

    it("returns an actionable policy failure and writes foreground artifacts", async () => {
      const skillName = "lazy-policy-skill";
      writePackageSkill(tempDir, skillName);
      const artifactsDir = path.join(tempDir, "policy-artifacts");
      const agents = [
        makeAgent("worker", {
          tools: ["./custom-tool.ts"],
          skills: [skillName],
        }),
      ];

      const result = await runSync(tempDir, agents, "worker", "Inspect the task", {
        runId: "invalid-tool-policy",
        tkTicket: { id: "tlhsrhp-o76f", title: "Enforce child tool policy safely" },
        artifactsDir,
        artifactConfig: {
          enabled: true,
          includeInput: true,
          includeOutput: true,
          includeJsonl: true,
          includeMetadata: true,
          includeTranscript: true,
        },
      });

      assert.equal(result.exitCode, 1);
      assert.deepEqual(result.tkTicket, {
        id: "tlhsrhp-o76f",
        title: "Enforce child tool policy safely",
      });
      assert.equal(result.error, INVALID_LAZY_SKILL_TOOL_POLICY_ERROR);
      assert.equal(mockPi.callCount(), 0, "invalid policy must not spawn Pi");
      const artifactPaths = result.artifactPaths;
      assert.ok(artifactPaths);
      assert.ok(artifactPaths.outputPath);
      assert.ok(
        fs
          .readFileSync(artifactPaths.outputPath, "utf-8")
          .includes(INVALID_LAZY_SKILL_TOOL_POLICY_ERROR),
      );
      assert.ok(fs.existsSync(artifactPaths.metadataPath));
      assert.ok(artifactPaths.transcriptPath);
      assert.ok(fs.existsSync(artifactPaths.transcriptPath));
    });
  },
);

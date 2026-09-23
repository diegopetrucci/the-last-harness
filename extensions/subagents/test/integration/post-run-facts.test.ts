/** Integration coverage for persisted post-run facts and workspace attribution. */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createMockPi, createTempDir, makeAgent, removeTempDir } from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import {
  ASYNC_DIR,
  RESULTS_DIR,
  createRepo,
  type AsyncResultPayload,
  type AsyncStatusPayload,
  executeAsyncParallel,
  executeAsyncSingle,
  waitForAsyncResultFile,
  waitForMarker,
} from "../support/async-execution-helpers.ts";
import {
  buildCompletionDetails,
  formatSingleCompletion,
} from "../../src/runs/background/notify.ts";
import { formatAwaitedNativeSubagentResult } from "../../src/shared/result-formatting.ts";

function artifactConfig() {
  return {
    enabled: true,
    includeInput: false,
    includeOutput: true,
    includeJsonl: false,
    includeTranscript: false,
    includeMetadata: true,
    includeChildEventProjections: false,
    cleanupDays: 7,
  } as const;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

describe("async post-run facts", () => {
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

  it("persists developer editing facts in status, artifacts, and rendered output", async () => {
    const repoDir = createRepo("tlh-post-run-developer-");
    const id = `post-run-developer-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    const sessionFile = path.join(tempDir, "developer-session.jsonl");
    const startedMarker = path.join(tempDir, "developer-started");
    fs.writeFileSync(sessionFile, '{"type":"session","id":"developer"}\n', "utf-8");
    mockPi.onCall({
      matchArgIncludes: "developer-style-edit",
      writeMarker: startedMarker,
      delay: 250,
      jsonl: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "runtime-edit-1",
                name: "edit",
                arguments: { path: "input.md" },
              },
            ],
            stopReason: "toolUse",
            usage: { input: 10, output: 5 },
          },
        },
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Edited input.md" }],
            stopReason: "stop",
            usage: { input: 2, output: 3 },
          },
        },
      ],
    });

    try {
      const started = executeAsyncSingle(id, {
        agent: "developer",
        task: "developer-style-edit: edit input.md and report the result",
        agentConfig: makeAgent("developer"),
        ctx: { pi: { events: { emit() {} } }, cwd: repoDir, currentSessionId: "session-1" },
        cwd: repoDir,
        sessionFile,
        artifactsDir: path.join(tempDir, "artifacts"),
        artifactConfig: artifactConfig(),
        shareEnabled: false,
        maxSubagentDepth: 2,
      });
      assert.equal(started.isError, undefined);
      await waitForMarker(startedMarker);

      // The runner has already captured its baseline when the child writes this
      // marker. Append the child session evidence and make the simulated edit
      // before the child exits, so the post snapshot is observably different.
      fs.appendFileSync(
        sessionFile,
        `${JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              { type: "toolCall", id: "developer-edit-1", name: "edit", arguments: {} },
              { type: "toolCall", id: "developer-write-1", name: "write", arguments: {} },
              { type: "toolCall", id: "developer-bash-1", name: "bash", arguments: {} },
            ],
            usage: { input: 12, output: 8 },
          },
        })}\n`,
        "utf-8",
      );
      fs.writeFileSync(path.join(repoDir, "input.md"), "edited by developer\n", "utf-8");

      await waitForAsyncResultFile(id);
      const payload = readJson<AsyncResultPayload>(resultPath);
      const status = readJson<AsyncStatusPayload>(path.join(asyncDir, "status.json"));
      const statusFacts = status.steps?.[0]?.terminalResult;
      const resultFacts = payload.results[0]?.terminalResult;

      assert.ok(statusFacts, "status step should persist terminal facts");
      assert.ok(resultFacts, "result artifact should persist terminal facts");
      assert.deepEqual(resultFacts, statusFacts);
      assert.equal(resultFacts.state, "completed");
      assert.equal(resultFacts.facts.attempts.length, 1);
      const attempt = resultFacts.facts.attempts[0]!;
      assert.equal(attempt.exit.code, 0);
      assert.equal(attempt.exit.signal, null);
      assert.ok(attempt.durationMs >= 0);
      assert.deepEqual(attempt.providerTokens, {
        status: "available",
        usage: { input: 12, output: 8, total: 20 },
      });
      assert.deepEqual(attempt.requestedToolCalls, { edit: 1, write: 1, bash: 1 });
      assert.equal(attempt.workspace.baseline.status, "available");
      assert.equal(attempt.workspace.post.status, "available");
      assert.equal(
        attempt.workspace.attribution,
        "exclusive",
        "a lone single async attempt must not attribute its own run as shared",
      );
      assert.match(attempt.workspace.post.statusPorcelainZ, /input\.md/);
      assert.notEqual(
        attempt.workspace.post.statusPorcelainZ,
        attempt.workspace.baseline.statusPorcelainZ,
      );

      const metadataPath = payload.results[0]?.artifactPaths?.metadataPath;
      assert.ok(metadataPath, "metadata artifact path should be persisted");
      const metadata = readJson<{ terminalResult?: unknown }>(metadataPath);
      assert.deepEqual(metadata.terminalResult, resultFacts);

      const child = payload.results[0]!;
      const rendered = formatAwaitedNativeSubagentResult({
        runId: id,
        mode: "single",
        children: [
          {
            agent: child.agent,
            status: child.success ? "completed" : "failed",
            summary: child.output,
            index: 0,
            artifactPath: child.artifactPaths?.outputPath,
            sessionPath: child.sessionFile,
            terminalResult: resultFacts,
          },
        ],
      });
      const artifactIndex = rendered.text.indexOf("Output artifact:");
      const factsIndex = rendered.text.indexOf("Facts:");
      const sessionIndex = rendered.text.indexOf("Session:");
      assert.ok(artifactIndex >= 0, "rendered result should include the output artifact path");
      assert.ok(factsIndex > artifactIndex, "rendered facts should follow the artifact path");
      assert.ok(sessionIndex > factsIndex, "rendered session path should follow the facts");

      const notificationDetails = buildCompletionDetails({
        id,
        agent: child.agent,
        success: child.success,
        state: payload.state,
        summary: child.output,
        timestamp: payload.timestamp,
        results: [
          {
            agent: child.agent,
            status: child.success ? "completed" : "failed",
            summary: child.output,
            artifactPath: child.artifactPaths?.outputPath,
            sessionPath: child.sessionFile,
            terminalResult: resultFacts,
          },
        ],
      });
      const notification = formatSingleCompletion(notificationDetails);
      assert.ok(
        notification.indexOf("Facts:") > notification.indexOf("Output artifact:"),
        "notification facts should follow the artifact path",
      );
      assert.match(notification, /tools=1\/1\/1/);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(asyncDir, { recursive: true, force: true });
      fs.rmSync(resultPath, { force: true });
    }
  });

  it("attributes overlapping parallel children sharing one cwd as shared", async () => {
    const repoDir = createRepo("tlh-post-run-parallel-");
    const id = `post-run-parallel-${Date.now().toString(36)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(RESULTS_DIR, `${id}.json`);
    mockPi.onCall({ matchArgIncludes: "parallel shared first", delay: 300, output: "first" });
    mockPi.onCall({ matchArgIncludes: "parallel shared second", delay: 300, output: "second" });

    try {
      const started = executeAsyncParallel(id, {
        tasks: [
          { agent: "first", task: "parallel shared first" },
          { agent: "second", task: "parallel shared second" },
        ],
        concurrency: 2,
        agents: [makeAgent("first"), makeAgent("second")],
        ctx: { pi: { events: { emit() {} } }, cwd: repoDir, currentSessionId: "session-1" },
        cwd: repoDir,
        artifactConfig: {
          ...artifactConfig(),
          includeOutput: false,
          includeMetadata: false,
          enabled: false,
        },
        shareEnabled: false,
        maxSubagentDepth: 2,
      });
      assert.equal(started.isError, undefined);
      await waitForAsyncResultFile(id);

      const payload = readJson<AsyncResultPayload>(resultPath);
      const status = readJson<AsyncStatusPayload>(path.join(asyncDir, "status.json"));
      assert.equal(payload.results.length, 2);
      assert.equal(status.steps?.length, 2);
      for (const child of payload.results) {
        assert.equal(child.terminalResult?.facts.attempts.length, 1);
        assert.equal(child.terminalResult?.facts.attempts[0]?.workspace.attribution, "shared");
      }
      for (const step of status.steps ?? []) {
        assert.equal(step.terminalResult?.facts.attempts[0]?.workspace.attribution, "shared");
      }
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(asyncDir, { recursive: true, force: true });
      fs.rmSync(resultPath, { force: true });
    }
  });
});

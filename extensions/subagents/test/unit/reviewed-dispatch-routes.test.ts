import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import type { AgentDiscoveryDiagnostic } from "../../src/agents/agents.ts";
import {
  executeAsyncChain,
  executeAsyncSingle,
} from "../../src/runs/background/async-execution.ts";
import {
  ASYNC_DIR,
  RESULTS_DIR,
  SUBAGENT_ASYNC_STARTED_EVENT,
  type SubagentState,
} from "../../src/shared/types.ts";
import { makeAgent, makeAsyncCtx, makeMinimalCtx } from "../support/helpers.ts";
import type { TextContent } from "@earendil-works/pi-ai";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function createState(): SubagentState {
  return {
    baseCwd: "",
    currentSessionId: null,
    asyncJobs: new Map(),
    foregroundRuns: new Map(),
    foregroundControls: new Map(),
    lastForegroundControlId: null,
    pendingForegroundControlNotices: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: { schedule: () => false, clear: () => {} },
  };
}

function createEvents() {
  const emitted: Array<{ channel: string; payload: unknown }> = [];
  return {
    emitted,
    api: {
      emit(channel: string, payload: unknown) {
        emitted.push({ channel, payload });
      },
      on() {
        return () => {};
      },
    },
  };
}

function createExecutor(
  root: string,
  events = createEvents(),
  agents = [makeAgent("worker"), makeAgent("producer"), makeAgent("reviewer")],
  agentDiagnostics: AgentDiscoveryDiagnostic[] = [],
) {
  return {
    events,
    executor: createSubagentExecutor({
      pi: {
        events: events.api,
        getSessionName() {
          return "parent";
        },
      } as any,
      state: createState(),
      config: { maxSubagentDepth: 2, control: {}, intercomBridge: {} } as any,
      tempArtifactsDir: root,
      getSubagentSessionRoot: (parentSessionFile) =>
        parentSessionFile
          ? path.join(path.dirname(parentSessionFile), path.basename(parentSessionFile, ".jsonl"))
          : root,
      expandTilde: (value) => value,
      discoverAgents: () => ({ agents, agentDiagnostics }),
      kill: () => true,
    }),
  };
}

function assertReviewedRejection(text: string): void {
  assert.match(text, /reviewed/);
  assert.match(text, /verified/);
  assert.match(text, /verify commands/);
  assert.match(text, /checked/);
}

describe("reviewed dispatch route preflight", () => {
  it("rejects reviewed acceptance through supported foreground single and parallel routes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reviewed-foreground-"));
    tempDirs.push(root);
    const { executor } = createExecutor(root);
    const cases: Array<{ label: string; params: Record<string, unknown> }> = [
      {
        label: "single",
        params: {
          agent: "worker",
          task: "Implement fix",
          acceptance: { level: "reviewed", review: false },
        },
      },
      {
        label: "parallel",
        params: { tasks: [{ agent: "worker", task: "Implement fix", acceptance: "reviewed" }] },
      },
    ];

    for (const testCase of cases) {
      const result = await executor.execute(
        `reviewed-${testCase.label}`,
        testCase.params,
        new AbortController().signal,
        undefined,
        makeMinimalCtx(root),
      );
      assert.equal(result.isError, true, testCase.label);
      // The executor always returns TextContent for rejection results; ImageContent is not possible here.
      assertReviewedRejection((result.content[0] as TextContent | undefined)?.text ?? "");
    }
  });

  it("reports the malformed definition reason during execution lookup", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-malformed-agent-lookup-"));
    tempDirs.push(root);
    const agentPath = path.join(root, ".pi", "agents", "broken.md");
    const { executor } = createExecutor(
      root,
      createEvents(),
      [],
      [
        {
          source: "project",
          filePath: agentPath,
          error:
            "Agent 'broken' has invalid acceptanceRole frontmatter; expected 'read-only' or 'writer'.",
        },
      ],
    );

    const result = await executor.execute(
      "malformed-agent-lookup",
      { agent: "broken", task: "Run the task" },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(root),
    );

    assert.equal(result.isError, true);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    assert.match(text, /Unknown agent: broken/);
    assert.match(text, /broken\.md/);
    assert.match(text, /acceptanceRole/);
  });

  it("rejects reviewed acceptance through direct async single and chain entry points before artifacts are created", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reviewed-async-"));
    tempDirs.push(root);
    const singleId = `reviewed-single-${Date.now().toString(36)}`;
    const single = executeAsyncSingle(singleId, {
      agent: "worker",
      task: "Implement fix",
      agentConfig: makeAgent("worker"),
      ctx: makeAsyncCtx(root, { currentSessionId: "session" }),
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      maxSubagentDepth: 2,
      acceptance: { level: "reviewed", review: false },
    });
    assert.equal(single.isError, true);
    assertReviewedRejection(single.content[0]?.text ?? "");
    assert.equal(fs.existsSync(path.join(ASYNC_DIR, singleId)), false);
    assert.equal(fs.existsSync(path.join(RESULTS_DIR, `${singleId}.json`)), false);

    const chainCases: Array<{ id: string; chain: Array<Record<string, unknown>> }> = [
      {
        id: `reviewed-chain-sequential-${Date.now().toString(36)}`,
        chain: [{ agent: "worker", task: "Implement fix", acceptance: "reviewed" }],
      },
      {
        id: `reviewed-chain-static-${Date.now().toString(36)}`,
        chain: [{ parallel: [{ agent: "worker", task: "Implement fix", acceptance: "reviewed" }] }],
      },
    ];

    for (const testCase of chainCases) {
      const result = executeAsyncChain(testCase.id, {
        chain: testCase.chain as any,
        agents: [makeAgent("worker"), makeAgent("producer"), makeAgent("reviewer")],
        ctx: makeAsyncCtx(root, { currentSessionId: "session" }),
        artifactConfig: {
          enabled: false,
          includeInput: false,
          includeOutput: false,
          includeJsonl: false,
          includeMetadata: false,
          cleanupDays: 7,
        },
        shareEnabled: false,
        maxSubagentDepth: 2,
      });
      assert.equal(result.isError, true, testCase.id);
      assertReviewedRejection(result.content[0]?.text ?? "");
      assert.equal(fs.existsSync(path.join(ASYNC_DIR, testCase.id)), false, testCase.id);
      assert.equal(
        fs.existsSync(path.join(RESULTS_DIR, `${testCase.id}.json`)),
        false,
        testCase.id,
      );
    }
  });

  it("rejects unsupported chain attachment on resume before launching async work", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reviewed-resume-"));
    tempDirs.push(root);
    const sourceRunId = `resume-reviewed-${Date.now().toString(36)}`;
    const sourceAsyncDir = path.join(ASYNC_DIR, sourceRunId);
    const sourceSession = path.join(root, "child-session.jsonl");
    const sourceResultPath = path.join(RESULTS_DIR, `${sourceRunId}.json`);
    fs.mkdirSync(sourceAsyncDir, { recursive: true });
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(sourceSession, "", "utf-8");
    fs.writeFileSync(
      path.join(sourceAsyncDir, "status.json"),
      JSON.stringify(
        {
          runId: sourceRunId,
          mode: "single",
          state: "running",
          pid: process.pid,
          startedAt: 1,
          lastUpdate: 1,
          cwd: root,
          steps: [{ agent: "worker", status: "running", sessionFile: sourceSession }],
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      sourceResultPath,
      JSON.stringify(
        {
          id: sourceRunId,
          agent: "worker",
          mode: "single",
          success: true,
          state: "complete",
          results: [
            { agent: "worker", output: "root output", success: true, sessionFile: sourceSession },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    const { executor, events } = createExecutor(root);

    const result = await executor.execute(
      "resume-reviewed-attach",
      {
        action: "resume",
        id: sourceRunId,
        chain: [{ agent: "reviewer", task: "Review the attached root", acceptance: "reviewed" }],
      },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(root),
    );

    assert.equal(result.isError, true);
    // The executor always returns TextContent for rejection results; ImageContent is not possible here.
    assert.match(
      (result.content[0] as TextContent | undefined)?.text ?? "",
      /Saved chains are deliberately unsupported in The Last Harness/,
    );
    assert.equal(result.details?.asyncId, undefined);
    assert.equal(
      events.emitted.some((entry) => entry.channel === SUBAGENT_ASYNC_STARTED_EVENT),
      false,
    );
  });
});

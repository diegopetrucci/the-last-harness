import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import {
  NATIVE_SUPERVISOR_TOOL_NAME,
  createNativeSupervisorChannel,
  ensureSupervisorChannelDir,
  registerNativeSupervisorClient,
  resolveSupervisorChannelDir,
} from "../../src/supervisor/native-supervisor-channel.ts";
import {
  SUBAGENT_CHILD_AGENT_ENV,
  SUBAGENT_CHILD_INDEX_ENV,
  SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
  SUBAGENT_RUN_ID_ENV,
  SUBAGENT_SUPERVISOR_BRIDGE_ENV,
  SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
} from "../../src/runs/shared/pi-args.ts";
import type { SubagentState } from "../../src/shared/types.ts";

type SupervisorReason = "need_decision" | "interview_request" | "progress_update";

interface SupervisorRequestToolDetails {
  delivered: boolean;
  requestId: string;
  reason: SupervisorReason;
}

interface PublicPendingSupervisorRequest {
  id: string;
  runId: string;
  agent: string;
  childIndex: number;
  reason: SupervisorReason;
  expectsReply: boolean;
}

type ParentSupervisorToolDetails =
  | { active: true; pending: number; root: string }
  | { pending: PublicPendingSupervisorRequest[] };

type NativeSupervisorToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: ParentSupervisorToolDetails;
};
type ContactSupervisorToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: SupervisorRequestToolDetails;
};

function supervisorText(result: NativeSupervisorToolResult): string {
  return result.content[0]?.text ?? "";
}

function malformedSupervisorAction(action: string): { action: "pending" | "status" } {
  const params: { action: "pending" | "status" } = { action: "pending" };
  Object.defineProperty(params, "action", { value: action, enumerable: true });
  return params;
}

interface InterviewRequestFixture {
  reason: SupervisorReason;
  message: string;
  expectsReply: boolean;
  expiresAt: number;
  interview: unknown;
}

function parseInterviewRequestFixture(value: unknown): InterviewRequestFixture | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const reason = Object.getOwnPropertyDescriptor(value, "reason")?.value;
  const message = Object.getOwnPropertyDescriptor(value, "message")?.value;
  const expectsReply = Object.getOwnPropertyDescriptor(value, "expectsReply")?.value;
  const expiresAt = Object.getOwnPropertyDescriptor(value, "expiresAt")?.value;
  const interview = Object.getOwnPropertyDescriptor(value, "interview")?.value;
  if (
    (reason !== "need_decision" &&
      reason !== "interview_request" &&
      reason !== "progress_update") ||
    typeof message !== "string" ||
    typeof expectsReply !== "boolean" ||
    typeof expiresAt !== "number"
  )
    return undefined;
  return { reason, message, expectsReply, expiresAt, interview };
}

const createdChannels: string[] = [];
const savedEnv = {
  [SUBAGENT_CHILD_AGENT_ENV]: process.env[SUBAGENT_CHILD_AGENT_ENV],
  [SUBAGENT_CHILD_INDEX_ENV]: process.env[SUBAGENT_CHILD_INDEX_ENV],
  [SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV]: process.env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV],
  [SUBAGENT_RUN_ID_ENV]: process.env[SUBAGENT_RUN_ID_ENV],
  [SUBAGENT_SUPERVISOR_BRIDGE_ENV]: process.env[SUBAGENT_SUPERVISOR_BRIDGE_ENV],
  [SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV]: process.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV],
};

function makeState(sessionId: string | null, ctx: unknown): SubagentState {
  return {
    baseCwd: process.cwd(),
    currentSessionId: sessionId,
    asyncJobs: new Map(),
    foregroundControls: new Map(),
    lastForegroundControlId: null,
    cleanupTimers: new Map(),
    lastUiContext: ctx as SubagentState["lastUiContext"],
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: { schedule: () => false, clear: () => {} },
  };
}

function writeRequest(input: {
  sessionId: string;
  runId: string;
  agent?: string;
  index?: number;
  message?: string;
  createdAt?: number;
  expiresAt?: number;
}): string {
  const agent = input.agent ?? "worker";
  const index = input.index ?? 0;
  const channelDir = resolveSupervisorChannelDir(input.runId, agent, index);
  createdChannels.push(channelDir);
  ensureSupervisorChannelDir(channelDir);
  const requestId = randomUUID();
  fs.writeFileSync(
    path.join(channelDir, "requests", `${requestId}.json`),
    JSON.stringify(
      {
        type: "subagent.supervisor.request",
        id: requestId,
        createdAt: input.createdAt ?? Date.now(),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        reason: "need_decision",
        message: input.message ?? "Need a decision",
        expectsReply: true,
        orchestratorSessionId: input.sessionId,
        runId: input.runId,
        agent,
        childIndex: index,
      },
      null,
      "\t",
    ),
  );
  return requestId;
}

function requestFile(runId: string, requestId: string, agent = "worker", index = 0): string {
  return path.join(
    resolveSupervisorChannelDir(runId, agent, index),
    "requests",
    `${requestId}.json`,
  );
}

function makeEmptyChannel(runId: string): string {
  const channelDir = resolveSupervisorChannelDir(runId, "worker", 0);
  createdChannels.push(channelDir);
  ensureSupervisorChannelDir(channelDir);
  return channelDir;
}

function ageChannel(channelDir: string, ageMs: number): void {
  const timestamp = new Date(Date.now() - ageMs);
  for (const dir of [
    path.join(channelDir, "requests"),
    path.join(channelDir, "replies"),
    channelDir,
  ]) {
    if (fs.existsSync(dir)) fs.utimesSync(dir, timestamp, timestamp);
  }
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv();
  delete process.env.PI_SUBAGENT_SUPERVISOR_ASK_TIMEOUT_MS;
  for (const channel of createdChannels.splice(0))
    fs.rmSync(channel, { recursive: true, force: true });
});

describe("native supervisor channel", () => {
  it("delivers requests only to the exact current session id", () => {
    const currentSessionId = `session-${randomUUID()}`;
    const otherSessionId = `session-${randomUUID()}`;
    const matchingId = writeRequest({ sessionId: currentSessionId, runId: `run-${randomUUID()}` });
    const otherId = writeRequest({ sessionId: otherSessionId, runId: `run-${randomUUID()}` });
    const sent: Array<{ content?: string; details?: { id?: string } }> = [];
    const registeredTools: string[] = [];
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      sessionManager: {
        getSessionId: () => currentSessionId,
        getSessionFile: () => null,
        getEntries: () => [],
      },
    };
    const pi = {
      getAllTools: () => [],
      registerTool: (tool: { name: string }) => {
        registeredTools.push(tool.name);
      },
      sendMessage: (message: { content?: string; details?: { id?: string } }) => {
        sent.push(message);
      },
      getSessionName: () => "shared-name",
    };
    const channel = createNativeSupervisorChannel(pi as never, makeState(currentSessionId, ctx));

    assert.deepEqual(registeredTools, []);
    channel.start();
    channel.dispose();

    assert.deepEqual(registeredTools, [NATIVE_SUPERVISOR_TOOL_NAME]);
    assert.deepEqual(
      sent.map((message) => message.details?.id),
      [matchingId],
    );
    assert.equal(
      channel.pending.has(matchingId),
      false,
      "disposed channel clears pending requests",
    );
    assert.equal(
      sent.some((message) => message.details?.id === otherId),
      false,
    );
  });

  it("creates request-only channels and prunes them when stale and empty", () => {
    const currentSessionId = `session-${randomUUID()}`;
    const staleEmptyChannel = makeEmptyChannel(`run-${randomUUID()}`);
    const staleRequestOnlyChannel = makeEmptyChannel(`run-${randomUUID()}`);
    // A legacy channel may still contain the now-unused replies directory.
    fs.mkdirSync(path.join(staleEmptyChannel, "replies"), { recursive: true });
    assert.deepEqual(fs.readdirSync(staleEmptyChannel), ["replies", "requests"]);
    assert.deepEqual(fs.readdirSync(staleRequestOnlyChannel), ["requests"]);
    ageChannel(staleEmptyChannel, 2 * 60 * 1000);
    ageChannel(staleRequestOnlyChannel, 2 * 60 * 1000);
    const sent: Array<{ details?: { id?: string } }> = [];
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      sessionManager: {
        getSessionId: () => currentSessionId,
        getSessionFile: () => null,
        getEntries: () => [],
      },
    };
    const pi = {
      getAllTools: () => [],
      registerTool: () => {},
      sendMessage: (message: { details?: { id?: string } }) => {
        sent.push(message);
      },
      getSessionName: () => "shared-name",
    };
    const channel = createNativeSupervisorChannel(pi as never, makeState(currentSessionId, ctx));

    channel.start();
    channel.dispose();

    assert.equal(fs.existsSync(staleEmptyChannel), false);
    assert.equal(fs.existsSync(staleRequestOnlyChannel), false);
    assert.deepEqual(sent, []);
  });

  it("preserves fresh or non-empty supervisor channel directories", () => {
    const currentSessionId = `session-${randomUUID()}`;
    const freshEmptyChannel = makeEmptyChannel(`run-${randomUUID()}`);
    const staleWithRequest = makeEmptyChannel(`run-${randomUUID()}`);
    const staleWithReply = makeEmptyChannel(`run-${randomUUID()}`);
    // Write a request file so the channel is non-empty (should not be removed).
    const staleRequestId = randomUUID();
    fs.writeFileSync(
      path.join(staleWithRequest, "requests", `${staleRequestId}.json`),
      JSON.stringify({ type: "subagent.supervisor.request", id: staleRequestId }),
    );
    // Legacy reply artifacts are not read or written, but non-empty directories
    // must remain untouched so cleanup cannot destroy unknown user data.
    fs.mkdirSync(path.join(staleWithReply, "replies"), { recursive: true });
    fs.writeFileSync(path.join(staleWithReply, "replies", "legacy.json"), "legacy");
    ageChannel(staleWithRequest, 2 * 60 * 1000);
    ageChannel(staleWithReply, 2 * 60 * 1000);
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      sessionManager: {
        getSessionId: () => currentSessionId,
        getSessionFile: () => null,
        getEntries: () => [],
      },
    };
    const pi = {
      getAllTools: () => [],
      registerTool: () => {},
      sendMessage: () => {},
      getSessionName: () => "shared-name",
    };
    const channel = createNativeSupervisorChannel(pi as never, makeState(currentSessionId, ctx));

    channel.start();
    channel.dispose();

    assert.equal(fs.existsSync(freshEmptyChannel), true);
    assert.equal(fs.existsSync(staleWithRequest), true);
    assert.equal(fs.existsSync(staleWithReply), true);
  });

  it("matches supervisor requests against the runtime session id instead of persisted session file path", () => {
    const currentSessionId = `session-${randomUUID()}`;
    const persistedSessionFile = path.join(os.tmpdir(), `${currentSessionId}.jsonl`);
    const matchingId = writeRequest({ sessionId: currentSessionId, runId: `run-${randomUUID()}` });
    const sent: Array<{ details?: { id?: string } }> = [];
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      sessionManager: {
        getSessionId: () => currentSessionId,
        getSessionFile: () => persistedSessionFile,
        getEntries: () => [],
      },
    };
    const pi = {
      getAllTools: () => [],
      registerTool: () => {},
      sendMessage: (message: { details?: { id?: string } }) => {
        sent.push(message);
      },
      getSessionName: () => "shared-name",
    };
    const channel = createNativeSupervisorChannel(
      pi as never,
      makeState(persistedSessionFile, ctx),
    );

    channel.start();
    channel.dispose();

    assert.deepEqual(
      sent.map((message) => message.details?.id),
      [matchingId],
    );
  });

  it("keeps an installed intercom tool and exposes only native supervisor inspection", async () => {
    const currentSessionId = `session-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    const requestId = writeRequest({ sessionId: currentSessionId, runId });
    const registeredTools = new Map<
      string,
      {
        parameters?: { properties?: { action?: { enum?: string[] } } };
        execute: (
          _id: string,
          params: { action: "pending" | "status" },
        ) => Promise<NativeSupervisorToolResult>;
      }
    >();
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      sessionManager: {
        getSessionId: () => currentSessionId,
        getSessionFile: () => null,
        getEntries: () => [],
      },
    };
    const pi = {
      getAllTools: () => [
        { name: "intercom" },
        ...[...registeredTools.keys()].map((name) => ({ name })),
      ],
      registerTool: (tool: {
        name: string;
        parameters?: { properties?: { action?: { enum?: string[] } } };
        execute: (
          _id: string,
          params: { action: "pending" | "status" },
        ) => Promise<NativeSupervisorToolResult>;
      }) => {
        registeredTools.set(tool.name, tool);
      },
      sendMessage: () => {},
      getSessionName: () => "shared-name",
    };
    const channel = createNativeSupervisorChannel(pi as never, makeState(currentSessionId, ctx));

    try {
      assert.deepEqual([...registeredTools.keys()], []);
      channel.start();

      assert.deepEqual([...registeredTools.keys()], [NATIVE_SUPERVISOR_TOOL_NAME]);
      const supervisorTool = registeredTools.get(NATIVE_SUPERVISOR_TOOL_NAME)!;
      assert.deepEqual(supervisorTool.parameters?.properties?.action?.enum, ["pending", "status"]);
      const status = await supervisorTool.execute("status", { action: "status" });
      assert.match(supervisorText(status), /Native supervisor channel active/);
      const pending = await supervisorTool.execute("pending", { action: "pending" });
      const pendingRequests = pending.details.pending;
      assert.ok(Array.isArray(pendingRequests));
      assert.deepEqual(
        pendingRequests.map((request) => request.id),
        [requestId],
      );
      await assert.rejects(
        () => supervisorTool.execute("list", malformedSupervisorAction("list")),
        /Unsupported supervisor action: list/,
      );
      await assert.rejects(
        () => supervisorTool.execute("reply", malformedSupervisorAction("reply")),
        /Unsupported supervisor action: reply/,
      );
    } finally {
      channel.dispose();
    }
  });

  it("cleans up pre-pause expired and terminal requests before displaying them", () => {
    const currentSessionId = `session-${randomUUID()}`;
    const expiredRunId = `run-${randomUUID()}`;
    const continuedRunId = `run-${randomUUID()}`;
    const cancelledRunId = `run-${randomUUID()}`;
    const completedRunId = `run-${randomUUID()}`;
    const failedRunId = `run-${randomUUID()}`;
    const expiredId = writeRequest({
      sessionId: currentSessionId,
      runId: expiredRunId,
      expiresAt: Date.now() - 1,
    });
    const continuedId = writeRequest({ sessionId: currentSessionId, runId: continuedRunId });
    const cancelledId = writeRequest({ sessionId: currentSessionId, runId: cancelledRunId });
    const completedId = writeRequest({ sessionId: currentSessionId, runId: completedRunId });
    const failedId = writeRequest({ sessionId: currentSessionId, runId: failedRunId });
    const sent: Array<{ details?: { id?: string } }> = [];
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      sessionManager: {
        getSessionId: () => currentSessionId,
        getSessionFile: () => null,
        getEntries: () => [],
      },
    };
    const state = makeState(currentSessionId, ctx);
    state.asyncJobs.set(continuedRunId, {
      asyncId: continuedRunId,
      asyncDir: path.join(os.tmpdir(), continuedRunId),
      status: "continued",
      steps: [{ agent: "worker", status: "continued", pause: { kind: "awaiting_supervisor" } }],
    });
    state.asyncJobs.set(cancelledRunId, {
      asyncId: cancelledRunId,
      asyncDir: path.join(os.tmpdir(), cancelledRunId),
      status: "cancelled",
      steps: [{ agent: "worker", status: "cancelled", pause: { kind: "awaiting_supervisor" } }],
    });
    state.asyncJobs.set(completedRunId, {
      asyncId: completedRunId,
      asyncDir: path.join(os.tmpdir(), completedRunId),
      status: "complete",
      steps: [{ agent: "worker", status: "completed" }],
    });
    state.asyncJobs.set(failedRunId, {
      asyncId: failedRunId,
      asyncDir: path.join(os.tmpdir(), failedRunId),
      status: "failed",
      steps: [{ agent: "worker", status: "failed" }],
    });
    const pi = {
      getAllTools: () => [],
      registerTool: () => {},
      sendMessage: (message: { details?: { id?: string } }) => {
        sent.push(message);
      },
      getSessionName: () => "shared-name",
    };
    const channel = createNativeSupervisorChannel(pi as never, state);

    channel.start();
    channel.dispose();

    assert.deepEqual(sent, []);
    assert.equal(fs.existsSync(requestFile(expiredRunId, expiredId)), false);
    assert.equal(fs.existsSync(requestFile(continuedRunId, continuedId)), false);
    assert.equal(fs.existsSync(requestFile(cancelledRunId, cancelledId)), false);
    assert.equal(fs.existsSync(requestFile(completedRunId, completedId)), false);
    assert.equal(fs.existsSync(requestFile(failedRunId, failedId)), false);
  });

  it("keeps blocking requests phase-truthful before durable pause completes", async () => {
    const currentSessionId = `session-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    writeRequest({ sessionId: currentSessionId, runId, index: 3 });
    const registeredTools = new Map<
      string,
      {
        execute: (
          _id: string,
          params: { action: "pending" | "status" },
        ) => Promise<NativeSupervisorToolResult>;
      }
    >();
    const sent: Array<{ content?: string; details?: { id?: string } }> = [];
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      sessionManager: {
        getSessionId: () => currentSessionId,
        getSessionFile: () => null,
        getEntries: () => [],
      },
    };
    const state = makeState(currentSessionId, ctx);
    state.asyncJobs.set(runId, {
      asyncId: runId,
      asyncDir: path.join(os.tmpdir(), runId),
      status: "pausing",
      pid: process.pid,
      steps: [
        { agent: "noop", status: "complete" },
        { agent: "noop", status: "complete" },
        { agent: "noop", status: "complete" },
        { agent: "worker", status: "pausing", pause: { kind: "awaiting_supervisor" } },
      ],
    });
    const pi = {
      getAllTools: () => [...registeredTools.keys()].map((name) => ({ name })),
      registerTool: (tool: {
        name: string;
        execute: (
          _id: string,
          params: { action: "pending" | "status" },
        ) => Promise<NativeSupervisorToolResult>;
      }) => {
        registeredTools.set(tool.name, tool);
      },
      sendMessage: (message: { content?: string; details?: { id?: string } }) => {
        sent.push(message);
      },
      getSessionName: () => "shared-name",
    };
    const channel = createNativeSupervisorChannel(pi as never, state);

    try {
      channel.start();
      const visible = sent[0]?.content ?? "";
      assert.match(visible, /Child 3 has a blocking request entering durable pause\./);
      assert.match(
        visible,
        /Blocking request is entering durable pause; wait until subagent status reports paused\./,
      );
      assert.match(
        visible,
        /Once paused, no child process is running\. Then use these exact actions:/,
      );
      assert.match(
        visible,
        new RegExp(
          `When paused: Resume unchanged: subagent\\(\\{ action: "resume", id: "${runId}", index: 3 \\}\\)`,
        ),
      );
      assert.match(
        visible,
        new RegExp(
          `When paused: Resume with guidance: subagent\\(\\{ action: "resume", id: "${runId}", index: 3, message: "Supervisor replied: ..." \\}\\)`,
        ),
      );
      assert.match(
        visible,
        new RegExp(
          `When paused: Cancel: subagent\\(\\{ action: "interrupt", id: "${runId}", index: 3 \\}\\)`,
        ),
      );
      assert.doesNotMatch(
        visible,
        new RegExp(`${NATIVE_SUPERVISOR_TOOL_NAME}\\(\\{ action: "reply"`),
      );
      assert.doesNotMatch(visible, /^No child process is running\./m);
      assert.doesNotMatch(visible, /^Reply with:/m);

      const pendingResult = await registeredTools
        .get(NATIVE_SUPERVISOR_TOOL_NAME)!
        .execute("pending", { action: "pending" });
      const pendingText = pendingResult.content[0]!.text;
      assert.match(
        pendingText,
        new RegExp(
          `When paused: Resume unchanged: subagent\\(\\{ action: "resume", id: "${runId}", index: 3 \\}\\)`,
        ),
      );
      assert.match(
        pendingText,
        new RegExp(
          `When paused: Resume with guidance: subagent\\(\\{ action: "resume", id: "${runId}", index: 3, message: "Supervisor replied: ..." \\}\\)`,
        ),
      );
      assert.match(
        pendingText,
        new RegExp(
          `When paused: Cancel: subagent\\(\\{ action: "interrupt", id: "${runId}", index: 3 \\}\\)`,
        ),
      );
      assert.match(
        pendingText,
        /Once paused, no child process is running\. Then use these exact actions:/,
      );
      assert.doesNotMatch(
        pendingText,
        new RegExp(`${NATIVE_SUPERVISOR_TOOL_NAME}\\(\\{ action: "reply"`),
      );
      assert.doesNotMatch(pendingText, /^- .*No child process is running\./m);
      assert.doesNotMatch(pendingText, /^Reply:/m);
    } finally {
      channel.dispose();
    }
  });

  it("keeps pending blocking requests phase-truthful before the child finishes pausing", async () => {
    const currentSessionId = `session-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    writeRequest({ sessionId: currentSessionId, runId, index: 2 });
    const registeredTools = new Map<
      string,
      {
        execute: (
          _id: string,
          params: { action: "pending" | "status" },
        ) => Promise<NativeSupervisorToolResult>;
      }
    >();
    const sent: Array<{ content?: string; details?: { id?: string } }> = [];
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      sessionManager: {
        getSessionId: () => currentSessionId,
        getSessionFile: () => null,
        getEntries: () => [],
      },
    };
    const state = makeState(currentSessionId, ctx);
    state.asyncJobs.set(runId, {
      asyncId: runId,
      asyncDir: path.join(os.tmpdir(), `${runId}-async`),
      status: "pausing",
      pid: process.pid,
      steps: [
        { agent: "noop", status: "complete" },
        { agent: "noop", status: "complete" },
        { agent: "worker", status: "pausing", pause: { kind: "awaiting_supervisor" } },
      ],
    });
    const pi = {
      getAllTools: () => [...registeredTools.keys()].map((name) => ({ name })),
      registerTool: (tool: {
        name: string;
        execute: (
          _id: string,
          params: { action: "pending" | "status" },
        ) => Promise<NativeSupervisorToolResult>;
      }) => {
        registeredTools.set(tool.name, tool);
      },
      sendMessage: (message: { content?: string; details?: { id?: string } }) => {
        sent.push(message);
      },
      getSessionName: () => "shared-name",
    };
    const channel = createNativeSupervisorChannel(pi as never, state);

    try {
      channel.start();
      const visible = sent[0]?.content ?? "";
      assert.match(visible, /Child 2 has a blocking request entering durable pause\./);
      assert.match(
        visible,
        /Blocking request is entering durable pause; wait until subagent status reports paused\./,
      );
      assert.match(
        visible,
        /Once paused, no child process is running\. Then use these exact actions:/,
      );
      assert.match(visible, /When paused: Resume unchanged: subagent/);
      assert.match(visible, /When paused: Resume with guidance: subagent/);
      assert.match(visible, /When paused: Cancel: subagent/);
      assert.doesNotMatch(visible, /^No child process is running\./m);
      assert.doesNotMatch(visible, /is durably paused awaiting supervisor guidance/);

      const pendingResult = await registeredTools
        .get(NATIVE_SUPERVISOR_TOOL_NAME)!
        .execute("pending", { action: "pending" });
      const pendingText = pendingResult.content[0]!.text;
      assert.match(
        pendingText,
        /Blocking request is entering durable pause; wait until subagent status reports paused\./,
      );
      assert.match(
        pendingText,
        /Once paused, no child process is running\. Then use these exact actions:/,
      );
      assert.match(pendingText, /When paused: Resume unchanged: subagent/);
      assert.doesNotMatch(pendingText, /is durably paused awaiting supervisor guidance/);
      assert.doesNotMatch(pendingText, /^- .*No child process is running\./m);
    } finally {
      channel.dispose();
    }
  });

  it("keeps durably paused requests pending across refresh and timeout", async () => {
    const currentSessionId = `session-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    const requestId = writeRequest({
      sessionId: currentSessionId,
      runId,
      expiresAt: Date.now() - 1,
    });
    const createPi = () => {
      const registeredTools = new Map<
        string,
        {
          execute: (
            _id: string,
            params: { action: "pending" | "status" },
          ) => Promise<NativeSupervisorToolResult>;
        }
      >();
      const sent: Array<{ content?: string; details?: { id?: string } }> = [];
      return {
        registeredTools,
        sent,
        pi: {
          getAllTools: () => [...registeredTools.keys()].map((name) => ({ name })),
          registerTool: (tool: {
            name: string;
            execute: (
              _id: string,
              params: { action: "pending" | "status" },
            ) => Promise<NativeSupervisorToolResult>;
          }) => {
            registeredTools.set(tool.name, tool);
          },
          sendMessage: (message: { content?: string; details?: { id?: string } }) => {
            sent.push(message);
          },
          getSessionName: () => "shared-name",
        },
      };
    };
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      sessionManager: {
        getSessionId: () => currentSessionId,
        getSessionFile: () => null,
        getEntries: () => [],
      },
    };
    const state = makeState(currentSessionId, ctx);
    state.asyncJobs.set(runId, {
      asyncId: runId,
      asyncDir: path.join(os.tmpdir(), `${runId}-paused`),
      status: "paused",
      steps: [{ agent: "worker", status: "paused", pause: { kind: "awaiting_supervisor" } }],
    });

    const first = createPi();
    const channel = createNativeSupervisorChannel(first.pi as never, state);
    channel.start();
    assert.deepEqual(
      first.sent.map((message) => message.details?.id),
      [requestId],
    );
    assert.equal(channel.pending.has(requestId), true);
    const firstPending = await first.registeredTools
      .get(NATIVE_SUPERVISOR_TOOL_NAME)!
      .execute("pending", { action: "pending" });
    assert.match(firstPending.content[0]!.text, /No child process is running\./);
    assert.equal(fs.existsSync(requestFile(runId, requestId)), true);
    channel.dispose();

    const second = createPi();
    const refreshedChannel = createNativeSupervisorChannel(second.pi as never, state);
    try {
      refreshedChannel.start();
      assert.deepEqual(
        second.sent.map((message) => message.details?.id),
        [requestId],
      );
      const refreshedPending = await second.registeredTools
        .get(NATIVE_SUPERVISOR_TOOL_NAME)!
        .execute("pending", { action: "pending" });
      assert.match(
        refreshedPending.content[0]!.text,
        new RegExp(
          `Resume unchanged: subagent\\(\\{ action: "resume", id: "${runId}", index: 0 \\}\\)`,
        ),
      );
      assert.equal(fs.existsSync(requestFile(runId, requestId)), true);
    } finally {
      refreshedChannel.dispose();
    }
  });

  it("refreshes pending requests before listing", async () => {
    const currentSessionId = `session-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    const requestId = writeRequest({ sessionId: currentSessionId, runId });
    const registeredTools = new Map<
      string,
      {
        execute: (
          _id: string,
          params: { action: "pending" | "status" },
        ) => Promise<NativeSupervisorToolResult>;
      }
    >();
    const sent: Array<{ details?: { id?: string } }> = [];
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      sessionManager: {
        getSessionId: () => currentSessionId,
        getSessionFile: () => null,
        getEntries: () => [],
      },
    };
    const pi = {
      getAllTools: () => [...registeredTools.keys()].map((name) => ({ name })),
      registerTool: (tool: {
        name: string;
        execute: (
          _id: string,
          params: { action: "pending" | "status" },
        ) => Promise<NativeSupervisorToolResult>;
      }) => {
        registeredTools.set(tool.name, tool);
      },
      sendMessage: (message: { details?: { id?: string } }) => {
        sent.push(message);
      },
      getSessionName: () => "shared-name",
    };
    const channel = createNativeSupervisorChannel(pi as never, makeState(currentSessionId, ctx));

    try {
      channel.start();
      assert.deepEqual(
        sent.map((message) => message.details?.id),
        [requestId],
      );
      assert.equal(channel.pending.has(requestId), true);

      fs.rmSync(requestFile(runId, requestId), { force: true });
      const pendingResult = await registeredTools
        .get(NATIVE_SUPERVISOR_TOOL_NAME)!
        .execute("pending", { action: "pending" });

      assert.match(pendingResult.content[0]!.text, /No pending supervisor requests/);
      assert.deepEqual(pendingResult.details?.pending, []);
      assert.equal(channel.pending.has(requestId), false);
    } finally {
      channel.dispose();
    }
  });

  it("registers only contact_supervisor for child supervisor coordination", () => {
    const registeredTools = new Map<string, { name: string; description?: string }>();
    const runId = `run-${randomUUID()}`;
    const channelDir = resolveSupervisorChannelDir(runId, "worker", 0);
    createdChannels.push(channelDir);
    const pi = {
      getAllTools: () => [...registeredTools.keys()].map((name) => ({ name })),
      registerTool: (tool: { name: string; description?: string }) => {
        registeredTools.set(tool.name, tool);
      },
    };
    process.env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV] = "session-parent";
    process.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV] = channelDir;
    process.env[SUBAGENT_RUN_ID_ENV] = runId;
    process.env[SUBAGENT_CHILD_AGENT_ENV] = "worker";
    process.env[SUBAGENT_CHILD_INDEX_ENV] = "0";
    delete process.env[SUBAGENT_SUPERVISOR_BRIDGE_ENV];
    try {
      registerNativeSupervisorClient(pi as never);
      assert.deepEqual([...registeredTools.keys()], ["contact_supervisor"]);
      assert.match(
        registeredTools.get("contact_supervisor")?.description ?? "",
        /durably pause the child until the parent resumes or cancels it/i,
      );
      assert.match(
        registeredTools.get("contact_supervisor")?.description ?? "",
        /no child process keeps running while paused/i,
      );
    } finally {
      restoreEnv();
    }
  });

  it("does not register native supervision when the child opts out", () => {
    const registeredTools = new Map<string, { name: string }>();
    const runId = `run-${randomUUID()}`;
    const channelDir = resolveSupervisorChannelDir(runId, "worker", 0);
    createdChannels.push(channelDir);
    const pi = {
      getAllTools: () => [...registeredTools.keys()].map((name) => ({ name })),
      registerTool: (tool: { name: string }) => {
        registeredTools.set(tool.name, tool);
      },
    };
    process.env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV] = "session-parent";
    process.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV] = channelDir;
    process.env[SUBAGENT_RUN_ID_ENV] = runId;
    process.env[SUBAGENT_CHILD_AGENT_ENV] = "worker";
    process.env[SUBAGENT_CHILD_INDEX_ENV] = "0";
    process.env[SUBAGENT_SUPERVISOR_BRIDGE_ENV] = "0";

    try {
      registerNativeSupervisorClient(pi as never);
      assert.deepEqual([...registeredTools.keys()], []);
    } finally {
      restoreEnv();
    }
  });

  it("does not override an installed external child intercom", () => {
    const installedIntercom = { name: "intercom", description: "Installed intercom" };
    const registeredTools = new Map<string, { name: string; description?: string }>([
      ["intercom", installedIntercom],
    ]);
    const runId = `run-${randomUUID()}`;
    const channelDir = resolveSupervisorChannelDir(runId, "worker", 0);
    createdChannels.push(channelDir);
    const pi = {
      getAllTools: () => [...registeredTools.keys()].map((name) => ({ name })),
      registerTool: (tool: { name: string; description?: string }) => {
        registeredTools.set(tool.name, tool);
      },
    };
    process.env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV] = "session-parent";
    process.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV] = channelDir;
    process.env[SUBAGENT_RUN_ID_ENV] = runId;
    process.env[SUBAGENT_CHILD_AGENT_ENV] = "worker";
    process.env[SUBAGENT_CHILD_INDEX_ENV] = "0";

    try {
      registerNativeSupervisorClient(pi as never);
      assert.equal(registeredTools.get("intercom"), installedIntercom);
      assert.equal(registeredTools.has("contact_supervisor"), true);
    } finally {
      restoreEnv();
    }
  });

  it("preserves structured interview requests until the blocking wait is cancelled", async () => {
    const runId = `run-${randomUUID()}`;
    const channelDir = resolveSupervisorChannelDir(runId, "worker", 0);
    createdChannels.push(channelDir);
    process.env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV] = "session-parent";
    process.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV] = channelDir;
    process.env[SUBAGENT_RUN_ID_ENV] = runId;
    process.env[SUBAGENT_CHILD_AGENT_ENV] = "worker";
    process.env[SUBAGENT_CHILD_INDEX_ENV] = "0";
    const registeredTools = new Map<
      string,
      {
        execute: (
          _id: string,
          params: { reason: SupervisorReason; message?: string; interview?: unknown },
          signal?: AbortSignal,
        ) => Promise<ContactSupervisorToolResult>;
      }
    >();
    const pi = {
      getAllTools: () => [...registeredTools.keys()].map((name) => ({ name })),
      registerTool: (tool: {
        name: string;
        execute: (
          _id: string,
          params: { reason: SupervisorReason; message?: string; interview?: unknown },
          signal?: AbortSignal,
        ) => Promise<ContactSupervisorToolResult>;
      }) => {
        registeredTools.set(tool.name, tool);
      },
    };
    registerNativeSupervisorClient(pi as never);
    const controller = new AbortController();
    const interview = { questions: [{ id: "choice", prompt: "Choose A or B" }] };
    const resultPromise = registeredTools
      .get("contact_supervisor")!
      .execute(
        "contact",
        { reason: "interview_request", message: "Need structured input", interview },
        controller.signal,
      );

    assert.deepEqual(fs.readdirSync(channelDir), ["requests"]);
    const requestEntries = fs.readdirSync(path.join(channelDir, "requests"));
    assert.equal(requestEntries.length, 1);
    const requestEntry = requestEntries[0];
    assert.ok(requestEntry, "Expected one structured interview request file");
    const parsedRequest: unknown = JSON.parse(
      fs.readFileSync(path.join(channelDir, "requests", requestEntry), "utf-8"),
    );
    const request = parseInterviewRequestFixture(parsedRequest);
    assert.ok(request, "Expected a valid structured interview request");
    assert.equal(request.reason, "interview_request");
    assert.match(
      request.message ?? "",
      /Structured interview response requested\. Once the child is durably paused, resume it with JSON guidance matching the requested interview shape via subagent\(\{ action: "resume"/,
    );
    assert.match(request.message ?? "", /message: "<JSON>"/);
    assert.doesNotMatch(request.message ?? "", /Reply with JSON/);
    assert.equal(request.expectsReply, true);
    assert.equal(typeof request.expiresAt, "number");
    assert.deepEqual(request.interview, interview);

    controller.abort();
    await assert.rejects(resultPromise, /Supervisor request cancelled/);
    assert.deepEqual(fs.readdirSync(path.join(channelDir, "requests")), []);
  });

  it("cleans up a blocking request when its abort-or-timeout wait expires", async () => {
    const runId = `run-${randomUUID()}`;
    const channelDir = resolveSupervisorChannelDir(runId, "worker", 0);
    createdChannels.push(channelDir);
    process.env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV] = "session-parent";
    process.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV] = channelDir;
    process.env[SUBAGENT_RUN_ID_ENV] = runId;
    process.env[SUBAGENT_CHILD_AGENT_ENV] = "worker";
    process.env[SUBAGENT_CHILD_INDEX_ENV] = "0";
    process.env.PI_SUBAGENT_SUPERVISOR_ASK_TIMEOUT_MS = "1";
    const registeredTools = new Map<
      string,
      {
        execute: (
          _id: string,
          params: { reason: SupervisorReason; message?: string },
        ) => Promise<ContactSupervisorToolResult>;
      }
    >();
    const pi = {
      getAllTools: () => [...registeredTools.keys()].map((name) => ({ name })),
      registerTool: (tool: {
        name: string;
        execute: (
          _id: string,
          params: { reason: SupervisorReason; message?: string },
        ) => Promise<ContactSupervisorToolResult>;
      }) => {
        registeredTools.set(tool.name, tool);
      },
    };
    registerNativeSupervisorClient(pi as never);

    await assert.rejects(
      () =>
        registeredTools
          .get("contact_supervisor")!
          .execute("contact", { reason: "need_decision", message: "Need a decision" }),
      /Timed out waiting for supervisor pause or cancellation/,
    );
    assert.deepEqual(fs.readdirSync(path.join(channelDir, "requests")), []);
  });
});

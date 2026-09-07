/** Regression guards for native supervisor and control-notice delivery. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  NATIVE_SUPERVISOR_TOOL_NAME,
  createNativeSupervisorChannel,
  ensureSupervisorChannelDir,
  registerNativeSupervisorClient,
  resolveSupervisorChannelDir,
} from "../../src/supervisor/native-supervisor-channel.ts";
import { handleSubagentControlNotice } from "../../src/extension/control-notices.ts";
import {
  SUBAGENT_CHILD_AGENT_ENV,
  SUBAGENT_CHILD_INDEX_ENV,
  SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
  SUBAGENT_RUN_ID_ENV,
  SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
} from "../../src/runs/shared/pi-args.ts";
import type { ControlEvent, SubagentState } from "../../src/shared/types.ts";

type SupervisorReason = "need_decision" | "interview_request" | "progress_update";

interface ContactSupervisorFixtureParams {
  reason: SupervisorReason;
  message?: string;
  interview?: unknown;
}

interface SupervisorRequestFixtureDetails {
  delivered: boolean;
  requestId: string;
  reason: SupervisorReason;
}

interface PendingSupervisorFixture {
  id: string;
  runId: string;
  agent: string;
  childIndex: number;
  reason: SupervisorReason;
  expectsReply: boolean;
}

type SupervisorChannelFixtureDetails =
  | { active: true; pending: number; root: string }
  | { pending: PendingSupervisorFixture[] };

type SupervisorRequestToolResult = AgentToolResult<SupervisorRequestFixtureDetails>;
type SupervisorChannelToolResult = AgentToolResult<SupervisorChannelFixtureDetails>;

interface RequestFileInspection {
  type: string;
  reason: SupervisorReason;
  expectsReply: boolean;
  runId: string;
}

function parseRequestFileInspection(value: unknown): RequestFileInspection | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const type = Object.getOwnPropertyDescriptor(value, "type")?.value;
  const reason = Object.getOwnPropertyDescriptor(value, "reason")?.value;
  const expectsReply = Object.getOwnPropertyDescriptor(value, "expectsReply")?.value;
  const runId = Object.getOwnPropertyDescriptor(value, "runId")?.value;
  if (
    typeof type !== "string" ||
    (reason !== "need_decision" &&
      reason !== "interview_request" &&
      reason !== "progress_update") ||
    typeof expectsReply !== "boolean" ||
    typeof runId !== "string"
  )
    return undefined;
  return { type, reason, expectsReply, runId };
}

function resultText(result: SupervisorChannelToolResult): string {
  const content = result.content[0];
  return content?.type === "text" ? content.text : "";
}

// ─── env save/restore ────────────────────────────────────────────────────────

const ENV_KEYS = [
  SUBAGENT_CHILD_AGENT_ENV,
  SUBAGENT_CHILD_INDEX_ENV,
  SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
  SUBAGENT_RUN_ID_ENV,
  SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
] as const;

type SavedEnv = Record<(typeof ENV_KEYS)[number], string | undefined>;

function saveEnv(): SavedEnv {
  return Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])) as SavedEnv;
}

function restoreEnv(saved: SavedEnv): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await wait(intervalMs);
  }
}

function makeParentState(sessionId: string | null, ctx: unknown): SubagentState {
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

function makeControlState(): SubagentState {
  return {
    baseCwd: "/tmp/project",
    currentSessionId: null,
    asyncJobs: new Map(),
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

function needsAttentionEvent(overrides: Partial<ControlEvent> = {}): ControlEvent {
  return {
    type: "needs_attention",
    to: "needs_attention",
    ts: 1,
    runId: "run-nointercom-1",
    agent: "worker",
    index: 0,
    message: "worker needs attention",
    reason: "idle",
    ...overrides,
  };
}

// ─── describe ────────────────────────────────────────────────────────────────

describe("no-pi-intercom regression guard", () => {
  // ── (a) contact_supervisor pending/status without intercom ────────────────

  describe("contact_supervisor pending/status with no intercom tool installed", () => {
    let savedEnv: SavedEnv;

    afterEach(() => {
      if (savedEnv) restoreEnv(savedEnv);
    });

    it("surfaces a need_decision request through the native pending/status channel", async () => {
      savedEnv = saveEnv();

      const runId = `run-${randomUUID()}`;
      const agent = "worker";
      const childIndex = 0;
      const orchestratorSessionId = `session-${randomUUID()}`;
      const channelDir = resolveSupervisorChannelDir(runId, agent, childIndex);

      ensureSupervisorChannelDir(channelDir);

      // Wire env so readChildMetadata() resolves
      process.env[SUBAGENT_RUN_ID_ENV] = runId;
      process.env[SUBAGENT_CHILD_AGENT_ENV] = agent;
      process.env[SUBAGENT_CHILD_INDEX_ENV] = String(childIndex);
      process.env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV] = orchestratorSessionId;
      process.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV] = channelDir;

      // Child side starts without any pre-installed tools.
      const childTools = new Map<
        string,
        {
          execute: (
            _id: string,
            params: ContactSupervisorFixtureParams,
            signal?: AbortSignal,
          ) => Promise<SupervisorRequestToolResult>;
        }
      >();
      const childPi = {
        getAllTools: () => [...childTools.keys()].map((name) => ({ name })),
        registerTool: (tool: {
          name: string;
          execute: (
            _id: string,
            params: ContactSupervisorFixtureParams,
            signal?: AbortSignal,
          ) => Promise<SupervisorRequestToolResult>;
        }) => {
          childTools.set(tool.name, tool);
        },
        sendMessage: () => {},
        getSessionName: () => "child-session",
      };

      // Register the native supervisor client.
      registerNativeSupervisorClient(childPi as never);

      assert.deepEqual([...childTools.keys()], ["contact_supervisor"]);

      // Parent side: native supervisor channel scoped to the same orchestrator
      // session id the child env points at.
      const parentTools = new Map<
        string,
        {
          execute: (
            _id: string,
            params: { action: "pending" | "status" },
          ) => Promise<SupervisorChannelToolResult>;
        }
      >();
      const parentCtx = {
        cwd: process.cwd(),
        hasUI: false,
        sessionManager: {
          getSessionId: () => orchestratorSessionId,
          getSessionFile: () => null,
          getEntries: () => [],
        },
      };
      const parentPi = {
        getAllTools: () => [...parentTools.keys()].map((name) => ({ name })),
        registerTool: (tool: {
          name: string;
          execute: (
            _id: string,
            params: { action: "pending" | "status" },
          ) => Promise<SupervisorChannelToolResult>;
        }) => {
          parentTools.set(tool.name, tool);
        },
        sendMessage: () => {},
        getSessionName: () => "parent-session",
      };
      const parentChannel = createNativeSupervisorChannel(
        parentPi as never,
        makeParentState(orchestratorSessionId, parentCtx),
      );

      try {
        parentChannel.start();
        assert.ok(
          parentTools.has(NATIVE_SUPERVISOR_TOOL_NAME),
          "parent subagent_supervisor tool should be registered",
        );

        // Kick off the child-side request in the background.
        const contactSupervisorTool = childTools.get("contact_supervisor")!;
        const controller = new AbortController();
        const resultPromise = contactSupervisorTool.execute(
          "req-id",
          {
            reason: "need_decision",
            message: "Should I proceed with option A?",
          },
          controller.signal,
        );

        // Wait for the request file to appear in the channel dir
        const requestsDir = path.join(channelDir, "requests");
        let requestId: string | undefined;
        await pollUntil(() => {
          const entries = fs.readdirSync(requestsDir).filter((f) => f.endsWith(".json"));
          if (entries.length > 0) {
            requestId = entries[0]!.replace(/\.json$/, "");
            return true;
          }
          return false;
        }, 4000);

        assert.ok(requestId, "Request file should have appeared in the channel dir");

        // Verify the request content
        const requestFile = path.join(requestsDir, `${requestId}.json`);
        const parsedRequest: unknown = JSON.parse(fs.readFileSync(requestFile, "utf-8"));
        const request = parseRequestFileInspection(parsedRequest);
        assert.ok(request, "Request file should contain the native supervisor shape");
        assert.equal(request.type, "subagent.supervisor.request");
        assert.equal(request.reason, "need_decision");
        assert.equal(request.expectsReply, true);
        assert.equal(request.runId, runId);

        // Wait for the parent channel poller to discover the request
        // (new request files are picked up by the poll loop, ≤500ms).
        await pollUntil(
          () => requestId !== undefined && parentChannel.pending.has(requestId),
          4000,
        );

        const status = await parentTools
          .get(NATIVE_SUPERVISOR_TOOL_NAME)!
          .execute("status", { action: "status" });
        assert.match(resultText(status), /Native supervisor channel active/);
        const pending = await parentTools
          .get(NATIVE_SUPERVISOR_TOOL_NAME)!
          .execute("pending", { action: "pending" });
        const pendingRequests = pending.details.pending;
        assert.ok(Array.isArray(pendingRequests));
        assert.deepEqual(
          pendingRequests.map((request) => request.id),
          [requestId],
        );

        // The canonical durable path aborts this live wait before a later resume or interrupt.
        controller.abort();
        await assert.rejects(resultPromise, /Supervisor request cancelled/);
        assert.equal(fs.existsSync(requestFile), false);
        assert.deepEqual(fs.readdirSync(channelDir), ["requests"]);
      } finally {
        parentChannel.dispose();
        fs.rmSync(channelDir, { recursive: true, force: true });
      }
    });
  });

  // ── (b) needs_attention notice delivery ──────────────────────────────────

  describe("needs_attention notice delivery", () => {
    it("delivers notices via pi.sendMessage", () => {
      const state = makeControlState();

      const sent: Array<{ message: unknown; options: unknown }> = [];

      const nudges: Array<{ text: string; options: unknown }> = [];
      const mockPi = {
        sendMessage(message: unknown, options?: unknown) {
          // Delivery goes here — not to the event bus
          sent.push({ message, options });
        },
        sendUserMessage(text: string, options?: unknown) {
          nudges.push({ text, options });
        },
      };

      handleSubagentControlNotice({
        pi: mockPi as never,
        state,
        visibleControlNotices: new Set(),
        details: { source: "async", event: needsAttentionEvent() },
        foregroundDelayMs: 20,
      });

      assert.equal(
        sent.length,
        1,
        `Expected exactly one delivered control notice; got ${sent.length}`,
      );
    });
  });
});

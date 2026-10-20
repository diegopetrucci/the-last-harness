import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ProjectAgentIdentity } from "../../src/agents/project-agent-loader.ts";
import { consumeChildMessageRequests } from "../../src/runs/background/control-channel.ts";
import { resolveProjectAgentExecution } from "../../src/runs/shared/project-agent-control.ts";
import { createSubagentExecutor } from "../../src/extension/subagent-executor.ts";
import type { ProjectAgentAccess } from "../../src/runs/shared/executor-types.ts";
import {
  isEmbeddedOnlyToolCall,
  noteSubagentToolExecutionEnd,
  noteSubagentToolExecutionStart,
  subagentExecutionAccountingSize,
  markEmbeddedOnlyToolCall,
  runBoundToToolCall,
} from "../../../the-last-harness/project-agent-access.mjs";
import { ASYNC_DIR, RESULTS_DIR, type SubagentState } from "../../src/shared/types.ts";
import { writeAsyncArtifactJson as writeJson } from "../support/async-artifact-fixtures.ts";
import { makeAgent, makeMinimalCtx, makeSubagentState } from "../support/helpers.ts";

const OWNER = "OWNER-A";
const NON_OWNER = "NONOWNER-B";

let root: string;
const runIds: string[] = [];

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-")));
  execFileSync("git", ["init", "--quiet", root]);
  const custom = path.join(root, ".tlh", "agents", "custom");
  fs.mkdirSync(custom, { recursive: true });
  fs.writeFileSync(
    path.join(custom, "WORKER.md"),
    "---\nname: worker\npackage: embedded\ndescription: Worker\ntools: read\n---\nPrompt\n",
  );
});

afterEach(() => {
  for (const runId of runIds.splice(0)) {
    fs.rmSync(path.join(ASYNC_DIR, runId), { recursive: true, force: true });
    fs.rmSync(path.join(RESULTS_DIR, `${runId}.json`), { force: true });
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function writeRun(state: "complete" | "running"): string {
  const runId = `project-control-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  runIds.push(runId);
  const asyncDir = path.join(ASYNC_DIR, runId);
  const sessionFile = path.join(asyncDir, "worker.jsonl");
  fs.mkdirSync(asyncDir, { recursive: true });
  fs.writeFileSync(sessionFile, "", "utf-8");
  const projectAgent: ProjectAgentIdentity = { slug: "worker", root, cwd: root };
  writeJson(path.join(asyncDir, "status.json"), {
    runId,
    mode: "single",
    state,
    ...(state === "running" ? { pid: 12345 } : {}),
    sessionId: OWNER,
    cwd: root,
    startedAt: 100,
    lastUpdate: Date.now(),
    sessionFile,
    projectAgents: [projectAgent],
    steps: [
      {
        agent: "embedded.worker",
        status: state,
        startedAt: 100,
        sessionFile,
        cwd: root,
        projectAgent,
      },
    ],
  });
  return runId;
}

function makeExecutor(access: ProjectAgentAccess | undefined, dispatched: string[]) {
  const state: SubagentState = makeSubagentState({ baseCwd: root });
  return createSubagentExecutor({
    pi: { events: { emit() {}, on: () => () => {} }, getSessionName: () => "parent" } as any,
    state,
    config: { maxSubagentDepth: 2, control: {} } as any,
    tempArtifactsDir: root,
    getSubagentSessionRoot: () => path.join(root, "sessions"),
    expandTilde: (value) => value,
    discoverAgents: () => ({ agents: [makeAgent("code-reviewer")] }),
    getProjectAgentAccess: () => access,
    kill: () => true,
    executeAsyncSingle: ((runId: string) => {
      dispatched.push(runId);
      return {
        content: [{ type: "text", text: "dispatched" }],
        details: { mode: "single", results: [], asyncId: runId },
      };
    }) as any,
  });
}

function ctxFor(sessionId: string, cwd = root) {
  const ctx = makeMinimalCtx(cwd);
  (ctx.sessionManager as any).getSessionId = () => sessionId;
  (ctx.sessionManager as any).getSessionFile = () => null;
  return ctx;
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

const trustedAccess = (overrides: Partial<ProjectAgentAccess> = {}): ProjectAgentAccess => ({
  architect: false,
  canManage: true,
  canInitiate: true,
  trustStore: { getEntry: (cwd) => ({ path: cwd, decision: true }) },
  ...overrides,
});

async function run(
  executor: ReturnType<typeof makeExecutor>,
  params: Record<string, unknown>,
  sessionId: string,
  toolCallId = "control",
) {
  return executor.execute(
    toolCallId,
    params as any,
    new AbortController().signal,
    undefined,
    ctxFor(sessionId),
  );
}

describe("persisted project-agent control authorization", () => {
  it("rejects durable embedded revival from a foreign session and allows the owner", async () => {
    const runId = writeRun("complete");
    const dispatched: string[] = [];
    const executor = makeExecutor(trustedAccess(), dispatched);

    const foreign = await run(
      executor,
      { action: "resume", id: runId, message: "Continue." },
      NON_OWNER,
    );
    assert.equal(foreign.isError, true);
    assert.match(text(foreign), /owned by another session/);
    assert.deepEqual(dispatched, []);

    const owner = await run(executor, { action: "resume", id: runId, message: "Continue." }, OWNER);
    assert.equal(owner.isError, undefined, text(owner));
    assert.equal(dispatched.length, 1);
  });

  it("lets an enabled primary steer a live embedded run and queues the request", async () => {
    const runId = writeRun("running");
    const executor = makeExecutor(trustedAccess(), []);
    const result = await run(executor, { action: "steer", id: runId, message: "Focus." }, OWNER);
    assert.equal(result.isError, undefined, text(result));
    const requests = consumeChildMessageRequests(path.join(ASYNC_DIR, runId));
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.message, "Focus.");
  });

  it("rejects embedded resume and steer in disabled mode before dispatch or queueing", async () => {
    const disabled = trustedAccess({ canManage: false, canInitiate: true });
    const dispatched: string[] = [];
    const completeId = writeRun("complete");
    const runningId = writeRun("running");
    const executor = makeExecutor(disabled, dispatched);

    const resume = await run(
      executor,
      { action: "resume", id: completeId, message: "Continue." },
      OWNER,
    );
    assert.equal(resume.isError, true);
    assert.match(text(resume), /cannot manage project-agent runs/);
    assert.deepEqual(dispatched, []);

    const steer = await run(executor, { action: "steer", id: runningId, message: "Focus." }, OWNER);
    assert.equal(steer.isError, true);
    assert.match(text(steer), /cannot manage project-agent runs/);
    assert.deepEqual(consumeChildMessageRequests(path.join(ASYNC_DIR, runningId)), []);
  });

  it("lets disabled mode initiate an authorized target", async () => {
    const access = trustedAccess({ canManage: false, canInitiate: true });
    const resolution = await resolveProjectAgentExecution(
      { agent: "embedded.worker", task: "go" },
      root,
      "both",
      OWNER,
      { discoverAgents: () => ({ agents: [] }), getProjectAgentAccess: () => access } as any,
    );
    assert.ok(!("error" in resolution), "error" in resolution ? resolution.error : "");
    assert.equal(resolution.projectAgentIdentities?.[0]?.slug, "worker");
  });

  it("rejects initiation without canInitiate", async () => {
    const dispatched: string[] = [];
    const denied = await run(
      makeExecutor(trustedAccess({ canManage: false, canInitiate: false }), dispatched),
      { agent: "embedded.worker", task: "go", agentScope: "both" },
      OWNER,
    );
    assert.equal(denied.isError, true);
    assert.match(text(denied), /not authorized for the current primary-agent mode/);
    assert.deepEqual(dispatched, []);
  });

  it("rejects outside-Git, nonexistent, and symlink-escape cwd before dispatch", async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tlh-outside-")));
    const escape = path.join(root, "escape");
    fs.symlinkSync(outside, escape);
    try {
      for (const cwd of [outside, path.join(root, "missing"), escape]) {
        const dispatched: string[] = [];
        const result = await run(
          makeExecutor(trustedAccess(), dispatched),
          { agent: "embedded.worker", task: "go", cwd },
          OWNER,
        );
        assert.equal(result.isError, true, cwd);
        assert.deepEqual(dispatched, [], cwd);
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

const RUSH_RESUME = "RUSH-RESUME-RESTRICTED";
const RUSH_STEER = "RUSH-STEER-RESTRICTED";
const rushAccess = () =>
  trustedAccess({
    controlRestrictedToEmbedded: true,
    resumeRestrictionReason: RUSH_RESUME,
    steerRestrictionReason: RUSH_STEER,
  });

function writeRunWith(options: {
  state: "complete" | "running";
  steps: Array<{ agent: string; [key: string]: unknown }>;
  results?: Array<{ agent: string; [key: string]: unknown }>;
}): string {
  const runId = `project-control-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  runIds.push(runId);
  const asyncDir = path.join(ASYNC_DIR, runId);
  const sessionFile = path.join(asyncDir, "child.jsonl");
  fs.mkdirSync(asyncDir, { recursive: true });
  fs.writeFileSync(sessionFile, "", "utf-8");
  const stamp = (child: { agent: string; [key: string]: unknown }) => ({
    status: options.state,
    startedAt: 100,
    sessionFile,
    cwd: root,
    ...child,
  });
  writeJson(path.join(asyncDir, "status.json"), {
    runId,
    mode: "parallel",
    state: options.state,
    ...(options.state === "running" ? { pid: 12345 } : {}),
    sessionId: OWNER,
    cwd: root,
    startedAt: 100,
    lastUpdate: Date.now(),
    sessionFile,
    steps: options.steps.map(stamp),
  });
  if (options.results) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    writeJson(path.join(RESULTS_DIR, `${runId}.json`), {
      id: runId,
      runId,
      agent: options.results[0]?.agent ?? "developer",
      success: true,
      mode: "parallel",
      state: options.state,
      cwd: root,
      sessionId: OWNER,
      results: options.results.map((child) => ({
        sessionFile,
        cwd: root,
        success: true,
        ...child,
      })),
    });
  }
  return runId;
}

const embeddedChild = (extra: Record<string, unknown> = {}) => ({
  agent: "embedded.worker",
  projectAgent: { slug: "worker", root, cwd: root },
  ...extra,
});
const ordinaryChild = { agent: "code-reviewer" };

describe("restricted (Rush) resume/steer is enforced by the executor", () => {
  const expectBlocked = async (
    action: "resume" | "steer",
    runId: string,
    extra: Record<string, unknown> = {},
    anyRejection = false,
  ) => {
    const dispatched: string[] = [];
    const executor = makeExecutor(rushAccess(), dispatched);
    const result = await run(executor, { action, id: runId, message: "Go.", ...extra }, OWNER);
    assert.equal(result.isError, true, text(result));
    if (!anyRejection) assert.equal(text(result), action === "resume" ? RUSH_RESUME : RUSH_STEER);
    assert.deepEqual(dispatched, []);
    assert.deepEqual(consumeChildMessageRequests(path.join(ASYNC_DIR, runId)), []);
  };
  const expectAllowed = async (
    action: "resume" | "steer",
    runId: string,
    extra: Record<string, unknown> = {},
  ) => {
    const dispatched: string[] = [];
    const executor = makeExecutor(rushAccess(), dispatched);
    const result = await run(executor, { action, id: runId, message: "Go.", ...extra }, OWNER);
    assert.equal(result.isError, undefined, text(result));
    if (action === "resume") assert.equal(dispatched.length, 1);
    else assert.equal(consumeChildMessageRequests(path.join(ASYNC_DIR, runId)).length, 1);
  };
  const stateFor = (action: "resume" | "steer") => (action === "resume" ? "complete" : "running");

  for (const action of ["resume", "steer"] as const) {
    const state = stateFor(action);

    it(`${action}: blocks an ordinary run`, async () => {
      await expectBlocked(action, writeRunWith({ state, steps: [ordinaryChild] }));
    });

    it(`${action}: mixed run blocks an ordinary index and allows the embedded index`, async () => {
      const steps = [ordinaryChild, embeddedChild()];
      await expectBlocked(action, writeRunWith({ state, steps }), { index: 0 });
      await expectAllowed(action, writeRunWith({ state, steps }), { index: 1 });
    });

    it(`${action}: blocks null and ordinary-agent-with-marker identities`, async () => {
      for (const child of [
        { agent: "embedded.worker" },
        { agent: "developer", projectAgent: { slug: "worker", root, cwd: root } },
        { agent: "embedded.worker", projectAgent: { slug: "other", root, cwd: root } },
      ]) {
        await expectBlocked(action, writeRunWith({ state, steps: [child] }));
      }
    });

    it(`${action}: rejects a null identity marker before dispatch or queueing`, async () => {
      const steps = [{ agent: "embedded.worker", projectAgent: null }];
      await expectBlocked(action, writeRunWith({ state, steps }), {}, true);
    });

    it(`${action}: allows a valid embedded child`, async () => {
      await expectAllowed(action, writeRunWith({ state, steps: [embeddedChild()] }));
    });
  }

  it("steer: unindexed steer on a mixed run is blocked unless every target is embedded", async () => {
    await expectBlocked(
      "steer",
      writeRunWith({ state: "running", steps: [ordinaryChild, embeddedChild()] }),
    );
    await expectAllowed(
      "steer",
      writeRunWith({ state: "running", steps: [embeddedChild(), embeddedChild()] }),
    );
  });

  it("resume: blocks when status and result records disagree about the child", async () => {
    // status says embedded, result says ordinary (and vice versa)
    await expectBlocked(
      "resume",
      writeRunWith({ state: "complete", steps: [embeddedChild()], results: [ordinaryChild] }),
    );
    await expectBlocked(
      "resume",
      writeRunWith({
        state: "complete",
        steps: [ordinaryChild],
        results: [embeddedChild()],
      }),
    );
    await expectBlocked(
      "resume",
      writeRunWith({
        state: "complete",
        steps: [{ agent: "embedded.worker" }],
        results: [embeddedChild()],
      }),
    );
  });

  it("resume: allows consistent status and result records for an embedded child", async () => {
    await expectAllowed(
      "resume",
      writeRunWith({ state: "complete", steps: [embeddedChild()], results: [embeddedChild()] }),
    );
  });

  describe("fails closed when the access bridge is present but broken", () => {
    for (const action of ["resume", "steer"] as const) {
      const state = action === "resume" ? "complete" : "running";
      const execWith = async (access: unknown, runId: string) => {
        const dispatched: string[] = [];
        const executor = makeExecutor(access as any, dispatched);
        const result = await run(executor, { action, id: runId, message: "Go." }, OWNER);
        return { result, dispatched, runId };
      };

      it(`${action}: malformed-but-restricted access rejects ordinary and embedded targets`, async () => {
        const malformed = { controlRestrictedToEmbedded: true, canManage: "invalid" };
        for (const steps of [[ordinaryChild], [embeddedChild()]]) {
          const { result, dispatched, runId } = await execWith(
            malformed,
            writeRunWith({ state, steps }),
          );
          assert.equal(result.isError, true, text(result));
          assert.deepEqual(dispatched, []);
          assert.deepEqual(consumeChildMessageRequests(path.join(ASYNC_DIR, runId)), []);
        }
      });

      it(`${action}: a throwing provider rejects an ordinary target`, async () => {
        const dispatched: string[] = [];
        const throwing = createSubagentExecutor({
          pi: { events: { emit() {}, on: () => () => {} }, getSessionName: () => "parent" } as any,
          state: makeSubagentState({ baseCwd: root }),
          config: { maxSubagentDepth: 2, control: {} } as any,
          tempArtifactsDir: root,
          getSubagentSessionRoot: () => path.join(root, "sessions"),
          expandTilde: (value) => value,
          discoverAgents: () => ({ agents: [makeAgent("code-reviewer")] }),
          getProjectAgentAccess: () => {
            throw new Error("bridge broken");
          },
          kill: () => true,
          executeAsyncSingle: ((runId: string) => {
            dispatched.push(runId);
            return { content: [{ type: "text", text: "dispatched" }], details: {} };
          }) as any,
        });
        const runId = writeRunWith({ state, steps: [ordinaryChild] });
        const result = await run(throwing, { action, id: runId, message: "Go." }, OWNER);
        assert.equal(result.isError, true, text(result));
        assert.deepEqual(dispatched, []);
        assert.deepEqual(consumeChildMessageRequests(path.join(ASYNC_DIR, runId)), []);
      });
    }
  });
});

describe("invocation-bound embedded-only restriction", () => {
  const unrestricted: Array<[string, ProjectAgentAccess | undefined]> = [
    ["architect selection", trustedAccess({ architect: true })],
    ["provider removed", undefined],
    ["legacy {architect:true}", { architect: true } as any],
  ];
  // run() executes with toolCallId "control": mark it as the hook would have.
  // tool_execution_end (the sole release) follows the call.
  const marked = async (fn: () => Promise<any>) => {
    assert.equal(markEmbeddedOnlyToolCall("control"), true);
    try {
      return await fn();
    } finally {
      noteSubagentToolExecutionEnd("control");
    }
  };

  for (const action of ["resume", "steer"] as const) {
    const state = action === "resume" ? "complete" : "running";
    for (const [label, access] of unrestricted) {
      it(`${action}: a marked call stays embedded-only when the executor sees ${label}`, async () => {
        const dispatched: string[] = [];
        const executor = makeExecutor(access, dispatched);
        const ordinary = writeRunWith({ state, steps: [ordinaryChild] });
        const blocked = await marked(() =>
          run(executor, { action, id: ordinary, message: "Go." }, OWNER),
        );
        assert.equal(blocked.isError, true, text(blocked));
        assert.deepEqual(dispatched, []);
        assert.deepEqual(consumeChildMessageRequests(path.join(ASYNC_DIR, ordinary)), []);
        if (!access?.trustStore) return; // embedded authorization needs a trust store
        const embedded = writeRunWith({ state, steps: [embeddedChild()] });
        const allowed = await marked(() =>
          run(executor, { action, id: embedded, message: "Go." }, OWNER),
        );
        assert.equal(allowed.isError, undefined, text(allowed));
      });
    }

    it(`${action}: an unmarked architect call is unaffected and marks are cleared after the call`, async () => {
      const dispatched: string[] = [];
      const executor = makeExecutor(trustedAccess({ architect: true }), dispatched);
      const ordinary = writeRunWith({ state, steps: [ordinaryChild] });
      const free = await run(executor, { action, id: ordinary, message: "Go." }, OWNER);
      assert.equal(free.isError, undefined, text(free));

      await marked(() => run(executor, { action, id: "missing-run-1", message: "x" }, OWNER));
      assert.equal(isEmbeddedOnlyToolCall("control"), false);
    });
  }

  it("does not release marks when the bound call settles, even on error", async () => {
    markEmbeddedOnlyToolCall("err-id");
    await assert.rejects(
      runBoundToToolCall("err-id", async () => {
        throw new Error("boom");
      }),
    );
    assert.equal(isEmbeddedOnlyToolCall("err-id"), true);
    noteSubagentToolExecutionEnd("err-id");
    assert.equal(isEmbeddedOnlyToolCall("err-id"), false);
  });

  it("start/end accounting: duplicate ids clear only when every started execution ended", async () => {
    const dispatched: string[] = [];
    const executor = makeExecutor(trustedAccess({ architect: true }), dispatched);
    const ordinary = writeRunWith({ state: "complete", steps: [ordinaryChild] });
    noteSubagentToolExecutionStart("dup");
    noteSubagentToolExecutionStart("dup");
    assert.equal(markEmbeddedOnlyToolCall("dup"), true);
    try {
      for (let i = 0; i < 2; i++) {
        const blocked = await run(
          executor,
          { action: "resume", id: ordinary, message: "Go." },
          OWNER,
          "dup",
        );
        assert.equal(blocked.isError, true, text(blocked));
        noteSubagentToolExecutionEnd("dup"); // one tool_execution_end per call
        assert.equal(isEmbeddedOnlyToolCall("dup"), i === 0, `after end ${i + 1}`);
      }
      assert.equal(subagentExecutionAccountingSize(), 0, "all state for the id is deleted");
      noteSubagentToolExecutionEnd("dup"); // stray end is a no-op
      assert.equal(subagentExecutionAccountingSize(), 0);
      assert.deepEqual(dispatched, []);
    } finally {
      noteSubagentToolExecutionEnd("dup");
      noteSubagentToolExecutionEnd("dup");
    }
    // Registry is empty again: a full 256 marks fit.
    const ids = Array.from({ length: 256 }, (_, i) => `empty-${i}`);
    try {
      for (const id of ids) assert.equal(markEmbeddedOnlyToolCall(id), true);
    } finally {
      for (const id of ids) noteSubagentToolExecutionEnd(id);
    }
    assert.equal(subagentExecutionAccountingSize(), 0);
  });

  it("bounds the registry without evicting outstanding marks, and recovers", async () => {
    // 256 outstanding marks = full registry; the executor runs under the OLDEST one.
    const ids = Array.from({ length: 256 }, (_, i) => `cap-${i}`);
    try {
      for (const id of ids) assert.equal(markEmbeddedOnlyToolCall(id), true);
      // Overflow fails closed for a new id; re-marking a marked id is a no-op.
      assert.equal(markEmbeddedOnlyToolCall("cap-over"), false);
      assert.equal(markEmbeddedOnlyToolCall("cap-0"), true);
      assert.equal(isEmbeddedOnlyToolCall("cap-over"), false);
      assert.equal(isEmbeddedOnlyToolCall("cap-0"), true);
      // Even after the provider changes, the oldest outstanding mark still restricts.
      const dispatched: string[] = [];
      const executor = makeExecutor(trustedAccess({ architect: true }), dispatched);
      const ordinary = writeRunWith({ state: "complete", steps: [ordinaryChild] });
      const blocked = await run(
        executor,
        { action: "resume", id: ordinary, message: "Go." },
        OWNER,
        "cap-0",
      );
      assert.equal(blocked.isError, true, text(blocked));
      assert.deepEqual(dispatched, []);
      // Its end frees capacity.
      noteSubagentToolExecutionEnd("cap-0");
      assert.equal(isEmbeddedOnlyToolCall("cap-0"), false);
      assert.equal(markEmbeddedOnlyToolCall("cap-over"), true);
    } finally {
      for (const id of [...ids, "cap-over"]) noteSubagentToolExecutionEnd(id);
    }
    assert.equal(markEmbeddedOnlyToolCall(undefined), false);
  });
});

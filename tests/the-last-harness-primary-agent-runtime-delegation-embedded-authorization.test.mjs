import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import test from "node:test";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

import { releaseWorkspaceReservationsForRun } from "../extensions/subagents/src/runs/shared/workspace-reservation.ts";
import { createSubagentExecutor } from "../extensions/subagents/src/extension/subagent-executor.ts";
import {
  ASYNC_DIR,
  RESULTS_DIR,
  TEMP_ARTIFACTS_DIR,
  TEMP_ROOT_DIR,
} from "../extensions/subagents/src/shared/types.ts";
import {
  makeAgent,
  makeMinimalCtx,
  makeSubagentState,
} from "../extensions/subagents/test/support/helpers.ts";
import {
  getTlhProjectAgentAccess,
  setTlhProjectAgentAccessProvider,
  isEmbeddedOnlyToolCall,
  markEmbeddedOnlyToolCall,
  noteSubagentToolExecutionEnd,
  subagentExecutionAccountingSize,
  runBoundToToolCall,
  isCurrentInvocationEmbeddedOnly,
} from "../extensions/the-last-harness/project-agent-access.mjs";

import { PRIMARY_AGENT_SESSION_STATE_ENTRY } from "../extensions/the-last-harness-primary-agent.mjs";
import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";
import {
  registerRuntimeHarness,
  createToolCallContext,
  selectablePrimaryAgents,
  EMBEDDED_SUBAGENTS_FEATURE,
} from "./the-last-harness-primary-agent-runtime-test-helpers.mjs";

// ─── Embedded subagents (ts-42p1) ───────────────────────────────────────────

function writeEmbeddedAgent(agentDir, relativePath, frontmatter) {
  if (agentDir.endsWith(`${sep}agent`)) {
    const repoRoot = join(dirname(agentDir), "workspace");
    if (!existsSync(join(repoRoot, ".git"))) {
      execFileSync("git", ["init", "--quiet"], { cwd: repoRoot });
    }
    new ProjectTrustStore(agentDir).set(repoRoot, true);
    const filePath = join(repoRoot, ".tlh", "agents", "custom", basenameUpper(relativePath));
    mkdirSync(dirname(filePath), { recursive: true });
    const definition = frontmatter.includes("\ntools:")
      ? frontmatter
      : frontmatter.replace(/\n---\s*$/u, "\ntools: read\n---");
    writeFileSync(filePath, `${definition}\nbody\n`);
    return filePath;
  }
  const filePath = join(agentDir, "agents", relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  const definition = frontmatter.includes("\ntools:")
    ? frontmatter
    : frontmatter.replace(/\n---\s*$/u, "\ntools: read\n---");
  writeFileSync(filePath, `${definition}\nbody\n`);
  return filePath;
}

function basenameUpper(relativePath) {
  const name = relativePath.split(/[\\\\/]/).at(-1) ?? relativePath;
  return name.endsWith(".md") ? `${name.slice(0, -3).toUpperCase()}.md` : name.toUpperCase();
}

test("embedded subagents: disabled mode preserves the default user scope", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeEmbeddedAgent(
      fixture.agent,
      "trusted/my-tool.md",
      "---\nname: my-tool\npackage: embedded\ndescription: Trusted helper\n---",
    );
    const { applySessionStart, toolCall } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata: [],
    });
    const ctx = createToolCallContext(
      [
        {
          type: "custom",
          customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
          data: { selected: "disabled" },
        },
      ],
      undefined,
      { cwd: fixture.cwd },
    );
    await applySessionStart(ctx);

    const allowedEvent = {
      toolName: "subagent",
      input: { agent: "embedded.my-tool", task: "do something" },
    };
    assert.equal(await toolCall(allowedEvent, ctx), undefined);
    assert.equal(allowedEvent.input.agentScope, "user");
    assert.equal(Object.hasOwn(allowedEvent.input, "context"), false);

    // Definition loading and fail-closed authorization happen in the executor;
    // the primary hook must not claim a project scope for the target.
    const deferredEvent = {
      toolName: "subagent",
      input: { agent: "embedded.missing-tool", task: "deferred to executor" },
    };
    assert.equal(await toolCall(deferredEvent, ctx), undefined);
  });
});

test("embedded subagents: architect preserves the requested user scope", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeEmbeddedAgent(
      fixture.agent,
      "trusted/my-tool.md",
      "---\nname: my-tool\npackage: embedded\ndescription: Trusted helper\n---",
    );
    const { applySessionStart, toolCall } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata: [],
    });
    const ctx = createToolCallContext(
      [
        {
          type: "custom",
          customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
          data: { selected: "architect" },
        },
      ],
      undefined,
      { cwd: fixture.cwd },
    );
    // Embedded loading and authorization happen in the executor. The primary
    // hook preserves the caller's requested scope for mixed dispatches.
    await applySessionStart(ctx);

    for (const input of [
      { agent: "embedded.my-tool", task: "do something", agentScope: "user" },
      { tasks: [{ agent: "embedded.my-tool", task: "step 1" }], agentScope: "user" },
    ]) {
      const result = await toolCall({ toolName: "subagent", input }, ctx);
      assert.equal(
        result,
        undefined,
        `authorized target should be allowed: ${JSON.stringify(input)}`,
      );
      assert.equal(input.agentScope, "user");
      assert.equal(Object.hasOwn(input, "context"), false);
    }
  });
});

test("embedded subagents: architect injects the current OpenRouter session model over frontmatter", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const sessionModel = { provider: "openrouter", id: "openai/gpt-5.4" };

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeEmbeddedAgent(
      fixture.agent,
      "trusted/my-tool.md",
      "---\nname: my-tool\npackage: embedded\ndescription: Trusted helper\nmodel: anthropic/claude-sonnet-4-6\n---",
    );
    const { applySessionStart, toolCall } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata: [],
    });
    const ctx = createToolCallContext(
      [
        {
          type: "custom",
          customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
          data: { selected: "architect" },
        },
      ],
      undefined,
      {
        cwd: fixture.cwd,
        model: sessionModel,
        modelRegistry: { getAvailable: () => [sessionModel] },
      },
    );
    await applySessionStart(ctx);

    const inheritedEvent = {
      toolName: "subagent",
      input: { agent: "embedded.my-tool", task: "use the current session model" },
    };
    assert.equal(await toolCall(inheritedEvent, ctx), undefined);
    assert.equal(inheritedEvent.input.model, "openrouter/openai/gpt-5.4");

    const explicitEvent = {
      toolName: "subagent",
      input: {
        agent: "embedded.my-tool",
        task: "use the caller-selected model",
        model: "anthropic/claude-opus-5",
      },
    };
    assert.equal(await toolCall(explicitEvent, ctx), undefined);
    assert.equal(explicitEvent.input.model, "anthropic/claude-opus-5");
  });
});

test("embedded subagents: every enabled primary may dispatch authorized targets regardless of stale settings", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
    );
    writeEmbeddedAgent(
      fixture.agent,
      "trusted/my-tool.md",
      "---\nname: my-tool\npackage: embedded\ndescription: Trusted helper\n---",
    );
    for (const selected of ["architect", "rush", "product", "bug-hunter"]) {
      const { applySessionStart, toolCall } = registerRuntimeHarness({
        primaryAgents: selectablePrimaryAgents(),
        subagentMetadata: [],
      });
      const ctx = createToolCallContext(
        [{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected } }],
        undefined,
        { cwd: fixture.cwd },
      );
      await applySessionStart(ctx);

      for (const input of [
        { agent: "embedded.my-tool", task: "do something" },
        { tasks: [{ agent: "embedded.my-tool", task: "do something in parallel" }] },
      ]) {
        const result = await toolCall({ toolName: "subagent", input }, ctx);
        assert.equal(result, undefined, `${selected} should dispatch authorized embedded targets`);
        assert.equal(input.agentScope, "user");
      }
    }
  });
});

test("embedded subagents: rush blocks embedded targets with rush-specific reason; management actions exempt", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
    );
    writeEmbeddedAgent(
      fixture.agent,
      "trusted/my-tool.md",
      "---\nname: my-tool\npackage: embedded\ndescription: Trusted helper\n---",
    );
    const { applySessionStart, toolCall } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata: [],
    });
    const ctx = createToolCallContext(
      [
        {
          type: "custom",
          customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
          data: { selected: "rush" },
        },
      ],
      undefined,
      { cwd: fixture.cwd },
    );
    await applySessionStart(ctx);

    const embeddedEvent = {
      toolName: "subagent",
      input: { agent: "embedded.my-tool", task: "do something" },
    };
    const result = await toolCall(embeddedEvent, ctx);
    assert.equal(result, undefined);
    assert.equal(embeddedEvent.input.agentScope, "user");

    const { owner, writeRun } = rushRunFixture(t, fixture);
    const { call } = rushExecutorCaller({ fixture, owner, toolCall, hookCtx: ctx });
    const resumeResult = await call({
      action: "resume",
      id: writeRun("complete", [{ agent: "developer" }]),
      message: "Continue.",
    });
    assert.equal(resumeResult.isError, true);
    assert.match(resumeResult.content[0]?.text ?? "", /Rush may not use subagent action=resume/i);

    const listEvent = { toolName: "subagent", input: { action: "list" } };
    assert.equal(await toolCall(listEvent, ctx), undefined);
  });
});

function rushRunFixture(t, fixture) {
  const owner = "rush-owner-session";
  const realCwd = realpathSync(fixture.cwd);
  const embeddedStep = {
    agent: "embedded.my-tool",
    projectAgent: { slug: "my-tool", root: realCwd, cwd: realCwd },
  };
  const runIds = [];
  const writeRun = (state, steps) => {
    const runId = `rush-e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    runIds.push(runId);
    const dir = join(ASYNC_DIR, runId);
    mkdirSync(dir, { recursive: true });
    const sessionFile = join(dir, "child.jsonl");
    writeFileSync(sessionFile, "");
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({
        runId,
        mode: "chain",
        state,
        ...(state === "running" ? { pid: 12345 } : {}),
        sessionId: owner,
        cwd: realCwd,
        startedAt: 100,
        lastUpdate: Date.now(),
        sessionFile,
        steps: steps.map((step) => ({
          status: state,
          startedAt: 100,
          sessionFile,
          cwd: realCwd,
          ...step,
        })),
      }),
    );
    return runId;
  };
  t.after(() => {
    for (const runId of runIds) rmSync(join(ASYNC_DIR, runId), { recursive: true, force: true });
    // Remove the shared temp dirs only when empty so unrelated runs are never touched.
    for (const dir of [
      join(TEMP_ROOT_DIR, "workspace-reservations"),
      ASYNC_DIR,
      RESULTS_DIR,
      TEMP_ARTIFACTS_DIR,
      TEMP_ROOT_DIR,
    ]) {
      try {
        rmdirSync(dir);
      } catch {
        // Non-empty or already absent.
      }
    }
  });

  return { owner, embeddedStep, writeRun };
}

let callSeq = 0;
function rushExecutorCaller({ fixture, owner, toolCall, hookCtx, afterHook }) {
  const dispatched = [];
  const executor = createSubagentExecutor({
    pi: { events: { emit() {}, on: () => () => {} }, getSessionName: () => "parent" },
    state: makeSubagentState({ baseCwd: fixture.cwd }),
    config: { maxSubagentDepth: 2, control: {} },
    tempArtifactsDir: fixture.cwd,
    getSubagentSessionRoot: () => join(fixture.cwd, "sessions"),
    expandTilde: (value) => value,
    discoverAgents: () => ({ agents: [makeAgent("code-reviewer")] }),
    getProjectAgentAccess: getTlhProjectAgentAccess,
    kill: () => true,
    executeAsyncSingle: (runId) => {
      dispatched.push(runId);
      return {
        content: [{ type: "text", text: "dispatched" }],
        details: { mode: "single", results: [], asyncId: runId },
      };
    },
  });
  const execCtx = makeMinimalCtx(fixture.cwd);
  execCtx.sessionManager.getSessionId = () => owner;
  execCtx.sessionManager.getSessionFile = () => null;
  const call = async (input) => {
    const toolCallId = `rush-${++callSeq}`;
    const hook = await toolCall({ toolName: "subagent", toolCallId, input }, hookCtx);
    assert.equal(hook, undefined, "hook delegates resume/steer to the executor");
    if (afterHook) afterHook();
    try {
      return await executor.execute(
        toolCallId,
        input,
        new AbortController().signal,
        undefined,
        execCtx,
      );
    } finally {
      noteSubagentToolExecutionEnd(toolCallId); // the tool_execution_end release
    }
  };

  return { call, dispatched };
}

// End-to-end: the Rush hook passes resume/steer through and the executor, using the real
// lifecycle access provider, enforces the embedded-only rule on the exact persisted children.
test("embedded subagents: rush resume/steer is enforced by the executor per exact child", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  writeEmbeddedAgent(
    fixture.agent,
    "trusted/my-tool.md",
    "---\nname: my-tool\npackage: embedded\ndescription: Trusted helper\n---",
  );
  const { owner, embeddedStep, writeRun } = rushRunFixture(t, fixture);

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { applySessionStart, toolCall } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata: [],
    });
    const hookCtx = createToolCallContext(
      [
        {
          type: "custom",
          customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
          data: { selected: "rush" },
        },
      ],
      undefined,
      { cwd: fixture.cwd },
    );
    await applySessionStart(hookCtx);

    const { call, dispatched } = rushExecutorCaller({ fixture, owner, toolCall, hookCtx });
    for (const action of ["resume", "steer"]) {
      const state = action === "resume" ? "complete" : "running";
      const reason = new RegExp(`Rush may not use subagent action=${action}`);
      const base = { action, message: "Go." };
      const before = dispatched.length;
      const blocked = async (runId, extra = {}, anyRejection = false) => {
        const result = await call({ ...base, id: runId, ...extra });
        assert.equal(result.isError, true, `${action} ${runId}`);
        if (!anyRejection) assert.match(result.content[0]?.text ?? "", reason);
      };
      await blocked(writeRun(state, [{ agent: "developer" }]));
      const mixed = writeRun(state, [{ agent: "developer" }, embeddedStep]);
      await blocked(mixed, { index: 0 });
      await blocked(mixed, {}, action === "resume");
      await blocked("missing-run-1", {}, true);
      assert.equal(dispatched.length, before, `${action} dispatched nothing while blocked`);

      // The stubbed dispatch never reaches a terminal state, so release the revived
      // runs' writer reservations (held by this live process) between allowed calls.
      const releaseDispatched = () => {
        for (const id of dispatched.slice(before)) releaseWorkspaceReservationsForRun(id);
      };
      const allowed = await call({ ...base, id: writeRun(state, [embeddedStep]) });
      releaseDispatched();
      assert.equal(allowed.isError, undefined, allowed.content[0]?.text);
      const mixedAllowed = await call({ ...base, id: mixed, index: 1 });
      releaseDispatched();
      assert.equal(mixedAllowed.isError, undefined, mixedAllowed.content[0]?.text);
    }
  });
});

test("embedded subagents: rush hook backstop blocks resume/steer unless the bridge reports the restriction", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { applySessionStart, toolCall } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata: [],
    });
    const hookCtx = createToolCallContext(
      [
        {
          type: "custom",
          customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
          data: { selected: "rush" },
        },
      ],
      undefined,
      { cwd: fixture.cwd },
    );
    await applySessionStart(hookCtx);
    const blockedProviders = {
      unregistered: undefined,
      undefined: () => undefined,
      unrestricted: () => ({ architect: false, canManage: true, canInitiate: true }),
    };
    try {
      for (const [name, provider] of Object.entries(blockedProviders)) {
        setTlhProjectAgentAccessProvider(provider);
        for (const action of ["resume", "steer"]) {
          const result = await toolCall(
            { toolName: "subagent", input: { action, id: "run-1", message: "Go." } },
            hookCtx,
          );
          assert.equal(result?.block, true, `${name} ${action}`);
          assert.match(result.reason, new RegExp(`Rush may not use subagent action=${action}`));
        }
      }
      // A restricted (even malformed) bridge delegates to the executor, which rejects.
      setTlhProjectAgentAccessProvider(() => ({
        controlRestrictedToEmbedded: true,
        canManage: "invalid",
      }));
      const delegated = await toolCall(
        {
          toolName: "subagent",
          toolCallId: "backstop-1",
          input: { action: "resume", id: "run-1", message: "Go." },
        },
        hookCtx,
      );
      assert.equal(delegated, undefined);
      assert.equal(isEmbeddedOnlyToolCall("backstop-1"), true);
      noteSubagentToolExecutionEnd("backstop-1");
      // A restricted bridge without a usable toolCallId cannot be bound: fail closed.
      const unbound = await toolCall(
        { toolName: "subagent", input: { action: "steer", id: "run-1", message: "Go." } },
        hookCtx,
      );
      assert.equal(unbound?.block, true);
      // A throwing bridge surfaces as a restricted deny, so the executor still rejects.
      setTlhProjectAgentAccessProvider(() => {
        throw new Error("bridge broken");
      });
      const access = getTlhProjectAgentAccess({});
      assert.equal(access.controlRestrictedToEmbedded, true);
      assert.equal(access.canManage, false);
    } finally {
      setTlhProjectAgentAccessProvider(undefined);
    }
  });
});

test("embedded subagents: product and bug-hunter may retain ordinary opaque resume behavior", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
    );
    for (const selected of ["product", "bug-hunter"]) {
      const { applySessionStart, toolCall } = registerRuntimeHarness({
        primaryAgents: selectablePrimaryAgents(),
        subagentMetadata: [],
      });
      const ctx = createToolCallContext(
        [{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected } }],
        undefined,
        { cwd: fixture.cwd },
      );
      await applySessionStart(ctx);

      const opaqueResumeEvent = {
        toolName: "subagent",
        input: { action: "resume", id: "run-123", message: "Continue the approved ticket." },
      };
      assert.equal(
        await toolCall(opaqueResumeEvent, ctx),
        undefined,
        `${selected} opaque resume should remain allowed`,
      );
      assert.equal(opaqueResumeEvent.input.agentScope, "user");
      assert.equal(Object.hasOwn(opaqueResumeEvent.input, "context"), false);
    }
  });
});

test("embedded subagents: product may dispatch authorized single and parallel targets", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
    );
    writeEmbeddedAgent(
      fixture.agent,
      "trusted/my-tool.md",
      "---\nname: my-tool\npackage: embedded\ndescription: Trusted helper\n---",
    );
    const { applySessionStart, toolCall } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata: [],
    });
    const ctx = createToolCallContext(
      [
        {
          type: "custom",
          customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
          data: { selected: "product" },
        },
      ],
      undefined,
      { cwd: fixture.cwd },
    );
    await applySessionStart(ctx);

    for (const input of [
      { agent: "embedded.my-tool", task: "do something" },
      { tasks: [{ agent: "embedded.my-tool", task: "step 1" }] },
    ]) {
      const result = await toolCall({ toolName: "subagent", input }, ctx);
      assert.equal(result, undefined);
      assert.equal(input.agentScope, "user");
    }
  });
});

test("embedded subagents: bug-hunter may dispatch authorized single and parallel targets", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
    );
    writeEmbeddedAgent(
      fixture.agent,
      "trusted/my-tool.md",
      "---\nname: my-tool\npackage: embedded\ndescription: Trusted helper\n---",
    );
    const { applySessionStart, toolCall } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata: [],
    });
    const ctx = createToolCallContext(
      [
        {
          type: "custom",
          customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
          data: { selected: "bug-hunter" },
        },
      ],
      undefined,
      { cwd: fixture.cwd },
    );
    await applySessionStart(ctx);

    for (const input of [
      { agent: "embedded.my-tool", task: "do something" },
      { tasks: [{ agent: "embedded.my-tool", task: "step 1" }] },
    ]) {
      const result = await toolCall({ toolName: "subagent", input }, ctx);
      assert.equal(result, undefined);
      assert.equal(input.agentScope, "user");
    }
  });
});

test("embedded subagents: architect keeps normal (non-embedded) targets working", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
    );
    const { applySessionStart, toolCall } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata: [],
    });
    const ctx = createToolCallContext(
      [
        {
          type: "custom",
          customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
          data: { selected: "architect" },
        },
      ],
      undefined,
      { cwd: fixture.cwd },
    );
    await applySessionStart(ctx);

    // Normal developer targets should still use the ordinary user-scope path.
    const normalEvent = { toolName: "subagent", input: { agent: "developer" } };
    const result = await toolCall(normalEvent, ctx);
    assert.equal(result, undefined);
    assert.equal(normalEvent.input.agentScope, "user");
    assert.equal(Object.hasOwn(normalEvent.input, "context"), false);
  });
});

test("embedded subagents: existing rush developer and resume blocks are preserved", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
    );
    const { applySessionStart, toolCall } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata: [],
    });
    const rushCtx = createToolCallContext(
      [
        {
          type: "custom",
          customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
          data: { selected: "rush" },
        },
      ],
      undefined,
      { cwd: fixture.cwd },
    );
    await applySessionStart(rushCtx);

    // Rush ordinary resume and steer still rejected (executor-enforced)
    const { owner, writeRun } = rushRunFixture(t, fixture);
    const { call } = rushExecutorCaller({ fixture, owner, toolCall, hookCtx: rushCtx });
    for (const [action, state] of [
      ["resume", "complete"],
      ["steer", "running"],
    ]) {
      const result = await call({
        action,
        id: writeRun(state, [{ agent: "developer" }]),
        message: "Go.",
      });
      assert.equal(result.isError, true);
      assert.match(
        result.content[0]?.text ?? "",
        new RegExp(`Rush may not use subagent action=${action}`),
      );
    }

    // Rush developer still blocked
    const developerEvent = {
      toolName: "subagent",
      input: { agent: "developer", task: "implement this" },
    };
    const developerResult = await toolCall(developerEvent, rushCtx);
    assert.equal(developerResult?.block, true);
    assert.match(
      developerResult?.reason ?? "",
      /Rush may not delegate implementation to developer/,
    );
  });
});

// ─── Multi-turn runtime regression tests ─────────────────────────────────────
// These tests exercise the genuine session_start → before_agent_start(xN) → tool_call
// lifecycle and ensure legacy experimental settings never become an authorization snapshot.

// The hook saw Rush; the executor then sees a different (or no) provider. The mark bound
// to the invocation must keep the embedded-only restriction regardless.
test("embedded subagents: rush mark survives a provider change between hook and executor", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const { owner, writeRun } = rushRunFixture(t, fixture);
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const swaps = {
      architect: () => ({ architect: true, canManage: true, canInitiate: true }),
      removed: undefined,
      legacy: () => ({ architect: true }),
    };
    try {
      for (const [name, swap] of Object.entries(swaps)) {
        for (const action of ["resume", "steer"]) {
          // A fresh harness re-registers the real provider after each swap.
          const { applySessionStart, toolCall } = registerRuntimeHarness({
            primaryAgents: selectablePrimaryAgents(),
            subagentMetadata: [],
          });
          const hookCtx = createToolCallContext(
            [
              {
                type: "custom",
                customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
                data: { selected: "rush" },
              },
            ],
            undefined,
            { cwd: fixture.cwd },
          );
          await applySessionStart(hookCtx);
          const state = action === "resume" ? "complete" : "running";
          const { call, dispatched } = rushExecutorCaller({
            fixture,
            owner,
            toolCall,
            hookCtx,
            afterHook: () => setTlhProjectAgentAccessProvider(swap),
          });
          const runId = writeRun(state, [{ agent: "developer" }]);
          const result = await call({ action, id: runId, message: "Go." });
          assert.equal(result.isError, true, `${name} ${action}`);
          assert.equal(dispatched.length, 0, `${name} ${action}`);
          assert.equal(isEmbeddedOnlyToolCall(`rush-${callSeq}`), false, "mark cleared");
        }
      }
    } finally {
      setTlhProjectAgentAccessProvider(undefined);
    }
  });
});

// Pi prepares every parallel call before executing any, so marks pile up. Overflow must
// never evict an outstanding mark: the new call is blocked at the hook, and the registry
// recovers once outstanding calls end.
test("embedded subagents: rush mark registry overflow fails closed and recovers", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { pi, applySessionStart, toolCall } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata: [],
    });
    const hookCtx = createToolCallContext(
      [
        {
          type: "custom",
          customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
          data: { selected: "rush" },
        },
      ],
      undefined,
      { cwd: fixture.cwd },
    );
    await applySessionStart(hookCtx);
    const fill = [];
    const hookCall = (toolCallId, action = "resume") =>
      toolCall(
        { toolName: "subagent", toolCallId, input: { action, id: "r", message: "Go." } },
        hookCtx,
      );
    const executionEnd = pi.events.find((event) => event.name === "tool_execution_end")?.handler;
    assert.equal(typeof executionEnd, "function");
    try {
      // Real hook calls hold marks until their execution ends.
      for (let i = 0; i < 256; i++) {
        fill.push(`fill-${i}`);
        assert.equal(await hookCall(`fill-${i}`, i % 2 ? "steer" : "resume"), undefined);
      }
      const overflow = await hookCall("overflow-1");
      assert.equal(overflow?.block, true);
      assert.match(overflow.reason, /Rush may not use subagent action=resume/);
      assert.equal(isEmbeddedOnlyToolCall("overflow-1"), false, "overflow call is never marked");
      assert.equal(isEmbeddedOnlyToolCall("fill-0"), true, "oldest outstanding mark not evicted");
      // A call ending (including one blocked by a later hook/extension, which only
      // emits tool_execution_end) frees capacity.
      await executionEnd({ toolName: "subagent", toolCallId: "fill-0" }, hookCtx);
      assert.equal(isEmbeddedOnlyToolCall("fill-0"), false);
      assert.equal(await hookCall("recovered-1"), undefined);
      assert.equal(isEmbeddedOnlyToolCall("recovered-1"), true);
      fill.push("recovered-1");
    } finally {
      for (const id of fill) noteSubagentToolExecutionEnd(id);
      setTlhProjectAgentAccessProvider(undefined);
    }
  });
  assert.equal(markEmbeddedOnlyToolCall("post-test"), true);
  noteSubagentToolExecutionEnd("post-test");
});

test("embedded subagents: rush hook does not mark calls it blocks", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { applySessionStart, toolCall } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata: [],
    });
    const hookCtx = createToolCallContext(
      [
        {
          type: "custom",
          customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
          data: { selected: "rush" },
        },
      ],
      undefined,
      { cwd: fixture.cwd },
    );
    await applySessionStart(hookCtx);
    // Blocked by a later hook check (invalid input for the action) after the mark would
    // previously have been taken.
    const result = await toolCall(
      {
        toolName: "subagent",
        toolCallId: "blocked-late",
        input: { action: "resume", id: "r", message: "Go.", agent: "developer" },
      },
      hookCtx,
    );
    assert.equal(result?.block, true);
    assert.equal(isEmbeddedOnlyToolCall("blocked-late"), false);
  });
});

// Pi forwards provider toolCallIds without enforcing uniqueness. Drive the REAL
// pi-agent-core loop (parallel): call A (resume, marked by the Rush hook) shares an id
// with a sibling B that ends early for a variety of reasons. Per-id start/end accounting
// must keep A restricted until every same-id execution has ended, even after the provider
// stops reporting the restriction, and must delete all state afterwards.
async function runDuplicateIdScenario(
  t,
  {
    calls,
    schema,
    prefill = 0,
    blockEarly = () => false,
    dropProvider = true,
    dropAfterAll = false,
  },
) {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const fillers = Array.from({ length: prefill }, (_, i) => `fill-${i}`);
  const result = { seen: [], hooks: [], marksAfterEnd: [] };
  let prepared = 0;
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { pi, applySessionStart, toolCall } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata: [],
    });
    const hookCtx = createToolCallContext(
      [
        {
          type: "custom",
          customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
          data: { selected: "rush" },
        },
      ],
      undefined,
      { cwd: fixture.cwd },
    );
    await applySessionStart(hookCtx);
    const handler = (name) => pi.events.find((event) => event.name === name)?.handler;
    const executionStart = handler("tool_execution_start");
    const executionEnd = handler("tool_execution_end");
    assert.equal(typeof executionStart, "function");
    assert.equal(typeof executionEnd, "function");
    const tool = {
      name: "subagent",
      label: "subagent",
      description: "test",
      parameters: schema ?? { type: "object", properties: {}, additionalProperties: true },
      execute: async (toolCallId, params) =>
        runBoundToToolCall(toolCallId, async () => {
          result.seen.push({
            marker: params.marker,
            restricted: isCurrentInvocationEmbeddedOnly(),
          });
          return { content: [{ type: "text", text: "ok" }], details: {} };
        }),
    };
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const assistant = (content, stopReason) => ({
      role: "assistant",
      content,
      api: "test",
      provider: "test",
      model: "test",
      usage,
      stopReason,
      timestamp: Date.now(),
    });
    let turn = 0;
    const streamFn = async () => {
      const message =
        turn++ === 0
          ? assistant(
              calls.map(({ id, arguments: args }) => ({
                type: "toolCall",
                id,
                name: "subagent",
                arguments: args,
              })),
              "toolUse",
            )
          : assistant([{ type: "text", text: "done" }], "stop");
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "done", reason: message.stopReason, message };
        },
        result: async () => message,
      };
    };
    const config = {
      model: { api: "test", provider: "test", id: "test" },
      convertToLlm: (messages) => messages,
      toolExecution: "parallel",
      beforeToolCall: async ({ toolCall: tc, args }) => {
        // An EARLIER extension blocks before TLH's hook ever runs.
        if (blockEarly(args)) return { block: true, reason: "blocked by an earlier extension" };
        const hook = await toolCall({ toolName: tc.name, toolCallId: tc.id, input: args }, hookCtx);
        prepared++;
        result.hooks.push({
          marker: args.marker,
          block: hook?.block === true,
          reason: hook?.reason,
          marked: isEmbeddedOnlyToolCall(tc.id),
        });
        if (hook?.block) return hook;
        // The provider stops reporting the restriction once the first call is prepared
        // (or, with dropAfterAll, only after every call has been through the hook).
        if (dropProvider && (!dropAfterAll || prepared === calls.length)) {
          setTlhProjectAgentAccessProvider(undefined);
        }
        return undefined;
      },
    };
    const emit = async (event) => {
      if (event.type === "tool_execution_start") await executionStart(event, hookCtx);
      if (event.type === "tool_execution_end") {
        // Snapshot right after the (synchronous) accounting step, before other ends run.
        const ending = executionEnd(event, hookCtx);
        result.marksAfterEnd.push(isEmbeddedOnlyToolCall(event.toolCallId));
        await ending;
      }
    };
    try {
      for (const id of fillers) assert.equal(markEmbeddedOnlyToolCall(id), true);
      await runAgentLoop(
        [{ role: "user", content: "go", timestamp: Date.now() }],
        { systemPrompt: "", messages: [], tools: [tool] },
        config,
        emit,
        undefined,
        streamFn,
      );
      for (const id of fillers) noteSubagentToolExecutionEnd(id);
      result.accountingSize = subagentExecutionAccountingSize();
    } finally {
      for (const id of [...fillers, ...calls.map((c) => c.id)]) noteSubagentToolExecutionEnd(id);
      setTlhProjectAgentAccessProvider(undefined);
    }
  });
  return result;
}

const resumeArgs = (marker, extra = {}) => ({
  action: "resume",
  id: "r",
  message: "Go.",
  marker,
  ...extra,
});

for (const [label, scenario] of [
  [
    "an earlier extension blocks unmarked same-id B",
    {
      calls: [
        { id: "dup-1", arguments: resumeArgs("A") },
        { id: "dup-1", arguments: resumeArgs("B") },
      ],
      blockEarly: (args) => args.marker === "B",
    },
  ],
  [
    "B is blocked by TLH before its marking step",
    {
      calls: [
        { id: "dup-1", arguments: resumeArgs("A") },
        { id: "dup-1", arguments: resumeArgs("B", { agent: "developer" }) },
      ],
    },
  ],
  [
    "B fails schema validation",
    {
      schema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
        additionalProperties: true,
      },
      calls: [
        { id: "dup-1", arguments: resumeArgs("A") },
        { id: "dup-1", arguments: { action: "resume", id: "r", marker: "B" } },
      ],
    },
  ],
  [
    "B is a non-resume/steer call blocked in preparation",
    {
      calls: [
        { id: "dup-1", arguments: resumeArgs("A") },
        { id: "dup-1", arguments: { action: "status", id: "r", marker: "B" } },
      ],
      blockEarly: (args) => args.marker === "B",
    },
  ],
  [
    "B is refused on capacity (registry full)",
    {
      prefill: 255,
      dropAfterAll: true,
      calls: [
        { id: "dup-1", arguments: resumeArgs("A") },
        { id: "over-1", arguments: resumeArgs("B") },
      ],
      verify: (result) => {
        // The provider is still valid during B's hook, so only a failed mark can block B.
        const [a, b] = result.hooks;
        assert.deepEqual(a, { marker: "A", block: false, reason: undefined, marked: true });
        assert.equal(b.block, true);
        assert.match(b.reason, /^TLH Rush may not use subagent action=resume\b/);
        assert.equal(b.marked, false, "B's id holds no mark");
      },
    },
  ],
]) {
  test(`embedded subagents: real runAgentLoop keeps A restricted when ${label}`, async (t) => {
    const result = await runDuplicateIdScenario(t, scenario);
    assert.deepEqual(
      result.seen.filter((entry) => entry.marker === "A"),
      [{ marker: "A", restricted: true }],
    );
    assert.equal(result.accountingSize, 0, "all per-id state is cleared after every call ended");
    assert.equal(isEmbeddedOnlyToolCall("dup-1"), false);
    scenario.verify?.(result);
  });
}

test("embedded subagents: at full capacity, re-marking an already-marked id is a no-op until both executions end (real runAgentLoop)", async (t) => {
  const result = await runDuplicateIdScenario(t, {
    prefill: 255,
    dropAfterAll: true,
    calls: [
      { id: "dup-1", arguments: resumeArgs("A") },
      { id: "dup-1", arguments: resumeArgs("B") },
    ],
  });
  assert.deepEqual(
    result.hooks.map(({ marker, block, marked }) => ({ marker, block, marked })),
    [
      { marker: "A", block: false, marked: true },
      { marker: "B", block: false, marked: true },
    ],
  );
  assert.deepEqual(result.seen, [
    { marker: "A", restricted: true },
    { marker: "B", restricted: true },
  ]);
  assert.deepEqual(result.marksAfterEnd, [true, false], "mark held until the second end");
  assert.equal(result.accountingSize, 0);
});

test("embedded subagents: two executed duplicate-id calls are both restricted and state is cleared (real runAgentLoop)", async (t) => {
  const result = await runDuplicateIdScenario(t, {
    dropProvider: false,
    calls: [
      { id: "dup-1", arguments: resumeArgs("A") },
      { id: "dup-1", arguments: resumeArgs("B") },
    ],
  });
  assert.deepEqual(result.seen, [
    { marker: "A", restricted: true },
    { marker: "B", restricted: true },
  ]);
  assert.equal(result.accountingSize, 0);
});

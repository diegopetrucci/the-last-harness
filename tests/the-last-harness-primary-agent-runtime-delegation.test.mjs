import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { PRIMARY_AGENT_SESSION_STATE_ENTRY } from "../extensions/the-last-harness-primary-agent.mjs";
import { cleanupTempDir, createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";
import {
  registerRuntimeHarness,
  createToolCallContext,
  writePrimaryConfig,
  selectablePrimaryAgents,
  contrarianMetadata,
  rushLikePrimary,
  createCommandContext,
  EMBEDDED_SUBAGENTS_FEATURE,
} from "./the-last-harness-primary-agent-runtime-test-helpers.mjs";

const SCOUT_RUN_MAX_TIMEOUT_MS = 360_000;

test("enabled primary mode allows approved delegation targets and forces safe top-level defaults", async () => {
  const { toolCall } = registerRuntimeHarness({ subagentMetadata: [] });
  const event = {
    toolName: "subagent",
    input: {
      tasks: [
        { agent: "repo-scout", task: "Map the repository" },
        { agent: "web-scout", task: "Research upstream release notes" },
      ],
    },
  };
  const ctx = createToolCallContext([
    {
      type: "custom",
      customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
      data: { selected: "architect" },
    },
  ]);

  assert.equal(await toolCall(event, ctx), undefined);
  assert.equal(event.input.agentScope, "user");
  assert.equal(event.input.context, "fresh");
});

test("tool_call caps targeted scout execution timeouts without affecting stricter or non-target calls", async () => {
  const { toolCall } = registerRuntimeHarness({ subagentMetadata: [] });
  const ctx = createToolCallContext([
    {
      type: "custom",
      customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
      data: { selected: "architect" },
    },
  ]);
  const cases = [
    {
      name: "missing timeout for librarian",
      event: {
        toolName: "subagent",
        input: { agent: "librarian", task: "Research upstream docs" },
      },
      expectedTimeoutMs: SCOUT_RUN_MAX_TIMEOUT_MS,
    },
    {
      name: "missing timeout for web-scout",
      event: {
        toolName: "subagent",
        input: { agent: "web-scout", task: "Research upstream docs" },
      },
      expectedTimeoutMs: SCOUT_RUN_MAX_TIMEOUT_MS,
    },
    {
      name: "missing timeout for repo-scout",
      event: { toolName: "subagent", input: { agent: "repo-scout", task: "Map the repo" } },
      expectedTimeoutMs: SCOUT_RUN_MAX_TIMEOUT_MS,
    },
    {
      name: "missing timeout for diff-summarizer",
      event: {
        toolName: "subagent",
        input: { agent: "diff-summarizer", task: "Summarize the diff" },
      },
      expectedTimeoutMs: SCOUT_RUN_MAX_TIMEOUT_MS,
    },
    {
      name: "overly long timeout is capped",
      event: {
        toolName: "subagent",
        input: { agent: "librarian", task: "Research upstream docs", timeoutMs: 420_000 },
      },
      expectedTimeoutMs: SCOUT_RUN_MAX_TIMEOUT_MS,
    },
    {
      name: "stricter timeout is preserved",
      event: {
        toolName: "subagent",
        input: { agent: "repo-scout", task: "Map the repo", timeoutMs: 120_000 },
      },
      expectedTimeoutMs: 120_000,
    },
    {
      name: "async execution is capped",
      event: {
        toolName: "subagent",
        input: { agent: "web-scout", task: "Research upstream docs", async: true },
      },
      expectedTimeoutMs: SCOUT_RUN_MAX_TIMEOUT_MS,
    },
    {
      name: "mixed batch uses run-level cap when any targeted scout is present",
      event: {
        toolName: "subagent",
        input: {
          tasks: [
            { agent: "developer", task: "Implement the change" },
            { agent: "diff-summarizer", task: "Summarize the diff" },
          ],
          timeoutMs: 420_000,
        },
      },
      expectedTimeoutMs: SCOUT_RUN_MAX_TIMEOUT_MS,
    },
    {
      name: "non-target execution is unchanged",
      event: {
        toolName: "subagent",
        input: { agent: "developer", task: "Implement the change", timeoutMs: 420_000 },
      },
      expectedTimeoutMs: 420_000,
    },
  ];

  for (const { name, event, expectedTimeoutMs } of cases) {
    assert.equal(await toolCall(event, ctx), undefined, name);
    assert.equal(event.input.timeoutMs, expectedTimeoutMs, name);
  }
});

test("tool_call leaves every resume timeout unchanged while still normalizing scope and context", async () => {
  const { toolCall } = registerRuntimeHarness({ subagentMetadata: [] });
  const ctx = createToolCallContext([
    {
      type: "custom",
      customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
      data: { selected: "architect" },
    },
  ]);
  const resumeChainEvent = {
    toolName: "subagent",
    input: {
      action: "resume",
      id: "run-123",
      message: "Continue the approved ticket.",
      timeoutMs: 420_000,
    },
  };
  const stricterResumeChainEvent = {
    toolName: "subagent",
    input: {
      action: "resume",
      id: "run-124",
      message: "Continue the approved ticket.",
      timeoutMs: 120_000,
    },
  };
  const listEvent = { toolName: "subagent", input: { action: "list", timeoutMs: 420_000 } };
  const opaqueResumeEvent = {
    toolName: "subagent",
    input: {
      action: "resume",
      id: "run-456",
      message: "Continue the approved ticket.",
      timeoutMs: 420_000,
    },
  };

  assert.equal(await toolCall(resumeChainEvent, ctx), undefined);
  assert.equal(resumeChainEvent.input.timeoutMs, 420_000);
  assert.equal(resumeChainEvent.input.agentScope, "user");
  assert.equal(resumeChainEvent.input.context, "fresh");

  assert.equal(await toolCall(stricterResumeChainEvent, ctx), undefined);
  assert.equal(stricterResumeChainEvent.input.timeoutMs, 120_000);
  assert.equal(stricterResumeChainEvent.input.agentScope, "user");
  assert.equal(stricterResumeChainEvent.input.context, "fresh");

  assert.equal(await toolCall(listEvent, ctx), undefined);
  assert.equal(listEvent.input.timeoutMs, 420_000);

  assert.equal(await toolCall(opaqueResumeEvent, ctx), undefined);
  assert.equal(opaqueResumeEvent.input.timeoutMs, 420_000);
});

test("enabled primary mode allows contrarian by default and stale contrarian settings stay harmless", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const subagentMetadata = [contrarianMetadata()];
  const branchEntries = [
    {
      type: "custom",
      customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
      data: { selected: "architect" },
    },
  ];
  const blockedCtx = createToolCallContext(branchEntries, undefined, {
    cwd: fixture.cwd,
    modelRegistry: {
      getAvailable: () => [
        { provider: "openai-codex", id: "gpt-5.4" },
        { provider: "anthropic", id: "claude-opus-5" },
      ],
    },
    model: { provider: "openai-codex", id: "gpt-5.4" },
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { toolCall } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata,
    });
    const defaultEvent = {
      toolName: "subagent",
      input: { agent: "contrarian", task: "stress-test this plan" },
    };
    assert.equal(await toolCall(defaultEvent, blockedCtx), undefined);
    assert.equal(defaultEvent.input.model, "anthropic/claude-opus-5:high");
    assert.equal(defaultEvent.input.agentScope, "user");
    assert.equal(defaultEvent.input.context, "fresh");

    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: ["contrarian"] } } }, null, 2)}\n`,
    );
    const legacyFlagEvent = {
      toolName: "subagent",
      input: { agent: "contrarian", task: "stress-test this plan" },
    };
    assert.equal(await toolCall(legacyFlagEvent, blockedCtx), undefined);
    assert.equal(legacyFlagEvent.input.model, "anthropic/claude-opus-5:high");
    assert.equal(legacyFlagEvent.input.agentScope, "user");
    assert.equal(legacyFlagEvent.input.context, "fresh");
  });
});

test("enabled primary mode blocks disallowed task delegation targets after forcing safe defaults", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
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

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { toolCall } = registerRuntimeHarness({ subagentMetadata: [] });
    const event = {
      toolName: "subagent",
      input: {
        tasks: [
          { agent: "repo-scout", task: "Inspect the repo" },
          { agent: "planner", task: "Plan the work" },
        ],
      },
    };

    assert.deepEqual(await toolCall(event, ctx), {
      block: true,
      reason:
        "TLH primary agents may delegate only to: developer, code-reviewer, repo-scout, diff-summarizer, librarian, web-scout, oracle, contrarian, or embedded.<slug>. Disallowed target(s): planner.",
    });
    assert.equal(event.input.agentScope, "user");
    assert.equal(event.input.context, "fresh");
  });
});

test("enabled primary mode normalizes safe management list/get/resume inputs and blocks unsafe resume calls", async () => {
  const { toolCall } = registerRuntimeHarness({ subagentMetadata: [] });
  const ctx = createToolCallContext([
    {
      type: "custom",
      customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
      data: { selected: "architect" },
    },
  ]);
  const listEvent = { toolName: "subagent", input: { action: "list" } };
  const listBothEvent = { toolName: "subagent", input: { action: "list", agentScope: "both" } };
  const getEvent = { toolName: "subagent", input: { action: "get", agentScope: "" } };
  const getBothEvent = { toolName: "subagent", input: { action: "get", agentScope: "both" } };
  const resumeEvent = {
    toolName: "subagent",
    input: {
      action: "resume",
      id: "run-123",
      message: "Continue the approved ticket.",
      agentScope: "",
      context: "",
    },
  };
  const resumeBothEvent = {
    toolName: "subagent",
    input: {
      action: "resume",
      id: "run-456",
      message: "Continue the approved ticket.",
      agentScope: "both",
    },
  };
  const blockedGetEvent = { toolName: "subagent", input: { action: "get", agentScope: "project" } };
  const blockedResumeScopeEvent = {
    toolName: "subagent",
    input: { action: "resume", id: "run-123", agentScope: "system" },
  };
  const blockedResumeContextEvent = {
    toolName: "subagent",
    input: { action: "resume", id: "run-123", context: "resume" },
  };

  assert.equal(await toolCall(listEvent, ctx), undefined);
  assert.equal(listEvent.input.agentScope, "user");
  assert.equal(await toolCall(listBothEvent, ctx), undefined);
  assert.equal(listBothEvent.input.agentScope, "user");
  assert.equal(await toolCall(getEvent, ctx), undefined);
  assert.equal(getEvent.input.agentScope, "user");
  assert.equal(await toolCall(getBothEvent, ctx), undefined);
  assert.equal(getBothEvent.input.agentScope, "user");
  assert.equal(await toolCall(resumeEvent, ctx), undefined);
  assert.equal(resumeEvent.input.agentScope, "user");
  assert.equal(resumeEvent.input.context, "fresh");
  assert.equal(await toolCall(resumeBothEvent, ctx), undefined);
  assert.equal(resumeBothEvent.input.agentScope, "user");
  assert.equal(resumeBothEvent.input.context, "fresh");
  assert.deepEqual(await toolCall(blockedGetEvent, ctx), {
    block: true,
    reason:
      'TLH primary-agent subagent get calls may not use agentScope: "project". TLH minor agents must run from the isolated user scope.',
  });
  assert.deepEqual(await toolCall(blockedResumeScopeEvent, ctx), {
    block: true,
    reason:
      'TLH primary-agent subagent resume calls may not use agentScope: "system". TLH minor agents must run from the isolated user scope.',
  });
  assert.deepEqual(await toolCall(blockedResumeContextEvent, ctx), {
    block: true,
    reason:
      'TLH primary-agent subagent resume may not use context: "resume". TLH child sessions must start fresh so parent primary-agent/Gnosis context is not leaked.',
  });
});

test("disabled primary mode enforces architect-equivalent subagent safety and scope", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const { toolCall } = registerRuntimeHarness({
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

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const allowedEvent = {
      toolName: "subagent",
      input: { agent: "repo-scout", task: "Map the repository" },
    };
    assert.equal(await toolCall(allowedEvent, ctx), undefined);
    assert.equal(allowedEvent.input.agentScope, "user");
    assert.equal(allowedEvent.input.context, "fresh");
    assert.equal(allowedEvent.input.timeoutMs, SCOUT_RUN_MAX_TIMEOUT_MS);

    const blockedTargetEvent = {
      toolName: "subagent",
      input: { agent: "planner", task: "Plan the work" },
    };
    assert.deepEqual(await toolCall(blockedTargetEvent, ctx), {
      block: true,
      reason:
        "TLH primary agents may delegate only to: developer, code-reviewer, repo-scout, diff-summarizer, librarian, web-scout, oracle, contrarian, or embedded.<slug>. Disallowed target(s): planner.",
    });
    assert.equal(blockedTargetEvent.input.agentScope, "user");
    assert.equal(blockedTargetEvent.input.context, "fresh");

    const blockedScopeEvent = {
      toolName: "subagent",
      input: { agent: "developer", task: "Implement the change", agentScope: "project" },
    };
    assert.match((await toolCall(blockedScopeEvent, ctx))?.reason ?? "", /may not use agentScope/);

    const blockedContextEvent = {
      toolName: "subagent",
      input: { agent: "developer", task: "Implement the change", context: "resume" },
    };
    assert.match((await toolCall(blockedContextEvent, ctx))?.reason ?? "", /may not use context/);
  });
});

test("Rush blocks subagent resume with a Rush-specific reason", async () => {
  const { toolCall } = registerRuntimeHarness({
    primaryAgents: selectablePrimaryAgents(),
    subagentMetadata: [],
  });
  const event = {
    toolName: "subagent",
    input: {
      action: "resume",
      id: "run-123",
      message: "Continue the approved ticket.",
      agentScope: "",
      context: "",
    },
  };
  const ctx = createToolCallContext([
    { type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "rush" } },
  ]);

  const result = await toolCall(event, ctx);
  assert.deepEqual(result, {
    block: true,
    reason:
      "TLH Rush may not use subagent action=resume because resuming by run id or index can continue a prior developer subagent without an explicit safe target. Rush must edit directly or start a new allowed subagent with an explicit agent target.",
  });
});

test("Rush blocks subagent steer with a Rush-specific reason", async () => {
  const { toolCall } = registerRuntimeHarness({
    primaryAgents: selectablePrimaryAgents(),
    subagentMetadata: [],
  });
  const event = {
    toolName: "subagent",
    input: { action: "steer", id: "run-123", message: "Please wrap up the current subtask." },
  };
  const ctx = createToolCallContext([
    { type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "rush" } },
  ]);

  const result = await toolCall(event, ctx);
  assert.deepEqual(result, {
    block: true,
    reason:
      "TLH Rush may not use subagent action=steer because an opaque steer carries no agent field, so TLH cannot prove the steered child is not a developer subagent. Rush must edit directly.",
  });
});

test("Rush blocks developer delegation in task-based subagent plans", async () => {
  const { toolCall } = registerRuntimeHarness({
    primaryAgents: selectablePrimaryAgents(),
    subagentMetadata: [],
  });
  const event = {
    toolName: "subagent",
    input: {
      tasks: [
        { agent: "code-reviewer", task: "Review the diff" },
        { agent: "developer", task: "Implement the fix" },
      ],
    },
  };
  const ctx = createToolCallContext([
    { type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "rush" } },
  ]);

  const result = await toolCall(event, ctx);
  assert.deepEqual(result, {
    block: true,
    reason:
      "TLH Rush may not delegate implementation to developer. Rush must edit directly; use code-reviewer, repo-scout, diff-summarizer, librarian, or oracle only when Rush prompt rules allow it.",
  });
});

test("/switch-primary-agent includes Rush completions, usage, and status strings", async () => {
  const { pi } = registerRuntimeHarness({
    primaryAgents: selectablePrimaryAgents(),
    subagentMetadata: [],
  });
  const command = pi.commands.get("switch-primary-agent");
  assert.ok(command, "registers /switch-primary-agent");
  assert.equal(pi.commands.has("agent"), false);
  assert.equal(pi.commands.has("architect"), false);
  assert.equal(pi.commands.has("tlh"), false);
  assert.equal(pi.commands.has("harness"), false);

  assert.deepEqual(
    (await command.getArgumentCompletions("r")).map((completion) => completion.value),
    ["rush", "reset"],
  );
  assert.deepEqual(
    (await command.getArgumentCompletions("default r")).map((completion) => completion.value),
    ["default rush", "default reset"],
  );
  assert.deepEqual(
    (await command.getArgumentCompletions("model r")).map((completion) => completion.value),
    ["model reset"],
  );

  const usage = createCommandContext();
  await command.handler("rush extra", usage.ctx);
  assert.deepEqual(usage.notifications.at(-1), {
    message: "Usage: /switch-primary-agent architect|rush|product|bug-hunter|disabled",
    type: "error",
  });

  const status = createCommandContext([
    { type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "rush" } },
  ]);
  await command.handler("status", status.ctx);
  assert.equal(status.notifications.at(-1)?.type, "info");
  assert.match(status.notifications.at(-1)?.message ?? "", /Primary agent: rush\./);
});

test("/switch-primary-agent model reset clears the active primary model override", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const primaryAgents = new Map([["architect", rushLikePrimary()]]);
  const initialSettings = `${JSON.stringify(
    {
      tlh: { primaryAgent: { modelOverrides: { architect: "openai-codex/gpt-5.6-luna" } } },
    },
    null,
    2,
  )}\n`;

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(join(fixture.agent, "settings.json"), initialSettings);
    const { pi } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
    const command = pi.commands.get("switch-primary-agent");
    assert.ok(command, "registers /switch-primary-agent");

    const reset = createCommandContext([], {
      cwd: fixture.cwd,
      modelRegistry: {
        getAvailable: () => [
          { provider: "openai-codex", id: "gpt-5.6-luna" },
          { provider: "anthropic", id: "claude-sonnet-4-6" },
        ],
      },
      model: { provider: "openai-codex", id: "gpt-5.6-luna" },
    });
    await command.handler("model reset", reset.ctx);

    const written = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
    assert.equal(written.tlh.primaryAgent.modelOverrides, undefined);
    assert.deepEqual(pi.model, { provider: "anthropic", id: "claude-sonnet-4-6" });
    assert.equal(reset.notifications.at(-1)?.type, "info");
    assert.match(reset.notifications.at(-1)?.message ?? "", /Cleared model override for architect/);
  });
});

test("/switch-primary-agent status reports model override or none", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const absentFixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", {
    cwd: true,
    test: t,
  });
  const primaryAgents = new Map([["architect", rushLikePrimary()]]);

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writePrimaryConfig(fixture.agent, {
      modelOverrides: { architect: "anthropic/claude-opus-4-8" },
    });
    const { pi } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
    const command = pi.commands.get("switch-primary-agent");
    assert.ok(command, "registers /switch-primary-agent");

    const status = createCommandContext([], { cwd: fixture.cwd });
    await command.handler("status", status.ctx);

    assert.equal(status.notifications.at(-1)?.type, "info");
    assert.match(
      status.notifications.at(-1)?.message ?? "",
      /Model override: anthropic\/claude-opus-4-8\./,
    );
  });

  await withEnv(
    { HOME: absentFixture.home, PI_CODING_AGENT_DIR: absentFixture.agent },
    async () => {
      const { pi } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
      const command = pi.commands.get("switch-primary-agent");
      assert.ok(command, "registers /switch-primary-agent");

      const status = createCommandContext([], { cwd: absentFixture.cwd });
      await command.handler("status", status.ctx);

      assert.equal(status.notifications.at(-1)?.type, "info");
      assert.match(status.notifications.at(-1)?.message ?? "", /Model override: none\./);
    },
  );
});

test("/switch-primary-agent status reports an override for overrideable Rush", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const primaryAgents = new Map([["rush", rushLikePrimary("rush")]]);

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writePrimaryConfig(fixture.agent, { modelOverrides: { rush: "anthropic/claude-opus-5" } });
    const { pi } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
    const command = pi.commands.get("switch-primary-agent");
    assert.ok(command, "registers /switch-primary-agent");

    const status = createCommandContext(
      [
        {
          type: "custom",
          customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
          data: { selected: "rush" },
        },
      ],
      { cwd: fixture.cwd },
    );
    await command.handler("status", status.ctx);

    assert.equal(status.notifications.at(-1)?.type, "info");
    assert.match(status.notifications.at(-1)?.message ?? "", /Primary agent: rush\./);
    assert.match(
      status.notifications.at(-1)?.message ?? "",
      /Model override: anthropic\/claude-opus-5\./,
    );
  });
});

test("/switch-primary-agent model reset clears an overrideable Rush model override", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const primaryAgents = new Map([["rush", rushLikePrimary("rush")]]);
  const initialSettings = `${JSON.stringify(
    {
      tlh: { primaryAgent: { modelOverrides: { rush: "anthropic/claude-opus-5" } } },
    },
    null,
    2,
  )}\n`;

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(join(fixture.agent, "settings.json"), initialSettings);
    const { pi } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
    const command = pi.commands.get("switch-primary-agent");
    assert.ok(command, "registers /switch-primary-agent");

    const reset = createCommandContext(
      [
        {
          type: "custom",
          customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
          data: { selected: "rush" },
        },
      ],
      {
        cwd: fixture.cwd,
        modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-4-6" }] },
        model: { provider: "anthropic", id: "claude-opus-5" },
      },
    );
    await command.handler("model reset", reset.ctx);

    const written = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
    assert.equal(written.tlh.primaryAgent.modelOverrides, undefined);
    assert.deepEqual(pi.model, { provider: "anthropic", id: "claude-sonnet-4-6" });
    assert.equal(reset.notifications.at(-1)?.type, "info");
    assert.match(reset.notifications.at(-1)?.message ?? "", /Cleared model override for rush/);
  });
});

test("/switch-primary-agent default writes tlh.primaryAgent with a backup", async () => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true });
  const initialSettings = `${JSON.stringify({ tlh: { primaryAgent: { selected: "architect" } } }, null, 2)}\n`;

  try {
    writeFileSync(join(fixture.agent, "settings.json"), initialSettings);
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const { pi } = registerRuntimeHarness({
        primaryAgents: selectablePrimaryAgents(),
        subagentMetadata: [],
      });
      const command = pi.commands.get("switch-primary-agent");
      assert.ok(command, "registers /switch-primary-agent");

      const writeDefault = createCommandContext([], { cwd: fixture.cwd });
      await command.handler("default rush", writeDefault.ctx);

      const written = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
      assert.deepEqual(written.tlh.primaryAgent, { enabled: true, selected: "rush" });
      const backups = readdirSync(fixture.agent).filter((entry) =>
        entry.startsWith("settings.json.bak-"),
      );
      assert.equal(backups.length, 1);
      assert.equal(readFileSync(join(fixture.agent, backups[0]), "utf8"), initialSettings);
      assert.equal(writeDefault.notifications.at(-1)?.type, "info");
      assert.match(
        writeDefault.notifications.at(-1)?.message ?? "",
        /Updated TLH primary-agent persistent default/,
      );
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("/switch-primary-agent default refuses normal Pi settings", async () => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true });
  const normalAgent = join(fixture.home, ".pi", "agent");

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: normalAgent }, async () => {
      const { pi } = registerRuntimeHarness({
        primaryAgents: selectablePrimaryAgents(),
        subagentMetadata: [],
      });
      const command = pi.commands.get("switch-primary-agent");
      assert.ok(command, "registers /switch-primary-agent");

      const writeDefault = createCommandContext([], { cwd: fixture.cwd });
      await command.handler("default rush", writeDefault.ctx);

      assert.equal(writeDefault.notifications.at(-1)?.type, "error");
      assert.match(
        writeDefault.notifications.at(-1)?.message ?? "",
        /isolated TLH profile|normal Pi config/,
      );
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

// ─── Embedded subagents (ts-42p1) ───────────────────────────────────────────

function writeEmbeddedAgent(agentDir, relativePath, frontmatter) {
  const filePath = join(agentDir, "agents", relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${frontmatter}\nbody\n`);
  return filePath;
}

test("embedded subagents: disabled mode allows authorized targets and blocks unauthorized ones", async (t) => {
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
      input: { agent: "embedded.my-tool", prompt: "do something" },
    };
    assert.equal(await toolCall(allowedEvent, ctx), undefined);
    assert.equal(allowedEvent.input.agentScope, "user");
    assert.equal(allowedEvent.input.context, "fresh");

    const blockedEvent = {
      toolName: "subagent",
      input: { agent: "embedded.missing-tool", prompt: "blocked" },
    };
    const blockedResult = await toolCall(blockedEvent, ctx);
    assert.equal(blockedResult?.block, true);
    assert.match(blockedResult?.reason ?? "", /embedded\.missing-tool/);
    assert.match(blockedResult?.reason ?? "", /valid package: embedded \/ name: <slug>/);
    assert.match(blockedResult?.reason ?? "", /primary-agent infrastructure/);
  });
});

test("embedded subagents: architect delegates authorized targets without the retired experimental gate", async (t) => {
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
    // The retired experimental setting is absent; profile authorization is the only gate.
    await applySessionStart(ctx);

    for (const input of [
      { agent: "embedded.my-tool", prompt: "do something" },
      { tasks: [{ agent: "embedded.my-tool", prompt: "step 1" }] },
    ]) {
      const result = await toolCall({ toolName: "subagent", input }, ctx);
      assert.equal(
        result,
        undefined,
        `authorized target should be allowed: ${JSON.stringify(input)}`,
      );
      assert.equal(input.agentScope, "user");
      assert.equal(input.context, "fresh");
    }
  });
});

test("embedded subagents: non-architect primary agents remain blocked regardless of stale settings", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
    );
    for (const selected of ["rush", "product", "bug-hunter"]) {
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

      const embeddedEvent = {
        toolName: "subagent",
        input: { agent: "embedded.my-tool", prompt: "do something" },
      };
      const result = await toolCall(embeddedEvent, ctx);
      assert.equal(result?.block, true, `expected block for ${selected}`);
      assert.match(
        result?.reason ?? "",
        new RegExp(
          `${selected === "bug-hunter" ? "Bug-Hunter" : selected[0].toUpperCase() + selected.slice(1)} may not delegate to embedded`,
          "i",
        ),
      );
      assert.match(
        result?.reason ?? "",
        /available only while architect or disabled mode is active|Rush must edit directly/i,
      );
    }
  });
});

test("embedded subagents: architect allows only profile-authorized embedded targets", async (t) => {
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
          data: { selected: "architect" },
        },
      ],
      undefined,
      { cwd: fixture.cwd },
    );
    await applySessionStart(ctx);

    const singleEvent = {
      toolName: "subagent",
      input: { agent: "embedded.my-tool", prompt: "do something" },
    };
    assert.equal(
      await toolCall(singleEvent, ctx),
      undefined,
      "single embedded target should be allowed for architect",
    );
    assert.equal(singleEvent.input.agentScope, "user");
    assert.equal(singleEvent.input.context, "fresh");

    const tasksEvent = {
      toolName: "subagent",
      input: { tasks: [{ agent: "embedded.my-tool", prompt: "step 1" }] },
    };
    assert.equal(
      await toolCall(tasksEvent, ctx),
      undefined,
      "tasks embedded target should be allowed for architect",
    );

    const missingEvent = {
      toolName: "subagent",
      input: { agent: "embedded.missing-tool", prompt: "blocked" },
    };
    const missingResult = await toolCall(missingEvent, ctx);
    assert.equal(missingResult?.block, true);
    assert.match(missingResult?.reason ?? "", /valid package: embedded \/ name: <slug>/);
    assert.match(missingResult?.reason ?? "", /embedded\.missing-tool/);
  });
});

test("embedded subagents: rush blocks embedded targets with rush-specific reason; management actions exempt", async (t) => {
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
          data: { selected: "rush" },
        },
      ],
      undefined,
      { cwd: fixture.cwd },
    );
    await applySessionStart(ctx);

    const embeddedEvent = {
      toolName: "subagent",
      input: { agent: "embedded.my-tool", prompt: "do something" },
    };
    const result = await toolCall(embeddedEvent, ctx);
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /Rush may not delegate to embedded/i);

    // Management actions are exempt
    const listEvent = { toolName: "subagent", input: { action: "list" } };
    const listResult = await toolCall(listEvent, ctx);
    // Rush resume is already blocked; management actions other than resume should not be blocked by embedded check
    // (list/get/status/interrupt/doctor should pass through normally)
    assert.notEqual(
      listResult?.reason,
      result?.reason,
      "management action should not hit embedded block",
    );
  });
});

test("embedded subagents: opaque resume keeps issue #330 behavior for product and bug-hunter", async (t) => {
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
      assert.equal(opaqueResumeEvent.input.context, "fresh");
    }
  });
});

test("embedded subagents: product blocks embedded targets with product-specific reason", async (t) => {
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
          data: { selected: "product" },
        },
      ],
      undefined,
      { cwd: fixture.cwd },
    );
    await applySessionStart(ctx);

    for (const input of [
      { agent: "embedded.my-tool", prompt: "do something" },
      { tasks: [{ agent: "embedded.my-tool", prompt: "step 1" }] },
    ]) {
      const result = await toolCall({ toolName: "subagent", input }, ctx);
      assert.equal(result?.block, true);
      assert.equal(
        result?.reason,
        "TLH Product may not delegate to embedded subagents. Embedded subagent delegation is available only while architect or disabled mode is active.",
      );
    }
  });
});

test("embedded subagents: bug-hunter blocks embedded targets with bug-hunter-specific reason", async (t) => {
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
          data: { selected: "bug-hunter" },
        },
      ],
      undefined,
      { cwd: fixture.cwd },
    );
    await applySessionStart(ctx);

    for (const input of [
      { agent: "embedded.my-tool", prompt: "do something" },
      { tasks: [{ agent: "embedded.my-tool", prompt: "step 1" }] },
    ]) {
      const result = await toolCall({ toolName: "subagent", input }, ctx);
      assert.equal(result?.block, true);
      assert.equal(
        result?.reason,
        "TLH Bug-Hunter may not delegate to embedded subagents. Embedded subagent delegation is available only while architect or disabled mode is active.",
      );
    }
  });
});

test("embedded subagents: same-name external fallback stays blocked when the profile file is missing required discovery frontmatter", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const externalAgentsDir = join(fixture.dir, "external-agents");

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify(
        {
          tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } },
          subagents: { agentDirs: [externalAgentsDir] },
        },
        null,
        2,
      )}\n`,
    );
    writeEmbeddedAgent(
      externalAgentsDir,
      "fallback.md",
      "---\nname: fallback\npackage: embedded\ndescription: External helper\n---",
    );
    writeEmbeddedAgent(
      fixture.agent,
      "fallback.md",
      "---\nname: fallback\npackage: embedded\ndescription:\n---",
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

    const blockedEvent = {
      toolName: "subagent",
      input: { agent: "embedded.fallback", prompt: "do something" },
    };
    const blockedResult = await toolCall(blockedEvent, ctx);
    assert.equal(blockedResult?.block, true);
    assert.match(blockedResult?.reason ?? "", /embedded\.fallback/);
    assert.match(blockedResult?.reason ?? "", /currently exists under/);
  });
});

test("embedded subagents: same-name external agents stay blocked and deleting profile files is observed immediately", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const externalAgentsDir = join(fixture.dir, "external-agents");

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify(
        {
          tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } },
          subagents: { agentDirs: [externalAgentsDir] },
        },
        null,
        2,
      )}\n`,
    );
    writeEmbeddedAgent(
      externalAgentsDir,
      "fallback.md",
      "---\nname: fallback\npackage: embedded\ndescription: External helper\n---",
    );
    const profilePath = writeEmbeddedAgent(
      fixture.agent,
      "fallback.md",
      "---\nname: fallback\npackage: embedded\ndescription: Profile helper\n---",
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

    const allowedEvent = {
      toolName: "subagent",
      input: { agent: "embedded.fallback", prompt: "do something" },
    };
    assert.equal(
      await toolCall(allowedEvent, ctx),
      undefined,
      "profile-owned embedded agent should be allowed",
    );

    writeFileSync(
      profilePath,
      "---\nname: fallback\npackage: bundled\ndescription: No longer embedded\n---\nbody\n",
    );

    const blockedEvent = {
      toolName: "subagent",
      input: { agent: "embedded.fallback", prompt: "do something" },
    };
    const blockedResult = await toolCall(blockedEvent, ctx);
    assert.equal(blockedResult?.block, true);
    assert.match(blockedResult?.reason ?? "", /embedded\.fallback/);
    assert.match(blockedResult?.reason ?? "", /currently exists under/);
  });
});

test("embedded subagents: same-name external agents stay blocked when the profile authorizer is a .chain.md file", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const externalAgentsDir = join(fixture.dir, "external-agents");

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify(
        {
          tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } },
          subagents: { agentDirs: [externalAgentsDir] },
        },
        null,
        2,
      )}\n`,
    );
    writeEmbeddedAgent(
      externalAgentsDir,
      "fallback.md",
      "---\nname: fallback\npackage: embedded\ndescription: External helper\n---",
    );
    writeEmbeddedAgent(
      fixture.agent,
      "fallback.chain.md",
      "---\nname: fallback\npackage: embedded\ndescription: Chain helper\n---",
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

    const blockedEvent = {
      toolName: "subagent",
      input: { agent: "embedded.fallback", prompt: "do something" },
    };
    const blockedResult = await toolCall(blockedEvent, ctx);
    assert.equal(blockedResult?.block, true);
    assert.match(blockedResult?.reason ?? "", /embedded\.fallback/);
    assert.match(blockedResult?.reason ?? "", /currently exists under/);
  });
});

test("embedded subagents: same-name external agents stay blocked when the profile authorizer is a symlink", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const externalAgentsDir = join(fixture.dir, "external-agents");

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify(
        {
          tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } },
          subagents: { agentDirs: [externalAgentsDir] },
        },
        null,
        2,
      )}\n`,
    );
    const externalAuthorizerPath = writeEmbeddedAgent(
      fixture.dir,
      "external-authorizer.md",
      "---\nname: fallback\npackage: embedded\ndescription: External authorizer\n---",
    );
    writeEmbeddedAgent(
      externalAgentsDir,
      "fallback.md",
      "---\nname: fallback\npackage: embedded\ndescription: External helper\n---",
    );
    mkdirSync(join(fixture.agent, "agents"), { recursive: true });
    symlinkSync(externalAuthorizerPath, join(fixture.agent, "agents", "fallback.md"));
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

    const blockedEvent = {
      toolName: "subagent",
      input: { agent: "embedded.fallback", prompt: "do something" },
    };
    const blockedResult = await toolCall(blockedEvent, ctx);
    assert.equal(blockedResult?.block, true);
    assert.match(blockedResult?.reason ?? "", /embedded\.fallback/);
    assert.match(blockedResult?.reason ?? "", /currently exists under/);
  });
});

test("embedded subagents: a symlinked profile agents root cannot authorize embedded targets", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const externalAgentsDir = join(fixture.dir, "external-agents");
  const profileAgentsDir = join(fixture.agent, "agents");

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify(
        {
          tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } },
          subagents: { agentDirs: [externalAgentsDir] },
        },
        null,
        2,
      )}\n`,
    );
    writeEmbeddedAgent(
      externalAgentsDir,
      "fallback.md",
      "---\nname: fallback\npackage: embedded\ndescription: External helper\n---",
    );
    symlinkSync(externalAgentsDir, profileAgentsDir, "dir");
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

    const blockedEvent = {
      toolName: "subagent",
      input: { agent: "embedded.fallback", prompt: "do something" },
    };
    const blockedResult = await toolCall(blockedEvent, ctx);
    assert.equal(blockedResult?.block, true);
    assert.match(blockedResult?.reason ?? "", /Unauthorized target\(s\): embedded\.fallback/);
    assert.match(blockedResult?.reason ?? "", /currently exists under/);
  });
});

test("embedded subagents: later same-name profile symlink collisions use upstream package normalization and block descriptions", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
    );
    const collisionCases = [
      {
        name: "fallback",
        laterFrontmatter:
          "---\nname: fallback\npackage: embedded\ndescription: Later symlink authorizer\n---",
      },
      {
        name: "normalized-package",
        laterFrontmatter:
          "---\nname: normalized-package\npackage: Embedded\ndescription: Later normalized-package symlink authorizer\n---",
      },
      {
        name: "block-description",
        laterFrontmatter:
          "---\nname: block-description\npackage: embedded\ndescription:\n  Later block-valued\n  symlink authorizer\n---",
      },
    ];
    for (const { name, laterFrontmatter } of collisionCases) {
      writeEmbeddedAgent(
        fixture.agent,
        `a/${name}.md`,
        `---\nname: ${name}\npackage: embedded\ndescription: Earlier regular authorizer\n---`,
      );
      const laterSymlinkTargetPath = writeEmbeddedAgent(
        fixture.dir,
        `later-${name}.md`,
        laterFrontmatter,
      );
      mkdirSync(join(fixture.agent, "agents", "z"), { recursive: true });
      symlinkSync(laterSymlinkTargetPath, join(fixture.agent, "agents", "z", `${name}.md`));
    }
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

    for (const { name } of collisionCases) {
      const runtimeName = `embedded.${name}`;
      const blockedResult = await toolCall(
        { toolName: "subagent", input: { agent: runtimeName, prompt: "blocked" } },
        ctx,
      );
      assert.equal(
        blockedResult?.block,
        true,
        `${runtimeName} should bind to the later symlink definition`,
      );
      assert.match(blockedResult?.reason ?? "", new RegExp(runtimeName.replace(".", "\\.")));
    }
  });
});

test("embedded subagents: a later valid regular profile definition supersedes an earlier same-name symlink collision", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
    );
    const earlierSymlinkTargetPath = writeEmbeddedAgent(
      fixture.dir,
      "earlier-symlink-target.md",
      "---\nname: fallback\npackage: embedded\ndescription: Earlier symlink authorizer\n---",
    );
    mkdirSync(join(fixture.agent, "agents", "a"), { recursive: true });
    symlinkSync(earlierSymlinkTargetPath, join(fixture.agent, "agents", "a", "fallback.md"));
    writeEmbeddedAgent(
      fixture.agent,
      "z/fallback.md",
      "---\nname: fallback\npackage: embedded\ndescription: Later regular authorizer\n---",
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

    assert.equal(
      await toolCall(
        { toolName: "subagent", input: { agent: "embedded.fallback", prompt: "allowed" } },
        ctx,
      ),
      undefined,
    );
  });
});

test("embedded subagents: definitions beneath nested .agents/skills paths do not supersede an earlier same-name symlink", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
    );
    const earlierSymlinkTargetPath = writeEmbeddedAgent(
      fixture.dir,
      "legacy-skill-collision-target.md",
      "---\nname: fallback\npackage: embedded\ndescription: Earlier symlink definition\n---",
    );
    mkdirSync(join(fixture.agent, "agents", "a"), { recursive: true });
    symlinkSync(earlierSymlinkTargetPath, join(fixture.agent, "agents", "a", "fallback.md"));
    writeEmbeddedAgent(
      fixture.agent,
      "z/.agents/skills/fallback.md",
      "---\nname: fallback\npackage: embedded\ndescription: Excluded legacy skill definition\n---",
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

    const blockedResult = await toolCall(
      { toolName: "subagent", input: { agent: "embedded.fallback", prompt: "blocked" } },
      ctx,
    );
    assert.equal(blockedResult?.block, true);
    assert.match(blockedResult?.reason ?? "", /embedded\.fallback/);
  });
});

test("embedded subagents: malformed or unreadable profile files fail closed", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
    );
    writeEmbeddedAgent(
      fixture.agent,
      "broken-uppercase.md",
      "---\nname: My-Tool\npackage: embedded\ndescription: Broken helper\n---",
    );
    writeEmbeddedAgent(
      fixture.agent,
      "broken-package.md",
      "---\nname: other-tool\npackage: bundled\ndescription: Wrong package\n---",
    );
    symlinkSync(
      join(fixture.agent, "missing-target.md"),
      join(fixture.agent, "agents", "missing-file.md"),
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

    for (const target of ["embedded.my-tool", "embedded.other-tool", "embedded.missing-file"]) {
      const result = await toolCall(
        { toolName: "subagent", input: { agent: target, prompt: "blocked" } },
        ctx,
      );
      assert.equal(result?.block, true, `${target} should fail closed`);
      assert.match(result?.reason ?? "", /currently exists under/);
    }
  });
});

test("embedded subagents: retired settings do not gate authorized targets across turns", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeEmbeddedAgent(
      fixture.agent,
      "my-tool.md",
      "---\nname: my-tool\npackage: embedded\ndescription: Trusted helper\n---",
    );
    const { applySessionStart, beforeAgentStart, toolCall } = registerRuntimeHarness({
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
    await beforeAgentStart({ systemPrompt: "base" }, ctx);

    // A legacy setting may be edited during the session, but it is no longer a runtime gate.
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
    );
    await beforeAgentStart({ systemPrompt: "base" }, ctx);

    const embeddedEvent = {
      toolName: "subagent",
      input: { agent: "embedded.my-tool", prompt: "do something" },
    };
    assert.equal(await toolCall(embeddedEvent, ctx), undefined);
    assert.equal(embeddedEvent.input.agentScope, "user");
    assert.equal(embeddedEvent.input.context, "fresh");
  });
});

test("embedded subagents: disabling a retired setting does not close the authorization path", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
    );
    writeEmbeddedAgent(
      fixture.agent,
      "my-tool.md",
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
    await applySessionStart(ctx);

    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [] } } }, null, 2)}\n`,
    );

    const embeddedEvent = {
      toolName: "subagent",
      input: { agent: "embedded.my-tool", prompt: "do something" },
    };
    assert.equal(
      await toolCall(embeddedEvent, ctx),
      undefined,
      "removing the retired setting must not close the embedded authorization path",
    );
    assert.equal(embeddedEvent.input.agentScope, "user");
    assert.equal(embeddedEvent.input.context, "fresh");
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

    // Normal developer target should still be blocked (wrong context, but not an embedded block)
    const normalEvent = { toolName: "subagent", input: { agent: "developer", context: "resume" } };
    const result = await toolCall(normalEvent, ctx);
    assert.equal(result?.block, true);
    // Reason should be about context, not embedded targeting
    assert.match(result?.reason ?? "", /context.*resume|resume.*context/i);
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

    // Rush resume still blocked
    const resumeEvent = { toolName: "subagent", input: { action: "resume", id: "run-123" } };
    const resumeResult = await toolCall(resumeEvent, rushCtx);
    assert.equal(resumeResult?.block, true);
    assert.match(resumeResult?.reason ?? "", /Rush may not use subagent action=resume/);

    // Rush developer still blocked
    const developerEvent = {
      toolName: "subagent",
      input: { agent: "developer", prompt: "implement this" },
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

test("embedded subagents: multi-turn legacy setting changes do not gate authorized delegation", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeEmbeddedAgent(
      fixture.agent,
      "my-tool.md",
      "---\nname: my-tool\npackage: embedded\ndescription: Trusted helper\n---",
    );
    const { applySessionStart, beforeAgentStart, toolCall } = registerRuntimeHarness({
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
    await beforeAgentStart({ systemPrompt: "base" }, ctx);

    // A legacy setting may change mid-session without gating the authorized target.
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
    );

    await beforeAgentStart({ systemPrompt: "base" }, ctx);

    const embeddedEvent = {
      toolName: "subagent",
      input: { agent: "embedded.my-tool", prompt: "do something" },
    };
    assert.equal(await toolCall(embeddedEvent, ctx), undefined);
    assert.equal(embeddedEvent.input.agentScope, "user");
    assert.equal(embeddedEvent.input.context, "fresh");
  });
});

test("embedded subagents: multi-turn removal of a retired setting preserves authorization", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
    );
    writeEmbeddedAgent(
      fixture.agent,
      "my-tool.md",
      "---\nname: my-tool\npackage: embedded\ndescription: Trusted helper\n---",
    );
    const { applySessionStart, beforeAgentStart, toolCall } = registerRuntimeHarness({
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
    await beforeAgentStart({ systemPrompt: "base" }, ctx);

    // Mid-session: remove the retired setting.
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [] } } }, null, 2)}\n`,
    );

    // A second turn must continue to use the profile authorization path.
    await beforeAgentStart({ systemPrompt: "base" }, ctx);

    const embeddedEvent = {
      toolName: "subagent",
      input: { agent: "embedded.my-tool", prompt: "do something" },
    };
    assert.equal(
      await toolCall(embeddedEvent, ctx),
      undefined,
      "removing the retired setting must not close the embedded authorization path",
    );
    assert.equal(embeddedEvent.input.agentScope, "user");
    assert.equal(embeddedEvent.input.context, "fresh");
  });
});

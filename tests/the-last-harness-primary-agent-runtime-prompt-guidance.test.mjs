import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { PRIMARY_AGENT_SESSION_STATE_ENTRY } from "../extensions/the-last-harness-primary-agent.mjs";
import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";
import {
  CI_FAILURE_INVESTIGATION_FEATURE,
  DELTA_FOLLOW_UP_REVIEWS_FEATURE,
  registerTlhPrimaryAgentRuntime,
  createPiHarness,
  createToolCallContext,
  registerRuntimeHarness,
  selectablePrimaryAgents,
  contrarianMetadata,
} from "./the-last-harness-primary-agent-runtime-test-helpers.mjs";

test("child runtime scopes tickets at session start", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv(
    { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, TICKETS_DIR: undefined },
    async () => {
      const pi = createPiHarness();
      const runtime = registerTlhPrimaryAgentRuntime(pi, {
        env: { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_CHILD_AGENT: "developer" },
      });
      assert.equal(runtime, undefined);
      const sessionStart = pi.events.find((event) => event.name === "session_start")?.handler;
      assert.equal(typeof sessionStart, "function");

      await sessionStart({}, { cwd: fixture.cwd });
      assert.equal(process.env.TICKETS_DIR, join(fixture.cwd, ".tickets"));
    },
  );
});

test("disabled primary mode still injects provider-aware subagent models", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { toolCall } = registerRuntimeHarness();
    const event = { toolName: "subagent", input: { agent: "developer", context: "resume" } };
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

    assert.equal(await toolCall(event, ctx), undefined);
    assert.equal(event.input.model, "openai-codex/gpt-5.6-luna:max");
    assert.equal(Object.hasOwn(event.input, "thinking"), false);
    assert.equal(event.input.agentScope, undefined);
    assert.equal(event.input.context, "resume");
  });
});

test("disabled primary mode allows contrarian by default and ignores stale contrarian experimental settings", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const subagentMetadata = [contrarianMetadata()];
  const branchEntries = [
    {
      type: "custom",
      customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
      data: { selected: "disabled" },
    },
  ];
  const ctx = createToolCallContext(branchEntries, undefined, {
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
      input: {
        agent: "contrarian",
        prompt: "stress-test this plan",
        agentScope: "project",
        context: "resume",
      },
    };
    assert.equal(await toolCall(defaultEvent, ctx), undefined);
    assert.equal(defaultEvent.input.model, "anthropic/claude-opus-5");
    assert.equal(defaultEvent.input.agentScope, "project");
    assert.equal(defaultEvent.input.context, "resume");

    for (const enabledFeatures of [["Contrarian", 123], ["Contrarian"], ["contrarian"]]) {
      writeFileSync(
        join(fixture.agent, "settings.json"),
        `${JSON.stringify({ tlh: { experimental: { enabledFeatures } } }, null, 2)}\n`,
      );
      const staleEvent = {
        toolName: "subagent",
        input: {
          agent: "contrarian",
          prompt: "stress-test this plan",
          agentScope: "project",
          context: "resume",
        },
      };
      assert.equal(await toolCall(staleEvent, ctx), undefined);
      assert.equal(staleEvent.input.model, "anthropic/claude-opus-5");
      assert.equal(staleEvent.input.agentScope, "project");
      assert.equal(staleEvent.input.context, "resume");
    }
  });
});

test("disabled primary mode allows opaque resume regardless of stale contrarian settings", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const branchEntries = [
    {
      type: "custom",
      customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
      data: { selected: "disabled" },
    },
  ];
  const ctx = createToolCallContext(branchEntries, undefined, { cwd: fixture.cwd });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { toolCall } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata: [],
    });
    const opaqueResumeEvent = {
      toolName: "subagent",
      input: {
        action: "resume",
        id: "run-123",
        message: "Continue the approved ticket.",
        agentScope: "",
        context: "",
      },
    };
    assert.equal(await toolCall(opaqueResumeEvent, ctx), undefined);
    assert.equal(opaqueResumeEvent.input.agentScope, "user");
    assert.equal(opaqueResumeEvent.input.context, "fresh");

    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: ["contrarian"] } } }, null, 2)}\n`,
    );
    const allowedResumeEvent = {
      toolName: "subagent",
      input: {
        action: "resume",
        id: "run-456",
        message: "Continue the approved ticket.",
        agentScope: "both",
      },
    };
    assert.equal(await toolCall(allowedResumeEvent, ctx), undefined);
    assert.equal(allowedResumeEvent.input.agentScope, "user");
    assert.equal(allowedResumeEvent.input.context, "fresh");
  });
});

test("enabled primary mode validates subagent input after injecting provider-aware models", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { toolCall } = registerRuntimeHarness();
    const event = { toolName: "subagent", input: { agent: "developer", context: "resume" } };
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

    const result = await toolCall(event, ctx);
    assert.deepEqual(result, {
      block: true,
      reason:
        'TLH primary-agent subagent execution may not use context: "resume". TLH child sessions must start fresh so parent primary-agent/Gnosis context is not leaked.',
    });
    assert.equal(event.input.model, "openai-codex/gpt-5.6-luna:max");
    assert.equal(Object.hasOwn(event.input, "thinking"), false);
    assert.equal(event.input.agentScope, "user");
  });
});

test("before_agent_start adds TLH commit attribution guidance only when enabled", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { beforeAgentStart } = registerRuntimeHarness();
    const enabledPrompt = await beforeAgentStart(
      { systemPrompt: "base prompt" },
      createToolCallContext([], undefined, { cwd: fixture.cwd }),
    );
    assert.match(enabledPrompt.systemPrompt, /## TLH Git Commit Attribution/);
    assert.match(
      enabledPrompt.systemPrompt,
      /Co-authored-by: The Last Harness <hi@thelastharness\.com>/,
    );
    assert.match(enabledPrompt.systemPrompt, /blank line/);

    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`,
    );
    const disabledPrompt = await beforeAgentStart(
      { systemPrompt: "base prompt" },
      createToolCallContext([], undefined, { cwd: fixture.cwd }),
    );
    assert.doesNotMatch(disabledPrompt.systemPrompt, /## TLH Git Commit Attribution/);
  });
});

test("before_agent_start includes permanent architect final-validation guidance and ignores stale tlh.experimental settings", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { beforeAgentStart } = registerRuntimeHarness();
    const assertValidationWorkflow = (systemPrompt) => {
      assert.match(systemPrompt, /final-validation ticket.*depends on all implementation tickets/i);
      assert.match(systemPrompt, /implementation-ticket validation narrow and ticket-scoped/i);
      assert.match(
        systemPrompt,
        /VALIDATING\.md.*otherwise use repo-discovered validation commands/i,
      );
      assert.match(systemPrompt, /Make any validation deferral explicit in the ticket text/i);
      assert.doesNotMatch(systemPrompt, /## TLH Experimental Feature:/);
    };

    const defaultPrompt = await beforeAgentStart(
      { systemPrompt: "base prompt" },
      createToolCallContext([], undefined, { cwd: fixture.cwd }),
    );
    assertValidationWorkflow(defaultPrompt.systemPrompt);

    for (const experimental of [
      { enabledFeatures: true },
      { enabledFeatures: [123] },
      { enabledFeatures: [] },
      { enabledFeatures: ["legacy-flag"] },
    ]) {
      writeFileSync(
        join(fixture.agent, "settings.json"),
        `${JSON.stringify({ tlh: { experimental } }, null, 2)}\n`,
      );
      const prompt = await beforeAgentStart(
        { systemPrompt: "base prompt" },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      );
      assertValidationWorkflow(prompt.systemPrompt);
    }
  });
});

test("before_agent_start gates delta follow-up review guidance behind isolated TLH settings for architect", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { beforeAgentStart } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata: [],
    });
    const defaultPrompt = await beforeAgentStart(
      { systemPrompt: "base prompt" },
      createToolCallContext([], undefined, { cwd: fixture.cwd }),
    );
    assert.doesNotMatch(
      defaultPrompt.systemPrompt,
      /## TLH Experimental Feature: delta-follow-up-reviews/,
    );
    assert.doesNotMatch(
      defaultPrompt.systemPrompt,
      /default the follow-up `code-reviewer` request to the delta since the last reviewed checkpoint/i,
    );
    assert.doesNotMatch(
      defaultPrompt.systemPrompt,
      /prior findings.*git range or checkpoint.*changed-file list/i,
    );
    assert.doesNotMatch(defaultPrompt.systemPrompt, /targeted wider review or full re-review/i);

    for (const enabledFeatures of [true, [123]]) {
      writeFileSync(
        join(fixture.agent, "settings.json"),
        `${JSON.stringify({ tlh: { experimental: { enabledFeatures } } }, null, 2)}\n`,
      );
      const malformedPrompt = await beforeAgentStart(
        { systemPrompt: "base prompt" },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      );
      assert.doesNotMatch(
        malformedPrompt.systemPrompt,
        /## TLH Experimental Feature: delta-follow-up-reviews/,
      );
      assert.doesNotMatch(
        malformedPrompt.systemPrompt,
        /default the follow-up `code-reviewer` request to the delta since the last reviewed checkpoint/i,
      );
      assert.doesNotMatch(malformedPrompt.systemPrompt, /targeted wider review or full re-review/i);
    }

    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [DELTA_FOLLOW_UP_REVIEWS_FEATURE] } } }, null, 2)}\n`,
    );
    const enabledPrompt = await beforeAgentStart(
      { systemPrompt: "base prompt" },
      createToolCallContext([], undefined, { cwd: fixture.cwd }),
    );
    assert.match(
      enabledPrompt.systemPrompt,
      /## TLH Experimental Feature: delta-follow-up-reviews/,
    );
    assert.match(
      enabledPrompt.systemPrompt,
      /default the follow-up `code-reviewer` request to the delta since the last reviewed checkpoint/i,
    );
    assert.match(
      enabledPrompt.systemPrompt,
      /prior findings.*git range or checkpoint.*changed-file list/i,
    );
    assert.match(enabledPrompt.systemPrompt, /targeted wider review or full re-review/i);
  });
});

test("before_agent_start gates ci failure investigation guidance behind isolated TLH settings for architect only", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { beforeAgentStart } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata: [],
    });
    const defaultPrompt = await beforeAgentStart(
      { systemPrompt: "base prompt" },
      createToolCallContext([], undefined, { cwd: fixture.cwd }),
    );
    assert.doesNotMatch(
      defaultPrompt.systemPrompt,
      /## TLH Experimental Feature: ci-failure-investigation/,
    );
    assert.doesNotMatch(
      defaultPrompt.systemPrompt,
      /read-only investigation before asking the user whether to proceed/i,
    );

    for (const enabledFeatures of [true, [123]]) {
      writeFileSync(
        join(fixture.agent, "settings.json"),
        `${JSON.stringify({ tlh: { experimental: { enabledFeatures } } }, null, 2)}\n`,
      );
      const malformedPrompt = await beforeAgentStart(
        { systemPrompt: "base prompt" },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      );
      assert.doesNotMatch(
        malformedPrompt.systemPrompt,
        /## TLH Experimental Feature: ci-failure-investigation/,
      );
      assert.doesNotMatch(
        malformedPrompt.systemPrompt,
        /read-only investigation before asking the user whether to proceed/i,
      );
    }

    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [CI_FAILURE_INVESTIGATION_FEATURE] } } }, null, 2)}\n`,
    );
    const architectPrompt = await beforeAgentStart(
      { systemPrompt: "base prompt" },
      createToolCallContext([], undefined, { cwd: fixture.cwd }),
    );
    assert.match(
      architectPrompt.systemPrompt,
      /## TLH Experimental Feature: ci-failure-investigation/,
    );
    assert.match(
      architectPrompt.systemPrompt,
      /This TLH experiment is enabled for the architect primary agent/i,
    );
    assert.match(
      architectPrompt.systemPrompt,
      /overrides the default post-PR monitor-and-ask-only step/i,
    );
    assert.match(
      architectPrompt.systemPrompt,
      /read-only investigation before asking the user whether to proceed/i,
    );
    assert.match(
      architectPrompt.systemPrompt,
      /Do not edit files, commit, push, rerun jobs, change the PR/i,
    );
    assert.match(
      architectPrompt.systemPrompt,
      /edits, commits, pushes, reruns, PR changes, or other follow-up changes/i,
    );
    assert.match(architectPrompt.systemPrompt, /ask for explicit user approval/i);

    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify(
        {
          tlh: {
            primaryAgent: { selected: "rush" },
            experimental: { enabledFeatures: [CI_FAILURE_INVESTIGATION_FEATURE] },
          },
        },
        null,
        2,
      )}\n`,
    );
    const rushPrompt = await beforeAgentStart(
      { systemPrompt: "base prompt" },
      createToolCallContext([], undefined, { cwd: fixture.cwd }),
    );
    assert.doesNotMatch(
      rushPrompt.systemPrompt,
      /## TLH Experimental Feature: ci-failure-investigation/,
    );
    assert.doesNotMatch(rushPrompt.systemPrompt, /This TLH experiment is enabled for TLH Rush/i);
    assert.doesNotMatch(
      rushPrompt.systemPrompt,
      /read-only investigation before asking the user whether to proceed/i,
    );
    assert.doesNotMatch(
      rushPrompt.systemPrompt,
      /summarize the failure and likely cause, then ask the user whether to proceed/i,
    );
  });
});

test("before_agent_start ci-failure-investigation guidance stays per-turn: enabling mid-session takes effect on the next turn", async (t) => {
  // Guards against regressing prompt-only experimental features to session-start semantics.
  // Unlike the embedded-subagents gate (once-per-session snapshot), delta-follow-up-reviews and
  // ci-failure-investigation guidance must read settings fresh each turn, matching pre-feature main.
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { beforeAgentStart, applySessionStart } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata: [],
    });
    const ctx = createToolCallContext([], undefined, { cwd: fixture.cwd });

    // Turn 1: session start + first before_agent_start with the feature OFF (no settings file).
    await applySessionStart(ctx);
    const offPrompt = await beforeAgentStart({ systemPrompt: "base prompt" }, ctx);
    assert.doesNotMatch(
      offPrompt.systemPrompt,
      /## TLH Experimental Feature: ci-failure-investigation/,
    );
    assert.doesNotMatch(
      offPrompt.systemPrompt,
      /read-only investigation before asking the user whether to proceed/i,
    );

    // Enable the feature mid-session.
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [CI_FAILURE_INVESTIGATION_FEATURE] } } }, null, 2)}\n`,
    );

    // Turn 2: a second before_agent_start (no new session start) must now surface the guidance,
    // because prompt-only experimental features read settings fresh every turn.
    const onPrompt = await beforeAgentStart({ systemPrompt: "base prompt" }, ctx);
    assert.match(onPrompt.systemPrompt, /## TLH Experimental Feature: ci-failure-investigation/);
    assert.match(
      onPrompt.systemPrompt,
      /read-only investigation before asking the user whether to proceed/i,
    );
  });
});

test("before_agent_start includes contrarian guidance by default and ignores stale contrarian experimental settings", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const subagentMetadata = [
    { name: "developer", description: "Implements exactly one approved task at a time." },
    contrarianMetadata(),
  ];

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { beforeAgentStart } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata,
    });
    const architectCtx = createToolCallContext(
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
    const defaultPrompt = await beforeAgentStart({ systemPrompt: "base prompt" }, architectCtx);
    assert.doesNotMatch(defaultPrompt.systemPrompt, /## TLH Experimental Feature: contrarian/);
    assert.match(
      defaultPrompt.systemPrompt,
      /- contrarian: Stress-tests plans, designs, and conclusions by steelmanning the strongest opposing case\./i,
    );
    assert.match(
      defaultPrompt.systemPrompt,
      /developer: Implements exactly one approved task at a time\./i,
    );

    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: ["Contrarian", 123] } } }, null, 2)}\n`,
    );
    const malformedPrompt = await beforeAgentStart({ systemPrompt: "base prompt" }, architectCtx);
    assert.doesNotMatch(malformedPrompt.systemPrompt, /## TLH Experimental Feature: contrarian/);
    assert.match(
      malformedPrompt.systemPrompt,
      /- contrarian: Stress-tests plans, designs, and conclusions by steelmanning the strongest opposing case\./i,
    );
    assert.match(
      malformedPrompt.systemPrompt,
      /developer: Implements exactly one approved task at a time\./i,
    );

    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: ["contrarian"] } } }, null, 2)}\n`,
    );
    const legacyFlagPrompt = await beforeAgentStart({ systemPrompt: "base prompt" }, architectCtx);
    assert.doesNotMatch(legacyFlagPrompt.systemPrompt, /## TLH Experimental Feature: contrarian/);
    assert.match(
      legacyFlagPrompt.systemPrompt,
      /- contrarian: Stress-tests plans, designs, and conclusions by steelmanning the strongest opposing case\./i,
    );
  });
});

test("child mode keeps parent-only controls disabled while applying commit attribution prompt and bash guard", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    const runtime = registerTlhPrimaryAgentRuntime(pi, { env: { PI_SUBAGENT_CHILD: "1" } });
    assert.equal(runtime, undefined);
    assert.deepEqual([...pi.commands.keys()], []);
    assert.deepEqual([...pi.shortcuts.keys()], []);
    assert.deepEqual(
      pi.events.map((event) => event.name),
      ["session_start", "before_agent_start", "tool_call"],
    );

    const beforeAgentStart = pi.events.find(
      (event) => event.name === "before_agent_start",
    )?.handler;
    const toolCall = pi.events.find((event) => event.name === "tool_call")?.handler;
    assert.equal(typeof beforeAgentStart, "function");
    assert.equal(typeof toolCall, "function");

    const enabledPrompt = await beforeAgentStart(
      { systemPrompt: "base prompt" },
      createToolCallContext([], undefined, { cwd: fixture.cwd }),
    );
    assert.match(enabledPrompt.systemPrompt, /## TLH Git Commit Attribution/);
    assert.match(
      enabledPrompt.systemPrompt,
      /Co-authored-by: The Last Harness <hi@thelastharness\.com>/,
    );
    assert.match(enabledPrompt.systemPrompt, /blank line/);

    const blockedCommit = await toolCall(
      { toolName: "bash", input: { command: 'git commit -m "ship it"' } },
      createToolCallContext([], undefined, { cwd: fixture.cwd }),
    );
    assert.equal(blockedCommit?.block, true);
    assert.match(blockedCommit?.reason ?? "", /TLH attribution footer/);

    const childSubagentCall = {
      toolName: "subagent",
      input: { agent: "developer", context: "resume" },
    };
    assert.equal(
      await toolCall(childSubagentCall, createToolCallContext([], undefined, { cwd: fixture.cwd })),
      undefined,
    );
    assert.equal(childSubagentCall.input.agentScope, undefined);
    assert.equal(childSubagentCall.input.context, "resume");

    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { attribution: { commit: false } } }, null, 2)}\n`,
    );
    const disabledPrompt = await beforeAgentStart(
      { systemPrompt: "base prompt" },
      createToolCallContext([], undefined, { cwd: fixture.cwd }),
    );
    assert.doesNotMatch(disabledPrompt.systemPrompt, /## TLH Git Commit Attribution/);
    assert.equal(
      await toolCall(
        { toolName: "bash", input: { command: 'git commit -m "ship it"' } },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      ),
      undefined,
    );
  });
});

test("child mode gates delta follow-up review guidance to enabled code-reviewer sessions", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const codeReviewerPi = createPiHarness();
    registerTlhPrimaryAgentRuntime(codeReviewerPi, {
      env: { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_CHILD_AGENT: "code-reviewer" },
    });
    const codeReviewerBeforeAgentStart = codeReviewerPi.events.find(
      (event) => event.name === "before_agent_start",
    )?.handler;
    assert.equal(typeof codeReviewerBeforeAgentStart, "function");

    const defaultPrompt = await codeReviewerBeforeAgentStart(
      { systemPrompt: "base prompt" },
      createToolCallContext([], undefined, { cwd: fixture.cwd }),
    );
    assert.doesNotMatch(
      defaultPrompt.systemPrompt,
      /## TLH Experimental Feature: delta-follow-up-reviews/,
    );
    assert.doesNotMatch(
      defaultPrompt.systemPrompt,
      /expect prior findings plus an exact delta baseline/i,
    );
    assert.doesNotMatch(
      defaultPrompt.systemPrompt,
      /default to the requested delta and prior findings/i,
    );
    assert.doesNotMatch(
      defaultPrompt.systemPrompt,
      /requested delta cannot be validated safely without wider context/i,
    );

    for (const enabledFeatures of [true, [123]]) {
      writeFileSync(
        join(fixture.agent, "settings.json"),
        `${JSON.stringify({ tlh: { experimental: { enabledFeatures } } }, null, 2)}\n`,
      );
      const malformedPrompt = await codeReviewerBeforeAgentStart(
        { systemPrompt: "base prompt" },
        createToolCallContext([], undefined, { cwd: fixture.cwd }),
      );
      assert.doesNotMatch(
        malformedPrompt.systemPrompt,
        /## TLH Experimental Feature: delta-follow-up-reviews/,
      );
      assert.doesNotMatch(
        malformedPrompt.systemPrompt,
        /expect prior findings plus an exact delta baseline/i,
      );
      assert.doesNotMatch(
        malformedPrompt.systemPrompt,
        /default to the requested delta and prior findings/i,
      );
      assert.doesNotMatch(
        malformedPrompt.systemPrompt,
        /requested delta cannot be validated safely without wider context/i,
      );
    }

    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [DELTA_FOLLOW_UP_REVIEWS_FEATURE] } } }, null, 2)}\n`,
    );
    const enabledPrompt = await codeReviewerBeforeAgentStart(
      { systemPrompt: "base prompt" },
      createToolCallContext([], undefined, { cwd: fixture.cwd }),
    );
    assert.match(
      enabledPrompt.systemPrompt,
      /## TLH Experimental Feature: delta-follow-up-reviews/,
    );
    assert.match(enabledPrompt.systemPrompt, /expect prior findings plus an exact delta baseline/i);
    assert.match(enabledPrompt.systemPrompt, /default to the requested delta and prior findings/i);
    assert.match(
      enabledPrompt.systemPrompt,
      /requested delta cannot be validated safely without wider context/i,
    );

    const developerPi = createPiHarness();
    registerTlhPrimaryAgentRuntime(developerPi, {
      env: { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_CHILD_AGENT: "developer" },
    });
    const developerBeforeAgentStart = developerPi.events.find(
      (event) => event.name === "before_agent_start",
    )?.handler;
    assert.equal(typeof developerBeforeAgentStart, "function");
    const developerPrompt = await developerBeforeAgentStart(
      { systemPrompt: "base prompt" },
      createToolCallContext([], undefined, { cwd: fixture.cwd }),
    );
    assert.doesNotMatch(
      developerPrompt.systemPrompt,
      /## TLH Experimental Feature: delta-follow-up-reviews/,
    );
    assert.doesNotMatch(
      developerPrompt.systemPrompt,
      /expect prior findings plus an exact delta baseline/i,
    );
    assert.doesNotMatch(
      developerPrompt.systemPrompt,
      /default to the requested delta and prior findings/i,
    );
    assert.doesNotMatch(
      developerPrompt.systemPrompt,
      /requested delta cannot be validated safely without wider context/i,
    );
  });
});

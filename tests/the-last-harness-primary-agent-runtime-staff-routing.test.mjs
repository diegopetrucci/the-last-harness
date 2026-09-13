import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { PRIMARY_AGENT_SESSION_STATE_ENTRY } from "../extensions/the-last-harness-primary-agent.mjs";
import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";
import {
  createToolCallContext,
  developerMetadata,
  registerRuntimeHarness,
  selectablePrimaryAgents,
  staffDeveloperMetadata,
} from "./the-last-harness-primary-agent-runtime-test-helpers.mjs";

const PRIMARY_AGENT_BRANCH = [
  {
    type: "custom",
    customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
    data: { selected: "architect" },
  },
];

function model(provider, id) {
  return {
    provider,
    id,
    reasoning: true,
    thinkingLevelMap: { low: "low", medium: "medium", max: "max" },
  };
}

function writeSettings(agentDir, settings = {}) {
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

function staffSettings(overrides = {}) {
  return {
    tlh: {
      experimental: { enabledFeatures: ["staff-developer-routing"] },
    },
    ...overrides,
  };
}

function assertNoActualRole(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) assertNoActualRole(entry);
    return;
  }
  assert.equal(Object.hasOwn(value, "actualRole"), false);
  for (const entry of Object.values(value)) assertNoActualRole(entry);
}

function runtimeOptions() {
  return {
    primaryAgents: selectablePrimaryAgents(),
    subagentMetadata: [developerMetadata(), staffDeveloperMetadata()],
  };
}

function contextFor(fixture, notifications, provider, id, availableModels) {
  return createToolCallContext(PRIMARY_AGENT_BRANCH, notifications, {
    cwd: fixture.cwd,
    model: model(provider, id),
    modelRegistry: { getAvailable: () => availableModels },
  });
}

test("staff-developer remains disabled by default and is not rewritten", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-staff-runtime-", { cwd: true, test: t });
  const notifications = [];
  writeSettings(fixture.agent, {});

  await withEnv(
    { HOME: fixture.home, USERPROFILE: fixture.home, PI_CODING_AGENT_DIR: fixture.agent },
    async () => {
      const { toolCall } = registerRuntimeHarness(runtimeOptions());
      const event = {
        toolName: "subagent",
        input: { agent: "staff-developer", task: "Implement the approved ticket" },
      };
      const result = await toolCall(
        event,
        contextFor(fixture, notifications, "openai-codex", "gpt-5.6-luna", [
          model("openai-codex", "gpt-6-astra"),
        ]),
      );

      assert.equal(result?.block, true);
      assert.match(result?.reason ?? "", /Disallowed target\(s\): staff-developer/);
      assert.equal(event.input.agent, "staff-developer");
      assert.equal(Object.hasOwn(event.input, "model"), false);
      assert.deepEqual(notifications, []);
      assertNoActualRole(event);
    },
  );
});

test("enabled staff routing dispatches the current direct-provider candidate", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-staff-runtime-", { cwd: true, test: t });
  const notifications = [];
  writeSettings(fixture.agent, staffSettings());

  await withEnv(
    { HOME: fixture.home, USERPROFILE: fixture.home, PI_CODING_AGENT_DIR: fixture.agent },
    async () => {
      const { toolCall } = registerRuntimeHarness(runtimeOptions());
      const event = {
        toolName: "subagent",
        input: { agent: "staff-developer", task: "Implement the approved ticket" },
      };
      const result = await toolCall(
        event,
        contextFor(fixture, notifications, "openai-codex", "gpt-5.6-luna", [
          model("openai-codex", "gpt-6-astra"),
          model("openai-codex", "gpt-5.6-luna"),
        ]),
      );

      assert.equal(result, undefined);
      assert.equal(event.input.agent, "staff-developer");
      assert.equal(event.input.model, "openai-codex/gpt-6-astra:low");
      assert.equal(event.input.agentScope, "user");
      assert.deepEqual(notifications, []);
      assertNoActualRole(event);
    },
  );
});

test("qualified staff model requests preserve their provider and model identity", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-staff-runtime-", { cwd: true, test: t });
  const notifications = [];
  writeSettings(fixture.agent, staffSettings());

  await withEnv(
    { HOME: fixture.home, USERPROFILE: fixture.home, PI_CODING_AGENT_DIR: fixture.agent },
    async () => {
      const { toolCall } = registerRuntimeHarness(runtimeOptions());
      const event = {
        toolName: "subagent",
        input: {
          agent: "staff-developer",
          task: "Implement the approved ticket",
          model: "anthropic/claude-opus-5:medium",
        },
      };
      const result = await toolCall(
        event,
        contextFor(fixture, notifications, "openai-codex", "gpt-5.6-luna", [
          model("openai-codex", "gpt-6-astra"),
          model("anthropic", "claude-opus-5"),
        ]),
      );

      assert.equal(result, undefined);
      assert.equal(event.input.agent, "staff-developer");
      assert.equal(event.input.model, "anthropic/claude-opus-5:medium");
      assert.deepEqual(notifications, []);
      assertNoActualRole(event);
    },
  );
});

test("caller model inheritance downgrades staff routing before injection", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-staff-runtime-", { cwd: true, test: t });
  const notifications = [];
  writeSettings(fixture.agent, staffSettings());

  await withEnv(
    { HOME: fixture.home, USERPROFILE: fixture.home, PI_CODING_AGENT_DIR: fixture.agent },
    async () => {
      const { toolCall } = registerRuntimeHarness(runtimeOptions());
      const event = {
        toolName: "subagent",
        input: {
          agent: "staff-developer",
          task: "Implement the approved ticket",
          model: "inherit",
        },
      };
      const result = await toolCall(
        event,
        contextFor(fixture, notifications, "openai-codex", "gpt-5.6-luna", [
          model("openai-codex", "gpt-6-astra"),
          model("openai-codex", "gpt-5.6-luna"),
        ]),
      );

      assert.equal(result, undefined);
      assert.equal(event.input.agent, "developer");
      assert.equal(event.input.model, "openai-codex/gpt-5.6-luna:max");
      assert.match(notifications[0]?.message ?? "", /session model|resolvable staff-developer/i);
      assertNoActualRole(event);
    },
  );
});

test("stored model:false downgrades staff routing before injection", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-staff-runtime-", { cwd: true, test: t });
  const notifications = [];
  writeSettings(fixture.agent, {
    ...staffSettings(),
    subagents: {
      agentOverrides: {
        "staff-developer": { model: false },
      },
    },
  });

  await withEnv(
    { HOME: fixture.home, USERPROFILE: fixture.home, PI_CODING_AGENT_DIR: fixture.agent },
    async () => {
      const { toolCall } = registerRuntimeHarness(runtimeOptions());
      const event = {
        toolName: "subagent",
        input: { agent: "staff-developer", task: "Implement the approved ticket" },
      };
      const result = await toolCall(
        event,
        contextFor(fixture, notifications, "openai-codex", "gpt-5.6-luna", [
          model("openai-codex", "gpt-6-astra"),
          model("openai-codex", "gpt-5.6-luna"),
        ]),
      );

      assert.equal(result, undefined);
      assert.equal(event.input.agent, "developer");
      assert.equal(event.input.model, "openai-codex/gpt-5.6-luna:max");
      assert.match(notifications[0]?.message ?? "", /session model|resolvable staff-developer/i);
      assertNoActualRole(event);
    },
  );
});

test("an unavailable bundled staff model downgrades to developer and warns once", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-staff-runtime-", { cwd: true, test: t });
  const notifications = [];
  writeSettings(fixture.agent, staffSettings());
  const ctxModels = [model("openai-codex", "gpt-5.6-luna")];

  await withEnv(
    { HOME: fixture.home, USERPROFILE: fixture.home, PI_CODING_AGENT_DIR: fixture.agent },
    async () => {
      const { toolCall } = registerRuntimeHarness(runtimeOptions());
      const event = {
        toolName: "subagent",
        input: {
          agent: "staff-developer",
          task: "Implement the approved ticket",
          fallbackModels: ["openai-codex/backup"],
          modelFallbackNotice: "stale caller notice",
        },
      };
      const ctx = contextFor(fixture, notifications, "openai-codex", "gpt-5.6-luna", ctxModels);
      const result = await toolCall(event, ctx);

      assert.equal(result, undefined);
      assert.equal(event.input.agent, "developer");
      assert.equal(event.input.model, "openai-codex/gpt-5.6-luna:max");
      assert.equal(Object.hasOwn(event.input, "fallbackModels"), false);
      assert.equal(Object.hasOwn(event.input, "modelFallbackNotice"), false);
      assert.equal(
        notifications.filter(({ message }) =>
          message.includes("staff-developer routing downgraded"),
        ).length,
        1,
      );
      assert.match(notifications[0]?.message ?? "", /bundled staff-developer model/);
      assertNoActualRole(event);
    },
  );
});

test("unavailable explicit staff overrides downgrade without crossing provider families", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-staff-runtime-", { cwd: true, test: t });
  const notifications = [];
  writeSettings(
    fixture.agent,
    staffSettings({
      subagents: {
        agentOverrides: {
          "staff-developer": { model: "anthropic/missing" },
        },
      },
    }),
  );

  await withEnv(
    { HOME: fixture.home, USERPROFILE: fixture.home, PI_CODING_AGENT_DIR: fixture.agent },
    async () => {
      const { toolCall } = registerRuntimeHarness(runtimeOptions());
      const event = {
        toolName: "subagent",
        input: { agent: "staff-developer", task: "Implement the approved ticket" },
      };
      const result = await toolCall(
        event,
        contextFor(fixture, notifications, "anthropic", "claude-sonnet-4-6", [
          model("openai-codex", "gpt-6-astra"),
          model("openai-codex", "gpt-5.6-luna"),
          model("anthropic", "claude-sonnet-4-6"),
        ]),
      );

      assert.equal(result, undefined);
      assert.equal(event.input.agent, "developer");
      assert.equal(event.input.model, "anthropic/claude-sonnet-4-6:medium");
      assert.match(notifications[0]?.message ?? "", /anthropic\/missing/);
      assertNoActualRole(event);
    },
  );
});

test("project staff overrides participate in availability checks after session load", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-staff-runtime-", { cwd: true, test: t });
  const notifications = [];
  writeSettings(fixture.agent, staffSettings());
  const projectDefaultsLoader = async () => ({
    status: "loaded",
    projectRoot: fixture.cwd,
    trust: { kind: "project-config", trusted: true, source: "default-always" },
    defaults: {
      primaryAgents: {},
      subagents: { "staff-developer": { model: "openai-codex/project-staff" } },
    },
    warnings: [],
  });

  await withEnv(
    { HOME: fixture.home, USERPROFILE: fixture.home, PI_CODING_AGENT_DIR: fixture.agent },
    async () => {
      const { toolCall, applySessionStart } = registerRuntimeHarness({
        ...runtimeOptions(),
        projectAgentLoader: async () => ({ status: "unavailable" }),
        projectDefaultsLoader,
      });
      const ctx = contextFor(fixture, notifications, "openai-codex", "gpt-5.6-luna", [
        model("openai-codex", "gpt-5.6-luna"),
      ]);
      await applySessionStart(ctx);

      const event = {
        toolName: "subagent",
        input: { agent: "staff-developer", task: "Implement the approved ticket" },
      };
      const result = await toolCall(event, ctx);

      assert.equal(result, undefined);
      assert.equal(event.input.agent, "developer");
      assert.equal(event.input.model, "openai-codex/gpt-5.6-luna:max");
      assert.match(notifications[0]?.message ?? "", /openai-codex\/project-staff/);
      assertNoActualRole(event);
    },
  );
});

test("an unavailable project staff pin falls back to an available stored staff pin", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-staff-runtime-", { cwd: true, test: t });
  const notifications = [];
  writeSettings(fixture.agent, {
    ...staffSettings(),
    subagents: {
      agentOverrides: {
        "staff-developer": { model: "openai-codex/stored-staff" },
      },
    },
  });
  const projectDefaultsLoader = async () => ({
    status: "loaded",
    projectRoot: fixture.cwd,
    trust: { kind: "project-config", trusted: true, source: "default-always" },
    defaults: {
      primaryAgents: {},
      subagents: { "staff-developer": { model: "openai-codex/missing-project" } },
    },
    warnings: [],
  });

  await withEnv(
    { HOME: fixture.home, USERPROFILE: fixture.home, PI_CODING_AGENT_DIR: fixture.agent },
    async () => {
      const { toolCall, applySessionStart } = registerRuntimeHarness({
        ...runtimeOptions(),
        projectAgentLoader: async () => ({ status: "unavailable" }),
        projectDefaultsLoader,
      });
      const ctx = contextFor(fixture, notifications, "openai-codex", "gpt-5.6-luna", [
        model("openai-codex", "gpt-6-astra"),
        model("openai-codex", "gpt-5.6-luna"),
        model("openai-codex", "stored-staff"),
      ]);
      await applySessionStart(ctx);

      const event = {
        toolName: "subagent",
        input: { agent: "staff-developer", task: "Implement the approved ticket" },
      };
      const result = await toolCall(event, ctx);

      assert.equal(result, undefined);
      assert.equal(event.input.agent, "staff-developer");
      assert.equal(event.input.model, "openai-codex/stored-staff:low");
      assert.equal(
        notifications.some(({ message }) => message.includes("staff-developer routing downgraded")),
        false,
      );
      assert.match(notifications[0]?.message ?? "", /openai-codex\/missing-project/);
      assertNoActualRole(event);
    },
  );
});

test("OpenRouter requires an explicit resolvable staff model and preserves qualified requests", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-staff-runtime-", { cwd: true, test: t });
  writeSettings(fixture.agent, staffSettings());

  await withEnv(
    { HOME: fixture.home, USERPROFILE: fixture.home, PI_CODING_AGENT_DIR: fixture.agent },
    async () => {
      const firstNotifications = [];
      const first = registerRuntimeHarness(runtimeOptions());
      const firstEvent = {
        toolName: "subagent",
        input: { agent: "staff-developer", task: "Implement the approved ticket" },
      };
      const firstCtx = contextFor(
        fixture,
        firstNotifications,
        "openrouter",
        "anthropic/claude-sonnet-4-6",
        [model("openrouter", "anthropic/claude-sonnet-4-6")],
      );
      assert.equal(await first.toolCall(firstEvent, firstCtx), undefined);
      assert.equal(firstEvent.input.agent, "developer");
      assert.equal(firstEvent.input.model, "openrouter/anthropic/claude-sonnet-4-6:medium");
      assert.match(firstNotifications[0]?.message ?? "", /OpenRouter requires an explicit/);
      assertNoActualRole(firstEvent);

      const secondNotifications = [];
      const second = registerRuntimeHarness(runtimeOptions());
      const secondEvent = {
        toolName: "subagent",
        input: {
          agent: "staff-developer",
          task: "Implement the approved ticket",
          model: "openrouter/openai/gpt-6-astra",
        },
      };
      const secondCtx = contextFor(
        fixture,
        secondNotifications,
        "openrouter",
        "anthropic/claude-sonnet-4-6",
        [
          model("openrouter", "anthropic/claude-sonnet-4-6"),
          model("openrouter", "openai/gpt-6-astra"),
        ],
      );
      assert.equal(await second.toolCall(secondEvent, secondCtx), undefined);
      assert.equal(secondEvent.input.agent, "staff-developer");
      assert.equal(secondEvent.input.model, "openrouter/openai/gpt-6-astra");
      assert.deepEqual(secondNotifications, []);
      assertNoActualRole(secondEvent);
    },
  );
});

test("mixed parallel batches downgrade only unavailable staff targets", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-staff-runtime-", { cwd: true, test: t });
  const notifications = [];
  writeSettings(fixture.agent, staffSettings());

  await withEnv(
    { HOME: fixture.home, USERPROFILE: fixture.home, PI_CODING_AGENT_DIR: fixture.agent },
    async () => {
      const { toolCall } = registerRuntimeHarness(runtimeOptions());
      const event = {
        toolName: "subagent",
        input: {
          tasks: [
            { agent: "staff-developer", task: "Use the available staff candidate" },
            {
              agent: "staff-developer",
              task: "Use an unavailable explicit candidate",
              model: "openai-codex/missing",
              fallbackModels: ["openai-codex/backup"],
              modelFallbackNotice: "stale caller notice",
            },
            { agent: "developer", task: "Implement ordinary work" },
          ],
        },
      };
      const ctx = contextFor(fixture, notifications, "openai-codex", "gpt-5.6-luna", [
        model("openai-codex", "gpt-6-astra"),
        model("openai-codex", "gpt-5.6-luna"),
      ]);
      const result = await toolCall(event, ctx);

      assert.equal(result, undefined);
      assert.deepEqual(
        event.input.tasks.map(({ agent, model: requestedModel }) => ({
          agent,
          model: requestedModel,
        })),
        [
          { agent: "staff-developer", model: "openai-codex/gpt-6-astra:low" },
          { agent: "developer", model: "openai-codex/gpt-5.6-luna:max" },
          { agent: "developer", model: "openai-codex/gpt-5.6-luna:max" },
        ],
      );
      assert.equal(Object.hasOwn(event.input.tasks[1], "fallbackModels"), false);
      assert.equal(Object.hasOwn(event.input.tasks[1], "modelFallbackNotice"), false);
      assert.equal(
        notifications.filter(({ message }) =>
          message.includes("staff-developer routing downgraded"),
        ).length,
        1,
      );
      assertNoActualRole(event);
    },
  );
});

test("Bug-Hunter blocks staff-developer after developer in a parallel batch", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-staff-runtime-", { cwd: true, test: t });
  const notifications = [];
  writeSettings(fixture.agent, staffSettings());

  await withEnv(
    { HOME: fixture.home, USERPROFILE: fixture.home, PI_CODING_AGENT_DIR: fixture.agent },
    async () => {
      const { toolCall } = registerRuntimeHarness(runtimeOptions());
      const event = {
        toolName: "subagent",
        input: {
          tasks: [
            { agent: "developer", task: "Implement ordinary work" },
            { agent: "staff-developer", task: "Implement security-sensitive work" },
          ],
        },
      };
      const ctx = createToolCallContext(
        [
          {
            type: "custom",
            customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
            data: { selected: "bug-hunter" },
          },
        ],
        notifications,
        {
          cwd: fixture.cwd,
          model: model("openai-codex", "gpt-5.6-luna"),
          modelRegistry: {
            getAvailable: () => [model("openai-codex", "gpt-6-astra")],
          },
        },
      );
      const result = await toolCall(event, ctx);

      assert.equal(result?.block, true);
      assert.match(
        result?.reason ?? "",
        /Bug-Hunter may not delegate implementation to staff-developer/,
      );
      assert.deepEqual(
        event.input.tasks.map(({ agent }) => agent),
        ["developer", "staff-developer"],
      );
      assert.deepEqual(notifications, []);
    },
  );
});

test("role safeguards reject staff implementation targets outside architect mode", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-staff-runtime-", { cwd: true, test: t });
  writeSettings(fixture.agent, staffSettings());

  await withEnv(
    { HOME: fixture.home, USERPROFILE: fixture.home, PI_CODING_AGENT_DIR: fixture.agent },
    async () => {
      for (const selection of ["rush", "product", "bug-hunter"]) {
        const notifications = [];
        const { toolCall } = registerRuntimeHarness(runtimeOptions());
        const event = {
          toolName: "subagent",
          input: { agent: "staff-developer", task: "Implement the approved ticket" },
        };
        const ctx = createToolCallContext(
          [
            {
              type: "custom",
              customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
              data: { selected: selection },
            },
          ],
          notifications,
          {
            cwd: fixture.cwd,
            model: model("openai-codex", "gpt-5.6-luna"),
            modelRegistry: {
              getAvailable: () => [model("openai-codex", "gpt-6-astra")],
            },
          },
        );
        const result = await toolCall(event, ctx);

        assert.equal(result?.block, true, selection);
        assert.match(result?.reason ?? "", /staff-developer|implementation/i, selection);
        assert.equal(event.input.agent, "staff-developer", selection);
        assertNoActualRole(event);
      }
    },
  );
});

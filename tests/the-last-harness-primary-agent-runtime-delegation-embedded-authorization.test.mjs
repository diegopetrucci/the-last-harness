import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import test from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

import { PRIMARY_AGENT_SESSION_STATE_ENTRY } from "../extensions/the-last-harness-primary-agent.mjs";
import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";
import {
  registerRuntimeHarness,
  createToolCallContext,
  selectablePrimaryAgents,
  EMBEDDED_SUBAGENTS_FEATURE,
} from "./the-last-harness-primary-agent-runtime-test-helpers.mjs";

// ─── Embedded subagents (ts-42p1) ───────────────────────────────────────────

test("project execution keeps retired binding and fail-open paths absent", () => {
  const sourcePaths = [
    "extensions/the-last-harness/primary-agent-runtime.ts",
    "extensions/the-last-harness/primary-agent-runtime.js",
    "extensions/subagents/src/runs/foreground/subagent-executor.ts",
    "extensions/subagents/src/runs/foreground/subagent-executor.js",
    "extensions/subagents/src/runs/foreground/foreground-control.ts",
    "extensions/subagents/src/runs/foreground/foreground-control.js",
    "extensions/subagents/src/runs/foreground/foreground-nested-control.ts",
    "extensions/subagents/src/runs/foreground/foreground-nested-control.js",
    "extensions/subagents/src/runs/foreground/foreground-resume.ts",
    "extensions/subagents/src/runs/foreground/foreground-resume.js",
    "extensions/subagents/src/runs/foreground/foreground-run-state.ts",
    "extensions/subagents/src/runs/foreground/foreground-run-state.js",
    "extensions/subagents/src/runs/foreground/foreground-support.ts",
    "extensions/subagents/src/runs/foreground/foreground-support.js",
    "extensions/subagents/src/runs/foreground/project-agent-control.ts",
    "extensions/subagents/src/runs/foreground/project-agent-control.js",
    "extensions/the-last-harness/prompts.ts",
    "extensions/the-last-harness/prompts.js",
    "extensions/the-last-harness-subagent-safety.mjs",
  ];
  for (const relativePath of sourcePaths) {
    const source = readFileSync(join(process.cwd(), relativePath), "utf8");
    assert.doesNotMatch(
      source,
      /projectCustomBinding|ProjectCustomAgentBinding|isProjectCustomAgentBinding|ProjectCustomAgentAuthorization|loadAuthorizedEmbeddedSubagentRuntimeNames/,
      `${relativePath} must not restore retired custom binding/authorization paths`,
    );
  }
});

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
      input: { agent: "embedded.my-tool", task: "do something" },
    };
    assert.equal(await toolCall(allowedEvent, ctx), undefined);
    assert.equal(allowedEvent.input.agentScope, "project");
    assert.equal(Object.hasOwn(allowedEvent.input, "context"), false);

    const blockedEvent = {
      toolName: "subagent",
      input: { agent: "embedded.missing-tool", task: "blocked" },
    };
    const blockedResult = await toolCall(blockedEvent, ctx);
    assert.equal(blockedResult?.block, true);
    assert.match(blockedResult?.reason ?? "", /embedded\.missing-tool/);
    assert.match(
      blockedResult?.reason ?? "",
      /description|package: embedded|No validated Git worktree root|Expected \.tlh\/agents\/custom/,
    );
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
    // The retired experimental setting is absent; exact trusted Git-root authorization is the only gate.
    await applySessionStart(ctx);

    for (const input of [
      { agent: "embedded.my-tool", task: "do something" },
      { tasks: [{ agent: "embedded.my-tool", task: "step 1" }] },
    ]) {
      const result = await toolCall({ toolName: "subagent", input }, ctx);
      assert.equal(
        result,
        undefined,
        `authorized target should be allowed: ${JSON.stringify(input)}`,
      );
      assert.equal(input.agentScope, "project");
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
        input: { agent: "embedded.my-tool", task: "do something" },
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

test("embedded subagents: architect allows only root-authorized embedded targets", async (t) => {
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
      input: { agent: "embedded.my-tool", task: "do something" },
    };
    assert.equal(
      await toolCall(singleEvent, ctx),
      undefined,
      "single embedded target should be allowed for architect",
    );
    assert.equal(singleEvent.input.agentScope, "project");
    assert.equal(Object.hasOwn(singleEvent.input, "context"), false);

    const tasksEvent = {
      toolName: "subagent",
      input: { tasks: [{ agent: "embedded.my-tool", task: "step 1" }] },
    };
    assert.equal(
      await toolCall(tasksEvent, ctx),
      undefined,
      "tasks embedded target should be allowed for architect",
    );

    const missingEvent = {
      toolName: "subagent",
      input: { agent: "embedded.missing-tool", task: "blocked" },
    };
    const missingResult = await toolCall(missingEvent, ctx);
    assert.equal(missingResult?.block, true);
    assert.match(
      missingResult?.reason ?? "",
      /description|package: embedded|No validated Git worktree root|Expected \.tlh\/agents\/custom/,
    );
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
      input: { agent: "embedded.my-tool", task: "do something" },
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
      assert.equal(Object.hasOwn(opaqueResumeEvent.input, "context"), false);
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
      { agent: "embedded.my-tool", task: "do something" },
      { tasks: [{ agent: "embedded.my-tool", task: "step 1" }] },
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
      { agent: "embedded.my-tool", task: "do something" },
      { tasks: [{ agent: "embedded.my-tool", task: "step 1" }] },
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

// Negative hard-cutover coverage: the external agent directory, generic profile agents, and
// `subagents.agentDirs` fixtures below must never authorize or replace a direct root custom file.
test("embedded subagents: same-name external fallback stays blocked when the root custom file is missing required discovery frontmatter", async (t) => {
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
      input: { agent: "embedded.fallback", task: "do something" },
    };
    const blockedResult = await toolCall(blockedEvent, ctx);
    assert.equal(blockedResult?.block, true);
    assert.match(blockedResult?.reason ?? "", /embedded\.fallback/);
    assert.match(
      blockedResult?.reason ?? "",
      /description|package: embedded|No validated Git worktree root|Expected \.tlh\/agents\/custom|tombstone|profile fallback/,
    );
  });
});

test("embedded subagents: same-name external agents stay blocked while the active snapshot remains stable", async (t) => {
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
      input: { agent: "embedded.fallback", task: "do something" },
    };
    assert.equal(
      await toolCall(allowedEvent, ctx),
      undefined,
      "direct root custom embedded agent should be allowed",
    );

    writeFileSync(
      profilePath,
      "---\nname: fallback\npackage: bundled\ndescription: No longer embedded\n---\nbody\n",
    );

    const snapshotEvent = {
      toolName: "subagent",
      input: { agent: "embedded.fallback", task: "the active snapshot remains exact" },
    };
    assert.equal(
      await toolCall(snapshotEvent, ctx),
      undefined,
      "the session snapshot must retain the trusted captured definition after a source edit",
    );
    assert.equal(snapshotEvent.input.agentScope, "project");
  });
});

test("embedded subagents: same-name external agents stay blocked when the root custom filename is a .chain.md file", async (t) => {
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
      input: { agent: "embedded.fallback", task: "do something" },
    };
    const blockedResult = await toolCall(blockedEvent, ctx);
    assert.equal(blockedResult?.block, true);
    assert.match(blockedResult?.reason ?? "", /embedded\.fallback/);
    assert.match(
      blockedResult?.reason ?? "",
      /description|package: embedded|No validated Git worktree root|Expected \.tlh\/agents\/custom/,
    );
  });
});

test("embedded subagents: same-name external agents stay blocked when the generic profile symlink cannot authorize", async (t) => {
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
      input: { agent: "embedded.fallback", task: "do something" },
    };
    const blockedResult = await toolCall(blockedEvent, ctx);
    assert.equal(blockedResult?.block, true);
    assert.match(blockedResult?.reason ?? "", /embedded\.fallback/);
    assert.match(
      blockedResult?.reason ?? "",
      /description|package: embedded|No validated Git worktree root|Expected \.tlh\/agents\/custom/,
    );
  });
});

test("embedded subagents: a symlinked generic profile agents root cannot authorize embedded targets", async (t) => {
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
      input: { agent: "embedded.fallback", task: "do something" },
    };
    const blockedResult = await toolCall(blockedEvent, ctx);
    assert.equal(blockedResult?.block, true);
    assert.match(
      blockedResult?.reason ?? "",
      /(?:Target|Unauthorized) target\(s\): embedded\.fallback/,
    );
    assert.match(
      blockedResult?.reason ?? "",
      /description|package: embedded|No validated Git worktree root|Expected \.tlh\/agents\/custom/,
    );
  });
});

test("embedded subagents: generic symlink collisions cannot supersede a root custom file", async (t) => {
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
        { toolName: "subagent", input: { agent: runtimeName, task: "blocked" } },
        ctx,
      );
      assert.equal(
        blockedResult,
        undefined,
        `${runtimeName} should remain bound to the direct root custom definition`,
      );
    }
  });
});

test("embedded subagents: a later valid root custom definition supersedes an earlier same-name symlink collision", async (t) => {
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
        { toolName: "subagent", input: { agent: "embedded.fallback", task: "allowed" } },
        ctx,
      ),
      undefined,
    );
  });
});

test("embedded subagents: generic nested skill paths cannot supersede a root custom file", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { experimental: { enabledFeatures: [EMBEDDED_SUBAGENTS_FEATURE] } } }, null, 2)}\n`,
    );
    writeEmbeddedAgent(
      fixture.agent,
      "fallback.md",
      "---\nname: fallback\npackage: embedded\ndescription: Direct root custom definition\n---",
    );
    const earlierSymlinkTargetPath = writeEmbeddedAgent(
      fixture.dir,
      "legacy-skill-collision-target.md",
      "---\nname: fallback\npackage: embedded\ndescription: Earlier symlink definition\n---",
    );
    mkdirSync(join(fixture.agent, "agents", "a"), { recursive: true });
    symlinkSync(earlierSymlinkTargetPath, join(fixture.agent, "agents", "a", "fallback.md"));
    const nestedSkillPath = join(fixture.agent, "agents", "z", ".agents", "skills", "fallback.md");
    mkdirSync(dirname(nestedSkillPath), { recursive: true });
    writeFileSync(
      nestedSkillPath,
      "---\nname: fallback\npackage: embedded\ndescription: Excluded legacy skill definition\n---\nbody\n",
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

    const allowedResult = await toolCall(
      { toolName: "subagent", input: { agent: "embedded.fallback", task: "allowed" } },
      ctx,
    );
    assert.equal(allowedResult, undefined);
  });
});

test("embedded subagents: malformed or unreadable root custom files fail closed", async (t) => {
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
    mkdirSync(join(fixture.agent, "agents"), { recursive: true });
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
        { toolName: "subagent", input: { agent: target, task: "blocked" } },
        ctx,
      );
      assert.equal(result?.block, true, `${target} should fail closed`);
      assert.match(
        result?.reason ?? "",
        /description|package: embedded|No validated Git worktree root|Expected \.tlh\/agents\/custom/,
      );
    }
  });
});

test("embedded subagents: current root trust does not depend on retired settings across turns", async (t) => {
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
      input: { agent: "embedded.my-tool", task: "do something" },
    };
    assert.equal(await toolCall(embeddedEvent, ctx), undefined);
    assert.equal(embeddedEvent.input.agentScope, "project");
    assert.equal(Object.hasOwn(embeddedEvent.input, "context"), false);
  });
});

test("embedded subagents: removing retired settings does not close the root authorization path", async (t) => {
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
      input: { agent: "embedded.my-tool", task: "do something" },
    };
    assert.equal(
      await toolCall(embeddedEvent, ctx),
      undefined,
      "removing the retired setting must not close the embedded authorization path",
    );
    assert.equal(embeddedEvent.input.agentScope, "project");
    assert.equal(Object.hasOwn(embeddedEvent.input, "context"), false);
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

    // Rush resume still blocked
    const resumeEvent = { toolName: "subagent", input: { action: "resume", id: "run-123" } };
    const resumeResult = await toolCall(resumeEvent, rushCtx);
    assert.equal(resumeResult?.block, true);
    assert.match(resumeResult?.reason ?? "", /Rush may not use subagent action=resume/);

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

test("embedded subagents: multi-turn root authorization survives setting changes", async (t) => {
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
      input: { agent: "embedded.my-tool", task: "do something" },
    };
    assert.equal(await toolCall(embeddedEvent, ctx), undefined);
    assert.equal(embeddedEvent.input.agentScope, "project");
    assert.equal(Object.hasOwn(embeddedEvent.input, "context"), false);
  });
});

test("embedded subagents: multi-turn root authorization survives setting removal", async (t) => {
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

    // A second turn must continue to use the exact trusted Git-root authorization path.
    await beforeAgentStart({ systemPrompt: "base" }, ctx);

    const embeddedEvent = {
      toolName: "subagent",
      input: { agent: "embedded.my-tool", task: "do something" },
    };
    assert.equal(
      await toolCall(embeddedEvent, ctx),
      undefined,
      "removing the retired setting must not close the embedded authorization path",
    );
    assert.equal(embeddedEvent.input.agentScope, "project");
    assert.equal(Object.hasOwn(embeddedEvent.input, "context"), false);
  });
});

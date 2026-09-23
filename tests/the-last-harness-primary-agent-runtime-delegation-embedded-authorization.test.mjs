import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

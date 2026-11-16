import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { withEnv, createIsolatedProfileFixture } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const {
  NAME_SESSION_TOOL_NAME,
  NAME_SESSION_TOOL_MAX_LENGTH,
  normalizeTlhSessionName,
  registerNameSessionTool,
} = await jiti.import("../extensions/the-last-harness/session-name.ts");

const NO_CHILD_ENV = {
  PI_SUBAGENT_CHILD: undefined,
  PI_SUBAGENT_CHILD_AGENT: undefined,
};

function createToolHarness(initialName) {
  let sessionName = initialName;
  const setSessionNameCalls = [];
  const tools = new Map();
  const pi = {
    tools,
    setSessionNameCalls,
    on() {},
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    getSessionName: () => sessionName,
    setSessionName(name) {
      setSessionNameCalls.push(name);
      sessionName = name;
    },
  };
  const ctx = {
    sessionManager: {
      getSessionName: () => sessionName,
    },
  };
  return { pi, ctx, getStoredName: () => sessionName };
}

function firstText(result) {
  return result.content
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}

// ── normalization ────────────────────────────────────────────────────────────

test("normalizeTlhSessionName collapses whitespace and trims", () => {
  assert.equal(
    normalizeTlhSessionName("   Fix   the\n\tflaky installer   test  "),
    "Fix the flaky installer test",
  );
});

test("normalizeTlhSessionName strips ANSI CSI and OSC sequences", () => {
  assert.equal(normalizeTlhSessionName("\u001b[31mRed\u001b[0m session"), "Red session");
  assert.equal(
    normalizeTlhSessionName("\u001b]8;;https://example.com\u0007linked\u001b]8;;\u0007 name"),
    "linked name",
  );
});

test("normalizeTlhSessionName turns control characters into word separators", () => {
  assert.equal(normalizeTlhSessionName("a\u0000b\u007fc\u0085d"), "a b c d");
});

test("normalizeTlhSessionName caps the name on code points without splitting a surrogate pair", () => {
  const longName = normalizeTlhSessionName("x".repeat(NAME_SESSION_TOOL_MAX_LENGTH + 20));
  assert.equal(longName.length, NAME_SESSION_TOOL_MAX_LENGTH);

  const emojiName = normalizeTlhSessionName("🚀".repeat(NAME_SESSION_TOOL_MAX_LENGTH + 5));
  assert.deepEqual(Array.from(emojiName), Array.from("🚀".repeat(NAME_SESSION_TOOL_MAX_LENGTH)));
});

test("normalizeTlhSessionName returns an empty string for whitespace, control, and ANSI input", () => {
  assert.equal(normalizeTlhSessionName(""), "");
  assert.equal(normalizeTlhSessionName(" \t\n\r "), "");
  assert.equal(normalizeTlhSessionName("\u0000\u0001\u001b[0m\u001b]0;;\u0007"), "");
});

// ── registration ─────────────────────────────────────────────────────────────

test("registerNameSessionTool registers name_session in a main session", async () => {
  await withEnv(NO_CHILD_ENV, async () => {
    const { pi } = createToolHarness(undefined);
    registerNameSessionTool(pi);
    const tool = pi.tools.get(NAME_SESSION_TOOL_NAME);
    assert.ok(tool, "expected the name_session tool to be registered");
    assert.equal(tool.label, "Name Session");
    assert.match(tool.description, /never overwrites an existing name/i);
    assert.match(tool.description, /secrets/i);
    assert.match(tool.description, /personal data/i);
    assert.deepEqual(tool.parameters.required, ["name"]);
    assert.equal(tool.parameters.additionalProperties, false);
  });
});

test("registerNameSessionTool is inert in a subagent child process", async () => {
  await withEnv({ ...NO_CHILD_ENV, PI_SUBAGENT_CHILD: "1" }, async () => {
    const { pi } = createToolHarness(undefined);
    registerNameSessionTool(pi);
    assert.equal(pi.tools.size, 0, "child sessions must not register name_session");
  });
});

// ── tool behavior ────────────────────────────────────────────────────────────

test("name_session names a previously unnamed session with the normalized label", async () => {
  await withEnv(NO_CHILD_ENV, async () => {
    const { pi, ctx } = createToolHarness(undefined);
    registerNameSessionTool(pi);
    const tool = pi.tools.get(NAME_SESSION_TOOL_NAME);

    const result = await tool.execute(
      "call-1",
      { name: "  Fix   flaky\ttest " },
      undefined,
      undefined,
      ctx,
    );

    assert.deepEqual(pi.setSessionNameCalls, ["Fix flaky test"]);
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.details, { changed: true, name: "Fix flaky test" });
    assert.match(firstText(result), /Fix flaky test/);
  });
});

test("name_session leaves an existing session name untouched and reports it", async () => {
  await withEnv(NO_CHILD_ENV, async () => {
    const { pi, ctx } = createToolHarness("Existing label");
    registerNameSessionTool(pi);
    const tool = pi.tools.get(NAME_SESSION_TOOL_NAME);

    const result = await tool.execute("call-2", { name: "Replacement" }, undefined, undefined, ctx);

    assert.deepEqual(pi.setSessionNameCalls, []);
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.details, { changed: false, name: "Existing label" });
    assert.match(firstText(result), /already named "Existing label"/);
  });
});

test("name_session treats a whitespace-only existing name as unnamed", async () => {
  await withEnv(NO_CHILD_ENV, async () => {
    const { pi, ctx } = createToolHarness("   ");
    registerNameSessionTool(pi);
    const tool = pi.tools.get(NAME_SESSION_TOOL_NAME);

    const result = await tool.execute("call-3", { name: "Fresh label" }, undefined, undefined, ctx);

    assert.deepEqual(pi.setSessionNameCalls, ["Fresh label"]);
    assert.equal(result.details.changed, true);
  });
});

test("name_session falls back to pi.getSessionName when the context read throws", async () => {
  await withEnv(NO_CHILD_ENV, async () => {
    const { pi, ctx } = createToolHarness("From extension api");
    ctx.sessionManager.getSessionName = () => {
      throw new Error("unavailable");
    };
    registerNameSessionTool(pi);
    const tool = pi.tools.get(NAME_SESSION_TOOL_NAME);

    const result = await tool.execute("call-4", { name: "Replacement" }, undefined, undefined, ctx);

    assert.deepEqual(pi.setSessionNameCalls, []);
    assert.deepEqual(result.details, { changed: false, name: "From extension api" });
  });
});

test("name_session fails closed when no getter can read the existing name", async () => {
  await withEnv(NO_CHILD_ENV, async () => {
    const { pi, ctx, getStoredName } = createToolHarness("User-set label");
    ctx.sessionManager.getSessionName = () => {
      throw new Error("session manager unavailable");
    };
    pi.getSessionName = () => {
      throw new Error("extension api unavailable");
    };
    registerNameSessionTool(pi);
    const tool = pi.tools.get(NAME_SESSION_TOOL_NAME);

    const result = await tool.execute(
      "call-4b",
      { name: "Replacement" },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(
      result.isError,
      true,
      "an unreadable existing name must not be treated as unnamed",
    );
    assert.deepEqual(result.details, { changed: false });
    assert.deepEqual(pi.setSessionNameCalls, []);
    assert.equal(getStoredName(), "User-set label", "the existing label must stay untouched");
  });
});

test("name_session errors without setting a name when the input is empty after normalization", async () => {
  await withEnv(NO_CHILD_ENV, async () => {
    const { pi, ctx } = createToolHarness(undefined);
    registerNameSessionTool(pi);
    const tool = pi.tools.get(NAME_SESSION_TOOL_NAME);

    for (const input of ["", "   ", "\n\t", "\u0000\u0001", "\u001b[31m\u001b[0m"]) {
      const result = await tool.execute("call-5", { name: input }, undefined, undefined, ctx);
      assert.equal(result.isError, true, `expected an error result for ${JSON.stringify(input)}`);
      assert.deepEqual(result.details, { changed: false });
    }
    assert.deepEqual(pi.setSessionNameCalls, []);
  });
});

test("name_session reports an error result when the runtime rejects the name", async () => {
  await withEnv(NO_CHILD_ENV, async () => {
    const { pi, ctx } = createToolHarness(undefined);
    pi.setSessionName = () => {
      throw new Error("session manager unavailable");
    };
    registerNameSessionTool(pi);
    const tool = pi.tools.get(NAME_SESSION_TOOL_NAME);

    const result = await tool.execute("call-6", { name: "Some label" }, undefined, undefined, ctx);

    assert.equal(result.isError, true);
    assert.deepEqual(result.details, { changed: false });
    assert.match(firstText(result), /session manager unavailable/);
  });
});

// ── extension wiring ─────────────────────────────────────────────────────────

function createExtensionPi(sessionState) {
  const tools = new Map();
  return {
    tools,
    on() {},
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    registerShortcut() {},
    registerProvider() {},
    appendEntry() {},
    sendMessage() {},
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools() {},
    getThinkingLevel: () => "medium",
    setThinkingLevel() {},
    setModel: async () => true,
    getSessionName: () => sessionState.name,
    setSessionName(name) {
      sessionState.name = name;
    },
  };
}

async function runExtensionRegistration(env, sessionState) {
  const tempRoot = mkdtempSync(join(tmpdir(), "tlh-session-name-"));
  try {
    const agentDir = join(tempRoot, "agent");
    const cwd = join(tempRoot, "workspace");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      `${JSON.stringify({ tlh: { primaryAgent: { enabled: true, selected: "architect" } } }, null, 2)}\n`,
    );

    return await withEnv({ ...env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, async () => {
      const localJiti = createJiti(import.meta.url, { moduleCache: false });
      const { default: theLastHarness } = await localJiti.import(
        "../extensions/the-last-harness.ts",
      );
      const pi = createExtensionPi(sessionState);
      theLastHarness(pi);
      return pi;
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

test("the TLH extension registers name_session in a main session", async () => {
  const sessionState = { name: undefined };
  const pi = await runExtensionRegistration(NO_CHILD_ENV, sessionState);

  const tool = pi.tools.get(NAME_SESSION_TOOL_NAME);
  assert.ok(tool, "expected the TLH extension to register name_session in a main session");

  const result = await tool.execute("call-7", { name: "Fix flaky test" }, undefined, undefined, {
    sessionManager: {
      getSessionName: () => sessionState.name,
    },
  });

  assert.equal(result.details.changed, true);
  assert.equal(sessionState.name, "Fix flaky test");
});

test("the TLH extension does not register name_session in a subagent child process", async () => {
  const sessionState = { name: undefined };
  const pi = await runExtensionRegistration(
    { ...NO_CHILD_ENV, PI_SUBAGENT_CHILD: "1" },
    sessionState,
  );

  assert.equal(pi.tools.size, 0, "child subagent sessions must not get name_session");
});

// ── real runtime: the architect gets the tool ────────────────────────────────

function createRuntimeEnv(fixture) {
  const env = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PI_") || key.startsWith("TLH_")) env[key] = undefined;
  }
  const dirs = {
    XDG_CONFIG_HOME: join(fixture.dir, "xdg-config"),
    XDG_DATA_HOME: join(fixture.dir, "xdg-data"),
    XDG_CACHE_HOME: join(fixture.dir, "xdg-cache"),
    TMPDIR: join(fixture.dir, "tmp"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  return {
    ...env,
    ...dirs,
    HOME: fixture.home,
    USERPROFILE: undefined,
    PI_CODING_AGENT_DIR: fixture.agent,
    PI_OFFLINE: "1",
  };
}

test("the architect session receives name_session as an active tool at session start", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-session-name-runtime-", { cwd: true, test: t });
  writeFileSync(
    join(fixture.agent, "settings.json"),
    `${JSON.stringify(
      {
        tlh: {
          primaryAgent: { enabled: true, selected: "architect" },
          telemetry: { enabled: false },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await withEnv(createRuntimeEnv(fixture), async () => {
    const {
      createAgentSession,
      DefaultResourceLoader,
      ModelRuntime,
      SessionManager,
      SettingsManager,
    } = await import("@earendil-works/pi-coding-agent");
    const { fauxProvider } = await import("@earendil-works/pi-ai");
    const { createInMemoryCredentialStore } =
      await import("./support/in-memory-credential-store.mjs");
    const { default: theLastHarness } = await import(
      new URL("../extensions/the-last-harness.js", import.meta.url).href
    );

    const faux = fauxProvider({
      provider: "tlh-session-name-faux",
      models: [{ id: "probe", contextWindow: 100_000, maxTokens: 2_000, reasoning: true }],
    });
    const modelRuntime = await ModelRuntime.create({
      credentials: createInMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);

    const settingsManager = SettingsManager.create(fixture.cwd, fixture.agent);
    const resourceLoader = new DefaultResourceLoader({
      cwd: fixture.cwd,
      agentDir: fixture.agent,
      settingsManager,
      extensionFactories: [theLastHarness],
      noContextFiles: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      systemPrompt: "Deterministic session naming fixture.",
      appendSystemPrompt: [],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);

    const { session } = await createAgentSession({
      cwd: fixture.cwd,
      agentDir: fixture.agent,
      modelRuntime,
      model: faux.getModel(),
      resourceLoader,
      sessionManager: SessionManager.create(fixture.cwd),
      settingsManager,
      sessionStartEvent: { reason: "startup" },
    });
    try {
      await session.bindExtensions({ mode: "print" });
      assert.ok(
        session.getAllTools().some((tool) => tool.name === NAME_SESSION_TOOL_NAME),
        "the bundled extension must register name_session",
      );
      assert.ok(
        session.getActiveToolNames().includes(NAME_SESSION_TOOL_NAME),
        `the architect must get name_session as an active tool, got ${JSON.stringify(
          session.getActiveToolNames(),
        )}`,
      );
    } finally {
      session.dispose();
    }
  });
});

// ── architect prompt wiring ─────────────────────────────────────────────────
const architectPrompt = readFileSync(
  new URL("../agents/primary/architect.md", import.meta.url),
  "utf8",
);

test("architect.md names an unnamed session after ticket creation and before presenting the tree", () => {
  assert.match(
    architectPrompt,
    /if it is still unnamed, call `name_session` with a short \(3-6 words\) outcome-focused label/,
  );
  assert.match(architectPrompt, /no ticket IDs, no secrets or personal data/i);
  assert.match(architectPrompt, /never rename a session that already has a name/i);

  const wireDependenciesIndex = architectPrompt.indexOf("to wire dependencies");
  const nameSessionStepIndex = architectPrompt.indexOf("`name_session` with a short");
  const presentTreeIndex = architectPrompt.indexOf("Present the ticket tree");
  assert.ok(
    wireDependenciesIndex !== -1 && nameSessionStepIndex !== -1 && presentTreeIndex !== -1,
    "architect.md must keep the dependency wiring, naming, and ticket-tree steps",
  );
  assert.ok(
    wireDependenciesIndex < nameSessionStepIndex && nameSessionStepIndex < presentTreeIndex,
    "session naming must happen after the tickets are wired and before the tree is presented",
  );
});

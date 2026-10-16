import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
function isolatedEnv(fixture, overrides = {}) {
  const unset = {};
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith("PI_") ||
      key.startsWith("TLH_") ||
      key.startsWith("MCP_") ||
      /(?:API_KEY|API_TOKEN|AUTH_TOKEN|ACCESS_TOKEN|CLIENT_SECRET|SECRET_ACCESS_KEY|SESSION_TOKEN)$/.test(
        key,
      )
    ) {
      unset[key] = undefined;
    }
  }
  const xdgConfig = join(fixture.dir, "xdg-config");
  const xdgData = join(fixture.dir, "xdg-data");
  const xdgCache = join(fixture.dir, "xdg-cache");
  const temp = join(fixture.dir, "tmp");
  for (const path of [xdgConfig, xdgData, xdgCache, temp]) mkdirSync(path, { recursive: true });
  return {
    ...unset,
    HOME: fixture.home,
    USERPROFILE: undefined,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_CACHE_HOME: xdgCache,
    TMPDIR: temp,
    PI_CODING_AGENT_DIR: fixture.agent,
    PI_OFFLINE: "1",
    TLH_SKIP_TELEMETRY: "1",
    TLH_SKIP_UPDATE_CHECK: "1",
    ...overrides,
  };
}

async function loadRuntimeModules() {
  const codingAgent = await import("@earendil-works/pi-coding-agent");
  const piAi = await import("@earendil-works/pi-ai");
  const extension = await import(
    pathToFileURL(join(repoRoot, "extensions", "the-last-harness.js")).href
  );
  const prompts = await import(
    pathToFileURL(join(repoRoot, "extensions", "the-last-harness", "prompts.js")).href
  );
  return {
    codingAgent,
    piAi,
    theLastHarness: extension.default,
    loadPrimaryAgents: prompts.loadPrimaryAgents,
  };
}

function createInMemoryCredentialStore() {
  const store = new Map();
  const tails = new Map();
  const enqueue = (providerId, fn) => {
    const tail = tails.get(providerId) ?? Promise.resolve();
    const result = tail.then(fn);
    tails.set(
      providerId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  };
  return {
    async read(providerId) {
      return store.get(providerId);
    },
    async list() {
      return [...store.entries()].map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }));
    },
    modify(providerId, fn) {
      return enqueue(providerId, async () => {
        const next = await fn(store.get(providerId));
        if (next !== undefined) store.set(providerId, next);
        return next;
      });
    },
    delete(providerId) {
      return enqueue(providerId, async () => {
        store.delete(providerId);
      });
    },
  };
}

async function createFauxRuntime({ ModelRuntime, fauxProvider }, provider, id) {
  const faux = fauxProvider({
    provider,
    models: [
      {
        id,
        contextWindow: 100_000,
        maxTokens: 2_000,
        reasoning: true,
      },
    ],
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: createInMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  return { faux, modelRuntime, model: faux.getModel() };
}

function toolDeclaration(name) {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {}, additionalProperties: false },
  };
}

function declaredToolNames(messages) {
  const names = new Map();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) names.set(tool.name, tool);
  }
  return [...names.keys()];
}

function sortedNames(names) {
  return [...names].sort((left, right) => left.localeCompare(right));
}

function toolResultText(message) {
  return (message?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

async function createChildSession({
  codingAgent,
  theLastHarness,
  fixture,
  modelRuntime,
  model,
  sessionManager,
  settingsManager,
  tools,
  sessionStartEvent,
}) {
  const resourceLoader = new codingAgent.DefaultResourceLoader({
    cwd: fixture.cwd,
    agentDir: fixture.agent,
    settingsManager,
    extensionFactories: [theLastHarness],
    noContextFiles: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    systemPrompt: "Deterministic child resume fixture.",
    appendSystemPrompt: [],
  });
  await resourceLoader.reload();
  const loaded = resourceLoader.getExtensions();
  assert.equal(loaded.errors.length, 0, JSON.stringify(loaded.errors));
  const options = {
    cwd: fixture.cwd,
    agentDir: fixture.agent,
    modelRuntime,
    model,
    resourceLoader,
    sessionManager,
    settingsManager,
    sessionStartEvent,
  };
  if (tools !== undefined) options.tools = tools;
  const { session } = await codingAgent.createAgentSession(options);
  await session.bindExtensions({ mode: "print" });
  return session;
}

test("Pi 1.3 primary resume applies policy at the provider and execution boundaries", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pi-1-3-primary-resume-", {
    cwd: true,
    test: t,
  });
  writeFileSync(
    join(fixture.agent, "settings.json"),
    `${JSON.stringify(
      {
        tlh: {
          primaryAgent: { enabled: true, selected: "architect" },
          telemetry: { enabled: false },
          updateCheck: { enabled: false },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(join(fixture.cwd, "allowed-tool.txt"), "allowed-tool-ok\n", "utf8");

  // Deliberately poison the inherited process first. The Pi and TLH modules are
  // dynamically imported only inside the sanitized environment below.
  await withEnv(
    {
      PI_SUBAGENT_CHILD: "1",
      PI_SUBAGENT_CHILD_AGENT: "developer",
      PI_PROVIDER: "ambient-provider",
      TLH_AGENT_DIR: "/ambient/agent",
    },
    async () => {
      await withEnv(isolatedEnv(fixture), async () => {
        assert.equal(process.env.PI_SUBAGENT_CHILD, undefined);
        assert.equal(process.env.TLH_AGENT_DIR, undefined);
        const { codingAgent, piAi, theLastHarness, loadPrimaryAgents } = await loadRuntimeModules();
        const {
          createAgentSession,
          DefaultResourceLoader,
          defineTool,
          ModelRuntime,
          SessionManager,
          SettingsManager,
        } = codingAgent;
        const { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } = piAi;

        const { faux, modelRuntime, model } = await createFauxRuntime(
          { ModelRuntime, fauxProvider },
          "tlh-primary-resume-faux",
          "primary",
        );
        const primaryAgents = loadPrimaryAgents();
        const architect = primaryAgents.get("architect");
        assert.ok(architect, "the bundled architect definition must be available");
        assert.ok(architect.filePath.includes(join(repoRoot, "agents", "primary")));

        let lateExecutions = 0;
        let controlExecutions = 0;
        const lateTool = defineTool({
          name: "late_tool",
          label: "late_tool",
          description: "restored late fixture tool",
          defaultActive: false,
          parameters: { type: "object", properties: {}, additionalProperties: false },
          async execute() {
            lateExecutions += 1;
            return { content: [{ type: "text", text: "late-tool-executed" }] };
          },
        });
        const controlTool = defineTool({
          name: "late_control",
          label: "late_control",
          description: "non-restored late fixture tool",
          defaultActive: false,
          parameters: { type: "object", properties: {}, additionalProperties: false },
          async execute() {
            controlExecutions += 1;
            return { content: [{ type: "text", text: "control-tool-executed" }] };
          },
        });
        const subagent = defineTool({
          name: "subagent",
          label: "subagent",
          description: "fixture subagent tool",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          async execute() {
            return { content: [{ type: "text", text: "subagent-fixture" }] };
          },
        });
        const supervisor = defineTool({
          name: "subagent_supervisor",
          label: "subagent_supervisor",
          description: "fixture supervisor tool",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          async execute() {
            return { content: [{ type: "text", text: "supervisor-fixture" }] };
          },
        });

        let session;
        const snapshots = [];
        const providerRequests = [];
        const toolCalls = [];
        const snapshot = (stage) => ({
          stage,
          active: session.getActiveToolNames(),
          callable: session.getCallableToolNames(),
          all: sortedNames(session.getAllTools().map((tool) => tool.name)),
        });
        const probeExtension = (pi) => {
          pi.on("session_start", () => snapshots.push(snapshot("after-primary-session_start")));
          pi.on("before_agent_start", () => {
            snapshots.push(snapshot("before-provider"));
          });
          pi.on("tool_call", (event) => toolCalls.push(event.toolName));
        };
        const lateExtension = (pi) => {
          pi.on("session_start", () => {
            pi.registerTool(lateTool);
            pi.registerTool(controlTool);
            snapshots.push(snapshot("after-late-registration"));
          });
        };
        const recordProviderRequest = (context) => {
          providerRequests.push({ declared: declaredToolNames(context.messages) });
        };

        const manager = SessionManager.create(fixture.cwd, join(fixture.agent, "sessions"), {
          id: "primary-resume-boundary",
        });
        manager.appendMessage({
          role: "system",
          content: "",
          toolsAdded: [
            toolDeclaration("read"),
            toolDeclaration("bash"),
            toolDeclaration("write"),
            toolDeclaration("late_tool"),
          ],
        });
        manager.appendModelChange(model.provider, model.id);
        manager.appendThinkingLevelChange("low");

        const settingsManager = SettingsManager.create(fixture.cwd, fixture.agent);
        const resourceLoader = new DefaultResourceLoader({
          cwd: fixture.cwd,
          agentDir: fixture.agent,
          settingsManager,
          extensionFactories: [theLastHarness, probeExtension, lateExtension],
          noContextFiles: true,
          noPromptTemplates: true,
          noSkills: true,
          noThemes: true,
          systemPrompt: "Deterministic primary resume fixture.",
          appendSystemPrompt: [],
        });
        await resourceLoader.reload();
        assert.equal(resourceLoader.getExtensions().errors.length, 0);

        faux.setResponses([
          async (context) => {
            recordProviderRequest(context);
            return fauxAssistantMessage(
              fauxToolCall("late_tool", {}, { id: "attempt-restored-late-tool" }),
              { stopReason: "toolUse" },
            );
          },
          async (context) => {
            recordProviderRequest(context);
            return fauxAssistantMessage(fauxText("late-tool-rejected"), { stopReason: "stop" });
          },
          async (context) => {
            recordProviderRequest(context);
            return fauxAssistantMessage(
              fauxToolCall("read", { path: "allowed-tool.txt" }, { id: "allowed-read" }),
              { stopReason: "toolUse" },
            );
          },
          async (context) => {
            recordProviderRequest(context);
            return fauxAssistantMessage(fauxText("allowed-read-complete"), { stopReason: "stop" });
          },
        ]);

        try {
          const created = await createAgentSession({
            cwd: fixture.cwd,
            agentDir: fixture.agent,
            modelRuntime,
            model,
            resourceLoader,
            settingsManager,
            sessionManager: manager,
            customTools: [subagent, supervisor],
            sessionStartEvent: {
              type: "session_start",
              reason: "resume",
              previousSessionFile: "fixture-primary.jsonl",
            },
          });
          session = created.session;
          await session.bindExtensions({ mode: "print" });

          const primaryBoundary = snapshots.find(
            (entry) => entry.stage === "after-primary-session_start",
          );
          assert.ok(primaryBoundary, "the probe must observe the primary policy boundary");
          const availablePrimaryTools = architect.tools.filter((name) =>
            primaryBoundary.all.includes(name),
          );
          assert.deepEqual(sortedNames(primaryBoundary.active), sortedNames(availablePrimaryTools));
          assert.equal(primaryBoundary.active.includes("late_tool"), false);
          const lateRegistration = snapshots.find(
            (entry) => entry.stage === "after-late-registration",
          );
          assert.ok(lateRegistration, "the late registration boundary must be observed");
          // Upstream may stop exposing a restored late tool transiently after
          // registration; the policy and execution boundaries below remain the
          // compatibility contract.
          assert.equal(lateRegistration.active.includes("late_control"), false);
          assert.equal(lateRegistration.callable.includes("late_control"), false);
          assert.equal(lateRegistration.all.includes("late_tool"), true);
          assert.equal(lateRegistration.all.includes("late_control"), true);

          await session.prompt("Attempt the restored late tool.");
          assert.ok(
            snapshots.some((entry) => entry.stage === "before-provider"),
            "before_agent_start must observe the primary boundary before provider execution",
          );
          assert.equal(lateExecutions, 0, "the transiently restored late tool must not execute");
          assert.equal(controlExecutions, 0, "the non-restored control tool must not execute");

          await session.prompt("Use the allowed read tool.");
          const primaryToolSet = sortedNames(availablePrimaryTools);
          assert.equal(providerRequests.length, 4);
          for (const request of providerRequests) {
            assert.deepEqual(sortedNames(request.declared), primaryToolSet);
            assert.equal(request.declared.includes("late_tool"), false);
            assert.equal(request.declared.includes("late_control"), false);
          }
          assert.equal(toolCalls.includes("read"), true, "an allowed primary tool must execute");
          assert.equal(
            toolCalls.includes("late_tool"),
            false,
            "the late tool must not reach execution",
          );
          const lateResult = session.state.messages.find(
            (message) => message.role === "toolResult" && message.toolName === "late_tool",
          );
          assert.ok(lateResult, "the provider's late-tool attempt must produce a tool result");
          assert.equal(lateResult.isError, true);
          assert.match(toolResultText(lateResult), /not found/i);
          const readResult = session.state.messages.find(
            (message) => message.role === "toolResult" && message.toolName === "read",
          );
          assert.ok(readResult, "the allowed read call must produce a tool result");
          assert.equal(readResult.isError, false);
          assert.match(toolResultText(readResult), /allowed-tool-ok/);
          assert.deepEqual(sortedNames(session.getActiveToolNames()), primaryToolSet);
          assert.deepEqual(sortedNames(session.getCallableToolNames()), primaryToolSet);
        } finally {
          session?.dispose();
        }
      });
    },
  );
});

test("Pi 1.3 child resume honors explicit tools and restores omitted tools from the real transcript", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pi-1-3-child-resume-", { cwd: true, test: t });
  await withEnv(
    isolatedEnv(fixture, {
      PI_SUBAGENT_CHILD: "1",
      PI_SUBAGENT_CHILD_AGENT: "developer",
    }),
    async () => {
      assert.equal(process.env.PI_SUBAGENT_CHILD, "1");
      const { codingAgent, piAi, theLastHarness } = await loadRuntimeModules();
      const { ModelRuntime, SessionManager, SettingsManager, parseArgs } = codingAgent;
      const { fauxAssistantMessage, fauxProvider, fauxText } = piAi;
      const { faux, modelRuntime, model } = await createFauxRuntime(
        { ModelRuntime, fauxProvider },
        "tlh-child-resume-faux",
        "child",
      );
      const providerRequests = [];
      let requestLabel = "";
      faux.setResponses(
        Array.from({ length: 8 }, () => async (context) => {
          providerRequests.push({
            label: requestLabel,
            declared: declaredToolNames(context.messages),
          });
          return fauxAssistantMessage(fauxText("child-resume-ok"), { stopReason: "stop" });
        }),
      );

      const explicitTools = parseArgs(["--tools", "read,write"]).tools;
      assert.deepEqual(explicitTools, ["read", "write"]);
      const explicitSessionDir = join(fixture.agent, "sessions", "explicit");
      const explicitManager = SessionManager.create(fixture.cwd, explicitSessionDir, {
        id: "child-explicit-tools",
      });
      const explicitSettings = SettingsManager.inMemory({});
      const explicitSession = await createChildSession({
        codingAgent,
        theLastHarness,
        fixture,
        modelRuntime,
        model,
        sessionManager: explicitManager,
        settingsManager: explicitSettings,
        tools: explicitTools,
        sessionStartEvent: { type: "session_start", reason: "startup" },
      });
      let explicitSessionFile;
      try {
        assert.deepEqual(sortedNames(explicitSession.getActiveToolNames()), ["read", "write"]);
        requestLabel = "explicit-initial";
        await explicitSession.prompt("Create the explicit child transcript.");
        explicitSession.setActiveToolsByName(["read"]);
        requestLabel = "explicit-narrowed";
        await explicitSession.prompt("Persist a narrower transcript loadout.");
        explicitSessionFile = explicitSession.sessionFile;
        assert.equal(typeof explicitSessionFile, "string");
        assert.deepEqual(
          sortedNames(declaredToolNames(explicitManager.buildSessionContext().messages)),
          ["read"],
          "the persisted explicit transcript must differ from the resumed explicit policy",
        );
      } finally {
        explicitSession.dispose();
      }

      const resumedExplicitManager = SessionManager.open(
        explicitSessionFile,
        explicitSessionDir,
        fixture.cwd,
      );
      const resumedExplicitSettings = SettingsManager.inMemory({});
      const resumedExplicit = await createChildSession({
        codingAgent,
        theLastHarness,
        fixture,
        modelRuntime,
        model,
        sessionManager: resumedExplicitManager,
        settingsManager: resumedExplicitSettings,
        tools: explicitTools,
        sessionStartEvent: {
          type: "session_start",
          reason: "resume",
          previousSessionFile: explicitSessionFile,
        },
      });
      try {
        assert.deepEqual(
          sortedNames(resumedExplicit.getActiveToolNames()),
          ["read", "write"],
          "an explicit child --tools policy must win over its older transcript loadout",
        );
        requestLabel = "explicit-resumed";
        await resumedExplicit.prompt("Resume the explicit child session.");
        const request = providerRequests.find((entry) => entry.label === "explicit-resumed");
        assert.deepEqual(sortedNames(request?.declared ?? []), ["read", "write"]);
        assert.deepEqual(sortedNames(resumedExplicit.getCallableToolNames()), ["read", "write"]);
      } finally {
        resumedExplicit.dispose();
      }

      // This child has no tools field: no tools override is passed to
      // createAgentSession. Pi must restore the actual loadout recorded by its
      // session transcript rather than treating the new default as a policy.
      const noToolsSessionDir = join(fixture.agent, "sessions", "omitted");
      const noToolsManager = SessionManager.create(fixture.cwd, noToolsSessionDir, {
        id: "child-omitted-tools",
      });
      const initialNoToolsSettings = SettingsManager.inMemory({
        defaultTools: ["read", "write"],
      });
      const noToolsSession = await createChildSession({
        codingAgent,
        theLastHarness,
        fixture,
        modelRuntime,
        model,
        sessionManager: noToolsManager,
        settingsManager: initialNoToolsSettings,
        sessionStartEvent: { type: "session_start", reason: "startup" },
      });
      let noToolsSessionFile;
      try {
        assert.deepEqual(sortedNames(noToolsSession.getActiveToolNames()), ["read", "write"]);
        requestLabel = "omitted-initial";
        await noToolsSession.prompt("Create the omitted-tools child transcript.");
        noToolsSessionFile = noToolsSession.sessionFile;
        assert.equal(typeof noToolsSessionFile, "string");
      } finally {
        noToolsSession.dispose();
      }

      const resumedNoToolsManager = SessionManager.open(
        noToolsSessionFile,
        noToolsSessionDir,
        fixture.cwd,
      );
      const changedDefaultSettings = SettingsManager.inMemory({ defaultTools: ["read"] });
      assert.deepEqual(changedDefaultSettings.getDefaultTools(), ["read"]);
      const resumedNoTools = await createChildSession({
        codingAgent,
        theLastHarness,
        fixture,
        modelRuntime,
        model,
        sessionManager: resumedNoToolsManager,
        settingsManager: changedDefaultSettings,
        sessionStartEvent: {
          type: "session_start",
          reason: "resume",
          previousSessionFile: noToolsSessionFile,
        },
      });
      try {
        assert.deepEqual(
          sortedNames(resumedNoTools.getActiveToolNames()),
          ["read", "write"],
          "a child with no tools field must restore the loadout from its real transcript",
        );
        requestLabel = "omitted-resumed";
        await resumedNoTools.prompt("Resume the omitted-tools child session.");
        const request = providerRequests.find((entry) => entry.label === "omitted-resumed");
        assert.deepEqual(sortedNames(request?.declared ?? []), ["read", "write"]);
        assert.deepEqual(sortedNames(resumedNoTools.getCallableToolNames()), ["read", "write"]);
      } finally {
        resumedNoTools.dispose();
      }

      assert.equal(
        providerRequests.filter((entry) => entry.label === "explicit-resumed").length,
        1,
      );
      assert.equal(providerRequests.filter((entry) => entry.label === "omitted-resumed").length, 1);
    },
  );
});

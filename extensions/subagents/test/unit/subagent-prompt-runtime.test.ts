import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import {
  createExtensionRuntime,
  ExtensionRunner,
  ProjectTrustStore,
  SessionManager,
  type BuildSystemPromptOptions,
  type Extension,
  type ExtensionAPI,
  type NormalizedBuildSystemPromptOptions,
  type Skill,
  type ToolDefinition,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { writeChildMessageRequestToDir } from "../../src/runs/background/control-channel.ts";
import {
  PACKAGED_MINOR_AGENT_ROLES,
  projectAgentGuidanceFilename,
} from "../../../shared/project-agent-guidance.ts";
import { setStructuredChildPromptRuntime } from "../../../shared/subagent-child-boundary.ts";
import {
  SUBAGENT_CHILD_AGENT_ENV,
  SUBAGENT_CHILD_INDEX_ENV,
  SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV,
  SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
  SUBAGENT_RUN_ID_ENV,
  SUBAGENT_STEER_INBOX_ENV,
  SUBAGENT_SUPERVISOR_BRIDGE_ENV,
  SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
  SUBAGENT_TK_TICKET_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";
import { TOOL_BUDGET_ENV } from "../../src/runs/shared/tool-budget.ts";
import registerSubagentPromptRuntime, {
  CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
  NATIVE_SUPERVISOR_GUIDANCE,
  rewriteSubagentPrompt,
  stripSubagentOrchestrationSkill,
} from "../../src/runs/shared/subagent-prompt-runtime.ts";
import {
  makeExtensionAPI,
  makeMinimalCtx,
  type TestEventHandler,
  type TestEventName,
  type TestEventRegistration,
  type TestEventResult,
} from "../support/helpers.ts";

type PiSystemPromptModule = {
  buildSystemPrompt(input: BuildSystemPromptOptions): string;
  normalizeBuildSystemPromptOptions(
    input: BuildSystemPromptOptions,
  ): NormalizedBuildSystemPromptOptions;
};

const piSystemPrompt = (await import(
  new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
)) as PiSystemPromptModule;
const { buildSystemPrompt, normalizeBuildSystemPromptOptions } = piSystemPrompt;

function recordEvents(handlers: Map<TestEventName, TestEventHandler>): TestEventRegistration["on"] {
  return (event, handler) => {
    handlers.set(event, handler);
    return () => {
      if (handlers.get(event) === handler) handlers.delete(event);
    };
  };
}

function makeToolInfo(name: string): ToolInfo {
  return {
    name,
    description: "test tool",
    parameters: Type.Object({}),
    sourceInfo: { path: "", source: "test", scope: "temporary", origin: "top-level" },
  };
}

function makePromptSkill(name: string): Skill {
  return {
    name,
    description: `${name} description`,
    filePath: `/tmp/${name}/SKILL.md`,
    baseDir: `/tmp/${name}`,
    sourceInfo: {
      path: `/tmp/${name}/SKILL.md`,
      source: "test",
      scope: "temporary",
      origin: "top-level",
    },
    disableModelInvocation: false,
  };
}

function makeStructuredPromptOptions() {
  return normalizeBuildSystemPromptOptions({
    cwd: "/repo",
    customPrompt: [
      "Packaged child role.",
      '<skill name="explicit">Keep this configured skill.</skill>',
    ].join("\n\n"),
    contextFiles: [{ path: "/repo/AGENTS.md", content: "Project rules" }],
    skills: [makePromptSkill("safe-bash"), makePromptSkill("pi-subagents")],
    sections: {
      unrelated: "Unrelated section must remain intact.",
    },
  });
}

type StructuredPromptEvent = {
  systemPrompt: string;
  systemPromptOptions: NormalizedBuildSystemPromptOptions;
};

function makePromptEvent(customPrompt = "base prompt"): StructuredPromptEvent {
  const systemPromptOptions = normalizeBuildSystemPromptOptions({
    cwd: "/repo",
    customPrompt,
  });
  return {
    systemPrompt: buildSystemPrompt(systemPromptOptions),
    systemPromptOptions,
  };
}

function renderPrompt(event: StructuredPromptEvent): string {
  return buildSystemPrompt(event.systemPromptOptions);
}

type TestPromptHandler = (
  ...args: never[]
) => Promise<{ systemPrompt?: string } | void> | { systemPrompt?: string } | void;

function makePromptExtension(path: string, register: (pi: ExtensionAPI) => void): Extension {
  const handlers = new Map<string, TestPromptHandler[]>();
  const pi = {
    on(event: string, handler: unknown): () => void {
      if (typeof handler !== "function") throw new TypeError("test handler must be callable");
      const registered = handlers.get(event) ?? [];
      registered.push(handler as TestPromptHandler);
      handlers.set(event, registered);
      return () => {};
    },
  } as ExtensionAPI;
  register(pi);
  return {
    path,
    resolvedPath: path,
    sourceInfo: { path, source: "test", scope: "temporary", origin: "top-level" },
    handlers: handlers as Extension["handlers"],
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

async function emitChainedBeforeAgentStart(
  options: BuildSystemPromptOptions,
  registrars: Array<(pi: ExtensionAPI) => void>,
): Promise<{ systemPromptOptions: NormalizedBuildSystemPromptOptions }> {
  const cwd = "/repo";
  const runtime = createExtensionRuntime();
  const extensions = registrars.map((register, index) =>
    makePromptExtension(`test-extension-${index}`, register),
  );
  const runner = new ExtensionRunner(
    extensions,
    runtime,
    cwd,
    SessionManager.inMemory(cwd),
    {} as ConstructorParameters<typeof ExtensionRunner>[4],
  );
  return runner.emitBeforeAgentStart("child task", undefined, options);
}

function countOccurrences(value: string, needle: string): number {
  return needle.length === 0 ? 0 : value.split(needle).length - 1;
}

const envSnapshot = {
  PI_SUBAGENT_INHERIT_PROJECT_CONTEXT: process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT,
  PI_SUBAGENT_INHERIT_SKILLS: process.env.PI_SUBAGENT_INHERIT_SKILLS,
  PI_SUBAGENT_STEER_INBOX: process.env.PI_SUBAGENT_STEER_INBOX,
  PI_SUBAGENT_TOOL_BUDGET: process.env.PI_SUBAGENT_TOOL_BUDGET,
  PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID,
  PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR: process.env.PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR,
  PI_SUBAGENT_RUN_ID: process.env.PI_SUBAGENT_RUN_ID,
  PI_SUBAGENT_CHILD_AGENT: process.env.PI_SUBAGENT_CHILD_AGENT,
  PI_SUBAGENT_CHILD_INDEX: process.env.PI_SUBAGENT_CHILD_INDEX,
  PI_SUBAGENT_PROJECT_AGENT_GUIDANCE: process.env.PI_SUBAGENT_PROJECT_AGENT_GUIDANCE,
  PI_SUBAGENT_TK_TICKET_ID: process.env[SUBAGENT_TK_TICKET_ID_ENV],
  PI_SUBAGENT_SUPERVISOR_BRIDGE: process.env[SUBAGENT_SUPERVISOR_BRIDGE_ENV],
};

const SKILLS_SECTION =
  "\n\nThe following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file when the task matches its description.\nWhen a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n<available_skills>\n  <skill>\n    <name>safe-bash</name>\n    <description>desc</description>\n    <location>/tmp/SKILL.md</location>\n  </skill>\n  <skill>\n    <name>pi-subagents</name>\n    <description>delegate to subagents</description>\n    <location>/tmp/pi-subagents/SKILL.md</location>\n  </skill>\n</available_skills>";

const BASE_PROMPT = [
  "You are a subagent.",
  "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n## /repo/AGENTS.md\n\nProject rules\n\n",
  SKILLS_SECTION,
  "\nCurrent date: 2026-04-16",
  "\nCurrent working directory: /repo",
].join("");

const CONFIGURED_SKILLS_SECTION =
  "\n\nThe following configured skills are available to this subagent.\nUse the read tool to load a skill's file when the task matches its description.\nWhen a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n<available_skills>\n  <skill>\n    <name>configured-skill</name>\n    <description>explicit agent skill</description>\n    <location>/tmp/configured-skill/SKILL.md</location>\n  </skill>\n</available_skills>";

afterEach(() => {
  if (envSnapshot.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT === undefined)
    delete process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT;
  else
    process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT =
      envSnapshot.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT;
  if (envSnapshot.PI_SUBAGENT_INHERIT_SKILLS === undefined)
    delete process.env.PI_SUBAGENT_INHERIT_SKILLS;
  else process.env.PI_SUBAGENT_INHERIT_SKILLS = envSnapshot.PI_SUBAGENT_INHERIT_SKILLS;
  if (envSnapshot.PI_SUBAGENT_STEER_INBOX === undefined)
    delete process.env[SUBAGENT_STEER_INBOX_ENV];
  else process.env[SUBAGENT_STEER_INBOX_ENV] = envSnapshot.PI_SUBAGENT_STEER_INBOX;
  if (envSnapshot.PI_SUBAGENT_TOOL_BUDGET === undefined) delete process.env[TOOL_BUDGET_ENV];
  else process.env[TOOL_BUDGET_ENV] = envSnapshot.PI_SUBAGENT_TOOL_BUDGET;
  if (envSnapshot.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID === undefined)
    delete process.env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV];
  else
    process.env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV] =
      envSnapshot.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID;
  if (envSnapshot.PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR === undefined)
    delete process.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV];
  else
    process.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV] =
      envSnapshot.PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR;
  if (envSnapshot.PI_SUBAGENT_RUN_ID === undefined) delete process.env[SUBAGENT_RUN_ID_ENV];
  else process.env[SUBAGENT_RUN_ID_ENV] = envSnapshot.PI_SUBAGENT_RUN_ID;
  if (envSnapshot.PI_SUBAGENT_CHILD_AGENT === undefined)
    delete process.env[SUBAGENT_CHILD_AGENT_ENV];
  else process.env[SUBAGENT_CHILD_AGENT_ENV] = envSnapshot.PI_SUBAGENT_CHILD_AGENT;
  if (envSnapshot.PI_SUBAGENT_CHILD_INDEX === undefined)
    delete process.env[SUBAGENT_CHILD_INDEX_ENV];
  else process.env[SUBAGENT_CHILD_INDEX_ENV] = envSnapshot.PI_SUBAGENT_CHILD_INDEX;
  if (envSnapshot.PI_SUBAGENT_PROJECT_AGENT_GUIDANCE === undefined)
    delete process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV];
  else
    process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] =
      envSnapshot.PI_SUBAGENT_PROJECT_AGENT_GUIDANCE;
  if (envSnapshot.PI_SUBAGENT_TK_TICKET_ID === undefined)
    delete process.env[SUBAGENT_TK_TICKET_ID_ENV];
  else process.env[SUBAGENT_TK_TICKET_ID_ENV] = envSnapshot.PI_SUBAGENT_TK_TICKET_ID;
  if (envSnapshot.PI_SUBAGENT_SUPERVISOR_BRIDGE === undefined)
    delete process.env[SUBAGENT_SUPERVISOR_BRIDGE_ENV];
  else process.env[SUBAGENT_SUPERVISOR_BRIDGE_ENV] = envSnapshot.PI_SUBAGENT_SUPERVISOR_BRIDGE;
});

type ProjectGuidanceFixture = {
  root: string;
  cwd: string;
  agentDir: string;
};

function makeProjectGuidanceFixture(): ProjectGuidanceFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-project-guidance-runtime-"));
  const repo = path.join(root, "repo");
  const cwd = path.join(repo, "packages", "app");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  return { root, cwd, agentDir };
}

function writeProjectGuidance(
  fixture: ProjectGuidanceFixture,
  role: string,
  content: string,
): string {
  const filename = projectAgentGuidanceFilename(role);
  assert.ok(filename, `expected a packaged project-guidance filename for ${role}`);
  const directory = path.join(fixture.cwd, ".tlh", "agents", "builtin");
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, filename);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

async function withChildGuidanceEnv<T>(
  fixture: ProjectGuidanceFixture,
  role: string | undefined,
  run: () => Promise<T>,
  options: {
    inheritProjectContext?: boolean;
    inheritSkills?: boolean;
    projectAgentGuidance?: boolean | string;
    tkTicketId?: string;
    supervisorBridge?: boolean | string;
  } = {},
): Promise<T> {
  const previous = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_SUBAGENT_CHILD_AGENT: process.env[SUBAGENT_CHILD_AGENT_ENV],
    PI_SUBAGENT_PROJECT_AGENT_GUIDANCE: process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV],
    PI_SUBAGENT_TK_TICKET_ID: process.env[SUBAGENT_TK_TICKET_ID_ENV],
    PI_SUBAGENT_SUPERVISOR_BRIDGE: process.env[SUBAGENT_SUPERVISOR_BRIDGE_ENV],
    PI_SUBAGENT_INHERIT_PROJECT_CONTEXT: process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT,
    PI_SUBAGENT_INHERIT_SKILLS: process.env.PI_SUBAGENT_INHERIT_SKILLS,
  };
  process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
  if (role === undefined) delete process.env[SUBAGENT_CHILD_AGENT_ENV];
  else process.env[SUBAGENT_CHILD_AGENT_ENV] = role;
  process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] = Object.hasOwn(options, "projectAgentGuidance")
    ? options.projectAgentGuidance === true
      ? "1"
      : options.projectAgentGuidance === false
        ? "0"
        : String(options.projectAgentGuidance)
    : "1";
  if (options.tkTicketId === undefined) delete process.env[SUBAGENT_TK_TICKET_ID_ENV];
  else process.env[SUBAGENT_TK_TICKET_ID_ENV] = options.tkTicketId;
  if (Object.hasOwn(options, "supervisorBridge"))
    process.env[SUBAGENT_SUPERVISOR_BRIDGE_ENV] =
      options.supervisorBridge === true
        ? "1"
        : options.supervisorBridge === false
          ? "0"
          : String(options.supervisorBridge);
  else process.env[SUBAGENT_SUPERVISOR_BRIDGE_ENV] = "1";
  process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT =
    options.inheritProjectContext === false ? "0" : "1";
  process.env.PI_SUBAGENT_INHERIT_SKILLS = options.inheritSkills === false ? "0" : "1";
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

type PromptRuntimeHandler = (
  event: unknown,
  ctx: ReturnType<typeof makeMinimalCtx>,
) => TestEventResult;
type PromptRuntimeEventName = TestEventName | "session_compact" | "session_compact_failed";

type PromptRuntimeHandlers = {
  beforeAgentStart: PromptRuntimeHandler;
  sessionStart: (ctx: ReturnType<typeof makeMinimalCtx>) => TestEventResult;
  sessionCompact: PromptRuntimeHandler;
  sessionCompactFailed?: PromptRuntimeHandler;
};

function isPromptRuntimeHandler(value: unknown): value is PromptRuntimeHandler {
  return typeof value === "function";
}

function registerPromptRuntimeHandlers(
  sendMessage?: ExtensionAPI["sendMessage"],
): PromptRuntimeHandlers {
  const handlers = new Map<PromptRuntimeEventName, PromptRuntimeHandler>();
  const extensionApi = makeExtensionAPI(sendMessage ? { sendMessage } : {});
  extensionApi.on = ((event: string, handler: unknown) => {
    if (
      (event as PromptRuntimeEventName) !== "before_agent_start" &&
      (event as PromptRuntimeEventName) !== "session_start" &&
      (event as PromptRuntimeEventName) !== "session_compact" &&
      (event as PromptRuntimeEventName) !== "session_compact_failed"
    ) {
      return () => {};
    }
    if (!isPromptRuntimeHandler(handler)) return () => {};
    const eventName = event as PromptRuntimeEventName;
    handlers.set(eventName, handler);
    return () => {
      if (handlers.get(eventName) === handler) handlers.delete(eventName);
    };
  }) as ExtensionAPI["on"];
  registerSubagentPromptRuntime(extensionApi);
  const beforeAgentStart = handlers.get("before_agent_start");
  const sessionStart = handlers.get("session_start");
  const sessionCompact = handlers.get("session_compact");
  assert.ok(beforeAgentStart, "before_agent_start handler should be registered");
  assert.ok(sessionStart, "session_start handler should be registered");
  assert.ok(sessionCompact, "session_compact handler should be registered");
  return {
    beforeAgentStart,
    sessionStart: (ctx) => sessionStart({}, ctx),
    sessionCompact,
    sessionCompactFailed: handlers.get("session_compact_failed"),
  };
}

function persistProjectTrust(fixture: ProjectGuidanceFixture): void {
  new ProjectTrustStore(fixture.agentDir).set(fixture.cwd, true);
}

function setSupervisorEnv(): void {
  process.env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV] = "session-parent";
  process.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV] = path.join(
    os.tmpdir(),
    "subagent-supervisor-runtime-test",
  );
  process.env[SUBAGENT_RUN_ID_ENV] = "run-123";
  process.env[SUBAGENT_CHILD_AGENT_ENV] = "worker";
  process.env[SUBAGENT_CHILD_INDEX_ENV] = "0";
}

function clearSupervisorEnv(): void {
  delete process.env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV];
  delete process.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV];
  delete process.env[SUBAGENT_RUN_ID_ENV];
  delete process.env[SUBAGENT_CHILD_AGENT_ENV];
  delete process.env[SUBAGENT_CHILD_INDEX_ENV];
}

describe("subagent prompt runtime", () => {
  it("gives each ExtensionAPI fixture a fresh event bus", () => {
    const first = makeExtensionAPI();
    const second = makeExtensionAPI();
    let received = false;
    first.events.on("test", () => {
      received = true;
    });

    assert.notEqual(first.events, second.events);
    second.events.emit("test", undefined);
    assert.equal(received, false);
    first.events.emit("test", undefined);
    assert.equal(received, true);
  });

  it("appends only matching trusted guidance for all packaged minor roles", async (t) => {
    const fixture = makeProjectGuidanceFixture();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    for (const role of PACKAGED_MINOR_AGENT_ROLES) {
      writeProjectGuidance(fixture, role, `guidance-${role}`);
    }
    persistProjectTrust(fixture);

    const handlers = registerPromptRuntimeHandlers();
    for (const role of PACKAGED_MINOR_AGENT_ROLES) {
      await withChildGuidanceEnv(fixture, role, async () => {
        const ctx = makeMinimalCtx(fixture.cwd);
        await handlers.sessionStart(ctx);
        const event = makePromptEvent(`packaged ${role} role`);
        await handlers.beforeAgentStart(event, ctx);
        const prompt = renderPrompt(event);
        assert.equal((prompt.match(/<tlh_project_agent_guidance>/g) ?? []).length, 1);
        assert.match(prompt, new RegExp(`guidance-${role}`));
        for (const otherRole of PACKAGED_MINOR_AGENT_ROLES) {
          if (otherRole !== role) assert.doesNotMatch(prompt, new RegExp(`guidance-${otherRole}`));
        }
        const guidanceIndex = prompt.indexOf(`guidance-${role}`);
        const boundaryIndex = prompt.lastIndexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS);
        assert.ok(guidanceIndex > `packaged ${role} role`.length);
        assert.ok(guidanceIndex < boundaryIndex);
        assert.ok(prompt.includes(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));

        await handlers.beforeAgentStart(event, ctx);
        const repeatedPrompt = renderPrompt(event);
        assert.equal(countOccurrences(repeatedPrompt, "<tlh_project_agent_guidance>"), 1);
        assert.equal(countOccurrences(repeatedPrompt, CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), 1);
        assert.match(repeatedPrompt, new RegExp(`guidance-${role}`));
      });
    }
  });

  it("ignores embedded, unknown, and custom child identities", async (t) => {
    const fixture = makeProjectGuidanceFixture();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    writeProjectGuidance(fixture, "developer", "private developer guidance");
    persistProjectTrust(fixture);

    const handlers = registerPromptRuntimeHandlers();
    for (const role of [
      "architect",
      "embedded.oracle",
      "custom-agent",
      "team.developer",
      "DEVELOPER",
      " developer ",
      " code-reviewer ",
      undefined,
    ]) {
      await withChildGuidanceEnv(fixture, role, async () => {
        const ctx = makeMinimalCtx(fixture.cwd);
        await handlers.sessionStart(ctx);
        const event = makePromptEvent("custom packaged role");
        await handlers.beforeAgentStart(event, ctx);
        const prompt = renderPrompt(event);
        assert.doesNotMatch(prompt, /TLH Project Agent Guidance/);
        assert.doesNotMatch(prompt, /private developer guidance/);
        assert.ok(prompt.includes(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
      });
    }
  });

  it("injects neutral native supervisor guidance for custom/project agents", async (t) => {
    const fixture = makeProjectGuidanceFixture();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const handlers = registerPromptRuntimeHandlers();

    await withChildGuidanceEnv(
      fixture,
      "custom-agent",
      async () => {
        setSupervisorEnv();
        const ctx = makeMinimalCtx(fixture.cwd);
        await handlers.sessionStart(ctx);
        const event = makePromptEvent("custom role");
        await handlers.beforeAgentStart(event, ctx);
        const prompt = renderPrompt(event);
        assert.match(prompt, /Native supervisor coordination:/);
        assert.match(prompt, /contact_supervisor/);
        assert.equal(countOccurrences(prompt, NATIVE_SUPERVISOR_GUIDANCE), 1);
        assert.doesNotMatch(prompt, /TLH Project Agent Guidance/);
        assert.ok(prompt.includes(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));

        await handlers.beforeAgentStart(event, ctx);
        const repeatedPrompt = renderPrompt(event);
        assert.equal(countOccurrences(repeatedPrompt, NATIVE_SUPERVISOR_GUIDANCE), 1);
        assert.ok(repeatedPrompt.includes(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
      },
      { projectAgentGuidance: false },
    );
  });

  it("does not duplicate native guidance for canonical packaged prompts", async (t) => {
    const fixture = makeProjectGuidanceFixture();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const handlers = registerPromptRuntimeHandlers();

    await withChildGuidanceEnv(
      fixture,
      "developer",
      async () => {
        setSupervisorEnv();
        const ctx = makeMinimalCtx(fixture.cwd);
        await handlers.sessionStart(ctx);
        const event = makePromptEvent("canonical role");
        await handlers.beforeAgentStart(event, ctx);
        const prompt = renderPrompt(event);
        assert.doesNotMatch(prompt, /Native supervisor coordination:/);
        assert.doesNotMatch(prompt, /<tlh_project_agent_guidance>/);
        assert.ok(prompt.includes(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
      },
      { projectAgentGuidance: true },
    );
  });

  it("suppresses native guidance and runtime registration for supervisor opt-out", async (t) => {
    const fixture = makeProjectGuidanceFixture();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const handlers = new Map<TestEventName, TestEventHandler>();
    const registered: string[] = [];
    const extensionApi = makeExtensionAPI({
      on: recordEvents(handlers),
      getAllTools: () => registered.map(makeToolInfo),
      registerTool<TParams extends TSchema, TDetails, TState>(
        tool: ToolDefinition<TParams, TDetails, TState>,
      ) {
        registered.push(tool.name);
      },
    });
    registerSubagentPromptRuntime(extensionApi);

    await withChildGuidanceEnv(
      fixture,
      "custom-agent",
      async () => {
        setSupervisorEnv();
        await handlers.get("session_start")?.({});
        const event = makePromptEvent("custom role");
        await handlers.get("before_agent_start")?.(event);
        const prompt = renderPrompt(event);
        assert.doesNotMatch(prompt, /Native supervisor coordination:/);
        assert.deepEqual(registered, []);
      },
      { projectAgentGuidance: false, supervisorBridge: false },
    );
  });

  it("requires an exact enabled provenance sentinel before resolving child guidance", async (t) => {
    const fixture = makeProjectGuidanceFixture();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    writeProjectGuidance(fixture, "developer", "verified developer guidance");
    persistProjectTrust(fixture);
    const handlers = registerPromptRuntimeHandlers();
    for (const sentinel of [undefined, "0", "true", " 1", "1 ", "yes"]) {
      await withChildGuidanceEnv(
        fixture,
        "developer",
        async () => {
          const ctx = makeMinimalCtx(fixture.cwd);
          await handlers.sessionStart(ctx);
          const event = makePromptEvent("packaged role");
          await handlers.beforeAgentStart(event, ctx);
          assert.doesNotMatch(renderPrompt(event), /verified developer guidance/);
        },
        { projectAgentGuidance: sentinel },
      );
    }
    await withChildGuidanceEnv(fixture, "developer", async () => {
      const ctx = makeMinimalCtx(fixture.cwd);
      await handlers.sessionStart(ctx);
      const event = makePromptEvent("packaged role");
      await handlers.beforeAgentStart(event, ctx);
      assert.match(renderPrompt(event), /verified developer guidance/);
    });
  });

  it("snapshots child guidance at session start and refreshes only on a later session", async (t) => {
    const fixture = makeProjectGuidanceFixture();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const guidancePath = writeProjectGuidance(fixture, "developer", "before session reload");
    persistProjectTrust(fixture);

    const handlers = registerPromptRuntimeHandlers();
    await withChildGuidanceEnv(fixture, "developer", async () => {
      const ctx = makeMinimalCtx(fixture.cwd);
      await handlers.sessionStart(ctx);
      fs.writeFileSync(guidancePath, "after session reload", "utf8");

      const stale = makePromptEvent("packaged role");
      await handlers.beforeAgentStart(stale, ctx);
      assert.match(renderPrompt(stale), /before session reload/);
      assert.doesNotMatch(renderPrompt(stale), /after session reload/);

      await handlers.sessionStart(ctx);
      const refreshed = makePromptEvent("packaged role");
      await handlers.beforeAgentStart(refreshed, ctx);
      assert.match(renderPrompt(refreshed), /after session reload/);
      assert.doesNotMatch(renderPrompt(refreshed), /before session reload/);
    });
  });

  it("skips matching child guidance without persisted trust", async (t) => {
    const fixture = makeProjectGuidanceFixture();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    writeProjectGuidance(fixture, "developer", "untrusted guidance");

    const handlers = registerPromptRuntimeHandlers();
    await withChildGuidanceEnv(fixture, "developer", async () => {
      const ctx = makeMinimalCtx(fixture.cwd);
      await handlers.sessionStart(ctx);
      const event = makePromptEvent("packaged role");
      await handlers.beforeAgentStart(event, ctx);
      const prompt = renderPrompt(event);
      assert.doesNotMatch(prompt, /TLH Project Agent Guidance/);
      assert.doesNotMatch(prompt, /untrusted guidance/);
    });

    persistProjectTrust(fixture);
    await withChildGuidanceEnv(fixture, "developer", async () => {
      const ctx = makeMinimalCtx(fixture.cwd);
      await handlers.sessionStart(ctx);
      const trusted = makePromptEvent("packaged role");
      await handlers.beforeAgentStart(trusted, ctx);
      assert.match(renderPrompt(trusted), /untrusted guidance/);
    });
  });

  it("preserves matching guidance after structured inherited-context rewriting", async (t) => {
    const fixture = makeProjectGuidanceFixture();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    writeProjectGuidance(fixture, "code-reviewer", "review guidance");
    persistProjectTrust(fixture);

    const handlers = registerPromptRuntimeHandlers();
    await withChildGuidanceEnv(
      fixture,
      "code-reviewer",
      async () => {
        const ctx = makeMinimalCtx(fixture.cwd);
        await handlers.sessionStart(ctx);
        const options = makeStructuredPromptOptions();
        const result = await handlers.beforeAgentStart(
          { systemPrompt: buildSystemPrompt(options), systemPromptOptions: options },
          ctx,
        );
        assert.equal(result, undefined);
        const rendered = buildSystemPrompt(options);
        assert.doesNotMatch(rendered, /Project rules/);
        assert.doesNotMatch(rendered, /<name>pi-subagents<\/name>/);
        assert.match(rendered, /review guidance/);
        assert.match(rendered, new RegExp(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
      },
      { inheritProjectContext: false, inheritSkills: false },
    );
  });

  it("nudges after the tool budget soft limit and blocks configured tools after hard", () => {
    const handlers = new Map<TestEventName, TestEventHandler>();
    const sent: string[] = [];
    process.env[TOOL_BUDGET_ENV] = JSON.stringify({ soft: 2, hard: 2, block: ["read"] });

    registerSubagentPromptRuntime(
      makeExtensionAPI({
        on: recordEvents(handlers),
        sendUserMessage(content, options) {
          if (typeof content !== "string" || options?.deliverAs === undefined) {
            throw new Error("test sendUserMessage expected string steer input");
          }
          sent.push(content);
        },
      }),
    );

    const toolCall = handlers.get("tool_call");
    assert.ok(toolCall, "tool_call handler should be registered");
    assert.equal(toolCall({ toolName: "grep" }), undefined);
    assert.equal(toolCall({ toolName: "grep" }), undefined);
    assert.equal(sent.length, 1);
    assert.match(sent[0] ?? "", /soft limit reached/);
    assert.deepEqual(toolCall({ toolName: "read" }), {
      block: true,
      reason:
        "Tool budget hard limit reached after 3 tool calls (hard 2). The 'read' tool is blocked so you can finalize from the context you already have.",
    });
    assert.equal(toolCall({ toolName: "write" }), undefined);
  });

  it("delivers steering inbox requests as mid-run user messages", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-steering-runtime-"));
    try {
      const inbox = path.join(dir, "steer");
      process.env[SUBAGENT_STEER_INBOX_ENV] = inbox;
      const handlers = new Map<TestEventName, TestEventHandler>();
      const sent: Array<{ content: string; options: { deliverAs: string } }> = [];

      registerSubagentPromptRuntime(
        makeExtensionAPI({
          on: recordEvents(handlers),
          sendUserMessage(content, options) {
            if (typeof content !== "string" || options?.deliverAs === undefined) {
              throw new Error("test sendUserMessage expected string steer input");
            }
            sent.push({ content, options: { deliverAs: options.deliverAs } });
          },
        }),
      );

      writeChildMessageRequestToDir(inbox, {
        type: "steer",
        id: "steer-1",
        ts: 1,
        message: "Focus on tests.",
      });
      handlers.get("message_start")?.({});
      handlers.get("session_shutdown")?.({});

      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.options.deliverAs, "steer");
      assert.match(sent[0]?.content ?? "", /Mid-run steering/);
      assert.match(sent[0]?.content ?? "", /Focus on tests\./);
      assert.deepEqual(
        fs.readdirSync(inbox).filter((entry) => entry.endsWith(".json")),
        [],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("delivers resume inbox requests with resume-specific wording", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-resume-runtime-"));
    try {
      const inbox = path.join(dir, "steer");
      process.env[SUBAGENT_STEER_INBOX_ENV] = inbox;
      const handlers = new Map<TestEventName, TestEventHandler>();
      const sent: Array<{ content: string; options: { deliverAs: string } }> = [];

      registerSubagentPromptRuntime(
        makeExtensionAPI({
          on: recordEvents(handlers),
          sendUserMessage(content, options) {
            if (typeof content !== "string" || options?.deliverAs === undefined) {
              throw new Error("test sendUserMessage expected string steer input");
            }
            sent.push({ content, options: { deliverAs: options.deliverAs } });
          },
        }),
      );

      writeChildMessageRequestToDir(inbox, {
        type: "resume",
        id: "resume-1",
        ts: 2,
        message: "Continue with the narrowed fix.",
      });
      handlers.get("message_start")?.({});
      handlers.get("session_shutdown")?.({});

      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.options.deliverAs, "steer");
      assert.match(sent[0]?.content ?? "", /Resume follow-up/);
      assert.match(sent[0]?.content ?? "", /Continue with the narrowed fix\./);
      assert.doesNotMatch(sent[0]?.content ?? "", /Mid-run steering/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on forced prompts before preserving structured child mutations", () => {
    const options = makeStructuredPromptOptions();
    setStructuredChildPromptRuntime(options.sections, "explicit", ["explicit first"]);
    setStructuredChildPromptRuntime(options.sections, "root", ["root child guidance"]);
    options.forceSystemPrompt = "FORCED full child replacement";

    rewriteSubagentPrompt(
      options,
      { inheritProjectContext: false, inheritSkills: false },
      "project child guidance",
      "supervisor child guidance",
      "ticket child guidance",
    );

    const rendered = buildSystemPrompt(options);
    assert.equal(options.forceSystemPrompt, undefined);
    assert.doesNotMatch(rendered, /FORCED full child replacement/);
    assert.deepEqual(options.contextFiles, []);
    assert.deepEqual(options.skills, []);
    assert.equal(options.sections.unrelated, "Unrelated section must remain intact.");
    assert.doesNotMatch(rendered, /<project_context>/);
    assert.doesNotMatch(rendered, /Project rules/);
    assert.doesNotMatch(rendered, /<skills>/);
    assert.doesNotMatch(rendered, /safe-bash description/);
    assert.match(rendered, /Keep this configured skill/);
    assert.doesNotMatch(rendered, /pi-subagents/);
    assert.match(rendered, /Unrelated section must remain intact\./);
    assert.match(rendered, /root child guidance/);
    assert.match(rendered, /project child guidance/);
    assert.match(rendered, /supervisor child guidance/);
    assert.match(rendered, /ticket child guidance/);
    assert.match(rendered, new RegExp(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
    assert.match(rendered, /<!-- tlh:child-root-runtime:start -->/);
    assert.match(rendered, /<!-- tlh:child-explicit-runtime:start -->/);
    assert.ok(
      rendered.indexOf("<tlh_child_root_runtime>") <
        rendered.indexOf("<tlh_child_explicit_runtime>"),
    );

    const inheritedOptions = makeStructuredPromptOptions();
    setStructuredChildPromptRuntime(inheritedOptions.sections, "root", ["root ordering guidance"]);
    rewriteSubagentPrompt(
      inheritedOptions,
      { inheritProjectContext: true, inheritSkills: true },
      "explicit ordering guidance",
    );
    const inheritedRendered = buildSystemPrompt(inheritedOptions);
    const projectContextIndex = inheritedRendered.indexOf("<project_context>");
    const skillsIndex = inheritedRendered.indexOf("<skills>");
    const cwdIndex = inheritedRendered.indexOf("<cwd>");
    const rootRuntimeIndex = inheritedRendered.indexOf("<tlh_child_root_runtime>");
    const explicitRuntimeIndex = inheritedRendered.indexOf("<tlh_child_explicit_runtime>");
    assert.ok(projectContextIndex >= 0);
    assert.ok(skillsIndex >= 0);
    assert.ok(cwdIndex >= 0);
    assert.ok(rootRuntimeIndex >= 0);
    assert.ok(explicitRuntimeIndex >= 0);
    assert.ok(projectContextIndex < rootRuntimeIndex);
    assert.ok(skillsIndex < rootRuntimeIndex);
    assert.ok(cwdIndex < rootRuntimeIndex);
    assert.ok(rootRuntimeIndex < explicitRuntimeIndex);
  });

  it("deletes a seeded project_context section when project inheritance is disabled", () => {
    const options = normalizeBuildSystemPromptOptions({
      cwd: "/repo",
      contextFiles: [{ path: "/repo/AGENTS.md", content: "Project rules" }],
      sections: {
        project_context: "Parent project section must be removed.",
        unrelated: "Keep this unrelated section.",
      },
    });

    rewriteSubagentPrompt(options, { inheritProjectContext: false, inheritSkills: true });

    const rendered = buildSystemPrompt(options);
    assert.equal(options.sections.project_context, undefined);
    assert.deepEqual(options.contextFiles, []);
    assert.doesNotMatch(rendered, /Parent project section must be removed/);
    assert.doesNotMatch(rendered, /Project rules/);
    assert.match(rendered, /Keep this unrelated section/);
  });

  it("deletes a seeded skills section when skill inheritance is disabled", () => {
    const options = normalizeBuildSystemPromptOptions({
      cwd: "/repo",
      skills: [makePromptSkill("safe-bash"), makePromptSkill("pi-subagents")],
      sections: {
        skills: "Parent skills section must be removed.",
        unrelated: "Keep this unrelated section.",
      },
    });

    rewriteSubagentPrompt(options, { inheritProjectContext: true, inheritSkills: false });

    const rendered = buildSystemPrompt(options);
    assert.equal(options.sections.skills, undefined);
    assert.deepEqual(options.skills, []);
    assert.doesNotMatch(rendered, /Parent skills section must be removed/);
    assert.doesNotMatch(rendered, /<name>safe-bash<\/name>/);
    assert.doesNotMatch(rendered, /<name>pi-subagents<\/name>/);
    assert.match(rendered, /Keep this unrelated section/);
  });

  it("sanitizes a seeded skills section while preserving unrelated skill markup", () => {
    const options = normalizeBuildSystemPromptOptions({
      cwd: "/repo",
      skills: [makePromptSkill("safe-bash"), makePromptSkill("pi-subagents")],
      sections: {
        skills: [
          '<skill name="pi-subagents">Remove the parent orchestration skill.</skill>',
          '<skill name="safe-bash">Keep this configured skill.</skill>',
        ].join("\n\n"),
      },
    });

    rewriteSubagentPrompt(options, { inheritProjectContext: true, inheritSkills: true });

    const rendered = buildSystemPrompt(options);
    assert.match(options.sections.skills, /<skill name="safe-bash">/);
    assert.doesNotMatch(options.sections.skills, /pi-subagents/);
    assert.doesNotMatch(rendered, /Remove the parent orchestration skill/);
    assert.match(rendered, /Keep this configured skill/);
    assert.deepEqual(
      options.skills.map((skill) => skill.name),
      ["safe-bash"],
    );
  });

  it("removes only the orchestration skill when inherited skills remain enabled", () => {
    const options = makeStructuredPromptOptions();
    rewriteSubagentPrompt(options, { inheritProjectContext: true, inheritSkills: true });

    const rendered = buildSystemPrompt(options);
    assert.deepEqual(
      options.skills.map((skill) => skill.name),
      ["safe-bash"],
    );
    assert.match(rendered, /<project_context>/);
    assert.match(rendered, /Project rules/);
    assert.match(rendered, /<skills>/);
    assert.match(rendered, /<name>safe-bash<\/name>/);
    assert.doesNotMatch(rendered, /<name>pi-subagents<\/name>/);
    assert.equal(options.sections.unrelated, "Unrelated section must remain intact.");
    assert.match(rendered, /Unrelated section must remain intact\./);
  });

  it("sanitizes orchestration skill markup from unrelated structured sections", () => {
    const options = makeStructuredPromptOptions();
    options.sections.unrelated = [
      "Keep this unrelated section.",
      '<skill name="pi-subagents">Remove the parent orchestration skill.</skill>',
      '<skill name="safe-bash">Keep this configured skill.</skill>',
      "<skill>\n  <name>pi-subagents</name>\n  <description>Remove this lazy entry.</description>\n</skill>",
    ].join("\n\n");

    rewriteSubagentPrompt(options, { inheritProjectContext: true, inheritSkills: true });

    assert.equal(options.sections.unrelated.includes("pi-subagents"), false);
    assert.match(options.sections.unrelated, /Keep this unrelated section/);
    assert.match(options.sections.unrelated, /<skill name="safe-bash">/);
    const rendered = buildSystemPrompt(options);
    assert.doesNotMatch(rendered, /Remove the parent orchestration skill/);
    assert.doesNotMatch(rendered, /Remove this lazy entry/);
    assert.match(rendered, /Keep this configured skill/);
  });

  it("mutates normalized prompt options from before_agent_start instead of returning a forced prompt", async () => {
    const handlers = registerPromptRuntimeHandlers();
    const options = makeStructuredPromptOptions();
    options.forceSystemPrompt = "FORCED handler replacement";
    const event = {
      systemPrompt: buildSystemPrompt(options),
      systemPromptOptions: options,
    };

    process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = "0";
    process.env.PI_SUBAGENT_INHERIT_SKILLS = "0";
    const result = await handlers.beforeAgentStart(event, makeMinimalCtx("/repo"));

    assert.equal(result, undefined);
    assert.equal(options.forceSystemPrompt, undefined);
    assert.doesNotMatch(buildSystemPrompt(options), /FORCED handler replacement/);
    assert.doesNotMatch(buildSystemPrompt(options), /Project rules/);
    assert.doesNotMatch(buildSystemPrompt(options), /<name>safe-bash<\/name>/);
    assert.equal(options.sections.unrelated, "Unrelated section must remain intact.");
    assert.match(buildSystemPrompt(options), new RegExp(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
  });

  it("keeps the explicit child boundary after a later handler returns a forced prompt", async () => {
    let laterHandlerRan = false;
    const result = await emitChainedBeforeAgentStart(
      {
        ...makeStructuredPromptOptions(),
        forceSystemPrompt: "FORCED late replacement",
      },
      [
        (pi) => registerSubagentPromptRuntime(pi),
        (pi) =>
          pi.on("before_agent_start", () => ({
            systemPrompt: "FORCED late replacement",
          })),
        (pi) =>
          pi.on("before_agent_start", () => {
            laterHandlerRan = true;
            return undefined;
          }),
      ],
    );

    assert.equal(laterHandlerRan, true);
    assert.equal(result.systemPromptOptions.forceSystemPrompt, undefined);
    const rendered = buildSystemPrompt(result.systemPromptOptions);
    assert.doesNotMatch(rendered, /FORCED late replacement/);
    assert.match(rendered, new RegExp(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
    assert.match(rendered, /Unrelated section must remain intact\./);
  });

  it("persists a validated developer ticket capsule at the prompt boundary", async (t) => {
    const fixture = makeProjectGuidanceFixture();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const handlers = registerPromptRuntimeHandlers();
    await withChildGuidanceEnv(
      fixture,
      "developer",
      async () => {
        const ctx = makeMinimalCtx(fixture.cwd);
        await handlers.sessionStart(ctx);
        const event = makePromptEvent(BASE_PROMPT);
        await handlers.beforeAgentStart(event, ctx);
        const prompt = renderPrompt(event);
        assert.match(prompt, /Developer ticket assignment:/);
        assert.match(prompt, /Ticket ID: tlhm-o1qg/);
        assert.match(prompt, /tk show tlhm-o1qg/);
        assert.equal((prompt.match(/tlhm-o1qg/g) ?? []).length, 2);
        assert.ok(prompt.includes(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
      },
      { tkTicketId: "tlhm-o1qg" },
    );

    await withChildGuidanceEnv(
      fixture,
      "custom-agent",
      async () => {
        const ctx = makeMinimalCtx(fixture.cwd);
        await handlers.sessionStart(ctx);
        const event = makePromptEvent(BASE_PROMPT);
        await handlers.beforeAgentStart(event, ctx);
        assert.doesNotMatch(renderPrompt(event), /Developer ticket assignment:/);
      },
      { tkTicketId: "tlhm-o1qg" },
    );
  });

  it("queues exactly one visible scope reminder with lifecycle-aware delivery", async (t) => {
    const fixture = makeProjectGuidanceFixture();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

    for (const testCase of [
      { reason: "threshold" as const, willRetry: false, deliverAs: "nextTurn" as const },
      { reason: "overflow" as const, willRetry: true, deliverAs: "steer" as const },
    ]) {
      const sent: Array<{
        message: Parameters<ExtensionAPI["sendMessage"]>[0];
        options: Parameters<ExtensionAPI["sendMessage"]>[1];
      }> = [];
      const handlers = registerPromptRuntimeHandlers((message, options) => {
        sent.push({ message, options });
      });

      await withChildGuidanceEnv(
        fixture,
        "developer",
        async () => {
          const ctx = makeMinimalCtx(fixture.cwd);
          await handlers.sessionStart(ctx);
          process.env[SUBAGENT_TK_TICKET_ID_ENV] = "tlhf-other";

          // Pi emits session_compact only after a successful compaction. A
          // non-retry compaction defers delivery to the next real prompt;
          // overflow retry already has a guaranteed continuation.
          handlers.sessionCompact({ type: "session_compact", ...testCase }, ctx);

          assert.equal(sent.length, 1);
          const reminder = sent[0];
          assert.ok(reminder);
          assert.equal(reminder.options?.deliverAs, testCase.deliverAs);
          assert.equal(reminder.options?.triggerTurn, undefined);
          assert.equal(reminder.message.customType, "tlh-developer-scope-reminder");
          assert.equal(reminder.message.display, true);
          assert.equal(typeof reminder.message.content, "string");
          if (typeof reminder.message.content !== "string") return;
          assert.match(reminder.message.content, /Re-run `tk show tlhf-v4ul`/);
          assert.match(reminder.message.content, /reread its acceptance criteria/);
          assert.match(reminder.message.content, /remain within the ticket's scope/);
          assert.equal(countOccurrences(reminder.message.content, "tlhf-v4ul"), 1);
          assert.doesNotMatch(reminder.message.content, /tlhf-other/);
        },
        { tkTicketId: "tlhf-v4ul" },
      );
    }
  });

  it("does not inject reminders for failed or out-of-scope child compactions", async (t) => {
    const fixture = makeProjectGuidanceFixture();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const sent: Array<{
      message: Parameters<ExtensionAPI["sendMessage"]>[0];
      options: Parameters<ExtensionAPI["sendMessage"]>[1];
    }> = [];
    const handlers = registerPromptRuntimeHandlers((message, options) => {
      sent.push({ message, options });
    });

    await withChildGuidanceEnv(
      fixture,
      "developer",
      async () => {
        const ctx = makeMinimalCtx(fixture.cwd);
        await handlers.sessionStart(ctx);
        // Failed and cancelled compactions use session_compact_failed; the
        // runtime deliberately registers no failure handler.
        assert.equal(handlers.sessionCompactFailed, undefined);
      },
      { tkTicketId: "tlhf-v4ul" },
    );

    for (const testCase of [
      { role: "architect", tkTicketId: "tlhf-v4ul" },
      { role: "developer", tkTicketId: undefined },
      { role: "developer", tkTicketId: "not a ticket" },
      { role: "custom-agent", tkTicketId: "tlhf-v4ul" },
    ]) {
      await withChildGuidanceEnv(
        fixture,
        testCase.role,
        async () => {
          const ctx = makeMinimalCtx(fixture.cwd);
          await handlers.sessionStart(ctx);
          handlers.sessionCompact(
            { type: "session_compact", reason: "threshold", willRetry: false },
            ctx,
          );
        },
        testCase.tkTicketId === undefined ? {} : { tkTicketId: testCase.tkTicketId },
      );
    }

    assert.equal(sent.length, 0);
  });

  it("omits the ticket capsule for missing or invalid developer environment values", async (t) => {
    const fixture = makeProjectGuidanceFixture();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const handlers = registerPromptRuntimeHandlers();
    for (const ticketId of [undefined, "bad id", "ticket.extra"] as const) {
      await withChildGuidanceEnv(
        fixture,
        "developer",
        async () => {
          const ctx = makeMinimalCtx(fixture.cwd);
          await handlers.sessionStart(ctx);
          const event = makePromptEvent(BASE_PROMPT);
          await handlers.beforeAgentStart(event, ctx);
          const prompt = renderPrompt(event);
          assert.doesNotMatch(prompt, /Developer ticket assignment:/);
          assert.doesNotMatch(prompt, /Ticket ID:/);
        },
        ticketId === undefined ? {} : { tkTicketId: ticketId },
      );
    }
  });

  it("injects a child-only boundary that forbids proposing or running subagents", () => {
    const options = makePromptEvent(BASE_PROMPT).systemPromptOptions;
    rewriteSubagentPrompt(options, { inheritProjectContext: true, inheritSkills: true });
    const rewritten = buildSystemPrompt(options);

    assert.ok(rewritten.includes(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
    assert.ok(rewritten.includes("Do not propose or run subagents."));
    assert.ok(rewritten.includes("If you need to edit files, use the available editing tools."));
    assert.ok(!rewritten.includes("call the actual edit/write tools"));
    assert.ok(
      rewritten.includes("Do not print tool-call syntax, patches, or pseudo-tool calls as text."),
    );
    rewriteSubagentPrompt(options, { inheritProjectContext: true, inheritSkills: true });
    const rewrittenAgain = buildSystemPrompt(options);
    assert.equal(countOccurrences(rewrittenAgain, CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), 1);
    assert.ok(rewrittenAgain.includes(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
  });

  it("keeps explicitly injected skill content when inherited skills are stripped", () => {
    const options = makeStructuredPromptOptions();
    rewriteSubagentPrompt(options, {
      inheritProjectContext: false,
      inheritSkills: false,
    });

    const rendered = buildSystemPrompt(options);
    assert.match(rendered, /<skill name="explicit">/);
    assert.doesNotMatch(rendered, /<skills>/);
    assert.doesNotMatch(rendered, /Project rules/);
  });

  it("keeps configured lazy skill references when inherited skills are stripped", () => {
    const options = makeStructuredPromptOptions();
    options.appendSystemPrompt = CONFIGURED_SKILLS_SECTION;
    rewriteSubagentPrompt(options, {
      inheritProjectContext: false,
      inheritSkills: false,
    });

    const rendered = buildSystemPrompt(options);
    assert.match(rendered, /<name>configured-skill<\/name>/);
    assert.match(rendered, /\/tmp\/configured-skill\/SKILL\.md/);
    assert.doesNotMatch(rendered, /<name>safe-bash<\/name>/);
    assert.doesNotMatch(rendered, /Project rules/);
  });

  it("strips the subagent orchestration skill even when inherited skills remain", () => {
    const options = makePromptEvent(BASE_PROMPT).systemPromptOptions;
    rewriteSubagentPrompt(options, { inheritProjectContext: true, inheritSkills: true });
    const rewritten = buildSystemPrompt(options);

    assert.ok(rewritten.includes("<name>safe-bash</name>"));
    assert.ok(!rewritten.includes("<name>pi-subagents</name>"));
    assert.ok(!rewritten.includes("delegate to subagents"));
  });

  it("strips explicit pi-subagents skill injection from child prompts", () => {
    const prompt =
      'Before\n\n<skill name="pi-subagents">\nDo not keep this.\n</skill>\n\n<skill name="safe-bash">\nKeep this.\n</skill>\nAfter';
    const rewritten = stripSubagentOrchestrationSkill(prompt);

    assert.ok(!rewritten.includes("Do not keep this"));
    assert.ok(rewritten.includes('<skill name="safe-bash">'));
  });

  it("defers native supervisor registration until runtime events", async () => {
    setSupervisorEnv();
    const handlers = new Map<TestEventName, TestEventHandler>();
    const registered: string[] = [];

    registerSubagentPromptRuntime(
      makeExtensionAPI({
        on: recordEvents(handlers),
        getAllTools: () => [makeToolInfo("contact_supervisor")],
        registerTool<TParams extends TSchema, TDetails, TState>(
          tool: ToolDefinition<TParams, TDetails, TState>,
        ) {
          registered.push(tool.name);
        },
      }),
    );

    assert.deepEqual(registered, []);
    handlers.get("session_start")?.({});
    await handlers.get("before_agent_start")?.(makePromptEvent(BASE_PROMPT));
    assert.deepEqual(registered, []);
  });

  it("fills a missing child contact_supervisor tool", async () => {
    setSupervisorEnv();
    const handlers = new Map<TestEventName, TestEventHandler>();
    const registered: string[] = [];

    registerSubagentPromptRuntime(
      makeExtensionAPI({
        on: recordEvents(handlers),
        getAllTools: () => registered.map(makeToolInfo),
        registerTool<TParams extends TSchema, TDetails, TState>(
          tool: ToolDefinition<TParams, TDetails, TState>,
        ) {
          registered.push(tool.name);
        },
      }),
    );

    handlers.get("session_start")?.({});
    await handlers.get("before_agent_start")?.(makePromptEvent(BASE_PROMPT));

    assert.deepEqual(registered, ["contact_supervisor"]);
  });

  it("registers contact_supervisor at runtime", async () => {
    setSupervisorEnv();
    const handlers = new Map<TestEventName, TestEventHandler>();
    const registered: string[] = [];

    registerSubagentPromptRuntime(
      makeExtensionAPI({
        on: recordEvents(handlers),
        getAllTools: () => registered.map(makeToolInfo),
        registerTool<TParams extends TSchema, TDetails, TState>(
          tool: ToolDefinition<TParams, TDetails, TState>,
        ) {
          registered.push(tool.name);
        },
      }),
    );

    handlers.get("session_start")?.({});
    assert.deepEqual(registered, ["contact_supervisor"]);

    await handlers.get("before_agent_start")?.(makePromptEvent(BASE_PROMPT));
    assert.deepEqual(registered, ["contact_supervisor"]);
  });

  it("rewrites the final child-visible prompt through before_agent_start", async () => {
    clearSupervisorEnv();
    const handlers = new Map<TestEventName, TestEventHandler>();
    registerSubagentPromptRuntime(
      makeExtensionAPI({
        on: recordEvents(handlers),
      }),
    );

    assert.ok(handlers.get("before_agent_start"), "expected before_agent_start handler");
    process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = "0";
    process.env.PI_SUBAGENT_INHERIT_SKILLS = "0";

    const options = makeStructuredPromptOptions();
    const rewritten = await handlers.get("before_agent_start")?.({
      systemPrompt: buildSystemPrompt(options),
      systemPromptOptions: options,
    });
    assert.equal(rewritten, undefined);
    const rendered = buildSystemPrompt(options);
    assert.ok(!rendered.includes("Project rules"));
    assert.ok(!rendered.includes("<skills>"));
    assert.ok(rendered.includes("<cwd>\n/repo\n</cwd>"));
  });
});

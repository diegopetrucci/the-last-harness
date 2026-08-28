import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import {
  ProjectTrustStore,
  type ExtensionAPI,
  type ToolDefinition,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { writeChildMessageRequestToDir } from "../../src/runs/background/control-channel.ts";
import {
  PACKAGED_MINOR_AGENT_ROLES,
  projectAgentGuidanceFilename,
} from "../../../shared/project-agent-guidance.ts";
import {
  CHILD_SUBAGENT_EXPLICIT_RUNTIME_CLOSE,
  CHILD_SUBAGENT_EXPLICIT_RUNTIME_OPEN,
} from "../../../shared/subagent-child-boundary.ts";
import {
  SUBAGENT_CHILD_AGENT_ENV,
  SUBAGENT_CHILD_INDEX_ENV,
  SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV,
  SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
  SUBAGENT_ORCHESTRATOR_TARGET_ENV,
  SUBAGENT_RUN_ID_ENV,
  SUBAGENT_STEER_INBOX_ENV,
  SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
} from "../../src/runs/shared/pi-args.ts";
import {
  STRUCTURED_OUTPUT_CAPTURE_ENV,
  STRUCTURED_OUTPUT_SCHEMA_ENV,
} from "../../src/runs/shared/structured-output.ts";
import { TOOL_BUDGET_ENV } from "../../src/runs/shared/tool-budget.ts";
import {
  BACKGROUND_COMPLETION_NUDGE_TEXT,
  CONTROL_NOTICE_NUDGE_TEXT,
} from "../../src/runs/shared/nudge-texts.ts";
import registerSubagentPromptRuntime, {
  CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
  SUBAGENT_INTERCOM_SESSION_NAME_ENV,
  rewriteSubagentPrompt,
  stripInheritedSkills,
  stripParentOnlySubagentMessages,
  stripProjectContext,
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

function recordEvents(handlers: Map<TestEventName, TestEventHandler>): TestEventRegistration["on"] {
  return (event, handler) => handlers.set(event, handler);
}

function makeToolInfo(name: string): ToolInfo {
  return {
    name,
    description: "test tool",
    parameters: Type.Object({}),
    sourceInfo: { path: "", source: "test", scope: "temporary", origin: "top-level" },
  };
}

function matchesToolParameters<TParams extends TSchema>(
  schema: TParams,
  value: unknown,
): value is Static<TParams> {
  return Compile(schema).Check(value);
}

function hasSystemPrompt(value: unknown): value is { systemPrompt: string } {
  if (typeof value !== "object" || value === null || !("systemPrompt" in value)) return false;
  return typeof value.systemPrompt === "string";
}

function countOccurrences(value: string, needle: string): number {
  return needle.length === 0 ? 0 : value.split(needle).length - 1;
}

function makeUserMessage(content: UserMessage["content"]): UserMessage {
  return { role: "user", content, timestamp: 1 };
}

function makeCustomMessage(customType: string, content: string): AgentMessage {
  return { role: "custom", customType, content, display: true, timestamp: 1 };
}

function makeToolResultMessage(toolName: string, content: string): ToolResultMessage<undefined> {
  return {
    role: "toolResult",
    toolCallId: `${toolName}-call`,
    toolName,
    content: [{ type: "text", text: content }],
    isError: false,
    timestamp: 1,
  };
}

function makeAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      totalTokens: 0,
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

const envSnapshot = {
  PI_SUBAGENT_INHERIT_PROJECT_CONTEXT: process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT,
  PI_SUBAGENT_INHERIT_SKILLS: process.env.PI_SUBAGENT_INHERIT_SKILLS,
  PI_SUBAGENT_INTERCOM_SESSION_NAME: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
  PI_SUBAGENT_STEER_INBOX: process.env.PI_SUBAGENT_STEER_INBOX,
  PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE: process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE,
  PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA: process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA,
  PI_SUBAGENT_TOOL_BUDGET: process.env.PI_SUBAGENT_TOOL_BUDGET,
  PI_SUBAGENT_ORCHESTRATOR_TARGET: process.env.PI_SUBAGENT_ORCHESTRATOR_TARGET,
  PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID,
  PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR: process.env.PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR,
  PI_SUBAGENT_RUN_ID: process.env.PI_SUBAGENT_RUN_ID,
  PI_SUBAGENT_CHILD_AGENT: process.env.PI_SUBAGENT_CHILD_AGENT,
  PI_SUBAGENT_CHILD_INDEX: process.env.PI_SUBAGENT_CHILD_INDEX,
  PI_SUBAGENT_PROJECT_AGENT_GUIDANCE: process.env.PI_SUBAGENT_PROJECT_AGENT_GUIDANCE,
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

const PROMPT_WITH_EXPLICIT_SKILL = [
  'You are a subagent.\n\n<skill name="explicit">\nKeep this section\n</skill>',
  "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n## /repo/AGENTS.md\n\nProject rules\n\n",
  SKILLS_SECTION,
  "\nCurrent date: 2026-04-16",
].join("");

const CONFIGURED_SKILLS_SECTION =
  "\n\nThe following configured skills are available to this subagent.\nUse the read tool to load a skill's file when the task matches its description.\nWhen a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n<available_skills>\n  <skill>\n    <name>configured-skill</name>\n    <description>explicit agent skill</description>\n    <location>/tmp/configured-skill/SKILL.md</location>\n  </skill>\n</available_skills>";

const STRUCTURED_OUTPUT_INSTRUCTIONS = [
  "This subagent step has a strict structured output contract.",
  "Your final action must be to call the `structured_output` tool with JSON matching the provided schema.",
  "Do not rely on prose-only completion; if you do not call `structured_output`, the parent will fail this step.",
].join("\n");

afterEach(() => {
  if (envSnapshot.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT === undefined)
    delete process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT;
  else
    process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT =
      envSnapshot.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT;
  if (envSnapshot.PI_SUBAGENT_INHERIT_SKILLS === undefined)
    delete process.env.PI_SUBAGENT_INHERIT_SKILLS;
  else process.env.PI_SUBAGENT_INHERIT_SKILLS = envSnapshot.PI_SUBAGENT_INHERIT_SKILLS;
  if (envSnapshot.PI_SUBAGENT_INTERCOM_SESSION_NAME === undefined)
    delete process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME;
  else
    process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME = envSnapshot.PI_SUBAGENT_INTERCOM_SESSION_NAME;
  if (envSnapshot.PI_SUBAGENT_STEER_INBOX === undefined)
    delete process.env[SUBAGENT_STEER_INBOX_ENV];
  else process.env[SUBAGENT_STEER_INBOX_ENV] = envSnapshot.PI_SUBAGENT_STEER_INBOX;
  if (envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE === undefined)
    delete process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
  else
    process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;
  if (envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA === undefined)
    delete process.env[STRUCTURED_OUTPUT_SCHEMA_ENV];
  else process.env[STRUCTURED_OUTPUT_SCHEMA_ENV] = envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA;
  if (envSnapshot.PI_SUBAGENT_TOOL_BUDGET === undefined) delete process.env[TOOL_BUDGET_ENV];
  else process.env[TOOL_BUDGET_ENV] = envSnapshot.PI_SUBAGENT_TOOL_BUDGET;
  if (envSnapshot.PI_SUBAGENT_ORCHESTRATOR_TARGET === undefined)
    delete process.env[SUBAGENT_ORCHESTRATOR_TARGET_ENV];
  else process.env[SUBAGENT_ORCHESTRATOR_TARGET_ENV] = envSnapshot.PI_SUBAGENT_ORCHESTRATOR_TARGET;
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
  } = {},
): Promise<T> {
  const previous = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_SUBAGENT_CHILD_AGENT: process.env[SUBAGENT_CHILD_AGENT_ENV],
    PI_SUBAGENT_PROJECT_AGENT_GUIDANCE: process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV],
    PI_SUBAGENT_INHERIT_PROJECT_CONTEXT: process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT,
    PI_SUBAGENT_INHERIT_SKILLS: process.env.PI_SUBAGENT_INHERIT_SKILLS,
  };
  process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
  if (role === undefined) delete process.env[SUBAGENT_CHILD_AGENT_ENV];
  else process.env[SUBAGENT_CHILD_AGENT_ENV] = role;
  process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] = Object.hasOwn(options, "projectAgentGuidance")
    ? String(options.projectAgentGuidance)
    : "1";
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

type PromptRuntimeHandlers = {
  beforeAgentStart: PromptRuntimeHandler;
  sessionStart: (ctx: ReturnType<typeof makeMinimalCtx>) => TestEventResult;
};

function isPromptRuntimeHandler(value: unknown): value is PromptRuntimeHandler {
  return typeof value === "function";
}

function registerPromptRuntimeHandlers(): PromptRuntimeHandlers {
  const handlers = new Map<TestEventName, PromptRuntimeHandler>();
  const extensionApi = makeExtensionAPI();
  extensionApi.on = ((event: string, handler: unknown) => {
    if (
      (event as TestEventName) !== "before_agent_start" &&
      (event as TestEventName) !== "session_start"
    ) {
      return;
    }
    if (isPromptRuntimeHandler(handler)) handlers.set(event as TestEventName, handler);
  }) as ExtensionAPI["on"];
  registerSubagentPromptRuntime(extensionApi);
  const beforeAgentStart = handlers.get("before_agent_start");
  const sessionStart = handlers.get("session_start");
  assert.ok(beforeAgentStart, "before_agent_start handler should be registered");
  assert.ok(sessionStart, "session_start handler should be registered");
  return {
    beforeAgentStart,
    sessionStart: (ctx) => sessionStart({}, ctx),
  };
}

function persistProjectTrust(fixture: ProjectGuidanceFixture): void {
  new ProjectTrustStore(fixture.agentDir).set(fixture.cwd, true);
}

function setSupervisorEnv(): void {
  process.env[SUBAGENT_ORCHESTRATOR_TARGET_ENV] = "subagent-chat-parent";
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
  delete process.env[SUBAGENT_ORCHESTRATOR_TARGET_ENV];
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
        const event = await handlers.beforeAgentStart(
          { systemPrompt: `packaged ${role} role` },
          ctx,
        );
        assert.ok(hasSystemPrompt(event));
        assert.equal((event.systemPrompt.match(/<tlh_project_agent_guidance>/g) ?? []).length, 1);
        assert.match(event.systemPrompt, new RegExp(`guidance-${role}`));
        for (const otherRole of PACKAGED_MINOR_AGENT_ROLES) {
          if (otherRole !== role)
            assert.doesNotMatch(event.systemPrompt, new RegExp(`guidance-${otherRole}`));
        }
        const guidanceIndex = event.systemPrompt.indexOf(`guidance-${role}`);
        const boundaryIndex = event.systemPrompt.lastIndexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS);
        assert.ok(guidanceIndex > `packaged ${role} role`.length);
        assert.ok(guidanceIndex < boundaryIndex);
        assert.ok(event.systemPrompt.endsWith(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));

        const repeated = await handlers.beforeAgentStart(event, ctx);
        const repeatedPrompt = hasSystemPrompt(repeated)
          ? repeated.systemPrompt
          : event.systemPrompt;
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
        const event = await handlers.beforeAgentStart(
          { systemPrompt: "custom packaged role" },
          ctx,
        );
        assert.ok(hasSystemPrompt(event));
        assert.doesNotMatch(event.systemPrompt, /TLH Project Agent Guidance/);
        assert.doesNotMatch(event.systemPrompt, /private developer guidance/);
        assert.ok(event.systemPrompt.endsWith(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
      });
    }
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
          const event = await handlers.beforeAgentStart({ systemPrompt: "packaged role" }, ctx);
          assert.ok(hasSystemPrompt(event));
          assert.doesNotMatch(event.systemPrompt, /verified developer guidance/);
        },
        { projectAgentGuidance: sentinel },
      );
    }
    await withChildGuidanceEnv(fixture, "developer", async () => {
      const ctx = makeMinimalCtx(fixture.cwd);
      await handlers.sessionStart(ctx);
      const event = await handlers.beforeAgentStart({ systemPrompt: "packaged role" }, ctx);
      assert.ok(hasSystemPrompt(event));
      assert.match(event.systemPrompt, /verified developer guidance/);
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

      const stale = await handlers.beforeAgentStart({ systemPrompt: "packaged role" }, ctx);
      assert.ok(hasSystemPrompt(stale));
      assert.match(stale.systemPrompt, /before session reload/);
      assert.doesNotMatch(stale.systemPrompt, /after session reload/);

      await handlers.sessionStart(ctx);
      const refreshed = await handlers.beforeAgentStart({ systemPrompt: "packaged role" }, ctx);
      assert.ok(hasSystemPrompt(refreshed));
      assert.match(refreshed.systemPrompt, /after session reload/);
      assert.doesNotMatch(refreshed.systemPrompt, /before session reload/);
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
      const event = await handlers.beforeAgentStart({ systemPrompt: "packaged role" }, ctx);
      assert.ok(hasSystemPrompt(event));
      assert.doesNotMatch(event.systemPrompt, /TLH Project Agent Guidance/);
      assert.doesNotMatch(event.systemPrompt, /untrusted guidance/);
    });

    persistProjectTrust(fixture);
    await withChildGuidanceEnv(fixture, "developer", async () => {
      const ctx = makeMinimalCtx(fixture.cwd);
      await handlers.sessionStart(ctx);
      const trusted = await handlers.beforeAgentStart({ systemPrompt: "packaged role" }, ctx);
      assert.ok(hasSystemPrompt(trusted));
      assert.match(trusted.systemPrompt, /untrusted guidance/);
    });
  });

  it("preserves matching guidance after inherited-context rewriting", async (t) => {
    const fixture = makeProjectGuidanceFixture();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    writeProjectGuidance(fixture, "code-reviewer", "review guidance");
    persistProjectTrust(fixture);

    const handlers = registerPromptRuntimeHandlers();
    const prompt = await withChildGuidanceEnv(
      fixture,
      "code-reviewer",
      async () => {
        const ctx = makeMinimalCtx(fixture.cwd);
        await handlers.sessionStart(ctx);
        return handlers.beforeAgentStart({ systemPrompt: BASE_PROMPT }, ctx);
      },
      { inheritProjectContext: false, inheritSkills: false },
    );
    assert.ok(hasSystemPrompt(prompt));
    assert.doesNotMatch(prompt.systemPrompt, /# Project Context/);
    assert.doesNotMatch(prompt.systemPrompt, /<name>pi-subagents<\/name>/);
    assert.match(prompt.systemPrompt, /review guidance/);
    assert.ok(prompt.systemPrompt.endsWith(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
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

  it("registered structured_output tool accepts valid schema output and writes the capture file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-structured-runtime-"));
    try {
      const schemaPath = path.join(dir, "schema.json");
      const outputPath = path.join(dir, "output.json");
      fs.writeFileSync(
        schemaPath,
        JSON.stringify({
          type: "object",
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
        }),
        "utf-8",
      );
      process.env[STRUCTURED_OUTPUT_SCHEMA_ENV] = schemaPath;
      process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = outputPath;
      let execute:
        | ((_id: string, params: { value: unknown }) => Promise<{ terminate?: boolean }>)
        | undefined;

      registerSubagentPromptRuntime(
        makeExtensionAPI({
          registerTool<TParams extends TSchema, TDetails, TState>(
            tool: ToolDefinition<TParams, TDetails, TState>,
          ) {
            if (tool.name !== "structured_output") return;
            execute = async (toolCallId, params) => {
              if (!matchesToolParameters(tool.parameters, params)) {
                throw new Error("test structured_output params failed schema validation");
              }
              const result = await tool.execute(
                toolCallId,
                params,
                undefined,
                undefined,
                makeMinimalCtx(process.cwd()),
              );
              return { terminate: result.terminate };
            };
          },
          on: () => {},
        }),
      );

      assert.ok(execute, "structured_output tool should be registered");
      const result = await execute("tool-1", { value: { ok: true } });
      assert.equal(result.terminate, true);
      assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf-8")), { ok: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips only the project context block", () => {
    const rewritten = stripProjectContext(BASE_PROMPT);
    assert.ok(!rewritten.includes("# Project Context"));
    assert.ok(
      rewritten.includes(
        "The following skills provide specialized instructions for specific tasks.",
      ),
    );
    assert.ok(rewritten.includes("Current date: 2026-04-16"));
  });

  it("strips only the inherited skills block", () => {
    const rewritten = stripInheritedSkills(BASE_PROMPT);
    assert.ok(rewritten.includes("# Project Context"));
    assert.ok(!rewritten.includes("<available_skills>"));
    assert.ok(rewritten.includes("Current date: 2026-04-16"));
  });

  it("can strip both inherited sections together", () => {
    const rewritten = rewriteSubagentPrompt(BASE_PROMPT, {
      inheritProjectContext: false,
      inheritSkills: false,
    });
    assert.ok(!rewritten.includes("# Project Context"));
    assert.ok(!rewritten.includes("<available_skills>"));
    assert.ok(rewritten.includes("Current working directory: /repo"));
  });

  it("keeps no-guidance and structured-output safety blocks singular", () => {
    const noGuidance = rewriteSubagentPrompt(
      `packaged role\n\n${CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS}`,
      {
        inheritProjectContext: true,
        inheritSkills: true,
      },
    );
    assert.equal(countOccurrences(noGuidance, CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), 1);
    assert.equal(
      countOccurrences(noGuidance, "This subagent step has a strict structured output contract."),
      0,
    );

    process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = "structured-output.json";
    const structured = rewriteSubagentPrompt(
      `packaged role\n\n${CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS}`,
      {
        inheritProjectContext: true,
        inheritSkills: true,
      },
    );
    assert.equal(countOccurrences(structured, CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), 1);
    assert.equal(
      countOccurrences(structured, "This subagent step has a strict structured output contract."),
      1,
    );
    assert.ok(
      structured.indexOf("This subagent step has a strict structured output contract.") <
        structured.indexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS),
    );
    const structuredAgain = rewriteSubagentPrompt(structured, {
      inheritProjectContext: true,
      inheritSkills: true,
    });
    assert.equal(countOccurrences(structuredAgain, CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), 1);
    assert.equal(
      countOccurrences(
        structuredAgain,
        "This subagent step has a strict structured output contract.",
      ),
      1,
    );
  });

  it("preserves role text containing guidance delimiters while deduplicating the exact snapshot", () => {
    const roleText = [
      "Packaged role instructions.",
      "## TLH Project Agent Guidance",
      "<tlh_project_agent_guidance>",
      "This heading and delimiter sequence is legitimate role text.",
      "</tlh_project_agent_guidance>",
    ].join("\n");
    const snapshot = [
      "## TLH Project Agent Guidance",
      "",
      "Source: .tlh/agents/builtin/DEVELOPER_PROMPT_APPEND.md",
      "",
      "<tlh_project_agent_guidance>",
      "Runtime guidance.",
      "</tlh_project_agent_guidance>",
    ].join("\n");
    const rewritten = rewriteSubagentPrompt(
      roleText,
      { inheritProjectContext: true, inheritSkills: true },
      snapshot,
    );
    assert.match(rewritten, /This heading and delimiter sequence is legitimate role text\./);
    assert.equal(countOccurrences(rewritten, "<tlh_project_agent_guidance>"), 2);
    assert.equal(countOccurrences(rewritten, "Runtime guidance."), 1);

    const repeated = rewriteSubagentPrompt(
      rewritten,
      { inheritProjectContext: true, inheritSkills: true },
      snapshot,
    );
    assert.match(repeated, /This heading and delimiter sequence is legitimate role text\./);
    assert.equal(countOccurrences(repeated, "<tlh_project_agent_guidance>"), 2);
    assert.equal(countOccurrences(repeated, "Runtime guidance."), 1);
    assert.ok(repeated.endsWith(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
  });

  it("preserves quoted runtime blocks and appends only the owned suffix", () => {
    process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = "structured-output.json";
    const snapshot = [
      "## TLH Project Agent Guidance",
      "",
      "Source: .tlh/agents/builtin/DEVELOPER_PROMPT_APPEND.md",
      "",
      "<tlh_project_agent_guidance>",
      "Runtime guidance.",
      "</tlh_project_agent_guidance>",
    ].join("\n");
    const quotedPrompt = [
      "Legitimate role and project text quotes runtime-looking blocks.",
      "Quoted project guidance:",
      snapshot,
      "Continuation after the quoted guidance.",
      "Quoted structured-output instructions:",
      STRUCTURED_OUTPUT_INSTRUCTIONS,
      "Continuation after the quoted structured-output instructions.",
      "Quoted child boundary:",
      CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
      "Continuation after the quoted child boundary.",
    ].join("\n\n");
    const explicitRuntimeBlock = [
      CHILD_SUBAGENT_EXPLICIT_RUNTIME_OPEN,
      [snapshot, STRUCTURED_OUTPUT_INSTRUCTIONS].join("\n\n"),
      CHILD_SUBAGENT_EXPLICIT_RUNTIME_CLOSE,
    ].join("\n");
    const promptWithRuntimeSuffix =
      [quotedPrompt, explicitRuntimeBlock, CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS].join("\n\n") +
      "\n \t";

    const rewritten = rewriteSubagentPrompt(
      promptWithRuntimeSuffix,
      { inheritProjectContext: true, inheritSkills: true },
      snapshot,
    );

    const expected = [
      quotedPrompt,
      explicitRuntimeBlock,
      CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
    ].join("\n\n");
    assert.equal(rewritten, expected);
    assert.equal(countOccurrences(rewritten, snapshot), 2);
    assert.equal(countOccurrences(rewritten, STRUCTURED_OUTPUT_INSTRUCTIONS), 2);
    assert.equal(countOccurrences(rewritten, CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), 2);
    assert.ok(rewritten.endsWith(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));

    const repeated = rewriteSubagentPrompt(
      rewritten,
      { inheritProjectContext: true, inheritSkills: true },
      snapshot,
    );
    assert.equal(repeated, expected);
  });

  it("injects a child-only boundary that forbids proposing or running subagents", () => {
    const rewritten = rewriteSubagentPrompt(BASE_PROMPT, {
      inheritProjectContext: true,
      inheritSkills: true,
    });

    assert.ok(rewritten.endsWith(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
    assert.ok(rewritten.includes("Do not propose or run subagents."));
    assert.ok(rewritten.includes("If you need to edit files, use the available editing tools."));
    assert.ok(!rewritten.includes("call the actual edit/write tools"));
    assert.ok(
      rewritten.includes("Do not print tool-call syntax, patches, or pseudo-tool calls as text."),
    );
    const rewrittenAgain = rewriteSubagentPrompt(rewritten, {
      inheritProjectContext: true,
      inheritSkills: true,
    });
    assert.equal(
      rewrittenAgain.indexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS),
      rewrittenAgain.length - CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS.length,
    );
    assert.equal(
      rewrittenAgain.lastIndexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS),
      rewrittenAgain.length - CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS.length,
    );
  });

  it("keeps explicitly injected skill content when inherited skills are stripped", () => {
    const rewritten = rewriteSubagentPrompt(PROMPT_WITH_EXPLICIT_SKILL, {
      inheritProjectContext: false,
      inheritSkills: false,
    });
    assert.ok(rewritten.includes('<skill name="explicit">'));
    assert.ok(!rewritten.includes("<available_skills>"));
    assert.ok(!rewritten.includes("# Project Context"));
  });

  it("keeps configured lazy skill references when inherited skills are stripped", () => {
    const prompt = [
      "You are a subagent.",
      CONFIGURED_SKILLS_SECTION,
      "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n## /repo/AGENTS.md\n\nProject rules\n\n",
      SKILLS_SECTION,
      "\nCurrent date: 2026-04-16",
    ].join("");
    const rewritten = rewriteSubagentPrompt(prompt, {
      inheritProjectContext: false,
      inheritSkills: false,
    });

    assert.ok(rewritten.includes("<name>configured-skill</name>"));
    assert.ok(rewritten.includes("/tmp/configured-skill/SKILL.md"));
    assert.ok(!rewritten.includes("<name>safe-bash</name>"));
    assert.ok(!rewritten.includes("# Project Context"));
  });

  it("strips the subagent orchestration skill even when inherited skills remain", () => {
    const rewritten = rewriteSubagentPrompt(BASE_PROMPT, {
      inheritProjectContext: true,
      inheritSkills: true,
    });

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

  it("strips parent-only subagent custom messages from forked child context", () => {
    const user = makeUserMessage("Task");
    const instruction = makeCustomMessage(
      "subagent-orchestration-instructions",
      "Subagent orchestration is enabled.",
    );
    const slashTextResult = makeCustomMessage("subagent-slash-text-result", "Subagent profiles");
    const notify = makeCustomMessage("subagent-notify", "Background task completed");
    const control = makeCustomMessage("subagent_control_notice", "needs attention");
    const otherCustom = makeCustomMessage("other", "keep");

    assert.deepEqual(
      stripParentOnlySubagentMessages([
        user,
        instruction,
        slashTextResult,
        notify,
        control,
        otherCustom,
      ]),
      [user, otherCustom],
    );
  });

  it("strips legacy slash-result custom messages from forked child context", () => {
    const legacySlashResult = makeCustomMessage("subagent-slash-result", "## Legacy result");
    const otherCustom = makeCustomMessage("other", "keep");

    assert.deepEqual(stripParentOnlySubagentMessages([legacySlashResult, otherCustom]), [
      otherCustom,
    ]);
  });

  it("strips prior parent subagent tool calls and results from forked child context", () => {
    const user = makeUserMessage("Task");
    const subagentResult = makeToolResultMessage("subagent", "subagent results");
    const readResult = makeToolResultMessage("read", "file contents");
    const mixedAssistant = makeAssistantMessage([
      { type: "text", text: "I will inspect the repo." },
      { type: "toolCall", id: "subagent-call", name: "subagent", arguments: { agent: "worker" } },
      { type: "toolCall", id: "read-call", name: "read", arguments: { path: "README.md" } },
    ]);
    const pureSubagentCall = makeAssistantMessage([
      {
        type: "toolCall",
        id: "reviewer-call",
        name: "subagent",
        arguments: { agent: "reviewer" },
      },
    ]);

    const textBlock = mixedAssistant.content[0];
    const readBlock = mixedAssistant.content[2];
    assert.ok(textBlock);
    assert.ok(readBlock);
    assert.deepEqual(
      stripParentOnlySubagentMessages([
        user,
        subagentResult,
        readResult,
        mixedAssistant,
        pureSubagentCall,
      ]),
      [
        user,
        readResult,
        {
          ...mixedAssistant,
          content: [textBlock, readBlock],
        },
      ],
    );
  });

  it("strips wake-up nudge user messages (string content) from forked child context", () => {
    const normalUser = makeUserMessage("Hello from the human.");
    const bgNudge = makeUserMessage(BACKGROUND_COMPLETION_NUDGE_TEXT);
    const controlNudge = makeUserMessage(CONTROL_NOTICE_NUDGE_TEXT);

    assert.deepEqual(stripParentOnlySubagentMessages([normalUser, bgNudge, controlNudge]), [
      normalUser,
    ]);
  });

  it("strips wake-up nudge user messages (single text-block content) from forked child context", () => {
    const normalUser = makeUserMessage([{ type: "text", text: "Hello from the human." }]);
    const bgNudge = makeUserMessage([{ type: "text", text: BACKGROUND_COMPLETION_NUDGE_TEXT }]);
    const controlNudge = makeUserMessage([{ type: "text", text: CONTROL_NOTICE_NUDGE_TEXT }]);

    assert.deepEqual(stripParentOnlySubagentMessages([normalUser, bgNudge, controlNudge]), [
      normalUser,
    ]);
  });

  it("does not strip normal user messages or [tlh]-prefixed messages that are not registered nudges", () => {
    const normalUser = makeUserMessage("Do the task.");
    const tlhPrefixed = makeUserMessage("[tlh] Some other instruction.");
    const almostNudge = makeUserMessage(BACKGROUND_COMPLETION_NUDGE_TEXT + " (extra)");

    const result = stripParentOnlySubagentMessages([normalUser, tlhPrefixed, almostNudge]);
    assert.deepEqual(result, [normalUser, tlhPrefixed, almostNudge]);
  });

  it("defers native supervisor registration until runtime events and respects installed pi-intercom tools", async () => {
    setSupervisorEnv();
    const handlers = new Map<TestEventName, TestEventHandler>();
    const registered: string[] = [];

    registerSubagentPromptRuntime(
      makeExtensionAPI({
        on: recordEvents(handlers),
        getAllTools: () => [makeToolInfo("intercom"), makeToolInfo("contact_supervisor")],
        registerTool<TParams extends TSchema, TDetails, TState>(
          tool: ToolDefinition<TParams, TDetails, TState>,
        ) {
          registered.push(tool.name);
        },
      }),
    );

    assert.deepEqual(registered, []);
    handlers.get("session_start")?.({});
    await handlers.get("before_agent_start")?.({ systemPrompt: BASE_PROMPT });
    assert.deepEqual(registered, []);
  });

  it("keeps installed pi-intercom while filling only a missing child contact_supervisor tool", async () => {
    setSupervisorEnv();
    const handlers = new Map<TestEventName, TestEventHandler>();
    const registered: string[] = [];

    registerSubagentPromptRuntime(
      makeExtensionAPI({
        on: recordEvents(handlers),
        getAllTools: () => [makeToolInfo("intercom"), ...registered.map(makeToolInfo)],
        registerTool<TParams extends TSchema, TDetails, TState>(
          tool: ToolDefinition<TParams, TDetails, TState>,
        ) {
          registered.push(tool.name);
        },
      }),
    );

    handlers.get("session_start")?.({});
    await handlers.get("before_agent_start")?.({ systemPrompt: BASE_PROMPT });

    assert.deepEqual(registered, ["contact_supervisor"]);
  });

  it("registers only contact_supervisor at runtime when pi-intercom is absent", async () => {
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

    await handlers.get("before_agent_start")?.({ systemPrompt: BASE_PROMPT });
    assert.deepEqual(registered, ["contact_supervisor"]);
  });

  it("sets the child intercom session name from env during agent startup", async () => {
    clearSupervisorEnv();
    let sessionName: string | undefined;
    const handlers = new Map<TestEventName, TestEventHandler>();
    process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV] = "subagent-worker-78f659a3";

    registerSubagentPromptRuntime(
      makeExtensionAPI({
        on: recordEvents(handlers),
        setSessionName(name: string) {
          sessionName = name;
        },
      }),
    );

    await handlers.get("before_agent_start")?.({ systemPrompt: BASE_PROMPT });

    assert.equal(sessionName, "subagent-worker-78f659a3");
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

    const rewritten = await handlers.get("before_agent_start")?.({
      systemPrompt: BASE_PROMPT,
    });
    assert.ok(hasSystemPrompt(rewritten));
    assert.ok(!rewritten.systemPrompt.includes("# Project Context"));
    assert.ok(!rewritten.systemPrompt.includes("<available_skills>"));
    assert.ok(rewritten.systemPrompt.includes("Current date: 2026-04-16"));
  });

  it("filters parent-only artifacts from polluted fork context while preserving ordinary history", () => {
    const handlers = new Map<TestEventName, TestEventHandler>();
    registerSubagentPromptRuntime(
      makeExtensionAPI({
        on: recordEvents(handlers),
      }),
    );

    const priorParentTurn = makeUserMessage(
      "Earlier we said planner → worker → reviewers → worker.",
    );
    const currentTask = makeUserMessage("Now implement only the assigned fix.");
    const instruction = makeCustomMessage(
      "subagent-orchestration-instructions",
      "Subagent orchestration is enabled.",
    );
    const subagentResult = makeToolResultMessage("subagent", "subagent results");
    const subagentCall = makeAssistantMessage([
      {
        type: "toolCall",
        id: "worker-call",
        name: "subagent",
        arguments: { agent: "worker" },
      },
    ]);
    const otherCustom = makeCustomMessage("other", "keep");

    assert.deepEqual(
      handlers.get("context")?.({
        messages: [
          priorParentTurn,
          instruction,
          subagentCall,
          subagentResult,
          otherCustom,
          currentTask,
        ],
      }),
      {
        messages: [priorParentTurn, otherCustom, currentTask],
      },
    );
  });

  it("does not rewrite child context when no parent-only artifacts are present", () => {
    const handlers = new Map<TestEventName, TestEventHandler>();
    registerSubagentPromptRuntime(
      makeExtensionAPI({
        on: recordEvents(handlers),
      }),
    );

    const messages: AgentMessage[] = [
      makeUserMessage("Task"),
      makeToolResultMessage("read", "file"),
      makeAssistantMessage([
        {
          type: "toolCall",
          id: "read-call",
          name: "read",
          arguments: { path: "README.md" },
        },
      ]),
    ];

    assert.equal(handlers.get("context")?.({ messages }), undefined);
  });
});

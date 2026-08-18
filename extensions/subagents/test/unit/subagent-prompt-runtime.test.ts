import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AgentMessage, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
  writeChildMessageRequestToDir,
  writeSteerRequestToDir,
} from "../../src/runs/background/control-channel.ts";
import {
  SUBAGENT_CHILD_AGENT_ENV,
  SUBAGENT_CHILD_INDEX_ENV,
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
import { makeExtensionAPI } from "../support/helpers.ts";

interface RuntimeLifecycleEvent {
  message?: AgentMessage;
  systemPrompt?: string;
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
});

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
  it("nudges after the tool budget soft limit and blocks configured tools after hard", () => {
    const handlers = new Map<
      string,
      (payload: { toolName?: string }) => BeforeToolCallResult | void
    >();
    const sent: string[] = [];
    process.env[TOOL_BUDGET_ENV] = JSON.stringify({ soft: 2, hard: 2, block: ["read"] });

    registerSubagentPromptRuntime(
      makeExtensionAPI({
        on(
          event: string,
          handler: (payload: { toolName?: string }) => BeforeToolCallResult | void,
        ): void {
          handlers.set(event, handler);
        },
        sendUserMessage(content: string) {
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
      const handlers = new Map<string, (payload?: RuntimeLifecycleEvent) => void>();
      const sent: Array<{ content: string; options: { deliverAs: string } }> = [];

      registerSubagentPromptRuntime(
        makeExtensionAPI({
          on(event: string, handler: (payload?: RuntimeLifecycleEvent) => void): void {
            handlers.set(event, handler);
          },
          sendUserMessage(content: string, options: { deliverAs: string }) {
            sent.push({ content, options });
          },
        }),
      );

      writeSteerRequestToDir(inbox, {
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
      const handlers = new Map<string, (payload?: RuntimeLifecycleEvent) => void>();
      const sent: Array<{ content: string; options: { deliverAs: string } }> = [];

      registerSubagentPromptRuntime(
        makeExtensionAPI({
          on(event: string, handler: (payload?: RuntimeLifecycleEvent) => void): void {
            handlers.set(event, handler);
          },
          sendUserMessage(content: string, options: { deliverAs: string }) {
            sent.push({ content, options });
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
          registerTool(tool: {
            name: string;
            execute: (_id: string, params: { value: unknown }) => Promise<{ terminate?: boolean }>;
          }) {
            if (tool.name === "structured_output") execute = tool.execute;
          },
          on() {},
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

  it("injects a child-only boundary that forbids proposing or running subagents", () => {
    const rewritten = rewriteSubagentPrompt(BASE_PROMPT, {
      inheritProjectContext: true,
      inheritSkills: true,
    });

    assert.ok(rewritten.startsWith(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
    assert.ok(rewritten.includes("Do not propose or run subagents."));
    assert.ok(rewritten.includes("If you need to edit files, use the available editing tools."));
    assert.ok(!rewritten.includes("call the actual edit/write tools"));
    assert.ok(
      rewritten.includes("Do not print tool-call syntax, patches, or pseudo-tool calls as text."),
    );
    assert.equal(
      rewriteSubagentPrompt(rewritten, {
        inheritProjectContext: true,
        inheritSkills: true,
      }).indexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS),
      0,
    );
    assert.equal(
      rewriteSubagentPrompt(rewritten, {
        inheritProjectContext: true,
        inheritSkills: true,
      }).lastIndexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS),
      0,
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
    const slashResult = makeCustomMessage("subagent-slash-result", "## Orchestration");
    const slashTextResult = makeCustomMessage("subagent-slash-text-result", "Subagent profiles");
    const notify = makeCustomMessage("subagent-notify", "Background task completed");
    const control = makeCustomMessage("subagent_control_notice", "needs attention");
    const otherCustom = makeCustomMessage("other", "keep");

    assert.deepEqual(
      stripParentOnlySubagentMessages([
        user,
        instruction,
        slashResult,
        slashTextResult,
        notify,
        control,
        otherCustom,
      ]),
      [user, otherCustom],
    );
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
    const handlers = new Map<string, (payload?: RuntimeLifecycleEvent) => void>();
    const registered: string[] = [];

    registerSubagentPromptRuntime(
      makeExtensionAPI({
        on(event: string, handler: (payload?: RuntimeLifecycleEvent) => void): void {
          handlers.set(event, handler);
        },
        getAllTools: () => [{ name: "intercom" }, { name: "contact_supervisor" }],
        registerTool(tool: { name: string }) {
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
    const handlers = new Map<string, (payload?: RuntimeLifecycleEvent) => void>();
    const registered: string[] = [];

    registerSubagentPromptRuntime(
      makeExtensionAPI({
        on(event: string, handler: (payload?: RuntimeLifecycleEvent) => void): void {
          handlers.set(event, handler);
        },
        getAllTools: () => [{ name: "intercom" }, ...registered.map((name) => ({ name }))],
        registerTool(tool: { name: string }) {
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
    const handlers = new Map<string, (payload?: RuntimeLifecycleEvent) => void>();
    const registered: string[] = [];

    registerSubagentPromptRuntime(
      makeExtensionAPI({
        on(event: string, handler: (payload?: RuntimeLifecycleEvent) => void): void {
          handlers.set(event, handler);
        },
        getAllTools: () => registered.map((name) => ({ name })),
        registerTool(tool: { name: string }) {
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
    let beforeAgentStart:
      | ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>)
      | undefined;
    process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV] = "subagent-worker-78f659a3";

    registerSubagentPromptRuntime(
      makeExtensionAPI({
        on(
          event: string,
          handler: (payload: {
            systemPrompt: string;
          }) => Promise<{ systemPrompt: string } | undefined>,
        ) {
          if (event === "before_agent_start") beforeAgentStart = handler;
        },
        setSessionName(name: string) {
          sessionName = name;
        },
      }),
    );

    await beforeAgentStart?.({ systemPrompt: BASE_PROMPT });

    assert.equal(sessionName, "subagent-worker-78f659a3");
  });

  it("rewrites the final child-visible prompt through before_agent_start", async () => {
    clearSupervisorEnv();
    let beforeAgentStart:
      | ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>)
      | undefined;
    registerSubagentPromptRuntime(
      makeExtensionAPI({
        on(
          event: string,
          handler: (payload: {
            systemPrompt: string;
          }) => Promise<{ systemPrompt: string } | undefined>,
        ) {
          if (event === "before_agent_start") beforeAgentStart = handler;
        },
      }),
    );

    assert.ok(beforeAgentStart, "expected before_agent_start handler");
    process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = "0";
    process.env.PI_SUBAGENT_INHERIT_SKILLS = "0";

    const rewritten = await beforeAgentStart?.({ systemPrompt: BASE_PROMPT });
    assert.ok(rewritten);
    assert.ok(!rewritten.systemPrompt.includes("# Project Context"));
    assert.ok(!rewritten.systemPrompt.includes("<available_skills>"));
    assert.ok(rewritten.systemPrompt.includes("Current date: 2026-04-16"));
  });

  it("filters parent-only artifacts from polluted fork context while preserving ordinary history", () => {
    let contextHandler:
      | ((event: { messages: AgentMessage[] }) => { messages: AgentMessage[] } | undefined)
      | undefined;
    registerSubagentPromptRuntime(
      makeExtensionAPI({
        on(
          event: string,
          handler: (payload: {
            messages: AgentMessage[];
          }) => { messages: AgentMessage[] } | undefined,
        ): void {
          if (event === "context") contextHandler = handler;
        },
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
    const slashResult = makeCustomMessage("subagent-slash-result", "## Orchestration");
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
      contextHandler?.({
        messages: [
          priorParentTurn,
          instruction,
          slashResult,
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
    let contextHandler:
      | ((event: { messages: AgentMessage[] }) => { messages: AgentMessage[] } | undefined)
      | undefined;
    registerSubagentPromptRuntime(
      makeExtensionAPI({
        on(
          event: string,
          handler: (payload: {
            messages: AgentMessage[];
          }) => { messages: AgentMessage[] } | undefined,
        ): void {
          if (event === "context") contextHandler = handler;
        },
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

    assert.equal(contextHandler?.({ messages }), undefined);
  });
});

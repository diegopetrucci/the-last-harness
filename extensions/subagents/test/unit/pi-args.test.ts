import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { TOOL_BUDGET_ENV } from "../../src/runs/shared/tool-budget.ts";
import {
  SUBAGENT_PARENT_SESSION_ENV,
  SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
  SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
  SUBAGENT_CHILD_ENV,
  applyThinkingSuffix,
  buildPiArgs,
  getThinkingLevelDropNote,
} from "../../src/runs/shared/pi-args.ts";

const originalEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_SUBAGENT_PARENT_SESSION: process.env.PI_SUBAGENT_PARENT_SESSION,
  PI_SUBAGENT_RUN_ID: process.env.PI_SUBAGENT_RUN_ID,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("buildPiArgs session wiring", () => {
  it("uses --session when sessionFile is provided", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-session-"));
    try {
      const sessionFile = path.join(tempDir, "nested", "session.jsonl");
      const { args } = buildPiArgs({
        baseArgs: ["-p"],
        task: "hello",
        sessionEnabled: true,
        sessionFile,
        sessionDir: "/tmp/should-not-be-used",
        inheritProjectContext: false,
        inheritSkills: false,
      });

      assert.ok(args.includes("--session"));
      assert.ok(args.includes(sessionFile));
      assert.ok(fs.existsSync(path.dirname(sessionFile)));
      assert.ok(
        !args.includes("--session-dir"),
        "--session-dir should not be emitted with --session",
      );
      assert.ok(
        !args.includes("--no-session"),
        "--no-session should not be emitted with --session",
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps fresh mode behavior (sessionDir + no session file)", () => {
    const { args } = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: true,
      sessionDir: "/tmp/subagent-sessions",
      inheritProjectContext: false,
      inheritSkills: false,
    });

    assert.ok(args.includes("--session-dir"));
    assert.ok(args.includes("/tmp/subagent-sessions"));
    assert.ok(!args.includes("--session"));
  });

  it("emits explicit parent session env for permission forwarding", () => {
    process.env.PI_SUBAGENT_PARENT_SESSION = "inherited-parent";
    const { env } = buildPiArgs({
      parentSessionId: "direct-parent",
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: false,
      inheritSkills: false,
    });

    assert.equal(env[SUBAGENT_PARENT_SESSION_ENV], "direct-parent");
  });

  it("falls back to inherited parent session env for permission forwarding", () => {
    process.env.PI_SUBAGENT_PARENT_SESSION = "inherited-parent";
    const { env } = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: false,
      inheritSkills: false,
    });

    assert.equal(env[SUBAGENT_PARENT_SESSION_ENV], "inherited-parent");
  });
});

describe("buildPiArgs model wiring", () => {
  it("uses --model for provider-qualified model ids", () => {
    const { args } = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: false,
      model: "openai-codex/gpt-5.4-mini",
      inheritProjectContext: false,
      inheritSkills: false,
    });

    assert.ok(args.includes("--model"));
    assert.ok(args.includes("openai-codex/gpt-5.4-mini"));
    assert.ok(!args.includes("--models"));
  });

  it("uses --model for bare model ids too", () => {
    const { args } = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: false,
      model: "kimi-k2.5",
      inheritProjectContext: false,
      inheritSkills: false,
    });

    assert.ok(args.includes("--model"));
    assert.ok(args.includes("kimi-k2.5"));
    assert.ok(!args.includes("--models"));
  });

  it("preserves thinking suffixes on model args", () => {
    const { args } = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: false,
      model: "openai-codex/gpt-5.4-mini",
      thinking: "high",
      inheritProjectContext: false,
      inheritSkills: false,
    });

    assert.equal(
      applyThinkingSuffix("openai-codex/gpt-5.4-mini", "high"),
      "openai-codex/gpt-5.4-mini:high",
    );
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("openai-codex/gpt-5.4-mini:high"));
  });

  it("passes max thinking through to the model argument", () => {
    const { args } = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      model: "openai/gpt-5",
      thinking: "max",
      sessionEnabled: false,
      inheritProjectContext: false,
      inheritSkills: false,
    });

    assert.equal(applyThinkingSuffix("openai/gpt-5", "max"), "openai/gpt-5:max");
    assert.equal(applyThinkingSuffix("openai/gpt-5:max", "high"), "openai/gpt-5:max");
    assert.equal(applyThinkingSuffix("openai/gpt-5:max", "high", true), "openai/gpt-5:high");
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("openai/gpt-5:max"));
  });

  it("reports only capability-gated thinking drops", () => {
    const availableModels = [
      {
        provider: "openai",
        id: "gpt-5",
        fullId: "openai/gpt-5",
        reasoning: true,
        thinkingLevelMap: { high: "high", max: null },
      },
    ];
    const note = getThinkingLevelDropNote("openai/gpt-5", "max", false, { availableModels });
    assert.equal(
      note,
      'Notice: Thinking level "max" was dropped for model "openai/gpt-5" because the model registry does not advertise support.',
    );
    assert.equal(
      getThinkingLevelDropNote("openai/gpt-5", "high", false, { availableModels }),
      undefined,
    );
    assert.equal(
      getThinkingLevelDropNote("openai/not-listed", "max", false, { availableModels }),
      undefined,
    );
    assert.equal(
      getThinkingLevelDropNote("openai/gpt-5", "max", true, { availableModels }),
      undefined,
    );
  });

  it("drops known-unsupported thinking levels when model capabilities are available", () => {
    const availableModels = [
      {
        provider: "openai",
        id: "gpt-5",
        fullId: "openai/gpt-5",
        reasoning: true,
        thinkingLevelMap: { max: null },
      },
    ];
    const model = applyThinkingSuffix("openai/gpt-5", "max", false, { availableModels });
    assert.equal(model, "openai/gpt-5");

    const { args } = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: false,
      model,
      thinking: "max",
      availableModels,
      inheritProjectContext: false,
      inheritSkills: false,
    });
    assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-5");
  });

  it("fails open for resolved models without a thinking-level map", () => {
    const availableModels = [
      {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        fullId: "anthropic/claude-sonnet-4-5",
        reasoning: true,
      },
    ];
    assert.equal(
      applyThinkingSuffix("anthropic/claude-sonnet-4-5", "max", false, { availableModels }),
      "anthropic/claude-sonnet-4-5:max",
    );
    assert.equal(
      getThinkingLevelDropNote("anthropic/claude-sonnet-4-5", "max", false, { availableModels }),
      undefined,
    );
  });

  it("fails open for unknown and unavailable model capabilities", () => {
    const availableModels = [
      { provider: "openai", id: "gpt-5", fullId: "openai/gpt-5", reasoning: false },
    ];
    assert.equal(
      applyThinkingSuffix("openai/not-listed", "high", false, { availableModels }),
      "openai/not-listed:high",
    );
    assert.equal(
      applyThinkingSuffix("openai/gpt-5", "high", false, { availableModels: [] }),
      "openai/gpt-5:high",
    );
  });

  it("gates positive capability metadata and keeps drop notes in lockstep", () => {
    const cases = [
      {
        thinking: "max",
        availableModels: [
          {
            provider: "openai",
            id: "gpt-5",
            fullId: "openai/gpt-5",
            reasoning: true,
            thinkingLevelMap: { xhigh: "xhigh" },
          },
        ],
        dropped: true,
      },
      {
        thinking: "xhigh",
        availableModels: [
          {
            provider: "openai",
            id: "gpt-5",
            fullId: "openai/gpt-5",
            reasoning: true,
            thinkingLevelMap: { max: "max" },
          },
        ],
        dropped: true,
      },
      {
        thinking: "high",
        availableModels: [
          {
            provider: "openai",
            id: "gpt-5",
            fullId: "openai/gpt-5",
            reasoning: true,
            thinkingLevelMap: { high: null },
          },
        ],
        dropped: true,
      },
      {
        thinking: "high",
        availableModels: [
          {
            provider: "openai",
            id: "gpt-5",
            fullId: "openai/gpt-5",
            reasoning: true,
            thinkingLevelMap: { high: "high" },
          },
        ],
        dropped: false,
      },
    ];

    for (const testCase of cases) {
      const model = applyThinkingSuffix("openai/gpt-5", testCase.thinking, false, {
        availableModels: testCase.availableModels,
      });
      const note = getThinkingLevelDropNote("openai/gpt-5", testCase.thinking, false, {
        availableModels: testCase.availableModels,
      });
      assert.equal(model === "openai/gpt-5", testCase.dropped);
      assert.equal(Boolean(note), testCase.dropped);
    }
  });

  it("gates reasoning-disabled models at every level except off", () => {
    const availableModels = [
      { provider: "openai", id: "gpt-5", fullId: "openai/gpt-5", reasoning: false },
    ];
    for (const thinking of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
      assert.equal(
        applyThinkingSuffix("openai/gpt-5", thinking, false, { availableModels }),
        "openai/gpt-5",
      );
      assert.ok(getThinkingLevelDropNote("openai/gpt-5", thinking, false, { availableModels }));
    }
    assert.equal(
      applyThinkingSuffix("openai/gpt-5", "off", false, { availableModels }),
      "openai/gpt-5:off",
    );
    assert.equal(
      getThinkingLevelDropNote("openai/gpt-5", "off", false, { availableModels }),
      undefined,
    );
  });

  it("preserves an already-suffixed model before capability checks", () => {
    const availableModels = [
      {
        provider: "openai",
        id: "gpt-5",
        fullId: "openai/gpt-5",
        reasoning: true,
        thinkingLevelMap: { high: null, max: null },
      },
    ];
    assert.equal(
      applyThinkingSuffix("openai/gpt-5:high", "max", false, { availableModels }),
      "openai/gpt-5:high",
    );
  });

  it("leaves explicit thinking overrides ungated", () => {
    const availableModels = [
      { provider: "openai", id: "gpt-5", fullId: "openai/gpt-5", reasoning: false },
    ];
    assert.equal(
      applyThinkingSuffix("openai/gpt-5", "high", true, { availableModels }),
      "openai/gpt-5:high",
    );
  });

  it("passes explicit thinking off through to the model arg", () => {
    const { args } = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: false,
      model: "anthropic/claude-haiku-4-5",
      thinking: "off",
      inheritProjectContext: false,
      inheritSkills: false,
    });

    assert.equal(
      applyThinkingSuffix("anthropic/claude-haiku-4-5", "off"),
      "anthropic/claude-haiku-4-5:off",
    );
    assert.equal(
      applyThinkingSuffix("anthropic/claude-haiku-4-5:high", "off", true),
      "anthropic/claude-haiku-4-5:off",
    );
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("anthropic/claude-haiku-4-5:off"));
  });

  it("does not append a thinking suffix for boolean false", () => {
    const model = "glm-5.2-short-fast";
    const once = applyThinkingSuffix(model, false);
    assert.equal(once, model);
    assert.equal(applyThinkingSuffix(once, false), model);

    const { args } = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: false,
      model,
      thinking: false,
      inheritProjectContext: false,
      inheritSkills: false,
    });

    assert.ok(args.includes("--model"));
    assert.ok(args.includes(model));
    assert.ok(!args.some((arg) => arg.includes(":false")));
  });

  it("leaves provider-specific model suffixes untouched when thinking is disabled", () => {
    const model = "openai-compatible/qwen2.5-coder:7b";
    const { args } = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: false,
      model,
      inheritProjectContext: false,
      inheritSkills: false,
    });

    assert.ok(args.includes("--model"));
    assert.ok(args.includes(model));
    assert.ok(!args.includes(`${model}:high`));
  });
});

describe("buildPiArgs system prompt mode wiring", () => {
  it("uses --append-system-prompt by default", () => {
    const { args } = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: false,
      systemPrompt: "You are a worker",
      inheritProjectContext: false,
      inheritSkills: false,
    });

    assert.ok(args.includes("--append-system-prompt"));
    assert.ok(!args.includes("--system-prompt"));
  });

  it("uses --system-prompt when systemPromptMode=replace", () => {
    const { args } = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: false,
      systemPrompt: "You are a worker",
      systemPromptMode: "replace",
      inheritProjectContext: false,
      inheritSkills: false,
    });

    assert.ok(args.includes("--system-prompt"));
    assert.ok(!args.includes("--append-system-prompt"));
  });

  it("injects the subagent prompt runtime extension and env flags", () => {
    const { args, env } = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: false,
      inheritSkills: true,
    });

    const extensionArgs = args.filter((_arg, index) => args[index - 1] === "--extension");
    assert.ok(
      extensionArgs.some((arg) =>
        arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts")),
      ),
    );
    assert.equal(env.PI_SUBAGENT_CHILD, "1");
    assert.equal(env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT, "0");
    assert.equal(env.PI_SUBAGENT_INHERIT_SKILLS, "1");
  });

  it("passes tool budget through env", () => {
    const { env } = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: false,
      inheritSkills: false,
      toolBudget: { soft: 2, hard: 3, block: ["read"] },
    });

    assert.deepEqual(JSON.parse(env[TOOL_BUDGET_ENV] ?? "{}"), {
      soft: 2,
      hard: 3,
      block: ["read"],
    });
  });

  it("passes child intercom and orchestrator metadata through env", () => {
    const { env } = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: true,
      inheritSkills: true,
      intercomSessionName: "subagent-worker-78f659a3",
      orchestratorIntercomTarget: "subagent-chat-parent",
      parentSessionId: "session-parent-123",
      runId: "78f659a3",
      childAgentName: "worker",
      childIndex: 2,
    });

    assert.equal(env.PI_SUBAGENT_INTERCOM_SESSION_NAME, "subagent-worker-78f659a3");
    assert.equal(env.PI_SUBAGENT_ORCHESTRATOR_TARGET, "subagent-chat-parent");
    assert.equal(env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV], "session-parent-123");
    assert.equal(env.PI_SUBAGENT_RUN_ID, "78f659a3");
    assert.equal(env.PI_SUBAGENT_CHILD_AGENT, "worker");
    assert.equal(env.PI_SUBAGENT_CHILD_INDEX, "2");
    assert.equal(typeof env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV], "string");
    assert.match(env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV] ?? "", /supervisor-channels/);
  });

  it("does not create a supervisor channel without an exact parent session id", () => {
    const { env } = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: true,
      inheritSkills: true,
      orchestratorIntercomTarget: "subagent-chat-parent",
      runId: "78f659a3",
      childAgentName: "worker",
      childIndex: 2,
    });

    assert.equal(env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV], undefined);
    assert.equal(env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV], undefined);
  });

  it("emits explicit builtin tool allowlists", () => {
    const { args } = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: false,
      inheritSkills: false,
      tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"],
    });

    const toolsArg = args[args.indexOf("--tools") + 1];
    assert.equal(toolsArg, "read,grep,find,ls,bash,edit,write,contact_supervisor");
  });

  it("adds read to explicit tool allowlists when skills must be loaded lazily", () => {
    const { args } = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: false,
      inheritSkills: false,
      requireReadTool: true,
      tools: ["bash"],
    });

    assert.equal(args[args.indexOf("--tools") + 1], "read,bash");
  });

  it("does not duplicate read in explicit tool allowlists for lazy skills", () => {
    const { args } = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: false,
      inheritSkills: false,
      requireReadTool: true,
      tools: ["read", "bash"],
    });

    assert.equal(args[args.indexOf("--tools") + 1], "read,bash");
  });

  it("always sets MCP_DIRECT_TOOLS=__none__ sentinel for @diegopetrucci/pi-mcp-adapter", () => {
    // The adapter's init.ts checks envDirect !== "__none__" before bootstrapping direct MCP tools.
    // An unset MCP_DIRECT_TOOLS means "bootstrap everything configured", which would widen every child's tool surface.
    const { env } = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: false,
      inheritSkills: false,
    });
    assert.equal(env.MCP_DIRECT_TOOLS, "__none__");
  });

  it("loads subagent-only extension paths only through child process extension args", () => {
    const { args } = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: false,
      inheritSkills: false,
      tools: ["read"],
      extensions: ["./main-allowed-ext.ts"],
      subagentOnlyExtensions: ["./child-tool.ts"],
    });

    const extensionArgs = args.filter((_arg, index) => args[index - 1] === "--extension");
    assert.ok(args.includes("--no-extensions"));
    assert.equal(args[args.indexOf("--tools") + 1], "read");
    assert.ok(extensionArgs.includes("./main-allowed-ext.ts"));
    assert.ok(extensionArgs.includes("./child-tool.ts"));
  });

  it("child spawn receives no parent-address env and loads no fanout-child extension", () => {
    const { args, env } = buildPiArgs({
      baseArgs: [],
      task: "work",
      sessionEnabled: false,
      inheritProjectContext: false,
      inheritSkills: false,
      tools: ["read", "subagent"],
    });

    // A child spawn must never receive parent-address env vars regardless of tools declared.
    // These env vars are what allowed a child to become a nested-fanout orchestrator.
    assert.equal(Object.hasOwn(env, "PI_SUBAGENT_PARENT_EVENT_SINK"), false);
    assert.equal(Object.hasOwn(env, "PI_SUBAGENT_PARENT_CONTROL_INBOX"), false);
    assert.equal(Object.hasOwn(env, "PI_SUBAGENT_PARENT_ROOT_RUN_ID"), false);
    assert.equal(Object.hasOwn(env, "PI_SUBAGENT_PARENT_RUN_ID"), false);
    assert.equal(Object.hasOwn(env, "PI_SUBAGENT_PARENT_CHILD_INDEX"), false);
    assert.equal(Object.hasOwn(env, "PI_SUBAGENT_PARENT_DEPTH"), false);
    assert.equal(Object.hasOwn(env, "PI_SUBAGENT_PARENT_PATH"), false);
    assert.equal(Object.hasOwn(env, "PI_SUBAGENT_PARENT_CAPABILITY_TOKEN"), false);
    // SUBAGENT_CHILD_ENV must be set so the child knows it is a child.
    assert.equal(env[SUBAGENT_CHILD_ENV], "1");
    // The fanout-child extension must NOT be added to the extension list.
    const extensionArgs = args.filter((_arg, index) => args[index - 1] === "--extension");
    assert.ok(!extensionArgs.some((arg) => arg.includes("fanout-child")));
    // Only the prompt-runtime extension is added.
    assert.ok(extensionArgs.some((arg) => arg.includes("subagent-prompt-runtime")));
  });

  it("emits an empty prompt file when replace mode is used with an empty prompt", () => {
    const { args } = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: false,
      systemPrompt: "",
      systemPromptMode: "replace",
      inheritProjectContext: false,
      inheritSkills: false,
    });

    assert.ok(args.includes("--system-prompt"));
  });
});

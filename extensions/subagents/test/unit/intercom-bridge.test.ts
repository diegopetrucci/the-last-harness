import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { buildPiArgs } from "../../src/runs/shared/pi-args.ts";
import {
  NATIVE_INTERCOM_EXTENSION_DIR,
  applyIntercomBridgeToAgent,
  diagnoseIntercomBridge,
  resolveIntercomBridge,
  resolveIntercomSessionTarget,
  resolveSubagentIntercomTarget,
  resolveIntercomBridgeMode,
  type IntercomBridgeState,
} from "../../src/intercom/intercom-bridge.ts";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "worker",
    description: "Test worker",
    systemPrompt: "Base prompt",
    systemPromptMode: "replace",
    inheritProjectContext: false,
    inheritSkills: false,
    source: "user",
    filePath: "/tmp/worker.md",
    ...overrides,
  };
}

describe("resolveIntercomBridgeMode", () => {
  it("defaults unknown values to always", () => {
    assert.equal(resolveIntercomBridgeMode(undefined), "always");
    assert.equal(resolveIntercomBridgeMode("nope"), "always");
  });

  it("accepts explicit modes", () => {
    assert.equal(resolveIntercomBridgeMode("off"), "off");
    assert.equal(resolveIntercomBridgeMode("fork-only"), "fork-only");
    assert.equal(resolveIntercomBridgeMode("always"), "always");
  });
});

describe("resolveIntercomSessionTarget", () => {
  it("prefers an explicit session name", () => {
    assert.equal(resolveIntercomSessionTarget("planner", "session-12345678"), "planner");
  });

  it("uses a runtime-only subagent chat alias when unnamed", () => {
    assert.equal(
      resolveIntercomSessionTarget(undefined, "session-12345678"),
      "subagent-chat-12345678",
    );
  });
});

describe("resolveSubagentIntercomTarget", () => {
  it("builds stable child session targets from run metadata", () => {
    assert.equal(resolveSubagentIntercomTarget("78f659a3", "worker"), "subagent-worker-78f659a3");
    assert.equal(
      resolveSubagentIntercomTarget("78f659a3", "senior executor", 1),
      "subagent-senior-executor-78f659a3-2",
    );
  });
});

describe("diagnoseIntercomBridge", () => {
  it("reports the native supervisor channel as available without external package discovery", () => {
    const diagnostic = diagnoseIntercomBridge({
      config: { mode: "always" },
      context: "fresh",
      orchestratorTarget: "main",
    });

    assert.equal(diagnostic.active, true);
    assert.equal(diagnostic.wantsIntercom, true);
    assert.equal(diagnostic.supervisorChannelAvailable, true);
    assert.equal(diagnostic.extensionDir, NATIVE_INTERCOM_EXTENSION_DIR);
  });

  it("does not read external intercom config when bridge mode is off", () => {
    const diagnostic = diagnoseIntercomBridge({
      config: { mode: "off" },
      context: "fresh",
      orchestratorTarget: "main",
    });

    assert.equal(diagnostic.active, false);
    assert.equal(diagnostic.reason, "bridge mode is off");
  });
});

describe("resolveIntercomBridge", () => {
  it("activates when mode/context permit and an orchestrator target exists", () => {
    const bridge = resolveIntercomBridge({
      config: { mode: "fork-only" },
      context: "fork",
      orchestratorTarget: "main",
    });

    assert.equal(bridge.active, true);
    assert.equal(bridge.orchestratorTarget, "main");
    assert.equal(bridge.extensionDir, NATIVE_INTERCOM_EXTENSION_DIR);
  });

  it("stays inactive for fresh context when mode is fork-only", () => {
    const bridge = resolveIntercomBridge({
      config: { mode: "fork-only" },
      context: "fresh",
      orchestratorTarget: "main",
    });
    assert.equal(bridge.active, false);
  });

  it("loads custom instructions from instructionFile", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-intercom-bridge-test-"));
    const instructionFile = path.join(tempDir, "bridge.md");
    fs.writeFileSync(instructionFile, "Custom bridge for {orchestratorTarget}\nUse ask then send.");
    try {
      const bridge = resolveIntercomBridge({
        config: { mode: "always", instructionFile },
        context: "fresh",
        orchestratorTarget: "main",
      });
      assert.equal(bridge.active, true);
      assert.match(bridge.instruction, /Custom bridge for main/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses stronger default instructions for fork-aware coordination", () => {
    const bridge = resolveIntercomBridge({
      config: { mode: "always" },
      context: "fork",
      orchestratorTarget: "main",
    });
    assert.equal(bridge.active, true);
    assert.match(bridge.instruction, /reference-only/i);
    assert.match(bridge.instruction, /normal assistant text/i);
    assert.match(bridge.instruction, /contact_supervisor/);
    assert.match(
      bridge.instruction,
      /supervisorBridge: false opts out of this generic bridge guidance and runtime contact_supervisor support/i,
    );
    assert.match(bridge.instruction, /need_decision/);
    assert.match(bridge.instruction, /progress_update/);
    assert.doesNotMatch(bridge.instruction, /intercom\(\{/i);
    assert.match(bridge.instruction, /durably pause the child/i);
    assert.match(bridge.instruction, /this OS process will stop/i);
    assert.match(bridge.instruction, /no child process keeps running/i);
    assert.match(
      bridge.instruction,
      /resume the paused child unchanged, resume it with guidance, or cancel it/i,
    );
    assert.doesNotMatch(
      bridge.instruction,
      /stay alive|reply arrives|blocking supervisor replies are unavailable|fresh redispatch|fresh-redispatch|\bdetached\b/i,
    );
    assert.match(
      bridge.instruction,
      /\n\nDo not use contact_supervisor for routine completion handoffs\./,
    );
    assert.match(bridge.instruction, /focused task result/i);
  });
});

describe("applyIntercomBridgeToAgent", () => {
  const activeBridge: IntercomBridgeState = {
    active: true,
    mode: "always",
    orchestratorTarget: "main",
    extensionDir: NATIVE_INTERCOM_EXTENSION_DIR,
    instruction:
      'Intercom orchestration channel:\n- Need a decision or blocked: contact_supervisor({ reason: "need_decision", message: "<question>" })\n- Blocking supervisor requests durably pause the child until the parent resumes or cancels it; no child process keeps running during that pause.\n- Blocked/update: contact_supervisor({ reason: "progress_update", message: "UPDATE: <summary>" })',
  };

  it("injects bridge instructions without changing the declared tool policy", () => {
    const policies: Array<{ label: string; tools: AgentConfig["tools"] }> = [
      { label: "omitted", tools: undefined },
      { label: "null", tools: null },
      { label: "empty", tools: [] },
      { label: "extension path", tools: ["./custom-tool.ts"] },
      { label: "named", tools: ["read", "bash"] },
    ];

    for (const { label, tools } of policies) {
      const agent = makeAgent({ tools });
      const updated = applyIntercomBridgeToAgent(agent, activeBridge);
      assert.equal(updated.tools, agent.tools, `${label} tools identity changed`);
      assert.deepEqual(updated.tools, tools, `${label} tools content changed`);
      assert.match(updated.systemPrompt, /Intercom orchestration channel:/);
      assert.match(updated.systemPrompt, /contact_supervisor/);
      assert.doesNotMatch(updated.systemPrompt, /intercom\(\{/i);
    }
  });

  it("uses the structured supervisorBridge opt-out without inspecting prompt prose", () => {
    const agent = makeAgent({
      name: "test-runner",
      tools: ["bash"],
      supervisorBridge: false,
      systemPrompt:
        "Run exact validation commands. This prose mentions contact_supervisor but is not a capability signal.",
    });

    const updated = applyIntercomBridgeToAgent(agent, activeBridge);
    assert.equal(updated, agent);
    assert.doesNotMatch(updated.systemPrompt, /Intercom orchestration channel:/);

    const { args } = buildPiArgs({
      baseArgs: ["-p"],
      task: "Run validation",
      sessionEnabled: false,
      inheritProjectContext: false,
      inheritSkills: false,
      tools: updated.tools,
      supervisorBridge: updated.supervisorBridge,
      systemPrompt: updated.systemPrompt,
      systemPromptMode: updated.systemPromptMode,
      orchestratorIntercomTarget: activeBridge.orchestratorTarget,
    });
    assert.equal(args[args.indexOf("--tools") + 1], "bash");
    assert.equal(args[args.indexOf("--exclude-tools") + 1], "contact_supervisor");
  });

  it("keeps omitted supervisorBridge behavior unchanged even when prompt prose forbids contact", () => {
    const agent = makeAgent({
      tools: null,
      systemPrompt: "Do not use contact_supervisor unless blocked; this is ordinary agent prose.",
    });
    const updated = applyIntercomBridgeToAgent(agent, activeBridge);
    assert.notEqual(updated, agent);
    assert.match(updated.systemPrompt, /Intercom orchestration channel:/);

    const { args } = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: false,
      inheritSkills: false,
      tools: updated.tools,
      supervisorBridge: updated.supervisorBridge,
      orchestratorIntercomTarget: activeBridge.orchestratorTarget,
    });
    assert.equal(args[args.indexOf("--tools") + 1], "contact_supervisor");
    assert.ok(!args.includes("--exclude-tools"));
  });

  it("is idempotent while preserving the original tools declaration", () => {
    const tools = ["read"];
    const agent = makeAgent({ tools });
    const first = applyIntercomBridgeToAgent(agent, activeBridge);
    const second = applyIntercomBridgeToAgent(first, activeBridge);
    assert.equal(first.tools, tools);
    assert.equal(second.tools, tools);
    assert.equal(second.systemPrompt, first.systemPrompt);
    assert.equal(second, first);
  });

  it("rebuilds from the unbridged prompt when a reused agent gets a new bridge", () => {
    const agent = makeAgent({ tools: ["read"] });
    const first = applyIntercomBridgeToAgent(agent, activeBridge);
    const alternateBridge = {
      ...activeBridge,
      orchestratorTarget: "alternate",
      instruction: "Intercom orchestration channel:\nUse the alternate supervisor.",
    };
    const alternate = applyIntercomBridgeToAgent(agent, alternateBridge);
    assert.notEqual(alternate, first);
    assert.equal(alternate.systemPrompt, `Base prompt\n\n${alternateBridge.instruction}`);
    assert.equal(applyIntercomBridgeToAgent(alternate, alternateBridge), alternate);
  });

  it("lets Pi CLI translation retain contact_supervisor for restricted bridge policies", () => {
    const restricted = applyIntercomBridgeToAgent(makeAgent({ tools: null }), activeBridge);
    const { args } = buildPiArgs({
      baseArgs: ["-p"],
      task: "hello",
      sessionEnabled: false,
      inheritProjectContext: false,
      inheritSkills: false,
      tools: restricted.tools,
      orchestratorIntercomTarget: activeBridge.orchestratorTarget,
    });

    assert.equal(args[args.indexOf("--tools") + 1], "contact_supervisor");
    assert.ok(!args.includes("--no-tools"));
  });

  it("preserves explicitly declared external intercom tools", () => {
    const agent = makeAgent({
      tools: ["read", "intercom"],
      extensions: ["/tmp/other-extension/index.ts"],
    });
    const updated = applyIntercomBridgeToAgent(agent, activeBridge);
    assert.equal(updated.tools, agent.tools);
    assert.deepEqual(updated.tools, ["read", "intercom"]);
    assert.match(updated.systemPrompt, /contact_supervisor/);
  });
});

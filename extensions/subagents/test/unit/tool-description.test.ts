import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { COMPACT_SUBAGENT_TOOL_DESCRIPTION } from "../../src/extension/tool-description.ts";
import { SUBAGENT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FORBIDDEN_VOCABULARY = [
  /\bchain\b/i,
  /\bchains\b/i,
  /\bworktree\b/i,
  /\bschedule\b/i,
  /\bscheduling\b/i,
  /\bcreate\b/i,
  /\bupdate\b/i,
  /\bdelete\b/i,
  /\beject\b/i,
  /\bdisable\b/i,
  /\benable\b/i,
  /\breset\b/i,
  /append-step/i,
  /\bclarify\b/i,
  /toolBudget/i,
  /\bbudget\b/i,
  /proactive skill subagent suggestions/i,
];
const ALLOWED_ACTIONS = [
  "list",
  "get",
  "status",
  "interrupt",
  "resume",
  "steer",
  "doctor",
] as const;

function assertMinimalContract(description: string): void {
  for (const pattern of FORBIDDEN_VOCABULARY) assert.doesNotMatch(description, pattern);
  for (const action of ALLOWED_ACTIONS) {
    assert.match(description, new RegExp(`action: "${escapeRegex(action)}"`));
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parentToolEnv(agentDir?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[SUBAGENT_CHILD_ENV];
  if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;
  return env;
}

describe("registered subagent tool description", () => {
  it("always uses the compact TLH-minimal contract", () => {
    const description = COMPACT_SUBAGENT_TOOL_DESCRIPTION;
    assert.ok(
      description.length <= 2500,
      `expected compact description <= 2500 chars, got ${description.length}`,
    );
    for (const builtinName of ["scout", "worker", "planner"]) {
      assert.doesNotMatch(description, new RegExp(`\\b${builtinName}\\b`));
    }
    assertMinimalContract(description);
    assert.match(description, /SINGLE:/i);
    assert.match(description, /PARALLEL:/i);
    assert.match(description, /fallbackModels/i);
    assert.doesNotMatch(description, /context:\s*"fresh"\s*\|\s*"fork"/);
    assert.match(description, /async:true|async: true/);
    assert.match(description, /Do not sleep or poll(?: status)? just to wait/i);
    assert.match(description, /no child process is running/i);
    assert.match(description, /subagents cannot spawn subagents/i);
    assert.match(description, /keep one writer/i);
    assert.match(description, /acceptanceRole may be "read-only" or "writer"/i);
    assert.match(description, /affects inferred acceptance only, never tools?/i);

    assert.match(description, /status\.json/);
    assert.match(description, /events\.jsonl/);
  });

  function readRegisteredDescription(agentDir: string): string {
    const script = String.raw`
			import registerSubagentExtension from "./src/extension/index.ts";
			const events = { on() { return () => {}; }, emit() {} };
			let registeredTool;
			const fakePi = new Proxy({
				events,
				registerTool(tool) { if (tool.name === "subagent") registeredTool = tool; },
				registerCommand() {},
				registerShortcut() {},
				registerMessageRenderer() {},
				sendMessage() {},
				getSessionName() { return undefined; },
			}, {
				get(target, prop) {
					if (prop in target) return target[prop];
					return () => undefined;
				},
			});
			registerSubagentExtension(fakePi);
			if (!registeredTool) throw new Error("tool not registered");
			process.stdout.write(JSON.stringify(registeredTool.description));
		`;
    const output = execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        "./test/support/register-loader.mjs",
        "--input-type=module",
        "--eval",
        script,
      ],
      { cwd: projectRoot, env: parentToolEnv(agentDir), encoding: "utf-8" },
    );
    return JSON.parse(output) as string;
  }

  function writeExtensionConfig(agentDir: string, config: Record<string, unknown>): void {
    const configDir = path.join(agentDir, "extensions", "subagent");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify(config), "utf-8");
  }

  it("registers compact description regardless of legacy extension config", () => {
    const defaultAgentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-subagents-tool-desc-default-"),
    );
    assert.equal(readRegisteredDescription(defaultAgentDir), COMPACT_SUBAGENT_TOOL_DESCRIPTION);

    const legacyFullAgentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-subagents-tool-desc-legacy-full-"),
    );
    writeExtensionConfig(legacyFullAgentDir, { toolDescriptionMode: "full" });
    assert.equal(readRegisteredDescription(legacyFullAgentDir), COMPACT_SUBAGENT_TOOL_DESCRIPTION);

    const legacyInvalidAgentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-subagents-tool-desc-legacy-invalid-"),
    );
    writeExtensionConfig(legacyInvalidAgentDir, { toolDescriptionMode: "tiny" });
    assert.equal(
      readRegisteredDescription(legacyInvalidAgentDir),
      COMPACT_SUBAGENT_TOOL_DESCRIPTION,
    );
  });
});

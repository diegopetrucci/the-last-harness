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
function parentToolEnv(agentDir?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[SUBAGENT_CHILD_ENV];
  if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;
  return env;
}

describe("registered subagent tool description", () => {
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

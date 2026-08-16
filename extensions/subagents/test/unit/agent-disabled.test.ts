import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgents, EXTRA_AGENT_DIRS_ENV } from "../../src/agents/agents.ts";
import { handleList } from "../../src/agents/agent-management.ts";

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalExtraAgentDirs = process.env[EXTRA_AGENT_DIRS_ENV];

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeAgent(dir: string, name: string, description = `${name} agent`): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nDo ${name} work.\n`,
    "utf-8",
  );
}

function readText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  assert.ok(first);
  assert.equal(first.type, "text");
  if (typeof first.text !== "string") throw new Error("Expected text content to be a string");
  return first.text;
}

describe("builtin agent disabling", () => {
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-disabled-home-"));
    tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-disabled-project-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env[EXTRA_AGENT_DIRS_ENV];
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
    if (originalExtraAgentDirs === undefined) delete process.env[EXTRA_AGENT_DIRS_ENV];
    else process.env[EXTRA_AGENT_DIRS_ENV] = originalExtraAgentDirs;
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempProject, { recursive: true, force: true });
  });

  it("surfaces malformed disabled overrides instead of silently ignoring them", () => {
    const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
    writeJson(settingsPath, {
      subagents: {
        agentOverrides: {
          reviewer: { disabled: "true" },
        },
      },
    });

    assert.throws(
      () => discoverAgents(tempProject, "both"),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(settingsPath) &&
        error.message.includes("reviewer") &&
        error.message.includes("disabled"),
    );
  });

  it("project-scope discovery excludes user custom agents", () => {
    const userConfiguredDir = path.join(tempHome, ".pi", "agent", "configured-agents");
    writeAgent(path.join(tempHome, ".pi", "agent", "agents"), "user-helper", "User helper");
    writeAgent(userConfiguredDir, "configured-user-helper", "Configured user helper");
    writeAgent(path.join(tempProject, ".pi", "agents"), "project-helper", "Project helper");
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: {
        agentDirs: ["configured-agents"],
      },
    });

    const projectScoped = discoverAgents(tempProject, "project").agents;
    assert.ok(
      projectScoped.find((agent) => agent.name === "project-helper" && agent.source === "project"),
    );
    assert.equal(
      projectScoped.find((agent) => agent.name === "user-helper"),
      undefined,
    );
    assert.equal(
      projectScoped.find((agent) => agent.name === "configured-user-helper"),
      undefined,
    );
  });

  it("custom extra-agent-dir, user, and project agents all discover in a clean environment", () => {
    const tlhDir = path.join(tempProject, "tlh-agents");
    process.env[EXTRA_AGENT_DIRS_ENV] = tlhDir;
    writeAgent(tlhDir, "tlh-helper", "TLH helper");
    writeAgent(path.join(tempHome, ".pi", "agent", "agents"), "user-helper", "User helper");
    writeAgent(path.join(tempProject, ".pi", "agents"), "project-helper", "Project helper");

    const discovered = discoverAgents(tempProject, "both").agents;
    assert.ok(discovered.find((agent) => agent.name === "tlh-helper" && agent.source === "user"));
    assert.ok(discovered.find((agent) => agent.name === "user-helper" && agent.source === "user"));
    assert.ok(
      discovered.find((agent) => agent.name === "project-helper" && agent.source === "project"),
    );
    assert.equal(
      discovered.some((agent) => agent.source === "builtin"),
      false,
    );
  });

  it("management list shows only enabled project agents with no builtin source", () => {
    const agentsDir = path.join(tempProject, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "helper.md"),
      "---\nname: helper\ndescription: Helper\n---\n\nHelp.\n",
      "utf-8",
    );

    const text = readText(handleList({}, { cwd: tempProject }));

    assert.match(text, /Executable agents:\n- helper \(project\): Helper/);
    assert.doesNotMatch(text, /\(builtin/);
  });
});

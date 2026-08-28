import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgents, EXTRA_AGENT_DIRS_ENV } from "../../src/agents/agents.ts";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
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

function trustProject(project: string, agentDir: string): void {
  execFileSync("git", ["init", "--quiet"], { cwd: project });
  fs.mkdirSync(agentDir, { recursive: true });
  new ProjectTrustStore(agentDir).set(project, true);
  process.env.PI_CODING_AGENT_DIR = agentDir;
}

function writeCanonicalAgent(agentDir: string, name: string): void {
  const filePath = path.join(agentDir, "tlh", "agents", "subagents", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `---\nname: ${name}\ndescription: TLH ${name}\n---\n\nTLH ${name}.\n`,
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

  // Negative hard-cutover coverage: the configured/profile/project agent fixtures below are
  // intentionally present to prove that only the exact trusted Git-root custom file survives.
  it("project-scope discovery uses only the trusted Git-root custom agent", () => {
    const userConfiguredDir = path.join(tempHome, ".pi", "agent", "configured-agents");
    writeAgent(path.join(tempHome, ".pi", "agent", "agents"), "user-helper", "User helper");
    writeAgent(userConfiguredDir, "configured-user-helper", "Configured user helper");
    writeAgent(path.join(tempProject, ".pi", "agents"), "project-helper", "Project helper");
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: {
        agentDirs: ["configured-agents"],
        agentOverrides: { "embedded.project-helper": { model: "override/model" } },
      },
    });
    const customPath = path.join(tempProject, ".tlh", "agents", "custom", "PROJECT-HELPER.md");
    fs.mkdirSync(path.dirname(customPath), { recursive: true });
    fs.writeFileSync(
      customPath,
      "---\nname: project-helper\npackage: embedded\ndescription: Project helper\n---\n\nProject helper.\n",
      "utf-8",
    );
    trustProject(tempProject, path.join(tempHome, ".pi", "agent"));

    const projectScoped = discoverAgents(tempProject, "project").agents;
    assert.equal(
      projectScoped.find((agent) => agent.name === "embedded.project-helper")?.source,
      "project",
    );
    assert.equal(
      projectScoped.find((agent) => agent.name === "embedded.project-helper")?.filePath,
      fs.realpathSync(customPath),
    );
    assert.equal(
      projectScoped.find((agent) => agent.name === "embedded.project-helper")?.model,
      undefined,
    );
    assert.equal(
      projectScoped.find((agent) => agent.name === "user-helper"),
      undefined,
    );
    assert.equal(
      projectScoped.find((agent) => agent.name === "configured-user-helper"),
      undefined,
    );
    assert.equal(
      projectScoped.find((agent) => agent.name === "project-helper"),
      undefined,
    );
  });

  it("ignores generic extra, user, and project agent directories after the hard cutover while retaining packaged TLH roles", () => {
    const tlhDir = path.join(tempProject, "tlh-agents");
    process.env[EXTRA_AGENT_DIRS_ENV] = tlhDir;
    writeAgent(tlhDir, "tlh-helper", "TLH helper");
    writeAgent(path.join(tempHome, ".pi", "agent", "agents"), "user-helper", "User helper");
    writeAgent(path.join(tempProject, ".pi", "agents"), "project-helper", "Project helper");
    const agentDir = path.join(tempHome, ".pi", "agent");
    writeCanonicalAgent(agentDir, "developer");
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const discovered = discoverAgents(tempProject, "both").agents;
    assert.equal(
      discovered.find((agent) => agent.name === "tlh-helper"),
      undefined,
    );
    assert.equal(
      discovered.find((agent) => agent.name === "user-helper"),
      undefined,
    );
    assert.equal(
      discovered.find((agent) => agent.name === "project-helper"),
      undefined,
    );
    assert.equal(discovered.find((agent) => agent.name === "developer")?.source, "user");
  });

  it("management list exposes only the trusted root custom project agent", () => {
    const agentsDir = path.join(tempProject, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "helper.md"),
      "---\nname: helper\ndescription: Helper\n---\n\nHelp.\n",
      "utf-8",
    );
    const customPath = path.join(tempProject, ".tlh", "agents", "custom", "HELPER.md");
    fs.mkdirSync(path.dirname(customPath), { recursive: true });
    fs.writeFileSync(
      customPath,
      "---\nname: helper\npackage: embedded\ndescription: Helper\n---\n\nHelp.\n",
      "utf-8",
    );
    trustProject(tempProject, path.join(tempHome, ".pi", "agent"));

    const text = readText(handleList({}, { cwd: tempProject }));

    assert.match(text, /Executable agents:\n- embedded\.helper \(project\): Helper/);
    assert.doesNotMatch(text, /- helper \(project\)/);
  });
});

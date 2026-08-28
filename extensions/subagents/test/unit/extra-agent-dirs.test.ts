import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  discoverAgents,
  discoverAgentsAll,
  EXTRA_AGENT_DIRS_ENV,
} from "../../src/agents/agents.ts";

let tempDir = "";
let agentDir = "";
let cwd = "";
const saved: Record<string, string | undefined> = {};
const MANAGED_ENV = ["PI_CODING_AGENT_DIR", "HOME", "USERPROFILE", EXTRA_AGENT_DIRS_ENV];

function writeAgent(dir: string, name: string): string {
  const filePath = path.join(dir, `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `---\nname: ${name}\ndescription: ${name} agent\n---\n\nDo ${name} work.\n`,
    "utf-8",
  );
  return filePath;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

describe("PI_SUBAGENT_EXTRA_AGENT_DIRS discovery", () => {
  beforeEach(() => {
    for (const key of MANAGED_ENV) saved[key] = process.env[key];
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extra-agent-dirs-"));
    // Isolate from the developer's real user agent dirs so defaults are empty.
    agentDir = path.join(tempDir, "agent");
    const homeDir = path.join(tempDir, "home");
    cwd = path.join(tempDir, "workspace");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    delete process.env[EXTRA_AGENT_DIRS_ENV];
  });

  afterEach(() => {
    for (const key of MANAGED_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("ignores env-provided generic agents while retaining canonical packaged TLH roles", () => {
    const bundledDir = path.join(tempDir, "store", "agents");
    writeAgent(bundledDir, "bundled-reviewer");
    process.env[EXTRA_AGENT_DIRS_ENV] = bundledDir;
    const canonical = writeAgent(path.join(agentDir, "tlh", "agents", "subagents"), "developer");

    const scoped = discoverAgents(cwd, "user");
    assert.equal(
      scoped.agents.find((agent) => agent.name === "bundled-reviewer"),
      undefined,
    );
    const found = scoped.agents.find((agent) => agent.name === "developer");
    assert.ok(found);
    assert.equal(found?.filePath, canonical);

    const all = discoverAgentsAll(cwd);
    assert.equal(
      all.user.find((agent) => agent.name === "bundled-reviewer"),
      undefined,
    );
    assert.ok(all.user.find((agent) => agent.name === "developer"));
  });

  it("ignores every directory listed in the legacy extra-agent PATH", () => {
    const dirA = path.join(tempDir, "store-a");
    const dirB = path.join(tempDir, "store-b");
    writeAgent(dirA, "agent-a");
    writeAgent(dirB, "agent-b");
    process.env[EXTRA_AGENT_DIRS_ENV] = [dirA, dirB].join(path.delimiter);

    const all = discoverAgentsAll(cwd);
    assert.equal(
      all.user.find((agent) => agent.name === "agent-a"),
      undefined,
    );
    assert.equal(
      all.user.find((agent) => agent.name === "agent-b"),
      undefined,
    );
  });

  it("ignores configured and local user agent directories after the hard cutover", () => {
    const bundledDir = path.join(tempDir, "store", "agents");
    const configuredDir = path.join(agentDir, "configured", "agents");
    writeAgent(bundledDir, "shared");
    writeAgent(bundledDir, "configured-wins");
    const configuredShared = writeAgent(configuredDir, "shared");
    const configuredOnly = writeAgent(configuredDir, "configured-wins");
    writeAgent(path.join(agentDir, "agents"), "shared");
    writeJson(path.join(agentDir, "settings.json"), {
      subagents: {
        agentDirs: ["configured/agents"],
      },
    });
    process.env[EXTRA_AGENT_DIRS_ENV] = bundledDir;

    const scoped = discoverAgents(cwd, "user");
    assert.equal(
      scoped.agents.find((agent) => agent.name === "shared"),
      undefined,
    );
    assert.equal(
      scoped.agents.find((agent) => agent.name === "configured-wins"),
      undefined,
    );

    const all = discoverAgentsAll(cwd);
    assert.equal(
      all.user.find((agent) => agent.name === "shared"),
      undefined,
    );
    assert.equal(
      all.user.find((agent) => agent.name === "configured-wins"),
      undefined,
    );
    assert.equal(
      all.user.some((agent) => agent.filePath === configuredShared),
      false,
    );
    assert.equal(
      all.user.some((agent) => agent.filePath === configuredOnly),
      false,
    );
  });

  it("ignores the env var when unset or empty", () => {
    process.env[EXTRA_AGENT_DIRS_ENV] = "";
    const all = discoverAgentsAll(cwd);
    assert.deepEqual(all.user, []);
  });
});

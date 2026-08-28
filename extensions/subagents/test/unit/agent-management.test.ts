import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleManagementAction } from "../../src/agents/agent-management.ts";
import { discoverAgentsAll } from "../../src/agents/agents.ts";
import { clearSkillCache } from "../../src/agents/skills.ts";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

let tempDir = "";
let oldAgentDir: string | undefined;

function trustProject(): void {
  execFileSync("git", ["init", "--quiet"], { cwd: tempDir });
  fs.mkdirSync(path.join(tempDir, "agent-home"), { recursive: true });
  new ProjectTrustStore(path.join(tempDir, "agent-home")).set(tempDir, true);
}

function writeCustom(filename: string, name: string, extra = ""): void {
  const filePath = path.join(tempDir, ".tlh", "agents", "custom", filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `---\nname: ${name}\npackage: embedded\ndescription: ${name}\n${extra}---\n\n${name}.\n`,
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

describe("agent management config parsing", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-management-"));
    oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "agent-home");
    clearSkillCache();
  });

  afterEach(() => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    clearSkillCache();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects saved-chain get and leaves JSON chain files untouched while list stays agent-only", () => {
    const ctx = { cwd: tempDir };
    const chainPath = path.join(tempDir, ".pi", "chains", "dynamic-review.chain.json");
    fs.mkdirSync(path.dirname(chainPath), { recursive: true });
    const original = JSON.stringify(
      {
        name: "dynamic-review",
        description: "Review dynamic targets",
        chain: [{ agent: "scout", task: "Return targets" }],
      },
      null,
      2,
    );
    fs.writeFileSync(chainPath, original, "utf-8");
    fs.writeFileSync(path.join(tempDir, ".pi", "chains", "broken.chain.json"), "{", "utf-8");

    const got = handleManagementAction("get", { chainName: "dynamic-review" }, ctx);
    assert.equal(got.isError, true);
    assert.match(readText(got), /Saved chains are deliberately unsupported in The Last Harness/);
    assert.equal(fs.readFileSync(chainPath, "utf-8"), original);

    const listed = handleManagementAction("list", {}, ctx);
    const text = readText(listed);
    assert.equal(listed.isError, false);
    assert.match(text, /^Executable agents:/);
    assert.doesNotMatch(text, /\bChains:\b/);
    assert.doesNotMatch(text, /Chain diagnostics:/);
    assert.doesNotMatch(text, /broken\.chain\.json/);
    assert.doesNotMatch(text, /Invalid JSON chain/);
  });

  it("rejects the models action as unknown and returns an error", () => {
    const result = handleManagementAction("models", {}, { cwd: tempDir });
    assert.equal(result.isError, true);
    assert.match(readText(result), /Unknown action: models/);
  });

  it("discovers no builtin agents from a clean environment", () => {
    const discovered = discoverAgentsAll(tempDir);
    assert.deepEqual(discovered.builtin, [], "builtin agents must be empty after removal");
  });

  it("formats omitted tools differently from explicit empty and named root custom policies", () => {
    trustProject();
    writeCustom("OMITTED.md", "omitted");
    writeCustom("EMPTY.md", "empty", "tools:\n");
    writeCustom("NAMED.md", "named", "tools: read, bash\n");

    const getAgent = (agent: string): string => {
      const result = handleManagementAction(
        "get",
        { agent: `embedded.${agent}` },
        { cwd: tempDir },
      );
      assert.equal(result.isError, false);
      return readText(result);
    };

    assert.doesNotMatch(getAgent("omitted"), /^Tools:/m);
    assert.match(getAgent("empty"), /^Tools: \(none\)$/m);
    assert.match(getAgent("named"), /^Tools: read, bash$/m);
  });

  it("lists malformed root custom warnings without hiding valid agents", () => {
    trustProject();
    writeCustom("BROKEN.md", "broken", "acceptanceRole: observer\n");
    writeCustom("VALID.md", "valid");

    const listed = handleManagementAction("list", {}, { cwd: tempDir });
    assert.equal(listed.isError, false);
    const text = readText(listed);
    assert.match(text, /- embedded\.valid \(project\): valid/);
    assert.match(text, /Agent load warnings:/);
    assert.match(text, /BROKEN\.md/);
    assert.match(text, /acceptanceRole/);
  });

  it("keeps root custom warnings aligned with user and project list scopes", () => {
    trustProject();
    writeCustom("PROJECT-BROKEN.md", "project-broken", "acceptanceRole: observer\n");
    fs.mkdirSync(path.join(tempDir, "agent-home", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "agent-home", "agents", "user-broken.md"),
      "---\ndescription: User malformed\n---\n\nMalformed user.\n",
      "utf-8",
    );

    const userText = readText(
      handleManagementAction("list", { agentScope: "user" }, { cwd: tempDir }),
    );
    assert.doesNotMatch(userText, /user-broken\.md|PROJECT-BROKEN\.md/);

    const projectText = readText(
      handleManagementAction("list", { agentScope: "project" }, { cwd: tempDir }),
    );
    assert.match(projectText, /PROJECT-BROKEN\.md/);
    assert.doesNotMatch(projectText, /user-broken\.md/);
  });
});

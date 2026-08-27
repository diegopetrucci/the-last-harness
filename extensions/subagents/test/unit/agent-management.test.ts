import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleManagementAction } from "../../src/agents/agent-management.ts";
import { discoverAgentsAll } from "../../src/agents/agents.ts";
import { clearSkillCache } from "../../src/agents/skills.ts";

let tempDir = "";
let oldAgentDir: string | undefined;

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

  it("formats omitted tools differently from explicit empty and named policies", () => {
    const agentsDir = path.join(tempDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "omitted.md"),
      `---
name: omitted
description: Omitted tools
---

Omitted tools.
`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(agentsDir, "empty.md"),
      `---
name: empty
description: Explicit empty tools
tools:
---

Empty tools.
`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(agentsDir, "named.md"),
      `---
name: named
description: Named tools
tools: read, bash
---

Named tools.
`,
      "utf-8",
    );

    const getAgent = (agent: string): string => {
      const result = handleManagementAction("get", { agent }, { cwd: tempDir });
      assert.equal(result.isError, false);
      return readText(result);
    };

    assert.doesNotMatch(getAgent("omitted"), /^Tools:/m);
    assert.match(getAgent("empty"), /^Tools: \(none\)$/m);
    assert.match(getAgent("named"), /^Tools: read, bash$/m);
  });

  it("lists malformed-agent warnings without hiding valid agents", () => {
    const agentsDir = path.join(tempDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "broken.md"),
      `---
name: broken
description: Broken
acceptanceRole: observer
---

Broken.
`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(agentsDir, "valid.md"),
      `---
name: valid
description: Valid
---

Valid.
`,
      "utf-8",
    );

    const listed = handleManagementAction("list", {}, { cwd: tempDir });
    assert.equal(listed.isError, false);
    const text = readText(listed);
    assert.match(text, /- valid \(project\): Valid/);
    assert.match(text, /Agent load warnings:/);
    assert.match(text, /broken\.md/);
    assert.match(text, /acceptanceRole/);
  });

  it("keeps malformed-agent warnings aligned with existing list scopes", () => {
    const userAgentsDir = path.join(tempDir, "agent-home", "agents");
    const projectAgentsDir = path.join(tempDir, ".pi", "agents");
    fs.mkdirSync(userAgentsDir, { recursive: true });
    fs.mkdirSync(projectAgentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(userAgentsDir, "user-broken.md"),
      `---
description: User malformed
---

Malformed user.
`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(projectAgentsDir, "project-broken.md"),
      `---
name: project-broken
---

Malformed project.
`,
      "utf-8",
    );

    const userText = readText(
      handleManagementAction("list", { agentScope: "user" }, { cwd: tempDir }),
    );
    assert.match(userText, /user-broken\.md/);
    assert.doesNotMatch(userText, /project-broken\.md/);

    const projectText = readText(
      handleManagementAction("list", { agentScope: "project" }, { cwd: tempDir }),
    );
    assert.match(projectText, /project-broken\.md/);
    assert.doesNotMatch(projectText, /user-broken\.md/);
  });
});

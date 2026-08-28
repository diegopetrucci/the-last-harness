import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgentsAll } from "../../src/agents/agents.ts";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
let tempDir = "";
let oldAgentDir: string | undefined;

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

describe("discoverAgentsAll saved-chain exclusion", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-no-chain-discovery-"));
    oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "agent-home");
  });

  afterEach(() => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps saved chain paths stable while using only the trusted root custom agent", () => {
    execFileSync("git", ["init", "--quiet"], { cwd: tempDir });
    new ProjectTrustStore(path.join(tempDir, "agent-home")).set(tempDir, true);
    writeFile(
      path.join(tempDir, "agent-home", "agents", "user-agent.md"),
      `---\nname: user-agent\ndescription: User agent\n---\n\nUse user agent.\n`,
    );
    writeFile(
      path.join(tempDir, "agent-home", "chains", "user-flow.chain.md"),
      `---\nname: user-flow\ndescription: User flow\n---\n\n## user-agent\n\nInspect.\n`,
    );
    writeFile(
      path.join(tempDir, ".pi", "agents", "project-agent.md"),
      `---\nname: project-agent\ndescription: Project agent\n---\n\nUse project agent.\n`,
    );
    writeFile(
      path.join(tempDir, ".pi", "chains", "project-flow.chain.json"),
      JSON.stringify(
        {
          name: "project-flow",
          description: "Project flow",
          chain: [{ agent: "project-agent", task: "Inspect" }],
        },
        null,
        2,
      ),
    );
    writeFile(
      path.join(tempDir, ".tlh", "agents", "custom", "PROJECT-AGENT.md"),
      `---\nname: project-agent\npackage: embedded\ndescription: Project agent\n---\n\nUse project agent.\n`,
    );
    const discovered = discoverAgentsAll(tempDir);

    assert.equal(
      discovered.user.some((agent) => agent.name === "user-agent"),
      false,
    );
    assert.equal(
      discovered.project.some((agent) => agent.name === "project-agent"),
      false,
    );
    assert.ok(discovered.project.some((agent) => agent.name === "embedded.project-agent"));
    assert.deepEqual(discovered.chains, []);
    assert.deepEqual(discovered.chainDiagnostics, []);
    assert.equal(discovered.userChainDir, path.join(tempDir, "agent-home", "chains"));
    assert.equal(discovered.projectChainDir, path.join(tempDir, ".pi", "chains"));
  });
});

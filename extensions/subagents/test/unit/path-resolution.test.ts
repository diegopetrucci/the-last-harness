// Fork delta (hermetic HOME redirect): the upstream version of this test
// backed up and restored the REAL ~/.agents directory around each run,
// which is destructive if the process crashes mid-run. This suite covers
// supported skill discovery plus negative hard-cutover coverage for generic
// agent definitions, so it points $HOME (and $USERPROFILE, which os.homedir()
// reads on Windows instead of $HOME) at a fresh mkdtemp fake-home directory
// and unsets PI_CODING_AGENT_DIR. The discovery code therefore never touches
// the real home directory on any platform.
import { describe, test, before, after } from "node:test";
import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgents } from "../../src/agents/agents.ts";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { resolveSkillPath, clearSkillCache } from "../../src/agents/skills.ts";

const tmpDir = path.join(os.tmpdir(), "pi-path-resolution-test");
const cwdDir = path.join(tmpDir, "cwd");

let realHomeDir: string;
let fakeHomeDir: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalPiCodingAgentDir: string | undefined;

before(() => {
  fs.mkdirSync(cwdDir, { recursive: true });

  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

  fakeHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-path-resolution-fake-home-"));
  process.env.HOME = fakeHomeDir;
  process.env.USERPROFILE = fakeHomeDir;
  delete process.env.PI_CODING_AGENT_DIR;

  realHomeDir = os.homedir();
});

after(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }

  if (originalPiCodingAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
  }

  fs.rmSync(fakeHomeDir, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Path resolution for skills and removed generic agent sources", () => {
  test("should resolve skills in .agents/skills", () => {
    const skillsDir = path.join(cwdDir, ".agents", "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, "test-skill-1.md"),
      "---\nname: test-skill-1\ndescription: test desc\n---\nSkill content",
    );

    clearSkillCache();
    const resolved = resolveSkillPath("test-skill-1", cwdDir);
    assert.ok(resolved);
    assert.strictEqual(resolved?.path, path.join(skillsDir, "test-skill-1.md"));
  });

  test("should resolve skills in ~/.agents/skills", () => {
    const userSkillsDir = path.join(realHomeDir, ".agents", "skills");
    fs.mkdirSync(userSkillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(userSkillsDir, "test-skill-2.md"),
      "---\nname: test-skill-2\ndescription: test desc\n---\nSkill content",
    );

    clearSkillCache();
    const resolved = resolveSkillPath("test-skill-2", cwdDir);
    assert.ok(resolved);
    assert.strictEqual(resolved?.path, path.join(userSkillsDir, "test-skill-2.md"));
  });

  test("negative hard-cutover: ignore generic project agent trees and use the trusted Git-root custom path", () => {
    const legacyDir = path.join(cwdDir, ".agents");
    const agentsDir = path.join(cwdDir, ".pi", "agents");
    fs.mkdirSync(path.join(cwdDir, ".agents", "skills"), { recursive: true });
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, "test-agent-legacy.md"),
      "---\nname: test-agent-legacy\ndescription: Legacy agent\n---\nLegacy content",
    );
    fs.writeFileSync(
      path.join(agentsDir, "test-agent-1.md"),
      "---\nname: test-agent-1\ndescription: Test agent\n---\nAgent content",
    );
    execFileSync("git", ["init", "--quiet"], { cwd: tmpDir });
    const agentDir = path.join(fakeHomeDir, ".pi", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    new ProjectTrustStore(agentDir).set(tmpDir, true);
    const customPath = path.join(tmpDir, ".tlh", "agents", "custom", "TEST-AGENT-1.md");
    fs.mkdirSync(path.dirname(customPath), { recursive: true });
    fs.writeFileSync(
      customPath,
      "---\nname: test-agent-1\npackage: embedded\ndescription: Test agent\n---\nAgent content",
    );

    const result = discoverAgents(cwdDir, "project");
    const custom = result.agents.find((a) => a.name === "embedded.test-agent-1");
    assert.ok(custom);
    assert.strictEqual(custom?.filePath, fs.realpathSync(customPath));
    assert.equal(
      result.agents.some((a) => a.name === "test-agent-legacy"),
      false,
    );
    assert.equal(
      result.agents.some((a) => a.name === "test-agent-1"),
      false,
    );
  });

  test("negative hard-cutover: ignore generic agents in ~/.agents while retaining packaged TLH roles", () => {
    const userAgentsDir = path.join(realHomeDir, ".agents");
    fs.mkdirSync(userAgentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(userAgentsDir, "test-agent-2.md"),
      "---\nname: test-agent-2\ndescription: Test agent\n---\nAgent content",
    );
    const agentDir = path.join(fakeHomeDir, ".pi", "agent");
    const canonical = path.join(agentDir, "tlh", "agents", "subagents", "developer.md");
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.writeFileSync(
      canonical,
      "---\nname: developer\ndescription: TLH developer\n---\nDeveloper content",
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const result = discoverAgents(cwdDir, "user");
    const agent = result.agents.find((a) => a.name === "developer");
    assert.ok(agent);
    assert.strictEqual(agent?.filePath, canonical);
    assert.equal(
      result.agents.some((a) => a.name === "test-agent-2"),
      false,
    );
  });
});

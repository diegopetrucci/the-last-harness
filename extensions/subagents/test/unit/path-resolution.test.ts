// Fork delta (hermetic HOME redirect): the upstream version of this test
// backed up and restored the REAL ~/.agents directory around each run,
// which is destructive if the process crashes mid-run. It also assumed
// PI_CODING_AGENT_DIR is unset, but TLH sessions always set
// PI_CODING_AGENT_DIR, which suppresses ~/.agents discovery in
// src/shared/profile.ts (getLegacyGlobalAgentsDir) and makes the
// "~/.agents" test cases fail under a live TLH session. This version
// instead points $HOME (and $USERPROFILE, which os.homedir() reads on
// Windows instead of $HOME) at a fresh mkdtemp fake-home directory for
// the duration of the test and unsets PI_CODING_AGENT_DIR, so the
// discovery code (which reads os.homedir() at call time) never touches
// the real home directory on any platform.
import { describe, test, before, after } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgents } from "../../src/agents/agents.ts";
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

describe("Path resolution for .agents and ~/.agents", () => {
	test("should resolve skills in .agents/skills", () => {
		const skillsDir = path.join(cwdDir, ".agents", "skills");
		fs.mkdirSync(skillsDir, { recursive: true });
		fs.writeFileSync(path.join(skillsDir, "test-skill-1.md"), "---\nname: test-skill-1\ndescription: test desc\n---\nSkill content");

		clearSkillCache();
		const resolved = resolveSkillPath("test-skill-1", cwdDir);
		assert.ok(resolved);
		assert.strictEqual(resolved?.path, path.join(skillsDir, "test-skill-1.md"));
	});

	test("should resolve skills in ~/.agents/skills", () => {
		const userSkillsDir = path.join(realHomeDir, ".agents", "skills");
		fs.mkdirSync(userSkillsDir, { recursive: true });
		fs.writeFileSync(path.join(userSkillsDir, "test-skill-2.md"), "---\nname: test-skill-2\ndescription: test desc\n---\nSkill content");

		clearSkillCache();
		const resolved = resolveSkillPath("test-skill-2", cwdDir);
		assert.ok(resolved);
		assert.strictEqual(resolved?.path, path.join(userSkillsDir, "test-skill-2.md"));
	});

	test("should resolve project agents from both .agents and .pi/agents", () => {
		const legacyDir = path.join(cwdDir, ".agents");
		const agentsDir = path.join(cwdDir, ".pi", "agents");
		fs.mkdirSync(path.join(cwdDir, ".agents", "skills"), { recursive: true });
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(legacyDir, "test-agent-legacy.md"),
			"---\nname: test-agent-legacy\ndescription: Legacy agent\n---\nLegacy content"
		);
		fs.writeFileSync(
			path.join(agentsDir, "test-agent-1.md"),
			"---\nname: test-agent-1\ndescription: Test agent\n---\nAgent content"
		);

		const result = discoverAgents(cwdDir, "project");
		const legacyAgent = result.agents.find((a) => a.name === "test-agent-legacy");
		const agent = result.agents.find((a) => a.name === "test-agent-1");
		assert.ok(legacyAgent);
		assert.strictEqual(legacyAgent?.filePath, path.join(legacyDir, "test-agent-legacy.md"));
		assert.ok(agent);
		assert.strictEqual(agent?.filePath, path.join(agentsDir, "test-agent-1.md"));
	});

	test("should resolve agents in ~/.agents", () => {
		const userAgentsDir = path.join(realHomeDir, ".agents");
		fs.mkdirSync(userAgentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(userAgentsDir, "test-agent-2.md"),
			"---\nname: test-agent-2\ndescription: Test agent\n---\nAgent content"
		);

		const result = discoverAgents(cwdDir, "user");
		const agent = result.agents.find((a) => a.name === "test-agent-2");
		assert.ok(agent);
		assert.strictEqual(agent?.filePath, path.join(userAgentsDir, "test-agent-2.md"));
	});
});

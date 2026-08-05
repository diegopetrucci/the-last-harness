import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgents, discoverAgentsAll, EXTRA_AGENT_DIRS_ENV } from "../../src/agents/agents.ts";

let tempDir = "";
let agentDir = "";
let cwd = "";
const saved: Record<string, string | undefined> = {};
const MANAGED_ENV = ["PI_CODING_AGENT_DIR", "HOME", "USERPROFILE", EXTRA_AGENT_DIRS_ENV];

function writeAgent(dir: string, name: string): string {
	const filePath = path.join(dir, `${name}.md`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name} agent\n---\n\nDo ${name} work.\n`, "utf-8");
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

	it("discovers agents from the env-provided dirs as a 'user' source", () => {
		const bundledDir = path.join(tempDir, "store", "agents");
		const bundledAgent = writeAgent(bundledDir, "bundled-reviewer");
		process.env[EXTRA_AGENT_DIRS_ENV] = bundledDir;

		const scoped = discoverAgents(cwd, "user");
		const found = scoped.agents.find((agent) => agent.name === "bundled-reviewer");
		assert.ok(found, "expected bundled agent under 'user' scope");
		assert.equal(found?.filePath, bundledAgent);

		const all = discoverAgentsAll(cwd);
		assert.ok(all.user.find((agent) => agent.name === "bundled-reviewer" && agent.filePath === bundledAgent));
	});

	it("scans every directory listed (PATH-style delimiter)", () => {
		const dirA = path.join(tempDir, "store-a");
		const dirB = path.join(tempDir, "store-b");
		writeAgent(dirA, "agent-a");
		writeAgent(dirB, "agent-b");
		process.env[EXTRA_AGENT_DIRS_ENV] = [dirA, dirB].join(path.delimiter);

		const all = discoverAgentsAll(cwd);
		assert.ok(all.user.find((agent) => agent.name === "agent-a"));
		assert.ok(all.user.find((agent) => agent.name === "agent-b"));
	});

	it("lets configured and local user agents override env-provided dirs by precedence", () => {
		const bundledDir = path.join(tempDir, "store", "agents");
		const configuredDir = path.join(agentDir, "configured", "agents");
		writeAgent(bundledDir, "shared");
		writeAgent(bundledDir, "configured-wins");
		const configuredShared = writeAgent(configuredDir, "shared");
		const configuredOnly = writeAgent(configuredDir, "configured-wins");
		const localPath = writeAgent(path.join(agentDir, "agents"), "shared");
		writeJson(path.join(agentDir, "settings.json"), {
			subagents: {
				disableBuiltins: true,
				agentDirs: ["configured/agents"],
			},
		});
		process.env[EXTRA_AGENT_DIRS_ENV] = bundledDir;

		const scoped = discoverAgents(cwd, "user");
		const matches = scoped.agents.filter((agent) => agent.name === "shared");
		assert.equal(matches.length, 1, "name collisions must dedupe");
		assert.equal(matches[0]?.filePath, localPath, "local user agent should win over configured and bundled dirs");
		assert.equal(scoped.agents.find((agent) => agent.name === "configured-wins")?.filePath, configuredOnly, "configured dirs should win over bundled dirs when no local override exists");

		const all = discoverAgentsAll(cwd);
		assert.equal(all.user.find((agent) => agent.name === "shared")?.filePath, localPath);
		assert.equal(all.user.find((agent) => agent.name === "configured-wins")?.filePath, configuredOnly);
		assert.equal(all.user.some((agent) => agent.filePath === configuredShared), false, "configured duplicates should be hidden by the higher-precedence local agent");
	});

	it("ignores the env var when unset or empty", () => {
		process.env[EXTRA_AGENT_DIRS_ENV] = "";
		const all = discoverAgentsAll(cwd);
		assert.deepEqual(all.user, []);
	});
});

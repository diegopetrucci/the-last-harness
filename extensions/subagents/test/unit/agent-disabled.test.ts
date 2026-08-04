import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildBuiltinOverrideConfig, discoverAgents, discoverAgentsAll, EXTRA_AGENT_DIRS_ENV } from "../../src/agents/agents.ts";
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
	assert.equal(typeof first.text, "string");
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

	it("filters a per-agent disabled builtin from runtime discovery while keeping it in discoverAgentsAll", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					reviewer: { disabled: true },
				},
			},
		});

		const runtimeReviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.equal(runtimeReviewer, undefined);

		const allReviewer = discoverAgentsAll(tempProject).builtin.find((agent) => agent.name === "reviewer");
		assert.ok(allReviewer);
		assert.equal(allReviewer.disabled, true);
		assert.equal(allReviewer.override?.scope, "user");
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
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("reviewer")
				&& error.message.includes("disabled"),
		);
	});

	it("bulk disableBuiltins hides builtins at runtime and marks them disabled in discoverAgentsAll", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { disableBuiltins: true },
		});

		const runtimeBuiltinCount = discoverAgents(tempProject, "both").agents.filter((agent) => agent.source === "builtin").length;
		assert.equal(runtimeBuiltinCount, 0);

		const allBuiltins = discoverAgentsAll(tempProject).builtin;
		assert.ok(allBuiltins.length > 0);
		assert.ok(allBuiltins.every((agent) => agent.disabled === true));
		assert.ok(allBuiltins.every((agent) => agent.override?.scope === "user"));
	});

	it("user disableBuiltins stays authoritative over project disableBuiltins false", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { disableBuiltins: true },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { disableBuiltins: false },
		});

		assert.equal(discoverAgents(tempProject, "both").agents.some((agent) => agent.source === "builtin"), false);
		assert.ok(discoverAgentsAll(tempProject).builtin.every((agent) => agent.disabled === true));
	});

	it("builtin agentOverrides cannot re-enable builtins while user disableBuiltins is true", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				disableBuiltins: true,
				agentOverrides: {
					reviewer: { disabled: false, model: "openai/gpt-5.4" },
				},
			},
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: {
				disableBuiltins: false,
				agentOverrides: {
					reviewer: { disabled: false, model: "openai/gpt-5.4-mini" },
				},
			},
		});

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.equal(reviewer, undefined);

		const allReviewer = discoverAgentsAll(tempProject).builtin.find((agent) => agent.name === "reviewer");
		assert.ok(allReviewer);
		assert.equal(allReviewer.disabled, true);
		assert.equal(allReviewer.override?.scope, "user");
		assert.equal(allReviewer.model, undefined);
	});

	it("project-scope discovery honors user disableBuiltins without including user custom agents", () => {
		const userConfiguredDir = path.join(tempHome, ".pi", "agent", "configured-agents");
		writeAgent(path.join(tempHome, ".pi", "agent", "agents"), "user-helper", "User helper");
		writeAgent(userConfiguredDir, "configured-user-helper", "Configured user helper");
		writeAgent(path.join(tempProject, ".pi", "agents"), "project-helper", "Project helper");
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				disableBuiltins: true,
				agentDirs: ["configured-agents"],
				agentOverrides: {
					reviewer: { model: 123 },
				},
			},
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: {
				disableBuiltins: false,
				agentOverrides: {
					reviewer: { disabled: false, model: "openai/gpt-5.4-mini" },
				},
			},
		});

		const projectScoped = discoverAgents(tempProject, "project").agents;
		assert.equal(projectScoped.some((agent) => agent.source === "builtin"), false);
		assert.ok(projectScoped.find((agent) => agent.name === "project-helper" && agent.source === "project"));
		assert.equal(projectScoped.find((agent) => agent.name === "user-helper"), undefined);
		assert.equal(projectScoped.find((agent) => agent.name === "configured-user-helper"), undefined);
	});

	it("project bulk disable beats user per-agent re-enable overrides when user bulk disable is not set", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					reviewer: { disabled: false, model: "openai/gpt-5.4" },
				},
			},
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { disableBuiltins: true },
		});

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.equal(reviewer, undefined);

		const allReviewer = discoverAgentsAll(tempProject).builtin.find((agent) => agent.name === "reviewer");
		assert.ok(allReviewer);
		assert.equal(allReviewer.disabled, true);
		assert.equal(allReviewer.override?.scope, "project");
	});

	it("custom TLH, user, and project agents still discover when builtins are disabled at the user scope", () => {
		const tlhDir = path.join(tempProject, "tlh-agents");
		process.env[EXTRA_AGENT_DIRS_ENV] = tlhDir;
		writeAgent(tlhDir, "tlh-helper", "TLH helper");
		writeAgent(path.join(tempHome, ".pi", "agent", "agents"), "user-helper", "User helper");
		writeAgent(path.join(tempProject, ".pi", "agents"), "project-helper", "Project helper");
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				disableBuiltins: true,
				agentOverrides: {
					reviewer: { disabled: false, model: "openai/gpt-5.4" },
				},
			},
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: {
				disableBuiltins: false,
				agentOverrides: {
					scout: { disabled: false, model: "openai/gpt-5.4-mini" },
				},
			},
		});

		const discovered = discoverAgents(tempProject, "both").agents;
		assert.ok(discovered.find((agent) => agent.name === "tlh-helper" && agent.source === "user"));
		assert.ok(discovered.find((agent) => agent.name === "user-helper" && agent.source === "user"));
		assert.ok(discovered.find((agent) => agent.name === "project-helper" && agent.source === "project"));
		assert.equal(discovered.some((agent) => agent.source === "builtin"), false);
	});

	it("surfaces malformed disableBuiltins values instead of silently ignoring them", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: { disableBuiltins: "true" },
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("disableBuiltins"),
		);
	});

	it("hides disabled builtins from agent-facing management list output", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { disableBuiltins: true },
		});
		const agentsDir = path.join(tempProject, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentsDir, "helper.md"),
			"---\nname: helper\ndescription: Helper\n---\n\nHelp.\n",
			"utf-8",
		);
		const disabledBuiltinNames = discoverAgentsAll(tempProject).builtin.map((agent) => agent.name);
		assert.ok(disabledBuiltinNames.length > 0);

		const text = readText(handleList(
			{},
			{ cwd: tempProject, modelRegistry: { getAvailable: () => [] } },
		));

		assert.match(text, /Executable agents:\n- helper \(project\): Helper/);
		assert.doesNotMatch(text, /Disabled builtins:/);
		for (const name of disabledBuiltinNames) {
			assert.doesNotMatch(text, new RegExp(`^- ${name} \\(builtin`, "m"));
		}
	});

	it("buildBuiltinOverrideConfig emits disabled false when re-enabling a builtin", () => {
		const override = buildBuiltinOverrideConfig(
			{
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				disabled: undefined,
				systemPrompt: "Base prompt",
			},
			{
				model: undefined,
				fallbackModels: undefined,
				thinking: undefined,
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				disabled: false,
				systemPrompt: "Base prompt",
				skills: undefined,
				tools: undefined,
				mcpDirectTools: undefined,
			},
		);

		assert.deepEqual(override, { disabled: false });
	});
});

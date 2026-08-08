import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildDoctorReport } from "../../src/extension/doctor.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function makeState(cwd: string): SubagentState {
	return {
		baseCwd: cwd,
		currentSessionId: "session-current",
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function makeAgent(name: string, source: AgentConfig["source"]): AgentConfig {
	return {
		name,
		description: `${name} agent`,
		systemPrompt: "Prompt",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source,
		filePath: `/tmp/${name}.md`,
	};
}

describe("buildDoctorReport", () => {
	it("formats a bounded successful environment summary", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-success-"));
		try {
			const paths = {
				tempRootDir: path.join(root, "temp-root"),
				asyncDir: path.join(root, "async"),
				resultsDir: path.join(root, "results"),
				chainRunsDir: path.join(root, "chains"),
			};
			for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });
			fs.mkdirSync(path.join(paths.asyncDir, "run-active"), { recursive: true });
			fs.writeFileSync(
				path.join(paths.asyncDir, "run-active", "status.json"),
				JSON.stringify(
					{
						runId: "run-active",
						mode: "single",
						state: "running",
						startedAt: 1000,
						lastUpdate: 1500,
					},
					null,
					2,
				),
				"utf-8",
			);

			const report = buildDoctorReport({
				cwd: root,
				config: { defaultSessionDir: "~/subagent-sessions", intercomBridge: { mode: "always" } },
				state: makeState(root),
				currentSessionFile: path.join(root, "sessions", "parent.jsonl"),
				currentSessionId: "session-abc123",
				orchestratorTarget: "subagent-chat-abc123",
				expandTilde: (value) => value.replace(/^~\//, `${root}/home/`),
				paths,
				deps: {
					isAsyncAvailable: () => true,
					discoverAgentsAll: () => ({
						builtin: [makeAgent("builtin-a", "builtin")],
						user: [makeAgent("user-a", "user")],
						project: [makeAgent("project-a", "project"), makeAgent("project-b", "project")],
						chains: [],
						userDir: path.join(root, "home", ".agents"),
						projectDir: path.join(root, ".pi", "agents"),
						userChainDir: path.join(root, "home", ".pi", "agent", "chains"),
						projectChainDir: path.join(root, ".pi", "chains"),
						userSettingsPath: path.join(root, "home", ".pi", "agent", "settings.json"),
						projectSettingsPath: path.join(root, ".pi", "settings.json"),
					}),
					discoverAvailableSkills: () => [
						{ name: "project-skill", source: "project" },
						{ name: "package-skill", source: "user-package" },
					],
					diagnoseIntercomBridge: () => ({
						active: true,
						mode: "always",
						wantsIntercom: true,
						supervisorChannelAvailable: true,
						extensionDir: "native:pi-subagents-supervisor-channel",
						orchestratorTarget: "subagent-chat-abc123",
					}),
				},
			});

			assert.match(report, /^Subagents doctor report/);
			assert.ok(report.includes(`- cwd: ${root}`));
			assert.match(report, /- async support: available/);
			assert.match(report, /- configured session dir: .*subagent-sessions/);
			assert.match(report, /- current session file: .*parent\.jsonl/);
			assert.match(report, /- temp root: ok /);
			assert.match(
				report,
				/- runtime dir counts: async 1 \(top-level 1, nested 0, active\/live 1, stale 0\); nested event routes 0 \(unreferenced 0\)/,
			);
			assert.match(report, /- agents: total 4 \(builtin 1, package 0, user 1, project 2\)/);
			assert.doesNotMatch(report, /- chains:/);
			assert.match(report, /- skills: total 2 \(project 1, user-package 1\)/);
			assert.match(report, /- bridge: active/);
			assert.match(report, /- supervisor channel: available \(native:pi-subagents-supervisor-channel\)/);
			assert.doesNotMatch(report, /Companion packages/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps reporting when a directory or discovery check fails", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-failure-"));
		try {
			const asyncPath = path.join(root, "async-file");
			fs.writeFileSync(asyncPath, "not a directory");
			const report = buildDoctorReport({
				cwd: root,
				config: {},
				state: makeState(root),
				paths: {
					tempRootDir: root,
					asyncDir: asyncPath,
					resultsDir: path.join(root, "missing-results"),
					chainRunsDir: path.join(root, "missing-chains"),
				},
				deps: {
					isAsyncAvailable: () => false,
					discoverAgentsAll: () => {
						throw new Error("discovery exploded");
					},
					discoverAvailableSkills: () => [],
					diagnoseIntercomBridge: () => ({
						active: false,
						mode: "fork-only",
						wantsIntercom: false,
						supervisorChannelAvailable: true,
						extensionDir: "native:pi-subagents-supervisor-channel",
						reason: "bridge mode is fork-only and context is not fork",
					}),
				},
			});

			assert.match(report, /- async support: unavailable/);
			assert.match(report, /- async runs: failed .*Error: not a directory:/);
			assert.match(report, /- results: missing /);
			assert.match(report, /- runtime dir counts: failed — Error: not a directory:/);
			assert.match(report, /- agents: failed — Error: discovery exploded/);
			assert.match(report, /- skills: total 0 \(none\)/);
			assert.match(report, /- bridge: inactive \(bridge mode is fork-only and context is not fork\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

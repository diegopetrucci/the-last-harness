import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { default: registerRtk } = await jiti.import("../extensions/rtk.ts");

function writeSettings(agentDir, settings = {}) {
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function createPiHarness({
	version = "0.43.0",
	rewriteStatus = 0,
	rewriteOutput = "rtk git status",
	execBehavior,
} = {}) {
	const handlers = new Map();
	const execCalls = [];
	return {
		handlers,
		execCalls,
		on(name, handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		async exec(command, args, options) {
			execCalls.push({ command, args, options });
			const customResult = await execBehavior?.(command, args, options);
			if (customResult) {
				return customResult;
			}
			if (command !== "rtk") {
				return { code: 1, stdout: "", stderr: "", killed: false };
			}
			if (args[0] === "--version") {
				return { code: 0, stdout: `rtk ${version}\n`, stderr: "", killed: false };
			}
			if (args[0] === "rewrite") {
				return { code: rewriteStatus, stdout: rewriteOutput, stderr: "", killed: false };
			}
			return { code: 1, stdout: "", stderr: "", killed: false };
		},
	};
}

function createToolCallContext(cwd) {
	return {
		cwd,
		signal: new AbortController().signal,
	};
}

test("RTK extension rewrites bash commands through the pinned native binary hook", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-rtk-extension-", { cwd: true, test: t });
	writeSettings(fixture.agent, {});

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, RTK_DISABLED: undefined }, async () => {
		const pi = createPiHarness();
		await registerRtk(pi);

		assert.equal(pi.handlers.get("tool_call")?.length, 1);
		const event = { toolName: "bash", input: { command: "git status" } };
		await pi.handlers.get("tool_call")?.[0]?.(event, createToolCallContext(fixture.cwd));

		assert.equal(event.input.command, "rtk git status");
		assert.deepEqual(pi.execCalls.map((call) => call.args[0]), ["--version", "rewrite"]);
	});
});

test("RTK extension falls back to the managed isolated binary when PATH lookup is unavailable", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-rtk-extension-", { cwd: true, test: t });
	writeSettings(fixture.agent, {});
	const managedRtk = join(fixture.agent, "bin", "rtk");

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, RTK_DISABLED: undefined }, async () => {
		const pi = createPiHarness({
			execBehavior(command, args) {
				if (command === "rtk" && args[0] === "--version") {
					return { code: 1, stdout: "", stderr: "not found", killed: false };
				}
				if (command === managedRtk && args[0] === "--version") {
					return { code: 0, stdout: "rtk 0.43.0\n", stderr: "", killed: false };
				}
				if (command === managedRtk && args[0] === "rewrite") {
					return { code: 0, stdout: "rtk git status", stderr: "", killed: false };
				}
				return undefined;
			},
		});
		await registerRtk(pi);

		assert.equal(pi.handlers.get("tool_call")?.length, 1);
		const event = { toolName: "bash", input: { command: "git status" } };
		await pi.handlers.get("tool_call")?.[0]?.(event, createToolCallContext(fixture.cwd));

		assert.equal(event.input.command, "rtk git status");
		assert.deepEqual(
			pi.execCalls.map((call) => [call.command, call.args[0]]),
			[["rtk", "--version"], [managedRtk, "--version"], [managedRtk, "rewrite"]],
		);
	});
});

test("RTK extension falls back to the managed isolated binary when PATH rtk is too old", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-rtk-extension-", { cwd: true, test: t });
	writeSettings(fixture.agent, {});
	const managedRtk = join(fixture.agent, "bin", "rtk");

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, RTK_DISABLED: undefined }, async () => {
		const pi = createPiHarness({
			execBehavior(command, args) {
				if (command === "rtk" && args[0] === "--version") {
					return { code: 0, stdout: "rtk 0.22.9\n", stderr: "", killed: false };
				}
				if (command === managedRtk && args[0] === "--version") {
					return { code: 0, stdout: "rtk 0.43.0\n", stderr: "", killed: false };
				}
				if (command === managedRtk && args[0] === "rewrite") {
					return { code: 0, stdout: "rtk git status", stderr: "", killed: false };
				}
				return undefined;
			},
		});
		await registerRtk(pi);

		const event = { toolName: "bash", input: { command: "git status" } };
		await pi.handlers.get("tool_call")?.[0]?.(event, createToolCallContext(fixture.cwd));

		assert.equal(event.input.command, "rtk git status");
		assert.deepEqual(
			pi.execCalls.map((call) => [call.command, call.args[0]]),
			[["rtk", "--version"], [managedRtk, "--version"], [managedRtk, "rewrite"]],
		);
	});
});

test("RTK extension honors RTK_DISABLED=1 without probing or registering handlers", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-rtk-extension-", { cwd: true, test: t });
	writeSettings(fixture.agent, {});

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, RTK_DISABLED: "1" }, async () => {
		const pi = createPiHarness();
		await registerRtk(pi);

		assert.equal(pi.execCalls.length, 0);
		assert.equal(pi.handlers.has("tool_call"), false);
	});
});

test("RTK extension honors tlh.rtk.disabled without rewriting commands", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-rtk-extension-", { cwd: true, test: t });
	writeSettings(fixture.agent, { tlh: { rtk: { disabled: true } } });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, RTK_DISABLED: undefined }, async () => {
		const pi = createPiHarness();
		await registerRtk(pi);

		const event = { toolName: "bash", input: { command: "git status" } };
		await pi.handlers.get("tool_call")?.[0]?.(event, createToolCallContext(fixture.cwd));

		assert.equal(event.input.command, "git status");
		assert.deepEqual(pi.execCalls.map((call) => call.args[0]), ["--version"]);
	});
});

test("RTK extension intentionally ignores legacy tlh.disabledDefaultExtensions rtk markers", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-rtk-extension-", { cwd: true, test: t });
	writeSettings(fixture.agent, { tlh: { disabledDefaultExtensions: ["rtk", "pi-rtk"] } });

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, RTK_DISABLED: undefined }, async () => {
		const pi = createPiHarness();
		await registerRtk(pi);

		const event = { toolName: "bash", input: { command: "git status" } };
		await pi.handlers.get("tool_call")?.[0]?.(event, createToolCallContext(fixture.cwd));

		assert.equal(event.input.command, "rtk git status");
		assert.deepEqual(pi.execCalls.map((call) => call.args[0]), ["--version", "rewrite"]);
	});
});

test("RTK extension leaves commands unchanged when rtk rewrite reports no native equivalent", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-rtk-extension-", { cwd: true, test: t });
	writeSettings(fixture.agent, {});

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, RTK_DISABLED: undefined }, async () => {
		const pi = createPiHarness({ rewriteStatus: 1, rewriteOutput: "" });
		await registerRtk(pi);

		const event = { toolName: "bash", input: { command: "git status" } };
		await pi.handlers.get("tool_call")?.[0]?.(event, createToolCallContext(fixture.cwd));

		assert.equal(event.input.command, "git status");
		assert.deepEqual(pi.execCalls.map((call) => call.args[0]), ["--version", "rewrite"]);
	});
});

test("RTK extension duplicate-load guard keeps a single tool_call handler per session", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-rtk-extension-", { cwd: true, test: t });
	writeSettings(fixture.agent, {});

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, RTK_DISABLED: undefined }, async () => {
		const pi = createPiHarness();
		await registerRtk(pi);
		await registerRtk(pi);

		assert.equal(pi.handlers.get("tool_call")?.length, 1);
		assert.equal(pi.execCalls.filter((call) => call.args[0] === "--version").length, 1);
	});
});

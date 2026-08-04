import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
	RETIRED_TLH_SUBAGENTS_DEFAULT_PACKAGE_SOURCES,
	packageIdentity,
} from "../scripts/lib/default-extensions.mjs";
import {
	EXTERNAL_SUBAGENT_PACKAGE_SOURCES,
	externalSubagentPackageIdentity,
} from "../extensions/subagents/src/extension/external-package-guard.js";

const repoRoot = resolve(import.meta.dirname, "..");
const extensionUrl = pathToFileURL(join(repoRoot, "extensions", "subagents", "src", "extension", "index.js")).href;

function runPackageLoadScenario(t, { scope, packageEntry, hasUI = true, mode = "tui" }) {
	const root = mkdtempSync(join(tmpdir(), "tlh-subagents-coexistence-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const settingsPath = scope === "user"
		? join(agentDir, "settings.json")
		: join(projectDir, ".pi", "settings.json");
	writeFileSync(settingsPath, JSON.stringify({ packages: [packageEntry] }, null, 2));

	const script = `
		import registerSubagentExtension from ${JSON.stringify(extensionUrl)};
		const calls = [];
		const tools = [];
		const handlers = [];
		const warnings = [];
		let sharedCleanupCalls = 0;
		globalThis.__piSubagentRuntimeCleanup = () => { sharedCleanupCalls += 1; };
		const fakePi = {
			get events() {
				calls.push("events");
				return { on() { calls.push("events.on"); return () => undefined; }, emit() { calls.push("events.emit"); } };
			},
			on(event, handler) { calls.push("on:" + event); handlers.push({ event, handler }); },
			registerTool(tool) { calls.push("registerTool:" + tool.name); tools.push(tool.name); },
			registerCommand(name) { calls.push("registerCommand:" + name); },
			registerShortcut(name) { calls.push("registerShortcut:" + name); },
			registerMessageRenderer(name) { calls.push("registerMessageRenderer:" + name); },
			registerEntryRenderer(name) { calls.push("registerEntryRenderer:" + name); },
		};
		registerSubagentExtension(fakePi);
		for (let pass = 0; pass < 2; pass += 1) {
			for (const registration of handlers) {
				if (registration.event === "session_start") {
					registration.handler({}, {
						cwd: process.cwd(),
						hasUI: ${JSON.stringify(hasUI)},
						mode: ${JSON.stringify(mode)},
						ui: { notify(message, level) { warnings.push({ message, level }); } },
					});
				}
			}
		}
		process.stdout.write(JSON.stringify({ calls, tools, warnings, sharedCleanupCalls }));
	`;
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
	};
	delete env.PI_SUBAGENT_CHILD;
	delete env.PI_SUBAGENT_FANOUT_CHILD;
	const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
		cwd: projectDir,
		env,
		encoding: "utf8",
	});
	assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
	return { ...JSON.parse(child.stdout), stderr: child.stderr };
}

for (const scenario of [
	{
		name: "user settings string package",
		scope: "user",
		packageEntry: "npm:@diegopetrucci/pi-subagents@0.31.14",
	},
	{
		name: "project settings object package",
		scope: "project",
		packageEntry: { source: "git:github.com/nicobailon/pi-subagents@v0.31.0" },
	},
]) {
	test(`bundled subagents package load defers for ${scenario.name}`, (t) => {
		const result = runPackageLoadScenario(t, scenario);
		assert.deepEqual(result.tools, [], "subagent and wait tools must not register");
		assert.deepEqual(result.calls, ["on:session_start"], "only the supported session-start warning path may register");
		assert.equal(result.sharedCleanupCalls, 0, "coexistence guard must run before shared runtime cleanup");
		assert.equal(result.warnings.length, 1, "exactly one UI warning must be emitted");
		assert.equal(result.warnings[0].level, "warning");
		assert.match(result.warnings[0].message, /external pi-subagents package remains active/);
		assert.match(result.warnings[0].message, new RegExp(`${scenario.scope} settings`));
		assert.equal(result.stderr, "", "interactive TUI warning must not also write to stderr");
	});
}

for (const scenario of [
	{ name: "headless print mode", hasUI: false, mode: "print", expectedUiWarnings: 0 },
	{ name: "RPC mode with a UI channel", hasUI: true, mode: "rpc", expectedUiWarnings: 1 },
]) {
	test(`bundled coexistence guard emits one stderr warning in ${scenario.name}`, (t) => {
		const result = runPackageLoadScenario(t, {
			scope: "user",
			packageEntry: "npm:@diegopetrucci/pi-subagents@0.31.14",
			hasUI: scenario.hasUI,
			mode: scenario.mode,
		});
		assert.equal(result.warnings.length, scenario.expectedUiWarnings);
		assert.equal(
			(result.stderr.match(/TLH bundled subagents did not register/g) ?? []).length,
			1,
			"repeated session-start events must not duplicate the stderr warning",
		);
		assert.match(result.stderr, /external pi-subagents package remains active in user settings/);
	});
}

test("bundled coexistence guard identities stay aligned with installer retirement identities", () => {
	assert.deepEqual(
		[...EXTERNAL_SUBAGENT_PACKAGE_SOURCES],
		[...RETIRED_TLH_SUBAGENTS_DEFAULT_PACKAGE_SOURCES],
		"runtime and installer source allowlists must remain identical",
	);
	for (const source of [
		...RETIRED_TLH_SUBAGENTS_DEFAULT_PACKAGE_SOURCES,
		"npm:@diegopetrucci/pi-subagents@0.31.14",
		"npm:pi-subagents@0.29.0",
		"git:github.com/nicobailon/pi-subagents@v0.31.0",
		"https://github.com/diegopetrucci/pi-subagents.git#main",
	]) {
		assert.equal(
			externalSubagentPackageIdentity(source),
			packageIdentity(source),
			`identity parity for ${source}`,
		);
	}
	// Local/path packages do not carry the retired-source ownership evidence this
	// migration relies on, so they intentionally remain outside the guard allowlist.
	assert.equal(externalSubagentPackageIdentity("local:../pi-subagents"), undefined);
});

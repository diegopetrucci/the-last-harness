import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const mergeScript = join(repoRoot, "scripts", "merge-settings.mjs");
const harnessPackage = "git:github.com/diegopetrucci/the-last-harness";

function tempFixture(defaultsValue, settingsValue, extensionsValue = []) {
	const dir = mkdtempSync(join(tmpdir(), "tlh-merge-settings-test-"));
	const defaults = join(dir, "settings.defaults.json");
	const extensions = join(dir, "default-extensions.json");
	const settings = join(dir, "settings.json");
	writeFileSync(defaults, JSON.stringify(defaultsValue, null, 2));
	writeFileSync(extensions, `${JSON.stringify(extensionsValue, null, 2)}\n`);
	writeFileSync(settings, JSON.stringify(settingsValue, null, 2));
	return { defaults, extensions, settings };
}

function runMerge(fixture) {
	execFileSync(process.execPath, [
		mergeScript,
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", fixture.extensions,
		"--quiet",
	], {
		cwd: repoRoot,
		env: process.env,
		encoding: "utf8",
	});
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

test("merge refuses to write a symlinked settings target", () => {
	const dir = mkdtempSync(join(tmpdir(), "tlh-merge-settings-symlink-test-"));
	const agentDir = join(dir, "agent");
	const outsideDir = join(dir, "outside");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(outsideDir, { recursive: true });
	const defaults = join(dir, "settings.defaults.json");
	const extensions = join(dir, "default-extensions.json");
	const settings = join(agentDir, "settings.json");
	const outsideSettings = join(outsideDir, "settings.json");
	writeFileSync(defaults, JSON.stringify({ packages: ["npm:new-default"] }, null, 2));
	writeFileSync(extensions, "[]\n");
	writeFileSync(outsideSettings, JSON.stringify({ packages: [harnessPackage] }, null, 2));
	symlinkSync(outsideSettings, settings);

	const result = spawnSync(process.execPath, [
		mergeScript,
		defaults,
		"--settings", settings,
		"--default-extensions", extensions,
		"--quiet",
	], {
		cwd: repoRoot,
		env: process.env,
		encoding: "utf8",
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /symlinked settings file/);
	assert.deepEqual(readJson(outsideSettings), { packages: [harnessPackage] });
});

test("merge treats normalized subagents.agentDirs paths as duplicates", () => {
	const fixture = tempFixture(
		{
			packages: [],
			subagents: { agentDirs: ["tlh/agents/subagents"] },
		},
		{
			packages: [harnessPackage],
			subagents: { agentDirs: ["./tlh/agents/subagents/"] },
		},
	);

	runMerge(fixture);

	assert.deepEqual(readJson(fixture.settings).subagents.agentDirs, ["./tlh/agents/subagents/"]);
});

test("merge keeps exact append semantics for unrelated arrays", () => {
	const fixture = tempFixture(
		{
			packages: [],
			otherAgentDirs: ["tlh/agents/subagents"],
		},
		{
			packages: [harnessPackage],
			otherAgentDirs: ["./tlh/agents/subagents"],
		},
	);

	runMerge(fixture);

	assert.deepEqual(readJson(fixture.settings).otherAgentDirs, [
		"./tlh/agents/subagents",
		"tlh/agents/subagents",
	]);
});

test("critical source updates dedupe stale same-identity filtered packages", () => {
	const criticalSource = "git:github.com/example/pi-critical@v2";
	const fixture = tempFixture(
		{ packages: [] },
		{
			packages: [
				harnessPackage,
				{ source: "git:github.com/example/pi-critical@v1", extensions: ["legacy-filter"] },
				{ source: "git:github.com/example/pi-critical@v0", extensions: ["stale-filter"] },
				"npm:unrelated-package",
			],
		},
		[
			{
				id: "critical-extension",
				critical: true,
				source: criticalSource,
			},
		],
	);

	runMerge(fixture);

	assert.deepEqual(readJson(fixture.settings).packages, [
		harnessPackage,
		criticalSource,
		"npm:unrelated-package",
	]);
});

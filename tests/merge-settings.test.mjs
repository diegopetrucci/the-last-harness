import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const mergeScript = join(repoRoot, "scripts", "merge-settings.mjs");
const harnessPackage = "git:github.com/diegopetrucci/the-last-harness";

function tempFixture(defaultsValue, settingsValue) {
	const dir = mkdtempSync(join(tmpdir(), "tlh-merge-settings-test-"));
	const defaults = join(dir, "settings.defaults.json");
	const extensions = join(dir, "default-extensions.json");
	const settings = join(dir, "settings.json");
	writeFileSync(defaults, JSON.stringify(defaultsValue, null, 2));
	writeFileSync(extensions, "[]\n");
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

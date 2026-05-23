import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("merge treats a missing default-extension manifest as empty", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{ packages: [harnessPackage] },
	);

	execFileSync(process.execPath, [
		mergeScript,
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", `${fixture.extensions}.missing`,
		"--quiet",
	], {
		cwd: repoRoot,
		env: process.env,
		encoding: "utf8",
	});

	assert.deepEqual(readJson(fixture.settings).packages, [harnessPackage]);
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

test("merge scrubs tlh.gnosis from existing settings while preserving other fields", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{
			packages: [harnessPackage],
			tlh: {
				gnosis: { enabled: true, installPath: "/some/path" },
				disabledDefaultExtensions: [],
			},
			otherField: "preserved",
		},
	);

	runMerge(fixture);

	const result = readJson(fixture.settings);
	assert.equal(Object.hasOwn(result.tlh ?? {}, "gnosis"), false, "tlh.gnosis should be removed");
	assert.deepEqual(result.tlh.disabledDefaultExtensions, [], "other tlh fields should be preserved");
	assert.equal(result.otherField, "preserved", "unrelated fields should be preserved");
});

test("merge leaves settings unchanged when tlh.gnosis is absent", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{
			packages: [harnessPackage],
			tlh: { disabledDefaultExtensions: ["some-ext"] },
			otherField: "untouched",
		},
	);

	runMerge(fixture);

	const result = readJson(fixture.settings);
	assert.equal(Object.hasOwn(result.tlh ?? {}, "gnosis"), false, "gnosis key should not appear");
	assert.deepEqual(result.tlh.disabledDefaultExtensions, ["some-ext"], "disabledDefaultExtensions unchanged");
	assert.equal(result.otherField, "untouched", "unrelated fields unchanged");
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


test("merge defers bundled pi-web-access when an upstream package is already installed", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{
			packages: [
				harnessPackage,
				"npm:pi-web-access",
			],
		},
		[
			{
				id: "pi-web-access",
				replaces: ["npm:pi-web-access", "git:github.com/nicobailon/pi-web-access"],
				source: "git:github.com/diegopetrucci/pi-web-access@tlh-v0.10.7-1",
			},
		],
	);

	runMerge(fixture);

	assert.deepEqual(readJson(fixture.settings).packages, [
		harnessPackage,
		"npm:pi-web-access",
	]);
});

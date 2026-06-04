import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const mergeScript = join(repoRoot, "scripts", "merge-settings.mjs");
const settingsDefaultsPath = join(repoRoot, "config", "settings.defaults.json");
const harnessPackage = "git:github.com/diegopetrucci/the-last-harness";
const changelogSentinel = "9999.0.0";

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

function runMerge(fixture, { dryRun = false, force = false, quiet = true } = {}) {
	const args = [
		mergeScript,
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", fixture.extensions,
	];
	if (dryRun) args.push("--dry-run");
	if (force) args.push("--force");
	if (quiet) args.push("--quiet");
	return execFileSync(process.execPath, args, {
		cwd: repoRoot,
		env: process.env,
		encoding: "utf8",
	});
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function backupFiles(settingsPath) {
	return readdirSync(dirname(settingsPath))
		.filter((name) => name.startsWith("settings.json.backup-"))
		.sort();
}

test("packaged defaults pin lastChangelogVersion to the changelog sentinel", () => {
	assert.equal(readJson(settingsDefaultsPath).lastChangelogVersion, changelogSentinel);
});

test("packaged defaults keep the isolated startup/privacy guardrails enabled", () => {
	const defaults = readJson(settingsDefaultsPath);

	assert.equal(defaults.quietStartup, true);
	assert.equal(defaults.collapseChangelog, true);
	assert.equal(defaults.warnings?.anthropicExtraUsage, false);
	assert.deepEqual(defaults.subagents, {
		disableBuiltins: true,
		agentDirs: ["tlh/agents/subagents"],
	});
});

test("merge adds the changelog sentinel when isolated settings omit it", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{ packages: [harnessPackage] },
	);

	runMerge(fixture);

	assert.equal(readJson(fixture.settings).lastChangelogVersion, changelogSentinel);
});

test("merge migrates existing lastChangelogVersion to the changelog sentinel", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{ packages: [harnessPackage], lastChangelogVersion: "0.10.0" },
	);

	runMerge(fixture);

	assert.equal(readJson(fixture.settings).lastChangelogVersion, changelogSentinel);
});

test("merge dry-run reports changelog sentinel migration without writing settings", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{ packages: [harnessPackage], lastChangelogVersion: "0.10.0" },
	);
	const before = readFileSync(fixture.settings, "utf8");

	const output = runMerge(fixture, { dryRun: true, quiet: false });

	assert.match(output, /Would overwrite lastChangelogVersion/);
	assert.match(output, /Dry run only; no settings were changed\./);
	assert.equal(readFileSync(fixture.settings, "utf8"), before);
});

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

test("merge reruns preserve user-owned settings and stay idempotent", () => {
	const fixture = tempFixture(
		readJson(settingsDefaultsPath),
		{
			packages: [harnessPackage],
			theme: "custom-theme",
			tlh: { disabledDefaultExtensions: ["notify"] },
			otherField: "preserved",
		},
		[
			{
				id: "notify",
				source: "npm:@diegopetrucci/pi-notify",
			},
		],
	);

	runMerge(fixture);
	const afterFirst = readFileSync(fixture.settings, "utf8");
	const backupsAfterFirst = backupFiles(fixture.settings);
	const firstSettings = readJson(fixture.settings);
	assert.equal(firstSettings.theme, "custom-theme");
	assert.deepEqual(firstSettings.tlh.disabledDefaultExtensions, ["notify"]);
	assert.equal(firstSettings.otherField, "preserved");
	assert.equal(firstSettings.quietStartup, true);
	assert.equal(firstSettings.collapseChangelog, true);
	assert.equal(firstSettings.warnings?.anthropicExtraUsage, false);
	assert.equal(backupsAfterFirst.length, 1);

	const secondOutput = runMerge(fixture, { quiet: false });
	assert.match(secondOutput, /No settings changes needed\./);
	assert.equal(readFileSync(fixture.settings, "utf8"), afterFirst);
	assert.deepEqual(backupFiles(fixture.settings), backupsAfterFirst);
});

test("merge --force preserves tlh.telemetry.enabled=false while applying defaults", () => {
	const fixture = tempFixture(
		{
			packages: [],
			theme: "the-last-harness",
			quietStartup: true,
			warnings: { anthropicExtraUsage: false },
			tlh: { telemetry: { enabled: true } },
		},
		{
			packages: [harnessPackage],
			theme: "custom-theme",
			tlh: { telemetry: { enabled: false } },
		},
	);

	runMerge(fixture, { force: true });

	const settings = readJson(fixture.settings);
	assert.equal(settings.theme, "the-last-harness");
	assert.equal(settings.quietStartup, true);
	assert.equal(settings.warnings?.anthropicExtraUsage, false);
	assert.equal(settings.tlh.telemetry.enabled, false, "telemetry opt-out must survive forced reruns");
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

test("merge removes npm:@diegopetrucci/pi-context-cap package and emits a changes line", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{
			packages: [
				harnessPackage,
				"npm:@diegopetrucci/pi-context-cap",
				"npm:@diegopetrucci/pi-notify",
			],
		},
	);

	const output = runMerge(fixture, { quiet: false });

	const settings = readJson(fixture.settings);
	assert.ok(!settings.packages.includes("npm:@diegopetrucci/pi-context-cap"), "pi-context-cap should be removed");
	assert.ok(settings.packages.includes("npm:@diegopetrucci/pi-notify"), "unrelated packages should be preserved");
	assert.match(output, /force-remove retired default extension package: npm:@diegopetrucci\/pi-context-cap/);
});

test("merge prunes context-cap from tlh.disabledDefaultExtensions and emits a changes line", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{
			packages: [harnessPackage],
			tlh: { disabledDefaultExtensions: ["context-cap", "notify"] },
		},
	);

	const output = runMerge(fixture, { quiet: false });

	const settings = readJson(fixture.settings);
	assert.deepEqual(settings.tlh.disabledDefaultExtensions, ["notify"], "context-cap should be pruned, other entries preserved");
	assert.match(output, /remove stale context-cap opt-out from tlh\.disabledDefaultExtensions/);
});

test("merge prunes whitespace-padded context-cap entry from tlh.disabledDefaultExtensions", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{
			packages: [harnessPackage],
			tlh: { disabledDefaultExtensions: [" context-cap ", "notify"] },
		},
	);

	const output = runMerge(fixture, { quiet: false });

	const settings = readJson(fixture.settings);
	assert.deepEqual(settings.tlh.disabledDefaultExtensions, ["notify"], "whitespace-padded context-cap should be pruned");
	assert.match(output, /remove stale context-cap opt-out from tlh\.disabledDefaultExtensions/);
});

test("merge is a no-op when settings have neither pi-context-cap nor context-cap opt-out", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{
			packages: [harnessPackage],
			tlh: { disabledDefaultExtensions: ["notify"] },
		},
	);

	runMerge(fixture);
	const afterFirst = readFileSync(fixture.settings, "utf8");

	const output = runMerge(fixture, { quiet: false });

	assert.match(output, /No settings changes needed\./);
	assert.equal(readFileSync(fixture.settings, "utf8"), afterFirst, "settings should be unchanged");
});

test("merge cleanup of pi-context-cap is idempotent after first run", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{
			packages: [
				harnessPackage,
				"npm:@diegopetrucci/pi-context-cap",
			],
			tlh: { disabledDefaultExtensions: ["context-cap", "notify"] },
		},
	);

	runMerge(fixture);

	const afterFirst = readFileSync(fixture.settings, "utf8");
	const firstSettings = readJson(fixture.settings);
	assert.ok(!firstSettings.packages.includes("npm:@diegopetrucci/pi-context-cap"), "pi-context-cap removed on first run");
	assert.deepEqual(firstSettings.tlh.disabledDefaultExtensions, ["notify"], "context-cap opt-out pruned on first run");

	const secondOutput = runMerge(fixture, { quiet: false });
	assert.match(secondOutput, /No settings changes needed\./);
	assert.equal(readFileSync(fixture.settings, "utf8"), afterFirst, "settings unchanged on second run");
});

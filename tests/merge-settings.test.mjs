import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const mergeScript = join(repoRoot, "scripts", "merge-settings.mjs");
const settingsDefaultsPath = join(repoRoot, "config", "settings.defaults.json");
const harnessPackage = "git:github.com/diegopetrucci/the-last-harness";
const retiredPlannotatorPackage = "npm:@plannotator/pi-extension";
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

test("merge refuses to mutate normal Pi config paths", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{ packages: [harnessPackage] },
	);
	const homeDir = join(dirname(fixture.settings), "home");
	const protectedSettings = join(homeDir, ".pi", "agent", "settings.json");

	const result = spawnSync(process.execPath, [
		mergeScript,
		fixture.defaults,
		"--settings", protectedSettings,
		"--default-extensions", fixture.extensions,
	], {
		cwd: repoRoot,
		env: { ...process.env, HOME: homeDir },
		encoding: "utf8",
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Refusing to modify normal Pi config from The Last Harness installer/);
	assert.equal(existsSync(join(homeDir, ".pi")), false);
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

test("merge removes the retired plannotator package from isolated settings and logs it", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{
			packages: [
				harnessPackage,
				retiredPlannotatorPackage,
				"npm:unrelated-package",
			],
		},
	);

	const output = runMerge(fixture, { quiet: false });
	const settings = readJson(fixture.settings);

	assert.match(output, /Will remove retired TLH default package: npm:@plannotator\/pi-extension/);
	assert.deepEqual(settings.packages, [
		harnessPackage,
		"npm:unrelated-package",
	]);
	assert.deepEqual(settings.tlh?.defaultExtensionProvenance?.managedPackageIdentities, []);
});

test("merge dry-run reports retired plannotator cleanup without writing settings", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{
			packages: [
				harnessPackage,
				{ source: retiredPlannotatorPackage, extensions: ["legacy-filter"] },
			],
		},
	);
	const before = readFileSync(fixture.settings, "utf8");

	const output = runMerge(fixture, { dryRun: true, quiet: false });

	assert.match(output, /Would remove retired TLH default package: npm:@plannotator\/pi-extension/);
	assert.equal(readFileSync(fixture.settings, "utf8"), before);
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
	assert.deepEqual(firstSettings.tlh.defaultExtensionProvenance.managedPackageIdentities, []);
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

test("merge records provenance for managed default-extension package identities", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{ packages: [harnessPackage] },
		[
			{
				id: "notify",
				source: "npm:@diegopetrucci/pi-notify",
			},
		],
	);

	runMerge(fixture);

	const settings = readJson(fixture.settings);
	assert.deepEqual(settings.packages, [
		harnessPackage,
		"npm:@diegopetrucci/pi-notify",
	]);
	assert.deepEqual(settings.tlh?.defaultExtensionProvenance?.managedPackageIdentities, ["npm:@diegopetrucci/pi-notify"]);
});

test("merge does not remove a manually re-added retired default after provenance migration", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{ packages: [harnessPackage, retiredPlannotatorPackage] },
	);

	runMerge(fixture);
	writeFileSync(fixture.settings, JSON.stringify({
		...readJson(fixture.settings),
		packages: [harnessPackage, retiredPlannotatorPackage],
	}, null, 2));

	runMerge(fixture);

	const settings = readJson(fixture.settings);
	assert.deepEqual(settings.packages, [harnessPackage, retiredPlannotatorPackage]);
	assert.deepEqual(settings.tlh?.defaultExtensionProvenance?.managedPackageIdentities, []);
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

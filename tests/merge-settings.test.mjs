import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const mergeScript = join(repoRoot, "scripts", "merge-settings.mjs");
const settingsDefaultsPath = join(repoRoot, "config", "settings.defaults.json");
const harnessPackage = "git:github.com/diegopetrucci/the-last-harness";
const branchHarnessPackage = "git:github.com/diegopetrucci/the-last-harness@feature/curated-startup-tips";
const retiredPlannotatorPackage = "npm:@plannotator/pi-extension";
const retiredPermissionGatePackage = "npm:@diegopetrucci/pi-permission-gate";
const retiredConfirmDestructivePackage = "npm:@diegopetrucci/pi-confirm-destructive";
const retiredOraclePackage = "npm:@diegopetrucci/pi-oracle";
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

function runMerge(fixture, { dryRun = false, force = false, quiet = true, packageSource = "" } = {}) {
	const args = [
		mergeScript,
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", fixture.extensions,
	];
	if (packageSource) args.push("--package-source", packageSource);
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

function symlinkFile(target, path) {
	if (process.platform === "win32") {
		symlinkSync(target, path, "file");
		return;
	}
	symlinkSync(target, path);
}

function writeSwapBackupSourceToSymlinkAfterOpenPreload(dir) {
	const preload = join(dir, "swap-backup-source-to-symlink-after-open.mjs");
	writeFileSync(preload, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const originalOpenSync = fs.openSync;
let sabotaged = false;
fs.openSync = (path, flags, mode) => {
	const pathString = String(path);
	if (!sabotaged && pathString === process.env.TLH_TEST_SWAP_BACKUP_SOURCE_PATH) {
		const fd = originalOpenSync(path, flags, mode);
		sabotaged = true;
		fs.unlinkSync(pathString);
		fs.symlinkSync(process.env.TLH_TEST_SWAP_BACKUP_SOURCE_TARGET, pathString, "file");
		return fd;
	}
	return originalOpenSync(path, flags, mode);
};
syncBuiltinESMExports();
`);
	return preload;
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

test("merge preserves settings and backup file modes when rewriting settings", () => {
	const fixture = tempFixture(
		{ packages: [], quietStartup: true },
		{ packages: [harnessPackage] },
	);
	chmodSync(fixture.settings, 0o640);

	runMerge(fixture);

	assert.equal(lstatSync(fixture.settings).mode & 0o777, 0o640);
	const backups = backupFiles(fixture.settings);
	assert.equal(backups.length, 1);
	assert.equal(lstatSync(join(dirname(fixture.settings), backups[0])).mode & 0o777, 0o640);
});

test("merge rejects symlinked settings targets before creating backups", () => {
	const fixture = tempFixture(
		{ packages: [], quietStartup: true },
		{ packages: [harnessPackage] },
	);
	const externalDir = mkdtempSync(join(tmpdir(), "tlh-merge-settings-symlink-target-"));
	const externalSettings = join(externalDir, "settings.json");
	writeFileSync(externalSettings, JSON.stringify({ packages: [harnessPackage] }, null, 2));
	rmSync(fixture.settings);
	symlinkFile(externalSettings, fixture.settings);

	const result = spawnSync(process.execPath, [
		mergeScript,
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", fixture.extensions,
	], {
		cwd: repoRoot,
		env: process.env,
		encoding: "utf8",
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /symlinked Pi settings source/);
	assert.deepEqual(backupFiles(fixture.settings), []);
});

test("merge rejects settings sources swapped to a symlink during backup read before creating backups", { skip: process.platform === "win32" }, () => {
	const fixture = tempFixture(
		{ packages: [], quietStartup: true },
		{ packages: [harnessPackage] },
	);
	const externalDir = mkdtempSync(join(tmpdir(), "tlh-merge-settings-backup-source-swap-"));
	const externalSettings = join(externalDir, "settings.json");
	const externalSource = { packages: ["npm:attacker"] };
	writeFileSync(externalSettings, JSON.stringify(externalSource, null, 2));
	const preload = writeSwapBackupSourceToSymlinkAfterOpenPreload(dirname(fixture.settings));

	const result = spawnSync(process.execPath, [
		"--import", preload,
		mergeScript,
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", fixture.extensions,
	], {
		cwd: repoRoot,
		env: {
			...process.env,
			TLH_TEST_SWAP_BACKUP_SOURCE_PATH: fixture.settings,
			TLH_TEST_SWAP_BACKUP_SOURCE_TARGET: externalSettings,
		},
		encoding: "utf8",
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /symlinked Pi settings source/);
	assert.deepEqual(backupFiles(fixture.settings), []);
	assert.deepEqual(readJson(externalSettings), externalSource);
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

test("merge migrates existing unpinned managed npm default package sources to bundled pinned sources without --force", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{
			packages: [
				harnessPackage,
				"npm:@diegopetrucci/pi-oracle",
			],
		},
		[
			{
				id: "oracle",
				source: "npm:@diegopetrucci/pi-oracle@0.1.12",
			},
		],
	);

	runMerge(fixture);

	const settings = readJson(fixture.settings);
	assert.deepEqual(settings.packages, [
		harnessPackage,
		"npm:@diegopetrucci/pi-oracle@0.1.12",
	]);
	assert.deepEqual(settings.tlh?.defaultExtensionProvenance?.managedPackageIdentities, ["npm:@diegopetrucci/pi-oracle"]);
});

test("merge updates managed pinned npm default package sources when the bundled manifest pin changes", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{
			packages: [
				harnessPackage,
				"npm:@diegopetrucci/pi-oracle@0.1.12",
			],
			tlh: {
				defaultExtensionProvenance: {
					managedPackageIdentities: ["npm:@diegopetrucci/pi-oracle"],
				},
			},
		},
		[
			{
				id: "oracle",
				source: "npm:@diegopetrucci/pi-oracle@0.1.13",
			},
		],
	);

	runMerge(fixture);

	const settings = readJson(fixture.settings);
	assert.deepEqual(settings.packages, [
		harnessPackage,
		"npm:@diegopetrucci/pi-oracle@0.1.13",
	]);
	assert.deepEqual(settings.tlh?.defaultExtensionProvenance?.managedPackageIdentities, ["npm:@diegopetrucci/pi-oracle"]);
});

test("merge preserves older pinned npm package sources without managed default provenance", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{
			packages: [
				harnessPackage,
				"npm:@diegopetrucci/pi-oracle@0.1.12",
			],
		},
		[
			{
				id: "oracle",
				source: "npm:@diegopetrucci/pi-oracle@0.1.13",
			},
		],
	);

	const firstOutput = runMerge(fixture, { quiet: false });
	const afterFirst = readJson(fixture.settings);
	const afterFirstRaw = readFileSync(fixture.settings, "utf8");

	assert.doesNotMatch(firstOutput, /update default extension package source/);
	assert.deepEqual(afterFirst.packages, [
		harnessPackage,
		"npm:@diegopetrucci/pi-oracle@0.1.12",
	]);
	assert.deepEqual(afterFirst.tlh?.defaultExtensionProvenance?.managedPackageIdentities ?? [], []);

	const secondOutput = runMerge(fixture, { quiet: false });
	const afterSecond = readJson(fixture.settings);

	assert.match(secondOutput, /No settings changes needed\./);
	assert.doesNotMatch(secondOutput, /update default extension package source/);
	assert.equal(readFileSync(fixture.settings, "utf8"), afterFirstRaw);
	assert.deepEqual(afterSecond.packages, [
		harnessPackage,
		"npm:@diegopetrucci/pi-oracle@0.1.12",
	]);
	assert.deepEqual(afterSecond.tlh?.defaultExtensionProvenance?.managedPackageIdentities ?? [], []);
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

test("merge replaces the harness package when a slash ref keeps the same git identity", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{
			packages: [harnessPackage],
		},
	);

	runMerge(fixture, { packageSource: branchHarnessPackage });

	assert.deepEqual(readJson(fixture.settings).packages, [branchHarnessPackage]);
});

test("merge dedupes duplicate harness entries when rerun with a branch package source", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{
			packages: [
				branchHarnessPackage,
				harnessPackage,
				"npm:unrelated-package@1.0.0",
				"npm:unrelated-package",
			],
		},
	);

	runMerge(fixture, { packageSource: branchHarnessPackage });

	assert.deepEqual(readJson(fixture.settings).packages, [
		branchHarnessPackage,
		"npm:unrelated-package@1.0.0",
		"npm:unrelated-package",
	]);
});

test("merge dedupes duplicate harness entries when rerun from main", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{
			packages: [
				branchHarnessPackage,
				harnessPackage,
				"npm:unrelated-package@1.0.0",
				"npm:unrelated-package",
			],
		},
	);

	runMerge(fixture);

	assert.deepEqual(readJson(fixture.settings).packages, [
		harnessPackage,
		"npm:unrelated-package@1.0.0",
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

test("merge force-removes retired confirmation packages by identity while preserving unrelated packages", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{
			packages: [
				harnessPackage,
				`${retiredPermissionGatePackage}@1.2.3`,
				{ source: `${retiredConfirmDestructivePackage}@0.4.0`, extensions: ["legacy-filter"] },
				"npm:@diegopetrucci/pi-notify",
			],
		},
	);

	const output = runMerge(fixture, { quiet: false });

	const settings = readJson(fixture.settings);
	assert.deepEqual(settings.packages, [
		harnessPackage,
		"npm:@diegopetrucci/pi-notify",
	]);
	assert.match(output, /force-remove retired default extension package: npm:@diegopetrucci\/pi-permission-gate/);
	assert.match(output, /force-remove retired default extension package: npm:@diegopetrucci\/pi-confirm-destructive/);
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

test("merge cleanup of retired confirmation packages is idempotent after first run", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{
			packages: [
				harnessPackage,
				retiredPermissionGatePackage,
				retiredConfirmDestructivePackage,
			],
		},
	);

	runMerge(fixture);

	const afterFirst = readFileSync(fixture.settings, "utf8");
	const firstSettings = readJson(fixture.settings);
	assert.deepEqual(firstSettings.packages, [harnessPackage], "retired confirmation packages removed on first run");

	const secondOutput = runMerge(fixture, { quiet: false });
	assert.match(secondOutput, /No settings changes needed\./);
	assert.equal(readFileSync(fixture.settings, "utf8"), afterFirst, "settings unchanged on second run");
});

test("merge force-removes pi-oracle package while preserving unrelated packages", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{
			packages: [
				harnessPackage,
				`${retiredOraclePackage}@2.1.0`,
				{ source: `${retiredOraclePackage}@1.0.0`, extensions: ["legacy-filter"] },
				"npm:@diegopetrucci/pi-notify",
			],
		},
	);

	const output = runMerge(fixture, { quiet: false });

	const settings = readJson(fixture.settings);
	assert.deepEqual(settings.packages, [
		harnessPackage,
		"npm:@diegopetrucci/pi-notify",
	]);
	assert.match(output, /force-remove retired default extension package: npm:@diegopetrucci\/pi-oracle/);
});

test("merge prunes oracle from tlh.disabledDefaultExtensions and emits a changes line", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{
			packages: [harnessPackage],
			tlh: { disabledDefaultExtensions: ["oracle", "notify"] },
		},
	);

	const output = runMerge(fixture, { quiet: false });

	const settings = readJson(fixture.settings);
	assert.deepEqual(settings.tlh.disabledDefaultExtensions, ["notify"], "oracle should be pruned, other entries preserved");
	assert.match(output, /remove stale oracle opt-out from tlh\.disabledDefaultExtensions/);
});

test("merge prunes whitespace-padded oracle entry from tlh.disabledDefaultExtensions", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{
			packages: [harnessPackage],
			tlh: { disabledDefaultExtensions: [" oracle ", "notify"] },
		},
	);

	const output = runMerge(fixture, { quiet: false });

	const settings = readJson(fixture.settings);
	assert.deepEqual(settings.tlh.disabledDefaultExtensions, ["notify"], "whitespace-padded oracle should be pruned");
	assert.match(output, /remove stale oracle opt-out from tlh\.disabledDefaultExtensions/);
});

test("merge cleanup of pi-oracle is idempotent after first run", () => {
	const fixture = tempFixture(
		{ packages: [] },
		{
			packages: [
				harnessPackage,
				retiredOraclePackage,
			],
			tlh: { disabledDefaultExtensions: ["oracle", "notify"] },
		},
	);

	runMerge(fixture);

	const afterFirst = readFileSync(fixture.settings, "utf8");
	const firstSettings = readJson(fixture.settings);
	assert.ok(!firstSettings.packages.includes(retiredOraclePackage), "pi-oracle removed on first run");
	assert.deepEqual(firstSettings.tlh.disabledDefaultExtensions, ["notify"], "oracle opt-out pruned on first run");

	const secondOutput = runMerge(fixture, { quiet: false });
	assert.match(secondOutput, /No settings changes needed\./);
	assert.equal(readFileSync(fixture.settings, "utf8"), afterFirst, "settings unchanged on second run");
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

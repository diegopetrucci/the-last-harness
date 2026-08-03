import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
	packageIdentity,
	readDefaultExtensions,
	setDefaultExtensionProvenance,
} from "../scripts/lib/default-extensions.mjs";
import { installableSupportFiles } from "../scripts/lib/tlh-install-support-manifest.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const mergeScript = join(repoRoot, "scripts", "merge-settings.mjs");
const defaultsScript = join(repoRoot, "scripts", "tlh-defaults.mjs");
const harnessPackage = "git:github.com/diegopetrucci/the-last-harness";
const retiredPlannotatorPackage = "npm:@plannotator/pi-extension";
const bundledExtensionsPath = join(repoRoot, "config", "default-extensions.json");
const bundledExtensions = readDefaultExtensions(bundledExtensionsPath);
const bundledExtensionsById = new Map(bundledExtensions.map((extension) => [extension.id, extension]));
const previousMcporterSource = "git:github.com/diegopetrucci/pi-mcp-adapter@tlh-v2.10.0-1";
const previousBundledMcporterSource = "npm:@diegopetrucci/pi-mcp-adapter@2.10.1";
const previousBundledNotifySource = "npm:@diegopetrucci/pi-notify@0.1.7";
const previousPiWebAccessSource = "git:github.com/diegopetrucci/pi-web-access@tlh-v0.10.7-1";
const expectedBundledNpmPackageIdentities = new Map([
	["openai-fast", "npm:@diegopetrucci/pi-openai-fast"],
	["anthropic-auth", "npm:@gotgenes/pi-anthropic-auth"],
	["inline-bash", "npm:@diegopetrucci/pi-inline-bash"],
	["notify", "npm:@diegopetrucci/pi-notify"],
	["context-inspector", "npm:@diegopetrucci/pi-context-inspector"],
	["quiet-tools", "npm:@diegopetrucci/pi-quiet-tools"],
	["dirty-repo-guard", "npm:@diegopetrucci/pi-dirty-repo-guard"],
]);

function tempFixture() {
	const dir = mkdtempSync(join(tmpdir(), "tlh-defaults-test-"));
	const defaults = join(dir, "settings.defaults.json");
	const extensions = join(dir, "default-extensions.json");
	const settings = join(dir, "settings.json");
	writeFileSync(defaults, JSON.stringify({ packages: [] }, null, 2));
	return { dir, defaults, extensions, settings };
}

function runNode(script, args, env = {}) {
	return execFileSync(process.execPath, [script, ...args], {
		cwd: repoRoot,
		env: { ...process.env, ...env },
		encoding: "utf8",
	});
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function packageSourceOf(entry) {
	return typeof entry === "string" ? entry : entry?.source;
}

function backupFiles(settingsPath) {
	return readdirSync(dirname(settingsPath))
		.filter((name) => name.startsWith("settings.json.backup-tlh-defaults-"))
		.sort();
}

function symlinkFile(target, path) {
	if (process.platform === "win32") {
		symlinkSync(target, path, "file");
		return;
	}
	symlinkSync(target, path);
}

function bundledExtension(id) {
	return bundledExtensionsById.get(id);
}

function bundledSource(id) {
	return bundledExtension(id)?.source;
}

const disablingExtensionFilterCases = [
	{ name: "empty extensions list", extensions: [] },
	{ name: "dash wildcard exclusion", extensions: ["-*"] },
	{ name: "bang wildcard exclusion", extensions: ["!*"] },
	{ name: "real subagents entrypoint exclusion", extensions: ["-src/extension/index.ts"] },
	{ name: "bang src tree exclusion", extensions: ["!src/**"] },
	{ name: "allowlist excluding hard-coded entrypoint", extensions: ["other.ts"] },
	{ name: "allowlist excluding real subagents entrypoint", extensions: ["index.ts"] },
];

test("shared package identity keeps npm, git, and local source semantics", () => {
	assert.equal(packageIdentity("npm:helper@1.2.3"), "npm:helper");
	assert.equal(packageIdentity("npm:@scope/helper@1.2.3"), "npm:@scope/helper");
	assert.equal(packageIdentity("git:github.com/TLH/helper@pin"), "git:github.com/tlh/helper");
	assert.equal(packageIdentity("https://github.com/TLH/helper.git#pin"), "git:github.com/tlh/helper");
	assert.equal(packageIdentity("git@github.com:TLH/helper.git"), "git:github.com/tlh/helper");
	assert.equal(packageIdentity("../local-helper@pin"), "local:../local-helper@pin");

	const harnessIdentity = packageIdentity("git:github.com/diegopetrucci/the-last-harness");
	assert.equal(packageIdentity("git:github.com/diegopetrucci/the-last-harness@tlh-v0.16.0"), harnessIdentity);
	assert.equal(
		packageIdentity("git:github.com/diegopetrucci/the-last-harness@feature/curated-startup-tips"),
		harnessIdentity,
	);
});

test("shared default-extension reader trims descriptions and can allow missing manifests", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "helper",
			description: "  Helpful default  ",
			source: "npm:helper",
		},
	], null, 2));

	assert.deepEqual(readDefaultExtensions(fixture.extensions), [
		{
			id: "helper",
			aliases: [],
			replaces: [],
			migrateReplacements: false,
			critical: false,
			source: "npm:helper",
			description: "Helpful default",
		},
	]);
	assert.deepEqual(readDefaultExtensions(join(fixture.dir, "missing-default-extensions.json"), { allowMissing: true }), []);
	assert.throws(
		() => readDefaultExtensions(join(fixture.dir, "missing-default-extensions.json")),
		/File does not exist:/,
	);
});

test("setDefaultExtensionProvenance returns false for non-plain-object settings", () => {
	for (const settings of [undefined, null, false, 0, 1n, "tlh", Symbol("tlh")]) {
		assert.equal(setDefaultExtensionProvenance(settings, ["npm:helper"]), false);
	}
	assert.equal(setDefaultExtensionProvenance([], ["npm:helper"]), false);
	assert.equal(setDefaultExtensionProvenance({ tlh: [] }, ["npm:helper"]), false);

	const settings = {};
	assert.equal(setDefaultExtensionProvenance(settings, ["npm:helper@1.2.3"]), true);
	assert.deepEqual(settings, {
		tlh: {
			defaultExtensionProvenance: {
				managedPackageIdentities: ["npm:helper"],
			},
		},
	});
});

test("bundled manifest retires rtk while keeping quiet-tools bundled", () => {
	const ids = bundledExtensions.map(({ id }) => id);
	const quietTools = bundledExtension("quiet-tools");
	const dirtyRepoGuard = bundledExtension("dirty-repo-guard");

	assert.ok(dirtyRepoGuard, "bundled dirty-repo-guard default should exist");
	assert.equal(packageIdentity(dirtyRepoGuard.source), "npm:@diegopetrucci/pi-dirty-repo-guard");
	assert.equal(ids.includes("permission-gate"), false);
	assert.equal(ids.includes("confirm-destructive"), false);
	assert.equal(ids.includes("librarian"), false);
	assert.equal(ids.includes("rtk"), false);
	assert.equal(ids.includes("triage-comments"), false);
	assert.ok(quietTools, "bundled quiet-tools default should exist");
	assert.deepEqual(quietTools.aliases, ["compact-bash"]);
	assert.deepEqual(quietTools.replaces, ["npm:@diegopetrucci/pi-compact-bash"]);
	assert.equal(quietTools.critical, false);
	assert.equal(packageIdentity(quietTools.source), "npm:@diegopetrucci/pi-quiet-tools");
});

test("bundled manifest keeps expected managed npm package identities", () => {
	for (const [id, packageId] of expectedBundledNpmPackageIdentities) {
		assert.equal(packageIdentity(bundledSource(id)), packageId, `${id} should keep managing ${packageId}`);
	}
});

test("tlh-defaults errors when the default-extension manifest is missing", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.settings, JSON.stringify({ packages: [] }, null, 2));

	const result = spawnSync(process.execPath, [
		defaultsScript,
		"--settings", fixture.settings,
		"--defaults", join(fixture.dir, "missing-default-extensions.json"),
		"list",
	], {
		cwd: repoRoot,
		env: process.env,
		encoding: "utf8",
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /File does not exist:/);
});

test("installable support files no longer include the legacy defaults helper tree", () => {
	const installableVariables = new Set(installableSupportFiles().map((file) => file.variable));

	for (const variable of [
		"TLH_DEFAULTS_SCRIPT",
		"TLH_INSTALL_PACKAGE_SOURCE_LIB",
		"TLH_INSTALL_PATHS_LIB",
		"TLH_SAFE_PROFILE_WRITE_LIB",
		"TLH_INSTALL_UTILS_LIB",
		"DEFAULT_EXTENSIONS_LIB",
		"DEFAULT_EXTENSIONS_FILE",
	]) {
		assert.equal(installableVariables.has(variable), false, variable);
	}
	assert.equal(installableVariables.has("TLH_RECOVER_UPDATE_SCRIPT"), true);
});

test("merge force-removes all pi-intercom package identities (string and object entries, duplicates, idempotent)", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "helper",
			source: "npm:helper",
		},
	], null, 2));
	// Cover all 4 force-removed identities, both string and object forms, and a duplicate entry.
	writeFileSync(fixture.settings, JSON.stringify({
		packages: [
			harnessPackage,
			"npm:@diegopetrucci/pi-intercom@0.8.0",
			"npm:pi-intercom@0.7.0",
			{ source: "git:github.com/nicobailon/pi-intercom@v0.6.0", owner: "preserve" },
			"git:github.com/diegopetrucci/pi-intercom@tlh-v0.6.0-6",
			"git:github.com/diegopetrucci/pi-intercom@tlh-v0.6.0-6",
			"npm:helper",
		],
		tlh: { disabledDefaultExtensions: ["intercom", "pi-intercom", "helper"] },
	}, null, 2));

	runNode(mergeScript, [
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", fixture.extensions,
		"--quiet",
	]);

	const settings = readJson(fixture.settings);
	// All intercom packages must be gone; unrelated packages survive (helper is
	// removed because it stays opted out via disabledDefaultExtensions).
	assert.deepEqual(settings.packages, [harnessPackage]);
	// Stale intercom opt-outs are pruned while unrelated opt-outs survive.
	assert.deepEqual(settings.tlh.disabledDefaultExtensions, ["helper"]);

	// Second merge is idempotent — no changes reported.
	const secondOutput = runNode(mergeScript, [
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", fixture.extensions,
	]);
	assert.match(secondOutput, /No settings changes needed\./);
});

test("merge force-removes pi-intercom and post-merge sources/critical-sources contain no intercom entry", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "helper",
			source: "npm:helper",
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		packages: [
			"npm:@diegopetrucci/pi-intercom@0.8.0",
			"npm:helper",
		],
	}, null, 2));

	runNode(mergeScript, [
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", fixture.extensions,
		"--quiet",
	]);

	const sources = runNode(defaultsScript, [
		"--settings", fixture.settings,
		"--defaults", fixture.extensions,
		"sources",
	]).trim().split("\n").filter(Boolean);
	assert.equal(
		sources.some((s) => s.includes("pi-intercom")),
		false,
		"sources must not contain any pi-intercom entry after force-removal",
	);

	const criticalSources = runNode(defaultsScript, [
		"--settings", fixture.settings,
		"--defaults", fixture.extensions,
		"critical-sources",
	]).trim().split("\n").filter(Boolean);
	assert.equal(
		criticalSources.some((s) => s.includes("pi-intercom")),
		false,
		"critical-sources must not contain any pi-intercom entry after force-removal",
	);
});

test("merge force-removes legacy pi-rtk packages and prunes stale rtk opt-outs", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "helper",
			source: "npm:helper",
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		packages: [
			harnessPackage,
			"git:github.com/diegopetrucci/pi-rtk@tlh-v0.6.0-5",
			"npm:pi-rtk",
			"npm:@sherif-fanous/pi-rtk",
			"git:github.com/sherif-fanous/pi-rtk@v0.5.0",
			"npm:helper",
		],
		tlh: { rtk: { disabled: true }, disabledDefaultExtensions: ["rtk", "pi-rtk", "helper"] },
	}, null, 2));

	runNode(mergeScript, [
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", fixture.extensions,
		"--quiet",
	]);

	const settings = readJson(fixture.settings);
	assert.deepEqual(settings.packages, [harnessPackage]);
	assert.deepEqual(settings.tlh.disabledDefaultExtensions, ["helper"]);
	assert.equal(Object.hasOwn(settings.tlh, "rtk"), false);
});

test("merge no longer reorders quiet-tools around retired rtk packages", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "quiet-tools",
			aliases: ["compact-bash"],
			replaces: ["npm:@diegopetrucci/pi-compact-bash"],
			source: bundledSource("quiet-tools"),
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		packages: [
			harnessPackage,
			"npm:before",
			"git:github.com/diegopetrucci/pi-rtk@tlh-v0.6.0-5",
			"npm:@diegopetrucci/pi-quiet-tools",
			"npm:after",
		],
	}, null, 2));

	const output = runNode(mergeScript, [
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", fixture.extensions,
	]);

	assert.doesNotMatch(output, /reorder targeted default extension packages for load order/);
	assert.deepEqual(readJson(fixture.settings).packages, [
		harnessPackage,
		"npm:before",
		bundledSource("quiet-tools"),
		"npm:after",
	]);
});

test("tlh-defaults rejects disabling critical defaults without changing settings", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "subagents",
			aliases: ["pi-subagents"],
			critical: true,
			source: "npm:subagents",
		},
		{
			id: "helper",
			source: "npm:helper",
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		packages: ["npm:subagents", "npm:helper"],
		tlh: { disabledDefaultExtensions: ["helper"] },
	}, null, 2));
	const before = readFileSync(fixture.settings, "utf8");

	const result = spawnSync(process.execPath, [
		defaultsScript,
		"--settings", fixture.settings,
		"--defaults", fixture.extensions,
		"disable", "pi-subagents",
	], {
		cwd: repoRoot,
		env: process.env,
		encoding: "utf8",
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /critical default extension 'subagents' cannot be disabled/i);
	assert.equal(readFileSync(fixture.settings, "utf8"), before);
});

test("tlh-defaults refuses to mutate normal Pi config paths", () => {
	const fixture = tempFixture();
	const homeDir = join(fixture.dir, "home");
	const protectedSettings = join(homeDir, ".pi", "agent", "settings.json");
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "helper",
			source: "npm:helper",
		},
	], null, 2));

	const result = spawnSync(process.execPath, [
		defaultsScript,
		"--settings", protectedSettings,
		"--defaults", fixture.extensions,
		"disable", "helper",
	], {
		cwd: repoRoot,
		env: { ...process.env, HOME: homeDir },
		encoding: "utf8",
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Refusing to modify normal Pi config from The Last Harness defaults command/);
	assert.equal(existsSync(join(homeDir, ".pi")), false);
});

test("tlh-defaults enable cleans stale critical opt-outs while preserving non-critical opt-outs", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "subagents",
			aliases: ["pi-subagents"],
			critical: true,
			source: "npm:subagents",
		},
		{
			id: "helper",
			source: "npm:helper",
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		packages: ["npm:subagents"],
		tlh: { disabledDefaultExtensions: ["pi-subagents", "helper"] },
	}, null, 2));

	runNode(defaultsScript, [
		"--settings", fixture.settings,
		"--defaults", fixture.extensions,
		"enable", "subagents",
	]);

	const settings = readJson(fixture.settings);
	assert.deepEqual(settings.tlh.disabledDefaultExtensions, ["helper"]);
	assert.deepEqual(settings.packages, ["npm:subagents"]);
});

test("tlh-defaults preserves settings and backup file modes when rewriting settings", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "helper",
			source: "npm:helper",
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({ packages: ["npm:helper"] }, null, 2));
	chmodSync(fixture.settings, 0o640);

	runNode(defaultsScript, [
		"--settings", fixture.settings,
		"--defaults", fixture.extensions,
		"disable", "helper",
	]);

	assert.equal(lstatSync(fixture.settings).mode & 0o777, 0o640);
	const backups = backupFiles(fixture.settings);
	assert.equal(backups.length, 1);
	assert.equal(lstatSync(join(dirname(fixture.settings), backups[0])).mode & 0o777, 0o640);
});

test("tlh-defaults rejects symlinked settings targets before creating backups", () => {
	const fixture = tempFixture();
	const externalDir = mkdtempSync(join(tmpdir(), "tlh-defaults-symlink-target-"));
	const externalSettings = join(externalDir, "settings.json");
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "helper",
			source: "npm:helper",
		},
	], null, 2));
	writeFileSync(externalSettings, JSON.stringify({ packages: ["npm:helper"] }, null, 2));
	symlinkFile(externalSettings, fixture.settings);

	const result = spawnSync(process.execPath, [
		defaultsScript,
		"--settings", fixture.settings,
		"--defaults", fixture.extensions,
		"disable", "helper",
	], {
		cwd: repoRoot,
		env: process.env,
		encoding: "utf8",
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /symlinked TLH defaults settings source/);
	assert.deepEqual(backupFiles(fixture.settings), []);
});

test("tlh-defaults prunes legacy rtk opt-outs while mutating other defaults", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "helper",
			source: "npm:helper",
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		packages: ["npm:helper"],
		tlh: { rtk: { disabled: true }, disabledDefaultExtensions: ["rtk", "pi-rtk"] },
	}, null, 2));

	runNode(defaultsScript, [
		"--settings", fixture.settings,
		"--defaults", fixture.extensions,
		"disable", "helper",
	]);

	const settings = readJson(fixture.settings);
	assert.deepEqual(settings.packages, []);
	assert.deepEqual(settings.tlh?.disabledDefaultExtensions ?? [], ["helper"]);
	assert.equal(Object.hasOwn(settings.tlh, "rtk"), false);
});

test("tlh-defaults persists retired tlh.rtk cleanup even when disable is otherwise a no-op", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "helper",
			source: "npm:helper",
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		tlh: {
			rtk: { disabled: true },
			disabledDefaultExtensions: ["helper"],
		},
	}, null, 2));

	const output = runNode(defaultsScript, [
		"--settings", fixture.settings,
		"--defaults", fixture.extensions,
		"disable", "helper",
	]);

	const settings = readJson(fixture.settings);
	assert.deepEqual(settings, {
		packages: [],
		tlh: {
			disabledDefaultExtensions: ["helper"],
			defaultExtensionProvenance: {
				managedPackageIdentities: [],
			},
		},
	});
	assert.equal(backupFiles(fixture.settings).length, 1);
	assert.doesNotMatch(output, /No settings changes were needed\./);
});

test("merge updates critical package pins without --force", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "subagents",
			critical: true,
			source: "git:github.com/tlh/pi-subagents@new-pin",
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({ packages: ["git:github.com/tlh/pi-subagents@old-pin"] }, null, 2));

	runNode(mergeScript, [
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", fixture.extensions,
		"--quiet",
	]);

	const packages = readJson(fixture.settings).packages;
	assert(packages.includes("git:github.com/tlh/pi-subagents@new-pin"));
	assert(!packages.includes("git:github.com/tlh/pi-subagents@old-pin"));
});

test("merge repairs critical same-identity package entries with disabling extension filters", () => {
	for (const { name, extensions } of disablingExtensionFilterCases) {
		const fixture = tempFixture();
		const criticalSource = "git:github.com/tlh/pi-subagents@new-pin";
		const oldSource = "git:github.com/tlh/pi-subagents@old-pin";
		writeFileSync(fixture.extensions, JSON.stringify([
			{
				id: "subagents",
				critical: true,
				source: criticalSource,
			},
		], null, 2));
		writeFileSync(fixture.settings, JSON.stringify({
			packages: [{ source: oldSource, extensions, owner: "preserve" }],
		}, null, 2));

		runNode(mergeScript, [
			fixture.defaults,
			"--settings", fixture.settings,
			"--default-extensions", fixture.extensions,
			"--quiet",
		]);

		const packages = readJson(fixture.settings).packages;
		const repaired = packages.find((entry) => packageSourceOf(entry) === criticalSource);
		assert(repaired, `${name}: critical package source was not repaired`);
		assert.equal(repaired.owner, "preserve", `${name}: unrelated package fields should be preserved`);
		assert.equal(Object.hasOwn(repaired, "extensions"), false, `${name}: disabling extension filter should be removed`);
		assert.equal(packages.some((entry) => packageSourceOf(entry) === oldSource), false, `${name}: old source should be removed`);
	}
});

test("merge removes critical package extension filters even when source is already canonical", () => {
	const fixture = tempFixture();
	const criticalSource = "git:github.com/tlh/pi-subagents@new-pin";
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "subagents",
			critical: true,
			source: criticalSource,
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		packages: [{ source: criticalSource, extensions: ["-src/extension/index.ts"], owner: "preserve" }],
	}, null, 2));

	runNode(mergeScript, [
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", fixture.extensions,
		"--quiet",
	]);

	const repaired = readJson(fixture.settings).packages.find((entry) => packageSourceOf(entry) === criticalSource);
	assert.deepEqual(repaired, { source: criticalSource, owner: "preserve" });
});

test("merge --force updates non-critical package source when identity matches a new pinned source", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "helper",
			source: "git:github.com/tlh/helper@new-pin",
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({ packages: ["git:github.com/tlh/helper@old-pin"] }, null, 2));

	runNode(mergeScript, [
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", fixture.extensions,
		"--force",
		"--quiet",
	]);

	const packages = readJson(fixture.settings).packages;
	assert(packages.includes("git:github.com/tlh/helper@new-pin"));
	assert(!packages.includes("git:github.com/tlh/helper@old-pin"));
});

test("tlh-defaults emits critical sources despite disabling package extension filters", () => {
	for (const { name, extensions } of disablingExtensionFilterCases) {
		const fixture = tempFixture();
		const criticalSource = "git:github.com/tlh/critical@new-pin";
		writeFileSync(fixture.extensions, JSON.stringify([
			{
				id: "critical",
				critical: true,
				source: criticalSource,
			},
		], null, 2));
		writeFileSync(fixture.settings, JSON.stringify({
			packages: [{ source: "git:github.com/tlh/critical@old-pin", extensions }],
		}, null, 2));

		const sources = runNode(defaultsScript, ["--settings", fixture.settings, "--defaults", fixture.extensions, "sources"])
			.trim()
			.split("\n")
			.filter(Boolean);
		assert.deepEqual(sources, [criticalSource], `${name}: sources should include critical default`);

		const criticalSources = runNode(defaultsScript, ["--settings", fixture.settings, "--defaults", fixture.extensions, "critical-sources"])
			.trim()
			.split("\n")
			.filter(Boolean);
		assert.deepEqual(criticalSources, [criticalSource], `${name}: critical-sources should include critical default`);
	}
});

test("tlh-defaults list does not report critical defaults as disabled by package filters", () => {
	for (const { name, extensions } of disablingExtensionFilterCases) {
		const fixture = tempFixture();
		const criticalSource = "git:github.com/tlh/critical@new-pin";
		writeFileSync(fixture.extensions, JSON.stringify([
			{
				id: "critical",
				critical: true,
				source: criticalSource,
			},
		], null, 2));
		writeFileSync(fixture.settings, JSON.stringify({
			packages: [{ source: "git:github.com/tlh/critical@old-pin", extensions }],
		}, null, 2));

		const output = runNode(defaultsScript, ["--settings", fixture.settings, "--defaults", fixture.extensions, "list"]);
		assert.match(output, /enabled\s+critical/, `${name}: critical default should be listed as enabled`);
		assert.doesNotMatch(output, /disabled by package filter/, `${name}: critical package filter should not disable status`);
	}
});

test("tlh-defaults keeps non-critical allowlisted package entrypoints enabled", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "helper",
			source: "npm:helper",
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		packages: [{ source: "npm:helper", extensions: ["index.ts"] }],
	}, null, 2));

	const output = runNode(defaultsScript, ["--settings", fixture.settings, "--defaults", fixture.extensions, "list"]);
	assert.match(output, /enabled\s+helper/, "non-critical allowlist should be listed as enabled");
	assert.doesNotMatch(output, /disabled by package filter/, "non-critical allowlist should not be treated as disabled");

	const sources = runNode(defaultsScript, ["--settings", fixture.settings, "--defaults", fixture.extensions, "sources"])
		.trim()
		.split("\n")
		.filter(Boolean);
	assert.deepEqual(sources, ["npm:helper"]);
});

test("tlh-defaults sources emit bundled pinned npm sources for existing unpinned managed defaults", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "oracle",
			source: "npm:@diegopetrucci/pi-oracle@0.1.12",
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		packages: ["npm:@diegopetrucci/pi-oracle"],
	}, null, 2));

	const sources = runNode(defaultsScript, ["--settings", fixture.settings, "--defaults", fixture.extensions, "sources"])
		.trim()
		.split("\n")
		.filter(Boolean);
	assert.deepEqual(sources, ["npm:@diegopetrucci/pi-oracle@0.1.12"]);
});

test("tlh-defaults sources emit the bundled npm pin when the installed managed package has an older same-identity pin", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "oracle",
			source: "npm:@diegopetrucci/pi-oracle@0.1.13",
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		packages: ["npm:@diegopetrucci/pi-oracle@0.1.12"],
	}, null, 2));

	const sources = runNode(defaultsScript, ["--settings", fixture.settings, "--defaults", fixture.extensions, "sources"])
		.trim()
		.split("\n")
		.filter(Boolean);
	assert.deepEqual(sources, ["npm:@diegopetrucci/pi-oracle@0.1.13"]);
});

test("tlh-defaults sources still respect disabled defaults while migrating pi-web-access replacements to the managed npm pin", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "oracle",
			source: "npm:@diegopetrucci/pi-oracle@0.1.12",
		},
		{
			id: "notify",
			source: "npm:@diegopetrucci/pi-notify@0.1.5",
		},
		{
			id: "pi-web-access",
			replaces: ["npm:pi-web-access", "git:github.com/nicobailon/pi-web-access", previousPiWebAccessSource],
			migrateReplacements: true,
			source: bundledSource("pi-web-access"),
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		packages: [
			"npm:@diegopetrucci/pi-oracle",
			"npm:@diegopetrucci/pi-notify",
			"npm:pi-web-access",
		],
		tlh: { disabledDefaultExtensions: ["notify"] },
	}, null, 2));

	const sources = runNode(defaultsScript, ["--settings", fixture.settings, "--defaults", fixture.extensions, "sources"])
		.trim()
		.split("\n")
		.filter(Boolean);
	assert.deepEqual(sources, ["npm:@diegopetrucci/pi-oracle@0.1.12", bundledSource("pi-web-access")]);
});

test("tlh-defaults sources defers non-migrating replacements and ignores stale/manual critical opt-outs", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "deferred",
			replaces: ["npm:old-default"],
			critical: true,
			source: "npm:new-default",
		},
		{
			id: "critical-enabled",
			critical: true,
			source: "git:github.com/tlh/critical@pin",
		},
		{
			id: "critical-disabled",
			critical: true,
			source: "git:github.com/tlh/disabled@pin",
		},
		{
			id: "non-critical-disabled",
			source: "npm:non-critical",
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		packages: ["npm:old-default", "git:github.com/tlh/critical@old-pin"],
		tlh: { disabledDefaultExtensions: ["critical-disabled", "non-critical-disabled"] },
	}, null, 2));

	const sources = runNode(defaultsScript, ["--settings", fixture.settings, "--defaults", fixture.extensions, "sources"])
		.trim()
		.split("\n")
		.filter(Boolean);
	assert.deepEqual(sources, ["git:github.com/tlh/critical@pin", "git:github.com/tlh/disabled@pin"]);

	const criticalSources = runNode(defaultsScript, ["--settings", fixture.settings, "--defaults", fixture.extensions, "critical-sources"])
		.trim()
		.split("\n")
		.filter(Boolean);
	assert.deepEqual(criticalSources, ["git:github.com/tlh/critical@pin", "git:github.com/tlh/disabled@pin"]);
});

for (const replacementSource of [
	"npm:pi-web-access@0.10.7",
	"git:github.com/nicobailon/pi-web-access@v0.10.7",
	previousPiWebAccessSource,
]) {
	test(`tlh-defaults enable switches ${replacementSource} to the bundled TLH source`, () => {
		const fixture = tempFixture();
		writeFileSync(fixture.extensions, JSON.stringify([
			{
				id: "pi-web-access",
				replaces: ["npm:pi-web-access", "git:github.com/nicobailon/pi-web-access", previousPiWebAccessSource],
				migrateReplacements: true,
				source: bundledSource("pi-web-access"),
			},
		], null, 2));
		writeFileSync(fixture.settings, JSON.stringify({
			packages: [replacementSource],
			tlh: { disabledDefaultExtensions: ["pi-web-access"] },
		}, null, 2));

		runNode(defaultsScript, [
			"--settings", fixture.settings,
			"--defaults", fixture.extensions,
			"enable", "pi-web-access",
		]);

		const settings = readJson(fixture.settings);
		assert.deepEqual(settings.packages, [bundledSource("pi-web-access")]);
		assert.deepEqual(settings.tlh.disabledDefaultExtensions, []);
		assert.deepEqual(settings.tlh.defaultExtensionProvenance.managedPackageIdentities, ["npm:@diegopetrucci/pi-web-access"]);
	});
}

for (const scenario of [
	{
		command: "disable",
		initialSettings: {
			packages: [harnessPackage, retiredPlannotatorPackage, "npm:@diegopetrucci/pi-notify"],
		},
		expectedPackages: [harnessPackage],
		expectedDisabledDefaultExtensions: ["notify"],
		expectedManagedPackageIdentities: [],
	},
	{
		command: "enable",
		initialSettings: {
			packages: [harnessPackage, retiredPlannotatorPackage],
			tlh: { disabledDefaultExtensions: ["notify"] },
		},
		expectedPackages: [harnessPackage, "npm:@diegopetrucci/pi-notify"],
		expectedDisabledDefaultExtensions: [],
		expectedManagedPackageIdentities: ["npm:@diegopetrucci/pi-notify"],
	},
]) {
	test(`tlh-defaults ${scenario.command} preserves legacy retired default cleanup for merge`, () => {
		const fixture = tempFixture();
		writeFileSync(fixture.extensions, JSON.stringify([
			{
				id: "notify",
				source: "npm:@diegopetrucci/pi-notify",
			},
		], null, 2));
		writeFileSync(fixture.settings, JSON.stringify(scenario.initialSettings, null, 2));

		runNode(defaultsScript, [
			"--settings", fixture.settings,
			"--defaults", fixture.extensions,
			scenario.command, "notify",
		]);

		const afterDefaults = readJson(fixture.settings);
		assert(afterDefaults.packages.includes(retiredPlannotatorPackage), "legacy retired package should still be present before merge cleanup");

		const firstMergeOutput = runNode(mergeScript, [
			fixture.defaults,
			"--settings", fixture.settings,
			"--default-extensions", fixture.extensions,
		]);
		assert.match(firstMergeOutput, /Will remove retired TLH default package: npm:@plannotator\/pi-extension/);

		const afterFirstMerge = readJson(fixture.settings);
		assert.deepEqual(afterFirstMerge.packages, scenario.expectedPackages);
		assert.deepEqual(afterFirstMerge.tlh?.disabledDefaultExtensions ?? [], scenario.expectedDisabledDefaultExtensions);
		assert.deepEqual(
			afterFirstMerge.tlh?.defaultExtensionProvenance?.managedPackageIdentities ?? [],
			scenario.expectedManagedPackageIdentities,
		);

		const secondMergeOutput = runNode(mergeScript, [
			fixture.defaults,
			"--settings", fixture.settings,
			"--default-extensions", fixture.extensions,
		]);
		assert.match(secondMergeOutput, /No settings changes needed\./);
		assert.equal(secondMergeOutput.includes("retired TLH default package"), false, "retired cleanup should remain one-time");
	});
}

test("tlh-defaults preserves pending retired default provenance across multiple mutations before merge", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "notify",
			source: "npm:@diegopetrucci/pi-notify",
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		packages: [harnessPackage, retiredPlannotatorPackage, "npm:@diegopetrucci/pi-notify"],
	}, null, 2));

	runNode(defaultsScript, [
		"--settings", fixture.settings,
		"--defaults", fixture.extensions,
		"disable", "notify",
	]);
	runNode(defaultsScript, [
		"--settings", fixture.settings,
		"--defaults", fixture.extensions,
		"enable", "notify",
	]);

	const afterDefaults = readJson(fixture.settings);
	assert.deepEqual(afterDefaults.packages, [
		harnessPackage,
		retiredPlannotatorPackage,
		"npm:@diegopetrucci/pi-notify",
	]);
	assert.deepEqual(afterDefaults.tlh?.disabledDefaultExtensions ?? [], []);
	assert.deepEqual(afterDefaults.tlh?.defaultExtensionProvenance?.managedPackageIdentities ?? [], [
		"npm:@diegopetrucci/pi-notify",
		"npm:@plannotator/pi-extension",
	]);

	const firstMergeOutput = runNode(mergeScript, [
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", fixture.extensions,
	]);
	assert.match(firstMergeOutput, /Will remove retired TLH default package: npm:@plannotator\/pi-extension/);

	const afterMerge = readJson(fixture.settings);
	assert.deepEqual(afterMerge.packages, [
		harnessPackage,
		"npm:@diegopetrucci/pi-notify",
	]);
	assert.deepEqual(afterMerge.tlh?.defaultExtensionProvenance?.managedPackageIdentities ?? [], ["npm:@diegopetrucci/pi-notify"]);
});

test("tlh-defaults disable anthropic-auth removes package and drops warnings.anthropicExtraUsage when it is the tlh default", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "anthropic-auth",
			source: "npm:@gotgenes/pi-anthropic-auth",
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		packages: ["npm:@gotgenes/pi-anthropic-auth"],
		warnings: { anthropicExtraUsage: false },
	}, null, 2));

	runNode(defaultsScript, [
		"--settings", fixture.settings,
		"--defaults", fixture.extensions,
		"disable", "anthropic-auth",
	]);

	const settings = readJson(fixture.settings);
	assert(!settings.packages.includes("npm:@gotgenes/pi-anthropic-auth"), "package should be removed");
	assert.equal(settings.warnings, undefined, "warnings should be dropped when it becomes empty");
	assert.deepEqual(settings.tlh?.defaultExtensionProvenance?.managedPackageIdentities, []);
});

test("tlh-defaults enable anthropic-auth restores warnings.anthropicExtraUsage when no warnings object is present", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "anthropic-auth",
			source: "npm:@gotgenes/pi-anthropic-auth",
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		packages: [],
		tlh: { disabledDefaultExtensions: ["anthropic-auth"] },
	}, null, 2));

	runNode(defaultsScript, [
		"--settings", fixture.settings,
		"--defaults", fixture.extensions,
		"enable", "anthropic-auth",
	]);

	const settings = readJson(fixture.settings);
	assert(settings.packages.includes("npm:@gotgenes/pi-anthropic-auth"), "package should be added");
	assert.equal(settings.warnings?.anthropicExtraUsage, false, "warnings.anthropicExtraUsage should be set to false");
	assert.deepEqual(settings.tlh.defaultExtensionProvenance.managedPackageIdentities, ["npm:@gotgenes/pi-anthropic-auth"]);
});

test("tlh-defaults disable anthropic-auth preserves explicit warnings.anthropicExtraUsage: true set by the user", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "anthropic-auth",
			source: "npm:@gotgenes/pi-anthropic-auth",
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		packages: ["npm:@gotgenes/pi-anthropic-auth"],
		warnings: { anthropicExtraUsage: true },
	}, null, 2));

	runNode(defaultsScript, [
		"--settings", fixture.settings,
		"--defaults", fixture.extensions,
		"disable", "anthropic-auth",
	]);

	const settings = readJson(fixture.settings);
	assert(!settings.packages.includes("npm:@gotgenes/pi-anthropic-auth"), "package should be removed");
	assert.equal(settings.warnings?.anthropicExtraUsage, true, "explicit true value should be preserved");
	assert(settings.warnings !== undefined, "warnings object should remain intact");
});

test("merge does not introduce warnings.anthropicExtraUsage when anthropic-auth is in disabledDefaultExtensions", () => {
	const fixture = tempFixture();
	// Synthetic defaults with the warnings suppression that ships in config/settings.defaults.json.
	writeFileSync(fixture.defaults, JSON.stringify({ packages: [], warnings: { anthropicExtraUsage: false } }, null, 2));
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "anthropic-auth",
			source: "npm:@gotgenes/pi-anthropic-auth",
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		packages: [],
		tlh: { disabledDefaultExtensions: ["anthropic-auth"] },
	}, null, 2));

	runNode(mergeScript, [
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", fixture.extensions,
		"--quiet",
	]);

	const settings = readJson(fixture.settings);
	assert.equal(settings.warnings?.anthropicExtraUsage, undefined, "warnings.anthropicExtraUsage should not be introduced by merge");
	assert.equal(settings.warnings, undefined, "warnings object should not be created by merge");
});

test("bundled manifest contains pi-web-access entry with migration metadata", () => {
	const bundled = bundledExtensions;
	const webAccess = bundled.find(({ id }) => id === "pi-web-access");

	assert.ok(webAccess, "bundled pi-web-access entry should exist");
	assert.equal(webAccess.critical, false, "pi-web-access must not be critical");
	assert.deepEqual(webAccess.replaces, [
		"npm:pi-web-access",
		"git:github.com/nicobailon/pi-web-access",
		previousPiWebAccessSource,
	], "pi-web-access should migrate upstream and prior TLH replacement sources");
	assert.equal(webAccess.migrateReplacements, true, "pi-web-access replacements must stay enabled for migration");
	assert.deepEqual(webAccess.aliases, [], "pi-web-access must have no aliases");
});

test("bundled manifest contains mcporter entry and migrates prior TLH-managed installs", () => {
	const bundledPath = bundledExtensionsPath;
	const bundled = readDefaultExtensions(bundledPath);
	const mcporter = bundled.find(({ id }) => id === "mcporter");

	assert.ok(mcporter, "bundled mcporter entry should exist");
	assert.equal(mcporter.critical, false, "mcporter must not be critical");
	assert.deepEqual(mcporter.aliases, ["pi-mcp-adapter", "mcp-adapter"]);
	assert.deepEqual(mcporter.replaces, ["npm:pi-mcp-adapter", previousMcporterSource]);
	assert.equal(mcporter.migrateReplacements, true, "mcporter should migrate both upstream npm and previous TLH git installs");

	const replacementMergeFixture = tempFixture();
	writeFileSync(replacementMergeFixture.extensions, JSON.stringify([mcporter], null, 2));
	writeFileSync(replacementMergeFixture.settings, JSON.stringify({ packages: [previousMcporterSource] }, null, 2));

	runNode(mergeScript, [
		replacementMergeFixture.defaults,
		"--settings", replacementMergeFixture.settings,
		"--default-extensions", replacementMergeFixture.extensions,
		"--quiet",
	]);

	const replacementMergedSettings = readJson(replacementMergeFixture.settings);
	assert.deepEqual(replacementMergedSettings.packages, [harnessPackage, bundledSource("mcporter")]);
	assert.deepEqual(replacementMergedSettings.tlh.defaultExtensionProvenance.managedPackageIdentities, ["npm:@diegopetrucci/pi-mcp-adapter"]);

	const managedPinnedFixture = tempFixture();
	writeFileSync(managedPinnedFixture.extensions, JSON.stringify([mcporter], null, 2));
	writeFileSync(managedPinnedFixture.settings, JSON.stringify({
		packages: [previousBundledMcporterSource],
		tlh: {
			defaultExtensionProvenance: {
				managedPackageIdentities: ["npm:@diegopetrucci/pi-mcp-adapter"],
			},
		},
	}, null, 2));

	runNode(mergeScript, [
		managedPinnedFixture.defaults,
		"--settings", managedPinnedFixture.settings,
		"--default-extensions", managedPinnedFixture.extensions,
		"--quiet",
	]);

	const managedPinnedSettings = readJson(managedPinnedFixture.settings);
	assert.equal(managedPinnedSettings.packages.includes(bundledSource("mcporter")), true);
	assert.equal(managedPinnedSettings.packages.includes(previousBundledMcporterSource), false);
	assert.equal(managedPinnedSettings.packages.includes(harnessPackage), true);
	assert.deepEqual(managedPinnedSettings.tlh.defaultExtensionProvenance.managedPackageIdentities, ["npm:@diegopetrucci/pi-mcp-adapter"]);

	const manualPinnedFixture = tempFixture();
	writeFileSync(manualPinnedFixture.extensions, JSON.stringify([mcporter], null, 2));
	writeFileSync(manualPinnedFixture.settings, JSON.stringify({ packages: [previousBundledMcporterSource] }, null, 2));

	runNode(mergeScript, [
		manualPinnedFixture.defaults,
		"--settings", manualPinnedFixture.settings,
		"--default-extensions", manualPinnedFixture.extensions,
		"--quiet",
	]);

	const manualPinnedSettings = readJson(manualPinnedFixture.settings);
	assert.equal(manualPinnedSettings.packages.includes(previousBundledMcporterSource), true);
	assert.equal(manualPinnedSettings.packages.includes(bundledSource("mcporter")), false);
	assert.equal(manualPinnedSettings.packages.includes(harnessPackage), true);
	assert.deepEqual(manualPinnedSettings.tlh.defaultExtensionProvenance.managedPackageIdentities, []);

	const disableFixture = tempFixture();
	writeFileSync(disableFixture.settings, JSON.stringify({ packages: [previousMcporterSource] }, null, 2));

	runNode(defaultsScript, [
		"--settings", disableFixture.settings,
		"--defaults", bundledPath,
		"disable", "mcp-adapter",
	]);

	const disabledSettings = readJson(disableFixture.settings);
	assert.deepEqual(disabledSettings.tlh.disabledDefaultExtensions, ["mcporter"]);
	assert.deepEqual(disabledSettings.packages, []);
});

test("bundled same-identity managed npm pins advance while manual pins stay untouched", () => {
	const fixtureExtension = {
		id: "notify",
		source: bundledSource("notify"),
	};

	const managedPinnedFixture = tempFixture();
	writeFileSync(managedPinnedFixture.extensions, JSON.stringify([fixtureExtension], null, 2));
	writeFileSync(managedPinnedFixture.settings, JSON.stringify({
		packages: [previousBundledNotifySource],
		tlh: {
			defaultExtensionProvenance: {
				managedPackageIdentities: ["npm:@diegopetrucci/pi-notify"],
			},
		},
	}, null, 2));

	runNode(mergeScript, [
		managedPinnedFixture.defaults,
		"--settings", managedPinnedFixture.settings,
		"--default-extensions", managedPinnedFixture.extensions,
		"--quiet",
	]);

	const managedPinnedSettings = readJson(managedPinnedFixture.settings);
	assert.equal(managedPinnedSettings.packages.includes(bundledSource("notify")), true);
	assert.equal(managedPinnedSettings.packages.includes(previousBundledNotifySource), false);
	assert.deepEqual(managedPinnedSettings.tlh.defaultExtensionProvenance.managedPackageIdentities, ["npm:@diegopetrucci/pi-notify"]);

	const manualPinnedFixture = tempFixture();
	writeFileSync(manualPinnedFixture.extensions, JSON.stringify([fixtureExtension], null, 2));
	writeFileSync(manualPinnedFixture.settings, JSON.stringify({
		packages: [previousBundledNotifySource],
	}, null, 2));

	runNode(mergeScript, [
		manualPinnedFixture.defaults,
		"--settings", manualPinnedFixture.settings,
		"--default-extensions", manualPinnedFixture.extensions,
		"--quiet",
	]);

	const manualPinnedSettings = readJson(manualPinnedFixture.settings);
	assert.equal(manualPinnedSettings.packages.includes(previousBundledNotifySource), true);
	assert.equal(manualPinnedSettings.packages.includes(bundledSource("notify")), false);
	assert.deepEqual(manualPinnedSettings.tlh.defaultExtensionProvenance.managedPackageIdentities, []);
});

test("bundled manifest contains subagents entry with correct critical migration flags and no intercom entry", () => {
	const bundled = bundledExtensions;
	const subagents = bundled.find(({ id }) => id === "subagents");
	const intercom = bundled.find(({ id }) => id === "intercom");

	assert.ok(subagents, "bundled subagents entry should exist");
	assert.equal(subagents.critical, true, "subagents must stay critical");
	assert.deepEqual(subagents.aliases, ["pi-subagents"]);
	assert.deepEqual(subagents.replaces, [
		"npm:pi-subagents",
		"git:github.com/nicobailon/pi-subagents",
		"git:github.com/diegopetrucci/pi-subagents",
	]);
	assert.equal(subagents.migrateReplacements, true, "subagents replacements must stay enabled");

	assert.equal(intercom, undefined, "bundled intercom entry should be absent after retirement");
});

test("bundled merge migrates legacy upstream and TLH subagents installs to the scoped npm source without duplicates", () => {
	const fixture = tempFixture();
	const bundledPath = bundledExtensionsPath;
	writeFileSync(fixture.settings, JSON.stringify({
		packages: [
			"git:github.com/nicobailon/pi-subagents@v0.31.0",
			"git:github.com/diegopetrucci/pi-subagents@tlh-v0.31.1",
		],
		tlh: { disabledDefaultExtensions: ["pi-subagents"] },
	}, null, 2));

	runNode(mergeScript, [
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", bundledPath,
		"--quiet",
	]);

	const settings = readJson(fixture.settings);
	assert.deepEqual(
		settings.packages.filter((entry) => packageIdentity(entry) === "npm:@diegopetrucci/pi-subagents"),
		[bundledSource("subagents")],
	);
	assert.equal(
		settings.packages.some((entry) => packageIdentity(entry) === "git:github.com/nicobailon/pi-subagents"),
		false,
	);
	assert.equal(
		settings.packages.some((entry) => packageIdentity(entry) === "git:github.com/diegopetrucci/pi-subagents"),
		false,
	);
	assert.deepEqual(
		(settings.tlh?.disabledDefaultExtensions ?? []).filter((value) => value === "subagents" || value === "pi-subagents"),
		[],
	);
});

test("bundled merge force-removes legacy TLH intercom git installs via the retirement list", () => {
	const fixture = tempFixture();
	const bundledPath = bundledExtensionsPath;
	writeFileSync(fixture.settings, JSON.stringify({
		packages: ["git:github.com/diegopetrucci/pi-intercom@tlh-v0.6.0-6"],
		tlh: { disabledDefaultExtensions: ["pi-intercom"] },
	}, null, 2));

	runNode(mergeScript, [
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", bundledPath,
		"--quiet",
	]);

	const settings = readJson(fixture.settings);
	// The legacy git install must be force-removed (not migrated to any npm source).
	assert.equal(
		settings.packages.some((entry) => packageIdentity(entry) === "git:github.com/diegopetrucci/pi-intercom"),
		false,
		"legacy git intercom install must be force-removed",
	);
	assert.equal(
		settings.packages.some((entry) => (typeof entry === "string" ? entry : entry.source).includes("pi-intercom")),
		false,
		"no pi-intercom source should remain after bundled merge",
	);
});

// ── fff retirement tests ─────────────────────────────────────────────────────

test("bundled manifest has no fff entry after retirement", () => {
	const fff = bundledExtensions.find(({ id }) => id === "fff");
	assert.equal(fff, undefined, "bundled fff entry should be absent after retirement");
});

test("bundled merge removes a TLH-managed fff package (provenance-gated, legacy profile)", () => {
	// A legacy profile with no provenance block: withLegacyRetiredDefaultPackageIdentities
	// treats any retired package present as managed and enqueues it for removal.
	const fixture = tempFixture();
	const bundledPath = bundledExtensionsPath;
	writeFileSync(fixture.settings, JSON.stringify({
		packages: [
			harnessPackage,
			"npm:@ff-labs/pi-fff@0.10.1",
			"npm:@diegopetrucci/pi-notify@0.1.14",
		],
	}, null, 2));

	const output = runNode(mergeScript, [
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", bundledPath,
	]);

	const settings = readJson(fixture.settings);
	assert.match(output, /Will remove retired TLH default package: npm:@ff-labs\/pi-fff/);
	assert.equal(
		settings.packages.some((entry) => packageIdentity(entry) === "npm:@ff-labs/pi-fff"),
		false,
		"TLH-managed fff package must be removed",
	);
	assert.equal(
		settings.packages.some((entry) => packageIdentity(entry) === "npm:@diegopetrucci/pi-notify"),
		true,
		"unrelated managed package must be preserved",
	);
});

test("bundled merge preserves a manually added fff package (provenance block exists, not managed)", () => {
	// A modern profile with a provenance block: withLegacyRetiredDefaultPackageIdentities
	// skips the legacy carry-over path. A fff package not listed in managedPackageIdentities
	// is treated as user-added and must be preserved.
	const fixture = tempFixture();
	const bundledPath = bundledExtensionsPath;
	writeFileSync(fixture.settings, JSON.stringify({
		packages: [
			harnessPackage,
			"npm:@ff-labs/pi-fff@0.10.1",
		],
		tlh: {
			defaultExtensionProvenance: {
				managedPackageIdentities: [], // provenance exists but fff is NOT managed
			},
		},
	}, null, 2));

	const output = runNode(mergeScript, [
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", bundledPath,
		"--quiet",
	]);

	const settings = readJson(fixture.settings);
	assert.equal(
		settings.packages.some((entry) => packageIdentity(entry) === "npm:@ff-labs/pi-fff"),
		true,
		"manually added fff package must be preserved",
	);
	assert.equal(output.includes("pi-fff"), false, "merge must not log any fff removal");
});

test("bundled merge prunes stale fff and pi-fff opt-outs from tlh.disabledDefaultExtensions", () => {
	const fixture = tempFixture();
	const bundledPath = bundledExtensionsPath;
	writeFileSync(fixture.settings, JSON.stringify({
		packages: [harnessPackage],
		tlh: { disabledDefaultExtensions: ["fff", "pi-fff", "notify"] },
	}, null, 2));

	const output = runNode(mergeScript, [
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", bundledPath,
	]);

	const settings = readJson(fixture.settings);
	assert.match(output, /remove stale fff opt-out from tlh\.disabledDefaultExtensions/);
	assert.equal(
		(settings.tlh?.disabledDefaultExtensions ?? []).some((v) => v === "fff" || v === "pi-fff"),
		false,
		"stale fff opt-outs must be removed",
	);
	assert.equal(
		(settings.tlh?.disabledDefaultExtensions ?? []).includes("notify"),
		true,
		"unrelated opt-out must be preserved",
	);
});

test("bundled manifest has no duplicate ids or alias conflicts", () => {
	// Note: runtime tool names registered by individual extensions are not statically introspectable
	// from this manifest (they are set at extension runtime). The runtime-side tool-name uniqueness
	// check lives in test/tool-name-uniqueness.test.mjs in the upstream fork.
	const bundled = bundledExtensions;

	const ids = bundled.map(({ id }) => id);
	assert.equal(new Set(ids).size, ids.length, "bundled manifest must not contain duplicate ids");

	// All ids plus all aliases must form a unique set so a new entry cannot accidentally alias an existing id.
	const allNames = [...ids, ...bundled.flatMap(({ aliases }) => aliases)];
	assert.equal(new Set(allNames).size, allNames.length, "bundled manifest ids and aliases must all be unique (no alias may shadow an existing id)");
});

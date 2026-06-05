import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { packageIdentity, readDefaultExtensions } from "../scripts/lib/default-extensions.mjs";
import { installableSupportFiles } from "../scripts/lib/tlh-install-support-manifest.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const mergeScript = join(repoRoot, "scripts", "merge-settings.mjs");
const defaultsScript = join(repoRoot, "scripts", "tlh-defaults.mjs");
const harnessPackage = "git:github.com/diegopetrucci/the-last-harness";
const retiredPlannotatorPackage = "npm:@plannotator/pi-extension";

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

test("bundled manifest keeps quiet-tools-compatible rtk load order", () => {
	const bundled = readDefaultExtensions(join(repoRoot, "config", "default-extensions.json"));
	const ids = bundled.map(({ id }) => id);
	const rtk = bundled.find(({ id }) => id === "rtk");
	const dirtyRepoGuard = bundled.find(({ id }) => id === "dirty-repo-guard");

	assert.ok(dirtyRepoGuard, "bundled dirty-repo-guard default should exist");
	assert.equal(dirtyRepoGuard.source, "npm:@diegopetrucci/pi-dirty-repo-guard");
	assert.equal(ids.includes("permission-gate"), false);
	assert.equal(ids.includes("confirm-destructive"), false);
	assert.ok(rtk, "bundled rtk default should exist");
	assert.deepEqual(rtk.aliases, ["pi-rtk"]);
	assert.deepEqual(rtk.replaces, [
		"npm:pi-rtk",
		"npm:@sherif-fanous/pi-rtk",
		"git:github.com/sherif-fanous/pi-rtk",
	]);
	assert.equal(rtk.migrateReplacements, true);
	assert.equal(rtk.critical, false);
	assert.equal(rtk.source, "git:github.com/diegopetrucci/pi-rtk@tlh-v0.6.0-5");
	assert(ids.indexOf("rtk") < ids.indexOf("quiet-tools"), "quiet-tools should load after rtk");
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

test("installed tlh-defaults helper can resolve its copied default-extension library", () => {
	const fixture = tempFixture();
	const supportDir = join(fixture.dir, "agent", "tlh");
	const copiedVariables = new Set([
		"TLH_DEFAULTS_SCRIPT",
		"TLH_INSTALL_PATHS_LIB",
		"TLH_INSTALL_UTILS_LIB",
		"DEFAULT_EXTENSIONS_LIB",
		"DEFAULT_EXTENSIONS_FILE",
	]);

	for (const file of installableSupportFiles().filter((entry) => copiedVariables.has(entry.variable))) {
		const target = join(supportDir, file.installName);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(join(repoRoot, file.relativePath), target);
	}
	writeFileSync(fixture.settings, JSON.stringify({ packages: [] }, null, 2));

	const result = spawnSync(process.execPath, [
		join(supportDir, "tlh-defaults.mjs"),
		"--settings", fixture.settings,
		"--defaults", join(supportDir, "default-extensions.json"),
		"sources",
	], {
		cwd: fixture.dir,
		env: process.env,
		encoding: "utf8",
	});

	assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
});

test("merge ignores and cleans stale/manual critical opt-outs while preserving non-critical opt-outs", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "subagents",
			aliases: ["pi-subagents"],
			replaces: ["git:github.com/upstream/pi-subagents"],
			migrateReplacements: true,
			critical: true,
			source: "git:github.com/tlh/pi-subagents@pinned",
		},
		{
			id: "intercom",
			replaces: ["npm:pi-intercom"],
			migrateReplacements: true,
			critical: true,
			source: "git:github.com/tlh/pi-intercom@pinned",
		},
		{
			id: "helper",
			source: "npm:helper",
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		packages: ["git:github.com/upstream/pi-subagents", "npm:pi-intercom", "npm:helper"],
		tlh: { disabledDefaultExtensions: ["intercom", "pi-subagents", "helper"] },
	}, null, 2));

	runNode(mergeScript, [
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", fixture.extensions,
		"--quiet",
	]);

	const settings = readJson(fixture.settings);
	assert(settings.packages.includes("git:github.com/tlh/pi-subagents@pinned"));
	assert(settings.packages.includes("git:github.com/tlh/pi-intercom@pinned"));
	assert(!settings.packages.includes("git:github.com/upstream/pi-subagents"));
	assert(!settings.packages.includes("npm:pi-intercom"));
	assert(!settings.packages.includes("npm:helper"));
	assert.deepEqual(settings.tlh.disabledDefaultExtensions, ["helper"]);
});

test("merge migrates non-critical pi-rtk replacements to the bundled TLH fork", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "rtk",
			aliases: ["pi-rtk"],
			replaces: ["npm:pi-rtk", "npm:@sherif-fanous/pi-rtk", "git:github.com/sherif-fanous/pi-rtk"],
			migrateReplacements: true,
			source: "git:github.com/diegopetrucci/pi-rtk@tlh-v0.6.0-5",
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		packages: ["npm:@sherif-fanous/pi-rtk"],
	}, null, 2));

	runNode(mergeScript, [
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", fixture.extensions,
		"--quiet",
	]);

	const settings = readJson(fixture.settings);
	assert(settings.packages.includes("git:github.com/diegopetrucci/pi-rtk@tlh-v0.6.0-5"));
	assert(!settings.packages.includes("npm:pi-rtk"));
	assert(!settings.packages.includes("npm:@sherif-fanous/pi-rtk"));
	assert(!settings.packages.includes("git:github.com/sherif-fanous/pi-rtk"));
});

test("merge reorders only targeted default extensions so unrelated defaults stay in place", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "oracle",
			source: "npm:@diegopetrucci/pi-oracle",
		},
		{
			id: "rtk",
			aliases: ["pi-rtk"],
			replaces: ["npm:pi-rtk", "npm:@sherif-fanous/pi-rtk", "git:github.com/sherif-fanous/pi-rtk"],
			migrateReplacements: true,
			source: "git:github.com/diegopetrucci/pi-rtk@tlh-v0.6.0-5",
		},
		{
			id: "quiet-tools",
			replaces: ["npm:@diegopetrucci/pi-compact-bash"],
			source: "npm:@diegopetrucci/pi-quiet-tools",
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		packages: [
			"npm:before",
			"npm:@diegopetrucci/pi-compact-bash",
			"npm:@diegopetrucci/pi-oracle",
			"npm:@sherif-fanous/pi-rtk",
			"npm:after",
		],
	}, null, 2));

	const output = runNode(mergeScript, [
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", fixture.extensions,
	]);

	assert.match(output, /reorder targeted default extension packages for load order: quiet-tools, rtk -> rtk, quiet-tools/);
	assert.deepEqual(readJson(fixture.settings).packages, [
		"npm:before",
		"git:github.com/diegopetrucci/pi-rtk@tlh-v0.6.0-5",
		"npm:@diegopetrucci/pi-oracle",
		"npm:after",
		"git:github.com/diegopetrucci/the-last-harness",
		"npm:@diegopetrucci/pi-compact-bash",
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

test("tlh-defaults enable repairs targeted default extension load order for rtk", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "oracle",
			source: "npm:@diegopetrucci/pi-oracle",
		},
		{
			id: "rtk",
			aliases: ["pi-rtk"],
			replaces: ["npm:pi-rtk", "npm:@sherif-fanous/pi-rtk", "git:github.com/sherif-fanous/pi-rtk"],
			migrateReplacements: true,
			source: "git:github.com/diegopetrucci/pi-rtk@tlh-v0.6.0-5",
		},
		{
			id: "quiet-tools",
			replaces: ["npm:@diegopetrucci/pi-compact-bash"],
			source: "npm:@diegopetrucci/pi-quiet-tools",
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		packages: [
			"npm:before",
			"npm:@diegopetrucci/pi-oracle",
			"git:github.com/diegopetrucci/pi-rtk@tlh-v0.6.0-5",
			"npm:@diegopetrucci/pi-compact-bash",
		],
	}, null, 2));

	runNode(defaultsScript, [
		"--settings", fixture.settings,
		"--defaults", fixture.extensions,
		"disable", "rtk",
	]);
	runNode(defaultsScript, [
		"--settings", fixture.settings,
		"--defaults", fixture.extensions,
		"enable", "rtk",
	]);

	const settings = readJson(fixture.settings);
	assert.deepEqual(settings.packages, [
		"npm:before",
		"npm:@diegopetrucci/pi-oracle",
		"git:github.com/diegopetrucci/pi-rtk@tlh-v0.6.0-5",
		"npm:@diegopetrucci/pi-compact-bash",
	]);
	assert.deepEqual(settings.tlh?.disabledDefaultExtensions ?? [], []);
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

test("tlh-defaults enable switches deferred pi-web-access replacements to the bundled TLH source", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.extensions, JSON.stringify([
		{
			id: "pi-web-access",
			replaces: ["npm:pi-web-access", "git:github.com/nicobailon/pi-web-access"],
			source: "git:github.com/diegopetrucci/pi-web-access@tlh-v0.10.7-1",
		},
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		packages: ["git:github.com/nicobailon/pi-web-access@v0.10.7"],
		tlh: { disabledDefaultExtensions: ["pi-web-access"] },
	}, null, 2));

	runNode(defaultsScript, [
		"--settings", fixture.settings,
		"--defaults", fixture.extensions,
		"enable", "pi-web-access",
	]);

	const settings = readJson(fixture.settings);
	assert.deepEqual(settings.packages, ["git:github.com/diegopetrucci/pi-web-access@tlh-v0.10.7-1"]);
	assert.deepEqual(settings.tlh.disabledDefaultExtensions, []);
	assert.deepEqual(settings.tlh.defaultExtensionProvenance.managedPackageIdentities, ["git:github.com/diegopetrucci/pi-web-access"]);
});

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

test("bundled manifest contains pi-web-access entry with correct tag and defer flags", () => {
	const bundled = readDefaultExtensions(join(repoRoot, "config", "default-extensions.json"));
	const webAccess = bundled.find(({ id }) => id === "pi-web-access");

	assert.ok(webAccess, "bundled pi-web-access entry should exist");
	assert.equal(webAccess.source, "git:github.com/diegopetrucci/pi-web-access@tlh-v0.10.7-1");
	assert.equal(webAccess.critical, false, "pi-web-access must not be critical");
	assert.deepEqual(webAccess.replaces, [
		"npm:pi-web-access",
		"git:github.com/nicobailon/pi-web-access",
	], "pi-web-access should defer to common upstream/manual installs");
	assert.equal(webAccess.migrateReplacements, false, "pi-web-access replacements must stay deferred by default");
	assert.deepEqual(webAccess.aliases, [], "pi-web-access must have no aliases");
});

test("bundled manifest contains mcporter entry and tlh-defaults accepts its aliases", () => {
	const bundledPath = join(repoRoot, "config", "default-extensions.json");
	const bundled = readDefaultExtensions(bundledPath);
	const mcporter = bundled.find(({ id }) => id === "mcporter");

	assert.ok(mcporter, "bundled mcporter entry should exist");
	assert.equal(mcporter.source, "npm:pi-mcp-adapter");
	assert.equal(mcporter.critical, false, "mcporter must not be critical");
	assert.deepEqual(mcporter.aliases, ["pi-mcp-adapter", "mcp-adapter"]);
	assert.deepEqual(mcporter.replaces, []);
	assert.equal(mcporter.migrateReplacements, false, "mcporter replacements must stay disabled by default");

	const fixture = tempFixture();
	writeFileSync(fixture.settings, JSON.stringify({ packages: ["npm:pi-mcp-adapter"] }, null, 2));

	runNode(defaultsScript, [
		"--settings", fixture.settings,
		"--defaults", bundledPath,
		"disable", "mcp-adapter",
	]);

	const settings = readJson(fixture.settings);
	assert.deepEqual(settings.tlh.disabledDefaultExtensions, ["mcporter"]);
	assert.deepEqual(settings.packages, []);
});

test("bundled manifest contains subagents and intercom entries with correct critical migration flags", () => {
	const bundled = readDefaultExtensions(join(repoRoot, "config", "default-extensions.json"));
	const subagents = bundled.find(({ id }) => id === "subagents");
	const intercom = bundled.find(({ id }) => id === "intercom");

	assert.ok(subagents, "bundled subagents entry should exist");
	assert.equal(subagents.source, "git:github.com/diegopetrucci/pi-subagents@tlh-v0.26.0-5");
	assert.equal(subagents.critical, true, "subagents must stay critical");
	assert.deepEqual(subagents.aliases, ["pi-subagents"]);
	assert.deepEqual(subagents.replaces, [
		"npm:pi-subagents",
		"git:github.com/nicobailon/pi-subagents",
	]);
	assert.equal(subagents.migrateReplacements, true, "subagents replacements must stay enabled");

	assert.ok(intercom, "bundled intercom entry should exist");
	assert.equal(intercom.source, "git:github.com/diegopetrucci/pi-intercom@tlh-v0.6.0-5");
	assert.equal(intercom.critical, true, "intercom must stay critical");
	assert.deepEqual(intercom.aliases, ["pi-intercom"]);
	assert.deepEqual(intercom.replaces, [
		"npm:pi-intercom",
		"git:github.com/nicobailon/pi-intercom",
	]);
	assert.equal(intercom.migrateReplacements, true, "intercom replacements must stay enabled");
});

test("bundled manifest contains intercom entry with correct tag and critical flags", () => {
	const bundled = readDefaultExtensions(join(repoRoot, "config", "default-extensions.json"));
	const intercom = bundled.find(({ id }) => id === "intercom");

	assert.ok(intercom, "bundled intercom entry should exist");
	assert.equal(intercom.source, "git:github.com/diegopetrucci/pi-intercom@tlh-v0.6.0-5");
	assert.equal(intercom.critical, true, "intercom must stay critical");
	assert.deepEqual(intercom.aliases, ["pi-intercom"]);
	assert.deepEqual(intercom.replaces, [
		"npm:pi-intercom",
		"git:github.com/nicobailon/pi-intercom",
	]);
	assert.equal(intercom.migrateReplacements, true, "intercom replacements must stay enabled");
});

test("bundled manifest has no duplicate ids or alias conflicts", () => {
	// Note: runtime tool names registered by individual extensions are not statically introspectable
	// from this manifest (they are set at extension runtime). The runtime-side tool-name uniqueness
	// check lives in test/tool-name-uniqueness.test.mjs in the upstream fork.
	const bundled = readDefaultExtensions(join(repoRoot, "config", "default-extensions.json"));

	const ids = bundled.map(({ id }) => id);
	assert.equal(new Set(ids).size, ids.length, "bundled manifest must not contain duplicate ids");

	// All ids plus all aliases must form a unique set so a new entry cannot accidentally alias an existing id.
	const allNames = [...ids, ...bundled.flatMap(({ aliases }) => aliases)];
	assert.equal(new Set(allNames).size, allNames.length, "bundled manifest ids and aliases must all be unique (no alias may shadow an existing id)");
});

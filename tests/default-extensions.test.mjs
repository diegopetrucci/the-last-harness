import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { packageIdentity, readDefaultExtensions } from "../scripts/lib/default-extensions.mjs";
import { installableSupportFiles } from "../scripts/lib/tlh-install-support-manifest.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const mergeScript = join(repoRoot, "scripts", "merge-settings.mjs");
const defaultsScript = join(repoRoot, "scripts", "tlh-defaults.mjs");

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

test("bundled manifest keeps rtk replacements and quiet-tools-compatible load order", () => {
	const bundled = readDefaultExtensions(join(repoRoot, "config", "default-extensions.json"));
	const ids = bundled.map(({ id }) => id);
	const rtk = bundled.find(({ id }) => id === "rtk");

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
	assert(ids.indexOf("permission-gate") < ids.indexOf("rtk"), "permission-gate should load before rtk");
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
			id: "permission-gate",
			source: "npm:@diegopetrucci/pi-permission-gate",
		},
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

	assert.match(output, /reorder targeted default extension packages for load order: quiet-tools, permission-gate, rtk -> permission-gate, rtk, quiet-tools/);
	assert.deepEqual(readJson(fixture.settings).packages, [
		"npm:before",
		"npm:@diegopetrucci/pi-permission-gate",
		"npm:@diegopetrucci/pi-oracle",
		"npm:after",
		"git:github.com/diegopetrucci/the-last-harness",
		"git:github.com/diegopetrucci/pi-rtk@tlh-v0.6.0-5",
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
			id: "permission-gate",
			source: "npm:@diegopetrucci/pi-permission-gate",
		},
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
			"npm:@diegopetrucci/pi-permission-gate",
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
		"npm:@diegopetrucci/pi-permission-gate",
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

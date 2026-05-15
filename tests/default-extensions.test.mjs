import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

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

test("merge migrates critical replacement defaults and removes disabled replacement aliases", () => {
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
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		packages: ["git:github.com/upstream/pi-subagents", "npm:pi-intercom"],
		tlh: { disabledDefaultExtensions: ["intercom"] },
	}, null, 2));

	runNode(mergeScript, [
		fixture.defaults,
		"--settings", fixture.settings,
		"--default-extensions", fixture.extensions,
		"--quiet",
	]);

	const settings = readJson(fixture.settings);
	assert(settings.packages.includes("git:github.com/tlh/pi-subagents@pinned"));
	assert(!settings.packages.includes("git:github.com/upstream/pi-subagents"));
	assert(!settings.packages.includes("npm:pi-intercom"));
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

test("tlh-defaults sources defers non-migrating replacements and critical-sources honors disabled defaults", () => {
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
	], null, 2));
	writeFileSync(fixture.settings, JSON.stringify({
		packages: ["npm:old-default", "git:github.com/tlh/critical@old-pin"],
		tlh: { disabledDefaultExtensions: ["critical-disabled"] },
	}, null, 2));

	const sources = runNode(defaultsScript, ["--settings", fixture.settings, "--defaults", fixture.extensions, "sources"])
		.trim()
		.split("\n")
		.filter(Boolean);
	assert.deepEqual(sources, ["git:github.com/tlh/critical@pin"]);

	const criticalSources = runNode(defaultsScript, ["--settings", fixture.settings, "--defaults", fixture.extensions, "critical-sources"])
		.trim()
		.split("\n")
		.filter(Boolean);
	assert.deepEqual(criticalSources, ["git:github.com/tlh/critical@pin"]);
});

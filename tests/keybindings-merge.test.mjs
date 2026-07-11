import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const mergeKeybindingsScript = join(repoRoot, "scripts", "merge-keybindings.mjs");
const keybindingDefaults = join(repoRoot, "config", "keybindings.defaults.json");

function tempFixture() {
	const agentDir = mkdtempSync(join(tmpdir(), "tlh-keybindings-test-"));
	const keybindings = join(agentDir, "keybindings.json");
	return { agentDir, keybindings };
}

function runMerge(args, agentDir) {
	return execFileSync(process.execPath, [mergeKeybindingsScript, ...args], {
		cwd: repoRoot,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, TLH_AGENT_DIR: agentDir },
		encoding: "utf8",
	});
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function backupFiles(agentDir) {
	return readdirSync(agentDir)
		.filter((name) => name.startsWith("keybindings.json.backup-"))
		.sort();
}

function symlinkFile(target, path) {
	if (process.platform === "win32") {
		symlinkSync(target, path, "file");
		return;
	}
	symlinkSync(target, path);
}

function spawnMerge(args, agentDir) {
	return spawnSync(process.execPath, [mergeKeybindingsScript, ...args], {
		cwd: repoRoot,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, TLH_AGENT_DIR: agentDir },
		encoding: "utf8",
	});
}

test("packaged keybinding defaults disable app.thinking.cycle", () => {
	assert.deepEqual(readJson(keybindingDefaults), { "app.thinking.cycle": [] });
});

test("merge sets missing defaults, preserves existing keys, and backs up existing keybindings", () => {
	const fixture = tempFixture();
	const original = { "app.open": ["ctrl+o"] };
	writeFileSync(fixture.keybindings, JSON.stringify(original, null, 2));

	const output = runMerge(["--quiet"], fixture.agentDir);

	assert.equal(output, "");
	assert.deepEqual(readJson(fixture.keybindings), {
		"app.open": ["ctrl+o"],
		"app.thinking.cycle": [],
	});
	const backups = backupFiles(fixture.agentDir);
	assert.equal(backups.length, 1);
	assert.deepEqual(readJson(join(fixture.agentDir, backups[0])), original);
});

test("merge preserves keybindings and backup file modes when rewriting keybindings", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.keybindings, JSON.stringify({ "app.open": ["ctrl+o"] }, null, 2));
	chmodSync(fixture.keybindings, 0o640);

	runMerge(["--quiet"], fixture.agentDir);

	assert.equal(lstatSync(fixture.keybindings).mode & 0o777, 0o640);
	const backups = backupFiles(fixture.agentDir);
	assert.equal(backups.length, 1);
	assert.equal(lstatSync(join(fixture.agentDir, backups[0])).mode & 0o777, 0o640);
});

test("merge rejects symlinked keybindings targets before creating backups", () => {
	const fixture = tempFixture();
	const externalDir = mkdtempSync(join(tmpdir(), "tlh-keybindings-symlink-target-"));
	const externalKeybindings = join(externalDir, "keybindings.json");
	writeFileSync(externalKeybindings, JSON.stringify({ "app.open": ["ctrl+o"] }, null, 2));
	symlinkFile(externalKeybindings, fixture.keybindings);

	const result = spawnSync(process.execPath, [mergeKeybindingsScript, "--quiet"], {
		cwd: repoRoot,
		env: { ...process.env, PI_CODING_AGENT_DIR: fixture.agentDir, TLH_AGENT_DIR: fixture.agentDir },
		encoding: "utf8",
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /symlinked Pi keybindings source/);
	assert.deepEqual(backupFiles(fixture.agentDir), []);
});

test("merge keeps a user-owned value for an existing default key", () => {
	const fixture = tempFixture();
	const original = { "app.thinking.cycle": ["shift+tab"] };
	writeFileSync(fixture.keybindings, JSON.stringify(original, null, 2));

	const output = runMerge(["--quiet"], fixture.agentDir);

	assert.equal(output, "");
	assert.deepEqual(readJson(fixture.keybindings), original);
	assert.deepEqual(backupFiles(fixture.agentDir), []);
});

test("merge treats legacy cycleThinkingLevel as user-owned app.thinking.cycle", () => {
	const fixture = tempFixture();
	const original = { cycleThinkingLevel: ["ctrl+shift+t"] };
	writeFileSync(fixture.keybindings, JSON.stringify(original, null, 2));

	const output = runMerge(["--quiet"], fixture.agentDir);

	assert.equal(output, "");
	assert.deepEqual(readJson(fixture.keybindings), original);
	assert.deepEqual(backupFiles(fixture.agentDir), []);
});

test("dry-run reports changes without writing keybindings", () => {
	const fixture = tempFixture();

	const output = runMerge(["--dry-run"], fixture.agentDir);

	assert.match(output, /Would set app\.thinking\.cycle/);
	assert.match(output, /Dry run only/);
	assert.equal(existsSync(fixture.keybindings), false);
});

// ---------------------------------------------------------------------------
// Multiple custom defaults: mixed user-owned and missing keys
// ---------------------------------------------------------------------------

test("merge with multiple custom defaults preserves user-owned keys and adds missing ones", () => {
	const fixture = tempFixture();
	const defaultsDir = mkdtempSync(join(tmpdir(), "tlh-keybindings-defaults-"));
	const customDefaultsPath = join(defaultsDir, "keybindings.defaults.json");
	const customDefaults = {
		"app.foo": ["ctrl+f"],
		"app.bar": ["ctrl+b"],
		"app.baz": ["ctrl+z"],
	};
	writeFileSync(customDefaultsPath, JSON.stringify(customDefaults, null, 2));

	// Existing: user owns app.foo with a different value, plus an unrelated key
	const original = { "app.foo": ["ctrl+custom"], "app.extra": ["ctrl+e"] };
	writeFileSync(fixture.keybindings, JSON.stringify(original, null, 2));

	runMerge(["--quiet", "--defaults", customDefaultsPath], fixture.agentDir);

	const result = readJson(fixture.keybindings);
	// User-owned value is preserved
	assert.deepEqual(result["app.foo"], ["ctrl+custom"]);
	// Unrelated key is preserved
	assert.deepEqual(result["app.extra"], ["ctrl+e"]);
	// Missing defaults are added with default values
	assert.deepEqual(result["app.bar"], ["ctrl+b"]);
	assert.deepEqual(result["app.baz"], ["ctrl+z"]);
	// Exactly one backup because the file was rewritten
	const backups = backupFiles(fixture.agentDir);
	assert.equal(backups.length, 1);
	assert.deepEqual(readJson(join(fixture.agentDir, backups[0])), original);
});

// ---------------------------------------------------------------------------
// Malformed / partial input
// ---------------------------------------------------------------------------

test("merge fails with non-zero exit on invalid JSON in keybindings file", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.keybindings, "NOT VALID JSON {{{");

	const result = spawnMerge(["--quiet"], fixture.agentDir);

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /merge-keybindings:/);
	// No backup created
	assert.deepEqual(backupFiles(fixture.agentDir), []);
	// File is unchanged
	assert.equal(readFileSync(fixture.keybindings, "utf8"), "NOT VALID JSON {{{");
});

test("merge fails with clear error when keybindings file contains a JSON array", () => {
	const fixture = tempFixture();
	writeFileSync(fixture.keybindings, JSON.stringify([{ "app.thinking.cycle": [] }]));

	const result = spawnMerge(["--quiet"], fixture.agentDir);

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Existing keybindings must be a JSON object/);
	assert.deepEqual(backupFiles(fixture.agentDir), []);
});

test("merge fails with clear error when defaults file is not a JSON object", () => {
	const fixture = tempFixture();
	const defaultsDir = mkdtempSync(join(tmpdir(), "tlh-keybindings-defaults-"));
	const badDefaultsPath = join(defaultsDir, "bad-defaults.json");
	writeFileSync(badDefaultsPath, "42");

	const result = spawnMerge(["--quiet", "--defaults", badDefaultsPath], fixture.agentDir);

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Default keybindings must be a JSON object/);
	assert.deepEqual(backupFiles(fixture.agentDir), []);
});

// ---------------------------------------------------------------------------
// Backup-on-rewrite behavior
// ---------------------------------------------------------------------------

test("no backup when all custom defaults are already present in keybindings", () => {
	const fixture = tempFixture();
	const defaultsDir = mkdtempSync(join(tmpdir(), "tlh-keybindings-defaults-"));
	const customDefaultsPath = join(defaultsDir, "keybindings.defaults.json");
	const customDefaults = { "app.foo": ["ctrl+f"], "app.bar": ["ctrl+b"] };
	writeFileSync(customDefaultsPath, JSON.stringify(customDefaults, null, 2));

	// File already has all defaults (with user-chosen values)
	const existing = { "app.foo": ["ctrl+custom-f"], "app.bar": ["ctrl+custom-b"] };
	writeFileSync(fixture.keybindings, JSON.stringify(existing, null, 2));

	runMerge(["--quiet", "--defaults", customDefaultsPath], fixture.agentDir);

	assert.deepEqual(backupFiles(fixture.agentDir), []);
	// File content unchanged
	assert.deepEqual(readJson(fixture.keybindings), existing);
});

test("dry-run creates no backup even when changes are pending and the keybindings file exists", () => {
	const fixture = tempFixture();
	const defaultsDir = mkdtempSync(join(tmpdir(), "tlh-keybindings-defaults-"));
	const customDefaultsPath = join(defaultsDir, "keybindings.defaults.json");
	const customDefaults = { "app.newkey": ["ctrl+n"] };
	writeFileSync(customDefaultsPath, JSON.stringify(customDefaults, null, 2));

	// Existing file is missing the new default
	const original = { "app.existing": ["ctrl+e"] };
	writeFileSync(fixture.keybindings, JSON.stringify(original, null, 2));

	const output = runMerge(["--dry-run", "--defaults", customDefaultsPath], fixture.agentDir);

	assert.match(output, /Would set app\.newkey/);
	assert.deepEqual(backupFiles(fixture.agentDir), []);
	// Original file is unchanged
	assert.deepEqual(readJson(fixture.keybindings), original);
});

test("exactly one backup is created when an existing keybindings file is rewritten with changes", () => {
	const fixture = tempFixture();
	const defaultsDir = mkdtempSync(join(tmpdir(), "tlh-keybindings-defaults-"));
	const customDefaultsPath = join(defaultsDir, "keybindings.defaults.json");
	const customDefaults = { "app.alpha": ["ctrl+a"], "app.beta": ["ctrl+b"] };
	writeFileSync(customDefaultsPath, JSON.stringify(customDefaults, null, 2));

	// Existing file has neither default
	const original = { "app.unrelated": ["ctrl+u"] };
	writeFileSync(fixture.keybindings, JSON.stringify(original, null, 2));

	runMerge(["--quiet", "--defaults", customDefaultsPath], fixture.agentDir);

	const backups = backupFiles(fixture.agentDir);
	assert.equal(backups.length, 1);
	assert.deepEqual(readJson(join(fixture.agentDir, backups[0])), original);
});

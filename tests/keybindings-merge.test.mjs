import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

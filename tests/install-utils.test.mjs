import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	assertNotInNormalPiConfig,
	assignRequiredEqualsValue,
	backupPathWithTimestamp,
	backupTimestampSuffix,
	pathIsInNormalPiConfig,
	readJsonFile,
	renderShellWords,
	requiredValue,
	shellQuote,
	shellWord,
} from "../scripts/lib/tlh-install-utils.mjs";

function tempFixture(t, prefix = "tlh-install-utils-test-") {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("required CLI value helpers preserve installer option errors", () => {
	assert.equal(requiredValue(["value"], 0, "--flag"), "value");
	assert.throws(() => requiredValue([], 0, "--flag"), /--flag requires a value/);
	assert.throws(() => requiredValue(["--next"], 0, "--flag"), /--flag requires a value/);

	const target = {};
	assignRequiredEqualsValue(target, "key", "value", "--flag");
	assert.deepEqual(target, { key: "value" });
	assert.throws(() => assignRequiredEqualsValue(target, "key", "", "--flag"), /--flag requires a value/);
});

test("readJsonFile handles BOM, empty files, missing fallbacks, and parse errors", (t) => {
	const root = tempFixture(t);
	const bomJson = join(root, "bom.json");
	const emptyJson = join(root, "empty.json");
	const invalidJson = join(root, "invalid.json");

	writeFileSync(bomJson, "\uFEFF{\"ok\":true}\n");
	writeFileSync(emptyJson, "  \n\t");
	writeFileSync(invalidJson, "{");

	assert.deepEqual(readJsonFile(bomJson), { ok: true });
	assert.deepEqual(readJsonFile(emptyJson), {});
	assert.deepEqual(readJsonFile(join(root, "missing.json"), { missingValue: { missing: true } }), { missing: true });
	assert.throws(() => readJsonFile(join(root, "missing.json")), /File does not exist:/);
	assert.throws(() => readJsonFile(invalidJson), /Invalid JSON in .*invalid\.json:/);
});

test("shell word rendering quotes only unsafe words", () => {
	assert.equal(shellQuote("can't"), "'can'\\''t'");
	assert.equal(shellWord("git:github.com/owner/repo@main"), "git:github.com/owner/repo@main");
	assert.equal(shellWord("two words"), "'two words'");
	assert.equal(renderShellWords(["env", "A=one two", "cmd"]), "env 'A=one two' cmd");
});

test("backup timestamp helpers render existing suffix formats", () => {
	const date = new Date("2026-05-20T21:22:23.456Z");
	assert.equal(backupTimestampSuffix(date), "2026-05-20T21-22-23-456Z");
	assert.equal(backupTimestampSuffix(date, { includeMilliseconds: false }), "2026-05-20T21-22-23Z");
	assert.equal(backupPathWithTimestamp("settings.json", { date }), "settings.json.backup-2026-05-20T21-22-23-456Z");
	assert.equal(
		backupPathWithTimestamp("settings.json", { marker: "before-install", date, includeMilliseconds: false }),
		"settings.json.backup-before-install-2026-05-20T21-22-23Z",
	);
});

test("normal Pi config helpers guard paths under only the normal ~/.pi root", (t) => {
	const root = tempFixture(t);
	const homeDir = join(root, "home");
	mkdirSync(homeDir, { recursive: true });

	assert.equal(pathIsInNormalPiConfig(join(homeDir, ".pi", "agent", "settings.json"), { homeDir }), true);
	assert.equal(pathIsInNormalPiConfig(join(homeDir, ".pi-other", "agent"), { homeDir }), false);
	assert.throws(
		() => assertNotInNormalPiConfig(
			join(homeDir, ".pi", "agent", "settings.json"),
			(path) => `Refusing test path: ${path}`,
			{ homeDir },
		),
		/Refusing test path:/,
	);
});

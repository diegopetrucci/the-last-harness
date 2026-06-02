import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	assertNotInNormalPiConfig,
	assignOptionValue,
	assignRequiredEqualsValue,
	backupPathWithTimestamp,
	backupTimestampSuffix,
	defaultTlhAgentDir,
	defaultTlhBinDir,
	defaultTlhKeybindingsPath,
	defaultTlhSettingsPath,
	expandHomePath,
	pathIsInNormalPiConfig,
	readJsonFile,
	readOptionValue,
	renderShellWords,
	requiredValue,
	resolveTlhAgentDir,
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

test("shared CLI option helpers parse split, equals, alias, and default path values", () => {
	assert.deepEqual(readOptionValue(["--flag", "value"], 0, "--flag"), {
		flag: "--flag",
		value: "value",
		nextIndex: 1,
	});
	assert.deepEqual(readOptionValue(["--flag=value"], 0, "--flag"), {
		flag: "--flag",
		value: "value",
		nextIndex: 0,
	});
	assert.deepEqual(readOptionValue(["--defaults=manifest.json"], 0, ["--defaults", "--default-extensions"]), {
		flag: "--defaults",
		value: "manifest.json",
		nextIndex: 0,
	});
	assert.throws(() => readOptionValue(["--flag="], 0, "--flag", { requireEqualsValue: true }), /--flag requires a value/);

	const args = {};
	assert.equal(assignOptionValue(args, "path", ["--path", "~/value"], 0, "--path"), 1);
	assert.deepEqual(args, { path: "~/value" });

	assert.equal(expandHomePath("~/agent", { homeDir: "/tmp/home" }), "/tmp/home/agent");
	assert.equal(defaultTlhAgentDir({ PI_CODING_AGENT_DIR: "~/pi-agent", TLH_AGENT_DIR: "~/tlh-agent" }, { homeDir: "/tmp/home" }), "/tmp/home/pi-agent");
	assert.equal(defaultTlhAgentDir({ PI_CODING_AGENT_DIR: "~/pi-agent", TLH_AGENT_DIR: "~/tlh-agent" }, { homeDir: "/tmp/home", preferTlhAgentDir: true }), "/tmp/home/tlh-agent");
	assert.equal(resolveTlhAgentDir("~/custom-agent", { homeDir: "/tmp/home" }), "/tmp/home/custom-agent");
	assert.equal(defaultTlhSettingsPath({ env: { TLH_AGENT_DIR: "~/tlh-agent" }, homeDir: "/tmp/home" }), "/tmp/home/tlh-agent/settings.json");
	assert.equal(defaultTlhKeybindingsPath({ env: { PI_CODING_AGENT_DIR: "~/pi-agent" }, homeDir: "/tmp/home" }), "/tmp/home/pi-agent/keybindings.json");
	assert.equal(defaultTlhBinDir({ TLH_BIN_DIR: "~/bin" }, { homeDir: "/tmp/home" }), "/tmp/home/bin");
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

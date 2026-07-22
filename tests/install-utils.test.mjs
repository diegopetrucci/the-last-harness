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
	isTlhOwnedBackupFilename,
	parseBackupTimestamp,
	pathIsInNormalPiConfig,
	readJsonFile,
	readOptionValue,
	renderShellWords,
	requiredValue,
	resolveTlhAgentDir,
	selectExpiredBackups,
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

test("parseBackupTimestamp: parses all four backup filename variants", () => {
	// No marker, with milliseconds
	assert.deepEqual(
		parseBackupTimestamp("settings.json.backup-2026-07-11T17-01-16-155Z"),
		new Date("2026-07-11T17:01:16.155Z"),
	);

	// Marker (before-install), no milliseconds
	assert.deepEqual(
		parseBackupTimestamp("settings.json.backup-before-install-2026-07-10T20-58-04Z"),
		new Date("2026-07-10T20:58:04Z"),
	);

	// Marker (tlh-defaults), with milliseconds
	assert.deepEqual(
		parseBackupTimestamp("settings.json.backup-tlh-defaults-2026-07-10T09-42-45-504Z"),
		new Date("2026-07-10T09:42:45.504Z"),
	);

	// Marker (tlh-tickets), with milliseconds
	assert.deepEqual(
		parseBackupTimestamp("settings.json.backup-tlh-tickets-2026-07-10T09-42-45-504Z"),
		new Date("2026-07-10T09:42:45.504Z"),
	);

	// keybindings variant
	assert.deepEqual(
		parseBackupTimestamp("keybindings.json.backup-2026-07-10T09-42-45-504Z"),
		new Date("2026-07-10T09:42:45.504Z"),
	);
});

test("parseBackupTimestamp: returns undefined for unrecognised filenames", () => {
	assert.equal(parseBackupTimestamp("settings.json"), undefined);
	assert.equal(parseBackupTimestamp("settings.json.bak"), undefined);
	assert.equal(parseBackupTimestamp(""), undefined);
	assert.equal(parseBackupTimestamp("settings.json.backup-notadate"), undefined);
	assert.equal(parseBackupTimestamp("settings.json.backup-"), undefined);
});

test("selectExpiredBackups: empty input returns empty array", () => {
	assert.deepEqual(selectExpiredBackups([]), []);
});

test("selectExpiredBackups: always retains the newest keepNewest files even if all are old", () => {
	const now = new Date("2026-08-01T00:00:00Z");
	// All three are 60 days old — all beyond maxAgeMs (28 days default)
	const candidates = [
		"settings.json.backup-2026-06-01T00-00-00Z",
		"settings.json.backup-2026-06-02T00-00-00Z",
		"settings.json.backup-2026-06-03T00-00-00Z",
	];
	const result = selectExpiredBackups(candidates, { now });
	// keepNewest=2 by default → only the oldest one is eligible
	assert.deepEqual(result, ["settings.json.backup-2026-06-01T00-00-00Z"]);
});

test("selectExpiredBackups: only selects backups strictly older than maxAgeMs", () => {
	const now = new Date("2026-08-01T00:00:00Z");
	const msPerDay = 24 * 60 * 60 * 1000;
	const maxAgeMs = 28 * msPerDay;

	// Exactly 28 days old — NOT strictly older, must not be selected
	const exactEdge = new Date(now.getTime() - maxAgeMs).toISOString()
		.replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
	const edgeFile = `settings.json.backup-${exactEdge}`;

	// 29 days old — strictly older, eligible
	const staleDate = new Date(now.getTime() - 29 * msPerDay).toISOString()
		.replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
	const staleFile = `settings.json.backup-${staleDate}`;

	// 1 day old — not stale
	const freshDate = new Date(now.getTime() - 1 * msPerDay).toISOString()
		.replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
	const freshFile = `settings.json.backup-${freshDate}`;

	const result = selectExpiredBackups([edgeFile, staleFile, freshFile], { now, keepNewest: 1 });
	// freshFile is keepNewest=1 → retained; edgeFile is exactly 28d → retained; staleFile → deleted
	assert.deepEqual(result, [staleFile]);
});

test("selectExpiredBackups: falls back to mtimeFallback when filename timestamp is unparseable", () => {
	const now = new Date("2026-08-01T00:00:00Z");
	const msPerDay = 24 * 60 * 60 * 1000;

	const oldMtime = now.getTime() - 40 * msPerDay; // 40 days ago
	const newMtime = now.getTime() - 1 * msPerDay;  // 1 day ago

	const unknownOld = "settings.json.bak-old";
	const unknownNew = "settings.json.bak-new";

	const mtimeFallback = (f) => {
		if (f === unknownOld) return oldMtime;
		if (f === unknownNew) return newMtime;
		return undefined;
	};

	// keepNewest=1 → retain unknownNew; unknownOld is 40d old → eligible
	const result = selectExpiredBackups([unknownOld, unknownNew], { now, keepNewest: 1, mtimeFallback });
	assert.deepEqual(result, [unknownOld]);
});

test("selectExpiredBackups: unparseable file with no mtime fallback is treated as age 0 (retained)", () => {
	const now = new Date("2026-08-01T00:00:00Z");
	const msPerDay = 24 * 60 * 60 * 1000;

	const staleDate = new Date(now.getTime() - 40 * msPerDay).toISOString()
		.replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
	const staleFile = `settings.json.backup-${staleDate}`;
	const unknownFile = "settings.json.bak-unknown";

	// keepNewest=0 (no floor) so stale file is eligible; unknownFile has age 0 → not selected
	const result = selectExpiredBackups([staleFile, unknownFile], { now, keepNewest: 0 });
	assert.deepEqual(result, [staleFile]);
});

test("selectExpiredBackups: mixed parseable and unparseable filenames, all fresh → none selected", () => {
	const now = new Date("2026-08-01T00:00:00Z");
	const msPerDay = 24 * 60 * 60 * 1000;

	const freshDate = new Date(now.getTime() - 5 * msPerDay).toISOString()
		.replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
	const freshFile = `settings.json.backup-${freshDate}`;
	const unknownFile = "settings.json.bak-unknown";

	assert.deepEqual(selectExpiredBackups([freshFile, unknownFile], { now }), []);
});

test("isTlhOwnedBackupFilename: accepts all four known TLH marker forms", () => {
	// Empty marker (no milliseconds)
	assert.equal(isTlhOwnedBackupFilename("settings.json.backup-2026-07-11T17-01-16Z", "settings.json"), true);
	// Empty marker (with milliseconds)
	assert.equal(isTlhOwnedBackupFilename("settings.json.backup-2026-07-11T17-01-16-155Z", "settings.json"), true);
	// before-install marker
	assert.equal(isTlhOwnedBackupFilename("settings.json.backup-before-install-2026-07-10T20-58-04Z", "settings.json"), true);
	// tlh-defaults marker
	assert.equal(isTlhOwnedBackupFilename("settings.json.backup-tlh-defaults-2026-07-10T09-42-45-504Z", "settings.json"), true);
	// tlh-tickets marker
	assert.equal(isTlhOwnedBackupFilename("settings.json.backup-tlh-tickets-2026-07-10T09-42-45-504Z", "settings.json"), true);
	// keybindings base name
	assert.equal(isTlhOwnedBackupFilename("keybindings.json.backup-2026-07-11T17-01-16-155Z", "keybindings.json"), true);
});

test("isTlhOwnedBackupFilename: rejects unknown marker even with a parseable trailing timestamp", () => {
	// Core regression case: unknown marker "my-personal-copy" + valid timestamp
	assert.equal(
		isTlhOwnedBackupFilename("settings.json.backup-my-personal-copy-2026-07-11T17-01-16-155Z", "settings.json"),
		false,
		"unknown marker with valid timestamp must be rejected",
	);
	// Another unknown marker
	assert.equal(isTlhOwnedBackupFilename("settings.json.backup-work-project-2026-07-11T17-01-16Z", "settings.json"), false);
});

test("isTlhOwnedBackupFilename: rejects filenames with no timestamp or wrong base", () => {
	assert.equal(isTlhOwnedBackupFilename("settings.json.backup-mynotes", "settings.json"), false);
	assert.equal(isTlhOwnedBackupFilename("settings.json", "settings.json"), false);
	assert.equal(isTlhOwnedBackupFilename("settings.json.backup-2026-07-11T17-01-16-155Z", "keybindings.json"), false);
	assert.equal(isTlhOwnedBackupFilename("", "settings.json"), false);
});

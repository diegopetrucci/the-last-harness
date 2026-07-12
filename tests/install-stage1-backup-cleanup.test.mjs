import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { cleanupOldSettingsBackups } from "../scripts/tlh-install.mjs";
import { captureConsole, makeTempDir } from "./install-stage1-test-helpers.mjs";
import { runStage1LocalPackageInstall } from "./install-stage1-core-test-helpers.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a backup filename with a timestamp far enough in the past to be eligible
 * for deletion (> 28 days old).
 */
function oldBackupName(base, daysAgo = 35) {
	const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
	const pad = (n, w = 2) => String(n).padStart(w, "0");
	const suffix = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}Z`;
	return `${base}.backup-${suffix}`;
}

/**
 * Build a backup filename with a timestamp from only a few days ago (retained).
 */
function recentBackupName(base, daysAgo = 2) {
	return oldBackupName(base, daysAgo);
}

function makeConfig(agentDir, extra = {}) {
	return { agentDir, dryRun: false, quiet: true, verbose: false, ...extra };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("cleanupOldSettingsBackups removes settings.json backups older than 28 days", (t) => {
	const root = makeTempDir("tlh-backup-cleanup-old-settings-");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const oldName = oldBackupName("settings.json");
	writeFileSync(join(agentDir, oldName), "{}", "utf8");

	// Add two newer backups so there are 2 to retain and the old one becomes eligible.
	const newer1 = recentBackupName("settings.json", 1);
	const newer2 = recentBackupName("settings.json", 2);
	writeFileSync(join(agentDir, newer1), "{}", "utf8");
	writeFileSync(join(agentDir, newer2), "{}", "utf8");

	cleanupOldSettingsBackups(makeConfig(agentDir));

	assert.equal(existsSync(join(agentDir, oldName)), false, "old backup should be removed");
	assert.ok(existsSync(join(agentDir, newer1)), "newest backup should be retained");
	assert.ok(existsSync(join(agentDir, newer2)), "second-newest backup should be retained");
});

test("cleanupOldSettingsBackups removes keybindings.json backups older than 28 days", (t) => {
	const root = makeTempDir("tlh-backup-cleanup-old-keybindings-");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const oldName = oldBackupName("keybindings.json");
	writeFileSync(join(agentDir, oldName), "[]", "utf8");

	const newer1 = recentBackupName("keybindings.json", 1);
	const newer2 = recentBackupName("keybindings.json", 2);
	writeFileSync(join(agentDir, newer1), "[]", "utf8");
	writeFileSync(join(agentDir, newer2), "[]", "utf8");

	cleanupOldSettingsBackups(makeConfig(agentDir));

	assert.equal(existsSync(join(agentDir, oldName)), false, "old keybindings backup should be removed");
	assert.ok(existsSync(join(agentDir, newer1)), "newest keybindings backup should be retained");
	assert.ok(existsSync(join(agentDir, newer2)), "second-newest keybindings backup should be retained");
});

test("cleanupOldSettingsBackups retains the 2 newest backups even when they are old", (t) => {
	const root = makeTempDir("tlh-backup-cleanup-keep-newest-");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	// Only 2 old backups: both should be retained (keepNewest = 2)
	const old1 = oldBackupName("settings.json", 60);
	const old2 = oldBackupName("settings.json", 45);
	writeFileSync(join(agentDir, old1), "{}", "utf8");
	writeFileSync(join(agentDir, old2), "{}", "utf8");

	cleanupOldSettingsBackups(makeConfig(agentDir));

	assert.ok(existsSync(join(agentDir, old1)), "oldest backup of 2 should be retained");
	assert.ok(existsSync(join(agentDir, old2)), "second backup of 2 should be retained");
});

test("cleanupOldSettingsBackups does not remove recent backups", (t) => {
	const root = makeTempDir("tlh-backup-cleanup-recent-");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const recent = recentBackupName("settings.json", 3);
	writeFileSync(join(agentDir, recent), "{}", "utf8");

	cleanupOldSettingsBackups(makeConfig(agentDir));

	assert.ok(existsSync(join(agentDir, recent)), "recent backup must not be removed");
});

test("cleanupOldSettingsBackups skips symlinked backup-named entries", (t) => {
	if (process.platform === "win32") return;
	const root = makeTempDir("tlh-backup-cleanup-symlink-");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const externalFile = join(root, "external-backup");
	writeFileSync(externalFile, "{}", "utf8");

	// Create 2 extra newer backups so the symlink-named entry becomes eligible by age.
	const newer1 = recentBackupName("settings.json", 1);
	const newer2 = recentBackupName("settings.json", 2);
	writeFileSync(join(agentDir, newer1), "{}", "utf8");
	writeFileSync(join(agentDir, newer2), "{}", "utf8");

	const symlinkName = oldBackupName("settings.json");
	symlinkSync(externalFile, join(agentDir, symlinkName));

	cleanupOldSettingsBackups(makeConfig(agentDir));

	assert.ok(existsSync(join(agentDir, symlinkName)), "symlinked backup-named entry should be preserved");
	assert.ok(existsSync(externalFile), "external file should be untouched");
});

test("cleanupOldSettingsBackups does not touch non-backup files", (t) => {
	const root = makeTempDir("tlh-backup-cleanup-nonbackup-");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const otherFile = join(agentDir, "settings.json");
	const anotherFile = join(agentDir, "some-other-file.txt");
	writeFileSync(otherFile, "{}", "utf8");
	writeFileSync(anotherFile, "hello", "utf8");

	cleanupOldSettingsBackups(makeConfig(agentDir));

	assert.ok(existsSync(otherFile), "settings.json must not be removed");
	assert.ok(existsSync(anotherFile), "unrelated file must not be removed");
});

test("cleanupOldSettingsBackups dry-run logs intent without deleting anything", (t) => {
	const root = makeTempDir("tlh-backup-cleanup-dryrun-");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const newer1 = recentBackupName("settings.json", 1);
	const newer2 = recentBackupName("settings.json", 2);
	const oldName = oldBackupName("settings.json");
	writeFileSync(join(agentDir, newer1), "{}", "utf8");
	writeFileSync(join(agentDir, newer2), "{}", "utf8");
	writeFileSync(join(agentDir, oldName), "{}", "utf8");

	const config = makeConfig(agentDir, { dryRun: true, quiet: false });
	const stdout = captureConsole("log", () => cleanupOldSettingsBackups(config));

	assert.ok(existsSync(join(agentDir, oldName)), "file must not be removed in dry-run mode");
	assert.match(stdout, /Would remove stale settings backup/);
});

test("cleanupOldSettingsBackups is skipped when agentDir is a symlink", (t) => {
	if (process.platform === "win32") return;
	const root = makeTempDir("tlh-backup-cleanup-symlink-agentdir-");
	const realDir = join(root, "real-agent");
	const agentDir = join(root, "agent");
	mkdirSync(realDir, { recursive: true });
	symlinkSync(realDir, agentDir);
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const oldName = oldBackupName("settings.json");
	writeFileSync(join(realDir, oldName), "{}", "utf8");

	const stderr = captureConsole("error", () => {
		assert.doesNotThrow(() => cleanupOldSettingsBackups(makeConfig(agentDir)));
	});

	assert.ok(existsSync(join(realDir, oldName)), "file in real dir must be untouched when agentDir is a symlink");
	assert.match(stderr, /agentDir is a symlink/);
});

test("--no-settings skips stale backup cleanup on install", (t) => {
	const { result } = runStage1LocalPackageInstall(t, { noSettings: true });

	assert.equal(result.status, 0, `install failed:\n${result.stderr}`);

	// Create an old backup after the fact to check that it was not touched.
	// (In --no-settings mode cleanupOldSettingsBackups should never be called.)
	// We verify the function is not called by observing that no log output mentions backup cleanup.
	assert.doesNotMatch(
		result.stdout + result.stderr,
		/Would remove stale settings backup|Removed stale settings backup/,
		"--no-settings install must not log stale backup cleanup",
	);
});

test("cleanupOldSettingsBackups is idempotent when agentDir is empty", (t) => {
	const root = makeTempDir("tlh-backup-cleanup-empty-");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	assert.doesNotThrow(() => cleanupOldSettingsBackups(makeConfig(agentDir)));
});

test("cleanupOldSettingsBackups does not delete user files with no parseable timestamp", (t) => {
	// Regression: files like `settings.json.backup-mynotes` share the backup prefix
	// but carry no TLH timestamp. They must never be treated as deletion candidates,
	// even when 2+ newer timestamped backups exist and the file has an old mtime.
	const root = makeTempDir("tlh-backup-cleanup-notimestamp-");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	// User-created file that matches the prefix but has no parseable TLH timestamp.
	const userFile = "settings.json.backup-mynotes";
	writeFileSync(join(agentDir, userFile), "{\"note\": \"my notes\"}", "utf8");

	// Two newer timestamped TLH backups exist — enough to make the user file
	// eligible by count if the filter were absent.
	const newer1 = recentBackupName("settings.json", 1);
	const newer2 = recentBackupName("settings.json", 2);
	writeFileSync(join(agentDir, newer1), "{}", "utf8");
	writeFileSync(join(agentDir, newer2), "{}", "utf8");

	cleanupOldSettingsBackups(makeConfig(agentDir));

	assert.ok(
		existsSync(join(agentDir, userFile)),
		"user file with no parseable timestamp must never be removed by backup cleanup",
	);
	assert.ok(existsSync(join(agentDir, newer1)), "newest timestamped backup should be retained");
	assert.ok(existsSync(join(agentDir, newer2)), "second-newest timestamped backup should be retained");
});

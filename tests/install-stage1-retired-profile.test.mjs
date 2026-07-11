import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { RETIRED_PROFILE_FILES, cleanupRetiredProfileFiles } from "../scripts/tlh-install.mjs";
import { captureConsole, makeTempDir } from "./install-stage1-test-helpers.mjs";

test("RETIRED_PROFILE_FILES includes extensions/librarian.json", () => {
	assert.ok(
		RETIRED_PROFILE_FILES.includes("extensions/librarian.json"),
		"RETIRED_PROFILE_FILES must include extensions/librarian.json",
	);
});

test("cleanupRetiredProfileFiles removes extensions/librarian.json when present as a regular file", (t) => {
	const root = makeTempDir("tlh-cleanup-retired-present-");
	const agentDir = join(root, "agent");
	const extensionsDir = join(agentDir, "extensions");
	const librarianJson = join(extensionsDir, "librarian.json");
	mkdirSync(extensionsDir, { recursive: true });
	writeFileSync(librarianJson, JSON.stringify({ version: "1.0.0" }), "utf8");
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const config = { agentDir, dryRun: false, quiet: true, verbose: false };
	cleanupRetiredProfileFiles(config);

	assert.equal(existsSync(librarianJson), false, "extensions/librarian.json should be removed");
});

test("cleanupRetiredProfileFiles is idempotent when extensions/librarian.json is absent", (t) => {
	const root = makeTempDir("tlh-cleanup-retired-absent-");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const config = { agentDir, dryRun: false, quiet: true, verbose: false };
	assert.doesNotThrow(() => cleanupRetiredProfileFiles(config));
});

test("cleanupRetiredProfileFiles skips a symlinked extensions/librarian.json without error", (t) => {
	if (process.platform === "win32") return;
	const root = makeTempDir("tlh-cleanup-retired-symlink-");
	const agentDir = join(root, "agent");
	const extensionsDir = join(agentDir, "extensions");
	const librarianJson = join(extensionsDir, "librarian.json");
	const externalFile = join(root, "external-librarian.json");
	mkdirSync(extensionsDir, { recursive: true });
	writeFileSync(externalFile, JSON.stringify({ version: "1.0.0" }), "utf8");
	symlinkSync(externalFile, librarianJson);
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const config = { agentDir, dryRun: false, quiet: true, verbose: false };
	cleanupRetiredProfileFiles(config);

	assert.ok(existsSync(librarianJson), "symlinked extensions/librarian.json should be preserved");
	assert.ok(existsSync(externalFile), "external file should be untouched");
});

test("cleanupRetiredProfileFiles dry-run logs removal without deleting the file", (t) => {
	const root = makeTempDir("tlh-cleanup-retired-dryrun-");
	const agentDir = join(root, "agent");
	const extensionsDir = join(agentDir, "extensions");
	const librarianJson = join(extensionsDir, "librarian.json");
	mkdirSync(extensionsDir, { recursive: true });
	writeFileSync(librarianJson, JSON.stringify({ version: "1.0.0" }), "utf8");
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const config = { agentDir, dryRun: true, quiet: false, verbose: false };
	const stdout = captureConsole("log", () => cleanupRetiredProfileFiles(config));

	assert.ok(existsSync(librarianJson), "file should not be removed in dry-run mode");
	assert.match(stdout, /Would remove retired profile file.*librarian\.json/);
});

test("cleanupRetiredProfileFiles only operates within config.agentDir and does not touch other paths", (t) => {
	const root = makeTempDir("tlh-cleanup-retired-isolation-");
	const agentDir = join(root, "agent");
	const otherDir = join(root, "other-profile");
	const otherLibrarianJson = join(otherDir, "extensions", "librarian.json");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(join(otherDir, "extensions"), { recursive: true });
	writeFileSync(otherLibrarianJson, JSON.stringify({ version: "1.0.0" }), "utf8");
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const config = { agentDir, dryRun: false, quiet: true, verbose: false };
	cleanupRetiredProfileFiles(config);

	assert.ok(existsSync(otherLibrarianJson), "file outside agentDir must not be removed");
});

test("cleanupRetiredProfileFiles skips cleanup and preserves external file when parent dir is a symlink (FIX 1)", (t) => {
	if (process.platform === "win32") return;
	const root = makeTempDir("tlh-cleanup-retired-symlink-parent-");
	const agentDir = join(root, "agent");
	const externalDir = join(root, "external-extensions");
	const externalFile = join(externalDir, "librarian.json");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(externalDir, { recursive: true });
	writeFileSync(externalFile, JSON.stringify({ version: "1.0.0" }), "utf8");
	symlinkSync(externalDir, join(agentDir, "extensions"), "dir");
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const config = { agentDir, dryRun: false, quiet: true, verbose: false };
	const stderr = captureConsole("error", () => {
		assert.doesNotThrow(() => cleanupRetiredProfileFiles(config));
	});

	assert.ok(existsSync(externalFile), "external file must not be removed when parent dir is a symlink");
	assert.match(stderr, /symlinked parent/);
});

test("cleanupRetiredProfileFiles preserves extensions/librarian.json when user-added librarian package is in post-merge settings (FIX 2)", (t) => {
	const root = makeTempDir("tlh-cleanup-retired-user-added-");
	const agentDir = join(root, "agent");
	const extensionsDir = join(agentDir, "extensions");
	const librarianJson = join(extensionsDir, "librarian.json");
	const settingsPath = join(agentDir, "settings.json");
	mkdirSync(extensionsDir, { recursive: true });
	writeFileSync(librarianJson, JSON.stringify({ version: "1.0.0" }), "utf8");
	writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:@diegopetrucci/pi-librarian"] }), "utf8");
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const config = { agentDir, dryRun: false, quiet: true, verbose: false, settingsPath };
	cleanupRetiredProfileFiles(config);

	assert.ok(
		existsSync(librarianJson),
		"extensions/librarian.json must be preserved when user-added librarian package is present in post-merge settings",
	);
});

test("cleanupRetiredProfileFiles removes extensions/librarian.json when librarian package is absent from post-merge settings (FIX 2)", (t) => {
	const root = makeTempDir("tlh-cleanup-retired-managed-absent-");
	const agentDir = join(root, "agent");
	const extensionsDir = join(agentDir, "extensions");
	const librarianJson = join(extensionsDir, "librarian.json");
	const settingsPath = join(agentDir, "settings.json");
	mkdirSync(extensionsDir, { recursive: true });
	writeFileSync(librarianJson, JSON.stringify({ version: "1.0.0" }), "utf8");
	writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:some-other-extension"] }), "utf8");
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const config = { agentDir, dryRun: false, quiet: true, verbose: false, settingsPath };
	cleanupRetiredProfileFiles(config);

	assert.equal(
		existsSync(librarianJson),
		false,
		"extensions/librarian.json must be removed when librarian package is absent from post-merge settings",
	);
});

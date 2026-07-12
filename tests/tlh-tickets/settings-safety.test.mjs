import test from "node:test";
import {
	assert,
	chmodSync,
	existsSync,
	join,
	mkdirSync,
	readFileSync,
	readdirSync,
	runTickets,
	statSync,
	tempFixture,
	ticketEnableArgs,
	writeFileSync,
	writeSwapParentAfterMkdirPreload,
	writeSwapParentBeforeMkdirPreload,
	writeSwapSettingsBackupParentBeforeOpenPreload,
	writeSwapSettingsParentBeforeRealpathPreload,
	writeSwapTargetParentBeforeOpenPreload,
} from "./test-helpers.mjs";

test("settings writes do not follow the old predictable temp-file symlink", { skip: process.platform === "win32" }, () => {
	const fixture = tempFixture();
	const settings = join(fixture.agent, "settings.json");
	const symlinkTarget = join(fixture.external, "sentinel-settings.json");
	const symlinkPathRecord = join(fixture.dir, "old-temp-path");
	writeFileSync(symlinkTarget, "original sentinel");

	const preload = join(fixture.dir, "predictable-temp-symlink.mjs");
	writeFileSync(preload, `import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const settings = process.env.TLH_TEST_SETTINGS_PATH;
const oldTempPath = \`${settings}.tmp-\${process.pid}\`;
mkdirSync(dirname(settings), { recursive: true });
symlinkSync(process.env.TLH_TEST_SYMLINK_TARGET, oldTempPath, "file");
writeFileSync(process.env.TLH_TEST_SYMLINK_PATH_RECORD, oldTempPath);
`);

	const result = runTickets(ticketEnableArgs(fixture, settings), {
		env: {
			HOME: fixture.home,
			TLH_TEST_SETTINGS_PATH: settings,
			TLH_TEST_SYMLINK_TARGET: symlinkTarget,
			TLH_TEST_SYMLINK_PATH_RECORD: symlinkPathRecord,
		},
		nodeArgs: ["--import", preload],
	});

	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(symlinkTarget, "utf8"), "original sentinel");
	assert.equal(existsSync(readFileSync(symlinkPathRecord, "utf8")), true);
	const written = JSON.parse(readFileSync(settings, "utf8"));
	assert.equal(written.tlh.tickets.enabled, true);
});

test("settings direct write refuses parent swap before open without touching external sentinels", { skip: process.platform === "win32" }, () => {
	const fixture = tempFixture();
	const settings = join(fixture.agent, "settings.json");
	const externalSettings = join(fixture.external, "settings.json");
	const externalTk = join(fixture.external, "tk");
	const preload = writeSwapTargetParentBeforeOpenPreload(fixture);
	writeFileSync(externalSettings, "original settings sentinel");
	writeFileSync(externalTk, "original tk sentinel");

	const result = runTickets(ticketEnableArgs(fixture, settings), {
		env: {
			HOME: fixture.home,
			TLH_TEST_SWAP_OPEN_PATH: settings,
			TLH_TEST_EXTERNAL: fixture.external,
		},
		nodeArgs: ["--import", preload],
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /outside the intended directory|already exists|EEXIST/i);
	assert.equal(readFileSync(externalSettings, "utf8"), "original settings sentinel");
	assert.equal(readFileSync(externalTk, "utf8"), "original tk sentinel");
});

test("settings direct write removes empty file created by parent swap to normal Pi", { skip: process.platform === "win32" }, () => {
	const fixture = tempFixture();
	const settings = join(fixture.agent, "settings.json");
	const normalPiAgent = join(fixture.home, ".pi", "agent");
	const normalSettings = join(normalPiAgent, "settings.json");
	const normalTk = join(normalPiAgent, "tk");
	const preload = writeSwapTargetParentBeforeOpenPreload(fixture);
	mkdirSync(normalPiAgent, { recursive: true });
	writeFileSync(normalTk, "normal Pi tk sentinel");

	const result = runTickets(ticketEnableArgs(fixture, settings), {
		env: {
			HOME: fixture.home,
			TLH_TEST_SWAP_OPEN_PATH: settings,
			TLH_TEST_EXTERNAL: normalPiAgent,
		},
		nodeArgs: ["--import", preload],
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /normal Pi config|outside the intended directory|symlinked settings directory/i);
	assert.equal(existsSync(normalSettings), false);
	assert.equal(readFileSync(normalTk, "utf8"), "normal Pi tk sentinel");
	assert.deepEqual(readdirSync(normalPiAgent), ["tk"]);
});

test("settings backup write refuses parent swap before open without copying settings outside", { skip: process.platform === "win32" }, () => {
	const fixture = tempFixture();
	const settings = join(fixture.agent, "settings.json");
	const externalSettings = join(fixture.external, "settings.json");
	const externalTk = join(fixture.external, "tk");
	const preload = writeSwapSettingsBackupParentBeforeOpenPreload(fixture);
	writeFileSync(settings, `{"secret":"do-not-leak","tlh":{"tickets":{"enabled":true}}}\n`);
	writeFileSync(externalSettings, "original settings sentinel");
	writeFileSync(externalTk, "original tk sentinel");

	const result = runTickets(ticketEnableArgs(fixture, settings), {
		env: {
			HOME: fixture.home,
			TLH_TEST_EXTERNAL: fixture.external,
		},
		nodeArgs: ["--import", preload],
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /outside the intended directory/i);
	assert.equal(readFileSync(externalSettings, "utf8"), "original settings sentinel");
	assert.equal(readFileSync(externalTk, "utf8"), "original tk sentinel");
	for (const entry of readdirSync(fixture.external)) {
		assert.doesNotMatch(readFileSync(join(fixture.external, entry), "utf8"), /do-not-leak/);
	}
});


test("settings write refuses parent swap before intended directory realpath capture", { skip: process.platform === "win32" }, () => {
	const fixture = tempFixture();
	const settingsDir = join(fixture.agent, "settings-parent");
	const settings = join(settingsDir, "settings.json");
	const normalPiAgent = join(fixture.home, ".pi", "agent");
	const normalSettings = join(normalPiAgent, "settings.json");
	const normalTk = join(normalPiAgent, "tk");
	const preload = writeSwapSettingsParentBeforeRealpathPreload(fixture);
	mkdirSync(normalPiAgent, { recursive: true });
	writeFileSync(normalSettings, "normal Pi settings sentinel");
	writeFileSync(normalTk, "normal Pi tk sentinel");

	const result = runTickets(ticketEnableArgs(fixture, settings), {
		env: {
			HOME: fixture.home,
			TLH_TEST_SWAP_REALPATH_PATH: settingsDir,
			TLH_TEST_EXTERNAL: normalPiAgent,
		},
		nodeArgs: ["--import", preload],
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /intended settings directory|normal Pi config|symlinked/i);
	assert.equal(readFileSync(normalSettings, "utf8"), "normal Pi settings sentinel");
	assert.equal(readFileSync(normalTk, "utf8"), "normal Pi tk sentinel");
	assert.deepEqual(readdirSync(normalPiAgent).sort(), ["settings.json", "tk"]);
});

test("settings directory creation does not clean up a directory when parent revalidation fails", { skip: process.platform === "win32" }, () => {
	const fixture = tempFixture();
	const settingsDir = join(fixture.agent, "settings-parent");
	const settings = join(settingsDir, "settings.json");
	const normalPiAgent = join(fixture.home, ".pi", "agent");
	const normalSettings = join(normalPiAgent, "settings.json");
	const normalTk = join(normalPiAgent, "tk");
	const externalCreatedSettingsDir = join(normalPiAgent, "settings-parent");
	const preload = writeSwapParentBeforeMkdirPreload(fixture);
	mkdirSync(normalPiAgent, { recursive: true });
	writeFileSync(normalSettings, "normal Pi settings sentinel");
	writeFileSync(normalTk, "normal Pi tk sentinel");

	const result = runTickets(ticketEnableArgs(fixture, settings), {
		env: {
			HOME: fixture.home,
			TLH_TEST_SWAP_MKDIR_PATH: settingsDir,
			TLH_TEST_EXTERNAL: normalPiAgent,
		},
		nodeArgs: ["--import", preload],
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /outside the intended directory|symlinked/i);
	assert.equal(readFileSync(normalSettings, "utf8"), "normal Pi settings sentinel");
	assert.equal(readFileSync(normalTk, "utf8"), "normal Pi tk sentinel");
	assert.equal(statSync(externalCreatedSettingsDir).isDirectory(), true);
	assert.deepEqual(readdirSync(externalCreatedSettingsDir), []);
	assert.deepEqual(readdirSync(normalPiAgent).sort(), ["settings-parent", "settings.json", "tk"]);
});

test("settings directory creation does not remove external directory swapped after mkdir", { skip: process.platform === "win32" }, () => {
	const fixture = tempFixture();
	const settingsDir = join(fixture.agent, "settings-parent");
	const settings = join(settingsDir, "settings.json");
	const normalPiAgent = join(fixture.home, ".pi", "agent");
	const normalSettings = join(normalPiAgent, "settings.json");
	const normalTk = join(normalPiAgent, "tk");
	const externalSettingsDir = join(normalPiAgent, "settings-parent");
	const preload = writeSwapParentAfterMkdirPreload(fixture);
	mkdirSync(externalSettingsDir, { recursive: true });
	writeFileSync(normalSettings, "normal Pi settings sentinel");
	writeFileSync(normalTk, "normal Pi tk sentinel");

	const result = runTickets(ticketEnableArgs(fixture, settings), {
		env: {
			HOME: fixture.home,
			TLH_TEST_SWAP_MKDIR_PATH: settingsDir,
			TLH_TEST_EXTERNAL: normalPiAgent,
		},
		nodeArgs: ["--import", preload],
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /outside the intended directory|symlinked|normal Pi config/i);
	assert.equal(readFileSync(normalSettings, "utf8"), "normal Pi settings sentinel");
	assert.equal(readFileSync(normalTk, "utf8"), "normal Pi tk sentinel");
	assert.equal(statSync(externalSettingsDir).isDirectory(), true);
	assert.deepEqual(readdirSync(externalSettingsDir), []);
	assert.deepEqual(readdirSync(normalPiAgent).sort(), ["settings-parent", "settings.json", "tk"]);
});

test("settings writes create new settings with restrictive mode", { skip: process.platform === "win32" }, () => {
	const fixture = tempFixture();
	const settings = join(fixture.agent, "settings.json");

	const result = runTickets(ticketEnableArgs(fixture, settings), { env: { HOME: fixture.home } });

	assert.equal(result.status, 0, result.stderr);
	assert.equal(statSync(settings).mode & 0o777, 0o600);
});

test("settings writes preserve existing settings and backup modes", { skip: process.platform === "win32" }, () => {
	const fixture = tempFixture();
	const settings = join(fixture.agent, "settings.json");
	writeFileSync(settings, `{"tlh":{"tickets":{"enabled":true}}}\n`);
	chmodSync(settings, 0o640);

	const result = runTickets(ticketEnableArgs(fixture, settings, ["--detail"]), { env: { HOME: fixture.home } });

	assert.equal(result.status, 0, result.stderr);
	assert.equal(statSync(settings).mode & 0o777, 0o640);
	const backups = readdirSync(fixture.agent).filter((entry) => entry.startsWith("settings.json.backup-tlh-tickets-"));
	assert.equal(backups.length, 1);
	assert.equal(statSync(join(fixture.agent, backups[0])).mode & 0o777, 0o640);
});

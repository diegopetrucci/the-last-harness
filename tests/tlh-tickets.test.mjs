import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const ticketsScript = join(repoRoot, "scripts", "tlh-tickets.mjs");

function runTickets(args, options = {}) {
	return spawnSync(process.execPath, [...(options.nodeArgs || []), ticketsScript, ...args], {
		cwd: repoRoot,
		env: { ...process.env, ...(options.env || {}) },
		encoding: "utf8",
	});
}

function tempFixture() {
	const dir = mkdtempSync(join(tmpdir(), "tlh-tickets-test-"));
	const home = join(dir, "home");
	const agent = join(dir, "agent");
	const external = join(dir, "external");
	mkdirSync(home, { recursive: true });
	mkdirSync(agent, { recursive: true });
	mkdirSync(external, { recursive: true });
	return { dir, home, agent, external };
}

function symlinkDirectory(target, path) {
	symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeValidTkLikeCommand(path, { sentinel } = {}) {
	writeFileSync(path, `#!/bin/sh
${sentinel ? `printf called > ${JSON.stringify(sentinel)}\n` : ""}case "\${1:-}" in
  help|--help|-h)
    echo "tk - minimal ticket system"
    echo "Usage: tk <command> [args]"
    echo "Tickets stored as markdown files in .tickets/"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);
	chmodSync(path, 0o755);
}

function createTicketArchive(fixture) {
	const archiveSource = join(fixture.dir, "archive-source");
	const root = join(archiveSource, "ticket-0.3.2");
	mkdirSync(root, { recursive: true });
	const ticket = join(root, "ticket");
	writeFileSync(ticket, `#!/usr/bin/env bash
set -euo pipefail
command_name="$(basename "$0")"
case "\${1:-}" in
  help|--help|-h)
    echo "\${command_name} - minimal ticket system with dependency tracking"
    echo "Usage: \${command_name} <command> [args]"
    echo "Tickets stored as markdown files in .tickets/"
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`);
	chmodSync(ticket, 0o755);
	writeFileSync(join(root, "extra"), "must not be installed");

	const archivePath = join(fixture.dir, "ticket.tar.gz");
	const tarResult = spawnSync("tar", ["-czf", archivePath, "-C", archiveSource, "ticket-0.3.2"], { encoding: "utf8" });
	assert.equal(tarResult.status, 0, tarResult.stderr || String(tarResult.error));
	return { archivePath, checksum: sha256File(archivePath), ticketContent: readFileSync(ticket, "utf8") };
}

function writeFetchPreload(fixture, archivePath) {
	const preload = join(fixture.dir, "stub-ticket-fetch.mjs");
	writeFileSync(preload, `import { readFileSync, writeFileSync } from "node:fs";
const archive = readFileSync(process.env.TLH_TEST_ARCHIVE);
const archiveBytes = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength);
globalThis.fetch = async (url) => {
	writeFileSync(process.env.TLH_TEST_FETCH_SENTINEL, String(url));
	return { ok: true, status: 200, statusText: "OK", arrayBuffer: async () => archiveBytes };
};
`);
	return preload;
}

function writeSwapTargetParentBeforeOpenPreload(fixture) {
	const preload = join(fixture.dir, "swap-target-parent-before-open.mjs");
	writeFileSync(preload, `import fs from "node:fs";
import { dirname } from "node:path";
import { syncBuiltinESMExports } from "node:module";

const originalOpenSync = fs.openSync;
let sabotaged = false;
fs.openSync = (path, flags, mode) => {
	const pathString = String(path);
	if (!sabotaged && pathString === process.env.TLH_TEST_SWAP_OPEN_PATH) {
		sabotaged = true;
		const parent = dirname(pathString);
		fs.rmSync(parent, { recursive: true, force: true });
		fs.symlinkSync(process.env.TLH_TEST_EXTERNAL, parent, "dir");
		return originalOpenSync(path, flags, mode);
	}
	return originalOpenSync(path, flags, mode);
};
syncBuiltinESMExports();
`);
	return preload;
}

function writeFetchAndSwapTargetParentBeforeOpenPreload(fixture) {
	const preload = join(fixture.dir, "fetch-and-swap-target-parent-before-open.mjs");
	writeFileSync(preload, `import fs from "node:fs";
import { dirname } from "node:path";
import { syncBuiltinESMExports } from "node:module";

const originalOpenSync = fs.openSync;
let sabotaged = false;
fs.openSync = (path, flags, mode) => {
	const pathString = String(path);
	if (!sabotaged && pathString === process.env.TLH_TEST_SWAP_OPEN_PATH) {
		sabotaged = true;
		const parent = dirname(pathString);
		fs.rmSync(parent, { recursive: true, force: true });
		fs.symlinkSync(process.env.TLH_TEST_EXTERNAL, parent, "dir");
		return originalOpenSync(path, flags, mode);
	}
	return originalOpenSync(path, flags, mode);
};
syncBuiltinESMExports();

const archive = fs.readFileSync(process.env.TLH_TEST_ARCHIVE);
const archiveBytes = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength);
globalThis.fetch = async (url) => {
	fs.writeFileSync(process.env.TLH_TEST_FETCH_SENTINEL, String(url));
	return { ok: true, status: 200, statusText: "OK", arrayBuffer: async () => archiveBytes };
};
`);
	return preload;
}

function writeSwapParentBeforeMkdirPreload(fixture) {
	const preload = join(fixture.dir, "swap-parent-before-mkdir.mjs");
	writeFileSync(preload, `import fs from "node:fs";
import { dirname } from "node:path";
import { syncBuiltinESMExports } from "node:module";

const originalMkdirSync = fs.mkdirSync;
let sabotaged = false;
fs.mkdirSync = (path, ...args) => {
	const pathString = String(path);
	if (!sabotaged && pathString === process.env.TLH_TEST_SWAP_MKDIR_PATH) {
		sabotaged = true;
		const parent = dirname(pathString);
		fs.rmSync(parent, { recursive: true, force: true });
		fs.symlinkSync(process.env.TLH_TEST_EXTERNAL, parent, "dir");
	}
	return originalMkdirSync(path, ...args);
};
syncBuiltinESMExports();
`);
	return preload;
}

function writeSwapParentAfterMkdirPreload(fixture) {
	const preload = join(fixture.dir, "swap-parent-after-mkdir.mjs");
	writeFileSync(preload, `import fs from "node:fs";
import { dirname } from "node:path";
import { syncBuiltinESMExports } from "node:module";

const originalMkdirSync = fs.mkdirSync;
let sabotaged = false;
fs.mkdirSync = (path, ...args) => {
	const pathString = String(path);
	const result = originalMkdirSync(path, ...args);
	if (!sabotaged && pathString === process.env.TLH_TEST_SWAP_MKDIR_PATH) {
		sabotaged = true;
		const parent = dirname(pathString);
		fs.rmSync(parent, { recursive: true, force: true });
		fs.symlinkSync(process.env.TLH_TEST_EXTERNAL, parent, "dir");
	}
	return result;
};
syncBuiltinESMExports();
`);
	return preload;
}

function writeFetchAndSwapParentBeforeMkdirPreload(fixture) {
	const preload = join(fixture.dir, "fetch-and-swap-parent-before-mkdir.mjs");
	writeFileSync(preload, `import fs from "node:fs";
import { dirname } from "node:path";
import { syncBuiltinESMExports } from "node:module";

const originalMkdirSync = fs.mkdirSync;
let sabotaged = false;
fs.mkdirSync = (path, ...args) => {
	const pathString = String(path);
	if (!sabotaged && pathString === process.env.TLH_TEST_SWAP_MKDIR_PATH) {
		sabotaged = true;
		const parent = dirname(pathString);
		fs.rmSync(parent, { recursive: true, force: true });
		fs.symlinkSync(process.env.TLH_TEST_EXTERNAL, parent, "dir");
	}
	return originalMkdirSync(path, ...args);
};
syncBuiltinESMExports();

const archive = fs.readFileSync(process.env.TLH_TEST_ARCHIVE);
const archiveBytes = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength);
globalThis.fetch = async (url) => {
	fs.writeFileSync(process.env.TLH_TEST_FETCH_SENTINEL, String(url));
	return { ok: true, status: 200, statusText: "OK", arrayBuffer: async () => archiveBytes };
};
`);
	return preload;
}

function writeSwapSettingsBackupParentBeforeOpenPreload(fixture) {
	const preload = join(fixture.dir, "swap-settings-backup-parent-before-open.mjs");
	writeFileSync(preload, `import fs from "node:fs";
import { basename, dirname } from "node:path";
import { syncBuiltinESMExports } from "node:module";

const originalOpenSync = fs.openSync;
let sabotaged = false;
fs.openSync = (path, flags, mode) => {
	const pathString = String(path);
	if (!sabotaged && basename(pathString).startsWith("settings.json.backup-tlh-tickets-")) {
		sabotaged = true;
		const parent = dirname(pathString);
		fs.rmSync(parent, { recursive: true, force: true });
		fs.symlinkSync(process.env.TLH_TEST_EXTERNAL, parent, "dir");
		return originalOpenSync(path, flags, mode);
	}
	return originalOpenSync(path, flags, mode);
};
syncBuiltinESMExports();
`);
	return preload;
}

function writeSwapSettingsParentBeforeRealpathPreload(fixture) {
	const preload = join(fixture.dir, "swap-settings-parent-before-realpath.mjs");
	writeFileSync(preload, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const originalMkdirSync = fs.mkdirSync;
const originalRealpathSync = fs.realpathSync;
let armed = false;
let sabotaged = false;
fs.mkdirSync = (path, ...args) => {
	const result = originalMkdirSync(path, ...args);
	if (String(path) === process.env.TLH_TEST_SWAP_REALPATH_PATH) armed = true;
	return result;
};
fs.realpathSync = (path, ...args) => {
	const pathString = String(path);
	if (armed && !sabotaged && pathString === process.env.TLH_TEST_SWAP_REALPATH_PATH) {
		sabotaged = true;
		fs.rmSync(pathString, { recursive: true, force: true });
		fs.symlinkSync(process.env.TLH_TEST_EXTERNAL, pathString, "dir");
	}
	return originalRealpathSync(path, ...args);
};
syncBuiltinESMExports();
`);
	return preload;
}

function writeFetchAndSwapTargetParentBeforeSecondRealpathPreload(fixture) {
	const preload = join(fixture.dir, "fetch-and-swap-target-parent-before-second-realpath.mjs");
	writeFileSync(preload, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const originalMkdirSync = fs.mkdirSync;
const originalRealpathSync = fs.realpathSync;
let armed = false;
let realpathCalls = 0;
let sabotaged = false;
fs.mkdirSync = (path, ...args) => {
	const result = originalMkdirSync(path, ...args);
	if (String(path) === process.env.TLH_TEST_SWAP_REALPATH_PATH) armed = true;
	return result;
};
fs.realpathSync = (path, ...args) => {
	const pathString = String(path);
	if (armed && pathString === process.env.TLH_TEST_SWAP_REALPATH_PATH) {
		realpathCalls += 1;
		if (!sabotaged && realpathCalls >= 2) {
			sabotaged = true;
			fs.rmSync(pathString, { recursive: true, force: true });
			fs.symlinkSync(process.env.TLH_TEST_EXTERNAL, pathString, "dir");
		}
	}
	return originalRealpathSync(path, ...args);
};
syncBuiltinESMExports();

const archive = fs.readFileSync(process.env.TLH_TEST_ARCHIVE);
const archiveBytes = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength);
globalThis.fetch = async (url) => {
	fs.writeFileSync(process.env.TLH_TEST_FETCH_SENTINEL, String(url));
	return { ok: true, status: 200, statusText: "OK", arrayBuffer: async () => archiveBytes };
};
`);
	return preload;
}

function writeSwapAgentRootBeforeLstatPreload(fixture) {
	const preload = join(fixture.dir, "swap-agent-root-before-lstat.mjs");
	writeFileSync(preload, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const originalLstatSync = fs.lstatSync;
let sabotaged = false;
fs.lstatSync = (path, ...args) => {
	const pathString = String(path);
	if (!sabotaged && pathString === process.env.TLH_TEST_SWAP_AGENT_ROOT) {
		sabotaged = true;
		fs.rmSync(pathString, { recursive: true, force: true });
		fs.symlinkSync(process.env.TLH_TEST_EXTERNAL, pathString, "dir");
	}
	return originalLstatSync(path, ...args);
};
syncBuiltinESMExports();

globalThis.fetch = async () => {
	fs.writeFileSync(process.env.TLH_TEST_FETCH_SENTINEL, "called");
	throw new Error("fetch should not be called");
};
`);
	return preload;
}

test("install-managed installs only tk from a verified ticket source archive", { skip: process.platform === "win32" }, () => {
	const fixture = tempFixture();
	const { archivePath, checksum, ticketContent } = createTicketArchive(fixture);
	const fetchSentinel = join(fixture.dir, "fetch-called");
	const preload = writeFetchPreload(fixture, archivePath);
	const target = join(fixture.agent, "bin", "tk");

	const result = runTickets([
		"--agent-dir", fixture.agent,
		"--target", target,
		"install-managed",
	], {
		env: {
			HOME: fixture.home,
			TLH_TEST_ARCHIVE: archivePath,
			TLH_TEST_FETCH_SENTINEL: fetchSentinel,
			TLH_TICKET_SOURCE_URL: "https://example.test/wedow-ticket.tar.gz",
			TLH_TICKET_SOURCE_SHA256: checksum,
		},
		nodeArgs: ["--import", preload],
	});

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), target);
	assert.equal(readFileSync(fetchSentinel, "utf8"), "https://example.test/wedow-ticket.tar.gz");
	assert.equal(readFileSync(target, "utf8"), ticketContent);
	assert.equal(statSync(target).mode & 0o777, 0o755);
	assert.deepEqual(readdirSync(join(fixture.agent, "bin")), ["tk"]);
	assert.deepEqual(readdirSync(dirname(target)).filter((entry) => entry.startsWith(".tlh-tickets-")), []);

	const validation = spawnSync(target, ["help"], { encoding: "utf8" });
	assert.equal(validation.status, 0, validation.stderr);
	assert.match(validation.stdout, /Usage: tk/);
});

test("install-managed rejects non-tk managed target before fetch or overwrite", () => {
	const fixture = tempFixture();
	const settings = join(fixture.agent, "settings.json");
	const originalSettings = `{"tlh":{"tickets":{"enabled":false}}}\n`;
	writeFileSync(settings, originalSettings);

	const fetchSentinel = join(fixture.dir, "fetch-called");
	const preload = join(fixture.dir, "fail-fetch.mjs");
	writeFileSync(preload, `import { writeFileSync } from "node:fs";
globalThis.fetch = async () => {
	writeFileSync(${JSON.stringify(fetchSentinel)}, "called");
	throw new Error("fetch should not be called");
};
`);

	const result = runTickets([
		"--agent-dir", fixture.agent,
		"--target", settings,
		"install-managed",
	], {
		env: { HOME: fixture.home },
		nodeArgs: ["--import", preload],
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /target basename.*exactly "tk"/i);
	assert.equal(readFileSync(settings, "utf8"), originalSettings);
	assert.equal(existsSync(fetchSentinel), false);
});

test("install-managed rejects agent bin symlink before network or writes", { skip: process.platform === "win32" }, () => {
	const fixture = tempFixture();
	symlinkDirectory(fixture.external, join(fixture.agent, "bin"));

	const fetchSentinel = join(fixture.dir, "fetch-called");
	const preload = join(fixture.dir, "fail-fetch.mjs");
	writeFileSync(preload, `import { writeFileSync } from "node:fs";
globalThis.fetch = async () => {
	writeFileSync(${JSON.stringify(fetchSentinel)}, "called");
	throw new Error("fetch should not be called");
};
`);

	const result = runTickets([
		"--agent-dir", fixture.agent,
		"--target", join(fixture.agent, "bin", "tk"),
		"install-managed",
	], {
		env: { HOME: fixture.home },
		nodeArgs: ["--import", preload],
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /symlinked target parent component/i);
	assert.equal(existsSync(fetchSentinel), false);
	assert.deepEqual(readdirSync(fixture.external), []);
});

test("install-managed rejects agent root swapped to an external symlink before plan capture", { skip: process.platform === "win32" }, () => {
	const fixture = tempFixture();
	const externalBin = join(fixture.external, "bin");
	const externalTk = join(externalBin, "tk");
	const fetchSentinel = join(fixture.dir, "fetch-called");
	const preload = writeSwapAgentRootBeforeLstatPreload(fixture);
	mkdirSync(externalBin, { recursive: true });
	writeFileSync(externalTk, "external tk sentinel");

	const result = runTickets([
		"--agent-dir", fixture.agent,
		"--target", join(fixture.agent, "bin", "tk"),
		"install-managed",
	], {
		env: {
			HOME: fixture.home,
			TLH_TEST_SWAP_AGENT_ROOT: fixture.agent,
			TLH_TEST_EXTERNAL: fixture.external,
			TLH_TEST_FETCH_SENTINEL: fetchSentinel,
		},
		nodeArgs: ["--import", preload],
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /symlinked managed agent root|changed while planning/i);
	assert.equal(existsSync(fetchSentinel), false);
	assert.equal(readFileSync(externalTk, "utf8"), "external tk sentinel");
});

test("install-managed rejects normal Pi agent dir before network or writes", () => {
	const fixture = tempFixture();
	const normalPiAgent = join(fixture.home, ".pi", "agent");
	mkdirSync(normalPiAgent, { recursive: true });

	const fetchSentinel = join(fixture.dir, "fetch-called");
	const preload = join(fixture.dir, "fail-fetch.mjs");
	writeFileSync(preload, `import { writeFileSync } from "node:fs";
globalThis.fetch = async () => {
	writeFileSync(${JSON.stringify(fetchSentinel)}, "called");
	throw new Error("fetch should not be called");
};
`);

	const result = runTickets([
		"--agent-dir", normalPiAgent,
		"install-managed",
	], {
		env: { HOME: fixture.home },
		nodeArgs: ["--import", preload],
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /normal Pi config/i);
	assert.equal(existsSync(fetchSentinel), false);
	assert.deepEqual(readdirSync(normalPiAgent), []);
});

test("enable validates the requested tk command before writing settings", () => {
	const fixture = tempFixture();
	const settings = join(fixture.agent, "settings.json");
	const invalidTk = join(fixture.external, "tk");
	writeFileSync(invalidTk, `#!/usr/bin/env bash
exit 42
`);
	chmodSync(invalidTk, 0o755);

	const result = runTickets([
		"--settings", settings,
		"--agent-dir", fixture.agent,
		"--install-path", invalidTk,
		"enable",
	], { env: { HOME: fixture.home } });

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /did not validate/i);
	assert.equal(existsSync(settings), false);
	assert.deepEqual(readdirSync(fixture.agent), []);
});

test("enable rejects a requested command whose basename is not tk before validation", () => {
	const fixture = tempFixture();
	const settings = join(fixture.agent, "settings.json");
	const ticket = join(fixture.external, "ticket");
	const sentinel = join(fixture.dir, "ticket-called");
	writeValidTkLikeCommand(ticket, { sentinel });

	const result = runTickets([
		"--settings", settings,
		"--agent-dir", fixture.agent,
		"--install-path", ticket,
		"enable",
	], { env: { HOME: fixture.home, PATH: "" } });

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /basename.*"tk"/i);
	assert.equal(existsSync(settings), false);
	assert.equal(existsSync(sentinel), false);
});

test("status does not report an enabled non-tk configured command as active", () => {
	const fixture = tempFixture();
	const settings = join(fixture.agent, "settings.json");
	const ticket = join(fixture.external, "ticket");
	const sentinel = join(fixture.dir, "ticket-called");
	writeValidTkLikeCommand(ticket, { sentinel });
	writeFileSync(settings, `${JSON.stringify({ tlh: { tickets: { enabled: true, installPath: ticket } } })}\n`);

	const result = runTickets([
		"--settings", settings,
		"--agent-dir", fixture.agent,
		"status",
	], { env: { HOME: fixture.home, PATH: "" } });

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /active: no/);
	assert.match(result.stdout, /command: not found/);
	assert.equal(existsSync(sentinel), false);
});

test("status treats unset settings with a valid tk command as active by default", () => {
	const fixture = tempFixture();
	const settings = join(fixture.agent, "settings.json");
	const managedTk = join(fixture.agent, "bin", "tk");
	mkdirSync(dirname(managedTk), { recursive: true });
	writeValidTkLikeCommand(managedTk);

	const result = runTickets([
		"--settings", settings,
		"--agent-dir", fixture.agent,
		"status",
	], { env: { HOME: fixture.home, PATH: "" } });

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /setting: unset/);
	assert.match(result.stdout, /active: yes/);
	assert.ok(result.stdout.includes(`  command: ${managedTk}`));
	assert.doesNotMatch(result.stdout, /tlh tickets enable/);
	assert.equal(existsSync(settings), false);
});

test("status keeps explicit disabled settings inactive even with a valid tk command", () => {
	const fixture = tempFixture();
	const settings = join(fixture.agent, "settings.json");
	const managedTk = join(fixture.agent, "bin", "tk");
	mkdirSync(dirname(managedTk), { recursive: true });
	writeValidTkLikeCommand(managedTk);
	writeFileSync(settings, `${JSON.stringify({ tlh: { tickets: { enabled: false } } })}\n`);

	const result = runTickets([
		"--settings", settings,
		"--agent-dir", fixture.agent,
		"status",
	], { env: { HOME: fixture.home, PATH: "" } });

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /setting: disabled/);
	assert.match(result.stdout, /active: no/);
	assert.ok(result.stdout.includes(`  command: ${managedTk}`));
});

test("validate rejects a command whose basename is not tk before validation", () => {
	const fixture = tempFixture();
	const settings = join(fixture.agent, "settings.json");
	const ticket = join(fixture.external, "ticket");
	const sentinel = join(fixture.dir, "ticket-called");
	writeValidTkLikeCommand(ticket, { sentinel });

	const result = runTickets([
		"--settings", settings,
		"--agent-dir", fixture.agent,
		"validate", ticket,
	], { env: { HOME: fixture.home, PATH: "" } });

	assert.notEqual(result.status, 0);
	assert.equal(result.stdout, "");
	assert.equal(existsSync(sentinel), false);
});

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

	const result = runTickets([
		"--settings", settings,
		"--agent-dir", fixture.agent,
		"disable",
	], {
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
	assert.equal(written.tlh.tickets.enabled, false);
});

test("settings direct write refuses parent swap before open without touching external sentinels", { skip: process.platform === "win32" }, () => {
	const fixture = tempFixture();
	const settings = join(fixture.agent, "settings.json");
	const externalSettings = join(fixture.external, "settings.json");
	const externalTk = join(fixture.external, "tk");
	const preload = writeSwapTargetParentBeforeOpenPreload(fixture);
	writeFileSync(externalSettings, "original settings sentinel");
	writeFileSync(externalTk, "original tk sentinel");

	const result = runTickets([
		"--settings", settings,
		"--agent-dir", fixture.agent,
		"disable",
	], {
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

	const result = runTickets([
		"--settings", settings,
		"--agent-dir", fixture.agent,
		"disable",
	], {
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

	const result = runTickets([
		"--settings", settings,
		"--agent-dir", fixture.agent,
		"disable",
	], {
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

test("install-managed dry-run rejects a managed target equal to a missing agent root", () => {
	const fixture = tempFixture();
	const missingAgent = join(fixture.dir, "missing-agent");

	const result = runTickets([
		"--agent-dir", missingAgent,
		"--target", missingAgent,
		"--dry-run",
		"install-managed",
	], { env: { HOME: fixture.home } });

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /profile directory/i);
	assert.doesNotMatch(result.stderr, /Would install tk/i);
	assert.equal(existsSync(missingAgent), false);
});

test("install-managed direct commit refuses parent swap before open without touching external sentinels", { skip: process.platform === "win32" }, () => {
	const fixture = tempFixture();
	const { archivePath, checksum } = createTicketArchive(fixture);
	const fetchSentinel = join(fixture.dir, "fetch-called");
	const externalSettings = join(fixture.external, "settings.json");
	const externalTk = join(fixture.external, "tk");
	const preload = writeFetchAndSwapTargetParentBeforeOpenPreload(fixture);
	const target = join(fixture.agent, "bin", "tk");
	writeFileSync(externalSettings, "original settings sentinel");
	writeFileSync(externalTk, "original tk sentinel");

	const result = runTickets([
		"--agent-dir", fixture.agent,
		"--target", target,
		"install-managed",
	], {
		env: {
			HOME: fixture.home,
			TLH_TEST_ARCHIVE: archivePath,
			TLH_TEST_FETCH_SENTINEL: fetchSentinel,
			TLH_TEST_SWAP_OPEN_PATH: target,
			TLH_TEST_EXTERNAL: fixture.external,
			TLH_TICKET_SOURCE_URL: "https://example.test/wedow-ticket.tar.gz",
			TLH_TICKET_SOURCE_SHA256: checksum,
		},
		nodeArgs: ["--import", preload],
	});

	assert.notEqual(result.status, 0);
	assert.equal(readFileSync(fetchSentinel, "utf8"), "https://example.test/wedow-ticket.tar.gz");
	assert.equal(readFileSync(externalSettings, "utf8"), "original settings sentinel");
	assert.equal(readFileSync(externalTk, "utf8"), "original tk sentinel");
});

test("install-managed removes empty file created by parent swap to external directory", { skip: process.platform === "win32" }, () => {
	const fixture = tempFixture();
	const { archivePath, checksum } = createTicketArchive(fixture);
	const fetchSentinel = join(fixture.dir, "fetch-called");
	const externalSettings = join(fixture.external, "settings.json");
	const externalTk = join(fixture.external, "tk");
	const preload = writeFetchAndSwapTargetParentBeforeOpenPreload(fixture);
	const target = join(fixture.agent, "bin", "tk");
	writeFileSync(externalSettings, "original settings sentinel");

	const result = runTickets([
		"--agent-dir", fixture.agent,
		"--target", target,
		"install-managed",
	], {
		env: {
			HOME: fixture.home,
			TLH_TEST_ARCHIVE: archivePath,
			TLH_TEST_FETCH_SENTINEL: fetchSentinel,
			TLH_TEST_SWAP_OPEN_PATH: target,
			TLH_TEST_EXTERNAL: fixture.external,
			TLH_TICKET_SOURCE_URL: "https://example.test/wedow-ticket.tar.gz",
			TLH_TICKET_SOURCE_SHA256: checksum,
		},
		nodeArgs: ["--import", preload],
	});

	assert.notEqual(result.status, 0);
	assert.equal(readFileSync(fetchSentinel, "utf8"), "https://example.test/wedow-ticket.tar.gz");
	assert.equal(readFileSync(externalSettings, "utf8"), "original settings sentinel");
	assert.equal(existsSync(externalTk), false);
	assert.deepEqual(readdirSync(fixture.external), ["settings.json"]);
});

test("install-managed does not clean up a managed bin directory when parent revalidation fails", { skip: process.platform === "win32" }, () => {
	const fixture = tempFixture();
	const { archivePath, checksum } = createTicketArchive(fixture);
	const fetchSentinel = join(fixture.dir, "fetch-called");
	const externalSettings = join(fixture.external, "settings.json");
	const externalTk = join(fixture.external, "tk");
	const externalBin = join(fixture.external, "bin");
	const preload = writeFetchAndSwapParentBeforeMkdirPreload(fixture);
	const targetParent = join(fixture.agent, "bin");
	const target = join(targetParent, "tk");
	writeFileSync(externalSettings, "original settings sentinel");
	writeFileSync(externalTk, "original tk sentinel");

	const result = runTickets([
		"--agent-dir", fixture.agent,
		"--target", target,
		"install-managed",
	], {
		env: {
			HOME: fixture.home,
			TLH_TEST_ARCHIVE: archivePath,
			TLH_TEST_FETCH_SENTINEL: fetchSentinel,
			TLH_TEST_SWAP_MKDIR_PATH: targetParent,
			TLH_TEST_EXTERNAL: fixture.external,
			TLH_TICKET_SOURCE_URL: "https://example.test/wedow-ticket.tar.gz",
			TLH_TICKET_SOURCE_SHA256: checksum,
		},
		nodeArgs: ["--import", preload],
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /outside the intended directory|symlinked/i);
	assert.equal(readFileSync(fetchSentinel, "utf8"), "https://example.test/wedow-ticket.tar.gz");
	assert.equal(readFileSync(externalSettings, "utf8"), "original settings sentinel");
	assert.equal(readFileSync(externalTk, "utf8"), "original tk sentinel");
	assert.equal(statSync(externalBin).isDirectory(), true);
	assert.deepEqual(readdirSync(externalBin), []);
	assert.deepEqual(readdirSync(fixture.external).sort(), ["bin", "settings.json", "tk"]);
});

test("install-managed refuses parent swap before intended parent realpath capture", { skip: process.platform === "win32" }, () => {
	const fixture = tempFixture();
	const { archivePath, checksum } = createTicketArchive(fixture);
	const fetchSentinel = join(fixture.dir, "fetch-called");
	const externalSettings = join(fixture.external, "settings.json");
	const externalTk = join(fixture.external, "tk");
	const preload = writeFetchAndSwapTargetParentBeforeSecondRealpathPreload(fixture);
	const targetParent = join(fixture.agent, "bin");
	const target = join(targetParent, "tk");
	writeFileSync(externalSettings, "original settings sentinel");
	writeFileSync(externalTk, "original tk sentinel");

	const result = runTickets([
		"--agent-dir", fixture.agent,
		"--target", target,
		"install-managed",
	], {
		env: {
			HOME: fixture.home,
			TLH_TEST_ARCHIVE: archivePath,
			TLH_TEST_FETCH_SENTINEL: fetchSentinel,
			TLH_TEST_SWAP_REALPATH_PATH: targetParent,
			TLH_TEST_EXTERNAL: fixture.external,
			TLH_TICKET_SOURCE_URL: "https://example.test/wedow-ticket.tar.gz",
			TLH_TICKET_SOURCE_SHA256: checksum,
		},
		nodeArgs: ["--import", preload],
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /intended target parent|isolated tlh profile|symlinked/i);
	assert.equal(readFileSync(fetchSentinel, "utf8"), "https://example.test/wedow-ticket.tar.gz");
	assert.equal(readFileSync(externalSettings, "utf8"), "original settings sentinel");
	assert.equal(readFileSync(externalTk, "utf8"), "original tk sentinel");
	assert.deepEqual(readdirSync(fixture.external).sort(), ["settings.json", "tk"]);
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

	const result = runTickets([
		"--settings", settings,
		"--agent-dir", fixture.agent,
		"disable",
	], {
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

	const result = runTickets([
		"--settings", settings,
		"--agent-dir", fixture.agent,
		"disable",
	], {
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

	const result = runTickets([
		"--settings", settings,
		"--agent-dir", fixture.agent,
		"disable",
	], {
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

	const result = runTickets([
		"--settings", settings,
		"--agent-dir", fixture.agent,
		"disable",
	], { env: { HOME: fixture.home } });

	assert.equal(result.status, 0, result.stderr);
	assert.equal(statSync(settings).mode & 0o777, 0o600);
});

test("settings writes preserve existing settings and backup modes", { skip: process.platform === "win32" }, () => {
	const fixture = tempFixture();
	const settings = join(fixture.agent, "settings.json");
	writeFileSync(settings, `{"tlh":{"tickets":{"enabled":true}}}\n`);
	chmodSync(settings, 0o640);

	const result = runTickets([
		"--settings", settings,
		"--agent-dir", fixture.agent,
		"--detail",
		"disable",
	], { env: { HOME: fixture.home } });

	assert.equal(result.status, 0, result.stderr);
	assert.equal(statSync(settings).mode & 0o777, 0o640);
	const backups = readdirSync(fixture.agent).filter((entry) => entry.startsWith("settings.json.backup-tlh-tickets-"));
	assert.equal(backups.length, 1);
	assert.equal(statSync(join(fixture.agent, backups[0])).mode & 0o777, 0o640);
});

test("configure-install without supports dry-run and records persistent opt-out state", () => {
	const fixture = tempFixture();
	const settings = join(fixture.agent, "settings.json");

	const dryRun = runTickets([
		"--settings", settings,
		"--agent-dir", fixture.agent,
		"--mode", "without",
		"--dry-run",
		"configure-install",
	], { env: { HOME: fixture.home } });

	assert.equal(dryRun.status, 0, dryRun.stderr);
	assert.match(dryRun.stdout, /disabled/);
	assert.equal(existsSync(settings), false);

	const configured = runTickets([
		"--settings", settings,
		"--agent-dir", fixture.agent,
		"--mode", "without",
		"configure-install",
	], { env: { HOME: fixture.home } });

	assert.equal(configured.status, 0, configured.stderr);
	const written = JSON.parse(readFileSync(settings, "utf8"));
	assert.equal(written.tlh.tickets.enabled, false);

	const state = runTickets([
		"--settings", settings,
		"--agent-dir", fixture.agent,
		"state",
	], { env: { HOME: fixture.home } });

	assert.equal(state.status, 0, state.stderr);
	assert.equal(state.stdout.trim(), "disabled");
});

test("disable refuses to write settings under the normal Pi agent profile", () => {
	const fixture = tempFixture();
	const normalPiAgent = join(fixture.home, ".pi", "agent");
	mkdirSync(normalPiAgent, { recursive: true });
	const settings = join(normalPiAgent, "settings.json");

	const result = runTickets([
		"--settings", settings,
		"--agent-dir", fixture.agent,
		"disable",
	], { env: { HOME: fixture.home } });

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /normal Pi config/i);
	assert.equal(existsSync(settings), false);
	assert.deepEqual(readdirSync(normalPiAgent), []);
});

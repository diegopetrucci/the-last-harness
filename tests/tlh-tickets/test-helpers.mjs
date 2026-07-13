import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const ticketsScript = join(repoRoot, "scripts", "tlh-tickets.mjs");

function runTickets(args, options = {}) {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key === "PI_CODING_AGENT_DIR" || key.startsWith("TLH_")) delete env[key];
	}
	Object.assign(env, options.env || {});

	return spawnSync(process.execPath, [...(options.nodeArgs || []), ticketsScript, ...args], {
		cwd: options.cwd || repoRoot,
		env,
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

function writeValidTkForEnable(fixture) {
	const command = join(fixture.dir, "valid-tk-bin", "tk");
	mkdirSync(dirname(command), { recursive: true });
	writeValidTkLikeCommand(command);
	return command;
}

function ticketEnableArgs(fixture, settings, extraArgs = []) {
	return [
		"--settings", settings,
		"--agent-dir", fixture.agent,
		...extraArgs,
		"--install-path", writeValidTkForEnable(fixture),
		"enable",
	];
}

const fixtureTicketSourceUrl = "https://example.test/wedow-ticket.tar.gz";

function unsafeTicketSourceArgs({ checksum, archiveEntry = "ticket-0.3.2/ticket" }) {
	return [
		"--unsafe-test-ticket-source-url", fixtureTicketSourceUrl,
		"--unsafe-test-ticket-source-sha256", checksum,
		"--unsafe-test-ticket-archive-entry", archiveEntry,
	];
}

function createTicketArchive(fixture, { ticketContent } = {}) {
	const archiveSource = join(fixture.dir, "archive-source");
	const root = join(archiveSource, "ticket-0.3.2");
	mkdirSync(root, { recursive: true });
	const ticket = join(root, "ticket");
	const content = ticketContent || `#!/usr/bin/env bash
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
`;
	writeFileSync(ticket, content);
	chmodSync(ticket, 0o755);
	writeFileSync(join(root, "extra"), "must not be installed");

	const archivePath = join(fixture.dir, "ticket.tar.gz");
	const tarResult = spawnSync("tar", ["-czf", archivePath, "-C", archiveSource, "ticket-0.3.2"], { encoding: "utf8" });
	assert.equal(tarResult.status, 0, tarResult.stderr || String(tarResult.error));
	return { archivePath, checksum: sha256File(archivePath), ticketContent: readFileSync(ticket, "utf8") };
}

function writePoisonCommand(dir, name, sentinel) {
	mkdirSync(dir, { recursive: true });
	const commandPath = join(dir, name);
	writeFileSync(commandPath, `#!/bin/sh
printf intercepted > ${JSON.stringify(sentinel)}
exit 88
`);
	chmodSync(commandPath, 0o755);
}

function writeFetchPreload(fixture) {
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


export {
	assert,
	spawnSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	statSync,
	symlinkSync,
	writeFileSync,
	tmpdir,
	dirname,
	join,
	resolve,
	repoRoot,
	ticketsScript,
	runTickets,
	tempFixture,
	symlinkDirectory,
	sha256File,
	writeValidTkLikeCommand,
	writeValidTkForEnable,
	ticketEnableArgs,
	fixtureTicketSourceUrl,
	unsafeTicketSourceArgs,
	createTicketArchive,
	writePoisonCommand,
	writeFetchPreload,
	writeSwapTargetParentBeforeOpenPreload,
	writeFetchAndSwapTargetParentBeforeOpenPreload,
	writeSwapParentBeforeMkdirPreload,
	writeSwapParentAfterMkdirPreload,
	writeFetchAndSwapParentBeforeMkdirPreload,
	writeSwapSettingsBackupParentBeforeOpenPreload,
	writeSwapSettingsParentBeforeRealpathPreload,
	writeFetchAndSwapTargetParentBeforeSecondRealpathPreload,
	writeSwapAgentRootBeforeLstatPreload,
};

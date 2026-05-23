import assert from "node:assert/strict";
import fs, { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createSafeTlhProfileWritePlan, writeSafeTlhProfileFile } from "../scripts/lib/tlh-profile-writes.mjs";

const repoRoot = join(import.meta.dirname, "..");

function tempFixture(t) {
	const dir = mkdtempSync(join(tmpdir(), "tlh-profile-writes-test-"));
	const home = join(dir, "home");
	const agent = join(dir, "agent");
	const external = join(dir, "external");
	mkdirSync(home, { recursive: true });
	mkdirSync(agent, { recursive: true });
	mkdirSync(external, { recursive: true });
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return { dir, home, agent, external };
}

function symlinkDirectory(target, path) {
	symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

function symlinkFile(target, path) {
	symlinkSync(target, path, process.platform === "win32" ? "file" : "file");
}

function patchFs(t, overrides) {
	const original = new Map();
	for (const [name, value] of Object.entries(overrides)) {
		const originalValue = fs[name];
		original.set(name, originalValue);
		if (name === "realpathSync" && typeof value === "function" && typeof originalValue?.native === "function" && typeof value.native !== "function") {
			value.native = (...args) => value(...args);
		}
		fs[name] = value;
	}
	syncBuiltinESMExports();
	t.after(() => {
		for (const [name, value] of original.entries()) {
			fs[name] = value;
		}
		syncBuiltinESMExports();
	});
}

test("copied profile write helper resolves its installed sibling dependency", async (t) => {
	const fixture = tempFixture(t);
	const supportLibDir = join(fixture.agent, "tlh", "lib");
	mkdirSync(supportLibDir, { recursive: true });
	copyFileSync(join(repoRoot, "scripts", "lib", "tlh-profile-writes.mjs"), join(supportLibDir, "tlh-profile-writes.mjs"));
	copyFileSync(join(repoRoot, "scripts", "lib", "tlh-install-paths.mjs"), join(supportLibDir, "tlh-install-paths.mjs"));

	const helper = await import(pathToFileURL(join(supportLibDir, "tlh-profile-writes.mjs")).href);
	assert.equal(typeof helper.createSafeTlhProfileWritePlan, "function");
	assert.equal(typeof helper.writeSafeTlhProfileFile, "function");
});

test("safe TLH profile writes reject normal Pi config targets before creating them", (t) => {
	const fixture = tempFixture(t);
	const protectedAgent = join(fixture.home, ".pi", "agent");
	const protectedTarget = join(protectedAgent, "settings.json");

	assert.throws(
		() => createSafeTlhProfileWritePlan({
			agentDir: protectedAgent,
			homeDir: fixture.home,
			label: "settings",
			targetPath: protectedTarget,
		}),
		/refusing to write settings profile root under normal Pi config root/i,
	);
	assert.equal(existsSync(join(fixture.home, ".pi")), false);
});

test("safe TLH profile writes reject symlinked TLH profile roots", { skip: process.platform === "win32" }, (t) => {
	const fixture = tempFixture(t);
	const linkedAgent = join(fixture.dir, "agent-link");
	symlinkDirectory(fixture.agent, linkedAgent);

	assert.throws(
		() => createSafeTlhProfileWritePlan({
			agentDir: linkedAgent,
			homeDir: fixture.home,
			label: "settings",
			targetPath: join(linkedAgent, "settings.json"),
		}),
		/symlinked TLH profile root/i,
	);
});

test("safe TLH profile writes reject symlinked target parents", { skip: process.platform === "win32" }, (t) => {
	const fixture = tempFixture(t);
	const linkedParent = join(fixture.agent, "config");
	symlinkDirectory(fixture.external, linkedParent);

	assert.throws(
		() => createSafeTlhProfileWritePlan({
			agentDir: fixture.agent,
			homeDir: fixture.home,
			label: "settings",
			targetPath: join(linkedParent, "settings.json"),
		}),
		/symlinked target parent component/i,
	);
});

test("safe TLH profile writes reject symlinked final targets", { skip: process.platform === "win32" }, (t) => {
	const fixture = tempFixture(t);
	const target = join(fixture.agent, "settings.json");
	const sentinel = join(fixture.external, "sentinel-settings.json");
	writeFileSync(sentinel, "do-not-touch");
	symlinkFile(sentinel, target);

	assert.throws(
		() => createSafeTlhProfileWritePlan({
			agentDir: fixture.agent,
			homeDir: fixture.home,
			label: "settings",
			targetPath: target,
		}),
		/symlinked path/i,
	);
	assert.equal(readFileSync(sentinel, "utf8"), "do-not-touch");
});

test("safe TLH profile writes reject rewriting hard-linked targets", (t) => {
	const fixture = tempFixture(t);
	const target = join(fixture.agent, "settings.json");
	const linkedCopy = join(fixture.agent, "settings-linked.json");
	writeFileSync(target, "original\n");
	linkSync(target, linkedCopy);

	const plan = createSafeTlhProfileWritePlan({
		agentDir: fixture.agent,
		homeDir: fixture.home,
		label: "settings",
		targetPath: target,
	});
	assert.throws(
		() => writeSafeTlhProfileFile(plan, "new\n", { mode: 0o600 }),
		/hard links/i,
	);
	assert.equal(readFileSync(target, "utf8"), "original\n");
	assert.equal(readFileSync(linkedCopy, "utf8"), "original\n");
});

test("safe TLH profile writes refuse parent swaps before mkdir and keep attacker-owned paths intact", { skip: process.platform === "win32" }, (t) => {
	const fixture = tempFixture(t);
	const target = join(fixture.agent, "nested", "child", "settings.json");
	const nested = dirname(dirname(target));
	const swappedParent = dirname(target);
	const externalSentinel = join(fixture.external, "sentinel.txt");
	writeFileSync(externalSentinel, "external sentinel");

	const originalMkdirSync = fs.mkdirSync;
	let sabotaged = false;
	patchFs(t, {
		mkdirSync(path, ...args) {
			const createdPath = String(path);
			const result = originalMkdirSync(path, ...args);
			if (!sabotaged && createdPath === swappedParent) {
				sabotaged = true;
				rmSync(createdPath, { recursive: true, force: true });
				symlinkDirectory(fixture.external, createdPath);
			}
			return result;
		},
	});

	const plan = createSafeTlhProfileWritePlan({
		agentDir: fixture.agent,
		homeDir: fixture.home,
		label: "settings",
		targetPath: target,
	});
	assert.throws(
		() => writeSafeTlhProfileFile(plan, "{}\n", { mode: 0o600 }),
		/symlinked directory component|outside the intended directory/i,
	);
	assert.equal(lstatSync(swappedParent).isSymbolicLink(), true);
	assert.equal(existsSync(nested), true);
	assert.equal(readFileSync(externalSentinel, "utf8"), "external sentinel");
});

test("safe TLH profile writes ignore a pre-created predictable temp symlink", { skip: process.platform === "win32" }, (t) => {
	const fixture = tempFixture(t);
	const target = join(fixture.agent, "settings.json");
	const oldTempPath = `${target}.tmp-${process.pid}`;
	const externalSentinel = join(fixture.external, "sentinel-settings.json");
	writeFileSync(externalSentinel, "original sentinel");
	symlinkFile(externalSentinel, oldTempPath);

	const plan = createSafeTlhProfileWritePlan({
		agentDir: fixture.agent,
		homeDir: fixture.home,
		label: "settings",
		targetPath: target,
	});
	writeSafeTlhProfileFile(plan, '{"ok":true}\n', { mode: 0o600 });

	assert.equal(readFileSync(target, "utf8"), '{"ok":true}\n');
	assert.equal(readFileSync(externalSentinel, "utf8"), "original sentinel");
	assert.equal(lstatSync(oldTempPath).isSymbolicLink(), true);
});

test("safe TLH profile writes refuse parent swaps before open and clean empty external files", { skip: process.platform === "win32" }, (t) => {
	const fixture = tempFixture(t);
	const parent = join(fixture.agent, "config");
	mkdirSync(parent, { recursive: true });
	const target = join(parent, "settings.json");
	const externalSentinel = join(fixture.external, "sentinel.txt");
	writeFileSync(externalSentinel, "external sentinel");

	const originalOpenSync = fs.openSync;
	let sabotaged = false;
	patchFs(t, {
		openSync(path, flags, mode) {
			const pathString = String(path);
			if (!sabotaged && pathString === target) {
				sabotaged = true;
				rmSync(parent, { recursive: true, force: true });
				symlinkDirectory(fixture.external, parent);
			}
			return originalOpenSync(path, flags, mode);
		},
	});

	const plan = createSafeTlhProfileWritePlan({
		agentDir: fixture.agent,
		homeDir: fixture.home,
		label: "settings",
		targetPath: target,
	});
	assert.throws(
		() => writeSafeTlhProfileFile(plan, '{"ok":true}\n', { mode: 0o600 }),
		/symlinked target parent|outside the intended target parent|outside the intended TLH profile/i,
	);
	assert.deepEqual(readdirSync(fixture.external), ["sentinel.txt"]);
	assert.equal(readFileSync(externalSentinel, "utf8"), "external sentinel");
});

test("safe TLH profile writes refuse parent swaps before realpath without touching external files", { skip: process.platform === "win32" }, (t) => {
	const fixture = tempFixture(t);
	const parent = join(fixture.agent, "config");
	mkdirSync(parent, { recursive: true });
	const target = join(parent, "settings.json");
	const externalTarget = join(fixture.external, "settings.json");
	writeFileSync(externalTarget, "external sentinel");

	const originalRealpathSync = fs.realpathSync;
	let sabotaged = false;
	patchFs(t, {
		realpathSync(path, ...args) {
			const pathString = String(path);
			if (!sabotaged && pathString === target) {
				sabotaged = true;
				rmSync(parent, { recursive: true, force: true });
				symlinkDirectory(fixture.external, parent);
			}
			return originalRealpathSync(path, ...args);
		},
	});

	const plan = createSafeTlhProfileWritePlan({
		agentDir: fixture.agent,
		homeDir: fixture.home,
		label: "settings",
		targetPath: target,
	});
	assert.throws(
		() => writeSafeTlhProfileFile(plan, '{"ok":true}\n', { mode: 0o600 }),
		/outside the intended directory|ENOENT|no such file/i,
	);
	assert.equal(readFileSync(externalTarget, "utf8"), "external sentinel");
});

test("safe TLH profile writes set requested modes for new and rewritten files", { skip: process.platform === "win32" }, (t) => {
	const fixture = tempFixture(t);
	const target = join(fixture.agent, "settings.json");
	const plan = createSafeTlhProfileWritePlan({
		agentDir: fixture.agent,
		homeDir: fixture.home,
		label: "settings",
		targetPath: target,
	});

	writeSafeTlhProfileFile(plan, '{"step":1}\n', { mode: 0o600 });
	assert.equal(statSync(target).mode & 0o777, 0o600);
	assert.equal(readFileSync(target, "utf8"), '{"step":1}\n');

	writeSafeTlhProfileFile(plan, '{"step":2}\n', { mode: 0o640, replace: true });
	assert.equal(statSync(target).mode & 0o777, 0o640);
	assert.equal(readFileSync(target, "utf8"), '{"step":2}\n');
});

test("safe TLH profile writes tighten existing file mode before truncating rewritten content", { skip: process.platform === "win32" }, (t) => {
	const fixture = tempFixture(t);
	const target = join(fixture.agent, "settings.json");
	writeFileSync(target, "original\n", { mode: 0o666 });
	const plan = createSafeTlhProfileWritePlan({
		agentDir: fixture.agent,
		homeDir: fixture.home,
		label: "settings",
		targetPath: target,
	});

	const originalFtruncateSync = fs.ftruncateSync;
	let observed = false;
	patchFs(t, {
		ftruncateSync(fd, len) {
			observed = true;
			assert.equal(statSync(target).mode & 0o777, 0o600);
			assert.equal(readFileSync(target, "utf8"), "original\n");
			return originalFtruncateSync(fd, len);
		},
	});

	writeSafeTlhProfileFile(plan, '{"step":2}\n', { mode: 0o600, replace: true });
	assert.equal(observed, true);
	assert.equal(statSync(target).mode & 0o777, 0o600);
	assert.equal(readFileSync(target, "utf8"), '{"step":2}\n');
});

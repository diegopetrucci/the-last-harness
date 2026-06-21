import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const gnosisScript = join(repoRoot, "scripts", "tlh-gnosis.mjs");

function runGnosis(args, options = {}) {
	return spawnSync(process.execPath, [...(options.nodeArgs || []), gnosisScript, ...args], {
		cwd: repoRoot,
		env: { ...process.env, ...(options.env || {}) },
		encoding: "utf8",
	});
}

function tempFixture() {
	const dir = mkdtempSync(join(tmpdir(), "tlh-gnosis-test-"));
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

function writeUnsupportedPlatformPreload(fixture, { platform = "freebsd", arch = "x64" } = {}) {
	const preload = join(fixture.dir, "unsupported-platform.mjs");
	writeFileSync(preload, [
		`Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });`,
		`Object.defineProperty(process, "arch", { value: ${JSON.stringify(arch)} });`,
		"",
	].join("\n"));
	return preload;
}

function gnosisAssetName(version) {
	let os;
	if (process.platform === "darwin") os = "darwin";
	else if (process.platform === "linux") os = "linux";
	else return undefined;

	let arch;
	if (process.arch === "arm64") arch = "arm64";
	else if (process.arch === "x64") arch = "amd64";
	else return undefined;

	return `gnosis_${version}_${os}_${arch}.tar.gz`;
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("install-managed dry-run uses the pinned default Gnosis release", () => {
	const fixture = tempFixture();

	const result = runGnosis([
		"--agent-dir", fixture.agent,
		"--target", join(fixture.agent, "bin", "gn"),
		"--dry-run",
		"install-managed",
	], { env: { HOME: fixture.home } });

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /Would download Gnosis 0\.5\.3 from https:\/\/github\.com\/skorokithakis\/gnosis/);
	assert.equal(result.stdout.trim(), join(fixture.agent, "bin", "gn"));
});

test("install-managed dry-run still honors TLH_GNOSIS_VERSION and CLI overrides", () => {
	const fixture = tempFixture();
	const target = join(fixture.agent, "bin", "gn");

	const envOverride = runGnosis([
		"--agent-dir", fixture.agent,
		"--target", target,
		"--dry-run",
		"install-managed",
	], {
		env: { HOME: fixture.home, TLH_GNOSIS_VERSION: "latest" },
	});
	assert.equal(envOverride.status, 0, envOverride.stderr);
	assert.match(envOverride.stderr, /Would download latest compatible release from https:\/\/github\.com\/skorokithakis\/gnosis/);

	const cliOverride = runGnosis([
		"--agent-dir", fixture.agent,
		"--target", target,
		"--gnosis-version", "0.5.2",
		"--dry-run",
		"install-managed",
	], { env: { HOME: fixture.home, TLH_GNOSIS_VERSION: "latest" } });
	assert.equal(cliOverride.status, 0, cliOverride.stderr);
	assert.match(cliOverride.stderr, /Would download Gnosis 0\.5\.2 from https:\/\/github\.com\/skorokithakis\/gnosis/);
});

test("install-managed rejects agent bin symlink before network or writes", () => {
	const fixture = tempFixture();
	symlinkDirectory(fixture.external, join(fixture.agent, "bin"));

	const fetchSentinel = join(fixture.dir, "fetch-called");
	const preload = join(fixture.dir, "fail-fetch.mjs");
	writeFileSync(preload, `import { writeFileSync } from "node:fs";\nglobalThis.fetch = async () => {\n\twriteFileSync(${JSON.stringify(fetchSentinel)}, "called");\n\tthrow new Error("fetch should not be called");\n};\n`);

	const result = runGnosis([
		"--agent-dir", fixture.agent,
		"--target", join(fixture.agent, "bin", "gn"),
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

test("install-managed rejects agent bin symlink during dry-run", () => {
	const fixture = tempFixture();
	symlinkDirectory(fixture.external, join(fixture.agent, "bin"));

	const result = runGnosis([
		"--agent-dir", fixture.agent,
		"--target", join(fixture.agent, "bin", "gn"),
		"--dry-run",
		"install-managed",
	], { env: { HOME: fixture.home } });

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /symlinked target parent component/i);
	assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Would install Gnosis/i);
	assert.deepEqual(readdirSync(fixture.external), []);
});

test("install-managed fails on unsupported platforms before dry-run output", () => {
	const fixture = tempFixture();
	const preload = writeUnsupportedPlatformPreload(fixture);

	const result = runGnosis([
		"--agent-dir", fixture.agent,
		"--target", join(fixture.agent, "bin", "gn"),
		"--dry-run",
		"install-managed",
	], {
		env: { HOME: fixture.home },
		nodeArgs: ["--import", preload],
	});

	assert.notEqual(result.status, 0);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /Unsupported platform for managed Gnosis install: freebsd\/x64\. Prebuilt gn binaries are only available for darwin\/linux on x64\/arm64\./);
	assert.doesNotMatch(result.stderr, /warning:/i);
	assert.doesNotMatch(result.stderr, /Would install Gnosis/i);
});

test("configure-install fails on unsupported platforms when automatic install would be required", () => {
	const fixture = tempFixture();
	const preload = writeUnsupportedPlatformPreload(fixture);

	const result = runGnosis([
		"--agent-dir", fixture.agent,
		"--target", join(fixture.agent, "bin", "gn"),
		"configure-install",
	], {
		env: { HOME: fixture.home, PATH: "" },
		nodeArgs: ["--import", preload],
	});

	assert.notEqual(result.status, 0);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /Unsupported platform for managed Gnosis install: freebsd\/x64\. Prebuilt gn binaries are only available for darwin\/linux on x64\/arm64\./);
	assert.doesNotMatch(result.stderr, /warning:/i);
});

test("install-managed revalidates target before creating swapped parent directories", { skip: process.platform === "win32" || !gnosisAssetName("1.2.3") }, () => {
	const fixture = tempFixture();
	const version = "1.2.3";
	const assetName = gnosisAssetName(version);
	const target = join(fixture.agent, "bin", "nested", "gn");

	const archiveSource = join(fixture.dir, "archive-source");
	mkdirSync(archiveSource, { recursive: true });
	const gn = join(archiveSource, "gn");
	writeFileSync(gn, `#!/usr/bin/env node\nconst first = process.argv[2];\nconst second = process.argv[3];\nprocess.exit(first === "help" && ["plan", "review"].includes(second) ? 0 : 1);\n`);
	chmodSync(gn, 0o755);

	const archivePath = join(fixture.dir, assetName);
	const tarResult = spawnSync("tar", ["-czf", archivePath, "-C", archiveSource, "gn"], { encoding: "utf8" });
	assert.equal(tarResult.status, 0, tarResult.stderr || String(tarResult.error));
	const checksum = sha256File(archivePath);

	const preload = join(fixture.dir, "swap-target-parent.mjs");
	writeFileSync(preload, `import { readFileSync, symlinkSync } from "node:fs";\nconst archive = readFileSync(process.env.TLH_TEST_ARCHIVE);\nconst archiveBytes = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength);\nconst checksums = \`${checksum}  ${assetName}\\n\`;\nglobalThis.fetch = async (url) => {\n\tif (String(url).endsWith("/checksums.txt")) {\n\t\tsymlinkSync(process.env.TLH_TEST_EXTERNAL_DIR, process.env.TLH_TEST_SWAP_LINK, "dir");\n\t\treturn { ok: true, status: 200, statusText: "OK", text: async () => checksums };\n\t}\n\treturn { ok: true, status: 200, statusText: "OK", arrayBuffer: async () => archiveBytes };\n};\n`);

	const result = runGnosis([
		"--agent-dir", fixture.agent,
		"--target", target,
		"--gnosis-version", version,
		"install-managed",
	], {
		env: {
			HOME: fixture.home,
			TLH_TEST_ARCHIVE: archivePath,
			TLH_TEST_EXTERNAL_DIR: fixture.external,
			TLH_TEST_SWAP_LINK: join(fixture.agent, "bin"),
		},
		nodeArgs: ["--import", preload],
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /symlinked target parent component/i);
	assert.equal(lstatSync(join(fixture.agent, "bin")).isSymbolicLink(), true);
	assert.deepEqual(readdirSync(fixture.external), []);
});

test("install-managed rejects dry-run target spelled through a symlinked agent path", () => {
	const fixture = tempFixture();
	const agentLink = join(fixture.dir, "agent-link");
	symlinkDirectory(fixture.agent, agentLink);

	const result = runGnosis([
		"--agent-dir", fixture.agent,
		"--target", join(agentLink, "bin", "gn"),
		"--dry-run",
		"install-managed",
	], { env: { HOME: fixture.home } });

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /outside the configured tlh profile path/i);
	assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Would install Gnosis/i);
});

test("install-managed ignores a pre-existing predictable temp symlink", { skip: process.platform === "win32" || !gnosisAssetName("1.2.3") }, () => {
	const fixture = tempFixture();
	const version = "1.2.3";
	const assetName = gnosisAssetName(version);
	const target = join(fixture.agent, "bin", "gn");
	const externalVictim = join(fixture.external, "victim");
	const predictableLinkSentinel = join(fixture.dir, "predictable-link");
	writeFileSync(externalVictim, "do-not-touch");
	chmodSync(externalVictim, 0o600);

	const archiveSource = join(fixture.dir, "archive-source");
	mkdirSync(archiveSource, { recursive: true });
	const gn = join(archiveSource, "gn");
	writeFileSync(gn, `#!/usr/bin/env node\nconst first = process.argv[2];\nconst second = process.argv[3];\nprocess.exit(first === "help" && ["plan", "review"].includes(second) ? 0 : 1);\n`);
	chmodSync(gn, 0o755);

	const archivePath = join(fixture.dir, assetName);
	const tarResult = spawnSync("tar", ["-czf", archivePath, "-C", archiveSource, "gn"], { encoding: "utf8" });
	assert.equal(tarResult.status, 0, tarResult.stderr || String(tarResult.error));
	const checksum = sha256File(archivePath);

	const preload = join(fixture.dir, "stub-managed-install.mjs");
	writeFileSync(preload, `import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";\nimport { dirname } from "node:path";\nconst target = process.env.TLH_TEST_TARGET;\nconst predictableLink = \`${"${target}"}.tmp.${"${process.pid}"}\`;\nmkdirSync(dirname(target), { recursive: true });\nsymlinkSync(process.env.TLH_TEST_EXTERNAL_VICTIM, predictableLink);\nwriteFileSync(process.env.TLH_TEST_PREDICTABLE_LINK_SENTINEL, predictableLink);\nconst archive = readFileSync(process.env.TLH_TEST_ARCHIVE);\nconst archiveBytes = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength);\nconst checksums = \`${checksum}  ${assetName}\\n\`;\nglobalThis.fetch = async (url) => {\n\tif (String(url).endsWith("/checksums.txt")) {\n\t\treturn { ok: true, status: 200, statusText: "OK", text: async () => checksums };\n\t}\n\treturn { ok: true, status: 200, statusText: "OK", arrayBuffer: async () => archiveBytes };\n};\n`);

	const result = runGnosis([
		"--agent-dir", fixture.agent,
		"--target", target,
		"--gnosis-version", version,
		"install-managed",
	], {
		env: {
			HOME: fixture.home,
			TLH_TEST_ARCHIVE: archivePath,
			TLH_TEST_EXTERNAL_VICTIM: externalVictim,
			TLH_TEST_PREDICTABLE_LINK_SENTINEL: predictableLinkSentinel,
			TLH_TEST_TARGET: target,
		},
		nodeArgs: ["--import", preload],
	});

	assert.equal(result.status, 0, result.stderr);
	const predictableLink = readFileSync(predictableLinkSentinel, "utf8");
	assert.equal(lstatSync(predictableLink).isSymbolicLink(), true);
	assert.equal(lstatSync(target).isSymbolicLink(), false);
	assert.equal(readFileSync(externalVictim, "utf8"), "do-not-touch");
	assert.equal(statSync(externalVictim).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(dirname(target)).filter((entry) => entry.startsWith(".tlh-gnosis-")), []);
});

test("configure-install rejects a managed target whose parent is symlinked", () => {
	const fixture = tempFixture();
	const managedTarget = join(fixture.agent, "bin", "gn");
	symlinkDirectory(fixture.external, join(fixture.agent, "bin"));

	const linkedGn = join(fixture.external, "gn");
	const gnSentinel = join(fixture.dir, "gn-called");
	writeFileSync(linkedGn, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.GN_SENTINEL, "called");\nconst [, , first, second] = process.argv;\nprocess.exit(first === "help" && ["plan", "review"].includes(second) ? 0 : 1);\n`);
	chmodSync(linkedGn, 0o755);

	const fetchSentinel = join(fixture.dir, "fetch-called");
	const preload = join(fixture.dir, "fail-fetch.mjs");
	writeFileSync(preload, `import { writeFileSync } from "node:fs";\nglobalThis.fetch = async () => {\n\twriteFileSync(${JSON.stringify(fetchSentinel)}, "called");\n\tthrow new Error("fetch should not be called");\n};\n`);

	const result = runGnosis([
		"--agent-dir", fixture.agent,
		"--target", managedTarget,
		"configure-install",
	], {
		env: { GN_SENTINEL: gnSentinel, HOME: fixture.home },
		nodeArgs: ["--import", preload],
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /symlinked target parent component/i);
	assert.equal(existsSync(gnSentinel), false);
	assert.equal(existsSync(fetchSentinel), false);
	assert.deepEqual(readdirSync(fixture.external), ["gn"]);
});

test("configure-install rejects a managed target spelled through a symlinked agent path", () => {
	const fixture = tempFixture();
	const agentLink = join(fixture.dir, "agent-link");
	symlinkDirectory(fixture.agent, agentLink);
	symlinkDirectory(fixture.external, join(fixture.agent, "bin"));

	const linkedGn = join(fixture.external, "gn");
	const gnSentinel = join(fixture.dir, "gn-called");
	writeFileSync(linkedGn, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.GN_SENTINEL, "called");\nconst [, , first, second] = process.argv;\nprocess.exit(first === "help" && ["plan", "review"].includes(second) ? 0 : 1);\n`);
	chmodSync(linkedGn, 0o755);

	const fetchSentinel = join(fixture.dir, "fetch-called");
	const preload = join(fixture.dir, "fail-fetch.mjs");
	writeFileSync(preload, `import { writeFileSync } from "node:fs";\nglobalThis.fetch = async () => {\n\twriteFileSync(${JSON.stringify(fetchSentinel)}, "called");\n\tthrow new Error("fetch should not be called");\n};\n`);

	const result = runGnosis([
		"--agent-dir", agentLink,
		"configure-install",
	], {
		env: { GN_SENTINEL: gnSentinel, HOME: fixture.home },
		nodeArgs: ["--import", preload],
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /symlinked target parent component/i);
	assert.equal(existsSync(gnSentinel), false);
	assert.equal(existsSync(fetchSentinel), false);
	assert.deepEqual(readdirSync(fixture.external), ["gn"]);
});

test("configure-install honors TLH_SKIP_GNOSIS_INSTALL", () => {
	const fixture = tempFixture();

	const result = runGnosis([
		"--agent-dir", fixture.agent,
		"configure-install",
	], { env: { HOME: fixture.home, TLH_SKIP_GNOSIS_INSTALL: "1" } });

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Gnosis integration: skipped/);
});

test("configure-install exits non-zero when release fetch fails", { skip: !gnosisAssetName("1.2.3") }, () => {
	const fixture = tempFixture();

	// Preload overrides fetch so every request throws, simulating an unreachable release host.
	const preload = join(fixture.dir, "fail-fetch-configure.mjs");
	writeFileSync(preload, [
		"globalThis.fetch = async (url) => {",
		"\tthrow new Error(`simulated fetch failure for configure-install: ${url}`);",
		"};",
		"",
	].join("\n"));

	const result = runGnosis([
		"--agent-dir", fixture.agent,
		"configure-install",
	], {
		env: { HOME: fixture.home, PATH: "" },
		nodeArgs: ["--import", preload],
	});

	// Must exit non-zero.
	assert.notEqual(result.status, 0);
	// Must NOT print the ready line.
	assert.doesNotMatch(result.stdout, /Gnosis integration: ready/);
	// Must NOT print the old "not ready" success line.
	assert.doesNotMatch(result.stdout, /Gnosis integration: not ready/);
	// Must print a clear error on stderr.
	assert.match(result.stderr, /error:.*[Gg]nosis/);
});

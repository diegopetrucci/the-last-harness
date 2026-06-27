import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const rtkScript = join(repoRoot, "scripts", "tlh-rtk.mjs");
const skipManagedBinaryTests = process.platform === "win32";

function runRtk(args, options = {}) {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key === "PI_CODING_AGENT_DIR" || key.startsWith("TLH_")) delete env[key];
	}
	Object.assign(env, options.env || {});

	return spawnSync(process.execPath, [...(options.nodeArgs || []), rtkScript, ...args], {
		cwd: options.cwd || repoRoot,
		env,
		encoding: "utf8",
	});
}

function tempFixture() {
	const dir = mkdtempSync(join(tmpdir(), "tlh-rtk-test-"));
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

function writeMockRtk(path, {
	version = "0.42.4",
	rewriteOutput = "rtk git status",
	rewriteStatus = 0,
	extraComment = "",
} = {}) {
	writeFileSync(path, `#!/bin/sh
${extraComment ? `# ${extraComment}\n` : ""}case "\${1:-}" in
  --version)
    echo "rtk ${version}"
    exit 0
    ;;
  rewrite)
    shift
    if [ "\${1:-}" = "git" ] && [ "\${2:-}" = "status" ] && [ "$#" -eq 2 ]; then
      printf '%s' ${JSON.stringify(rewriteOutput)}
      exit ${rewriteStatus}
    fi
    exit 1
    ;;
  *)
    exit 1
    ;;
esac
`);
	chmodSync(path, 0o755);
}

function createRtkArchive(fixture, options = {}) {
	const archiveSource = join(fixture.dir, `archive-source-${Math.random().toString(16).slice(2)}`);
	mkdirSync(archiveSource, { recursive: true });
	const rtk = join(archiveSource, "rtk");
	writeMockRtk(rtk, options);

	const assetName = options.assetName || "rtk-test.tar.gz";
	const archivePath = join(fixture.dir, assetName);
	const tarResult = spawnSync("tar", ["-czf", archivePath, "-C", archiveSource, "rtk"], { encoding: "utf8" });
	assert.equal(tarResult.status, 0, tarResult.stderr || String(tarResult.error));
	return {
		archivePath,
		assetName,
		assetSha256: sha256File(archivePath),
		binarySha256: sha256File(rtk),
	};
}

function writeFakeTar(path, sentinelPath) {
	writeFileSync(path, `#!/bin/sh
printf '%s\n' "$0 $*" > ${JSON.stringify(sentinelPath)}
exit 99
`);
	chmodSync(path, 0o755);
}

function unsafeRtkArgs({
	version = "0.42.4",
	assetName,
	assetSha256,
	binarySha256,
	downloadUrl = "https://example.test/rtk-test.tar.gz",
}) {
	return [
		"--unsafe-test-rtk-version", version,
		"--unsafe-test-download-url", downloadUrl,
		"--unsafe-test-asset-name", assetName,
		"--unsafe-test-asset-sha256", assetSha256,
		"--unsafe-test-binary-sha256", binarySha256,
	];
}

function writeFetchPreload(fixture) {
	const preload = join(fixture.dir, "stub-rtk-fetch.mjs");
	writeFileSync(preload, `import { readFileSync, writeFileSync } from "node:fs";
const archive = readFileSync(process.env.TLH_TEST_ARCHIVE);
const archiveBytes = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength);
globalThis.fetch = async (url) => {
	if (process.env.TLH_TEST_FETCH_SENTINEL) writeFileSync(process.env.TLH_TEST_FETCH_SENTINEL, String(url));
	return { ok: true, status: 200, statusText: "OK", arrayBuffer: async () => archiveBytes };
};
`);
	return preload;
}

function writeFailFetchPreload(fixture) {
	const preload = join(fixture.dir, "fail-rtk-fetch.mjs");
	writeFileSync(preload, `import { writeFileSync } from "node:fs";
globalThis.fetch = async (url) => {
	writeFileSync(process.env.TLH_TEST_FETCH_SENTINEL, String(url));
	throw new Error("fetch should not be called");
};
`);
	return preload;
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

test("install-managed refreshes a checksum-drifted managed RTK binary to the pinned version and validation behavior", { skip: skipManagedBinaryTests }, () => {
	const fixture = tempFixture();
	const target = join(fixture.agent, "bin", "rtk");
	mkdirSync(dirname(target), { recursive: true });
	writeMockRtk(target, { extraComment: "old-managed-copy" });
	const previousChecksum = sha256File(target);

	const archive = createRtkArchive(fixture);
	const preload = writeFetchPreload(fixture);
	const result = runRtk([
		"--agent-dir", fixture.agent,
		"--target", target,
		...unsafeRtkArgs(archive),
		"install-managed",
	], {
		env: {
			HOME: fixture.home,
			TLH_TEST_ARCHIVE: archive.archivePath,
		},
		nodeArgs: ["--import", preload],
	});

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), target);
	assert.notEqual(sha256File(target), previousChecksum);
	assert.equal(sha256File(target), archive.binarySha256);
	assert.deepEqual(readdirSync(dirname(target)).filter((entry) => entry.startsWith(".tlh-rtk-")), []);

	const version = spawnSync(target, ["--version"], { encoding: "utf8" });
	assert.equal(version.status, 0, version.stderr);
	assert.equal(version.stdout.trim(), "rtk 0.42.4");

	const rewrite = spawnSync(target, ["rewrite", "git", "status"], { encoding: "utf8" });
	assert.equal(rewrite.status, 0, rewrite.stderr);
	assert.equal(rewrite.stdout, "rtk git status");
});

test("install-managed ignores an untrusted tar earlier in PATH during archive list and extract", { skip: skipManagedBinaryTests }, () => {
	const fixture = tempFixture();
	const archive = createRtkArchive(fixture);
	const preload = writeFetchPreload(fixture);
	const target = join(fixture.agent, "bin", "rtk");
	const fakeBin = join(fixture.dir, "fake-bin");
	const fakeTarSentinel = join(fixture.dir, "fake-tar-called");
	mkdirSync(fakeBin, { recursive: true });
	writeFakeTar(join(fakeBin, "tar"), fakeTarSentinel);

	const result = runRtk([
		"--agent-dir", fixture.agent,
		"--target", target,
		...unsafeRtkArgs(archive),
		"install-managed",
	], {
		env: {
			HOME: fixture.home,
			PATH: [fakeBin, process.env.PATH || ""].filter(Boolean).join(delimiter),
			TLH_TEST_ARCHIVE: archive.archivePath,
		},
		nodeArgs: ["--import", preload],
	});

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), target);
	assert.equal(existsSync(fakeTarSentinel), false);
	assert.equal(sha256File(target), archive.binarySha256);
});

test("install-managed fails when the downloaded RTK archive checksum does not match the embedded pin", { skip: skipManagedBinaryTests }, () => {
	const fixture = tempFixture();
	const archive = createRtkArchive(fixture);
	const preload = writeFetchPreload(fixture);
	const target = join(fixture.agent, "bin", "rtk");

	const mismatchedAssetSha256 = `${archive.assetSha256[0] === "0" ? "1" : "0"}${archive.assetSha256.slice(1)}`;
	const result = runRtk([
		"--agent-dir", fixture.agent,
		"--target", target,
		...unsafeRtkArgs({
			...archive,
			assetSha256: mismatchedAssetSha256,
		}),
		"install-managed",
	], {
		env: {
			HOME: fixture.home,
			TLH_TEST_ARCHIVE: archive.archivePath,
		},
		nodeArgs: ["--import", preload],
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /RTK archive checksum verification failed/i);
	assert.equal(existsSync(target), false);
});

test("install-managed fails when the pinned RTK binary does not satisfy rewrite validation", { skip: skipManagedBinaryTests }, () => {
	const fixture = tempFixture();
	const archive = createRtkArchive(fixture, { rewriteOutput: "rtk git diff" });
	const preload = writeFetchPreload(fixture);
	const target = join(fixture.agent, "bin", "rtk");

	const result = runRtk([
		"--agent-dir", fixture.agent,
		"--target", target,
		...unsafeRtkArgs(archive),
		"install-managed",
	], {
		env: {
			HOME: fixture.home,
			TLH_TEST_ARCHIVE: archive.archivePath,
		},
		nodeArgs: ["--import", preload],
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /downloaded RTK binary did not validate/i);
	assert.equal(existsSync(target), false);
});

test("install-managed rejects a symlinked managed bin path before fetch or writes", { skip: skipManagedBinaryTests }, () => {
	const fixture = tempFixture();
	symlinkDirectory(fixture.external, join(fixture.agent, "bin"));
	const fetchSentinel = join(fixture.dir, "fetch-called");
	const preload = writeFailFetchPreload(fixture);

	const result = runRtk([
		"--agent-dir", fixture.agent,
		"--target", join(fixture.agent, "bin", "rtk"),
		"install-managed",
	], {
		env: {
			HOME: fixture.home,
			TLH_TEST_FETCH_SENTINEL: fetchSentinel,
		},
		nodeArgs: ["--import", preload],
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /symlinked target parent component/i);
	assert.equal(existsSync(fetchSentinel), false);
	assert.deepEqual(readdirSync(fixture.external), []);
});

test("install-managed fails on unsupported platforms before dry-run output", () => {
	const fixture = tempFixture();
	const preload = writeUnsupportedPlatformPreload(fixture);

	const result = runRtk([
		"--agent-dir", fixture.agent,
		"--target", join(fixture.agent, "bin", "rtk"),
		"--dry-run",
		"install-managed",
	], {
		env: { HOME: fixture.home },
		nodeArgs: ["--import", preload],
	});

	assert.notEqual(result.status, 0);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /Unsupported platform for managed RTK install: freebsd\/x64\. Prebuilt rtk binaries are only supported for darwin\/linux on x64\/arm64\./);
	assert.doesNotMatch(result.stderr, /Would install RTK/i);
});

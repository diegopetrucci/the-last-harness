import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const checkPackageVersionsScript = join(repoRoot, "scripts", "check-package-versions.mjs");

function tempFixture({ packageVersion, lockfileVersion = packageVersion, rootPackageVersion = packageVersion }) {
	const dir = mkdtempSync(join(tmpdir(), "tlh-check-package-versions-test-"));
	const packagePath = join(dir, "package.json");
	const lockfilePath = join(dir, "package-lock.json");

	writeFileSync(packagePath, `${JSON.stringify({ name: "fixture", version: packageVersion }, null, 2)}\n`);
	writeFileSync(lockfilePath, `${JSON.stringify({
		name: "fixture",
		version: lockfileVersion,
		lockfileVersion: 3,
		packages: {
			"": {
				name: "fixture",
				version: rootPackageVersion,
			},
		},
	}, null, 2)}\n`);

	return { packagePath, lockfilePath };
}

function runCheckPackageVersions(fixture) {
	return spawnSync(process.execPath, [
		checkPackageVersionsScript,
		"--package", fixture.packagePath,
		"--lockfile", fixture.lockfilePath,
	], {
		cwd: repoRoot,
		encoding: "utf8",
	});
}

test("check-package-versions passes when package metadata versions match", () => {
	const fixture = tempFixture({ packageVersion: "1.2.3" });

	const result = runCheckPackageVersions(fixture);

	assert.equal(result.status, 0);
	assert.match(result.stdout, /all tracked version fields match \(1\.2\.3\)/);
	assert.equal(result.stderr, "");
});

test("check-package-versions reports the mismatched file fields", () => {
	const fixture = tempFixture({
		packageVersion: "1.2.3",
		lockfileVersion: "1.2.4",
		rootPackageVersion: "1.2.3",
	});

	const result = runCheckPackageVersions(fixture);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /Version metadata mismatch/);
	assert.match(result.stderr, /package\.json#version: "1\.2\.3"/);
	assert.match(result.stderr, /package-lock\.json#version: "1\.2\.4"/);
	assert.match(result.stderr, /package-lock\.json#packages\[""\]\.version: "1\.2\.3"/);
});

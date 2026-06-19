import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const checkPackageVersionsScript = join(repoRoot, "scripts", "check-package-versions.mjs");

function tempFixture({
	packageVersion,
	lockfileVersion = packageVersion,
	rootPackageVersion = packageVersion,
	dependencies = {},
	devDependencies = {},
	peerDependencies = {},
	defaultExtensions = [{ id: "helper", source: "npm:helper@1.2.3" }],
	gnosisVersion = "0.5.3",
	installVersion = gnosisVersion,
	includeLatestReleaseUrl = true,
} = {}) {
	const dir = mkdtempSync(join(tmpdir(), "tlh-check-package-versions-test-"));
	const packagePath = join(dir, "package.json");
	const lockfilePath = join(dir, "package-lock.json");
	const defaultExtensionsPath = join(dir, "default-extensions.json");
	const gnosisScriptPath = join(dir, "tlh-gnosis.mjs");
	const installScriptPath = join(dir, "tlh-install.mjs");

	writeFileSync(packagePath, `${JSON.stringify({
		name: "fixture",
		version: packageVersion,
		dependencies,
		devDependencies,
		peerDependencies,
	}, null, 2)}\n`);
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
	writeFileSync(defaultExtensionsPath, `${JSON.stringify(defaultExtensions, null, 2)}\n`);
	writeFileSync(gnosisScriptPath, `const DEFAULT_GNOSIS_VERSION = ${JSON.stringify(gnosisVersion)};\n`);
	writeFileSync(installScriptPath, [
		`const DEFAULT_GNOSIS_VERSION = ${JSON.stringify(installVersion)};`,
		includeLatestReleaseUrl
			? 'const LATEST_RELEASE_URL = "https://github.com/example/the-last-harness/releases/latest/download/install.sh";'
			: "",
		"",
	].join("\n"));

	return { packagePath, lockfilePath, defaultExtensionsPath, gnosisScriptPath, installScriptPath };
}

function runCheckPackageVersions(fixture) {
	return spawnSync(process.execPath, [
		checkPackageVersionsScript,
		"--package", fixture.packagePath,
		"--lockfile", fixture.lockfilePath,
		"--default-extensions", fixture.defaultExtensionsPath,
		"--gnosis-script", fixture.gnosisScriptPath,
		"--gnosis-script", fixture.installScriptPath,
	], {
		cwd: repoRoot,
		encoding: "utf8",
	});
}

test("check-package-versions passes with pinned dependency exceptions and ignores allowed ranges/URLs", () => {
	const fixture = tempFixture({
		packageVersion: "1.2.3",
		dependencies: {
			eslint: "9.39.4",
			aliased: "npm:helper@1.2.3",
			githubHelper: "github:example/github-helper#v1.2.3",
			releaseHelper: "https://github.com/example/release-helper/releases/download/v1.2.3/release-helper-1.2.3.tgz",
			archiveTagHelper: "https://github.com/example/archive-tag-helper/archive/refs/tags/v1.2.3.tar.gz",
			workspaceHelper: "workspace:*",
		},
		devDependencies: {
			typescript: "6.0.3",
			fileHelper: "file:../file-helper",
			linkHelper: "link:../link-helper",
			zipballTagHelper: "https://github.com/example/zipball-tag-helper/zipball/refs/tags/v1.2.3",
			sshHelper: "git+ssh://git@github.com/example/ssh-helper.git#abcdef1234567",
		},
		peerDependencies: {
			"@earendil-works/pi-coding-agent": ">=0.79.1 <=0.79.7",
		},
		defaultExtensions: [
			{ id: "helper", source: "npm:helper@1.2.3" },
			{ id: "forked-helper", source: "git:github.com/example/helper@tlh-v1.2.3" },
		],
	});

	const result = runCheckPackageVersions(fixture);

	assert.equal(result.status, 0);
	assert.match(result.stdout, /all tracked version fields match \(1\.2\.3\), and managed dependency pins are valid/);
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

test("check-package-versions rejects loose dependencies and devDependencies", () => {
	const fixture = tempFixture({
		packageVersion: "1.2.3",
		dependencies: {
			eslint: "^9.39.4",
		},
		devDependencies: {
			typescript: "latest",
		},
		peerDependencies: {
			allowed: "^1.0.0",
		},
	});

	const result = runCheckPackageVersions(fixture);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /package\.json#dependencies\.eslint must use an exact version or pinned non-registry source, found "\^9\.39\.4"/);
	assert.match(result.stderr, /package\.json#devDependencies\.typescript must use an exact version or pinned non-registry source, found "latest"/);
	assert.doesNotMatch(result.stderr, /peerDependencies/);
});

test("check-package-versions rejects floating git/github/http/ssh package sources", () => {
	const fixture = tempFixture({
		packageVersion: "1.2.3",
		dependencies: {
			gitHelper: "git+https://github.com/example/git-helper.git",
			githubHelper: "github:example/github-helper",
			httpArchiveBranchHelper: "https://github.com/example/http-archive-branch-helper/archive/refs/heads/main.tar.gz",
		},
		devDependencies: {
			httpHelper: "https://github.com/example/http-helper/releases/latest/download/http-helper.tgz",
			httpTarballBranchHelper: "https://github.com/example/http-tarball-branch-helper/tarball/refs/heads/main",
			httpZipballBranchHelper: "https://github.com/example/http-zipball-branch-helper/zipball/refs/heads/main",
			sshHelper: "ssh://git@github.com/example/ssh-helper.git#main",
		},
	});

	const result = runCheckPackageVersions(fixture);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /package\.json#dependencies\.gitHelper must use an exact version or pinned non-registry source, found "git\+https:\/\/github\.com\/example\/git-helper\.git"/);
	assert.match(result.stderr, /package\.json#dependencies\.githubHelper must use an exact version or pinned non-registry source, found "github:example\/github-helper"/);
	assert.match(result.stderr, /package\.json#dependencies\.httpArchiveBranchHelper must use an exact version or pinned non-registry source, found "https:\/\/github\.com\/example\/http-archive-branch-helper\/archive\/refs\/heads\/main\.tar\.gz"/);
	assert.match(result.stderr, /package\.json#devDependencies\.httpHelper must use an exact version or pinned non-registry source, found "https:\/\/github\.com\/example\/http-helper\/releases\/latest\/download\/http-helper\.tgz"/);
	assert.match(result.stderr, /package\.json#devDependencies\.httpTarballBranchHelper must use an exact version or pinned non-registry source, found "https:\/\/github\.com\/example\/http-tarball-branch-helper\/tarball\/refs\/heads\/main"/);
	assert.match(result.stderr, /package\.json#devDependencies\.httpZipballBranchHelper must use an exact version or pinned non-registry source, found "https:\/\/github\.com\/example\/http-zipball-branch-helper\/zipball\/refs\/heads\/main"/);
	assert.match(result.stderr, /package\.json#devDependencies\.sshHelper must use an exact version or pinned non-registry source, found "ssh:\/\/git@github\.com\/example\/ssh-helper\.git#main"/);
});

test("check-package-versions rejects unversioned bundled npm defaults", () => {
	const fixture = tempFixture({
		packageVersion: "1.2.3",
		defaultExtensions: [
			{ id: "helper", source: "npm:helper" },
		],
	});

	const result = runCheckPackageVersions(fixture);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /default-extensions\.json#helper\.source must pin npm defaults to an exact version, found "npm:helper"/);
});

test("check-package-versions rejects bundled git defaults without refs", () => {
	const fixture = tempFixture({
		packageVersion: "1.2.3",
		defaultExtensions: [
			{ id: "forked-helper", source: "git:github.com/example/helper" },
		],
	});

	const result = runCheckPackageVersions(fixture);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /default-extensions\.json#forked-helper\.source must pin git defaults to an explicit ref, found "git:github\.com\/example\/helper"/);
});

test("check-package-versions rejects latest as the managed Gnosis default", () => {
	const fixture = tempFixture({
		packageVersion: "1.2.3",
		gnosisVersion: "latest",
		installVersion: "latest",
	});

	const result = runCheckPackageVersions(fixture);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /tlh-gnosis\.mjs#DEFAULT_GNOSIS_VERSION must use an exact version, found "latest"/);
	assert.match(result.stderr, /tlh-install\.mjs#DEFAULT_GNOSIS_VERSION must use an exact version, found "latest"/);
});

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const checkPackageVersionsScript = join(repoRoot, "scripts", "check-package-versions.mjs");
const FIXTURE_MANAGED_PI_VERSION = "9.8.7";
const FIXTURE_MANAGED_PI_DRIFT_VERSION = "9.8.6";
const FIXTURE_MANAGED_GNOSIS_VERSION = "4.5.6";
const FIXTURE_MANAGED_GNOSIS_DRIFT_VERSION = "4.5.5";

function tempFixture({
	packageVersion,
	lockfileVersion = packageVersion,
	rootPackageVersion = packageVersion,
	dependencies = {},
	devDependencies = {
		"@earendil-works/pi-coding-agent": FIXTURE_MANAGED_PI_VERSION,
		"@earendil-works/pi-tui": FIXTURE_MANAGED_PI_VERSION,
	},
	peerDependencies = {
		"@earendil-works/pi-coding-agent": FIXTURE_MANAGED_PI_VERSION,
		"@earendil-works/pi-tui": FIXTURE_MANAGED_PI_VERSION,
	},
	overrides = {},
	defaultExtensions = [{ id: "helper", source: "npm:helper@1.2.3" }],
	gnosisVersion = FIXTURE_MANAGED_GNOSIS_VERSION,
	gnosisMtsVersion = gnosisVersion,
	installVersion = gnosisVersion,
	installShPiVersion = FIXTURE_MANAGED_PI_VERSION,
	installMtsPiVersion = installShPiVersion,
	installMjsPiVersion = installShPiVersion,
	includeLatestReleaseUrl = true,
} = {}) {
	const dir = mkdtempSync(join(tmpdir(), "tlh-check-package-versions-test-"));
	const packagePath = join(dir, "package.json");
	const lockfilePath = join(dir, "package-lock.json");
	const defaultExtensionsPath = join(dir, "default-extensions.json");
	const installShPath = join(dir, "install.sh");
	const gnosisScriptMtsPath = join(dir, "tlh-gnosis.mts");
	const gnosisScriptPath = join(dir, "tlh-gnosis.mjs");
	const installMtsPath = join(dir, "tlh-install.mts");
	const installMjsPath = join(dir, "tlh-install.mjs");

	writeFileSync(packagePath, `${JSON.stringify({
		name: "fixture",
		version: packageVersion,
		dependencies,
		devDependencies: {
			"@earendil-works/pi-coding-agent": FIXTURE_MANAGED_PI_VERSION,
			"@earendil-works/pi-tui": FIXTURE_MANAGED_PI_VERSION,
			...devDependencies,
		},
		peerDependencies: {
			"@earendil-works/pi-coding-agent": FIXTURE_MANAGED_PI_VERSION,
			"@earendil-works/pi-tui": FIXTURE_MANAGED_PI_VERSION,
			...peerDependencies,
		},
		overrides,
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
	writeFileSync(installShPath, `TLH_PINNED_PI_VERSION=${JSON.stringify(installShPiVersion)}\n`);
	writeFileSync(gnosisScriptMtsPath, `const DEFAULT_GNOSIS_VERSION = ${JSON.stringify(gnosisMtsVersion)};\n`);
	writeFileSync(gnosisScriptPath, `const DEFAULT_GNOSIS_VERSION = ${JSON.stringify(gnosisVersion)};\n`);
	writeFileSync(installMtsPath, [
		`const PINNED_PI_VERSION = ${JSON.stringify(installMtsPiVersion)};`,
		"",
	].join("\n"));
	writeFileSync(installMjsPath, [
		`const PINNED_PI_VERSION = ${JSON.stringify(installMjsPiVersion)};`,
		`const DEFAULT_GNOSIS_VERSION = ${JSON.stringify(installVersion)};`,
		includeLatestReleaseUrl
			? 'const LATEST_RELEASE_URL = "https://github.com/example/the-last-harness/releases/latest/download/install.sh";'
			: "",
		"",
	].join("\n"));

	return { packagePath, lockfilePath, defaultExtensionsPath, installShPath, gnosisScriptMtsPath, gnosisScriptPath, installMtsPath, installMjsPath };
}

function runCheckPackageVersions(fixture) {
	return spawnSync(process.execPath, [
		checkPackageVersionsScript,
		"--package", fixture.packagePath,
		"--lockfile", fixture.lockfilePath,
		"--default-extensions", fixture.defaultExtensionsPath,
		"--install-sh", fixture.installShPath,
		"--gnosis-script", fixture.gnosisScriptMtsPath,
		"--gnosis-script", fixture.gnosisScriptPath,
		"--gnosis-script", fixture.installMjsPath,
		"--pi-install-script", fixture.installMtsPath,
		"--pi-install-script", fixture.installMjsPath,
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
			githubExplicitTagHelper: "github:example/github-explicit-tag-helper#refs/tags/v1.2.3",
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
			"@earendil-works/pi-coding-agent": FIXTURE_MANAGED_PI_VERSION,
			"@earendil-works/pi-tui": FIXTURE_MANAGED_PI_VERSION,
		},
		overrides: {
			dompurify: "3.4.11",
			"parent-package": {
				"child-package": "1.2.3",
				"aliased-child-package": "npm:replacement-package@1.2.3",
			},
		},
		defaultExtensions: [
			{ id: "helper", source: "npm:helper@1.2.3" },
			{ id: "forked-helper", source: "git:github.com/example/helper@tlh-v1.2.3" },
			{ id: "forked-helper-explicit-tag", source: "git:github.com/example/helper-explicit-tag@refs/tags/v1.2.3" },
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

test("check-package-versions rejects loose dependencies, devDependencies, and overrides", () => {
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
		overrides: {
			dompurify: "^3.4.11",
			"parent-package": {
				"child-package": "^1.2.3",
				"aliased-child-package": "npm:replacement-package@^1.2.3",
			},
		},
	});

	const result = runCheckPackageVersions(fixture);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /package\.json#dependencies\.eslint must use an exact version or pinned non-registry source, found "\^9\.39\.4"/);
	assert.match(result.stderr, /package\.json#devDependencies\.typescript must use an exact version or pinned non-registry source, found "latest"/);
	assert.match(result.stderr, /package\.json#overrides\.dompurify must use an exact version or pinned non-registry source, found "\^3\.4\.11"/);
	assert.match(result.stderr, /package\.json#overrides\.parent-package\.child-package must use an exact version or pinned non-registry source, found "\^1\.2\.3"/);
	assert.match(result.stderr, /package\.json#overrides\.parent-package\.aliased-child-package must use an exact version or pinned non-registry source, found "npm:replacement-package@\^1\.2\.3"/);
	assert.doesNotMatch(result.stderr, /peerDependencies/);
});

test("check-package-versions rejects floating and branch-like git/github/http/ssh package refs", () => {
	const fixture = tempFixture({
		packageVersion: "1.2.3",
		dependencies: {
			gitHelper: "git+https://github.com/example/git-helper.git",
			githubHelper: "github:example/github-helper",
			githubDevelopHelper: "github:example/github-develop-helper#develop",
			githubExplicitTagMainHelper: "github:example/github-explicit-tag-main-helper#refs/tags/main",
			gitFeatureHelper: "git+https://github.com/example/git-feature-helper.git#feature/foo",
			httpArchiveBranchHelper: "https://github.com/example/http-archive-branch-helper/archive/refs/heads/main.tar.gz",
		},
		devDependencies: {
			httpHelper: "https://github.com/example/http-helper/releases/latest/download/http-helper.tgz",
			httpReleaseHelper: "https://github.com/example/http-release-helper/releases/download/release-2026/http-release-helper.tgz",
			httpTarballBranchHelper: "https://github.com/example/http-tarball-branch-helper/tarball/refs/heads/main",
			httpZipballTagBranchHelper: "https://github.com/example/http-zipball-tag-branch-helper/zipball/refs/tags/feature/foo",
			httpZipballBranchHelper: "https://github.com/example/http-zipball-branch-helper/zipball/HEAD",
			sshHelper: "ssh://git@github.com/example/ssh-helper.git#heads/main",
		},
	});

	const result = runCheckPackageVersions(fixture);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /package\.json#dependencies\.gitHelper must use an exact version or pinned non-registry source, found "git\+https:\/\/github\.com\/example\/git-helper\.git"/);
	assert.match(result.stderr, /package\.json#dependencies\.githubHelper must use an exact version or pinned non-registry source, found "github:example\/github-helper"/);
	assert.match(result.stderr, /package\.json#dependencies\.githubDevelopHelper must use an exact version or pinned non-registry source, found "github:example\/github-develop-helper#develop"/);
	assert.match(result.stderr, /package\.json#dependencies\.githubExplicitTagMainHelper must use an exact version or pinned non-registry source, found "github:example\/github-explicit-tag-main-helper#refs\/tags\/main"/);
	assert.match(result.stderr, /package\.json#dependencies\.gitFeatureHelper must use an exact version or pinned non-registry source, found "git\+https:\/\/github\.com\/example\/git-feature-helper\.git#feature\/foo"/);
	assert.match(result.stderr, /package\.json#dependencies\.httpArchiveBranchHelper must use an exact version or pinned non-registry source, found "https:\/\/github\.com\/example\/http-archive-branch-helper\/archive\/refs\/heads\/main\.tar\.gz"/);
	assert.match(result.stderr, /package\.json#devDependencies\.httpHelper must use an exact version or pinned non-registry source, found "https:\/\/github\.com\/example\/http-helper\/releases\/latest\/download\/http-helper\.tgz"/);
	assert.match(result.stderr, /package\.json#devDependencies\.httpReleaseHelper must use an exact version or pinned non-registry source, found "https:\/\/github\.com\/example\/http-release-helper\/releases\/download\/release-2026\/http-release-helper\.tgz"/);
	assert.match(result.stderr, /package\.json#devDependencies\.httpTarballBranchHelper must use an exact version or pinned non-registry source, found "https:\/\/github\.com\/example\/http-tarball-branch-helper\/tarball\/refs\/heads\/main"/);
	assert.match(result.stderr, /package\.json#devDependencies\.httpZipballTagBranchHelper must use an exact version or pinned non-registry source, found "https:\/\/github\.com\/example\/http-zipball-tag-branch-helper\/zipball\/refs\/tags\/feature\/foo"/);
	assert.match(result.stderr, /package\.json#devDependencies\.httpZipballBranchHelper must use an exact version or pinned non-registry source, found "https:\/\/github\.com\/example\/http-zipball-branch-helper\/zipball\/HEAD"/);
	assert.match(result.stderr, /package\.json#devDependencies\.sshHelper must use an exact version or pinned non-registry source, found "ssh:\/\/git@github\.com\/example\/ssh-helper\.git#heads\/main"/);
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

test("check-package-versions rejects bundled default sources that are neither npm nor git", () => {
	const fixture = tempFixture({
		packageVersion: "1.2.3",
		defaultExtensions: [
			{ id: "local-helper", source: "./extensions/local-helper" },
		],
	});

	const result = runCheckPackageVersions(fixture);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /default-extensions\.json#local-helper\.source must use a pinned npm or git source, found "\.\/extensions\/local-helper"/);
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

test("check-package-versions rejects bundled git defaults pinned to branch-like refs", () => {
	const fixture = tempFixture({
		packageVersion: "1.2.3",
		defaultExtensions: [
			{ id: "forked-helper-main", source: "git:github.com/example/helper-main@main" },
			{ id: "forked-helper-develop", source: "git:github.com/example/helper-develop@develop" },
			{ id: "forked-helper-explicit-tag-main", source: "git:github.com/example/helper-explicit-tag-main@refs/tags/main" },
			{ id: "forked-helper-feature", source: "git:github.com/example/helper-feature@feature/foo" },
			{ id: "forked-helper-explicit-tag-feature", source: "git:github.com/example/helper-explicit-tag-feature@refs/tags/feature/foo" },
			{ id: "forked-helper-release", source: "git:github.com/example/helper-release@release-2026" },
		],
	});

	const result = runCheckPackageVersions(fixture);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /default-extensions\.json#forked-helper-main\.source must pin git defaults to a tag- or commit-like ref, found "git:github\.com\/example\/helper-main@main"/);
	assert.match(result.stderr, /default-extensions\.json#forked-helper-develop\.source must pin git defaults to a tag- or commit-like ref, found "git:github\.com\/example\/helper-develop@develop"/);
	assert.match(result.stderr, /default-extensions\.json#forked-helper-explicit-tag-main\.source must pin git defaults to a tag- or commit-like ref, found "git:github\.com\/example\/helper-explicit-tag-main@refs\/tags\/main"/);
	assert.match(result.stderr, /default-extensions\.json#forked-helper-feature\.source must pin git defaults to a tag- or commit-like ref, found "git:github\.com\/example\/helper-feature@feature\/foo"/);
	assert.match(result.stderr, /default-extensions\.json#forked-helper-explicit-tag-feature\.source must pin git defaults to a tag- or commit-like ref, found "git:github\.com\/example\/helper-explicit-tag-feature@refs\/tags\/feature\/foo"/);
	assert.match(result.stderr, /default-extensions\.json#forked-helper-release\.source must pin git defaults to a tag- or commit-like ref, found "git:github\.com\/example\/helper-release@release-2026"/);
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

test("check-package-versions rejects managed Gnosis version drift in the TypeScript source", () => {
	const fixture = tempFixture({
		packageVersion: "1.2.3",
		gnosisMtsVersion: FIXTURE_MANAGED_GNOSIS_DRIFT_VERSION,
	});

	const result = runCheckPackageVersions(fixture);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /Managed Gnosis defaults must stay in sync:/);
	assert.match(result.stderr, /tlh-gnosis\.mts: "4\.5\.5"/);
	assert.match(result.stderr, /tlh-gnosis\.mjs: "4\.5\.6"/);
});


test("check-package-versions rejects managed Pi pin drift across package metadata and install sources", () => {
	const fixture = tempFixture({
		packageVersion: "1.2.3",
		installMtsPiVersion: FIXTURE_MANAGED_PI_DRIFT_VERSION,
	});

	const result = runCheckPackageVersions(fixture);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /Managed Pi pins must stay in sync:/);
	assert.match(result.stderr, /package\.json#peerDependencies\.@earendil-works\/pi-coding-agent: "9\.8\.7"/);
	assert.match(result.stderr, /tlh-install\.mts#PINNED_PI_VERSION: "9\.8\.6"/);
});

test("check-package-versions rejects non-exact managed Pi package pins", () => {
	const fixture = tempFixture({
		packageVersion: "1.2.3",
		peerDependencies: {
			"@earendil-works/pi-coding-agent": `^${FIXTURE_MANAGED_PI_VERSION}`,
			"@earendil-works/pi-tui": FIXTURE_MANAGED_PI_VERSION,
		},
	});

	const result = runCheckPackageVersions(fixture);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /package\.json#peerDependencies\.@earendil-works\/pi-coding-agent must use an exact version, found "\^9\.8\.7"/);
});

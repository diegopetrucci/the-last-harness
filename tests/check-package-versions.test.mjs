import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";

const _tmpDirs = [];
after(() => {
  for (const d of _tmpDirs) rmSync(d, { recursive: true, force: true });
});

const repoRoot = resolve(import.meta.dirname, "..");
const checkPackageVersionsScript = join(repoRoot, "scripts", "check-package-versions.mjs");
const FIXTURE_MANAGED_PI_VERSION = "9.8.7";
const FIXTURE_MANAGED_PI_DRIFT_VERSION = "9.8.6";
const FIXTURE_MANAGED_TYPEBOX_VERSION = "1.3.7";
const FIXTURE_MANAGED_TYPEBOX_DRIFT_VERSION = "1.3.6";
const FIXTURE_MANAGED_GNOSIS_VERSION = "4.5.6";
const FIXTURE_MANAGED_GNOSIS_DRIFT_VERSION = "4.5.5";
const EXACT_VERSION_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function resolvedRegistryVersion(spec) {
  const trimmed = String(spec ?? "").trim();
  if (EXACT_VERSION_RE.test(trimmed)) return trimmed;
  if (!trimmed.startsWith("npm:")) return undefined;

  const separator = trimmed.lastIndexOf("@");
  const version = separator === -1 ? "" : trimmed.slice(separator + 1);
  return EXACT_VERSION_RE.test(version) ? version : undefined;
}

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
    typebox: "*",
  },
  overrides = {},
  defaultExtensions = [{ id: "helper", source: "npm:helper@1.2.3" }],
  gnosisVersion = FIXTURE_MANAGED_GNOSIS_VERSION,
  gnosisMtsVersion = gnosisVersion,
  installVersion = gnosisVersion,
  installShPiVersion = FIXTURE_MANAGED_PI_VERSION,
  installMtsPiVersion = installShPiVersion,
  installMjsPiVersion = installShPiVersion,
  modelSelectionScopeVersion = installMtsPiVersion,
  piTypeboxVersion = FIXTURE_MANAGED_TYPEBOX_VERSION,
  includeLatestReleaseUrl = true,
  installedVersions = {},
  missingInstalledPackages = [],
  missingLockfilePackages = [],
  lockfileDependencyVersions = {},
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tlh-check-package-versions-test-"));
  _tmpDirs.push(dir);
  const packagePath = join(dir, "package.json");
  const lockfilePath = join(dir, "package-lock.json");
  const defaultExtensionsPath = join(dir, "default-extensions.json");
  const installShPath = join(dir, "install.sh");
  const modelSelectionScopePath = join(dir, "model-selection-scope.ts");
  const gnosisScriptMtsPath = join(dir, "tlh-gnosis.mts");
  const gnosisScriptPath = join(dir, "tlh-gnosis.mjs");
  const installMtsPath = join(dir, "tlh-install.mts");
  const installMjsPath = join(dir, "tlh-install.mjs");

  const packageJson = {
    name: "fixture",
    version: packageVersion,
    dependencies: {
      ...dependencies,
    },
    devDependencies: {
      "@earendil-works/pi-agent-core": FIXTURE_MANAGED_PI_VERSION,
      "@earendil-works/pi-ai": FIXTURE_MANAGED_PI_VERSION,
      "@earendil-works/pi-coding-agent": FIXTURE_MANAGED_PI_VERSION,
      "@earendil-works/pi-tui": FIXTURE_MANAGED_PI_VERSION,
      typebox: FIXTURE_MANAGED_TYPEBOX_VERSION,
      ...devDependencies,
    },
    peerDependencies: {
      "@earendil-works/pi-coding-agent": FIXTURE_MANAGED_PI_VERSION,
      "@earendil-works/pi-tui": FIXTURE_MANAGED_PI_VERSION,
      ...peerDependencies,
    },
    overrides,
  };
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  const lockPackages = {
    "": {
      name: "fixture",
      version: rootPackageVersion,
      dependencies: packageJson.dependencies,
      devDependencies: packageJson.devDependencies,
      peerDependencies: packageJson.peerDependencies,
    },
  };
  for (const field of ["dependencies", "devDependencies"]) {
    for (const [name, spec] of Object.entries(packageJson[field])) {
      const resolvedVersion = lockfileDependencyVersions[name] ?? resolvedRegistryVersion(spec);
      if (resolvedVersion === undefined) continue;
      lockPackages[`node_modules/${name}`] = { version: resolvedVersion };
    }
  }
  lockPackages["node_modules/@earendil-works/pi-coding-agent"] = {
    ...lockPackages["node_modules/@earendil-works/pi-coding-agent"],
    dependencies: { typebox: piTypeboxVersion },
  };
  for (const name of missingLockfilePackages) {
    delete lockPackages[`node_modules/${name}`];
  }

  writeFileSync(
    lockfilePath,
    `${JSON.stringify(
      {
        name: "fixture",
        version: lockfileVersion,
        lockfileVersion: 3,
        packages: lockPackages,
      },
      null,
      2,
    )}\n`,
  );

  const nodeModulesDir = join(dir, "node_modules");
  const seenInstalledPackages = new Set();
  for (const field of ["dependencies", "devDependencies"]) {
    for (const [name] of Object.entries(packageJson[field])) {
      if (seenInstalledPackages.has(name)) continue;
      const expectedVersion = lockPackages[`node_modules/${name}`]?.version;
      if (typeof expectedVersion !== "string") continue;
      seenInstalledPackages.add(name);
      if (missingInstalledPackages.includes(name)) continue;

      const packageDir = join(nodeModulesDir, name);
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(
        join(packageDir, "package.json"),
        `${JSON.stringify({ name, version: installedVersions[name] ?? expectedVersion })}\n`,
      );
    }
  }
  writeFileSync(defaultExtensionsPath, `${JSON.stringify(defaultExtensions, null, 2)}\n`);
  writeFileSync(installShPath, `TLH_PINNED_PI_VERSION=${JSON.stringify(installShPiVersion)}\n`);
  writeFileSync(
    gnosisScriptMtsPath,
    `const DEFAULT_GNOSIS_VERSION = ${JSON.stringify(gnosisMtsVersion)};\n`,
  );
  writeFileSync(
    gnosisScriptPath,
    `const DEFAULT_GNOSIS_VERSION = ${JSON.stringify(gnosisVersion)};\n`,
  );
  writeFileSync(
    installMtsPath,
    [`const PINNED_PI_VERSION = ${JSON.stringify(installMtsPiVersion)};`, ""].join("\n"),
  );
  writeFileSync(
    modelSelectionScopePath,
    [`const PINNED_PI_VERSION = ${JSON.stringify(modelSelectionScopeVersion)};`, ""].join("\n"),
  );
  writeFileSync(
    installMjsPath,
    [
      `const PINNED_PI_VERSION = ${JSON.stringify(installMjsPiVersion)};`,
      `const DEFAULT_GNOSIS_VERSION = ${JSON.stringify(installVersion)};`,
      includeLatestReleaseUrl
        ? 'const LATEST_RELEASE_URL = "https://github.com/example/the-last-harness/releases/latest/download/install.sh";'
        : "",
      "",
    ].join("\n"),
  );

  return {
    packagePath,
    lockfilePath,
    defaultExtensionsPath,
    installShPath,
    modelSelectionScopePath,
    gnosisScriptMtsPath,
    gnosisScriptPath,
    installMtsPath,
    installMjsPath,
    nodeModulesDir,
  };
}

function runCheckPackageVersions(fixture, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [
      checkPackageVersionsScript,
      "--package",
      fixture.packagePath,
      "--lockfile",
      fixture.lockfilePath,
      "--default-extensions",
      fixture.defaultExtensionsPath,
      "--install-sh",
      fixture.installShPath,
      "--model-selection-scope",
      fixture.modelSelectionScopePath,
      "--gnosis-script",
      fixture.gnosisScriptMtsPath,
      "--gnosis-script",
      fixture.gnosisScriptPath,
      "--gnosis-script",
      fixture.installMjsPath,
      "--pi-install-script",
      fixture.installMtsPath,
      "--pi-install-script",
      fixture.installMjsPath,
      "--node-modules-dir",
      fixture.nodeModulesDir,
      // Skip runtime manifest check unless the caller provides a fixture dir
      "--runtime-manifest-dir",
      "",
      ...extraArgs,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
}

test("check-package-versions passes with pinned dependency exceptions and ignores allowed ranges/URLs", () => {
  const fixture = tempFixture({
    packageVersion: "1.2.3",
    dependencies: {
      eslint: "9.39.4",
      aliased: "npm:helper@1.2.3",
      githubHelper: "github:example/github-helper#v1.2.3",
      githubExplicitTagHelper: "github:example/github-explicit-tag-helper#refs/tags/v1.2.3",
      releaseHelper:
        "https://github.com/example/release-helper/releases/download/v1.2.3/release-helper-1.2.3.tgz",
      archiveTagHelper:
        "https://github.com/example/archive-tag-helper/archive/refs/tags/v1.2.3.tar.gz",
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
      typebox: "*",
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
      {
        id: "forked-helper-explicit-tag",
        source: "git:github.com/example/helper-explicit-tag@refs/tags/v1.2.3",
      },
    ],
  });

  const result = runCheckPackageVersions(fixture);

  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /all tracked version fields match \(1\.2\.3\), and managed dependency pins are valid/,
  );
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
      typebox: "*",
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
  assert.match(
    result.stderr,
    /package\.json#dependencies\.eslint must use an exact version or pinned non-registry source, found "\^9\.39\.4"/,
  );
  assert.match(
    result.stderr,
    /package\.json#devDependencies\.typescript must use an exact version or pinned non-registry source, found "latest"/,
  );
  assert.match(
    result.stderr,
    /package\.json#overrides\.dompurify must use an exact version or pinned non-registry source, found "\^3\.4\.11"/,
  );
  assert.match(
    result.stderr,
    /package\.json#overrides\.parent-package\.child-package must use an exact version or pinned non-registry source, found "\^1\.2\.3"/,
  );
  assert.match(
    result.stderr,
    /package\.json#overrides\.parent-package\.aliased-child-package must use an exact version or pinned non-registry source, found "npm:replacement-package@\^1\.2\.3"/,
  );
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
      httpArchiveBranchHelper:
        "https://github.com/example/http-archive-branch-helper/archive/refs/heads/main.tar.gz",
    },
    devDependencies: {
      httpHelper: "https://github.com/example/http-helper/releases/latest/download/http-helper.tgz",
      httpReleaseHelper:
        "https://github.com/example/http-release-helper/releases/download/release-2026/http-release-helper.tgz",
      httpTarballBranchHelper:
        "https://github.com/example/http-tarball-branch-helper/tarball/refs/heads/main",
      httpZipballTagBranchHelper:
        "https://github.com/example/http-zipball-tag-branch-helper/zipball/refs/tags/feature/foo",
      httpZipballBranchHelper: "https://github.com/example/http-zipball-branch-helper/zipball/HEAD",
      sshHelper: "ssh://git@github.com/example/ssh-helper.git#heads/main",
    },
  });

  const result = runCheckPackageVersions(fixture);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /package\.json#dependencies\.gitHelper must use an exact version or pinned non-registry source, found "git\+https:\/\/github\.com\/example\/git-helper\.git"/,
  );
  assert.match(
    result.stderr,
    /package\.json#dependencies\.githubHelper must use an exact version or pinned non-registry source, found "github:example\/github-helper"/,
  );
  assert.match(
    result.stderr,
    /package\.json#dependencies\.githubDevelopHelper must use an exact version or pinned non-registry source, found "github:example\/github-develop-helper#develop"/,
  );
  assert.match(
    result.stderr,
    /package\.json#dependencies\.githubExplicitTagMainHelper must use an exact version or pinned non-registry source, found "github:example\/github-explicit-tag-main-helper#refs\/tags\/main"/,
  );
  assert.match(
    result.stderr,
    /package\.json#dependencies\.gitFeatureHelper must use an exact version or pinned non-registry source, found "git\+https:\/\/github\.com\/example\/git-feature-helper\.git#feature\/foo"/,
  );
  assert.match(
    result.stderr,
    /package\.json#dependencies\.httpArchiveBranchHelper must use an exact version or pinned non-registry source, found "https:\/\/github\.com\/example\/http-archive-branch-helper\/archive\/refs\/heads\/main\.tar\.gz"/,
  );
  assert.match(
    result.stderr,
    /package\.json#devDependencies\.httpHelper must use an exact version or pinned non-registry source, found "https:\/\/github\.com\/example\/http-helper\/releases\/latest\/download\/http-helper\.tgz"/,
  );
  assert.match(
    result.stderr,
    /package\.json#devDependencies\.httpReleaseHelper must use an exact version or pinned non-registry source, found "https:\/\/github\.com\/example\/http-release-helper\/releases\/download\/release-2026\/http-release-helper\.tgz"/,
  );
  assert.match(
    result.stderr,
    /package\.json#devDependencies\.httpTarballBranchHelper must use an exact version or pinned non-registry source, found "https:\/\/github\.com\/example\/http-tarball-branch-helper\/tarball\/refs\/heads\/main"/,
  );
  assert.match(
    result.stderr,
    /package\.json#devDependencies\.httpZipballTagBranchHelper must use an exact version or pinned non-registry source, found "https:\/\/github\.com\/example\/http-zipball-tag-branch-helper\/zipball\/refs\/tags\/feature\/foo"/,
  );
  assert.match(
    result.stderr,
    /package\.json#devDependencies\.httpZipballBranchHelper must use an exact version or pinned non-registry source, found "https:\/\/github\.com\/example\/http-zipball-branch-helper\/zipball\/HEAD"/,
  );
  assert.match(
    result.stderr,
    /package\.json#devDependencies\.sshHelper must use an exact version or pinned non-registry source, found "ssh:\/\/git@github\.com\/example\/ssh-helper\.git#heads\/main"/,
  );
});

test("check-package-versions rejects unversioned bundled npm defaults", () => {
  const fixture = tempFixture({
    packageVersion: "1.2.3",
    defaultExtensions: [{ id: "helper", source: "npm:helper" }],
  });

  const result = runCheckPackageVersions(fixture);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /default-extensions\.json#helper\.source must pin npm defaults to an exact version, found "npm:helper"/,
  );
});

test("check-package-versions rejects bundled default sources that are neither npm nor git", () => {
  const fixture = tempFixture({
    packageVersion: "1.2.3",
    defaultExtensions: [{ id: "local-helper", source: "./extensions/local-helper" }],
  });

  const result = runCheckPackageVersions(fixture);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /default-extensions\.json#local-helper\.source must use a pinned npm or git source, found "\.\/extensions\/local-helper"/,
  );
});

test("check-package-versions rejects bundled git defaults without refs", () => {
  const fixture = tempFixture({
    packageVersion: "1.2.3",
    defaultExtensions: [{ id: "forked-helper", source: "git:github.com/example/helper" }],
  });

  const result = runCheckPackageVersions(fixture);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /default-extensions\.json#forked-helper\.source must pin git defaults to an explicit ref, found "git:github\.com\/example\/helper"/,
  );
});

test("check-package-versions rejects bundled git defaults pinned to branch-like refs", () => {
  const fixture = tempFixture({
    packageVersion: "1.2.3",
    defaultExtensions: [
      { id: "forked-helper-main", source: "git:github.com/example/helper-main@main" },
      { id: "forked-helper-develop", source: "git:github.com/example/helper-develop@develop" },
      {
        id: "forked-helper-explicit-tag-main",
        source: "git:github.com/example/helper-explicit-tag-main@refs/tags/main",
      },
      { id: "forked-helper-feature", source: "git:github.com/example/helper-feature@feature/foo" },
      {
        id: "forked-helper-explicit-tag-feature",
        source: "git:github.com/example/helper-explicit-tag-feature@refs/tags/feature/foo",
      },
      { id: "forked-helper-release", source: "git:github.com/example/helper-release@release-2026" },
    ],
  });

  const result = runCheckPackageVersions(fixture);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /default-extensions\.json#forked-helper-main\.source must pin git defaults to a tag- or commit-like ref, found "git:github\.com\/example\/helper-main@main"/,
  );
  assert.match(
    result.stderr,
    /default-extensions\.json#forked-helper-develop\.source must pin git defaults to a tag- or commit-like ref, found "git:github\.com\/example\/helper-develop@develop"/,
  );
  assert.match(
    result.stderr,
    /default-extensions\.json#forked-helper-explicit-tag-main\.source must pin git defaults to a tag- or commit-like ref, found "git:github\.com\/example\/helper-explicit-tag-main@refs\/tags\/main"/,
  );
  assert.match(
    result.stderr,
    /default-extensions\.json#forked-helper-feature\.source must pin git defaults to a tag- or commit-like ref, found "git:github\.com\/example\/helper-feature@feature\/foo"/,
  );
  assert.match(
    result.stderr,
    /default-extensions\.json#forked-helper-explicit-tag-feature\.source must pin git defaults to a tag- or commit-like ref, found "git:github\.com\/example\/helper-explicit-tag-feature@refs\/tags\/feature\/foo"/,
  );
  assert.match(
    result.stderr,
    /default-extensions\.json#forked-helper-release\.source must pin git defaults to a tag- or commit-like ref, found "git:github\.com\/example\/helper-release@release-2026"/,
  );
});

test("check-package-versions rejects latest as the managed Gnosis default", () => {
  const fixture = tempFixture({
    packageVersion: "1.2.3",
    gnosisVersion: "latest",
    installVersion: "latest",
  });

  const result = runCheckPackageVersions(fixture);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /tlh-gnosis\.mjs#DEFAULT_GNOSIS_VERSION must use an exact version, found "latest"/,
  );
  assert.match(
    result.stderr,
    /tlh-install\.mjs#DEFAULT_GNOSIS_VERSION must use an exact version, found "latest"/,
  );
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
  assert.match(
    result.stderr,
    /package\.json#peerDependencies\.@earendil-works\/pi-coding-agent: "9\.8\.7"/,
  );
  assert.match(result.stderr, /tlh-install\.mts#PINNED_PI_VERSION: "9\.8\.6"/);
});

test("check-package-versions rejects model-selection scope Pi pin drift", () => {
  const fixture = tempFixture({
    packageVersion: "1.2.3",
    modelSelectionScopeVersion: FIXTURE_MANAGED_PI_DRIFT_VERSION,
  });

  const result = runCheckPackageVersions(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Managed Pi pins must stay in sync:/);
  assert.match(result.stderr, /model-selection-scope\.ts#PINNED_PI_VERSION: "9\.8\.6"/);
});

test("check-package-versions manages direct Pi type dependencies with the shared Pi pin", () => {
  const fixture = tempFixture({
    packageVersion: "1.2.3",
    devDependencies: {
      "@earendil-works/pi-agent-core": FIXTURE_MANAGED_PI_DRIFT_VERSION,
      "@earendil-works/pi-ai": FIXTURE_MANAGED_PI_VERSION,
    },
  });

  const result = runCheckPackageVersions(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Managed Pi pins must stay in sync:/);
  assert.match(
    result.stderr,
    /package\.json#devDependencies\.@earendil-works\/pi-agent-core: "9\.8\.6"/,
  );
  assert.match(result.stderr, /package\.json#devDependencies\.@earendil-works\/pi-ai: "9\.8\.7"/);
});

test("check-package-versions rejects typebox in dependencies (host-provided by Pi)", () => {
  const fixture = tempFixture({
    packageVersion: "1.2.3",
    dependencies: { typebox: FIXTURE_MANAGED_TYPEBOX_VERSION },
  });

  const result = runCheckPackageVersions(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /package\.json#dependencies\.typebox must not exist/);
  assert.match(result.stderr, /host-provided by Pi/);
});

test("check-package-versions ties devDependencies typebox to Pi's pinned typebox version", () => {
  const fixture = tempFixture({
    packageVersion: "1.2.3",
    devDependencies: {
      "@earendil-works/pi-coding-agent": FIXTURE_MANAGED_PI_VERSION,
      "@earendil-works/pi-tui": FIXTURE_MANAGED_PI_VERSION,
      typebox: FIXTURE_MANAGED_TYPEBOX_DRIFT_VERSION,
    },
  });

  const result = runCheckPackageVersions(fixture);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /TLH's devDependencies typebox pin must match Pi's pinned typebox version:/,
  );
  assert.match(result.stderr, /package\.json#devDependencies\.typebox: "1\.3\.6"/);
  assert.match(
    result.stderr,
    /package-lock\.json#packages\["node_modules\/@earendil-works\/pi-coding-agent"\]\.dependencies\.typebox: "1\.3\.7"/,
  );
});

test("check-package-versions rejects missing peerDependencies typebox", () => {
  const fixture = tempFixture({
    packageVersion: "1.2.3",
    peerDependencies: {
      "@earendil-works/pi-coding-agent": FIXTURE_MANAGED_PI_VERSION,
      "@earendil-works/pi-tui": FIXTURE_MANAGED_PI_VERSION,
      // typebox intentionally omitted
    },
  });

  const result = runCheckPackageVersions(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /package\.json#peerDependencies\.typebox must be '\*'/);
  assert.match(result.stderr, /found missing/);
});

test("check-package-versions rejects wrong-range peerDependencies typebox", () => {
  const fixture = tempFixture({
    packageVersion: "1.2.3",
    peerDependencies: {
      "@earendil-works/pi-coding-agent": FIXTURE_MANAGED_PI_VERSION,
      "@earendil-works/pi-tui": FIXTURE_MANAGED_PI_VERSION,
      typebox: FIXTURE_MANAGED_TYPEBOX_VERSION,
    },
  });

  const result = runCheckPackageVersions(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /package\.json#peerDependencies\.typebox must be '\*'/);
  assert.match(result.stderr, /found "1\.3\.7"/);
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
  assert.match(
    result.stderr,
    /package\.json#peerDependencies\.@earendil-works\/pi-coding-agent must use an exact version, found "\^9\.8\.7"/,
  );
});

test("check-package-versions reports stale direct registry dependencies with npm ci guidance", () => {
  const fixture = tempFixture({
    packageVersion: "1.2.3",
    dependencies: { staleDirect: "2.0.0" },
    installedVersions: { staleDirect: "1.9.0" },
  });

  const result = runCheckPackageVersions(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Installed dependencies are stale or mismatched/);
  assert.match(result.stderr, /run npm ci/);
  assert.match(result.stderr, /dependencies\.staleDirect/);
  assert.match(result.stderr, /expected "2\.0\.0", got "1\.9\.0"/);
});

test("check-package-versions reports missing direct registry dependencies", () => {
  const fixture = tempFixture({
    packageVersion: "1.2.3",
    dependencies: { missingDirect: "2.0.0" },
    missingInstalledPackages: ["missingDirect"],
  });

  const result = runCheckPackageVersions(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Installed dependencies are stale or mismatched/);
  assert.match(result.stderr, /run npm ci/);
  assert.match(result.stderr, /dependencies\.missingDirect/);
  assert.match(result.stderr, /package is not installed/);
});

test("check-package-versions uses the root lock entry version for exact npm aliases", () => {
  const fixture = tempFixture({
    packageVersion: "1.2.3",
    dependencies: { aliasedDirect: "npm:replacement-package@3.4.5" },
    lockfileDependencyVersions: { aliasedDirect: "3.4.5" },
    installedVersions: { aliasedDirect: "3.4.5" },
  });

  const result = runCheckPackageVersions(fixture);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("check-package-versions reports an eligible dependency without a usable root lock version", () => {
  const fixture = tempFixture({
    packageVersion: "1.2.3",
    dependencies: { missingLock: "2.0.0" },
    missingLockfilePackages: ["missingLock"],
  });

  const result = runCheckPackageVersions(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Installed dependencies are stale or mismatched/);
  assert.match(
    result.stderr,
    /package-lock\.json#packages\["node_modules\/missingLock"\]\.version/,
  );
  assert.match(result.stderr, /run npm ci/);
});

test("check-package-versions excludes peer-only, ranged, and non-registry specs from installed checks", () => {
  const fixture = tempFixture({
    packageVersion: "1.2.3",
    dependencies: {
      rangedDirect: "^2.0.0",
      localDirect: "file:../local-direct",
      gitDirect: "git+ssh://git@github.com/example/git-direct.git#abcdef1234567",
    },
    devDependencies: { rangedDev: "~3.0.0" },
    peerDependencies: { peerOnly: "4.0.0" },
  });

  const result = runCheckPackageVersions(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /package\.json#dependencies\.rangedDirect must use an exact version/);
  assert.doesNotMatch(result.stderr, /Installed dependencies are stale or mismatched/);
  assert.doesNotMatch(result.stderr, /peerOnly/);
  assert.doesNotMatch(result.stderr, /localDirect/);
  assert.doesNotMatch(result.stderr, /gitDirect/);
});

test("check-package-versions keeps managed Pi installed-version freshness checks", () => {
  const fixture = tempFixture({
    packageVersion: "1.2.3",
    installedVersions: {
      "@earendil-works/pi-coding-agent": FIXTURE_MANAGED_PI_DRIFT_VERSION,
    },
  });

  const result = runCheckPackageVersions(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Installed dependencies are stale or mismatched/);
  assert.match(result.stderr, /@earendil-works\/pi-coding-agent/);
  assert.match(result.stderr, /expected "9\.8\.7", got "9\.8\.6"/);
});

// ---------------------------------------------------------------------------
// Runtime manifest validation tests
// ---------------------------------------------------------------------------

const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_RUNTIME_TOP_LEVEL_KEY = `node_modules/${PI_CODING_AGENT_PACKAGE}`;

function makeRuntimeManifestDir({
  piVersion = FIXTURE_MANAGED_PI_VERSION,
  lockfileVersion = 3,
  extraTopLevel = [],
  missingResolved = false,
  missingIntegrity = false,
  missingIntegrityWithoutShrinkwrap = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tlh-runtime-manifest-test-"));
  _tmpDirs.push(dir);

  const packageJson = {
    name: "tlh-pi-runtime",
    version: piVersion,
    private: true,
    dependencies: { [PI_CODING_AGENT_PACKAGE]: piVersion },
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(packageJson, null, 2), "utf8");

  // Build a minimal but structurally-valid lockfile
  const topLevelEntry = {
    version: piVersion,
    resolved: `https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-${piVersion}.tgz`,
    integrity:
      "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
    hasShrinkwrap: true,
  };
  const nestedKey = `${PI_RUNTIME_TOP_LEVEL_KEY}/node_modules/some-dep`;
  const nestedEntry = {
    version: "1.0.0",
    resolved: "https://registry.npmjs.org/some-dep/-/some-dep-1.0.0.tgz",
    // No integrity — covered by hasShrinkwrap parent
  };

  const packages = {
    "": {
      name: "tlh-pi-runtime",
      version: piVersion,
      dependencies: { [PI_CODING_AGENT_PACKAGE]: piVersion },
    },
    [PI_RUNTIME_TOP_LEVEL_KEY]: topLevelEntry,
    [nestedKey]: nestedEntry,
  };

  for (const extraKey of extraTopLevel) {
    packages[`node_modules/${extraKey}`] = {
      version: "1.0.0",
      resolved: `https://registry.npmjs.org/${extraKey}/-/${extraKey}-1.0.0.tgz`,
      integrity:
        "sha512-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ==",
    };
  }

  if (missingResolved) {
    delete packages[PI_RUNTIME_TOP_LEVEL_KEY].resolved;
  }

  if (missingIntegrity) {
    delete packages[PI_RUNTIME_TOP_LEVEL_KEY].integrity;
  }

  if (missingIntegrityWithoutShrinkwrap) {
    // Add a top-level package with no integrity and no shrinkwrap parent
    packages["node_modules/orphan-no-integrity"] = {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/orphan-no-integrity/-/orphan-no-integrity-1.0.0.tgz",
    };
  }

  const lock = {
    name: "tlh-pi-runtime",
    version: piVersion,
    lockfileVersion,
    requires: true,
    packages,
  };
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock, null, 2), "utf8");

  return dir;
}

test("check-package-versions passes with a valid runtime manifest", () => {
  const runtimeDir = makeRuntimeManifestDir();
  const fixture = tempFixture({ packageVersion: "1.2.3" });

  const result = runCheckPackageVersions(fixture, ["--runtime-manifest-dir", runtimeDir]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
});

test("check-package-versions fails when runtime manifest dep version mismatches managed Pi pin", () => {
  const runtimeDir = makeRuntimeManifestDir({ piVersion: FIXTURE_MANAGED_PI_DRIFT_VERSION });
  const fixture = tempFixture({ packageVersion: "1.2.3" });

  const result = runCheckPackageVersions(fixture, ["--runtime-manifest-dir", runtimeDir]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /dependencies\["@earendil-works\/pi-coding-agent"\]/);
  assert.match(result.stderr, new RegExp(FIXTURE_MANAGED_PI_DRIFT_VERSION));
  assert.match(result.stderr, new RegExp(FIXTURE_MANAGED_PI_VERSION));
});

test("check-package-versions fails when runtime lockfile has wrong lockfileVersion", () => {
  const runtimeDir = makeRuntimeManifestDir({ lockfileVersion: 2 });
  const fixture = tempFixture({ packageVersion: "1.2.3" });

  const result = runCheckPackageVersions(fixture, ["--runtime-manifest-dir", runtimeDir]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /lockfileVersion must be 3/);
  assert.match(result.stderr, /found 2/);
});

test("check-package-versions fails when runtime lockfile has extra top-level packages", () => {
  const runtimeDir = makeRuntimeManifestDir({ extraTopLevel: ["unexpected-extra-package"] });
  const fixture = tempFixture({ packageVersion: "1.2.3" });

  const result = runCheckPackageVersions(fixture, ["--runtime-manifest-dir", runtimeDir]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /exactly one top-level package/);
  assert.match(result.stderr, /unexpected-extra-package/);
});

test("check-package-versions fails when runtime lockfile entry is missing resolved", () => {
  const runtimeDir = makeRuntimeManifestDir({ missingResolved: true });
  const fixture = tempFixture({ packageVersion: "1.2.3" });

  const result = runCheckPackageVersions(fixture, ["--runtime-manifest-dir", runtimeDir]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing resolved/);
});

test("check-package-versions fails when top-level runtime package is missing integrity", () => {
  const runtimeDir = makeRuntimeManifestDir({ missingIntegrity: true });
  const fixture = tempFixture({ packageVersion: "1.2.3" });

  const result = runCheckPackageVersions(fixture, ["--runtime-manifest-dir", runtimeDir]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing integrity/);
});

test("check-package-versions fails when a non-shrinkwrap-covered package is missing integrity", () => {
  const runtimeDir = makeRuntimeManifestDir({ missingIntegrityWithoutShrinkwrap: true });
  const fixture = tempFixture({ packageVersion: "1.2.3" });

  const result = runCheckPackageVersions(fixture, ["--runtime-manifest-dir", runtimeDir]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing integrity/);
  assert.match(result.stderr, /orphan-no-integrity/);
});

test("check-package-versions skips runtime manifest check when dir is empty string", () => {
  const fixture = tempFixture({ packageVersion: "1.2.3" });

  // No --runtime-manifest-dir passed = uses the "" override from runCheckPackageVersions
  const result = runCheckPackageVersions(fixture);

  // Should still pass (fixture has no config/pi-runtime but we skip the check)
  assert.equal(result.status, 0, result.stderr);
});

test("check-package-versions fails when runtime manifest package.json is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "tlh-runtime-manifest-missing-"));
  _tmpDirs.push(dir);
  // Create lock but no package.json
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }), "utf8");

  const fixture = tempFixture({ packageVersion: "1.2.3" });
  const result = runCheckPackageVersions(fixture, ["--runtime-manifest-dir", dir]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /package\.json/);
});

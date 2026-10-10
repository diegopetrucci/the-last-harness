import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { after, test } from "node:test";

import { readDefaultExtensions } from "../scripts/lib/default-extensions.mjs";
import { evaluateMcpAdapterCutover } from "../scripts/lib/mcp-adapter-cutover.mjs";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const mergeScript = join(repoRoot, "scripts", "merge-settings.mjs");
const harnessPackage = "git:github.com/diegopetrucci/the-last-harness";
const targetSource = "npm:@diegopetrucci/pi-mcp-adapter@5.0.0";
const oldSource = "npm:@diegopetrucci/pi-mcp-adapter@2.36.0";
const oldGitSource = "git:github.com/diegopetrucci/pi-mcp-adapter@tlh-v2.10.0-1";
const builtinMcpExclusion = "-builtin:mcp";
const mcporter = readDefaultExtensions(join(repoRoot, "config", "default-extensions.json")).find(
  (extension) => extension.id === "mcporter",
);
assert.ok(mcporter, "the bundled mcporter manifest entry must exist");

const tempRoots = [];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function createFixture(settings, { installedVersion, extensions = [mcporter] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tlh-mcp-cutover-test-"));
  tempRoots.push(dir);
  const settingsPath = join(dir, "settings.json");
  const defaultsPath = join(dir, "settings.defaults.json");
  const extensionsPath = join(dir, "default-extensions.json");
  writeFileSync(
    defaultsPath,
    JSON.stringify(
      {
        packages: [harnessPackage],
        extensions: [builtinMcpExclusion],
        lastChangelogVersion: "9999.0.0",
      },
      null,
      2,
    ),
  );
  writeFileSync(extensionsPath, `${JSON.stringify(extensions, null, 2)}\n`);
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  if (installedVersion) {
    const packageDir = join(dir, "npm", "node_modules", "@diegopetrucci", "pi-mcp-adapter");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      `${JSON.stringify({ name: "@diegopetrucci/pi-mcp-adapter", version: installedVersion }, null, 2)}\n`,
    );
  }
  return { dir, settingsPath, defaultsPath, extensionsPath };
}

function writeGitPackageMetadata(fixture, version) {
  const packageDir = join(fixture.dir, "git", "github.com", "diegopetrucci", "pi-mcp-adapter");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify({ name: "@diegopetrucci/pi-mcp-adapter", version }, null, 2)}\n`,
  );
}

function runMerge(fixture, extraArgs = []) {
  const env = {
    ...process.env,
    HOME: join(fixture.dir, "home"),
    USERPROFILE: join(fixture.dir, "home"),
    PI_CODING_AGENT_DIR: fixture.dir,
    TLH_AGENT_DIR: fixture.dir,
    MCP_OAUTH_DIR: join(fixture.dir, "oauth"),
    XDG_CONFIG_HOME: join(fixture.dir, "xdg", "config"),
    XDG_CACHE_HOME: join(fixture.dir, "xdg", "cache"),
    XDG_DATA_HOME: join(fixture.dir, "xdg", "data"),
    XDG_STATE_HOME: join(fixture.dir, "xdg", "state"),
    TMPDIR: join(fixture.dir, "tmp"),
  };
  const result = spawnSync(
    process.execPath,
    [
      mergeScript,
      fixture.defaultsPath,
      "--settings",
      fixture.settingsPath,
      "--default-extensions",
      fixture.extensionsPath,
      "--quiet",
      ...extraArgs,
    ],
    { cwd: repoRoot, env, encoding: "utf8" },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(
    result.status,
    0,
    `merge failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return { settings: readJson(fixture.settingsPath), stdout: result.stdout, stderr: result.stderr };
}

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

test("constrained legacy selectors stay held despite stale native installed metadata", () => {
  const rangeSource = "npm:@diegopetrucci/pi-mcp-adapter@^2.0.0";
  const rangeFixture = createFixture(
    { packages: [harnessPackage, rangeSource] },
    { installedVersion: "5.0.0" },
  );
  const rangeResult = runMerge(rangeFixture);
  assert.deepEqual(rangeResult.settings.packages, [harnessPackage, rangeSource]);
  assert.match(
    rangeResult.stderr,
    /cutover held for mcporter: selected adapter version is unresolved/,
  );

  const legacyGitFixture = createFixture({ packages: [harnessPackage, oldGitSource] });
  writeGitPackageMetadata(legacyGitFixture, "5.0.0");
  const legacyDecision = evaluateMcpAdapterCutover(
    { packages: [harnessPackage, oldGitSource] },
    mcporter,
    { agentDir: legacyGitFixture.dir, homeDir: join(legacyGitFixture.dir, "home") },
  );
  assert.equal(legacyDecision.selected[0]?.metadata.kind, "found");
  assert.deepEqual(legacyDecision.selected[0]?.metadata.version, { major: 5, minor: 0, patch: 0 });
  const legacyGitResult = runMerge(legacyGitFixture);
  assert.deepEqual(legacyGitResult.settings.packages, [harnessPackage, oldGitSource]);
  assert.match(
    legacyGitResult.stderr,
    /cutover held for mcporter: selected adapter version is unresolved/,
  );
});

test("legacy targets freeze native intent before unresolved selections", () => {
  const legacyManifest = { ...mcporter, source: oldSource };
  const nativeIntentCases = [
    { name: "caret v5", source: "npm:@diegopetrucci/pi-mcp-adapter@^5.0.0", cached: false },
    { name: "tilde v5", source: "npm:@diegopetrucci/pi-mcp-adapter@~5.1.0", cached: false },
    {
      name: "stable TLH v5 ref",
      source: "git:github.com/diegopetrucci/pi-mcp-adapter@tlh-v5.0.0-1",
      cached: false,
    },
    { name: "caret v6", source: "npm:@diegopetrucci/pi-mcp-adapter@^6.0.0", cached: false },
    {
      name: "stable TLH v10 ref",
      source: "git:github.com/diegopetrucci/pi-mcp-adapter@tlh-v10.0.0-1",
      cached: false,
    },
    {
      name: "stable TLH v49 ref",
      source: "git:github.com/diegopetrucci/pi-mcp-adapter@tlh-v49.0.0-1",
      cached: false,
    },
  ];

  for (const { name, source, cached } of nativeIntentCases) {
    for (const force of [false, true]) {
      const fixture = createFixture(
        {
          packages: [harnessPackage, source],
          tlh: {
            defaultExtensionProvenance: {
              managedPackageIdentities: [packageIdentityForTest(source)],
            },
          },
        },
        { extensions: [legacyManifest] },
      );
      if (cached) writeGitPackageMetadata(fixture, "5.0.0");
      const result = runMerge(fixture, force ? ["--force"] : []);
      assert.deepEqual(
        result.settings.packages,
        [harnessPackage, source],
        `${name}, force=${force}`,
      );
      assert.match(
        result.stderr,
        /selected adapter version is unresolved/,
        `${name}, force=${force}`,
      );
    }
  }

  for (const force of [false, true]) {
    const nativeAndUnresolved = createFixture(
      {
        packages: [harnessPackage, "npm:@diegopetrucci/pi-mcp-adapter@5.1.0", oldGitSource],
        tlh: {
          defaultExtensionProvenance: {
            managedPackageIdentities: [
              "npm:@diegopetrucci/pi-mcp-adapter",
              "git:github.com/diegopetrucci/pi-mcp-adapter",
            ],
          },
        },
      },
      { extensions: [legacyManifest] },
    );
    const result = runMerge(nativeAndUnresolved, force ? ["--force"] : []);
    assert.deepEqual(result.settings.packages, [
      harnessPackage,
      "npm:@diegopetrucci/pi-mcp-adapter@5.1.0",
      oldGitSource,
    ]);
    assert.match(result.stderr, /selected adapter version is unresolved/);
  }
});

test("installed metadata follows symlinked profiles but rejects cache-root and nested escapes", () => {
  const source = "npm:@diegopetrucci/pi-mcp-adapter";
  const fixture = createFixture(
    { packages: [harnessPackage, source] },
    { installedVersion: "5.0.0" },
  );
  const symlinkParent = mkdtempSync(join(tmpdir(), "tlh-mcp-cutover-symlink-parent-"));
  tempRoots.push(symlinkParent);
  const symlinkProfile = join(symlinkParent, "profile");
  symlinkSync(fixture.dir, symlinkProfile, "dir");
  const symlinkDecision = evaluateMcpAdapterCutover(
    { packages: [harnessPackage, source] },
    mcporter,
    { agentDir: symlinkProfile, homeDir: join(symlinkParent, "home") },
  );
  assert.equal(symlinkDecision.selected[0]?.metadata.kind, "found");
  assert.deepEqual(symlinkDecision.selected[0]?.metadata.version, { major: 5, minor: 0, patch: 0 });
  assert.equal(symlinkDecision.action, "native");

  const cacheRootProfile = mkdtempSync(join(tmpdir(), "tlh-mcp-cutover-cache-root-"));
  const cacheRootOutside = mkdtempSync(join(tmpdir(), "tlh-mcp-cutover-cache-outside-"));
  tempRoots.push(cacheRootProfile, cacheRootOutside);
  const outsideNpm = join(cacheRootOutside, "npm");
  mkdirSync(join(outsideNpm, "node_modules", "@diegopetrucci", "pi-mcp-adapter"), {
    recursive: true,
  });
  writeFileSync(
    join(outsideNpm, "node_modules", "@diegopetrucci", "pi-mcp-adapter", "package.json"),
    `${JSON.stringify({ name: "@diegopetrucci/pi-mcp-adapter", version: "5.0.0" }, null, 2)}\n`,
  );
  symlinkSync(outsideNpm, join(cacheRootProfile, "npm"), "dir");
  const cacheRootDecision = evaluateMcpAdapterCutover(
    { packages: [harnessPackage, source] },
    mcporter,
    { agentDir: cacheRootProfile, homeDir: join(cacheRootProfile, "home") },
  );
  assert.equal(cacheRootDecision.selected[0]?.metadata.kind, "invalid");
  assert.equal(cacheRootDecision.action, "hold");

  const nestedProfile = mkdtempSync(join(tmpdir(), "tlh-mcp-cutover-nested-profile-"));
  const nestedOutside = mkdtempSync(join(tmpdir(), "tlh-mcp-cutover-nested-outside-"));
  tempRoots.push(nestedProfile, nestedOutside);
  const nestedParent = join(nestedProfile, "npm", "node_modules", "@diegopetrucci");
  mkdirSync(nestedParent, { recursive: true });
  writeFileSync(
    join(nestedOutside, "package.json"),
    `${JSON.stringify({ name: "@diegopetrucci/pi-mcp-adapter", version: "5.0.0" }, null, 2)}\n`,
  );
  symlinkSync(nestedOutside, join(nestedParent, "pi-mcp-adapter"), "dir");
  const nestedDecision = evaluateMcpAdapterCutover(
    { packages: [harnessPackage, source] },
    mcporter,
    { agentDir: nestedProfile, homeDir: join(nestedProfile, "home") },
  );
  assert.equal(nestedDecision.selected[0]?.metadata.kind, "invalid");
  assert.equal(nestedDecision.action, "hold");
});

function packageIdentityForTest(source) {
  if (source.startsWith("npm:")) return "npm:@diegopetrucci/pi-mcp-adapter";
  return "git:github.com/diegopetrucci/pi-mcp-adapter";
}

test("pre-v5 selections are held even with --force and preserve objects, filters, order, and ownership", () => {
  const entry = {
    source: oldGitSource,
    extensions: ["src/index.ts"],
    autoload: true,
    userMetadata: { keep: true },
  };
  for (const force of [false, true]) {
    const fixture = createFixture({
      packages: [harnessPackage, entry],
      extensions: ["./user-extension.js", builtinMcpExclusion],
      tlh: {
        builtinMcpExclusionManaged: true,
        defaultExtensionProvenance: {
          managedPackageIdentities: ["git:github.com/diegopetrucci/pi-mcp-adapter"],
        },
      },
    });
    const result = runMerge(fixture, force ? ["--force"] : []);
    assert.deepEqual(result.settings.packages, [harnessPackage, entry]);
    assert.deepEqual(result.settings.extensions, ["./user-extension.js", builtinMcpExclusion]);
    assert.equal(result.settings.tlh.builtinMcpExclusionManaged, true);
    assert.deepEqual(result.settings.tlh.defaultExtensionProvenance.managedPackageIdentities, [
      "git:github.com/diegopetrucci/pi-mcp-adapter",
    ]);
    assert.match(
      result.stderr,
      /cutover held for mcporter: selected adapter version is unresolved/,
    );
    assert.doesNotMatch(result.stderr, /pi-mcp-adapter@|src\/index/);
  }
});

test("legacy replacement identities and mixed selections fail closed without name guessing", () => {
  const fixture = createFixture({
    packages: [
      harnessPackage,
      "npm:pi-mcp-adapter",
      { source: oldGitSource, metadata: { keep: true } },
      "npm:some-mcp-adapter@2.0.0",
    ],
  });
  const result = runMerge(fixture);
  assert.deepEqual(result.settings.packages, [
    harnessPackage,
    "npm:pi-mcp-adapter",
    { source: oldGitSource, metadata: { keep: true } },
    "npm:some-mcp-adapter@2.0.0",
  ]);
  assert.match(result.stderr, /selected adapter version is unresolved/);
  assert.doesNotMatch(result.stderr, /some-mcp-adapter/);
});

test("unpinned installed adapter metadata gates v2, permits v5 pinning, and holds missing metadata", () => {
  for (const scenario of [
    {
      name: "installed-v2",
      installedVersion: "2.36.0",
      expectedSource: "npm:@diegopetrucci/pi-mcp-adapter",
      held: true,
    },
    { name: "installed-v5", installedVersion: "5.0.0", expectedSource: targetSource, held: false },
    {
      name: "missing",
      installedVersion: undefined,
      expectedSource: "npm:@diegopetrucci/pi-mcp-adapter",
      held: true,
    },
  ]) {
    const source = "npm:@diegopetrucci/pi-mcp-adapter";
    const fixture = createFixture({ packages: [harnessPackage, source] }, scenario);
    const result = runMerge(fixture);
    assert.equal(result.settings.packages[1], scenario.expectedSource, scenario.name);
    if (scenario.held) {
      assert.match(result.stderr, /cutover held for mcporter/);
    } else {
      assert.equal(result.stderr, "", scenario.name);
      assert.deepEqual(result.settings.tlh.defaultExtensionProvenance.managedPackageIdentities, [
        "npm:@diegopetrucci/pi-mcp-adapter",
      ]);
    }
  }
});

test("already-native pins are not implicitly downgraded, including installed metadata conflicts", () => {
  const newer = createFixture(
    {
      packages: [harnessPackage, "npm:@diegopetrucci/pi-mcp-adapter@5.1.0"],
      tlh: {
        defaultExtensionProvenance: {
          managedPackageIdentities: ["npm:@diegopetrucci/pi-mcp-adapter"],
        },
      },
    },
    { installedVersion: "5.1.0" },
  );
  const newerResult = runMerge(newer);
  assert.equal(newerResult.settings.packages[1], "npm:@diegopetrucci/pi-mcp-adapter@5.1.0");
  assert.equal(newerResult.stderr, "");

  const conflict = createFixture(
    { packages: [harnessPackage, targetSource] },
    { installedVersion: "2.36.0" },
  );
  const conflictResult = runMerge(conflict);
  assert.equal(conflictResult.settings.packages[1], targetSource);
  assert.match(conflictResult.stderr, /installed adapter metadata conflicts/);
});

test("fresh selection is explicit, while opt-outs preserve intentional ownership behavior", () => {
  const fresh = createFixture({ packages: [harnessPackage] });
  const freshResult = runMerge(fresh);
  assert.equal(freshResult.settings.packages[1], targetSource);
  assert.equal(freshResult.settings.tlh.builtinMcpExclusionManaged, true);
  assert.match(freshResult.stderr, /fresh component choice and does not assert project safety/);

  const optedOut = createFixture({
    packages: [harnessPackage, oldSource],
    extensions: [builtinMcpExclusion],
    tlh: { disabledDefaultExtensions: ["mcporter"], builtinMcpExclusionManaged: true },
  });
  const optedOutResult = runMerge(optedOut);
  assert.deepEqual(optedOutResult.settings.packages, [harnessPackage]);
  assert.equal(optedOutResult.settings.extensions, undefined);
  assert.equal(optedOutResult.settings.tlh.builtinMcpExclusionManaged, undefined);
  assert.doesNotMatch(optedOutResult.stderr, /cutover held/);

  const filtered = createFixture({
    packages: [harnessPackage, { source: oldSource, extensions: [], userMetadata: { keep: true } }],
    extensions: [builtinMcpExclusion],
    tlh: { builtinMcpExclusionManaged: true },
  });
  const filteredResult = runMerge(filtered);
  assert.deepEqual(filteredResult.settings.packages, [
    harnessPackage,
    { source: oldSource, extensions: [], userMetadata: { keep: true } },
  ]);
  assert.equal(filteredResult.settings.extensions, undefined);
  assert.equal(filteredResult.settings.tlh.builtinMcpExclusionManaged, undefined);
  assert.equal(filteredResult.stderr, "");
});

test("enabled held legacy adapters acquire builtin exclusion ownership when missing", () => {
  const fixture = createFixture({ packages: [harnessPackage, oldSource] });
  const result = runMerge(fixture);
  assert.deepEqual(result.settings.packages, [harnessPackage, oldSource]);
  assert.deepEqual(result.settings.extensions, [builtinMcpExclusion]);
  assert.equal(result.settings.tlh.builtinMcpExclusionManaged, true);
  assert.match(result.stderr, /cutover held for mcporter: selected adapter is pre-v5/);
});

test("pre-v5 manifest migrations remain ordinary, but cannot downgrade a native profile", () => {
  const oldManifest = { ...mcporter, source: "npm:@diegopetrucci/pi-mcp-adapter@2.36.0" };
  const ordinary = createFixture(
    {
      packages: [harnessPackage, "npm:@diegopetrucci/pi-mcp-adapter@2.10.1"],
      tlh: {
        defaultExtensionProvenance: {
          managedPackageIdentities: ["npm:@diegopetrucci/pi-mcp-adapter"],
        },
      },
    },
    { extensions: [oldManifest] },
  );
  const ordinaryResult = runMerge(ordinary);
  assert.equal(ordinaryResult.settings.packages[1], oldManifest.source);
  assert.equal(ordinaryResult.stderr, "");

  const native = createFixture(
    {
      packages: [harnessPackage, "npm:@diegopetrucci/pi-mcp-adapter@5.1.0"],
      tlh: {
        defaultExtensionProvenance: {
          managedPackageIdentities: ["npm:@diegopetrucci/pi-mcp-adapter"],
        },
      },
    },
    { extensions: [oldManifest] },
  );
  const nativeResult = runMerge(native);
  assert.equal(nativeResult.settings.packages[1], "npm:@diegopetrucci/pi-mcp-adapter@5.1.0");
});

test("unrelated package names do not select the MCP adapter", () => {
  const decision = evaluateMcpAdapterCutover(
    { packages: ["npm:company-mcp-tools@2.0.0"] },
    mcporter,
    { agentDir: "/path/that/does/not/exist", homeDir: "/path/that/does/not/exist" },
  );
  assert.equal(decision.action, "fresh");
  assert.equal(decision.freeze, false);
});

const fixtureRoot = process.env.TLH_MCP_COMPAT_FIXTURES_DIR;
if (fixtureRoot) {
  test("owned published adapter fixture inputs are available", () => {
    assert.equal(existsSync(join(fixtureRoot, "diegopetrucci-pi-mcp-adapter-2.36.0.tgz")), true);
    assert.equal(existsSync(join(fixtureRoot, "diegopetrucci-pi-mcp-adapter-5.0.0.tgz")), true);
  });
}

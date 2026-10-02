import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const mergeScript = join(repoRoot, "scripts", "merge-settings.mjs");
const settingsDefaultsPath = join(repoRoot, "config", "settings.defaults.json");
const bundledExtensionsPath = join(repoRoot, "config", "default-extensions.json");
const harnessPackage = "git:github.com/diegopetrucci/the-last-harness";
const changelogSentinel = "9999.0.0";
const builtinMcpExclusion = "-builtin:mcp";
const _tmpDirs = [];

after(() => {
  for (const dir of _tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Create a temp fixture with an empty default-extensions list (enough for most
 * -builtin:mcp tests that rely on tlh.disabledDefaultExtensions).
 */
function tempFixture(settingsValue) {
  const dir = mkdtempSync(join(tmpdir(), "tlh-merge-mcp-test-"));
  _tmpDirs.push(dir);
  const defaults = join(dir, "settings.defaults.json");
  const extensions = join(dir, "default-extensions.json");
  const settings = join(dir, "settings.json");
  writeFileSync(defaults, readFileSync(settingsDefaultsPath));
  writeFileSync(extensions, "[]\n");
  writeFileSync(settings, `${JSON.stringify(settingsValue, null, 2)}\n`);
  return { defaults, extensions, settings };
}

/**
 * Create a temp fixture backed by the bundled default-extensions.json so that
 * package-filter opt-out logic can find the mcporter extension entry.
 */
function tempFixtureWithBundledExtensions(settingsValue) {
  const dir = mkdtempSync(join(tmpdir(), "tlh-merge-mcp-test-"));
  _tmpDirs.push(dir);
  const defaults = join(dir, "settings.defaults.json");
  const extensions = join(dir, "default-extensions.json");
  const settings = join(dir, "settings.json");
  writeFileSync(defaults, readFileSync(settingsDefaultsPath));
  writeFileSync(extensions, readFileSync(bundledExtensionsPath));
  writeFileSync(settings, `${JSON.stringify(settingsValue, null, 2)}\n`);
  return { defaults, extensions, settings };
}

function runMerge(fixture, { quiet = true } = {}) {
  const args = [
    mergeScript,
    fixture.defaults,
    "--settings",
    fixture.settings,
    "--default-extensions",
    fixture.extensions,
  ];
  if (quiet) args.push("--quiet");
  return execFileSync(process.execPath, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
  });
}

test("packaged settings defaults disable builtin:mcp", () => {
  const defaults = readJson(settingsDefaultsPath);
  assert.ok(
    Array.isArray(defaults.extensions),
    "settings defaults must declare extension defaults",
  );
  assert.ok(
    defaults.extensions.includes(builtinMcpExclusion),
    "settings defaults must persist the builtin:mcp exclusion",
  );
});

test("fresh merge appends the builtin:mcp exclusion and records ownership", () => {
  const fixture = tempFixtureWithBundledExtensions({
    packages: [harnessPackage],
    lastChangelogVersion: changelogSentinel,
  });

  runMerge(fixture);

  const after = readJson(fixture.settings);
  assert.deepEqual(after.extensions, [builtinMcpExclusion]);
  assert.equal(after.tlh?.builtinMcpExclusionManaged, true);
});

test("update preserves unrelated extension entries and does not claim a preexisting exclusion", () => {
  const extensions = ["./user-extension.js", builtinMcpExclusion, "./another-extension.js"];
  const fixture = tempFixtureWithBundledExtensions({
    packages: [harnessPackage],
    extensions,
    lastChangelogVersion: changelogSentinel,
  });

  runMerge(fixture);

  const afterFirstMerge = readJson(fixture.settings);
  assert.deepEqual(afterFirstMerge.extensions, extensions);
  assert.equal(
    afterFirstMerge.extensions.filter((entry) => entry === builtinMcpExclusion).length,
    1,
  );
  assert.equal(afterFirstMerge.tlh?.builtinMcpExclusionManaged, undefined);

  const secondOutput = runMerge(fixture, { quiet: false });
  assert.match(secondOutput, /No settings changes needed\./);
  assert.deepEqual(readJson(fixture.settings).extensions, extensions);
});

test("opted-out merge (disabledDefaultExtensions) does not add the builtin:mcp exclusion", () => {
  const fixture = tempFixtureWithBundledExtensions({
    packages: [harnessPackage],
    tlh: { disabledDefaultExtensions: ["mcporter"] },
    lastChangelogVersion: changelogSentinel,
  });

  runMerge(fixture);

  const after = readJson(fixture.settings);
  assert.ok(
    !Array.isArray(after.extensions) || !after.extensions.includes(builtinMcpExclusion),
    "merge must not add the builtin:mcp exclusion when mcporter is disabled",
  );
});

test("opted-out merge preserves an unmarked user exclusion", () => {
  const fixture = tempFixtureWithBundledExtensions({
    packages: [harnessPackage],
    extensions: [builtinMcpExclusion],
    tlh: { disabledDefaultExtensions: ["mcporter"] },
    lastChangelogVersion: changelogSentinel,
  });

  runMerge(fixture);

  const after = readJson(fixture.settings);
  assert.deepEqual(after.extensions, [builtinMcpExclusion]);
  assert.equal(after.tlh?.builtinMcpExclusionManaged, undefined);
});

test("opted-out merge removes a TLH-owned exclusion and clears ownership", () => {
  const fixture = tempFixtureWithBundledExtensions({
    packages: [harnessPackage],
    extensions: [builtinMcpExclusion],
    tlh: {
      disabledDefaultExtensions: ["mcporter"],
      builtinMcpExclusionManaged: true,
    },
    lastChangelogVersion: changelogSentinel,
  });

  runMerge(fixture);

  const after = readJson(fixture.settings);
  assert.equal(after.extensions, undefined);
  assert.equal(after.tlh?.builtinMcpExclusionManaged, undefined);
});

test("false exclusion ownership does not authorize removal", () => {
  const fixture = tempFixtureWithBundledExtensions({
    packages: [harnessPackage],
    extensions: [builtinMcpExclusion],
    tlh: {
      disabledDefaultExtensions: ["mcporter"],
      builtinMcpExclusionManaged: false,
    },
    lastChangelogVersion: changelogSentinel,
  });

  runMerge(fixture);

  const after = readJson(fixture.settings);
  assert.deepEqual(after.extensions, [builtinMcpExclusion]);
  assert.equal(after.tlh?.builtinMcpExclusionManaged, false);
});

test("opted-out merge preserves unrelated extension entries and unmarked exclusions", () => {
  const fixture = tempFixtureWithBundledExtensions({
    packages: [harnessPackage],
    extensions: ["./user-ext.js", builtinMcpExclusion, "./other-ext.js"],
    tlh: { disabledDefaultExtensions: ["mcporter"] },
    lastChangelogVersion: changelogSentinel,
  });

  runMerge(fixture);

  const after = readJson(fixture.settings);
  assert.deepEqual(after.extensions, ["./user-ext.js", builtinMcpExclusion, "./other-ext.js"]);
});

test("package-filter opt-out does not add the builtin:mcp exclusion", () => {
  // A package entry with an empty extensions array disables the extension via
  // the package-filter path (packageEntryDisablesExtensions returns true).
  const mcporterSource = readJson(bundledExtensionsPath).find((e) => e.id === "mcporter")?.source;
  assert.ok(mcporterSource, "mcporter must have a bundled source");

  const fixture = tempFixtureWithBundledExtensions({
    packages: [harnessPackage, { source: mcporterSource, extensions: [] }],
    lastChangelogVersion: changelogSentinel,
  });

  runMerge(fixture);

  const after = readJson(fixture.settings);
  assert.ok(
    !Array.isArray(after.extensions) || !after.extensions.includes(builtinMcpExclusion),
    "merge must not add the builtin:mcp exclusion when mcporter is disabled via package filter",
  );
  assert.equal(after.tlh?.builtinMcpExclusionManaged, undefined);
});

test("package-filter opt-out removes a TLH-owned exclusion and clears ownership", () => {
  const mcporterSource = readJson(bundledExtensionsPath).find((e) => e.id === "mcporter")?.source;
  assert.ok(mcporterSource, "mcporter must have a bundled source");

  const fixture = tempFixtureWithBundledExtensions({
    packages: [harnessPackage, { source: mcporterSource, extensions: [] }],
    extensions: [builtinMcpExclusion],
    tlh: { builtinMcpExclusionManaged: true },
    lastChangelogVersion: changelogSentinel,
  });

  runMerge(fixture);

  const after = readJson(fixture.settings);
  assert.equal(after.extensions, undefined);
  assert.equal(after.tlh?.builtinMcpExclusionManaged, undefined);
});

test("package-filter opt-out preserves an unmarked user exclusion", () => {
  const mcporterSource = readJson(bundledExtensionsPath).find((e) => e.id === "mcporter")?.source;
  assert.ok(mcporterSource, "mcporter must have a bundled source");

  const fixture = tempFixtureWithBundledExtensions({
    packages: [harnessPackage, { source: mcporterSource, extensions: [] }],
    extensions: [builtinMcpExclusion],
    lastChangelogVersion: changelogSentinel,
  });

  runMerge(fixture);

  const after = readJson(fixture.settings);
  assert.deepEqual(after.extensions, [builtinMcpExclusion]);
  assert.equal(after.tlh?.builtinMcpExclusionManaged, undefined);
});

test("fresh merge with an empty default-extension manifest does not add the exclusion", () => {
  const fixture = tempFixture({
    packages: [harnessPackage],
    lastChangelogVersion: changelogSentinel,
  });

  runMerge(fixture);

  const after = readJson(fixture.settings);
  assert.equal(after.extensions, undefined);
  assert.equal(after.tlh?.builtinMcpExclusionManaged, undefined);
});

test("missing default-extension manifest removes only a TLH-owned exclusion", () => {
  const fixture = tempFixture({
    packages: [harnessPackage],
    extensions: [builtinMcpExclusion],
    tlh: { builtinMcpExclusionManaged: true },
    lastChangelogVersion: changelogSentinel,
  });
  rmSync(fixture.extensions);

  runMerge(fixture);

  const after = readJson(fixture.settings);
  assert.equal(after.extensions, undefined);
  assert.equal(after.tlh?.builtinMcpExclusionManaged, undefined);
});

test("missing default-extension manifest preserves an unmarked user exclusion", () => {
  const fixture = tempFixture({
    packages: [harnessPackage],
    extensions: [builtinMcpExclusion],
    lastChangelogVersion: changelogSentinel,
  });
  rmSync(fixture.extensions);

  runMerge(fixture);

  const after = readJson(fixture.settings);
  assert.deepEqual(after.extensions, [builtinMcpExclusion]);
  assert.equal(after.tlh?.builtinMcpExclusionManaged, undefined);
});

test("enabled merge adds exactly one exclusion while preserving an existing extensions array", () => {
  const fixture = tempFixtureWithBundledExtensions({
    packages: [harnessPackage],
    extensions: ["./user-ext.js"],
    lastChangelogVersion: changelogSentinel,
  });

  runMerge(fixture);

  const after = readJson(fixture.settings);
  assert.deepEqual(after.extensions, ["./user-ext.js", builtinMcpExclusion]);
  assert.equal(after.extensions.filter((entry) => entry === builtinMcpExclusion).length, 1);
  assert.equal(after.tlh?.builtinMcpExclusionManaged, true);

  const secondOutput = runMerge(fixture, { quiet: false });
  assert.match(secondOutput, /No settings changes needed\./);
  assert.deepEqual(readJson(fixture.settings).extensions, after.extensions);
});

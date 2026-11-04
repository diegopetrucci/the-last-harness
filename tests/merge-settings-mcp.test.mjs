import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  tempFixture as createMergeFixture,
  runMerge,
  readJson,
} from "./support/merge-settings-fixtures.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const settingsDefaultsPath = join(repoRoot, "config", "settings.defaults.json");
const bundledExtensionsPath = join(repoRoot, "config", "default-extensions.json");
const harnessPackage = "git:github.com/diegopetrucci/the-last-harness";
const projectMcpJsonSource = "npm:@diegopetrucci/pi-project-mcp-json@0.1.4";
const changelogSentinel = "9999.0.0";
const builtinMcpExclusion = "-builtin:mcp";

function tempFixture(settingsValue, extensionsValue = []) {
  return createMergeFixture(readJson(settingsDefaultsPath), settingsValue, extensionsValue);
}

function bundledFixture(settingsValue) {
  return tempFixture(
    { lastChangelogVersion: changelogSentinel, ...settingsValue },
    readJson(bundledExtensionsPath),
  );
}

function packageSources(settings) {
  return settings.packages.map((entry) => (typeof entry === "string" ? entry : entry.source));
}

test("packaged defaults ship project-mcp-json and no adapter or builtin:mcp exclusion", () => {
  const defaults = readJson(settingsDefaultsPath);
  assert.ok(!(defaults.extensions ?? []).includes(builtinMcpExclusion));
  const extensions = readJson(bundledExtensionsPath);
  assert.equal(
    extensions.find((entry) => entry.id === "project-mcp-json")?.source,
    projectMcpJsonSource,
  );
  assert.equal(
    extensions.find((entry) => entry.id === "mcporter"),
    undefined,
  );
  assert.ok(!extensions.some((entry) => /mcp-adapter/.test(entry.source)));
});

test("fresh merge adds project-mcp-json without the adapter, exclusion, or ownership marker", () => {
  const fixture = bundledFixture({ packages: [harnessPackage] });

  runMerge(fixture);

  const after = readJson(fixture.settings);
  assert.ok(packageSources(after).includes(projectMcpJsonSource));
  assert.ok(!packageSources(after).some((source) => /mcp-adapter/.test(source)));
  assert.equal(after.extensions, undefined);
  assert.equal(after.tlh?.builtinMcpExclusionManaged, undefined);
});

test("TLH-owned builtin:mcp exclusion is withdrawn and ownership cleared", () => {
  const fixture = bundledFixture({
    packages: [harnessPackage],
    extensions: [builtinMcpExclusion],
    tlh: { builtinMcpExclusionManaged: true },
  });

  const output = runMerge(fixture, { quiet: false });

  const after = readJson(fixture.settings);
  assert.equal(after.extensions, undefined);
  assert.equal(after.tlh?.builtinMcpExclusionManaged, undefined);
  assert.match(output, /remove TLH-managed builtin:mcp exclusion/);
});

test("withdrawal keeps unrelated extension entries", () => {
  const fixture = bundledFixture({
    packages: [harnessPackage],
    extensions: ["./user-ext.js", builtinMcpExclusion, "./other-ext.js"],
    tlh: { builtinMcpExclusionManaged: true },
  });

  runMerge(fixture);

  const after = readJson(fixture.settings);
  assert.deepEqual(after.extensions, ["./user-ext.js", "./other-ext.js"]);
  assert.equal(after.tlh?.builtinMcpExclusionManaged, undefined);
});

test("an unmarked user builtin:mcp exclusion survives", () => {
  const fixture = bundledFixture({
    packages: [harnessPackage],
    extensions: [builtinMcpExclusion],
  });

  runMerge(fixture);

  const after = readJson(fixture.settings);
  assert.deepEqual(after.extensions, [builtinMcpExclusion]);
  assert.equal(after.tlh?.builtinMcpExclusionManaged, undefined);
});

test("false exclusion ownership does not authorize removal", () => {
  const fixture = bundledFixture({
    packages: [harnessPackage],
    extensions: [builtinMcpExclusion],
    tlh: { builtinMcpExclusionManaged: false },
  });

  runMerge(fixture);

  const after = readJson(fixture.settings);
  assert.deepEqual(after.extensions, [builtinMcpExclusion]);
  assert.equal(after.tlh?.builtinMcpExclusionManaged, false);
});

test("withdrawal also works with a missing default-extension manifest", () => {
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

for (const source of [
  "npm:@diegopetrucci/pi-mcp-adapter@5.0.2",
  "npm:@diegopetrucci/pi-mcp-adapter@2.36.0",
  "npm:@diegopetrucci/pi-mcp-adapter@^5",
  "npm:@diegopetrucci/pi-mcp-adapter",
  "npm:pi-mcp-adapter",
  "npm:pi-mcp-adapter@2.11.0",
  "git:github.com/diegopetrucci/pi-mcp-adapter@tlh-v2.10.0-1",
  "git:github.com/nicobailon/pi-mcp-adapter",
]) {
  test(`adapter identity ${source} is force-removed from existing profiles`, () => {
    const fixture = bundledFixture({
      packages: [harnessPackage, source, "npm:user-package@1.0.0"],
    });

    const output = runMerge(fixture, { quiet: false });

    const after = readJson(fixture.settings);
    assert.ok(!packageSources(after).some((entry) => /mcp-adapter/.test(entry)));
    assert.ok(packageSources(after).includes("npm:user-package@1.0.0"));
    assert.ok(packageSources(after).includes(projectMcpJsonSource));
    assert.match(
      output,
      /force-remove retired default extension package: .*\(replaced by native \/mcp\)/,
    );
  });
}

test("adapter object entries and user-added filtered entries are force-removed", () => {
  const fixture = bundledFixture({
    packages: [
      harnessPackage,
      { source: "npm:@diegopetrucci/pi-mcp-adapter@5.0.2", extensions: [] },
      { source: "npm:pi-mcp-adapter", extensions: ["extensions/custom.js"] },
    ],
  });

  runMerge(fixture);

  assert.ok(!packageSources(readJson(fixture.settings)).some((entry) => /mcp-adapter/.test(entry)));
});

test("mcporter and its aliases are scrubbed from disabledDefaultExtensions and provenance", () => {
  const fixture = bundledFixture({
    packages: [harnessPackage, "npm:@diegopetrucci/pi-mcp-adapter@5.0.2"],
    tlh: {
      disabledDefaultExtensions: ["mcporter", "pi-mcp-adapter", "mcp-adapter", "inline-bash"],
      defaultExtensionProvenance: {
        managedPackageIdentities: [
          "npm:@diegopetrucci/pi-mcp-adapter",
          "npm:@diegopetrucci/pi-fast",
        ],
      },
    },
  });

  runMerge(fixture);

  const after = readJson(fixture.settings);
  assert.deepEqual(after.tlh.disabledDefaultExtensions, ["inline-bash"]);
  assert.ok(
    !JSON.stringify(after.tlh.defaultExtensionProvenance).includes("mcp-adapter"),
    "provenance must not keep adapter identities",
  );
});

test("a second merge after the adapter removal is a no-op", () => {
  const fixture = bundledFixture({
    packages: [harnessPackage, "npm:@diegopetrucci/pi-mcp-adapter@5.0.2"],
    extensions: [builtinMcpExclusion],
    tlh: { builtinMcpExclusionManaged: true },
  });

  runMerge(fixture);
  const output = runMerge(fixture, { quiet: false });

  assert.match(output, /No settings changes needed\./);
});

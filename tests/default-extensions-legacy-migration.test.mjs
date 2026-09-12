import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";

import { packageIdentity } from "../scripts/lib/default-extensions.mjs";

import {
  backupFiles,
  bundledExtension,
  bundledExtensionsPath,
  bundledSource,
  defaultsScript,
  harnessPackage,
  mergeScript,
  piTranscribeGitSource,
  piTranscribeNpmSource,
  previousBundledDirtyRepoGuardSource,
  previousBundledMcporterSource,
  previousMcporterSource,
  readJson,
  retiredPlannotatorPackage,
  runNode,
  tempFixture,
} from "./support/default-extensions-fixtures.mjs";

test("merge force-removes all pi-intercom package identities (string and object entries, duplicates, idempotent)", () => {
  const fixture = tempFixture();
  writeFileSync(
    fixture.extensions,
    JSON.stringify(
      [
        {
          id: "helper",
          source: "npm:helper",
        },
      ],
      null,
      2,
    ),
  );
  // Cover all 4 force-removed identities, both string and object forms, and a duplicate entry.
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: [
          harnessPackage,
          "npm:@diegopetrucci/pi-intercom@0.8.0",
          "npm:pi-intercom@0.7.0",
          { source: "git:github.com/nicobailon/pi-intercom@v0.6.0", owner: "preserve" },
          "git:github.com/diegopetrucci/pi-intercom@tlh-v0.6.0-6",
          "git:github.com/diegopetrucci/pi-intercom@tlh-v0.6.0-6",
          "npm:helper",
        ],
        tlh: { disabledDefaultExtensions: ["intercom", "pi-intercom", "helper"] },
      },
      null,
      2,
    ),
  );

  runNode(mergeScript, [
    fixture.defaults,
    "--settings",
    fixture.settings,
    "--default-extensions",
    fixture.extensions,
    "--quiet",
  ]);

  const settings = readJson(fixture.settings);
  // All intercom packages must be gone; unrelated packages survive (helper is
  // removed because it stays opted out via disabledDefaultExtensions).
  assert.deepEqual(settings.packages, [harnessPackage]);
  // Stale intercom opt-outs are pruned while unrelated opt-outs survive.
  assert.deepEqual(settings.tlh.disabledDefaultExtensions, ["helper"]);

  // Second merge is idempotent — no changes reported.
  const secondOutput = runNode(mergeScript, [
    fixture.defaults,
    "--settings",
    fixture.settings,
    "--default-extensions",
    fixture.extensions,
  ]);
  assert.match(secondOutput, /No settings changes needed\./);
});

test("merge force-removes pi-intercom and post-merge sources/critical-sources contain no intercom entry", () => {
  const fixture = tempFixture();
  writeFileSync(
    fixture.extensions,
    JSON.stringify(
      [
        {
          id: "helper",
          source: "npm:helper",
        },
      ],
      null,
      2,
    ),
  );
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: ["npm:@diegopetrucci/pi-intercom@0.8.0", "npm:helper"],
      },
      null,
      2,
    ),
  );

  runNode(mergeScript, [
    fixture.defaults,
    "--settings",
    fixture.settings,
    "--default-extensions",
    fixture.extensions,
    "--quiet",
  ]);

  const sources = runNode(defaultsScript, [
    "--settings",
    fixture.settings,
    "--defaults",
    fixture.extensions,
    "sources",
  ])
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.equal(
    sources.some((s) => s.includes("pi-intercom")),
    false,
    "sources must not contain any pi-intercom entry after force-removal",
  );

  const criticalSources = runNode(defaultsScript, [
    "--settings",
    fixture.settings,
    "--defaults",
    fixture.extensions,
    "critical-sources",
  ])
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.equal(
    criticalSources.some((s) => s.includes("pi-intercom")),
    false,
    "critical-sources must not contain any pi-intercom entry after force-removal",
  );
});

test("merge force-removes legacy pi-rtk packages and prunes stale rtk opt-outs", () => {
  const fixture = tempFixture();
  writeFileSync(
    fixture.extensions,
    JSON.stringify(
      [
        {
          id: "helper",
          source: "npm:helper",
        },
      ],
      null,
      2,
    ),
  );
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: [
          harnessPackage,
          "git:github.com/diegopetrucci/pi-rtk@tlh-v0.6.0-5",
          "npm:pi-rtk",
          "npm:@sherif-fanous/pi-rtk",
          "git:github.com/sherif-fanous/pi-rtk@v0.5.0",
          "npm:helper",
        ],
        tlh: { rtk: { disabled: true }, disabledDefaultExtensions: ["rtk", "pi-rtk", "helper"] },
      },
      null,
      2,
    ),
  );

  runNode(mergeScript, [
    fixture.defaults,
    "--settings",
    fixture.settings,
    "--default-extensions",
    fixture.extensions,
    "--quiet",
  ]);

  const settings = readJson(fixture.settings);
  assert.deepEqual(settings.packages, [harnessPackage]);
  assert.deepEqual(settings.tlh.disabledDefaultExtensions, ["helper"]);
  assert.equal(Object.hasOwn(settings.tlh, "rtk"), false);
});

test("merge no longer reorders quiet-tools around retired rtk packages", () => {
  const fixture = tempFixture();
  writeFileSync(
    fixture.extensions,
    JSON.stringify(
      [
        {
          id: "quiet-tools",
          aliases: ["compact-bash"],
          replaces: ["npm:@diegopetrucci/pi-compact-bash"],
          source: bundledSource("quiet-tools"),
        },
      ],
      null,
      2,
    ),
  );
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: [
          harnessPackage,
          "npm:before",
          "git:github.com/diegopetrucci/pi-rtk@tlh-v0.6.0-5",
          "npm:@diegopetrucci/pi-quiet-tools",
          "npm:after",
        ],
      },
      null,
      2,
    ),
  );

  const output = runNode(mergeScript, [
    fixture.defaults,
    "--settings",
    fixture.settings,
    "--default-extensions",
    fixture.extensions,
  ]);

  assert.doesNotMatch(output, /reorder targeted default extension packages for load order/);
  assert.deepEqual(readJson(fixture.settings).packages, [
    harnessPackage,
    "npm:before",
    bundledSource("quiet-tools"),
    "npm:after",
  ]);
});

test("tlh-defaults prunes legacy rtk opt-outs while mutating other defaults", () => {
  const fixture = tempFixture();
  writeFileSync(
    fixture.extensions,
    JSON.stringify(
      [
        {
          id: "helper",
          source: "npm:helper",
        },
      ],
      null,
      2,
    ),
  );
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: ["npm:helper"],
        tlh: { rtk: { disabled: true }, disabledDefaultExtensions: ["rtk", "pi-rtk"] },
      },
      null,
      2,
    ),
  );

  runNode(defaultsScript, [
    "--settings",
    fixture.settings,
    "--defaults",
    fixture.extensions,
    "disable",
    "helper",
  ]);

  const settings = readJson(fixture.settings);
  assert.deepEqual(settings.packages, []);
  assert.deepEqual(settings.tlh?.disabledDefaultExtensions ?? [], ["helper"]);
  assert.equal(Object.hasOwn(settings.tlh, "rtk"), false);
});

test("tlh-defaults persists retired tlh.rtk cleanup even when disable is otherwise a no-op", () => {
  const fixture = tempFixture();
  writeFileSync(
    fixture.extensions,
    JSON.stringify(
      [
        {
          id: "helper",
          source: "npm:helper",
        },
      ],
      null,
      2,
    ),
  );
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        tlh: {
          rtk: { disabled: true },
          disabledDefaultExtensions: ["helper"],
        },
      },
      null,
      2,
    ),
  );

  const output = runNode(defaultsScript, [
    "--settings",
    fixture.settings,
    "--defaults",
    fixture.extensions,
    "disable",
    "helper",
  ]);

  const settings = readJson(fixture.settings);
  assert.deepEqual(settings, {
    packages: [],
    tlh: {
      disabledDefaultExtensions: ["helper"],
      defaultExtensionProvenance: {
        managedPackageIdentities: [],
      },
    },
  });
  assert.equal(backupFiles(fixture.settings).length, 1);
  assert.doesNotMatch(output, /No settings changes were needed\./);
});

for (const scenario of [
  {
    command: "disable",
    initialSettings: {
      packages: [
        harnessPackage,
        retiredPlannotatorPackage,
        "npm:@diegopetrucci/pi-dirty-repo-guard",
      ],
    },
    expectedPackages: [harnessPackage],
    expectedDisabledDefaultExtensions: ["dirty-repo-guard"],
    expectedManagedPackageIdentities: [],
  },
  {
    command: "enable",
    initialSettings: {
      packages: [harnessPackage, retiredPlannotatorPackage],
      tlh: { disabledDefaultExtensions: ["dirty-repo-guard"] },
    },
    expectedPackages: [harnessPackage, bundledSource("dirty-repo-guard")],
    expectedDisabledDefaultExtensions: [],
    expectedManagedPackageIdentities: ["npm:@diegopetrucci/pi-dirty-repo-guard"],
  },
]) {
  test(`tlh-defaults ${scenario.command} preserves legacy retired default cleanup for merge`, () => {
    const fixture = tempFixture();
    writeFileSync(
      fixture.extensions,
      JSON.stringify(
        [
          {
            id: "dirty-repo-guard",
            source: bundledSource("dirty-repo-guard"),
          },
        ],
        null,
        2,
      ),
    );
    writeFileSync(fixture.settings, JSON.stringify(scenario.initialSettings, null, 2));

    runNode(defaultsScript, [
      "--settings",
      fixture.settings,
      "--defaults",
      fixture.extensions,
      scenario.command,
      "dirty-repo-guard",
    ]);

    const afterDefaults = readJson(fixture.settings);
    assert(
      afterDefaults.packages.includes(retiredPlannotatorPackage),
      "legacy retired package should still be present before merge cleanup",
    );

    const firstMergeOutput = runNode(mergeScript, [
      fixture.defaults,
      "--settings",
      fixture.settings,
      "--default-extensions",
      fixture.extensions,
    ]);
    assert.match(
      firstMergeOutput,
      /Will remove retired TLH default package: npm:@plannotator\/pi-extension/,
    );

    const afterFirstMerge = readJson(fixture.settings);
    assert.deepEqual(afterFirstMerge.packages, scenario.expectedPackages);
    assert.deepEqual(
      afterFirstMerge.tlh?.disabledDefaultExtensions ?? [],
      scenario.expectedDisabledDefaultExtensions,
    );
    assert.deepEqual(
      afterFirstMerge.tlh?.defaultExtensionProvenance?.managedPackageIdentities ?? [],
      scenario.expectedManagedPackageIdentities,
    );

    const secondMergeOutput = runNode(mergeScript, [
      fixture.defaults,
      "--settings",
      fixture.settings,
      "--default-extensions",
      fixture.extensions,
    ]);
    assert.match(secondMergeOutput, /No settings changes needed\./);
    assert.equal(
      secondMergeOutput.includes("retired TLH default package"),
      false,
      "retired cleanup should remain one-time",
    );
  });
}

test("tlh-defaults preserves pending retired default provenance across multiple mutations before merge", () => {
  const fixture = tempFixture();
  writeFileSync(
    fixture.extensions,
    JSON.stringify(
      [
        {
          id: "dirty-repo-guard",
          source: bundledSource("dirty-repo-guard"),
        },
      ],
      null,
      2,
    ),
  );
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: [harnessPackage, retiredPlannotatorPackage, bundledSource("dirty-repo-guard")],
      },
      null,
      2,
    ),
  );

  runNode(defaultsScript, [
    "--settings",
    fixture.settings,
    "--defaults",
    fixture.extensions,
    "disable",
    "dirty-repo-guard",
  ]);
  runNode(defaultsScript, [
    "--settings",
    fixture.settings,
    "--defaults",
    fixture.extensions,
    "enable",
    "dirty-repo-guard",
  ]);

  const afterDefaults = readJson(fixture.settings);
  assert.deepEqual(afterDefaults.packages, [
    harnessPackage,
    retiredPlannotatorPackage,
    bundledSource("dirty-repo-guard"),
  ]);
  assert.deepEqual(afterDefaults.tlh?.disabledDefaultExtensions ?? [], []);
  assert.deepEqual(afterDefaults.tlh?.defaultExtensionProvenance?.managedPackageIdentities ?? [], [
    "npm:@diegopetrucci/pi-dirty-repo-guard",
    "npm:@plannotator/pi-extension",
  ]);

  const firstMergeOutput = runNode(mergeScript, [
    fixture.defaults,
    "--settings",
    fixture.settings,
    "--default-extensions",
    fixture.extensions,
  ]);
  assert.match(
    firstMergeOutput,
    /Will remove retired TLH default package: npm:@plannotator\/pi-extension/,
  );

  const afterMerge = readJson(fixture.settings);
  assert.deepEqual(afterMerge.packages, [harnessPackage, bundledSource("dirty-repo-guard")]);
  assert.deepEqual(afterMerge.tlh?.defaultExtensionProvenance?.managedPackageIdentities ?? [], [
    "npm:@diegopetrucci/pi-dirty-repo-guard",
  ]);
});

test("mcporter migration handles prior TLH-managed and manual installs", () => {
  const bundledPath = bundledExtensionsPath;
  const mcporter = bundledExtension("mcporter");

  const replacementMergeFixture = tempFixture();
  writeFileSync(replacementMergeFixture.extensions, JSON.stringify([mcporter], null, 2));
  writeFileSync(
    replacementMergeFixture.settings,
    JSON.stringify({ packages: [previousMcporterSource] }, null, 2),
  );

  runNode(mergeScript, [
    replacementMergeFixture.defaults,
    "--settings",
    replacementMergeFixture.settings,
    "--default-extensions",
    replacementMergeFixture.extensions,
    "--quiet",
  ]);

  const replacementMergedSettings = readJson(replacementMergeFixture.settings);
  assert.deepEqual(replacementMergedSettings.packages, [harnessPackage, bundledSource("mcporter")]);
  assert.deepEqual(
    replacementMergedSettings.tlh.defaultExtensionProvenance.managedPackageIdentities,
    ["npm:@diegopetrucci/pi-mcp-adapter"],
  );

  const managedPinnedFixture = tempFixture();
  writeFileSync(managedPinnedFixture.extensions, JSON.stringify([mcporter], null, 2));
  writeFileSync(
    managedPinnedFixture.settings,
    JSON.stringify(
      {
        packages: [previousBundledMcporterSource],
        tlh: {
          defaultExtensionProvenance: {
            managedPackageIdentities: ["npm:@diegopetrucci/pi-mcp-adapter"],
          },
        },
      },
      null,
      2,
    ),
  );

  runNode(mergeScript, [
    managedPinnedFixture.defaults,
    "--settings",
    managedPinnedFixture.settings,
    "--default-extensions",
    managedPinnedFixture.extensions,
    "--quiet",
  ]);

  const managedPinnedSettings = readJson(managedPinnedFixture.settings);
  assert.equal(managedPinnedSettings.packages.includes(bundledSource("mcporter")), true);
  assert.equal(managedPinnedSettings.packages.includes(previousBundledMcporterSource), false);
  assert.equal(managedPinnedSettings.packages.includes(harnessPackage), true);
  assert.deepEqual(managedPinnedSettings.tlh.defaultExtensionProvenance.managedPackageIdentities, [
    "npm:@diegopetrucci/pi-mcp-adapter",
  ]);

  const manualPinnedFixture = tempFixture();
  writeFileSync(manualPinnedFixture.extensions, JSON.stringify([mcporter], null, 2));
  writeFileSync(
    manualPinnedFixture.settings,
    JSON.stringify({ packages: [previousBundledMcporterSource] }, null, 2),
  );

  runNode(mergeScript, [
    manualPinnedFixture.defaults,
    "--settings",
    manualPinnedFixture.settings,
    "--default-extensions",
    manualPinnedFixture.extensions,
    "--quiet",
  ]);

  const manualPinnedSettings = readJson(manualPinnedFixture.settings);
  assert.equal(manualPinnedSettings.packages.includes(previousBundledMcporterSource), true);
  assert.equal(manualPinnedSettings.packages.includes(bundledSource("mcporter")), false);
  assert.equal(manualPinnedSettings.packages.includes(harnessPackage), true);
  assert.deepEqual(
    manualPinnedSettings.tlh.defaultExtensionProvenance.managedPackageIdentities,
    [],
  );

  const disableFixture = tempFixture();
  writeFileSync(
    disableFixture.settings,
    JSON.stringify({ packages: [previousMcporterSource] }, null, 2),
  );

  runNode(defaultsScript, [
    "--settings",
    disableFixture.settings,
    "--defaults",
    bundledPath,
    "disable",
    "mcp-adapter",
  ]);

  const disabledSettings = readJson(disableFixture.settings);
  assert.deepEqual(disabledSettings.tlh.disabledDefaultExtensions, ["mcporter"]);
  assert.deepEqual(disabledSettings.packages, []);
});

test("tlh-defaults disable migrates the fast alias and removes the replaced package", () => {
  const fixture = tempFixture();
  writeFileSync(
    fixture.settings,
    JSON.stringify({ packages: ["npm:@diegopetrucci/pi-openai-fast"] }, null, 2),
  );

  runNode(defaultsScript, [
    "--settings",
    fixture.settings,
    "--defaults",
    bundledExtensionsPath,
    "disable",
    "openai-fast",
  ]);

  const settings = readJson(fixture.settings);
  assert.deepEqual(
    settings.tlh.disabledDefaultExtensions,
    ["fast"],
    "disabling by alias should normalise to the canonical fast id",
  );
  assert.deepEqual(settings.packages, []);
});

test("future pi-transcribe npm manifest migrates TLH-managed Git installs and preserves manual npm pins", () => {
  const bundled = bundledExtension("pi-transcribe");
  assert.ok(bundled, "bundled pi-transcribe default should exist");
  const futurePiTranscribe = {
    ...bundled,
    replaces: [piTranscribeGitSource],
    migrateReplacements: true,
    source: piTranscribeNpmSource,
  };

  const managedFixture = tempFixture();
  writeFileSync(managedFixture.extensions, JSON.stringify([futurePiTranscribe], null, 2));
  writeFileSync(
    managedFixture.settings,
    JSON.stringify(
      {
        packages: [harnessPackage, piTranscribeGitSource, "npm:user-owned-package@1.2.3"],
        tlh: {
          defaultExtensionProvenance: {
            managedPackageIdentities: [packageIdentity(piTranscribeGitSource)],
          },
        },
      },
      null,
      2,
    ),
  );

  runNode(mergeScript, [
    managedFixture.defaults,
    "--settings",
    managedFixture.settings,
    "--default-extensions",
    managedFixture.extensions,
    "--quiet",
  ]);

  const managedSettings = readJson(managedFixture.settings);
  assert.equal(managedSettings.packages.includes(piTranscribeGitSource), false);
  assert.equal(managedSettings.packages.includes(piTranscribeNpmSource), true);
  assert.equal(managedSettings.packages.includes("npm:user-owned-package@1.2.3"), true);
  assert.deepEqual(managedSettings.tlh.defaultExtensionProvenance.managedPackageIdentities, [
    "npm:@earendil-works/pi-transcribe",
  ]);

  const manualFixture = tempFixture();
  const manualPiTranscribeSource = "npm:@earendil-works/pi-transcribe@0.0.0";
  writeFileSync(manualFixture.extensions, JSON.stringify([futurePiTranscribe], null, 2));
  writeFileSync(
    manualFixture.settings,
    JSON.stringify(
      {
        packages: [harnessPackage, manualPiTranscribeSource, "npm:user-owned-package@1.2.3"],
        tlh: { defaultExtensionProvenance: { managedPackageIdentities: [] } },
      },
      null,
      2,
    ),
  );

  runNode(mergeScript, [
    manualFixture.defaults,
    "--settings",
    manualFixture.settings,
    "--default-extensions",
    manualFixture.extensions,
    "--quiet",
  ]);

  const manualSettings = readJson(manualFixture.settings);
  assert.deepEqual(manualSettings.packages, [
    harnessPackage,
    manualPiTranscribeSource,
    "npm:user-owned-package@1.2.3",
  ]);
  assert.deepEqual(manualSettings.tlh.defaultExtensionProvenance.managedPackageIdentities, []);
});

test("bundled same-identity managed npm pins advance while manual pins stay untouched", () => {
  const fixtureExtension = {
    id: "dirty-repo-guard",
    source: bundledSource("dirty-repo-guard"),
  };

  const managedPinnedFixture = tempFixture();
  writeFileSync(managedPinnedFixture.extensions, JSON.stringify([fixtureExtension], null, 2));
  writeFileSync(
    managedPinnedFixture.settings,
    JSON.stringify(
      {
        packages: [previousBundledDirtyRepoGuardSource],
        tlh: {
          defaultExtensionProvenance: {
            managedPackageIdentities: ["npm:@diegopetrucci/pi-dirty-repo-guard"],
          },
        },
      },
      null,
      2,
    ),
  );

  runNode(mergeScript, [
    managedPinnedFixture.defaults,
    "--settings",
    managedPinnedFixture.settings,
    "--default-extensions",
    managedPinnedFixture.extensions,
    "--quiet",
  ]);

  const managedPinnedSettings = readJson(managedPinnedFixture.settings);
  assert.equal(managedPinnedSettings.packages.includes(bundledSource("dirty-repo-guard")), true);
  assert.equal(managedPinnedSettings.packages.includes(previousBundledDirtyRepoGuardSource), false);
  assert.deepEqual(managedPinnedSettings.tlh.defaultExtensionProvenance.managedPackageIdentities, [
    "npm:@diegopetrucci/pi-dirty-repo-guard",
  ]);

  const manualPinnedFixture = tempFixture();
  writeFileSync(manualPinnedFixture.extensions, JSON.stringify([fixtureExtension], null, 2));
  writeFileSync(
    manualPinnedFixture.settings,
    JSON.stringify(
      {
        packages: [previousBundledDirtyRepoGuardSource],
      },
      null,
      2,
    ),
  );

  runNode(mergeScript, [
    manualPinnedFixture.defaults,
    "--settings",
    manualPinnedFixture.settings,
    "--default-extensions",
    manualPinnedFixture.extensions,
    "--quiet",
  ]);

  const manualPinnedSettings = readJson(manualPinnedFixture.settings);
  assert.equal(manualPinnedSettings.packages.includes(previousBundledDirtyRepoGuardSource), true);
  assert.equal(manualPinnedSettings.packages.includes(bundledSource("dirty-repo-guard")), false);
  assert.deepEqual(
    manualPinnedSettings.tlh.defaultExtensionProvenance.managedPackageIdentities,
    [],
  );
});

test("bundled merge removes legacy upstream and TLH subagents git installs via retirement list", () => {
  // The subagents external default has been retired: legacy git packages are cleaned
  // up by applyRetiredTlhDefaultPackageCleanup (RETIRED_TLH_SUBAGENTS_DEFAULT_PACKAGE_SOURCES is
  // included in RETIRED_TLH_DEFAULT_PACKAGE_SOURCES). No npm source is added in their place because
  // the first-party bundled extension is now registered directly via package.json.
  const fixture = tempFixture();
  const bundledPath = bundledExtensionsPath;
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: [
          harnessPackage,
          "git:github.com/nicobailon/pi-subagents@v0.31.0",
          "git:github.com/diegopetrucci/pi-subagents@tlh-v0.31.1",
          "npm:unrelated-ext",
        ],
        tlh: { disabledDefaultExtensions: ["pi-subagents", "other-ext"] },
      },
      null,
      2,
    ),
  );

  runNode(mergeScript, [
    fixture.defaults,
    "--settings",
    fixture.settings,
    "--default-extensions",
    bundledPath,
    "--quiet",
  ]);

  const settings = readJson(fixture.settings);
  // Both legacy git installs must be removed.
  assert.equal(
    settings.packages.some(
      (entry) => packageIdentity(entry) === "git:github.com/nicobailon/pi-subagents",
    ),
    false,
    "legacy nicobailon git install must be removed",
  );
  assert.equal(
    settings.packages.some(
      (entry) => packageIdentity(entry) === "git:github.com/diegopetrucci/pi-subagents",
    ),
    false,
    "legacy TLH git install must be removed",
  );
  // No npm replacement must be added.
  assert.equal(
    settings.packages.some((entry) => packageIdentity(entry) === "npm:@diegopetrucci/pi-subagents"),
    false,
    "no npm subagents source may be added by retirement migration",
  );
  // Unrelated package must survive.
  assert.ok(
    settings.packages.some((entry) => packageIdentity(entry) === "npm:unrelated-ext"),
    "unrelated package must be preserved",
  );
  // pi-subagents opt-out must be pruned; unrelated opt-out must survive.
  assert.equal(
    (settings.tlh?.disabledDefaultExtensions ?? []).some(
      (v) => v === "subagents" || v === "pi-subagents",
    ),
    false,
    "stale subagents opt-out must be pruned",
  );
  assert.ok(
    (settings.tlh?.disabledDefaultExtensions ?? []).includes("other-ext"),
    "unrelated opt-out must be preserved",
  );
});

test("bundled merge preserves a manually installed subagents npm package (modern profile, not in provenance)", () => {
  // A modern profile (provenance block exists) where subagents is NOT in managedPackageIdentities:
  // the package must be treated as user-added and preserved.
  const fixture = tempFixture();
  const bundledPath = bundledExtensionsPath;
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: [harnessPackage, "npm:@diegopetrucci/pi-subagents@0.31.14"],
        tlh: {
          defaultExtensionProvenance: {
            managedPackageIdentities: [], // provenance exists but subagents is NOT managed
          },
        },
      },
      null,
      2,
    ),
  );

  const output = runNode(mergeScript, [
    fixture.defaults,
    "--settings",
    fixture.settings,
    "--default-extensions",
    bundledPath,
  ]);

  const settings = readJson(fixture.settings);
  assert.ok(
    settings.packages.some((entry) => packageIdentity(entry) === "npm:@diegopetrucci/pi-subagents"),
    "user-added subagents package must be preserved when not managed",
  );
  assert.equal(output.includes("pi-subagents"), false, "merge must not log any subagents removal");
});

test("bundled merge prunes stale subagents and pi-subagents opt-outs from tlh.disabledDefaultExtensions", () => {
  const fixture = tempFixture();
  const bundledPath = bundledExtensionsPath;
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: [harnessPackage],
        tlh: { disabledDefaultExtensions: ["subagents", "pi-subagents", "notify"] },
      },
      null,
      2,
    ),
  );

  const output = runNode(mergeScript, [
    fixture.defaults,
    "--settings",
    fixture.settings,
    "--default-extensions",
    bundledPath,
  ]);

  const settings = readJson(fixture.settings);
  assert.match(output, /remove stale subagents opt-out from tlh\.disabledDefaultExtensions/);
  assert.equal(
    (settings.tlh?.disabledDefaultExtensions ?? []).some(
      (v) => v === "subagents" || v === "pi-subagents",
    ),
    false,
    "stale subagents opt-outs must be removed",
  );
  assert.ok(
    (settings.tlh?.disabledDefaultExtensions ?? []).includes("notify"),
    "unrelated opt-out must be preserved",
  );
});

test("bundled merge force-removes legacy TLH intercom git installs via the retirement list", () => {
  const fixture = tempFixture();
  const bundledPath = bundledExtensionsPath;
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: ["git:github.com/diegopetrucci/pi-intercom@tlh-v0.6.0-6"],
        tlh: { disabledDefaultExtensions: ["pi-intercom"] },
      },
      null,
      2,
    ),
  );

  runNode(mergeScript, [
    fixture.defaults,
    "--settings",
    fixture.settings,
    "--default-extensions",
    bundledPath,
    "--quiet",
  ]);

  const settings = readJson(fixture.settings);
  // The legacy git install must be force-removed (not migrated to any npm source).
  assert.equal(
    settings.packages.some(
      (entry) => packageIdentity(entry) === "git:github.com/diegopetrucci/pi-intercom",
    ),
    false,
    "legacy git intercom install must be force-removed",
  );
  assert.equal(
    settings.packages.some((entry) =>
      (typeof entry === "string" ? entry : entry.source).includes("pi-intercom"),
    ),
    false,
    "no pi-intercom source should remain after bundled merge",
  );
});

// ── notify retirement tests ──────────────────────────────────────────────────

test("bundled merge force-removes the notify npm install (now bundled first-party)", () => {
  // notify is now a bundled first-party extension; the npm package must be removed so
  // that two notify extensions do not run in parallel and fire every notification twice.
  const fixture = tempFixture();
  const bundledPath = bundledExtensionsPath;
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: ["npm:@diegopetrucci/pi-notify@0.1.15", harnessPackage],
        tlh: { disabledDefaultExtensions: ["notify"] },
      },
      null,
      2,
    ),
  );

  runNode(mergeScript, [
    fixture.defaults,
    "--settings",
    fixture.settings,
    "--default-extensions",
    bundledPath,
    "--quiet",
  ]);

  const settings = readJson(fixture.settings);
  // The npm notify package must be force-removed.
  assert.equal(
    settings.packages.some((entry) => packageIdentity(entry) === "npm:@diegopetrucci/pi-notify"),
    false,
    "npm pi-notify install must be force-removed after bundling",
  );
  // The stale opt-out is preserved (harmless unknown id; no pruner is intentionally registered).
  assert.ok(
    (settings.tlh?.disabledDefaultExtensions ?? []).includes("notify"),
    "stale notify opt-out must be preserved as a harmless unknown id",
  );
});

// ── fff retirement tests ─────────────────────────────────────────────────────

test("bundled merge removes a TLH-managed fff package (provenance-gated, legacy profile)", () => {
  // A legacy profile with no provenance block: withLegacyRetiredDefaultPackageIdentities
  // treats any retired package present as managed and enqueues it for removal.
  const fixture = tempFixture();
  const bundledPath = bundledExtensionsPath;
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: [
          harnessPackage,
          "npm:@ff-labs/pi-fff@0.10.1",
          "npm:@diegopetrucci/pi-inline-bash@0.1.5",
        ],
      },
      null,
      2,
    ),
  );

  const output = runNode(mergeScript, [
    fixture.defaults,
    "--settings",
    fixture.settings,
    "--default-extensions",
    bundledPath,
  ]);

  const settings = readJson(fixture.settings);
  assert.match(output, /Will remove retired TLH default package: npm:@ff-labs\/pi-fff/);
  assert.equal(
    settings.packages.some((entry) => packageIdentity(entry) === "npm:@ff-labs/pi-fff"),
    false,
    "TLH-managed fff package must be removed",
  );
  assert.equal(
    settings.packages.some(
      (entry) => packageIdentity(entry) === "npm:@diegopetrucci/pi-inline-bash",
    ),
    true,
    "unrelated managed package must be preserved",
  );
});

test("bundled merge preserves a manually added fff package (provenance block exists, not managed)", () => {
  // A modern profile with a provenance block: withLegacyRetiredDefaultPackageIdentities
  // skips the legacy carry-over path. A fff package not listed in managedPackageIdentities
  // is treated as user-added and must be preserved.
  const fixture = tempFixture();
  const bundledPath = bundledExtensionsPath;
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: [harnessPackage, "npm:@ff-labs/pi-fff@0.10.1"],
        tlh: {
          defaultExtensionProvenance: {
            managedPackageIdentities: [], // provenance exists but fff is NOT managed
          },
        },
      },
      null,
      2,
    ),
  );

  const output = runNode(mergeScript, [
    fixture.defaults,
    "--settings",
    fixture.settings,
    "--default-extensions",
    bundledPath,
    "--quiet",
  ]);

  const settings = readJson(fixture.settings);
  assert.equal(
    settings.packages.some((entry) => packageIdentity(entry) === "npm:@ff-labs/pi-fff"),
    true,
    "manually added fff package must be preserved",
  );
  assert.equal(output.includes("pi-fff"), false, "merge must not log any fff removal");
});

test("bundled merge prunes stale fff and pi-fff opt-outs from tlh.disabledDefaultExtensions", () => {
  const fixture = tempFixture();
  const bundledPath = bundledExtensionsPath;
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: [harnessPackage],
        tlh: { disabledDefaultExtensions: ["fff", "pi-fff", "notify"] },
      },
      null,
      2,
    ),
  );

  const output = runNode(mergeScript, [
    fixture.defaults,
    "--settings",
    fixture.settings,
    "--default-extensions",
    bundledPath,
  ]);

  const settings = readJson(fixture.settings);
  assert.match(output, /remove stale fff opt-out from tlh\.disabledDefaultExtensions/);
  assert.equal(
    (settings.tlh?.disabledDefaultExtensions ?? []).some((v) => v === "fff" || v === "pi-fff"),
    false,
    "stale fff opt-outs must be removed",
  );
  assert.equal(
    (settings.tlh?.disabledDefaultExtensions ?? []).includes("notify"),
    true,
    "unrelated opt-out must be preserved",
  );
});

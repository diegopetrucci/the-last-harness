import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";

import { packageIdentity } from "../scripts/lib/default-extensions.mjs";

import {
  backupFiles,
  bundledExtension,
  bundledExtensionsPath,
  bundledSource,
  currentPiTranscribeGitSource,
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

test("merge force-removes pi-quiet-tools and pi-compact-bash (string and object entries, duplicates, idempotent)", () => {
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
  // Cover both package identities (quiet-tools and legacy compact-bash), object
  // form, and a duplicate entry.
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: [
          harnessPackage,
          "npm:@diegopetrucci/pi-quiet-tools@0.1.12",
          { source: "npm:@diegopetrucci/pi-quiet-tools@0.1.10", owner: "user" },
          "npm:@diegopetrucci/pi-compact-bash@0.1.5",
          "npm:@diegopetrucci/pi-quiet-tools@0.1.12",
          "npm:helper",
        ],
        tlh: { disabledDefaultExtensions: ["quiet-tools", "compact-bash", "helper"] },
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
  // All quiet-tools and compact-bash packages must be stripped unconditionally,
  // even object entries marked owner:user.
  assert.deepEqual(settings.packages, [harnessPackage]);

  // quiet-tools and compact-bash are pruned from disabledDefaultExtensions;
  // the unrelated 'helper' entry must survive.
  assert.equal(
    (settings.tlh?.disabledDefaultExtensions ?? []).some(
      (v) => v === "quiet-tools" || v === "compact-bash",
    ),
    false,
    "quiet-tools and compact-bash opt-outs must be pruned from disabledDefaultExtensions",
  );
  assert.equal(
    (settings.tlh?.disabledDefaultExtensions ?? []).includes("helper"),
    true,
    "unrelated helper opt-out must survive",
  );

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

test("merge force-removes pi-quiet-tools even when provenance marks it as manually re-added", () => {
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
          "npm:@diegopetrucci/pi-quiet-tools@0.1.12",
          "npm:@diegopetrucci/pi-compact-bash@0.1.5",
          "npm:helper",
        ],
        tlh: {
          defaultExtensionProvenance: {
            // Simulate a user who manually re-added both packages.
            managedPackageIdentities: [],
          },
        },
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
  assert.ok(
    !settings.packages.some(
      (p) =>
        (typeof p === "string" ? p : (p?.source ?? "")).includes("pi-quiet-tools") ||
        (typeof p === "string" ? p : (p?.source ?? "")).includes("pi-compact-bash"),
    ),
    "force-removal must apply even when provenance does not mark packages as managed",
  );
  assert.ok(
    settings.packages.includes("npm:helper"),
    "unrelated packages must survive force-removal",
  );
});

test("merge no longer reorders a bundled extension upgrade around retired rtk packages", () => {
  // Original intent: with force-removed rtk packages mixed in, an unpinned npm
  // entry for a still-bundled extension is upgraded to the pinned bundled source
  // without emitting a load-order reorder message.
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
        packages: [
          harnessPackage,
          "npm:before",
          "git:github.com/diegopetrucci/pi-rtk@tlh-v0.6.0-5",
          "npm:@diegopetrucci/pi-dirty-repo-guard",
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
    bundledSource("dirty-repo-guard"),
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

test("Pi Voice migration replaces current and historical pi-transcribe pins", () => {
  const bundled = bundledExtension("pi-voice");
  assert.ok(bundled, "bundled pi-voice default should exist");
  assert.deepEqual(bundled.aliases, ["pi-transcribe"]);
  assert.equal(bundled.source, "npm:@earendil-works/pi-voice@0.1.0");
  assert.equal(bundled.migrateReplacements, true);

  const fixture = tempFixture();
  writeFileSync(fixture.extensions, JSON.stringify([bundled], null, 2));
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: [
          harnessPackage,
          currentPiTranscribeGitSource,
          piTranscribeGitSource,
          piTranscribeNpmSource,
          "npm:@earendil-works/pi-transcribe@0.0.0",
          "npm:user-owned-package@1.2.3",
        ],
        tlh: {
          defaultExtensionProvenance: {
            managedPackageIdentities: [
              packageIdentity(currentPiTranscribeGitSource),
              packageIdentity(piTranscribeNpmSource),
            ],
          },
        },
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
  assert.deepEqual(settings.packages, [
    harnessPackage,
    "npm:user-owned-package@1.2.3",
    bundled.source,
  ]);
  assert.deepEqual(settings.tlh.defaultExtensionProvenance.managedPackageIdentities, [
    "npm:@earendil-works/pi-voice",
  ]);
});

test("Pi Voice migration removes legacy pins even when they are not provenance-managed", () => {
  const bundled = bundledExtension("pi-voice");
  assert.ok(bundled, "bundled pi-voice default should exist");

  const fixture = tempFixture();
  writeFileSync(fixture.extensions, JSON.stringify([bundled], null, 2));
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: [
          harnessPackage,
          piTranscribeGitSource,
          "npm:@earendil-works/pi-transcribe@0.0.0",
          "npm:user-owned-package@1.2.3",
        ],
        tlh: { defaultExtensionProvenance: { managedPackageIdentities: [] } },
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
  assert.deepEqual(settings.packages, [
    harnessPackage,
    "npm:user-owned-package@1.2.3",
    bundled.source,
  ]);
  assert.deepEqual(settings.tlh.defaultExtensionProvenance.managedPackageIdentities, [
    "npm:@earendil-works/pi-voice",
  ]);
});

test("tlh-defaults disable accepts the pi-transcribe compatibility alias", () => {
  const bundled = bundledExtension("pi-voice");
  assert.ok(bundled, "bundled pi-voice default should exist");

  const fixture = tempFixture();
  writeFileSync(fixture.extensions, JSON.stringify([bundled], null, 2));
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: [harnessPackage, bundled.source, piTranscribeGitSource],
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
    "pi-transcribe",
  ]);

  const settings = readJson(fixture.settings);
  assert.deepEqual(settings.tlh.disabledDefaultExtensions, ["pi-voice"]);
  assert.deepEqual(settings.packages, [harnessPackage]);
});

for (const filter of [[], ["-*"], ["!*"], ["-index.ts"], ["!index.ts"]]) {
  test(`merge migrates filtered Pi Voice replacement objects in place ${JSON.stringify(filter)}`, () => {
    const bundled = bundledExtension("pi-voice");
    assert.ok(bundled, "bundled pi-voice default should exist");

    const legacyEntry = {
      source: piTranscribeGitSource,
      extensions: filter,
      autoload: true,
      resources: ["model.bin"],
      userMetadata: { preserve: true },
    };
    const fixture = tempFixture();
    writeFileSync(fixture.extensions, JSON.stringify([bundled], null, 2));
    writeFileSync(
      fixture.settings,
      JSON.stringify(
        {
          packages: [harnessPackage, legacyEntry],
          tlh: { userFlag: true },
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
    assert.deepEqual(settings.packages, [
      harnessPackage,
      { ...legacyEntry, source: bundled.source },
    ]);
    assert.deepEqual(settings.tlh.disabledDefaultExtensions ?? [], []);
    assert.deepEqual(settings.tlh.defaultExtensionProvenance.managedPackageIdentities, []);
    assert.equal(settings.tlh.userFlag, true);
  });
}

test("merge preserves a filtered canonical Pi Voice object without a durable opt-out", () => {
  const bundled = bundledExtension("pi-voice");
  assert.ok(bundled, "bundled pi-voice default should exist");
  const canonicalEntry = {
    source: bundled.source,
    extensions: ["!*"],
    autoload: true,
    resources: ["model.bin"],
    userMetadata: { preserve: true },
  };
  const fixture = tempFixture();
  writeFileSync(fixture.extensions, JSON.stringify([bundled], null, 2));
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: [harnessPackage, canonicalEntry],
        tlh: { userFlag: true },
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
  assert.deepEqual(settings.packages, [harnessPackage, canonicalEntry]);
  assert.deepEqual(settings.tlh.disabledDefaultExtensions ?? [], []);
  assert.deepEqual(settings.tlh.defaultExtensionProvenance.managedPackageIdentities, []);
  assert.equal(settings.tlh.userFlag, true);
});

test("merge preserves filtered unrelated default objects without deriving opt-outs", () => {
  const bundled = bundledExtension("pi-voice");
  assert.ok(bundled, "bundled pi-voice default should exist");
  const unrelated = {
    id: "unrelated-default",
    source: "npm:unrelated-default@1.0.0",
    description: "fixture",
  };
  const unrelatedEntry = {
    source: unrelated.source,
    extensions: [],
    autoload: true,
    resources: ["fixture.txt"],
    userMetadata: { preserve: true },
  };
  const fixture = tempFixture();
  writeFileSync(fixture.extensions, JSON.stringify([bundled, unrelated], null, 2));
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: [harnessPackage, unrelatedEntry, "npm:user-owned-package@1.2.3"],
        tlh: { userFlag: true },
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
  assert.deepEqual(settings.packages, [
    harnessPackage,
    unrelatedEntry,
    "npm:user-owned-package@1.2.3",
    bundled.source,
  ]);
  assert.deepEqual(settings.tlh.disabledDefaultExtensions ?? [], []);
  assert.equal(settings.tlh.userFlag, true);
});

for (const sourceKind of ["canonical", "replacement"]) {
  test(`tlh-defaults reports a filtered Pi Voice ${sourceKind} as disabled by package filter`, () => {
    const bundled = bundledExtension("pi-voice");
    assert.ok(bundled, "bundled pi-voice default should exist");
    const source = sourceKind === "canonical" ? bundled.source : piTranscribeGitSource;
    const fixture = tempFixture();
    writeFileSync(fixture.extensions, JSON.stringify([bundled], null, 2));
    writeFileSync(
      fixture.settings,
      JSON.stringify(
        {
          packages: [{ source, extensions: [], userMetadata: { preserve: true } }],
        },
        null,
        2,
      ),
    );

    const list = runNode(defaultsScript, [
      "--settings",
      fixture.settings,
      "--defaults",
      fixture.extensions,
      "list",
    ]);
    assert.match(list, /disabled\s+pi-voice/);
    assert.match(list, /disabled by package filter/);

    const sources = runNode(defaultsScript, [
      "--settings",
      fixture.settings,
      "--defaults",
      fixture.extensions,
      "sources",
    ]);
    assert.equal(sources.trim(), "");
  });
}

test("merge preserves partial package filters and unknown Pi Voice metadata", () => {
  const bundled = bundledExtension("pi-voice");
  assert.ok(bundled, "bundled pi-voice default should exist");
  const fixture = tempFixture();
  writeFileSync(fixture.extensions, JSON.stringify([bundled], null, 2));
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: [
          harnessPackage,
          {
            source: piTranscribeGitSource,
            extensions: ["-src/extension/index.ts"],
            autoload: true,
            userMetadata: { preserve: true },
          },
        ],
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

  assert.deepEqual(readJson(fixture.settings).packages, [
    harnessPackage,
    {
      source: bundled.source,
      extensions: ["-src/extension/index.ts"],
      autoload: true,
      userMetadata: { preserve: true },
    },
  ]);
});

test("tlh-defaults enable migrates an object replacement without dropping metadata", () => {
  const bundled = bundledExtension("pi-voice");
  assert.ok(bundled, "bundled pi-voice default should exist");
  const fixture = tempFixture();
  writeFileSync(fixture.extensions, JSON.stringify([bundled], null, 2));
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: [
          {
            source: piTranscribeGitSource,
            extensions: [],
            autoload: true,
            userMetadata: { preserve: true },
          },
        ],
        tlh: { disabledDefaultExtensions: ["pi-voice"] },
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
    "enable",
    "pi-voice",
  ]);

  const settings = readJson(fixture.settings);
  assert.deepEqual(settings.packages, [
    {
      source: bundled.source,
      autoload: true,
      userMetadata: { preserve: true },
    },
  ]);
  assert.deepEqual(settings.tlh.disabledDefaultExtensions, []);
});

test("merge preserves a manual canonical object pin when a replacement coexists", () => {
  const bundled = bundledExtension("pi-voice");
  assert.ok(bundled, "bundled pi-voice default should exist");
  const manualCanonicalSource = "npm:@earendil-works/pi-voice@0.0.9";
  const manualCanonicalEntry = {
    source: manualCanonicalSource,
    extensions: ["src/extension/index.ts"],
    autoload: true,
    userMetadata: { preserve: true },
  };
  const fixture = tempFixture();
  writeFileSync(fixture.extensions, JSON.stringify([bundled], null, 2));
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: [
          harnessPackage,
          {
            source: piTranscribeGitSource,
            extensions: ["src/extension/index.ts"],
            replacementMetadata: { preserve: false },
          },
          manualCanonicalEntry,
        ],
        tlh: { defaultExtensionProvenance: { managedPackageIdentities: [] } },
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
  assert.deepEqual(settings.packages, [harnessPackage, manualCanonicalEntry]);
  assert.deepEqual(settings.tlh.defaultExtensionProvenance.managedPackageIdentities, []);
});

test("tlh-defaults enable preserves a manual canonical object pin when a replacement coexists", () => {
  const bundled = bundledExtension("pi-voice");
  assert.ok(bundled, "bundled pi-voice default should exist");
  const manualCanonicalEntry = {
    source: "npm:@earendil-works/pi-voice@0.0.9",
    extensions: ["src/extension/index.ts"],
    autoload: true,
    userMetadata: { preserve: true },
  };
  const fixture = tempFixture();
  writeFileSync(fixture.extensions, JSON.stringify([bundled], null, 2));
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: [
          {
            source: piTranscribeGitSource,
            extensions: ["src/extension/index.ts"],
            replacementMetadata: { preserve: false },
          },
          manualCanonicalEntry,
        ],
        tlh: {
          disabledDefaultExtensions: ["pi-voice"],
          defaultExtensionProvenance: { managedPackageIdentities: [] },
        },
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
    "enable",
    "pi-voice",
  ]);

  const settings = readJson(fixture.settings);
  assert.deepEqual(settings.packages, [
    {
      source: "npm:@earendil-works/pi-voice@0.0.9",
      autoload: true,
      userMetadata: { preserve: true },
    },
  ]);
  assert.deepEqual(settings.tlh.disabledDefaultExtensions, []);
  assert.deepEqual(settings.tlh.defaultExtensionProvenance.managedPackageIdentities, []);
});

test("merge preserves a canonical string pin when a replacement object coexists", () => {
  const bundled = bundledExtension("pi-voice");
  assert.ok(bundled, "bundled pi-voice default should exist");
  const manualCanonicalSource = "npm:@earendil-works/pi-voice@0.0.9";
  const fixture = tempFixture();
  writeFileSync(fixture.extensions, JSON.stringify([bundled], null, 2));
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: [
          harnessPackage,
          {
            source: piTranscribeGitSource,
            extensions: ["src/extension/index.ts"],
            replacementMetadata: { preserve: false },
          },
          manualCanonicalSource,
        ],
        tlh: { defaultExtensionProvenance: { managedPackageIdentities: [] } },
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
  assert.deepEqual(settings.packages, [harnessPackage, manualCanonicalSource]);
  assert.deepEqual(settings.tlh.defaultExtensionProvenance.managedPackageIdentities, []);
});

test("tlh-defaults enable preserves a canonical string pin when a replacement object coexists", () => {
  const bundled = bundledExtension("pi-voice");
  assert.ok(bundled, "bundled pi-voice default should exist");
  const manualCanonicalSource = "npm:@earendil-works/pi-voice@0.0.9";
  const fixture = tempFixture();
  writeFileSync(fixture.extensions, JSON.stringify([bundled], null, 2));
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        packages: [
          {
            source: piTranscribeGitSource,
            extensions: ["src/extension/index.ts"],
            replacementMetadata: { preserve: false },
          },
          manualCanonicalSource,
        ],
        tlh: {
          disabledDefaultExtensions: ["pi-voice"],
          defaultExtensionProvenance: { managedPackageIdentities: [] },
        },
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
    "enable",
    "pi-voice",
  ]);

  const settings = readJson(fixture.settings);
  assert.deepEqual(settings.packages, [manualCanonicalSource]);
  assert.deepEqual(settings.tlh.disabledDefaultExtensions, []);
  assert.deepEqual(settings.tlh.defaultExtensionProvenance.managedPackageIdentities, []);
});

test("merge treats an unfiltered canonical identity as authoritative over a filtered replacement", () => {
  const bundled = bundledExtension("pi-voice");
  assert.ok(bundled, "bundled pi-voice default should exist");
  const manualCanonicalSource = "npm:@earendil-works/pi-voice@0.0.9";

  for (const canonicalEntry of [
    manualCanonicalSource,
    {
      source: manualCanonicalSource,
      extensions: ["src/extension/index.ts"],
      canonicalMetadata: { preserve: true },
    },
  ]) {
    const fixture = tempFixture();
    writeFileSync(fixture.extensions, JSON.stringify([bundled], null, 2));
    writeFileSync(
      fixture.settings,
      JSON.stringify(
        {
          packages: [
            harnessPackage,
            {
              source: piTranscribeGitSource,
              extensions: [],
              replacementMetadata: { stale: true },
            },
            canonicalEntry,
          ],
          tlh: { defaultExtensionProvenance: { managedPackageIdentities: [] } },
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
    assert.deepEqual(settings.packages, [harnessPackage, canonicalEntry]);
    assert.deepEqual(settings.tlh.disabledDefaultExtensions ?? [], []);
    assert.deepEqual(settings.tlh.defaultExtensionProvenance.managedPackageIdentities, []);
  }
});

test("tlh-defaults list and sources keep an unfiltered canonical identity enabled over a filtered replacement", () => {
  const bundled = bundledExtension("pi-voice");
  assert.ok(bundled, "bundled pi-voice default should exist");
  const manualCanonicalSource = "npm:@earendil-works/pi-voice@0.0.9";

  for (const canonicalEntry of [
    manualCanonicalSource,
    {
      source: manualCanonicalSource,
      extensions: ["src/extension/index.ts"],
      canonicalMetadata: { preserve: true },
    },
  ]) {
    const fixture = tempFixture();
    writeFileSync(fixture.extensions, JSON.stringify([bundled], null, 2));
    writeFileSync(
      fixture.settings,
      JSON.stringify(
        {
          packages: [
            {
              source: piTranscribeGitSource,
              extensions: [],
              replacementMetadata: { stale: true },
            },
            canonicalEntry,
          ],
        },
        null,
        2,
      ),
    );

    const list = runNode(defaultsScript, [
      "--settings",
      fixture.settings,
      "--defaults",
      fixture.extensions,
      "list",
    ]);
    assert.match(list, /enabled\s+pi-voice/);
    assert.doesNotMatch(list, /disabled by package filter/);

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
    assert.deepEqual(sources, [bundled.source]);
  }
});

for (const scenario of [
  { name: "malformed tlh", tlh: "malformed" },
  {
    name: "malformed disabledDefaultExtensions",
    tlh: { disabledDefaultExtensions: { malformed: true } },
  },
]) {
  test(`merge migrates a filtered replacement with ${scenario.name} and is idempotent`, () => {
    const bundled = bundledExtension("pi-voice");
    assert.ok(bundled, "bundled pi-voice default should exist");
    const filteredEntry = {
      source: piTranscribeGitSource,
      extensions: [],
      autoload: true,
      userMetadata: { preserve: true },
    };
    const fixture = tempFixture();
    writeFileSync(fixture.extensions, JSON.stringify([bundled], null, 2));
    writeFileSync(
      fixture.settings,
      JSON.stringify(
        {
          packages: [harnessPackage, filteredEntry],
          tlh: scenario.tlh,
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

    const first = readJson(fixture.settings);
    assert.deepEqual(first.packages, [
      harnessPackage,
      { ...filteredEntry, source: bundled.source },
    ]);
    assert.deepEqual(
      first.tlh?.disabledDefaultExtensions ?? [],
      scenario.tlh?.disabledDefaultExtensions ?? [],
    );

    const secondOutput = runNode(mergeScript, [
      fixture.defaults,
      "--settings",
      fixture.settings,
      "--default-extensions",
      fixture.extensions,
    ]);
    assert.match(secondOutput, /No settings changes needed\./);
    assert.deepEqual(readJson(fixture.settings), first);
  });
}

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

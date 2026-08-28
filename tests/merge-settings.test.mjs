import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const mergeScript = join(repoRoot, "scripts", "merge-settings.mjs");
const settingsDefaultsPath = join(repoRoot, "config", "settings.defaults.json");
const harnessPackage = "git:github.com/diegopetrucci/the-last-harness";
const branchHarnessPackage =
  "git:github.com/diegopetrucci/the-last-harness@feature/curated-startup-tips";
const retiredPlannotatorPackage = "npm:@plannotator/pi-extension";
const retiredPermissionGatePackage = "npm:@diegopetrucci/pi-permission-gate";
const retiredConfirmDestructivePackage = "npm:@diegopetrucci/pi-confirm-destructive";
const retiredOraclePackage = "npm:@diegopetrucci/pi-oracle";
const retiredTlhRtkPackage = "git:github.com/diegopetrucci/pi-rtk@tlh-v0.6.0-5";
const retiredUpstreamRtkPackage = "npm:pi-rtk";
const retiredSherifNpmRtkPackage = "npm:@sherif-fanous/pi-rtk";
const retiredSherifGitRtkPackage = "git:github.com/sherif-fanous/pi-rtk@v0.5.0";
const changelogSentinel = "9999.0.0";

function tempFixture(defaultsValue, settingsValue, extensionsValue = []) {
  const dir = mkdtempSync(join(tmpdir(), "tlh-merge-settings-test-"));
  const defaults = join(dir, "settings.defaults.json");
  const extensions = join(dir, "default-extensions.json");
  const settings = join(dir, "settings.json");
  writeFileSync(defaults, JSON.stringify(defaultsValue, null, 2));
  writeFileSync(extensions, `${JSON.stringify(extensionsValue, null, 2)}\n`);
  writeFileSync(settings, JSON.stringify(settingsValue, null, 2));
  return { defaults, extensions, settings };
}

function runMerge(
  fixture,
  { dryRun = false, force = false, quiet = true, packageSource = "" } = {},
) {
  const args = [
    mergeScript,
    fixture.defaults,
    "--settings",
    fixture.settings,
    "--default-extensions",
    fixture.extensions,
  ];
  if (packageSource) args.push("--package-source", packageSource);
  if (dryRun) args.push("--dry-run");
  if (force) args.push("--force");
  if (quiet) args.push("--quiet");
  return execFileSync(process.execPath, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function backupFiles(settingsPath) {
  return readdirSync(dirname(settingsPath))
    .filter((name) => name.startsWith("settings.json.backup-"))
    .sort();
}

function symlinkFile(target, path) {
  if (process.platform === "win32") {
    symlinkSync(target, path, "file");
    return;
  }
  symlinkSync(target, path);
}

function writeSwapBackupSourceToSymlinkAfterOpenPreload(dir) {
  const preload = join(dir, "swap-backup-source-to-symlink-after-open.mjs");
  writeFileSync(
    preload,
    `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const originalOpenSync = fs.openSync;
let sabotaged = false;
fs.openSync = (path, flags, mode) => {
	const pathString = String(path);
	if (!sabotaged && pathString === process.env.TLH_TEST_SWAP_BACKUP_SOURCE_PATH) {
		const fd = originalOpenSync(path, flags, mode);
		sabotaged = true;
		fs.unlinkSync(pathString);
		fs.symlinkSync(process.env.TLH_TEST_SWAP_BACKUP_SOURCE_TARGET, pathString, "file");
		return fd;
	}
	return originalOpenSync(path, flags, mode);
};
syncBuiltinESMExports();
`,
  );
  return preload;
}

test("merge adds the changelog sentinel when isolated settings omit it", () => {
  const fixture = tempFixture({ packages: [] }, { packages: [harnessPackage] });

  runMerge(fixture);

  assert.equal(readJson(fixture.settings).lastChangelogVersion, changelogSentinel);
});

test("merge preserves settings and backup file modes when rewriting settings", () => {
  const fixture = tempFixture({ packages: [], quietStartup: true }, { packages: [harnessPackage] });
  chmodSync(fixture.settings, 0o640);

  runMerge(fixture);

  assert.equal(lstatSync(fixture.settings).mode & 0o777, 0o640);
  const backups = backupFiles(fixture.settings);
  assert.equal(backups.length, 1);
  assert.equal(lstatSync(join(dirname(fixture.settings), backups[0])).mode & 0o777, 0o640);
});

test("merge rejects symlinked settings targets before creating backups", () => {
  const fixture = tempFixture({ packages: [], quietStartup: true }, { packages: [harnessPackage] });
  const externalDir = mkdtempSync(join(tmpdir(), "tlh-merge-settings-symlink-target-"));
  const externalSettings = join(externalDir, "settings.json");
  writeFileSync(externalSettings, JSON.stringify({ packages: [harnessPackage] }, null, 2));
  rmSync(fixture.settings);
  symlinkFile(externalSettings, fixture.settings);

  const result = spawnSync(
    process.execPath,
    [
      mergeScript,
      fixture.defaults,
      "--settings",
      fixture.settings,
      "--default-extensions",
      fixture.extensions,
    ],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlinked Pi settings source/);
  assert.deepEqual(backupFiles(fixture.settings), []);
});

test(
  "merge rejects settings sources swapped to a symlink during backup read before creating backups",
  {
    skip: process.platform === "win32",
  },
  () => {
    const fixture = tempFixture(
      { packages: [], quietStartup: true },
      { packages: [harnessPackage] },
    );
    const externalDir = mkdtempSync(join(tmpdir(), "tlh-merge-settings-backup-source-swap-"));
    const externalSettings = join(externalDir, "settings.json");
    const externalSource = { packages: ["npm:attacker"] };
    writeFileSync(externalSettings, JSON.stringify(externalSource, null, 2));
    const preload = writeSwapBackupSourceToSymlinkAfterOpenPreload(dirname(fixture.settings));

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        preload,
        mergeScript,
        fixture.defaults,
        "--settings",
        fixture.settings,
        "--default-extensions",
        fixture.extensions,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          TLH_TEST_SWAP_BACKUP_SOURCE_PATH: fixture.settings,
          TLH_TEST_SWAP_BACKUP_SOURCE_TARGET: externalSettings,
        },
        encoding: "utf8",
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlinked Pi settings source/);
    assert.deepEqual(backupFiles(fixture.settings), []);
    assert.deepEqual(readJson(externalSettings), externalSource);
  },
);

test("merge migrates existing lastChangelogVersion to the changelog sentinel", () => {
  const fixture = tempFixture(
    { packages: [] },
    { packages: [harnessPackage], lastChangelogVersion: "0.10.0" },
  );

  runMerge(fixture);

  assert.equal(readJson(fixture.settings).lastChangelogVersion, changelogSentinel);
});

test("merge dry-run reports changelog sentinel migration without writing settings", () => {
  const fixture = tempFixture(
    { packages: [] },
    { packages: [harnessPackage], lastChangelogVersion: "0.10.0" },
  );
  const before = readFileSync(fixture.settings, "utf8");

  const output = runMerge(fixture, { dryRun: true, quiet: false });

  assert.match(output, /Would overwrite lastChangelogVersion/);
  assert.match(output, /Dry run only; no settings were changed\./);
  assert.equal(readFileSync(fixture.settings, "utf8"), before);
});

test("merge treats a missing default-extension manifest as empty", () => {
  const fixture = tempFixture({ packages: [] }, { packages: [harnessPackage] });

  execFileSync(
    process.execPath,
    [
      mergeScript,
      fixture.defaults,
      "--settings",
      fixture.settings,
      "--default-extensions",
      `${fixture.extensions}.missing`,
      "--quiet",
    ],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
    },
  );

  assert.deepEqual(readJson(fixture.settings).packages, [harnessPackage]);
});

test("merge refuses to mutate normal Pi config paths", () => {
  const fixture = tempFixture({ packages: [] }, { packages: [harnessPackage] });
  const homeDir = join(dirname(fixture.settings), "home");
  const protectedSettings = join(homeDir, ".pi", "agent", "settings.json");

  const result = spawnSync(
    process.execPath,
    [
      mergeScript,
      fixture.defaults,
      "--settings",
      protectedSettings,
      "--default-extensions",
      fixture.extensions,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, HOME: homeDir },
      encoding: "utf8",
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Refusing to modify normal Pi config from The Last Harness installer/,
  );
  assert.equal(existsSync(join(homeDir, ".pi")), false);
});

// Negative cutover coverage: an old/user-owned `agentDirs` entry is preserved as data, but
// the installer no longer adds or relies on it for canonical TLH agents.
test("merge preserves user-owned subagents.agentDirs without adding installer defaults", () => {
  const fixture = tempFixture(
    {
      packages: [],
    },
    {
      packages: [harnessPackage],
      subagents: { agentDirs: ["./tlh/agents/subagents/"] },
    },
  );

  runMerge(fixture);

  assert.deepEqual(readJson(fixture.settings).subagents.agentDirs, ["./tlh/agents/subagents/"]);
  assert.equal(readJson(fixture.defaults).subagents, undefined);
});

for (const [name, malformedValue] of [
  ["scalar", "nope"],
  ["null", null],
  ["array", ["custom/subagents"]],
]) {
  test(`merge preserves malformed user-owned subagents ${name} container`, () => {
    const fixture = tempFixture(
      {
        packages: [],
      },
      {
        packages: [harnessPackage],
        subagents: malformedValue,
      },
    );

    runMerge(fixture);

    assert.deepEqual(readJson(fixture.settings).subagents, malformedValue);
  });
}

test("merge only repairs malformed non-installer object containers with --force", () => {
  const fixture = tempFixture(
    {
      packages: [],
      warnings: { anthropicExtraUsage: false },
    },
    {
      packages: [harnessPackage],
      warnings: "broken",
    },
  );

  runMerge(fixture);
  assert.equal(readJson(fixture.settings).warnings, "broken");

  runMerge(fixture, { force: true });
  assert.deepEqual(readJson(fixture.settings).warnings, { anthropicExtraUsage: false });
});

// `otherAgentDirs` is unrelated user data; this guards the merge contract while the
// installer-owned `subagents.agentDirs` default remains removed.
test("merge keeps exact append semantics for unrelated arrays", () => {
  const fixture = tempFixture(
    {
      packages: [],
      otherAgentDirs: ["tlh/agents/subagents"],
    },
    {
      packages: [harnessPackage],
      otherAgentDirs: ["./tlh/agents/subagents"],
    },
  );

  runMerge(fixture);

  assert.deepEqual(readJson(fixture.settings).otherAgentDirs, [
    "./tlh/agents/subagents",
    "tlh/agents/subagents",
  ]);
});

test("merge scrubs tlh.gnosis from existing settings while preserving other fields", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage],
      tlh: {
        gnosis: { enabled: true, installPath: "/some/path" },
        disabledDefaultExtensions: [],
      },
      otherField: "preserved",
    },
  );

  runMerge(fixture);

  const result = readJson(fixture.settings);
  assert.equal(Object.hasOwn(result.tlh ?? {}, "gnosis"), false, "tlh.gnosis should be removed");
  assert.deepEqual(
    result.tlh.disabledDefaultExtensions,
    [],
    "other tlh fields should be preserved",
  );
  assert.equal(result.otherField, "preserved", "unrelated fields should be preserved");
});

test("merge leaves settings unchanged when tlh.gnosis is absent", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage],
      tlh: { disabledDefaultExtensions: ["some-ext"] },
      otherField: "untouched",
    },
  );

  runMerge(fixture);

  const result = readJson(fixture.settings);
  assert.equal(Object.hasOwn(result.tlh ?? {}, "gnosis"), false, "gnosis key should not appear");
  assert.deepEqual(
    result.tlh.disabledDefaultExtensions,
    ["some-ext"],
    "disabledDefaultExtensions unchanged",
  );
  assert.equal(result.otherField, "untouched", "unrelated fields unchanged");
});

test("merge removes the retired plannotator package from isolated settings and logs it", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage, retiredPlannotatorPackage, "npm:unrelated-package"],
    },
  );

  const output = runMerge(fixture, { quiet: false });
  const settings = readJson(fixture.settings);

  assert.match(output, /Will remove retired TLH default package: npm:@plannotator\/pi-extension/);
  assert.deepEqual(settings.packages, [harnessPackage, "npm:unrelated-package"]);
  assert.deepEqual(settings.tlh?.defaultExtensionProvenance?.managedPackageIdentities, []);
});

test("merge dry-run reports retired plannotator cleanup without writing settings", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [
        harnessPackage,
        { source: retiredPlannotatorPackage, extensions: ["legacy-filter"] },
      ],
    },
  );
  const before = readFileSync(fixture.settings, "utf8");

  const output = runMerge(fixture, { dryRun: true, quiet: false });

  assert.match(output, /Would remove retired TLH default package: npm:@plannotator\/pi-extension/);
  assert.equal(readFileSync(fixture.settings, "utf8"), before);
});

test("merge reruns preserve user-owned settings and stay idempotent", () => {
  const fixture = tempFixture(
    readJson(settingsDefaultsPath),
    {
      packages: [harnessPackage],
      theme: "custom-theme",
      tlh: { disabledDefaultExtensions: ["notify"] },
      otherField: "preserved",
    },
    [
      {
        id: "notify",
        source: "npm:@diegopetrucci/pi-notify",
      },
    ],
  );

  runMerge(fixture);
  const afterFirst = readFileSync(fixture.settings, "utf8");
  const backupsAfterFirst = backupFiles(fixture.settings);
  const firstSettings = readJson(fixture.settings);
  assert.equal(firstSettings.theme, "custom-theme");
  assert.deepEqual(firstSettings.tlh.disabledDefaultExtensions, ["notify"]);
  assert.deepEqual(firstSettings.tlh.defaultExtensionProvenance.managedPackageIdentities, []);
  assert.equal(firstSettings.otherField, "preserved");
  assert.equal(firstSettings.quietStartup, true);
  assert.equal(firstSettings.collapseChangelog, true);
  assert.equal(firstSettings.warnings?.anthropicExtraUsage, false);
  assert.equal(backupsAfterFirst.length, 1);

  const secondOutput = runMerge(fixture, { quiet: false });
  assert.match(secondOutput, /No settings changes needed\./);
  assert.equal(readFileSync(fixture.settings, "utf8"), afterFirst);
  assert.deepEqual(backupFiles(fixture.settings), backupsAfterFirst);
});

test("merge records provenance for managed default-extension package identities", () => {
  const fixture = tempFixture({ packages: [] }, { packages: [harnessPackage] }, [
    {
      id: "inline-bash",
      source: "npm:@diegopetrucci/pi-inline-bash",
    },
  ]);

  runMerge(fixture);

  const settings = readJson(fixture.settings);
  assert.deepEqual(settings.packages, [harnessPackage, "npm:@diegopetrucci/pi-inline-bash"]);
  assert.deepEqual(settings.tlh?.defaultExtensionProvenance?.managedPackageIdentities, [
    "npm:@diegopetrucci/pi-inline-bash",
  ]);
});

test("merge does not remove a manually re-added retired default after provenance migration", () => {
  const fixture = tempFixture(
    { packages: [] },
    { packages: [harnessPackage, retiredPlannotatorPackage] },
  );

  runMerge(fixture);
  writeFileSync(
    fixture.settings,
    JSON.stringify(
      {
        ...readJson(fixture.settings),
        packages: [harnessPackage, retiredPlannotatorPackage],
      },
      null,
      2,
    ),
  );

  runMerge(fixture);

  const settings = readJson(fixture.settings);
  assert.deepEqual(settings.packages, [harnessPackage, retiredPlannotatorPackage]);
  assert.deepEqual(settings.tlh?.defaultExtensionProvenance?.managedPackageIdentities, []);
});

test("merge --force preserves tlh.telemetry.enabled=false while applying defaults", () => {
  const fixture = tempFixture(
    {
      packages: [],
      theme: "the-last-harness",
      quietStartup: true,
      warnings: { anthropicExtraUsage: false },
      tlh: { telemetry: { enabled: true } },
    },
    {
      packages: [harnessPackage],
      theme: "custom-theme",
      tlh: { telemetry: { enabled: false } },
    },
  );

  runMerge(fixture, { force: true });

  const settings = readJson(fixture.settings);
  assert.equal(settings.theme, "the-last-harness");
  assert.equal(settings.quietStartup, true);
  assert.equal(settings.warnings?.anthropicExtraUsage, false);
  assert.equal(
    settings.tlh.telemetry.enabled,
    false,
    "telemetry opt-out must survive forced reruns",
  );
});

test("merge migrates existing unpinned managed npm default package sources to bundled pinned sources without --force", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage, "npm:@diegopetrucci/pi-inline-bash"],
    },
    [
      {
        id: "inline-bash",
        source: "npm:@diegopetrucci/pi-inline-bash@0.1.5",
      },
    ],
  );

  runMerge(fixture);

  const settings = readJson(fixture.settings);
  assert.deepEqual(settings.packages, [harnessPackage, "npm:@diegopetrucci/pi-inline-bash@0.1.5"]);
  assert.deepEqual(settings.tlh?.defaultExtensionProvenance?.managedPackageIdentities, [
    "npm:@diegopetrucci/pi-inline-bash",
  ]);
});

test("merge updates managed pinned npm default package sources when the bundled manifest pin changes", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage, "npm:@diegopetrucci/pi-inline-bash@0.1.5"],
      tlh: {
        defaultExtensionProvenance: {
          managedPackageIdentities: ["npm:@diegopetrucci/pi-inline-bash"],
        },
      },
    },
    [
      {
        id: "inline-bash",
        source: "npm:@diegopetrucci/pi-inline-bash@0.1.6",
      },
    ],
  );

  runMerge(fixture);

  const settings = readJson(fixture.settings);
  assert.deepEqual(settings.packages, [harnessPackage, "npm:@diegopetrucci/pi-inline-bash@0.1.6"]);
  assert.deepEqual(settings.tlh?.defaultExtensionProvenance?.managedPackageIdentities, [
    "npm:@diegopetrucci/pi-inline-bash",
  ]);
});

test("merge preserves older pinned npm package sources without managed default provenance", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage, "npm:@diegopetrucci/pi-inline-bash@0.1.5"],
    },
    [
      {
        id: "inline-bash",
        source: "npm:@diegopetrucci/pi-inline-bash@0.1.6",
      },
    ],
  );

  const firstOutput = runMerge(fixture, { quiet: false });
  const afterFirst = readJson(fixture.settings);
  const afterFirstRaw = readFileSync(fixture.settings, "utf8");

  assert.doesNotMatch(firstOutput, /update default extension package source/);
  assert.deepEqual(afterFirst.packages, [
    harnessPackage,
    "npm:@diegopetrucci/pi-inline-bash@0.1.5",
  ]);
  assert.deepEqual(afterFirst.tlh?.defaultExtensionProvenance?.managedPackageIdentities ?? [], []);

  const secondOutput = runMerge(fixture, { quiet: false });
  const afterSecond = readJson(fixture.settings);

  assert.match(secondOutput, /No settings changes needed\./);
  assert.doesNotMatch(secondOutput, /update default extension package source/);
  assert.equal(readFileSync(fixture.settings, "utf8"), afterFirstRaw);
  assert.deepEqual(afterSecond.packages, [
    harnessPackage,
    "npm:@diegopetrucci/pi-inline-bash@0.1.5",
  ]);
  assert.deepEqual(afterSecond.tlh?.defaultExtensionProvenance?.managedPackageIdentities ?? [], []);
});

test("critical source updates dedupe stale same-identity filtered packages", () => {
  const criticalSource = "git:github.com/example/pi-critical@v2";
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [
        harnessPackage,
        { source: "git:github.com/example/pi-critical@v1", extensions: ["legacy-filter"] },
        { source: "git:github.com/example/pi-critical@v0", extensions: ["stale-filter"] },
        "npm:unrelated-package",
      ],
    },
    [
      {
        id: "critical-extension",
        critical: true,
        source: criticalSource,
      },
    ],
  );

  runMerge(fixture);

  assert.deepEqual(readJson(fixture.settings).packages, [
    harnessPackage,
    criticalSource,
    "npm:unrelated-package",
  ]);
});

test("merge replaces the harness package when a slash ref keeps the same git identity", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage],
    },
  );

  runMerge(fixture, { packageSource: branchHarnessPackage });

  assert.deepEqual(readJson(fixture.settings).packages, [branchHarnessPackage]);
});

test("merge dedupes duplicate harness entries when rerun with a branch package source", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [
        branchHarnessPackage,
        harnessPackage,
        "npm:unrelated-package@1.0.0",
        "npm:unrelated-package",
      ],
    },
  );

  runMerge(fixture, { packageSource: branchHarnessPackage });

  assert.deepEqual(readJson(fixture.settings).packages, [
    branchHarnessPackage,
    "npm:unrelated-package@1.0.0",
    "npm:unrelated-package",
  ]);
});

test("merge dedupes duplicate harness entries when rerun from main", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [
        branchHarnessPackage,
        harnessPackage,
        "npm:unrelated-package@1.0.0",
        "npm:unrelated-package",
      ],
    },
  );

  runMerge(fixture);

  assert.deepEqual(readJson(fixture.settings).packages, [
    harnessPackage,
    "npm:unrelated-package@1.0.0",
    "npm:unrelated-package",
  ]);
});

// ── Non-canonical (local) package source tests (tlhmf-14h1) ─────────────────

test("merge with a local path source registers exactly one TLH entry and omits the canonical git entry", () => {
  const localSource = "/Users/test/tlh-repo";
  const fixture = tempFixture({ packages: [harnessPackage] }, { packages: [] });

  runMerge(fixture, { packageSource: localSource });

  const settings = readJson(fixture.settings);
  assert.equal(settings.packages[0], localSource, "local source is first entry");
  assert.ok(!settings.packages.includes(harnessPackage), "no canonical git entry");
  const tlhCount = settings.packages.filter(
    (e) => e === localSource || e === harnessPackage,
  ).length;
  assert.equal(tlhCount, 1, "exactly one TLH package entry");
});

test("merge with the canonical git source is unchanged by the non-canonical dedup logic", () => {
  const fixture = tempFixture({ packages: [harnessPackage] }, { packages: [] });

  runMerge(fixture);

  const settings = readJson(fixture.settings);
  assert.deepEqual(settings.packages, [harnessPackage], "canonical entry is the only package");
});

test("merge with a local path source over existing settings containing the canonical entry removes the canonical entry", () => {
  const localSource = "/Users/test/tlh-repo";
  const fixture = tempFixture({ packages: [harnessPackage] }, { packages: [harnessPackage] });

  runMerge(fixture, { packageSource: localSource });

  const settings = readJson(fixture.settings);
  assert.ok(!settings.packages.includes(harnessPackage), "canonical entry removed");
  assert.ok(settings.packages.includes(localSource), "local source entry present");
  const tlhCount = settings.packages.filter(
    (e) => e === localSource || e === harnessPackage,
  ).length;
  assert.equal(tlhCount, 1, "exactly one TLH package entry");
});

test("merge defers bundled pi-web-access when an upstream package is already installed", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage, "npm:pi-web-access"],
    },
    [
      {
        id: "pi-web-access",
        replaces: ["npm:pi-web-access", "git:github.com/nicobailon/pi-web-access"],
        source: "git:github.com/diegopetrucci/pi-web-access@tlh-v0.10.7-1",
      },
    ],
  );

  runMerge(fixture);

  assert.deepEqual(readJson(fixture.settings).packages, [harnessPackage, "npm:pi-web-access"]);
});

test("merge force-removes retired confirmation packages by identity while preserving unrelated packages", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [
        harnessPackage,
        `${retiredPermissionGatePackage}@1.2.3`,
        { source: `${retiredConfirmDestructivePackage}@0.4.0`, extensions: ["legacy-filter"] },
        "npm:@diegopetrucci/pi-inline-bash",
      ],
    },
  );

  const output = runMerge(fixture, { quiet: false });

  const settings = readJson(fixture.settings);
  assert.deepEqual(settings.packages, [harnessPackage, "npm:@diegopetrucci/pi-inline-bash"]);
  assert.match(
    output,
    /force-remove retired default extension package: npm:@diegopetrucci\/pi-permission-gate/,
  );
  assert.match(
    output,
    /force-remove retired default extension package: npm:@diegopetrucci\/pi-confirm-destructive/,
  );
});

test("merge removes npm:@diegopetrucci/pi-context-cap package and emits a changes line", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [
        harnessPackage,
        "npm:@diegopetrucci/pi-context-cap",
        "npm:@diegopetrucci/pi-inline-bash",
      ],
    },
  );

  const output = runMerge(fixture, { quiet: false });

  const settings = readJson(fixture.settings);
  assert.ok(
    !settings.packages.includes("npm:@diegopetrucci/pi-context-cap"),
    "pi-context-cap should be removed",
  );
  assert.ok(
    settings.packages.includes("npm:@diegopetrucci/pi-inline-bash"),
    "unrelated packages should be preserved",
  );
  assert.match(
    output,
    /force-remove retired default extension package: npm:@diegopetrucci\/pi-context-cap/,
  );
});

test("merge prunes context-cap from tlh.disabledDefaultExtensions and emits a changes line", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage],
      tlh: { disabledDefaultExtensions: ["context-cap", "notify"] },
    },
  );

  const output = runMerge(fixture, { quiet: false });

  const settings = readJson(fixture.settings);
  assert.deepEqual(
    settings.tlh.disabledDefaultExtensions,
    ["notify"],
    "context-cap should be pruned, other entries preserved",
  );
  assert.match(output, /remove stale context-cap opt-out from tlh\.disabledDefaultExtensions/);
});

test("merge prunes whitespace-padded context-cap entry from tlh.disabledDefaultExtensions", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage],
      tlh: { disabledDefaultExtensions: [" context-cap ", "notify"] },
    },
  );

  const output = runMerge(fixture, { quiet: false });

  const settings = readJson(fixture.settings);
  assert.deepEqual(
    settings.tlh.disabledDefaultExtensions,
    ["notify"],
    "whitespace-padded context-cap should be pruned",
  );
  assert.match(output, /remove stale context-cap opt-out from tlh\.disabledDefaultExtensions/);
});

test("merge is a no-op when settings have neither pi-context-cap nor context-cap opt-out", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage],
      tlh: { disabledDefaultExtensions: ["notify"] },
    },
  );

  runMerge(fixture);
  const afterFirst = readFileSync(fixture.settings, "utf8");

  const output = runMerge(fixture, { quiet: false });

  assert.match(output, /No settings changes needed\./);
  assert.equal(readFileSync(fixture.settings, "utf8"), afterFirst, "settings should be unchanged");
});

test("merge cleanup of retired confirmation packages is idempotent after first run", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage, retiredPermissionGatePackage, retiredConfirmDestructivePackage],
    },
  );

  runMerge(fixture);

  const afterFirst = readFileSync(fixture.settings, "utf8");
  const firstSettings = readJson(fixture.settings);
  assert.deepEqual(
    firstSettings.packages,
    [harnessPackage],
    "retired confirmation packages removed on first run",
  );

  const secondOutput = runMerge(fixture, { quiet: false });
  assert.match(secondOutput, /No settings changes needed\./);
  assert.equal(
    readFileSync(fixture.settings, "utf8"),
    afterFirst,
    "settings unchanged on second run",
  );
});

test("merge force-removes pi-oracle package while preserving unrelated packages", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [
        harnessPackage,
        `${retiredOraclePackage}@2.1.0`,
        { source: `${retiredOraclePackage}@1.0.0`, extensions: ["legacy-filter"] },
        "npm:@diegopetrucci/pi-inline-bash",
      ],
    },
  );

  const output = runMerge(fixture, { quiet: false });

  const settings = readJson(fixture.settings);
  assert.deepEqual(settings.packages, [harnessPackage, "npm:@diegopetrucci/pi-inline-bash"]);
  assert.match(
    output,
    /force-remove retired default extension package: npm:@diegopetrucci\/pi-oracle/,
  );
});

test("merge prunes oracle from tlh.disabledDefaultExtensions and emits a changes line", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage],
      tlh: { disabledDefaultExtensions: ["oracle", "notify"] },
    },
  );

  const output = runMerge(fixture, { quiet: false });

  const settings = readJson(fixture.settings);
  assert.deepEqual(
    settings.tlh.disabledDefaultExtensions,
    ["notify"],
    "oracle should be pruned, other entries preserved",
  );
  assert.match(output, /remove stale oracle opt-out from tlh\.disabledDefaultExtensions/);
});

test("merge prunes whitespace-padded oracle entry from tlh.disabledDefaultExtensions", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage],
      tlh: { disabledDefaultExtensions: [" oracle ", "notify"] },
    },
  );

  const output = runMerge(fixture, { quiet: false });

  const settings = readJson(fixture.settings);
  assert.deepEqual(
    settings.tlh.disabledDefaultExtensions,
    ["notify"],
    "whitespace-padded oracle should be pruned",
  );
  assert.match(output, /remove stale oracle opt-out from tlh\.disabledDefaultExtensions/);
});

test("merge cleanup of pi-oracle is idempotent after first run", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage, retiredOraclePackage],
      tlh: { disabledDefaultExtensions: ["oracle", "notify"] },
    },
  );

  runMerge(fixture);

  const afterFirst = readFileSync(fixture.settings, "utf8");
  const firstSettings = readJson(fixture.settings);
  assert.ok(
    !firstSettings.packages.includes(retiredOraclePackage),
    "pi-oracle removed on first run",
  );
  assert.deepEqual(
    firstSettings.tlh.disabledDefaultExtensions,
    ["notify"],
    "oracle opt-out pruned on first run",
  );

  const secondOutput = runMerge(fixture, { quiet: false });
  assert.match(secondOutput, /No settings changes needed\./);
  assert.equal(
    readFileSync(fixture.settings, "utf8"),
    afterFirst,
    "settings unchanged on second run",
  );
});

test("merge force-removes pi-notify package previously installed from npm source", () => {
  // pi-notify was retired as an npm default when notify was bundled as a first-party extension.
  // If both ran simultaneously, every notification would fire twice. This test asserts the
  // force-removal guarantee: any previously-installed npm:@diegopetrucci/pi-notify entry must
  // be stripped from isolated settings on merge, even when paired with unrelated active packages.
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [
        harnessPackage,
        "npm:@diegopetrucci/pi-notify",
        "npm:@diegopetrucci/pi-notify@0.1.5",
        "npm:@diegopetrucci/pi-inline-bash",
      ],
    },
  );

  const output = runMerge(fixture, { quiet: false });

  const settings = readJson(fixture.settings);
  assert.ok(
    !settings.packages.some((p) =>
      (typeof p === "string" ? p : p.source).startsWith("npm:@diegopetrucci/pi-notify"),
    ),
    "all pi-notify entries must be stripped",
  );
  assert.ok(
    settings.packages.includes("npm:@diegopetrucci/pi-inline-bash"),
    "unrelated packages must be preserved",
  );
  assert.match(
    output,
    /force-remove retired default extension package: npm:@diegopetrucci\/pi-notify/,
  );
});

test("merge force-removal of pi-notify is idempotent after first run", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage, "npm:@diegopetrucci/pi-notify@0.1.5"],
    },
  );

  runMerge(fixture);

  const afterFirst = readFileSync(fixture.settings, "utf8");
  const firstSettings = readJson(fixture.settings);
  assert.ok(
    !firstSettings.packages.some((p) =>
      (typeof p === "string" ? p : p.source).startsWith("npm:@diegopetrucci/pi-notify"),
    ),
    "pi-notify removed on first run",
  );

  const secondOutput = runMerge(fixture, { quiet: false });
  assert.match(secondOutput, /No settings changes needed\./);
  assert.equal(
    readFileSync(fixture.settings, "utf8"),
    afterFirst,
    "settings unchanged on second run",
  );
});

test("merge cleanup of pi-context-cap is idempotent after first run", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage, "npm:@diegopetrucci/pi-context-cap"],
      tlh: { disabledDefaultExtensions: ["context-cap", "notify"] },
    },
  );

  runMerge(fixture);

  const afterFirst = readFileSync(fixture.settings, "utf8");
  const firstSettings = readJson(fixture.settings);
  assert.ok(
    !firstSettings.packages.includes("npm:@diegopetrucci/pi-context-cap"),
    "pi-context-cap removed on first run",
  );
  assert.deepEqual(
    firstSettings.tlh.disabledDefaultExtensions,
    ["notify"],
    "context-cap opt-out pruned on first run",
  );

  const secondOutput = runMerge(fixture, { quiet: false });
  assert.match(secondOutput, /No settings changes needed\./);
  assert.equal(
    readFileSync(fixture.settings, "utf8"),
    afterFirst,
    "settings unchanged on second run",
  );
});

test("merge force-removes legacy pi-rtk packages and prunes stale rtk opt-outs idempotently", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [
        harnessPackage,
        retiredTlhRtkPackage,
        retiredUpstreamRtkPackage,
        retiredSherifNpmRtkPackage,
        retiredSherifGitRtkPackage,
        "npm:keep",
      ],
      tlh: { rtk: { disabled: true }, disabledDefaultExtensions: ["rtk", "pi-rtk", "notify"] },
    },
  );

  const firstOutput = runMerge(fixture, { quiet: false });
  const afterFirst = readFileSync(fixture.settings, "utf8");
  const firstSettings = readJson(fixture.settings);

  assert.deepEqual(firstSettings.packages, [harnessPackage, "npm:keep"]);
  assert.deepEqual(firstSettings.tlh.disabledDefaultExtensions, ["notify"]);
  assert.equal(Object.hasOwn(firstSettings.tlh, "rtk"), false);
  assert.match(
    firstOutput,
    /force-remove retired default extension package: git:github\.com\/diegopetrucci\/pi-rtk/,
  );
  assert.match(firstOutput, /force-remove retired default extension package: npm:pi-rtk/);
  assert.match(
    firstOutput,
    /force-remove retired default extension package: npm:@sherif-fanous\/pi-rtk/,
  );
  assert.match(
    firstOutput,
    /force-remove retired default extension package: git:github\.com\/sherif-fanous\/pi-rtk/,
  );
  assert.match(firstOutput, /remove tlh\.rtk \(one-time cleanup\)/);
  assert.match(firstOutput, /remove stale rtk opt-out from tlh\.disabledDefaultExtensions/);

  const secondOutput = runMerge(fixture, { quiet: false });
  assert.match(secondOutput, /No settings changes needed\./);
  assert.equal(
    readFileSync(fixture.settings, "utf8"),
    afterFirst,
    "settings unchanged on second run",
  );
});

// ── Librarian retirement tests ────────────────────────────────────────────────

const retiredLibrarianPackage = "npm:@diegopetrucci/pi-librarian";

test("merge removes the TLH-managed librarian package from isolated settings and logs it", () => {
  // A profile with NO defaultExtensionProvenance is treated as a legacy install
  // where the librarian package was TLH-seeded. The carry-over logic in
  // withLegacyRetiredDefaultPackageIdentities adds it to managedPackageIdentities,
  // causing applyRetiredTlhDefaultPackageCleanup to remove it.
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage, retiredLibrarianPackage, "npm:unrelated-package"],
    },
  );

  const output = runMerge(fixture, { quiet: false });
  const settings = readJson(fixture.settings);

  assert.match(output, /Will remove retired TLH default package: npm:@diegopetrucci\/pi-librarian/);
  assert.deepEqual(settings.packages, [harnessPackage, "npm:unrelated-package"]);
  assert.deepEqual(settings.tlh?.defaultExtensionProvenance?.managedPackageIdentities, []);
});

test("merge preserves a user-added librarian package that TLH did not install", () => {
  // A profile WITH defaultExtensionProvenance set causes withLegacyRetiredDefaultPackageIdentities
  // to skip the legacy carry-over path, so a librarian package not in managedPackageIdentities
  // is treated as user-added and must be preserved.
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage, retiredLibrarianPackage],
      tlh: {
        defaultExtensionProvenance: {
          managedPackageIdentities: [], // provenance exists but librarian is NOT managed
        },
      },
    },
  );

  const output = runMerge(fixture, { quiet: false });
  const settings = readJson(fixture.settings);

  assert.ok(
    settings.packages.includes(retiredLibrarianPackage),
    "user-added librarian package must be preserved",
  );
  assert.doesNotMatch(output, /pi-librarian/);
});

test("merge removes TLH-managed librarian from a modern profile where provenance already records it as managed", () => {
  // Dominant real-world migration case: a user who received librarian as a TLH
  // default before retirement. Their profile is MODERN (defaultExtensionProvenance
  // exists) and the librarian identity IS already in managedPackageIdentities.
  // withLegacyRetiredDefaultPackageIdentities skips the legacy carry-over path
  // (because provenance exists) but the identity is already present in the set,
  // so applyRetiredTlhDefaultPackageCleanup must still remove the package.
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage, retiredLibrarianPackage, "npm:unrelated-package"],
      tlh: {
        defaultExtensionProvenance: {
          managedPackageIdentities: [retiredLibrarianPackage],
        },
      },
    },
  );

  const output = runMerge(fixture, { quiet: false });
  const settings = readJson(fixture.settings);

  // Package must be removed and the change logged
  assert.match(output, /Will remove retired TLH default package: npm:@diegopetrucci\/pi-librarian/);
  assert.ok(
    !settings.packages.some(
      (entry) => (typeof entry === "string" ? entry : entry.source) === retiredLibrarianPackage,
    ),
    "librarian must be removed from packages",
  );
  assert.ok(
    settings.packages.includes("npm:unrelated-package"),
    "unrelated package must be preserved",
  );

  // Resynced provenance must NOT contain the retired librarian identity
  const resynced = settings.tlh?.defaultExtensionProvenance?.managedPackageIdentities ?? [];
  assert.ok(
    !resynced.includes(retiredLibrarianPackage),
    "resynced provenance must not list the retired librarian identity",
  );
});

test("merge dry-run reports retired librarian cleanup without writing settings", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage, retiredLibrarianPackage],
    },
  );
  const before = readFileSync(fixture.settings, "utf8");

  const output = runMerge(fixture, { dryRun: true, quiet: false });

  assert.match(
    output,
    /Would remove retired TLH default package: npm:@diegopetrucci\/pi-librarian/,
  );
  assert.equal(readFileSync(fixture.settings, "utf8"), before);
});

test("merge librarian retirement cleanup is idempotent after first run", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage, retiredLibrarianPackage],
    },
  );

  runMerge(fixture);

  const afterFirst = readFileSync(fixture.settings, "utf8");
  const firstSettings = readJson(fixture.settings);
  assert.ok(
    !firstSettings.packages.includes(retiredLibrarianPackage),
    "librarian removed on first run",
  );

  const secondOutput = runMerge(fixture, { quiet: false });
  assert.match(secondOutput, /No settings changes needed\./);
  assert.equal(
    readFileSync(fixture.settings, "utf8"),
    afterFirst,
    "settings unchanged on second run",
  );
});

// ── fff retirement tests ───────────────────────────────────────────────────

const retiredFffPackage = "npm:@ff-labs/pi-fff";

test("merge removes the TLH-managed fff package from isolated settings and logs it", () => {
  // A profile with NO defaultExtensionProvenance is treated as a legacy install
  // where fff was TLH-seeded. withLegacyRetiredDefaultPackageIdentities adds it
  // to managedPackageIdentities, causing applyRetiredTlhDefaultPackageCleanup to remove it.
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage, retiredFffPackage, "npm:unrelated-package"],
    },
  );

  const output = runMerge(fixture, { quiet: false });
  const settings = readJson(fixture.settings);

  assert.match(output, /Will remove retired TLH default package: npm:@ff-labs\/pi-fff/);
  assert.deepEqual(settings.packages, [harnessPackage, "npm:unrelated-package"]);
  assert.deepEqual(settings.tlh?.defaultExtensionProvenance?.managedPackageIdentities, []);
});

test("merge preserves a user-added fff package that TLH did not install", () => {
  // A profile WITH defaultExtensionProvenance set causes withLegacyRetiredDefaultPackageIdentities
  // to skip the legacy carry-over path, so a fff package not in managedPackageIdentities
  // is treated as user-added and must be preserved.
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage, retiredFffPackage],
      tlh: {
        defaultExtensionProvenance: {
          managedPackageIdentities: [], // provenance exists but fff is NOT managed
        },
      },
    },
  );

  const output = runMerge(fixture, { quiet: false });
  const settings = readJson(fixture.settings);

  assert.ok(
    settings.packages.includes(retiredFffPackage),
    "user-added fff package must be preserved",
  );
  assert.doesNotMatch(output, /pi-fff/);
});

test("merge removes TLH-managed fff from a modern profile where provenance already records it as managed", () => {
  // Dominant real-world migration case: a user who received fff as a TLH default
  // before retirement. Their profile is MODERN (defaultExtensionProvenance exists)
  // and the fff identity IS already in managedPackageIdentities.
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage, retiredFffPackage, "npm:unrelated-package"],
      tlh: {
        defaultExtensionProvenance: {
          managedPackageIdentities: [retiredFffPackage],
        },
      },
    },
  );

  const output = runMerge(fixture, { quiet: false });
  const settings = readJson(fixture.settings);

  assert.match(output, /Will remove retired TLH default package: npm:@ff-labs\/pi-fff/);
  assert.ok(
    !settings.packages.some(
      (entry) => (typeof entry === "string" ? entry : entry.source) === retiredFffPackage,
    ),
    "fff must be removed from packages",
  );
  assert.ok(
    settings.packages.includes("npm:unrelated-package"),
    "unrelated package must be preserved",
  );

  const resynced = settings.tlh?.defaultExtensionProvenance?.managedPackageIdentities ?? [];
  assert.ok(
    !resynced.includes(retiredFffPackage),
    "resynced provenance must not list the retired fff identity",
  );
});

test("merge prunes stale fff and pi-fff opt-outs from tlh.disabledDefaultExtensions", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage],
      tlh: { disabledDefaultExtensions: ["fff", "pi-fff", "notify"] },
    },
  );

  const output = runMerge(fixture, { quiet: false });
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

test("merge fff retirement cleanup is idempotent after first run", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage, retiredFffPackage],
    },
  );

  runMerge(fixture);

  const afterFirst = readFileSync(fixture.settings, "utf8");
  const firstSettings = readJson(fixture.settings);
  assert.ok(!firstSettings.packages.includes(retiredFffPackage), "fff removed on first run");

  const secondOutput = runMerge(fixture, { quiet: false });
  assert.match(secondOutput, /No settings changes needed\./);
  assert.equal(
    readFileSync(fixture.settings, "utf8"),
    afterFirst,
    "settings unchanged on second run",
  );
});

// ── subagents retirement tests ──────────────────────────────────────────────

const retiredSubagentsNpmPackage = "npm:@diegopetrucci/pi-subagents";

test("merge removes the TLH-managed subagents npm package from isolated settings and logs it", () => {
  // A profile with NO defaultExtensionProvenance is treated as a legacy install
  // where the external npm subagents package was TLH-seeded.
  // withLegacyRetiredDefaultPackageIdentities adds it to managedPackageIdentities,
  // causing applyRetiredTlhDefaultPackageCleanup to remove it.
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage, retiredSubagentsNpmPackage, "npm:unrelated-package"],
    },
  );

  const output = runMerge(fixture, { quiet: false });
  const settings = readJson(fixture.settings);

  assert.match(output, /Will remove retired TLH default package: npm:@diegopetrucci\/pi-subagents/);
  assert.ok(
    !settings.packages.some(
      (entry) => (typeof entry === "string" ? entry : entry.source) === retiredSubagentsNpmPackage,
    ),
    "TLH-managed subagents npm package must be removed",
  );
  assert.ok(
    settings.packages.includes("npm:unrelated-package"),
    "unrelated package must be preserved",
  );
  assert.deepEqual(settings.tlh?.defaultExtensionProvenance?.managedPackageIdentities, []);
});

test("merge preserves a user-added subagents npm package that TLH did not install", () => {
  // A profile WITH defaultExtensionProvenance set and the subagents identity NOT
  // in managedPackageIdentities: the package is user-added and must be preserved.
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage, retiredSubagentsNpmPackage],
      tlh: {
        defaultExtensionProvenance: {
          managedPackageIdentities: [], // provenance exists but subagents is NOT managed
        },
      },
    },
  );

  const output = runMerge(fixture, { quiet: false });
  const settings = readJson(fixture.settings);

  assert.ok(
    settings.packages.includes(retiredSubagentsNpmPackage),
    "user-added subagents npm package must be preserved",
  );
  assert.doesNotMatch(output, /pi-subagents/);
});

test("merge removes TLH-managed subagents from a modern profile where provenance already records it as managed", () => {
  // Dominant real-world migration case: a user who received the subagents external
  // package as a TLH default before retirement. Their profile is MODERN
  // (defaultExtensionProvenance exists) and the subagents identity IS already
  // in managedPackageIdentities.
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage, retiredSubagentsNpmPackage, "npm:unrelated-package"],
      tlh: {
        defaultExtensionProvenance: {
          managedPackageIdentities: [retiredSubagentsNpmPackage],
        },
      },
    },
  );

  const output = runMerge(fixture, { quiet: false });
  const settings = readJson(fixture.settings);

  assert.match(output, /Will remove retired TLH default package: npm:@diegopetrucci\/pi-subagents/);
  assert.ok(
    !settings.packages.some(
      (entry) => (typeof entry === "string" ? entry : entry.source) === retiredSubagentsNpmPackage,
    ),
    "TLH-managed subagents npm package must be removed",
  );
  assert.ok(
    settings.packages.includes("npm:unrelated-package"),
    "unrelated package must be preserved",
  );

  const resynced = settings.tlh?.defaultExtensionProvenance?.managedPackageIdentities ?? [];
  assert.ok(
    !resynced.includes(retiredSubagentsNpmPackage),
    "resynced provenance must not list the retired subagents npm identity",
  );
});

test("merge prunes stale subagents and pi-subagents opt-outs from tlh.disabledDefaultExtensions", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage],
      tlh: { disabledDefaultExtensions: ["subagents", "pi-subagents", "notify"] },
    },
  );

  const output = runMerge(fixture, { quiet: false });
  const settings = readJson(fixture.settings);

  assert.match(output, /remove stale subagents opt-out from tlh\.disabledDefaultExtensions/);
  assert.equal(
    (settings.tlh?.disabledDefaultExtensions ?? []).some(
      (v) => v === "subagents" || v === "pi-subagents",
    ),
    false,
    "stale subagents opt-outs must be removed",
  );
  assert.equal(
    (settings.tlh?.disabledDefaultExtensions ?? []).includes("notify"),
    true,
    "unrelated opt-out must be preserved",
  );
});

test("merge subagents retirement cleanup is idempotent after first run", () => {
  const fixture = tempFixture(
    { packages: [] },
    {
      packages: [harnessPackage, retiredSubagentsNpmPackage],
    },
  );

  runMerge(fixture);

  const afterFirst = readFileSync(fixture.settings, "utf8");
  const firstSettings = readJson(fixture.settings);
  assert.ok(
    !firstSettings.packages.includes(retiredSubagentsNpmPackage),
    "subagents npm package removed on first run",
  );

  const secondOutput = runMerge(fixture, { quiet: false });
  assert.match(secondOutput, /No settings changes needed\./);
  assert.equal(
    readFileSync(fixture.settings, "utf8"),
    afterFirst,
    "settings unchanged on second run",
  );
});

test("merge prune removes subagents.disableBuiltins while preserving user-owned agentDirs", () => {
  const fixture = tempFixture(
    {
      packages: [],
    },
    {
      packages: [harnessPackage],
      subagents: {
        disableBuiltins: true,
        agentDirs: ["custom/subagents"],
        agentOverrides: {
          developer: { model: "kept" },
        },
      },
    },
  );

  runMerge(fixture);

  const settings = readJson(fixture.settings);
  assert.equal(
    Object.hasOwn(settings.subagents, "disableBuiltins"),
    false,
    "disableBuiltins must be pruned",
  );
  assert.deepEqual(
    settings.subagents.agentDirs,
    ["custom/subagents"],
    "user-owned agentDirs must survive without installer additions",
  );
  assert.deepEqual(
    settings.subagents.agentOverrides,
    { developer: { model: "kept" } },
    "agentOverrides must survive",
  );
});

test("merge prune for subagents.disableBuiltins is idempotent on second run", () => {
  const fixture = tempFixture(
    {
      packages: [],
    },
    {
      packages: [harnessPackage],
      subagents: {
        disableBuiltins: true,
        agentDirs: ["custom/subagents"],
      },
    },
  );

  runMerge(fixture);

  const afterFirstPrune = readFileSync(fixture.settings, "utf8");
  assert.equal(
    Object.hasOwn(readJson(fixture.settings).subagents, "disableBuiltins"),
    false,
    "disableBuiltins removed on first run",
  );

  const secondOutput = runMerge(fixture, { quiet: false });
  assert.match(secondOutput, /No settings changes needed\./);
  assert.equal(
    readFileSync(fixture.settings, "utf8"),
    afterFirstPrune,
    "settings unchanged on second run",
  );
});

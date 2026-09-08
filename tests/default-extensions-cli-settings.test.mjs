import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  packageIdentity,
  readDefaultExtensions,
  setDefaultExtensionProvenance,
} from "../scripts/lib/default-extensions.mjs";

import {
  backupFiles,
  bundledSource,
  defaultsScript,
  disablingExtensionFilterCases,
  mergeScript,
  packageSourceOf,
  previousPiWebAccessSource,
  readJson,
  repoRoot,
  runNode,
  symlinkFile,
  tempFixture,
} from "./support/default-extensions-fixtures.mjs";

test("shared package identity keeps npm, git, and local source semantics", () => {
  assert.equal(packageIdentity("npm:helper@1.2.3"), "npm:helper");
  assert.equal(packageIdentity("npm:@scope/helper@1.2.3"), "npm:@scope/helper");
  assert.equal(packageIdentity("git:github.com/TLH/helper@pin"), "git:github.com/tlh/helper");
  assert.equal(
    packageIdentity("https://github.com/TLH/helper.git#pin"),
    "git:github.com/tlh/helper",
  );
  assert.equal(packageIdentity("git@github.com:TLH/helper.git"), "git:github.com/tlh/helper");
  assert.equal(packageIdentity("../local-helper@pin"), "local:../local-helper@pin");

  const harnessIdentity = packageIdentity("git:github.com/diegopetrucci/the-last-harness");
  assert.equal(
    packageIdentity("git:github.com/diegopetrucci/the-last-harness@tlh-v0.16.0"),
    harnessIdentity,
  );
  assert.equal(
    packageIdentity("git:github.com/diegopetrucci/the-last-harness@feature/curated-startup-tips"),
    harnessIdentity,
  );
});

test("shared default-extension reader trims descriptions and can allow missing manifests", () => {
  const fixture = tempFixture();
  writeFileSync(
    fixture.extensions,
    JSON.stringify(
      [
        {
          id: "helper",
          description: "  Helpful default  ",
          source: "npm:helper",
        },
      ],
      null,
      2,
    ),
  );

  assert.deepEqual(readDefaultExtensions(fixture.extensions), [
    {
      id: "helper",
      aliases: [],
      replaces: [],
      migrateReplacements: false,
      critical: false,
      source: "npm:helper",
      description: "Helpful default",
    },
  ]);
  assert.deepEqual(
    readDefaultExtensions(join(fixture.dir, "missing-default-extensions.json"), {
      allowMissing: true,
    }),
    [],
  );
  assert.throws(
    () => readDefaultExtensions(join(fixture.dir, "missing-default-extensions.json")),
    /File does not exist:/,
  );
});

test("setDefaultExtensionProvenance returns false for non-plain-object settings", () => {
  for (const settings of [undefined, null, false, 0, 1n, "tlh", Symbol("tlh")]) {
    assert.equal(setDefaultExtensionProvenance(settings, ["npm:helper"]), false);
  }
  assert.equal(setDefaultExtensionProvenance([], ["npm:helper"]), false);
  assert.equal(setDefaultExtensionProvenance({ tlh: [] }, ["npm:helper"]), false);

  const settings = {};
  assert.equal(setDefaultExtensionProvenance(settings, ["npm:helper@1.2.3"]), true);
  assert.deepEqual(settings, {
    tlh: {
      defaultExtensionProvenance: {
        managedPackageIdentities: ["npm:helper"],
      },
    },
  });
});

test("tlh-defaults errors when the default-extension manifest is missing", () => {
  const fixture = tempFixture();
  writeFileSync(fixture.settings, JSON.stringify({ packages: [] }, null, 2));

  const result = spawnSync(
    process.execPath,
    [
      defaultsScript,
      "--settings",
      fixture.settings,
      "--defaults",
      join(fixture.dir, "missing-default-extensions.json"),
      "list",
    ],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /File does not exist:/);
});

test("tlh-defaults rejects disabling critical defaults without changing settings", () => {
  const fixture = tempFixture();
  writeFileSync(
    fixture.extensions,
    JSON.stringify(
      [
        {
          id: "subagents",
          aliases: ["pi-subagents"],
          critical: true,
          source: "npm:subagents",
        },
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
        packages: ["npm:subagents", "npm:helper"],
        tlh: { disabledDefaultExtensions: ["helper"] },
      },
      null,
      2,
    ),
  );
  const before = readFileSync(fixture.settings, "utf8");

  const result = spawnSync(
    process.execPath,
    [
      defaultsScript,
      "--settings",
      fixture.settings,
      "--defaults",
      fixture.extensions,
      "disable",
      "pi-subagents",
    ],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /critical default extension 'subagents' cannot be disabled/i);
  assert.equal(readFileSync(fixture.settings, "utf8"), before);
});

test("tlh-defaults refuses to mutate normal Pi config paths", () => {
  const fixture = tempFixture();
  const homeDir = join(fixture.dir, "home");
  const protectedSettings = join(homeDir, ".pi", "agent", "settings.json");
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

  const result = spawnSync(
    process.execPath,
    [
      defaultsScript,
      "--settings",
      protectedSettings,
      "--defaults",
      fixture.extensions,
      "disable",
      "helper",
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
    /Refusing to modify normal Pi config from The Last Harness defaults command/,
  );
  assert.equal(existsSync(join(homeDir, ".pi")), false);
});

test("tlh-defaults enable cleans stale critical opt-outs while preserving non-critical opt-outs", () => {
  const fixture = tempFixture();
  writeFileSync(
    fixture.extensions,
    JSON.stringify(
      [
        {
          id: "subagents",
          aliases: ["pi-subagents"],
          critical: true,
          source: "npm:subagents",
        },
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
        packages: ["npm:subagents"],
        tlh: { disabledDefaultExtensions: ["pi-subagents", "helper"] },
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
    "subagents",
  ]);

  const settings = readJson(fixture.settings);
  assert.deepEqual(settings.tlh.disabledDefaultExtensions, ["helper"]);
  assert.deepEqual(settings.packages, ["npm:subagents"]);
});

test("tlh-defaults preserves settings and backup file modes when rewriting settings", () => {
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
  writeFileSync(fixture.settings, JSON.stringify({ packages: ["npm:helper"] }, null, 2));
  chmodSync(fixture.settings, 0o640);

  runNode(defaultsScript, [
    "--settings",
    fixture.settings,
    "--defaults",
    fixture.extensions,
    "disable",
    "helper",
  ]);

  assert.equal(lstatSync(fixture.settings).mode & 0o777, 0o640);
  const backups = backupFiles(fixture.settings);
  assert.equal(backups.length, 1);
  assert.equal(lstatSync(join(dirname(fixture.settings), backups[0])).mode & 0o777, 0o640);
});

test("tlh-defaults rejects symlinked settings targets before creating backups", () => {
  const fixture = tempFixture();
  const externalDir = mkdtempSync(join(tmpdir(), "tlh-defaults-symlink-target-"));
  const externalSettings = join(externalDir, "settings.json");
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
  writeFileSync(externalSettings, JSON.stringify({ packages: ["npm:helper"] }, null, 2));
  symlinkFile(externalSettings, fixture.settings);

  const result = spawnSync(
    process.execPath,
    [
      defaultsScript,
      "--settings",
      fixture.settings,
      "--defaults",
      fixture.extensions,
      "disable",
      "helper",
    ],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlinked TLH defaults settings source/);
  assert.deepEqual(backupFiles(fixture.settings), []);
});

test("merge updates critical package pins without --force", () => {
  const fixture = tempFixture();
  writeFileSync(
    fixture.extensions,
    JSON.stringify(
      [
        {
          id: "subagents",
          critical: true,
          source: "git:github.com/tlh/pi-subagents@new-pin",
        },
      ],
      null,
      2,
    ),
  );
  writeFileSync(
    fixture.settings,
    JSON.stringify({ packages: ["git:github.com/tlh/pi-subagents@old-pin"] }, null, 2),
  );

  runNode(mergeScript, [
    fixture.defaults,
    "--settings",
    fixture.settings,
    "--default-extensions",
    fixture.extensions,
    "--quiet",
  ]);

  const packages = readJson(fixture.settings).packages;
  assert(packages.includes("git:github.com/tlh/pi-subagents@new-pin"));
  assert(!packages.includes("git:github.com/tlh/pi-subagents@old-pin"));
});

test("merge repairs critical same-identity package entries with disabling extension filters", () => {
  for (const { name, extensions } of disablingExtensionFilterCases) {
    const fixture = tempFixture();
    const criticalSource = "git:github.com/tlh/pi-subagents@new-pin";
    const oldSource = "git:github.com/tlh/pi-subagents@old-pin";
    writeFileSync(
      fixture.extensions,
      JSON.stringify(
        [
          {
            id: "subagents",
            critical: true,
            source: criticalSource,
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
          packages: [{ source: oldSource, extensions, owner: "preserve" }],
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

    const packages = readJson(fixture.settings).packages;
    const repaired = packages.find((entry) => packageSourceOf(entry) === criticalSource);
    assert(repaired, `${name}: critical package source was not repaired`);
    assert.equal(
      repaired.owner,
      "preserve",
      `${name}: unrelated package fields should be preserved`,
    );
    assert.equal(
      Object.hasOwn(repaired, "extensions"),
      false,
      `${name}: disabling extension filter should be removed`,
    );
    assert.equal(
      packages.some((entry) => packageSourceOf(entry) === oldSource),
      false,
      `${name}: old source should be removed`,
    );
  }
});

test("merge removes critical package extension filters even when source is already canonical", () => {
  const fixture = tempFixture();
  const criticalSource = "git:github.com/tlh/pi-subagents@new-pin";
  writeFileSync(
    fixture.extensions,
    JSON.stringify(
      [
        {
          id: "subagents",
          critical: true,
          source: criticalSource,
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
          { source: criticalSource, extensions: ["-src/extension/index.ts"], owner: "preserve" },
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

  const repaired = readJson(fixture.settings).packages.find(
    (entry) => packageSourceOf(entry) === criticalSource,
  );
  assert.deepEqual(repaired, { source: criticalSource, owner: "preserve" });
});

test("merge --force updates non-critical package source when identity matches a new pinned source", () => {
  const fixture = tempFixture();
  writeFileSync(
    fixture.extensions,
    JSON.stringify(
      [
        {
          id: "helper",
          source: "git:github.com/tlh/helper@new-pin",
        },
      ],
      null,
      2,
    ),
  );
  writeFileSync(
    fixture.settings,
    JSON.stringify({ packages: ["git:github.com/tlh/helper@old-pin"] }, null, 2),
  );

  runNode(mergeScript, [
    fixture.defaults,
    "--settings",
    fixture.settings,
    "--default-extensions",
    fixture.extensions,
    "--force",
    "--quiet",
  ]);

  const packages = readJson(fixture.settings).packages;
  assert(packages.includes("git:github.com/tlh/helper@new-pin"));
  assert(!packages.includes("git:github.com/tlh/helper@old-pin"));
});

test("tlh-defaults emits critical sources despite disabling package extension filters", () => {
  for (const { name, extensions } of disablingExtensionFilterCases) {
    const fixture = tempFixture();
    const criticalSource = "git:github.com/tlh/critical@new-pin";
    writeFileSync(
      fixture.extensions,
      JSON.stringify(
        [
          {
            id: "critical",
            critical: true,
            source: criticalSource,
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
          packages: [{ source: "git:github.com/tlh/critical@old-pin", extensions }],
        },
        null,
        2,
      ),
    );

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
    assert.deepEqual(sources, [criticalSource], `${name}: sources should include critical default`);

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
    assert.deepEqual(
      criticalSources,
      [criticalSource],
      `${name}: critical-sources should include critical default`,
    );
  }
});

test("tlh-defaults list does not report critical defaults as disabled by package filters", () => {
  for (const { name, extensions } of disablingExtensionFilterCases) {
    const fixture = tempFixture();
    const criticalSource = "git:github.com/tlh/critical@new-pin";
    writeFileSync(
      fixture.extensions,
      JSON.stringify(
        [
          {
            id: "critical",
            critical: true,
            source: criticalSource,
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
          packages: [{ source: "git:github.com/tlh/critical@old-pin", extensions }],
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
      "list",
    ]);
    assert.match(
      output,
      /enabled\s+critical/,
      `${name}: critical default should be listed as enabled`,
    );
    assert.doesNotMatch(
      output,
      /disabled by package filter/,
      `${name}: critical package filter should not disable status`,
    );
  }
});

test("tlh-defaults keeps non-critical allowlisted package entrypoints enabled", () => {
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
        packages: [{ source: "npm:helper", extensions: ["index.ts"] }],
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
    "list",
  ]);
  assert.match(output, /enabled\s+helper/, "non-critical allowlist should be listed as enabled");
  assert.doesNotMatch(
    output,
    /disabled by package filter/,
    "non-critical allowlist should not be treated as disabled",
  );

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
  assert.deepEqual(sources, ["npm:helper"]);
});

test("tlh-defaults sources emit bundled pinned npm sources for existing unpinned managed defaults", () => {
  const fixture = tempFixture();
  writeFileSync(
    fixture.extensions,
    JSON.stringify(
      [
        {
          id: "oracle",
          source: "npm:@diegopetrucci/pi-oracle@0.1.12",
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
        packages: ["npm:@diegopetrucci/pi-oracle"],
      },
      null,
      2,
    ),
  );

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
  assert.deepEqual(sources, ["npm:@diegopetrucci/pi-oracle@0.1.12"]);
});

test("tlh-defaults sources emit the bundled npm pin when the installed managed package has an older same-identity pin", () => {
  const fixture = tempFixture();
  writeFileSync(
    fixture.extensions,
    JSON.stringify(
      [
        {
          id: "oracle",
          source: "npm:@diegopetrucci/pi-oracle@0.1.13",
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
        packages: ["npm:@diegopetrucci/pi-oracle@0.1.12"],
      },
      null,
      2,
    ),
  );

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
  assert.deepEqual(sources, ["npm:@diegopetrucci/pi-oracle@0.1.13"]);
});

test("tlh-defaults sources still respect disabled defaults while migrating pi-web-access replacements to the managed npm pin", () => {
  const fixture = tempFixture();
  writeFileSync(
    fixture.extensions,
    JSON.stringify(
      [
        {
          id: "oracle",
          source: "npm:@diegopetrucci/pi-oracle@0.1.12",
        },
        {
          id: "notify",
          source: "npm:@diegopetrucci/pi-notify@0.1.5",
        },
        {
          id: "pi-web-access",
          replaces: [
            "npm:pi-web-access",
            "git:github.com/nicobailon/pi-web-access",
            previousPiWebAccessSource,
          ],
          migrateReplacements: true,
          source: bundledSource("pi-web-access"),
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
          "npm:@diegopetrucci/pi-oracle",
          "npm:@diegopetrucci/pi-notify",
          "npm:pi-web-access",
        ],
        tlh: { disabledDefaultExtensions: ["notify"] },
      },
      null,
      2,
    ),
  );

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
  assert.deepEqual(sources, [
    "npm:@diegopetrucci/pi-oracle@0.1.12",
    bundledSource("pi-web-access"),
  ]);
});

test("tlh-defaults sources defers non-migrating replacements and ignores stale/manual critical opt-outs", () => {
  const fixture = tempFixture();
  writeFileSync(
    fixture.extensions,
    JSON.stringify(
      [
        {
          id: "deferred",
          replaces: ["npm:old-default"],
          critical: true,
          source: "npm:new-default",
        },
        {
          id: "critical-enabled",
          critical: true,
          source: "git:github.com/tlh/critical@pin",
        },
        {
          id: "critical-disabled",
          critical: true,
          source: "git:github.com/tlh/disabled@pin",
        },
        {
          id: "non-critical-disabled",
          source: "npm:non-critical",
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
        packages: ["npm:old-default", "git:github.com/tlh/critical@old-pin"],
        tlh: { disabledDefaultExtensions: ["critical-disabled", "non-critical-disabled"] },
      },
      null,
      2,
    ),
  );

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
  assert.deepEqual(sources, ["git:github.com/tlh/critical@pin", "git:github.com/tlh/disabled@pin"]);

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
  assert.deepEqual(criticalSources, [
    "git:github.com/tlh/critical@pin",
    "git:github.com/tlh/disabled@pin",
  ]);
});

for (const replacementSource of [
  "npm:pi-web-access@0.10.7",
  "git:github.com/nicobailon/pi-web-access@v0.10.7",
  previousPiWebAccessSource,
]) {
  test(`tlh-defaults enable switches ${replacementSource} to the bundled TLH source`, () => {
    const fixture = tempFixture();
    writeFileSync(
      fixture.extensions,
      JSON.stringify(
        [
          {
            id: "pi-web-access",
            replaces: [
              "npm:pi-web-access",
              "git:github.com/nicobailon/pi-web-access",
              previousPiWebAccessSource,
            ],
            migrateReplacements: true,
            source: bundledSource("pi-web-access"),
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
          packages: [replacementSource],
          tlh: { disabledDefaultExtensions: ["pi-web-access"] },
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
      "pi-web-access",
    ]);

    const settings = readJson(fixture.settings);
    assert.deepEqual(settings.packages, [bundledSource("pi-web-access")]);
    assert.deepEqual(settings.tlh.disabledDefaultExtensions, []);
    assert.deepEqual(settings.tlh.defaultExtensionProvenance.managedPackageIdentities, [
      "npm:@diegopetrucci/pi-web-access",
    ]);
  });
}

test("tlh-defaults disable anthropic-auth removes package and drops warnings.anthropicExtraUsage when it is the tlh default", () => {
  const fixture = tempFixture();
  writeFileSync(
    fixture.extensions,
    JSON.stringify(
      [
        {
          id: "anthropic-auth",
          source: "npm:@gotgenes/pi-anthropic-auth",
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
        packages: ["npm:@gotgenes/pi-anthropic-auth"],
        warnings: { anthropicExtraUsage: false },
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
    "anthropic-auth",
  ]);

  const settings = readJson(fixture.settings);
  assert(
    !settings.packages.includes("npm:@gotgenes/pi-anthropic-auth"),
    "package should be removed",
  );
  assert.equal(settings.warnings, undefined, "warnings should be dropped when it becomes empty");
  assert.deepEqual(settings.tlh?.defaultExtensionProvenance?.managedPackageIdentities, []);
});

test("tlh-defaults enable anthropic-auth restores warnings.anthropicExtraUsage when no warnings object is present", () => {
  const fixture = tempFixture();
  writeFileSync(
    fixture.extensions,
    JSON.stringify(
      [
        {
          id: "anthropic-auth",
          source: "npm:@gotgenes/pi-anthropic-auth",
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
        packages: [],
        tlh: { disabledDefaultExtensions: ["anthropic-auth"] },
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
    "anthropic-auth",
  ]);

  const settings = readJson(fixture.settings);
  assert(settings.packages.includes("npm:@gotgenes/pi-anthropic-auth"), "package should be added");
  assert.equal(
    settings.warnings?.anthropicExtraUsage,
    false,
    "warnings.anthropicExtraUsage should be set to false",
  );
  assert.deepEqual(settings.tlh.defaultExtensionProvenance.managedPackageIdentities, [
    "npm:@gotgenes/pi-anthropic-auth",
  ]);
});

test("tlh-defaults disable anthropic-auth preserves explicit warnings.anthropicExtraUsage: true set by the user", () => {
  const fixture = tempFixture();
  writeFileSync(
    fixture.extensions,
    JSON.stringify(
      [
        {
          id: "anthropic-auth",
          source: "npm:@gotgenes/pi-anthropic-auth",
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
        packages: ["npm:@gotgenes/pi-anthropic-auth"],
        warnings: { anthropicExtraUsage: true },
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
    "anthropic-auth",
  ]);

  const settings = readJson(fixture.settings);
  assert(
    !settings.packages.includes("npm:@gotgenes/pi-anthropic-auth"),
    "package should be removed",
  );
  assert.equal(
    settings.warnings?.anthropicExtraUsage,
    true,
    "explicit true value should be preserved",
  );
  assert(settings.warnings !== undefined, "warnings object should remain intact");
});

test("merge does not introduce warnings.anthropicExtraUsage when anthropic-auth is in disabledDefaultExtensions", () => {
  const fixture = tempFixture();
  // Synthetic defaults with the warnings suppression that ships in config/settings.defaults.json.
  writeFileSync(
    fixture.defaults,
    JSON.stringify({ packages: [], warnings: { anthropicExtraUsage: false } }, null, 2),
  );
  writeFileSync(
    fixture.extensions,
    JSON.stringify(
      [
        {
          id: "anthropic-auth",
          source: "npm:@gotgenes/pi-anthropic-auth",
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
        packages: [],
        tlh: { disabledDefaultExtensions: ["anthropic-auth"] },
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
  assert.equal(
    settings.warnings?.anthropicExtraUsage,
    undefined,
    "warnings.anthropicExtraUsage should not be introduced by merge",
  );
  assert.equal(settings.warnings, undefined, "warnings object should not be created by merge");
});

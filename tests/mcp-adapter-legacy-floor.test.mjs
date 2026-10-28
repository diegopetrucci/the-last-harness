import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { after, test } from "node:test";

import { readDefaultExtensions } from "../scripts/lib/default-extensions.mjs";
import { MCP_ADAPTER_LEGACY_PIN_FLOOR } from "../scripts/lib/mcp-adapter-cutover.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const mergeScript = join(repoRoot, "scripts", "merge-settings.mjs");
const harnessPackage = "git:github.com/diegopetrucci/the-last-harness";
const identity = "npm:@diegopetrucci/pi-mcp-adapter";
const floorSource = `${identity}@2.36.0`;
const oldSource = `${identity}@2.11.0`;
const managed = {
  defaultExtensionProvenance: { managedPackageIdentities: [identity] },
};
const mcporter = readDefaultExtensions(join(repoRoot, "config", "default-extensions.json")).find(
  (extension) => extension.id === "mcporter",
);
assert.ok(mcporter);

const tempRoots = [];
after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function createFixture(settings, { installedVersion } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tlh-mcp-floor-test-"));
  tempRoots.push(dir);
  const settingsPath = join(dir, "settings.json");
  const defaultsPath = join(dir, "settings.defaults.json");
  const extensionsPath = join(dir, "default-extensions.json");
  writeFileSync(
    defaultsPath,
    JSON.stringify({ packages: [harnessPackage], lastChangelogVersion: "9999.0.0" }),
  );
  writeFileSync(extensionsPath, JSON.stringify([mcporter]));
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  if (installedVersion) {
    const packageDir = join(dir, "npm", "node_modules", "@diegopetrucci", "pi-mcp-adapter");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "@diegopetrucci/pi-mcp-adapter", version: installedVersion }),
    );
  }
  return { dir, settingsPath, defaultsPath, extensionsPath };
}

function runMerge(fixture, extraArgs = []) {
  const result = spawnSync(
    process.execPath,
    [
      mergeScript,
      fixture.defaultsPath,
      "--settings",
      fixture.settingsPath,
      "--default-extensions",
      fixture.extensionsPath,
      ...extraArgs,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, HOME: join(fixture.dir, "home"), PI_CODING_AGENT_DIR: fixture.dir },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, `merge failed\n${result.stdout}\n${result.stderr}`);
  return { ...result, settings: readJson(fixture.settingsPath) };
}

function backups(fixture) {
  return readdirSync(fixture.dir).filter(
    (name) => name.startsWith("settings.json.") && name !== "settings.json",
  );
}

test("floor constant is the documented last pre-v5 adapter", () => {
  assert.equal(MCP_ADAPTER_LEGACY_PIN_FLOOR, "2.36.0");
});

test("managed exact pre-floor pin advances to the floor, stays held, and is idempotent", () => {
  const fixture = createFixture({
    packages: [harnessPackage, oldSource],
    tlh: managed,
  });

  const dry = runMerge(fixture, ["--dry-run"]);
  assert.match(
    dry.stdout,
    new RegExp(`Would update ${identity} pin: ${oldSource} -> ${floorSource}`),
  );
  assert.deepEqual(dry.settings.packages, [harnessPackage, oldSource]);
  assert.deepEqual(backups(fixture), []);

  const first = runMerge(fixture);
  assert.deepEqual(first.settings.packages, [harnessPackage, floorSource]);
  assert.match(
    first.stdout,
    new RegExp(`Will update ${identity} pin: ${oldSource} -> ${floorSource}`),
  );
  assert.match(first.stderr, /cutover held for mcporter: selected adapter is pre-v5/);
  assert.doesNotMatch(first.stderr, /metadata conflicts/);
  assert.equal(backups(fixture).length, 1);
  assert.ok(!JSON.stringify(first.settings).includes("@5."));
  assert.deepEqual(first.settings.tlh.defaultExtensionProvenance.managedPackageIdentities, [
    identity,
  ]);

  const second = runMerge(fixture);
  assert.match(second.stdout, /No settings changes needed\./);
  assert.deepEqual(second.settings.packages, [harnessPackage, floorSource]);
  assert.match(second.stderr, /cutover held for mcporter: selected adapter is pre-v5/);
});

test("--force authorizes the floor for an unmanaged exact pin", () => {
  const fixture = createFixture({ packages: [harnessPackage, oldSource] });
  assert.deepEqual(runMerge(fixture, ["--force"]).settings.packages, [harnessPackage, floorSource]);
});

const unchanged = [
  ["unmanaged provenance without --force", { packages: [harnessPackage, oldSource] }],
  ["exactly the floor", { packages: [harnessPackage, floorSource], tlh: managed }],
  ["a v5 selection", { packages: [harnessPackage, `${identity}@5.0.0`], tlh: managed }],
  [
    "an object entry",
    { packages: [harnessPackage, { source: oldSource, extensions: ["x"] }], tlh: managed },
  ],
  [
    "a replacement identity",
    { packages: [harnessPackage, "npm:pi-mcp-adapter@2.11.0"], tlh: managed },
  ],
  ["a range selector", { packages: [harnessPackage, `${identity}@^2.11.0`], tlh: managed }],
  ["an unpinned selector", { packages: [harnessPackage, identity], tlh: managed }],
  [
    "disabled id opt-out",
    {
      packages: [harnessPackage, oldSource],
      tlh: { ...managed, disabledDefaultExtensions: ["mcporter"] },
    },
  ],
  [
    "package filter opt-out",
    { packages: [harnessPackage, { source: oldSource, extensions: [] }], tlh: managed },
  ],
  [
    "multiple selections",
    { packages: [harnessPackage, oldSource, "npm:pi-mcp-adapter"], tlh: managed },
  ],
];

for (const [name, settings] of unchanged) {
  test(`floor leaves settings unchanged for ${name}`, () => {
    const fixture = createFixture(settings);
    const result = runMerge(fixture);
    const sources = result.settings.packages.map((entry) =>
      typeof entry === "string" ? entry : entry.source,
    );
    const hadFloor = settings.packages.includes(floorSource);
    assert.equal(sources.includes(floorSource), hadFloor, "floor pin must not be introduced");
    // Other merge behavior (opt-out removal, normal v5 migration) is out of scope here.
    if (!/opt-out|a v5 selection/.test(name)) {
      assert.deepEqual(result.settings.packages, settings.packages);
    }
  });
}

test("floor leaves settings unchanged on an installed-metadata conflict", () => {
  const fixture = createFixture(
    { packages: [harnessPackage, oldSource], tlh: managed },
    { installedVersion: "5.0.0" },
  );
  const result = runMerge(fixture);
  assert.deepEqual(result.settings.packages, [harnessPackage, oldSource]);
  assert.match(result.stderr, /installed adapter metadata conflicts/);
});

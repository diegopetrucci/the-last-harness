/**
 * Tests for the 'system' theme default merge behaviour.
 *
 * These cases cover the scenarios where the packaged default is 'system':
 * - missing theme gets filled in
 * - existing 'the-last-harness' (the previous default) is preserved
 * - any other custom theme is preserved
 * - --force overwrites with the declared default
 * - repeat merge after filling 'system' is idempotent
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";

const _tmpDirs = [];
after(() => {
  for (const d of _tmpDirs) rmSync(d, { recursive: true, force: true });
});

const repoRoot = resolve(import.meta.dirname, "..");
const mergeScript = join(repoRoot, "scripts", "merge-settings.mjs");
const harnessPackage = "git:github.com/diegopetrucci/the-last-harness";

function tempFixture(defaultsValue, settingsValue, extensionsValue = []) {
  const dir = mkdtempSync(join(tmpdir(), "tlh-merge-theme-test-"));
  _tmpDirs.push(dir);
  const defaults = join(dir, "settings.defaults.json");
  const extensions = join(dir, "default-extensions.json");
  const settings = join(dir, "settings.json");
  writeFileSync(defaults, JSON.stringify(defaultsValue, null, 2));
  writeFileSync(extensions, `${JSON.stringify(extensionsValue, null, 2)}\n`);
  writeFileSync(settings, JSON.stringify(settingsValue, null, 2));
  return { defaults, extensions, settings };
}

function runMerge(fixture, { dryRun = false, force = false, quiet = true } = {}) {
  const args = [
    mergeScript,
    fixture.defaults,
    "--settings",
    fixture.settings,
    "--default-extensions",
    fixture.extensions,
  ];
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

test("merge fills missing theme with 'system' default", () => {
  const fixture = tempFixture(
    { packages: [harnessPackage], theme: "system" },
    { packages: [harnessPackage] },
  );

  runMerge(fixture);

  const settings = readJson(fixture.settings);
  assert.equal(settings.theme, "system");
});

test("merge preserves existing 'the-last-harness' theme without migration", () => {
  const fixture = tempFixture(
    { packages: [harnessPackage], theme: "system" },
    { packages: [harnessPackage], theme: "the-last-harness" },
  );

  runMerge(fixture);

  const settings = readJson(fixture.settings);
  assert.equal(
    settings.theme,
    "the-last-harness",
    "existing 'the-last-harness' must not be migrated to 'system'",
  );
});

test("merge preserves other custom theme without migration", () => {
  const fixture = tempFixture(
    { packages: [harnessPackage], theme: "system" },
    { packages: [harnessPackage], theme: "my-project-theme" },
  );

  runMerge(fixture);

  const settings = readJson(fixture.settings);
  assert.equal(settings.theme, "my-project-theme");
});

test("merge --force overwrites theme with default", () => {
  // --force applies all scalar defaults from the defaults file.
  // Theme is a user-owned scalar, so --force replaces an existing explicit
  // value with whatever the defaults file declares (currently 'system').
  const fixture = tempFixture(
    { packages: [harnessPackage], theme: "system" },
    { packages: [harnessPackage], theme: "the-last-harness" },
  );

  runMerge(fixture, { force: true });

  const settings = readJson(fixture.settings);
  assert.equal(settings.theme, "system", "--force must overwrite theme with the declared default");
});

test("merge is idempotent after filling missing theme with 'system'", () => {
  const fixture = tempFixture(
    { packages: [harnessPackage], theme: "system" },
    { packages: [harnessPackage] },
  );

  runMerge(fixture);
  const afterFirst = readFileSync(fixture.settings, "utf8");
  const backupsAfterFirst = backupFiles(fixture.settings);

  const secondOutput = runMerge(fixture, { quiet: false });
  assert.match(secondOutput, /No settings changes needed\./);
  assert.equal(readFileSync(fixture.settings, "utf8"), afterFirst);
  assert.deepEqual(backupFiles(fixture.settings), backupsAfterFirst);
});

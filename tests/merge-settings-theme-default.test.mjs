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
import { readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";

import { tempFixture, runMerge, readJson } from "./support/merge-settings-fixtures.mjs";

const harnessPackage = "git:github.com/diegopetrucci/the-last-harness";

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

import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { tempFixture, runMerge, readJson } from "./support/merge-settings-fixtures.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const harnessPackage = "git:github.com/diegopetrucci/the-last-harness";

const defaults = { packages: [] };
const marker = { compactionReserveTokensManaged: true };

function merged(settingsExtra, opts) {
  const fixture = tempFixture(defaults, { packages: [harnessPackage], ...settingsExtra });
  const output = runMerge(fixture, { quiet: false, ...opts });
  return { fixture, output, result: readJson(fixture.settings) };
}

test("marker + 49152 removes the reserve, the empty compaction object, and the marker", () => {
  const { result, output } = merged({ compaction: { reserveTokens: 49152 }, tlh: marker });
  assert.equal(result.compaction, undefined);
  assert.equal(result.tlh.compactionReserveTokensManaged, undefined);
  assert.match(output, /remove retired TLH compaction\.reserveTokens default/);
});

test("marker + 49152 preserves other compaction keys", () => {
  const modelOverrides = { "p/m": { reserveTokens: 8000 } };
  const { result } = merged({
    compaction: { enabled: false, reserveTokens: 49152, modelOverrides },
    tlh: marker,
  });
  assert.deepEqual(result.compaction, { enabled: false, modelOverrides });
  assert.equal(result.tlh.compactionReserveTokensManaged, undefined);
});

for (const value of [16384, 1234]) {
  test(`marker + custom reserve ${value} is kept and the marker is cleared`, () => {
    const { result } = merged({ compaction: { reserveTokens: value }, tlh: marker });
    assert.equal(result.compaction.reserveTokens, value);
    assert.equal(result.tlh.compactionReserveTokensManaged, undefined);
  });
}

test("marker without a compaction object just clears the marker", () => {
  const { result } = merged({ tlh: marker });
  assert.equal(result.compaction, undefined);
  assert.equal(result.tlh.compactionReserveTokensManaged, undefined);
});

for (const force of [false, true]) {
  test(`no marker leaves 49152 untouched (force=${force})`, () => {
    const { result } = merged({ compaction: { reserveTokens: 49152 } }, { force });
    assert.deepEqual(result.compaction, { reserveTokens: 49152 });
  });

  test(`marker + 49152 is migrated with force=${force}`, () => {
    const { result } = merged({ compaction: { reserveTokens: 49152 }, tlh: marker }, { force });
    assert.equal(result.compaction, undefined);
  });
}

test("dry-run reports the migration without writing", () => {
  const settings = {
    packages: [harnessPackage],
    compaction: { reserveTokens: 49152 },
    tlh: marker,
  };
  const fixture = tempFixture(defaults, settings);
  const output = runMerge(fixture, { dryRun: true, quiet: false });
  assert.match(output, /Would remove retired TLH compaction\.reserveTokens default/);
  assert.match(output, /Would clear compaction\.reserveTokens ownership marker/);
  assert.deepEqual(readJson(fixture.settings), settings);
});

test("migration is idempotent", () => {
  const { fixture } = merged({ compaction: { reserveTokens: 49152 }, tlh: marker });
  const second = runMerge(fixture, { quiet: false });
  assert.match(second, /No settings changes needed\./);
});

test("shipped settings.defaults.json no longer contains compaction", () => {
  const shipped = readJson(join(repoRoot, "config", "settings.defaults.json"));
  assert.equal("compaction" in shipped, false);
});

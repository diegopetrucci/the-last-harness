import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const mergeScript = join(repoRoot, "scripts", "merge-settings.mjs");
const harnessPackage = "git:github.com/diegopetrucci/the-last-harness";

const _tmpDirs = [];
after(() => {
  for (const d of _tmpDirs) rmSync(d, { recursive: true, force: true });
});

function tempFixture(defaultsValue, settingsValue, extensionsValue = []) {
  const dir = mkdtempSync(join(tmpdir(), "tlh-merge-settings-test-"));
  _tmpDirs.push(dir);
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
  { dryRun = false, force = false, quiet = true, packageSource = "", env = process.env } = {},
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
    env,
    encoding: "utf8",
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const defaults = { packages: [], compaction: { reserveTokens: 49152 } };
const base = { packages: [harnessPackage] };

function merged(settingsExtra, opts) {
  const fixture = tempFixture(defaults, { ...base, ...settingsExtra });
  const output = runMerge(fixture, { quiet: false, ...opts });
  return { fixture, output, result: readJson(fixture.settings) };
}

test("missing compaction key gets reserveTokens and the marker", () => {
  const { result, output } = merged({});
  assert.deepEqual(result.compaction, { reserveTokens: 49152 });
  assert.equal(result.tlh.compactionReserveTokensManaged, true);
  assert.match(output, /mark compaction\.reserveTokens as TLH-managed/);
});

test("compaction {enabled:false} keeps enabled and gains reserveTokens + marker", () => {
  const { result } = merged({ compaction: { enabled: false } });
  assert.deepEqual(result.compaction, { enabled: false, reserveTokens: 49152 });
  assert.equal(result.tlh.compactionReserveTokensManaged, true);
});

test("compaction with only modelOverrides keeps them and gains reserveTokens + marker", () => {
  const modelOverrides = { "p/m": { reserveTokens: 8000 } };
  const { result } = merged({ compaction: { modelOverrides } });
  assert.deepEqual(result.compaction, { modelOverrides, reserveTokens: 49152 });
  assert.equal(result.tlh.compactionReserveTokensManaged, true);
});

test("user reserveTokens is preserved without --force and no marker is set", () => {
  const { result, output } = merged({ compaction: { reserveTokens: 16384 } });
  assert.equal(result.compaction.reserveTokens, 16384);
  assert.equal(result.tlh?.compactionReserveTokensManaged, undefined);
  assert.doesNotMatch(output, /compaction\.reserveTokens/);
});

for (const value of [null, "custom"]) {
  test(`non-object compaction (${JSON.stringify(value)}) is preserved without --force`, () => {
    const { result } = merged({ compaction: value });
    assert.equal(result.compaction, value);
    assert.equal(result.tlh?.compactionReserveTokensManaged, undefined);
  });
}

test("--force overwrites a different user value and sets the marker", () => {
  const { result } = merged({ compaction: { reserveTokens: 16384 } }, { force: true });
  assert.equal(result.compaction.reserveTokens, 49152);
  assert.equal(result.tlh.compactionReserveTokensManaged, true);
});

test("marker is skipped when tlh is not a plain object", () => {
  const { result } = merged({ tlh: "x" });
  assert.equal(result.compaction.reserveTokens, 49152);
  assert.equal(result.tlh, "x");
});

test("a second merge reports no changes and keeps the marker", () => {
  const { fixture } = merged({});
  const second = runMerge(fixture, { quiet: false });
  assert.match(second, /No settings changes needed\./);
  assert.equal(readJson(fixture.settings).tlh.compactionReserveTokensManaged, true);
});

test("dry-run reports the change but does not write", () => {
  const fixture = tempFixture(defaults, base);
  const output = runMerge(fixture, { dryRun: true, quiet: false });
  assert.match(output, /Would mark compaction\.reserveTokens as TLH-managed/);
  assert.deepEqual(readJson(fixture.settings), base);
});

test("shipped settings.defaults.json ships compaction.reserveTokens 49152", () => {
  const shipped = readJson(join(repoRoot, "config", "settings.defaults.json"));
  assert.equal(shipped.compaction?.reserveTokens, 49152);
  const fixture = tempFixture(shipped, base);
  runMerge(fixture);
  const result = readJson(fixture.settings);
  assert.equal(result.compaction.reserveTokens, 49152);
  assert.equal(result.tlh.compactionReserveTokensManaged, true);
});

for (const force of [false, true]) {
  test(`existing reserveTokens 49152 without marker stays unmarked (force=${force})`, () => {
    const { result } = merged({ compaction: { reserveTokens: 49152 } }, { force });
    assert.equal(result.compaction.reserveTokens, 49152);
    assert.equal(result.tlh?.compactionReserveTokensManaged, undefined);
  });
}

test("existing marker alongside a preserved custom value keeps both", () => {
  const { result } = merged({
    compaction: { reserveTokens: 16384 },
    tlh: { compactionReserveTokensManaged: true },
  });
  assert.equal(result.compaction.reserveTokens, 16384);
  assert.equal(result.tlh.compactionReserveTokensManaged, true);
});

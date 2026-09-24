import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const mergeScript = join(repoRoot, "scripts", "merge-settings.mjs");
const harnessPackage = "git:github.com/diegopetrucci/the-last-harness";

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

test("merge adds cacheWarming: idle when the key is absent from isolated settings", () => {
  const fixture = tempFixture(
    { packages: [], cacheWarming: "idle" },
    { packages: [harnessPackage] },
  );

  runMerge(fixture);

  assert.equal(readJson(fixture.settings).cacheWarming, "idle");
});

test("merge preserves cacheWarming: off without --force", () => {
  const fixture = tempFixture(
    { packages: [], cacheWarming: "idle" },
    { packages: [harnessPackage], cacheWarming: "off" },
  );

  runMerge(fixture);

  assert.equal(
    readJson(fixture.settings).cacheWarming,
    "off",
    "user-set cacheWarming: off must survive without --force",
  );
});

test("merge preserves cacheWarming: streaming without --force", () => {
  const fixture = tempFixture(
    { packages: [], cacheWarming: "idle" },
    { packages: [harnessPackage], cacheWarming: "streaming" },
  );

  runMerge(fixture);

  assert.equal(
    readJson(fixture.settings).cacheWarming,
    "streaming",
    "user-set cacheWarming: streaming must survive without --force",
  );
});

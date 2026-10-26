import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after } from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const mergeScript = join(repoRoot, "scripts", "merge-settings.mjs");

const _tmpDirs = [];
after(() => {
  for (const d of _tmpDirs) rmSync(d, { recursive: true, force: true });
});

export function tempFixture(defaultsValue, settingsValue, extensionsValue = []) {
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

export function runMerge(
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

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

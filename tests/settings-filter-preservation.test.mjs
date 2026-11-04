import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const mergeScript = join(repoRoot, "scripts", "merge-settings.mjs");
const harness = "git:github.com/diegopetrucci/the-last-harness";
const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function merge(settingsValue, defaultsValue, packageSource) {
  const dir = mkdtempSync(join(tmpdir(), "tlh-filter-preserve-"));
  tmpDirs.push(dir);
  const defaults = join(dir, "defaults.json");
  const extensions = join(dir, "default-extensions.json");
  const settings = join(dir, "settings.json");
  writeFileSync(defaults, JSON.stringify(defaultsValue));
  writeFileSync(extensions, "[]\n");
  writeFileSync(settings, JSON.stringify(settingsValue));
  const run = () =>
    execFileSync(
      process.execPath,
      [
        mergeScript,
        defaults,
        "--settings",
        settings,
        "--default-extensions",
        extensions,
        ...(packageSource ? ["--package-source", packageSource] : []),
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
  const out = run();
  const first = readFileSync(settings, "utf8");
  run();
  assert.equal(readFileSync(settings, "utf8"), first, "merge must be idempotent");
  return { out, settings: JSON.parse(first) };
}

test("harness source update keeps object-entry filters and replaces string entries", () => {
  const defaults = { packages: [`${harness}@tlh-v2.0.0`] };
  const obj = merge(
    {
      packages: [{ source: `${harness}@tlh-v1.0.0`, skills: [], extensions: ["a.js"], custom: 1 }],
    },
    defaults,
    `${harness}@tlh-v2.0.0`,
  );
  assert.deepEqual(obj.settings.packages, [
    { source: `${harness}@tlh-v2.0.0`, skills: [], extensions: ["a.js"], custom: 1 },
  ]);
  assert.match(obj.out, /replace packages: .*tlh-v1\.0\.0 -> .*tlh-v2\.0\.0/);

  const str = merge({ packages: [`${harness}@tlh-v1.0.0`] }, defaults, `${harness}@tlh-v2.0.0`);
  assert.deepEqual(str.settings.packages, [`${harness}@tlh-v2.0.0`]);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const oxlintPath = join(repoRoot, "node_modules/.bin/oxlint");
const oxlintConfigPath = join(repoRoot, ".oxlintrc.json");
const ruleCode = "anti-slop(no-reflect-apply)";

function lintFixtures(t, fixtures) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "tlh-no-reflect-apply-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const fixturePaths = Object.entries(fixtures).map(([name, source]) => {
    const fixturePath = join(fixtureRoot, name);
    writeFileSync(fixturePath, source);
    return fixturePath;
  });

  const result = spawnSync(
    oxlintPath,
    ["--config", oxlintConfigPath, "--quiet", "--format", "json", ...fixturePaths],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.stderr, "");
  assert.ok(result.stdout.length > 0, "Oxlint should emit a JSON report");
  const report = JSON.parse(result.stdout);
  return report.diagnostics
    .map((diagnostic) => ({
      code: diagnostic.code,
      filename: basename(diagnostic.filename),
      line: diagnostic.labels[0]?.span.line,
      severity: diagnostic.severity,
    }))
    .sort(
      (left, right) =>
        left.filename.localeCompare(right.filename) || (left.line ?? 0) - (right.line ?? 0),
    );
}

test("no-reflect-apply reports global direct and computed calls", (t) => {
  const diagnostics = lintFixtures(t, {
    "global.js": `Reflect.apply(fn, receiver, args);
Reflect["apply"](fn, receiver, args);
Reflect['apply'](fn, receiver, args);
`,
  });

  assert.deepEqual(
    diagnostics.map(({ filename, line }) => `${filename}:${line}`),
    ["global.js:1", "global.js:2", "global.js:3"],
  );
  assert.ok(diagnostics.every(({ code, severity }) => code === ruleCode && severity === "error"));
});

test("no-reflect-apply ignores shadowed Reflect and unrelated calls", (t) => {
  const diagnostics = lintFixtures(t, {
    "allowed.ts": `
function shadowedParameter(Reflect: { apply(): void }) {
  Reflect.apply();
  Reflect["apply"]();
}

function shadowedBinding() {
  const Reflect = { apply() {} };
  Reflect.apply();
  Reflect["apply"]();
}

const localReflect = { apply() {} };
localReflect.apply();
Reflect.get(target, key);
Reflect["get"](target, key);
Reflect.construct(Constructor, args);
`,
  });

  assert.deepEqual(diagnostics, []);
});

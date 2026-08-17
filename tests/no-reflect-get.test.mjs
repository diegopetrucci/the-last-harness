import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const oxlintPath = join(repoRoot, "node_modules/.bin/oxlint");
const oxlintConfigPath = join(repoRoot, ".oxlintrc.json");
const ruleCode = "anti-slop(no-reflect-get)";

function lintFixtures(t, fixtures) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "tlh-no-reflect-get-"));
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

test("no-reflect-get reports global direct and computed calls", (t) => {
  const diagnostics = lintFixtures(t, {
    "global.js": `Reflect.get(target, key);
Reflect["get"](target, key);
Reflect['get'](target, key);
`,
  });

  assert.deepEqual(
    diagnostics.map(({ filename, line }) => `${filename}:${line}`),
    ["global.js:1", "global.js:2", "global.js:3"],
  );
  assert.ok(diagnostics.every(({ code, severity }) => code === ruleCode && severity === "error"));
});

test("no-reflect-get ignores shadowed Reflect and unrelated calls", (t) => {
  const diagnostics = lintFixtures(t, {
    "allowed.ts": `
function shadowedParameter(Reflect: { get(): unknown }) {
  Reflect.get();
  Reflect["get"]();
}

function shadowedBinding() {
  const Reflect = { get() {} };
  Reflect.get();
  Reflect["get"]();
}

const localReflect = { get() {} };
localReflect.get();
Reflect.construct(Constructor, args);
Reflect["construct"](Constructor, args);
Reflect.set(target, key, value);
`,
  });

  assert.deepEqual(diagnostics, []);
});

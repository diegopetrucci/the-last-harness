import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const oxlintPath = join(repoRoot, "node_modules/.bin/oxlint");
const oxlintConfigPath = join(repoRoot, ".oxlintrc.json");
const ruleCode = "anti-slop(no-object-parameters)";

function lintFixtures(t, fixtures) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "tlh-no-object-parameters-"));
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

test("no-object-parameters rejects direct object, local aliases, parenthesized aliases, and object unions", (t) => {
  const diagnostics = lintFixtures(t, {
    "rejected-alias.ts": `type LocalObject = object;
type ParenthesizedObject = (LocalObject);
type ParenthesizedKeyword = (object);
function localAlias(input: LocalObject): void {}
function parenthesizedAlias(input: ParenthesizedObject): void {}
function parenthesizedKeyword(input: ParenthesizedKeyword): void {}
`,
    "rejected-direct.ts": `function direct(input: object): void {}
const arrow = (input: object): void => {};
`,
    "rejected-union.ts": `interface OwnerContract {
  ownerId: string;
}
type OwnerOrObject = OwnerContract | object;
function inlineUnion(input: OwnerContract | object): void {}
function aliasedUnion(input: OwnerOrObject): void {}
`,
  });

  assert.deepEqual(
    diagnostics.map(({ filename, line }) => `${filename}:${line}`),
    [
      "rejected-alias.ts:4",
      "rejected-alias.ts:5",
      "rejected-alias.ts:6",
      "rejected-direct.ts:1",
      "rejected-direct.ts:2",
      "rejected-union.ts:5",
      "rejected-union.ts:6",
    ],
  );
  assert.ok(diagnostics.every(({ code, severity }) => code === ruleCode && severity === "error"));
});

test("no-object-parameters allows owner-specific and meaningfully constrained generic inputs", (t) => {
  const diagnostics = lintFixtures(t, {
    "allowed.ts": `interface OwnerContract {
  ownerId: string;
  displayName: string;
}

function acceptOwner(owner: OwnerContract): OwnerContract {
  return owner;
}

function preserveSpecificOwner<T extends OwnerContract>(owner: T): T {
  return owner;
}
`,
  });

  assert.deepEqual(diagnostics, []);
});

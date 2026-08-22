import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const oxlintPath = join(repoRoot, "node_modules/.bin/oxlint");
const oxlintConfigPath = join(repoRoot, ".oxlintrc.json");
const ruleCode = "anti-slop(no-chained-type-assertions)";

function lintFixtures(t, fixtures) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "tlh-no-chained-type-assertions-"));
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

test("no-chained-type-assertions reports direct, parenthesized, angle, and mixed chains", (t) => {
  const diagnostics = lintFixtures(t, {
    "rejected.ts": `
interface OwnerContract {
  ownerId: string;
}

declare const untrusted: unknown;

const direct = untrusted as unknown as OwnerContract;
const parenthesized = (untrusted as unknown) as OwnerContract;
const angle = <OwnerContract><unknown>untrusted;
const mixed = ({ ownerId: "owner" } as const) as OwnerContract;
`,
  });

  assert.deepEqual(
    diagnostics.map(({ filename, line }) => `${filename}:${line}`),
    ["rejected.ts:8", "rejected.ts:9", "rejected.ts:10", "rejected.ts:11"],
  );
  assert.ok(diagnostics.every(({ code, severity }) => code === ruleCode && severity === "error"));
});

test("no-chained-type-assertions allows one owner assertion, const values, and validated boundaries", (t) => {
  const diagnostics = lintFixtures(t, {
    "allowed.ts": `
interface OwnerContract {
  ownerId: string;
}

const owner = { ownerId: "owner" } as OwnerContract;
const frozenOwner = { ownerId: "owner" } as const;

function isOwnerContract(value: unknown): value is OwnerContract {
  return (
    typeof value === "object" &&
    value !== null &&
    "ownerId" in value &&
    typeof value.ownerId === "string"
  );
}

function parseOwner(value: unknown): OwnerContract {
  if (!isOwnerContract(value)) throw new Error("invalid owner");
  return value;
}

declare const externalInput: unknown;
const validatedOwner = parseOwner(externalInput);
`,
  });

  assert.deepEqual(diagnostics, []);
});

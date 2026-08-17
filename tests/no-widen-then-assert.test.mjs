import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const oxlintPath = join(repoRoot, "node_modules/.bin/oxlint");
const oxlintConfigPath = join(repoRoot, ".oxlintrc.json");
const ruleCode = "anti-slop(no-widen-then-assert)";

function lintFixtures(t, fixtures) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "tlh-no-widen-then-assert-"));
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

test("no-widen-then-assert reports representative broad bindings restored with assertions", (t) => {
  const diagnostics = lintFixtures(t, {
    "rejected.ts": `
function restore() {
  const unknownConfig: unknown = { retries: 3 };
  const fromUnknown = unknownConfig as { retries: number };
  const fromUnknownAngle = <{ retries: number }>unknownConfig;

  const objectConfig: object = { retries: 3 };
  const fromObject = objectConfig as { retries: number };

  const recordConfig: Record<string, unknown> = { retries: 3 };
  const fromRecord = recordConfig as Record<string, number>;

  const assertedConfig = ({ retries: 3 } as unknown);
  const fromAssertion = assertedConfig as { retries: number };

  return [fromUnknown, fromUnknownAngle, fromObject, fromRecord, fromAssertion];
}
`,
  });

  assert.deepEqual(
    diagnostics.map(({ filename, line }) => `${filename}:${line}`),
    ["rejected.ts:4", "rejected.ts:5", "rejected.ts:8", "rejected.ts:11", "rejected.ts:14"],
  );
  assert.ok(diagnostics.every(({ code, severity }) => code === ruleCode && severity === "error"));
});

test("no-widen-then-assert allows precise, mutable, boundary, and already-broad flows", (t) => {
  const diagnostics = lintFixtures(t, {
    "allowed.ts": `
type Config = { retries: number };

const preciseConfig = { retries: 3 };
const fromPrecise = preciseConfig as Config;

let mutableConfig: unknown = { retries: 3 };
const fromMutable = mutableConfig as Config;

const externalConfig: unknown = getExternalConfig();
const fromExternal = externalConfig as Config;
const remainsBroad = externalConfig as unknown;

const closedOverConfig: unknown = { retries: 3 };
function narrowAtUseBoundary() {
  return closedOverConfig as Config;
}

function parseBoundary(input: unknown) {
  return input as Config;
}

declare function getExternalConfig(): unknown;
`,
  });

  assert.deepEqual(diagnostics, []);
});

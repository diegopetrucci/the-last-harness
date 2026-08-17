import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const oxlintPath = join(repoRoot, "node_modules/.bin/oxlint");
const oxlintConfigPath = join(repoRoot, ".oxlintrc.json");
const ruleCode = "anti-slop(no-module-mocking)";

function lintFixtures(t, fixtures) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "tlh-no-module-mocking-"));
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

test("no-module-mocking reports imported aliases and globals for supported methods and computed properties", (t) => {
  const diagnostics = lintFixtures(t, {
    "globals.js": `
/* global vi, jest */
vi.doMock("./dependency");
vi.mock("./dependency");
vi.unstable_mockModule("./dependency");
vi["doMock"]("./dependency");
vi["mock"]("./dependency");
vi["unstable_mockModule"]("./dependency");

jest.doMock("./dependency");
jest.mock("./dependency");
jest.unstable_mockModule("./dependency");
jest["doMock"]("./dependency");
jest["mock"]("./dependency");
jest["unstable_mockModule"]("./dependency");
`,
    "imported.ts": `import { vi, vi as vitest } from "vitest";
import { jest, jest as testing } from "@jest/globals";

vi.doMock("./dependency");
vi.mock("./dependency");
vi.unstable_mockModule("./dependency");
vi["doMock"]("./dependency");
vitest.mock("./dependency");
vitest["unstable_mockModule"]("./dependency");

jest.doMock("./dependency");
jest.mock("./dependency");
jest.unstable_mockModule("./dependency");
jest["doMock"]("./dependency");
testing.mock("./dependency");
testing["unstable_mockModule"]("./dependency");
`,
  });

  assert.deepEqual(
    diagnostics.map(({ filename, line }) => `${filename}:${line}`),
    [
      "globals.js:3",
      "globals.js:4",
      "globals.js:5",
      "globals.js:6",
      "globals.js:7",
      "globals.js:8",
      "globals.js:10",
      "globals.js:11",
      "globals.js:12",
      "globals.js:13",
      "globals.js:14",
      "globals.js:15",
      "imported.ts:4",
      "imported.ts:5",
      "imported.ts:6",
      "imported.ts:7",
      "imported.ts:8",
      "imported.ts:9",
      "imported.ts:11",
      "imported.ts:12",
      "imported.ts:13",
      "imported.ts:14",
      "imported.ts:15",
      "imported.ts:16",
    ],
  );
  assert.ok(diagnostics.every(({ code, severity }) => code === ruleCode && severity === "error"));
});

test("no-module-mocking ignores local shadows and non-module mocking APIs", (t) => {
  const diagnostics = lintFixtures(t, {
    "allowed.ts": `import { vi } from "vitest";
import { jest } from "@jest/globals";

const subject = { method() {} };
const value = {};

vi.fn();
vi.spyOn(subject, "method");
vi.mocked(value);
vi.clearAllMocks();
vi.resetAllMocks();
vi.restoreAllMocks();
vi.stubGlobal("dependency", value);
vi.stubEnv("NODE_ENV", "test");

jest.fn();
jest.spyOn(subject, "method");
jest.mocked(value);
jest.clearAllMocks();
jest.resetAllMocks();
jest.restoreAllMocks();
jest.replaceProperty(subject, "method", () => {});
`,
    "shadows.ts": `import { vi as vitest } from "vitest";
import { jest as testing } from "@jest/globals";

function shadowImported(vitest, testing) {
  vitest.mock("./dependency");
  testing["doMock"]("./dependency");
}

function shadowGlobals() {
  const vi = { mock() {}, doMock() {} };
  const jest = { mock() {}, doMock() {} };
  vi.mock("./dependency");
  vi["doMock"]("./dependency");
  jest.mock("./dependency");
  jest["doMock"]("./dependency");
}
`,
  });

  assert.deepEqual(diagnostics, []);
});

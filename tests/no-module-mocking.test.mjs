import assert from "node:assert/strict";
import test from "node:test";

import { lintDiagnosticSummaries } from "./support/lint-fixtures.mjs";

const ruleCode = "anti-slop(no-module-mocking)";

function lintFixtures(t, fixtures) {
  return lintDiagnosticSummaries(t, fixtures, { prefix: "tlh-no-module-mocking-" });
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

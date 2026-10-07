import assert from "node:assert/strict";
import test from "node:test";

import { lintDiagnosticSummaries } from "./support/lint-fixtures.mjs";

const ruleCode = "anti-slop(no-widen-then-assert)";

function lintFixtures(t, fixtures) {
  return lintDiagnosticSummaries(t, fixtures, { prefix: "tlh-no-widen-then-assert-" });
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

declare const externalConfig: unknown;
const fromExternal = externalConfig as Config;
const remainsBroad = externalConfig as unknown;

const closedOverConfig: unknown = { retries: 3 };
function narrowAtUseBoundary() {
  return closedOverConfig as Config;
}

function parseBoundary(input: unknown) {
  return input as Config;
}

`,
  });

  assert.deepEqual(diagnostics, []);
});

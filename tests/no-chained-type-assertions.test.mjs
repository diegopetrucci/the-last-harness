import assert from "node:assert/strict";
import test from "node:test";

import { lintDiagnosticSummaries } from "./support/lint-fixtures.mjs";

const ruleCode = "anti-slop(no-chained-type-assertions)";

function lintFixtures(t, fixtures) {
  return lintDiagnosticSummaries(t, fixtures, { prefix: "tlh-no-chained-type-assertions-" });
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

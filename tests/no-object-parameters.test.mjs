import assert from "node:assert/strict";
import test from "node:test";

import { lintDiagnosticSummaries } from "./support/lint-fixtures.mjs";

const ruleCode = "anti-slop(no-object-parameters)";

function lintFixtures(t, fixtures) {
  return lintDiagnosticSummaries(t, fixtures, { prefix: "tlh-no-object-parameters-" });
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

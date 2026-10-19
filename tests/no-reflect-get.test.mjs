import assert from "node:assert/strict";
import test from "node:test";

import { lintDiagnosticSummaries } from "./support/lint-fixtures.mjs";

const ruleCode = "anti-slop(no-reflect-get)";

function lintFixtures(t, fixtures) {
  return lintDiagnosticSummaries(t, fixtures, { prefix: "tlh-no-reflect-get-" });
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
function shadowedParameter(Reflect: { get(): void }) {
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

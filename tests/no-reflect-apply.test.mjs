import assert from "node:assert/strict";
import test from "node:test";

import { lintDiagnosticSummaries } from "./support/lint-fixtures.mjs";

const ruleCode = "anti-slop(no-reflect-apply)";

function lintFixtures(t, fixtures) {
  return lintDiagnosticSummaries(t, fixtures, { prefix: "tlh-no-reflect-apply-" });
}

test("no-reflect-apply reports global direct and computed calls", (t) => {
  const diagnostics = lintFixtures(t, {
    "global.js": `Reflect.apply(fn, receiver, args);
Reflect["apply"](fn, receiver, args);
Reflect['apply'](fn, receiver, args);
`,
  });

  assert.deepEqual(
    diagnostics.map(({ filename, line }) => `${filename}:${line}`),
    ["global.js:1", "global.js:2", "global.js:3"],
  );
  assert.ok(diagnostics.every(({ code, severity }) => code === ruleCode && severity === "error"));
});

test("no-reflect-apply ignores shadowed Reflect and unrelated calls", (t) => {
  const diagnostics = lintFixtures(t, {
    "allowed.ts": `
function shadowedParameter(Reflect: { apply(): void }) {
  Reflect.apply();
  Reflect["apply"]();
}

function shadowedBinding() {
  const Reflect = { apply() {} };
  Reflect.apply();
  Reflect["apply"]();
}

const localReflect = { apply() {} };
localReflect.apply();
Reflect.construct(Constructor, args);
`,
  });

  assert.deepEqual(diagnostics, []);
});

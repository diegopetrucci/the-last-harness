import assert from "node:assert/strict";
import test from "node:test";

import { lintDiagnosticSummaries } from "./support/lint-fixtures.mjs";

const ruleCode = "anti-slop(no-shape-in-symbol-names)";

function lintFixtures(t, fixtures) {
  return lintDiagnosticSummaries(t, fixtures, { prefix: "tlh-no-shape-in-symbol-names-" });
}

test("no-shape-in-symbol-names rejects case-insensitive identifiers, private identifiers, and JSX identifiers", (t) => {
  const diagnostics = lintFixtures(t, {
    "identifiers.ts": `const responseShape = 1;
const RESPONSESHAPE = 2;
const responseSHape = 3;
`,
    "private-identifiers.ts": `class PrivateMembers {
  #PrivateShape = 1;
  #privateSHAPE() {}
}
`,
    "jsx-identifiers.tsx": `const first = <ShapeWidget />;
const second = <widgetSHAPE />;
const third = <WIDGETshApE />;
`,
  });

  assert.deepEqual(
    diagnostics.map(({ filename, line }) => `${filename}:${line}`),
    [
      "identifiers.ts:1",
      "identifiers.ts:2",
      "identifiers.ts:3",
      "jsx-identifiers.tsx:1",
      "jsx-identifiers.tsx:2",
      "jsx-identifiers.tsx:3",
      "private-identifiers.ts:2",
      "private-identifiers.ts:3",
    ],
  );
  assert.ok(diagnostics.every(({ code, severity }) => code === ruleCode && severity === "error"));
});

test("no-shape-in-symbol-names allows domain-role names", (t) => {
  const diagnostics = lintFixtures(t, {
    "allowed.tsx": `interface OwnerProfile {
  ownerId: string;
}

type RouteRecord = {
  routeId: string;
};

class SessionRegistry {
  #currentOwner = "owner";

  currentRole(): string {
    return this.#currentOwner;
  }
}

const OwnerBadge = ({ owner }: { owner: OwnerProfile }) => <OwnerBadgeView owner={owner} />;
const route: RouteRecord = { routeId: "route-1" };
const registry = new SessionRegistry();
`,
  });

  assert.deepEqual(diagnostics, []);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const oxlintPath = join(repoRoot, "node_modules/.bin/oxlint");
const oxlintConfigPath = join(repoRoot, ".oxlintrc.json");
const ruleCode = "anti-slop(no-shape-in-symbol-names)";

function lintFixtures(t, fixtures) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "tlh-no-shape-in-symbol-names-"));
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

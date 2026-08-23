import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const oxlintPath = join(repoRoot, "node_modules/.bin/oxlint");
const oxlintConfigPath = join(repoRoot, ".oxlintrc.json");
const ruleCode = "anti-slop(no-unknown-returns)";

function lintFixtures(t, fixtures) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "tlh-no-unknown-returns-"));
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
    .filter((diagnostic) => diagnostic.code === ruleCode)
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

test("no-unknown-returns rejects unknown contracts across supported signatures", (t) => {
  const diagnostics = lintFixtures(t, {
    "alias.ts": `
      type UnknownAlias = unknown;
      function alias(): UnknownAlias {
        return undefined;
      }
    `,
    "arrow-callback.ts": `
      const callback = (value: string): unknown => value;
    `,
    "call-signature.ts": `
      interface Callable {
        (value: string): unknown;
      }
    `,
    "construct-signature.ts": `
      interface Constructable {
        new (value: string): unknown;
      }
    `,
    "constructor-type.ts": `
      type Factory = new (value: string) => unknown;
    `,
    "declare-function.ts": `
      declare function declaredUnknown(): unknown;
    `,
    "direct.ts": `
      function direct(): unknown {
        return undefined;
      }
    `,
    "function-expression.ts": `
      const expression = function (): unknown {
        return undefined;
      };
    `,
    "function-type.ts": `
      type Callback = (value: string) => unknown;
    `,
    "method.ts": `
      interface Contract {
        method(value: string): unknown;
      }
    `,
    "parenthesized.ts": `
      function parenthesized(): (unknown) {
        return undefined;
      }
    `,
    "promise-like.ts": `
      function promiseLike(): PromiseLike<unknown> {
        return Promise.resolve(undefined);
      }
    `,
    "promise.ts": `
      function promise(): Promise<unknown> {
        return Promise.resolve(undefined);
      }
    `,
    "union.ts": `
      type UnknownUnion = string | unknown;
      function union(): UnknownUnion {
        return undefined;
      }
    `,
  });

  assert.deepEqual(
    diagnostics.map(({ filename }) => filename),
    [
      "alias.ts",
      "arrow-callback.ts",
      "call-signature.ts",
      "construct-signature.ts",
      "constructor-type.ts",
      "declare-function.ts",
      "direct.ts",
      "function-expression.ts",
      "function-type.ts",
      "method.ts",
      "parenthesized.ts",
      "promise-like.ts",
      "promise.ts",
      "union.ts",
    ],
  );
  assert.ok(diagnostics.every(({ code, severity }) => code === ruleCode && severity === "error"));
});

test("no-unknown-returns allows named domain and parsed boundary contracts", (t) => {
  const diagnostics = lintFixtures(t, {
    "allowed.ts": `
      type Domain = { kind: "domain"; value: string };
      type DomainCallback = (value: Domain) => void;

      interface DomainApi {
        parse(input: unknown): Domain;
        load(input: unknown): Promise<Domain>;
        watch(callback: DomainCallback): void;
      }

      function parseDomain(input: unknown): Domain {
        if (typeof input !== "string") throw new Error("expected a domain value");
        return { kind: "domain", value: input };
      }

      function loadDomain(input: unknown): Promise<Domain> {
        return Promise.resolve(parseDomain(input));
      }

      function loadDomainLike(input: unknown): PromiseLike<Domain> {
        return Promise.resolve(parseDomain(input));
      }

      const notifyDomain = (callback: DomainCallback): void => {
        callback(parseDomain("ready"));
      };

      const callback: (value: Domain) => void = (value) => {
        void value;
      };
    `,
  });

  assert.deepEqual(diagnostics, []);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const oxlintPath = join(repoRoot, "node_modules/.bin/oxlint");
const oxlintConfigPath = join(repoRoot, ".oxlintrc.json");

function lintFixtures(t, fixtures) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "tlh-no-unknown-type-aliases-"));
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
  return report.diagnostics.map((diagnostic) => ({
    alias: diagnostic.message.match(/`([^`]+)`/)?.[1],
    filename: basename(diagnostic.filename),
  }));
}

function lintFixture(t, source) {
  return lintFixtures(t, { "fixture.ts": source }).map(({ alias }) => alias);
}

test("no-unknown-type-aliases reports direct and chained aliases in nested scopes", (t) => {
  const aliases = lintFixture(
    t,
    `
      type ProgramDirect = unknown;
      type ProgramForward = ProgramForwardSource;
      type ProgramForwardSource = unknown;
      type ProgramReverseSource = unknown;
      type ProgramReverse = ProgramReverseSource;

      function nested() {
        type FunctionDirect = unknown;
        type FunctionForward = FunctionForwardSource;
        type FunctionForwardSource = unknown;

        {
          type BlockDirect = unknown;
          type BlockForward = BlockForwardSource;
          type BlockForwardSource = unknown;
        }
      }

      namespace Namespaced {
        type NamespaceDirect = unknown;
        type NamespaceForward = NamespaceForwardSource;
        type NamespaceForwardSource = unknown;
      }

      namespace Reopened {
        export type ReopenedSource = unknown;
      }

      namespace Reopened {
        export type ThroughReopened = ReopenedSource;
      }
    `,
  );

  assert.deepEqual(aliases, [
    "ProgramDirect",
    "ProgramForward",
    "ProgramForwardSource",
    "ProgramReverseSource",
    "ProgramReverse",
    "FunctionDirect",
    "FunctionForward",
    "FunctionForwardSource",
    "BlockDirect",
    "BlockForward",
    "BlockForwardSource",
    "NamespaceDirect",
    "NamespaceForward",
    "NamespaceForwardSource",
    "ReopenedSource",
    "ThroughReopened",
  ]);
});

test("no-unknown-type-aliases gives nested private unknown aliases precedence over merged exports", (t) => {
  const aliases = lintFixture(
    t,
    `
      namespace PrivateUnknownOwner {
        type PrivateUnknown = unknown;
        namespace Nested {
          type ThroughPrivateUnknown = PrivateUnknown;
        }
      }
      namespace PrivateUnknownOwner {
        export type PrivateUnknown = string;
      }
    `,
  );

  assert.deepEqual(aliases, ["PrivateUnknown", "ThroughPrivateUnknown"]);
});

test("no-unknown-type-aliases gives nested private string aliases precedence over merged unknown exports", (t) => {
  const aliases = lintFixture(
    t,
    `
      namespace PrivateStringOwner {
        type PrivateString = string;
        namespace Nested {
          type ThroughPrivateString = PrivateString;
        }
      }
      namespace PrivateStringOwner {
        export type PrivateString = unknown;
      }
    `,
  );

  assert.deepEqual(aliases, ["PrivateString"]);
});

test("no-unknown-type-aliases keeps reopened namespace private aliases declaration-local", (t) => {
  const aliases = lintFixture(
    t,
    `
      namespace ReopenedLocal {
        type Local = unknown;
        type ThroughUnknownLocal = Local;
      }
      namespace ReopenedLocal {
        type Local = string;
        type ThroughStringLocal = Local;
      }
    `,
  );

  assert.deepEqual(aliases, ["Local", "ThroughUnknownLocal"]);
});

test("no-unknown-type-aliases merges exported type-space shadows across namespaces", (t) => {
  const aliases = lintFixture(
    t,
    `
      type Shared = unknown;
      namespace Merged {
        export interface Shared {}
      }
      namespace Merged {
        export type ThroughMergedInterface = Shared;
      }

      type ClassShared = unknown;
      namespace ClassMerged {
        export class ClassShared {}
      }
      namespace ClassMerged {
        export type ThroughMergedClass = ClassShared;
      }

      type EnumShared = unknown;
      namespace EnumMerged {
        export enum EnumShared {}
      }
      namespace EnumMerged {
        export type ThroughMergedEnum = EnumShared;
      }

      namespace ImportSource {
        export type Imported = string;
      }
      type ImportShared = unknown;
      namespace ImportMerged {
        export import ImportShared = ImportSource.Imported;
      }
      namespace ImportMerged {
        export type ThroughMergedImport = ImportShared;
      }
    `,
  );

  assert.deepEqual(aliases, ["Shared", "ClassShared", "EnumShared", "ImportShared"]);
});

test("no-unknown-type-aliases treats ambient namespace members as exported", (t) => {
  const aliases = lintFixture(
    t,
    `
      declare namespace Ambient {
        type Source = unknown;
      }
      declare namespace Ambient {
        type ThroughAmbient = Source;
      }
    `,
  );

  assert.deepEqual(aliases, ["Source", "ThroughAmbient"]);
});

test("no-unknown-type-aliases inherits ambient exports into nested namespaces", (t) => {
  const aliases = lintFixture(
    t,
    `
      declare namespace Outer {
        namespace Inner {
          type NestedSource = unknown;
        }
      }
      declare namespace Outer {
        namespace Inner {
          type ThroughNested = NestedSource;
        }
      }
    `,
  );

  assert.deepEqual(aliases, ["NestedSource", "ThroughNested"]);
});

test("no-unknown-type-aliases merges quoted ambient module names semantically", (t) => {
  const aliases = lintFixture(
    t,
    `
      declare module "quoted" {
        type Source = unknown;
      }
      declare module 'quoted' {
        type ThroughQuoted = Source;
      }
    `,
  );

  assert.deepEqual(aliases, ["Source", "ThroughQuoted"]);
});

test("no-unknown-type-aliases merges dotted and nested namespaces", (t) => {
  const aliases = lintFixture(
    t,
    `
      namespace A.B {
        export type DottedSource = unknown;
      }
      namespace A {
        export namespace B {
          export type ThroughNested = DottedSource;
        }
      }

      namespace DottedParent {
        export type DottedParentSource = unknown;
      }
      namespace DottedParent.Child {
        export type DottedParentThrough = DottedParentSource;
      }
      namespace NestedParent {
        export type NestedParentSource = unknown;
        export namespace Child {
          export type NestedParentThrough = NestedParentSource;
        }
      }

      type DottedShadowSource = unknown;
      namespace DottedShadow.Child {
        export type DottedShadowThrough = DottedShadowSource;
      }
      namespace DottedShadow {
        export interface DottedShadowSource {}
      }
      type NestedShadowSource = unknown;
      namespace NestedShadow {
        export interface NestedShadowSource {}
        export namespace Child {
          export type NestedShadowThrough = NestedShadowSource;
        }
      }
    `,
  );

  assert.deepEqual(aliases, [
    "DottedSource",
    "ThroughNested",
    "DottedParentSource",
    "DottedParentThrough",
    "NestedParentSource",
    "NestedParentThrough",
    "DottedShadowSource",
    "NestedShadowSource",
  ]);
});

test("no-unknown-type-aliases treats namespace import equals as a type-space shadow", (t) => {
  const aliases = lintFixture(
    t,
    `
      type Shared = unknown;
      namespace Types {
        export type Shared = string;
      }
      namespace Consumer {
        import Shared = Types.Shared;
        export type ThroughImportedType = Shared;
      }
    `,
  );

  assert.deepEqual(aliases, ["Shared"]);
});

test("no-unknown-type-aliases resets alias state between files", (t) => {
  const diagnostics = lintFixtures(t, {
    "first.ts": "type Shared = unknown;\n",
    "second.ts": "type ThroughOtherFile = Shared;\n",
  });

  assert.deepEqual(diagnostics, [{ alias: "Shared", filename: "first.ts" }]);
});

test("no-unknown-type-aliases isolates shadowed and sibling aliases", (t) => {
  const aliases = lintFixture(
    t,
    `
      type Shared = unknown;
      type UsesShared = Shared;

      function shadowedByString() {
        type Shared = string;
        type UsesStringShadow = Shared;
      }

      function inheritsShared() {
        type UsesInheritedShared = Shared;
      }

      function shadowsWithTypeParameter<Shared>() {
        type UsesTypeParameter = Shared;
      }

      {
        type Sibling = unknown;
        type UsesUnknownSibling = Sibling;
      }

      {
        type Sibling = string;
        type UsesStringSibling = Sibling;
      }
    `,
  );

  assert.deepEqual(aliases, [
    "Shared",
    "UsesShared",
    "UsesInheritedShared",
    "Sibling",
    "UsesUnknownSibling",
  ]);
});

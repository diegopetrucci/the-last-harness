/**
 * Regression tests for scripts/check-lazy-import-boundaries.mjs.
 *
 * Each test creates a temporary fixture extensions directory, writes the
 * relevant .js files, runs the checker against it, and asserts on exit code
 * and output. Fixtures deliberately have no package.json so --extensions-dir
 * falls back to the filename-heuristic entry discovery path.
 *
 * Cases covered:
 *  - Multiline dynamic import whose lazy target has a bare specifier → FAIL
 *  - Nested lazy boundary (outer -> inner -> bare specifier) → FAIL
 *  - Computed and identifier-bound new URL targets → FAIL
 *  - Declared runtime dependency allowed; peer/dev-only imports → FAIL
 *  - No false positive: import-looking text inside a comment → PASS
 *  - No false positive: import-looking text inside a template string → PASS
 *  - Clean fixture (no violations) → PASS
 *  - In-repo fixture is analysed as itself, not replaced by the repo tree → FAIL (violation in fixture)
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test, { after, before } from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const checkerScript = join(repoRoot, "scripts", "check-lazy-import-boundaries.mjs");

/** Directories created during this run, to be removed on teardown. */
const tempDirs = [];

/**
 * Create a temporary directory and populate it with the given files.
 * `files` is an object mapping relative paths → file content strings.
 * Returns the absolute path to the root directory.
 */
function makeTempDir(files, rootOverride) {
  const base = rootOverride ?? tmpdir();
  const dir = mkdtempSync(join(base, "tlh-lazy-boundary-test-"));
  tempDirs.push(dir);
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(dir, relPath);
    mkdirSync(resolve(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return dir;
}

/**
 * Run the checker against `extensionsDir` and return { status, stdout, stderr }.
 */
function runChecker(extensionsDir) {
  const result = spawnSync(process.execPath, [checkerScript, "--extensions-dir", extensionsDir], {
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ---------------------------------------------------------------------------
// Teardown: remove temp dirs created during this run AND any pre-existing
// stray dirs from previous runs that were never cleaned up.
// ---------------------------------------------------------------------------

before(() => {
  // Clean up any stray directories from previous test runs.
  const TMPDIR = tmpdir();
  let strays;
  try {
    strays = readdirSync(TMPDIR).filter((name) => name.startsWith("tlh-lazy-boundary-test-"));
  } catch {
    strays = [];
  }
  for (const name of strays) {
    try {
      rmSync(join(TMPDIR, name), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// ---------------------------------------------------------------------------
// Fixture: clean (no violations) — baseline sanity check
// ---------------------------------------------------------------------------

test("clean fixture: no violations, exits 0", () => {
  const dir = makeTempDir({
    "entry.js": `
import "./helper.js";
const lazyA = () => import("./sub/lazyClean.js");
`,
    "helper.js": `
import { readFileSync } from "node:fs";
export function readFile(p) { return readFileSync(p, "utf8"); }
`,
    "sub/lazyClean.js": `
import { readFileSync } from "node:fs";
export function run() { return readFileSync("/tmp/x", "utf8"); }
`,
  });

  const { status, stdout } = runChecker(dir);
  assert.equal(status, 0, `expected exit 0, got ${status}`);
  assert.match(stdout, /OK/, "expected OK in stdout");
});

// ---------------------------------------------------------------------------
// Fixture: multiline dynamic import whose lazy target has a bare specifier
// ---------------------------------------------------------------------------

test("multiline dynamic import with bare specifier in lazy target: exits 1", () => {
  const dir = makeTempDir({
    // Entry uses a multiline dynamic import (spread across lines)
    "entry.js": `
const lazyA = () => import(
    "./sub/lazyMultiline.js"
);
`,
    // The lazy target statically imports a bare specifier
    "sub/lazyMultiline.js": `
import "@earendil-works/pi-coding-agent";
export function run() {}
`,
  });

  const { status, stderr } = runChecker(dir);
  assert.equal(status, 1, `expected exit 1 (violation), got ${status}; stderr: ${stderr}`);
  assert.match(stderr, /bare specifier/i, `expected "bare specifier" in stderr; got: ${stderr}`);
  assert.match(
    stderr,
    /@earendil-works\/pi-coding-agent/,
    `expected the bare specifier name in stderr; got: ${stderr}`,
  );
});

// ---------------------------------------------------------------------------
// Fixture: nested lazy boundary — outer lazy → inner lazy → bare specifier
//
// The entry dynamically imports sub/outer.js. sub/outer.js in turn
// dynamically imports ./inner.js (sub/inner.js). sub/inner.js statically
// imports a bare specifier.
//
// Both nested files live under sub/ so filename-heuristic discovery
// cannot promote them to entries; only entry.js is an entry. Detection
// therefore requires transitively following nested lazy boundaries — if that
// traversal is removed the checker cannot reach sub/inner.js and the test
// would pass incorrectly (exit 0 instead of exit 1).
// ---------------------------------------------------------------------------

test("nested lazy boundary with bare specifier in inner lazy target: exits 1", () => {
  const dir = makeTempDir({
    // Top-level entry — the only file discovered as an entry.
    "entry.js": `
const lazyOuter = () => import("./sub/outer.js");
`,
    // sub/outer.js — lazy target; itself has a nested lazy boundary.
    "sub/outer.js": `
export function loadInner() {
  return import("./inner.js");
}
`,
    // sub/inner.js — nested lazy target with a bare specifier.
    "sub/inner.js": `
import "@earendil-works/pi-coding-agent";
export function run() {}
`,
  });

  const { status, stderr } = runChecker(dir);
  assert.equal(status, 1, `expected exit 1 (violation), got ${status}; stderr: ${stderr}`);
  assert.match(stderr, /bare specifier/i, `expected "bare specifier" in stderr; got: ${stderr}`);
  assert.match(
    stderr,
    /@earendil-works\/pi-coding-agent/,
    `expected the bare specifier name in stderr; got: ${stderr}`,
  );
});

// ---------------------------------------------------------------------------
// Fixtures: statically computed file URLs must be followed
// ---------------------------------------------------------------------------

test("computed new URL dynamic target with an inline expression: exits 1", () => {
  const dir = makeTempDir({
    "entry.js": `
const lazy = () => import(new URL(["./sub", "computed.js"].join("/"), import.meta.url).href);
`,
    "sub/computed.js": `
import "@earendil-works/pi-coding-agent";
export function run() {}
`,
  });

  const { status, stderr } = runChecker(dir);
  assert.equal(status, 1, `expected exit 1 (violation), got ${status}; stderr: ${stderr}`);
  assert.match(stderr, /computed\.js/, `expected computed URL target in stderr; got: ${stderr}`);
  assert.match(stderr, /bare specifier/i, `expected bare-specifier violation; got: ${stderr}`);
});

test("identifier-bound new URL dynamic target: exits 1", () => {
  const dir = makeTempDir({
    "entry.js": `
const targetUrl = new URL(["./sub", "identifier-bound.js"].join("/"), import.meta.url);
const lazy = () => import(targetUrl.href);
`,
    "sub/identifier-bound.js": `
import "@earendil-works/pi-coding-agent";
export function run() {}
`,
  });

  const { status, stderr } = runChecker(dir);
  assert.equal(status, 1, `expected exit 1 (violation), got ${status}; stderr: ${stderr}`);
  assert.match(
    stderr,
    /identifier-bound\.js/,
    `expected identifier-bound URL target in stderr; got: ${stderr}`,
  );
  assert.match(stderr, /bare specifier/i, `expected bare-specifier violation; got: ${stderr}`);
});

// ---------------------------------------------------------------------------
// Fixtures: only declared runtime dependencies are allowed in native graphs
// ---------------------------------------------------------------------------

test("declared runtime dependency is allowed but peer/dev-only imports fail", () => {
  const dir = makeTempDir({
    "package.json": JSON.stringify({
      dependencies: { "declared-runtime": "1.0.0" },
      peerDependencies: { "peer-only": "1.0.0" },
      devDependencies: { "dev-only": "1.0.0" },
    }),
    "entry.js": `const lazy = () => import("./sub/declared.js");`,
    "sub/declared.js": `
import "declared-runtime/subpath";
import "peer-only";
import "dev-only";
export function run() {}
`,
  });

  const { status, stderr } = runChecker(dir);
  assert.equal(status, 1, `expected peer/dev violations, got ${status}; stderr: ${stderr}`);
  assert.match(stderr, /peer-only/, `expected peer-only violation; got: ${stderr}`);
  assert.match(stderr, /dev-only/, `expected dev-only violation; got: ${stderr}`);
  assert.doesNotMatch(stderr, /declared-runtime/, "declared runtime dependency must be allowed");
});

// ---------------------------------------------------------------------------
// Fixture: import-looking text inside a comment — should NOT false-positive
// ---------------------------------------------------------------------------

test("import-looking text inside a comment: exits 0, no false positive", () => {
  const dir = makeTempDir({
    "entry.js": `
// This is just a comment: import("./imaginary.js")
/* Another comment: import("./also-imaginary.js") */
export function noop() {}
`,
  });

  const { status, stdout } = runChecker(dir);
  assert.equal(status, 0, `expected exit 0, got ${status}`);
  assert.match(stdout, /OK/, "expected OK in stdout");
});

// ---------------------------------------------------------------------------
// Fixture: import-looking text inside a template string — should NOT false-positive
// ---------------------------------------------------------------------------

test("import-looking text inside a template string: exits 0, no false positive", () => {
  const dir = makeTempDir({
    "entry.js": `
const msg = \`The syntax is import("./something.js") but we are not actually importing\`;
export { msg };
`,
  });

  const { status, stdout } = runChecker(dir);
  assert.equal(status, 0, `expected exit 0, got ${status}`);
  assert.match(stdout, /OK/, "expected OK in stdout");
});

// ---------------------------------------------------------------------------
// Regression: fixture placed INSIDE the repo is analysed as itself.
//
// Before the fix, tryReadPiExtensions would walk up from the fixture dir,
// find the repo's package.json with pi.extensions, and analyse the repo's
// own extensions tree instead of the fixture. Two symptoms:
//   1. Output paths contained "../extensions/the-last-harness.js" (wrong tree).
//   2. The allowlist path became "../extensions/the-last-harness/common.js"
//      which doesn't match "the-last-harness/common.js", so common.js was
//      spuriously reported as a shared-module violation.
//
// The fix: manifest entries are only accepted if they are children of
// extensionsDir. If they aren't, heuristic discovery is used instead.
// ---------------------------------------------------------------------------

test("in-repo fixture is analysed as itself, not replaced by the repo tree", () => {
  // Place the fixture INSIDE the repo so the repo's package.json is above it.
  const dir = makeTempDir(
    {
      "entry.js": `const l = () => import("./bad.js");`,
      "bad.js": `import "@earendil-works/pi-coding-agent";\nexport function run() {}\n`,
    },
    repoRoot,
  );

  const { status, stderr } = runChecker(dir);

  // Should detect the violation in our fixture file.
  assert.equal(status, 1, `expected exit 1 (fixture violation), got ${status}; stderr: ${stderr}`);
  assert.match(stderr, /bad\.js/, `expected "bad.js" in stderr (fixture file); got: ${stderr}`);
  assert.match(stderr, /bare specifier/i, `expected "bare specifier" in stderr; got: ${stderr}`);

  // Must NOT report the repo's own extension files.
  assert.doesNotMatch(stderr, /the-last-harness\.js/, `must not analyse repo tree; got: ${stderr}`);

  // common.js must NOT be spuriously reported as a shared-module violation.
  // Before the fix the allowlist relative path was wrong and common.js was flagged.
  assert.doesNotMatch(
    stderr,
    /common\.js.*shared module|shared module.*common\.js/i,
    `common.js must not be a spurious violation; got: ${stderr}`,
  );
});

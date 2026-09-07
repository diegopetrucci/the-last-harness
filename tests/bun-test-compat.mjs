/**
 * Bun-only compatibility preload for the alternate test runner.
 *
 * This file is intentionally test-only. It mirrors the small compatibility
 * seams provided by the Node test loader without changing the shipped runtime:
 * - use the child HOME for Bun's eagerly cached os.homedir;
 * - keep Node as the executable for tests that spawn the shipped runtime; and
 * - preserve the default node:fs shape for tests that replace fs methods.
 *
 * Bun has no parent-aware resolve hook equivalent to Node's test loader. The
 * Bun-specific mock.module calls below are therefore an explicit runner-
 * compatibility exception to the repository's no-module-mocking policy: they
 * adapt Bun's built-in modules in this preload only, rather than replacing a
 * dependency in a test or in shipped runtime code. Bun deliberately leaves
 * pi-tui and pi-coding-agent real; the canonical Node loader's importer-scoped
 * render.ts component shim is documented in VALIDATING.md and is not global.
 */

import { mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";

const nodeExecutable = process.env.TLH_TEST_NODE_EXEC_PATH?.trim();
if (!nodeExecutable) {
  throw new Error(
    "Bun test compatibility preload requires TLH_TEST_NODE_EXEC_PATH so product subprocesses use Node",
  );
}
process.execPath = nodeExecutable;

const originalOs = { ...os };
const initialHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || "/tmp";
const mockedOs = {
  ...originalOs,
  homedir: () => process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || initialHome,
};
mock.module("node:os", () => ({ ...mockedOs, default: mockedOs }));

// Keep the default node:fs shape available to both ESM default imports and
// tests that replace CJS fs methods after this preload has run. In particular,
// readdirSync must delegate at call time: Bun's cloned mock namespace does not
// receive syncBuiltinESMExports updates made by a test.
const nativeFs = fs;
const nativeReaddirSync = nativeFs.readdirSync;
const mockedFs = { ...nativeFs };
mockedFs.readdirSync = (...args) => {
  const currentReaddirSync = nativeFs.readdirSync;
  const readdirSync =
    currentReaddirSync === mockedFs.readdirSync ? nativeReaddirSync : currentReaddirSync;
  return readdirSync.call(nativeFs, ...args);
};
mock.module("node:fs", () => ({ ...mockedFs, default: mockedFs }));

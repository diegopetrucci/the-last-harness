import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildChildEnv,
  discoverSuiteFiles,
  parseTapSummary,
  repoRoot,
  validateTapSummary,
} from "../scripts/run-subagents-tests.mjs";

const runnerPath = join(repoRoot, "scripts/run-subagents-tests.mjs");

function tapSummary(overrides = {}) {
  const values = {
    tests: 1,
    pass: 1,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    ...overrides,
  };
  return [
    "TAP version 13",
    "1..1",
    ...Object.entries(values).map(([name, value]) => `# ${name} ${value}`),
    "# duration_ms 1",
  ].join("\n");
}

test("subagents runner resolves its suite and loader outside the repository cwd", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "tlh-subagents-runner-cwd-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [runnerPath, "e2e"], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^subagents e2e: 1\/1 passed \(1 file\)\s*$/);
  assert.equal(result.stderr, "");
});

test("subagents runner rejects missing and zero-file suites before spawning Node", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tlh-subagents-runner-files-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => discoverSuiteFiles("unit", { directory: join(root, "missing"), minimumFiles: 93 }),
    /Could not read unit test directory/,
  );
  const emptyDir = join(root, "empty");
  mkdirSync(emptyDir);
  assert.throws(
    () => discoverSuiteFiles("unit", { directory: emptyDir, minimumFiles: 93 }),
    /unit suite found 0 test files; expected at least 93/,
  );
});

test("subagents runner buildChildEnv strips PI_SUBAGENT keys and scales timeouts in CI", () => {
  const base = {
    PI_SUBAGENT_SOMETHING: "should-be-removed",
    PI_SUBAGENTS_EXTRA: "also-removed",
    KEEP: "preserved",
    NODE_TEST_CONTEXT: "cleared",
  };

  // Without CI: no scaling, PI keys stripped.
  const envNoCI = buildChildEnv(base, "/tmp/agent-dir");
  assert.equal(envNoCI.TLH_TEST_TIMEOUT_SCALE, undefined, "scale must be absent without CI");
  assert.equal(envNoCI.PI_SUBAGENT_SOMETHING, undefined, "PI_SUBAGENT_* must be stripped");
  assert.equal(envNoCI.PI_SUBAGENTS_EXTRA, undefined, "PI_SUBAGENTS_* must be stripped");
  assert.equal(envNoCI.NODE_TEST_CONTEXT, undefined, "NODE_TEST_CONTEXT must be cleared");
  assert.equal(envNoCI.KEEP, "preserved", "unrelated keys must be preserved");
  assert.equal(envNoCI.PI_CODING_AGENT_DIR, "/tmp/agent-dir");

  // With CI: scale factor of 3 is injected.
  const envCI = buildChildEnv({ ...base, CI: "1" }, "/tmp/agent-dir");
  assert.equal(envCI.TLH_TEST_TIMEOUT_SCALE, "3", "scale must be 3 when CI is set");
  assert.equal(envCI.CI, "1", "CI must be preserved");
});

test("subagents runner rejects skipped TAP and enforces full-run versus shard floors", () => {
  const skipped = parseTapSummary(tapSummary({ pass: 0, skipped: 1 }));
  assert.throws(
    () => validateTapSummary("unit", skipped, { sharded: true, minimumTests: 1_147 }),
    /unit suite reported skipped=1/,
  );

  const onePassing = parseTapSummary(tapSummary());
  assert.throws(
    () => validateTapSummary("unit", onePassing, { sharded: false, minimumTests: 1_147 }),
    /unit suite executed 1 tests; expected at least 1147/,
  );
  assert.doesNotThrow(() =>
    validateTapSummary("unit", onePassing, { sharded: true, minimumTests: 1_147 }),
  );
});

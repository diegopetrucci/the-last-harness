import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildBunChildEnv,
  bunArgs,
  bunSuiteConfigs,
  DEFAULT_BUN_PARALLEL,
  discoverBunSuiteFiles,
  main as runBunTests,
  normalizeBunOptions,
  parseBunSummary,
  REQUIRED_BUN_VERSION,
  validateBunSummary,
} from "../scripts/run-bun-tests.mjs";
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

function bunSummary(overrides = {}) {
  return {
    tests: 4,
    files: 2,
    pass: 4,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    ...overrides,
  };
}

function bunOutput(overrides = {}) {
  const summary = bunSummary(overrides);
  return [
    "bun test v1.4.0",
    `${summary.pass} pass`,
    `${summary.fail} fail`,
    `${summary.cancelled} cancelled`,
    `${summary.skipped} skip`,
    `${summary.todo} todo`,
    `Ran ${summary.tests} tests across ${summary.files} files. [1.00ms]`,
  ].join("\n");
}

test("Bun runner discovers nested root test files and applies a file floor", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tlh-bun-runner-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "nested"), { recursive: true });
  const first = join(root, "nested", "first.test.mjs");
  const second = join(root, "second.test.mjs");
  writeFileSync(first, "");
  writeFileSync(second, "");

  assert.deepEqual(discoverBunSuiteFiles("root", { directory: root, minimumFiles: 2 }), [
    first,
    second,
  ]);
  assert.throws(
    () => discoverBunSuiteFiles("root", { directory: root, minimumFiles: 3 }),
    /root suite found 2 test files; expected at least 3/,
  );
  assert.equal(bunSuiteConfigs.root.minimumFiles, 145);
});

test("Bun runner parses pass, failure, cancellation, skip, todo, and file counts", () => {
  assert.deepEqual(parseBunSummary(bunOutput()), bunSummary());
  assert.deepEqual(
    parseBunSummary(
      [
        "1 pass",
        "1 failures",
        "1 canceled",
        "1 skipped",
        "1 todos",
        "Ran 5 tests across 1 file.",
      ].join("\n"),
    ),
    {
      tests: 5,
      files: 1,
      pass: 1,
      fail: 1,
      cancelled: 1,
      skipped: 1,
      todo: 1,
    },
  );
});

test("Bun summary parsing uses only the final summary block", () => {
  const summary = parseBunSummary(
    [
      "fixture output: 1 pass",
      "1 pass",
      "Ran 1 test across 1 file.",
      "fixture output after an earlier summary",
      "3 pass",
      "0 fail",
      "0 cancelled",
      "0 skip",
      "0 todo",
      "Ran 3 tests across 1 file. [1.00ms]",
    ].join("\n"),
  );
  assert.deepEqual(summary, bunSummary({ tests: 3, files: 1, pass: 3 }));
  assert.throws(
    () => parseBunSummary(`${bunOutput()}\ntrailing output`),
    /final non-empty output block/,
  );
});

test("Bun runner rejects empty arguments and pins its required version", () => {
  assert.equal(REQUIRED_BUN_VERSION, "1.4.0");
  const messages = [];
  const originalConsoleError = console.error;
  console.error = (...args) => messages.push(args.join(" "));
  try {
    assert.equal(runBunTests([""]), 2);
    assert.equal(runBunTests(["e2e", ""]), 2);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(messages.length, 2);
});

test("Bun runner rejects every non-pass outcome and enforces full-run floors", () => {
  for (const field of ["fail", "cancelled", "skipped", "todo"]) {
    const summary = bunSummary({ [field]: 1, pass: 3 });
    assert.throws(
      () => validateBunSummary("unit", summary, { minimumFiles: 1, minimumTests: 1 }),
      new RegExp(`unit suite reported ${field}=1`),
    );
  }

  assert.throws(
    () =>
      validateBunSummary("unit", bunSummary({ tests: 1, pass: 1, files: 1 }), {
        minimumFiles: 2,
        minimumTests: 4,
      }),
    /unit suite reported 1 files; expected at least 2/,
  );
  assert.throws(
    () =>
      validateBunSummary("unit", bunSummary({ tests: 1, pass: 1, files: 2 }), {
        minimumFiles: 1,
        minimumTests: 4,
      }),
    /unit suite executed 1 tests; expected at least 4/,
  );
  assert.doesNotThrow(() =>
    validateBunSummary("unit", bunSummary({ tests: 1, pass: 1, files: 1 }), {
      sharded: true,
      minimumFiles: 2,
      minimumTests: 4,
    }),
  );
});

test("Bun runner builds an isolated child environment with explicit Node", () => {
  const env = buildBunChildEnv(
    {
      HOME: "/human-home",
      PI_SUBAGENT_CHILD: "1",
      PI_SUBAGENTS_TEMP_ROOT: "/shared-root",
      NODE_TEST_CONTEXT: "test",
    },
    "/tmp/bun-agent",
    "/tmp/bun-runner",
  );
  assert.equal(env.HOME, "/tmp/bun-runner/home");
  assert.equal(env.TMPDIR, "/tmp/bun-runner/tmp");
  assert.equal(env.PI_CODING_AGENT_DIR, "/tmp/bun-agent");
  assert.equal(env.PI_SUBAGENT_CHILD, undefined);
  assert.equal(env.PI_SUBAGENTS_TEMP_ROOT, undefined);
  assert.equal(env.NODE_TEST_CONTEXT, undefined);
  assert.equal(env.TLH_TEST_NODE_EXEC_PATH, process.execPath);
});

test("Bun runner forwards exactly one worker count to every suite and keeps one as default", () => {
  assert.equal(DEFAULT_BUN_PARALLEL, 1);
  const files = ["/tmp/first.test.mjs"];
  const workerFlags = (args) =>
    args.filter((option) => option === "--parallel" || option.startsWith("--parallel="));

  assert.deepEqual(workerFlags(bunArgs(files)), ["--parallel=1"]);
  for (const suite of ["root", "unit", "integration", "e2e"]) {
    const args = bunArgs([`/tmp/${suite}.test.mjs`], ["--parallel=9", "--shard=1/2"]);
    assert.deepEqual(workerFlags(args), ["--parallel=9"], `${suite} worker count`);
    assert.ok(args.includes("--shard=1/2"), `${suite} options must be preserved`);
  }

  assert.deepEqual(normalizeBunOptions(["--parallel=9", "--timeout=1000"]), {
    options: ["--timeout=1000"],
    parallel: 9,
  });
});

test("Bun runner rejects invalid or conflicting worker counts and disabled isolation", () => {
  for (const option of [
    "--parallel",
    "--parallel=",
    "--parallel=0",
    "--parallel=-1",
    "--parallel=1.5",
    "--parallel=not-a-number",
    "--parallel=9007199254740992",
  ]) {
    assert.throws(() => normalizeBunOptions([option]), /positive integer|explicit value/);
  }

  for (const options of [
    ["--parallel=9", "--parallel=9"],
    ["--parallel=9", "--parallel=10"],
    ["--parallel=9", "--parallel"],
  ]) {
    assert.throws(() => normalizeBunOptions(options), /specified more than once|explicit value/);
  }

  assert.throws(
    () => normalizeBunOptions(["--parallel=9", "--no-isolate"]),
    /--no-isolate is not supported/,
  );
  assert.throws(
    () => normalizeBunOptions(["--parallel=9", "--no-isolate=true"]),
    /--no-isolate is not supported/,
  );
});

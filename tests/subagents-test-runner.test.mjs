import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  buildChildEnv,
  buildTestCommandArgs,
  countNamePatternExcludedFiles,
  discoverSuiteFiles,
  findInheritedSelectionFilter,
  parseRunnerOptions,
  parseTapSummary,
  repoRoot,
  selectedNamePatternSummary,
  validateTapSummary,
} from "../scripts/run-subagents-tests.mjs";

const runnerPath = join(repoRoot, "scripts/run-subagents-tests.mjs");

function scrubRunnerEnv() {
  const env = { ...process.env };
  delete env.TICKETS_DIR;
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  delete env.TLH_CI_TIMINGS_DIR;
  delete env.TLH_CI_TIMINGS_EVENT_FILE;
  delete env.TLH_CI_TIMINGS_SUITE;
  delete env.TLH_CI_TIMINGS_SHARD;
  delete env.TLH_CI_TIMINGS_REPO_ROOT;
  delete env.TLH_CI_TIMINGS_RUN_ID;
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_SUBAGENT")) delete env[key];
  }
  return env;
}

test("subagents runner projects the shared concurrency policy into Node args", () => {
  const args = buildTestCommandArgs({
    loader: "file:///tmp/register-loader.mjs",
    files: ["suite.test.ts"],
    env: { GITHUB_ACTIONS: "true", TLH_TEST_CONCURRENCY: "6" },
  });
  assert.ok(args.includes("--test-concurrency=6"));
  assert.ok(args.indexOf("--test-concurrency=6") < args.indexOf("suite.test.ts"));

  const githubArgs = buildTestCommandArgs({
    loader: "file:///tmp/register-loader.mjs",
    files: ["suite.test.ts"],
    env: { GITHUB_ACTIONS: "true" },
  });
  assert.ok(!githubArgs.some((arg) => arg.startsWith("--test-concurrency=")));

  const timingArgs = buildTestCommandArgs({
    loader: "file:///tmp/register-loader.mjs",
    files: ["suite.test.ts"],
    env: {
      TLH_CI_TIMINGS_DIR: "/workspace/timings",
      TLH_CI_TIMINGS_EVENT_FILE: "/workspace/timings/unit.events.jsonl",
    },
  });
  assert.ok(
    timingArgs.includes(
      `--test-reporter=${new URL("../scripts/ci-timing-reporter.mjs", import.meta.url).href}`,
    ),
  );
  assert.ok(timingArgs.includes("--test-reporter-destination=stdout"));
  assert.ok(
    timingArgs.includes("--test-reporter-destination=/workspace/timings/unit.events.jsonl"),
  );

  const childEnv = buildChildEnv(
    {
      TLH_CI_TIMINGS_DIR: "/workspace/timings",
      TLH_CI_TIMINGS_EVENT_FILE: "/workspace/timings/unit.events.jsonl",
      TLH_CI_TIMINGS_SUITE: "unit",
      TLH_CI_TIMINGS_REPO_ROOT: "/workspace/repo",
    },
    "/tmp/agent-dir",
  );
  assert.equal(childEnv.TLH_CI_TIMINGS_DIR, undefined);
  assert.equal(childEnv.TLH_CI_TIMINGS_EVENT_FILE, undefined);
  assert.equal(childEnv.TLH_CI_TIMINGS_SUITE, "unit");
  assert.equal(childEnv.TLH_CI_TIMINGS_REPO_ROOT, "/workspace/repo");
});

test("subagents runner rejects incomplete timing configuration without a stack", () => {
  const result = spawnSync(process.execPath, [runnerPath, "e2e"], {
    cwd: repoRoot,
    env: { ...scrubRunnerEnv(), TLH_CI_TIMINGS_DIR: "/tmp/timings" },
    encoding: "utf8",
  });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /must be set together/);
  assert.doesNotMatch(result.stderr, /\bat /u);
});

test("subagents runner reports invalid concurrency overrides without a stack", () => {
  const result = spawnSync(process.execPath, [runnerPath, "e2e"], {
    cwd: repoRoot,
    env: { ...process.env, TLH_TEST_CONCURRENCY: "invalid" },
    encoding: "utf8",
  });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    'TLH_TEST_CONCURRENCY must be a positive integer or unset it; received "invalid".\n',
  );
  assert.doesNotMatch(result.stderr, /\bat /u);
});

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
    () => discoverSuiteFiles("unit", { directory: join(root, "missing") }),
    /Could not read unit test directory/,
  );
  const emptyDir = join(root, "empty");
  mkdirSync(emptyDir);
  assert.throws(
    () => discoverSuiteFiles("unit", { directory: emptyDir }),
    /unit suite found no \.test\.ts files/,
  );
});

test("subagents runner rejects a diagnostic with zero selected passes at the CLI", () => {
  const result = spawnSync(
    process.execPath,
    [runnerPath, "e2e", "--test-name-pattern=^does-not-exist$"],
    { cwd: repoRoot, env: scrubRunnerEnv(), encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /diagnostic selected zero passing tests/);
  assert.match(result.stdout, /1\.\.0/);
});

test("subagents runner rejects unsupported filtering at the CLI", () => {
  const result = spawnSync(
    process.execPath,
    [runnerPath, "e2e", "--test-skip-pattern=known-flake"],
    { cwd: repoRoot, env: scrubRunnerEnv(), encoding: "utf8" },
  );
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /does not support --test-skip-pattern/);
});

test("subagents runner accepts a selected test across multi-file diagnostics", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tlh-subagents-runner-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixtureSource = (name) =>
    `import assert from "node:assert/strict";\nimport test from "node:test";\n` +
    `test("${name}", () => assert.ok(true));\n`;
  writeFileSync(join(root, "a-selected.test.ts"), fixtureSource("processes all items"));
  writeFileSync(join(root, "b-excluded.test.ts"), fixtureSource("unrelated behavior"));
  writeFileSync(join(root, "c-excluded.test.ts"), fixtureSource("another unrelated behavior"));
  const files = discoverSuiteFiles("integration", { directory: root });
  assert.equal(files.length, 3, "the regression requires a multi-file suite");

  // Exercise the real runner and TS loader path against the fixture directory
  // through the optional runSuite config seam, in a scrubbed child process.
  const script =
    `import { runSuite } from ${JSON.stringify(pathToFileURL(runnerPath).href)};\n` +
    `process.exitCode = runSuite("integration", ["--test-name-pattern=processes all items"], ` +
    `{ config: { directory: ${JSON.stringify(root)}, minimumTests: 1 } });\n`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repoRoot,
    env: scrubRunnerEnv(),
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    result.stdout,
    new RegExp(
      `subagents integration diagnostic .*1/1 selected tests passed \\(${files.length} files\\)`,
    ),
  );
});

test("subagents runner rejects inherited selection filters without dropping other Node options", () => {
  const unrelated = "--trace-warnings --no-warnings";
  const preserved = buildChildEnv({ NODE_OPTIONS: unrelated, KEEP: "yes" }, "/tmp/agent-dir");
  assert.equal(preserved.NODE_OPTIONS, unrelated);
  assert.equal(preserved.KEEP, "yes");

  for (const [nodeOptions, flag] of [
    ["--trace-warnings --test-name-pattern=does-not-exist", "--test-name-pattern"],
    ["--trace-warnings --test_name-pattern=does_not_exist", "--test-name-pattern"],
    ["--trace-warnings --test-name-pattern='does not exist'", "--test-name-pattern"],
    ['--trace-warnings --test-name_pattern "does_not_exist=part"', "--test-name-pattern"],
    ["--trace-warnings --test-skip-pattern='known flaky'", "--test-skip-pattern"],
    ["--trace-warnings --test_skip-pattern='known_flaky=part'", "--test-skip-pattern"],
    ["--trace-warnings --test-only", "--test-only"],
    ["--trace-warnings --test_only", "--test-only"],
  ]) {
    assert.equal(findInheritedSelectionFilter(nodeOptions), flag);
    assert.throws(
      () => buildChildEnv({ NODE_OPTIONS: nodeOptions }, "/tmp/agent-dir"),
      new RegExp(`rejects ${flag} inherited via NODE_OPTIONS`),
    );
  }

  const env = scrubRunnerEnv();
  env.NODE_OPTIONS = '--trace-warnings --test-name-pattern "does not exist"';
  const result = spawnSync(process.execPath, [runnerPath, "e2e"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /rejects --test-name-pattern inherited via NODE_OPTIONS/);
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

test("subagents runner labels name-pattern diagnostics and accepts both argument forms", () => {
  assert.deepEqual(parseRunnerOptions(["--test-name-pattern", "boots child"]), {
    diagnostic: true,
    namePattern: "boots child",
  });
  assert.deepEqual(parseRunnerOptions(["--test-name-pattern=^boots child$"]), {
    diagnostic: true,
    namePattern: "^boots child$",
  });
  const patternWithUnderscoresAndEquals = "boots_child=part_two";
  assert.deepEqual(parseRunnerOptions(["--test_name-pattern", patternWithUnderscoresAndEquals]), {
    diagnostic: true,
    namePattern: patternWithUnderscoresAndEquals,
  });
  assert.deepEqual(
    parseRunnerOptions([`--test-name_pattern=^${patternWithUnderscoresAndEquals}$`]),
    {
      diagnostic: true,
      namePattern: `^${patternWithUnderscoresAndEquals}$`,
    },
  );
  assert.deepEqual(parseRunnerOptions(["--test-shard=1/2"]), {
    diagnostic: false,
    namePattern: undefined,
  });
});

test("subagents runner rejects ambiguous and unsupported filtered execution", () => {
  for (const options of [
    ["--test-name-pattern"],
    ["--test-name-pattern", ""],
    ["--test-name-pattern", "--test-skip-pattern"],
    ["--test-name-pattern=first", "--test-name-pattern=second"],
    ["--test-only"],
    ["--test_only"],
    ["--test-skip-pattern=flaky"],
    ["--test-skip_pattern=flaky_name=part"],
    ["--test-rerun-failures=failures.json"],
  ]) {
    assert.throws(() => parseRunnerOptions(options), /test-name-pattern|does not support/u);
  }
});

test("subagents runner counts excluded wrappers with interleaved comments", () => {
  const zeroSelected = [
    "TAP version 13",
    "1..0",
    "# exit handler log",
    "# another diagnostic comment",
    "# Subtest: /tmp/excluded-a.test.ts",
    "ok 1 - /tmp/excluded-a.test.ts",
    "1..0",
    "# Subtest: /tmp/excluded-b.test.ts",
    "ok 2 - /tmp/excluded-b.test.ts",
  ].join("\n");
  assert.equal(countNamePatternExcludedFiles(zeroSelected), 2);
  assert.deepEqual(selectedNamePatternSummary(zeroSelected, { tests: 2, pass: 2 }), {
    tests: 0,
    pass: 0,
  });

  const positiveSelected = [
    "TAP version 13",
    "# Subtest: selected test",
    "ok 1 - selected test",
    "1..1",
    "1..0",
    "# exit handler log",
    "# Subtest: /tmp/excluded.test.ts",
    "ok 2 - /tmp/excluded.test.ts",
  ].join("\n");
  assert.equal(countNamePatternExcludedFiles(positiveSelected), 1);
  assert.deepEqual(selectedNamePatternSummary(positiveSelected, { tests: 2, pass: 2 }), {
    tests: 1,
    pass: 1,
  });

  const skipped = parseTapSummary(tapSummary({ pass: 0, skipped: 1 }));
  assert.throws(
    () =>
      validateTapSummary("unit", skipped, {
        diagnostic: true,
        selectedTests: 1,
        selectedPasses: 0,
      }),
    /unit suite reported skipped=1/,
  );
});

test("subagents runner requires a passing selected test for a diagnostic", () => {
  const summary = parseTapSummary(tapSummary());
  assert.doesNotThrow(() =>
    validateTapSummary("unit", summary, {
      diagnostic: true,
      selectedTests: 1,
      selectedPasses: 1,
      minimumTests: 1_147,
    }),
  );
  assert.throws(
    () =>
      validateTapSummary("unit", summary, {
        diagnostic: true,
        selectedTests: 0,
        selectedPasses: 0,
      }),
    /unit diagnostic selected zero passing tests/,
  );
  for (const field of ["fail", "cancelled", "todo"]) {
    const failed = parseTapSummary(tapSummary({ pass: 0, [field]: 1 }));
    assert.throws(
      () =>
        validateTapSummary("unit", failed, {
          diagnostic: true,
          selectedTests: 0,
          selectedPasses: 0,
        }),
      new RegExp(`unit suite reported ${field}=1`),
    );
  }
});

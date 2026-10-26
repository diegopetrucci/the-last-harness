import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import timingReporter from "../scripts/ci-timing-reporter.mjs";
import { runLanes } from "../scripts/run-lane.mjs";
import {
  CI_TIMINGS_DIR_ENV,
  CI_TIMINGS_EVENT_FILE_ENV,
  createCiTimingCollector,
  createCiTimingConfig,
  ciTimingReporterArgs,
  resolveCiTimingDirectory,
  timingEnvironmentForCommand,
  timingEventFile,
} from "../scripts/ci-timings.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function repoTempDir() {
  return mkdtempSync(join(repoRoot, ".tmp-ci-timings-test-"));
}

test("CI timing collection stays disabled unless an output directory is configured", () => {
  assert.equal(resolveCiTimingDirectory({}), undefined);
  assert.equal(createCiTimingConfig({ env: {}, repoRoot }), null);
});

test("CI timing output rejects relative and guarded directories", () => {
  assert.throws(
    () => resolveCiTimingDirectory({ [CI_TIMINGS_DIR_ENV]: "relative/timings" }),
    /must be an absolute path/,
  );
  const root = repoTempDir();
  try {
    assert.throws(
      () =>
        resolveCiTimingDirectory(
          {
            [CI_TIMINGS_DIR_ENV]: join(root, "reports"),
            HOME: root,
          },
          [],
        ),
      /outside HOME/,
    );
    assert.throws(
      () =>
        resolveCiTimingDirectory(
          {
            [CI_TIMINGS_DIR_ENV]: join(root, "reports"),
            TMPDIR: root,
          },
          [],
        ),
      /outside TMPDIR/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CI timing config records the effective concurrency policy", () => {
  const root = repoTempDir();
  try {
    const reportDir = join(root, "reports");
    const config = createCiTimingConfig({
      env: {
        [CI_TIMINGS_DIR_ENV]: reportDir,
        HOME: join(root, "home"),
        TMPDIR: join(root, "tmp"),
      },
      repoRoot,
      shard: "1/2",
      availableParallelism: () => 8,
    });
    assert.ok(config);
    assert.equal(config.availableCpuCount, 8);
    assert.equal(config.laneLayout, "baseline");
    assert.equal(config.effectiveConcurrency, 4);
    assert.equal(config.concurrencySource, "adaptive-local");
    const githubConfig = createCiTimingConfig({
      env: {
        [CI_TIMINGS_DIR_ENV]: reportDir,
        HOME: join(root, "home"),
        TMPDIR: join(root, "tmp"),
        GITHUB_ACTIONS: "true",
      },
      repoRoot,
      shard: "1/2",
      laneLayout: "experimental",
      availableParallelism: () => 4,
    });
    assert.ok(githubConfig);
    assert.equal(githubConfig.laneLayout, "experimental");
    assert.equal(githubConfig.availableCpuCount, 4);
    assert.equal(githubConfig.effectiveConcurrency, 3);
    assert.equal(githubConfig.concurrencySource, "node-default");
    assert.equal(existsSync(reportDir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CI timing reporter arguments preserve the normal reporter and use the configured event file", () => {
  const args = ciTimingReporterArgs({
    env: {
      [CI_TIMINGS_DIR_ENV]: "/workspace/timings",
      [CI_TIMINGS_EVENT_FILE_ENV]: "/workspace/timings/unit.events.jsonl",
    },
    reporterPath: "/workspace/reporter.mjs",
  });
  assert.deepEqual(args, [
    "--test-reporter=/workspace/reporter.mjs",
    "--test-reporter-destination=stdout",
    "--test-reporter-destination=/workspace/timings/unit.events.jsonl",
  ]);
  assert.deepEqual(ciTimingReporterArgs({ env: {}, reporterPath: "/workspace/reporter.mjs" }), []);
  assert.throws(
    () =>
      ciTimingReporterArgs({
        env: { [CI_TIMINGS_DIR_ENV]: "/workspace/timings" },
        reporterPath: "/workspace/reporter.mjs",
      }),
    /must be set together/,
  );
  assert.throws(
    () =>
      ciTimingReporterArgs({
        env: { [CI_TIMINGS_EVENT_FILE_ENV]: "/workspace/timings/unit.events.jsonl" },
        reporterPath: "/workspace/reporter.mjs",
      }),
    /must be set together/,
  );
});

test("CI timing reports separate wall time from cumulative per-file time and use relative files", () => {
  const root = repoTempDir();
  try {
    const config = createCiTimingConfig({
      env: {
        [CI_TIMINGS_DIR_ENV]: join(root, "reports"),
        HOME: join(root, "home"),
        TMPDIR: join(root, "tmp"),
      },
      repoRoot,
      shard: "1/2",
      runId: "test-run",
      availableParallelism: () => 4,
    });
    assert.ok(config);
    let clock = 100;
    const collector = createCiTimingCollector(config, { now: () => clock });
    const eventFile = timingEventFile(config, { lane: "a", index: 0, suite: "root" });
    const commandEnv = timingEnvironmentForCommand(config, {
      suite: "root",
      eventFile,
    });
    assert.equal(commandEnv[CI_TIMINGS_EVENT_FILE_ENV], eventFile);
    collector.startLane("a");
    const command = collector.startCommand({
      lane: "a",
      suite: "root",
      index: 0,
      eventFile,
    });
    mkdirSync(config.directory, { recursive: true });
    writeFileSync(
      eventFile,
      `${JSON.stringify({
        type: "file",
        file: "tests/slow.test.mjs",
        durationMs: 12.5,
        status: "passed",
      })}\n${JSON.stringify({
        type: "file",
        file: "tests/fast.test.mjs",
        durationMs: 2.5,
        status: "passed",
      })}\n`,
    );
    clock = 140;
    collector.endCommand(command, { ok: true });
    collector.endLane("a", true);
    const result = collector.finalize(0);
    assert.equal(result.written, true);
    const report = JSON.parse(readFileSync(result.reportPath, "utf8"));
    assert.equal(report.shard, "1/2");
    assert.equal(report.laneLayout, "baseline");
    assert.equal(report.nodeVersion, process.version);
    assert.deepEqual(report.platform, { os: process.platform, arch: process.arch });
    assert.equal(report.lanes[0].commands[0].suite, "root");
    assert.equal(report.lanes[0].commands[0].elapsedWallMs, 40);
    assert.equal(report.lanes[0].commands[0].cumulativeFileTimeMs, 15);
    assert.equal(report.cumulativeFileTimeMs, 15);
    assert.deepEqual(
      report.lanes[0].commands[0].files.map(({ file }) => file),
      ["tests/slow.test.mjs", "tests/fast.test.mjs"],
    );
    assert.equal(existsSync(eventFile), false, "raw event files are removed after report creation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CI timing reports a failed command and lane as failed", async () => {
  const root = repoTempDir();
  try {
    const config = createCiTimingConfig({
      env: {
        [CI_TIMINGS_DIR_ENV]: join(root, "reports"),
        HOME: join(root, "home"),
        TMPDIR: join(root, "tmp"),
      },
      repoRoot,
      shard: "1/2",
      runId: "failed-run",
      availableParallelism: () => 2,
    });
    assert.ok(config);
    const collector = createCiTimingCollector(config);
    const eventFile = timingEventFile(config, { lane: "a", index: 0, suite: "root" });
    const exitCode = await runLanes(
      [
        {
          name: "a",
          commands: [[process.execPath, "-e", "process.exit(1)"]],
          timingCommands: [{ suite: "root", eventFile }],
        },
      ],
      { baseHomeDir: join(root, "home") },
      { timing: collector, stdout: { write: () => true } },
    );
    assert.equal(exitCode, 1);
    const result = collector.finalize(exitCode);
    const report = JSON.parse(readFileSync(result.reportPath, "utf8"));
    assert.equal(report.status, "failed");
    assert.equal(report.exitCode, 1);
    assert.equal(report.lanes[0].status, "failed");
    assert.equal(report.lanes[0].commands[0].status, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CI timing collector propagates a reporter truncation marker", () => {
  const root = repoTempDir();
  try {
    const config = createCiTimingConfig({
      env: {
        [CI_TIMINGS_DIR_ENV]: join(root, "reports"),
        HOME: join(root, "home"),
        TMPDIR: join(root, "tmp"),
      },
      repoRoot,
      shard: "1/2",
      runId: "marker-run",
      availableParallelism: () => 2,
    });
    assert.ok(config);
    const collector = createCiTimingCollector(config);
    const eventFile = timingEventFile(config, { lane: "a", index: 0, suite: "root" });
    collector.startLane("a");
    const command = collector.startCommand({ lane: "a", suite: "root", index: 0, eventFile });
    writeFileSync(
      eventFile,
      `${JSON.stringify({
        type: "file",
        suite: "root",
        file: "tests/slow.test.mjs",
        durationMs: 12,
        status: "passed",
      })}\n${JSON.stringify({ type: "truncated", suite: "root", maxBytes: 1024 })}\n`,
    );
    collector.endCommand(command, { ok: true });
    collector.endLane("a", true);
    const result = collector.finalize(0);
    const report = JSON.parse(readFileSync(result.reportPath, "utf8"));
    assert.equal(report.lanes[0].commands[0].eventDataTruncated, true);
    assert.deepEqual(
      report.lanes[0].commands[0].files.map(({ file }) => file),
      ["tests/slow.test.mjs"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CI timing reporter reserves room for a truncation marker", async () => {
  const previousSuite = process.env.TLH_CI_TIMINGS_SUITE;
  const previousRoot = process.env.TLH_CI_TIMINGS_REPO_ROOT;
  process.env.TLH_CI_TIMINGS_SUITE = "root";
  process.env.TLH_CI_TIMINGS_REPO_ROOT = repoRoot;
  try {
    async function* events() {
      for (let index = 0; index < 20_000; index += 1) {
        yield {
          type: "test:summary",
          data: {
            file: join(repoRoot, "tests", `timed-${index}.test.mjs`),
            duration_ms: index,
            success: true,
          },
        };
      }
    }
    const output = [];
    for await (const line of timingReporter(events())) output.push(line);
    const text = output.join("");
    assert.ok(Buffer.byteLength(text) <= 1024 * 1024);
    const records = text.trim().split("\n").map(JSON.parse);
    assert.equal(records.at(-1)?.type, "truncated");
  } finally {
    if (previousSuite === undefined) delete process.env.TLH_CI_TIMINGS_SUITE;
    else process.env.TLH_CI_TIMINGS_SUITE = previousSuite;
    if (previousRoot === undefined) delete process.env.TLH_CI_TIMINGS_REPO_ROOT;
    else process.env.TLH_CI_TIMINGS_REPO_ROOT = previousRoot;
  }
});

test("CI timing cancellation writes a cancelled report without changing the exit contract", () => {
  const root = repoTempDir();
  try {
    const config = createCiTimingConfig({
      env: {
        [CI_TIMINGS_DIR_ENV]: join(root, "reports"),
        HOME: join(root, "home"),
        TMPDIR: join(root, "tmp"),
      },
      repoRoot,
      shard: "2/2",
      runId: "cancelled-run",
      availableParallelism: () => 2,
    });
    assert.ok(config);
    const collector = createCiTimingCollector(config);
    const eventFile = timingEventFile(config, { lane: "b", index: 0, suite: "integration" });
    collector.startLane("b");
    collector.startCommand({ lane: "b", suite: "integration", index: 0, eventFile });
    collector.onCancellation("SIGTERM");
    const reportPath = join(config.directory, "tlh-ci-timings-cancelled-run-2_2.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.status, "cancelled");
    assert.equal(report.cancellationSignal, "SIGTERM");
    assert.equal(report.lanes[0].commands[0].status, "cancelled");
    assert.equal(existsSync(reportPath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("timing reporter emits per-file records while TAP remains on stdout", () => {
  const root = repoTempDir();
  const testFile = join(root, "sample.test.mjs");
  try {
    const config = createCiTimingConfig({
      env: {
        [CI_TIMINGS_DIR_ENV]: join(root, "reports"),
        HOME: join(root, "home"),
        TMPDIR: join(root, "tmp"),
      },
      repoRoot,
      shard: "1/2",
      runId: "reporter-run",
      availableParallelism: () => 2,
    });
    assert.ok(config);
    const eventFile = timingEventFile(config, { lane: "a", index: 0, suite: "root" });
    writeFileSync(testFile, "import test from 'node:test'; test('sample', () => {});\n");
    const env = {
      ...process.env,
      ...timingEnvironmentForCommand(config, { suite: "root", eventFile }),
    };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-reporter=tap",
        ...ciTimingReporterArgs({
          env,
          reporterPath: resolve(repoRoot, "scripts/ci-timing-reporter.mjs"),
        }),
        testFile,
      ],
      { cwd: repoRoot, env, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /TAP version/, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    const event = readFileSync(eventFile, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(event.length, 1);
    assert.equal(event[0].suite, "root");
    assert.equal(event[0].file, relative(repoRoot, testFile).replaceAll("\\", "/"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

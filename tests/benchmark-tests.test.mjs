import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RUNS,
  formatMilliseconds,
  median,
  parseArgs,
  runBenchmark,
  usage,
  runTestPath,
  runnerOrder,
  TEST_RUNNERS,
} from "../scripts/benchmark-tests.mjs";

function streamCapture() {
  const chunks = [];
  return {
    stream: {
      write(chunk) {
        chunks.push(String(chunk));
      },
    },
    get text() {
      return chunks.join("");
    },
  };
}

test("benchmark arguments accept a positive run count and reject invalid values", () => {
  assert.deepEqual(parseArgs([]), { runs: DEFAULT_RUNS, help: false });
  assert.deepEqual(parseArgs(["--runs=5"]), { runs: 5, help: false });
  assert.deepEqual(parseArgs(["--runs", "2"]), { runs: 2, help: false });
  assert.deepEqual(parseArgs(["--help"]), { runs: DEFAULT_RUNS, help: true });

  for (const argv of [
    ["--runs"],
    ["--runs", "0"],
    ["--runs=-1"],
    ["--runs=1.5"],
    ["--runs=not-a-number"],
    ["--unknown"],
  ]) {
    assert.throws(() => parseArgs(argv), /requires a value|positive integer|Unknown option/);
  }
  assert.throws(() => parseArgs(["--runs=2", "--runs=3"]), /more than once/);
});

test("benchmark help and preamble disclose the runner concurrency caveat", () => {
  const caveat =
    /canonical Node \(npm test\) runs test files in parallel processes; the viable Bun path is serialized with --parallel=1/;
  const comparison =
    /two viable repository test configurations, not equal-concurrency raw runtime throughput/;

  assert.match(usage(), caveat);
  assert.match(usage(), comparison);

  const output = [];
  const status = runBenchmark({
    runs: 1,
    run: () => ({ ok: true, status: 0, signal: null, elapsedMs: 1 }),
    log: (line) => output.push(line),
  });

  assert.equal(status, 0);
  assert.match(output.join("\n"), caveat);
  assert.match(output.join("\n"), comparison);
});

test("benchmark runner commands use the canonical Node and Bun npm paths", () => {
  assert.deepEqual(TEST_RUNNERS.node.command.slice(1), ["test"]);
  assert.deepEqual(TEST_RUNNERS.bun.command.slice(1), ["run", "test:bun"]);
});

test("benchmark order alternates sequentially across repetitions", () => {
  assert.deepEqual(
    [1, 2, 3, 4].map((repetition) => runnerOrder(repetition)),
    [
      ["node", "bun"],
      ["bun", "node"],
      ["node", "bun"],
      ["bun", "node"],
    ],
  );
  assert.throws(() => runnerOrder(0), /positive integer/);
});

test("median calculates odd and even samples without mutating input", () => {
  const odd = [30, 10, 20];
  const even = [40, 10, 30, 20];
  assert.equal(median(odd), 20);
  assert.equal(median(even), 25);
  assert.deepEqual(odd, [30, 10, 20]);
  assert.throws(() => median([]), /at least one/);
  assert.throws(() => median([1, Number.NaN]), /finite/);
  assert.equal(formatMilliseconds(12.345), "12.3ms");
});

test("benchmark reports samples and medians while running one runner at a time", () => {
  const calls = [];
  const output = [];
  let active = 0;
  let maximumActive = 0;
  const durations = [10, 40, 60, 30, 20, 50];

  const status = runBenchmark({
    runs: 3,
    run(runner, repetition) {
      calls.push(`${repetition}:${runner.name}`);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const elapsedMs = durations[calls.length - 1];
      active -= 1;
      return { ok: true, status: 0, signal: null, elapsedMs };
    },
    log: (line) => output.push(line),
    error: (line) => output.push(`error: ${line}`),
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, ["1:node", "1:bun", "2:bun", "2:node", "3:node", "3:bun"]);
  assert.equal(maximumActive, 1);
  assert.match(output.join("\n"), /Run 1\/3: node -> bun/);
  assert.match(output.join("\n"), /Node: 10\.0ms/);
  assert.match(output.join("\n"), /Bun: 40\.0ms/);
  assert.match(output.join("\n"), /Median total Node: 20\.0ms/);
  assert.match(output.join("\n"), /Median total Bun: 50\.0ms/);
});

test("benchmark stops at the first failed path and does not start later work", () => {
  const calls = [];
  const output = [];
  const stdout = streamCapture();
  const stderr = streamCapture();

  const status = runBenchmark({
    runs: 3,
    run(runner, repetition) {
      calls.push(`${repetition}:${runner.name}`);
      if (runner.name === "bun") {
        return {
          ok: false,
          status: 7,
          signal: null,
          elapsedMs: 12,
          stdout: "bun stdout\n",
          stderr: "bun stderr\n",
        };
      }
      return { ok: true, status: 0, signal: null, elapsedMs: 10 };
    },
    log: (line) => output.push(line),
    error: (line) => output.push(`error: ${line}`),
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(status, 7);
  assert.deepEqual(calls, ["1:node", "1:bun"]);
  assert.equal(stdout.text, "bun stdout\n");
  assert.equal(stderr.text, "bun stderr\n");
  assert.match(output.join("\n"), /stopped at run 1: Bun test path failed/);
  assert.match(output.join("\n"), /No later runner or repetition was started/);
  assert.doesNotMatch(output.join("\n"), /Median total/);
});

test("runTestPath invokes only the selected package script and measures elapsed time", () => {
  const calls = [];
  const clock = [100, 145];
  const result = runTestPath(TEST_RUNNERS.node, {
    cwd: "/fixture",
    env: { TEST_ENV: "1" },
    now: () => clock.shift(),
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, signal: null, stdout: "ignored", stderr: "" };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.elapsedMs, 45);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["test"]);
  assert.equal(calls[0].options.cwd, "/fixture");
  assert.deepEqual(calls[0].options.env, { TEST_ENV: "1" });
});

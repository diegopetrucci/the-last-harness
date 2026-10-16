import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { Writable } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CI_TIMINGS_DIR_ENV,
  CI_TIMINGS_EVENT_FILE_ENV,
  createCiTimingConfig,
} from "../scripts/ci-timings.mjs";
import {
  CI_LANE_LAYOUT_ENV,
  buildLanes,
  parseLaneLayout,
  parseShard,
  parseShardRunnerOptions,
  registerTmpdirCleanup,
} from "../scripts/run-ci-test-shard.mjs";
import { runLane, runLanes, spawnBuffered } from "../scripts/run-lane.mjs";
import { isProcessAlive as processIsAlive } from "./process-liveness.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const runLanePath = resolve(testDir, "../scripts/run-lane.mjs");
const runCiShardPath = resolve(testDir, "../scripts/run-ci-test-shard.mjs");

const _tmpDirs = [];
after(() => {
  for (const d of _tmpDirs) rmSync(d, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "tlh-run-lane-test-"));
  _tmpDirs.push(dir);
  return dir;
}

/**
 * Build a subprocess environment that cannot inherit ticket or subagent
 * session state from the contributor harness.
 */
function scrubTestEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.TICKETS_DIR;
  delete env.NODE_TEST_CONTEXT;
  delete env.TLH_CI_TIMINGS_DIR;
  delete env.TLH_CI_TIMINGS_EVENT_FILE;
  delete env.TLH_CI_TIMINGS_SUITE;
  delete env.TLH_CI_TIMINGS_SHARD;
  delete env.TLH_CI_TIMINGS_REPO_ROOT;
  delete env.TLH_CI_TIMINGS_RUN_ID;
  delete env[CI_LANE_LAYOUT_ENV];
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_SUBAGENTS_")) delete env[key];
  }
  Object.assign(env, overrides);
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_SUBAGENTS_")) delete env[key];
  }
  return env;
}

/** Build a fully owned HOME/profile/TMPDIR for a subprocess fixture. */
function ownedTestEnv(root, overrides = {}) {
  const env = scrubTestEnv(overrides);
  const home = join(root, "home");
  const profile = join(root, "profile");
  mkdirSync(home, { recursive: true });
  mkdirSync(profile, { recursive: true });
  env.HOME = home;
  env.PI_CODING_AGENT_DIR = profile;
  env.TMPDIR = root;
  env.TMP = root;
  env.TEMP = root;
  return env;
}

/** Include explicit undefined entries so runLane's inherited merge cannot restore state. */
function scrubLaneEnv(overrides = {}) {
  const env = scrubTestEnv(overrides);
  env.TICKETS_DIR = undefined;
  env.NODE_TEST_CONTEXT = undefined;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_SUBAGENTS_")) env[key] = undefined;
  }
  return env;
}

const cleanLaneEnv = scrubLaneEnv();

// Baseline layout assertions must not inherit an opt-in experimental selector.
const baselineLaneEnv = Object.freeze({});

function isNumericPid(pid) {
  return Number.isInteger(pid) && pid > 0;
}

async function waitForProcessGone(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processIsAlive(pid);
}

/** Kill a fixture-owned detached process group and its direct leader. */
function killOwnedPid(pid) {
  if (!isNumericPid(pid)) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The direct PID fallback below covers a group that already disappeared.
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone is the expected cleanup case.
  }
}

async function cleanupOwnedPids(pids) {
  const owned = [...new Set(pids.filter(isNumericPid))];
  for (const pid of owned) killOwnedPid(pid);
  const results = await Promise.all(
    owned.map(async (pid) => ({ pid, gone: await waitForProcessGone(pid) })),
  );
  return results.filter(({ gone }) => !gone).map(({ pid }) => pid);
}

function readPid(path) {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
    return isNumericPid(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function observeClose(child) {
  return new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

/**
 * Bound a helper-process close wait without leaving a timer behind after the
 * child settles.  The close observer itself is attached at spawn time so a
 * fast exit cannot be missed while the test is doing its readiness handshake.
 */
function awaitWithTimeout(promise, timeoutMs, description) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Timed out waiting for ${description}`));
    }, timeoutMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const HELPER_CLOSE_TIMEOUT_MS = 5000;

/** Capture stream output into a buffer. */
function captureStream() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  return {
    stream,
    get content() {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

// ---------------------------------------------------------------------------
// spawnBuffered
// ---------------------------------------------------------------------------

test("spawnBuffered: resolves ok=true on zero exit", async () => {
  const { ok } = await spawnBuffered([process.execPath, "-e", "process.exit(0)"], scrubTestEnv());
  assert.equal(ok, true);
});

test("spawnBuffered: resolves ok=false on non-zero exit", async () => {
  const { ok } = await spawnBuffered([process.execPath, "-e", "process.exit(1)"], scrubTestEnv());
  assert.equal(ok, false);
});

test("spawnBuffered: buffers stdout and writes atomically on completion", async () => {
  const out = captureStream();
  const err = captureStream();
  await spawnBuffered(
    [process.execPath, "-e", "process.stdout.write('hello stdout')"],
    scrubTestEnv(),
    {
      stdout: out.stream,
      stderr: err.stream,
    },
  );
  assert.ok(
    out.content.includes("hello stdout"),
    `expected stdout to include 'hello stdout', got: ${out.content}`,
  );
  assert.equal(err.content, "");
});

test("spawnBuffered: buffers stderr and writes it in the same labeled block as stdout", async () => {
  const out = captureStream();
  const err = captureStream();
  await spawnBuffered(
    [process.execPath, "-e", "process.stderr.write('hello stderr')"],
    scrubTestEnv(),
    {
      stdout: out.stream,
      stderr: err.stream,
    },
  );
  // stderr is serialized into the same stdout frame so diagnostics stay
  // attached to their label header (cannot be separated by GHA log streaming).
  assert.ok(
    out.content.includes("hello stderr"),
    `expected stderr payload in stdout frame, got: ${out.content}`,
  );
  assert.equal(err.content, "", "nothing should go to the stderr stream");
});

test("spawnBuffered: injects env into child process", async () => {
  const out = captureStream();
  const env = scrubTestEnv({ TLH_LANE_CANARY: "lane-canary-42" });
  await spawnBuffered(
    [process.execPath, "-e", "process.stdout.write(process.env.TLH_LANE_CANARY ?? 'missing')"],
    env,
    {
      stdout: out.stream,
    },
  );
  assert.ok(
    out.content.includes("lane-canary-42"),
    `expected 'lane-canary-42' in output, got: ${out.content}`,
  );
});

test("spawnBuffered: prints label header before buffered output", async () => {
  const out = captureStream();
  await spawnBuffered([process.execPath, "-e", "process.stdout.write('payload')"], scrubTestEnv(), {
    stdout: out.stream,
    label: "lane a: node -e ...",
  });
  assert.match(out.content, /=== lane a: node -e \.\.\. ===/);
  assert.ok(out.content.includes("payload"), `expected 'payload' in output, got: ${out.content}`);
  assert.ok(
    out.content.indexOf("===") < out.content.indexOf("payload"),
    "label header should appear before buffered output",
  );
});

test("spawnBuffered: emits truncation notice when stdout exceeds buffer limit", async () => {
  const out = captureStream();
  const limit = 10; // very small for testing
  await spawnBuffered(
    [process.execPath, "-e", "process.stdout.write('x'.repeat(100))"],
    scrubTestEnv(),
    {
      stdout: out.stream,
      maxBufferBytes: limit,
    },
  );
  assert.match(out.content, /\[TLH\] stdout truncated at 10 bytes/);
});

test("spawnBuffered: emits truncation notice when stderr exceeds buffer limit", async () => {
  // stderr is framed into the stdout block, so the truncation notice appears in stdout.
  const out = captureStream();
  const limit = 10;
  await spawnBuffered(
    [process.execPath, "-e", "process.stderr.write('x'.repeat(100))"],
    scrubTestEnv(),
    {
      stdout: out.stream,
      maxBufferBytes: limit,
    },
  );
  assert.match(out.content, /\[TLH\] stderr truncated at 10 bytes/);
});

test("spawnBuffered: does not emit truncation notice when output is within limit", async () => {
  const out = captureStream();
  await spawnBuffered([process.execPath, "-e", "process.stdout.write('small')"], scrubTestEnv(), {
    stdout: out.stream,
    maxBufferBytes: 1000,
  });
  assert.ok(
    !out.content.includes("[TLH]"),
    `unexpected truncation notice in output: ${out.content}`,
  );
});

test("spawnBuffered: serializes stdout and stderr into one labeled block on stdout", async () => {
  const out = captureStream();
  const err = captureStream();
  // Command writes to both stdout and stderr.
  const code = `process.stdout.write("out-payload"); process.stderr.write("err-payload");`;
  await spawnBuffered([process.execPath, "-e", code], scrubTestEnv(), {
    stdout: out.stream,
    stderr: err.stream,
    label: "framing-test",
  });
  const content = out.content;
  // Everything lands on stdout.
  assert.ok(content.includes("=== framing-test ==="), "label should be in stdout");
  assert.ok(content.includes("out-payload"), "stdout payload should be in frame");
  assert.ok(content.includes("err-payload"), "stderr payload should be in stdout frame");
  assert.equal(err.content, "", "nothing should be written to the stderr stream");
  // Label appears before both payloads.
  const labelIdx = content.indexOf("=== framing-test ===");
  assert.ok(content.indexOf("out-payload") > labelIdx, "stdout payload should follow the label");
  assert.ok(content.indexOf("err-payload") > labelIdx, "stderr payload should follow the label");
});

test("runLanes: concurrent stderr-producing lanes each keep stderr attached to their label", async () => {
  const base = tempDir();
  const out = captureStream();
  const err = captureStream();

  // Two lanes that both produce only stderr output.
  await runLanes(
    [
      {
        name: "alpha",
        commands: [[process.execPath, "-e", "process.stderr.write('alpha-stderr-payload')"]],
        env: cleanLaneEnv,
      },
      {
        name: "beta",
        commands: [[process.execPath, "-e", "process.stderr.write('beta-stderr-payload')"]],
        env: cleanLaneEnv,
      },
    ],
    { baseHomeDir: base },
    { stdout: out.stream, stderr: err.stream },
  );

  const content = out.content;

  // Both payloads must appear in stdout (serialized into the framed blocks).
  assert.ok(
    content.includes("alpha-stderr-payload"),
    "alpha stderr payload must be in stdout frame",
  );
  assert.ok(content.includes("beta-stderr-payload"), "beta stderr payload must be in stdout frame");
  assert.equal(err.content, "", "nothing should be written to the stderr stream");

  // Each payload must appear after its own label and before the other lane's label,
  // proving atomic framing even with concurrent lanes.
  const alphaLabelIdx = content.indexOf("lane alpha:");
  const betaLabelIdx = content.indexOf("lane beta:");
  const alphaPayloadIdx = content.indexOf("alpha-stderr-payload");
  const betaPayloadIdx = content.indexOf("beta-stderr-payload");

  assert.ok(alphaLabelIdx !== -1, "alpha label must be present");
  assert.ok(betaLabelIdx !== -1, "beta label must be present");

  // Alpha label before alpha payload; beta label before beta payload.
  assert.ok(alphaPayloadIdx > alphaLabelIdx, "alpha payload must follow alpha label");
  assert.ok(betaPayloadIdx > betaLabelIdx, "beta payload must follow beta label");

  // Alpha payload and beta payload must not be interleaved across labels.
  // Whichever label comes first: its payload must appear before the other label.
  if (alphaLabelIdx < betaLabelIdx) {
    assert.ok(
      alphaPayloadIdx < betaLabelIdx,
      "alpha-stderr-payload must appear before beta label (framing must be atomic)",
    );
  } else {
    assert.ok(
      betaPayloadIdx < alphaLabelIdx,
      "beta-stderr-payload must appear before alpha label (framing must be atomic)",
    );
  }
});

test(
  "spawnBuffered: flushes partial buffered output to process.stdout on SIGTERM",
  { timeout: 20000 },
  async () => {
    const base = tempDir();
    const readyFile = join(base, "ready.txt");
    const childPidFile = join(base, "child.pid");
    // parentReadyFile is written by the helperScript after it has confirmed the data
    // is buffered, providing a deterministic signal to the test (no wall-clock waits).
    const parentReadyFile = join(base, "parent-ready.txt");

    // Child writes its identity before output, then signals readiness in the write
    // callback so readyFile is only created after the data is in the pipe buffer.
    const childCode = [
      `import { writeFileSync } from "node:fs";`,
      `writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));`,
      `process.stdout.write("partial output from child", () => {`,
      `  writeFileSync(${JSON.stringify(readyFile)}, "1");`,
      `});`,
      `setInterval(() => {}, 100000);`, // keep event loop alive
    ].join("\n");

    // helperScript polls for readyFile (data is in the OS pipe), then uses setImmediate
    // to let the I/O poll phase deliver the data event to spawnBuffered before signalling
    // parentReadyFile — a fully deterministic handshake without wall-clock thresholds.
    const helperScript = `
import { spawnBuffered } from ${JSON.stringify(runLanePath)};
import { existsSync, writeFileSync } from "node:fs";
const spawnPromise = spawnBuffered(
  [process.execPath, "--input-type=module", "-e", ${JSON.stringify(childCode)}],
  process.env
);
// Poll until child has written data to the pipe.
const deadline = Date.now() + 10000;
while (!existsSync(${JSON.stringify(readyFile)})) {
  if (Date.now() > deadline) process.exit(1);
  await new Promise(r => setTimeout(r, 10));
}
// setImmediate fires after the I/O poll phase where the pipe data event lands,
// ensuring spawnBuffered has pushed the chunk to outChunks before we signal.
await new Promise(r => setImmediate(r));
writeFileSync(${JSON.stringify(parentReadyFile)}, "1");
await spawnPromise;
`;

    const proc = spawn(process.execPath, ["--input-type=module", "-e", helperScript], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: ownedTestEnv(base),
    });
    const closePromise = observeClose(proc);

    const stdoutChunks = [];
    const stderrChunks = [];
    proc.stdout.on("data", (c) => stdoutChunks.push(c));
    proc.stderr.on("data", (c) => stderrChunks.push(c));

    try {
      // Wait for the helperScript's deterministic "data buffered" signal.
      const deadline = Date.now() + 10000;
      while (!existsSync(parentReadyFile)) {
        if (proc.exitCode !== null || proc.signalCode !== null) {
          const result = await awaitWithTimeout(
            closePromise,
            HELPER_CLOSE_TIMEOUT_MS,
            "partial-output helper close",
          );
          throw new Error(
            `helper exited before readiness (code=${result.code}, signal=${result.signal}); ` +
              `stderr=${Buffer.concat(stderrChunks)}`,
          );
        }
        if (Date.now() > deadline) {
          throw new Error("Timed out waiting for parent readiness signal");
        }
        await new Promise((r) => setTimeout(r, 25));
      }

      assert.equal(proc.kill("SIGTERM"), true, "helper should accept SIGTERM");
      const result = await awaitWithTimeout(
        closePromise,
        HELPER_CLOSE_TIMEOUT_MS,
        "partial-output helper close",
      );
      assert.equal(
        result.signal,
        null,
        `helper should exit via run-lane: ${JSON.stringify(result)}`,
      );
      assert.equal(result.code, 1, "run-lane should exit with its interruption code");

      const output = Buffer.concat(stdoutChunks).toString("utf8");
      assert.match(
        output,
        /partial output from child/,
        `Signal handler should flush buffered output; got: ${output}`,
      );
    } finally {
      const ownedPids = [proc.pid, readPid(childPidFile)];
      const survivors = await cleanupOwnedPids(ownedPids);
      assert.deepEqual(survivors, [], "signal fixture processes must not survive cleanup");
    }
  },
);

test(
  "spawnBuffered readiness failure cleanup owns a detached child tree",
  { timeout: 20000 },
  async () => {
    const base = tempDir();
    const childPidFile = join(base, "readiness-child.pid");
    const grandchildPidFile = join(base, "readiness-grandchild.pid");
    const grandchildReadyFile = join(base, "readiness-grandchild.ready");
    const treeReadyFile = join(base, "readiness-tree.ready");
    const failureFile = join(base, "readiness-failed");

    const grandchildCode = [
      `const { writeFileSync } = require("node:fs");`,
      `process.on("SIGTERM", () => {});`,
      `writeFileSync(${JSON.stringify(grandchildReadyFile)}, "ready");`,
      `setInterval(() => {}, 100000);`,
    ].join("\n");
    const childCode = [
      `const { existsSync, writeFileSync } = require("node:fs");`,
      `const { spawn } = require("node:child_process");`,
      `process.on("SIGTERM", () => {});`,
      `writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));`,
      `const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildCode)}], { stdio: "ignore" });`,
      `writeFileSync(${JSON.stringify(grandchildPidFile)}, String(grandchild.pid));`,
      `const deadline = Date.now() + 5000;`,
      `const waitForGrandchild = () => {`,
      `  if (existsSync(${JSON.stringify(grandchildReadyFile)})) {`,
      `    writeFileSync(${JSON.stringify(treeReadyFile)}, "ready");`,
      `    return;`,
      `  }`,
      `  if (Date.now() > deadline) process.exit(3);`,
      `  setTimeout(waitForGrandchild, 10);`,
      `};`,
      `waitForGrandchild();`,
      `setInterval(() => {}, 100000);`,
    ].join("\n");
    const helperScript = `
import { spawnBuffered } from ${JSON.stringify(runLanePath)};
import { existsSync, writeFileSync } from "node:fs";
spawnBuffered(
  [process.execPath, "-e", ${JSON.stringify(childCode)}],
  process.env,
  { label: "readiness failure fixture" },
);
while (!existsSync(${JSON.stringify(treeReadyFile)})) {
  await new Promise(r => setTimeout(r, 10));
}
writeFileSync(${JSON.stringify(failureFile)}, "helper exited before readiness");
process.exit(2);
`;

    const helper = spawn(process.execPath, ["--input-type=module", "-e", helperScript], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: ownedTestEnv(base),
    });
    const closePromise = observeClose(helper);
    const stderr = [];
    helper.stderr.on("data", (chunk) => stderr.push(chunk));

    try {
      const readyDeadline = Date.now() + 5000;
      while (!existsSync(treeReadyFile)) {
        if (helper.exitCode !== null || helper.signalCode !== null) {
          const result = await awaitWithTimeout(
            closePromise,
            HELPER_CLOSE_TIMEOUT_MS,
            "readiness-failure helper close",
          );
          throw new Error(
            `readiness fixture exited too early (code=${result.code}, signal=${result.signal}); ` +
              `stderr=${Buffer.concat(stderr)}`,
          );
        }
        if (Date.now() > readyDeadline) throw new Error("readiness fixture did not become owned");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const result = await awaitWithTimeout(
        closePromise,
        HELPER_CLOSE_TIMEOUT_MS,
        "readiness-failure helper close",
      );
      assert.equal(
        result.signal,
        null,
        `readiness helper should exit normally: ${JSON.stringify(result)}`,
      );
      assert.equal(result.code, 2);
      assert.equal(existsSync(failureFile), true, "fixture must record failed readiness");
    } finally {
      const survivors = await cleanupOwnedPids([
        helper.pid,
        readPid(childPidFile),
        readPid(grandchildPidFile),
      ]);
      assert.deepEqual(
        survivors,
        [],
        "readiness failure cleanup must remove child and grandchild independently",
      );
    }
  },
);

// ---------------------------------------------------------------------------
// runLane
// ---------------------------------------------------------------------------

test("runLane: creates the lane HOME directory", async () => {
  const base = tempDir();
  const laneHome = join(base, "lane-home-create");
  await runLane(
    { name: "create", commands: [[process.execPath, "-e", ""]], env: cleanLaneEnv },
    laneHome,
  );
  assert.ok(existsSync(laneHome), "lane HOME dir should be created");
});

test("runLane: sets HOME env var for all commands in the lane", async () => {
  const base = tempDir();
  const laneHome = join(base, "lane-home-env");
  const out = captureStream();
  await runLane(
    {
      name: "env",
      commands: [[process.execPath, "-e", "process.stdout.write(process.env.HOME)"]],
      env: cleanLaneEnv,
    },
    laneHome,
    { stdout: out.stream },
  );
  // Output includes the label header; check that the HOME path is present.
  assert.ok(out.content.includes(laneHome), `expected HOME path in output, got: ${out.content}`);
});

test("runLane: merges lane-specific env over process.env", async () => {
  const base = tempDir();
  const laneHome = join(base, "lane-env-merge");
  const out = captureStream();
  await runLane(
    {
      name: "merge",
      commands: [
        [process.execPath, "-e", "process.stdout.write(process.env.TLH_LANE_VAR ?? 'missing')"],
      ],
      env: { ...cleanLaneEnv, TLH_LANE_VAR: "custom-value" },
    },
    laneHome,
    { stdout: out.stream },
  );
  assert.ok(
    out.content.includes("custom-value"),
    `expected 'custom-value' in output, got: ${out.content}`,
  );
});

test("runLane: runs commands sequentially and stops on first failure", async () => {
  const base = tempDir();
  const laneHome = join(base, "lane-seq-stop");
  const sentinel = join(base, "sentinel.txt");
  // First command fails; second command writes a sentinel file that must NOT be created.
  const ok = await runLane(
    {
      name: "seq",
      commands: [
        [process.execPath, "-e", "process.exit(1)"],
        [
          process.execPath,
          "--input-type=module",
          "-e",
          `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "ran")`,
        ],
      ],
      env: cleanLaneEnv,
    },
    laneHome,
  );
  assert.equal(ok, false);
  assert.ok(!existsSync(sentinel), "second command must not run after first command failed");
});

test("runLane: returns true when all commands succeed", async () => {
  const base = tempDir();
  const laneHome = join(base, "lane-all-ok");
  const ok = await runLane(
    {
      name: "ok",
      commands: [
        [process.execPath, "-e", "process.exit(0)"],
        [process.execPath, "-e", "process.exit(0)"],
      ],
      env: cleanLaneEnv,
    },
    laneHome,
  );
  assert.equal(ok, true);
});

test("runLane: optional timing hooks observe command and lane wall time", async () => {
  const calls = [];
  const timing = {
    startLane(name) {
      calls.push(["lane-start", name]);
    },
    endLane(name, ok) {
      calls.push(["lane-end", name, ok]);
    },
    startCommand(command) {
      calls.push(["command-start", command.suite]);
      return command;
    },
    endCommand(command, result) {
      calls.push(["command-end", command.suite, result.ok]);
    },
  };
  const ok = await runLane(
    {
      name: "timed",
      commands: [[process.execPath, "-e", "process.exit(0)"]],
      timingCommands: [{ suite: "root", eventFile: "/repo/timings/root.events.jsonl" }],
    },
    tempDir(),
    { env: cleanLaneEnv, timing },
  );
  assert.equal(ok, true);
  assert.deepEqual(calls, [
    ["lane-start", "timed"],
    ["command-start", "root"],
    ["command-end", "root", true],
    ["lane-end", "timed", true],
  ]);
});

// ---------------------------------------------------------------------------
// runLanes
// ---------------------------------------------------------------------------

test("runLanes: runs lanes concurrently (not sequentially)", { timeout: 15000 }, async () => {
  const base = tempDir();
  const markerA = join(base, "marker-a");
  const markerB = join(base, "marker-b");

  // Each lane writes its own marker, then polls for the sibling's marker (10s timeout).
  // If lanes ran sequentially, the first lane would time out waiting for the sibling
  // (which hasn't started yet) and exit non-zero, causing runLanes to return 1.
  function pollCode(writeFile, waitFile) {
    return [
      `import { writeFileSync, existsSync } from "node:fs";`,
      `import { setTimeout as sleep } from "node:timers/promises";`,
      `writeFileSync(${JSON.stringify(writeFile)}, "1");`,
      `const deadline = Date.now() + 10000;`,
      `while (!existsSync(${JSON.stringify(waitFile)})) {`,
      `  if (Date.now() > deadline) process.exit(1);`,
      `  await sleep(50);`,
      `}`,
    ].join("\n");
  }

  const code = await runLanes(
    [
      {
        name: "a",
        commands: [[process.execPath, "--input-type=module", "-e", pollCode(markerA, markerB)]],
        env: cleanLaneEnv,
      },
      {
        name: "b",
        commands: [[process.execPath, "--input-type=module", "-e", pollCode(markerB, markerA)]],
        env: cleanLaneEnv,
      },
    ],
    { baseHomeDir: base },
  );
  assert.equal(
    code,
    0,
    "Both lanes should find each other's markers, confirming concurrent execution",
  );
});

test("runLanes: returns 0 when all lanes succeed", async () => {
  const base = tempDir();
  const code = await runLanes(
    [
      {
        name: "a",
        commands: [[process.execPath, "-e", "process.exit(0)"]],
        env: cleanLaneEnv,
      },
      {
        name: "b",
        commands: [[process.execPath, "-e", "process.exit(0)"]],
        env: cleanLaneEnv,
      },
    ],
    { baseHomeDir: base },
  );
  assert.equal(code, 0);
});

test("runLanes: returns 1 when any lane fails", async () => {
  const base = tempDir();
  const code = await runLanes(
    [
      {
        name: "a",
        commands: [[process.execPath, "-e", "process.exit(1)"]],
        env: cleanLaneEnv,
      },
      {
        name: "b",
        commands: [[process.execPath, "-e", "process.exit(0)"]],
        env: cleanLaneEnv,
      },
    ],
    { baseHomeDir: base },
  );
  assert.equal(code, 1);
});

test("runLanes: all lanes run to completion even when one fails", async () => {
  const base = tempDir();
  const sentinel = join(base, "lane-b-sentinel.txt");
  await runLanes(
    [
      // Lane A fails immediately.
      {
        name: "fail",
        commands: [[process.execPath, "-e", "process.exit(1)"]],
        env: cleanLaneEnv,
      },
      // Lane B must still complete and write the sentinel.
      {
        name: "ok",
        commands: [
          [
            process.execPath,
            "--input-type=module",
            "-e",
            `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "done")`,
          ],
        ],
        env: cleanLaneEnv,
      },
    ],
    { baseHomeDir: base },
  );
  assert.ok(existsSync(sentinel), "lane B must complete even when lane A fails");
});

test("runLanes: treats a rejected lane as failure without abandoning sibling", async () => {
  const base = tempDir();
  // Create a regular file where lane-x's HOME would go; mkdirSync will throw EEXIST/ENOTDIR.
  writeFileSync(join(base, "lane-x"), "block");
  const sentinel = join(base, "sentinel.txt");

  const code = await runLanes(
    [
      // Lane x: its HOME dir cannot be created (a file blocks it) → runLane throws.
      {
        name: "x",
        commands: [[process.execPath, "-e", "process.exit(0)"]],
        env: cleanLaneEnv,
      },
      // Lane y: must still run to completion.
      {
        name: "y",
        commands: [
          [
            process.execPath,
            "--input-type=module",
            "-e",
            `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "done")`,
          ],
        ],
        env: cleanLaneEnv,
      },
    ],
    { baseHomeDir: base },
  );

  assert.equal(code, 1, "runLanes should return 1 when a lane throws");
  assert.ok(existsSync(sentinel), "sibling lane must complete even when another lane throws");
});

test("runLanes: creates per-lane HOME subdirectories", async () => {
  const base = tempDir();
  await runLanes(
    [
      { name: "x", commands: [[process.execPath, "-e", ""]], env: cleanLaneEnv },
      { name: "y", commands: [[process.execPath, "-e", ""]], env: cleanLaneEnv },
    ],
    { baseHomeDir: base },
  );
  assert.ok(existsSync(join(base, "lane-x")), "lane-x HOME dir should exist");
  assert.ok(existsSync(join(base, "lane-y")), "lane-y HOME dir should exist");
});

test(
  "runLane latches shutdown before a zero-exit command can start its queue",
  { timeout: 20000 },
  async () => {
    const base = tempDir();
    const firstReadyFile = join(base, "queued-first.ready");
    const helperReadyFile = join(base, "queued-helper.ready");
    const firstTermFile = join(base, "queued-first.term");
    const firstPidFile = join(base, "queued-first.pid");
    const queuedFile = join(base, "queued-command.started");
    const completedFile = join(base, "queued-helper.completed");
    const laneHome = join(base, "lane-home");
    const firstCode = [
      `import { writeFileSync } from "node:fs";`,
      `process.on("SIGTERM", () => {`,
      `  writeFileSync(${JSON.stringify(firstTermFile)}, "term");`,
      `  process.exit(0);`,
      `});`,
      `writeFileSync(${JSON.stringify(firstPidFile)}, String(process.pid));`,
      `process.stdout.write("shutdown partial output", () => {`,
      `  writeFileSync(${JSON.stringify(firstReadyFile)}, "ready");`,
      `});`,
      `setInterval(() => {}, 100000);`,
    ].join("\n");
    const queuedCode = [
      `import { writeFileSync } from "node:fs";`,
      `writeFileSync(${JSON.stringify(queuedFile)}, "started");`,
    ].join("\n");
    const helperScript = `
import { existsSync, writeFileSync } from "node:fs";
import { runLane } from ${JSON.stringify(runLanePath)};
const result = runLane(
  {
    name: "queued",
    commands: [
      [process.execPath, "--input-type=module", "-e", ${JSON.stringify(firstCode)}],
      [process.execPath, "--input-type=module", "-e", ${JSON.stringify(queuedCode)}],
    ],
    env: ${JSON.stringify(ownedTestEnv(base))},
  },
  ${JSON.stringify(laneHome)},
);
while (!existsSync(${JSON.stringify(firstReadyFile)})) {
  await new Promise(r => setTimeout(r, 10));
}
await new Promise(r => setImmediate(r));
writeFileSync(${JSON.stringify(helperReadyFile)}, "ready");
const ok = await result;
writeFileSync(${JSON.stringify(completedFile)}, String(ok));
`;

    const helper = spawn(process.execPath, ["--input-type=module", "-e", helperScript], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: ownedTestEnv(base),
    });
    const closePromise = observeClose(helper);
    const stdout = [];
    const stderr = [];
    helper.stdout.on("data", (chunk) => stdout.push(chunk));
    helper.stderr.on("data", (chunk) => stderr.push(chunk));

    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(helperReadyFile)) {
        if (helper.exitCode !== null || helper.signalCode !== null) {
          const result = await awaitWithTimeout(
            closePromise,
            HELPER_CLOSE_TIMEOUT_MS,
            "queued-command helper close",
          );
          throw new Error(
            `queue helper exited before cancellation handshake (code=${result.code}, signal=${result.signal}); ` +
              `stderr=${Buffer.concat(stderr)}`,
          );
        }
        if (Date.now() > deadline) throw new Error("queue helper readiness timed out");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      assert.equal(helper.kill("SIGTERM"), true, "first SIGTERM should be delivered");
      const termDeadline = Date.now() + 5000;
      while (!existsSync(firstTermFile)) {
        if (helper.exitCode !== null || helper.signalCode !== null) {
          throw new Error("helper exited before first TERM evidence was written");
        }
        if (Date.now() > termDeadline) {
          throw new Error("first TERM evidence timed out");
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(helper.kill("SIGTERM"), true, "repeated SIGTERM should be delivered");
      const result = await awaitWithTimeout(
        closePromise,
        HELPER_CLOSE_TIMEOUT_MS,
        "queued-command helper close",
      );
      const output = Buffer.concat(stdout).toString("utf8");
      const evidence = [
        `code=${result.code}`,
        `signal=${result.signal}`,
        `term=${existsSync(firstTermFile)}`,
        `queued=${existsSync(queuedFile)}`,
        `completed=${existsSync(completedFile)}`,
        `stdout=${output}`,
        `stderr=${Buffer.concat(stderr)}`,
      ].join("; ");
      assert.equal(result.signal, null, `queue helper should exit through run-lane; ${evidence}`);
      assert.equal(result.code, 1, `run-lane interruption should return 1; ${evidence}`);
      assert.equal(
        existsSync(firstTermFile),
        true,
        `first command should receive SIGTERM; ${evidence}`,
      );
      assert.equal(existsSync(queuedFile), false, `queued command must not start; ${evidence}`);
      assert.equal(
        (output.match(/interrupted by SIGTERM/g) ?? []).length,
        1,
        `repeated signals must flush exactly one interrupted frame; ${evidence}`,
      );
      assert.match(output, /shutdown partial output/);
    } finally {
      const survivors = await cleanupOwnedPids([helper.pid, readPid(firstPidFile)]);
      assert.deepEqual(survivors, [], "queue fixture processes must not survive cleanup");
    }
  },
);

test(
  "runLanes: real cancellation invokes the timing collector shutdown hook",
  { timeout: 20_000 },
  async () => {
    const base = tempDir();
    const timingDir = mkdtempSync(join(resolve(testDir, ".."), ".tmp-ci-timings-cancel-"));
    _tmpDirs.push(timingDir);
    const commandReady = join(base, "timing-command.ready");
    const helperReady = join(base, "timing-helper.ready");
    const reportPath = join(timingDir, "tlh-ci-timings-real-cancel-1_2.json");
    const repoRoot = resolve(testDir, "..");
    const longCommand = [
      `import { writeFileSync } from "node:fs";`,
      `writeFileSync(${JSON.stringify(commandReady)}, "ready");`,
      `setInterval(() => {}, 100000);`,
    ].join("\n");
    const helperCode = `
import { existsSync, writeFileSync } from "node:fs";
import { createCiTimingCollector, createCiTimingConfig, timingEventFile } from ${JSON.stringify(resolve(repoRoot, "scripts/ci-timings.mjs"))};
import { runLanes } from ${JSON.stringify(runLanePath)};
const config = createCiTimingConfig({
  env: process.env,
  repoRoot: ${JSON.stringify(repoRoot)},
  shard: "1/2",
  runId: "real-cancel",
  availableParallelism: () => 4,
});
if (!config) throw new Error("timing config was unexpectedly disabled");
const timing = createCiTimingCollector(config);
const eventFile = timingEventFile(config, { lane: "a", index: 0, suite: "root" });
const lanesPromise = runLanes(
  [{
    name: "a",
    commands: [[process.execPath, "--input-type=module", "-e", ${JSON.stringify(longCommand)}]],
    env: process.env,
    timingCommands: [{ suite: "root", eventFile }],
  }],
  { baseHomeDir: ${JSON.stringify(base)}, cwd: ${JSON.stringify(repoRoot)} },
  { timing },
);
while (!existsSync(${JSON.stringify(commandReady)})) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
writeFileSync(${JSON.stringify(helperReady)}, "ready");
await lanesPromise;
`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", helperCode], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: ownedTestEnv(base, { TLH_CI_TIMINGS_DIR: timingDir }),
    });
    const closePromise = observeClose(child);
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(helperReady)) {
        if (child.exitCode !== null || child.signalCode !== null) {
          const result = await awaitWithTimeout(
            closePromise,
            HELPER_CLOSE_TIMEOUT_MS,
            "timing cancellation helper close",
          );
          throw new Error(
            `helper exited before cancellation handshake (code=${result.code}, signal=${result.signal}); ` +
              `stderr=${Buffer.concat(stderr)}`,
          );
        }
        if (Date.now() > deadline)
          throw new Error("timing cancellation helper readiness timed out");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      assert.equal(child.kill("SIGTERM"), true, "helper should accept SIGTERM");
      const result = await awaitWithTimeout(
        closePromise,
        HELPER_CLOSE_TIMEOUT_MS,
        "timing cancellation helper close",
      );
      const evidence = `code=${result.code}; signal=${result.signal}; stdout=${Buffer.concat(stdout)}; stderr=${Buffer.concat(stderr)}`;
      assert.equal(result.signal, null, `helper should exit through run-lane; ${evidence}`);
      assert.equal(result.code, 1, `helper should exit with cancellation failure; ${evidence}`);
      assert.equal(existsSync(reportPath), true, `timing report should be written; ${evidence}`);
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      assert.equal(report.status, "cancelled");
      assert.equal(report.cancellationSignal, "SIGTERM");
      assert.equal(report.lanes[0].status, "cancelled");
      assert.equal(report.lanes[0].commands[0].status, "cancelled");
    } finally {
      const survivors = await cleanupOwnedPids([child.pid]);
      assert.deepEqual(survivors, [], "timing cancellation processes must not survive cleanup");
    }
  },
);

// ---------------------------------------------------------------------------
// CI shard temporary-root cleanup
// ---------------------------------------------------------------------------

test("registerTmpdirCleanup removes a shard root idempotently", () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-ci-shard-run-"));
  const baselineExitListeners = process.listenerCount("exit");
  const cleanup = registerTmpdirCleanup(root);

  try {
    assert.equal(process.listenerCount("exit"), baselineExitListeners + 1);

    cleanup();
    assert.equal(
      process.listenerCount("exit"),
      baselineExitListeners,
      "cleanup should remove its exit listener",
    );
    assert.equal(existsSync(root), false, "cleanup should remove the shard root");

    mkdirSync(root);
    cleanup();
    assert.equal(
      existsSync(root),
      true,
      "a second cleanup should not remove a root recreated after the first cleanup",
    );
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "registerTmpdirCleanup defers main cleanup until descendant escalation",
  { timeout: 20000 },
  async () => {
    const base = tempDir();
    const rootMarker = join(base, "child-root.txt");
    const readyMarker = join(base, "child-ready.txt");
    const commandReadyMarker = join(base, "command-ready.txt");
    const commandTermMarker = join(base, "command-term.txt");
    const commandExitMarker = join(base, "command-exit.txt");
    const commandPidMarker = join(base, "command-pid.txt");
    const grandchildPidMarker = join(base, "grandchild-pid.txt");
    const grandchildReadyMarker = join(base, "grandchild-ready.txt");
    const rootMissingMarker = join(base, "root-missing.txt");
    const cleanupStartedMarker = join(base, "cleanup-started.txt");
    const completedMarker = join(base, "child-completed.txt");
    const exitMarker = join(base, "child-exit.txt");
    const crashMarker = join(base, "child-crash.txt");
    let root;
    const longLivedCommand = [
      `import { existsSync, writeFileSync } from "node:fs";`,
      `import { spawn } from "node:child_process";`,
      `process.on("exit", (code) => {`,
      `  writeFileSync(process.env.TLH_CI_SHARD_COMMAND_EXIT_MARKER, String(code));`,
      `});`,
      `process.on("SIGTERM", () => {`,
      `  writeFileSync(process.env.TLH_CI_SHARD_COMMAND_TERM_MARKER, "term");`,
      `  process.exit(0);`,
      `});`,
      `const grandchildCode = [`,
      `  "const { writeFileSync } = require('node:fs');",`,
      `  "process.on('SIGTERM', () => {});",`,
      `  "const heartbeat = () => { try { writeFileSync(process.env.TLH_CI_SHARD_ROOT_HEARTBEAT_MARKER, 'alive'); } catch { try { writeFileSync(process.env.TLH_CI_SHARD_ROOT_MISSING_MARKER, 'missing'); } catch {} } };",`,
      `  "heartbeat();",`,
      `  "setInterval(heartbeat, 10);",`,
      `  "writeFileSync(process.env.TLH_CI_SHARD_GRANDCHILD_READY_MARKER, 'ready');",`,
      `].join("\\n");`,
      `const grandchild = spawn(process.execPath, ["-e", grandchildCode], { stdio: "ignore" });`,
      `writeFileSync(process.env.TLH_CI_SHARD_COMMAND_PID_MARKER, String(process.pid));`,
      `writeFileSync(process.env.TLH_CI_SHARD_GRANDCHILD_PID_MARKER, String(grandchild.pid));`,
      `const deadline = Date.now() + 5000;`,
      `while (!existsSync(process.env.TLH_CI_SHARD_GRANDCHILD_READY_MARKER)) {`,
      `  if (Date.now() > deadline) process.exit(3);`,
      `  await new Promise((resolve) => setTimeout(resolve, 10));`,
      `}`,
      `process.stdout.write("term-exiting leader partial output", () => {`,
      `  writeFileSync(process.env.TLH_CI_SHARD_COMMAND_READY_MARKER, "ready");`,
      `});`,
      `setInterval(() => {}, 100000);`,
    ].join("\n");
    const childCode = [
      `import { existsSync, mkdtempSync, writeFileSync } from "node:fs";`,
      `import { tmpdir } from "node:os";`,
      `import { join } from "node:path";`,
      `import { runLanes } from ${JSON.stringify(runLanePath)};`,
      `import { registerTmpdirCleanup } from ${JSON.stringify(runCiShardPath)};`,
      `process.on("uncaughtExceptionMonitor", (error) => {`,
      `  writeFileSync(process.env.TLH_CI_SHARD_CRASH_MARKER, String(error));`,
      `});`,
      `process.on("exit", (code) => {`,
      `  writeFileSync(process.env.TLH_CI_SHARD_EXIT_MARKER, String(code));`,
      `});`,
      `const root = mkdtempSync(join(tmpdir(), "tlh-ci-shard-run-"));`,
      `writeFileSync(process.env.TLH_CI_SHARD_ROOT_MARKER, root);`,
      `const cleanupTmpdir = registerTmpdirCleanup(root);`,
      `const laneEnv = {`,
      `  ...process.env,`,
      `  TMPDIR: root,`,
      `  TMP: root,`,
      `  TEMP: root,`,
      `  TLH_CI_SHARD_ROOT_HEARTBEAT_MARKER: join(root, "heartbeat.txt"),`,
      `  TLH_CI_SHARD_ROOT_MISSING_MARKER: ${JSON.stringify(rootMissingMarker)},`,
      `};`,
      `let exitCode;`,
      `try {`,
      `  const lanesPromise = runLanes(`,
      `    [{`,
      `      name: "a",`,
      `      commands: [[process.execPath, "--input-type=module", "-e", ${JSON.stringify(longLivedCommand)}]],`,
      `      env: laneEnv,`,
      `    }],`,
      `    { baseHomeDir: root, cwd: process.cwd() },`,
      `  );`,
      `  const deadline = Date.now() + 5000;`,
      `  while (!existsSync(process.env.TLH_CI_SHARD_COMMAND_READY_MARKER)) {`,
      `    if (Date.now() > deadline) throw new Error("command never became ready");`,
      `    await new Promise((resolve) => setTimeout(resolve, 10));`,
      `  }`,
      `  writeFileSync(process.env.TLH_CI_SHARD_READY_MARKER, "ready");`,
      `  exitCode = await lanesPromise;`,
      `  writeFileSync(process.env.TLH_CI_SHARD_COMPLETED_MARKER, String(exitCode));`,
      `} finally {`,
      `  writeFileSync(${JSON.stringify(cleanupStartedMarker)}, "started");`,
      `  cleanupTmpdir();`,
      `}`,
      `process.exitCode = exitCode;`,
    ].join("\n");
    const env = ownedTestEnv(base, {
      TLH_CI_SHARD_ROOT_MARKER: rootMarker,
      TLH_CI_SHARD_READY_MARKER: readyMarker,
      TLH_CI_SHARD_COMMAND_READY_MARKER: commandReadyMarker,
      TLH_CI_SHARD_COMMAND_TERM_MARKER: commandTermMarker,
      TLH_CI_SHARD_COMMAND_EXIT_MARKER: commandExitMarker,
      TLH_CI_SHARD_COMMAND_PID_MARKER: commandPidMarker,
      TLH_CI_SHARD_GRANDCHILD_PID_MARKER: grandchildPidMarker,
      TLH_CI_SHARD_GRANDCHILD_READY_MARKER: grandchildReadyMarker,
      TLH_CI_SHARD_ROOT_MISSING_MARKER: rootMissingMarker,
      TLH_CI_SHARD_COMPLETED_MARKER: completedMarker,
      TLH_CI_SHARD_EXIT_MARKER: exitMarker,
      TLH_CI_SHARD_CRASH_MARKER: crashMarker,
    });
    const child = spawn(process.execPath, ["--input-type=module", "-e", childCode], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const closePromise = observeClose(child);

    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(readyMarker)) {
        if (child.exitCode !== null || child.signalCode !== null) {
          const result = await awaitWithTimeout(
            closePromise,
            HELPER_CLOSE_TIMEOUT_MS,
            "shard-cleanup helper close",
          );
          throw new Error(
            `helper exited before ready marker (code=${result.code}, signal=${result.signal}); ` +
              `stderr: ${Buffer.concat(stderr)}`,
          );
        }
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ready marker; stderr: ${Buffer.concat(stderr)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      root = readFileSync(rootMarker, "utf8").trim();
      assert.equal(child.kill("SIGTERM"), true, "helper should accept SIGTERM");
      const result = await awaitWithTimeout(
        closePromise,
        HELPER_CLOSE_TIMEOUT_MS,
        "shard-cleanup helper close",
      );
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8");
      const exitEvidence = existsSync(exitMarker) ? readFileSync(exitMarker, "utf8") : "missing";
      const commandExitEvidence = existsSync(commandExitMarker)
        ? readFileSync(commandExitMarker, "utf8")
        : "missing";
      const evidence = [
        `ready=${existsSync(readyMarker)}`,
        `commandReady=${existsSync(commandReadyMarker)}`,
        `commandTerm=${existsSync(commandTermMarker)}`,
        `commandExit=${commandExitEvidence}`,
        `grandchildReady=${existsSync(grandchildReadyMarker)}`,
        `rootMissing=${existsSync(rootMissingMarker)}`,
        `cleanupStarted=${existsSync(cleanupStartedMarker)}`,
        `completed=${existsSync(completedMarker)}`,
        `exit=${exitEvidence}`,
        `crash=${existsSync(crashMarker)}`,
        `code=${result.code}`,
        `signal=${result.signal}`,
        `stdout=${output}`,
        `stderr=${errorOutput}`,
      ].join("; ");

      assert.equal(result.signal, null, `helper should exit via run-lane; ${evidence}`);
      assert.equal(result.code, 1, `helper should exit with run-lane's code; ${evidence}`);
      assert.equal(existsSync(crashMarker), false, `helper should not crash; ${evidence}`);
      assert.equal(
        exitEvidence,
        "1",
        `helper exit evidence should record process.exit(1); ${evidence}`,
      );
      assert.equal(
        existsSync(commandTermMarker),
        true,
        `leader should receive SIGTERM and exit 0; ${evidence}`,
      );
      assert.equal(
        existsSync(completedMarker),
        true,
        `leader exit may settle the await during shutdown; ${evidence}`,
      );
      assert.equal(
        readFileSync(completedMarker, "utf8"),
        "1",
        `runLanes should report interruption even though the TERM handler's command exits 0; ${evidence}`,
      );
      assert.equal(
        commandExitEvidence,
        "0",
        `the TERM handler's command should exit 0 before aggregate shutdown failure; ${evidence}`,
      );
      assert.match(output, /term-exiting leader partial output/);
      assert.equal(
        existsSync(cleanupStartedMarker),
        true,
        `main-equivalent finally should run before process exit; ${evidence}`,
      );
      assert.equal(
        existsSync(rootMissingMarker),
        false,
        `main cleanup must not remove the root while the descendant is alive; ${evidence}`,
      );
      assert.equal(
        existsSync(root),
        false,
        `main finally cleanup should remove the shard root; ${evidence}`,
      );
      assert.equal(
        await waitForProcessGone(readPid(grandchildPidMarker)),
        true,
        `SIGKILL escalation should remove the TERM-ignoring descendant; ${evidence}`,
      );
    } finally {
      const rootPath =
        root ?? (existsSync(rootMarker) ? readFileSync(rootMarker, "utf8").trim() : null);
      const survivors = await cleanupOwnedPids([
        child.pid,
        readPid(commandPidMarker),
        readPid(grandchildPidMarker),
      ]);
      assert.deepEqual(survivors, [], "shard signal fixture processes must not survive cleanup");
      if (rootPath) rmSync(rootPath, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// parseShard
// ---------------------------------------------------------------------------

test("parseShard: accepts valid shard 1/2", () => {
  const result = parseShard("1/2");
  assert.equal(result.shard, 1);
  assert.equal(result.shardStr, "1/2");
});

test("parseShard: accepts valid shard 2/2", () => {
  const result = parseShard("2/2");
  assert.equal(result.shard, 2);
  assert.equal(result.shardStr, "2/2");
});

test("parseShard: rejects missing argument", () => {
  assert.throws(() => parseShard(undefined), /Expected <N>\/2/);
});

test("parseShard: rejects wrong total (3/3)", () => {
  assert.throws(() => parseShard("3/3"), /Expected <N>\/2/);
});

test("parseShard: rejects out-of-range shard (3/2)", () => {
  assert.throws(() => parseShard("3/2"), /Shard number must be 1 or 2/);
});

test("parseShard: rejects zero shard (0/2)", () => {
  assert.throws(() => parseShard("0/2"), /Shard number must be 1 or 2/);
});

test("parseLaneLayout: defaults to baseline and accepts experimental", () => {
  assert.equal(parseLaneLayout(undefined), "baseline");
  assert.equal(parseLaneLayout("baseline"), "baseline");
  assert.equal(parseLaneLayout("experimental"), "experimental");
});

test("parseLaneLayout: rejects malformed values", () => {
  assert.throws(() => parseLaneLayout("three-lanes"), /TLH_CI_LANE_LAYOUT/);
  assert.throws(() => parseLaneLayout(""), /TLH_CI_LANE_LAYOUT/);
});

test("parseShardRunnerOptions: validates layout and concurrency before spawning", () => {
  assert.deepEqual(
    parseShardRunnerOptions(["1/2", "--lane-layout", "experimental"], {
      TLH_TEST_CONCURRENCY: "4",
    }),
    { shard: 1, shardStr: "1/2", laneLayout: "experimental" },
  );
  assert.throws(
    () => parseShardRunnerOptions(["1/2"], { [CI_LANE_LAYOUT_ENV]: "invalid" }),
    /TLH_CI_LANE_LAYOUT/,
  );
  assert.throws(
    () => parseShardRunnerOptions(["1/2"], { TLH_TEST_CONCURRENCY: "0" }),
    /TLH_TEST_CONCURRENCY/,
  );
  assert.throws(
    () => parseShardRunnerOptions(["1/2", "--unknown"], {}),
    /Unknown run-ci-test-shard\.mjs option/,
  );
});

// ---------------------------------------------------------------------------
// buildLanes
// ---------------------------------------------------------------------------

test("buildLanes: projects adaptive local and explicit GitHub concurrency", () => {
  const [localLaneA] = buildLanes(1, "1/2", baselineLaneEnv, null, "baseline");
  assert.match(localLaneA.commands[0].join(" "), /--test-concurrency=[1-9]\d*/);

  const [githubLaneA] = buildLanes(
    1,
    "1/2",
    { ...baselineLaneEnv, GITHUB_ACTIONS: "true" },
    null,
    "baseline",
  );
  assert.doesNotMatch(githubLaneA.commands[0].join(" "), /--test-concurrency=/);

  const [overriddenLaneA] = buildLanes(
    1,
    "1/2",
    {
      ...baselineLaneEnv,
      GITHUB_ACTIONS: "true",
      TLH_TEST_CONCURRENCY: "3",
    },
    null,
    "baseline",
  );
  assert.match(overriddenLaneA.commands[0].join(" "), /--test-concurrency=3/);
});

test("CI shard runner reports invalid concurrency overrides without a stack", () => {
  const result = spawnSync(process.execPath, [runCiShardPath, "1/2"], {
    cwd: resolve(testDir, ".."),
    env: scrubTestEnv({ TLH_TEST_CONCURRENCY: "invalid" }),
    encoding: "utf8",
  });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    'Error: TLH_TEST_CONCURRENCY must be a positive integer or unset it; received "invalid".\n',
  );
  assert.doesNotMatch(result.stderr, /\bat /u);
});

test("buildLanes: opt-in timing adds a separate reporter and suite metadata", () => {
  const repoRoot = resolve(testDir, "..");
  const root = mkdtempSync(join(repoRoot, ".tmp-ci-timings-runner-"));
  try {
    const env = scrubLaneEnv({
      TLH_CI_TIMINGS_DIR: join(root, "reports"),
      HOME: join(root, "home"),
      TMPDIR: join(root, "tmp"),
    });
    const config = createCiTimingConfig({
      env,
      repoRoot,
      shard: "1/2",
      runId: "runner-test",
      availableParallelism: () => 4,
    });
    const [laneA, laneB] = buildLanes(1, "1/2", env, config, "baseline");
    const rootCommand = laneA.commands[0].join(" ");
    assert.match(rootCommand, /--test-reporter=dot/);
    assert.match(rootCommand, /ci-timing-reporter\.mjs/);
    assert.match(rootCommand, /--test-reporter-destination=stdout/);
    assert.equal(laneA.env?.[CI_TIMINGS_DIR_ENV], undefined);
    assert.equal(laneA.env?.[CI_TIMINGS_EVENT_FILE_ENV], undefined);
    assert.equal(laneA.commandEnvs?.[0]?.[CI_TIMINGS_DIR_ENV], undefined);
    assert.equal(laneA.commandEnvs?.[0]?.[CI_TIMINGS_EVENT_FILE_ENV], undefined);
    assert.deepEqual(
      laneA.timingCommands?.map((entry) => entry?.suite),
      ["root", "unit", "e2e"],
    );
    assert.deepEqual(
      laneB.timingCommands?.map((entry) => entry?.suite),
      ["integration"],
    );
    assert.match(laneA.commandEnvs?.[1]?.TLH_CI_TIMINGS_EVENT_FILE ?? "", /unit\.events\.jsonl$/);
    assert.match(
      laneB.commandEnvs?.[0]?.TLH_CI_TIMINGS_EVENT_FILE ?? "",
      /integration\.events\.jsonl/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "timed root runner does not leak its event destination to a nested runner",
  { timeout: 120_000 },
  async () => {
    const repoRoot = resolve(testDir, "..");
    const root = mkdtempSync(join(repoRoot, ".tmp-ci-timings-nested-"));
    const reports = join(root, "reports");
    const testFile = join(root, "nested-runner.test.mjs");
    const runnerPath = join(repoRoot, "scripts/run-subagents-tests.mjs");
    writeFileSync(
      testFile,
      [
        'import test from "node:test";',
        'import { spawnSync } from "node:child_process";',
        'test("starts a nested runner without timing output", () => {',
        `  const result = spawnSync(process.execPath, [${JSON.stringify(runnerPath)}, "e2e"], {`,
        `    cwd: ${JSON.stringify(repoRoot)},`,
        "    env: process.env,",
        '    encoding: "utf8",',
        "  });",
        "  if (result.status !== 0) {",
        "    throw new Error(`nested runner failed: ${result.status}\\n${result.stdout}\\n${result.stderr}`);",
        "  }",
        "});",
        "",
      ].join("\n"),
    );
    try {
      mkdirSync(join(root, "home"), { recursive: true });
      mkdirSync(join(root, "tmp"), { recursive: true });
      const env = scrubLaneEnv({
        [CI_TIMINGS_DIR_ENV]: reports,
        HOME: join(root, "home"),
        TMPDIR: join(root, "tmp"),
      });
      const config = createCiTimingConfig({
        env,
        repoRoot,
        shard: "1/2",
        runId: "nested-runner",
        availableParallelism: () => 4,
      });
      assert.ok(config);
      const [laneA] = buildLanes(1, "1/2", env, config, "baseline");
      const rootCommand = [...laneA.commands[0]];
      rootCommand[rootCommand.length - 1] = testFile;
      const output = captureStream();
      const ok = await runLane(
        {
          name: laneA.name,
          commands: [rootCommand],
          env,
          commandEnvs: [laneA.commandEnvs?.[0]],
        },
        join(root, "lane-home"),
        { cwd: repoRoot, stdout: output.stream },
      );
      assert.equal(ok, true, output.content);

      const eventFile = laneA.timingCommands?.[0]?.eventFile;
      assert.ok(eventFile);
      const records = readFileSync(eventFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
      assert.equal(
        records.length,
        1,
        `unexpected timing records: ${readFileSync(eventFile, "utf8")}`,
      );
      assert.equal(records[0].suite, "root");
      assert.equal(records[0].file, relative(repoRoot, testFile).replaceAll("\\", "/"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("inherited experimental layout keeps baseline buildLanes assertions isolated", () => {
  // Run the existing buildLanes assertions in a child so this selector is
  // inherited through process.env. This test name intentionally stays outside
  // the child pattern to avoid recursively spawning itself.
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      "--test-name-pattern",
      "^buildLanes:",
      fileURLToPath(import.meta.url),
    ],
    {
      cwd: resolve(testDir, ".."),
      env: scrubTestEnv({ [CI_LANE_LAYOUT_ENV]: "experimental" }),
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
  assert.equal(
    result.status,
    0,
    `baseline buildLanes assertions failed under inherited experimental layout:\n${output}`,
  );
  assert.match(result.stdout ?? "", /# tests [1-9]\d*/u, output);
});

test("buildLanes: experimental shard 1 uses three isolated lanes", () => {
  const lanes = buildLanes(1, "1/2", { [CI_LANE_LAYOUT_ENV]: "experimental" });
  assert.deepEqual(
    lanes.map((lane) => ({ name: lane.name, commandCount: lane.commands.length })),
    [
      { name: "root", commandCount: 1 },
      { name: "unit", commandCount: 2 },
      { name: "integration", commandCount: 1 },
    ],
  );

  const [rootLane, unitLane, integrationLane] = lanes;
  assert.match(rootLane.commands[0].join(" "), /--test-shard=1\/2/);
  assert.match(unitLane.commands[0].join(" "), /run-subagents-tests\.mjs unit/);
  assert.match(unitLane.commands[0].join(" "), /--test-shard=1\/2/);
  assert.match(unitLane.commands[1].join(" "), /run-subagents-tests\.mjs e2e/);
  assert.doesNotMatch(unitLane.commands[1].join(" "), /--test-shard=/);
  assert.match(integrationLane.commands[0].join(" "), /--test-shard=1\/2/);
});

test("buildLanes: experimental shard 2 keeps unit and integration assignments", () => {
  const lanes = buildLanes(2, "2/2", {}, null, "experimental");
  assert.deepEqual(
    lanes.map((lane) => ({ name: lane.name, commandCount: lane.commands.length })),
    [
      { name: "root", commandCount: 1 },
      { name: "unit", commandCount: 1 },
      { name: "integration", commandCount: 1 },
    ],
  );
  assert.doesNotMatch(
    lanes[1].commands.map((command) => command.join(" ")).join("\n"),
    /run-subagents-tests\.mjs e2e/,
  );
});

test("experimental lanes retain independent HOME directories and sibling failure isolation", async () => {
  const base = tempDir();
  const markers = new Map([
    ["root", join(base, "root-home.txt")],
    ["unit", join(base, "unit-home.txt")],
    ["integration", join(base, "integration-home.txt")],
    ["e2e", join(base, "e2e-ran.txt")],
  ]);
  const writeMarker = (marker, exitCode = 0) => [
    process.execPath,
    "--input-type=module",
    "-e",
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, process.env.HOME); process.exit(${exitCode});`,
  ];
  const definitions = buildLanes(1, "1/2", {}, null, "experimental");
  const lanes = definitions.map((lane) => ({
    ...lane,
    commands:
      lane.name === "unit"
        ? [writeMarker(markers.get("unit"), 1), writeMarker(markers.get("e2e"))]
        : [writeMarker(markers.get(lane.name))],
  }));

  const exitCode = await runLanes(lanes, { baseHomeDir: base });
  assert.equal(exitCode, 1);
  assert.equal(existsSync(markers.get("root")), true);
  assert.equal(existsSync(markers.get("unit")), true);
  assert.equal(existsSync(markers.get("integration")), true);
  assert.equal(existsSync(markers.get("e2e")), false);
  const homes = [
    readFileSync(markers.get("root"), "utf8"),
    readFileSync(markers.get("unit"), "utf8"),
    readFileSync(markers.get("integration"), "utf8"),
  ];
  assert.equal(new Set(homes).size, 3);
});

test("buildLanes: experimental timing metadata follows each lane command", () => {
  const repoRoot = resolve(testDir, "..");
  const root = mkdtempSync(join(repoRoot, ".tmp-ci-timings-experimental-"));
  try {
    const env = scrubLaneEnv({
      [CI_LANE_LAYOUT_ENV]: "experimental",
      TLH_CI_TIMINGS_DIR: join(root, "reports"),
      HOME: join(root, "home"),
      TMPDIR: join(root, "tmp"),
    });
    const config = createCiTimingConfig({
      env,
      repoRoot,
      shard: "1/2",
      laneLayout: "experimental",
      runId: "experimental-runner",
      availableParallelism: () => 4,
    });
    const lanes = buildLanes(1, "1/2", env, config, "experimental");
    assert.deepEqual(
      lanes.map((lane) => lane.name),
      ["root", "unit", "integration"],
    );
    assert.deepEqual(
      lanes.map((lane) => lane.timingCommands?.map((entry) => entry?.suite)),
      [["root"], ["unit", "e2e"], ["integration"]],
    );
    for (const lane of lanes) {
      assert.equal(lane.commandEnvs?.length, lane.commands.length);
      assert.equal(lane.timingCommands?.length, lane.commands.length);
      assert.equal(lane.env?.[CI_TIMINGS_DIR_ENV], undefined);
      assert.equal(lane.env?.[CI_TIMINGS_EVENT_FILE_ENV], undefined);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildLanes: shard 1 includes e2e at end of lane A", () => {
  const [laneA, laneB] = buildLanes(1, "1/2", baselineLaneEnv, null, "baseline");
  assert.equal(laneA.name, "a");
  assert.equal(laneB.name, "b");

  const laneAJoined = laneA.commands.map((c) => c.join(" ")).join("\n");
  assert.match(laneAJoined, /run-subagents-tests\.mjs unit/);
  assert.match(laneAJoined, /run-subagents-tests\.mjs e2e/);
  assert.match(laneAJoined, /--test-shard=1\/2/);

  // e2e must be the last command in lane A
  const lastCmd = laneA.commands.at(-1)?.join(" ") ?? "";
  assert.match(lastCmd, /run-subagents-tests\.mjs e2e/);
});

test("buildLanes: shard 2 does not include e2e", () => {
  const [laneA] = buildLanes(2, "2/2", baselineLaneEnv, null, "baseline");
  const laneAJoined = laneA.commands.map((c) => c.join(" ")).join("\n");
  assert.doesNotMatch(laneAJoined, /run-subagents-tests\.mjs e2e/);
});

test("buildLanes: lane B contains only integration suite", () => {
  for (const shard of [1, 2]) {
    const [, laneB] = buildLanes(shard, `${shard}/2`, baselineLaneEnv, null, "baseline");
    assert.equal(laneB.commands.length, 1);
    const cmd = laneB.commands[0].join(" ");
    assert.match(cmd, /run-subagents-tests\.mjs integration/);
    assert.match(cmd, new RegExp(`--test-shard=${shard}/2`));
  }
});

test("buildLanes: shard parameter flows to all sharded suites", () => {
  for (const shard of [1, 2]) {
    const lanes = buildLanes(shard, `${shard}/2`, baselineLaneEnv, null, "baseline");
    // Every command that is not e2e must carry the shard option.
    for (const lane of lanes) {
      for (const cmd of lane.commands) {
        const joined = cmd.join(" ");
        if (!joined.includes("e2e")) {
          assert.match(
            joined,
            new RegExp(`--test-shard=${shard}/2`),
            `Missing shard option in: ${joined}`,
          );
        }
      }
    }
  }
});

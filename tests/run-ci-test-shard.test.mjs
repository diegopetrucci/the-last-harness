import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildLanes, parseShard } from "../scripts/run-ci-test-shard.mjs";
import { runLane, runLanes, spawnBuffered } from "../scripts/run-lane.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const runLanePath = resolve(testDir, "../scripts/run-lane.mjs");

function tempDir() {
  return mkdtempSync(join(tmpdir(), "tlh-run-lane-test-"));
}

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
  const { ok } = await spawnBuffered([process.execPath, "-e", "process.exit(0)"], process.env);
  assert.equal(ok, true);
});

test("spawnBuffered: resolves ok=false on non-zero exit", async () => {
  const { ok } = await spawnBuffered([process.execPath, "-e", "process.exit(1)"], process.env);
  assert.equal(ok, false);
});

test("spawnBuffered: buffers stdout and writes atomically on completion", async () => {
  const out = captureStream();
  const err = captureStream();
  await spawnBuffered(
    [process.execPath, "-e", "process.stdout.write('hello stdout')"],
    process.env,
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
    process.env,
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
  const env = { ...process.env, TLH_LANE_CANARY: "lane-canary-42" };
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
  await spawnBuffered([process.execPath, "-e", "process.stdout.write('payload')"], process.env, {
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
    process.env,
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
    process.env,
    {
      stdout: out.stream,
      maxBufferBytes: limit,
    },
  );
  assert.match(out.content, /\[TLH\] stderr truncated at 10 bytes/);
});

test("spawnBuffered: does not emit truncation notice when output is within limit", async () => {
  const out = captureStream();
  await spawnBuffered([process.execPath, "-e", "process.stdout.write('small')"], process.env, {
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
  await spawnBuffered([process.execPath, "-e", code], process.env, {
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
      },
      {
        name: "beta",
        commands: [[process.execPath, "-e", "process.stderr.write('beta-stderr-payload')"]],
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
  { timeout: 15000 },
  async () => {
    const base = tempDir();
    const readyFile = join(base, "ready.txt");
    // parentReadyFile is written by the helperScript after it has confirmed the data
    // is buffered, providing a deterministic signal to the test (no wall-clock waits).
    const parentReadyFile = join(base, "parent-ready.txt");

    // Child writes its output and signals readiness in the write callback so readyFile
    // is only created after the data is in the pipe buffer.
    const childCode = [
      `import { writeFileSync } from "node:fs";`,
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
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks = [];
    proc.stdout.on("data", (c) => stdoutChunks.push(c));

    try {
      // Wait for the helperScript's deterministic "data buffered" signal.
      const deadline = Date.now() + 10000;
      while (!existsSync(parentReadyFile)) {
        if (Date.now() > deadline) {
          throw new Error("Timed out waiting for parent readiness signal");
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      proc.kill("SIGTERM");
      await new Promise((r) => proc.on("close", r));

      const output = Buffer.concat(stdoutChunks).toString("utf8");
      assert.match(
        output,
        /partial output from child/,
        `Signal handler should flush buffered output; got: ${output}`,
      );
    } finally {
      // Ensure the helper process cannot outlive this test even on assertion failure.
      if (proc.exitCode === null && !proc.killed) {
        proc.kill("SIGKILL");
        await new Promise((r) => proc.on("close", r));
      }
    }
  },
);

// ---------------------------------------------------------------------------
// runLane
// ---------------------------------------------------------------------------

test("runLane: creates the lane HOME directory", async () => {
  const base = tempDir();
  const laneHome = join(base, "lane-home-create");
  await runLane({ name: "create", commands: [[process.execPath, "-e", ""]] }, laneHome);
  assert.ok(existsSync(laneHome), "lane HOME dir should be created");
});

test("runLane: sets HOME env var for all commands in the lane", async () => {
  const base = tempDir();
  const laneHome = join(base, "lane-home-env");
  const out = captureStream();
  await runLane(
    { name: "env", commands: [[process.execPath, "-e", "process.stdout.write(process.env.HOME)"]] },
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
      env: { TLH_LANE_VAR: "custom-value" },
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
    },
    laneHome,
  );
  assert.equal(ok, true);
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
      },
      {
        name: "b",
        commands: [[process.execPath, "--input-type=module", "-e", pollCode(markerB, markerA)]],
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
      { name: "a", commands: [[process.execPath, "-e", "process.exit(0)"]] },
      { name: "b", commands: [[process.execPath, "-e", "process.exit(0)"]] },
    ],
    { baseHomeDir: base },
  );
  assert.equal(code, 0);
});

test("runLanes: returns 1 when any lane fails", async () => {
  const base = tempDir();
  const code = await runLanes(
    [
      { name: "a", commands: [[process.execPath, "-e", "process.exit(1)"]] },
      { name: "b", commands: [[process.execPath, "-e", "process.exit(0)"]] },
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
      { name: "fail", commands: [[process.execPath, "-e", "process.exit(1)"]] },
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
      { name: "x", commands: [[process.execPath, "-e", "process.exit(0)"]] },
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
      { name: "x", commands: [[process.execPath, "-e", ""]] },
      { name: "y", commands: [[process.execPath, "-e", ""]] },
    ],
    { baseHomeDir: base },
  );
  assert.ok(existsSync(join(base, "lane-x")), "lane-x HOME dir should exist");
  assert.ok(existsSync(join(base, "lane-y")), "lane-y HOME dir should exist");
});

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

// ---------------------------------------------------------------------------
// buildLanes
// ---------------------------------------------------------------------------

test("buildLanes: shard 1 includes e2e at end of lane A", () => {
  const [laneA, laneB] = buildLanes(1, "1/2");
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
  const [laneA] = buildLanes(2, "2/2");
  const laneAJoined = laneA.commands.map((c) => c.join(" ")).join("\n");
  assert.doesNotMatch(laneAJoined, /run-subagents-tests\.mjs e2e/);
});

test("buildLanes: lane B contains only integration suite", () => {
  for (const shard of [1, 2]) {
    const [, laneB] = buildLanes(shard, `${shard}/2`);
    assert.equal(laneB.commands.length, 1);
    const cmd = laneB.commands[0].join(" ");
    assert.match(cmd, /run-subagents-tests\.mjs integration/);
    assert.match(cmd, new RegExp(`--test-shard=${shard}/2`));
  }
});

test("buildLanes: shard parameter flows to all sharded suites", () => {
  for (const shard of [1, 2]) {
    const lanes = buildLanes(shard, `${shard}/2`);
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

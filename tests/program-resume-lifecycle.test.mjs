// Real-Pi lifecycle tests for the tlh OSC 7577 resume bridge (GitHub issue #934).
//
// Runs the pinned upstream Pi CLI under `node --import scripts/tlh-program-resume-preload.mjs` inside a
// pty, with a test-generated terminal token, a temp agent dir and a faux model provider supplied by an
// extension in <agent>/extensions. Every OSC 7577 frame on the raw pty bytes is verified with the real
// token. Skips only when no python3 pty is available (the pty bridge needs it).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import {
  PiPty,
  createWorkspace,
  delay,
  hasPty,
  readEvents,
  sessionFiles,
  waitFor,
  writeFixtureSession,
} from "./program-resume-lifecycle-helpers.mjs";

const CASE_TIMEOUT = 90_000;
const skip = hasPty ? false : "python3 with a working pty module is required to drive real Pi";

/**
 * Global invariant for every run: no frame that verifies with the real token reports argv0 `pi` or
 * carries --agent-dir, and every verified frame is signed for Pi's own pid.
 */
function assertNoPiFrames(pty) {
  for (const frame of pty.verified()) {
    assert.equal(frame.pid, pty.pid, "verified frame must carry Pi's pid");
    if (frame.kind === "report") {
      assert.notEqual(frame.argv[0], "pi");
      assert.ok(!frame.argv.includes("--agent-dir"), `unexpected --agent-dir in ${frame.argv}`);
    }
  }
  const raw = pty.raw().toString("latin1");
  assert.ok(!raw.includes(pty.token), "real token must never appear in terminal output");
}

/** Start a workspace + Pi run with guaranteed teardown (kill on failure, temp dir removal). */
async function launch(t, args, { sessions = 0, env, extensions = true } = {}) {
  const workspace = createWorkspace();
  const ids = [];
  for (let index = 0; index < sessions; index += 1) {
    ids.push(writeFixtureSession(workspace, 120 - index * 60));
  }
  const pty = new PiPty(workspace, args(ids), { env });
  t.after(async () => {
    try {
      await pty.dispose();
      assertNoPiFrames(pty);
    } finally {
      workspace.cleanup();
    }
  });
  await pty.ready({ extensions });
  return { workspace, pty, ids };
}

const report = (uuid, workspace) => ({
  kind: "report",
  argv: ["tlh", "--session", uuid],
  cwd: workspace.cwd,
});
const strip = (frames) =>
  frames.map(({ kind, argv, cwd }) => (kind === "clear" ? { kind } : { kind, argv, cwd }));
const clear = { kind: "clear" };
const quit = async (pty) => {
  pty.send("\x04");
  assert.equal(await pty.waitForExit(), 0);
};

test(
  "startup on a fixture session reports exactly tlh --session <uuid> with the session cwd",
  { skip, timeout: CASE_TIMEOUT },
  async (t) => {
    const { workspace, pty, ids } = await launch(t, ([id]) => ["--session", id], { sessions: 1 });
    await waitFor(() => pty.verified().length >= 1, "startup report");
    await delay(500);
    assert.deepEqual(strip(pty.verified()), [report(ids[0], workspace)]);
    // The Pi process presents itself as the wrapper command, not `pi`.
    assert.equal(pty.psArgs().split(/\s+/)[0], "tlh");
    // Pi's own decoy-signed frame never reaches the terminal verifiable: every frame that parses is real.
    assert.ok(pty.frames().every((frame) => frame.verified));
    await quit(pty);
  },
);

test(
  "fresh start reports only after the first message is answered, user quit clears",
  { skip, timeout: CASE_TIMEOUT },
  async (t) => {
    const { workspace, pty } = await launch(t, () => []);
    await delay(500);
    assert.deepEqual(pty.frames(), [], "no frame before any session file exists");
    assert.equal(sessionFiles(workspace).length, 0);
    await pty.type("hello one");
    await waitFor(() => readEvents(workspace).includes("agent_end"), "faux reply");
    await waitFor(() => pty.verified().length >= 1, "first report");
    const [file] = sessionFiles(workspace);
    assert.ok(file, "session file exists once the first message is written");
    const uuid = /_([0-9a-f-]{36})\.jsonl$/.exec(file)[1];
    assert.deepEqual(strip(pty.verified()), [report(uuid, workspace)]);
    await quit(pty);
    assert.deepEqual(strip(pty.verified()), [report(uuid, workspace), clear]);
  },
);

test(
  "/new clears, then the next message reports the new session",
  { skip, timeout: CASE_TIMEOUT },
  async (t) => {
    const { workspace, pty } = await launch(t, () => []);
    await pty.type("hello one");
    await waitFor(() => pty.verified().length >= 1, "first report");
    const first = pty.verified()[0].argv[2];
    await pty.type("/new");
    await waitFor(() => pty.verified().length >= 2, "clear after /new");
    assert.deepEqual(pty.verified()[1], { ...clear, pid: pty.pid });
    await delay(500);
    assert.equal(pty.verified().length, 2, "nothing reported for a session without a file");
    await pty.type("hello two");
    await waitFor(() => pty.verified().length >= 3, "report for the new session");
    const next = pty.verified()[2];
    assert.equal(next.kind, "report");
    assert.notEqual(next.argv[2], first);
    assert.deepEqual(strip([next]), [report(next.argv[2], workspace)]);
    assert.equal(sessionFiles(workspace).length, 2);
    await quit(pty);
  },
);

test(
  "/resume into another session reports the new uuid",
  { skip, timeout: CASE_TIMEOUT },
  async (t) => {
    // ids[0] is the older session we start in; ids[1] is the most recent and is the selector's first row.
    const { workspace, pty, ids } = await launch(t, ([older]) => ["--session", older], {
      sessions: 2,
    });
    await waitFor(() => pty.verified().length >= 1, "startup report");
    await pty.type("/resume");
    await waitFor(() => /Resume Session/.test(pty.text()), "resume selector");
    await delay(500);
    pty.send("\r");
    await waitFor(() => pty.verified().length >= 2, "report after /resume");
    assert.deepEqual(strip(pty.verified()), [report(ids[0], workspace), report(ids[1], workspace)]);
    await quit(pty);
  },
);

test(
  "/fork into another session reports the forked uuid",
  { skip, timeout: CASE_TIMEOUT },
  async (t) => {
    const { workspace, pty, ids } = await launch(t, ([id]) => ["--session", id], { sessions: 1 });
    await waitFor(() => pty.verified().length >= 1, "startup report");
    await pty.type("/fork");
    await waitFor(() => /Message 2 of 2/.test(pty.text()), "fork selector");
    await delay(500);
    pty.send("\r"); // the selector starts on the last user message
    await waitFor(() => pty.verified().length >= 2, "report after /fork");
    const forked = pty.verified()[1];
    assert.equal(forked.kind, "report");
    assert.notEqual(forked.argv[2], ids[0]);
    assert.deepEqual(strip([forked]), [report(forked.argv[2], workspace)]);
    assert.equal(sessionFiles(workspace).length, 2);
    pty.send("\x15"); // fork refills the editor with the forked message; empty it so Ctrl+D quits
    await delay(200);
    await quit(pty);
  },
);

test(
  "Ctrl+Z then SIGCONT reports the same command again",
  { skip, timeout: CASE_TIMEOUT },
  async (t) => {
    const { workspace, pty, ids } = await launch(t, ([id]) => ["--session", id], { sessions: 1 });
    await waitFor(() => pty.verified().length >= 1, "startup report");
    await delay(300);
    pty.send("\x1a");
    const stopped = () =>
      spawnSync("ps", ["-o", "stat=", "-p", String(pty.pid)], { encoding: "utf8" }).stdout.includes(
        "T",
      );
    await waitFor(stopped, "Pi to stop on Ctrl+Z");
    assert.equal(pty.verified().length, 1, "suspending reports nothing");
    pty.signal("SIGCONT");
    await waitFor(() => pty.verified().length >= 2, "report after resume");
    assert.deepEqual(strip(pty.verified()), [report(ids[0], workspace), report(ids[0], workspace)]);
    await quit(pty);
  },
);

for (const signal of ["SIGHUP", "SIGTERM"]) {
  test(
    `${signal} leaves the last report in place (no clear)`,
    { skip, timeout: CASE_TIMEOUT },
    async (t) => {
      const { workspace, pty, ids } = await launch(t, ([id]) => ["--session", id], { sessions: 1 });
      await waitFor(() => pty.verified().length >= 1, "startup report");
      await delay(300);
      pty.signal(signal);
      await pty.waitForExit();
      await delay(200);
      assert.deepEqual(strip(pty.verified()), [report(ids[0], workspace)]);
    },
  );
}

for (const flags of [["-ne"], ["-t", "read"], ["--approve"]]) {
  test(
    `launched with ${flags.join(" ")} only ever clears`,
    { skip, timeout: CASE_TIMEOUT },
    async (t) => {
      const { pty } = await launch(t, ([id]) => ["--session", id, ...flags], {
        sessions: 1,
        extensions: !flags.includes("-ne"),
      });
      await waitFor(() => pty.verified().length >= 1, "startup frame");
      await delay(500);
      pty.send("\x04");
      await pty.waitForExit();
      const frames = pty.verified();
      assert.ok(frames.length >= 1);
      assert.ok(
        frames.every((frame) => frame.kind === "clear"),
        JSON.stringify(frames),
      );
    },
  );
}

test(
  "a bash tool child sees neither the real token nor Pi's decoy",
  { skip, timeout: CASE_TIMEOUT },
  async (t) => {
    const { workspace, pty } = await launch(t, () => []);
    const outDir = join(workspace.root, "it's a dir");
    mkdirSync(outDir);
    const out = join(outDir, "bash env.txt");
    await pty.type(`BASHPLEASE:${out}`);
    await waitFor(() => readEvents(workspace).includes("agent_end"), "tool run to finish");
    assert.ok(existsSync(out), "the faux model's bash tool call ran");
    const env = readFileSync(out, "utf8");
    assert.ok(
      env.includes(`PI_CODING_AGENT_DIR=${workspace.agentDir}`),
      "env dump is from the real child",
    );
    assert.ok(!env.includes(pty.token), "real token leaked to a child");
    assert.ok(!/OSC7577_TOKEN/.test(env), "no token variable in a child");
    assert.ok(!/TLH_PROGRAM_RESUME_ACTIVE/.test(env), "marker leaked to a child");
    await waitFor(() => pty.verified().length >= 1, "report after tool turn");
    await quit(pty);
  },
);

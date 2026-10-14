/**
 * OSC 7501 child records for background subagents: emission, titles, id
 * sanitization, clear on removal, cap, dedup, gating, shutdown, and Herdr/cmux
 * not re-running for agent-name-only snapshot changes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  createProgramStatusActivityReporter,
  createCmuxActivityReporter,
  createHerdrActivityReporter,
} = await jiti.import("../extensions/the-last-harness/activity-reporters.ts");
const { createTlhEffectiveActivityTracker } = await jiti.import(
  "../extensions/the-last-harness/activity-tracker.ts",
);

const b64 = (t) => Buffer.from(t).toString("base64");
const osc = (f) => `\x1b]7501;${f}\x1b\\`;
const working = (id, title) =>
  osc(`state=working:id=${id}${title === undefined ? "" : `:title=${b64(title)}`}`);
const clear = (id) => osc(`state=clear:id=${id}`);
const rootMsg = (n) => osc(`state=working:app=tlh:msg=${b64(`${n} subagents running`)}`);
const rootMsg1 = osc(`state=working:app=tlh:msg=${b64("1 subagent running")}`);

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
};

function setup({ env = {}, isTTY = true, mode = "tui" } = {}) {
  const writes = [];
  const output = { isTTY, write: (d) => writes.push(d) };
  const reporter = createProgramStatusActivityReporter({ env, output, idleDebounceMs: 0 });
  reporter.handleSessionStart({
    mode,
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => "s" },
  });
  return { reporter, writes };
}

async function emit(ctx, ids, agents) {
  ctx.reporter.handleSnapshot({
    inProgress: ids.length > 0,
    waitingForUser: false,
    primaryReasons: [],
    activeAsyncJobIds: ids,
    ...(agents ? { activeAsyncJobAgents: agents } : {}),
  });
  await settle();
}

test("child working record with title, parallel title, and missing agent name", async () => {
  const ctx = setup();
  await emit(ctx, ["r1", "r2", "r3"], { r1: ["worker"], r2: ["scout", "reviewer"] });
  assert.deepEqual(ctx.writes, [
    rootMsg(4),
    working("subagent/r1", "worker"),
    working("subagent/r2", "scout+reviewer"),
    working("subagent/r3", undefined),
  ]);
  assert.ok(ctx.writes.every((w) => !w.includes("app=tlh") || !w.includes("id=")));
});

test("parallel same-name agents are counted separately in title and root msg", async () => {
  const ctx = setup();
  await emit(ctx, ["r1"], { r1: ["worker", "worker"] });
  assert.deepEqual(ctx.writes, [rootMsg(2), working("subagent/r1", "worker+worker")]);
});

test("runId is sanitized; unfixable ids are skipped but still counted in root msg", async () => {
  const ctx = setup();
  await emit(ctx, ["", "a b/c", "x".repeat(60)], {});
  assert.deepEqual(ctx.writes, [
    rootMsg(3),
    working("subagent/a-b-c", undefined),
    working(`subagent/${"x".repeat(32)}`, undefined),
  ]);
});

test("child clear on removal; unchanged snapshots and root do not repeat records", async () => {
  const ctx = setup();
  await emit(ctx, ["r1", "r2"], { r1: ["a"] });
  await emit(ctx, ["r1", "r2"], { r1: ["a"] });
  await emit(ctx, ["r1"], { r1: ["a"] });
  await emit(ctx, ["r1"], { r1: ["b"] });
  assert.deepEqual(ctx.writes, [
    rootMsg(2),
    working("subagent/r1", "a"),
    working("subagent/r2", undefined),
    rootMsg1,
    clear("subagent/r2"),
    working("subagent/r1", "b"),
  ]);
});

test("caps child records at 32 lowest sorted runIds; extras still count in root msg", async () => {
  const ctx = setup();
  const ids = Array.from({ length: 40 }, (_, i) => `r${String(i).padStart(2, "0")}`);
  await emit(ctx, ids);
  assert.equal(ctx.writes[0], rootMsg(40));
  const kids = ctx.writes.slice(1);
  assert.equal(kids.length, 32);
  assert.equal(kids[0], working("subagent/r00"));
  assert.equal(kids[31], working("subagent/r31"));
  // Dropping a low id promotes the next one over the cap.
  await emit(ctx, ids.slice(1));
  assert.deepEqual(ctx.writes.slice(33), [
    rootMsg(39),
    clear("subagent/r00"),
    working("subagent/r32"),
  ]);
});

test("no child output without TTY, with TLH_PROGRAM_STATUS=0, or for non-root sessions", async () => {
  for (const opts of [{ isTTY: false }, { env: { TLH_PROGRAM_STATUS: "0" } }, { mode: "rpc" }]) {
    const ctx = setup(opts);
    await emit(ctx, ["r1"], { r1: ["w"] });
    assert.deepEqual(ctx.writes, []);
  }
});

test("task text never appears; shutdown keeps the single global clear", async () => {
  const ctx = setup();
  await emit(ctx, ["r1"], { r1: ["worker"] });
  ctx.reporter.handleSessionShutdown();
  await settle();
  assert.deepEqual(ctx.writes, [rootMsg1, working("subagent/r1", "worker"), osc("state=clear")]);
});

test("tracker re-notifies when agent names arrive late; Herdr and cmux send no extra requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-psch-"));
  const asyncDir = join(root, "r1");
  mkdirSync(asyncDir);
  writeFileSync(
    join(asyncDir, "status.json"),
    JSON.stringify({ state: "running", pid: process.pid }),
  );
  const tracker = createTlhEffectiveActivityTracker({ checkPidLiveness: () => "alive" });
  const snapshots = [];
  tracker.subscribe((s) => snapshots.push(s));
  try {
    tracker.handleAsyncStarted({ id: "r1", asyncDir });
    tracker.handleAsyncStarted({ id: "r1", asyncDir, agent: "worker" });
  } finally {
    tracker.dispose();
    rmSync(root, { recursive: true, force: true });
  }
  const withJobs = snapshots.filter((s) => s.activeAsyncJobIds.length > 0);
  assert.deepEqual(
    withJobs.map((s) => s.activeAsyncJobAgents?.r1),
    [undefined, ["worker"]],
  );

  const commands = [];
  const cmux = createCmuxActivityReporter({
    env: { CMUX_WORKSPACE_ID: "w", CMUX_SURFACE_ID: "s", CMUX_BIN: "cmux" },
    runner: async (command, args) => commands.push([command, ...args]),
    idleDebounceMs: 0,
  });
  const requests = [];
  const herdr = createHerdrActivityReporter({
    env: {
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_PANE_ID: "pane-1",
      HERDR_TLH_HEARTBEAT_MS: "0",
    },
    agentDir: "/nonexistent-tlh-agent-dir",
    sendRequest: async (r) => requests.push(r),
    idleDebounceMs: 0,
  });
  const sm = { getSessionFile: () => undefined, getSessionId: () => "x" };
  for (const r of [cmux, herdr]) r.handleSessionStart({ mode: "tui", sessionManager: sm });
  for (const s of withJobs) {
    cmux.handleSnapshot(s);
    herdr.handleSnapshot(s);
  }
  await settle();
  assert.equal(commands.length, 1);
  assert.equal(requests.filter((r) => r.method === "pane.report_agent").length, 1);
  cmux.dispose();
  herdr.dispose();
});

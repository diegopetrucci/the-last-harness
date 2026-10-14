/**
 * OSC 7501 root record msg: per-state mapping, precedence, rename re-emit,
 * dedup on the full report, and unchanged opt-out / non-TTY / clear behavior.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createProgramStatusActivityReporter, createCmuxActivityReporter } = await jiti.import(
  "../extensions/the-last-harness/activity-reporters.ts",
);
const { createTlhEffectiveActivityTracker } = await jiti.import(
  "../extensions/the-last-harness/activity-tracker.ts",
);

const b64 = (t) => Buffer.from(t).toString("base64");
// msg values are base64-encoded on the wire (see formatProgramStatusReport).
const seq = (fields) =>
  `\x1b]7501;${fields.replace(/msg=(.*)$/, (_m, t) => `msg=${b64(t)}`)}\x1b\\`;
const clearSeq = seq("state=clear");

function setup({ name, env = {}, isTTY = true } = {}) {
  const writes = [];
  const output = { isTTY, write: (d) => writes.push(d) };
  const session = { name };
  const sessionManager = {
    getSessionFile: () => undefined,
    getSessionId: () => "s",
    getSessionName: () => session.name,
  };
  const reporter = createProgramStatusActivityReporter({ env, output, idleDebounceMs: 0 });
  reporter.handleSessionStart({ mode: "tui", sessionManager });
  return { reporter, writes, session, sessionManager };
}

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
};

async function emit(ctx, snapshot) {
  ctx.reporter.handleSnapshot({
    inProgress: false,
    waitingForUser: false,
    primaryReasons: [],
    activeAsyncJobIds: [],
    ...snapshot,
  });
  await settle();
}

const primary = { inProgress: true, runActive: true, primaryReasons: ["primary:agent-loop"] };

test("working msg: session name; compaction takes precedence", async () => {
  const ctx = setup({ name: "My Session" });
  await emit(ctx, primary);
  await emit(ctx, { ...primary, compacting: true, primaryReasons: ["primary:compaction:x"] });
  assert.deepEqual(ctx.writes, [
    seq("state=working:app=tlh:msg=My Session"),
    seq("state=working:app=tlh:msg=Compacting context"),
  ]);
});

test("working msg: async-only subagents count agents (1 per job when unknown)", async () => {
  const ctx = setup({ name: "Named" });
  const rootOnly = (writes) => writes.filter((w) => !w.includes("id=subagent/"));
  await emit(ctx, {
    inProgress: true,
    activeAsyncJobIds: ["a"],
    activeAsyncJobAgents: { a: ["w"] },
  });
  await emit(ctx, { inProgress: true, activeAsyncJobIds: ["a", "b"] });
  await emit(ctx, {
    inProgress: true,
    activeAsyncJobIds: ["a", "b"],
    activeAsyncJobAgents: { a: ["scout", "worker", "reviewer"] },
  });
  assert.deepEqual(rootOnly(ctx.writes), [
    seq("state=working:app=tlh:msg=1 subagent running"),
    seq("state=working:app=tlh:msg=2 subagents running"),
    seq("state=working:app=tlh:msg=4 subagents running"),
  ]);
});

test("blocked msg: prompt title when present, omitted otherwise", async () => {
  const ctx = setup({ name: "Named" });
  await emit(ctx, {
    ...primary,
    waitingForUser: true,
    waitingForUserKind: "confirm",
    waitingForUserTitle: "Approve change?",
  });
  await emit(ctx, { ...primary, waitingForUser: true, waitingForUserKind: "custom" });
  assert.deepEqual(ctx.writes, [
    seq("state=blocked:app=tlh:kind=permission:msg=Approve change?"),
    seq("state=blocked:app=tlh:kind=question"),
  ]);
});

test("done msg is session name; error msg is first error line; idle has none", async () => {
  const ctx = setup({ name: "Named" });
  await emit(ctx, { lastRunOutcome: "completed" });
  await emit(ctx, { lastRunOutcome: "error", lastRunErrorLine: "Boom" });
  await emit(ctx, { lastRunOutcome: "aborted" });
  assert.deepEqual(ctx.writes, [
    seq("state=done:app=tlh:msg=Named"),
    seq("state=error:app=tlh:msg=Boom"),
    seq("state=idle:app=tlh"),
  ]);
});

test("unnamed session emits no msg", async () => {
  const ctx = setup({ name: "   " });
  await emit(ctx, primary);
  await emit(ctx, { lastRunOutcome: "completed" });
  assert.deepEqual(ctx.writes, [seq("state=working:app=tlh"), seq("state=done:app=tlh")]);
});

test("rename re-emits with the new name; identical reports are deduped", async () => {
  const ctx = setup({});
  await emit(ctx, primary);
  await emit(ctx, primary);
  ctx.session.name = "Renamed";
  ctx.reporter.handleSessionInfoChanged?.({ sessionManager: ctx.sessionManager });
  await settle();
  ctx.reporter.handleSessionInfoChanged?.({ sessionManager: ctx.sessionManager });
  await settle();
  assert.deepEqual(ctx.writes, [
    seq("state=working:app=tlh"),
    seq("state=working:app=tlh:msg=Renamed"),
  ]);
});

test("rename before any snapshot emits nothing", async () => {
  const ctx = setup({});
  ctx.session.name = "Early";
  ctx.reporter.handleSessionInfoChanged?.({ sessionManager: ctx.sessionManager });
  await settle();
  assert.deepEqual(ctx.writes, []);
});

test("shutdown still clears globally; opt-out and non-TTY stay silent", async () => {
  const ctx = setup({ name: "N" });
  await emit(ctx, primary);
  ctx.reporter.handleSessionShutdown();
  await settle();
  assert.equal(ctx.writes.at(-1), clearSeq);
  ctx.reporter.handleSessionInfoChanged?.({ sessionManager: ctx.sessionManager });
  await settle();
  assert.equal(ctx.writes.length, 2);

  for (const opts of [{ env: { TLH_PROGRAM_STATUS: "0" } }, { isTTY: false }]) {
    const quiet = setup({ name: "N", ...opts });
    await emit(quiet, primary);
    quiet.reporter.handleSessionInfoChanged?.({ sessionManager: quiet.sessionManager });
    quiet.reporter.handleSessionShutdown();
    await settle();
    assert.deepEqual(quiet.writes, []);
  }
});

test("tracker re-notifies on nested prompt title change; cmux does not re-run", async () => {
  const tracker = createTlhEffectiveActivityTracker();
  const snapshots = [];
  tracker.subscribe((s) => snapshots.push(s));
  tracker.handleUIPromptStart({ kind: "select", title: "First" });
  tracker.handleUIPromptStart({ kind: "select", title: "Second" });
  assert.deepEqual(
    snapshots.map((s) => s.waitingForUserTitle),
    ["First", "Second"],
  );

  const commands = [];
  const cmux = createCmuxActivityReporter({
    env: { CMUX_WORKSPACE_ID: "w", CMUX_SURFACE_ID: "s", CMUX_BIN: "cmux" },
    runner: async (command, args) => commands.push([command, ...args]),
    idleDebounceMs: 0,
  });
  cmux.handleSessionStart({
    mode: "tui",
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => "x" },
  });
  for (const s of snapshots) cmux.handleSnapshot(s);
  await settle();
  assert.equal(commands.length, 1);
  cmux.dispose();
});

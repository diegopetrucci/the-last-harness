import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { createFakeTimers } from "./support/fake-timers.mjs";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = mkdtempSync(join(tmpdir(), "tlh-notify-tmux-agent-"));
mkdirSync(join(agentDir, "extensions"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url);
const { createNotifyExtension } = await jiti.import("../extensions/notify/index.ts");

async function capture(backend, env) {
  writeFileSync(
    join(agentDir, "extensions", "notify.json"),
    JSON.stringify({
      terminal: { backend },
      channels: { terminal: true, desktop: false, bell: false, sound: false },
      suppressWhileActive: false,
    }),
  );
  const timers = createFakeTimers();
  const handlers = new Map();
  const writes = [];
  createNotifyExtension({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    settleDebounceMs: 10,
    terminalWrite: (s) => writes.push(s),
    env,
  })({
    on: (name, h) => handlers.set(name, h),
    events: { on: () => () => {} },
  });
  handlers.get("agent_settled")(
    {},
    { cwd: tmpdir(), hasUI: true, isProjectTrusted: () => false, isIdle: () => true },
  );
  await timers.advanceAsync(10);
  return writes;
}

const wrap = (s) => `\x1bPtmux;${s.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
const osc777 = (w) => w.filter((s) => s.includes("]777;"));

for (const [backend, raw] of [
  ["osc777", [`\x1b]777;notify;Pi;Waiting for input\x07`]],
  ["osc99", [`\x1b]99;i=1:d=0;Pi\x1b\\`, `\x1b]99;i=1:p=body;Waiting for input\x1b\\`]],
]) {
  test(`${backend} is unchanged outside tmux`, async () => {
    const writes = await capture(backend, {});
    assert.equal(writes.length, raw.length);
    writes.forEach((w, i) =>
      assert.equal(
        w.slice(0, raw[i].indexOf(";", 6) + 1),
        raw[i].slice(0, raw[i].indexOf(";", 6) + 1),
      ),
    );
    for (const w of writes) assert.ok(!w.startsWith("\x1bPtmux;"));
  });

  test(`${backend} is passthrough-wrapped inside tmux`, async () => {
    const plain = await capture(backend, {});
    const writes = await capture(backend, { TMUX: "/tmp/tmux-1/default,1,0" });
    assert.deepEqual(writes, plain.map(wrap));
  });
}

test("osc777 sequence shape", async () => {
  const writes = await capture("osc777", {});
  assert.equal(osc777(writes).length, 1);
  assert.ok(writes[0].startsWith("\x1b]777;notify;"));
  assert.ok(writes[0].endsWith("\x07"));
});

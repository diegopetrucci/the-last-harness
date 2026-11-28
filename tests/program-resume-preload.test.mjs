import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  formatProgramResume,
  formatProgramResumeClear,
  takeProgramResumeToken,
} from "@earendil-works/pi-tui";

const PRELOAD = join(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/tlh-program-resume-preload.mjs",
);
const REAL = "real-token-0123456789abcdef";
const AGENT_DIR = "/home/u/.the-last-harness/agent";
const UUID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const TIME = 1700000000123;

const activeEnv = (extra = {}) => ({
  OSC7577_TOKEN: REAL,
  TLH_PROGRAM_RESUME_ACTIVE: "1",
  TLH_RUNTIME_WRAPPER_NAME: "tlh",
  PI_CODING_AGENT_DIR: AGENT_DIR,
  ...extra,
});

function run(script, env, { preload = true } = {}) {
  const base = { ...process.env };
  for (const key of ["OSC7577_TOKEN", "TLH_PROGRAM_RESUME_ACTIVE", "TLH_RUNTIME_WRAPPER_NAME"]) {
    delete base[key];
  }
  const args = [...(preload ? ["--import", PRELOAD] : []), "-e", script];
  const result = spawnSync(process.execPath, args, {
    env: { ...base, ...env },
    encoding: "buffer",
  });
  assert.equal(result.status, 0, result.stderr.toString());
  return result;
}

const sign = (token, pid) => ({ pid, time: TIME, token });
const expectedReport = (pid) =>
  formatProgramResume({ argv: ["tlh", "--session", UUID], cwd: "/work" }, sign(REAL, pid));
const expectedClear = (pid) => formatProgramResumeClear(sign(REAL, pid));

/** Child script that signs frames with whatever decoy the preload left in env, as Pi does. */
const FRAMES_SCRIPT = `
const { formatProgramResume, formatProgramResumeClear, takeProgramResumeToken } = await import(${JSON.stringify(
  new URL("../node_modules/@earendil-works/pi-tui/dist/index.js", import.meta.url).href,
)});
const token = takeProgramResumeToken();
process.title = "pi";
const pid = process.pid, time = ${TIME};
const s = { pid, time, token };
const report = formatProgramResume({ argv: ["pi", "--agent-dir", ${JSON.stringify(AGENT_DIR)}, "--session", ${JSON.stringify(UUID)}], cwd: "/work" }, s);
const clear = formatProgramResumeClear(s);
const foreign = formatProgramResumeClear({ pid, time, token: "attacker" });
const w = (c) => process.stdout.write(c);
w("a" + report + "b");
w(Buffer.from("x\\u00e9" + report + "\\u00fcy"));
w(report + "-" + clear);
w(report.slice(0, 20));
w(report.slice(20));
w("f" + foreign + "g");
w(clear);
w("plain");
process.stderr.write(JSON.stringify({ pid, report }));
`;

test("inert without a token or without the marker", () => {
  const script = `process.stdout.write(JSON.stringify({t:process.title,k:process.env.OSC7577_TOKEN??null,m:process.env.TLH_PROGRAM_RESUME_ACTIVE??null,w:process.stdout.write===Object.getPrototypeOf(process.stdout).write}))`;
  const baseline = JSON.parse(run(script, { OSC7577_TOKEN: REAL }, { preload: false }).stdout);
  for (const env of [
    { OSC7577_TOKEN: REAL, TLH_RUNTIME_WRAPPER_NAME: "tlh" },
    { OSC7577_TOKEN: REAL, TLH_PROGRAM_RESUME_ACTIVE: "0", TLH_RUNTIME_WRAPPER_NAME: "tlh" },
    { TLH_PROGRAM_RESUME_ACTIVE: "1", TLH_RUNTIME_WRAPPER_NAME: "tlh" },
    { OSC7577_TOKEN: "", TLH_PROGRAM_RESUME_ACTIVE: "1", TLH_RUNTIME_WRAPPER_NAME: "tlh" },
  ]) {
    const seen = JSON.parse(run(script, env).stdout);
    assert.equal(seen.t, baseline.t);
    assert.equal(seen.k, env.OSC7577_TOKEN ?? null);
    assert.equal(seen.m, env.TLH_PROGRAM_RESUME_ACTIVE ?? null);
    assert.equal(seen.w, true);
  }
});

test("active preload hides the real token, hands out a decoy and pins the OS-visible title", () => {
  const script = `
    const { execFileSync } = await import("node:child_process");
    const fs = await import("node:fs");
    process.title = "pi";
    const comm = process.platform === "linux"
      ? fs.readFileSync("/proc/" + process.pid + "/comm", "utf8").trim()
      : execFileSync("ps", ["-o", "comm=", "-p", String(process.pid)], { encoding: "utf8" }).trim();
    process.stdout.write(JSON.stringify({ title: process.title, comm, token: process.env.OSC7577_TOKEN ?? null, marker: process.env.TLH_PROGRAM_RESUME_ACTIVE ?? null }));`;
  const seen = JSON.parse(run(script, activeEnv()).stdout);
  assert.equal(seen.title, "tlh");
  assert.equal(seen.comm, "tlh");
  assert.match(seen.token, /^[0-9a-f]{64}$/);
  assert.notEqual(seen.token, REAL);
  assert.equal(seen.marker, null);
});

test("rewrites decoy-signed frames with the real token and preserves surrounding bytes", () => {
  const result = run(FRAMES_SCRIPT, activeEnv());
  const { pid, report: decoyReport } = JSON.parse(result.stderr.toString());
  const rep = expectedReport(pid);
  const clr = expectedClear(pid);
  assert.notEqual(rep, decoyReport);
  const expected = Buffer.concat([
    Buffer.from("a" + rep + "b", "utf8"),
    Buffer.from("x\u00e9" + rep + "\u00fcy", "utf8"),
    Buffer.from(rep + "-" + clr, "utf8"),
    // Split frame: both halves pass through unchanged (decoy-signed; the terminal rejects them).
    Buffer.from(decoyReport.slice(0, 20) + decoyReport.slice(20), "utf8"),
    Buffer.from("fg", "utf8"), // foreign-token frame dropped
    Buffer.from(clr + "plain", "utf8"),
  ]);
  assert.equal(result.stdout.toString("hex"), expected.toString("hex"));
});

test("a malformed 7577 frame is dropped alone while a valid decoy-signed report is re-signed", () => {
  const script = `
const { formatProgramResume, takeProgramResumeToken } = await import(${JSON.stringify(
    new URL("../node_modules/@earendil-works/pi-tui/dist/index.js", import.meta.url).href,
  )});
const token = takeProgramResumeToken();
const pid = process.pid;
const report = formatProgramResume({ argv: ["pi", "--agent-dir", ${JSON.stringify(AGENT_DIR)}, "--session", ${JSON.stringify(UUID)}], cwd: "/work" }, { pid, time: ${TIME}, token });
const malformed = "\\x1b]7577;pid=1:time=2:argv,cwd=Zm9v:mac=zz\\x1b\\\\";
process.stdout.write("a" + malformed + "b" + report + "c");
process.stderr.write(JSON.stringify({ pid }));
`;
  for (const extra of [{}, { TLH_PROGRAM_RESUME_TEST_FAIL: "frame" }]) {
    const result = run(script, activeEnv(extra));
    const { pid } = JSON.parse(result.stderr.toString());
    const signed = extra.TLH_PROGRAM_RESUME_TEST_FAIL ? expectedClear(pid) : expectedReport(pid);
    assert.equal(result.stdout.toString("utf8"), "ab" + signed + "c");
  }
});

test("a decoy-verified frame with a different pid is dropped without a clear", () => {
  const script = `
const { formatProgramResume, takeProgramResumeToken } = await import(${JSON.stringify(
    new URL("../node_modules/@earendil-works/pi-tui/dist/index.js", import.meta.url).href,
  )});
const token = takeProgramResumeToken();
const pid = process.pid;
const argv = ["pi", "--agent-dir", ${JSON.stringify(AGENT_DIR)}, "--session", ${JSON.stringify(UUID)}];
const wrong = formatProgramResume({ argv, cwd: "/work" }, { pid: pid + 1, time: ${TIME}, token });
const report = formatProgramResume({ argv, cwd: "/work" }, { pid, time: ${TIME}, token });
process.stdout.write("a" + wrong + "b" + report + "c");
process.stderr.write(JSON.stringify({ pid }));
`;
  for (const extra of [{}, { TLH_PROGRAM_RESUME_TEST_FAIL: "frame" }]) {
    const result = run(script, activeEnv(extra));
    const { pid } = JSON.parse(result.stderr.toString());
    const signed = extra.TLH_PROGRAM_RESUME_TEST_FAIL ? expectedClear(pid) : expectedReport(pid);
    assert.equal(result.stdout.toString("utf8"), "ab" + signed + "c");
  }
});

test("a throwing underlying writer or callback propagates and the writer is not retried", () => {
  const patch = `data:text/javascript,${encodeURIComponent(
    `globalThis.__calls = 0; globalThis.__cbs = 0; const orig = process.stdout.write; process.stdout.write = function (c, ...r) { globalThis.__calls++; if (typeof c === "string" && c.startsWith("W")) throw new Error("writer boom"); const cb = r.find((x) => typeof x === "function"); if (cb) { cb(); } return true; };`,
  )}`;
  const script = `
const { formatProgramResume, takeProgramResumeToken } = await import(${JSON.stringify(
    new URL("../node_modules/@earendil-works/pi-tui/dist/index.js", import.meta.url).href,
  )});
const token = takeProgramResumeToken();
const frame = formatProgramResume({ argv: ["pi", "--session", ${JSON.stringify(UUID)}], cwd: "/work" }, { pid: process.pid, time: ${TIME}, token });
const out = {};
for (const [name, chunk, cb] of [
  ["writer", "W" + frame, undefined],
  ["callback", "C" + frame, () => { globalThis.__cbs++; throw new Error("cb boom"); }],
]) {
  globalThis.__calls = 0; globalThis.__cbs = 0;
  let msg = null;
  try { process.stdout.write(chunk, cb); } catch (e) { msg = e.message; }
  out[name] = { msg, calls: globalThis.__calls, cbs: globalThis.__cbs };
}
process.stderr.write(JSON.stringify(out));
`;
  const base = { ...process.env };
  for (const key of ["OSC7577_TOKEN", "TLH_PROGRAM_RESUME_ACTIVE", "TLH_RUNTIME_WRAPPER_NAME"]) {
    delete base[key];
  }
  const result = spawnSync(
    process.execPath,
    ["--import", patch, "--import", PRELOAD, "-e", script],
    { env: { ...base, ...activeEnv() }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stderr);
  assert.deepEqual(out.writer, { msg: "writer boom", calls: 1, cbs: 0 });
  assert.deepEqual(out.callback, { msg: "cb boom", calls: 1, cbs: 1 });
});

test("fallback clears use Unix seconds and verify with the real token", () => {
  for (const mode of ["transform", "all"]) {
    const result = run(FRAMES_SCRIPT, activeEnv({ TLH_PROGRAM_RESUME_TEST_FAIL: mode }));
    const text = result.stdout.toString("latin1");
    const childPid = JSON.parse(result.stderr.toString()).pid;
    const intro = "\u001b]7577;";
    const frames = text
      .split(intro)
      .slice(1)
      .filter((part) => part.includes("\u001b\\"))
      .map((part) => part.slice(0, part.indexOf("\u001b\\")));
    const real = frames.filter((frame) => {
      const at = frame.lastIndexOf(":mac=");
      if (at === -1) return false;
      const digest = createHash("sha256")
        .update(`${frame.slice(0, at)}:${REAL}`)
        .digest("hex");
      return frame.slice(at + 5) === digest;
    });
    assert.ok(real.length >= 1, `no real-token-verified frame in ${JSON.stringify(frames)}`);
    const now = Math.floor(Date.now() / 1000);
    for (const frame of real) {
      const m = /^pid=(\d+):time=(\d+):clear=1:mac=[0-9a-f]{64}$/.exec(frame);
      assert.ok(m, `real-signed frame is not a clear: ${frame}`);
      assert.equal(Number(m[1]), childPid);
      assert.ok(Math.abs(Number(m[2]) - now) <= 5, `time ${m[2]} not within 5s of ${now}`);
    }
  }
});

test("a grandchild sees neither the real token nor the decoy after Pi takes it", () => {
  const script = `
    const { takeProgramResumeToken } = await import(${JSON.stringify(
      new URL("../node_modules/@earendil-works/pi-tui/dist/index.js", import.meta.url).href,
    )});
    const taken = takeProgramResumeToken();
    const { spawnSync } = await import("node:child_process");
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.env.OSC7577_TOKEN))"], { encoding: "utf8" });
    process.stdout.write(JSON.stringify({ taken, child: child.stdout, execArgv: process.execArgv.length }));`;
  const seen = JSON.parse(run(script, activeEnv()).stdout);
  assert.match(seen.taken, /^[0-9a-f]{64}$/);
  assert.notEqual(seen.taken, REAL);
  assert.equal(seen.child, "undefined");
});

test("an invalid wrapper name or missing agent dir installs nothing and removes the token", () => {
  const script = `process.stdout.write(JSON.stringify({ t: process.title, k: process.env.OSC7577_TOKEN ?? null, m: process.env.TLH_PROGRAM_RESUME_ACTIVE ?? null }));
    process.stdout.write("\\x1b]7577;pid=1:time=1:clear=1:mac=" + "0".repeat(64) + "\\x1b\\\\");`;
  const baseline = JSON.parse(
    run(script.split("\n")[0], {}, { preload: false }).stdout.toString(),
  ).t;
  for (const env of [
    activeEnv({ TLH_RUNTIME_WRAPPER_NAME: "a/b" }),
    activeEnv({ TLH_RUNTIME_WRAPPER_NAME: "-x" }),
    activeEnv({ TLH_RUNTIME_WRAPPER_NAME: "" }),
    activeEnv({ PI_CODING_AGENT_DIR: "" }),
  ]) {
    const out = run(script, env).stdout.toString("latin1");
    const json = JSON.parse(out.slice(0, out.indexOf("}") + 1));
    assert.equal(json.k, null);
    assert.equal(json.m, null);
    assert.equal(json.t, baseline);
    // Hook not installed: the raw frame passes through byte for byte.
    assert.ok(out.endsWith("pid=1:time=1:clear=1:mac=" + "0".repeat(64) + "\x1b\\"));
  }
});

test("pi-tui frame format reference still matches the module output", () => {
  // Guards the fixtures above against drift in the pinned pi-tui.
  assert.equal(typeof takeProgramResumeToken, "function");
  assert.ok(expectedReport(1).startsWith("\u001b]7577;pid=1:time="));
});

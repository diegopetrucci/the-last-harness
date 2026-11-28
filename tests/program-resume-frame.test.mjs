import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { formatProgramResume, formatProgramResumeClear } from "@earendil-works/pi-tui";

import {
  findFrames,
  formatClear,
  formatReport,
  isValidWrapperName,
  parseFrame,
  transformPiReport,
  verifyFrame,
} from "../scripts/lib/program-resume-frame.mjs";

const TOKEN = "tok-1234567890abcdef";
const sender = { pid: 4242, time: 1700000000123, token: TOKEN };
const AGENT_DIR = "/home/u/.the-last-harness/agent";
const UUID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const opts = { expectedAgentDir: AGENT_DIR, wrapperName: "tlh", pid: 99 };

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const signBody = (body, token = TOKEN) =>
  `\x1b]7577;${body}:mac=${createHash("sha256").update(`${body}:${token}`).digest("hex")}\x1b\\`;
const piFrame = (argv, cwd = "/work") => formatProgramResume({ argv, cwd }, sender);

test("formatting is byte-identical to pi-tui", () => {
  const commands = [
    { argv: ["pi"] },
    { argv: ["pi", "--session", UUID], cwd: "/work" },
    { argv: ["/usr/bin/pi", "ünï", "日本語", "", "a b"], cwd: "/tmp/ü" },
    { argv: ["pi", ...Array.from({ length: 63 }, (_, i) => String(i))] },
    { argv: ["pi", ...Array.from({ length: 64 }, () => "x")] }, // 65 -> undefined
    { argv: ["./pi"] },
    { argv: ["pi"], cwd: "rel" },
    { argv: ["pi", "a\nb"] },
    { argv: ["pi", "\ud800"] },
    { argv: ["pi", "x".repeat(3000)] },
    { argv: ["-pi"] },
    { argv: [] },
  ];
  for (const command of commands) {
    assert.equal(formatReport(command, sender), formatProgramResume(command, sender));
  }
  assert.equal(formatClear(sender), formatProgramResumeClear(sender));
});

test("round trip and verification", () => {
  const frame = formatReport({ argv: ["pi", "--x", "é"], cwd: "/w" }, sender);
  const parsed = parseFrame(frame);
  assert.deepEqual(parsed.argv, ["pi", "--x", "é"]);
  assert.equal(parsed.cwd, "/w");
  assert.equal(parsed.pid, "4242");
  assert.equal(verifyFrame(parsed, TOKEN), true);
  assert.equal(verifyFrame(parsed, "other"), false);
  assert.equal(verifyFrame(parsed, ""), false);

  const clear = parseFrame(formatClear(sender));
  assert.equal(clear.clear, true);
  assert.equal(verifyFrame(clear, TOKEN), true);

  const noCwd = parseFrame(formatReport({ argv: ["pi"] }, sender));
  assert.equal(noCwd.cwd, undefined);
  assert.equal(formatReport({ argv: noCwd.argv }, sender), formatReport({ argv: ["pi"] }, sender));
});

test("findFrames locates complete frames only", () => {
  const a = formatClear(sender);
  const b = piFrame(["pi"]);
  const text = `x${a}mid${b}\x1b]7577;pid=1`;
  const found = findFrames(text);
  assert.equal(found.length, 2);
  assert.equal(text.slice(found[0].start, found[0].end), a);
  assert.equal(found[1].frame, b);
  assert.deepEqual(findFrames("plain"), []);
});

test("parser rejects adversarial frames", () => {
  const argv = b64("pi");
  const base = `pid=1:time=2:argv=${argv}`;
  const good = signBody(base);
  assert.ok(parseFrame(good));

  const mac = good.match(/mac=([0-9a-f]{64})/)[1];
  const rejects = {
    "not a frame": "hello",
    "no terminator": good.slice(0, -2),
    "BEL terminator": good.slice(0, -2) + "\x07",
    "short mac": good.replace(mac, mac.slice(1)),
    "uppercase mac": good.replace(mac, mac.toUpperCase()),
    "missing mac": `\x1b]7577;${base}\x1b\\`,
    "mac not last": `\x1b]7577;pid=1:time=2:mac=${mac}:argv=${argv}\x1b\\`,
    "duplicate keys": signBody(`${base}:argv=${argv}`),
    "duplicate pid": signBody(`pid=1:${base}`),
    "unknown key": signBody(`${base}:extra=1`),
    "unknown key before mac": signBody(`pid=1:time=2:foo=bar:argv=${argv}`),
    "wrong order": signBody(`time=2:pid=1:argv=${argv}`),
    "argv and clear": signBody(`${base}:clear=1`),
    "clear=0": signBody("pid=1:time=2:clear=0"),
    "missing argv": signBody("pid=1:time=2"),
    "malformed pair": signBody(`pid=1:time=2:argv`),
    "empty key": signBody(`pid=1:time=2:=x:argv=${argv}`),
    "non-numeric pid": signBody(`pid=x:time=2:argv=${argv}`),
    "bad base64 chars": signBody(`pid=1:time=2:argv=${"!!!!"}`),
    "base64 url alphabet": signBody(`pid=1:time=2:argv=${b64("pi>>").replace(/\+/g, "-")}`),
    "missing padding": signBody(`pid=1:time=2:argv=${b64("pi").replace(/=+$/, "")}`),
    "extra padding": signBody(`pid=1:time=2:argv=${b64("pi")}=`),
    "non-canonical trailing bits": signBody(`pid=1:time=2:argv=cB==`),
    "invalid utf-8": signBody(`pid=1:time=2:argv=${Buffer.from([0x70, 0xff]).toString("base64")}`),
    "lone surrogate (CESU)": signBody(
      `pid=1:time=2:argv=${Buffer.from([0x70, 0xed, 0xa0, 0x80]).toString("base64")}`,
    ),
    "control char in argv": signBody(`pid=1:time=2:argv=${b64("pi\n")}`),
    "C1 control in argv": signBody(`pid=1:time=2:argv=${b64("pi\u0085")}`),
    "raw control char in frame": signBody(`pid=1:time=2:argv=${argv}\n`),
    "empty argv": signBody("pid=1:time=2:argv="),
    "empty program": signBody(`pid=1:time=2:argv=${b64("")},${argv}`),
    "relative program": signBody(`pid=1:time=2:argv=${b64("./pi")}`),
    "dash program": signBody(`pid=1:time=2:argv=${b64("-pi")}`),
    "relative cwd": signBody(`${base}:cwd=${b64("rel")}`),
    "control char in cwd": signBody(`${base}:cwd=${b64("/a\tb")}`),
    "65 argv": signBody(
      `pid=1:time=2:argv=${Array.from({ length: 65 }, (_, i) => (i ? b64("x") : argv)).join(",")}`,
    ),
    oversize: signBody(`pid=1:time=2:argv=${b64("pi")},${b64("x".repeat(2100))}`),
  };
  for (const [name, frame] of Object.entries(rejects)) {
    assert.equal(parseFrame(frame), undefined, name);
  }

  // 64 elements is the maximum and is accepted.
  const sixtyFour = signBody(
    `pid=1:time=2:argv=${Array.from({ length: 64 }, (_, i) => (i ? b64("x") : argv)).join(",")}`,
  );
  assert.equal(parseFrame(sixtyFour).argv.length, 64);
  // Absolute program and empty trailing argument are fine.
  assert.ok(parseFrame(signBody(`pid=1:time=2:argv=${b64("/bin/pi")},`)));
});

test("comma-containing keys are rejected without throwing; separate argv and cwd parse", () => {
  const argv = b64("pi");
  const cwd = b64("/work");
  for (const body of [
    `pid=1:time=2:argv,cwd=${argv}`,
    `pid=1:time=2:argv,cwd=${argv},${cwd}`,
    `pid=1:time=2:argv=${argv}:cwd,x=${cwd}`,
    `pid=1:time=2:clear,argv=1`,
    `pid,time=1:argv=${argv}:cwd=${cwd}`,
  ]) {
    assert.doesNotThrow(() => parseFrame(signBody(body)), body);
    assert.equal(parseFrame(signBody(body)), undefined, body);
  }
  const parsed = parseFrame(signBody(`pid=1:time=2:argv=${argv}:cwd=${cwd}`));
  assert.deepEqual(parsed.argv, ["pi"]);
  assert.equal(parsed.cwd, "/work");
});

test("verification fails on tampered body and wrong token", () => {
  const frame = signBody(`pid=1:time=2:argv=${b64("pi")}`);
  assert.equal(verifyFrame(parseFrame(frame), TOKEN), true);
  assert.equal(verifyFrame(parseFrame(frame), "wrong"), false);
  const tampered = frame.replace("time=2", "time=3");
  assert.equal(verifyFrame(parseFrame(tampered), TOKEN), false);
  const wrongTokenFrame = signBody(`pid=1:time=2:argv=${b64("pi")}`, "attacker");
  assert.equal(verifyFrame(parseFrame(wrongTokenFrame), TOKEN), false);
});

const parsedFor = (argv, cwd = "/work") => parseFrame(piFrame(argv, cwd));
const exact = ["pi", "--agent-dir", AGENT_DIR, "--session", UUID];

test("transform: exact shape becomes a wrapper report", () => {
  assert.deepEqual(transformPiReport(parsedFor(exact), opts), {
    kind: "report",
    argv: ["tlh", "--session", UUID],
    cwd: "/work",
  });
  // Agent dir is compared after path.resolve.
  assert.equal(
    transformPiReport(
      parsedFor(["pi", "--agent-dir", `${AGENT_DIR}/../agent/`, "--session", UUID]),
      opts,
    ).kind,
    "report",
  );
  // A relative agent dir is never accepted, even if it would resolve to the expected one.
  assert.equal(
    transformPiReport(
      parsedFor(["pi", "--agent-dir", "agent", "--session", UUID], "/home/u/.the-last-harness"),
      opts,
    ).kind,
    "clear",
  );
  // Without cwd the report has no cwd.
  const noCwd = parseFrame(formatReport({ argv: exact }, sender));
  assert.deepEqual(transformPiReport(noCwd, opts), {
    kind: "report",
    argv: ["tlh", "--session", UUID],
  });
});

test("transform: everything else clears", () => {
  const clear = { kind: "clear" };
  const cases = {
    "clear frame": parseFrame(formatClear(sender)),
    "session-dir": parsedFor([...exact, "--session-dir", "/s"]),
    "session-dir before": parsedFor(["pi", "--session-dir", "/s", ...exact.slice(1)]),
    "-t read": parsedFor([...exact, "-t", "read"]),
    "--tools": parsedFor([...exact, "--tools", "read"]),
    "--exclude-tools": parsedFor([...exact, "--exclude-tools", "bash"]),
    "-xt": parsedFor([...exact, "-xt", "bash"]),
    "--no-tools": parsedFor([...exact, "--no-tools"]),
    "-nt": parsedFor([...exact, "-nt"]),
    "--no-builtin-tools": parsedFor([...exact, "--no-builtin-tools"]),
    "-nbt": parsedFor([...exact, "-nbt"]),
    "--extension": parsedFor([...exact, "--extension", "./x.ts"]),
    "-e ./x.ts": parsedFor([...exact, "-e", "./x.ts"]),
    "--no-extensions": parsedFor([...exact, "--no-extensions"]),
    "-ne": parsedFor([...exact, "-ne"]),
    "--no-mcp": parsedFor([...exact, "--no-mcp"]),
    "--skill": parsedFor([...exact, "--skill", "s"]),
    "--no-skills": parsedFor([...exact, "--no-skills"]),
    "-ns": parsedFor([...exact, "-ns"]),
    "--prompt-template": parsedFor([...exact, "--prompt-template", "p"]),
    "--no-prompt-templates": parsedFor([...exact, "--no-prompt-templates"]),
    "-np": parsedFor([...exact, "-np"]),
    "--theme": parsedFor([...exact, "--theme", "t"]),
    "--no-themes": parsedFor([...exact, "--no-themes"]),
    "--no-context-files": parsedFor([...exact, "--no-context-files"]),
    "-nc": parsedFor([...exact, "-nc"]),
    "--system-prompt": parsedFor([...exact, "--system-prompt", "x"]),
    "--append-system-prompt": parsedFor([...exact, "--append-system-prompt", "x"]),
    "--approve": parsedFor([...exact, "--approve"]),
    "-a": parsedFor([...exact, "-a"]),
    "--no-approve": parsedFor([...exact, "--no-approve"]),
    "-na": parsedFor([...exact, "-na"]),
    "--models": parsedFor([...exact, "--models", "a,b"]),
    "different agent dir": parsedFor(["pi", "--agent-dir", "/other", "--session", UUID]),
    "relative agent dir elsewhere": parsedFor(
      ["pi", "--agent-dir", "agent", "--session", UUID],
      "/nope",
    ),
    "relative agent dir without cwd": parseFrame(
      formatReport({ argv: ["pi", "--agent-dir", "agent", "--session", UUID] }, sender),
    ),
    "missing --agent-dir": parsedFor(["pi", "--session", UUID]),
    "agent-dir=": parsedFor(["pi", `--agent-dir=${AGENT_DIR}`, "--session", UUID]),
    "non-UUID session": parsedFor(["pi", "--agent-dir", AGENT_DIR, "--session", "abc123"]),
    "session path": parsedFor(["pi", "--agent-dir", AGENT_DIR, "--session", "/tmp/s.jsonl"]),
    "bad uuid version": parsedFor([
      "pi",
      "--agent-dir",
      AGENT_DIR,
      "--session",
      UUID.replace("-7e5f", "-0e5f"),
    ]),
    "argv0 not pi": parsedFor(["node", ...exact.slice(1)]),
    "argv0 absolute pi": parsedFor(["/usr/bin/pi", ...exact.slice(1)]),
    "tlh already": parsedFor(["tlh", "--session", UUID]),
    "wrong flag order": parsedFor(["pi", "--session", UUID, "--agent-dir", AGENT_DIR]),
    "extra trailing": parsedFor([...exact, "hello"]),
    "bare pi": parsedFor(["pi"]),
  };
  for (const [name, parsed] of Object.entries(cases)) {
    assert.deepEqual(transformPiReport(parsed, opts), clear, name);
  }
});

test("transform: invalid wrapper names and oversize rewrites clear", () => {
  const parsed = parsedFor(exact);
  for (const wrapperName of ["", "a/b", "-tlh", "t\nlh", "/abs/tlh", "a\\b", undefined]) {
    assert.deepEqual(
      transformPiReport(parsed, { ...opts, wrapperName }),
      { kind: "clear" },
      String(wrapperName),
    );
    assert.equal(isValidWrapperName(wrapperName), false);
  }
  assert.equal(isValidWrapperName("tlh-dev"), true);
  // A wrapper name this long cannot fit into 2048 bytes once encoded.
  assert.deepEqual(transformPiReport(parsed, { ...opts, wrapperName: "w".repeat(2000) }), {
    kind: "clear",
  });
});

test("transformed report formats identically to pi-tui and verifies", () => {
  const result = transformPiReport(parsedFor(exact), opts);
  const signer = { pid: 99, time: 5, token: "bridge-token" };
  const frame = formatReport({ argv: result.argv, cwd: result.cwd }, signer);
  assert.equal(frame, formatProgramResume({ argv: result.argv, cwd: result.cwd }, signer));
  assert.equal(verifyFrame(parseFrame(frame), "bridge-token"), true);
});

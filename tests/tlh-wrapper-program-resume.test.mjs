/**
 * Generated-wrapper behaviour for the opt-in OSC 7577 resume bridge (#934):
 * the token stash never reaches helpers/subcommands, and the bridge launch
 * happens only for opt-in, non-nested, TTY, plain interactive launches.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  BASH_SUPPORTS_XTRACEFD,
  REPO_ROOT,
  TOKEN,
  parseRecord,
  runWrapper,
} from "./tlh-wrapper-program-resume-test-helpers.mjs";

const OPT_IN = { OSC7577_TOKEN: TOKEN, TLH_PROGRAM_RESUME: "1" };

function assertNoTokenAnywhere(run) {
  for (const text of [run.node, run.pi]) {
    if (text === undefined) continue;
    assert.ok(!text.includes(TOKEN), `token leaked:\n${text}`);
    assert.ok(!text.includes("tlh_osc7577_stash"), `stash leaked:\n${text}`);
    assert.ok(!text.includes("TLH_PROGRAM_RESUME_ACTIVE"), `marker leaked:\n${text}`);
  }
  assert.ok(!run.result.stdout.includes(TOKEN) && !run.result.stderr.includes(TOKEN));
}

function assertPlainPiExec(run, args) {
  assert.equal(run.result.status, 0, `${run.result.stdout}\n${run.result.stderr}`);
  assert.ok(!(run.node ?? "").includes("--import"), "bridge launch must not happen");
  const pi = parseRecord(run.pi);
  assert.ok(pi, "pi must run");
  assert.equal(pi.argv, args.map((a) => `[${a}]`).join(""));
  assertNoTokenAnywhere(run);
}

test("helpers and subcommands never see the token or the stash, even if the stash name was exported", (t) => {
  for (const sub of ["update", "defaults", "tickets", "doctor", "sessions", "version"]) {
    const run = runWrapper(t, {
      args: [sub],
      env: { ...OPT_IN, tlh_osc7577_stash: "caller-exported-stash" },
      tty: true,
    });
    assert.equal(run.result.status, 0, `${sub}: ${run.result.stdout}\n${run.result.stderr}`);
    assert.ok(run.node, `${sub}: helper should run under node`);
    assert.ok(!run.node.includes("caller-exported-stash"), sub);
    assertNoTokenAnywhere(run);
  }
});

test("a caller-exported stash name does not leak into the plain pi exec", (t) => {
  const run = runWrapper(t, { env: { tlh_osc7577_stash: "caller-exported-stash" }, args: ["hi"] });
  assertPlainPiExec(run, ["hi"]);
  assert.ok(!run.pi.includes("caller-exported-stash"));
});

test("the MCP startup guard never sees the token or the stash", (t) => {
  const run = runWrapper(t, { env: { ...OPT_IN }, tty: true, args: [] });
  assert.equal(run.result.status, 0, run.result.stderr);
  // Guard + bridge launch both run under node; only the bridge launch gets the token.
  const records = run.node.split("ARGV:").filter(Boolean);
  const guard = records.find((r) => r.includes("--startup-guard"));
  assert.ok(guard, "guard should have run");
  assert.ok(!guard.includes(TOKEN) && !guard.includes("tlh_osc7577_stash"));
});

const GATING_CASES = [
  ["opt-in unset", { env: { OSC7577_TOKEN: TOKEN }, tty: true }],
  ["opt-in 0", { env: { ...OPT_IN, TLH_PROGRAM_RESUME: "0" }, tty: true }],
  ["opt-in true", { env: { ...OPT_IN, TLH_PROGRAM_RESUME: "true" }, tty: true }],
  ["empty token", { env: { OSC7577_TOKEN: "", TLH_PROGRAM_RESUME: "1" }, tty: true }],
  ...["TMUX", "STY", "ZELLIJ", "HERDR_ENV", "HERDR_PANE_ID"].map((name) => [
    `inside ${name}`,
    { env: { ...OPT_IN, [name]: "x" }, tty: true },
  ]),
  ["non-TTY (pipes)", { env: { ...OPT_IN }, tty: false }],
  ["missing preload", { env: { ...OPT_IN }, tty: true, missingPreload: true }],
  ["invalid wrapper name (leading dash)", { env: { ...OPT_IN }, tty: true, wrapperName: "-tlh" }],
  ["invalid wrapper name (space)", { env: { ...OPT_IN }, tty: true, wrapperName: "my tlh" }],
];

for (const [name, options] of GATING_CASES) {
  test(`gating: ${name} -> plain pi exec without token`, (t) => {
    const args = ["hello"];
    const run = runWrapper(t, { ...options, args });
    if (options.tty) {
      // The MCP guard runs under node; it is not the pi launch.
      assert.ok(!parseRecord(run.node)?.env.has("OSC7577_TOKEN"));
      assert.ok(!(run.node ?? "").includes("--import"), "bridge launch must not happen");
      const pi = parseRecord(run.pi);
      assert.ok(pi, "pi must run");
      assert.equal(pi.argv, "[hello]");
      assertNoTokenAnywhere(run);
    } else {
      assertPlainPiExec({ ...run, node: undefined }, args);
    }
  });
}

const INELIGIBLE_ARGS = [
  ["install", "x"],
  ["remove", "x"],
  ["uninstall", "x"],
  ["list"],
  ["config"],
  ["mcp", "list"],
  ["auth", "check"],
  ["-p", "hi"],
  ["--print", "hi"],
  ["--mode", "json"],
  ["--mode=rpc"],
  ["--export", "s.jsonl"],
  ["-h"],
  ["--help"],
  ["-v"],
  ["--version"],
  ["--list-models"],
  ["-c", "-p", "hi"],
];

for (const args of INELIGIBLE_ARGS) {
  test(`gating: args ${JSON.stringify(args)} -> plain pi exec without token`, (t) => {
    const run = runWrapper(t, { args, env: { ...OPT_IN }, tty: true });
    assert.equal(run.result.status, 0, `${run.result.stdout}\n${run.result.stderr}`);
    const pi = parseRecord(run.pi);
    assert.ok(pi, "pi must run directly");
    assert.equal(pi.argv, args.map((a) => `[${a}]`).join(""));
    assertNoTokenAnywhere(run);
  });
}

test("gating: bare -- is not a stop marker (Pi options may consume it)", (t) => {
  for (const args of [
    ["--name", "--", "--print", "hi"],
    ["--", "list"],
  ]) {
    const run = runWrapper(t, { args, env: { ...OPT_IN }, tty: true });
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(parseRecord(run.pi)?.argv, args.map((a) => `[${a}]`).join(""));
    assert.ok(!(run.node ?? "").includes("--import"));
    assertNoTokenAnywhere(run);
  }
});

test("gating: plain and --session launches stay eligible", (t) => {
  for (const args of [[], ["--session", "123e4567-e89b-12d3-a456-426614174000"]]) {
    const run = runWrapper(t, { args, env: { ...OPT_IN }, tty: true });
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.match(run.node, /--import/);
  }
});

test("preload is passed as a file URL that node loads, for paths with # ? % and space", (t) => {
  const run = runWrapper(t, {
    env: { ...OPT_IN },
    tty: true,
    stubPackageDir: "pkg #1 ?q %41 x",
  });
  assert.equal(run.result.status, 0, run.result.stderr);
  const launch = parseRecord(
    run.node
      .split("ARGV:")
      .filter((r) => r.includes("--import"))
      .map((r) => `ARGV:${r}`)[0],
  );
  const url = /^\[--import\]\[([^\]]*)\]/.exec(launch.argv)[1];
  assert.equal(url, pathToFileURL(run.preloadPath).href);
  assert.ok(url.startsWith("file://") && !url.includes("#1") && !url.includes(" "));
  const loaded = spawnSync(process.execPath, ["--import", url, "-e", ""], {
    env: { ...process.env, TLH_TEST_RECORD_DIR: run.record },
    encoding: "utf8",
  });
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(readFileSync(join(run.record, "preload-ran.txt"), "utf8"), "ran");
});

test("relative --package-root -> empty preload URL and plain pi exec without token", (t) => {
  // Resolves to the real repo from the wrapper's cwd (a dir under tmpdir), so only the
  // absolute-root requirement can make the bridge ineligible.
  const packageRoot = join("..", relative(realpathSync(tmpdir()), realpathSync(REPO_ROOT)));
  const run = runWrapper(t, { args: ["hello"], env: { ...OPT_IN }, tty: true, packageRoot });
  const wrapper = readFileSync(join(run.root, "wrapper-bin", "tlh"), "utf8");
  assert.match(wrapper, /^tlh_program_resume_preload_url=''$/m);
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.ok(!(run.node ?? "").includes("--import"), "bridge launch must not happen");
  assert.equal(parseRecord(run.pi)?.argv, "[hello]");
  assertNoTokenAnywhere(run);
});

test("unreadable preload -> plain pi exec, no permission error", (t) => {
  if (process.getuid?.() === 0) return t.skip("running as root");
  const run = runWrapper(t, {
    args: ["hello"],
    env: { ...OPT_IN },
    tty: true,
    stubPackageDir: "pkg",
    unreadablePreload: true,
  });
  chmodSync(run.preloadPath, 0o644);
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.ok(!(run.node ?? "").includes("--import"));
  assert.equal(parseRecord(run.pi)?.argv, "[hello]");
  assert.ok(!/permission denied/i.test(run.result.stderr));
  assertNoTokenAnywhere(run);
});

for (const [label, options] of [
  ["eligible", { args: [] }],
  ["ineligible", { args: ["--print", "hi"] }],
  ["not opted in", { args: [], env: { OSC7577_TOKEN: TOKEN } }],
]) {
  for (const mode of ["stderr", "xtracefd"]) {
    test(`xtrace never prints the token: ${label}, ${mode}`, (t) => {
      if (mode === "xtracefd" && !BASH_SUPPORTS_XTRACEFD) return t.skip("bash < 4.1");
      const xtraceFile = join(mkdtempSync(join(tmpdir(), "tlh-xtrace-")), "trace.txt");
      t.after(() => rmSync(dirname(xtraceFile), { recursive: true, force: true }));
      const run = runWrapper(t, {
        env: { ...OPT_IN },
        ...options,
        tty: true,
        bashArgs: ["-x"],
        ...(mode === "xtracefd" ? { xtraceFile } : {}),
      });
      assert.equal(run.result.status, 0, run.result.stderr);
      const trace = mode === "xtracefd" ? readFileSync(xtraceFile, "utf8") : "";
      assert.ok(!run.result.stderr.includes(TOKEN), "token in stderr trace");
      assert.ok(!trace.includes(TOKEN), "token in BASH_XTRACEFD trace");
      assert.ok(mode === "xtracefd" ? trace.length > 0 : run.result.stderr.includes("+ "));
    });
  }
}

test("eligible TTY launch: node --import preload pi with token and marker", (t) => {
  const args = ["--model", "x", "hello world"];
  const run = runWrapper(t, { args, env: { ...OPT_IN }, tty: true });
  assert.equal(run.result.status, 0, `${run.result.stdout}\n${run.result.stderr}`);
  const launches = run.node.split("ARGV:").filter((r) => r.includes("--import"));
  assert.equal(launches.length, 1);
  const launch = parseRecord(`ARGV:${launches[0]}`);
  assert.equal(
    launch.argv,
    `[--import][${pathToFileURL(`${REPO_ROOT}/scripts/tlh-program-resume-preload.mjs`).href}][${run.piCmd}][--model][x][hello world]`,
  );
  assert.equal(launch.env.get("OSC7577_TOKEN"), TOKEN);
  assert.equal(launch.env.get("TLH_PROGRAM_RESUME_ACTIVE"), "1");
  assert.ok(!launch.text.includes("tlh_osc7577_stash"));
});

test("inherited TLH_PROGRAM_RESUME_ACTIVE is dropped on ineligible launches", (t) => {
  const run = runWrapper(t, {
    args: ["hello"],
    env: { OSC7577_TOKEN: TOKEN, TLH_PROGRAM_RESUME_ACTIVE: "1" },
    tty: true,
  });
  assert.ok(!parseRecord(run.pi).env.has("TLH_PROGRAM_RESUME_ACTIVE"));
});

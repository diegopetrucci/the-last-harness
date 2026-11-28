/**
 * Generated-wrapper behaviour for the opt-in OSC 7577 resume bridge (#934):
 * the token stash never reaches helpers/subcommands, and the bridge launch
 * happens only for opt-in, non-nested, TTY, plain interactive launches.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
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

test("gating: ineligible words after a bare -- do not disable the bridge", (t) => {
  const args = ["--", "-p", "list"];
  const run = runWrapper(t, { args, env: { ...OPT_IN }, tty: true });
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.match(run.node, /--import/);
  assert.equal(run.pi, undefined, "node stub does not exec pi");
});

test("eligible TTY launch: node --import preload pi with token and marker", (t) => {
  const args = ["--model", "x", "hello world"];
  const run = runWrapper(t, { args, env: { ...OPT_IN }, tty: true });
  assert.equal(run.result.status, 0, `${run.result.stdout}\n${run.result.stderr}`);
  const launches = run.node.split("ARGV:").filter((r) => r.includes("--import"));
  assert.equal(launches.length, 1);
  const launch = parseRecord(`ARGV:${launches[0]}`);
  assert.equal(
    launch.argv,
    `[--import][${REPO_ROOT}/scripts/tlh-program-resume-preload.mjs][${run.piCmd}][--model][x][hello world]`,
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

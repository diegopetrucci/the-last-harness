import assert from "node:assert/strict";
import { mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import test from "node:test";

import { makeTempDir } from "./test-fixture-helpers.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const script = join(repoRoot, "scripts", "tlh-version.mjs");

function makeFixture(t, { state, piVersion = "1.2.3" } = {}) {
  const root = makeTempDir("tlh-version-test-", t);
  const packageRoot = join(root, "pkg");
  const agentDir = join(root, "agent");
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(join(agentDir, "tlh"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ version: "0.9.0" }));
  if (typeof state === "string") {
    writeFileSync(join(agentDir, "tlh", "install-state.json"), state);
  } else if (state !== undefined) {
    writeFileSync(join(agentDir, "tlh", "install-state.json"), JSON.stringify(state));
  }
  const runtime = join(root, "runtime");
  const piPkg = join(runtime, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(piPkg, "dist"), { recursive: true });
  mkdirSync(join(runtime, "bin"), { recursive: true });
  writeFileSync(
    join(piPkg, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: piVersion }),
  );
  writeFileSync(join(piPkg, "dist", "cli.js"), "");
  const piBin = join(runtime, "bin", "pi");
  symlinkSync(join(piPkg, "dist", "cli.js"), piBin);
  return { root, packageRoot, agentDir, piBin };
}

function run(fixture, { piCmd = fixture.piBin, extra = ["--json"], args } = {}) {
  return spawnSync(
    process.execPath,
    [
      script,
      ...(args ?? [
        "--agent-dir",
        fixture.agentDir,
        "--package-root",
        fixture.packageRoot,
        "--pi-cmd",
        piCmd,
        ...extra,
      ]),
    ],
    { encoding: "utf8" },
  );
}

function runJson(fixture, options) {
  const result = run(fixture, options);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function snapshot(dir) {
  const entries = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      entries.push(`${relative(dir, p)}:${st.isDirectory() ? "d" : st.size}:${st.mtimeMs}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return entries;
}

test("latest-release install reports tag ref and exact key set", (t) => {
  const f = makeFixture(t, {
    state: { track: "latest-release", ref: "v0.9.0", repo: "owner/repo" },
  });
  const out = runJson(f);
  assert.deepEqual(Object.keys(out), [
    "schemaVersion",
    "tlhVersion",
    "piVersion",
    "track",
    "ref",
    "repo",
    "agentDir",
  ]);
  assert.equal(out.schemaVersion, 1);
  assert.deepEqual(out, {
    schemaVersion: 1,
    tlhVersion: "0.9.0",
    piVersion: "1.2.3",
    track: "latest-release",
    ref: "v0.9.0",
    repo: "owner/repo",
    agentDir: f.agentDir,
  });
});

test("pinned-tag track is reported as-is", (t) => {
  const f = makeFixture(t, { state: { track: "pinned-tag", ref: "v0.8.0", repo: "o/r" } });
  const out = runJson(f);
  assert.equal(out.track, "pinned-tag");
  assert.equal(out.ref, "v0.8.0");
});

test("ref track with main still reports tlhVersion from package.json", (t) => {
  const f = makeFixture(t, { state: { track: "ref", ref: "main", repo: "o/r" } });
  const out = runJson(f);
  assert.equal(out.track, "ref");
  assert.equal(out.ref, "main");
  assert.equal(out.tlhVersion, "0.9.0");
});

test("missing install-state yields null provenance", (t) => {
  const f = makeFixture(t);
  const out = runJson(f);
  assert.equal(out.track, null);
  assert.equal(out.ref, null);
  assert.equal(out.repo, null);
  assert.equal(out.tlhVersion, "0.9.0");
});

test("invalid or wrong-typed install-state yields nulls", (t) => {
  for (const state of [
    "{not json",
    "[]",
    '"x"',
    JSON.stringify({ track: 5, ref: "  ", repo: {} }),
  ]) {
    const f = makeFixture(t, { state });
    const out = runJson(f);
    assert.equal(out.track, null);
    assert.equal(out.ref, null);
    assert.equal(out.repo, null);
  }
});

test("missing or empty --pi-cmd yields null piVersion", (t) => {
  const f = makeFixture(t, { state: { track: "ref", ref: "main", repo: "o/r" } });
  assert.equal(runJson(f, { piCmd: "" }).piVersion, null);
  assert.equal(runJson(f, { piCmd: join(f.root, "nope", "pi") }).piVersion, null);
});

test("symlinked pi resolves the runtime package version", (t) => {
  const f = makeFixture(t, { piVersion: "4.5.6" });
  assert.equal(runJson(f).piVersion, "4.5.6");
});

test("command creates or modifies no files in the agent dir", (t) => {
  const f = makeFixture(t, { state: { track: "ref", ref: "main", repo: "o/r" } });
  const before = snapshot(f.agentDir);
  runJson(f);
  run(f, { extra: [] });
  assert.deepEqual(snapshot(f.agentDir), before);
});

test("plain-text output is a readable summary", (t) => {
  const f = makeFixture(t, { state: { track: "ref", ref: "main", repo: "o/r" } });
  const result = run(f, { extra: [] });
  assert.equal(result.status, 0);
  assert.equal(
    result.stdout,
    [
      "TLH version: 0.9.0",
      "Pi runtime version: 1.2.3",
      "Track: ref (main)",
      "Repository: o/r",
      `Profile dir: ${f.agentDir}`,
      "",
    ].join("\n"),
  );
  const bare = makeFixture(t);
  const text = run(bare, { piCmd: "", extra: [] }).stdout;
  assert.match(text, /Pi runtime version: unknown/);
  assert.match(text, /Track: unknown/);
  assert.match(text, /Repository: unknown/);
});

test("option values may not be another flag", (t) => {
  const f = makeFixture(t);
  for (const args of [
    ["--agent-dir", "--json", "--package-root", f.packageRoot],
    ["--agent-dir", f.agentDir, "--package-root", "--json"],
    ["--agent-dir", f.agentDir, "--package-root", f.packageRoot, "--pi-cmd", "--json"],
  ]) {
    const result = run(f, { args });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
  }
});

test("explicit empty --pi-cmd is accepted", (t) => {
  const f = makeFixture(t);
  const result = run(f, {
    args: ["--agent-dir", f.agentDir, "--package-root", f.packageRoot, "--pi-cmd", "", "--json"],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).piVersion, null);
});

test("help exits zero", (t) => {
  const result = run(makeFixture(t), { args: ["--help"] });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
});

test("unknown option or missing required flags fail with empty stdout", (t) => {
  const f = makeFixture(t);
  for (const args of [
    ["--agent-dir", f.agentDir, "--package-root", f.packageRoot, "--bogus"],
    ["--package-root", f.packageRoot, "--json"],
    ["--agent-dir", f.agentDir, "--json"],
  ]) {
    const result = run(f, { args });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.notEqual(result.stderr, "");
  }
});

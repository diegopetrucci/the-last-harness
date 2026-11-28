/**
 * Unit tests for the renderWrapper function in scripts/tlh-wrapper.mjs.
 * These tests check the rendered shell-script string directly, without
 * executing the wrapper.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_MARKER, renderWrapper, writeWrapper } from "../scripts/tlh-wrapper.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Minimal valid args used across multiple tests.
const BASE_ARGS = {
  agentDir: "/tmp/test-agent",
  binDir: "/tmp/test-bin",
  wrapperName: "tlh",
  packageRoot: "/tmp/test-package",
};

const PINNED_ARGS = {
  ...BASE_ARGS,
  piCmd: "/home/user/.the-last-harness/runtime/bin/pi",
};

test("renderWrapper: exports TLH_RUNTIME_WRAPPER_NAME from the default wrapper name", () => {
  const rendered = renderWrapper(PINNED_ARGS);
  assert.ok(rendered.includes('export TLH_RUNTIME_WRAPPER_NAME="${default_wrapper_name}"'));
  assert.ok(rendered.includes("default_wrapper_name='tlh'"));
  const custom = renderWrapper({ ...PINNED_ARGS, wrapperName: "tlh-alt" });
  assert.ok(custom.includes("default_wrapper_name='tlh-alt'"));
  assert.ok(custom.includes('export TLH_RUNTIME_WRAPPER_NAME="${default_wrapper_name}"'));
});

test("renderWrapper: does not export the installer input TLH_WRAPPER_NAME", () => {
  const rendered = renderWrapper(PINNED_ARGS);
  const assignments = rendered
    .split("\n")
    .filter((line) => /^\s*(export\s+)?TLH_WRAPPER_NAME=/.test(line));
  assert.deepEqual(assignments, []);
  assert.ok(!rendered.includes("export TLH_WRAPPER_NAME"));
});

test("renderWrapper: TLH_RUNTIME_WRAPPER_NAME is exported before the pinned pi exec", () => {
  const rendered = renderWrapper(PINNED_ARGS);
  const exportIndex = rendered.indexOf('export TLH_RUNTIME_WRAPPER_NAME="${default_wrapper_name}"');
  const piExecIndex = rendered.indexOf('exec "${default_pi_cmd}" "$@"');
  assert.ok(exportIndex >= 0 && piExecIndex >= 0);
  assert.ok(exportIndex < piExecIndex);
});

function launchWithStubPi(t, wrapperName) {
  const root = mkdtempSync(join(tmpdir(), "tlh-wrapper-runtime-name-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const piCmd = join(root, "runtime", "bin", "pi");
  mkdirSync(dirname(piCmd), { recursive: true });
  writeFileSync(
    piCmd,
    [
      "#!/usr/bin/env bash",
      "printf 'TLH_RUNTIME_WRAPPER_NAME=%s\\n' \"${TLH_RUNTIME_WRAPPER_NAME:-}\"",
      "printf 'TLH_WRAPPER_NAME=%s\\n' \"${TLH_WRAPPER_NAME:-}\"",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const wrapperPath = join(root, wrapperName);
  writeFileSync(
    wrapperPath,
    renderWrapper({
      ...BASE_ARGS,
      agentDir: join(root, "agent"),
      binDir: root,
      packageRoot: REPO_ROOT,
      wrapperName,
      piCmd,
    }),
    { mode: 0o755 },
  );
  const env = { ...process.env, HOME: root };
  delete env.TLH_WRAPPER_NAME;
  delete env.TLH_RUNTIME_WRAPPER_NAME;
  return spawnSync("bash", [wrapperPath], { cwd: root, env, encoding: "utf8" });
}

test("rendered wrapper: launch environment carries the runtime wrapper name only", (t) => {
  for (const name of ["tlh", "tlh-alt"]) {
    const result = launchWithStubPi(t, name);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`^TLH_RUNTIME_WRAPPER_NAME=${name}$`, "m"));
    assert.match(result.stdout, /^TLH_WRAPPER_NAME=$/m);
  }
});

test("renderWrapper: MCP adapter startup guard runs before the pinned pi exec", () => {
  const rendered = renderWrapper(PINNED_ARGS);
  const guardIndex = rendered.indexOf(
    'scripts/lib/mcp-adapter-cutover.mjs" --startup-guard --agent-dir "${default_agent_dir}"',
  );
  const piExecIndex = rendered.indexOf('exec "${default_pi_cmd}" "$@"');

  assert.ok(guardIndex >= 0, "rendered wrapper must invoke the MCP adapter startup guard");
  assert.ok(piExecIndex >= 0, "rendered wrapper must exec the pinned pi runtime");
  assert.ok(guardIndex < piExecIndex, "startup guard must run before the pinned pi runtime");
  assert.ok(
    rendered.includes("tlh_package_mcp_adapter_guard_is_usable()"),
    "rendered wrapper must validate the startup guard support graph",
  );
});

test("renderWrapper: NODE_COMPILE_CACHE export is present exactly once in the pi exec path", () => {
  const rendered = renderWrapper(PINNED_ARGS);
  const lines = rendered.split("\n");

  const compileCacheLines = lines.filter((line) => line.includes("NODE_COMPILE_CACHE"));
  assert.equal(
    compileCacheLines.length,
    1,
    `expected exactly one NODE_COMPILE_CACHE line; got: ${JSON.stringify(compileCacheLines)}`,
  );
  assert.equal(
    compileCacheLines[0],
    'export NODE_COMPILE_CACHE="${tlh_pinned_dir%/*}/node-compile-cache"',
  );
});

test("renderWrapper: NODE_COMPILE_CACHE export precedes both the bridge launch and the plain pinned pi exec", () => {
  const rendered = renderWrapper(PINNED_ARGS);
  const lines = rendered.split("\n");

  const ncIndex = lines.indexOf(
    'export NODE_COMPILE_CACHE="${tlh_pinned_dir%/*}/node-compile-cache"',
  );
  const execIndex = lines.indexOf('exec "${default_pi_cmd}" "$@"');
  const bridgeIndex = lines.findIndex((line) => line.includes('exec "${tlh_node_cmd}" --import'));

  assert.ok(ncIndex >= 0, "NODE_COMPILE_CACHE export line must be present");
  assert.ok(execIndex >= 0, 'exec "${default_pi_cmd}" "$@" line must be present');
  assert.ok(bridgeIndex > ncIndex, "bridge launch must come after the NODE_COMPILE_CACHE export");
  assert.ok(execIndex > bridgeIndex, "plain pi exec must remain the final line of the wrapper");
  assert.equal(lines[execIndex + 1], "");
  assert.equal(lines.length, execIndex + 2);
});

test("renderWrapper: helper branch exec lines do not include NODE_COMPILE_CACHE", () => {
  const rendered = renderWrapper(PINNED_ARGS);
  const lines = rendered.split("\n");

  // Helper branches use 'exec "${tlh_node_cmd}"' to run Node helper scripts.
  // NODE_COMPILE_CACHE must not appear on those lines.
  const helperExecLines = lines.filter((line) => line.includes('exec "${tlh_node_cmd}"'));
  assert.ok(helperExecLines.length > 0, "at least one helper exec line must exist");
  for (const line of helperExecLines) {
    assert.ok(
      !line.includes("NODE_COMPILE_CACHE"),
      `helper exec line must not include NODE_COMPILE_CACHE: ${line}`,
    );
  }
});

test("renderWrapper: sessions guard function is present and points to tlh-sessions.mjs", () => {
  const rendered = renderWrapper(BASE_ARGS);
  assert.ok(
    rendered.includes("tlh_package_sessions_script_is_usable()"),
    "rendered wrapper must define tlh_package_sessions_script_is_usable",
  );
  assert.ok(
    rendered.includes(
      'tlh_package_script_is_usable "${default_tlh_package_root}/scripts/tlh-sessions.mjs"',
    ),
    "sessions guard must check scripts/tlh-sessions.mjs via tlh_package_script_is_usable",
  );
});

test("renderWrapper: sessions subcommand block is present with correct structure", () => {
  const rendered = renderWrapper(BASE_ARGS);
  assert.ok(
    rendered.includes('if [[ "${1:-}" == "sessions" ]]; then'),
    "rendered wrapper must contain sessions subcommand block",
  );
  assert.ok(
    rendered.includes("if ! tlh_package_sessions_script_is_usable; then"),
    "sessions block must check guard before proceeding",
  );
  assert.ok(
    rendered.includes(
      "tlh sessions package support files are missing or corrupt; run `tlh update` to recover.",
    ),
    "sessions block must emit correct error message when guard fails",
  );
  assert.ok(
    rendered.includes(
      '"${default_tlh_package_root}/scripts/tlh-sessions.mjs" --agent-dir "${default_agent_dir}"',
    ),
    "sessions exec must pass --agent-dir explicitly",
  );
});

test("renderWrapper: sessions subcommand uses tlh_sanitized_path (not tlh_managed_helper_path)", () => {
  const rendered = renderWrapper(BASE_ARGS);
  const lines = rendered.split("\n");
  const sessionsExecLine = lines.find(
    (line) => line.includes('exec "${tlh_node_cmd}"') && line.includes("tlh-sessions.mjs"),
  );
  assert.ok(sessionsExecLine, "sessions exec line must be present");
  assert.ok(
    sessionsExecLine.includes('PATH="${tlh_sanitized_path}"'),
    `sessions exec must use tlh_sanitized_path; got: ${sessionsExecLine}`,
  );
  assert.ok(
    !sessionsExecLine.includes("tlh_managed_helper_path"),
    "sessions exec must not use tlh_managed_helper_path",
  );
});

test("renderWrapper: sessions subcommand block appears before the pinned pi runtime exec", () => {
  const rendered = renderWrapper(PINNED_ARGS);
  const sessionsIndex = rendered.indexOf('if [[ "${1:-}" == "sessions" ]]; then');
  const piExecIndex = rendered.indexOf('exec "${default_pi_cmd}" "$@"');
  assert.ok(sessionsIndex >= 0, "sessions block must be present");
  assert.ok(piExecIndex >= 0, "pi exec line must be present");
  assert.ok(
    sessionsIndex < piExecIndex,
    "sessions block must appear before the pinned pi runtime exec",
  );
});

test("renderWrapper: PI_PROGRAM_STATUS is exported with default 0 when unset", () => {
  const rendered = renderWrapper(BASE_ARGS);
  assert.ok(
    rendered.includes('export PI_PROGRAM_STATUS="${PI_PROGRAM_STATUS:-0}"'),
    "rendered wrapper must export PI_PROGRAM_STATUS defaulting to 0",
  );
});

test("renderWrapper: PI_PROGRAM_STATUS export appears immediately after PI_CODING_AGENT_DIR export", () => {
  const rendered = renderWrapper(BASE_ARGS);
  const lines = rendered.split("\n");
  const agentDirIndex = lines.indexOf('export PI_CODING_AGENT_DIR="${default_agent_dir}"');
  const programStatusIndex = lines.indexOf('export PI_PROGRAM_STATUS="${PI_PROGRAM_STATUS:-0}"');
  assert.ok(agentDirIndex >= 0, "PI_CODING_AGENT_DIR export line must be present");
  assert.ok(programStatusIndex >= 0, "PI_PROGRAM_STATUS export line must be present");
  assert.equal(
    agentDirIndex + 1,
    programStatusIndex,
    "PI_PROGRAM_STATUS export must be the line immediately after PI_CODING_AGENT_DIR export",
  );
});

test("renderWrapper: PI_PROGRAM_STATUS preserves user-provided value (uses :- default syntax)", () => {
  const rendered = renderWrapper(BASE_ARGS);
  // The :- syntax means user-set PI_PROGRAM_STATUS is preserved; only unset gets 0.
  assert.ok(
    rendered.includes('"${PI_PROGRAM_STATUS:-0}"'),
    "PI_PROGRAM_STATUS must use :-0 default so a user-set value is preserved",
  );
  // Must not use plain assignment that would clobber a user-set value.
  assert.ok(
    !rendered.includes("PI_PROGRAM_STATUS=0"),
    "PI_PROGRAM_STATUS must not use plain =0 assignment that would clobber a user-set value",
  );
});

test("renderWrapper: NODE_COMPILE_CACHE export uses tlh_pinned_dir%/* (strip bin dir → runtime prefix)", () => {
  // With piCmd="/a/runtime/bin/pi":
  //   tlh_pinned_dir="${default_pi_cmd%/*}"  → "/a/runtime/bin"
  //   ${tlh_pinned_dir%/*}                   → "/a/runtime"
  //   NODE_COMPILE_CACHE                     → "/a/runtime/node-compile-cache"
  // The shell expression must be verbatim so it evaluates correctly at runtime.
  const rendered = renderWrapper({
    ...BASE_ARGS,
    piCmd: "/a/runtime/bin/pi",
  });
  assert.ok(
    rendered.includes('export NODE_COMPILE_CACHE="${tlh_pinned_dir%/*}/node-compile-cache"'),
    "rendered wrapper must contain the verbatim NODE_COMPILE_CACHE export expression",
  );
});

test("renderWrapper: version subcommand is wired before the MCP guard and pi exec", () => {
  const rendered = renderWrapper(PINNED_ARGS);
  const versionIndex = rendered.indexOf('if [[ "${1:-}" == "version" ]]; then');
  const guardIndex = rendered.indexOf("tlh_mcp_adapter_guard_required=1");
  const piExecIndex = rendered.indexOf('exec "${default_pi_cmd}" "$@"');
  assert.ok(versionIndex >= 0, "version block must be present");
  assert.ok(versionIndex < guardIndex, "version block must precede the MCP guard");
  assert.ok(versionIndex < piExecIndex, "version block must precede the pi exec");
  assert.ok(
    rendered.includes(
      '"${default_tlh_package_root}/scripts/tlh-version.mjs" --agent-dir "${default_agent_dir}" --package-root "${default_tlh_package_root}" --pi-cmd "${default_pi_cmd}" "$@"',
    ),
    "version exec must pass baked agent dir, package root, and pi cmd",
  );
  assert.ok(
    rendered.includes("tlh version package support files are missing or corrupt"),
    "version block must emit recovery error",
  );
});

test("renderWrapper: --version is still handled outside the version subcommand", () => {
  const rendered = renderWrapper(PINNED_ARGS);
  assert.ok(rendered.includes("--version|-v|install|remove|uninstall|list|mcp)"));
  assert.ok(!rendered.includes('"${1:-}" == "--version"'));
});

function runRenderedWrapper(t, { withScript }) {
  const root = mkdtempSync(join(tmpdir(), "tlh-wrapper-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = join(root, "package");
  const agentDir = join(root, "agent");
  mkdirSync(join(packageRoot, "scripts"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  if (withScript) {
    for (const name of ["tlh-version.mjs"]) {
      copyFileSync(join(REPO_ROOT, "scripts", name), join(packageRoot, "scripts", name));
    }
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ version: "9.9.9" }));
  }
  const wrapperPath = join(root, "tlh");
  writeFileSync(
    wrapperPath,
    renderWrapper({ ...BASE_ARGS, agentDir, packageRoot, binDir: root, piCmd: "" }),
    { mode: 0o755 },
  );
  const result = spawnSync("bash", [wrapperPath, "version", "--json"], {
    encoding: "utf8",
    env: { ...process.env, HOME: root },
  });
  return { result, agentDir };
}

test("rendered wrapper: version --json runs tlh-version.mjs with the baked agent dir", (t) => {
  const { result, agentDir } = runRenderedWrapper(t, { withScript: true });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.agentDir, agentDir);
});

test("rendered wrapper: version with missing script prints recovery error and exits 1", (t) => {
  const { result } = runRenderedWrapper(t, { withScript: false });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /tlh version package support files are missing or corrupt; run `tlh update` to recover\./,
  );
});

function wrapperFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tlh-wrapper-symlink-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const args = { ...BASE_ARGS, binDir, piCmd: "", force: false, quiet: true };
  return { root, binDir, args, path: join(binDir, "tlh") };
}

test("writeWrapper: dangling symlink at wrapper path is refused without --force", (t) => {
  const { root, args, path } = wrapperFixture(t);
  const target = join(root, "missing-target");
  symlinkSync(target, path);
  assert.throws(() => writeWrapper(args, path), /already exists and is not managed/);
  assert.equal(readlinkSync(path), target);
  assert.equal(existsSync(target), false);
});

test("writeWrapper: --force replaces a dangling symlink without following it", (t) => {
  const { root, args, path } = wrapperFixture(t);
  const target = join(root, "missing-target");
  symlinkSync(target, path);
  writeWrapper({ ...args, force: true }, path);
  assert.equal(lstatSync(path).isSymbolicLink(), false);
  assert.match(readFileSync(path, "utf8"), new RegExp(DEFAULT_MARKER));
  assert.equal(existsSync(target), false);
});

test("writeWrapper: pre-existing symlink at the temp path is not followed", (t) => {
  const { root, args, path } = wrapperFixture(t);
  const victim = join(root, "victim");
  writeFileSync(victim, "keep", { mode: 0o600 });
  symlinkSync(victim, `${path}.tmp.${process.pid}`);
  writeWrapper(args, path);
  assert.equal(readFileSync(victim, "utf8"), "keep");
  assert.equal(lstatSync(victim).mode & 0o777, 0o600);
  assert.match(readFileSync(path, "utf8"), new RegExp(DEFAULT_MARKER));
});

test("tlh-wrapper --dry-run warns for a dangling symlink at the wrapper path", (t) => {
  const { root, binDir, path } = wrapperFixture(t);
  symlinkSync(join(root, "missing-target"), path);
  const result = spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, "scripts/tlh-wrapper.mjs"),
      "--dry-run",
      "--agent-dir",
      join(root, "agent"),
      "--bin-dir",
      binDir,
      "--wrapper-name",
      "tlh",
      "--package-root",
      REPO_ROOT,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /would not overwrite unmanaged existing wrapper/);
});

test("writeWrapper: live symlink to a managed wrapper is replaced without --force", (t) => {
  const { root, args, path } = wrapperFixture(t);
  const target = join(root, "managed-target");
  writeFileSync(target, renderWrapper({ ...args, packageRoot: REPO_ROOT }));
  symlinkSync(target, path);
  writeWrapper(args, path);
  assert.equal(lstatSync(path).isSymbolicLink(), false);
  assert.match(readFileSync(path, "utf8"), new RegExp(DEFAULT_MARKER));
});

test("writeWrapper: directory at the wrapper path is refused without --force", (t) => {
  const { args, path } = wrapperFixture(t);
  mkdirSync(path);
  assert.throws(() => writeWrapper(args, path), /already exists and is not managed/);
});

test(
  "writeWrapper: FIFO at the wrapper path is never opened and needs --force",
  { timeout: 10_000 },
  (t) => {
    const { args, path } = wrapperFixture(t);
    const made = spawnSync("mkfifo", [path], { encoding: "utf8" });
    if (made.error || made.status !== 0) {
      t.skip("mkfifo unavailable");
      return;
    }
    assert.throws(() => writeWrapper(args, path), /already exists and is not managed/);
    writeWrapper({ ...args, force: true }, path);
    assert.equal(lstatSync(path).isFile(), true);
    assert.match(readFileSync(path, "utf8"), new RegExp(DEFAULT_MARKER));
  },
);

test("renderWrapper: stashes then unsets OSC7577_TOKEN right after the line-3 marker, before any export or exec", () => {
  const rendered = renderWrapper(PINNED_ARGS);
  const lines = rendered.split("\n");
  assert.equal(lines[2], `# ${DEFAULT_MARKER}`);
  assert.equal(lines[3], 'tlh_osc7577_stash="${OSC7577_TOKEN-}"');
  assert.equal(lines[4], "unset -v OSC7577_TOKEN");
  assert.equal(lines[5], "export -n tlh_osc7577_stash");
  assert.equal(lines[6], "unset -v TLH_PROGRAM_RESUME_ACTIVE");
  assert.equal(rendered.split("unset -v OSC7577_TOKEN").length - 1, 1);
  const unsetIndex = rendered.indexOf("unset -v OSC7577_TOKEN");
  assert.ok(unsetIndex < rendered.indexOf("export PATH"));
  assert.ok(unsetIndex < rendered.indexOf("export TLH_PROGRAM_RESUME_ACTIVE"));
  assert.ok(unsetIndex < rendered.indexOf("tlh_js_relative_imports_exist() {"));
  for (const match of rendered.matchAll(/exec "/g)) {
    assert.ok(unsetIndex < match.index);
  }
});

function launchOsc(t, { token, subcommand }) {
  const root = mkdtempSync(join(tmpdir(), "tlh-wrapper-osc7577-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const piCmd = join(root, "runtime", "bin", "pi");
  mkdirSync(dirname(piCmd), { recursive: true });
  writeFileSync(piCmd, '#!/usr/bin/env bash\nprintf "pi:%s\\n" "${OSC7577_TOKEN-unset}"\n', {
    mode: 0o755,
  });
  const fakeBin = join(root, "fakebin");
  mkdirSync(fakeBin);
  writeFileSync(
    join(fakeBin, "node"),
    '#!/bin/sh\nprintf "node:%s\\n" "${OSC7577_TOKEN-unset}"\n',
    {
      mode: 0o755,
    },
  );
  const wrapperPath = join(root, "tlh");
  writeFileSync(
    wrapperPath,
    renderWrapper({
      ...BASE_ARGS,
      agentDir: join(root, "agent"),
      binDir: root,
      packageRoot: REPO_ROOT,
      piCmd,
    }),
    { mode: 0o755 },
  );
  const env = { ...process.env, HOME: root, PATH: `${fakeBin}:${process.env.PATH}` };
  delete env.OSC7577_TOKEN;
  if (token !== undefined) env.OSC7577_TOKEN = token;
  return spawnSync("bash", subcommand ? [wrapperPath, subcommand] : [wrapperPath], {
    cwd: root,
    env,
    encoding: "utf8",
  });
}

test("rendered wrapper: pi exec does not receive OSC7577_TOKEN", (t) => {
  const result = launchOsc(t, { token: "secret-token" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^pi:unset$/m);
  assert.doesNotMatch(result.stdout + result.stderr, /secret-token/);
});

test("rendered wrapper: node helper subcommands do not receive OSC7577_TOKEN", (t) => {
  const result = launchOsc(t, { token: "secret-token", subcommand: "defaults" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^node:unset$/m);
});

test("rendered wrapper: runs normally under set -u when OSC7577_TOKEN is absent", (t) => {
  const result = launchOsc(t, {});
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^pi:unset$/m);
});

// Matrix derived from Pi 1.7.0 dist/cli/agent-dir-arg.js: early extraction
// compares each arg to exactly "--agent-dir" (taking the next arg as value, even
// if it is another option's value), stops at "--", does not parse "--agent-dir=X"
// (rejected anyway), and a missing value is a Pi error. Repeats are all honoured.
function runAgentDirWrapper(t, args) {
  const root = mkdtempSync(join(tmpdir(), "tlh-wrapper-agent-dir-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const piCmd = join(root, "runtime", "bin", "pi");
  const marker = join(root, "pi-ran");
  mkdirSync(dirname(piCmd), { recursive: true });
  writeFileSync(
    piCmd,
    `#!/usr/bin/env bash\nprintf 'ARGS:' > "${marker}"\nfor a in "$@"; do printf '[%s]' "$a" >> "${marker}"; done\n`,
    { mode: 0o755 },
  );
  const wrapperPath = join(root, "tlh");
  writeFileSync(
    wrapperPath,
    renderWrapper({
      ...BASE_ARGS,
      agentDir: join(root, "agent"),
      binDir: root,
      packageRoot: join(root, "pkg"),
      piCmd,
    }),
    { mode: 0o755 },
  );
  const result = spawnSync("bash", [wrapperPath, ...args], {
    cwd: root,
    env: { ...process.env, HOME: root },
    encoding: "utf8",
  });
  return { result, ran: existsSync(marker), marker };
}

test("rendered wrapper: refuses every argv shape Pi 1.7.0 honours as --agent-dir", (t) => {
  const refusedArgv = [
    ["--agent-dir", "/x"],
    ["--agent-dir"],
    ["--agent-dir=/x"],
    ["--agent-dir", "/x", "--agent-dir", "/y"],
    ["-p", "--agent-dir", "/x", "hi"],
    ["--model", "m", "--agent-dir", "/x"],
    ["--session", "s", "--agent-dir", "/x"],
    ["--model", "--agent-dir", "/x"],
    ["hello", "--agent-dir", "/x"],
    ["--agent-dir", "--", "x"],
    ["mcp", "--agent-dir", "/x"],
  ];
  for (const args of refusedArgv) {
    const { result, ran } = runAgentDirWrapper(t, args);
    const label = JSON.stringify(args);
    assert.notEqual(result.status, 0, label);
    assert.match(result.stderr, /--agent-dir/, label);
    assert.match(result.stderr, /not supported/, label);
    assert.equal(ran, false, `pi must not run: ${label}`);
    // The MCP guard would fail on the missing package root with a different message.
    assert.doesNotMatch(result.stderr, /startup guard/, label);
  }
});

test("rendered wrapper: ordinary args and --agent-dir substrings or after -- reach pi unchanged", (t) => {
  const cases = [
    ["--session", "abc"],
    ["explain --agent-dir to me"],
    ["x--agent-dir", "--agent-dirs"],
    ["--", "--agent-dir", "/x"],
  ];
  for (const args of cases) {
    const { result, ran, marker } = runAgentDirWrapper(t, ["mcp", ...args]);
    assert.equal(result.status, 0, `${JSON.stringify(args)}: ${result.stderr}`);
    assert.equal(ran, true);
    assert.equal(
      readFileSync(marker, "utf8"),
      `ARGS:${["mcp", ...args].map((a) => `[${a}]`).join("")}`,
    );
  }
});

/**
 * Unit tests for the renderWrapper function in scripts/tlh-wrapper.mjs.
 * These tests check the rendered shell-script string directly, without
 * executing the wrapper.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { renderWrapper } from "../scripts/tlh-wrapper.mjs";

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

test("renderWrapper: NODE_COMPILE_CACHE export appears immediately before exec of pinned pi", () => {
  const rendered = renderWrapper(PINNED_ARGS);
  const lines = rendered.split("\n");

  const ncIndex = lines.indexOf(
    'export NODE_COMPILE_CACHE="${tlh_pinned_dir%/*}/node-compile-cache"',
  );
  const execIndex = lines.indexOf('exec "${default_pi_cmd}" "$@"');

  assert.ok(ncIndex >= 0, "NODE_COMPILE_CACHE export line must be present");
  assert.ok(execIndex >= 0, 'exec "${default_pi_cmd}" "$@" line must be present');
  assert.equal(
    ncIndex + 1,
    execIndex,
    "NODE_COMPILE_CACHE export must be the line immediately before the pi exec",
  );
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
  return spawnSync("bash", [wrapperPath, "version", "--json"], {
    encoding: "utf8",
    env: { ...process.env, HOME: root },
  });
}

test("rendered wrapper: version --json runs tlh-version.mjs with the baked agent dir", (t) => {
  const result = runRenderedWrapper(t, { withScript: true });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(typeof parsed, "object");
  assert.ok(result.stdout.includes("agent"), "output should reference the baked agent dir");
});

test("rendered wrapper: version with missing script prints recovery error and exits 1", (t) => {
  const result = runRenderedWrapper(t, { withScript: false });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /tlh version package support files are missing or corrupt; run `tlh update` to recover\./,
  );
});

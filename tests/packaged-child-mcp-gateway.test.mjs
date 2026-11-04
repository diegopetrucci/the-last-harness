import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildPiArgs } from "../extensions/subagents/src/runs/shared/pi-args.js";

// Go/no-go gate for Pi-native MCP: a restricted child (explicit --tools allowlist plus
// `codemode` and `mcp__*`) must reach MCP servers through the real pinned Pi runtime. Every
// assertion is derived from Pi's `--mode json` / `--mode rpc` event stream or from what the
// fixture server processes themselves observed; the model is a deterministic faux provider.
const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testsDir, "..");
const supportDir = join(testsDir, "support");
const fixtureServerPath = join(supportDir, "packaged-child-mcp-gateway-fixture.mjs");
const fauxProviderPath = join(supportDir, "packaged-child-mcp-gateway-faux-provider.mjs");
const piBinPath = join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "pi.cmd" : "pi",
);

// The restricted child's `--tools` value comes from TLH's real child argv builder for an agent
// that declares `read, codemode`, so this gate covers the argv TLH actually emits.
const builtChildArgs = buildPiArgs({
  baseArgs: ["-p"],
  task: "go",
  sessionEnabled: false,
  inheritProjectContext: false,
  inheritSkills: false,
  supervisorBridge: false,
  tools: ["read", "codemode"],
}).args;
const RESTRICTED_TOOLS = builtChildArgs[builtChildArgs.indexOf("--tools") + 1];
const READ_ONLY_TOOLS = "read,codemode";

function isolatedEnv(root, extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key.startsWith("PI_") ||
      key.startsWith("TLH_") ||
      /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(key)
    ) {
      continue;
    }
    env[key] = value;
  }
  return {
    ...env,
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    PI_CODING_AGENT_DIR: join(root, "agent"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    TLH_SKIP_TELEMETRY: "1",
    TLH_SKIP_UPDATE_CHECK: "1",
    TMPDIR: join(root, "tmp"),
    ...extra,
  };
}

/** Creates a temp profile with two fixture servers: `cm` (codemode exposure) and `dir` (direct). */
function createProfile() {
  const root = mkdtempSync(join(tmpdir(), "tlh-native-mcp-gateway-"));
  for (const dir of ["agent", "workspace", "home", "tmp"]) mkdirSync(join(root, dir));
  const logPath = join(root, "fixture.log");
  const server = (name, exposure) => ({
    command: process.execPath,
    args: [fixtureServerPath],
    env: { FIXTURE_NAME: name, FIXTURE_LOG: logPath },
    exposure,
  });
  writeFileSync(
    join(root, "agent", "mcp.json"),
    `${JSON.stringify({ mcpServers: { cm: server("cm", "codemode"), dir: server("dir", "direct") } })}\n`,
  );
  const readLog = () =>
    existsSync(logPath)
      ? readFileSync(logPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  return { root, cwd: join(root, "workspace"), readLog };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitFor(predicate, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${description}`);
}

/** Spawns the real pinned `pi` with the faux model and collects its JSONL event stream. */
function startPi(profile, { mode, tools, steps }) {
  const stepsPath = join(profile.root, "steps.json");
  writeFileSync(stepsPath, JSON.stringify(steps));
  const args = [
    ...(mode === "json" ? ["-p", "--mode", "json"] : ["--mode", "rpc"]),
    "--no-session",
    "--extension",
    fauxProviderPath,
    "--model",
    "faux/child",
    "--tools",
    tools,
    ...(mode === "json" ? ["go"] : []),
  ];
  const child = spawn(piBinPath, args, {
    cwd: profile.cwd,
    env: isolatedEnv(profile.root, { FAUX_STEPS: stepsPath }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    let newline = stdout.indexOf("\n");
    while (newline !== -1) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (line.trim()) events.push(JSON.parse(line));
      newline = stdout.indexOf("\n");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  const send = (command) => child.stdin.write(`${JSON.stringify(command)}\n`);
  if (mode === "json") child.stdin.end();
  return {
    child,
    events,
    send,
    exited,
    stderr: () => stderr,
    debug: () => JSON.stringify({ stderr, events: events.map((event) => event.type) }),
  };
}

const toolEnds = (events, toolName) =>
  events.filter((event) => event.type === "tool_execution_end" && event.toolName === toolName);
const resultText = (event) => event.result.content.map((part) => part.text ?? "").join("\n");

async function runToCompletion(profile, options) {
  const pi = startPi(profile, { mode: "json", ...options });
  const { code } = await pi.exited;
  assert.equal(code, 0, pi.debug());
  return pi;
}

function assertNoFixtureProcessesLeft(profile) {
  const pids = [...new Set(profile.readLog().map((entry) => entry.pid))];
  assert.ok(pids.length > 0, "fixture servers must have started");
  for (const pid of pids) {
    assert.equal(isAlive(pid), false, `fixture server pid ${pid} must exit with the child`);
  }
}

function withProfile(body) {
  return async () => {
    const profile = createProfile();
    try {
      await body(profile);
    } finally {
      // Never leave stray fixture servers behind, even when an assertion failed.
      for (const pid of new Set(profile.readLog().map((entry) => entry.pid))) {
        if (isAlive(pid)) process.kill(pid, "SIGKILL");
      }
      rmSync(profile.root, { recursive: true, force: true });
      assert.equal(existsSync(profile.root), false, "temp profile must be removed");
    }
  };
}

test(
  "restricted child calls a codemode-exposure MCP server from codemode and sees isError resolve",
  { timeout: 120_000 },
  withProfile(async (profile) => {
    const code = `
      const ok = await tools.mcp__cm__read_fixture({});
      const failed = await tools.mcp__cm__fail_fixture({});
      return JSON.stringify({ ok: ok.content[0].text, failedIsError: failed.isError, failed: failed.content[0].text });
    `;
    const pi = await runToCompletion(profile, {
      tools: RESTRICTED_TOOLS,
      steps: [{ tool: "codemode", args: { code } }, { text: "done" }],
    });

    const [script] = toolEnds(pi.events, "codemode");
    assert.equal(script.isError, false, resultText(script));
    assert.match(resultText(script), /^Script completed/);
    const returned = JSON.parse(resultText(script).split("\n").at(-1));
    assert.deepEqual(returned, {
      ok: "FIXTURE_OK:cm",
      failedIsError: true,
      failed: "FIXTURE_ERROR:cm",
    });

    // The MCP calls came from the codemode script, through Pi's tool pipeline.
    const scriptCallId = script.toolCallId;
    for (const name of ["mcp__cm__read_fixture", "mcp__cm__fail_fixture"]) {
      const [end] = toolEnds(pi.events, name);
      assert.equal(end.parentToolCallId, scriptCallId, `${name} must be a codemode child call`);
    }
    assert.equal(toolEnds(pi.events, "mcp__cm__fail_fixture")[0].isError, true);
    const calls = profile.readLog().filter((entry) => entry.event === "tools/call" && entry.tool);
    assert.deepEqual(
      calls.map((entry) => `${entry.server}:${entry.tool}`),
      ["cm:read_fixture", "cm:fail_fixture"],
    );
    assertNoFixtureProcessesLeft(profile);
  }),
);

test(
  "restricted child reaches a direct-exposure MCP server only because --tools has mcp__*",
  { timeout: 120_000 },
  withProfile(async (profile) => {
    const pi = await runToCompletion(profile, {
      tools: RESTRICTED_TOOLS,
      steps: [{ tool: "mcp__dir__read_fixture" }, { text: "done" }],
    });
    const [direct] = toolEnds(pi.events, "mcp__dir__read_fixture");
    assert.equal(direct.isError, false, resultText(direct));
    assert.equal(resultText(direct), "FIXTURE_OK:dir");
    assert.equal(direct.parentToolCallId, undefined, "the call must be a direct model call");
    assertNoFixtureProcessesLeft(profile);
  }),
);

test(
  "without an mcp__ entry the same direct-exposure tool is not callable by the model",
  { timeout: 120_000 },
  withProfile(async (profile) => {
    const pi = await runToCompletion(profile, {
      tools: READ_ONLY_TOOLS,
      steps: [{ tool: "mcp__dir__read_fixture" }, { text: "done" }],
    });
    const [direct] = toolEnds(pi.events, "mcp__dir__read_fixture");
    assert.equal(
      direct.isError,
      true,
      "direct tool must be rejected without an mcp__ allowlist entry",
    );
    assert.equal(
      profile.readLog().some((entry) => entry.event === "tools/call" && entry.tool),
      false,
      "the fixture server must never receive a call",
    );
    assertNoFixtureProcessesLeft(profile);
  }),
);

test(
  "tools outside the allowlist are not callable from codemode",
  { timeout: 120_000 },
  withProfile(async (profile) => {
    const code = `
      const outcome = {};
      for (const name of ["write", "edit", "bash"]) {
        try {
          await tools[name]({ path: "escape.txt", content: "x", command: "true" });
          outcome[name] = "called";
        } catch (error) {
          outcome[name] = String(error.message);
        }
      }
      outcome.listed = ALL_TOOLS.map((tool) => tool.name).filter((name) => !name.startsWith("mcp__"));
      return JSON.stringify(outcome);
    `;
    const pi = await runToCompletion(profile, {
      tools: RESTRICTED_TOOLS,
      steps: [{ tool: "codemode", args: { code } }, { text: "done" }],
    });
    const [script] = toolEnds(pi.events, "codemode");
    const outcome = JSON.parse(resultText(script).split("\n").at(-1));
    for (const name of ["write", "edit", "bash"]) {
      assert.match(
        outcome[name],
        /does not exist/,
        `${name} must not be callable: ${resultText(script)}`,
      );
    }
    assert.deepEqual(outcome.listed, ["read"]);
    assert.equal(
      toolEnds(pi.events, "write").length +
        toolEnds(pi.events, "edit").length +
        toolEnds(pi.events, "bash").length,
      0,
    );
    assert.equal(existsSync(join(profile.cwd, "escape.txt")), false);
    assertNoFixtureProcessesLeft(profile);
  }),
);

test(
  "aborting a running codemode MCP call ends it and cancels it on the server",
  { timeout: 120_000 },
  withProfile(async (profile) => {
    const pi = startPi(profile, {
      mode: "rpc",
      tools: RESTRICTED_TOOLS,
      steps: [
        {
          tool: "codemode",
          args: { code: "return JSON.stringify(await tools.mcp__cm__slow_fixture({}));" },
        },
        { text: "unreachable after abort" },
      ],
    });
    try {
      pi.send({ type: "prompt", message: "go" });
      await waitFor(
        () =>
          profile
            .readLog()
            .some((entry) => entry.event === "tools/call" && entry.tool === "slow_fixture"),
        `the slow MCP call to reach the fixture\n${pi.debug()}`,
      );
      assert.equal(toolEnds(pi.events, "codemode").length, 0, "the script must still be running");

      pi.send({ type: "abort" });
      await waitFor(
        () => pi.events.some((event) => event.type === "agent_settled"),
        "agent_settled",
      );
      assert.equal(pi.events.find((event) => event.type === "agent_settled").aborted, true);
      const [script] = toolEnds(pi.events, "codemode");
      assert.ok(script, `the aborted codemode call must end\n${pi.debug()}`);
      assert.equal(script.isError, true);
      await waitFor(
        () => profile.readLog().some((entry) => entry.event === "slow_fixture:cancelled"),
        "the server to observe the MCP cancellation",
      );
    } finally {
      pi.child.stdin.end();
    }
    const { code } = await pi.exited;
    assert.equal(code, 0, pi.debug());
    assertNoFixtureProcessesLeft(profile);
  }),
);

test("buildPiArgs emits codemode and mcp__* for a codemode-declaring agent", () => {
  assert.equal(RESTRICTED_TOOLS, "read,codemode,mcp__*");
});

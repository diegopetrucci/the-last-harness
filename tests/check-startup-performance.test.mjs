import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";

import { PYTHON_PTY_BRIDGE_FOR_TESTS } from "../scripts/check-startup-performance.mjs";
import { renderWrapper } from "../scripts/tlh-wrapper.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const checkStartupPerformanceScript = join(repoRoot, "scripts", "check-startup-performance.mjs");
const SYNTHETIC_FIXTURE_LIFETIME_SECONDS = 120;
const TEST_PROCESS_CLEANUP_TIMEOUT_MS = 5000;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function delay(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function waitForCondition(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) {
      return result;
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function writeExecutable(path, content) {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

function hasPython3PtyBridge() {
  const result = spawnSync("python3", ["-c", "pass"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function createDirectBridgeFixture(body) {
  const root = mkdtempSync(join(tmpdir(), "tlh-python-pty-bridge-test-"));
  const commandPath = join(root, "fixture.sh");
  const pidFile = join(root, "fixture.pid");
  const bridgePidFile = join(root, "bridge.pid");
  const readyFile = join(root, "fixture.ready");
  writeExecutable(
    commandPath,
    `#!/usr/bin/env bash
set -euo pipefail
pid_file=${JSON.stringify(pidFile)}
bridge_pid_file=${JSON.stringify(bridgePidFile)}
ready_file=${JSON.stringify(readyFile)}
${body}
`,
  );
  return { bridgePidFile, commandPath, pidFile, readyFile, root };
}

function spawnDirectPtyBridge(commandPath) {
  const bridge = spawn("python3", ["-c", PYTHON_PTY_BRIDGE_FOR_TESTS, commandPath], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  let stderr = "";
  bridge.stdout.on("data", () => {});
  bridge.stdout.on("error", () => {});
  bridge.stderr.setEncoding("utf8");
  bridge.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  bridge.stderr.on("error", () => {});
  bridge.on("error", () => {});
  return { bridge, getStderr: () => stderr };
}

function waitForProcessExit(child, timeoutMs, description) {
  return new Promise((resolvePromise, rejectPromise) => {
    let timeoutHandle;
    const finish = (callback, value) => {
      clearTimeout(timeoutHandle);
      child.off("error", onError);
      child.off("close", onClose);
      callback(value);
    };
    const onError = (error) => {
      finish(rejectPromise, error);
    };
    const onClose = (code, signal) => {
      finish(resolvePromise, { code, signal });
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("error", onError);
    child.once("close", onClose);
    timeoutHandle = setTimeout(() => {
      finish(rejectPromise, new Error(`timed out waiting for ${description}`));
    }, timeoutMs);
  });
}

function processGroupExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "ESRCH") {
        return false;
      }
      if (error.code === "EPERM") {
        return true;
      }
    }
    throw error;
  }
}

function readPidFile(path) {
  if (!existsSync(path)) {
    return undefined;
  }
  const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "ESRCH") {
        return false;
      }
      if (error.code === "EPERM") {
        return true;
      }
    }
    throw error;
  }
}

function identityExists(pid, group) {
  return group ? processGroupExists(pid) || processExists(pid) : processExists(pid);
}

function sendSignal(pid, signal, group = false) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  try {
    process.kill(group ? -pid : pid, signal);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return;
    }
    throw error;
  }
}

function sendIdentitySignal(pid, signal, group) {
  if (!group) {
    sendSignal(pid, signal);
    return;
  }
  let groupAlive;
  try {
    groupAlive = processGroupExists(pid);
  } catch (error) {
    try {
      sendSignal(pid, signal);
    } catch (fallbackError) {
      throw new AggregateError(
        [error, fallbackError],
        "process-group and individual signal failed",
      );
    }
    throw error;
  }
  sendSignal(pid, signal, groupAlive);
}

async function waitForIdentityGone(pid, group) {
  const deadline = Date.now() + TEST_PROCESS_CLEANUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!identityExists(pid, group)) {
      return true;
    }
    await delay(25);
  }
  return !identityExists(pid, group);
}

async function stopProcessIdentity(pid, { group = false } = {}) {
  const failures = [];
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try {
      sendIdentitySignal(pid, signal, group);
    } catch (error) {
      failures.push(error);
    }
    try {
      if (await waitForIdentityGone(pid, group)) {
        break;
      }
    } catch (error) {
      failures.push(error);
    }
  }

  let surviving = false;
  try {
    surviving = identityExists(pid, group);
  } catch (error) {
    failures.push(error);
  }
  if (surviving) {
    failures.push(
      new Error(`${group ? "process group" : "process"} ${pid} survived TERM/KILL cleanup`),
    );
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${group ? "process group" : "process"} ${pid} cleanup failed`,
    );
  }
}

function waitForChildExit(child, timeoutMs = TEST_PROCESS_CLEANUP_TIMEOUT_MS) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolvePromise) => {
    let timeoutHandle;
    const finish = (result) => {
      clearTimeout(timeoutHandle);
      child.off("error", onError);
      child.off("close", onClose);
      resolvePromise(result);
    };
    const onError = () => {
      finish(true);
    };
    const onClose = () => {
      finish(true);
    };
    child.once("error", onError);
    child.once("close", onClose);
    timeoutHandle = setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

async function stopChildProcess(child, initialSignal = "SIGTERM") {
  const failures = [];
  const signals = initialSignal === "SIGKILL" ? ["SIGKILL"] : [initialSignal, "SIGTERM", "SIGKILL"];
  for (const signal of signals) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(signal);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      if (await waitForChildExit(child)) {
        break;
      }
    } catch (error) {
      failures.push(error);
    }
  }

  let surviving = false;
  try {
    surviving = processExists(child.pid);
  } catch (error) {
    failures.push(error);
  }
  if (surviving) {
    failures.push(new Error(`child process ${child.pid} survived TERM/KILL cleanup`));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `child process ${child.pid} cleanup failed`);
  }
}

function attemptCleanup(failures, label, cleanup) {
  return Promise.resolve()
    .then(cleanup)
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(new Error(`${label}: ${message}`));
    });
}

function throwCleanupFailures(failures) {
  if (failures.length > 0) {
    throw new AggregateError(failures, "startup-performance test cleanup failed");
  }
}

function isSafeTemporaryWorkspaceRoot(workspaceRoot) {
  const resolvedRoot = resolve(workspaceRoot);
  return (
    dirname(resolvedRoot) === resolve(tmpdir()) &&
    basename(resolvedRoot).startsWith("tlh-startup-performance-")
  );
}

function parseTemporaryWorkspace(stdout) {
  const linePattern = /^temporary profile: ([^\r\n]+)\r?\n/gm;
  let parsed;
  for (const match of stdout.matchAll(linePattern)) {
    const profilePath = resolve(match[1].trim());
    const workspaceRoot = resolve(dirname(profilePath));
    if (!isSafeTemporaryWorkspaceRoot(workspaceRoot)) {
      continue;
    }
    parsed = { profilePath, workspaceRoot };
  }
  return parsed;
}

function captureWorkspaceRoot(observed, stdout) {
  const parsed = parseTemporaryWorkspace(stdout);
  if (parsed) {
    observed.workspaceRoot ??= parsed.workspaceRoot;
  }
}

function captureDirectBridgeIdentity(observed, fixture) {
  observed.fixturePid ??= readPidFile(fixture.pidFile);
  observed.bridgeParentPid ??= readPidFile(fixture.bridgePidFile);
}

function registerDirectBridgeCleanup(t, fixture, bridge, observed) {
  t.after(async () => {
    const failures = [];
    await attemptCleanup(failures, "capture direct bridge identities", () =>
      captureDirectBridgeIdentity(observed, fixture),
    );
    await attemptCleanup(failures, "direct bridge", () => stopChildProcess(bridge));
    await attemptCleanup(failures, "direct bridge parent", () =>
      stopProcessIdentity(observed.bridgeParentPid),
    );
    await attemptCleanup(failures, "direct fixture process group", () =>
      stopProcessIdentity(observed.fixturePid, { group: true }),
    );
    await attemptCleanup(failures, "direct fixture", () =>
      rmSync(fixture.root, { recursive: true, force: true }),
    );
    throwCleanupFailures(failures);
  });
}

function createManagedWrapperFixture() {
  const root = mkdtempSync(join(tmpdir(), "tlh-check-startup-performance-test-"));
  const agentDir = join(root, "agent-source");
  const runtimeBinDir = join(root, "runtime", "bin");
  const wrapperBinDir = join(root, "bin");
  const packageRoot = join(root, "package-root");
  const wrapperPath = join(wrapperBinDir, "tlh");
  const piPath = join(runtimeBinDir, "pi");
  const customCommandPath = join(root, "custom-command.sh");

  mkdirSync(agentDir, { recursive: true });
  mkdirSync(runtimeBinDir, { recursive: true });
  mkdirSync(wrapperBinDir, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), "{}\n", "utf8");

  writeExecutable(
    piPath,
    `#!/usr/bin/env bash
set -euo pipefail
source_agent_dir=${JSON.stringify(agentDir)}
if [[ "\${PI_CODING_AGENT_DIR:-}" == "\${source_agent_dir}" ]]; then
  printf 'used original profile: %s\n' "\${PI_CODING_AGENT_DIR}" >&2
  exit 9
fi
printf 'Context: startup check\n'
printf 'agent: ready\n'
trap 'exit 0' INT TERM
fixture_deadline=$((SECONDS + ${SYNTHETIC_FIXTURE_LIFETIME_SECONDS}))
while (( SECONDS < fixture_deadline )); do
  sleep 1
done
`,
  );

  writeExecutable(
    customCommandPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ -z "\${PI_CODING_AGENT_DIR:-}" ]]; then
  printf 'missing PI_CODING_AGENT_DIR\n' >&2
  exit 9
fi
printf 'Context: custom command\n'
printf 'agent: ready\n'
trap 'exit 0' INT TERM
fixture_deadline=$((SECONDS + ${SYNTHETIC_FIXTURE_LIFETIME_SECONDS}))
while (( SECONDS < fixture_deadline )); do
  sleep 1
done
`,
  );

  writeExecutable(
    wrapperPath,
    renderWrapper({
      agentDir,
      binDir: wrapperBinDir,
      wrapperName: "tlh",
      packageRoot,
      piCmd: piPath,
    }),
  );

  return {
    agentDir,
    customCommandPath,
    root,
    wrapperBinDir,
    wrapperPath,
  };
}

function runCheckStartupPerformance(fixture, args) {
  return spawnSync(process.execPath, [checkStartupPerformanceScript, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.wrapperBinDir}:${process.env.PATH || ""}`,
    },
    timeout: 15000,
  });
}

test("SIGINT cleanup accepts only complete, safe temporary profile paths", () => {
  const temporaryRoot = resolve(tmpdir());
  const validWorkspaceRoot = join(temporaryRoot, "tlh-startup-performance-path-safety");
  const validProfilePath = join(validWorkspaceRoot, "agent");

  assert.deepEqual(parseTemporaryWorkspace(`temporary profile: ${validProfilePath}\n`), {
    profilePath: validProfilePath,
    workspaceRoot: validWorkspaceRoot,
  });
  assert.equal(parseTemporaryWorkspace(`temporary profile: ${validProfilePath}`), undefined);
  assert.equal(
    parseTemporaryWorkspace(
      `temporary profile: ${join(temporaryRoot, "not-a-startup-workspace", "agent")}\n`,
    ),
    undefined,
  );
  assert.equal(
    parseTemporaryWorkspace(`temporary profile: ${join(repoRoot, "agent")}\n`),
    undefined,
  );
});

test("direct Python PTY bridge cleans up when checker stdin reaches EOF", async (t) => {
  if (!hasPython3PtyBridge()) {
    t.skip("requires python3 PTY bridge coverage");
    return;
  }

  const fixture = createDirectBridgeFixture(`
trap 'exit 0' INT TERM
printf '%s\\n' "$$" >"$pid_file"
printf '%s\\n' "$PPID" >"$bridge_pid_file"
printf 'ready\\n' >"$ready_file"
fixture_deadline=$((SECONDS + ${SYNTHETIC_FIXTURE_LIFETIME_SECONDS}))
while (( SECONDS < fixture_deadline )); do
  sleep 0.05
done
`);
  const { bridge, getStderr } = spawnDirectPtyBridge(fixture.commandPath);
  const observed = { bridgePid: bridge.pid };
  registerDirectBridgeCleanup(t, fixture, bridge, observed);

  const fixturePid = await waitForCondition(
    () => {
      captureDirectBridgeIdentity(observed, fixture);
      if (!existsSync(fixture.readyFile) || !observed.fixturePid || !observed.bridgeParentPid) {
        return undefined;
      }
      return observed.fixturePid;
    },
    TEST_PROCESS_CLEANUP_TIMEOUT_MS,
    "direct bridge fixture readiness",
  );
  assert.ok(
    Number.isInteger(fixturePid) && fixturePid > 0,
    `expected fixture pid, got ${fixturePid}`,
  );
  assert.equal(observed.bridgeParentPid, observed.bridgePid);

  bridge.stdin.end();
  const exit = await waitForProcessExit(bridge, 5000, "direct bridge exit after stdin EOF");
  assert.equal(exit.signal, null);
  assert.equal(exit.code, 0, getStderr());
  assert.equal(getStderr(), "");
  await waitForCondition(
    () => !processGroupExists(fixturePid),
    5000,
    "fixture process group cleanup after stdin EOF",
  );
});

test("direct Python PTY bridge cleans up when checker stdout closes", async (t) => {
  if (!hasPython3PtyBridge()) {
    t.skip("requires python3 PTY bridge coverage");
    return;
  }

  const fixture = createDirectBridgeFixture(`
trap 'exit 0' INT TERM
printf '%s\\n' "$$" >"$pid_file"
printf '%s\\n' "$PPID" >"$bridge_pid_file"
printf 'ready\\n' >"$ready_file"
fixture_deadline=$((SECONDS + ${SYNTHETIC_FIXTURE_LIFETIME_SECONDS}))
while (( SECONDS < fixture_deadline )); do
  printf 'output after checker close\\n'
  sleep 0.05
done
`);
  const { bridge, getStderr } = spawnDirectPtyBridge(fixture.commandPath);
  const observed = { bridgePid: bridge.pid };
  registerDirectBridgeCleanup(t, fixture, bridge, observed);

  const fixturePid = await waitForCondition(
    () => {
      captureDirectBridgeIdentity(observed, fixture);
      if (!existsSync(fixture.readyFile) || !observed.fixturePid || !observed.bridgeParentPid) {
        return undefined;
      }
      return observed.fixturePid;
    },
    TEST_PROCESS_CLEANUP_TIMEOUT_MS,
    "direct bridge fixture readiness",
  );
  assert.ok(
    Number.isInteger(fixturePid) && fixturePid > 0,
    `expected fixture pid, got ${fixturePid}`,
  );
  assert.equal(observed.bridgeParentPid, observed.bridgePid);

  bridge.stdout.destroy();
  const exit = await waitForProcessExit(bridge, 5000, "direct bridge exit after stdout close");
  assert.equal(exit.signal, null);
  assert.notEqual(exit.code, 120, "BrokenPipe must not trigger BufferedWriter finalizer exit");
  assert.equal(getStderr(), "", "controlled BrokenPipe cleanup must not write finalizer noise");
  await waitForCondition(
    () => !processGroupExists(fixturePid),
    5000,
    "fixture process group cleanup after stdout close",
  );
});

test("check-startup-performance uses a temporary tlh wrapper for the default command", (t) => {
  const fixture = createManagedWrapperFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const result = runCheckStartupPerformance(fixture, [
    "--runs",
    "2",
    "--budget-ms",
    "10000",
    "--timeout-ms",
    "5000",
    "--profile-source",
    fixture.agentDir,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /launch mode: temporary managed tlh wrapper/);
  assert.match(result.stdout, new RegExp(`source wrapper: ${escapeRegExp(fixture.wrapperPath)}`));
  assert.match(result.stdout, /PASS warm first-header mean/);
  assert.equal(result.stderr, "");
});

test("check-startup-performance keeps custom --command launches usable", (t) => {
  const fixture = createManagedWrapperFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const result = runCheckStartupPerformance(fixture, [
    "--runs",
    "2",
    "--budget-ms",
    "10000",
    "--timeout-ms",
    "5000",
    "--profile-source",
    fixture.agentDir,
    "--command",
    fixture.customCommandPath,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /launch mode: direct custom command/);
  assert.doesNotMatch(result.stdout, /temporary wrapper:/);
  assert.match(result.stdout, /PASS warm first-header mean/);
  assert.equal(result.stderr, "");
});

test("check-startup-performance requires genuine header output after a delayed rendered footer", (t) => {
  const fixture = createManagedWrapperFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  writeExecutable(
    fixture.customCommandPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '~/Developer/the-last-harness-minotaur (main)\n'
sleep 0.15
printf '────────────────────────────────────────────────────────────────────────────────\n'
trap 'exit 0' INT TERM
fixture_deadline=$((SECONDS + ${SYNTHETIC_FIXTURE_LIFETIME_SECONDS}))
while (( SECONDS < fixture_deadline )); do
  sleep 1
done
`,
  );
  const result = runCheckStartupPerformance(fixture, [
    "--runs",
    "2",
    "--budget-ms",
    "10000",
    "--timeout-ms",
    "5000",
    "--profile-source",
    fixture.agentDir,
    "--command",
    fixture.customCommandPath,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS warm first-header mean/);
  const warmRun = result.stdout.match(
    /run\s+2 warm\s+output [\d.]+ms\s+header ([\d.]+)ms\s+footer ([\d.]+)ms/u,
  );
  assert.ok(warmRun, `expected warm-run timing output, got:\n${result.stdout}`);
  assert.ok(
    Number(warmRun[1]) - Number(warmRun[2]) >= 100,
    `expected delayed header after footer, got: ${warmRun[0]}`,
  );
  assert.equal(result.stderr, "");
});

test("check-startup-performance does not treat rendered footer cwd output as a header", (t) => {
  const fixture = createManagedWrapperFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  writeExecutable(
    fixture.customCommandPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '~/Developer/the-last-harness-minotaur (main)\n'
trap 'exit 0' INT TERM
fixture_deadline=$((SECONDS + ${SYNTHETIC_FIXTURE_LIFETIME_SECONDS}))
while (( SECONDS < fixture_deadline )); do
  sleep 1
done
`,
  );
  const result = runCheckStartupPerformance(fixture, [
    "--runs",
    "2",
    "--budget-ms",
    "10000",
    "--timeout-ms",
    "300",
    "--profile-source",
    fixture.agentDir,
    "--command",
    fixture.customCommandPath,
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /timed out waiting for header/);
});

test("check-startup-performance cleans up the active child process group and temp workspace on SIGINT", async (t) => {
  if (!hasPython3PtyBridge()) {
    t.skip("requires python3 PTY bridge coverage");
    return;
  }

  const fixture = createManagedWrapperFixture();

  const childPidFile = join(fixture.root, "child.pid");
  const childReadyFile = join(fixture.root, "child.ready");
  const childSignalFile = join(fixture.root, "child.signal");
  const bridgePidFile = join(fixture.root, "bridge.pid");
  const helperPidFile = join(fixture.root, "helper.pid");
  const helperReadyFile = join(fixture.root, "helper.ready");
  const helperSignalFile = join(fixture.root, "helper.signal");
  const helperScriptPath = join(fixture.root, "term-trap-helper.sh");
  writeExecutable(
    helperScriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
trap '' INT
trap 'printf "signal=%s\\n" "TERM" >"${helperSignalFile}"; exit 0' TERM
printf '%s\n' "$$" >"${helperPidFile}"
printf 'ready\n' >"${helperReadyFile}"
fixture_deadline=$((SECONDS + ${SYNTHETIC_FIXTURE_LIFETIME_SECONDS}))
while (( SECONDS < fixture_deadline )); do
  sleep 0.05
done
`,
  );
  writeExecutable(
    fixture.customCommandPath,
    `#!/usr/bin/env bash
set -euo pipefail
fixture_deadline=$((SECONDS + ${SYNTHETIC_FIXTURE_LIFETIME_SECONDS}))
"${helperScriptPath}" &
helper_pid=$!
while [[ ! -f "${helperReadyFile}" && SECONDS -lt fixture_deadline ]]; do
  sleep 0.05
done
if [[ ! -f "${helperReadyFile}" ]]; then
  kill "$helper_pid" 2>/dev/null || true
  wait "$helper_pid" 2>/dev/null || true
  exit 1
fi
printf '%s\n' "$$" >"${childPidFile}"
printf '%s\n' "$PPID" >"${bridgePidFile}"
trap '' INT
trap 'printf "signal=%s\\n" "TERM" >"${childSignalFile}"; wait "$helper_pid"; exit 0' TERM
printf 'ready\n' >"${childReadyFile}"
printf 'Context: interrupt cleanup\\n'
while (( SECONDS < fixture_deadline )); do
  sleep 1
done
`,
  );

  const checker = spawn(
    process.execPath,
    [
      checkStartupPerformanceScript,
      "--runs",
      "2",
      "--budget-ms",
      "10000",
      "--timeout-ms",
      "10000",
      "--profile-source",
      fixture.agentDir,
      "--command",
      fixture.customCommandPath,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${fixture.wrapperBinDir}:${process.env.PATH || ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const observed = {
    checkerPid: checker.pid,
    bridgePid: undefined,
    fixturePid: undefined,
    helperPid: undefined,
    workspaceRoot: undefined,
  };
  let stdout = "";
  let stderr = "";
  checker.stdout.setEncoding("utf8");
  checker.stderr.setEncoding("utf8");
  checker.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  checker.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  t.after(async () => {
    const failures = [];
    await attemptCleanup(failures, "capture initial identities", () => {
      captureWorkspaceRoot(observed, stdout);
      observed.fixturePid ??= readPidFile(childPidFile);
      observed.bridgePid ??= readPidFile(bridgePidFile);
      observed.helperPid ??= readPidFile(helperPidFile);
    });

    await attemptCleanup(failures, "checker", () => stopChildProcess(checker, "SIGINT"));
    await attemptCleanup(failures, "capture final identities", () => {
      captureWorkspaceRoot(observed, stdout);
      observed.fixturePid ??= readPidFile(childPidFile);
      observed.bridgePid ??= readPidFile(bridgePidFile);
      observed.helperPid ??= readPidFile(helperPidFile);
    });
    await attemptCleanup(failures, "PTY bridge", () => stopProcessIdentity(observed.bridgePid));
    await attemptCleanup(failures, "fixture process group", () =>
      stopProcessIdentity(observed.fixturePid, { group: true }),
    );
    await attemptCleanup(failures, "fixture helper", () => stopProcessIdentity(observed.helperPid));
    await attemptCleanup(failures, "checker workspace", () => {
      if (observed.workspaceRoot && isSafeTemporaryWorkspaceRoot(observed.workspaceRoot)) {
        rmSync(observed.workspaceRoot, { recursive: true, force: true });
      }
    });
    await attemptCleanup(failures, "managed fixture", () =>
      rmSync(fixture.root, { recursive: true, force: true }),
    );
    throwCleanupFailures(failures);
  });

  await waitForCondition(
    () => {
      const parsed = parseTemporaryWorkspace(stdout);
      if (!parsed || !existsSync(childReadyFile) || !existsSync(helperReadyFile)) {
        return undefined;
      }
      observed.workspaceRoot ??= parsed.workspaceRoot;
      observed.fixturePid ??= readPidFile(childPidFile);
      observed.bridgePid ??= readPidFile(bridgePidFile);
      observed.helperPid ??= readPidFile(helperPidFile);
      if (!observed.fixturePid || !observed.bridgePid || !observed.helperPid) {
        return undefined;
      }
      return parsed.profilePath;
    },
    TEST_PROCESS_CLEANUP_TIMEOUT_MS,
    "startup checker to create a temp profile and launch the child process group",
  );
  const workspaceRoot = observed.workspaceRoot;
  assert.ok(workspaceRoot, "expected a validated temporary workspace path");
  const childPid = observed.fixturePid;
  assert.ok(Number.isInteger(childPid) && childPid > 0, `expected child pid, got ${childPid}`);
  const bridgePid = observed.bridgePid;
  assert.ok(Number.isInteger(bridgePid) && bridgePid > 0, `expected bridge pid, got ${bridgePid}`);
  const helperPid = observed.helperPid;
  assert.ok(Number.isInteger(helperPid) && helperPid > 0, `expected helper pid, got ${helperPid}`);
  assert.ok(
    Number.isInteger(observed.checkerPid) && observed.checkerPid > 0,
    "expected checker pid",
  );

  const exitPromise = new Promise((resolvePromise, rejectPromise) => {
    checker.once("error", rejectPromise);
    checker.once("exit", (code, signal) => {
      resolvePromise({ code, signal });
    });
  });
  checker.kill("SIGINT");
  const exit = await exitPromise;

  assert.deepEqual(exit, { code: null, signal: "SIGINT" });
  await waitForCondition(() => !existsSync(workspaceRoot), 5000, "temp workspace cleanup");
  await waitForCondition(() => existsSync(childSignalFile), 5000, "child signal trap output");
  await waitForCondition(() => existsSync(helperSignalFile), 5000, "helper TERM trap output");
  for (const [pid, description] of [
    [bridgePid, "PTY bridge shutdown"],
    [childPid, "child process shutdown"],
    [helperPid, "TERM-trap helper shutdown"],
  ]) {
    await waitForCondition(
      () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          return error && typeof error === "object" && "code" in error && error.code === "ESRCH";
        }
      },
      5000,
      description,
    );
  }
  assert.match(readFileSync(childSignalFile, "utf8"), /signal=TERM/);
  assert.match(readFileSync(helperSignalFile, "utf8"), /signal=TERM/);
  assert.equal(stderr, "");
});

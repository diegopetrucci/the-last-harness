import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";

import {
  assertOwnedWorkspacePath,
  benchmarkScope,
  buildChildEnvironment,
  compareBundledNpmPins,
  createBenchmarkWorkspace,
  createCleanupController,
  createPhaseObserver,
  createReadinessObserver,
  diagnoseReadinessFailure,
  finishPhaseObserver,
  hasTlhFooter,
  hasTlhHeader,
  installedRevisionMismatchDiagnostic,
  npmVersion,
  observeInstallerChunk,
  observeReadinessChunk,
  parseArgs,
  parseBundledNpmPins,
  parseRemoteRevision,
  printTextResult,
  prepareSource,
  readInstalledPackageRevision,
  readPiVersion,
  readRemoteRefFile,
  resolveRemoteRefRevision,
  runProcess,
  selectedScenarios,
  scenarioCacheCondition,
  summarizeSamples,
  writeCredentialFreeTrustMetadata,
} from "../scripts/check-installer-performance.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const benchmarkScript = join(repoRoot, "scripts", "check-installer-performance.mjs");

function fixtureEnvironment() {
  return {
    PATH: process.env.PATH,
    HOME: "/poisoned/home",
    PI_OFFLINE: "1",
    AWS_SECRET_ACCESS_KEY: "poisoned-secret",
    NPM_TOKEN: "poisoned-token",
    GITHUB_TOKEN: "poisoned-token",
    SSH_AUTH_SOCK: "/poisoned/socket",
    NPM_CONFIG_USERCONFIG: "/poisoned/npmrc-user",
    npm_config_userconfig: "/poisoned/npmrc-user-lower",
    NPM_CONFIG_GLOBALCONFIG: "/poisoned/npmrc-global",
    npm_config_globalconfig: "/poisoned/npmrc-global-lower",
  };
}

function processStillExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForProcessGone(pid, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processStillExists(pid)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return !processStillExists(pid);
}

function cleanupWorkspace(workspace) {
  rmSync(workspace.root, { recursive: true, force: true });
}

test("CLI parses bounded public options and help performs no benchmark work", () => {
  const parsed = parseArgs([
    "--mode",
    "checkout",
    "--ref",
    "main",
    "--runs",
    "2",
    "--scenarios",
    "cold",
    "--json",
  ]);
  assert.deepEqual(parsed, {
    mode: "checkout",
    ref: "main",
    upgradeFrom: undefined,
    runs: 2,
    scenarios: "cold",
    json: true,
    help: false,
  });
  assert.throws(() => parseArgs(["--scenarios", "all"]), /--upgrade-from is required/);
  assert.throws(
    () => parseArgs(["--mode", "checkout", "--scenarios", "all", "--upgrade-from", "previous"]),
    /--mode checkout only supports --scenarios cold/,
  );
  assert.throws(
    () => parseArgs(["--scenarios", "cold", "--upgrade-from", "previous"]),
    /only valid when --scenarios is all/,
  );
  assert.throws(() => parseArgs(["--scenarios", "cold", "--runs", "0"]), /positive integer/);
  assert.throws(() => parseArgs(["--scenarios", "cold", "--ref", "../source"]), /valid Git ref/);

  const help = spawnSync(process.execPath, [benchmarkScript, "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: fixtureEnvironment(),
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--mode remote\|checkout/);
  assert.match(help.stdout, /checkout\s+mode supports --scenarios cold/u);
  assert.doesNotMatch(help.stdout, /temporary profile|npm cache copied/);

  const invalidJson = spawnSync(
    process.execPath,
    [benchmarkScript, "--json", "--scenarios", "all"],
    { cwd: repoRoot, encoding: "utf8", env: fixtureEnvironment() },
  );
  assert.equal(invalidJson.status, 1);
  assert.equal(invalidJson.stderr, "");
  assert.deepEqual(JSON.parse(invalidJson.stdout), {
    benchmark: "installer-performance",
    error: "--upgrade-from is required when --scenarios is all",
  });
});

test("scenario plans and cache conditions stay isolated", () => {
  assert.deepEqual(selectedScenarios("all"), [
    "cold-cache-fresh",
    "warm-cache-fresh",
    "unchanged-reinstall",
    "changed-pin-upgrade",
  ]);
  assert.deepEqual(selectedScenarios("cold"), ["cold-cache-fresh"]);
  const conditions = selectedScenarios("all").map(scenarioCacheCondition);
  assert.equal(new Set(conditions).size, 4);

  const left = createBenchmarkWorkspace();
  const right = createBenchmarkWorkspace();
  try {
    assert.notEqual(left.root, right.root);
    assert.notEqual(left.npmCache, right.npmCache);
    assert.match(left.root, /tlh-installer-performance-/u);
  } finally {
    cleanupWorkspace(left);
    cleanupWorkspace(right);
  }
});

test("child environment removes poisoned credentials and keeps measured launch online", () => {
  const workspace = createBenchmarkWorkspace();
  try {
    const environment = buildChildEnvironment(workspace, fixtureEnvironment(), { ref: "main" });
    assert.equal(environment.HOME, workspace.home);
    assert.equal(environment.PI_CODING_AGENT_DIR, workspace.agentDir);
    assert.equal(environment.PI_OFFLINE, undefined);
    assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(environment.NPM_TOKEN, undefined);
    assert.equal(environment.GITHUB_TOKEN, undefined);
    assert.equal(environment.SSH_AUTH_SOCK, undefined);
    assert.equal(environment.NPM_CONFIG_USERCONFIG, workspace.npmUserConfig);
    assert.equal(environment.npm_config_userconfig, workspace.npmUserConfig);
    assert.equal(environment.NPM_CONFIG_GLOBALCONFIG, workspace.npmGlobalConfig);
    assert.equal(environment.npm_config_globalconfig, workspace.npmGlobalConfig);
    assert.notEqual(workspace.npmUserConfig, workspace.npmGlobalConfig);
    for (const configPath of [workspace.npmUserConfig, workspace.npmGlobalConfig]) {
      assertOwnedWorkspacePath(workspace.root, configPath);
      assert.equal(existsSync(configPath), true);
    }
    assert.equal(environment.npm_config_cache, workspace.npmCache);
    assert.equal(environment.TLH_SKIP_UPDATE_CHECK, "1");
    assert.equal(environment.TLH_SKIP_TELEMETRY, "1");

    const trustPath = writeCredentialFreeTrustMetadata(workspace);
    const trust = JSON.parse(readFileSync(trustPath, "utf8"));
    assert.deepEqual(trust, { [realpathSync(workspace.cwd)]: true });
    assert.throws(
      () => assertOwnedWorkspacePath(workspace.root, repoRoot),
      /outside benchmark workspace/,
    );
  } finally {
    cleanupWorkspace(workspace);
  }
});

test("phase observer parses markers split per stream and preserves unavailable phases", () => {
  const observed = createPhaseObserver();
  assert.equal(Object.hasOwn(observed, "observedLines"), false);
  observeInstallerChunk(observed, "npm warning without newline", 1, "stderr");
  observeInstallerChunk(observed, "Refreshing instal", 2, "stdout");
  observeInstallerChunk(observed, "ler...\nPinning local Pi runtime to 0.85.1...\n", 10, "stdout");
  observeInstallerChunk(observed, "Installing package...\n", 20);
  observeInstallerChunk(observed, "Applying isolated settings...\n", 35);
  observeInstallerChunk(observed, "Creating wrapper command...\n", 50);
  observeInstallerChunk(observed, "Done. The Last Harness is ready.\n", 60);
  const phases = finishPhaseObserver(observed, 70);
  assert.equal(phases.bootstrap.durationMs, 10);
  assert.equal(phases.runtime.durationMs, 10);
  assert.equal(phases["package-reconciliation"].durationMs, 15);
  assert.equal(phases.defaults.durationMs, 15);
  assert.equal(phases["managed-tools"].durationMs, null);
  assert.equal(phases.wrapper.durationMs, 10);
  assert.equal(phases.runtime.quality, "progress-derived");
  assert.equal(observed.pendingByStream.stderr, "npm warning without newline");

  const missing = finishPhaseObserver(createPhaseObserver(), 12);
  assert.equal(missing.runtime.durationMs, null);
  assert.equal(missing.runtime.quality, "unavailable");
});

test("installed revision mismatches are diagnosed without replacing ref resolution", () => {
  const resolvedRevision = "1111111111111111111111111111111111111111";
  const observedRevision = "2222222222222222222222222222222222222222";
  assert.equal(
    installedRevisionMismatchDiagnostic(
      "cold-cache-fresh",
      1,
      "v0.40.0",
      resolvedRevision,
      resolvedRevision,
    ),
    null,
  );
  assert.equal(
    installedRevisionMismatchDiagnostic("cold-cache-fresh", 1, "v0.40.0", resolvedRevision, null),
    null,
  );
  const mismatch = installedRevisionMismatchDiagnostic(
    "cold-cache-fresh",
    1,
    "v0.40.0",
    resolvedRevision,
    observedRevision,
  );
  assert.match(mismatch, /resolved to 111111.*installed package revision was 222222/u);
  assert.equal(
    summarizeSamples([
      {
        scenario: "cold-cache-fresh",
        installer: null,
        launch: null,
        failureDiagnostics: [mismatch],
      },
    ]).failedSamples,
    1,
  );
});

test("remote ref parsing prefers annotated-tag peeled commits and preserves direct refs", () => {
  const annotatedObject = "1111111111111111111111111111111111111111";
  const annotatedCommit = "2222222222222222222222222222222222222222";
  const branchCommit = "3333333333333333333333333333333333333333";
  const lightweightCommit = "4444444444444444444444444444444444444444";

  assert.equal(
    parseRemoteRevision(
      [`${annotatedObject}\trefs/tags/v0.39.0`, `${annotatedCommit}\trefs/tags/v0.39.0^{}`].join(
        "\n",
      ),
      "v0.39.0",
    ),
    annotatedCommit,
  );
  assert.equal(parseRemoteRevision(`${branchCommit}\trefs/heads/main\n`, "main"), branchCommit);
  assert.equal(
    parseRemoteRevision(`${lightweightCommit}\trefs/tags/v0.38.0\n`, "v0.38.0"),
    lightweightCommit,
  );
  assert.equal(parseRemoteRevision("not-a-ref\n", "missing"), null);
});

test("package ref resolution uses the remote source independently of support checkout mode", async () => {
  const workspace = createBenchmarkWorkspace();
  const cleanup = createCleanupController();
  const calls = [];
  const revision = "5555555555555555555555555555555555555555";
  try {
    const resolved = await resolveRemoteRefRevision(
      "main",
      workspace,
      fixtureEnvironment(),
      cleanup,
      async (command, args) => {
        calls.push({ command, args: [...args] });
        return {
          command,
          args: [...args],
          code: 0,
          signal: null,
          stdout: `${revision}\trefs/heads/main\n`,
          stderr: "",
          elapsedMs: 0,
          timedOut: false,
          stoppedByCondition: false,
        };
      },
    );
    assert.equal(resolved, revision);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "git");
    assert.equal(calls[0].args[1], "ls-remote");
    assert.equal(calls[0].args.includes("rev-parse"), false);
  } finally {
    cleanupWorkspace(workspace);
  }
});

test("moving symbolic refs resolve once and remote setup uses the resolved commit", async () => {
  const workspace = createBenchmarkWorkspace();
  const cleanup = createCleanupController();
  const requestedRef = "moving";
  const resolvedRevision = "6".repeat(40);
  const laterRevision = "7".repeat(40);
  let resolutionCalls = 0;
  const sourceCalls = [];
  try {
    const resolved = await resolveRemoteRefRevision(
      requestedRef,
      workspace,
      fixtureEnvironment(),
      cleanup,
      async (command, args) => {
        resolutionCalls += 1;
        return {
          command,
          args: [...args],
          code: 0,
          signal: null,
          stdout: `${resolutionCalls === 1 ? resolvedRevision : laterRevision}\trefs/heads/${requestedRef}\n`,
          stderr: "",
          elapsedMs: 0,
          timedOut: false,
          stoppedByCondition: false,
        };
      },
    );
    assert.equal(resolved, resolvedRevision);

    const source = await prepareSource(
      {
        mode: "remote",
        ref: requestedRef,
        upgradeFrom: undefined,
        runs: 1,
        scenarios: "cold",
        json: false,
        help: false,
      },
      workspace.root,
      workspace,
      fixtureEnvironment(),
      cleanup,
      resolved,
      async (command, args, options) => {
        sourceCalls.push({ command, args: [...args], env: options.env });
        const outputPath = args[args.indexOf("-o") + 1];
        writeFileSync(outputPath, "#!/usr/bin/env bash\nexit 0\n");
        return {
          command,
          args: [...args],
          code: 0,
          signal: null,
          stdout: "",
          stderr: "",
          elapsedMs: 0,
          timedOut: false,
          stoppedByCondition: false,
        };
      },
    );

    assert.equal(resolutionCalls, 1);
    assert.equal(sourceCalls.length, 1);
    const sourceUrl = sourceCalls[0].args.find((arg) => arg.startsWith("https://"));
    assert.equal(
      sourceUrl,
      `https://raw.githubusercontent.com/diegopetrucci/the-last-harness/${resolvedRevision}/install.sh`,
    );
    assert.equal(sourceCalls[0].env.TLH_REF, resolvedRevision);
    assert.equal(source.supportCodeRevision, resolvedRevision);
  } finally {
    cleanupWorkspace(workspace);
  }
});

test("checkout all is rejected and pin manifests use only remote ref sources", async () => {
  assert.throws(
    () => parseArgs(["--mode", "checkout", "--scenarios", "all", "--upgrade-from", "previous"]),
    /--mode checkout only supports --scenarios cold/,
  );

  const workspace = createBenchmarkWorkspace();
  const cleanup = createCleanupController();
  const urls = [];
  try {
    const content = await readRemoteRefFile(
      "v0.39.0",
      "config/default-extensions.json",
      workspace,
      fixtureEnvironment(),
      cleanup,
      async (url) => {
        urls.push(url);
        return '{"source":"remote"}';
      },
    );
    assert.equal(content, '{"source":"remote"}');
    assert.deepEqual(urls, [
      "https://raw.githubusercontent.com/diegopetrucci/the-last-harness/v0.39.0/config/default-extensions.json",
    ]);
  } finally {
    cleanupWorkspace(workspace);
  }
});

test("readiness requires actual header and footer markers, not first output", () => {
  const readiness = createReadinessObserver();
  assert.equal(observeReadinessChunk(readiness, "loading package\n", 1), false);
  assert.equal(observeReadinessChunk(readiness, "Con", 5), false);
  assert.equal(observeReadinessChunk(readiness, "text: tlh\n", 8), false);
  assert.equal(observeReadinessChunk(readiness, "agent: ready\n", 12), true);
  assert.equal(readiness.firstOutputMs, 1);
  assert.equal(readiness.headerMs, 8);
  assert.equal(readiness.footerMs, 12);
  assert.equal(hasTlhHeader(readiness.normalizedOutput), true);
  assert.equal(hasTlhFooter(readiness.normalizedOutput), true);

  const missing = createReadinessObserver();
  observeReadinessChunk(missing, "first output only\n", 3);
  const diagnostics = diagnoseReadinessFailure(missing, {
    code: null,
    signal: null,
    timedOut: true,
  });
  assert.ok(diagnostics.some((line) => line.includes("header marker")));
  assert.ok(diagnostics.some((line) => line.includes("footer marker")));
  assert.ok(diagnostics.some((line) => line.includes("timed out")));
});

test("pin comparison accepts external JSON only after narrowing and requires a changed package pin", () => {
  const before = parseBundledNpmPins(
    JSON.stringify([
      { id: "one", source: "npm:@scope/one@1.0.0" },
      { id: "two", source: "git:github.com/example/two" },
    ]),
  );
  const after = parseBundledNpmPins(
    JSON.stringify([{ id: "one", source: "npm:@scope/one@1.1.0" }]),
  );
  assert.deepEqual(compareBundledNpmPins(before, after), {
    changed: true,
    packages: [{ name: "@scope/one", from: "1.0.0", to: "1.1.0" }],
  });
  assert.throws(
    () => parseBundledNpmPins(JSON.stringify({ source: "npm:one@1" })),
    /must be an array/,
  );
});

test("summary medians exclude failed samples and JSON envelopes round-trip", () => {
  const samples = [
    {
      scenario: "cold-cache-fresh",
      run: 1,
      installer: { success: true, wallMs: 30, phases: { bootstrap: { durationMs: 10 } } },
      launch: { ready: true, wallMs: 50 },
      observedInstalledRevision: "observed-revision",
      failureDiagnostics: [],
    },
    {
      scenario: "cold-cache-fresh",
      run: 2,
      installer: { success: true, wallMs: 10, phases: { bootstrap: { durationMs: 4 } } },
      launch: { ready: true, wallMs: 10 },
      failureDiagnostics: [],
    },
    {
      scenario: "cold-cache-fresh",
      run: 3,
      installer: { success: false, wallMs: 90, phases: { bootstrap: { durationMs: 90 } } },
      launch: null,
      failureDiagnostics: ["failed"],
    },
    {
      scenario: "cold-cache-fresh",
      run: 4,
      installer: { success: true, wallMs: 100, phases: { bootstrap: { durationMs: 100 } } },
      launch: { ready: true, wallMs: 100 },
      failureDiagnostics: ["installed revision mismatch"],
    },
  ];
  const summary = summarizeSamples(samples);
  assert.deepEqual(summary.installerWallMs, {
    count: 2,
    median: 20,
    mean: 20,
    min: 10,
    max: 30,
  });
  assert.deepEqual(summary.firstUsableLaunchMs, {
    count: 2,
    median: 30,
    mean: 30,
    min: 10,
    max: 50,
  });
  assert.deepEqual(summary.phasesMs.bootstrap, {
    count: 2,
    median: 7,
    mean: 7,
    min: 4,
    max: 10,
  });
  assert.equal(summary.failedSamples, 2);
  assert.deepEqual(summary.byScenario["cold-cache-fresh"].installerWallMs, {
    count: 2,
    median: 20,
    mean: 20,
    min: 10,
    max: 30,
  });
  assert.deepEqual(summary.byScenario["cold-cache-fresh"].firstUsableLaunchMs, {
    count: 2,
    median: 30,
    mean: 30,
    min: 10,
    max: 50,
  });
  assert.equal(summary.byScenario["cold-cache-fresh"].failures, 2);

  const envelope = {
    schemaVersion: 1,
    benchmark: "installer-performance",
    toolVersions: { node: "22.0.0", npm: "10.0.0", pi: null },
    cacheConditions: { "cold-cache-fresh": "new npm cache" },
    measurementScope: { phaseTimings: "approximate" },
    samples,
    summary,
    failureDiagnostics: ["cold-cache-fresh run 3:", "failed installer", "launch diagnostics"],
  };
  const roundTripped = JSON.parse(JSON.stringify(envelope));
  assert.deepEqual(roundTripped, envelope);
  assert.equal(roundTripped.samples[0].observedInstalledRevision, "observed-revision");
  assert.equal(Object.hasOwn(roundTripped.samples[0], "resolvedPackageRevision"), false);

  const output = [];
  const originalLog = console.log;
  console.log = (...args) => output.push(args.join(" "));
  try {
    printTextResult({
      mode: "checkout",
      selectedRef: { requested: "main", resolved: "revision" },
      upgradeFromRef: null,
      supportCodeRevision: "support-revision",
      platform: { os: "test", arch: "test" },
      toolVersions: { node: "22.0.0", npm: "10.0.0", pi: null },
      samples,
      summary,
      measurementScope: {
        installerWallTime: "total installer time",
        phaseComposition: "phase composition",
        setupProvenance: "setup provenance",
        offline: "PI_OFFLINE is absent",
      },
      failureDiagnostics: ["cold-cache-fresh run 3:", "failed installer", "launch diagnostics"],
    });
  } finally {
    console.log = originalLog;
  }
  const text = output.join("\\n");
  assert.match(text, /bootstrap: 7\.0ms median/);
  assert.match(text, /observed installed revision: observed-revision/u);
  assert.match(text, /failed samples: 2/u);
  assert.doesNotMatch(text, /failures: 3/u);
  assert.match(text, /managed-tools: unavailable median/);
  assert.match(text, /setup provenance: setup provenance/);
  assert.match(
    benchmarkScope().setupProvenance,
    /checkout mode uses this checkout's current support code/,
  );
});

test("probe subprocesses register their process trees with cleanup", async () => {
  const workspace = createBenchmarkWorkspace();
  const cleanup = createCleanupController();
  const packageRoot = join(
    workspace.agentDir,
    "git",
    "github.com",
    "diegopetrucci",
    "the-last-harness",
  );
  const piPath = join(workspace.root, "runtime", "bin", "pi");
  mkdirSync(join(packageRoot, ".git"), { recursive: true });
  mkdirSync(join(workspace.root, "runtime", "bin"), { recursive: true });
  writeFileSync(piPath, "synthetic pi\n");
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args: [...args], registerStop: options.registerStop });
    return {
      command,
      args: [...args],
      code: 0,
      signal: null,
      stdout:
        command === "git" ? `${"1".repeat(40)}\n` : command === "npm" ? "10.0.0\n" : "pi 1.2.3\n",
      stderr: "",
      elapsedMs: 0,
      timedOut: false,
      stoppedByCondition: false,
    };
  };
  try {
    assert.equal(
      await readInstalledPackageRevision(workspace, fixtureEnvironment(), cleanup, runner),
      "1".repeat(40),
    );
    assert.equal(await readPiVersion(workspace, fixtureEnvironment(), cleanup, runner), "1.2.3");
    assert.equal(await npmVersion(workspace, fixtureEnvironment(), cleanup, runner), "10.0.0");
    assert.deepEqual(
      calls.map(({ command }) => command),
      ["git", piPath, "npm"],
    );
    assert.equal(
      calls.every(({ registerStop }) => registerStop === cleanup.registerStop),
      true,
    );
  } finally {
    cleanupWorkspace(workspace);
  }
});

test("cleanup keeps signal handlers installed until stops and roots finish", async () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-installer-performance-signal-order-test-"));
  const cleanup = createCleanupController();
  const baselineListeners = process.listenerCount("SIGTERM");
  let releaseStop;
  const stopGate = new Promise((resolvePromise) => {
    releaseStop = resolvePromise;
  });
  cleanup.registerStop(async () => {
    await stopGate;
  });
  cleanup.registerWorkspace(root);
  cleanup.install();
  try {
    const pendingCleanup = cleanup.cleanup();
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(process.listenerCount("SIGTERM"), baselineListeners + 1);
    assert.equal(existsSync(root), true);
    releaseStop();
    await pendingCleanup;
    assert.equal(existsSync(root), false);
    assert.equal(process.listenerCount("SIGTERM"), baselineListeners + 1);
  } finally {
    cleanup.uninstall();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
  assert.equal(process.listenerCount("SIGTERM"), baselineListeners);
});

test("cleanup removes owned roots and rejects protected roots", async () => {
  const ownedRoot = mkdtempSync(join(tmpdir(), "tlh-installer-performance-owned-cleanup-test-"));
  const protectedRoot = mkdtempSync(join(tmpdir(), "tlh-protected-cleanup-test-"));
  const ownedCleanup = createCleanupController();
  const protectedCleanup = createCleanupController();
  try {
    ownedCleanup.registerWorkspace(ownedRoot);
    await ownedCleanup.cleanup();
    assert.equal(existsSync(ownedRoot), false);

    protectedCleanup.registerWorkspace(protectedRoot);
    await assert.rejects(protectedCleanup.cleanup(), /unowned benchmark path/);
    assert.equal(existsSync(protectedRoot), true);
  } finally {
    if (existsSync(protectedRoot)) rmSync(protectedRoot, { recursive: true, force: true });
  }
});

test("cleanup continues owned-root removal after stop and root errors", async () => {
  const ownedRoot = mkdtempSync(join(tmpdir(), "tlh-installer-performance-owned-error-test-"));
  const protectedRoot = mkdtempSync(join(tmpdir(), "tlh-protected-cleanup-error-test-"));
  const cleanup = createCleanupController();
  cleanup.registerStop(() => {
    throw new Error("synthetic stop failure");
  });
  cleanup.registerWorkspace(protectedRoot);
  cleanup.registerWorkspace(ownedRoot);
  try {
    await assert.rejects(cleanup.cleanup(), /unowned benchmark path/);
    assert.equal(existsSync(ownedRoot), false);
    assert.equal(existsSync(protectedRoot), true);
  } finally {
    if (existsSync(protectedRoot)) rmSync(protectedRoot, { recursive: true, force: true });
  }
});

test("clean child exit reports close time before detached descendant cleanup grace", async () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-installer-performance-clean-exit-test-"));
  const pidFile = join(root, "descendant.pid");
  const readyFile = join(root, "descendant.ready");
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    TMPDIR: root,
    TLH_TEST_DESCENDANT_PID_FILE: pidFile,
    TLH_TEST_DESCENDANT_READY_FILE: readyFile,
  };
  const fixture = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const pidFile = process.env.TLH_TEST_DESCENDANT_PID_FILE;",
    "const readyFile = process.env.TLH_TEST_DESCENDANT_READY_FILE;",
    "const descendant = spawn(process.execPath, ['-e', \"const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(process.env.TLH_TEST_DESCENDANT_READY_FILE, 'ready'); setTimeout(() => {}, 60000);\"], { stdio: 'ignore', env: process.env });",
    "fs.writeFileSync(pidFile, String(descendant.pid));",
    "const waitForReady = setInterval(() => { if (fs.existsSync(readyFile)) { clearInterval(waitForReady); process.exit(0); } }, 1);",
  ].join(" ");
  try {
    const baselineStartedAt = performance.now();
    const baseline = await runProcess(
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 30)"],
      { cwd: root, env, timeoutMs: 2000 },
    );
    const baselineWallMs = performance.now() - baselineStartedAt;
    assert.equal(baseline.code, 0);

    const startedAt = performance.now();
    const result = await runProcess(process.execPath, ["-e", fixture], {
      cwd: root,
      env,
      timeoutMs: 2000,
    });
    const wallMs = performance.now() - startedAt;
    assert.equal(result.code, 0);
    const descendantCleanupOverheadMs = wallMs - result.elapsedMs;
    const descendantPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    assert.equal(await waitForProcessGone(descendantPid), true);
    assert.ok(
      descendantCleanupOverheadMs > baselineWallMs,
      `expected descendant cleanup overhead (${descendantCleanupOverheadMs.toFixed(1)}ms) to exceed baseline wall time (${baselineWallMs.toFixed(1)}ms)`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed and timed-out synthetic process trees are terminated", async () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-installer-performance-process-test-"));
  const pidFile = join(root, "child.pid");
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    TMPDIR: root,
    TLH_TEST_CHILD_PID_FILE: pidFile,
  };
  const fixture = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);",
    "fs.writeFileSync(process.env.TLH_TEST_CHILD_PID_FILE, String(child.pid));",
    "setTimeout(() => process.exit(7), 30);",
  ].join(" ");
  try {
    const failed = await runProcess(process.execPath, ["-e", fixture], {
      cwd: root,
      env,
      timeoutMs: 2000,
    });
    assert.equal(failed.code, 7);
    const childPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    assert.equal(await waitForProcessGone(childPid), true);

    const timedOut = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      cwd: root,
      env,
      timeoutMs: 100,
    });
    assert.equal(timedOut.timedOut, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup controller stops registered process trees on synthetic interruption", async () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-installer-performance-interrupt-test-"));
  const cleanup = createCleanupController();
  let running;
  try {
    running = runProcess(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: root },
      timeoutMs: 5000,
      registerStop: cleanup.registerStop,
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    await cleanup.cleanup();
    const result = await running;
    assert.ok(result.signal !== null || result.code !== 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

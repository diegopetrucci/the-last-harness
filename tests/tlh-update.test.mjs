import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const updateScript = join(repoRoot, "scripts", "tlh-update.mjs");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Create a temporary isolated agent dir for a single test, cleaned up after. */
function createFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "tlh-update-test-"));
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, agentDir };
}

function writeInstallState(agentDir, state) {
  const stateDir = join(agentDir, "tlh");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "install-state.json"), JSON.stringify(state, null, 2));
}

function writeSettings(agentDir, settings) {
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
}

/**
 * Build a clean child environment for tlh-update.mjs subprocesses.
 * Starts from process.env but strips TLH_* env vars and PI_OFFLINE so that
 * ambient developer/CI values don't make tests non-deterministic.
 * The caller-supplied `env` overrides (including PI_CODING_AGENT_DIR /
 * TLH_AGENT_DIR) are applied after the strip, so tests can still opt in to
 * any of these vars explicitly.
 */
const STRIPPED_VARS = [
  "TLH_REPO",
  "TLH_PACKAGE_SOURCE",
  "TLH_WRAPPER_NAME",
  "TLH_REF",
  "TLH_RAW_BASE",
  "TLH_UPDATE_TRACK",
  "PI_OFFLINE",
];

function buildChildEnv(agentDir, overrides = {}) {
  const base = { ...process.env };
  for (const key of STRIPPED_VARS) {
    delete base[key];
  }
  return { ...base, PI_CODING_AGENT_DIR: agentDir, TLH_AGENT_DIR: agentDir, ...overrides };
}

/** Run tlh-update.mjs expecting success; returns stdout. */
function runUpdate(agentDir, args = [], env = {}) {
  return execFileSync(process.execPath, [updateScript, ...args], {
    cwd: repoRoot,
    env: buildChildEnv(agentDir, env),
    encoding: "utf8",
  });
}

/** Run tlh-update.mjs without throwing; returns the full SpawnSyncReturns. */
function spawnUpdate(agentDir, args = [], env = {}) {
  return spawnSync(process.execPath, [updateScript, ...args], {
    cwd: repoRoot,
    env: buildChildEnv(agentDir, env),
    encoding: "utf8",
  });
}

// ---------------------------------------------------------------------------
// 1. --dry-run plan rendering for each track
// ---------------------------------------------------------------------------

test("dry-run latest-release: shows Track and releases/latest URL", (t) => {
  const { agentDir } = createFixture(t);
  writeInstallState(agentDir, {
    schemaVersion: 1,
    repo: "diegopetrucci/the-last-harness",
    track: "latest-release",
    packageSourceIsDefault: true,
  });

  const output = runUpdate(agentDir, ["--dry-run"]);

  assert.match(output, /The Last Harness update plan/);
  assert.match(output, /Track: latest-release/);
  assert.match(output, /releases\/latest\/download\/install\.sh/);
});

test("dry-run pinned-tag with --ref: shows Track and releases/download URL", (t) => {
  const { agentDir } = createFixture(t);

  const output = runUpdate(agentDir, ["--dry-run", "--track", "pinned-tag", "--ref", "v1.2.3"]);

  assert.match(output, /Track: pinned-tag \(v1\.2\.3\)/);
  assert.match(output, /releases\/download\/v1\.2\.3\/install\.sh/);
});

test("dry-run ref with non-semver --ref: shows Track and raw.githubusercontent.com URL", (t) => {
  const { agentDir } = createFixture(t);

  const output = runUpdate(agentDir, ["--dry-run", "--track", "ref", "--ref", "my-feature-branch"]);

  assert.match(output, /Track: ref \(my-feature-branch\)/);
  assert.match(
    output,
    /raw\.githubusercontent\.com\/diegopetrucci\/the-last-harness\/my-feature-branch\/install\.sh/,
  );
});

// ---------------------------------------------------------------------------
// 2. State loading
// ---------------------------------------------------------------------------

test("state loaded from tlh/install-state.json: plan reflects repo, track, ref", (t) => {
  const { agentDir } = createFixture(t);
  writeInstallState(agentDir, {
    schemaVersion: 1,
    repo: "diegopetrucci/the-last-harness",
    track: "ref",
    ref: "stable-branch",
    packageSourceIsDefault: true,
  });

  const output = runUpdate(agentDir, ["--dry-run"]);

  assert.match(output, /Track: ref \(stable-branch\)/);
  assert.match(
    output,
    /raw\.githubusercontent\.com\/diegopetrucci\/the-last-harness\/stable-branch\/install\.sh/,
  );
});

test("state inferred from settings.json packages when no install-state.json: semver ref -> pinned-tag", (t) => {
  const { agentDir } = createFixture(t);
  writeSettings(agentDir, {
    packages: ["github.com/diegopetrucci/the-last-harness#v2.0.0"],
  });

  const output = runUpdate(agentDir, ["--dry-run"]);

  assert.match(output, /Track: pinned-tag \(v2\.0\.0\)/);
  assert.match(output, /releases\/download\/v2\.0\.0\/install\.sh/);
});

test("state inferred from settings.json packages when no install-state.json: branch ref -> ref track", (t) => {
  const { agentDir } = createFixture(t);
  writeSettings(agentDir, {
    packages: ["github.com/diegopetrucci/the-last-harness#feature-x"],
  });

  const output = runUpdate(agentDir, ["--dry-run"]);

  assert.match(output, /Track: ref \(feature-x\)/);
  assert.match(
    output,
    /raw\.githubusercontent\.com\/diegopetrucci\/the-last-harness\/feature-x\/install\.sh/,
  );
});

// ---------------------------------------------------------------------------
// 3. Error exits
// ---------------------------------------------------------------------------

test("error: unknown option exits non-zero with message", (t) => {
  const { agentDir } = createFixture(t);

  const result = spawnUpdate(agentDir, ["--unknown-flag-xyz"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown option for tlh update/);
});

test("error: custom track exits non-zero with message", (t) => {
  const { agentDir } = createFixture(t);
  writeInstallState(agentDir, {
    schemaVersion: 1,
    repo: "diegopetrucci/the-last-harness",
    track: "custom",
    packageSourceIsDefault: true,
  });

  const result = spawnUpdate(agentDir, []);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /custom update track/);
});

test("error: undeterminable track (no state, no --track) exits non-zero", (t) => {
  const { agentDir } = createFixture(t);
  // No install-state.json, no settings.json, no --track flag

  const result = spawnUpdate(agentDir, []);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not determine update track/);
});

test("error: pinned-tag without --ref exits non-zero", (t) => {
  const { agentDir } = createFixture(t);

  const result = spawnUpdate(agentDir, ["--track", "pinned-tag"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires a ref/);
});

test("error: ref track without --ref exits non-zero", (t) => {
  const { agentDir } = createFixture(t);

  const result = spawnUpdate(agentDir, ["--track", "ref"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires a ref/);
});

test("error: custom-source override conflict (changesStoredCustomTarget) exits non-zero", (t) => {
  const { agentDir } = createFixture(t);
  writeInstallState(agentDir, {
    schemaVersion: 1,
    repo: "some-org/the-last-harness",
    track: "ref",
    ref: "main",
    packageSource: "github.com/some-org/the-last-harness@main",
    packageSourceIsDefault: false,
  });

  // Passing --track without --package-source on a custom-source install
  const result = spawnUpdate(agentDir, ["--track", "latest-release"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /custom package source/);
});

test("error: unsupported repo value exits non-zero with message", (t) => {
  const { agentDir } = createFixture(t);

  // "not a repo" contains spaces and fails the /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/ check
  const result = spawnUpdate(agentDir, [
    "--repo",
    "not-a-valid/repo!!!",
    "--track",
    "latest-release",
    "--dry-run",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported GitHub repo value/);
});

test("dry-run custom file source preserves the raw package source in update plans", (t) => {
  const { agentDir } = createFixture(t);
  const packageSource = `file:${repoRoot}`;
  writeInstallState(agentDir, {
    schemaVersion: 1,
    repo: "diegopetrucci/the-last-harness",
    track: "custom",
    packageSource,
    packageSourceIsDefault: false,
  });

  const output = runUpdate(agentDir, [
    "--dry-run",
    "--track",
    "ref",
    "--ref",
    "main",
    "--package-source",
    packageSource,
  ]);

  assert.match(output, /Track: ref \(main\)/);
  assert.match(
    output,
    new RegExp(`Package source: ${packageSource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
  assert.match(
    output,
    new RegExp(`TLH_PACKAGE_SOURCE='${packageSource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`),
  );
});

// ---------------------------------------------------------------------------
// 4. --extensions path
// ---------------------------------------------------------------------------

test("--extensions: unsupported --track flag causes non-zero exit with message", (t) => {
  const { agentDir } = createFixture(t);

  const result = spawnUpdate(agentDir, ["--extensions", "--track", "latest-release"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--extensions does not support/);
  assert.match(result.stderr, /--track/);
});

test("--extensions: protected normal-Pi config path causes non-zero exit with message", () => {
  // ~/ .pi/agent is the canonical normal-Pi config root; pathIsProtectedPiConfig triggers on it
  // even if the directory does not exist on this machine.
  const protectedAgentDir = join(homedir(), ".pi", "agent");

  const result = spawnSync(
    process.execPath,
    [updateScript, "--extensions", "--dry-run", "--agent-dir", protectedAgentDir],
    {
      cwd: repoRoot,
      env: buildChildEnv(protectedAgentDir),
      encoding: "utf8",
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /refusing to run The Last Harness extension update against normal Pi config root/,
  );
});

test("--extensions --dry-run: shows extension update plan output", (t) => {
  const { agentDir } = createFixture(t);

  const output = runUpdate(agentDir, ["--extensions", "--dry-run"]);

  assert.match(output, /The Last Harness extension update plan/);
});

// ---------------------------------------------------------------------------
// 5. PI_OFFLINE=1 without --dry-run refuses with error
// ---------------------------------------------------------------------------

test("PI_OFFLINE=1 without --dry-run refuses with 'PI_OFFLINE is set' error", (t) => {
  const { agentDir } = createFixture(t);
  writeInstallState(agentDir, {
    schemaVersion: 1,
    repo: "diegopetrucci/the-last-harness",
    track: "latest-release",
    packageSourceIsDefault: true,
  });

  const result = spawnUpdate(agentDir, ["--track", "latest-release"], { PI_OFFLINE: "1" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PI_OFFLINE is set/);
});

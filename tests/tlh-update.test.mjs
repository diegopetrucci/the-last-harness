import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const updateScript = join(repoRoot, "scripts", "tlh-update.mjs");
const recoveryScript = join(repoRoot, "scripts", "tlh-recover-update.mjs");
const sdkPackageManagerScript = join(
  repoRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "core",
  "package-manager.js",
);
const sdkGitScript = join(
  repoRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "utils",
  "git.js",
);
const nativeMcpSource = "npm:@diegopetrucci/pi-mcp-adapter@5.0.0";
const legacyMcpSource = "npm:@diegopetrucci/pi-mcp-adapter@2.36.0";
const unpinnedMcpSource = "npm:@diegopetrucci/pi-mcp-adapter";

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
function spawnUpdate(agentDir, args = [], env = {}, cwd = repoRoot) {
  return spawnSync(process.execPath, [updateScript, ...args], {
    cwd,
    env: buildChildEnv(agentDir, env),
    encoding: "utf8",
  });
}

function spawnRecovery(agentDir, args = [], env = {}, cwd = repoRoot) {
  return spawnSync(process.execPath, [recoveryScript, ...args], {
    cwd,
    env: buildChildEnv(agentDir, env),
    encoding: "utf8",
  });
}

function writeFakeRuntimePi(dir, logPath) {
  const piPath = join(dir, "runtime", "bin", "pi");
  mkdirSync(join(dir, "runtime", "bin"), { recursive: true });
  writeFileSync(
    piPath,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>${JSON.stringify(logPath)}\nexit 0\n`,
  );
  chmodSync(piPath, 0o755);
  return piPath;
}

function writeInstalledMcpMetadata(
  agentDir,
  version,
  packageName = "@diegopetrucci/pi-mcp-adapter",
) {
  const packageDir = join(agentDir, "npm", "node_modules", ...packageName.split("/"));
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: packageName, version }, null, 2),
  );
}

function writeInstalledGitMetadata(agentDir, cachePath, version) {
  const packageDir = join(agentDir, "git", ...cachePath.split("/"));
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "pi-mcp-adapter", version }, null, 2),
  );
}

function writeDownloadedInstallerFixture(dir, body) {
  const installerPath = join(dir, "downloaded-installer.sh");
  writeFileSync(installerPath, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  const fetchHookPath = join(dir, "fetch-hook.mjs");
  writeFileSync(
    fetchHookPath,
    `import { readFileSync } from "node:fs";\nglobalThis.fetch = async () => new Response(readFileSync(process.env.TLH_TEST_INSTALLER_PATH), { status: 200 });\n`,
  );
  return { installerPath, fetchHookPath };
}

function spawnPlainUpdate(agentDir, installerFixture, args = [], env = {}) {
  return spawnSync(
    process.execPath,
    ["--import", installerFixture.fetchHookPath, updateScript, ...args],
    {
      cwd: repoRoot,
      env: buildChildEnv(agentDir, {
        TLH_TEST_INSTALLER_PATH: installerFixture.installerPath,
        ...env,
      }),
      encoding: "utf8",
    },
  );
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

test("plain update dry-run refuses migration under the normal Pi config root", () => {
  const agentDir = join(homedir(), ".pi", "agent", "tlh-aohm-migration-test");
  const result = spawnUpdate(agentDir, ["--dry-run", "--track", "latest-release"]);
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(
    result.stderr,
    /refusing to migrate TLH subagent attention config under normal Pi config root/,
  );
  assert.doesNotMatch(output, /Would enforce TLH subagent attention config/);
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
// 4. Plain update post-step
// ---------------------------------------------------------------------------

test("plain update enforces the subagent attention config after a successful installer", (t) => {
  const { dir, agentDir } = createFixture(t);
  const configDir = join(agentDir, "extensions", "subagent");
  const configPath = join(configDir, "config.json");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      control: {
        activeNoticeAfterMs: 1,
        needsAttentionAfterMs: 2,
        notifyOn: ["active_long_running", "needs_attention"],
      },
      userValue: "preserve",
    }) + "\n",
  );
  const installer = writeDownloadedInstallerFixture(dir, "");

  const result = spawnPlainUpdate(agentDir, installer, ["--track", "latest-release"]);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /Enforced TLH subagent attention config/);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
    control: { needsAttentionAfterMs: 180000, notifyOn: ["needs_attention"] },
    userValue: "preserve",
  });
  assert.equal(
    readdirSync(configDir).filter((entry) => entry.startsWith("config.json.backup-")).length,
    1,
    "successful plain update backs up a changed config",
  );
});

test("plain update does not create a second backup when the installer already converged config", (t) => {
  const { dir, agentDir } = createFixture(t);
  const configDir = join(agentDir, "extensions", "subagent");
  const configPath = join(configDir, "config.json");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({ control: { activeNoticeAfterMs: 1 }, userValue: "preserve" }) + "\n",
  );
  const convergedContent =
    JSON.stringify({
      control: { needsAttentionAfterMs: 180000, notifyOn: ["needs_attention"] },
      userValue: "preserve",
    }) + "\n";
  const installer = writeDownloadedInstallerFixture(
    dir,
    `agent_dir=""\nwhile (($# > 0)); do\n  if [[ "$1" == "--agent-dir" ]]; then\n    agent_dir="$2"\n    shift 2\n  else\n    shift\n  fi\ndone\nprintf '%s\\n' '${convergedContent.trim()}' > "$agent_dir/extensions/subagent/config.json"`,
  );

  const result = spawnPlainUpdate(agentDir, installer, ["--track", "latest-release"]);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.equal(readFileSync(configPath, "utf8"), convergedContent);
  assert.equal(
    readdirSync(configDir).filter((entry) => entry.startsWith("config.json.backup-")).length,
    0,
    "a converged post-step creates no second backup",
  );
  assert.doesNotMatch(output, /Enforced TLH subagent attention config/);
});

test("plain update does not migrate config when the downloaded installer fails", (t) => {
  const { dir, agentDir } = createFixture(t);
  const configDir = join(agentDir, "extensions", "subagent");
  const configPath = join(configDir, "config.json");
  mkdirSync(configDir, { recursive: true });
  const originalContent =
    JSON.stringify({
      control: { activeNoticeAfterMs: 1, needsAttentionAfterMs: 2 },
      userValue: "preserve",
    }) + "\n";
  writeFileSync(configPath, originalContent);
  const installer = writeDownloadedInstallerFixture(dir, "exit 23");

  const result = spawnPlainUpdate(agentDir, installer, ["--track", "latest-release"]);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 23, output);
  assert.equal(readFileSync(configPath, "utf8"), originalContent);
  assert.equal(
    readdirSync(configDir).filter((entry) => entry.startsWith("config.json.backup-")).length,
    0,
    "a failed installer does not trigger the migration post-step",
  );
  assert.doesNotMatch(output, /Enforced TLH subagent attention config/);
});

// ---------------------------------------------------------------------------
// 5. --extensions path
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

test("--extensions holds legacy profile and project selections before invoking fake pi", (t) => {
  const { dir, agentDir } = createFixture(t);
  const project = join(dir, "project");
  const piLog = join(dir, "pi.log");
  mkdirSync(join(project, ".pi"), { recursive: true });
  writeSettings(agentDir, { packages: [legacyMcpSource] });
  writeSettings(join(project, ".pi"), { packages: [nativeMcpSource] });
  writeFakeRuntimePi(dir, piLog);

  const profileHeld = spawnUpdate(agentDir, ["--extensions"]);
  assert.notEqual(profileHeld.status, 0);
  assert.match(profileHeld.stderr, /MCP adapter extension update held/);
  assert.equal(existsSync(piLog), false);

  writeSettings(agentDir, { packages: [] });
  writeSettings(join(project, ".pi"), { packages: [legacyMcpSource] });
  const projectHeld = spawnUpdate(agentDir, ["--extensions"], {}, project);
  assert.notEqual(projectHeld.status, 0);
  assert.match(projectHeld.stderr, /MCP adapter extension update held/);
  assert.equal(existsSync(piLog), false);
});

test("--extensions and recovery hold project overrides with a shadowed unsafe global source", (t) => {
  const { dir, agentDir } = createFixture(t);
  const project = join(dir, "project");
  const piLog = join(dir, "pi.log");
  mkdirSync(join(project, ".pi"), { recursive: true });
  writeSettings(join(project, ".pi"), { packages: [nativeMcpSource] });
  writeFakeRuntimePi(dir, piLog);

  for (const globalSource of [legacyMcpSource, unpinnedMcpSource]) {
    writeSettings(agentDir, { packages: [globalSource] });
    const update = spawnUpdate(agentDir, ["--extensions"], {}, project);
    assert.notEqual(update.status, 0);
    assert.match(update.stderr, /MCP adapter extension update held/);
    assert.equal(existsSync(piLog), false);

    const recovery = spawnRecovery(agentDir, ["--extensions"], {}, project);
    assert.notEqual(recovery.status, 0);
    assert.match(recovery.stderr, /MCP adapter extension update held/);
    assert.equal(existsSync(piLog), false);
  }
});

test("--extensions permits exact native profile/project selections and records the real executor", (t) => {
  const { dir, agentDir } = createFixture(t);
  const project = join(dir, "project");
  const piLog = join(dir, "pi.log");
  mkdirSync(join(project, ".pi"), { recursive: true });
  writeSettings(agentDir, { packages: [nativeMcpSource] });
  writeSettings(join(project, ".pi"), { packages: [nativeMcpSource] });
  writeFakeRuntimePi(dir, piLog);

  const result = spawnUpdate(agentDir, ["--extensions"], {}, project);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(readFileSync(piLog, "utf8"), "update --extensions\n");
});

test("--extensions rejects a ranged native selector even with a compatible warm cache", (t) => {
  const { dir, agentDir } = createFixture(t);
  const piLog = join(dir, "pi.log");
  writeSettings(agentDir, {
    packages: ["npm:@diegopetrucci/pi-mcp-adapter@^5.0.0"],
  });
  writeInstalledMcpMetadata(agentDir, "5.2.0");
  writeFakeRuntimePi(dir, piLog);

  const result = spawnUpdate(agentDir, ["--extensions"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MCP adapter extension update held/);
  assert.equal(existsSync(piLog), false);
});

test("Git identity matrix is anchored to the installed SDK source parser", () => {
  const sdkPackageManager = readFileSync(sdkPackageManagerScript, "utf8");
  const sdkGit = readFileSync(sdkGitScript, "utf8");

  assert.match(sdkPackageManager, /parseSource\(source\)/);
  assert.match(sdkPackageManager, /const gitParsed = parseGitUrl\(source\)/);
  assert.match(sdkGit, /function splitRef\(url\)/);
  assert.match(sdkGit, /export function parseGitUrl\(source\)/);
  assert.match(sdkGit, /git@/);
  assert.match(sdkGit, /https\?\|ssh\|git/);
});

test("main and recovery hold recognized MCP legacy and unresolved Git sources equally", (t) => {
  const sources = [
    {
      label: "HTTPS",
      legacy: "https://github.com/diegopetrucci/pi-mcp-adapter.git#v2.36.0",
      unresolved: "https://github.com/diegopetrucci/pi-mcp-adapter.git",
      cachePath: "github.com/diegopetrucci/pi-mcp-adapter",
    },
    {
      label: "SCP",
      legacy: "git@github.com:diegopetrucci/pi-mcp-adapter.git@v2.36.0",
      unresolved: "git@github.com:diegopetrucci/pi-mcp-adapter.git",
      cachePath: "github.com/diegopetrucci/pi-mcp-adapter",
    },
    {
      label: "SSH",
      legacy: "ssh://git@github.com/diegopetrucci/pi-mcp-adapter.git#v2.36.0",
      unresolved: "ssh://git@github.com/diegopetrucci/pi-mcp-adapter.git",
      cachePath: "github.com/diegopetrucci/pi-mcp-adapter",
    },
    {
      label: "mixed-case HTTPS",
      legacy: "HTTPS://GITHUB.COM/DiegoPetrucci/PI-MCP-ADAPTER.git#v2.36.0",
      unresolved: "HTTPS://GITHUB.COM/DiegoPetrucci/PI-MCP-ADAPTER.git",
      cachePath: "github.com/DiegoPetrucci/PI-MCP-ADAPTER",
    },
  ];

  for (const { label, legacy, unresolved, cachePath } of sources) {
    for (const source of [legacy, unresolved]) {
      const { dir, agentDir } = createFixture(t);
      const piLog = join(dir, "pi.log");
      writeSettings(agentDir, { packages: [source] });
      writeInstalledGitMetadata(agentDir, cachePath, "2.36.0");
      writeFakeRuntimePi(dir, piLog);

      const update = spawnUpdate(agentDir, ["--extensions"]);
      assert.notEqual(update.status, 0, `${label} main unexpectedly ran\n${update.stdout}`);
      assert.match(update.stderr, /MCP adapter extension update held/);
      assert.equal(existsSync(piLog), false, `${label} main invoked fake pi`);

      const recovery = spawnRecovery(agentDir, ["--extensions"]);
      assert.notEqual(recovery.status, 0, `${label} recovery unexpectedly ran\n${recovery.stdout}`);
      assert.match(recovery.stderr, /MCP adapter extension update held/);
      assert.equal(existsSync(piLog), false, `${label} recovery invoked fake pi`);
    }
  }
});

test("main and recovery permit a recognized native Git ref with its matching cache", (t) => {
  const sources = [
    {
      source: "https://github.com/diegopetrucci/pi-mcp-adapter.git#v5.0.0",
      cachePath: "github.com/diegopetrucci/pi-mcp-adapter",
    },
    {
      source: "git@github.com:diegopetrucci/pi-mcp-adapter.git@v5.0.0",
      cachePath: "github.com/diegopetrucci/pi-mcp-adapter",
    },
    {
      source: "ssh://git@github.com/diegopetrucci/pi-mcp-adapter.git#v5.0.0",
      cachePath: "github.com/diegopetrucci/pi-mcp-adapter",
    },
    {
      source: "HTTPS://GITHUB.COM/DiegoPetrucci/PI-MCP-ADAPTER.git#v5.0.0",
      cachePath: "github.com/DiegoPetrucci/PI-MCP-ADAPTER",
    },
  ];

  for (const { source, cachePath } of sources) {
    const { dir, agentDir } = createFixture(t);
    const piLog = join(dir, "pi.log");
    writeSettings(agentDir, { packages: [source] });
    writeInstalledGitMetadata(agentDir, cachePath, "5.0.0");
    writeFakeRuntimePi(dir, piLog);

    const update = spawnUpdate(agentDir, ["--extensions"]);
    assert.equal(update.status, 0, `${source} main failed\n${update.stderr}`);
    const recovery = spawnRecovery(agentDir, ["--extensions"]);
    assert.equal(recovery.status, 0, `${source} recovery failed\n${recovery.stderr}`);
    assert.equal(readFileSync(piLog, "utf8"), "update --extensions\nupdate --extensions\n");
  }
});

test("main and recovery ignore unrelated sources containing the adapter name", (t) => {
  for (const source of [
    "npm:@example/pi-mcp-adapter-tools@2.36.0",
    "https://github.com/example/pi-mcp-adapter-tools.git#v2.36.0",
  ]) {
    const { dir, agentDir } = createFixture(t);
    const piLog = join(dir, "pi.log");
    writeSettings(agentDir, { packages: [source] });
    writeFakeRuntimePi(dir, piLog);

    const update = spawnUpdate(agentDir, ["--extensions"]);
    assert.equal(update.status, 0, `${source} main failed\n${update.stderr}`);
    const recovery = spawnRecovery(agentDir, ["--extensions"]);
    assert.equal(recovery.status, 0, `${source} recovery failed\n${recovery.stderr}`);
    assert.equal(readFileSync(piLog, "utf8"), "update --extensions\nupdate --extensions\n");
  }
});

// ---------------------------------------------------------------------------
// 6. PI_OFFLINE=1 without --dry-run refuses with error
// ---------------------------------------------------------------------------

test("recovery --extensions holds legacy and ranged MCP selections but runs exact native pins", (t) => {
  const { dir, agentDir } = createFixture(t);
  const piLog = join(dir, "pi.log");
  writeFakeRuntimePi(dir, piLog);
  writeSettings(agentDir, { packages: [legacyMcpSource] });

  const legacy = spawnRecovery(agentDir, ["--extensions"]);
  assert.notEqual(legacy.status, 0);
  assert.match(legacy.stderr, /MCP adapter extension update held/);
  assert.equal(existsSync(piLog), false);

  writeSettings(agentDir, {
    packages: ["npm:@diegopetrucci/pi-mcp-adapter@^5.0.0"],
  });
  const ranged = spawnRecovery(agentDir, ["--extensions"]);
  assert.notEqual(ranged.status, 0);
  assert.match(ranged.stderr, /MCP adapter extension update held/);
  assert.equal(existsSync(piLog), false);

  writeSettings(agentDir, { packages: [nativeMcpSource] });
  const native = spawnRecovery(agentDir, ["--extensions"]);
  assert.equal(native.status, 0, `${native.stdout}\n${native.stderr}`);
  assert.equal(readFileSync(piLog, "utf8"), "update --extensions\n");
});

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

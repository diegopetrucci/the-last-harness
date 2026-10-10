import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  installDefaultExtensions,
  preInstallNpmDefaultExtensions,
} from "../scripts/tlh-install.mjs";
import { packageSourcePiSource } from "../scripts/lib/tlh-install-package-source.mjs";
import { runMcpAdapterMigration } from "../scripts/lib/mcp-adapter-migration.mjs";
import {
  assertPiCommands,
  makeDefaultExtensionInstallConfig,
} from "./install-stage1-default-extensions-test-helpers.mjs";

const nativeSource = "npm:@diegopetrucci/pi-mcp-adapter@5.0.0";
const legacySource = "npm:@diegopetrucci/pi-mcp-adapter@2.36.0";
const helperSource = "npm:fixture-helper@1.0.0";
const canonicalIdentity = "npm:@diegopetrucci/pi-mcp-adapter";
const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");
const defaultsScript = join(repoRoot, "scripts", "tlh-defaults.mjs");
const defaultExtensionsPath = join(repoRoot, "config", "default-extensions.json");

function defaultsCommand(config, command = "sources") {
  return spawnSync(
    process.execPath,
    [
      defaultsScript,
      "--settings",
      config.settingsPath,
      "--defaults",
      config.supportFilePaths.DEFAULT_EXTENSIONS_FILE,
      command,
    ],
    {
      cwd: repoRoot,
      env: {
        ...config.env,
        HOME: config.env.HOME,
        PI_CODING_AGENT_DIR: config.agentDir,
        TLH_AGENT_DIR: config.agentDir,
      },
      encoding: "utf8",
    },
  );
}

function mcpDefaults() {
  return [
    {
      id: "mcporter",
      source: nativeSource,
      replaces: [legacySource],
    },
    { id: "fixture-helper", source: helperSource },
  ];
}

function mergeSettings(config, defaultsPath) {
  return spawnSync(
    process.execPath,
    [
      join(repoRoot, "scripts", "merge-settings.mjs"),
      defaultsPath,
      "--settings",
      config.settingsPath,
      "--package-source",
      packageSourcePiSource(config.packageSource, { agentDir: config.agentDir }),
      "--default-extensions",
      config.supportFilePaths.DEFAULT_EXTENSIONS_FILE,
      "--quiet",
    ],
    {
      cwd: repoRoot,
      env: {
        ...config.env,
        HOME: config.env.HOME,
        PI_CODING_AGENT_DIR: config.agentDir,
        TLH_AGENT_DIR: config.agentDir,
      },
      encoding: "utf8",
    },
  );
}

function loggingPiBody({ rejectMcp = false, failBulk = false } = {}) {
  return [
    'printf \'%s|%s|%s\\n\' "${PI_CODING_AGENT_DIR:?}" "$(pwd -P)" "$*" >>"${PI_LOG}"',
    rejectMcp
      ? '[[ "$*" != *"pi-mcp-adapter"* ]] || { printf \'held MCP source executed\\n\' >&2; exit 91; }'
      : "",
    failBulk
      ? '[[ "$*" != "update --extensions" ]] || { printf \'bulk refresh failed\\n\' >&2; exit 92; }'
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function loggingNpmBody() {
  return 'printf \'%s\\n\' "$*" >>"${AGENT_DIR}/npm.log"';
}

function assertNoMcpSource(text) {
  assert.doesNotMatch(text, /pi-mcp-adapter/u);
  assert.doesNotMatch(text, /5\.0\.0/u);
}

function assertOriginalBytes(before) {
  for (const [path, bytes] of before) assert.deepEqual(readFileSync(path), bytes, path);
}

test("installer fixtures hold legacy pins across source selection, batch/fallback, and pre-install", (t) => {
  const { config, agentDir, piLog } = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: mcpDefaults(),
    settings: { packages: [legacySource, helperSource] },
    fakePiBody: loggingPiBody({ rejectMcp: true, failBulk: true }),
    fakeNpmBody: loggingNpmBody(),
  });
  const legacyConfig = join(agentDir, "mcp.json");
  writeFileSync(
    legacyConfig,
    '{\n  "mcpServers": {"fixture": {"command": "fixture-command"}}\n}\n',
  );
  const before = new Map([
    [config.settingsPath, readFileSync(config.settingsPath)],
    [legacyConfig, readFileSync(legacyConfig)],
  ]);

  const sources = defaultsCommand(config);
  assert.equal(sources.status, 0, `${sources.stdout}\n${sources.stderr}`);
  assert.match(sources.stderr, /MCP adapter cutover held/u);
  assertNoMcpSource(sources.stdout);
  assertNoMcpSource(sources.stderr);

  installDefaultExtensions(config);
  assertPiCommands(piLog, agentDir, [`update ${helperSource}`]);
  assertNoMcpSource(readFileSync(piLog, "utf8"));

  preInstallNpmDefaultExtensions(config);
  const npmLog = readFileSync(join(agentDir, "npm.log"), "utf8");
  assert.match(npmLog, /fixture-helper@1\.0\.0/u);
  assertNoMcpSource(npmLog);
  assertOriginalBytes(before);
});

test("fresh selection announces v5, cold pre-install is fake, and warm profiles stay untouched", (t) => {
  const { config, agentDir, piLog } = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: mcpDefaults(),
    settings: {
      packages: [helperSource],
      theme: "user-theme",
      userField: "fixture-user-value",
    },
    fakePiBody: loggingPiBody(),
    fakeNpmBody: loggingNpmBody(),
  });
  const legacyConfig = join(agentDir, "mcp.json");
  const legacyBytes = Buffer.from('{"fixture":"preserve"}\n');
  writeFileSync(legacyConfig, legacyBytes);
  const preMergeBefore = new Map([
    [config.settingsPath, readFileSync(config.settingsPath)],
    [legacyConfig, readFileSync(legacyConfig)],
  ]);

  const sources = defaultsCommand(config);
  assert.equal(sources.status, 0, `${sources.stdout}\n${sources.stderr}`);
  assert.match(sources.stderr, /fresh component choice/u);
  assert.match(
    sources.stdout,
    new RegExp(nativeSource.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
  );
  assertOriginalBytes(preMergeBefore);

  const fixtureDefaultsPath = join(config.agentDir, "..", "settings.defaults.json");
  const fixtureDefaults = JSON.parse(
    readFileSync(join(repoRoot, "config", "settings.defaults.json"), "utf8"),
  );
  fixtureDefaults.fixtureDefault = "fixture-default";
  writeFileSync(fixtureDefaultsPath, `${JSON.stringify(fixtureDefaults, null, 2)}\n`);
  const merge = mergeSettings(config, fixtureDefaultsPath);
  assert.equal(merge.status, 0, `${merge.stdout}\n${merge.stderr}`);
  const mergedSettings = JSON.parse(readFileSync(config.settingsPath, "utf8"));
  assert.equal(mergedSettings.fixtureDefault, "fixture-default");
  assert.equal(mergedSettings.theme, "user-theme");
  assert.equal(mergedSettings.userField, "fixture-user-value");
  assert.equal(mergedSettings.packages.includes(nativeSource), true);
  assert.equal(mergedSettings.packages.includes(helperSource), true);
  assert.equal(readFileSync(legacyConfig).equals(legacyBytes), true);
  const before = new Map([
    [config.settingsPath, readFileSync(config.settingsPath)],
    [legacyConfig, readFileSync(legacyConfig)],
  ]);

  installDefaultExtensions(config);
  assertPiCommands(piLog, agentDir, ["update --extensions"]);
  preInstallNpmDefaultExtensions(config);
  const npmLogPath = join(agentDir, "npm.log");
  const coldNpmLog = readFileSync(npmLogPath, "utf8");
  assert.match(coldNpmLog, /pi-mcp-adapter@5\.0\.0/u);
  const npmRoot = join(agentDir, "npm");
  assert.equal(existsSync(npmRoot), true);
  writeFileSync(join(npmRoot, "warm-sentinel"), "preserve-warm\n");
  const warmLogBefore = readFileSync(npmLogPath);

  preInstallNpmDefaultExtensions(config);
  assert.deepEqual(readFileSync(npmLogPath), warmLogBefore);
  assert.equal(readFileSync(join(npmRoot, "warm-sentinel"), "utf8"), "preserve-warm\n");
  assertOriginalBytes(before);
});

test("acknowledged migration selects v5, while rollback re-holds the old source and preserves bytes", (t) => {
  const { config, agentDir, piLog } = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: mcpDefaults(),
    settings: {
      packages: [legacySource],
      owner: "fixture-owner",
      tlh: { defaultExtensionProvenance: { managedPackageIdentities: [canonicalIdentity] } },
    },
    fakePiBody: loggingPiBody({ rejectMcp: true }),
    fakeNpmBody: loggingNpmBody(),
  });
  const legacyConfig = join(agentDir, "mcp.json");
  const legacyBytes = Buffer.from(
    '{\n  // migration fixture bytes\n  "mcpServers": {"fixture": {"command": "fixture-command"}}\n}\n',
  );
  writeFileSync(legacyConfig, legacyBytes);
  const settingsBeforeMigration = readFileSync(config.settingsPath);

  const migration = runMcpAdapterMigration({
    settingsPath: realpathSync(config.settingsPath),
    defaultExtensionsPath,
    apply: true,
    acknowledgeUnverifiedMcpConfigs: true,
    homeDir: config.env.HOME,
  });
  assert.equal(migration.exitCode, 0, migration.output);
  const migratedNative = join(agentDir, "mcp-adapter.json");
  assert.equal(readFileSync(migratedNative).equals(legacyBytes), true);
  assert.equal(readFileSync(legacyConfig).equals(legacyBytes), true);
  const migratedSettings = JSON.parse(readFileSync(config.settingsPath, "utf8"));
  assert.equal(migratedSettings.packages[0], nativeSource);

  let sources = defaultsCommand(config);
  assert.equal(sources.status, 0, `${sources.stdout}\n${sources.stderr}`);
  assert.match(sources.stdout, /pi-mcp-adapter@5\.0\.0/u);
  assert.doesNotMatch(sources.stderr, /cutover held/u);

  installDefaultExtensions(config);
  preInstallNpmDefaultExtensions(config);
  assert.match(readFileSync(join(agentDir, "npm.log"), "utf8"), /pi-mcp-adapter@5\.0\.0/u);
  assertNoMcpSource(readFileSync(piLog, "utf8"));

  const rollbackSettings = JSON.parse(readFileSync(config.settingsPath, "utf8"));
  rollbackSettings.packages = [legacySource];
  writeFileSync(config.settingsPath, `${JSON.stringify(rollbackSettings, null, 2)}\n`);
  rmSync(join(agentDir, "npm"), { recursive: true, force: true });
  rmSync(join(agentDir, "npm.log"), { force: true });
  writeFileSync(piLog, "", "utf8");
  sources = defaultsCommand(config);
  assert.equal(sources.status, 0, `${sources.stdout}\n${sources.stderr}`);
  assert.match(sources.stderr, /cutover held/u);
  assertNoMcpSource(sources.stdout);
  assertNoMcpSource(sources.stderr);

  installDefaultExtensions(config);
  preInstallNpmDefaultExtensions(config);
  assertNoMcpSource(readFileSync(piLog, "utf8"));
  assert.equal(existsSync(join(agentDir, "npm.log")), false);
  assert.equal(readFileSync(legacyConfig).equals(legacyBytes), true);
  assert.equal(readFileSync(migratedNative).equals(legacyBytes), true);
  assert.equal(settingsBeforeMigration.includes(Buffer.from(legacySource)), true);
});

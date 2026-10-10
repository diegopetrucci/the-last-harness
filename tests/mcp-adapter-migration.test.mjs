import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

import { runMcpAdapterMigration } from "../scripts/lib/mcp-adapter-migration.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const defaultsScript = join(repoRoot, "scripts", "tlh-defaults.mjs");
const defaultExtensions = join(repoRoot, "config", "default-extensions.json");
const canonicalMcpIdentity = "npm:@diegopetrucci/pi-mcp-adapter";
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "tlh-mcp-migration-")));
  temporaryDirectories.push(directory);
  const agent = join(directory, "agent");
  const project = join(directory, "project");
  const projectPi = join(project, ".pi");
  const home = join(directory, "home");
  for (const path of [agent, projectPi, home]) {
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, ".keep"), "", { flag: "w" });
  }
  return {
    directory,
    agent,
    project,
    projectPi,
    home,
    settings: join(agent, "settings.json"),
    globalLegacy: join(agent, "mcp.json"),
    globalNative: join(agent, "mcp-adapter.json"),
    projectLegacy: join(projectPi, "mcp.json"),
    projectNative: join(projectPi, "mcp-adapter.json"),
  };
}

function removePlaceholder(path) {
  rmSync(path, { force: true });
}

function runDefaults(fixtureValue, args) {
  const result = spawnSync(
    process.execPath,
    [
      defaultsScript,
      "--settings",
      fixtureValue.settings,
      "--defaults",
      defaultExtensions,
      "migrate-mcp",
      ...args,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: fixtureValue.home,
        PI_CODING_AGENT_DIR: fixtureValue.agent,
      },
      encoding: "utf8",
    },
  );
  return result;
}

function writeLegacy(
  path,
  body = '{\n  // legacy JSONC\n  "mcpServers": {\n    "docs": { "command": "node", "args": ["server.js"] }\n  }\n}\n',
) {
  writeFileSync(path, body);
}

function writeLegacySettings(
  path,
  source = "npm:@diegopetrucci/pi-mcp-adapter@2.36.0",
  { managed = true } = {},
) {
  const identity = source.startsWith("npm:pi-mcp-adapter")
    ? "npm:pi-mcp-adapter"
    : canonicalMcpIdentity;
  const settings = { packages: [source], owner: "preserve" };
  if (managed) {
    settings.tlh = { defaultExtensionProvenance: { managedPackageIdentities: [identity] } };
  }
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}

test("preview is the default and does not write configs or settings", () => {
  const value = fixture();
  removePlaceholder(join(value.agent, ".keep"));
  writeLegacySettings(value.settings);
  writeLegacy(value.globalLegacy);
  const before = readFileSync(value.globalLegacy);
  const result = runDefaults(value, []);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MCP migration preview/);
  assert.match(result.stdout, /COPY/);
  assert.equal(existsSync(value.globalNative), false);
  assert.deepEqual(readFileSync(value.globalLegacy), before);
  assert.match(readFileSync(value.settings, "utf8"), /2\.36\.0/);
});

test("apply requires both explicit flags and does not treat force or yes as consent", () => {
  const value = fixture();
  removePlaceholder(join(value.agent, ".keep"));
  writeLegacySettings(value.settings);
  writeLegacy(value.globalLegacy);
  for (const args of [["--apply"], ["--force", "--apply"], ["--yes", "--apply"]]) {
    const result = runDefaults(value, args);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stdout,
      /both --apply and --acknowledge-unverified-mcp-configs are required/,
    );
    assert.equal(existsSync(value.globalNative), false);
    assert.match(readFileSync(value.settings, "utf8"), /2\.36\.0/);
  }
});

test("acknowledged apply copies JSONC bytes and mode, then updates only the owned pin", () => {
  const value = fixture();
  removePlaceholder(join(value.agent, ".keep"));
  writeLegacySettings(value.settings);
  const body =
    '{\n/* preserve this comment */\n"mcpServers": {"docs": {"url": "https://mcp.example.invalid"}}\n}\n';
  writeLegacy(value.globalLegacy, body);
  chmodSync(value.globalLegacy, 0o640);
  const result = runDefaults(value, ["--apply", "--acknowledge-unverified-mcp-configs"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Apply committed writes transactionally/);
  assert.equal(readFileSync(value.globalNative, "utf8"), body);
  assert.equal(lstatSync(value.globalNative).mode & 0o777, 0o640);
  assert.equal(readFileSync(value.globalLegacy, "utf8"), body);
  const settings = JSON.parse(readFileSync(value.settings, "utf8"));
  assert.equal(settings.packages[0], "npm:@diegopetrucci/pi-mcp-adapter@5.0.0");
  assert.equal(settings.owner, "preserve");
  assert.deepEqual(settings.extensions, ["-builtin:mcp"]);
  assert.equal(settings.tlh.builtinMcpExclusionManaged, true);
  const backupNames = readdirSync(value.agent).filter((name) =>
    name.includes("settings.json.backup"),
  );
  assert.equal(backupNames.length, 1);
});

test("project selection includes ancestors and keeps native-looking legacy bytes untouched", () => {
  const value = fixture();
  removePlaceholder(join(value.agent, ".keep"));
  writeLegacySettings(value.settings);
  writeLegacy(
    value.projectLegacy,
    '{\n  "mcpServers": {"native-looking": {"command": "node"}}\n}\n',
  );
  const before = readFileSync(value.projectLegacy);
  const result = runDefaults(value, [
    "--project",
    value.project,
    "--apply",
    "--acknowledge-unverified-mcp-configs",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(value.projectNative).toString(), before.toString());
  assert.equal(readFileSync(value.projectLegacy).toString(), before.toString());
});

test("v3 and unknown pins remain manual and never activate the legacy file", () => {
  for (const source of [
    "npm:@diegopetrucci/pi-mcp-adapter@3.0.0",
    "npm:@diegopetrucci/pi-mcp-adapter",
  ]) {
    const value = fixture();
    removePlaceholder(join(value.agent, ".keep"));
    writeLegacySettings(value.settings, source);
    writeLegacy(value.globalLegacy);
    const result = runDefaults(value, ["--apply", "--acknowledge-unverified-mcp-configs"]);
    assert.notEqual(result.status, 0, source);
    assert.match(result.stdout, /MANUAL/);
    assert.equal(existsSync(value.globalNative), false);
    const escapedSource = source.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    assert.match(readFileSync(value.settings, "utf8"), new RegExp(escapedSource));
  }
});

test("native-only fields, malformed JSONC, and nonidentical targets refuse the whole transaction", () => {
  const cases = [
    {
      body: '{"mcpServers":{"docs":{"command":"node","enabled":true}}}',
      reason: /config-native-field/,
    },
    {
      body: '{"mcpServers":{"docs":{"command":"node","url":"https://example.invalid"}}}',
      reason: /config-command-and-url/,
    },
    {
      body: '{"mcpServers":{"docs":{"url":"https://example.invalid","auth":{}}}}',
      reason: /config-auth-object/,
    },
    { body: "{", reason: /config-malformed/ },
  ];
  for (const item of cases) {
    const value = fixture();
    removePlaceholder(join(value.agent, ".keep"));
    writeLegacySettings(value.settings);
    writeLegacy(value.globalLegacy, item.body);
    const result = runDefaults(value, ["--apply", "--acknowledge-unverified-mcp-configs"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, item.reason);
    assert.equal(existsSync(value.globalNative), false);
    assert.match(readFileSync(value.settings, "utf8"), /2\.36\.0/);
  }

  const value = fixture();
  removePlaceholder(join(value.agent, ".keep"));
  writeLegacySettings(value.settings);
  writeLegacy(value.globalLegacy);
  writeFileSync(value.globalNative, '{"different":true}\n');
  const result = runDefaults(value, ["--apply", "--acknowledge-unverified-mcp-configs"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /target-nonidentical/);
  assert.equal(readFileSync(value.globalNative, "utf8"), '{"different":true}\n');
  assert.match(readFileSync(value.settings, "utf8"), /2\.36\.0/);
});

test("unmatched native configs are refused before activation, including unsafe forms", () => {
  const global = fixture();
  removePlaceholder(join(global.agent, ".keep"));
  removePlaceholder(join(global.projectPi, ".keep"));
  writeLegacySettings(global.settings);
  writeLegacy(global.projectLegacy, '{"mcpServers":{"project":{"command":"node"}}}\n');
  const projectLegacyBefore = readFileSync(global.projectLegacy);
  const nativeBody = '{"mcpServers":{"already-native":{"url":"native-secret"}}}\n';
  writeFileSync(global.globalNative, nativeBody);
  const beforeSettings = readFileSync(global.settings);
  let result = runDefaults(global, [
    "--project",
    global.project,
    "--apply",
    "--acknowledge-unverified-mcp-configs",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /native-config-unmatched/);
  assert.equal(existsSync(global.globalLegacy), false);
  assert.equal(existsSync(global.globalNative), true);
  assert.equal(readFileSync(global.globalNative, "utf8"), nativeBody);
  assert.equal(existsSync(global.projectNative), false);
  assert.deepEqual(readFileSync(global.projectLegacy), projectLegacyBefore);
  assert.deepEqual(readFileSync(global.settings), beforeSettings);
  assert.doesNotMatch(result.stdout, /native-secret/);

  const emptyProject = fixture();
  removePlaceholder(join(emptyProject.agent, ".keep"));
  removePlaceholder(join(emptyProject.projectPi, ".keep"));
  writeLegacySettings(emptyProject.settings);
  writeLegacy(emptyProject.globalLegacy);
  const emptyProjectGlobalLegacyBefore = readFileSync(emptyProject.globalLegacy);
  writeFileSync(emptyProject.projectLegacy, "");
  const emptyProjectLegacyBefore = readFileSync(emptyProject.projectLegacy);
  const emptyProjectNativeBody =
    '{"mcpServers":{"empty-project-native":{"url":"empty-project-native-secret"}}}\n';
  writeFileSync(emptyProject.projectNative, emptyProjectNativeBody);
  const emptyProjectNativeBefore = readFileSync(emptyProject.projectNative);
  const emptyProjectSettingsBefore = readFileSync(emptyProject.settings);
  result = runDefaults(emptyProject, [
    "--project",
    emptyProject.project,
    "--apply",
    "--acknowledge-unverified-mcp-configs",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /native-config-unmatched/);
  assert.equal(existsSync(emptyProject.globalNative), false);
  assert.deepEqual(readFileSync(emptyProject.globalLegacy), emptyProjectGlobalLegacyBefore);
  assert.deepEqual(readFileSync(emptyProject.projectLegacy), emptyProjectLegacyBefore);
  assert.deepEqual(readFileSync(emptyProject.projectNative), emptyProjectNativeBefore);
  assert.deepEqual(readFileSync(emptyProject.settings), emptyProjectSettingsBefore);
  assert.doesNotMatch(result.stdout, /empty-project-native-secret/);

  const emptyGlobal = fixture();
  removePlaceholder(join(emptyGlobal.agent, ".keep"));
  removePlaceholder(join(emptyGlobal.projectPi, ".keep"));
  writeLegacySettings(emptyGlobal.settings);
  writeFileSync(emptyGlobal.globalLegacy, "");
  const emptyGlobalLegacyBefore = readFileSync(emptyGlobal.globalLegacy);
  const emptyGlobalNativeBody =
    '{"mcpServers":{"empty-global-native":{"url":"empty-global-native-secret"}}}\n';
  writeFileSync(emptyGlobal.globalNative, emptyGlobalNativeBody);
  const emptyGlobalNativeBefore = readFileSync(emptyGlobal.globalNative);
  writeLegacy(emptyGlobal.projectLegacy);
  const emptyGlobalProjectLegacyBefore = readFileSync(emptyGlobal.projectLegacy);
  const emptyGlobalSettingsBefore = readFileSync(emptyGlobal.settings);
  result = runDefaults(emptyGlobal, [
    "--project",
    emptyGlobal.project,
    "--apply",
    "--acknowledge-unverified-mcp-configs",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /native-config-unmatched/);
  assert.deepEqual(readFileSync(emptyGlobal.globalLegacy), emptyGlobalLegacyBefore);
  assert.deepEqual(readFileSync(emptyGlobal.globalNative), emptyGlobalNativeBefore);
  assert.deepEqual(readFileSync(emptyGlobal.projectLegacy), emptyGlobalProjectLegacyBefore);
  assert.equal(existsSync(emptyGlobal.projectNative), false);
  assert.deepEqual(readFileSync(emptyGlobal.settings), emptyGlobalSettingsBefore);
  assert.doesNotMatch(result.stdout, /empty-global-native-secret/);

  for (const item of [
    { body: '{"imports":["native-import-secret"]}\n', reason: /config-imported/ },
    { body: '{"mcpServers":', reason: /config-malformed/ },
  ]) {
    const value = fixture();
    removePlaceholder(join(value.agent, ".keep"));
    removePlaceholder(join(value.projectPi, ".keep"));
    writeLegacySettings(value.settings);
    writeLegacy(value.projectLegacy, '{"mcpServers":{"project":{"command":"node"}}}\n');
    const projectLegacyBefore = readFileSync(value.projectLegacy);
    writeFileSync(value.globalNative, item.body);
    const settingsBefore = readFileSync(value.settings);
    result = runDefaults(value, [
      "--project",
      value.project,
      "--apply",
      "--acknowledge-unverified-mcp-configs",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, item.reason);
    assert.equal(existsSync(value.globalLegacy), false);
    assert.equal(readFileSync(value.globalNative, "utf8"), item.body);
    assert.equal(existsSync(value.projectNative), false);
    assert.deepEqual(readFileSync(value.projectLegacy), projectLegacyBefore);
    assert.deepEqual(readFileSync(value.settings), settingsBefore);
    assert.doesNotMatch(result.stdout, /native-import-secret/);
  }

  const project = fixture();
  removePlaceholder(join(project.agent, ".keep"));
  removePlaceholder(join(project.projectPi, ".keep"));
  writeLegacySettings(project.settings);
  writeLegacy(project.globalLegacy);
  const globalLegacyBefore = readFileSync(project.globalLegacy);
  const projectNativeBody = '{"mcpServers":{"project-native":{"url":"project-native-secret"}}}\n';
  writeFileSync(project.projectNative, projectNativeBody);
  const projectSettingsBefore = readFileSync(project.settings);
  result = runDefaults(project, [
    "--project",
    project.project,
    "--apply",
    "--acknowledge-unverified-mcp-configs",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /native-config-unmatched/);
  assert.equal(existsSync(project.globalNative), false);
  assert.equal(readFileSync(project.globalLegacy, "utf8"), globalLegacyBefore.toString());
  assert.equal(readFileSync(project.projectNative, "utf8"), projectNativeBody);
  assert.deepEqual(readFileSync(project.settings), projectSettingsBefore);
  assert.doesNotMatch(result.stdout, /project-native-secret/);

  const unsafeProject = fixture();
  removePlaceholder(join(unsafeProject.agent, ".keep"));
  writeLegacySettings(unsafeProject.settings);
  writeLegacy(unsafeProject.globalLegacy);
  const outside = join(unsafeProject.directory, "native-outside.json");
  writeFileSync(outside, '{"token":"project-native-secret"}\n');
  symlinkSync(outside, unsafeProject.projectNative);
  const unsafeProjectSettingsBefore = readFileSync(unsafeProject.settings);
  result = runDefaults(unsafeProject, [
    "--project",
    unsafeProject.project,
    "--apply",
    "--acknowledge-unverified-mcp-configs",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /source-aliased|unsafe-path/);
  assert.equal(existsSync(unsafeProject.globalNative), false);
  assert.equal(
    readFileSync(unsafeProject.projectNative, "utf8"),
    '{"token":"project-native-secret"}\n',
  );
  assert.deepEqual(readFileSync(unsafeProject.settings), unsafeProjectSettingsBefore);
  assert.doesNotMatch(result.stdout, /project-native-secret/);
});

test("planning rereads fail closed when legacy inputs change", () => {
  const global = fixture();
  removePlaceholder(join(global.agent, ".keep"));
  removePlaceholder(join(global.projectPi, ".keep"));
  writeLegacySettings(global.settings);
  writeFileSync(global.globalLegacy, "");
  const concurrentGlobalLegacy =
    '{"mcpServers":{"global-reread":{"url":"global-reread-secret"}}}\n';
  const globalNativeBody = '{"mcpServers":{"global-native":{"url":"global-native-secret"}}}\n';
  writeFileSync(global.globalNative, globalNativeBody);
  writeLegacy(global.projectLegacy, '{"mcpServers":{"eligible-project":{"command":"node"}}}\n');
  const globalSettingsBefore = readFileSync(global.settings);
  const globalNativeBefore = readFileSync(global.globalNative);
  const globalProjectLegacyBefore = readFileSync(global.projectLegacy);
  let globalCallbackRan = false;
  const globalResult = runMcpAdapterMigration({
    settingsPath: global.settings,
    defaultExtensionsPath: defaultExtensions,
    projectDirs: [global.project],
    apply: true,
    acknowledgeUnverifiedMcpConfigs: true,
    homeDir: global.home,
    hooks: {
      beforeUnmatchedNativeReread: (scope, legacyPath) => {
        if (scope === "global" && legacyPath === global.globalLegacy) {
          globalCallbackRan = true;
          writeFileSync(global.globalLegacy, concurrentGlobalLegacy);
        }
      },
    },
  });
  assert.equal(globalCallbackRan, true);
  assert.equal(globalResult.exitCode, 1);
  assert.match(globalResult.output, /could not be safely planned/);
  assert.doesNotMatch(globalResult.output, /global-reread-secret|global-native-secret/);
  assert.deepEqual(readFileSync(global.globalLegacy), Buffer.from(concurrentGlobalLegacy));
  assert.deepEqual(readFileSync(global.globalNative), globalNativeBefore);
  assert.deepEqual(readFileSync(global.projectLegacy), globalProjectLegacyBefore);
  assert.equal(existsSync(global.projectNative), false);
  assert.deepEqual(readFileSync(global.settings), globalSettingsBefore);
  assert.doesNotMatch(readFileSync(global.settings, "utf8"), /5\.0\.0/);

  const project = fixture();
  removePlaceholder(join(project.agent, ".keep"));
  removePlaceholder(join(project.projectPi, ".keep"));
  writeLegacySettings(project.settings);
  writeLegacy(project.globalLegacy);
  const projectGlobalLegacyBefore = readFileSync(project.globalLegacy);
  writeFileSync(project.projectLegacy, "");
  const concurrentProjectLegacy =
    '{"mcpServers":{"project-reread":{"url":"project-reread-secret"}}}\n';
  const projectNativeBody = '{"mcpServers":{"project-native":{"url":"project-native-secret"}}}\n';
  writeFileSync(project.projectNative, projectNativeBody);
  const projectSettingsBefore = readFileSync(project.settings);
  const projectNativeBefore = readFileSync(project.projectNative);
  let projectCallbackRan = false;
  const projectResult = runMcpAdapterMigration({
    settingsPath: project.settings,
    defaultExtensionsPath: defaultExtensions,
    projectDirs: [project.project],
    apply: true,
    acknowledgeUnverifiedMcpConfigs: true,
    homeDir: project.home,
    hooks: {
      beforeUnmatchedNativeReread: (scope, legacyPath) => {
        if (scope === "project" && legacyPath === project.projectLegacy) {
          projectCallbackRan = true;
          writeFileSync(project.projectLegacy, concurrentProjectLegacy);
        }
      },
    },
  });
  assert.equal(projectCallbackRan, true);
  assert.equal(projectResult.exitCode, 1);
  assert.match(projectResult.output, /could not be safely planned/);
  assert.doesNotMatch(projectResult.output, /project-reread-secret|project-native-secret/);
  assert.deepEqual(readFileSync(project.globalLegacy), projectGlobalLegacyBefore);
  assert.equal(existsSync(project.globalNative), false);
  assert.deepEqual(readFileSync(project.projectLegacy), Buffer.from(concurrentProjectLegacy));
  assert.deepEqual(readFileSync(project.projectNative), projectNativeBefore);
  assert.deepEqual(readFileSync(project.settings), projectSettingsBefore);
  assert.doesNotMatch(readFileSync(project.settings, "utf8"), /5\.0\.0/);
});

test("foreign UID ownership is refused without changing the fixture", () => {
  const value = fixture();
  removePlaceholder(join(value.agent, ".keep"));
  writeLegacySettings(value.settings);
  writeLegacy(value.globalLegacy);
  const beforeSettings = readFileSync(value.settings);
  const beforeLegacy = readFileSync(value.globalLegacy);
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
  const originalGetuid = process.getuid;
  assert.equal(typeof originalGetuid, "function");
  let result;
  Object.defineProperty(process, "getuid", {
    configurable: true,
    value: () => originalGetuid() + 1,
  });
  try {
    result = runMcpAdapterMigration({
      settingsPath: value.settings,
      defaultExtensionsPath: defaultExtensions,
      apply: true,
      acknowledgeUnverifiedMcpConfigs: true,
      homeDir: value.home,
    });
  } finally {
    if (originalDescriptor) Object.defineProperty(process, "getuid", originalDescriptor);
  }
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /unsafe-access/);
  assert.equal(existsSync(value.globalNative), false);
  assert.deepEqual(readFileSync(value.settings), beforeSettings);
  assert.deepEqual(readFileSync(value.globalLegacy), beforeLegacy);
});

test("symlinked sources and secrets are refused without leaking config content", () => {
  const value = fixture();
  removePlaceholder(join(value.agent, ".keep"));
  writeLegacySettings(value.settings);
  const secret = "super-secret-token";
  const outside = join(value.directory, "outside.json");
  writeFileSync(outside, JSON.stringify({ token: secret }));
  symlinkSync(outside, value.globalLegacy);
  const result = runDefaults(value, ["--apply", "--acknowledge-unverified-mcp-configs"]);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, new RegExp(secret));
  assert.doesNotMatch(result.stderr, new RegExp(secret));
  assert.equal(existsSync(value.globalNative), false);
});

test("copy failure rolls back only this run's earlier target", () => {
  const value = fixture();
  removePlaceholder(join(value.agent, ".keep"));
  writeLegacySettings(value.settings);
  writeLegacy(value.globalLegacy);
  writeLegacy(value.projectLegacy, '{"mcpServers":{"project":{"command":"node"}}}\n');
  const result = runMcpAdapterMigration({
    settingsPath: value.settings,
    defaultExtensionsPath: defaultExtensions,
    projectDirs: [value.project],
    apply: true,
    acknowledgeUnverifiedMcpConfigs: true,
    hooks: {
      beforeCopy: (_sourcePath, _targetPath, index) => {
        if (index === 1) throw new Error("injected copy failure");
      },
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(existsSync(value.globalNative), false);
  assert.equal(existsSync(value.projectNative), false);
  assert.match(readFileSync(value.settings, "utf8"), /2\.36\.0/);
});

test("settings race rolls back owned copies while retaining the concurrent settings edit", () => {
  const value = fixture();
  removePlaceholder(join(value.agent, ".keep"));
  writeLegacySettings(value.settings);
  writeLegacy(value.globalLegacy);
  let result = runMcpAdapterMigration({
    settingsPath: value.settings,
    defaultExtensionsPath: defaultExtensions,
    apply: true,
    acknowledgeUnverifiedMcpConfigs: true,
    hooks: {
      beforeSettings: (settingsPath) => {
        writeFileSync(
          settingsPath,
          JSON.stringify({ packages: ["npm:helper"], concurrent: true }) + "\n",
        );
      },
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(existsSync(value.globalNative), false);
  assert.match(readFileSync(value.settings, "utf8"), /concurrent/);
  assert.doesNotMatch(readFileSync(value.settings, "utf8"), /5\.0\.0/);

  const concurrentTarget = fixture();
  removePlaceholder(join(concurrentTarget.agent, ".keep"));
  writeLegacySettings(concurrentTarget.settings);
  writeLegacy(concurrentTarget.globalLegacy);
  const concurrentTargetSettingsBefore = readFileSync(concurrentTarget.settings);
  const concurrentTargetSourceBefore = readFileSync(concurrentTarget.globalLegacy);
  const identicalTargetBytes = readFileSync(concurrentTarget.globalLegacy);
  writeFileSync(concurrentTarget.globalNative, identicalTargetBytes);
  const concurrentTargetBytes = Buffer.from("concurrent-target-edit\n");
  result = runMcpAdapterMigration({
    settingsPath: concurrentTarget.settings,
    defaultExtensionsPath: defaultExtensions,
    apply: true,
    acknowledgeUnverifiedMcpConfigs: true,
    homeDir: concurrentTarget.home,
    hooks: {
      beforeSettings: (settingsPath) => {
        if (settingsPath === concurrentTarget.settings) {
          writeFileSync(concurrentTarget.globalNative, concurrentTargetBytes);
        }
      },
    },
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(readFileSync(concurrentTarget.settings), concurrentTargetSettingsBefore);
  assert.deepEqual(readFileSync(concurrentTarget.globalLegacy), concurrentTargetSourceBefore);
  assert.deepEqual(readFileSync(concurrentTarget.globalNative), concurrentTargetBytes);
  assert.doesNotMatch(readFileSync(concurrentTarget.settings, "utf8"), /5\.0\.0/);
});

test("a successful rerun is idempotent and does not create a second config copy", () => {
  const value = fixture();
  removePlaceholder(join(value.agent, ".keep"));
  writeLegacySettings(value.settings);
  writeLegacy(value.globalLegacy);
  const first = runDefaults(value, ["--apply", "--acknowledge-unverified-mcp-configs"]);
  assert.equal(first.status, 0, first.stderr);
  const nativeBefore = readFileSync(value.globalNative);
  const settingsBefore = readFileSync(value.settings);
  const nativeStatBefore = lstatSync(value.globalNative);
  const settingsStatBefore = lstatSync(value.settings);
  const backupCountBefore = readdirSync(value.agent).filter((name) =>
    name.includes("settings.json.backup"),
  ).length;
  const second = runDefaults(value, ["--apply", "--acknowledge-unverified-mcp-configs"]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /UNCHANGED/);
  assert.deepEqual(readFileSync(value.globalNative), nativeBefore);
  assert.deepEqual(readFileSync(value.settings), settingsBefore);
  const nativeStatAfter = lstatSync(value.globalNative);
  const settingsStatAfter = lstatSync(value.settings);
  assert.equal(nativeStatAfter.ino, nativeStatBefore.ino);
  assert.equal(nativeStatAfter.mtimeMs, nativeStatBefore.mtimeMs);
  assert.equal(settingsStatAfter.ino, settingsStatBefore.ino);
  assert.equal(settingsStatAfter.mtimeMs, settingsStatBefore.mtimeMs);
  assert.equal(
    readdirSync(value.agent).filter((name) => name.includes("settings.json.backup")).length,
    backupCountBefore,
  );
});

test("approved replacement migration records owned canonical provenance and reruns without writes", () => {
  const value = fixture();
  removePlaceholder(join(value.agent, ".keep"));
  writeLegacySettings(value.settings, "npm:pi-mcp-adapter@2.36.0", { managed: false });
  writeLegacy(value.globalLegacy);
  const first = runDefaults(value, ["--apply", "--acknowledge-unverified-mcp-configs"]);
  assert.equal(first.status, 0, first.stderr);
  const firstSettings = readFileSync(value.settings);
  const firstNative = readFileSync(value.globalNative);
  const firstSettingsStat = lstatSync(value.settings);
  const firstNativeStat = lstatSync(value.globalNative);
  const settings = JSON.parse(firstSettings.toString());
  assert.equal(settings.packages[0], "npm:@diegopetrucci/pi-mcp-adapter@5.0.0");
  assert.deepEqual(settings.tlh.defaultExtensionProvenance.managedPackageIdentities, [
    canonicalMcpIdentity,
  ]);
  const second = runDefaults(value, ["--apply", "--acknowledge-unverified-mcp-configs"]);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(readFileSync(value.settings), firstSettings);
  assert.deepEqual(readFileSync(value.globalNative), firstNative);
  assert.equal(lstatSync(value.settings).ino, firstSettingsStat.ino);
  assert.equal(lstatSync(value.settings).mtimeMs, firstSettingsStat.mtimeMs);
  assert.equal(lstatSync(value.globalNative).ino, firstNativeStat.ino);
  assert.equal(lstatSync(value.globalNative).mtimeMs, firstNativeStat.mtimeMs);
});

test("JSONC URLs, escaped quotes, comments, and trailing commas are copied byte-for-byte", () => {
  const value = fixture();
  removePlaceholder(join(value.agent, ".keep"));
  writeLegacySettings(value.settings);
  const body =
    '{\n  // URL comments are data, not JSONC comments\n  "mcpServers": {\n    "docs": { "url": "https://example.invalid/path//part?q=\\\"ok\\\"", },\n  },\n}\n';
  writeLegacy(value.globalLegacy, body);
  const result = runDefaults(value, ["--apply", "--acknowledge-unverified-mcp-configs"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(value.globalNative, "utf8"), body);
});

test("BOM, nonobjects, native exposure fields, alternate containers, imports, and auth refuse without writes", () => {
  const cases = [
    { body: `\uFEFF${JSON.stringify({ mcpServers: {} })}`, reason: /config-bom/ },
    { body: "[]", reason: /config-nonobject/ },
    { body: '{"exposure":"all"}', reason: /config-policy/ },
    { body: '{"toolExposure":"all"}', reason: /config-policy/ },
    { body: '{"timeout":10}', reason: /config-policy/ },
    { body: '{"auth":{"token":"auth-secret"}}', reason: /config-auth-object/ },
    {
      body: '{"mcpServers":{"docs":{"url":"malformed-secret"}}',
      reason: /config-malformed/,
    },
    {
      body: '{"mcp-servers":{"docs":{"command":"node","enabled":true}}}',
      reason: /config-imported/,
    },
    { body: '{"imports":["sentinel-import"]}', reason: /config-imported/ },
    { body: '{"claudePlugins":["sentinel-plugin"]}', reason: /config-imported/ },
  ];
  for (const item of cases) {
    const value = fixture();
    removePlaceholder(join(value.agent, ".keep"));
    writeLegacySettings(value.settings);
    const beforeSettings = readFileSync(value.settings);
    writeLegacy(value.globalLegacy, item.body);
    const result = runDefaults(value, ["--apply", "--acknowledge-unverified-mcp-configs"]);
    assert.notEqual(result.status, 0, item.body);
    assert.match(result.stdout, item.reason);
    assert.doesNotMatch(
      result.stdout,
      /auth-secret|malformed-secret|sentinel-import|sentinel-plugin/,
    );
    assert.equal(existsSync(value.globalNative), false);
    assert.deepEqual(readFileSync(value.settings), beforeSettings);
  }
});

test("apply combined with preview or dry-run is rejected before any write", () => {
  for (const previewFlag of ["--preview", "--dry-run"]) {
    const value = fixture();
    removePlaceholder(join(value.agent, ".keep"));
    writeLegacySettings(value.settings);
    writeLegacy(value.globalLegacy);
    const result = runDefaults(value, [
      "--apply",
      previewFlag,
      "--acknowledge-unverified-mcp-configs",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /cannot be combined/);
    assert.equal(existsSync(value.globalNative), false);
    assert.match(readFileSync(value.settings, "utf8"), /2\.36\.0/);
  }
});

test("unknown options and planning failures are nonzero and do not echo arguments", () => {
  const value = fixture();
  removePlaceholder(join(value.agent, ".keep"));
  writeLegacySettings(value.settings);
  writeLegacy(value.globalLegacy);
  const sentinel = "unknown-option-secret";
  const unknown = runDefaults(value, [`--not-real=${sentinel}`]);
  assert.notEqual(unknown.status, 0);
  assert.doesNotMatch(`${unknown.stdout}${unknown.stderr}`, new RegExp(sentinel));
  assert.match(`${unknown.stdout}${unknown.stderr}`, /Unknown migrate-mcp option/);

  const planned = runMcpAdapterMigration({
    settingsPath: value.settings,
    defaultExtensionsPath: join(value.directory, "missing-default-extensions.json"),
  });
  assert.equal(planned.exitCode, 1);
  assert.match(planned.output, /could not be safely planned/);
});

test("hardlinked sources, symlinked project profiles, dangling targets, and unsafe identical targets refuse", () => {
  const hardlinked = fixture();
  removePlaceholder(join(hardlinked.agent, ".keep"));
  writeLegacySettings(hardlinked.settings);
  writeLegacy(hardlinked.globalLegacy);
  linkSync(hardlinked.globalLegacy, join(hardlinked.directory, "source-alias.json"));
  let result = runDefaults(hardlinked, ["--apply", "--acknowledge-unverified-mcp-configs"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /source-aliased/);
  assert.equal(existsSync(hardlinked.globalNative), false);

  const symlinkedPi = fixture();
  removePlaceholder(join(symlinkedPi.agent, ".keep"));
  writeLegacySettings(symlinkedPi.settings);
  const outsidePi = join(symlinkedPi.directory, "outside-pi");
  mkdirSync(outsidePi);
  writeLegacy(join(outsidePi, "mcp.json"));
  rmSync(symlinkedPi.projectPi, { recursive: true, force: true });
  symlinkSync(outsidePi, symlinkedPi.projectPi);
  result = runDefaults(symlinkedPi, [
    "--project",
    symlinkedPi.project,
    "--apply",
    "--acknowledge-unverified-mcp-configs",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /unsafe-path|unsafe-access/);
  assert.equal(existsSync(symlinkedPi.projectNative), false);

  const danglingTarget = fixture();
  removePlaceholder(join(danglingTarget.agent, ".keep"));
  writeLegacySettings(danglingTarget.settings);
  writeLegacy(danglingTarget.globalLegacy);
  symlinkSync(join(danglingTarget.directory, "missing-target"), danglingTarget.globalNative);
  result = runDefaults(danglingTarget, ["--apply", "--acknowledge-unverified-mcp-configs"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /unsafe-path|target-unsafe/);
  assert.equal(lstatSync(danglingTarget.globalNative).isSymbolicLink(), true);
});

test("unsafe identical targets and group-writable sources or directories are refused", () => {
  const identical = fixture();
  removePlaceholder(join(identical.agent, ".keep"));
  writeLegacySettings(identical.settings);
  writeLegacy(identical.globalLegacy);
  const body = readFileSync(identical.globalLegacy);
  writeFileSync(identical.globalNative, body);
  chmodSync(identical.globalNative, 0o666);
  let result = runDefaults(identical, ["--apply", "--acknowledge-unverified-mcp-configs"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /unsafe-access/);
  assert.match(readFileSync(identical.settings, "utf8"), /2\.36\.0/);

  const source = fixture();
  removePlaceholder(join(source.agent, ".keep"));
  writeLegacySettings(source.settings);
  writeLegacy(source.globalLegacy);
  chmodSync(source.globalLegacy, 0o660);
  result = runDefaults(source, ["--apply", "--acknowledge-unverified-mcp-configs"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /unsafe-access/);
  assert.equal(existsSync(source.globalNative), false);

  const directory = fixture();
  removePlaceholder(join(directory.agent, ".keep"));
  writeLegacySettings(directory.settings);
  writeLegacy(directory.globalLegacy);
  chmodSync(directory.agent, 0o777);
  result = runDefaults(directory, ["--apply", "--acknowledge-unverified-mcp-configs"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /unsafe-access/);
  assert.equal(existsSync(directory.globalNative), false);
});

test("global and project source aliases block all writes", () => {
  const value = fixture();
  removePlaceholder(join(value.agent, ".keep"));
  writeLegacySettings(value.settings);
  writeLegacy(value.globalLegacy);
  linkSync(value.globalLegacy, value.projectLegacy);
  const result = runDefaults(value, [
    "--project",
    value.project,
    "--apply",
    "--acknowledge-unverified-mcp-configs",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /source-aliased/);
  assert.equal(existsSync(value.globalNative), false);
  assert.equal(existsSync(value.projectNative), false);
});

test("disabled, custom, ambiguous, and native-intent selections refuse for the intended reason", () => {
  const canonical = "npm:@diegopetrucci/pi-mcp-adapter@2.36.0";
  const provenance = {
    defaultExtensionProvenance: { managedPackageIdentities: [canonicalMcpIdentity] },
  };
  const settingsVariants = [
    {
      settings: {
        packages: [canonical],
        tlh: { disabledDefaultExtensions: ["mcporter"], ...provenance },
      },
      reason: /adapter-disabled/,
    },
    {
      settings: {
        packages: [{ source: canonical, extensions: ["-mcporter"] }],
        tlh: provenance,
      },
      reason: /adapter-disabled/,
    },
    {
      settings: {
        packages: [{ source: canonical, autoload: false }],
        tlh: provenance,
      },
      reason: /adapter-disabled/,
    },
    {
      settings: { packages: [canonical] },
      reason: /unmanaged-adapter-selection/,
    },
    {
      settings: { packages: ["npm:@custom/pi-mcp-adapter@2.0.0"] },
      reason: /unmanaged-adapter-selection/,
    },
    {
      settings: {
        packages: [canonical, "npm:pi-mcp-adapter@2.36.0"],
        tlh: provenance,
      },
      reason: /adapter-selection-ambiguous/,
    },
    {
      settings: { packages: ["npm:@diegopetrucci/pi-mcp-adapter@^5.0.0"] },
      reason: /adapter-version-unknown/,
    },
    {
      settings: { packages: ["npm:@diegopetrucci/pi-mcp-adapter@5.0.0"] },
      reason: /unmanaged-adapter-selection/,
    },
  ];
  for (const variant of settingsVariants) {
    const value = fixture();
    removePlaceholder(join(value.agent, ".keep"));
    writeFileSync(value.settings, `${JSON.stringify(variant.settings)}\n`);
    const beforeSettings = readFileSync(value.settings);
    writeLegacy(value.globalLegacy);
    const result = runDefaults(value, ["--apply", "--acknowledge-unverified-mcp-configs"]);
    assert.notEqual(result.status, 0, JSON.stringify(variant.settings));
    assert.match(result.stdout, variant.reason);
    assert.equal(existsSync(value.globalNative), false);
    assert.deepEqual(readFileSync(value.settings), beforeSettings);
  }
});

test("installed native metadata conflicts and unsafe profile layers block migration", () => {
  const conflict = fixture();
  removePlaceholder(join(conflict.agent, ".keep"));
  writeLegacySettings(conflict.settings);
  writeLegacy(conflict.globalLegacy);
  const metadataDir = join(
    conflict.agent,
    "npm",
    "node_modules",
    "@diegopetrucci",
    "pi-mcp-adapter",
  );
  mkdirSync(metadataDir, { recursive: true });
  writeFileSync(
    join(metadataDir, "package.json"),
    JSON.stringify({ name: "@diegopetrucci/pi-mcp-adapter", version: "5.0.0" }),
  );
  let result = runDefaults(conflict, ["--apply", "--acknowledge-unverified-mcp-configs"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /installed-metadata-conflict/);
  assert.equal(existsSync(conflict.globalNative), false);

  const profile = fixture();
  removePlaceholder(join(profile.agent, ".keep"));
  writeFileSync(
    profile.settings,
    JSON.stringify({ packages: ["npm:@diegopetrucci/pi-mcp-adapter@5.0.0"] }) + "\n",
  );
  writeLegacy(profile.projectLegacy);
  result = runDefaults(profile, [
    "--project",
    profile.project,
    "--apply",
    "--acknowledge-unverified-mcp-configs",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /unmanaged-adapter-selection/);
  assert.equal(existsSync(profile.projectNative), false);
});

test("managed provenance and object fields survive while unmarked builtin exclusions remain unmarked", () => {
  const value = fixture();
  removePlaceholder(join(value.agent, ".keep"));
  const legacy = "npm:@diegopetrucci/pi-mcp-adapter@2.36.0";
  writeFileSync(
    value.settings,
    `${JSON.stringify({
      packages: [{ source: legacy, customField: { keep: true } }],
      extensions: ["-builtin:mcp", "user-extension"],
      tlh: {
        defaultExtensionProvenance: {
          managedPackageIdentities: ["npm:@diegopetrucci/pi-mcp-adapter"],
        },
      },
    })}\n`,
  );
  writeLegacy(value.globalLegacy);
  const result = runDefaults(value, ["--apply", "--acknowledge-unverified-mcp-configs"]);
  assert.equal(result.status, 0, result.stderr);
  const settings = JSON.parse(readFileSync(value.settings, "utf8"));
  assert.equal(settings.packages[0].source, "npm:@diegopetrucci/pi-mcp-adapter@5.0.0");
  assert.deepEqual(settings.packages[0].customField, { keep: true });
  assert.deepEqual(settings.extensions, ["-builtin:mcp", "user-extension"]);
  assert.equal(Object.hasOwn(settings.tlh, "builtinMcpExclusionManaged"), false);
  assert.ok(
    settings.tlh.defaultExtensionProvenance.managedPackageIdentities.includes(
      "npm:@diegopetrucci/pi-mcp-adapter",
    ),
  );
});

test("distinct profile and project adapter identities, and blocked projects, prevent global or project writes", () => {
  const distinct = fixture();
  removePlaceholder(join(distinct.agent, ".keep"));
  writeLegacySettings(distinct.settings);
  writeFileSync(
    join(distinct.projectPi, "settings.json"),
    JSON.stringify({ packages: ["npm:pi-mcp-adapter@2.36.0"] }) + "\n",
  );
  writeLegacy(distinct.projectLegacy);
  let result = runDefaults(distinct, [
    "--project",
    distinct.project,
    "--apply",
    "--acknowledge-unverified-mcp-configs",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /adapter-selection-ambiguous/);
  assert.equal(existsSync(distinct.globalNative), false);
  assert.equal(existsSync(distinct.projectNative), false);

  const blocked = fixture();
  removePlaceholder(join(blocked.agent, ".keep"));
  writeLegacySettings(blocked.settings);
  writeLegacy(blocked.globalLegacy);
  writeLegacy(blocked.projectLegacy, '{"mcpServers":{"docs":{"enabled":true}}}');
  result = runDefaults(blocked, [
    "--project",
    blocked.project,
    "--apply",
    "--acknowledge-unverified-mcp-configs",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /config-native-field/);
  assert.equal(existsSync(blocked.globalNative), false);
  assert.equal(existsSync(blocked.projectNative), false);
  assert.match(readFileSync(blocked.settings, "utf8"), /2\.36\.0/);
});

test("custom adapter sources cannot coexist with an eligible selection, while unrelated packages remain allowed", () => {
  const canonical = "npm:@diegopetrucci/pi-mcp-adapter@2.36.0";
  const provenance = {
    defaultExtensionProvenance: { managedPackageIdentities: [canonicalMcpIdentity] },
  };
  const custom = "npm:@custom/pi-mcp-adapter@2.0.0";

  const profile = fixture();
  removePlaceholder(join(profile.agent, ".keep"));
  writeFileSync(
    profile.settings,
    `${JSON.stringify({ packages: [canonical, custom], tlh: provenance })}\n`,
  );
  writeLegacy(profile.globalLegacy);
  let result = runDefaults(profile, ["--apply", "--acknowledge-unverified-mcp-configs"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /adapter-selection-ambiguous/);
  assert.equal(existsSync(profile.globalNative), false);

  const project = fixture();
  removePlaceholder(join(project.agent, ".keep"));
  writeLegacySettings(project.settings);
  const projectSettings = join(project.projectPi, "settings.json");
  writeFileSync(
    projectSettings,
    `${JSON.stringify({ packages: [canonical, custom], tlh: provenance })}\n`,
  );
  writeLegacy(project.globalLegacy);
  writeLegacy(project.projectLegacy);
  result = runDefaults(project, [
    "--project",
    project.project,
    "--apply",
    "--acknowledge-unverified-mcp-configs",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /adapter-selection-ambiguous/);
  assert.equal(existsSync(project.globalNative), false);
  assert.equal(existsSync(project.projectNative), false);

  const unrelated = fixture();
  removePlaceholder(join(unrelated.agent, ".keep"));
  writeFileSync(
    unrelated.settings,
    `${JSON.stringify({ packages: [canonical, "npm:some-mcp-tool@1.0.0"], tlh: provenance })}\n`,
  );
  writeLegacy(unrelated.globalLegacy);
  result = runDefaults(unrelated, ["--apply", "--acknowledge-unverified-mcp-configs"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(unrelated.globalNative), true);
});

test("discovered ancestors are manual-only while explicitly selected ancestors can migrate", () => {
  const value = fixture();
  removePlaceholder(join(value.agent, ".keep"));
  writeLegacySettings(value.settings);
  const ancestor = value.directory;
  const ancestorPi = join(ancestor, ".pi");
  mkdirSync(ancestorPi, { recursive: true });
  writeLegacy(join(ancestorPi, "mcp.json"));
  writeLegacy(value.projectLegacy);
  let result = runDefaults(value, [
    "--project",
    value.project,
    "--apply",
    "--acknowledge-unverified-mcp-configs",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ancestor-manual-only/);
  assert.equal(existsSync(join(ancestorPi, "mcp-adapter.json")), false);
  assert.equal(existsSync(value.projectNative), true);

  const explicit = fixture();
  removePlaceholder(join(explicit.agent, ".keep"));
  writeLegacySettings(explicit.settings);
  const explicitAncestor = explicit.directory;
  const explicitPi = join(explicitAncestor, ".pi");
  mkdirSync(explicitPi, { recursive: true });
  writeLegacy(join(explicitPi, "mcp.json"));
  result = runDefaults(explicit, [
    "--project",
    explicitAncestor,
    "--apply",
    "--acknowledge-unverified-mcp-configs",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(explicitPi, "mcp-adapter.json")), true);
});

test("post-write failures roll back, while concurrent settings or copy edits retain required artifacts", () => {
  const postWrite = fixture();
  removePlaceholder(join(postWrite.agent, ".keep"));
  writeLegacySettings(postWrite.settings);
  writeLegacy(postWrite.globalLegacy);
  let result = runMcpAdapterMigration({
    settingsPath: postWrite.settings,
    defaultExtensionsPath: defaultExtensions,
    apply: true,
    acknowledgeUnverifiedMcpConfigs: true,
    homeDir: postWrite.home,
    hooks: {
      afterSettings: () => {
        throw new Error("post-write failure");
      },
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(existsSync(postWrite.globalNative), false);
  assert.match(readFileSync(postWrite.settings, "utf8"), /2\.36\.0/);
  assert.match(result.output, /rolled back/);

  const concurrentSettings = fixture();
  removePlaceholder(join(concurrentSettings.agent, ".keep"));
  writeLegacySettings(concurrentSettings.settings);
  writeLegacy(concurrentSettings.globalLegacy);
  result = runMcpAdapterMigration({
    settingsPath: concurrentSettings.settings,
    defaultExtensionsPath: defaultExtensions,
    apply: true,
    acknowledgeUnverifiedMcpConfigs: true,
    homeDir: concurrentSettings.home,
    hooks: {
      afterSettings: (settingsPath) => {
        writeFileSync(
          settingsPath,
          JSON.stringify({ packages: ["npm:helper"], concurrent: true }) + "\n",
        );
      },
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(existsSync(concurrentSettings.globalNative), true);
  assert.match(readFileSync(concurrentSettings.settings, "utf8"), /concurrent/);
  assert.match(result.output, /retained|could not be fully verified/);

  const concurrentCopy = fixture();
  removePlaceholder(join(concurrentCopy.agent, ".keep"));
  writeLegacySettings(concurrentCopy.settings);
  writeLegacy(concurrentCopy.globalLegacy);
  result = runMcpAdapterMigration({
    settingsPath: concurrentCopy.settings,
    defaultExtensionsPath: defaultExtensions,
    apply: true,
    acknowledgeUnverifiedMcpConfigs: true,
    homeDir: concurrentCopy.home,
    hooks: {
      afterCopy: (_sourcePath, targetPath) => writeFileSync(targetPath, "concurrent-copy-edit\n"),
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(readFileSync(concurrentCopy.globalNative, "utf8"), "concurrent-copy-edit\n");
  assert.match(result.output, /retained|could not be fully verified/);
});

test("successful multi-settings commit reaches and verifies both AFTER writes", () => {
  const value = fixture();
  removePlaceholder(join(value.agent, ".keep"));
  writeLegacySettings(value.settings);
  const projectSettings = join(value.projectPi, "settings.json");
  writeLegacySettings(projectSettings);
  writeLegacy(value.globalLegacy);
  writeLegacy(value.projectLegacy);
  const writes = [];
  const result = runMcpAdapterMigration({
    settingsPath: value.settings,
    defaultExtensionsPath: defaultExtensions,
    projectDirs: [value.project],
    apply: true,
    acknowledgeUnverifiedMcpConfigs: true,
    homeDir: value.home,
    hooks: {
      afterSettings: (settingsPath) => {
        writes.push({ path: settingsPath, bytes: readFileSync(settingsPath) });
      },
    },
  });
  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(
    writes.map((write) => write.path),
    [value.settings, projectSettings],
  );
  for (const write of writes) {
    assert.match(write.bytes.toString(), /5\.0\.0/);
    assert.match(write.bytes.toString(), /builtinMcpExclusionManaged/);
  }
  assert.equal(existsSync(value.globalNative), true);
  assert.equal(existsSync(value.projectNative), true);
});

test("two-settings rollback, linked-temp cleanup, and source-change races are conservative", () => {
  const twoSettings = fixture();
  removePlaceholder(join(twoSettings.agent, ".keep"));
  writeLegacySettings(twoSettings.settings);
  const projectSettings = join(twoSettings.projectPi, "settings.json");
  writeLegacySettings(projectSettings);
  writeLegacy(twoSettings.globalLegacy);
  writeLegacy(twoSettings.projectLegacy);
  const settingsBefore = readFileSync(twoSettings.settings);
  const projectSettingsBefore = readFileSync(projectSettings);
  const globalLegacyBefore = readFileSync(twoSettings.globalLegacy);
  const projectLegacyBefore = readFileSync(twoSettings.projectLegacy);
  const rollbackWrites = [];
  let result = runMcpAdapterMigration({
    settingsPath: twoSettings.settings,
    defaultExtensionsPath: defaultExtensions,
    projectDirs: [twoSettings.project],
    apply: true,
    acknowledgeUnverifiedMcpConfigs: true,
    homeDir: twoSettings.home,
    hooks: {
      afterSettings: (settingsPath) => {
        rollbackWrites.push({ path: settingsPath, bytes: readFileSync(settingsPath) });
        if (settingsPath === projectSettings) throw new Error("second settings failure");
      },
    },
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(
    rollbackWrites.map((write) => write.path),
    [twoSettings.settings, projectSettings],
  );
  assert.match(rollbackWrites[0].bytes.toString(), /5\.0\.0/);
  assert.match(rollbackWrites[1].bytes.toString(), /5\.0\.0/);
  assert.equal(existsSync(twoSettings.globalNative), false);
  assert.equal(existsSync(twoSettings.projectNative), false);
  assert.deepEqual(readFileSync(twoSettings.settings), settingsBefore);
  assert.deepEqual(readFileSync(projectSettings), projectSettingsBefore);
  assert.deepEqual(readFileSync(twoSettings.globalLegacy), globalLegacyBefore);
  assert.deepEqual(readFileSync(twoSettings.projectLegacy), projectLegacyBefore);
  assert.match(readFileSync(twoSettings.settings, "utf8"), /2\.36\.0/);
  assert.match(readFileSync(projectSettings, "utf8"), /2\.36\.0/);

  const linkFailure = fixture();
  removePlaceholder(join(linkFailure.agent, ".keep"));
  writeLegacySettings(linkFailure.settings);
  writeLegacy(linkFailure.globalLegacy);
  result = runMcpAdapterMigration({
    settingsPath: linkFailure.settings,
    defaultExtensionsPath: defaultExtensions,
    apply: true,
    acknowledgeUnverifiedMcpConfigs: true,
    homeDir: linkFailure.home,
    hooks: {
      afterTargetLink: () => {
        throw new Error("link cleanup failure");
      },
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(existsSync(linkFailure.globalNative), false);
  assert.match(readFileSync(linkFailure.settings, "utf8"), /2\.36\.0/);

  const sourceRace = fixture();
  removePlaceholder(join(sourceRace.agent, ".keep"));
  writeLegacySettings(sourceRace.settings);
  writeLegacy(sourceRace.globalLegacy);
  result = runMcpAdapterMigration({
    settingsPath: sourceRace.settings,
    defaultExtensionsPath: defaultExtensions,
    apply: true,
    acknowledgeUnverifiedMcpConfigs: true,
    homeDir: sourceRace.home,
    hooks: { afterCopy: (sourcePath) => appendFileSync(sourcePath, "race\n") },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(existsSync(sourceRace.globalNative), false);
  assert.match(readFileSync(sourceRace.settings, "utf8"), /2\.36\.0/);
});

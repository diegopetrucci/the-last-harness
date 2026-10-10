import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

import { runMcpAdapterMigration } from "../scripts/lib/mcp-adapter-migration.mjs";
import {
  cleanupPublishedLoaders,
  ensurePublishedLoaders,
  normalizeFixturePaths,
  runLoaderChild,
} from "./support/mcp-adapter-migration-compat-runner.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const defaultExtensionsPath = join(repoRoot, "config", "default-extensions.json");
const temporaryDirectories = [];

function makeFixture(label) {
  const root = resolve(mkdtempSync(join(tmpdir(), `tlh-mcp-compat-${label}-`)));
  const home = join(root, "home");
  const workspace = join(home, "workspace");
  const project = join(workspace, "projects", "current");
  const agent = join(root, "agent");
  for (const path of [
    home,
    workspace,
    project,
    join(project, ".pi"),
    agent,
    join(home, ".agents"),
    join(root, "oauth"),
    join(root, "tmp"),
    join(root, "xdg", "config"),
    join(root, "xdg", "cache"),
    join(root, "xdg", "data"),
    join(root, "xdg", "state"),
  ]) {
    mkdirSync(path, { recursive: true });
  }
  temporaryDirectories.push(root);
  return {
    root,
    home,
    workspace,
    project,
    agent,
    settings: join(agent, "settings.json"),
    globalLegacy: join(agent, "mcp.json"),
    globalAdapter: join(agent, "mcp-adapter.json"),
    projectLegacy: join(project, ".pi", "mcp.json"),
    projectAdapter: join(project, ".pi", "mcp-adapter.json"),
    projectShared: join(project, ".mcp.json"),
    globalShared: join(home, ".config", "mcp", "mcp.json"),
    ancestorShared: join(workspace, ".mcp.json"),
    ancestorPi: join(workspace, ".pi", "mcp-adapter.json"),
    ancestorLegacyPi: join(workspace, ".pi", "mcp.json"),
  };
}

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  cleanupPublishedLoaders();
});

function writeText(path, value) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, value, "utf8");
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function adapterPaths(fixture, mode) {
  return mode === "legacy"
    ? {
        global: fixture.globalLegacy,
        project: fixture.projectLegacy,
        ancestor: fixture.ancestorLegacyPi,
      }
    : {
        global: fixture.globalAdapter,
        project: fixture.projectAdapter,
        ancestor: fixture.ancestorPi,
      };
}

function writeAdapterLayout(fixture, mode, globalBody, projectBody) {
  const paths = adapterPaths(fixture, mode);
  writeText(paths.global, globalBody);
  writeText(paths.project, projectBody);
  writeJson(join(fixture.home, ".agents", "mcp.json"), {
    mcpServers: {
      imported: {
        command: "fixture-imported-command",
        args: ["--imported"],
        disabled: true,
        directTools: true,
      },
    },
  });
  writeJson(fixture.ancestorShared, {
    mcpServers: {
      ancestor: { command: "fixture-ancestor-command", args: ["--shared"] },
    },
  });
  mkdirSync(resolve(fixture.ancestorPi, ".."), { recursive: true });
  writeJson(paths.ancestor, {
    mcpServers: {
      "ancestor-pi": {
        command: "fixture-ancestor-pi-command",
        lifecycle: { restartOnExit: true },
      },
    },
  });
}

function supportedGlobalBody(fixture) {
  return `{
  // JSONC comments and trailing commas are part of the preserved input.
  "imports": ["agents",],
  "settings": {
    "hostConfigDiscovery": "off",
    "ancestorConfigRoots": [${JSON.stringify(fixture.workspace)}],
  },
  "claudePlugins": [],
  "mcpServers": {
    "shared": {
      "url": "https://fixture.invalid/shared",
      "auth": "oauth",
      "oauth": {"clientId": "fixture-client", "scope": "fixture:read"},
      "headers": {"X-Fixture": "fixture-header"},
      "bearerToken": "fixture-bearer",
      "bearerTokenEnv": "FIXTURE_BEARER",
      "bearerTokenStore": "fixture-store",
      "requestHeadersCommand": "fixture-header-command",
      "caFile": "fixture-ca.pem",
      "disabled": true,
      "directTools": ["read"],
      "toolPrefix": "alias",
      "includeTools": ["read"],
      "excludeTools": ["write"],
      "searchKeywords": ["docs"],
      "approveTools": ["danger"],
      "trace": true,
      "lifecycle": {"restartOnExit": true, "maxRestarts": 2},
      "idleTimeout": 100,
      "requestTimeoutMs": 2500,
      "exposeResources": true,
      "debug": true,
      "protocolVersion": "2025-06-18",
      "tasks": {"enabled": true},
      "aliases": ["docs-alias"],
    },
    "local": {
      "command": "fixture-local-command",
      "args": ["--fixture"],
      "env": {"FIXTURE_ENV": "fixture-value"},
      "cwd": "./fixture-commands",
      "disabled": false,
      "includeTools": ["local/read"],
      "approveTools": ["local/write"],
      "lifecycle": {"restartOnExit": false},
    },
  },
}\n`;
}

function supportedProjectBody() {
  return `{
  "mcpServers": {
    "shared": {
      "disabled": false,
      "includeTools": ["project-read"],
      "approveTools": ["project-write"],
    },
    "project-only": {
      "command": "fixture-project-command",
      "args": ["--project"],
      "directTools": true,
    },
  },
}\n`;
}

function loaderConfig(result, fixture) {
  return normalizeFixturePaths(result.config, fixture.root);
}

function loaderDiscovery(result, fixture) {
  return normalizeFixturePaths(result.discovery, fixture.root);
}

test("actual 2.36.0 and 5.0.0 loaders preserve adapter config, imports, inheritance, and ancestors", (t) => {
  const published = ensurePublishedLoaders();
  const sourceEvidence = readFileSync(published.loaders["5.0.0"].sourceEvidencePath, "utf8");
  assert.match(
    sourceEvidence,
    /setPiMcpConfigEnabled\(typeof pi\.registerMcpServer === "function"\)/u,
  );

  const legacy = makeFixture("legacy-loader");
  const native = makeFixture("native-loader");
  writeAdapterLayout(legacy, "legacy", supportedGlobalBody(legacy), supportedProjectBody());
  writeAdapterLayout(native, "adapter", supportedGlobalBody(native), supportedProjectBody());
  writeFileSync(native.globalLegacy, readFileSync(native.globalAdapter));
  writeFileSync(native.projectLegacy, readFileSync(native.projectAdapter));
  assert.deepEqual(readFileSync(native.globalLegacy), readFileSync(native.globalAdapter));
  assert.deepEqual(readFileSync(native.projectLegacy), readFileSync(native.projectAdapter));

  const legacyResult = runLoaderChild({
    loaderPath: published.loaders["2.36.0"].configPath,
    fixtureRoot: legacy.root,
    cwd: legacy.project,
    nativeEnabled: false,
  });
  const nativeResult = runLoaderChild({
    loaderPath: published.loaders["5.0.0"].configPath,
    fixtureRoot: native.root,
    cwd: native.project,
    nativeEnabled: true,
  });

  assert.deepEqual(loaderConfig(nativeResult, native), loaderConfig(legacyResult, legacy));
  const config = loaderConfig(nativeResult, native);
  assert.deepEqual(config.settings.ancestorConfigRoots, ["<fixture>/home/workspace"]);
  assert.equal(config.mcpServers.shared.disabled, false);
  assert.deepEqual(config.mcpServers.shared.includeTools, ["project-read"]);
  assert.deepEqual(config.mcpServers.shared.approveTools, ["project-write"]);
  assert.equal(config.mcpServers.shared.bearerToken, "fixture-bearer");
  assert.deepEqual(config.mcpServers.imported, {
    command: "fixture-imported-command",
    args: ["--imported"],
    disabled: true,
    directTools: true,
  });
  assert.equal(config.mcpServers.ancestor.command, "fixture-ancestor-command");
  assert.equal(config.mcpServers["ancestor-pi"].lifecycle.restartOnExit, true);
  assert.equal(nativeResult.nativeEnabled, true);
  assert.equal(legacyResult.nativeEnabled, false);
  assert.equal(published.artifacts.length, 2);
  assert.equal(published.artifacts[0].version, "2.36.0");
  assert.equal(published.artifacts[1].version, "5.0.0");

  const discovery = loaderDiscovery(nativeResult, native);
  assert.ok(discovery.some((entry) => entry.path === "<fixture>/agent/mcp-adapter.json"));
  assert.ok(
    discovery.some(
      (entry) => entry.path === "<fixture>/home/workspace/projects/current/.pi/mcp-adapter.json",
    ),
  );
  t.diagnostic(
    `released-loader-integrity: ${published.artifacts.map((entry) => `${entry.version}=${entry.integrity}`).join(", ")}; ` +
      "coverage=adapter controls, disabled/direct/filter/approval/lifecycle/bearer/OAuth, imports, JSONC, global inheritance, and selected ancestors",
  );
});

function nativeSplitGlobalBody(fixture) {
  return `{
  "settings": {
    "hostConfigDiscovery": "off",
    "ancestorConfigRoots": [${JSON.stringify(fixture.workspace)}],
  },
  "imports": ["agents"],
  "mcpServers": {
    "native-direct": {
      "command": "fixture-native-command",
      "args": ["--native"],
      "env": {"FIXTURE_NATIVE": "yes"},
      "exposure": "direct",
      "toolExposure": {"danger": "hidden"},
      "enabled": false,
      "timeout": 4,
    },
    "native-http": {
      "url": "https://fixture.invalid/native",
      "headers": {"X-Native": "native-header"},
      "oauth": {"clientId": "fixture-native-client", "callbackPort": 4321},
    },
  },
}\n`;
}

function nativeSplitProjectBody() {
  return `{
  "mcpServers": {
    "native-direct": {
      "command": "fixture-project-native-command",
      "args": ["--project-native"],
      "env": {"FIXTURE_NATIVE": "yes"},
      "exposure": "deferred",
      "toolExposure": {"danger": "hidden"},
      "enabled": false,
      "timeout": 2,
    },
  },
}\n`;
}

function nativeSplitAdapterBody(fixture) {
  return `{
  "settings": {
    "hostConfigDiscovery": "off",
    "ancestorConfigRoots": [${JSON.stringify(fixture.workspace)}],
  },
  "imports": ["agents"],
}\n`;
}

function nativeSplitLegacyBody(fixture) {
  return `{
  "settings": {
    "hostConfigDiscovery": "off",
    "ancestorConfigRoots": [${JSON.stringify(fixture.workspace)}],
  },
  "imports": ["agents"],
  "mcpServers": {
    "native-direct": {
      "command": "fixture-native-command",
      "args": ["--native"],
      "env": {"FIXTURE_NATIVE": "yes"},
      "directTools": true,
      "excludeTools": ["danger"],
      "disabled": true,
      "requestTimeoutMs": 4000,
    },
    "native-http": {
      "url": "https://fixture.invalid/native",
      "headers": {"X-Native": "native-header"},
      "oauth": {"clientId": "fixture-native-client", "redirectUri": "http://127.0.0.1:4321/callback"},
    },
  },
}\n`;
}

function nativeSplitLegacyProjectBody() {
  return `{
  "mcpServers": {
    "native-direct": {
      "command": "fixture-project-native-command",
      "args": ["--project-native"],
      "directTools": "search",
      "requestTimeoutMs": 2000,
    },
  },
}\n`;
}

test("Pi 1.0.3 native enable translates native files without losing supported effective fields", () => {
  const published = ensurePublishedLoaders();
  const legacy = makeFixture("legacy-native-split");
  const native = makeFixture("native-native-split");
  writeAdapterLayout(
    legacy,
    "legacy",
    nativeSplitLegacyBody(legacy),
    nativeSplitLegacyProjectBody(),
  );
  writeText(legacy.globalLegacy, nativeSplitLegacyBody(legacy));
  writeText(legacy.projectLegacy, nativeSplitLegacyProjectBody());

  writeAdapterLayout(native, "adapter", nativeSplitAdapterBody(native), "{}\n");
  writeText(native.globalLegacy, nativeSplitGlobalBody(native));
  writeText(native.projectLegacy, nativeSplitProjectBody());

  const legacyResult = runLoaderChild({
    loaderPath: published.loaders["2.36.0"].configPath,
    fixtureRoot: legacy.root,
    cwd: legacy.project,
    nativeEnabled: false,
  });
  const nativeResult = runLoaderChild({
    loaderPath: published.loaders["5.0.0"].configPath,
    fixtureRoot: native.root,
    cwd: native.project,
    nativeEnabled: true,
  });
  assert.deepEqual(loaderConfig(nativeResult, native), loaderConfig(legacyResult, legacy));
  const config = loaderConfig(nativeResult, native);
  assert.deepEqual(config.mcpServers["native-direct"].args, ["--project-native"]);
  assert.deepEqual(config.mcpServers["native-direct"].env, { FIXTURE_NATIVE: "yes" });
  assert.equal(config.mcpServers["native-direct"].disabled, true);
  assert.equal(config.mcpServers["native-direct"].directTools, "search");
  assert.equal(config.mcpServers["native-direct"].requestTimeoutMs, 2000);
  assert.deepEqual(config.mcpServers.imported.args, ["--imported"]);
  assert.equal(config.mcpServers.imported.disabled, true);
  assert.equal(config.mcpServers.imported.directTools, true);
  assert.equal(config.mcpServers.ancestor.command, "fixture-ancestor-command");
  assert.equal(config.mcpServers["ancestor-pi"].lifecycle.restartOnExit, true);
  assert.deepEqual(config.settings.ancestorConfigRoots, ["<fixture>/home/workspace"]);
  assert.equal(
    config.mcpServers["native-http"].oauth.redirectUri,
    "http://127.0.0.1:4321/callback",
  );
  assert.equal(nativeResult.nativeEnabled, true);

  const legacyGlobalOnly = makeFixture("legacy-native-split-global-only");
  const nativeGlobalOnly = makeFixture("native-native-split-global-only");
  writeAdapterLayout(legacyGlobalOnly, "legacy", nativeSplitLegacyBody(legacyGlobalOnly), "{}\n");
  rmSync(legacyGlobalOnly.projectLegacy, { force: true });
  writeAdapterLayout(nativeGlobalOnly, "adapter", nativeSplitAdapterBody(nativeGlobalOnly), "{}\n");
  rmSync(nativeGlobalOnly.projectAdapter, { force: true });
  writeText(nativeGlobalOnly.globalLegacy, nativeSplitGlobalBody(nativeGlobalOnly));

  const legacyGlobalResult = runLoaderChild({
    loaderPath: published.loaders["2.36.0"].configPath,
    fixtureRoot: legacyGlobalOnly.root,
    cwd: legacyGlobalOnly.home,
    nativeEnabled: false,
  });
  const nativeGlobalResult = runLoaderChild({
    loaderPath: published.loaders["5.0.0"].configPath,
    fixtureRoot: nativeGlobalOnly.root,
    cwd: nativeGlobalOnly.home,
    nativeEnabled: true,
  });
  assert.deepEqual(
    loaderConfig(nativeGlobalResult, nativeGlobalOnly),
    loaderConfig(legacyGlobalResult, legacyGlobalOnly),
  );
  const globalConfig = loaderConfig(nativeGlobalResult, nativeGlobalOnly);
  assert.equal(globalConfig.mcpServers["native-direct"].directTools, true);
  assert.equal(globalConfig.mcpServers["native-direct"].requestTimeoutMs, 4000);
});

function naiveEntryBody() {
  return `{
  "mcpServers": {
    "adapter-controls": {
      "command": "fixture-naive-command",
      "args": ["--naive"],
      "directTools": true,
      "includeTools": ["read"],
      "approveTools": ["write"],
      "lifecycle": {"restartOnExit": true},
      "bearerToken": "fixture-bearer",
      "disabled": true,
    },
  },
}\n`;
}

test("counterexample proves a naive v5 native-file upgrade loses adapter fields", () => {
  const published = ensurePublishedLoaders();
  const legacy = makeFixture("legacy-naive");
  const naive = makeFixture("naive-native");
  writeText(legacy.globalLegacy, naiveEntryBody());
  writeText(naive.globalLegacy, naiveEntryBody());
  const legacyResult = runLoaderChild({
    loaderPath: published.loaders["2.36.0"].configPath,
    fixtureRoot: legacy.root,
    cwd: legacy.project,
    nativeEnabled: false,
  });
  const naiveResult = runLoaderChild({
    loaderPath: published.loaders["5.0.0"].configPath,
    fixtureRoot: naive.root,
    cwd: naive.project,
    nativeEnabled: true,
  });
  const before = loaderConfig(legacyResult, legacy).mcpServers["adapter-controls"];
  const after = loaderConfig(naiveResult, naive).mcpServers["adapter-controls"];
  assert.equal(before.directTools, true);
  assert.equal(before.bearerToken, "fixture-bearer");
  assert.equal(after.command, "fixture-naive-command");
  assert.equal(Object.hasOwn(after, "directTools"), false);
  assert.equal(Object.hasOwn(after, "includeTools"), false);
  assert.equal(Object.hasOwn(after, "approveTools"), false);
  assert.equal(Object.hasOwn(after, "lifecycle"), false);
  assert.equal(Object.hasOwn(after, "bearerToken"), false);
  assert.match(naiveResult.notices.join("\n"), /Ignored|Skipped/u);
});

function writeUrlInheritanceFixture(fixture) {
  writeJson(fixture.globalShared, {
    mcpServers: {
      inherited: {
        url: "https://fixture.invalid/old",
        headers: { Authorization: "fixture-header" },
        bearerToken: "fixture-bearer",
        bearerTokenEnv: "FIXTURE_BEARER",
        oauth: { clientId: "fixture-client" },
        auth: { provider: "fixture-provider" },
      },
    },
  });
  writeJson(fixture.projectShared, {
    mcpServers: {
      inherited: { url: "https://fixture.invalid/new" },
    },
  });
}

test("released loaders retain URL-bound credential clearing differences as explicit security evidence", () => {
  const published = ensurePublishedLoaders();
  const legacy = makeFixture("legacy-url-auth");
  const native = makeFixture("native-url-auth");
  writeUrlInheritanceFixture(legacy);
  writeUrlInheritanceFixture(native);
  const legacyResult = runLoaderChild({
    loaderPath: published.loaders["2.36.0"].configPath,
    fixtureRoot: legacy.root,
    cwd: legacy.project,
    nativeEnabled: false,
  });
  const nativeResult = runLoaderChild({
    loaderPath: published.loaders["5.0.0"].configPath,
    fixtureRoot: native.root,
    cwd: native.project,
    nativeEnabled: true,
  });
  const oldEntry = loaderConfig(legacyResult, legacy).mcpServers.inherited;
  const newEntry = loaderConfig(nativeResult, native).mcpServers.inherited;
  assert.equal(oldEntry.url, "https://fixture.invalid/new");
  assert.equal(newEntry.url, "https://fixture.invalid/new");
  assert.equal(Object.hasOwn(oldEntry, "headers"), false);
  assert.equal(Object.hasOwn(oldEntry, "bearerToken"), false);
  assert.equal(Object.hasOwn(oldEntry, "oauth"), false);
  assert.deepEqual(oldEntry.auth, { provider: "fixture-provider" });
  assert.equal(Object.hasOwn(newEntry, "auth"), false);
  // 5.0.0's explicit object-auth clearing is a security/default difference;
  // this proof records it rather than normalizing the two released outputs.
});

function migrationFixture(label, body) {
  const fixture = makeFixture(label);
  const settings = {
    packages: ["npm:@diegopetrucci/pi-mcp-adapter@2.36.0"],
    owner: "fixture-owner",
    tlh: {
      defaultExtensionProvenance: {
        managedPackageIdentities: ["npm:@diegopetrucci/pi-mcp-adapter"],
      },
    },
  };
  writeJson(fixture.settings, settings);
  writeText(fixture.globalLegacy, body);
  return fixture;
}

function assertMigrationRefusal(fixture, reason, marker) {
  const beforeSettings = readFileSync(fixture.settings);
  const beforeLegacy = readFileSync(fixture.globalLegacy);
  const result = runMcpAdapterMigration({
    settingsPath: fixture.settings,
    defaultExtensionsPath,
    apply: true,
    acknowledgeUnverifiedMcpConfigs: true,
    homeDir: fixture.home,
  });
  assert.equal(result.exitCode, 1, result.output);
  assert.match(result.output, reason);
  assert.doesNotMatch(result.output, new RegExp(marker, "u"));
  assert.deepEqual(readFileSync(fixture.settings), beforeSettings);
  assert.deepEqual(readFileSync(fixture.globalLegacy), beforeLegacy);
  assert.equal(existsSync(fixture.globalAdapter), false);
}

test("unsafe native fields, dual transports, object auth, BOM, imports, and conflicts refuse before writes", () => {
  assertMigrationRefusal(
    migrationFixture(
      "refuse-native-field",
      '{"mcpServers":{"unsafe":{"command":"fixture-command","enabled":true,"marker":"fixture-native-marker"}}}\n',
    ),
    /config-native-field/u,
    "fixture-native-marker",
  );
  assertMigrationRefusal(
    migrationFixture(
      "refuse-dual-transport",
      '{"mcpServers":{"unsafe":{"command":"fixture-command","url":"https://fixture.invalid/dual","marker":"fixture-dual-marker"}}}\n',
    ),
    /config-command-and-url/u,
    "fixture-dual-marker",
  );
  assertMigrationRefusal(
    migrationFixture(
      "refuse-object-auth",
      '{"mcpServers":{"unsafe":{"url":"https://fixture.invalid/auth","auth":{"provider":"fixture-provider"},"marker":"fixture-auth-marker"}}}\n',
    ),
    /config-auth-object/u,
    "fixture-auth-marker",
  );
  assertMigrationRefusal(
    migrationFixture(
      "refuse-bom",
      '\uFEFF{"mcpServers":{"unsafe":{"command":"fixture-command","marker":"fixture-bom-marker"}}}\n',
    ),
    /config-bom/u,
    "fixture-bom-marker",
  );
  assertMigrationRefusal(
    migrationFixture(
      "refuse-imports",
      '{"imports":["agents"],"mcpServers":{"unsafe":{"command":"fixture-command","marker":"fixture-import-marker"}}}\n',
    ),
    /config-imported/u,
    "fixture-import-marker",
  );

  const conflict = migrationFixture(
    "refuse-conflict",
    '{"mcpServers":{"safe":{"command":"fixture-command"}}}\n',
  );
  writeText(conflict.globalAdapter, '{"different":true,"marker":"fixture-conflict-marker"}\n');
  const beforeSettings = readFileSync(conflict.settings);
  const beforeLegacy = readFileSync(conflict.globalLegacy);
  const result = runMcpAdapterMigration({
    settingsPath: conflict.settings,
    defaultExtensionsPath,
    apply: true,
    acknowledgeUnverifiedMcpConfigs: true,
    homeDir: conflict.home,
  });
  assert.equal(result.exitCode, 1, result.output);
  assert.match(result.output, /target-nonidentical/u);
  assert.doesNotMatch(result.output, /fixture-conflict-marker/u);
  assert.deepEqual(readFileSync(conflict.settings), beforeSettings);
  assert.deepEqual(readFileSync(conflict.globalLegacy), beforeLegacy);
  assert.equal(
    readFileSync(conflict.globalAdapter, "utf8"),
    '{"different":true,"marker":"fixture-conflict-marker"}\n',
  );
});

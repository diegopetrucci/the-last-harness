import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  TLH_SUBAGENT_PROMPTS,
  captureManagedRetiredSubagentPackages,
  captureRetiredSubagentNpmCommand,
  cleanupManagedRetiredSubagentPackages,
  copyTlhSubagentPrompts,
  findTlhSubagentsDir,
  managedRetiredSubagentPackages,
  migrateSubagentExtensionConfig,
  missingTlhSubagentPrompts,
  restoreNeededTlhSubagentPrompts,
} from "../scripts/lib/tlh-install-subagents.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

function tempFixture(t, prefix = "tlh-install-lib-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePromptSet(dir, label = "prompt") {
  mkdirSync(dir, { recursive: true });
  for (const prompt of TLH_SUBAGENT_PROMPTS) {
    writeFileSync(join(dir, prompt), `${label}:${prompt}\n`);
  }
}

test("subagent prompt discovery honors source precedence and copies prompt files safely", (t) => {
  const root = tempFixture(t);
  const agentDir = join(root, "agent");
  const localRepo = join(root, "local-repo");
  const localPrompts = join(localRepo, "agents", "subagents");
  const customPrompts = join(agentDir, "git", "github.com", "custom", "pkg", "agents", "subagents");
  const defaultPrompts = join(
    agentDir,
    "git",
    "github.com",
    "diegopetrucci",
    "the-last-harness",
    "agents",
    "subagents",
  );
  writePromptSet(localPrompts, "local");
  writePromptSet(customPrompts, "custom");
  writePromptSet(defaultPrompts, "default");

  const customConfig = {
    agentDir,
    repo: "diegopetrucci/the-last-harness",
    packageSource: "git:github.com/custom/pkg@main",
    packageSourceIsDefault: false,
    tmpDir: "",
  };
  assert.equal(findTlhSubagentsDir(customConfig, { localRepoDir: localRepo }), customPrompts);

  unlinkSync(join(customPrompts, TLH_SUBAGENT_PROMPTS[0]));
  assert.deepEqual(missingTlhSubagentPrompts(customPrompts), [TLH_SUBAGENT_PROMPTS[0]]);
  assert.equal(findTlhSubagentsDir(customConfig, { localRepoDir: localRepo }), localPrompts);

  const defaultConfig = {
    agentDir,
    repo: "diegopetrucci/the-last-harness",
    packageSource: "git:github.com/diegopetrucci/the-last-harness@main",
    packageSourceIsDefault: true,
    tmpDir: "",
  };
  assert.equal(findTlhSubagentsDir(defaultConfig, { localRepoDir: localRepo }), localPrompts);

  const installedDir = copyTlhSubagentPrompts(defaultConfig, localPrompts);
  assert.equal(installedDir, join(realpathSync.native(agentDir), "tlh", "agents", "subagents"));
  writeFileSync(join(installedDir, "contrarian.md"), "stale:contrarian.md\n");
  assert.deepEqual(restoreNeededTlhSubagentPrompts(localPrompts, installedDir), ["contrarian.md"]);
  copyTlhSubagentPrompts(defaultConfig, localPrompts);
  assert.equal(readFileSync(join(installedDir, "contrarian.md"), "utf8"), "local:contrarian.md\n");
  assert.equal(readFileSync(join(installedDir, "web-scout.md"), "utf8"), "local:web-scout.md\n");
  for (const prompt of TLH_SUBAGENT_PROMPTS) {
    assert.equal(readFileSync(join(installedDir, prompt), "utf8"), `local:${prompt}\n`);
  }
});

test("settings defaults no longer declare a subagents.agentDirs default", () => {
  const defaults = JSON.parse(
    readFileSync(join(process.cwd(), "config", "settings.defaults.json"), "utf8"),
  );
  assert.equal(defaults.subagents, undefined);
});

test("migrateSubagentExtensionConfig creates and converges the managed policy", (t) => {
  const agentDir = tempFixture(t, "tlh-ext-config-fresh-");
  const configPath = join(agentDir, "extensions", "subagent", "config.json");

  const first = migrateSubagentExtensionConfig({ agentDir });
  assert.deepEqual(first.changes, ["set control.needsAttentionAfterMs: 180000"]);
  assert.equal(first.changed, true);
  assert.equal(first.backupPath, undefined, "fresh config has no backup");
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
    control: { needsAttentionAfterMs: 180000 },
  });

  const firstContent = readFileSync(configPath, "utf8");
  const second = migrateSubagentExtensionConfig({ agentDir });
  assert.equal(second.changed, false, "a converged run is a no-op");
  assert.equal(second.backupPath, undefined, "a converged run does not create a backup");
  assert.equal(readFileSync(configPath, "utf8"), firstContent, "converged config is untouched");
});

test("migrateSubagentExtensionConfig rejects normal Pi config before planning", (t) => {
  const homeDir = tempFixture(t, "tlh-protected-pi-home-");
  const agentDir = join(homeDir, ".pi", "agent", "tlh-aohm-migration-test");
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { migrateSubagentExtensionConfig } from ${JSON.stringify(join(repoRoot, "scripts/lib/tlh-install-subagents.mjs"))};
const result = migrateSubagentExtensionConfig({ agentDir: ${JSON.stringify(agentDir)}, dryRun: true });
process.stdout.write(JSON.stringify(result));`,
    ],
    { cwd: repoRoot, env: { ...process.env, HOME: homeDir }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.changed, false);
  assert.deepEqual(parsed.changes, []);
  assert.match(parsed.warning || "", /normal Pi config root/);
  assert.equal(existsSync(join(homeDir, ".pi")), false);
});

test("migrateSubagentExtensionConfig replaces overrides, removes retired controls, and backs up", (t) => {
  const agentDir = tempFixture(t, "tlh-ext-config-migration-");
  const configDir = join(agentDir, "extensions", "subagent");
  const configPath = join(configDir, "config.json");
  mkdirSync(configDir, { recursive: true });
  const before =
    JSON.stringify(
      {
        toolDescriptionMode: "full",
        control: {
          activeNoticeAfterMs: 123456,
          activeNoticeAfterTurns: 7,
          activeNoticeAfterTokens: 99,
          needsAttentionAfterMs: 321,
          notifyOn: ["active_long_running", "needs_attention", "active_long_running", "custom"],
          nestedKey: "preserve",
        },
        topLevelKey: true,
      },
      null,
      2,
    ) + "\n";
  writeFileSync(configPath, before);

  const result = migrateSubagentExtensionConfig({ agentDir });
  assert.equal(result.changed, true);
  assert.deepEqual(result.changes, [
    "remove control.activeNoticeAfterMs",
    "remove control.activeNoticeAfterTurns",
    "remove control.activeNoticeAfterTokens",
    "remove active_long_running from control.notifyOn",
    "set control.needsAttentionAfterMs: 180000",
  ]);
  assert.ok(result.backupPath, "changed existing config has a backup path");
  assert.equal(readFileSync(result.backupPath, "utf8"), before, "backup preserves original bytes");

  const migrated = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(migrated.toolDescriptionMode, "full");
  assert.equal(migrated.topLevelKey, true);
  assert.deepEqual(migrated.control, {
    needsAttentionAfterMs: 180000,
    notifyOn: ["needs_attention", "custom"],
    nestedKey: "preserve",
  });
  const backupNames = readdirSync(configDir).filter((name) =>
    name.startsWith("config.json.backup-"),
  );
  assert.equal(backupNames.length, 1, "exactly one backup is created for the changed write");

  const afterMigration = readFileSync(configPath, "utf8");
  const rerun = migrateSubagentExtensionConfig({ agentDir });
  assert.equal(rerun.changed, false, "rerunning a migrated config is a no-op");
  assert.equal(rerun.backupPath, undefined, "rerunning does not create another backup");
  assert.equal(readFileSync(configPath, "utf8"), afterMigration);
  assert.equal(
    readdirSync(configDir).filter((name) => name.startsWith("config.json.backup-")).length,
    1,
  );
});

test("migrateSubagentExtensionConfig clears an active-only notifyOn list", (t) => {
  const agentDir = tempFixture(t, "tlh-ext-config-active-only-");
  const configDir = join(agentDir, "extensions", "subagent");
  const configPath = join(configDir, "config.json");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({ control: { notifyOn: ["active_long_running"] } }) + "\n",
  );

  const result = migrateSubagentExtensionConfig({ agentDir });
  assert.equal(result.changed, true);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).control, {
    notifyOn: [],
    needsAttentionAfterMs: 180000,
  });
});

test("migrateSubagentExtensionConfig dry-run is filesystem-neutral", (t) => {
  const freshAgentDir = tempFixture(t, "tlh-ext-config-dry-fresh-");
  const freshResult = migrateSubagentExtensionConfig({ agentDir: freshAgentDir, dryRun: true });
  assert.equal(freshResult.changed, true);
  assert.equal(freshResult.backupPath, undefined);
  assert.equal(existsSync(join(freshAgentDir, "extensions")), false, "dry-run creates no dirs");

  const agentDir = tempFixture(t, "tlh-ext-config-dry-existing-");
  const configDir = join(agentDir, "extensions", "subagent");
  const configPath = join(configDir, "config.json");
  mkdirSync(configDir, { recursive: true });
  const content = JSON.stringify({ control: { needsAttentionAfterMs: 1 } }) + "\n";
  writeFileSync(configPath, content);
  const beforeNames = readdirSync(configDir);
  const result = migrateSubagentExtensionConfig({ agentDir, dryRun: true });
  assert.equal(result.changed, true);
  assert.ok(result.backupPath, "dry-run reports the backup it would create");
  assert.equal(readFileSync(configPath, "utf8"), content, "dry-run leaves config bytes unchanged");
  assert.deepEqual(readdirSync(configDir), beforeNames, "dry-run creates no backup");
});

test("migrateSubagentExtensionConfig preserves malformed and structurally unsafe configs", (t) => {
  const agentDir = tempFixture(t, "tlh-ext-config-unsafe-");
  const configDir = join(agentDir, "extensions", "subagent");
  const configPath = join(configDir, "config.json");
  const sourcePath = join(configDir, "source.json");
  mkdirSync(configDir, { recursive: true });

  const cases = [
    ["array", "[]\n", "top-level JSON value must be an object"],
    ["null", "null\n", "top-level JSON value must be an object"],
    ["scalar", "42\n", "top-level JSON value must be an object"],
    ["invalid JSON", "{ not-json\n", "contains invalid JSON"],
    ["invalid control", JSON.stringify({ control: null }) + "\n", "control must be an object"],
    [
      "invalid notifyOn",
      JSON.stringify({ control: { notifyOn: "active_long_running" } }) + "\n",
      "control.notifyOn must be an array",
    ],
    ["symlink", '{"control":{"needsAttentionAfterMs":1}}\n', "symbolic link", "symlink"],
    ["hardlink", '{"control":{"needsAttentionAfterMs":1}}\n', "hard-linked", "hardlink"],
    ["empty", "", "config file is empty"],
    ["whitespace", " \t\r\n", "config file is empty"],
  ];
  for (const [label, content, warning, structure] of cases) {
    rmSync(configPath, { force: true });
    rmSync(sourcePath, { force: true });
    if (structure === "symlink") {
      writeFileSync(sourcePath, content);
      symlinkSync(sourcePath, configPath);
    } else if (structure === "hardlink") {
      writeFileSync(sourcePath, content);
      linkSync(sourcePath, configPath);
    } else {
      writeFileSync(configPath, content);
    }
    const before = readFileSync(configPath, "utf8");
    const beforeStats = lstatSync(configPath);
    const beforeEntries = readdirSync(configDir);
    const result = migrateSubagentExtensionConfig({ agentDir });
    assert.equal(result.changed, false, `${label} config is not changed`);
    assert.equal(result.backupPath, undefined, `${label} config has no backup`);
    assert.match(
      result.warning || "",
      new RegExp(
        `${warning}.*existing configuration was preserved; inspect the file and repair it manually before rerunning`,
      ),
    );
    assert.equal(readFileSync(configPath, "utf8"), before, `${label} config is preserved`);
    assert.deepEqual(readdirSync(configDir), beforeEntries, `${label} config creates no backup`);
    assert.equal(
      lstatSync(configPath).mtimeMs,
      beforeStats.mtimeMs,
      `${label} config is not written`,
    );
    if (structure === "symlink") assert.equal(lstatSync(configPath).isSymbolicLink(), true);
    if (structure === "hardlink") assert.equal(lstatSync(configPath).nlink, 2);
  }
});

// ── managedRetiredSubagentPackages unit tests ──────────────────────────────

test("managedRetiredSubagentPackages returns empty for non-object or missing packages", () => {
  assert.deepEqual(managedRetiredSubagentPackages(null), []);
  assert.deepEqual(managedRetiredSubagentPackages({}), []);
  assert.deepEqual(managedRetiredSubagentPackages({ packages: "not-an-array" }), []);
});

test("managedRetiredSubagentPackages returns candidate for legacy profile with npm subagents source", () => {
  // No provenance block → withLegacyRetiredDefaultPackageIdentities treats the
  // retired npm source as managed (legacy carry-over path).
  const settings = { packages: ["npm:@diegopetrucci/pi-subagents@0.31.14", "npm:unrelated"] };
  const result = managedRetiredSubagentPackages(settings);
  assert.equal(result.length, 1, "one candidate returned");
  assert.equal(result[0].identity, "npm:@diegopetrucci/pi-subagents");
  assert.equal(result[0].source, "npm:@diegopetrucci/pi-subagents@0.31.14");
});

test("managedRetiredSubagentPackages returns candidate for legacy profile with upstream npm source", () => {
  const settings = { packages: ["npm:pi-subagents@0.29.0"] };
  const result = managedRetiredSubagentPackages(settings);
  assert.equal(result.length, 1);
  assert.equal(result[0].identity, "npm:pi-subagents");
});

test("managedRetiredSubagentPackages returns candidate for legacy profile with git source", () => {
  const settings = { packages: ["git:github.com/nicobailon/pi-subagents@v0.31.0"] };
  const result = managedRetiredSubagentPackages(settings);
  assert.equal(result.length, 1);
  assert.equal(result[0].identity, "git:github.com/nicobailon/pi-subagents");
});

test("managedRetiredSubagentPackages skips unrelated packages in legacy profile", () => {
  const settings = { packages: ["npm:some-other-package", "npm:@diegopetrucci/pi-notify"] };
  assert.deepEqual(managedRetiredSubagentPackages(settings), []);
});

test("managedRetiredSubagentPackages skips subagents if provenance exists but identity not managed", () => {
  // Modern profile: provenance block exists but subagents is NOT in managedPackageIdentities.
  // withLegacyRetiredDefaultPackageIdentities does NOT carry it over → treated as user-added.
  const settings = {
    packages: ["npm:@diegopetrucci/pi-subagents@0.31.14"],
    tlh: { defaultExtensionProvenance: { managedPackageIdentities: [] } },
  };
  assert.deepEqual(managedRetiredSubagentPackages(settings), []);
});

test("managedRetiredSubagentPackages returns candidate when provenance lists the identity as managed", () => {
  const settings = {
    packages: ["npm:@diegopetrucci/pi-subagents@0.31.14"],
    tlh: {
      defaultExtensionProvenance: {
        managedPackageIdentities: ["npm:@diegopetrucci/pi-subagents"],
      },
    },
  };
  const result = managedRetiredSubagentPackages(settings);
  assert.equal(result.length, 1);
  assert.equal(result[0].identity, "npm:@diegopetrucci/pi-subagents");
});

test("captureManagedRetiredSubagentPackages returns empty for missing file", (t) => {
  const dir = tempFixture(t);
  assert.deepEqual(captureManagedRetiredSubagentPackages(join(dir, "nonexistent.json")), []);
});

test("captureManagedRetiredSubagentPackages returns empty for non-JSON file", (t) => {
  const dir = tempFixture(t);
  const badPath = join(dir, "bad.json");
  writeFileSync(badPath, "not json");
  assert.deepEqual(captureManagedRetiredSubagentPackages(badPath), []);
});

test("captureManagedRetiredSubagentPackages reads candidates from a real settings file", (t) => {
  const dir = tempFixture(t);
  const settingsPath = join(dir, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({
      packages: ["npm:@diegopetrucci/pi-subagents@0.31.14", "npm:other"],
    }),
  );
  const result = captureManagedRetiredSubagentPackages(settingsPath);
  assert.equal(result.length, 1);
  assert.equal(result[0].identity, "npm:@diegopetrucci/pi-subagents");
});

// ── cleanupManagedRetiredSubagentPackages unit tests ───────────────────────

function createRetiredNpmState(agentDir, packageName = "@diegopetrucci/pi-subagents") {
  const installRoot = join(agentDir, "npm");
  const packageDir = join(installRoot, "node_modules", packageName);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: packageName }));
  writeFileSync(
    join(installRoot, "package.json"),
    JSON.stringify({ dependencies: { [packageName]: "^0.31.10", keep: "1.0.0" } }, null, 2),
  );
  writeFileSync(
    join(installRoot, "package-lock.json"),
    JSON.stringify(
      {
        packages: {
          "": { dependencies: { [packageName]: "^0.31.10", keep: "1.0.0" } },
          [`node_modules/${packageName}`]: { version: "0.31.14" },
        },
      },
      null,
      2,
    ),
  );
  return { installRoot, packageDir };
}

function uninstallingPackageManager(calls) {
  return (command, args) => {
    calls.push({ command, args: [...args] });
    const uninstallIndex = args.indexOf("uninstall");
    const packageName = args[uninstallIndex + 1];
    const rootFlagIndex = Math.max(args.indexOf("--prefix"), args.indexOf("--cwd"));
    const installRoot = args[rootFlagIndex + 1];
    const packageJsonPath = join(installRoot, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    delete packageJson.dependencies?.[packageName];
    writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
    const packageLockPath = join(installRoot, "package-lock.json");
    if (existsSync(packageLockPath)) {
      const packageLock = JSON.parse(readFileSync(packageLockPath, "utf8"));
      delete packageLock.packages?.[""]?.dependencies?.[packageName];
      delete packageLock.packages?.[`node_modules/${packageName}`];
      writeFileSync(packageLockPath, JSON.stringify(packageLock, null, 2));
    }
    rmSync(join(installRoot, "node_modules", packageName), { recursive: true, force: true });
    return { status: 0, stdout: "", stderr: "" };
  };
}

test("captureRetiredSubagentNpmCommand reads configured package-manager command", (t) => {
  const root = tempFixture(t, "tlh-subagents-npm-command-");
  const settingsPath = join(root, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ npmCommand: ["corepack", "--", "pnpm"] }));
  assert.deepEqual(captureRetiredSubagentNpmCommand(settingsPath), ["corepack", "--", "pnpm"]);
});

test("cleanupManagedRetiredSubagentPackages uses npm uninstall and converges manifest, lock, and node_modules", (t) => {
  const root = tempFixture(t, "tlh-subagents-cleanup-npm-");
  const agentDir = join(root, "agent");
  const packageName = "@diegopetrucci/pi-subagents";
  const { installRoot, packageDir } = createRetiredNpmState(agentDir, packageName);
  const calls = [];

  const cleanup = cleanupManagedRetiredSubagentPackages(
    { agentDir, dryRun: false, quiet: true, runPackageManager: uninstallingPackageManager(calls) },
    [
      {
        source: "npm:@diegopetrucci/pi-subagents@0.31.14",
        identity: "npm:@diegopetrucci/pi-subagents",
      },
    ],
  );

  assert.deepEqual(calls, [
    {
      command: "npm",
      args: ["uninstall", packageName, "--prefix", installRoot, "--legacy-peer-deps"],
    },
  ]);
  assert.deepEqual(cleanup.uninstalledNpmPackages, [packageName]);
  assert.equal(
    existsSync(packageDir),
    false,
    "package-manager uninstall must remove node_modules package",
  );
  assert.equal(
    Object.hasOwn(
      JSON.parse(readFileSync(join(installRoot, "package.json"), "utf8")).dependencies,
      packageName,
    ),
    false,
  );
  assert.equal(
    Object.hasOwn(
      JSON.parse(readFileSync(join(installRoot, "package-lock.json"), "utf8")).packages[""]
        .dependencies,
      packageName,
    ),
    false,
  );
});

test("cleanupManagedRetiredSubagentPackages honors configured pnpm command semantics", (t) => {
  const root = tempFixture(t, "tlh-subagents-cleanup-pnpm-");
  const agentDir = join(root, "agent");
  const packageName = "@diegopetrucci/pi-subagents";
  const { installRoot } = createRetiredNpmState(agentDir, packageName);
  const calls = [];

  cleanupManagedRetiredSubagentPackages(
    {
      agentDir,
      npmCommand: ["corepack", "--", "pnpm"],
      quiet: true,
      runPackageManager: uninstallingPackageManager(calls),
    },
    [{ source: "npm:@diegopetrucci/pi-subagents", identity: "npm:@diegopetrucci/pi-subagents" }],
  );

  assert.deepEqual(calls, [
    {
      command: "corepack",
      args: ["--", "pnpm", "uninstall", packageName, "--prefix", installRoot],
    },
  ]);
});

test("cleanupManagedRetiredSubagentPackages honors configured bun command semantics", (t) => {
  const root = tempFixture(t, "tlh-subagents-cleanup-bun-");
  const agentDir = join(root, "agent");
  const packageName = "@diegopetrucci/pi-subagents";
  const { installRoot } = createRetiredNpmState(agentDir, packageName);
  const calls = [];

  cleanupManagedRetiredSubagentPackages(
    {
      agentDir,
      npmCommand: ["bun"],
      quiet: true,
      runPackageManager: uninstallingPackageManager(calls),
    },
    [{ source: "npm:@diegopetrucci/pi-subagents", identity: "npm:@diegopetrucci/pi-subagents" }],
  );

  assert.deepEqual(calls, [
    {
      command: "bun",
      args: ["uninstall", packageName, "--cwd", installRoot],
    },
  ]);
});

test("cleanupManagedRetiredSubagentPackages is a no-op when npm install root does not exist", (t) => {
  const root = tempFixture(t, "tlh-subagents-cleanup-missing-");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  let called = false;

  cleanupManagedRetiredSubagentPackages(
    {
      agentDir,
      quiet: true,
      runPackageManager: () => {
        called = true;
        return { status: 0 };
      },
    },
    [{ source: "npm:@diegopetrucci/pi-subagents", identity: "npm:@diegopetrucci/pi-subagents" }],
  );
  assert.equal(called, false);
});

test("cleanupManagedRetiredSubagentPackages skips pnpm when the npm root is already converged", (t) => {
  const root = tempFixture(t, "tlh-subagents-cleanup-converged-");
  const agentDir = join(root, "agent");
  const installRoot = join(agentDir, "npm");
  mkdirSync(join(installRoot, "node_modules"), { recursive: true });
  writeFileSync(
    join(installRoot, "package.json"),
    JSON.stringify({ dependencies: { keep: "1.0.0" } }, null, 2),
  );
  let called = false;

  const cleanup = cleanupManagedRetiredSubagentPackages(
    {
      agentDir,
      npmCommand: ["corepack", "--", "pnpm"],
      quiet: true,
      runPackageManager: () => {
        called = true;
        throw new Error("package manager must not run for converged state");
      },
    },
    [{ source: "npm:@diegopetrucci/pi-subagents", identity: "npm:@diegopetrucci/pi-subagents" }],
  );

  assert.equal(called, false);
  assert.deepEqual(
    cleanup.uninstalledNpmPackages,
    [],
    "already-absent package must not be reported as newly uninstalled",
  );
  assert.deepEqual(
    cleanup.plannedNpmPackages,
    [],
    "already-absent package must not be reported as planned cleanup",
  );
});

test("cleanupManagedRetiredSubagentPackages fails before refresh when package-manager uninstall fails", (t) => {
  const root = tempFixture(t, "tlh-subagents-cleanup-failure-");
  const agentDir = join(root, "agent");
  const packageName = "@diegopetrucci/pi-subagents";
  createRetiredNpmState(agentDir, packageName);

  assert.throws(
    () =>
      cleanupManagedRetiredSubagentPackages(
        {
          agentDir,
          quiet: true,
          runPackageManager: () => ({ status: 42, stderr: "uninstall failed" }),
        },
        [
          {
            source: "npm:@diegopetrucci/pi-subagents",
            identity: "npm:@diegopetrucci/pi-subagents",
          },
        ],
      ),
    /failed to uninstall retired TLH subagent npm package.*uninstall failed/,
  );
});

test("cleanupManagedRetiredSubagentPackages dry-run logs uninstall without invoking package manager", (t) => {
  const root = tempFixture(t, "tlh-subagents-cleanup-dryrun-");
  const agentDir = join(root, "agent");
  const packageName = "@diegopetrucci/pi-subagents";
  const { packageDir } = createRetiredNpmState(agentDir, packageName);
  const logged = [];
  const origLog = console.log;
  console.log = (msg) => logged.push(msg);
  try {
    const cleanup = cleanupManagedRetiredSubagentPackages(
      {
        agentDir,
        dryRun: true,
        quiet: false,
        runPackageManager: () => {
          throw new Error("package manager must not run during dry-run");
        },
      },
      [{ source: "npm:@diegopetrucci/pi-subagents", identity: "npm:@diegopetrucci/pi-subagents" }],
    );
    assert.deepEqual(cleanup.plannedNpmPackages, [packageName]);
  } finally {
    console.log = origLog;
  }

  assert.ok(existsSync(packageDir), "dry-run must not delete the package dir");
  assert.ok(
    logged.some((msg) => msg.includes("Would uninstall")),
    "dry-run must log a would-uninstall message",
  );
});

test("cleanupManagedRetiredSubagentPackages skips when agentDir is a symlink and emits a warning", (t) => {
  const root = tempFixture(t, "tlh-subagents-cleanup-symlink-");
  const realDir = join(root, "real");
  const symlinkDir = join(root, "agent");
  mkdirSync(realDir, { recursive: true });
  symlinkSync(realDir, symlinkDir);

  const warnings = [];
  const origErr = console.error;
  console.error = (msg) => warnings.push(msg);
  try {
    cleanupManagedRetiredSubagentPackages({ agentDir: symlinkDir, dryRun: false, quiet: false }, [
      { source: "npm:@diegopetrucci/pi-subagents", identity: "npm:@diegopetrucci/pi-subagents" },
    ]);
  } finally {
    console.error = origErr;
  }

  assert.ok(
    warnings.some((w) => w.includes("unsafe agent dir")),
    "symlinked agentDir must produce a safety warning",
  );
});

test("cleanupManagedRetiredSubagentPackages removes owned git checkout and empty parent dirs", (t) => {
  const root = tempFixture(t, "tlh-subagents-cleanup-git-");
  const agentDir = join(root, "agent");
  const gitRoot = join(agentDir, "git");
  const ownerDir = join(gitRoot, "github.com", "nicobailon");
  const repoDir = join(ownerDir, "pi-subagents");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(join(repoDir, ".git"), { recursive: true }); // simulates a managed git checkout

  cleanupManagedRetiredSubagentPackages({ agentDir, dryRun: false, quiet: true }, [
    {
      source: "git:github.com/nicobailon/pi-subagents@v0.31.0",
      identity: "git:github.com/nicobailon/pi-subagents",
    },
  ]);

  assert.equal(existsSync(repoDir), false, "git checkout dir must be removed");
  // Empty intermediate parent under git root must also be cleaned up.
  assert.equal(existsSync(ownerDir), false, "empty owner dir under git root must be removed");
});

test("cleanupManagedRetiredSubagentPackages does not remove non-empty sibling git dirs", (t) => {
  const root = tempFixture(t, "tlh-subagents-cleanup-git-sibling-");
  const agentDir = join(root, "agent");
  const gitRoot = join(agentDir, "git");
  const ownerDir = join(gitRoot, "github.com", "nicobailon");
  const repoDir = join(ownerDir, "pi-subagents");
  const siblingDir = join(ownerDir, "other-repo");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  mkdirSync(siblingDir, { recursive: true });

  cleanupManagedRetiredSubagentPackages({ agentDir, dryRun: false, quiet: true }, [
    {
      source: "git:github.com/nicobailon/pi-subagents@v0.31.0",
      identity: "git:github.com/nicobailon/pi-subagents",
    },
  ]);

  assert.equal(existsSync(repoDir), false, "managed git checkout must be removed");
  // Owner dir still has the sibling, so it must NOT be removed.
  assert.ok(existsSync(ownerDir), "non-empty owner dir must be preserved");
  assert.ok(existsSync(siblingDir), "sibling repo must be preserved");
});

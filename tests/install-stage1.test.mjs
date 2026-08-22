import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import test from "node:test";

import { makeTempDir, readPiLogRecords } from "./install-stage1-test-helpers.mjs";
import {
  TLH_PINNED_PI_VERSION,
  escapeRegExp,
  pathWithoutRepoNodeModulesBin,
  readJson,
  repoRoot,
  runHelper,
  runStage1LocalPackageInstall,
  scrubInstallerEnv,
  writeFakePi,
} from "./install-stage1-core-test-helpers.mjs";

import { buildInstallConfig, parseArgs, usage } from "../scripts/tlh-install.mjs";
import { validateInstallerTargets } from "../scripts/lib/tlh-install-paths.mjs";

test("stage-1 hides PATH-adjustment and refresh fallback detail lines unless --verbose", (t) => {
  for (const verbose of [false, true]) {
    const { result, agentDir } = runStage1LocalPackageInstall(t, { verbose });
    const output = `${result.stdout}\n${result.stderr}`;
    const runtimeBinDir = join(dirname(agentDir), "runtime", "bin");
    const runtimePiPath = join(runtimeBinDir, "pi");
    const pathNotice = `warning: ${runtimePiPath} installed but ${runtimeBinDir} is not on PATH. Added it to PATH for this install; add it to your shell profile with: export PATH="${runtimeBinDir}:$PATH"`;
    const refreshDetailPattern =
      /Running settings-wide extension refresh from merged settings; fallback retries only 9 non-critical bundled default source\(s\) individually\./;

    assert.equal(result.status, 0, output);
    if (verbose) {
      assert.ok(output.includes(pathNotice), output);
      assert.match(output, refreshDetailPattern);
    } else {
      assert.equal(output.includes(pathNotice), false, output);
      assert.doesNotMatch(output, refreshDetailPattern);
    }
  }
});

test("stage-1 rejects legacy ticket integration flags", () => {
  assert.doesNotThrow(() => parseArgs([]));
  for (const flag of ["--with-tickets", "--without-tickets", "--no-tickets"]) {
    assert.throws(() => parseArgs([flag]), new RegExp(`unknown option: ${flag}`));
  }
});

test("installer helpers no longer support the removed --no-pi-install opt-out", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  mkdirSync(homeDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const stage0Help = spawnSync("bash", [join(repoRoot, "install.sh"), "--help"], {
    cwd: repoRoot,
    env: scrubInstallerEnv({ HOME: homeDir }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(stage0Help.status, 0, stage0Help.stderr);
  assert.match(stage0Help.stdout, new RegExp(`Upstream Pi ${escapeRegExp(TLH_PINNED_PI_VERSION)}`));
  assert.match(stage0Help.stdout, /installed into a private TLH runtime/);
  assert.match(
    stage0Help.stdout,
    /TLH_GNOSIS_VERSION\s+Gnosis version to install \(default: 0\.5\.4\)/,
  );
  assert.doesNotMatch(stage0Help.stdout, /--no-pi-install/);

  const stage0RemovedFlag = spawnSync("bash", [join(repoRoot, "install.sh"), "--no-pi-install"], {
    cwd: repoRoot,
    env: scrubInstallerEnv({ HOME: homeDir }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.notEqual(stage0RemovedFlag.status, 0);
  assert.match(stage0RemovedFlag.stderr, /error: unknown option: --no-pi-install/);
  assert.equal(stage0RemovedFlag.stdout, "");

  assert.throws(() => parseArgs(["--no-pi-install"]), /unknown option: --no-pi-install/);
  assert.match(usage(), new RegExp(`Upstream Pi ${escapeRegExp(TLH_PINNED_PI_VERSION)}`));
  assert.match(usage(), /TLH_GNOSIS_VERSION\s+Gnosis version to install \(default: 0\.5\.4\)/);
  assert.doesNotMatch(usage(), /--no-pi-install/);

  const updateHelp = spawnSync(
    process.execPath,
    [join(repoRoot, "scripts/tlh-update.mjs"), "--help"],
    {
      cwd: repoRoot,
      env: scrubInstallerEnv({ HOME: homeDir }),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.equal(updateHelp.status, 0, updateHelp.stderr);
  assert.match(updateHelp.stdout, /Upstream Pi is installed into a private TLH runtime/);
  assert.doesNotMatch(updateHelp.stdout, /--no-pi-install/);

  const updateRemovedFlag = spawnSync(
    process.execPath,
    [join(repoRoot, "scripts/tlh-update.mjs"), "--no-pi-install"],
    {
      cwd: repoRoot,
      env: scrubInstallerEnv({ HOME: homeDir }),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.notEqual(updateRemovedFlag.status, 0);
  assert.match(updateRemovedFlag.stderr, /Unknown option for tlh update: --no-pi-install/);
  assert.equal(updateRemovedFlag.stdout, "");
});

test("stage-1 infers update track unless env or CLI overrides", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  mkdirSync(homeDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const configFor = (argv = [], overrides = {}) => {
    const env = scrubInstallerEnv({ HOME: homeDir, ...overrides });
    return buildInstallConfig(
      parseArgs(["--agent-dir", agentDir, "--bin-dir", binDir, ...argv], env),
      env,
    );
  };

  assert.equal(configFor([], { TLH_REF: "feature" }).updateTrack, "ref");
  assert.equal(configFor([], { TLH_REF: "v1.2.3" }).updateTrack, "pinned-tag");
  assert.equal(
    configFor([], { TLH_REF: "v1.2.3", TLH_UPDATE_TRACK: "latest-release" }).updateTrack,
    "latest-release",
  );
  assert.equal(
    configFor(["--track", "ref"], { TLH_REF: "v1.2.3", TLH_UPDATE_TRACK: "latest-release" })
      .updateTrack,
    "ref",
  );
});

test("stage-1 applies tlh-main defaults for main ref when wrapper name and agent dir are not explicit", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const binDir = join(root, "bin");
  mkdirSync(homeDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // No explicit --agent-dir, no TLH_AGENT_DIR, no --wrapper-name, no TLH_WRAPPER_NAME.
  // ref defaults to 'main' (DEFAULT_REF).
  const env = scrubInstallerEnv({ HOME: homeDir });
  const config = buildInstallConfig(parseArgs(["--bin-dir", binDir], env), env);

  // Wrapper and agent dir should use the main-specific named defaults.
  assert.equal(config.wrapperName, "tlh-main");
  assert.ok(
    config.agentDir.endsWith(join(".the-last-harness-main", "agent")),
    `agentDir should end with .the-last-harness-main/agent, got: ${config.agentDir}`,
  );
  // Runtime prefix is derived from dirname(agentDir)/runtime — verify it follows agentDir.
  assert.ok(
    config.agentDir.includes(".the-last-harness-main"),
    `agentDir should include .the-last-harness-main, got: ${config.agentDir}`,
  );
  // The runtimePrefix (dirname(agentDir)/runtime) = .the-last-harness-main/runtime;
  // we verify the agentDir parent matches so the derivation is correct.
  const expectedRuntimePrefix = join(dirname(config.agentDir), "runtime");
  assert.ok(
    expectedRuntimePrefix.endsWith(join(".the-last-harness-main", "runtime")),
    `runtimePrefix should end with .the-last-harness-main/runtime, got: ${expectedRuntimePrefix}`,
  );
  assert.equal(config.wrapperPath, join(binDir, "tlh-main"));
});

test("stage-1 keeps tlh defaults for release tag ref (non-main)", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const binDir = join(root, "bin");
  mkdirSync(homeDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Semver tag ref — non-main, so standard defaults apply.
  const env = scrubInstallerEnv({ HOME: homeDir, TLH_REF: "v1.2.3" });
  const config = buildInstallConfig(parseArgs(["--bin-dir", binDir], env), env);

  assert.equal(config.wrapperName, "tlh");
  assert.ok(
    config.agentDir.endsWith(join(".the-last-harness", "agent")),
    `agentDir should end with .the-last-harness/agent, got: ${config.agentDir}`,
  );
  // Ensure .the-last-harness-main is NOT used for a tag install.
  assert.ok(
    !config.agentDir.includes(".the-last-harness-main"),
    `agentDir should not include .the-last-harness-main for a tag ref, got: ${config.agentDir}`,
  );
  assert.equal(config.wrapperPath, join(binDir, "tlh"));
});

test("stage-1 explicit --wrapper-name and --agent-dir override main-ref auto-defaults", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const binDir = join(root, "bin");
  const customAgentDir = join(root, "my-agent");
  mkdirSync(homeDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Explicit CLI overrides: even on main ref, explicit values must win.
  const envBase = scrubInstallerEnv({ HOME: homeDir });
  const configCliOverride = buildInstallConfig(
    parseArgs(
      ["--bin-dir", binDir, "--wrapper-name", "tlh", "--agent-dir", customAgentDir],
      envBase,
    ),
    envBase,
  );
  assert.equal(
    configCliOverride.wrapperName,
    "tlh",
    "explicit --wrapper-name tlh on main ref must not be rewritten to tlh-main",
  );
  assert.equal(
    configCliOverride.agentDir,
    customAgentDir,
    "explicit --agent-dir on main ref must not be replaced with .the-last-harness-main/agent",
  );

  // Explicit env overrides via TLH_WRAPPER_NAME / TLH_AGENT_DIR.
  const envWithExplicit = scrubInstallerEnv({
    HOME: homeDir,
    TLH_WRAPPER_NAME: "my-tlh",
    TLH_AGENT_DIR: customAgentDir,
  });
  const configEnvOverride = buildInstallConfig(
    parseArgs(["--bin-dir", binDir], envWithExplicit),
    envWithExplicit,
  );
  assert.equal(
    configEnvOverride.wrapperName,
    "my-tlh",
    "TLH_WRAPPER_NAME env must override main-ref auto-default",
  );
  assert.equal(
    configEnvOverride.agentDir,
    customAgentDir,
    "TLH_AGENT_DIR env must override main-ref auto-default",
  );

  // Partial override: explicit wrapper name only; agentDir still gets main-ref default.
  const envPartialWrapperName = scrubInstallerEnv({ HOME: homeDir, TLH_WRAPPER_NAME: "my-tlh" });
  const configPartialWrapper = buildInstallConfig(
    parseArgs(["--bin-dir", binDir], envPartialWrapperName),
    envPartialWrapperName,
  );
  assert.equal(
    configPartialWrapper.wrapperName,
    "my-tlh",
    "TLH_WRAPPER_NAME overrides wrapper name even on main ref",
  );
  assert.ok(
    configPartialWrapper.agentDir.endsWith(join(".the-last-harness-main", "agent")),
    `agentDir should still use main-ref default when only wrapper name is explicit: ${configPartialWrapper.agentDir}`,
  );

  // Partial override: explicit agent dir only; wrapperName still gets main-ref default.
  const envPartialAgentDir = scrubInstallerEnv({ HOME: homeDir, TLH_AGENT_DIR: customAgentDir });
  const configPartialAgent = buildInstallConfig(
    parseArgs(["--bin-dir", binDir], envPartialAgentDir),
    envPartialAgentDir,
  );
  assert.equal(
    configPartialAgent.wrapperName,
    "tlh-main",
    "wrapperName should still use main-ref default when only agent dir is explicit",
  );
  assert.equal(
    configPartialAgent.agentDir,
    customAgentDir,
    "TLH_AGENT_DIR env must override main-ref auto-default agentDir",
  );
});

test("stage-1 defaults managed Gnosis to the pinned release and still honors env overrides", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  mkdirSync(homeDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const configFor = (overrides = {}) => {
    const env = scrubInstallerEnv({ HOME: homeDir, ...overrides });
    return buildInstallConfig(parseArgs(["--agent-dir", agentDir, "--bin-dir", binDir], env), env);
  };

  assert.equal(configFor().gnosisVersion, "0.5.4");
  assert.equal(configFor({ TLH_GNOSIS_VERSION: "latest" }).gnosisVersion, "latest");
  assert.equal(configFor({ TLH_GNOSIS_VERSION: "0.5.2" }).gnosisVersion, "0.5.2");
});

test("stage-1 --no-settings does not short-circuit Gnosis configure", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  const fakebin = join(root, "fakebin");
  mkdirSync(homeDir, { recursive: true });
  writeFakePi(
    fakebin,
    `if [[ "\${1:-}" == "--version" ]]; then\n\tprintf '${TLH_PINNED_PI_VERSION}\\n'\n\texit 0\nfi\nexit 0`,
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = spawnSync(
    process.execPath,
    [
      join(repoRoot, "scripts/tlh-install.mjs"),
      "--dry-run",
      "--no-settings",
      "--agent-dir",
      agentDir,
      "--bin-dir",
      binDir,
    ],
    {
      cwd: repoRoot,
      env: scrubInstallerEnv({
        HOME: homeDir,
        PATH: [fakebin, pathWithoutRepoNodeModulesBin()].filter(Boolean).join(delimiter),
        TLH_SKIP_GNOSIS_INSTALL: "1",
      }),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /Skipping settings\/keybinding merge \(--no-settings\)\./);
  assert.match(output, /Skipping Gnosis integration \(TLH_SKIP_GNOSIS_INSTALL is set\)\./);
  assert.doesNotMatch(output, /Skipping Gnosis integration \(--no-settings\)\./);
});

test("stage-1 copies only the profile recovery launcher into the isolated profile", (t) => {
  const { result, agentDir } = runStage1LocalPackageInstall(t, { noSettings: true });
  const output = `${result.stdout}\n${result.stderr}`;
  const supportDir = join(agentDir, "tlh");

  assert.equal(result.status, 0, output);
  assert.equal(existsSync(join(supportDir, "recover-update.mjs")), true, "recover-update.mjs");
  for (const relativePath of [
    "tlh-rtk.mjs",
    "tlh-defaults.mjs",
    "tlh-tickets.mjs",
    "tlh-update.mjs",
    "default-extensions.json",
    "lib/default-extensions.mjs",
    "lib/tlh-install-package-source.mjs",
    "lib/tlh-install-paths.mjs",
    "lib/tlh-install-utils.mjs",
    "lib/tlh-safe-profile-write.mjs",
    "tlh-gnosis.mjs",
    "tlh-wrapper.mjs",
    "tlh-install-state.mjs",
  ]) {
    assert.equal(existsSync(join(supportDir, relativePath)), false, relativePath);
  }
});

test("stage-1 removes legacy managed RTK artifacts even when settings/default extensions are skipped", (t) => {
  const { result, agentDir } = runStage1LocalPackageInstall(t, {
    noSettings: true,
    existingSupportFiles: {
      "tlh-rtk.mjs": "legacy helper\n",
    },
    existingManagedRtk: true,
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.equal(existsSync(join(agentDir, "bin", "rtk")), false);
  assert.equal(existsSync(join(agentDir, "tlh", "tlh-rtk.mjs")), false);
});

test("stage-1 dry-run reports legacy managed RTK cleanup with --no-settings without deleting", (t) => {
  const { result, agentDir } = runStage1LocalPackageInstall(t, {
    dryRun: true,
    noSettings: true,
    existingSupportFiles: {
      "tlh-rtk.mjs": "legacy helper\n",
    },
    existingManagedRtk: true,
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /Would remove retired profile file: .*bin[\\/]rtk/);
  assert.match(output, /Would remove retired profile file: .*tlh[\\/]tlh-rtk\.mjs/);
  assert.equal(existsSync(join(agentDir, "bin", "rtk")), true);
  assert.equal(existsSync(join(agentDir, "tlh", "tlh-rtk.mjs")), true);
});

test("stage-1 leaves existing install-only TLH support files untouched during install", (t) => {
  const existingSupportFiles = {
    "tlh-gnosis.mjs": "legacy gnosis helper\n",
    "tlh-wrapper.mjs": "legacy wrapper helper\n",
    "tlh-install-state.mjs": "legacy install-state helper\n",
  };
  const { result, agentDir } = runStage1LocalPackageInstall(t, {
    existingSupportFiles,
    noSettings: true,
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  for (const [relativePath, content] of Object.entries(existingSupportFiles)) {
    assert.equal(readFileSync(join(agentDir, "tlh", relativePath), "utf8"), content, relativePath);
  }
});

test("stage-1 --no-settings preserves existing extensions/librarian.json during installer flow", (t) => {
  const existingLibrarianConfig = { version: "1.0.0" };
  const { result, agentDir } = runStage1LocalPackageInstall(t, {
    existingLibrarianConfig,
    noSettings: true,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  const librarianConfigPath = join(agentDir, "extensions", "librarian.json");

  assert.equal(result.status, 0, output);
  assert.equal(readJson(librarianConfigPath).version, existingLibrarianConfig.version);
});

test("stage-1 derives packageRoot from custom package source install dirs", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  mkdirSync(homeDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const baseEnv = {
    ...process.env,
    PI_CODING_AGENT_DIR: join(homeDir, ".pi", "agent"),
    TLH_AGENT_DIR: join(homeDir, ".pi", "agent"),
    TLH_REPO: "poisoned/repo",
    TLH_REF: "poisoned-ref",
  };
  const configFor = (packageSource) => {
    const env = scrubInstallerEnv({ HOME: homeDir, TLH_PACKAGE_SOURCE: packageSource }, baseEnv);
    return buildInstallConfig(parseArgs(["--agent-dir", agentDir, "--bin-dir", binDir], env), env);
  };

  const gitConfig = configFor("git:github.com/custom/pkg@feature");
  assert.equal(gitConfig.packageSourceIsDefault, false);
  assert.equal(gitConfig.updateTrack, "custom");
  assert.equal(gitConfig.packageRoot, join(agentDir, "git", "github.com", "custom", "pkg"));
  assert.equal(gitConfig.packageHelperRoot, gitConfig.packageRoot);

  runHelper(
    "scripts/tlh-wrapper.mjs",
    [
      "--agent-dir",
      gitConfig.agentDir,
      "--bin-dir",
      gitConfig.binDir,
      "--wrapper-name",
      gitConfig.wrapperName,
      "--package-root",
      gitConfig.packageHelperRoot,
    ],
    { homeDir },
  );
  const wrapper = readFileSync(gitConfig.wrapperPath, "utf8");
  assert.ok(
    wrapper.split(/\r?\n/).includes(`default_tlh_package_root='${gitConfig.packageHelperRoot}'`),
  );

  const relativeLocalConfig = configFor("../local-package");
  assert.equal(relativeLocalConfig.packageRoot, resolve(agentDir, "../local-package"));
  assert.equal(relativeLocalConfig.packageHelperRoot, relativeLocalConfig.packageRoot);

  const homeLocalConfig = configFor("~/local-package");
  assert.equal(homeLocalConfig.packageRoot, join(homeDir, "local-package"));
  assert.equal(homeLocalConfig.packageHelperRoot, homeLocalConfig.packageRoot);

  const fileLocalSource = `file:${join(root, "file-package")}`;
  const fileLocalConfig = configFor(fileLocalSource);
  assert.equal(fileLocalConfig.packageRoot, join(root, "file-package"));
  assert.equal(fileLocalConfig.packageHelperRoot, fileLocalConfig.packageRoot);
  assert.equal(fileLocalConfig.packageSource, fileLocalSource);

  const unsupportedConfig = configFor("github:owner/repo");
  assert.equal(
    unsupportedConfig.packageRoot,
    join(agentDir, "git", "github.com", "diegopetrucci", "the-last-harness"),
  );
  assert.equal(unsupportedConfig.packageHelperRoot, "");
});

test("stage-1 normalizes absolute file: sources for Pi while preserving raw install metadata", (t) => {
  const filePackageSource = `file:${repoRoot}`;
  const { result, agentDir, piLog } = runStage1LocalPackageInstall(t, {
    envOverrides: { TLH_PACKAGE_SOURCE: filePackageSource },
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.deepEqual(
    readPiLogRecords(piLog)
      .map((record) => record.command)
      .slice(0, 3),
    ["--version", `install ${repoRoot}`, `update ${repoRoot}`],
  );
  assert.equal(
    readJson(join(agentDir, "tlh", "install-state.json")).packageSource,
    filePackageSource,
  );
  const settings = readJson(join(agentDir, "settings.json"));
  assert.equal(settings.packages[0], repoRoot);
  assert.equal(settings.packages.includes(filePackageSource), false);
});

// (tlh update / tlh recovery update tests moved to install-stage1-update.test.mjs)

test("stage-1 canonicalizes relative target dirs before deriving wrapper and state paths", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const cwd = join(root, "workspace");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  const previousCwd = process.cwd();
  t.after(() => {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  });
  process.chdir(cwd);
  const canonicalCwd = process.cwd();

  const env = scrubInstallerEnv(
    { HOME: homeDir },
    {
      ...process.env,
      PI_CODING_AGENT_DIR: join(homeDir, ".pi", "agent"),
      TLH_AGENT_DIR: join(homeDir, ".pi", "agent"),
      TLH_BIN_DIR: join(homeDir, ".pi", "agent"),
      TLH_PACKAGE_SOURCE: "~/poisoned-package",
      TLH_REPO: "poisoned/repo",
      TLH_REF: "poisoned-ref",
      TLH_UPDATE_TRACK: "custom",
    },
  );
  const parsed = parseArgs(["--agent-dir", ".pi/agent", "--bin-dir", "bin"], env);
  const config = buildInstallConfig(parsed, env);
  const expectedAgentDir = join(canonicalCwd, ".pi", "agent");
  const expectedBinDir = join(canonicalCwd, "bin");
  const normalPiAgentIfLeftRelative = join(homeDir, ".pi", "agent");

  assert.equal(resolve(homeDir, parsed.agentDirInput), normalPiAgentIfLeftRelative);
  assert.equal(config.agentDir, expectedAgentDir);
  assert.equal(config.binDir, expectedBinDir);
  assert.notEqual(config.agentDir, normalPiAgentIfLeftRelative);
  for (const targetPath of [
    config.agentDir,
    config.binDir,
    config.settingsPath,
    config.keybindingsPath,
    config.supportDir,
    config.statePath,
    config.wrapperPath,
    config.packageRoot,
  ]) {
    assert.ok(isAbsolute(targetPath), `expected absolute path: ${targetPath}`);
  }
  assert.equal(config.settingsPath, join(expectedAgentDir, "settings.json"));
  assert.equal(config.keybindingsPath, join(expectedAgentDir, "keybindings.json"));
  assert.equal(config.statePath, join(expectedAgentDir, "tlh", "install-state.json"));
  // ref defaults to 'main' (TLH_REF is scrubbed by scrubInstallerEnv); no explicit --wrapper-name,
  // so main-ref auto-default applies and wrapperName becomes 'tlh-main'.
  assert.equal(config.wrapperName, "tlh-main");
  assert.equal(config.wrapperPath, join(expectedBinDir, "tlh-main"));
  assert.equal(
    config.packageRoot,
    join(expectedAgentDir, "git", "github.com", "diegopetrucci", "the-last-harness"),
  );
  assert.doesNotThrow(() => validateInstallerTargets(config, { homeDir }));

  runHelper(
    "scripts/tlh-wrapper.mjs",
    [
      "--agent-dir",
      config.agentDir,
      "--bin-dir",
      config.binDir,
      "--wrapper-name",
      config.wrapperName,
      "--package-root",
      config.packageRoot,
    ],
    { homeDir },
  );
  const wrapper = readFileSync(config.wrapperPath, "utf8");
  assert.ok(wrapper.split(/\r?\n/).includes(`default_agent_dir='${config.agentDir}'`));
  assert.doesNotMatch(wrapper, /^default_agent_dir='\.pi\/agent'$/m);
  assert.doesNotMatch(wrapper, /PI_CODING_AGENT_DIR=\.pi\/agent/);

  runHelper(
    "scripts/tlh-install-state.mjs",
    [
      "--state-path",
      config.statePath,
      "--repo",
      config.repo,
      "--ref",
      config.ref,
      "--track",
      config.updateTrack,
      "--package-source",
      config.packageSource,
      "--package-source-is-default",
      String(config.packageSourceIsDefault),
      "--raw-base",
      config.rawBase,
      "--agent-dir",
      config.agentDir,
      "--bin-dir",
      config.binDir,
      "--wrapper-name",
      config.wrapperName,
    ],
    { homeDir },
  );
  const state = JSON.parse(readFileSync(config.statePath, "utf8"));
  assert.equal(state.agentDir, config.agentDir);
  assert.equal(state.binDir, config.binDir);
  assert.ok(isAbsolute(state.agentDir));
  assert.ok(isAbsolute(state.binDir));
  assert.notEqual(state.agentDir, parsed.agentDirInput);
  assert.notEqual(state.agentDir, normalPiAgentIfLeftRelative);
  assert.equal(existsSync(join(homeDir, ".pi")), false);
});

test("stage-1 --no-wrapper summary emits done header, blank line, and PI_CODING_AGENT_DIR command in backticks", (t) => {
  const { result, agentDir } = runStage1LocalPackageInstall(t);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const lines = result.stdout.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l === "Done. The Last Harness is ready. Start with:");
  assert.ok(headerIdx !== -1, `summary header not found in stdout:\n${result.stdout}`);
  // The line immediately after the header must be blank (blank-line separation).
  assert.equal(lines[headerIdx + 1], "", "expected blank line directly after summary header");
  // The command must appear wrapped in literal backticks — not as 'Start with: <cmd>' on the same line.
  const runtimePi = join(dirname(agentDir), "runtime", "bin", "pi");
  const expectedCmd = `\`PI_CODING_AGENT_DIR="${agentDir}" "${runtimePi}"\``;
  assert.equal(
    lines[headerIdx + 2],
    expectedCmd,
    `expected backtick-wrapped PI_CODING_AGENT_DIR command on the line after the blank; got: ${JSON.stringify(lines[headerIdx + 2])}`,
  );
});

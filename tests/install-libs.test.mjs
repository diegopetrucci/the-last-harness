import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

import {
  criticalGitSourceSpec,
  gitSourceInstallSource,
  packageSourceInstallDir,
  packageSourcePiSource,
  parseGitSource,
} from "../scripts/lib/tlh-install-package-source.mjs";
import { assertGitSourceTargetSafe, refreshGitCheckout } from "../scripts/lib/tlh-install-git.mjs";
import {
  assertProfilePathWithinAgent,
  ensureSafeProfileDir,
  pathIsProtectedPiConfig,
  safeProfileFileTarget,
  validateInstallerTargets,
} from "../scripts/lib/tlh-install-paths.mjs";
import { writeSafeProfileFile } from "../scripts/lib/tlh-safe-profile-write.mjs";
import {
  TLH_SUBAGENT_PROMPTS,
  captureManagedRetiredSubagentPackages,
  captureRetiredSubagentNpmCommand,
  cleanupManagedRetiredSubagentPackages,
  copyTlhSubagentPrompts,
  findTlhSubagentsDir,
  managedRetiredSubagentPackages,
  missingTlhSubagentPrompts,
  provisionSubagentExtensionConfig,
  restoreNeededTlhSubagentPrompts,
  subagentExtensionConfigMissingDefaults,
  settingsRequireTlhSubagentPrompts,
} from "../scripts/lib/tlh-install-subagents.mjs";

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

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  return result.stdout.trim();
}

function runGit(args, options = {}) {
  return runCommand("git", args, options);
}

function createManagedGitCheckout(t) {
  const root = tempFixture(t, "tlh-install-git-test-");
  const agentDir = join(root, "agent");
  const seedDir = join(root, "seed");
  const originDir = join(root, "origin.git");
  const targetDir = join(agentDir, "git", "github.com", "owner", "repo");

  mkdirSync(seedDir, { recursive: true });
  runGit(["init", seedDir]);
  runGit(["-C", seedDir, "checkout", "-b", "main"]);
  runGit(["-C", seedDir, "config", "user.email", "tests@example.com"]);
  runGit(["-C", seedDir, "config", "user.name", "TLH Tests"]);
  writeFileSync(join(seedDir, ".gitignore"), "build/\n");
  writeFileSync(join(seedDir, "tracked.txt"), "tracked v1\n");
  runGit(["-C", seedDir, "add", "."]);
  runGit(["-C", seedDir, "commit", "-m", "initial"]);
  runGit(["clone", "--bare", seedDir, originDir]);
  mkdirSync(join(agentDir, "git", "github.com", "owner"), { recursive: true });
  runGit(["clone", originDir, targetDir]);

  return { agentDir, originDir, targetDir };
}

function gitCheckoutIo(warnings) {
  return {
    runCommand(_config, commandArgs, options = {}) {
      const [command, ...args] = commandArgs;
      runCommand(command, args, {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
      });
    },
    warn(message) {
      warnings.push(message);
    },
  };
}

function listBackupRefs(targetDir) {
  const refs = runGit(["-C", targetDir, "for-each-ref", "refs/tlh-backup", "--format=%(refname)"]);
  return refs === "" ? [] : refs.split("\n");
}

test("package-source parsing resolves git, hash-pinned, and local package sources", (t) => {
  const root = tempFixture(t);
  const agentDir = join(root, "agent");
  const homeDir = join(root, "home");

  assert.deepEqual(parseGitSource("git:github.com/diegopetrucci/the-last-harness@main"), {
    repo: "https://github.com/diegopetrucci/the-last-harness",
    host: "github.com",
    path: "diegopetrucci/the-last-harness",
    ref: "main",
  });
  assert.deepEqual(criticalGitSourceSpec("git@github.com:owner/repo@feature", { agentDir }), {
    targetDir: join(agentDir, "git", "github.com", "owner", "repo"),
    repo: "git@github.com:owner/repo",
    ref: "feature",
  });
  assert.equal(
    gitSourceInstallSource("https://github.com/acme/tool.git#v1.2.3", { agentDir }),
    "git:https://github.com/acme/tool.git@v1.2.3",
  );
  assert.equal(
    packageSourceInstallDir("../local-package", { agentDir, homeDir }),
    resolve(agentDir, "../local-package"),
  );
  assert.equal(
    packageSourceInstallDir("~/local-package", { agentDir, homeDir }),
    join(homeDir, "local-package"),
  );
  const checkoutDir = resolve(root, "checkout");
  assert.equal(packageSourceInstallDir(`file:${checkoutDir}`, { agentDir, homeDir }), checkoutDir);
  assert.equal(
    packageSourceInstallDir(`file://${checkoutDir}`, { agentDir, homeDir }),
    checkoutDir,
  );
  assert.equal(
    packageSourceInstallDir(`file://localhost${checkoutDir}`, { agentDir, homeDir }),
    checkoutDir,
  );
  assert.equal(
    packageSourceInstallDir(`file://remotehost${checkoutDir}`, { agentDir, homeDir }),
    resolve(agentDir, `file://remotehost${checkoutDir}`),
  );
  assert.equal(packageSourcePiSource(`file:${checkoutDir}`, { agentDir, homeDir }), checkoutDir);
  assert.equal(
    packageSourcePiSource(`file://localhost${checkoutDir}`, { agentDir, homeDir }),
    checkoutDir,
  );
  assert.equal(
    packageSourcePiSource(`file://remotehost${checkoutDir}`, { agentDir, homeDir }),
    `file://remotehost${checkoutDir}`,
  );
  assert.equal(
    packageSourcePiSource("../local-package", { agentDir, homeDir }),
    "../local-package",
  );
  assert.equal(
    packageSourceInstallDir("file:../local-package", { agentDir, homeDir }),
    resolve(agentDir, "file:../local-package"),
  );
  assert.equal(packageSourceInstallDir("github:owner/repo", { agentDir, homeDir }), "");
});

test("git source target guard rejects existing non-git checkout dirs", (t) => {
  const root = tempFixture(t);
  const agentDir = join(root, "agent");
  const source = "git:github.com/owner/repo@main";
  const targetDir = join(agentDir, "git", "github.com", "owner", "repo");

  assert.doesNotThrow(() =>
    assertGitSourceTargetSafe({ agentDir }, source, "The Last Harness package checkout"),
  );
  mkdirSync(targetDir, { recursive: true });
  assert.throws(
    () => assertGitSourceTargetSafe({ agentDir }, source, "The Last Harness package checkout"),
    /refusing to use existing non-git The Last Harness package checkout/,
  );
});

test("normal Pi config guards reject agent, wrapper, and profile writes under ~/.pi", (t) => {
  const root = tempFixture(t);
  const homeDir = join(root, "home");
  mkdirSync(homeDir, { recursive: true });

  assert.equal(pathIsProtectedPiConfig(join(homeDir, ".pi", "agent"), { homeDir }), true);
  assert.equal(pathIsProtectedPiConfig(join(homeDir, ".pi-other", "agent"), { homeDir }), false);

  assert.throws(
    () =>
      validateInstallerTargets(
        {
          agentDir: join(homeDir, ".pi", "agent"),
          binDir: join(root, "bin"),
          wrapperPath: join(root, "bin", "tlh"),
          wrapperName: "tlh",
          updateTrack: "ref",
        },
        { homeDir },
      ),
    /refusing to place The Last Harness agent dir under normal Pi config root/,
  );
  assert.throws(
    () =>
      validateInstallerTargets(
        {
          agentDir: join(root, "agent"),
          binDir: join(homeDir, ".pi", "agent"),
          wrapperPath: join(homeDir, ".pi", "agent", "tlh"),
          wrapperName: "tlh",
          updateTrack: "ref",
        },
        { homeDir },
      ),
    /refusing to place The Last Harness wrapper dir under normal Pi config root/,
  );
  assert.throws(
    () =>
      validateInstallerTargets(
        {
          agentDir: join(root, "agent"),
          binDir: join(root, "bin"),
          wrapperPath: join(homeDir, ".pi", "agent", "tlh"),
          wrapperName: "tlh",
          updateTrack: "ref",
        },
        { homeDir },
      ),
    /refusing to place The Last Harness wrapper under normal Pi config root/,
  );
  assert.doesNotThrow(() =>
    validateInstallerTargets(
      {
        agentDir: join(root, "agent"),
        binDir: join(root, "bin"),
        wrapperPath: join(root, "bin", "tlh"),
        wrapperName: "tlh",
        updateTrack: "ref",
      },
      { homeDir },
    ),
  );
  assert.equal(existsSync(join(homeDir, ".pi")), false);

  assert.throws(
    () =>
      assertProfilePathWithinAgent(
        { agentDir: join(root, "agent") },
        join(root, "outside", "settings.json"),
        "test file",
        { homeDir },
      ),
    /refusing to write test file outside the isolated TLH profile/,
  );
});

test("safeProfileFileTarget rejects single-segment file targets", (t) => {
  const root = tempFixture(t);
  const agentDir = join(root, "agent");
  const homeDir = join(root, "home");
  mkdirSync(homeDir, { recursive: true });

  assert.throws(
    () => safeProfileFileTarget({ agentDir }, "settings.json", "test file", { homeDir }),
    /refusing unsafe test file: settings\.json/,
  );
  assert.equal(existsSync(agentDir), false);
  assert.equal(existsSync(join(agentDir, "settings.jso")), false);
});

test("writeSafeProfileFile writes root profile files with safe temp dirs and explicit modes", (t) => {
  const root = tempFixture(t);
  const agentDir = join(root, "agent");
  const homeDir = join(root, "home");
  const externalDir = join(root, "external");
  const legacyTempPath = join(agentDir, `settings.json.tmp-${process.pid}`);
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(externalDir, { recursive: true });
  symlinkSync(join(externalDir, "legacy-target.json"), legacyTempPath);

  writeSafeProfileFile(
    { agentDir },
    "settings.json",
    '{\n  "tlh": true\n}\n',
    "isolated settings",
    {
      homeDir,
      mode: 0o600,
    },
  );

  assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), '{\n  "tlh": true\n}\n');
  assert.equal(lstatSync(join(agentDir, "settings.json")).mode & 0o777, 0o600);
  assert.equal(lstatSync(legacyTempPath).isSymbolicLink(), true);
  assert.deepEqual(
    readdirSync(agentDir).filter((entry) => entry.startsWith(".settings.json.tmp.")),
    [],
  );
});

test("writeSafeProfileFile preserves existing file mode when overwriting", (t) => {
  const root = tempFixture(t);
  const agentDir = join(root, "agent");
  const homeDir = join(root, "home");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), "before\n", { mode: 0o640 });

  writeSafeProfileFile({ agentDir }, "settings.json", "after\n", "isolated settings", { homeDir });

  assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), "after\n");
  assert.equal(lstatSync(join(agentDir, "settings.json")).mode & 0o777, 0o640);
});

test(
  "writeSafeProfileFile preserves resolved modes under restrictive umask",
  { concurrency: false },
  (t) => {
    const root = tempFixture(t);
    const agentDir = join(root, "agent");
    const homeDir = join(root, "home");
    const explicitTarget = join(agentDir, "settings.json");
    const preservedTarget = join(agentDir, "state.json");
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });

    const previousUmask = process.umask(0o077);
    t.after(() => {
      process.umask(previousUmask);
    });

    writeSafeProfileFile(
      { agentDir },
      "settings.json",
      '{\n  "tlh": true\n}\n',
      "isolated settings",
      {
        homeDir,
        mode: 0o640,
      },
    );
    assert.equal(lstatSync(explicitTarget).mode & 0o777, 0o640);

    writeFileSync(preservedTarget, "before\n");
    chmodSync(preservedTarget, 0o640);
    writeSafeProfileFile({ agentDir }, "state.json", "after\n", "isolated state", { homeDir });
    assert.equal(readFileSync(preservedTarget, "utf8"), "after\n");
    assert.equal(lstatSync(preservedTarget).mode & 0o777, 0o640);
  },
);

test("writeSafeProfileFile rejects protected normal Pi targets before creating them", (t) => {
  const root = tempFixture(t);
  const homeDir = join(root, "home");
  const protectedAgentDir = join(homeDir, ".pi", "agent");
  mkdirSync(homeDir, { recursive: true });

  assert.throws(
    () =>
      writeSafeProfileFile(
        { agentDir: protectedAgentDir },
        "settings.json",
        "{}\n",
        "isolated settings",
        { homeDir },
      ),
    /refusing to write isolated settings parent directory under normal Pi config root/,
  );
  assert.equal(existsSync(protectedAgentDir), false);
  assert.equal(existsSync(join(homeDir, ".pi")), false);
});

test("writeSafeProfileFile rejects symlinked profile roots, parents, and final targets", (t) => {
  const root = tempFixture(t);
  const agentDir = join(root, "agent");
  const linkedAgentDir = join(root, "linked-agent");
  const homeDir = join(root, "home");
  const externalDir = join(root, "external");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(externalDir, { recursive: true });
  symlinkSync(externalDir, linkedAgentDir, "dir");
  symlinkSync(externalDir, join(agentDir, "nested"), "dir");

  assert.throws(
    () =>
      writeSafeProfileFile(
        { agentDir: linkedAgentDir },
        "settings.json",
        "{}\n",
        "isolated settings",
        { homeDir },
      ),
    /refusing to write isolated settings parent directory through symlinked TLH profile path/,
  );
  assert.throws(
    () =>
      writeSafeProfileFile(
        { agentDir: linkedAgentDir },
        "tlh/install-state.json",
        "{}\n",
        "install state",
        {
          homeDir,
        },
      ),
    /refusing to write install state parent directory through symlinked TLH profile path/,
  );
  assert.throws(
    () =>
      writeSafeProfileFile({ agentDir }, "nested/settings.json", "{}\n", "isolated settings", {
        homeDir,
      }),
    /refusing to write isolated settings parent directory through symlinked TLH profile path/,
  );
  assert.equal(existsSync(join(externalDir, "settings.json")), false);
  assert.equal(existsSync(join(externalDir, "tlh", "install-state.json")), false);

  symlinkSync(join(externalDir, "settings.json"), join(agentDir, "settings.json"));
  assert.throws(
    () =>
      writeSafeProfileFile({ agentDir }, "settings.json", "{}\n", "isolated settings", { homeDir }),
    /refusing to replace symlinked isolated settings/,
  );
  assert.equal(existsSync(join(externalDir, "settings.json")), false);
});

test("writeSafeProfileFile rejects temp target symlink swaps before commit", (t) => {
  const root = tempFixture(t);
  const agentDir = join(root, "agent");
  const homeDir = join(root, "home");
  const externalDir = join(root, "external");
  const target = join(agentDir, "settings.json");
  const attackerTarget = join(externalDir, "attacker-settings.json");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(externalDir, { recursive: true });
  writeFileSync(target, "original\n", { mode: 0o600 });
  writeFileSync(attackerTarget, "attacker\n");

  assert.throws(
    () =>
      writeSafeProfileFile({ agentDir }, "settings.json", "safe\n", "isolated settings", {
        homeDir,
        beforeCommit({ tempTarget }) {
          unlinkSync(tempTarget);
          symlinkSync(attackerTarget, tempTarget);
        },
      }),
    /refusing to commit unexpected temp file type/,
  );
  assert.equal(readFileSync(target, "utf8"), "original\n");
  assert.equal(lstatSync(target).isSymbolicLink(), false);
  assert.equal(readFileSync(attackerTarget, "utf8"), "attacker\n");
});

test("writeSafeProfileFile rejects temp dir swaps to attacker-controlled content", (t) => {
  const root = tempFixture(t);
  const agentDir = join(root, "agent");
  const homeDir = join(root, "home");
  const externalDir = join(root, "external");
  const target = join(agentDir, "settings.json");
  const externalTempTarget = join(externalDir, "settings.json");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(externalDir, { recursive: true });
  writeFileSync(target, "original\n", { mode: 0o600 });

  assert.throws(
    () =>
      writeSafeProfileFile({ agentDir }, "settings.json", "safe\n", "isolated settings", {
        homeDir,
        beforeCommit({ tempDir }) {
          rmSync(tempDir, { recursive: true, force: true });
          symlinkSync(externalDir, tempDir, "dir");
          writeFileSync(externalTempTarget, "attacker\n");
        },
      }),
    /refusing to commit unexpected temp directory type/,
  );
  assert.equal(readFileSync(target, "utf8"), "original\n");
  assert.equal(lstatSync(target).isSymbolicLink(), false);
  assert.equal(readFileSync(externalTempTarget, "utf8"), "attacker\n");
});

test("writeSafeProfileFile preserves temp dirs with unexpected extra content during cleanup", (t) => {
  const root = tempFixture(t);
  const agentDir = join(root, "agent");
  const homeDir = join(root, "home");
  let tempDirWithSentinel = "";
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  assert.throws(
    () =>
      writeSafeProfileFile({ agentDir }, "settings.json", "{}\n", "isolated settings", {
        homeDir,
        beforeCommit({ tempDir }) {
          tempDirWithSentinel = tempDir;
          writeFileSync(join(tempDir, "sentinel.txt"), "keep\n");
          throw new Error("stop before commit");
        },
      }),
    /stop before commit/,
  );
  assert.equal(existsSync(join(agentDir, "settings.json")), false);
  assert.equal(existsSync(join(tempDirWithSentinel, "settings.json")), false);
  assert.equal(readFileSync(join(tempDirWithSentinel, "sentinel.txt"), "utf8"), "keep\n");
});

test("writeSafeProfileFile skips cleanup when the helper temp dir path is recreated", (t) => {
  const root = tempFixture(t);
  const agentDir = join(root, "agent");
  const homeDir = join(root, "home");
  let recreatedTempDir = "";
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  assert.throws(
    () =>
      writeSafeProfileFile({ agentDir }, "settings.json", "{}\n", "isolated settings", {
        homeDir,
        beforeCommit({ tempDir }) {
          recreatedTempDir = tempDir;
          rmSync(tempDir, { recursive: true, force: true });
          mkdirSync(tempDir, { recursive: true });
          writeFileSync(join(tempDir, "sentinel.txt"), "keep\n");
        },
      }),
    /refusing to commit (replaced temp directory|missing temp file)/,
  );
  assert.equal(existsSync(join(agentDir, "settings.json")), false);
  assert.equal(readFileSync(join(recreatedTempDir, "sentinel.txt"), "utf8"), "keep\n");
});

test("writeSafeProfileFile detects swapped parents and avoids unsafe cleanup", (t) => {
  const root = tempFixture(t);
  const agentDir = join(root, "agent");
  const homeDir = join(root, "home");
  const externalDir = join(root, "external");
  let externalTempDir = "";
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(externalDir, { recursive: true });

  assert.throws(
    () =>
      writeSafeProfileFile({ agentDir }, "tlh/install-state.json", "{}\n", "TLH install state", {
        homeDir,
        beforeCommit({ parent, tempDir }) {
          externalTempDir = join(externalDir, basename(tempDir));
          rmSync(parent, { recursive: true, force: true });
          symlinkSync(externalDir, parent, "dir");
          mkdirSync(externalTempDir, { recursive: true });
          writeFileSync(join(externalTempDir, "sentinel.txt"), "keep\n");
        },
      }),
    /symlinked TLH profile path/,
  );
  assert.equal(existsSync(join(externalDir, "install-state.json")), false);
  assert.equal(readFileSync(join(externalTempDir, "sentinel.txt"), "utf8"), "keep\n");
});

test("writeSafeProfileFile preserves temp dirs when the profile root is moved aside and symlinked back", (t) => {
  const root = tempFixture(t);
  const agentDir = join(root, "agent");
  const movedAgentDir = join(root, "moved-agent");
  const homeDir = join(root, "home");
  let movedTempDir = "";
  let movedTempTarget = "";
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  assert.throws(
    () =>
      writeSafeProfileFile({ agentDir }, "settings.json", "safe\n", "isolated settings", {
        homeDir,
        beforeCommit({ tempDir }) {
          movedTempDir = join(movedAgentDir, basename(tempDir));
          movedTempTarget = join(movedTempDir, "settings.json");
          renameSync(agentDir, movedAgentDir);
          symlinkSync(movedAgentDir, agentDir, "dir");
        },
      }),
    /symlinked TLH profile path/,
  );
  assert.equal(lstatSync(agentDir).isSymbolicLink(), true);
  assert.equal(readFileSync(movedTempTarget, "utf8"), "safe\n");
  assert.equal(lstatSync(movedTempDir).isDirectory(), true);
});

test("ensureSafeProfileDir rejects protected profile roots before creating them", (t) => {
  const root = tempFixture(t);
  const homeDir = join(root, "home");
  const protectedAgentDir = join(homeDir, ".pi", "agent");
  mkdirSync(homeDir, { recursive: true });

  assert.throws(
    () =>
      ensureSafeProfileDir({ agentDir: protectedAgentDir }, "tlh", "test directory", { homeDir }),
    /refusing to write test directory under normal Pi config root/,
  );
  assert.equal(existsSync(protectedAgentDir), false);
  assert.equal(existsSync(join(homeDir, ".pi")), false);
});

test("refreshGitCheckout preserves ignored local files without creating backup refs", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  const warnings = [];
  const ignoredFile = join(targetDir, "build", "local.txt");

  mkdirSync(join(targetDir, "build"), { recursive: true });
  writeFileSync(ignoredFile, "keep me\n");

  refreshGitCheckout(
    { agentDir },
    {
      targetDir,
      repo: originDir,
      ref: "main",
      label: "test checkout",
      missingMessage: `missing checkout: ${targetDir}`,
    },
    gitCheckoutIo(warnings),
  );

  assert.equal(readFileSync(ignoredFile, "utf8"), "keep me\n");
  assert.deepEqual(listBackupRefs(targetDir), []);
  assert.equal(
    warnings.some((message) => message.includes("dirty checkout")),
    false,
  );
});

test("refreshGitCheckout keeps dirty-checkout backup output concise by default", (t) => {
  const { agentDir, targetDir, originDir } = createManagedGitCheckout(t);
  const warnings = [];

  writeFileSync(join(targetDir, "tracked.txt"), "tracked local\n");

  refreshGitCheckout(
    { agentDir },
    {
      targetDir,
      repo: originDir,
      ref: "main",
      label: "test checkout",
      missingMessage: `missing checkout: ${targetDir}`,
    },
    gitCheckoutIo(warnings),
  );

  const backupRefs = listBackupRefs(targetDir);
  assert.equal(backupRefs.length, 1);
  assert.equal(runGit(["-C", targetDir, "show", `${backupRefs[0]}:tracked.txt`]), "tracked local");
  assert.equal(readFileSync(join(targetDir, "tracked.txt"), "utf8"), "tracked v1\n");
  assert.equal(
    warnings.some(
      (message) => message.includes("dirty checkout") && message.includes(backupRefs[0]),
    ),
    true,
  );
  assert.equal(
    warnings.some((message) => message.includes("diff --git")),
    false,
  );
  assert.equal(
    warnings.some((message) => message.includes("@@")),
    false,
  );
});

test("refreshGitCheckout emits dirty-checkout diff details only in verbose mode", (t) => {
  const { agentDir, targetDir, originDir } = createManagedGitCheckout(t);
  const warnings = [];

  writeFileSync(join(targetDir, "tracked.txt"), "tracked local\n");

  refreshGitCheckout(
    { agentDir, verbose: true },
    {
      targetDir,
      repo: originDir,
      ref: "main",
      label: "test checkout",
      missingMessage: `missing checkout: ${targetDir}`,
    },
    gitCheckoutIo(warnings),
  );

  const backupRefs = listBackupRefs(targetDir);
  assert.equal(backupRefs.length, 1);
  assert.equal(
    warnings.some(
      (message) => message.includes("dirty checkout") && message.includes(backupRefs[0]),
    ),
    true,
  );
  assert.equal(
    warnings.some((message) => message.includes("diff --git a/tracked.txt b/tracked.txt")),
    true,
  );
  assert.equal(
    warnings.some(
      (message) => message.includes("-tracked v1") && message.includes("+tracked local"),
    ),
    true,
  );
});

test("refreshGitCheckout stays quiet about dirty-checkout backups in quiet mode", (t) => {
  const { agentDir, targetDir, originDir } = createManagedGitCheckout(t);
  const warnings = [];

  writeFileSync(join(targetDir, "tracked.txt"), "tracked local\n");

  refreshGitCheckout(
    { agentDir, quiet: true },
    {
      targetDir,
      repo: originDir,
      ref: "main",
      label: "test checkout",
      missingMessage: `missing checkout: ${targetDir}`,
    },
    gitCheckoutIo(warnings),
  );

  const backupRefs = listBackupRefs(targetDir);
  assert.equal(backupRefs.length, 1);
  assert.equal(runGit(["-C", targetDir, "show", `${backupRefs[0]}:tracked.txt`]), "tracked local");
  assert.equal(readFileSync(join(targetDir, "tracked.txt"), "utf8"), "tracked v1\n");
  assert.deepEqual(warnings, []);
});

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

test("settings defaults declare when bundled subagent prompts are required", (t) => {
  const root = tempFixture(t);
  const defaults = join(root, "settings.defaults.json");
  writeFileSync(defaults, JSON.stringify({ subagents: { agentDirs: ["tlh/agents/subagents"] } }));
  assert.equal(settingsRequireTlhSubagentPrompts(defaults), true);

  writeFileSync(defaults, JSON.stringify({ subagents: { agentDirs: ["other"] } }));
  assert.equal(settingsRequireTlhSubagentPrompts(defaults), false);

  writeFileSync(defaults, "not json");
  assert.equal(settingsRequireTlhSubagentPrompts(defaults), false);
});

test("subagentExtensionConfigMissingDefaults describes only writable defaults", (t) => {
  const agentDir = tempFixture(t, "tlh-ext-config-notice-");
  const config = { agentDir };
  const configPath = join(agentDir, "extensions", "subagent", "config.json");

  assert.deepEqual(
    subagentExtensionConfigMissingDefaults(config),
    ["toolDescriptionMode: compact", "control.activeNoticeAfterMs: 270000 (4m30)"],
    "missing config reports both defaults",
  );

  mkdirSync(join(agentDir, "extensions", "subagent"), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ control: null }) + "\n");
  assert.deepEqual(
    subagentExtensionConfigMissingDefaults(config),
    ["toolDescriptionMode: compact"],
    "non-object control reports only the writable tool-description default",
  );

  writeFileSync(configPath, JSON.stringify({ toolDescriptionMode: "full", control: null }) + "\n");
  assert.deepEqual(
    subagentExtensionConfigMissingDefaults(config),
    [],
    "complete writable defaults report no provisioning",
  );
});

test("provisionSubagentExtensionConfig sets TLH defaults independently and is idempotent", (t) => {
  const agentDir = tempFixture(t, "tlh-ext-config-test-");
  const config = { agentDir };
  const configPath = join(agentDir, "extensions", "subagent", "config.json");

  // Fresh install: config does not exist yet.
  provisionSubagentExtensionConfig(config);
  assert.ok(existsSync(configPath), "config.json created on first run");
  const created = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(created.toolDescriptionMode, "compact", "toolDescriptionMode set to compact");
  assert.deepEqual(
    created.control,
    { activeNoticeAfterMs: 270000 },
    "active notice default set to 4m30",
  );

  // Idempotent re-run: existing values must not change.
  provisionSubagentExtensionConfig(config);
  const afterRerun = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(afterRerun, created, "re-running leaves the completed config unchanged");

  // A user override is preserved while the independently missing default is added.
  writeFileSync(
    configPath,
    JSON.stringify({
      control: { activeNoticeAfterMs: 123456, nestedKey: "preserve" },
      topLevelKey: true,
    }) + "\n",
  );
  provisionSubagentExtensionConfig(config);
  const afterActiveNoticeOverride = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(
    afterActiveNoticeOverride.toolDescriptionMode,
    "compact",
    "compact added when toolDescriptionMode is missing",
  );
  assert.equal(
    afterActiveNoticeOverride.control.activeNoticeAfterMs,
    123456,
    "active notice override is preserved",
  );
  assert.equal(
    afterActiveNoticeOverride.control.nestedKey,
    "preserve",
    "nested control keys are preserved",
  );
  assert.equal(afterActiveNoticeOverride.topLevelKey, true, "top-level user keys are preserved");

  // The other direction is independent too: an existing tool override does not block
  // provisioning the missing active-notice default.
  writeFileSync(
    configPath,
    JSON.stringify({
      toolDescriptionMode: "full",
      control: { nestedKey: "preserve" },
    }) + "\n",
  );
  provisionSubagentExtensionConfig(config);
  const afterToolDescriptionOverride = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(
    afterToolDescriptionOverride.toolDescriptionMode,
    "full",
    "tool description override is preserved",
  );
  assert.equal(
    afterToolDescriptionOverride.control.activeNoticeAfterMs,
    270000,
    "active notice added independently",
  );
  assert.equal(
    afterToolDescriptionOverride.control.nestedKey,
    "preserve",
    "existing nested control keys remain",
  );

  // A malformed nested control value is preserved while the independently writable
  // tool-description default is still added.
  writeFileSync(configPath, JSON.stringify({ control: null, topLevelKey: "preserve" }) + "\n");
  provisionSubagentExtensionConfig(config);
  const afterNonObjectControl = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(
    afterNonObjectControl.toolDescriptionMode,
    "compact",
    "compact added with a non-object control value",
  );
  assert.equal(afterNonObjectControl.control, null, "non-object control value is preserved");
  assert.equal(afterNonObjectControl.topLevelKey, "preserve", "top-level key remains preserved");
});

test("provisionSubagentExtensionConfig preserves byte-for-byte non-object and unreadable configs", (t) => {
  const agentDir = tempFixture(t, "tlh-ext-config-noobj-");
  const config = { agentDir };
  const configDir = join(agentDir, "extensions", "subagent");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.json");

  // Array value — must be left byte-for-byte untouched.
  const arrayContent = "[]\n";
  writeFileSync(configPath, arrayContent);
  provisionSubagentExtensionConfig(config);
  assert.equal(
    readFileSync(configPath, "utf8"),
    arrayContent,
    "array config preserved byte-for-byte",
  );

  // null value — must be left byte-for-byte untouched.
  const nullContent = "null\n";
  writeFileSync(configPath, nullContent);
  provisionSubagentExtensionConfig(config);
  assert.equal(
    readFileSync(configPath, "utf8"),
    nullContent,
    "null config preserved byte-for-byte",
  );

  // Scalar value — must be left byte-for-byte untouched.
  const scalarContent = "42\n";
  writeFileSync(configPath, scalarContent);
  provisionSubagentExtensionConfig(config);
  assert.equal(
    readFileSync(configPath, "utf8"),
    scalarContent,
    "scalar config preserved byte-for-byte",
  );

  // Invalid JSON is unreadable and must also be left untouched.
  const invalidContent = "{ not-json\n";
  writeFileSync(configPath, invalidContent);
  provisionSubagentExtensionConfig(config);
  assert.equal(
    readFileSync(configPath, "utf8"),
    invalidContent,
    "unreadable config preserved byte-for-byte",
  );
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

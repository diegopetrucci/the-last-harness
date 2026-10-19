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
import { basename, dirname, join, resolve } from "node:path";
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
import {
  writeProfileFileWithBackup,
  writeSafeProfileFile,
} from "../scripts/lib/tlh-safe-profile-write.mjs";
function tempFixture(t, prefix = "tlh-install-lib-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
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

  return { root, agentDir, originDir, targetDir };
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

function npmInstallMarkerPath(targetDir) {
  return join(
    runGit(["-C", targetDir, "rev-parse", "--absolute-git-dir"]),
    "tlh-npm-install-complete.json",
  );
}

function trackingCheckoutIo(warnings, npmInstallCalls, { onNpmInstall } = {}) {
  return {
    runCommand(_config, commandArgs, options = {}) {
      const [command, ...args] = commandArgs;
      runCommand(command, args, {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
      });
    },
    runInDir(_config, dir, commandArgs) {
      npmInstallCalls.push([...commandArgs]);
      if (onNpmInstall) onNpmInstall(dir);
    },
    warn(message) {
      warnings.push(message);
    },
  };
}

function addPackageJsonToCheckout(targetDir, originDir) {
  runGit(["-C", targetDir, "config", "user.email", "tests@example.com"]);
  runGit(["-C", targetDir, "config", "user.name", "TLH Tests"]);
  writeFileSync(join(targetDir, ".gitignore"), "build/\nnode_modules/\n");
  writeFileSync(
    join(targetDir, "package.json"),
    JSON.stringify({ name: "test-pkg", version: "1.0.0" }) + "\n",
  );
  runGit(["-C", targetDir, "add", ".gitignore", "package.json"]);
  runGit(["-C", targetDir, "commit", "-m", "add package.json"]);
  runGit(["-C", targetDir, "push", originDir, "HEAD:main"]);
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

test("writeProfileFileWithBackup preserves backup bytes and modes", (t) => {
  const root = tempFixture(t);
  const agentDir = join(root, "agent");
  const profilePath = join(agentDir, "settings.json");
  const backupPath = join(agentDir, "settings.json.backup");
  const previousContent = Buffer.from([0x00, 0xff, 0x10, 0x80]);
  const nextContent = Buffer.from([0xfe, 0x01, 0x7f]);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(profilePath, previousContent, { mode: 0o640 });

  const result = writeProfileFileWithBackup(profilePath, nextContent, {
    targetLabel: "profile target",
    sourceLabel: "profile source",
    backupLabel: "profile backup",
    backupPath,
  });

  assert.equal(result, backupPath);
  assert.deepEqual(readFileSync(backupPath), previousContent);
  assert.deepEqual(readFileSync(profilePath), nextContent);
  assert.equal(lstatSync(backupPath).mode & 0o777, 0o640);
  assert.equal(lstatSync(profilePath).mode & 0o777, 0o640);
});

test("writeProfileFileWithBackup creates a target without a backup when none is requested", (t) => {
  const root = tempFixture(t);
  const agentDir = join(root, "agent");
  const profilePath = join(agentDir, "settings.json");
  const backupPath = join(agentDir, "settings.json.backup");
  const content = Buffer.from([0x00, 0xc3, 0x28]);
  mkdirSync(agentDir, { recursive: true });

  const result = writeProfileFileWithBackup(profilePath, content, {
    targetLabel: "profile target",
    sourceLabel: "profile source",
    backupLabel: "profile backup",
  });

  assert.equal(result, undefined);
  assert.deepEqual(readFileSync(profilePath), content);
  assert.equal(existsSync(backupPath), false);
});

test("writeProfileFileWithBackup does not write the target when its backup fails", (t) => {
  const root = tempFixture(t);
  const agentDir = join(root, "agent");
  const externalDir = join(root, "external");
  const profilePath = join(agentDir, "settings.json");
  const backupPath = join(agentDir, "settings.json.backup");
  const externalPath = join(externalDir, "external.json");
  const previousContent = Buffer.from("before\\n");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(externalDir, { recursive: true });
  writeFileSync(profilePath, previousContent, { mode: 0o640 });
  writeFileSync(externalPath, "external\\n");
  symlinkSync(externalPath, backupPath);

  assert.throws(
    () =>
      writeProfileFileWithBackup(profilePath, Buffer.from("after\\n"), {
        targetLabel: "profile target",
        sourceLabel: "profile source",
        backupLabel: "profile backup",
        backupPath,
      }),
    /refusing to replace symlinked profile backup/,
  );
  assert.deepEqual(readFileSync(profilePath), previousContent);
  assert.equal(lstatSync(backupPath).isSymbolicLink(), true);
  assert.equal(readFileSync(externalPath, "utf8"), "external\\n");
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

test("refreshGitCheckout reuses npm install only with a matching TLH marker", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  const warnings = [];
  const npmInstallCalls = [];

  addPackageJsonToCheckout(targetDir, originDir);
  const io = trackingCheckoutIo(warnings, npmInstallCalls, {
    onNpmInstall(dir) {
      rmSync(join(dir, "node_modules"), { recursive: true, force: true });
      mkdirSync(join(dir, "node_modules"), { recursive: true });
    },
  });
  const options = {
    targetDir,
    repo: originDir,
    ref: "main",
    label: "test checkout",
    missingMessage: `missing checkout: ${targetDir}`,
  };

  refreshGitCheckout({ agentDir }, options, io);

  const markerPath = npmInstallMarkerPath(targetDir);
  const head = runGit(["-C", targetDir, "rev-parse", "HEAD"]);
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  assert.equal(marker.schemaVersion, 2);
  assert.equal(marker.head, head);
  assert.deepEqual(marker.dependencyInputs.dependencies, {});
  assert.equal(npmInstallCalls.length, 1, "the first refresh must repair the absent marker");

  refreshGitCheckout({ agentDir }, options, io);

  assert.equal(
    npmInstallCalls.length,
    1,
    "an unchanged clean checkout with a matching marker must skip npm install",
  );
  assert.deepEqual(listBackupRefs(targetDir), []);
});

test("refreshGitCheckout repairs missing, malformed, mismatched, and non-directory npm state", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  const warnings = [];
  const npmInstallCalls = [];

  addPackageJsonToCheckout(targetDir, originDir);
  const io = trackingCheckoutIo(warnings, npmInstallCalls, {
    onNpmInstall(dir) {
      rmSync(join(dir, "node_modules"), { recursive: true, force: true });
      mkdirSync(join(dir, "node_modules"), { recursive: true });
    },
  });
  const options = {
    targetDir,
    repo: originDir,
    ref: "main",
    label: "test checkout",
    missingMessage: `missing checkout: ${targetDir}`,
  };
  const markerPath = npmInstallMarkerPath(targetDir);

  // No marker: a bare node_modules directory is deliberately insufficient.
  mkdirSync(join(targetDir, "node_modules"), { recursive: true });
  refreshGitCheckout({ agentDir }, options, io);
  assert.equal(npmInstallCalls.length, 1);

  writeFileSync(markerPath, "not json\n");
  refreshGitCheckout({ agentDir }, options, io);
  assert.equal(npmInstallCalls.length, 2);

  writeFileSync(markerPath, JSON.stringify({ schemaVersion: 1, head: "0".repeat(40) }) + "\n");
  refreshGitCheckout({ agentDir }, options, io);
  assert.equal(npmInstallCalls.length, 3);

  rmSync(join(targetDir, "node_modules"), { recursive: true, force: true });
  writeFileSync(join(targetDir, "node_modules"), "not a directory\n");
  refreshGitCheckout({ agentDir }, options, io);
  assert.equal(npmInstallCalls.length, 4);
});

test("refreshGitCheckout invalidates an old marker before a failed npm install", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  const warnings = [];
  const npmInstallCalls = [];

  addPackageJsonToCheckout(targetDir, originDir);
  mkdirSync(join(targetDir, "node_modules"), { recursive: true });
  const markerPath = npmInstallMarkerPath(targetDir);
  const head = runGit(["-C", targetDir, "rev-parse", "HEAD"]);
  writeFileSync(markerPath, JSON.stringify({ schemaVersion: 1, head }) + "\n");
  // A dirty checkout forces reconciliation even though the old marker matches.
  writeFileSync(join(targetDir, "tracked.txt"), "dirty local change\n");

  const failingIo = trackingCheckoutIo(warnings, npmInstallCalls, {
    onNpmInstall() {
      throw new Error("simulated npm failure");
    },
  });
  assert.throws(
    () =>
      refreshGitCheckout(
        { agentDir, quiet: true },
        {
          targetDir,
          repo: originDir,
          ref: "main",
          label: "test checkout",
          missingMessage: `missing checkout: ${targetDir}`,
        },
        failingIo,
      ),
    /simulated npm failure/,
  );
  assert.equal(existsSync(markerPath), false, "failed npm must not retain an old success marker");

  const repairCalls = [];
  refreshGitCheckout(
    { agentDir, quiet: true },
    {
      targetDir,
      repo: originDir,
      ref: "main",
      label: "test checkout",
      missingMessage: `missing checkout: ${targetDir}`,
    },
    trackingCheckoutIo([], repairCalls, {
      onNpmInstall(dir) {
        mkdirSync(join(dir, "node_modules"), { recursive: true });
      },
    }),
  );
  assert.equal(repairCalls.length, 1, "the next refresh must repair after the failed install");
});

test("refreshGitCheckout stores its marker in the resolved Git directory", (t) => {
  const { root, agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  addPackageJsonToCheckout(targetDir, originDir);
  const separateTarget = join(root, "agent", "git", "github.com", "owner", "separate");
  const separateGitDir = join(root, "agent", "git-metadata", "separate.git");
  mkdirSync(dirname(separateGitDir), { recursive: true });
  runGit(["clone", "--separate-git-dir", separateGitDir, originDir, separateTarget]);
  assert.equal(lstatSync(join(separateTarget, ".git")).isFile(), true);

  const npmInstallCalls = [];
  const options = {
    targetDir: separateTarget,
    repo: originDir,
    ref: "main",
    label: "separate test checkout",
    missingMessage: `missing checkout: ${separateTarget}`,
  };
  const io = trackingCheckoutIo([], npmInstallCalls, {
    onNpmInstall(dir) {
      mkdirSync(join(dir, "node_modules"), { recursive: true });
    },
  });

  refreshGitCheckout({ agentDir }, options, io);
  const markerPath = npmInstallMarkerPath(separateTarget);
  assert.equal(markerPath, join(realpathSync(separateGitDir), "tlh-npm-install-complete.json"));

  refreshGitCheckout({ agentDir }, options, io);
  assert.equal(npmInstallCalls.length, 1);
});

test("refreshGitCheckout refuses a symlinked completion marker", (t) => {
  const { root, agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  addPackageJsonToCheckout(targetDir, originDir);
  mkdirSync(join(targetDir, "node_modules"), { recursive: true });

  const markerPath = npmInstallMarkerPath(targetDir);
  const externalMarkerPath = join(root, "external-marker.json");
  writeFileSync(externalMarkerPath, "keep this external file\n");
  symlinkSync(externalMarkerPath, markerPath);

  const npmInstallCalls = [];
  assert.throws(
    () =>
      refreshGitCheckout(
        { agentDir },
        {
          targetDir,
          repo: originDir,
          ref: "main",
          label: "test checkout",
          missingMessage: `missing checkout: ${targetDir}`,
        },
        trackingCheckoutIo([], npmInstallCalls, {
          onNpmInstall(dir) {
            mkdirSync(join(dir, "node_modules"), { recursive: true });
          },
        }),
      ),
    /refusing to invalidate symlinked npm install marker.*remove the symlink.*rerun the installer/,
  );

  assert.equal(readFileSync(externalMarkerPath, "utf8"), "keep this external file\n");
  assert.equal(lstatSync(markerPath).isSymbolicLink(), true);
  assert.equal(npmInstallCalls.length, 0);
});

test("refreshGitCheckout forces npm install when a direct dependency directory is missing from node_modules", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  const warnings = [];
  const npmInstallCalls = [];

  // Add a package.json with a direct production dependency.
  runGit(["-C", targetDir, "config", "user.email", "tests@example.com"]);
  runGit(["-C", targetDir, "config", "user.name", "TLH Tests"]);
  writeFileSync(join(targetDir, ".gitignore"), "build/\nnode_modules/\n");
  writeFileSync(
    join(targetDir, "package.json"),
    JSON.stringify({ name: "test-pkg", version: "1.0.0", dependencies: { "some-dep": "^1.0.0" } }) +
      "\n",
  );
  runGit(["-C", targetDir, "add", ".gitignore", "package.json"]);
  runGit(["-C", targetDir, "commit", "-m", "add package.json with dep"]);
  runGit(["-C", targetDir, "push", originDir, "HEAD:main"]);

  const io = trackingCheckoutIo(warnings, npmInstallCalls, {
    onNpmInstall(dir) {
      // Simulate npm install: create node_modules with the dep directory.
      mkdirSync(join(dir, "node_modules", "some-dep"), { recursive: true });
    },
  });
  const options = {
    targetDir,
    repo: originDir,
    ref: "main",
    label: "test checkout",
    missingMessage: `missing checkout: ${targetDir}`,
  };

  // First refresh: installs and writes marker.
  refreshGitCheckout({ agentDir }, options, io);
  const markerPath = npmInstallMarkerPath(targetDir);
  const head = runGit(["-C", targetDir, "rev-parse", "HEAD"]);
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  assert.equal(marker.schemaVersion, 2);
  assert.equal(marker.head, head);
  assert.deepEqual(marker.dependencyInputs.dependencies, { "some-dep": "^1.0.0" });
  assert.equal(npmInstallCalls.length, 1);

  // Second refresh: all gates pass, including the dependency directory — reuse.
  refreshGitCheckout({ agentDir }, options, io);
  assert.equal(npmInstallCalls.length, 1, "reuse must skip npm install when dep dir is present");

  // Now remove the dep directory to simulate partial deletion.
  rmSync(join(targetDir, "node_modules", "some-dep"), { recursive: true, force: true });

  // Third refresh: missing dep directory must force reinstall and rewrite marker.
  refreshGitCheckout({ agentDir }, options, io);
  assert.equal(
    npmInstallCalls.length,
    2,
    "a missing direct dependency directory must force npm install",
  );
  const repairedMarker = JSON.parse(readFileSync(markerPath, "utf8"));
  assert.equal(repairedMarker.schemaVersion, 2);
  assert.equal(repairedMarker.head, head);
  assert.deepEqual(repairedMarker.dependencyInputs.dependencies, { "some-dep": "^1.0.0" });
});

test("refreshGitCheckout forces npm install when a scoped direct dependency directory is missing", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  const npmInstallCalls = [];

  runGit(["-C", targetDir, "config", "user.email", "tests@example.com"]);
  runGit(["-C", targetDir, "config", "user.name", "TLH Tests"]);
  writeFileSync(join(targetDir, ".gitignore"), "build/\nnode_modules/\n");
  writeFileSync(
    join(targetDir, "package.json"),
    JSON.stringify({
      name: "test-pkg",
      version: "1.0.0",
      dependencies: { "@scope/scoped-dep": "^2.0.0" },
    }) + "\n",
  );
  runGit(["-C", targetDir, "add", ".gitignore", "package.json"]);
  runGit(["-C", targetDir, "commit", "-m", "add package.json with scoped dep"]);
  runGit(["-C", targetDir, "push", originDir, "HEAD:main"]);

  const io = trackingCheckoutIo([], npmInstallCalls, {
    onNpmInstall(dir) {
      mkdirSync(join(dir, "node_modules", "@scope", "scoped-dep"), { recursive: true });
    },
  });
  const options = {
    targetDir,
    repo: originDir,
    ref: "main",
    label: "test checkout",
    missingMessage: `missing checkout: ${targetDir}`,
  };

  // First refresh installs, creating the scoped dep directory.
  refreshGitCheckout({ agentDir }, options, io);
  assert.equal(npmInstallCalls.length, 1);

  // Second refresh: scoped dep directory present — reuse.
  refreshGitCheckout({ agentDir }, options, io);
  assert.equal(npmInstallCalls.length, 1, "reuse must work for scoped dep when dir is present");

  // Remove the scoped dep directory.
  rmSync(join(targetDir, "node_modules", "@scope"), { recursive: true, force: true });

  // Third refresh: missing scoped dep must force reinstall.
  refreshGitCheckout({ agentDir }, options, io);
  assert.equal(npmInstallCalls.length, 2, "a missing scoped dep directory must force npm install");
});

test("refreshGitCheckout reuses npm install when all direct dependencies are present", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  const npmInstallCalls = [];

  runGit(["-C", targetDir, "config", "user.email", "tests@example.com"]);
  runGit(["-C", targetDir, "config", "user.name", "TLH Tests"]);
  writeFileSync(join(targetDir, ".gitignore"), "build/\nnode_modules/\n");
  writeFileSync(
    join(targetDir, "package.json"),
    JSON.stringify({
      name: "test-pkg",
      version: "1.0.0",
      dependencies: { "dep-a": "^1.0.0", "dep-b": "^2.0.0" },
      devDependencies: { "dev-only": "^3.0.0" },
      optionalDependencies: { "opt-dep": "^4.0.0" },
    }) + "\n",
  );
  runGit(["-C", targetDir, "add", ".gitignore", "package.json"]);
  runGit(["-C", targetDir, "commit", "-m", "add package.json with multiple deps"]);
  runGit(["-C", targetDir, "push", originDir, "HEAD:main"]);

  const io = trackingCheckoutIo([], npmInstallCalls, {
    onNpmInstall(dir) {
      // Install only production deps (--omit=dev); optionalDependencies absent.
      mkdirSync(join(dir, "node_modules", "dep-a"), { recursive: true });
      mkdirSync(join(dir, "node_modules", "dep-b"), { recursive: true });
    },
  });
  const options = {
    targetDir,
    repo: originDir,
    ref: "main",
    label: "test checkout",
    missingMessage: `missing checkout: ${targetDir}`,
  };

  refreshGitCheckout({ agentDir }, options, io);
  assert.equal(npmInstallCalls.length, 1);

  // All production dep dirs present; devDependencies and absent optionalDependencies must not block reuse.
  refreshGitCheckout({ agentDir }, options, io);
  assert.equal(
    npmInstallCalls.length,
    1,
    "reuse must work when all production dep dirs are present and optional ones absent",
  );
});

test("refreshGitCheckout forces npm install when checkout package.json is malformed or missing", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  const npmInstallCalls = [];
  const markerPath = npmInstallMarkerPath(targetDir);

  runGit(["-C", targetDir, "config", "user.email", "tests@example.com"]);
  runGit(["-C", targetDir, "config", "user.name", "TLH Tests"]);
  writeFileSync(join(targetDir, ".gitignore"), "build/\nnode_modules/\n");
  // Start with a valid package.json that has no dependencies.
  writeFileSync(
    join(targetDir, "package.json"),
    JSON.stringify({ name: "test-pkg", version: "1.0.0" }) + "\n",
  );
  runGit(["-C", targetDir, "add", ".gitignore", "package.json"]);
  runGit(["-C", targetDir, "commit", "-m", "initial package.json"]);
  runGit(["-C", targetDir, "push", originDir, "HEAD:main"]);

  const io = trackingCheckoutIo([], npmInstallCalls, {
    onNpmInstall(dir) {
      mkdirSync(join(dir, "node_modules"), { recursive: true });
    },
  });
  const options = {
    targetDir,
    repo: originDir,
    ref: "main",
    label: "test checkout",
    missingMessage: `missing checkout: ${targetDir}`,
  };

  // First refresh: installs normally.
  refreshGitCheckout({ agentDir }, options, io);
  assert.equal(npmInstallCalls.length, 1);
  // Valid second refresh: reuse.
  refreshGitCheckout({ agentDir }, options, io);
  assert.equal(npmInstallCalls.length, 1);

  // Corrupt the in-tree package.json (git clean will restore the committed version,
  // so we corrupt the committed version by amending).
  writeFileSync(join(targetDir, "package.json"), "not valid json\n");
  runGit(["-C", targetDir, "add", "package.json"]);
  runGit(["-C", targetDir, "commit", "--amend", "--no-edit"]);
  runGit(["-C", targetDir, "push", "--force", originDir, "HEAD:main"]);

  // Force a dirty state so wasClean is false and the checkout updates the tree.
  writeFileSync(join(targetDir, "extra.txt"), "dirty\n");
  // Also reset the marker to the old head so it would otherwise match.
  const oldHead = runGit(["-C", targetDir, "rev-parse", "HEAD"]);
  writeFileSync(markerPath, JSON.stringify({ schemaVersion: 1, head: oldHead }) + "\n");

  refreshGitCheckout({ agentDir }, options, io);
  assert.equal(
    npmInstallCalls.length,
    2,
    "a malformed package.json must force npm install even when the marker would match",
  );
});

test("refreshGitCheckout reuses npm install when optionalDependencies are absent from node_modules", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  const npmInstallCalls = [];

  runGit(["-C", targetDir, "config", "user.email", "tests@example.com"]);
  runGit(["-C", targetDir, "config", "user.name", "TLH Tests"]);
  writeFileSync(join(targetDir, ".gitignore"), "build/\nnode_modules/\n");
  writeFileSync(
    join(targetDir, "package.json"),
    JSON.stringify({
      name: "test-pkg",
      version: "1.0.0",
      dependencies: { "prod-dep": "^1.0.0" },
      optionalDependencies: { "opt-dep": "^2.0.0" },
    }) + "\n",
  );
  runGit(["-C", targetDir, "add", ".gitignore", "package.json"]);
  runGit(["-C", targetDir, "commit", "-m", "add package.json with optional dep"]);
  runGit(["-C", targetDir, "push", originDir, "HEAD:main"]);

  const io = trackingCheckoutIo([], npmInstallCalls, {
    onNpmInstall(dir) {
      // opt-dep intentionally not installed (e.g. platform-incompatible optional).
      mkdirSync(join(dir, "node_modules", "prod-dep"), { recursive: true });
    },
  });
  const options = {
    targetDir,
    repo: originDir,
    ref: "main",
    label: "test checkout",
    missingMessage: `missing checkout: ${targetDir}`,
  };

  refreshGitCheckout({ agentDir }, options, io);
  assert.equal(npmInstallCalls.length, 1);

  // Reuse must succeed: opt-dep absent from node_modules must not block it.
  refreshGitCheckout({ agentDir }, options, io);
  assert.equal(
    npmInstallCalls.length,
    1,
    "absent optionalDependency directory must not block npm install reuse",
  );
});

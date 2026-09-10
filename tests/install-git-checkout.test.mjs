import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  cleanupGitCheckoutPreparation,
  finalizeGitCheckout,
  installManagedGitCheckout,
  prepareGitCheckout,
  refreshGitCheckout,
} from "../scripts/lib/tlh-install-git.mjs";

function tempFixture(t, prefix = "tlh-install-git-test-") {
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
  const root = tempFixture(t);
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

function checkoutOptions(targetDir, originDir, extra = {}) {
  return {
    targetDir,
    repo: originDir,
    label: "test checkout",
    missingMessage: `missing checkout: ${targetDir}`,
    ...extra,
  };
}

function recordingCheckoutIo(warnings = [], commands = []) {
  return {
    runCommand(_config, commandArgs, options = {}) {
      commands.push({ args: [...commandArgs], options: { ...options } });
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

function realGitPath(targetDir, gitPath) {
  return gitPath.startsWith("/") ? gitPath : resolve(targetDir, gitPath);
}

function npmTrackingIo(npmCalls, onInstall, events = [], commands = []) {
  return {
    ...recordingCheckoutIo([], commands),
    runInDir(_config, dir, commandArgs) {
      npmCalls.push({ dir, args: [...commandArgs] });
      onInstall?.(dir, commandArgs);
    },
    onInstrumentationEvent(event) {
      events.push({ ...event });
    },
  };
}

function observeRestoreTempPaths(run) {
  const observedPaths = [];
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = (path, ...args) => {
    if (typeof path === "string" && path.includes(".tlh-restore-")) {
      observedPaths.push(path);
    }
    return originalWriteFileSync(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    run();
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    syncBuiltinESMExports();
  }
  return observedPaths;
}

function addDependencyPackage(targetDir, originDir, dependencies = { "some-dep": "^1.0.0" }) {
  runGit(["-C", targetDir, "config", "user.email", "tests@example.com"]);
  runGit(["-C", targetDir, "config", "user.name", "TLH Tests"]);
  writeFileSync(join(targetDir, ".gitignore"), "node_modules/\n");
  writeFileSync(
    join(targetDir, "package.json"),
    `${JSON.stringify({ name: "test-pkg", version: "1.0.0", dependencies })}\n`,
  );
  runGit(["-C", targetDir, "add", ".gitignore", "package.json"]);
  runGit(["-C", targetDir, "commit", "-m", "add package manifest"]);
  runGit(["-C", targetDir, "push", originDir, "HEAD:main"]);
}

function checkoutIndexPath(targetDir) {
  return realGitPath(targetDir, runGit(["-C", targetDir, "rev-parse", "--git-path", "index"]));
}

function createPnpmLink(dir, packageName) {
  const nodeModulesDir = join(dir, "node_modules");
  const storePackageDir = join(
    nodeModulesDir,
    ".pnpm",
    `${packageName.replace(/[\\/@]/g, "+")}@1.0.0`,
    "node_modules",
    packageName,
  );
  mkdirSync(storePackageDir, { recursive: true });
  writeFileSync(join(storePackageDir, "package.json"), JSON.stringify({ name: packageName }));
  const directPath = join(nodeModulesDir, packageName);
  mkdirSync(dirname(directPath), { recursive: true });
  symlinkSync(resolve(storePackageDir), directPath, "dir");
}

test("prepare/finalize preserves ignored files and performs no package-manager work", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  const warnings = [];
  const commands = [];
  const io = recordingCheckoutIo(warnings, commands);
  const ignoredFile = join(targetDir, "build", "local.txt");
  mkdirSync(join(targetDir, "build"), { recursive: true });
  writeFileSync(ignoredFile, "keep me\n");

  const preparation = prepareGitCheckout({ agentDir }, checkoutOptions(targetDir, originDir), io);
  assert.equal(preparation.status, "clean");
  assert.equal(
    finalizeGitCheckout({ agentDir }, checkoutOptions(targetDir, originDir), preparation, io),
    true,
  );

  assert.equal(readFileSync(ignoredFile, "utf8"), "keep me\n");
  assert.deepEqual(listBackupRefs(targetDir), []);
  assert.deepEqual(
    commands.filter(({ args }) => args.includes("fetch") || args.includes("npm")),
    [],
  );
  assert.deepEqual(warnings, []);
});

test("finalization preserves root node_modules while cleaning unrelated untracked files", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  const preparation = prepareGitCheckout(
    { agentDir },
    checkoutOptions(targetDir, originDir),
    recordingCheckoutIo(),
  );
  const dependencyOutput = join(targetDir, "node_modules", "some-dependency", "index.js");
  mkdirSync(dirname(dependencyOutput), { recursive: true });
  writeFileSync(dependencyOutput, "package-manager output\n");
  const unrelatedFile = join(targetDir, "unrelated-untracked.txt");
  writeFileSync(unrelatedFile, "remove me\n");

  assert.equal(
    finalizeGitCheckout(
      { agentDir },
      checkoutOptions(targetDir, originDir),
      preparation,
      recordingCheckoutIo(),
    ),
    true,
  );

  assert.equal(readFileSync(dependencyOutput, "utf8"), "package-manager output\n");
  assert.equal(existsSync(unrelatedFile), false);
});

test("prepare backs up dirty content, cleans it, and preserves the real index", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  const warnings = [];
  const io = recordingCheckoutIo(warnings);
  const indexPath = realGitPath(
    targetDir,
    runGit(["-C", targetDir, "rev-parse", "--git-path", "index"]),
  );
  const originalHead = runGit(["-C", targetDir, "rev-parse", "HEAD"]);
  runGit(["-C", targetDir, "update-ref", "refs/tlh-backup/keep", originalHead]);

  writeFileSync(join(targetDir, "tracked.txt"), "staged content\n");
  runGit(["-C", targetDir, "add", "tracked.txt"]);
  writeFileSync(join(targetDir, "tracked.txt"), "unstaged content\n");
  writeFileSync(join(targetDir, "untracked.txt"), "untracked content\n");
  const indexBefore = readFileSync(indexPath);

  const preparation = prepareGitCheckout({ agentDir }, checkoutOptions(targetDir, originDir), io);
  assert.equal(preparation.status, "dirty");
  assert.ok(preparation.indexFile);
  assert.equal(preparation.indexFile.startsWith(agentDir), false);
  assert.deepEqual(readFileSync(indexPath), indexBefore);
  assert.equal(readFileSync(join(targetDir, "tracked.txt"), "utf8"), "tracked v1\n");
  assert.equal(existsSync(join(targetDir, "untracked.txt")), false);

  const backupRefs = listBackupRefs(targetDir);
  assert.equal(backupRefs.length, 2);
  assert.equal(backupRefs.includes("refs/tlh-backup/keep"), true);
  const newBackupRef = backupRefs.find((ref) => ref !== "refs/tlh-backup/keep");
  assert.ok(newBackupRef);
  assert.equal(
    runGit(["-C", targetDir, "show", `${newBackupRef}:tracked.txt`]),
    "unstaged content",
  );
  assert.equal(
    runGit(["-C", targetDir, "show", `${newBackupRef}:untracked.txt`]),
    "untracked content",
  );

  assert.equal(
    finalizeGitCheckout({ agentDir }, checkoutOptions(targetDir, originDir), preparation, io),
    true,
  );
  assert.deepEqual(readFileSync(indexPath), indexBefore);
  assert.equal(runGit(["-C", targetDir, "rev-parse", "--abbrev-ref", "HEAD"]), "HEAD");
  assert.equal(existsSync(preparation.indexFile), false);
  assert.match(warnings[0], /dirty checkout/);
  assert.throws(
    () => finalizeGitCheckout({ agentDir }, checkoutOptions(targetDir, originDir), preparation, io),
    /already been consumed.*prepareGitCheckout/,
  );
});

test(
  "prepare does not leak its alternate index to a foreign clone process",
  { concurrency: false },
  (t) => {
    const previousIndex = process.env.GIT_INDEX_FILE;
    delete process.env.GIT_INDEX_FILE;
    try {
      const { agentDir, originDir, targetDir, root } = createManagedGitCheckout(t);
      const preparation = prepareGitCheckout(
        { agentDir },
        checkoutOptions(targetDir, originDir),
        recordingCheckoutIo(),
      );
      assert.equal(process.env.GIT_INDEX_FILE, undefined);

      const foreignTarget = join(root, "foreign-repo");
      const foreignClone = spawnSync("git", ["clone", originDir, foreignTarget], {
        encoding: "utf8",
        env: process.env,
      });
      assert.equal(foreignClone.status, 0, foreignClone.stderr || foreignClone.stdout);
      assert.equal(existsSync(join(foreignTarget, "tracked.txt")), true);

      finalizeGitCheckout(
        { agentDir },
        checkoutOptions(targetDir, originDir),
        preparation,
        recordingCheckoutIo(),
      );
    } finally {
      if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = previousIndex;
    }
  },
);

test(
  "legacy refresh scrubs an ambient foreign index while preserving dirty backup content",
  { concurrency: false },
  (t) => {
    const { root, agentDir, originDir, targetDir } = createManagedGitCheckout(t);
    const foreignTarget = join(root, "foreign-repo");
    runGit(["clone", originDir, foreignTarget]);
    const foreignIndex = realGitPath(
      foreignTarget,
      runGit(["-C", foreignTarget, "rev-parse", "--git-path", "index"]),
    );
    const foreignIndexBefore = readFileSync(foreignIndex);

    writeFileSync(join(targetDir, "tracked.txt"), "legacy tracked change\n");
    writeFileSync(join(targetDir, "legacy-untracked.txt"), "legacy untracked change\n");

    const previousIndex = process.env.GIT_INDEX_FILE;
    let backupRefs;
    try {
      process.env.GIT_INDEX_FILE = foreignIndex;
      refreshGitCheckout(
        { agentDir },
        {
          targetDir,
          repo: originDir,
          ref: "main",
          label: "test checkout",
          missingMessage: `missing checkout: ${targetDir}`,
        },
        gitCheckoutIo([]),
      );
      backupRefs = listBackupRefs(targetDir);
    } finally {
      if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = previousIndex;
    }

    assert.equal(backupRefs.length, 1);
    assert.equal(
      runGit(["-C", targetDir, "show", `${backupRefs[0]}:tracked.txt`]),
      "legacy tracked change",
    );
    assert.equal(
      runGit(["-C", targetDir, "show", `${backupRefs[0]}:legacy-untracked.txt`]),
      "legacy untracked change",
    );
    assert.deepEqual(readFileSync(foreignIndex), foreignIndexBefore);
  },
);

test("finalization trusts Pi-selected HEAD instead of stale tags or FETCH_HEAD", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  const oldHead = runGit(["-C", targetDir, "rev-parse", "HEAD"]);
  writeFileSync(join(targetDir, "tracked.txt"), "selected commit\n");
  runGit(["-C", targetDir, "add", "tracked.txt"]);
  runGit(["-C", targetDir, "commit", "-m", "selected commit"]);
  const selectedHead = runGit(["-C", targetDir, "rev-parse", "HEAD"]);
  runGit(["-C", targetDir, "reset", "--hard", oldHead]);
  runGit(["-C", targetDir, "tag", "-f", "release", oldHead]);
  writeFileSync(join(targetDir, ".git", "FETCH_HEAD"), `${oldHead}\t\tnot-a-real-ref\n`);

  const commands = [];
  const io = recordingCheckoutIo([], commands);
  const preparation = prepareGitCheckout({ agentDir }, checkoutOptions(targetDir, originDir), io);
  runGit(["-C", targetDir, "reset", "--hard", selectedHead], {
    env: { ...process.env, GIT_INDEX_FILE: preparation.indexFile },
  });
  assert.equal(
    finalizeGitCheckout({ agentDir }, checkoutOptions(targetDir, originDir), preparation, io),
    true,
  );

  assert.equal(runGit(["-C", targetDir, "rev-parse", "HEAD"]), selectedHead);
  assert.equal(runGit(["-C", targetDir, "rev-parse", "--abbrev-ref", "HEAD"]), "HEAD");
  assert.deepEqual(
    commands.filter(({ args }) => args.includes("fetch") || args.includes("npm")),
    [],
  );
});

test("alternate and separate Git directories keep the real index untouched", (t) => {
  const { root, agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  rmSync(targetDir, { recursive: true, force: true });
  const separateGitDir = join(agentDir, "git-metadata", "repo.git");
  mkdirSync(dirname(separateGitDir), { recursive: true });
  runGit(["clone", "--separate-git-dir", separateGitDir, originDir, targetDir]);
  assert.equal(lstatSync(join(targetDir, ".git")).isFile(), true);

  const indexPath = realGitPath(
    targetDir,
    runGit(["-C", targetDir, "rev-parse", "--git-path", "index"]),
  );
  writeFileSync(join(targetDir, "tracked.txt"), "local change\n");
  runGit(["-C", targetDir, "add", "tracked.txt"]);
  const indexBefore = readFileSync(indexPath);
  const preparation = prepareGitCheckout(
    { agentDir },
    checkoutOptions(targetDir, originDir),
    recordingCheckoutIo(),
  );

  assert.equal(preparation.status, "dirty");
  assert.deepEqual(readFileSync(indexPath), indexBefore);
  assert.equal(
    finalizeGitCheckout(
      { agentDir },
      checkoutOptions(targetDir, originDir),
      preparation,
      recordingCheckoutIo(),
    ),
    true,
  );
  assert.deepEqual(readFileSync(indexPath), indexBefore);
  assert.equal(realpathSync(preparation.gitDir), realpathSync(separateGitDir));
  assert.equal(existsSync(join(root, "outside")), false);
});

test("origin is normalized before Pi without consulting local refs", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  const wrongOrigin = join(dirname(originDir), "wrong.git");
  runGit(["-C", targetDir, "remote", "set-url", "origin", wrongOrigin]);
  const commands = [];
  const preparation = prepareGitCheckout(
    { agentDir },
    checkoutOptions(targetDir, originDir),
    recordingCheckoutIo([], commands),
  );
  assert.equal(runGit(["-C", targetDir, "remote", "get-url", "origin"]), originDir);
  assert.equal(
    finalizeGitCheckout(
      { agentDir },
      checkoutOptions(targetDir, originDir),
      preparation,
      recordingCheckoutIo(),
    ),
    true,
  );
  assert.equal(
    commands.some(({ args }) => args.includes("remote") && args.includes("set-url")),
    true,
  );
  assert.equal(
    commands.some(({ args }) => args.includes("fetch")),
    false,
  );
});

test("malformed checkouts with TLH backup refs are refused without losing the refs", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  const head = runGit(["-C", targetDir, "rev-parse", "HEAD"]);
  runGit(["-C", targetDir, "update-ref", "refs/tlh-backup/keep", head]);
  const indexPath = realGitPath(
    targetDir,
    runGit(["-C", targetDir, "rev-parse", "--git-path", "index"]),
  );
  writeFileSync(indexPath, "malformed index\n");

  assert.throws(
    () =>
      prepareGitCheckout(
        { agentDir },
        checkoutOptions(targetDir, originDir),
        recordingCheckoutIo(),
      ),
    /refusing destructive repair of malformed.*backup refs/,
  );
  assert.deepEqual(listBackupRefs(targetDir), ["refs/tlh-backup/keep"]);
});

test("corrupt index without backup refs returns an actionable non-destructive status", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  const indexPath = realGitPath(
    targetDir,
    runGit(["-C", targetDir, "rev-parse", "--git-path", "index"]),
  );
  writeFileSync(indexPath, "malformed index\n");
  const warnings = [];
  const preparation = prepareGitCheckout(
    { agentDir },
    checkoutOptions(targetDir, originDir),
    recordingCheckoutIo(warnings),
  );

  assert.equal(preparation.status, "malformed");
  assert.match(
    warnings[0],
    /no TLH backup refs were found.*Repair the Git index or checkout manually/,
  );
  assert.deepEqual(readFileSync(indexPath, "utf8"), "malformed index\n");
  assert.deepEqual(listBackupRefs(targetDir), []);
});

test("finalization rejects a preparation for a different checkout target", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  const otherTarget = join(agentDir, "git", "github.com", "owner", "other-repo");
  mkdirSync(dirname(otherTarget), { recursive: true });
  runGit(["clone", originDir, otherTarget]);
  const preparation = prepareGitCheckout(
    { agentDir },
    checkoutOptions(targetDir, originDir),
    recordingCheckoutIo(),
  );

  assert.throws(
    () =>
      finalizeGitCheckout(
        { agentDir },
        checkoutOptions(otherTarget, originDir),
        preparation,
        recordingCheckoutIo(),
      ),
    /different checkout target/,
  );
  assert.equal(existsSync(preparation.indexFile), false);
  assert.equal(runGit(["-C", otherTarget, "rev-parse", "--abbrev-ref", "HEAD"]), "main");
});

test("cleanup ignores caller-supplied paths outside its temporary index namespace", (t) => {
  const root = tempFixture(t);
  const victimDir = join(root, "victim");
  mkdirSync(victimDir, { recursive: true });
  writeFileSync(join(victimDir, "keep.txt"), "keep\n");

  cleanupGitCheckoutPreparation({
    targetDir: join(root, "target"),
    status: "clean",
    indexFile: join(victimDir, "index"),
  });
  assert.equal(existsSync(join(victimDir, "keep.txt")), true);
});

test("missing checkouts can be finalized after Pi creates them", (t) => {
  const { root, agentDir, originDir } = createManagedGitCheckout(t);
  const targetDir = join(agentDir, "git", "github.com", "owner", "new-repo");
  rmSync(targetDir, { recursive: true, force: true });
  const options = checkoutOptions(targetDir, originDir);
  const preparation = prepareGitCheckout({ agentDir }, options, recordingCheckoutIo());
  assert.equal(preparation.status, "missing");
  mkdirSync(dirname(targetDir), { recursive: true });
  runGit(["clone", originDir, targetDir]);
  assert.equal(
    finalizeGitCheckout({ agentDir }, options, preparation, recordingCheckoutIo()),
    true,
  );
  assert.equal(
    existsSync(join(root, "agent", "git", "github.com", "owner", "new-repo", ".git")),
    true,
  );
});

test(
  "missing finalization does not write an ambient foreign index",
  { concurrency: false },
  (t) => {
    const { root, agentDir, originDir } = createManagedGitCheckout(t);
    const foreignTarget = join(root, "foreign-repo");
    runGit(["clone", originDir, foreignTarget]);
    const foreignIndex = realGitPath(
      foreignTarget,
      runGit(["-C", foreignTarget, "rev-parse", "--git-path", "index"]),
    );
    const foreignIndexBefore = readFileSync(foreignIndex);
    const targetDir = join(agentDir, "git", "github.com", "owner", "new-repo");
    rmSync(targetDir, { recursive: true, force: true });
    const options = checkoutOptions(targetDir, originDir);
    const preparation = prepareGitCheckout({ agentDir }, options, recordingCheckoutIo());
    mkdirSync(dirname(targetDir), { recursive: true });
    runGit(["clone", originDir, targetDir]);

    const previousIndex = process.env.GIT_INDEX_FILE;
    try {
      process.env.GIT_INDEX_FILE = foreignIndex;
      assert.equal(
        finalizeGitCheckout({ agentDir }, options, preparation, recordingCheckoutIo()),
        true,
      );
    } finally {
      if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = previousIndex;
    }

    assert.deepEqual(readFileSync(foreignIndex), foreignIndexBefore);
  },
);

test("prepare respects quiet output and truncates verbose dirty-checkout details", (t) => {
  const quietFixture = createManagedGitCheckout(t);
  const quietWarnings = [];
  const quietLines = Array.from({ length: 260 }, (_, index) => `quiet line ${index}`);
  writeFileSync(join(quietFixture.targetDir, "tracked.txt"), `${quietLines.join("\n")}\n`);
  const quietPreparation = prepareGitCheckout(
    { agentDir: quietFixture.agentDir, quiet: true, verbose: true },
    checkoutOptions(quietFixture.targetDir, quietFixture.originDir),
    gitCheckoutIo(quietWarnings),
  );
  assert.equal(quietPreparation.status, "dirty");
  assert.deepEqual(quietWarnings, []);
  cleanupGitCheckoutPreparation(quietPreparation);

  const verboseFixture = createManagedGitCheckout(t);
  const verboseWarnings = [];
  const verboseLines = Array.from({ length: 260 }, (_, index) => `verbose line ${index}`);
  writeFileSync(join(verboseFixture.targetDir, "tracked.txt"), `${verboseLines.join("\n")}\n`);
  const verbosePreparation = prepareGitCheckout(
    { agentDir: verboseFixture.agentDir, verbose: true },
    checkoutOptions(verboseFixture.targetDir, verboseFixture.originDir),
    gitCheckoutIo(verboseWarnings),
  );
  assert.equal(verbosePreparation.status, "dirty");
  assert.equal(
    verboseWarnings.some((message) =>
      message.includes("... truncated, use the diff command above"),
    ),
    true,
  );
  assert.equal(
    verboseWarnings.some((message) => message.includes("verbose line 259")),
    false,
  );
  cleanupGitCheckoutPreparation(verbosePreparation);
});

test("dependency-input changes invalidate an otherwise matching marker", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  addDependencyPackage(targetDir, originDir);
  const npmCalls = [];
  const io = npmTrackingIo(npmCalls, (dir) => {
    mkdirSync(join(dir, "node_modules", "some-dep"), { recursive: true });
  });
  const options = {
    ...checkoutOptions(targetDir, originDir),
    ref: "main",
  };

  refreshGitCheckout({ agentDir }, options, io);
  const markerPath = join(
    runGit(["-C", targetDir, "rev-parse", "--absolute-git-dir"]),
    "tlh-npm-install-complete.json",
  );
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  marker.dependencyInputs.dependencies = {};
  writeFileSync(markerPath, `${JSON.stringify(marker)}\n`);

  refreshGitCheckout({ agentDir }, options, io);
  assert.equal(npmCalls.length, 2);
});

test("managed checkout lifecycle lets Pi perform one fresh repair and reuses its marker", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  addDependencyPackage(targetDir, originDir);
  const npmCalls = [];
  const io = npmTrackingIo(npmCalls, (dir) => {
    mkdirSync(join(dir, "node_modules", "some-dep"), { recursive: true });
  });
  const options = checkoutOptions(targetDir, originDir);
  let piRuns = 0;
  const beforeIndex = process.env.GIT_INDEX_FILE;
  const runPi = () => {
    piRuns += 1;
  };

  installManagedGitCheckout({ agentDir }, options, runPi, io);
  installManagedGitCheckout({ agentDir }, options, runPi, io);

  assert.equal(piRuns, 2);
  assert.equal(npmCalls.length, 1, "only the first same-HEAD install needs a repair");
  assert.equal(process.env.GIT_INDEX_FILE, beforeIndex);
  assert.equal(listBackupRefs(targetDir).length, 0);
});

test("managed checkout restores the real index bytes and mode after Pi success", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  addDependencyPackage(targetDir, originDir);
  const indexPath = checkoutIndexPath(targetDir);
  chmodSync(indexPath, 0o600);
  const indexBefore = readFileSync(indexPath);
  const modeBefore = lstatSync(indexPath).mode & 0o777;

  const restoreTempPaths = observeRestoreTempPaths(() =>
    installManagedGitCheckout(
      { agentDir },
      checkoutOptions(targetDir, originDir),
      () => {
        writeFileSync(join(targetDir, "tracked.txt"), "Pi staged content\n");
        runGit(["-C", targetDir, "add", "tracked.txt"]);
      },
      npmTrackingIo([], (dir) => {
        mkdirSync(join(dir, "node_modules", "some-dep"), { recursive: true });
      }),
    ),
  );

  assert.deepEqual(readFileSync(indexPath), indexBefore);
  assert.equal(lstatSync(indexPath).mode & 0o777, modeBefore);
  assert.equal(restoreTempPaths.length, 1);
  assert.equal(
    restoreTempPaths.some((path) => realpathSync(dirname(path)) === realpathSync(agentDir)),
    false,
  );
  assert.deepEqual(
    restoreTempPaths.map((path) => realpathSync(dirname(path))),
    [realpathSync(dirname(indexPath))],
  );
});

test("managed checkout restores the real index on Pi failure", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  addDependencyPackage(targetDir, originDir);
  const indexPath = checkoutIndexPath(targetDir);
  chmodSync(indexPath, 0o640);
  const indexBefore = readFileSync(indexPath);
  const modeBefore = lstatSync(indexPath).mode & 0o777;
  const events = [];

  assert.throws(
    () =>
      installManagedGitCheckout(
        { agentDir },
        checkoutOptions(targetDir, originDir),
        () => {
          writeFileSync(join(targetDir, "tracked.txt"), "failed Pi content\n");
          runGit(["-C", targetDir, "add", "tracked.txt"]);
          throw new Error("simulated Pi failure");
        },
        npmTrackingIo([], undefined, events),
      ),
    /simulated Pi failure/,
  );

  assert.deepEqual(events, [
    { type: "pi-reconciliation", phase: "start" },
    { type: "pi-reconciliation", phase: "failed" },
  ]);
  assert.deepEqual(readFileSync(indexPath), indexBefore);
  assert.equal(lstatSync(indexPath).mode & 0o777, modeBefore);
});

test("managed checkout preserves a pre-Pi missing real index", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  const indexPath = checkoutIndexPath(targetDir);
  rmSync(indexPath, { force: true });
  assert.equal(existsSync(indexPath), false);

  installManagedGitCheckout(
    { agentDir },
    checkoutOptions(targetDir, originDir),
    () => {},
    npmTrackingIo([]),
  );

  assert.equal(existsSync(indexPath), false);
});

test("managed checkout restores an index in a separate Git directory", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  rmSync(targetDir, { recursive: true, force: true });
  const separateGitDir = join(agentDir, "git-metadata", "repo.git");
  mkdirSync(dirname(separateGitDir), { recursive: true });
  runGit(["clone", "--separate-git-dir", separateGitDir, originDir, targetDir]);
  addDependencyPackage(targetDir, originDir);
  const indexPath = checkoutIndexPath(targetDir);
  chmodSync(indexPath, 0o600);
  const indexBefore = readFileSync(indexPath);

  const restoreTempPaths = observeRestoreTempPaths(() =>
    installManagedGitCheckout(
      { agentDir },
      checkoutOptions(targetDir, originDir),
      () => {
        writeFileSync(join(targetDir, "tracked.txt"), "separate Pi content\n");
        runGit(["-C", targetDir, "add", "tracked.txt"]);
      },
      npmTrackingIo([], (dir) => {
        mkdirSync(join(dir, "node_modules", "some-dep"), { recursive: true });
      }),
    ),
  );

  assert.deepEqual(readFileSync(indexPath), indexBefore);
  assert.equal(realpathSync(dirname(indexPath)), realpathSync(separateGitDir));
  assert.equal(restoreTempPaths.length, 1);
  assert.equal(
    restoreTempPaths.some((path) => realpathSync(dirname(path)) === realpathSync(agentDir)),
    false,
  );
  assert.deepEqual(
    restoreTempPaths.map((path) => realpathSync(dirname(path))),
    [realpathSync(dirname(indexPath))],
  );
});

test("managed checkout lifecycle repairs a partial direct dependency after Pi returns", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  addDependencyPackage(targetDir, originDir, {
    "some-dep": "^1.0.0",
    "another-dep": "^1.0.0",
  });
  const npmCalls = [];
  const io = npmTrackingIo(npmCalls, (dir) => {
    mkdirSync(join(dir, "node_modules", "some-dep"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "another-dep"), { recursive: true });
  });
  const options = checkoutOptions(targetDir, originDir);
  installManagedGitCheckout({ agentDir }, options, () => {}, io);
  assert.equal(npmCalls.length, 1);

  rmSync(join(targetDir, "node_modules", "another-dep"), { recursive: true, force: true });
  installManagedGitCheckout({ agentDir }, options, () => {}, io);

  assert.equal(npmCalls.length, 2, "partial dependency state must be repaired");
  assert.equal(existsSync(join(targetDir, "node_modules", "another-dep")), true);
});

test("managed checkout lifecycle performs one Pi install for a fresh clone", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  addDependencyPackage(targetDir, originDir);
  rmSync(targetDir, { recursive: true, force: true });
  const npmCalls = [];
  const io = npmTrackingIo(npmCalls, (dir) => {
    mkdirSync(join(dir, "node_modules", "some-dep"), { recursive: true });
  });
  let piNpmRuns = 0;

  installManagedGitCheckout(
    { agentDir },
    checkoutOptions(targetDir, originDir),
    () => {
      mkdirSync(dirname(targetDir), { recursive: true });
      runGit(["clone", originDir, targetDir]);
      piNpmRuns += 1;
      mkdirSync(join(targetDir, "node_modules", "some-dep"), { recursive: true });
    },
    io,
  );

  assert.equal(piNpmRuns, 1);
  assert.equal(npmCalls.length, 0, "finalization must not repeat Pi's fresh-clone npm pass");
  assert.equal(existsSync(join(targetDir, ".git", "tlh-npm-install-complete.json")), true);
  assert.equal(existsSync(checkoutIndexPath(targetDir)), true);
  assert.equal(
    runGit(["-C", targetDir, "write-tree"]),
    runGit(["-C", targetDir, "rev-parse", "HEAD^{tree}"]),
    "fresh checkout must retain a consistent newly created index",
  );
});

test("managed fresh checkout with no direct dependencies does not repeat Pi's npm pass", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  addDependencyPackage(targetDir, originDir, {});
  rmSync(targetDir, { recursive: true, force: true });
  const npmCalls = [];
  const io = npmTrackingIo(npmCalls);

  installManagedGitCheckout(
    { agentDir },
    checkoutOptions(targetDir, originDir),
    () => {
      mkdirSync(dirname(targetDir), { recursive: true });
      runGit(["clone", originDir, targetDir]);
    },
    io,
  );

  assert.equal(npmCalls.length, 0);
});

test("managed checkout instrumentation separates Pi from TLH work on fresh and clean paths", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  addDependencyPackage(targetDir, originDir);
  rmSync(targetDir, { recursive: true, force: true });
  const npmCalls = [];
  const events = [];
  const commands = [];
  const io = npmTrackingIo(
    npmCalls,
    (dir) => mkdirSync(join(dir, "node_modules", "some-dep"), { recursive: true }),
    events,
    commands,
  );
  const options = checkoutOptions(targetDir, originDir);

  installManagedGitCheckout(
    { agentDir },
    options,
    () => {
      mkdirSync(dirname(targetDir), { recursive: true });
      runGit(["clone", originDir, targetDir]);
      mkdirSync(join(targetDir, "node_modules", "some-dep"), { recursive: true });
    },
    io,
  );

  assert.deepEqual(
    events.filter(({ type }) => type === "pi-reconciliation"),
    [
      { type: "pi-reconciliation", phase: "start" },
      { type: "pi-reconciliation", phase: "complete", headChanged: false },
    ],
  );
  assert.deepEqual(
    events.filter(({ type }) => type === "tlh-repair"),
    [],
  );
  assert.deepEqual(events.at(-1), {
    type: "managed-checkout-summary",
    tlhGitFetches: 0,
    tlhPackageManagerInstalls: 0,
  });
  assert.equal(npmCalls.length, 0, "fresh Pi install must not trigger a second npm install");
  assert.equal(
    commands.some(({ args }) => args.includes("fetch")),
    false,
  );

  events.length = 0;
  commands.length = 0;
  installManagedGitCheckout({ agentDir }, options, () => {}, io);

  assert.deepEqual(
    events.filter(({ type }) => type === "pi-reconciliation"),
    [
      { type: "pi-reconciliation", phase: "start" },
      { type: "pi-reconciliation", phase: "complete", headChanged: false },
    ],
  );
  assert.deepEqual(
    events.filter(({ type }) => type === "tlh-repair"),
    [],
  );
  assert.deepEqual(events.at(-1), {
    type: "managed-checkout-summary",
    tlhGitFetches: 0,
    tlhPackageManagerInstalls: 0,
  });
  assert.equal(npmCalls.length, 0, "clean existing install must not run ordinary npm");
  assert.equal(
    commands.some(({ args }) => args.includes("fetch")),
    false,
  );
});

test("managed checkout instrumentation identifies a TLH repair separately", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  addDependencyPackage(targetDir, originDir);
  const npmCalls = [];
  const events = [];
  const commands = [];
  const io = npmTrackingIo(
    npmCalls,
    (dir) => mkdirSync(join(dir, "node_modules", "some-dep"), { recursive: true }),
    events,
    commands,
  );
  const options = checkoutOptions(targetDir, originDir);

  installManagedGitCheckout({ agentDir }, options, () => {}, io);
  rmSync(join(targetDir, "node_modules", "some-dep"), { recursive: true, force: true });
  events.length = 0;
  commands.length = 0;

  installManagedGitCheckout({ agentDir }, options, () => {}, io);

  assert.deepEqual(
    events.filter(({ type }) => type === "tlh-repair"),
    [
      {
        type: "tlh-repair",
        phase: "start",
        reason: "invalid-marker-or-dependencies",
      },
      {
        type: "tlh-repair",
        phase: "complete",
        reason: "invalid-marker-or-dependencies",
      },
    ],
  );
  assert.deepEqual(events.at(-1), {
    type: "managed-checkout-summary",
    tlhGitFetches: 0,
    tlhPackageManagerInstalls: 1,
  });
  assert.equal(npmCalls.length, 2, "the repair path must run exactly one additional npm install");
  assert.equal(
    commands.some(({ args }) => args.includes("fetch")),
    false,
  );
});

test("Pi repair avoids a duplicate configured package-manager pass", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  addDependencyPackage(targetDir, originDir);
  const npmCalls = [];
  const events = [];
  const options = checkoutOptions(targetDir, originDir);
  const io = npmTrackingIo(
    npmCalls,
    (dir) => {
      mkdirSync(join(dir, "node_modules", "some-dep"), { recursive: true });
    },
    events,
  );

  installManagedGitCheckout({ agentDir }, options, () => {}, io);
  assert.equal(npmCalls.length, 1);
  rmSync(join(targetDir, "node_modules", "some-dep"), { recursive: true, force: true });
  events.length = 0;

  installManagedGitCheckout(
    { agentDir, npmCommand: ["pnpm", "--config", "store-dir"] },
    options,
    () => {
      // Simulate Pi's own same-HEAD repair using pnpm's link layout.
      createPnpmLink(targetDir, "some-dep");
    },
    io,
  );

  assert.equal(npmCalls.length, 1, "Pi's repair must not be duplicated by TLH");
  assert.deepEqual(
    events.filter(({ type }) => type === "tlh-repair"),
    [{ type: "tlh-repair", phase: "skipped", reason: "pi-repaired-dependencies" }],
  );
  assert.deepEqual(events.at(-1), {
    type: "managed-checkout-summary",
    tlhGitFetches: 0,
    tlhPackageManagerInstalls: 0,
  });
  assert.equal(lstatSync(join(targetDir, "node_modules", "some-dep")).isSymbolicLink(), true);
});

test("managed pnpm repair accepts unscoped and scoped store links", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  const dependencies = { "some-dep": "^1.0.0", "@scope/scoped-dep": "^1.0.0" };
  addDependencyPackage(targetDir, originDir, dependencies);
  const npmCalls = [];
  const io = npmTrackingIo(npmCalls, (dir, commandArgs) => {
    assert.deepEqual(commandArgs, ["pnpm", "install"]);
    rmSync(join(dir, "node_modules"), { recursive: true, force: true });
    createPnpmLink(dir, "some-dep");
    createPnpmLink(dir, "@scope/scoped-dep");
  });

  installManagedGitCheckout(
    { agentDir, npmCommand: ["pnpm"] },
    checkoutOptions(targetDir, originDir),
    () => {},
    io,
  );

  assert.equal(npmCalls.length, 1);
  assert.equal(lstatSync(join(targetDir, "node_modules", "some-dep")).isSymbolicLink(), true);
  assert.equal(
    lstatSync(join(targetDir, "node_modules", "@scope", "scoped-dep")).isSymbolicLink(),
    true,
  );

  installManagedGitCheckout(
    { agentDir, npmCommand: ["pnpm"] },
    checkoutOptions(targetDir, originDir),
    () => {},
    io,
  );
  assert.equal(
    npmCalls.length,
    2,
    "custom package-manager semantics retain the conservative repair fallback",
  );
});

test("managed dependency reconciliation rejects pnpm links outside node_modules", (t) => {
  const { agentDir, originDir, targetDir, root } = createManagedGitCheckout(t);
  addDependencyPackage(targetDir, originDir);
  const outsideDir = join(root, "outside-dependency");
  mkdirSync(outsideDir, { recursive: true });
  const npmCalls = [];
  const io = npmTrackingIo(npmCalls, (dir) => {
    const directPath = join(dir, "node_modules", "some-dep");
    mkdirSync(dirname(directPath), { recursive: true });
    symlinkSync(outsideDir, directPath, "dir");
  });

  assert.throws(
    () =>
      installManagedGitCheckout(
        { agentDir, npmCommand: ["pnpm"] },
        checkoutOptions(targetDir, originDir),
        () => {},
        io,
      ),
    /package-manager install did not produce a complete/,
  );
  assert.equal(npmCalls.length, 1);
});

test("managed checkout lifecycle performs one Pi install for a changed ref", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  addDependencyPackage(targetDir, originDir);
  const npmCalls = [];
  const io = npmTrackingIo(npmCalls, (dir) => {
    mkdirSync(join(dir, "node_modules", "some-dep"), { recursive: true });
  });
  const options = checkoutOptions(targetDir, originDir);
  installManagedGitCheckout({ agentDir }, options, () => {}, io);
  const oldHead = runGit(["-C", targetDir, "rev-parse", "HEAD"]);

  writeFileSync(join(targetDir, "tracked.txt"), "tracked v2\n");
  runGit(["-C", targetDir, "add", "tracked.txt"]);
  runGit(["-C", targetDir, "commit", "-m", "new ref"]);
  runGit(["-C", targetDir, "push", originDir, "HEAD:main"]);
  runGit(["-C", targetDir, "reset", "--hard", oldHead]);
  rmSync(join(targetDir, "node_modules"), { recursive: true, force: true });

  let piNpmRuns = 0;
  installManagedGitCheckout(
    { agentDir },
    options,
    () => {
      runGit(["-C", targetDir, "fetch", "origin", "main"]);
      runGit(["-C", targetDir, "reset", "--hard", "FETCH_HEAD"]);
      piNpmRuns += 1;
      mkdirSync(join(targetDir, "node_modules", "some-dep"), { recursive: true });
    },
    io,
  );

  assert.equal(piNpmRuns, 1);
  assert.equal(npmCalls.length, 1, "the changed-ref npm pass must remain single-pass");
  assert.notEqual(runGit(["-C", targetDir, "rev-parse", "HEAD"]), oldHead);
  assert.equal(readFileSync(join(targetDir, "tracked.txt"), "utf8"), "tracked v2\n");
  assert.deepEqual(
    listBackupRefs(targetDir).filter((ref) => ref.includes("/index/")),
    [],
    "an unchanged pre-Pi index must not get a redundant backup ref",
  );
});

test("changed refs preserve staged index content and leave additions/removals clean", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  addDependencyPackage(targetDir, originDir);
  writeFileSync(join(targetDir, "removed-from-head.txt"), "remove me\n");
  runGit(["-C", targetDir, "add", "removed-from-head.txt"]);
  runGit(["-C", targetDir, "commit", "-m", "add removable file"]);
  runGit(["-C", targetDir, "push", originDir, "HEAD:main"]);

  const npmCalls = [];
  const io = npmTrackingIo(npmCalls, (dir) => {
    mkdirSync(join(dir, "node_modules", "some-dep"), { recursive: true });
  });
  const options = checkoutOptions(targetDir, originDir);
  installManagedGitCheckout({ agentDir }, options, () => {}, io);

  const oldHead = runGit(["-C", targetDir, "rev-parse", "HEAD"]);
  writeFileSync(join(targetDir, "tracked.txt"), "changed HEAD content\n");
  runGit(["-C", targetDir, "add", "tracked.txt"]);
  writeFileSync(join(targetDir, "added-in-head.txt"), "new file\n");
  runGit(["-C", targetDir, "rm", "--cached", "--", "removed-from-head.txt"]);
  runGit(["-C", targetDir, "add", "added-in-head.txt"]);
  runGit(["-C", targetDir, "commit", "-m", "changed ref"]);
  runGit(["-C", targetDir, "push", originDir, "HEAD:main"]);
  runGit(["-C", targetDir, "reset", "--hard", oldHead]);
  writeFileSync(join(targetDir, "tracked.txt"), "pre-Pi staged content\n");
  runGit(["-C", targetDir, "add", "tracked.txt"]);

  installManagedGitCheckout(
    { agentDir },
    options,
    () => {
      runGit(["-C", targetDir, "fetch", "origin", "main"]);
      runGit(["-C", targetDir, "reset", "--hard", "FETCH_HEAD"]);
      mkdirSync(join(targetDir, "node_modules", "some-dep"), { recursive: true });
    },
    io,
  );

  const backupRefs = listBackupRefs(targetDir);
  const indexBackupRefs = backupRefs.filter((ref) => ref.includes("/index/"));
  assert.equal(indexBackupRefs.length, 1);
  const indexBackupRef = indexBackupRefs[0];
  assert.equal(indexBackupRef.startsWith("refs/tlh-backup/index/"), true);
  assert.equal(runGit(["-C", targetDir, "rev-parse", `${indexBackupRef}^`]), oldHead);
  assert.equal(
    runGit(["-C", targetDir, "show", `${indexBackupRef}:tracked.txt`]),
    "pre-Pi staged content",
  );
  assert.equal(
    runGit(["-C", targetDir, "write-tree"]),
    runGit(["-C", targetDir, "rev-parse", "HEAD^{tree}"]),
    "changed-HEAD finalization must synchronize the real index",
  );
  assert.equal(runGit(["-C", targetDir, "status", "--porcelain"]), "");
  const cleanPreview = runGit(["-C", targetDir, "clean", "-ndx"]);
  assert.equal(cleanPreview.includes("tracked.txt"), false);
  assert.equal(cleanPreview.includes("added-in-head.txt"), false);
  assert.equal(cleanPreview.includes("removed-from-head.txt"), false);
  assert.equal(
    npmCalls.length,
    1,
    "the changed ref must not trigger a duplicate package-manager pass",
  );
});

test("managed checkout lifecycle backs up dirty same-HEAD content without duplicate npm", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  addDependencyPackage(targetDir, originDir);
  const npmCalls = [];
  const io = npmTrackingIo(npmCalls, (dir) => {
    mkdirSync(join(dir, "node_modules", "some-dep"), { recursive: true });
  });
  const options = checkoutOptions(targetDir, originDir);
  installManagedGitCheckout({ agentDir }, options, () => {}, io);
  assert.equal(npmCalls.length, 1);

  writeFileSync(join(targetDir, "tracked.txt"), "local dirty content\n");
  writeFileSync(join(targetDir, ".gitignore"), "build/\n");
  mkdirSync(join(targetDir, "node_modules", "local-only"), { recursive: true });
  writeFileSync(join(targetDir, "node_modules", "local-only", "keep.txt"), "keep\n");
  installManagedGitCheckout({ agentDir }, options, () => {}, io);

  assert.equal(npmCalls.length, 1, "a valid marker avoids npm after dirty cleanup");
  assert.equal(readFileSync(join(targetDir, "tracked.txt"), "utf8"), "tracked v1\n");
  assert.equal(existsSync(join(targetDir, "node_modules", "local-only", "keep.txt")), true);
  const backupRef = listBackupRefs(targetDir)[0];
  assert.equal(
    runGit(["-C", targetDir, "ls-tree", "-r", "--name-only", backupRef]).includes(
      "node_modules/local-only/keep.txt",
    ),
    false,
  );
  assert.equal(listBackupRefs(targetDir).length, 1);
});

test("managed checkout lifecycle preserves Pi's invalid npmCommand error", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  addDependencyPackage(targetDir, originDir);

  assert.throws(
    () =>
      installManagedGitCheckout(
        { agentDir, npmCommand: [""] },
        checkoutOptions(targetDir, originDir),
        () => {},
        npmTrackingIo([]),
      ),
    { message: "Invalid npmCommand: first array entry must be a non-empty command" },
  );
});

test("managed checkout lifecycle uses a configured package manager for conservative repair", (t) => {
  const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
  addDependencyPackage(targetDir, originDir);
  const npmCalls = [];
  const io = npmTrackingIo(npmCalls, (dir, commandArgs) => {
    assert.deepEqual(commandArgs, ["pnpm", "--config", "store-dir", "install"]);
    mkdirSync(join(dir, "node_modules", "some-dep"), { recursive: true });
  });
  const options = checkoutOptions(targetDir, originDir);

  installManagedGitCheckout(
    { agentDir, npmCommand: ["pnpm", "--config", "store-dir"] },
    options,
    () => {},
    io,
  );

  assert.equal(npmCalls.length, 1);
});

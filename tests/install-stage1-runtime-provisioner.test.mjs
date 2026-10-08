/**
 * Unit tests for scripts/lib/tlh-install-runtime.mts — provisionPiRuntime,
 * isTlhOnlyLib (via provisionPiRuntime), cleanupStaleRuntimeDirs, and
 * RUNTIME_FAILED_DIR_PREFIX.  These tests import the generated .mjs directly
 * and use a fake IO so they do not invoke the real installer.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";

import {
  RUNTIME_FAILED_DIR_PREFIX,
  RUNTIME_INSTALL_LOCK_NAME,
  RUNTIME_INSTALL_LOCK_RECLAIM_NAME,
  RUNTIME_PREVIOUS_DIR_PREFIX,
  RUNTIME_STAGING_DIR_PREFIX,
  acquireInstallLock,
  cleanupStaleRuntimeDirs,
  provisionPiRuntime,
  reclaimStaleLock,
  releaseInstallLock,
} from "../scripts/lib/tlh-install-runtime.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Build a minimal fake IO for provisionPiRuntime.  checkVersion may be overridden. */
function makeIo({ checkVersion, printedCommands = [], logs = [] } = {}) {
  return {
    log: (msg) => logs.push(msg),
    verboseLog: (msg) => logs.push(`[verbose] ${msg}`),
    printCommand: (args) => printedCommands.push([...args].join(" ")),
    runCommand: () => {},
    checkVersion: checkVersion ?? (() => {}),
  };
}

/** Write the staged node_modules structure that simulates what npm ci would create. */
function writeStagedNodeModules(stagingDir, { piVersion = "1.0.0" } = {}) {
  const piCli = join(
    stagingDir,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "bundle",
    "cli.js",
  );
  mkdirSync(
    join(stagingDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle"),
    {
      recursive: true,
    },
  );
  writeFileSync(
    piCli,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '${piVersion}\\n'; fi\n`,
    "utf8",
  );
  chmodSync(piCli, 0o755);
}

// ---------------------------------------------------------------------------
// Fix #1: shippedPackageJsonPath / shippedLockPath API — explicit path names
// ---------------------------------------------------------------------------

test("provisionPiRuntime: accepts shippedPackageJsonPath / shippedLockPath with any filename", (t) => {
  const root = makeTmp("tlh-rt-unit-explicit-paths-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  const tmpDir = join(root, "tmpdir");
  mkdirSync(tmpDir, { recursive: true });

  // Files have remote tempPath names (simulating the stage-1 remote fetch).
  const shippedPackageJsonPath = join(tmpDir, "pi-runtime-package.json");
  const shippedLockPath = join(tmpDir, "pi-runtime-package-lock.json");
  writeFileSync(shippedPackageJsonPath, JSON.stringify({ name: "tlh-pi-runtime" }), "utf8");
  writeFileSync(shippedLockPath, JSON.stringify({ lockfileVersion: 3 }), "utf8");

  const printedCommands = [];
  const io = makeIo({ printedCommands });

  // Override runCommand to create the staged node_modules (simulating npm ci).
  let ranNpmCi = false;
  io.runCommand = (args, opts) => {
    if (args[0] === "npm" && args[1] === "ci") {
      ranNpmCi = true;
      writeStagedNodeModules(opts?.cwd ?? "");
    }
  };
  // checkVersion always succeeds.
  io.checkVersion = () => {};

  const result = provisionPiRuntime(
    {
      prefix,
      shippedPackageJsonPath,
      shippedLockPath,
      pinnedVersion: "1.0.0",
      dryRun: false,
      origin: "created",
    },
    io,
  );

  assert.equal(result.installed, true, "should have performed install");
  assert.ok(ranNpmCi, "npm ci should have been called");
});

test("provisionPiRuntime: throws actionable error when shippedPackageJsonPath is missing (real run)", (t) => {
  const root = makeTmp("tlh-rt-unit-missing-pkg-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  // Pretend piBin doesn't exist so reuse check is skipped.
  const io = makeIo();

  assert.throws(
    () =>
      provisionPiRuntime(
        {
          prefix,
          shippedPackageJsonPath: "",
          shippedLockPath: "/nonexistent/pi-runtime-package-lock.json",
          pinnedVersion: "1.0.0",
          dryRun: false,
          origin: "created",
        },
        io,
      ),
    /shipped package\.json not found/i,
    "should throw about missing shipped package.json",
  );
});

test("provisionPiRuntime: throws actionable error when shippedLockPath is missing (real run)", (t) => {
  const root = makeTmp("tlh-rt-unit-missing-lock-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  const tmpDir = join(root, "tmpdir");
  mkdirSync(tmpDir, { recursive: true });
  const shippedPackageJsonPath = join(tmpDir, "pi-runtime-package.json");
  writeFileSync(shippedPackageJsonPath, JSON.stringify({ name: "tlh-pi-runtime" }), "utf8");

  const io = makeIo();

  assert.throws(
    () =>
      provisionPiRuntime(
        {
          prefix,
          shippedPackageJsonPath,
          shippedLockPath: "",
          pinnedVersion: "1.0.0",
          dryRun: false,
          origin: "created",
        },
        io,
      ),
    /shipped package-lock\.json not found/i,
    "should throw about missing shipped package-lock.json",
  );
});

test("provisionPiRuntime: dry-run tolerates empty shipped paths", (t) => {
  const root = makeTmp("tlh-rt-unit-dryrun-empty-paths-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  const printedCommands = [];
  const io = makeIo({ printedCommands });

  // Should not throw even though paths are empty.
  const result = provisionPiRuntime(
    {
      prefix,
      shippedPackageJsonPath: "",
      shippedLockPath: "",
      pinnedVersion: "1.0.0",
      dryRun: true,
      origin: "created",
    },
    io,
  );

  assert.equal(result.installed, true, "dry-run should report installed=true");
  // Must have printed the npm ci command.
  assert.ok(
    printedCommands.some((cmd) => cmd.includes("npm ci")),
    `dry-run must print npm ci command; got: ${printedCommands.join(", ")}`,
  );
});

// ---------------------------------------------------------------------------
// Fix #5: dry-run output — actual command, not synthetic bash -c
// ---------------------------------------------------------------------------

test("provisionPiRuntime: dry-run prints 'npm ci --ignore-scripts --no-audit --no-fund'", (t) => {
  const root = makeTmp("tlh-rt-unit-dryrun-cmd-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  const printedCommands = [];
  const io = makeIo({ printedCommands });

  provisionPiRuntime(
    {
      prefix,
      shippedPackageJsonPath: "",
      shippedLockPath: "",
      pinnedVersion: "1.0.0",
      dryRun: true,
      origin: "created",
    },
    io,
  );

  const npmCiCmd = printedCommands.find((cmd) => cmd.startsWith("npm ci"));
  assert.ok(npmCiCmd, `should print npm ci command; printed: ${printedCommands.join(", ")}`);
  assert.match(npmCiCmd, /--ignore-scripts/, "npm ci must include --ignore-scripts");
  assert.match(npmCiCmd, /--no-audit/, "npm ci must include --no-audit");
  assert.match(npmCiCmd, /--no-fund/, "npm ci must include --no-fund");
  // Must NOT be the synthetic bash -c form.
  assert.doesNotMatch(npmCiCmd, /bash -c/, "npm ci must not be wrapped in bash -c");
});

// ---------------------------------------------------------------------------
// Fix #2: no lib/bin after successful staged install
// ---------------------------------------------------------------------------

test("provisionPiRuntime: lib/ has no bin/ subdirectory after staged swap", (t) => {
  const root = makeTmp("tlh-rt-unit-no-lib-bin-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  const tmpDir = join(root, "tmpdir");
  mkdirSync(tmpDir, { recursive: true });
  const shippedPackageJsonPath = join(tmpDir, "pi-runtime-package.json");
  const shippedLockPath = join(tmpDir, "pi-runtime-package-lock.json");
  writeFileSync(shippedPackageJsonPath, JSON.stringify({ name: "tlh-pi-runtime" }), "utf8");
  writeFileSync(shippedLockPath, JSON.stringify({ lockfileVersion: 3 }), "utf8");

  const io = makeIo();
  io.runCommand = (_args, opts) => {
    writeStagedNodeModules(opts?.cwd ?? "");
  };
  io.checkVersion = () => {};

  provisionPiRuntime(
    {
      prefix,
      shippedPackageJsonPath,
      shippedLockPath,
      pinnedVersion: "1.0.0",
      dryRun: false,
      origin: "created",
    },
    io,
  );

  const libBin = join(prefix, "lib", "bin");
  assert.equal(existsSync(libBin), false, "lib/bin must not exist after staged swap");
});

// ---------------------------------------------------------------------------
// Fix #3: tightened isTlhOnlyLib — tested via provisionPiRuntime migrated path
// ---------------------------------------------------------------------------

// Helper: set up a minimal migrated prefix (existing lib) and call
// provisionPiRuntime in dry-run=true so shipped paths are not needed.
// The migrated guard runs before the dry-run branch.
function assertMigratedGuard(libSetup, { expectOk, description }) {
  return (t) => {
    const root = makeTmp("tlh-rt-unit-migrated-guard-");
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const prefix = join(root, "prefix");
    const libDir = join(prefix, "lib");
    mkdirSync(libDir, { recursive: true });
    libSetup(libDir);

    const io = makeIo();

    if (expectOk) {
      // Should not throw.
      const result = provisionPiRuntime(
        {
          prefix,
          shippedPackageJsonPath: "",
          shippedLockPath: "",
          pinnedVersion: "1.0.0",
          dryRun: true,
          origin: "migrated",
        },
        io,
      );
      assert.equal(result.installed, true, `${description}: should proceed`);
    } else {
      assert.throws(
        () =>
          provisionPiRuntime(
            {
              prefix,
              shippedPackageJsonPath: "",
              shippedLockPath: "",
              pinnedVersion: "1.0.0",
              dryRun: true,
              origin: "migrated",
            },
            io,
          ),
        (err) => {
          assert.match(
            String(err),
            /does not own/i,
            `${description}: error must say entries TLH does not own`,
          );
          return true;
        },
        `${description}: should refuse`,
      );
    }
  };
}

// Old global layout: lib/node_modules/@earendil-works/pi-coding-agent + .package-lock.json → OK
test(
  "isTlhOnlyLib: old global layout (TLH-only) → proceeds",
  assertMigratedGuard(
    (libDir) => {
      mkdirSync(join(libDir, "node_modules", "@earendil-works", "pi-coding-agent"), {
        recursive: true,
      });
      mkdirSync(join(libDir, "node_modules", ".bin"), { recursive: true });
      writeFileSync(join(libDir, "node_modules", ".package-lock.json"), "{}", "utf8");
    },
    { expectOk: true, description: "old global layout" },
  ),
);

// lib has package.json + package-lock.json with correct name → OK
test(
  "isTlhOnlyLib: lib with TLH-named package.json + package-lock.json → proceeds",
  assertMigratedGuard(
    (libDir) => {
      writeFileSync(
        join(libDir, "package.json"),
        JSON.stringify({ name: "tlh-pi-runtime" }),
        "utf8",
      );
      writeFileSync(join(libDir, "package-lock.json"), "{}", "utf8");
      mkdirSync(join(libDir, "node_modules", "@earendil-works", "pi-coding-agent"), {
        recursive: true,
      });
    },
    { expectOk: true, description: "TLH-named package.json" },
  ),
);

// lib has package.json with wrong name → refuse
test(
  "isTlhOnlyLib: lib/package.json with foreign name → refuses",
  assertMigratedGuard(
    (libDir) => {
      writeFileSync(
        join(libDir, "package.json"),
        JSON.stringify({ name: "some-other-pkg" }),
        "utf8",
      );
    },
    { expectOk: false, description: "foreign package.json name" },
  ),
);

// lib top-level has a foreign file → refuse
test(
  "isTlhOnlyLib: lib/ top-level foreign file → refuses",
  assertMigratedGuard(
    (libDir) => {
      writeFileSync(join(libDir, "foreign-file.js"), "// foreign\n", "utf8");
    },
    { expectOk: false, description: "foreign lib top-level file" },
  ),
);

// lib/node_modules has a foreign scoped sibling @earendil-works/other → refuse
test(
  "isTlhOnlyLib: @earendil-works/other (foreign scoped sibling) → refuses",
  assertMigratedGuard(
    (libDir) => {
      mkdirSync(join(libDir, "node_modules", "@earendil-works", "pi-coding-agent"), {
        recursive: true,
      });
      mkdirSync(join(libDir, "node_modules", "@earendil-works", "other"), { recursive: true });
    },
    { expectOk: false, description: "foreign scoped sibling @earendil-works/other" },
  ),
);

// lib/node_modules has a top-level non-dotfile, non-@earendil-works entry → refuse
test(
  "isTlhOnlyLib: lib/node_modules top-level foreign package → refuses",
  assertMigratedGuard(
    (libDir) => {
      mkdirSync(join(libDir, "node_modules", "some-tool"), { recursive: true });
    },
    { expectOk: false, description: "foreign node_modules entry" },
  ),
);

// Unreadable lib dir → refuse (fail closed)
test("isTlhOnlyLib: unreadable lib dir → refuses (fail closed)", (t) => {
  // Skip if running as root (chmod has no effect).
  if (process.getuid?.() === 0) {
    t.skip("cannot test unreadable dirs as root");
    return;
  }

  const root = makeTmp("tlh-rt-unit-unreadable-lib-");
  t.after(() => {
    // Restore permissions before cleanup.
    try {
      chmodSync(join(root, "prefix", "lib"), 0o755);
    } catch {
      // ignore
    }
    rmSync(root, { recursive: true, force: true });
  });

  const prefix = join(root, "prefix");
  const libDir = join(prefix, "lib");
  mkdirSync(libDir, { recursive: true });
  // Make lib unreadable so readdirSync throws.
  chmodSync(libDir, 0o000);

  const io = makeIo();

  assert.throws(
    () =>
      provisionPiRuntime(
        {
          prefix,
          shippedPackageJsonPath: "",
          shippedLockPath: "",
          pinnedVersion: "1.0.0",
          dryRun: true,
          origin: "migrated",
        },
        io,
      ),
    /does not own/i,
    "should refuse with fail-closed error on unreadable lib dir",
  );
});

// ---------------------------------------------------------------------------
// Fix #4: RUNTIME_FAILED_DIR_PREFIX constant + cleanupStaleRuntimeDirs
// ---------------------------------------------------------------------------

test("RUNTIME_FAILED_DIR_PREFIX: exported as a dot-prefixed string", () => {
  assert.ok(
    typeof RUNTIME_FAILED_DIR_PREFIX === "string",
    "RUNTIME_FAILED_DIR_PREFIX should be a string",
  );
  assert.ok(
    RUNTIME_FAILED_DIR_PREFIX.startsWith("."),
    `RUNTIME_FAILED_DIR_PREFIX should start with '.'; got: ${RUNTIME_FAILED_DIR_PREFIX}`,
  );
  assert.match(
    RUNTIME_FAILED_DIR_PREFIX,
    /failed/,
    "RUNTIME_FAILED_DIR_PREFIX should include 'failed'",
  );
});

test("cleanupStaleRuntimeDirs: removes .tlh-runtime-failed-* dirs", (t) => {
  const prefix = makeTmp("tlh-rt-unit-cleanup-failed-");
  t.after(() => rmSync(prefix, { recursive: true, force: true }));

  // Create stale dirs with all three prefixes.
  const stagingDir = join(prefix, `${RUNTIME_STAGING_DIR_PREFIX}12345`);
  const previousDir = join(prefix, `${RUNTIME_PREVIOUS_DIR_PREFIX}12345`);
  const failedDir = join(prefix, `${RUNTIME_FAILED_DIR_PREFIX}12345`);
  const keepDir = join(prefix, "lib");
  mkdirSync(stagingDir, { recursive: true });
  mkdirSync(previousDir, { recursive: true });
  mkdirSync(failedDir, { recursive: true });
  mkdirSync(keepDir, { recursive: true });

  cleanupStaleRuntimeDirs(prefix);

  assert.equal(existsSync(stagingDir), false, "staging dir must be removed");
  assert.equal(existsSync(previousDir), false, "previous dir must be removed");
  assert.equal(existsSync(failedDir), false, "failed dir must be removed");
  assert.ok(existsSync(keepDir), "lib dir must be kept");
});

test("rollbackSwap: failed dir is dot-prefixed and cleaned up after rollback", (t) => {
  const root = makeTmp("tlh-rt-unit-rollback-failed-dir-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  const tmpDir = join(root, "tmpdir");
  mkdirSync(tmpDir, { recursive: true });
  const shippedPackageJsonPath = join(tmpDir, "package.json");
  const shippedLockPath = join(tmpDir, "package-lock.json");
  writeFileSync(shippedPackageJsonPath, JSON.stringify({ name: "tlh-pi-runtime" }), "utf8");
  writeFileSync(shippedLockPath, JSON.stringify({ lockfileVersion: 3 }), "utf8");

  const io = makeIo();
  io.runCommand = (_args, opts) => {
    writeStagedNodeModules(opts?.cwd ?? "");
  };
  // checkVersion succeeds for the staged bin, fails on the post-swap bin -> triggers rollback.
  let calls = 0;
  io.checkVersion = () => {
    calls++;
    if (calls > 1) throw new Error("Simulated post-swap version mismatch");
  };

  assert.throws(
    () =>
      provisionPiRuntime(
        {
          prefix,
          shippedPackageJsonPath,
          shippedLockPath,
          pinnedVersion: "1.0.0",
          dryRun: false,
          origin: "created",
        },
        io,
      ),
    /Simulated post-swap version mismatch/,
  );

  // After rollback, no dot-prefixed failed dirs should remain in the prefix.
  // (rollbackSwap cleans up the failed dir after restoring previous)
  if (existsSync(prefix)) {
    const entries = readdirSync(prefix);
    const failedPrefixPattern = new RegExp(`^${RUNTIME_FAILED_DIR_PREFIX}`);
    const leaked = entries.filter((e) => failedPrefixPattern.test(e));
    assert.equal(leaked.length, 0, `no ${RUNTIME_FAILED_DIR_PREFIX} dirs should remain: ${leaked}`);
    // Regression guard: verify the old non-dot pattern is not used either.
    const oldStyleLeaked = entries.filter((e) => /lib\.failed-/.test(e));
    assert.equal(oldStyleLeaked.length, 0, `no non-dot .failed- dirs: ${oldStyleLeaked}`);
  }
});

// ---------------------------------------------------------------------------
// Item 1: symlinked bin/ or lib/ refused (both origins, incl. dry-run)
// ---------------------------------------------------------------------------

test("provisionPiRuntime: symlinked bin/ refused — sentinel external dir untouched", (t) => {
  const root = makeTmp("tlh-rt-unit-symlink-bin-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  const sentinelDir = join(root, "sentinel");
  mkdirSync(sentinelDir, { recursive: true });
  writeFileSync(join(sentinelDir, "sentinel.txt"), "external content", "utf8");

  // Create prefix/bin as a symlink pointing to the external sentinel dir.
  mkdirSync(prefix, { recursive: true });
  symlinkSync(sentinelDir, join(prefix, "bin"));

  const io = makeIo();

  // Should throw for both origins and in both real and dry-run modes.
  for (const dryRun of [false, true]) {
    for (const origin of ["created", "migrated"]) {
      assert.throws(
        () =>
          provisionPiRuntime(
            {
              prefix,
              shippedPackageJsonPath: "",
              shippedLockPath: "",
              pinnedVersion: "1.0.0",
              dryRun,
              origin,
            },
            io,
          ),
        (err) => {
          assert.match(String(err), /is a symlink/i, "error must mention symlink");
          return true;
        },
        `dryRun=${dryRun} origin=${origin}: should refuse symlinked bin/`,
      );
    }
  }

  // Sentinel external dir must be completely untouched.
  assert.ok(existsSync(join(sentinelDir, "sentinel.txt")), "sentinel file must survive");
  assert.equal(
    readFileSync(join(sentinelDir, "sentinel.txt"), "utf8"),
    "external content",
    "sentinel file content must be unchanged",
  );
});

test("provisionPiRuntime: symlinked lib/ refused — sentinel external dir untouched", (t) => {
  const root = makeTmp("tlh-rt-unit-symlink-lib-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  const sentinelDir = join(root, "sentinel");
  mkdirSync(sentinelDir, { recursive: true });
  writeFileSync(join(sentinelDir, "sentinel.txt"), "external content", "utf8");

  // Create prefix/lib as a symlink (dangling; target does not exist) to test
  // dangling-symlink detection.
  mkdirSync(prefix, { recursive: true });
  const danglingTarget = join(root, "nonexistent-target");
  symlinkSync(danglingTarget, join(prefix, "lib"));

  const io = makeIo();

  // Should throw for both origins and in both real and dry-run modes.
  for (const dryRun of [false, true]) {
    for (const origin of ["created", "migrated"]) {
      assert.throws(
        () =>
          provisionPiRuntime(
            {
              prefix,
              shippedPackageJsonPath: "",
              shippedLockPath: "",
              pinnedVersion: "1.0.0",
              dryRun,
              origin,
            },
            io,
          ),
        (err) => {
          assert.match(String(err), /is a symlink/i, "error must mention symlink");
          return true;
        },
        `dryRun=${dryRun} origin=${origin}: should refuse symlinked lib/`,
      );
    }
  }

  // Verify lib symlink target was NOT created (since the target was nonexistent
  // and we should not have written anything).
  assert.equal(existsSync(danglingTarget), false, "dangling target must not be created");
  // Sentinel dir (separate) must also be untouched.
  assert.ok(existsSync(join(sentinelDir, "sentinel.txt")), "sentinel file must survive");
});

// ---------------------------------------------------------------------------
// Item 2: bin/pi rename-aside; rollback restores byte-identical previous entry
// ---------------------------------------------------------------------------

test("provisionPiRuntime: post-swap validation failure restores previous bin/pi (regular file)", (t) => {
  const root = makeTmp("tlh-rt-unit-rollback-reg-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  const tmpDir = join(root, "tmpdir");
  mkdirSync(tmpDir, { recursive: true });
  const shippedPackageJsonPath = join(tmpDir, "package.json");
  const shippedLockPath = join(tmpDir, "package-lock.json");
  writeFileSync(shippedPackageJsonPath, JSON.stringify({ name: "tlh-pi-runtime" }), "utf8");
  writeFileSync(shippedLockPath, JSON.stringify({ lockfileVersion: 3 }), "utf8");

  // Write a distinctive previous bin/pi as a regular file.
  const piBinDir = join(prefix, "bin");
  const piBin = join(piBinDir, "pi");
  mkdirSync(piBinDir, { recursive: true });
  const prevContent = "#!/bin/sh\n# previous-pi-regular-file\necho prev\n";
  writeFileSync(piBin, prevContent, "utf8");

  const io = makeIo();
  io.runCommand = (_args, opts) => {
    writeStagedNodeModules(opts?.cwd ?? "");
  };
  // Staged validation succeeds; post-swap validation fails.
  let calls = 0;
  io.checkVersion = () => {
    calls++;
    if (calls > 1) throw new Error("Simulated post-swap failure");
  };

  assert.throws(
    () =>
      provisionPiRuntime(
        {
          prefix,
          shippedPackageJsonPath,
          shippedLockPath,
          pinnedVersion: "1.0.0",
          dryRun: false,
          origin: "created",
        },
        io,
      ),
    /Simulated post-swap failure/,
  );

  // bin/pi must be restored byte-identically.
  assert.ok(existsSync(piBin), "bin/pi must be restored after rollback");
  const restoredContent = readFileSync(piBin, "utf8");
  assert.equal(restoredContent, prevContent, "bin/pi content must be byte-identical to original");
  // Verify the restored file is a regular file (not a symlink).
  const st = lstatSync(piBin);
  assert.equal(st.isSymbolicLink(), false, "restored bin/pi must be a regular file, not a symlink");

  // No prevPiBin backup should remain in piBinDir after rollback.
  const binEntries = readdirSync(piBinDir);
  const leaked = binEntries.filter((e) => e.startsWith(RUNTIME_PREVIOUS_DIR_PREFIX));
  assert.equal(leaked.length, 0, `no previous bin/pi backup should remain: ${leaked}`);
});

test("provisionPiRuntime: post-swap validation failure restores previous bin/pi (symlink variant)", (t) => {
  const root = makeTmp("tlh-rt-unit-rollback-symlink-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  const tmpDir = join(root, "tmpdir");
  mkdirSync(tmpDir, { recursive: true });
  const shippedPackageJsonPath = join(tmpDir, "package.json");
  const shippedLockPath = join(tmpDir, "package-lock.json");
  writeFileSync(shippedPackageJsonPath, JSON.stringify({ name: "tlh-pi-runtime" }), "utf8");
  writeFileSync(shippedLockPath, JSON.stringify({ lockfileVersion: 3 }), "utf8");

  // Write a distinctive previous bin/pi as a symlink.
  const piBinDir = join(prefix, "bin");
  const piBin = join(piBinDir, "pi");
  mkdirSync(piBinDir, { recursive: true });
  const prevTarget = "../lib/some-other-target/cli.js";
  symlinkSync(prevTarget, piBin);

  const io = makeIo();
  io.runCommand = (_args, opts) => {
    writeStagedNodeModules(opts?.cwd ?? "");
  };
  // Staged validation succeeds; post-swap validation fails.
  let calls = 0;
  io.checkVersion = () => {
    calls++;
    if (calls > 1) throw new Error("Simulated post-swap failure (symlink variant)");
  };

  assert.throws(
    () =>
      provisionPiRuntime(
        {
          prefix,
          shippedPackageJsonPath,
          shippedLockPath,
          pinnedVersion: "1.0.0",
          dryRun: false,
          origin: "created",
        },
        io,
      ),
    /Simulated post-swap failure \(symlink variant\)/,
  );

  // bin/pi must be restored as a symlink with the same target.
  // Check restored symlink exists (lstatSync works even for dangling symlinks).
  let restoredExists = false;
  try {
    lstatSync(piBin);
    restoredExists = true;
  } catch {
    /* */
  }
  assert.ok(restoredExists, "bin/pi must be restored after rollback");
  const restoredSt = lstatSync(piBin);
  assert.equal(restoredSt.isSymbolicLink(), true, "restored bin/pi must be a symlink");
  const restoredTarget = readlinkSync(piBin);
  assert.equal(restoredTarget, prevTarget, "restored symlink target must match original");

  // No prevPiBin backup should remain.
  const binEntries = readdirSync(piBinDir);
  const leaked = binEntries.filter((e) => e.startsWith(RUNTIME_PREVIOUS_DIR_PREFIX));
  assert.equal(leaked.length, 0, `no previous bin/pi backup should remain: ${leaked}`);
});

// ---------------------------------------------------------------------------
// Item 3: interrupted-swap recovery before reuse check
// ---------------------------------------------------------------------------

test("provisionPiRuntime: interrupted-swap recovery restores lib and bin/pi before reuse check", (t) => {
  const root = makeTmp("tlh-rt-unit-recovery-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  const tmpDir = join(root, "tmpdir");
  mkdirSync(tmpDir, { recursive: true });
  const shippedPackageJsonPath = join(tmpDir, "package.json");
  // Use a different content for the shipped lock so the lock check fails and
  // we know the reuse check made a decision based on the restored state.
  const shippedLockPath = join(tmpDir, "package-lock.json");
  writeFileSync(shippedPackageJsonPath, JSON.stringify({ name: "tlh-pi-runtime" }), "utf8");
  writeFileSync(shippedLockPath, JSON.stringify({ lockfileVersion: 3, different: true }), "utf8");

  // Simulate an interrupted swap state: lib absent, previous-lib backup present.
  mkdirSync(prefix, { recursive: true });
  const prevDirName = `${RUNTIME_PREVIOUS_DIR_PREFIX}${process.pid}`;
  const prevDir = join(prefix, prevDirName);
  mkdirSync(prevDir, { recursive: true });
  // Write working runtime content into the backup.
  writeFileSync(join(prevDir, "package.json"), JSON.stringify({ name: "tlh-pi-runtime" }), "utf8");

  // Simulate that bin/pi is also absent (crash happened after rename-aside).
  const piBinDir = join(prefix, "bin");
  const piBin = join(piBinDir, "pi");
  mkdirSync(piBinDir, { recursive: true });
  const prevPiBinName = `${prevDirName}-bin-pi`;
  const prevPiBin = join(piBinDir, prevPiBinName);
  const prevPiContent = "#!/bin/sh\n# recovered-pi\n";
  writeFileSync(prevPiBin, prevPiContent, "utf8");

  // npm ci will fail after recovery attempt (simulates a failing reinstall).
  const npmError = new Error("Simulated npm ci failure after recovery");
  const io = makeIo();
  io.runCommand = () => {
    throw npmError;
  };
  // checkVersion must succeed for the reuse check to possibly return early;
  // but since the lock won't match, we expect to proceed to install.
  io.checkVersion = () => {};

  assert.throws(
    () =>
      provisionPiRuntime(
        {
          prefix,
          shippedPackageJsonPath,
          shippedLockPath,
          pinnedVersion: "1.0.0",
          dryRun: false,
          origin: "created",
        },
        io,
      ),
    /Simulated npm ci failure after recovery/,
  );

  // After a failed npm ci, the recovery-restored lib and bin/pi must survive.
  // (npm ci failure only removes the staging dir, not the restored runtime.)
  assert.ok(existsSync(join(prefix, "lib")), "recovered lib must survive a failing npm ci");
  assert.ok(existsSync(piBin), "recovered bin/pi must survive a failing npm ci");

  // The previous backup should no longer exist (it was renamed to lib).
  assert.equal(existsSync(prevDir), false, "previous backup must have been consumed by recovery");
});

test("provisionPiRuntime: interrupted-swap recovery dry-run only logs (no actual rename)", (t) => {
  const root = makeTmp("tlh-rt-unit-recovery-dryrun-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  mkdirSync(prefix, { recursive: true });

  // Simulate interrupted swap: lib absent, backup present.
  const prevDirName = `${RUNTIME_PREVIOUS_DIR_PREFIX}${process.pid}`;
  const prevDir = join(prefix, prevDirName);
  mkdirSync(prevDir, { recursive: true });

  const logs = [];
  const io = makeIo({ logs });

  provisionPiRuntime(
    {
      prefix,
      shippedPackageJsonPath: "",
      shippedLockPath: "",
      pinnedVersion: "1.0.0",
      dryRun: true,
      origin: "created",
    },
    io,
  );

  // In dry-run, the backup must NOT have been renamed.
  assert.ok(existsSync(prevDir), "dry-run must not rename the backup");
  assert.equal(existsSync(join(prefix, "lib")), false, "dry-run must not create lib");

  // Should have logged the planned recovery.
  const recoveryLog = logs.find((l) => l.includes("Would recover interrupted swap"));
  assert.ok(recoveryLog, `dry-run must log planned recovery; logs: ${logs.join(" | ")}`);
});

// ---------------------------------------------------------------------------
// Follow-up review fixes for tlha-5ljv
// ---------------------------------------------------------------------------

// Item 1 (ordering): symlinked bin/ refused BEFORE recovery runs — sentinel
// and the previous backup inside the sentinel are both untouched.
test("provisionPiRuntime: symlinked bin/ refused before recovery — sentinel and backup untouched", (t) => {
  const root = makeTmp("tlh-rt-unit-symlink-before-recovery-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  const sentinelDir = join(root, "sentinel");
  mkdirSync(sentinelDir, { recursive: true });

  // Place a .tlh-runtime-previous-1-bin-pi file in the sentinel dir so we
  // can confirm recovery did NOT try to clean or rename it.
  const sentinelBinPiBkup = join(sentinelDir, `${RUNTIME_PREVIOUS_DIR_PREFIX}1-bin-pi`);
  const sentinelContent = "#!/bin/sh\n# sentinel-pi-backup\n";
  writeFileSync(sentinelBinPiBkup, sentinelContent, "utf8");

  // Make prefix/bin a symlink to the sentinel dir.
  mkdirSync(prefix, { recursive: true });
  symlinkSync(sentinelDir, join(prefix, "bin"));

  // Put a previous-lib backup in the prefix (simulates interrupted swap).
  const prevDir = join(prefix, `${RUNTIME_PREVIOUS_DIR_PREFIX}99`);
  mkdirSync(prevDir, { recursive: true });
  writeFileSync(join(prevDir, "package.json"), JSON.stringify({ name: "tlh-pi-runtime" }), "utf8");
  // lib/ absent — recovery would try to rename prevDir → lib if not blocked.

  const io = makeIo();

  // Should refuse for all origin/dryRun combinations.
  for (const dryRun of [false, true]) {
    for (const origin of ["created", "migrated"]) {
      assert.throws(
        () =>
          provisionPiRuntime(
            {
              prefix,
              shippedPackageJsonPath: "",
              shippedLockPath: "",
              pinnedVersion: "1.0.0",
              dryRun,
              origin,
            },
            io,
          ),
        (err) => {
          assert.match(String(err), /is a symlink/i, "error must mention symlink");
          return true;
        },
        `dryRun=${dryRun} origin=${origin}: should refuse symlinked bin/`,
      );
    }
  }

  // Sentinel and its backup file must be completely untouched.
  assert.ok(existsSync(sentinelBinPiBkup), "sentinel backup file must survive");
  assert.equal(
    readFileSync(sentinelBinPiBkup, "utf8"),
    sentinelContent,
    "sentinel backup file content must be byte-identical",
  );

  // The previous-lib backup must be untouched (recovery must NOT have run).
  assert.ok(existsSync(prevDir), "previous lib backup must be untouched");

  // lib/ must still be absent (recovery must NOT have renamed the backup).
  assert.equal(existsSync(join(prefix, "lib")), false, "lib must still be absent");
});

// Item 3: cleanupStaleRuntimeDirs also removes bin/.tlh-runtime-previous-*-bin-pi.
test("cleanupStaleRuntimeDirs: removes bin/.tlh-runtime-previous-*-bin-pi entries", (t) => {
  const prefix = makeTmp("tlh-rt-unit-cleanup-bin-bkup-");
  t.after(() => rmSync(prefix, { recursive: true, force: true }));

  const binDir = join(prefix, "bin");
  mkdirSync(binDir, { recursive: true });

  const backup1 = join(binDir, `${RUNTIME_PREVIOUS_DIR_PREFIX}12345-bin-pi`);
  const backup2 = join(binDir, `${RUNTIME_PREVIOUS_DIR_PREFIX}99999-bin-pi`);
  const keepPi = join(binDir, "pi"); // actual pi binary — must NOT be removed
  writeFileSync(backup1, "#!/bin/sh\n# backup 1\n", "utf8");
  writeFileSync(backup2, "#!/bin/sh\n# backup 2\n", "utf8");
  writeFileSync(keepPi, "#!/bin/sh\n# pi\n", "utf8");

  // Also create a prefix-level stale dir to confirm the existing cleanup still works.
  const stalePrefix = join(prefix, `${RUNTIME_STAGING_DIR_PREFIX}111`);
  mkdirSync(stalePrefix, { recursive: true });

  cleanupStaleRuntimeDirs(prefix);

  assert.equal(existsSync(backup1), false, "bin/pi backup 1 must be removed");
  assert.equal(existsSync(backup2), false, "bin/pi backup 2 must be removed");
  assert.ok(existsSync(keepPi), "actual bin/pi must be kept");
  assert.equal(existsSync(stalePrefix), false, "prefix-level stale staging dir must be removed");
});

// ---------------------------------------------------------------------------
// tlha-3tdj: stale cleanup on the reuse path
// ---------------------------------------------------------------------------

test("provisionPiRuntime reuse path: removes stale dirs and bin backup while keeping lib, bin/pi, and lockfile", (t) => {
  const root = makeTmp("tlh-rt-unit-reuse-stale-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  const tmpDir = join(root, "tmpdir");
  mkdirSync(tmpDir, { recursive: true });

  // Identical lockfile content so runtimeLockIsIdentical returns true.
  const lockContent = JSON.stringify({ lockfileVersion: 3, name: "tlh-pi-runtime" });
  const shippedLockPath = join(tmpDir, "package-lock.json");
  const shippedPackageJsonPath = join(tmpDir, "package.json");
  writeFileSync(shippedLockPath, lockContent, "utf8");
  writeFileSync(shippedPackageJsonPath, JSON.stringify({ name: "tlh-pi-runtime" }), "utf8");

  // Set up a valid runtime: lib/package-lock.json (byte-identical to shipped) and bin/pi.
  const libDir = join(prefix, "lib");
  const binDir = join(prefix, "bin");
  const piBin = join(binDir, "pi");
  mkdirSync(libDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(libDir, "package-lock.json"), lockContent, "utf8");
  writeFileSync(piBin, "#!/bin/sh\n# pi\n", "utf8");

  // Leftover stale entries from a previous crashed install.
  const stalePrevDir = join(prefix, `${RUNTIME_PREVIOUS_DIR_PREFIX}9001`);
  const staleStagingDir = join(prefix, `${RUNTIME_STAGING_DIR_PREFIX}9001`);
  const staleBinBackup = join(binDir, `${RUNTIME_PREVIOUS_DIR_PREFIX}9001-bin-pi`);
  mkdirSync(stalePrevDir, { recursive: true });
  mkdirSync(staleStagingDir, { recursive: true });
  writeFileSync(staleBinBackup, "#!/bin/sh\n# stale bin backup\n", "utf8");

  // Also write a sentinel file inside lib to confirm lib is untouched.
  const libSentinel = join(libDir, "sentinel.txt");
  writeFileSync(libSentinel, "keep me", "utf8");

  const result = provisionPiRuntime(
    {
      prefix,
      shippedPackageJsonPath,
      shippedLockPath,
      pinnedVersion: "1.0.0",
      dryRun: false,
      origin: "created",
    },
    makeIo(),
  );

  assert.equal(result.installed, false, "reuse path must return installed:false");

  // All three stale leftovers must be gone.
  assert.equal(existsSync(stalePrevDir), false, "stale previous dir must be removed");
  assert.equal(existsSync(staleStagingDir), false, "stale staging dir must be removed");
  assert.equal(existsSync(staleBinBackup), false, "stale bin/pi backup must be removed");

  // lib, bin/pi and the lockfile inside lib must be untouched.
  assert.ok(existsSync(libDir), "lib dir must be untouched");
  assert.ok(existsSync(piBin), "bin/pi must be untouched");
  assert.equal(
    readFileSync(join(libDir, "package-lock.json"), "utf8"),
    lockContent,
    "lockfile must be untouched",
  );
  assert.equal(readFileSync(libSentinel, "utf8"), "keep me", "lib sentinel must be untouched");
});

test("provisionPiRuntime reuse path dry-run: leaves stale dirs in place and logs what would be removed", (t) => {
  const root = makeTmp("tlh-rt-unit-reuse-stale-dryrun-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  const tmpDir = join(root, "tmpdir");
  mkdirSync(tmpDir, { recursive: true });

  // Identical lockfile content so runtimeLockIsIdentical returns true.
  const lockContent = JSON.stringify({ lockfileVersion: 3, name: "tlh-pi-runtime" });
  const shippedLockPath = join(tmpDir, "package-lock.json");
  const shippedPackageJsonPath = join(tmpDir, "package.json");
  writeFileSync(shippedLockPath, lockContent, "utf8");
  writeFileSync(shippedPackageJsonPath, JSON.stringify({ name: "tlh-pi-runtime" }), "utf8");

  // Set up a valid runtime.
  const libDir = join(prefix, "lib");
  const binDir = join(prefix, "bin");
  const piBin = join(binDir, "pi");
  mkdirSync(libDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(libDir, "package-lock.json"), lockContent, "utf8");
  writeFileSync(piBin, "#!/bin/sh\n# pi\n", "utf8");

  // Leftover stale entries.
  const stalePrevDir = join(prefix, `${RUNTIME_PREVIOUS_DIR_PREFIX}9002`);
  const staleStagingDir = join(prefix, `${RUNTIME_STAGING_DIR_PREFIX}9002`);
  const staleBinBackup = join(binDir, `${RUNTIME_PREVIOUS_DIR_PREFIX}9002-bin-pi`);
  mkdirSync(stalePrevDir, { recursive: true });
  mkdirSync(staleStagingDir, { recursive: true });
  writeFileSync(staleBinBackup, "#!/bin/sh\n# stale bin backup\n", "utf8");

  const logs = [];
  const result = provisionPiRuntime(
    {
      prefix,
      shippedPackageJsonPath,
      shippedLockPath,
      pinnedVersion: "1.0.0",
      dryRun: true,
      origin: "created",
    },
    makeIo({ logs }),
  );

  assert.equal(result.installed, false, "dry-run reuse path must return installed:false");

  // Stale entries must NOT have been removed in dry-run.
  assert.ok(existsSync(stalePrevDir), "dry-run must not remove stale previous dir");
  assert.ok(existsSync(staleStagingDir), "dry-run must not remove stale staging dir");
  assert.ok(existsSync(staleBinBackup), "dry-run must not remove stale bin/pi backup");

  // Logs must mention each stale entry that would be removed.
  const staleEntriesToMention = [stalePrevDir, staleStagingDir, staleBinBackup];
  for (const entry of staleEntriesToMention) {
    const mentioned = logs.some((l) => l.includes(entry));
    assert.ok(mentioned, `dry-run must log planned removal of ${entry}; logs: ${logs.join(" | ")}`);
  }
});

// ---------------------------------------------------------------------------
// Lock tests (tlha-uhbj)
// ---------------------------------------------------------------------------

/**
 * Helper: write a valid TLH pi runtime layout (bin/pi + lib/package-lock.json +
 * lib/node_modules/...) so the reuse-check passes without running npm ci.
 */
function writeReuseableRuntime(prefix, lockContent) {
  const libDir = join(prefix, "lib");
  const binDir = join(prefix, "bin");
  const piBin = join(binDir, "pi");
  mkdirSync(libDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(libDir, "package-lock.json"), lockContent, "utf8");
  writeFileSync(piBin, "#!/bin/sh\n# pi\n", "utf8");
  return { libDir, binDir, piBin };
}

test("Lock-1: live lock held by live pid → refused with actionable message, staging/previous dirs untouched", async (t) => {
  const root = makeTmp("tlh-rt-lock1-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  mkdirSync(prefix, { recursive: true });

  // Spawn a sleeping child process whose pid is definitely alive.
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
    detached: false,
    stdio: "ignore",
  });
  t.after(() => {
    try {
      child.kill();
    } catch {
      /* best-effort */
    }
  });
  // Wait briefly for the child to start.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const lockDir = join(prefix, RUNTIME_INSTALL_LOCK_NAME);
  mkdirSync(lockDir);
  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({ pid: child.pid, hostname: hostname(), startedAt: new Date().toISOString() }),
  );

  // Seed a staging dir and previous dir alongside the lock to verify they are untouched.
  const stagingDir = join(prefix, `${RUNTIME_STAGING_DIR_PREFIX}9001`);
  const previousDir = join(prefix, `${RUNTIME_PREVIOUS_DIR_PREFIX}9001`);
  mkdirSync(stagingDir);
  mkdirSync(previousDir);

  const tmpDir = join(root, "tmpdir");
  mkdirSync(tmpDir, { recursive: true });
  const lockContent = JSON.stringify({ lockfileVersion: 3, name: "tlh-pi-runtime" });
  const shippedLockPath = join(tmpDir, "package-lock.json");
  const shippedPackageJsonPath = join(tmpDir, "package.json");
  writeFileSync(shippedLockPath, lockContent, "utf8");
  writeFileSync(shippedPackageJsonPath, JSON.stringify({ name: "tlh-pi-runtime" }), "utf8");

  let errorMessage = "";
  try {
    provisionPiRuntime(
      {
        prefix,
        shippedPackageJsonPath,
        shippedLockPath,
        pinnedVersion: "1.0.0",
        dryRun: false,
        origin: "created",
      },
      makeIo(),
    );
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e);
  }

  assert.ok(
    errorMessage.includes("Another TLH install"),
    `must include actionable message; got: ${errorMessage}`,
  );
  assert.ok(
    errorMessage.includes(String(child.pid)),
    `must name the holder pid; got: ${errorMessage}`,
  );
  // Lock must still exist (not removed by the refused run).
  assert.ok(existsSync(lockDir), "lock dir must still exist after refusal");
  // Staging/previous dirs of the holder must be untouched.
  assert.ok(existsSync(stagingDir), "staging dir must be untouched");
  assert.ok(existsSync(previousDir), "previous dir must be untouched");
});

test("Lock-2: stale lock with dead pid → reclaimed, provisioning proceeds, lock removed afterwards", (t) => {
  const root = makeTmp("tlh-rt-lock2-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  const tmpDir = join(root, "tmpdir");
  mkdirSync(tmpDir, { recursive: true });

  const lockContent = JSON.stringify({ lockfileVersion: 3, name: "tlh-pi-runtime" });
  const shippedLockPath = join(tmpDir, "package-lock.json");
  const shippedPackageJsonPath = join(tmpDir, "package.json");
  writeFileSync(shippedLockPath, lockContent, "utf8");
  writeFileSync(shippedPackageJsonPath, JSON.stringify({ name: "tlh-pi-runtime" }), "utf8");

  // Set up a runtime that will reuse (no npm ci needed).
  writeReuseableRuntime(prefix, lockContent);

  // Seed a stale lock with a dead pid (pid 1 is unlikely to be ESRCH; use a
  // definitely-dead pid by finding a PID that doesn't exist).
  const lockDir = join(prefix, RUNTIME_INSTALL_LOCK_NAME);
  mkdirSync(lockDir);
  // Use pid 0 which is never a valid user process: process.kill(0, 0) sends to
  // process group, not a specific dead pid. Instead use a very high pid unlikely to exist.
  const deadPid = 2147483647; // INT_MAX; safe to assume dead
  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({ pid: deadPid, hostname: hostname(), startedAt: new Date().toISOString() }),
  );

  const logs = [];
  const result = provisionPiRuntime(
    {
      prefix,
      shippedPackageJsonPath,
      shippedLockPath,
      pinnedVersion: "1.0.0",
      dryRun: false,
      origin: "created",
    },
    makeIo({ logs }),
  );

  assert.equal(result.installed, false, "must reuse existing runtime (installed:false)");
  // Lock must be gone after successful run.
  assert.equal(existsSync(lockDir), false, "lock must be removed after completion");
  // Must have logged reclaim.
  const reclaimed = logs.some((l) => l.includes("reclaiming stale lock"));
  assert.ok(reclaimed, `must log stale-lock reclaim; logs: ${logs.join(" | ")}`);
});

test("Lock-3: lock released after success and after failed npm ci (rollback path)", (t) => {
  const root = makeTmp("tlh-rt-lock3-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // ── 3a: success path ──
  {
    const prefix = join(root, "success");
    const tmpDir = join(root, "tmpdir-success");
    mkdirSync(tmpDir, { recursive: true });

    const lockContent = JSON.stringify({ lockfileVersion: 3, name: "tlh-pi-runtime" });
    const shippedLockPath = join(tmpDir, "package-lock.json");
    const shippedPackageJsonPath = join(tmpDir, "package.json");
    writeFileSync(shippedLockPath, lockContent, "utf8");
    writeFileSync(shippedPackageJsonPath, JSON.stringify({ name: "tlh-pi-runtime" }), "utf8");
    writeReuseableRuntime(prefix, lockContent);

    provisionPiRuntime(
      {
        prefix,
        shippedPackageJsonPath,
        shippedLockPath,
        pinnedVersion: "1.0.0",
        dryRun: false,
        origin: "created",
      },
      makeIo(),
    );

    const lockDir = join(prefix, RUNTIME_INSTALL_LOCK_NAME);
    assert.equal(existsSync(lockDir), false, "lock must be removed after successful reuse run");
  }

  // ── 3b: failed npm ci path — lock must still be released ──
  {
    const prefix = join(root, "failed-npm");
    const tmpDir = join(root, "tmpdir-failed");
    mkdirSync(tmpDir, { recursive: true });

    // No shipped files → provisionPiRuntime will throw after acquiring the lock.
    const shippedLockPath = join(tmpDir, "nonexistent-lock.json");
    const shippedPackageJsonPath = join(tmpDir, "nonexistent-pkg.json");

    // No existing bin/pi so it attempts install path.
    mkdirSync(prefix, { recursive: true });

    let threw = false;
    try {
      provisionPiRuntime(
        {
          prefix,
          shippedPackageJsonPath,
          shippedLockPath,
          pinnedVersion: "1.0.0",
          dryRun: false,
          origin: "created",
        },
        makeIo(),
      );
    } catch {
      threw = true;
    }

    assert.ok(threw, "must throw when shipped files are missing");
    const lockDir = join(prefix, RUNTIME_INSTALL_LOCK_NAME);
    assert.equal(existsSync(lockDir), false, "lock must be released even after error");
  }
});

test("Lock-4: dry-run never creates the lock dir", (t) => {
  const root = makeTmp("tlh-rt-lock4-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  mkdirSync(prefix, { recursive: true });

  const tmpDir = join(root, "tmpdir");
  mkdirSync(tmpDir, { recursive: true });
  const lockContent = JSON.stringify({ lockfileVersion: 3, name: "tlh-pi-runtime" });
  const shippedLockPath = join(tmpDir, "package-lock.json");
  const shippedPackageJsonPath = join(tmpDir, "package.json");
  writeFileSync(shippedLockPath, lockContent, "utf8");
  writeFileSync(shippedPackageJsonPath, JSON.stringify({ name: "tlh-pi-runtime" }), "utf8");

  // Set up a reuseable runtime so we exercise the reuse branch in dry-run.
  writeReuseableRuntime(prefix, lockContent);

  provisionPiRuntime(
    {
      prefix,
      shippedPackageJsonPath,
      shippedLockPath,
      pinnedVersion: "1.0.0",
      dryRun: true,
      origin: "created",
    },
    makeIo(),
  );

  const lockDir = join(prefix, RUNTIME_INSTALL_LOCK_NAME);
  assert.equal(existsSync(lockDir), false, "dry-run must not create the lock dir");
});

test("Lock-5a: malformed owner.json recent → refused as in-use", (t) => {
  const root = makeTmp("tlh-rt-lock5a-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  mkdirSync(prefix, { recursive: true });

  const lockDir = join(prefix, RUNTIME_INSTALL_LOCK_NAME);
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, "owner.json"), "not-json-at-all");
  // mtime is current (fresh); should be treated as in-use.

  const logs = [];
  let errorMessage = "";
  try {
    acquireInstallLock(lockDir, (msg) => logs.push(msg));
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e);
  }

  assert.ok(
    errorMessage.includes("malformed owner.json"),
    `must refuse recent malformed lock; got: ${errorMessage}`,
  );
  assert.ok(existsSync(lockDir), "lock must not be removed when recent");
});

test("Lock-5b: malformed owner.json with old mtime → reclaimed", (t) => {
  const root = makeTmp("tlh-rt-lock5b-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  mkdirSync(prefix, { recursive: true });

  const lockDir = join(prefix, RUNTIME_INSTALL_LOCK_NAME);
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, "owner.json"), "not-json-at-all");
  // Set mtime to 11 minutes ago (older than the 10-minute threshold).
  const oldTime = new Date(Date.now() - 11 * 60 * 1000);
  utimesSync(lockDir, oldTime, oldTime);

  const logs = [];
  // acquireInstallLock should reclaim the stale lock and acquire it.
  const token = acquireInstallLock(lockDir, (msg) => logs.push(msg));
  // Lock must now be held by this process.
  assert.ok(existsSync(lockDir), "lock must exist after acquisition");
  const owner = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"));
  assert.equal(owner.pid, process.pid, "lock owner must be current pid");
  // Must have logged reclaim.
  const reclaimed = logs.some((l) => l.includes("reclaiming stale lock"));
  assert.ok(reclaimed, `must log stale reclaim for old malformed lock; logs: ${logs.join(" | ")}`);
  // Clean up: release the lock using the returned token.
  releaseInstallLock(lockDir, token);
  assert.equal(existsSync(lockDir), false, "lock must be gone after release");
});

test("Lock-6: retry EEXIST after stale-reclaim → actionable error, not raw EEXIST (simulated via live-owner lock on second acquireInstallLock call)", async (t) => {
  // This test covers the retry-EEXIST code path (attempt === 1 with EEXIST) by
  // observing its visible effect: an actionable error message rather than a raw
  // EEXIST system error.  Because injecting a race between the reclaim and the
  // retry requires OS-level coordination, we use the closest safe approximation:
  // acquire the lock from this process, then call acquireInstallLock again on
  // the same lockDir (lock now held by a live pid = current process), verifying
  // the error message is actionable regardless of which internal branch fires.
  const root = makeTmp("tlh-rt-lock6-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  mkdirSync(prefix, { recursive: true });

  // Spawn a sleeping child so we have a definitely-live foreign pid to write
  // into the lock, ensuring isPidAlive returns true and the actionable branch runs.
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
    detached: false,
    stdio: "ignore",
  });
  t.after(() => {
    try {
      child.kill();
    } catch {
      /* best-effort */
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const lockDir = join(prefix, RUNTIME_INSTALL_LOCK_NAME);
  mkdirSync(lockDir);
  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({ pid: child.pid, hostname: hostname(), startedAt: new Date().toISOString() }),
  );

  let errorMessage = "";
  try {
    acquireInstallLock(lockDir, () => {});
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e);
  }

  // Must get the actionable "Another TLH install" message, not a raw EEXIST code.
  assert.ok(
    errorMessage.includes("Another TLH install"),
    `must be actionable (not raw EEXIST); got: ${errorMessage}`,
  );
  assert.ok(
    !errorMessage.includes("EEXIST"),
    `must not expose raw EEXIST code; got: ${errorMessage}`,
  );
});

// ---------------------------------------------------------------------------
// Concurrency-safety tests (tlha-zne2)
// ---------------------------------------------------------------------------

test("Lock-7 (two-contender regression): reclaimStaleLock does not delete a lock re-acquired with a different token", (t) => {
  // Simulate the race: B observed stale lock (dead pid, token T1).
  // A already reclaimed T1 and acquired a new lock with token T2.
  // B calls reclaimStaleLock with T1's info — must NOT delete A's T2 lock.
  const root = makeTmp("tlh-rt-lock7-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  mkdirSync(prefix, { recursive: true });
  const lockDir = join(prefix, RUNTIME_INSTALL_LOCK_NAME);

  // Write the new lock (A's lock) with token T2 and a live pid.
  const tokenT2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  mkdirSync(lockDir);
  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
      token: tokenT2,
    }),
  );

  // B's observed state: the original stale lock (dead pid, different token T1).
  const observedOwnerB = {
    pid: 2147483647,
    hostname: hostname(),
    token: "11111111-2222-3333-4444-555555555555",
  };

  const logs = [];
  // B's reclaimStaleLock call must not throw and must not remove A's lock.
  reclaimStaleLock(lockDir, observedOwnerB, (msg) => logs.push(msg));

  // A's lock must still exist with T2.
  assert.ok(existsSync(lockDir), "A's lock must still exist after B's failed reclaim");
  const ownerAfter = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"));
  assert.equal(ownerAfter.token, tokenT2, "lock must still hold A's token T2");

  // Reclaim dir must be gone (removed in finally even on no-op path).
  const reclaimDir = join(prefix, RUNTIME_INSTALL_LOCK_RECLAIM_NAME);
  assert.equal(
    existsSync(reclaimDir),
    false,
    "reclaim dir must be cleaned up after reclaimStaleLock",
  );

  // Clean up A's lock.
  rmSync(lockDir, { recursive: true, force: true });
});

test("Lock-8: releaseInstallLock with non-matching token leaves lock intact", (t) => {
  const root = makeTmp("tlh-rt-lock8-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  mkdirSync(prefix, { recursive: true });
  const lockDir = join(prefix, RUNTIME_INSTALL_LOCK_NAME);

  const token = acquireInstallLock(lockDir, () => {});

  // Release with a wrong token — lock must survive.
  releaseInstallLock(lockDir, "wrong-token-00000000-0000-0000-0000-000000000000");
  assert.ok(existsSync(lockDir), "lock must still exist after release with wrong token");

  // Also verify: same pid but wrong token still refuses.
  const ownerRaw = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"));
  assert.equal(ownerRaw.pid, process.pid, "lock owner pid must be current process");

  // Release with correct token — lock must be gone.
  releaseInstallLock(lockDir, token);
  assert.equal(existsSync(lockDir), false, "lock must be removed with correct token");
});

test("Lock-9: pre-existing reclaim dir causes reclaimStaleLock to throw and leaves reclaim dir in place", (t) => {
  const root = makeTmp("tlh-rt-lock9-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  mkdirSync(prefix, { recursive: true });
  const lockDir = join(prefix, RUNTIME_INSTALL_LOCK_NAME);
  const reclaimDir = join(prefix, RUNTIME_INSTALL_LOCK_RECLAIM_NAME);

  // Create both the stale lock and a pre-existing reclaim dir (simulates another process reclaiming).
  mkdirSync(lockDir);
  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({
      pid: 2147483647,
      hostname: hostname(),
      startedAt: "2020-01-01T00:00:00.000Z",
      token: "stale-tok",
    }),
  );
  mkdirSync(reclaimDir);

  const observedOwner = { pid: 2147483647, hostname: hostname(), token: "stale-tok" };
  let errorMessage = "";
  try {
    reclaimStaleLock(lockDir, observedOwner, () => {});
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e);
  }

  assert.ok(
    errorMessage.includes("Another TLH install"),
    `must throw actionable error; got: ${errorMessage}`,
  );
  assert.ok(
    errorMessage.includes("reclaim mutex"),
    `must mention reclaim mutex; got: ${errorMessage}`,
  );
  // Reclaim dir must NOT have been removed by the refused run (it was pre-existing).
  assert.ok(existsSync(reclaimDir), "reclaim dir must still exist after refused reclaimStaleLock");
  // Stale lock must also still exist.
  assert.ok(existsSync(lockDir), "stale lock must still exist after refused reclaimStaleLock");

  // Clean up.
  rmSync(reclaimDir, { recursive: true, force: true });
  rmSync(lockDir, { recursive: true, force: true });
});

test("Lock-10: reclaimStaleLock removes reclaim dir after successful reclaim", (t) => {
  const root = makeTmp("tlh-rt-lock10-");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const prefix = join(root, "prefix");
  mkdirSync(prefix, { recursive: true });
  const lockDir = join(prefix, RUNTIME_INSTALL_LOCK_NAME);
  const reclaimDir = join(prefix, RUNTIME_INSTALL_LOCK_RECLAIM_NAME);

  // Set up a stale lock with a dead pid.
  const deadPid = 2147483647;
  const staleToken = "dead-dead-dead-dead-dead00000000";
  mkdirSync(lockDir);
  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({
      pid: deadPid,
      hostname: hostname(),
      startedAt: "2020-01-01T00:00:00.000Z",
      token: staleToken,
    }),
  );

  const observedOwner = { pid: deadPid, hostname: hostname(), token: staleToken };
  const logs = [];
  reclaimStaleLock(lockDir, observedOwner, (msg) => logs.push(msg));

  // Lock must be gone.
  assert.equal(existsSync(lockDir), false, "stale lock must be removed after successful reclaim");
  // Reclaim dir must be cleaned up in finally.
  assert.equal(
    existsSync(reclaimDir),
    false,
    "reclaim dir must be removed after successful reclaim",
  );
  // Must have logged reclaim.
  const reclaimed = logs.some((l) => l.includes("reclaiming stale lock"));
  assert.ok(reclaimed, `must log reclaim; logs: ${logs.join(" | ")}`);
});

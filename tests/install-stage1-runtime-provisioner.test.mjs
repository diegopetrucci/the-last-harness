/**
 * Unit tests for scripts/lib/tlh-install-runtime.mts — provisionPiRuntime,
 * isTlhOnlyLib (via provisionPiRuntime), cleanupStaleRuntimeDirs, and
 * RUNTIME_FAILED_DIR_PREFIX.  These tests import the generated .mjs directly
 * and use a fake IO so they do not invoke the real installer.
 *
 * Covers correction-pass requirements for tlha-e7lp:
 *   Fix #1 – shippedPackageJsonPath/shippedLockPath API + remote tempPath names
 *   Fix #2 – no lib/bin after a successful staged install
 *   Fix #3 – tightened isTlhOnlyLib guard
 *   Fix #4 – RUNTIME_FAILED_DIR_PREFIX constant + cleanupStaleRuntimeDirs
 *   Fix #5 – dry-run prints actual npm ci command, no void/npmCiArgs dead code
 *
 * Review-fix requirements for tlha-5ljv:
 *   Item 1 – symlinked bin/ or lib/ refused (both origins, incl. dry-run)
 *   Item 2 – bin/pi rename-aside transaction; rollback restores byte-identical entry
 *   Item 3 – interrupted-swap recovery before reuse check
 */
import assert from "node:assert/strict";
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";

import {
  RUNTIME_FAILED_DIR_PREFIX,
  RUNTIME_PREVIOUS_DIR_PREFIX,
  RUNTIME_STAGING_DIR_PREFIX,
  cleanupStaleRuntimeDirs,
  provisionPiRuntime,
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
